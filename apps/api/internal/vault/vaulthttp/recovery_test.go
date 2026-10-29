package vaulthttp_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/authhttp"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/compose"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault/vaulthttp"
)

type recoverCompletePayload struct {
	RecoveryKeyID        string          `json:"recovery_key_id"`
	KDF                  vault.KDFParams `json:"kdf"`
	VaultKeyWrappedByKEK string          `json:"vault_key_wrapped_by_kek"`
}

func makeRecoverCompletePayload(t *testing.T, rkID uuid.UUID, seed byte) recoverCompletePayload {
	t.Helper()
	return recoverCompletePayload{
		RecoveryKeyID: rkID.String(),
		KDF: vault.KDFParams{
			Alg:         "argon2id13",
			Ops:         3,
			Mem:         67108864,
			Parallelism: 1,
			Salt:        vault.EncodeBase64URL(seqTestBytes(16, seed)),
		},
		VaultKeyWrappedByKEK: makeWrapB64U(t, vault.WrapKindKEK, seed),
	}
}

func readPromCounter(t *testing.T, reg *prometheus.Registry, metricName, labelName, labelValue string) float64 {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("reg.Gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() != metricName {
			continue
		}
		for _, m := range f.GetMetric() {
			if labelName == "" {
				return m.GetCounter().GetValue()
			}
			for _, lbl := range m.GetLabel() {
				if lbl.GetName() == labelName && lbl.GetValue() == labelValue {
					return m.GetCounter().GetValue()
				}
			}
		}
	}
	return 0
}

// TestRecoveryLookupHitMissCrossUserAndMetrics covers Task 10 bullets:
// - POST /vault/unlock/recovery finds RK by user + lookup_hash; 200 {recovery_key_id, wrap}; does not consume.
// - Any miss (non-existent hash, another user's RK, consumed RK, user without vault) -> identical 401 recovery_key_invalid.
// - Increments vault_unlock_failures_total{method="recovery"} on miss only.
func TestRecoveryLookupHitMissCrossUserAndMetrics(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	jarA, _ := h.signupUser("rec-lookup-a@example.com", password)
	jarB, _ := h.signupUser("rec-lookup-b@example.com", password)
	jarNoVault, _ := h.signupUser("rec-lookup-novault@example.com", password)

	payloadA := makeCreatePayload(t, 0x10)
	resp, raw := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadA), reqOptions{
		idemKey: "idem-rec-lookup-create-a",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create vault A = %d %s", resp.StatusCode, raw)
	}

	payloadB := makeCreatePayload(t, 0x50)
	resp, raw = h.doReq(jarB, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadB), reqOptions{
		idemKey: "idem-rec-lookup-create-b",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create vault B = %d %s", resp.StatusCode, raw)
	}

	// 1. Lookup hit for User A slot 3 returns 200 {recovery_key_id, wrap} with Cache-Control: no-store and does NOT consume.
	lookupBodyA := `{"lookup_hash":"` + payloadA.RecoveryKeys[2].LookupHash + `"}`
	respHit1, rawHit1 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/recovery", lookupBodyA, reqOptions{})
	if respHit1.StatusCode != http.StatusOK {
		t.Fatalf("lookup hit1 = %d %s", respHit1.StatusCode, rawHit1)
	}
	if cc := respHit1.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("lookup Cache-Control = %q, want no-store", cc)
	}
	var hit1 vault.RecoveryLookupResponse
	if err := json.Unmarshal([]byte(rawHit1), &hit1); err != nil {
		t.Fatalf("decode hit1: %v", err)
	}
	if hit1.RecoveryKeyID == uuid.Nil || hit1.Wrap != payloadA.RecoveryKeys[2].Wrap {
		t.Fatalf("hit1 = %+v, want wrap %q", hit1, payloadA.RecoveryKeys[2].Wrap)
	}

	// Calling lookup a second time returns the exact same RK ID and wrap (not consumed).
	respHit2, rawHit2 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/recovery", lookupBodyA, reqOptions{})
	if respHit2.StatusCode != http.StatusOK || rawHit2 != rawHit1 {
		t.Fatalf("lookup hit2 = %d %s, want %s", respHit2.StatusCode, rawHit2, rawHit1)
	}
	if gotFail := readPromCounter(t, h.reg, "vault_unlock_failures_total", "method", "recovery"); gotFail != 0 {
		t.Fatalf("vault_unlock_failures_total after hits = %v, want 0", gotFail)
	}

	// 2. Non-existent lookup_hash -> 401 recovery_key_invalid.
	unknownHash := vault.EncodeBase64URL(seqTestBytes(32, 0xEE))
	respMiss1, rawMiss1 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/recovery", `{"lookup_hash":"`+unknownHash+`"}`, reqOptions{})
	if respMiss1.StatusCode != http.StatusUnauthorized {
		t.Fatalf("lookup unknown hash = %d %s, want 401", respMiss1.StatusCode, rawMiss1)
	}
	probMiss1 := decodeProblem(t, rawMiss1)
	if probMiss1.Code != "recovery_key_invalid" {
		t.Fatalf("probMiss1.Code = %q, want recovery_key_invalid", probMiss1.Code)
	}

	// 3. RK of another user (User B sends User A's lookup_hash) -> identical 401 recovery_key_invalid problem shape.
	respCrossUser, rawCrossUser := h.doReq(jarB, http.MethodPost, "/api/v1/vault/unlock/recovery", lookupBodyA, reqOptions{})
	if respCrossUser.StatusCode != http.StatusUnauthorized {
		t.Fatalf("lookup cross-user = %d %s, want 401", respCrossUser.StatusCode, rawCrossUser)
	}
	probCrossUser := decodeProblem(t, rawCrossUser)
	probMiss1.Instance = ""
	probCrossUser.Instance = ""
	if probCrossUser != probMiss1 {
		t.Fatalf("cross-user 401 problem %+v differs from unknown-hash 401 problem %+v", probCrossUser, probMiss1)
	}

	// 4. User without a vault -> identical 401 recovery_key_invalid problem shape.
	respNoVault, rawNoVault := h.doReq(jarNoVault, http.MethodPost, "/api/v1/vault/unlock/recovery", lookupBodyA, reqOptions{})
	if respNoVault.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no-vault 401 = %d %s, want 401", respNoVault.StatusCode, rawNoVault)
	}
	probNoVault := decodeProblem(t, rawNoVault)
	probNoVault.Instance = ""
	if probNoVault != probMiss1 {
		t.Fatalf("no-vault 401 problem %+v differs from %+v", probNoVault, probMiss1)
	}
	if gotFail := readPromCounter(t, h.reg, "vault_unlock_failures_total", "method", "recovery"); gotFail != 3 {
		t.Fatalf("vault_unlock_failures_total after 3 misses = %v, want 3", gotFail)
	}
}

// TestRecoverCompleteBarrierConcurrentSameRK covers Task 10 barrier requirement:
// "BARRIER test on real Postgres — two concurrent completes with the same RK (start both, hold them at a barrier
// so both are past the idempotency claim with different keys) -> exactly one 200, the other a defined error (412 or 401),
// RK row gone once"
func TestRecoverCompleteBarrierConcurrentSameRK(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	jarA, meA := h.signupUser("barrier-http@example.com", password)

	payloadA := makeCreatePayload(t, 0x15)
	respCreate, rawCreate := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadA), reqOptions{
		idemKey: "idem-barrier-create-0001",
	})
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("create vault = %d %s", respCreate.StatusCode, rawCreate)
	}
	var created vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawCreate), &created); err != nil {
		t.Fatal(err)
	}

	// Look up slot 1 RK ID.
	respLookup, rawLookup := h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/recovery",
		`{"lookup_hash":"`+payloadA.RecoveryKeys[0].LookupHash+`"}`, reqOptions{})
	if respLookup.StatusCode != http.StatusOK {
		t.Fatalf("lookup = %d %s", respLookup.StatusCode, rawLookup)
	}
	var lookupRes vault.RecoveryLookupResponse
	if err := json.Unmarshal([]byte(rawLookup), &lookupRes); err != nil {
		t.Fatal(err)
	}

	grant := h.reauthGrant(jarA, "vault.recover", password)
	ifMatch := `"` + created.VaultKeyID + `:1"`

	// Install barrier hook inside Service.RecoverComplete (which runs AFTER Idempotency.Claim in routes.go).
	var arrived atomic.Int32
	bothClaimed := make(chan struct{})
	release := make(chan struct{})
	vault.SetRecoverCompleteTestHook(func(_ context.Context) {
		if arrived.Add(1) == 2 {
			close(bothClaimed)
		}
		<-release
	})
	t.Cleanup(func() { vault.SetRecoverCompleteTestHook(nil) })

	type callResult struct {
		status int
		body   string
	}
	results := make([]callResult, 2)
	var wg sync.WaitGroup
	wg.Add(2)

	idemKeys := []string{"idem-barrier-complete-key-1", "idem-barrier-complete-key-2"}
	for i := range 2 {
		go func(idx int) {
			defer wg.Done()
			// Clone cookieJar per goroutine to avoid map race in test client.
			localJar := cookieJar{}
			for k, v := range jarA {
				localJar[k] = v
			}
			body := mustJSON(t, makeRecoverCompletePayload(t, lookupRes.RecoveryKeyID, byte(0x70+idx*11)))
			r, raw := h.doReq(localJar, http.MethodPost, "/api/v1/vault/recover/complete", body, reqOptions{
				idemKey: idemKeys[idx],
				ifMatch: ifMatch,
				grant:   grant,
			})
			results[idx] = callResult{status: r.StatusCode, body: raw}
		}(i)
	}

	select {
	case <-bothClaimed:
		// While both requests are held at the barrier, verify both idempotency keys are claimed ('in_progress') in Postgres.
		var inProgressCount int
		if err := h.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND status = 'in_progress'`,
			meA.User.ID,
		).Scan(&inProgressCount); err != nil {
			close(release)
			t.Fatalf("query in_progress claims: %v", err)
		}
		if inProgressCount != 2 {
			close(release)
			t.Fatalf("expected 2 in_progress idempotency claims at barrier, got %d", inProgressCount)
		}
		close(release)
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for both HTTP requests to reach RecoverComplete barrier")
	}
	wg.Wait()

	// Disable hook for subsequent checks.
	vault.SetRecoverCompleteTestHook(nil)

	okCount := 0
	errCount := 0
	for i, res := range results {
		switch res.status {
		case http.StatusOK:
			okCount++
			var vr vault.VaultVersionResponse
			if err := json.Unmarshal([]byte(res.body), &vr); err != nil || vr.Version != 2 {
				t.Fatalf("winner [%d] body = %s, want version=2", i, res.body)
			}
		case http.StatusPreconditionFailed, http.StatusUnauthorized:
			errCount++
			prob := decodeProblem(t, res.body)
			if res.status == http.StatusPreconditionFailed && prob.Code != "version_mismatch" {
				t.Fatalf("loser [%d] 412 code = %q, want version_mismatch", i, prob.Code)
			}
			if res.status == http.StatusUnauthorized && prob.Code != "recovery_key_invalid" {
				t.Fatalf("loser [%d] 401 code = %q, want recovery_key_invalid", i, prob.Code)
			}
		default:
			t.Fatalf("unexpected status on concurrent complete [%d]: %d %s", i, res.status, res.body)
		}
	}
	if okCount != 1 || errCount != 1 {
		t.Fatalf("barrier results: okCount=%d errCount=%d (%+v)", okCount, errCount, results)
	}

	// Verify RK row is gone once (remaining = 9, slot 1 empty).
	respRK, rawRK := h.doReq(jarA, http.MethodGet, "/api/v1/vault/recovery-keys", "", reqOptions{})
	if respRK.StatusCode != http.StatusOK {
		t.Fatalf("GET /vault/recovery-keys = %d %s", respRK.StatusCode, rawRK)
	}
	var rkStatus vault.RecoveryKeysStatus
	if err := json.Unmarshal([]byte(rawRK), &rkStatus); err != nil {
		t.Fatal(err)
	}
	if rkStatus.Remaining != 9 || len(rkStatus.EmptySlots) != 1 || rkStatus.EmptySlots[0] != 1 {
		t.Fatalf("rkStatus = %+v, want remaining=9 empty_slots=[1]", rkStatus)
	}

	// Verify audit_log has exactly 1 vault.recover and 1 recovery_key.consume, and vault_recover_total == 1.
	var recoverAudits, consumeAudits int
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`,
		meA.User.ID, vault.EventVaultRecover,
	).Scan(&recoverAudits); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`,
		meA.User.ID, vault.EventRecoveryKeyConsume,
	).Scan(&consumeAudits); err != nil {
		t.Fatal(err)
	}
	if recoverAudits != 1 || consumeAudits != 1 {
		t.Fatalf("audit counts: vault.recover=%d recovery_key.consume=%d, want 1 and 1", recoverAudits, consumeAudits)
	}
	if got := readPromCounter(t, h.reg, "vault_recover_total", "", ""); got != 1 {
		t.Fatalf("vault_recover_total = %v, want 1", got)
	}
}

// TestRecoverCompleteCrossUserStaleVersionAndIdempotentRetry covers Task 10 bullets:
// - RK of another user -> 401 recovery_key_invalid
// - old version -> 412 version_mismatch
// - same-key retry -> original response, not 429, no extra RK deleted (even after grant expires and rate limit bucket is full)
// - logs/audit never contain lookup_hash or wraps
func TestRecoverCompleteCrossUserStaleVersionAndIdempotentRetry(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	jarA, meA := h.signupUser("rec-complete-a@example.com", password)
	jarB, _ := h.signupUser("rec-complete-b@example.com", password)

	payloadA := makeCreatePayload(t, 0x22)
	if _, err := h.pool.Exec(context.Background(), `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, meA.User.ID); err != nil {
		t.Fatal(err)
	}
	respA, rawA := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadA), reqOptions{
		idemKey: "idem-rec-comp-create-a",
	})
	if respA.StatusCode != http.StatusCreated {
		t.Fatalf("create A = %d %s", respA.StatusCode, rawA)
	}
	var createdA vault.VaultCreatedResponse
	_ = json.Unmarshal([]byte(rawA), &createdA)

	payloadB := makeCreatePayload(t, 0x66)
	respB, rawB := h.doReq(jarB, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadB), reqOptions{
		idemKey: "idem-rec-comp-create-b",
	})
	if respB.StatusCode != http.StatusCreated {
		t.Fatalf("create B = %d %s", respB.StatusCode, rawB)
	}
	var createdB vault.VaultCreatedResponse
	_ = json.Unmarshal([]byte(rawB), &createdB)

	// Look up User A's slot 1 RK.
	_, rawLookupA := h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/recovery",
		`{"lookup_hash":"`+payloadA.RecoveryKeys[0].LookupHash+`"}`, reqOptions{})
	var lookupA vault.RecoveryLookupResponse
	_ = json.Unmarshal([]byte(rawLookupA), &lookupA)

	// 1. User B tries POST /vault/recover/complete with User A's recovery_key_id -> 401 recovery_key_invalid.
	grantB := h.reauthGrant(jarB, "vault.recover", password)
	crossBody := mustJSON(t, makeRecoverCompletePayload(t, lookupA.RecoveryKeyID, 0x91))
	respCross, rawCross := h.doReq(jarB, http.MethodPost, "/api/v1/vault/recover/complete", crossBody, reqOptions{
		idemKey: "idem-rec-comp-cross-user",
		ifMatch: `"` + createdB.VaultKeyID + `:1"`,
		grant:   grantB,
	})
	if respCross.StatusCode != http.StatusUnauthorized || decodeProblem(t, rawCross).Code != "recovery_key_invalid" {
		t.Fatalf("cross-user recover/complete = %d %s, want 401 recovery_key_invalid", respCross.StatusCode, rawCross)
	}

	// 2. Old/wrong version on User A -> 412 version_mismatch with current_version=1.
	grantA := h.reauthGrant(jarA, "vault.recover", password)
	completePayloadA := makeRecoverCompletePayload(t, lookupA.RecoveryKeyID, 0xA5)
	completeBodyA := mustJSON(t, completePayloadA)
	respStale, rawStale := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recover/complete", completeBodyA, reqOptions{
		idemKey: "idem-rec-comp-stale-ver",
		ifMatch: `"` + createdA.VaultKeyID + `:9"`,
		grant:   grantA,
	})
	if respStale.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("stale version recover/complete = %d %s, want 412", respStale.StatusCode, rawStale)
	}
	var probStale struct {
		Code           string `json:"code"`
		CurrentVersion *int32 `json:"current_version"`
	}
	if err := json.Unmarshal([]byte(rawStale), &probStale); err != nil {
		t.Fatalf("decode stale problem: %v", err)
	}
	if probStale.Code != "version_mismatch" || probStale.CurrentVersion == nil || *probStale.CurrentVersion != 1 {
		t.Fatalf("stale version problem = %+v, want version_mismatch(1)", probStale)
	}

	// 3. Valid complete for User A succeeds -> 200 {version: 2}.
	idemKeySuccess := "idem-rec-comp-success-01"
	respOK, rawOK := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recover/complete", completeBodyA, reqOptions{
		idemKey: idemKeySuccess,
		ifMatch: `"` + createdA.VaultKeyID + `:1"`,
		grant:   grantA,
	})
	if respOK.StatusCode != http.StatusOK {
		t.Fatalf("valid recover/complete = %d %s, want 200", respOK.StatusCode, rawOK)
	}
	var verResp vault.VaultVersionResponse
	if err := json.Unmarshal([]byte(rawOK), &verResp); err != nil || verResp.Version != 2 {
		t.Fatalf("verResp = %+v, want version=2", verResp)
	}

	// 4. Attempting another complete with a new Idempotency-Key and the SAME (now consumed) RK at version 2 -> 401 recovery_key_invalid.
	respReconsume, rawReconsume := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recover/complete",
		mustJSON(t, makeRecoverCompletePayload(t, lookupA.RecoveryKeyID, 0xB1)),
		reqOptions{
			idemKey: "idem-rec-comp-reconsume-02",
			ifMatch: `"` + createdA.VaultKeyID + `:2"`,
			grant:   grantA,
		})
	if respReconsume.StatusCode != http.StatusUnauthorized || decodeProblem(t, rawReconsume).Code != "recovery_key_invalid" {
		t.Fatalf("reconsume deleted RK = %d %s, want 401 recovery_key_invalid", respReconsume.StatusCode, rawReconsume)
	}

	// 5. Same-key retry after grant expires (and even if we drain the remaining 2 rate-limit slots in the 15-min window):
	// First use up the remaining 2 attempts in User A's 5/15m vault_recovery_complete bucket (we already used 4 above: stale, ok, reconsume + 1 more).
	_, _ = h.doReq(jarA, http.MethodPost, "/api/v1/vault/recover/complete",
		mustJSON(t, makeRecoverCompletePayload(t, lookupA.RecoveryKeyID, 0xB2)),
		reqOptions{
			idemKey: "idem-rec-comp-drain-04",
			ifMatch: `"` + createdA.VaultKeyID + `:2"`,
			grant:   grantA,
		})
	_, _ = h.doReq(jarA, http.MethodPost, "/api/v1/vault/recover/complete",
		mustJSON(t, makeRecoverCompletePayload(t, lookupA.RecoveryKeyID, 0xB3)),
		reqOptions{
			idemKey: "idem-rec-comp-drain-05",
			ifMatch: `"` + createdA.VaultKeyID + `:2"`,
			grant:   grantA,
		})

	// Advance clock by 6 minutes: grantA (5m TTL) is now EXPIRED, while the 15m rate-limit window is STILL FULL (5/5).
	h.clk.Advance(6 * time.Minute)
	// Refresh session access cookie if needed or re-use session (10m access TTL is still valid at +6m).
	respRetry, rawRetry := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recover/complete", completeBodyA, reqOptions{
		idemKey: idemKeySuccess,
		ifMatch: `"` + createdA.VaultKeyID + `:1"`,
		grant:   grantA, // expired grant, but idempotency Lookup runs at step 2 before RequireReauth and UserLimiter!
	})
	if respRetry.StatusCode != http.StatusOK {
		t.Fatalf("same-key retry = %d %s, want 200 (not 429 or 401)", respRetry.StatusCode, rawRetry)
	}
	var retryVerResp vault.VaultVersionResponse
	if err := json.Unmarshal([]byte(rawRetry), &retryVerResp); err != nil || retryVerResp != verResp {
		t.Fatalf("same-key retry decoded = %+v (%s), want %+v", retryVerResp, rawRetry, verResp)
	}

	// Verify no extra RK was deleted (still 9 remaining).
	_, rawStatus := h.doReq(jarA, http.MethodGet, "/api/v1/vault/recovery-keys", "", reqOptions{})
	var rkStatus vault.RecoveryKeysStatus
	_ = json.Unmarshal([]byte(rawStatus), &rkStatus)
	if rkStatus.Remaining != 9 {
		t.Fatalf("Remaining after idempotent retry = %d, want 9", rkStatus.Remaining)
	}

	// 6. Verify logs, audit_log, and user_notification never contain lookup_hash or wraps.
	sentinels := []string{
		payloadA.RecoveryKeys[0].LookupHash,
		payloadA.RecoveryKeys[0].Wrap,
		completePayloadA.VaultKeyWrappedByKEK,
		completePayloadA.KDF.Salt,
	}
	logStr := h.logs.String()
	for _, s := range sentinels {
		if strings.Contains(logStr, s) {
			t.Fatalf("logs leaked sensitive value %q: %s", s, logStr)
		}
	}

	var noticeCount, jobCount int
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM user_notification WHERE user_id = $1`,
		meA.User.ID,
	).Scan(&noticeCount); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`,
	).Scan(&jobCount); err != nil {
		t.Fatal(err)
	}
	if noticeCount != 1 || jobCount != 1 {
		t.Fatalf("user_notification=%d river_job=%d after recover+replay, want 1 and 1", noticeCount, jobCount)
	}
	if beforeWorker := h.countSecurityMailsDelivered("rec-complete-a@example.com"); beforeWorker != 0 {
		t.Fatalf("direct emails before worker = %d, want 0", beforeWorker)
	}
	if ran, err := h.runSecurityNoticeWorker(context.Background(), h.mail); err != nil || ran != 1 {
		t.Fatalf("runSecurityNoticeWorker = (%d, %v), want (1, nil)", ran, err)
	}
	if total := h.countSecurityMailsDelivered("rec-complete-a@example.com"); total != 1 {
		t.Fatalf("total security emails delivered after recover+replay = %d, want 1", total)
	}

	_, rawAudit := h.doReq(jarA, http.MethodGet, "/api/v1/auth/audit", "", reqOptions{})
	for _, s := range sentinels {
		if strings.Contains(rawAudit, s) {
			t.Fatalf("GET /auth/audit leaked sensitive value %q: %s", s, rawAudit)
		}
	}
}

// TestRecoveryRateLimitsSeparateBucketsSixthBlocked covers Task 10 bullet:
// "6th request within 15 min blocked (429 + Retry-After) at lookup AND at complete
// (separate buckets; a lookup hit does not drain complete)."
func TestRecoveryRateLimitsSeparateBucketsSixthBlocked(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	jar, _ := h.signupUser("rec-ratelimit@example.com", password)

	payload := makeCreatePayload(t, 0x44)
	resp, raw := h.doReq(jar, http.MethodPost, "/api/v1/vault", mustJSON(t, payload), reqOptions{
		idemKey: "idem-rec-rl-create-01",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create vault = %d %s", resp.StatusCode, raw)
	}
	var created vault.VaultCreatedResponse
	_ = json.Unmarshal([]byte(raw), &created)

	// 1. Send 5 lookup requests (all hits!) within 15 minutes -> all 5 succeed (200) and count toward vault_recovery_lookup.
	var rkIDs []uuid.UUID
	for i := range 5 {
		body := `{"lookup_hash":"` + payload.RecoveryKeys[i].LookupHash + `"}`
		r, rawBody := h.doReq(jar, http.MethodPost, "/api/v1/vault/unlock/recovery", body, reqOptions{})
		if r.StatusCode != http.StatusOK {
			t.Fatalf("lookup #%d = %d %s, want 200", i+1, r.StatusCode, rawBody)
		}
		var lr vault.RecoveryLookupResponse
		if err := json.Unmarshal([]byte(rawBody), &lr); err != nil {
			t.Fatal(err)
		}
		rkIDs = append(rkIDs, lr.RecoveryKeyID)
	}

	// 2. 6th lookup within 15 minutes is blocked with 429 rate_limited + Retry-After header.
	r6, raw6 := h.doReq(jar, http.MethodPost, "/api/v1/vault/unlock/recovery",
		`{"lookup_hash":"`+payload.RecoveryKeys[5].LookupHash+`"}`, reqOptions{})
	if r6.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("6th lookup = %d %s, want 429", r6.StatusCode, raw6)
	}
	retryAfterHdr := r6.Header.Get("Retry-After")
	retryAfterSec, err := strconv.Atoi(retryAfterHdr)
	if err != nil || retryAfterSec <= 0 {
		t.Fatalf("6th lookup Retry-After header = %q, want positive integer", retryAfterHdr)
	}
	prob6 := decodeProblem(t, raw6)
	if prob6.Code != "rate_limited" || prob6.RetryAfter == nil || *prob6.RetryAfter <= 0 {
		t.Fatalf("6th lookup problem = %+v, want rate_limited with retry_after", prob6)
	}

	// 3. Even though vault_recovery_lookup is exhausted (5/5), POST /vault/recover/complete uses a SEPARATE bucket
	// (vault_recovery_complete), so 5 complete requests still succeed!
	grant := h.reauthGrant(jar, "vault.recover", password)
	curVersion := created.Version
	for i := range 5 {
		cp := makeRecoverCompletePayload(t, rkIDs[i], byte(0xC0+i*5))
		rc, rawC := h.doReq(jar, http.MethodPost, "/api/v1/vault/recover/complete", mustJSON(t, cp), reqOptions{
			idemKey: "idem-rec-rl-complete-0" + strconv.Itoa(i+1),
			ifMatch: `"` + created.VaultKeyID + `:` + strconv.Itoa(int(curVersion)) + `"`,
			grant:   grant,
		})
		if rc.StatusCode != http.StatusOK {
			t.Fatalf("complete #%d = %d %s, want 200", i+1, rc.StatusCode, rawC)
		}
		var vr vault.VaultVersionResponse
		if err := json.Unmarshal([]byte(rawC), &vr); err != nil {
			t.Fatal(err)
		}
		curVersion = vr.Version
	}

	// 4. 6th complete request within 15 minutes is blocked with 429 rate_limited + Retry-After header.
	cp6 := makeRecoverCompletePayload(t, uuid.New(), 0xF5)
	rc6, rawC6 := h.doReq(jar, http.MethodPost, "/api/v1/vault/recover/complete", mustJSON(t, cp6), reqOptions{
		idemKey: "idem-rec-rl-complete-06",
		ifMatch: `"` + created.VaultKeyID + `:` + strconv.Itoa(int(curVersion)) + `"`,
		grant:   grant,
	})
	if rc6.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("6th complete = %d %s, want 429", rc6.StatusCode, rawC6)
	}
	if ra := rc6.Header.Get("Retry-After"); ra == "" {
		t.Fatal("6th complete missing Retry-After header")
	}
	probC6 := decodeProblem(t, rawC6)
	if probC6.Code != "rate_limited" || probC6.RetryAfter == nil || *probC6.RetryAfter <= 0 {
		t.Fatalf("6th complete problem = %+v, want rate_limited with retry_after", probC6)
	}
}

type lateOwnershipTakeoverTracer struct {
	once       atomic.Bool
	onFinishTx func()
}

func (t *lateOwnershipTakeoverTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	if strings.Contains(d.SQL, "UPDATE idempotency_key") && t.once.CompareAndSwap(false, true) {
		t.onFinishTx()
	}
	return ctx
}

func (t *lateOwnershipTakeoverTracer) TraceQueryEnd(_ context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
}

// TestRecoverCompleteLateOwnershipLossRollsBackVaultRKsAuditNoticeAndJob covers BE1-15:
// forces idempotency ownership loss inside a real POST /vault/recover/complete mutation
// AFTER vault KDF/wrap update, RK consumption, audit insertion, and security notice + River
// job insertion, right before FinishIdempotencyKey / COMMIT. Verifies full rollback atomicity:
//   - original vault/KDF/wrap/version (1) and all 10 RKs remain intact;
//   - zero vault.recover / recovery_key.consume audit rows;
//   - zero user_notification rows, zero river_job rows, zero delivered emails (would fail if
//     NotifySecurity were passed a nil tx);
//   - no finalized idempotency response (status remains 'in_progress', response/status_code NULL);
//   - the new owner's claim token is preserved (not deleted by step-8 release).
func TestRecoverCompleteLateOwnershipLossRollsBackVaultRKsAuditNoticeAndJob(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	email := "late-ownership-loss@example.com"
	jarA, meA := h.signupUser(email, password)
	ctx := context.Background()

	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, meA.User.ID); err != nil {
		t.Fatal(err)
	}

	createPayload := makeCreatePayload(t, 0x31)
	respCreate, rawCreate := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, createPayload), reqOptions{
		idemKey: "idem-late-fail-create-0001",
	})
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault = %d %s", respCreate.StatusCode, rawCreate)
	}
	var created vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawCreate), &created); err != nil {
		t.Fatal(err)
	}

	respLookup, rawLookup := h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/recovery",
		`{"lookup_hash":"`+createPayload.RecoveryKeys[0].LookupHash+`"}`, reqOptions{})
	if respLookup.StatusCode != http.StatusOK {
		t.Fatalf("lookup slot 1 = %d %s", respLookup.StatusCode, rawLookup)
	}
	var lookupRes vault.RecoveryLookupResponse
	if err := json.Unmarshal([]byte(rawLookup), &lookupRes); err != nil {
		t.Fatal(err)
	}

	idemKey := "idem-late-fail-recover-0001"
	completePayload := makeRecoverCompletePayload(t, lookupRes.RecoveryKeyID, 0x84)
	completeBody := mustJSON(t, completePayload)
	fp := httpx.ComputeIdempotencyFingerprint(http.MethodPost, "/api/v1/vault/recover/complete", []byte(completeBody))
	newOwner := uuid.New()
	var takeoverErr error

	tracer := &lateOwnershipTakeoverTracer{
		onFinishTx: func() {
			// Advance clock past the 60s in_progress window so a second claimant can legitimately
			// take over the in_progress row right before the first transaction runs FinishIdempotencyKey.
			h.clk.Advance(61 * time.Second)
			reclaimNow := h.clk.Now()
			_, takeoverErr = gen.New(h.pool).ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
				UserID:      meA.User.ID,
				Key:         idemKey,
				Method:      http.MethodPost,
				Path:        "/api/v1/vault/recover/complete",
				RequestHash: fp,
				OwnerToken:  newOwner,
				Now:         pgtype.Timestamptz{Time: reclaimNow, Valid: true},
			})
		},
	}

	pcfg := h.pool.Config()
	pcfg.ConnConfig.Tracer = tracer
	tracedPool, err := pgxpool.NewWithConfig(ctx, pcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tracedPool.Close)

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.AppOrigin = h.origin
	riverInsert, err := river.NewClient(riverpgxv5.New(tracedPool), &river.Config{})
	if err != nil {
		t.Fatal(err)
	}
	_, _, authAPI, err := compose.NewAuth(cfg, tracedPool, riverInsert, h.clk, h.mail, nil)
	if err != nil {
		t.Fatal(err)
	}
	vaultSvc, vaultAPI, err := compose.NewVault(cfg, tracedPool, riverInsert, h.clk, h.mail, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	authn, csrfv, reauth := compose.Adapters(h.authSvc)
	srv := httptest.NewServer(httpx.NewRouter(httpx.Deps{
		Config:        cfg,
		Logger:        slog.Default(),
		Authenticator: authn,
		CSRF:          csrfv,
		Reauth:        reauth,
		MountAPI:      compose.MountAll(authhttp.Mount(authAPI), vaulthttp.Mount(vaultAPI)),
	}))
	t.Cleanup(srv.Close)

	tracedHarness := &harness{
		t:        t,
		srv:      srv,
		origin:   h.origin,
		clk:      h.clk,
		mail:     h.mail,
		authSvc:  h.authSvc,
		vaultSvc: vaultSvc,
		vaultAPI: vaultAPI,
		pool:     tracedPool,
		logs:     h.logs,
	}

	grant := h.reauthGrant(jarA, "vault.recover", password)
	ifMatch := formatIfMatchTag(created.VaultKeyID, 1)
	resp, raw := tracedHarness.doReq(jarA, http.MethodPost, "/api/v1/vault/recover/complete", completeBody, reqOptions{
		idemKey: idemKey,
		ifMatch: ifMatch,
		grant:   grant,
	})
	if takeoverErr != nil {
		t.Fatalf("ownership takeover ClaimIdempotencyKey failed: %v", takeoverErr)
	}
	if !tracer.once.Load() {
		t.Fatal("lateOwnershipTakeoverTracer was never triggered")
	}
	if resp.StatusCode < 400 {
		t.Fatalf("expected non-2xx on late ownership loss, got %d %s", resp.StatusCode, raw)
	}

	// 1. Original vault/KDF/wrap/version and all 10 RKs remain unchanged.
	respGet, rawGet := h.doReq(jarA, http.MethodGet, "/api/v1/vault", "", reqOptions{})
	if respGet.StatusCode != http.StatusOK {
		t.Fatalf("GET /vault = %d %s", respGet.StatusCode, rawGet)
	}
	var state vault.VaultState
	if err := json.Unmarshal([]byte(rawGet), &state); err != nil {
		t.Fatal(err)
	}
	if state.VaultKeyID != created.VaultKeyID ||
		state.Version != 1 ||
		state.KDF != createPayload.KDF ||
		state.VaultKeyWrappedByKEK != createPayload.VaultKeyWrappedByKEK ||
		state.RecoveryKeysRemaining != 10 {
		t.Fatalf("vault state altered after rolled-back recovery: got %+v, want version=1 kdf=%+v wrap=%s remaining=10",
			state, createPayload.KDF, createPayload.VaultKeyWrappedByKEK)
	}

	// Slot 1 RK is still present and lookup still succeeds.
	respLookupAfter, rawLookupAfter := h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/recovery",
		`{"lookup_hash":"`+createPayload.RecoveryKeys[0].LookupHash+`"}`, reqOptions{})
	if respLookupAfter.StatusCode != http.StatusOK {
		t.Fatalf("slot 1 lookup after rollback = %d %s, want 200", respLookupAfter.StatusCode, rawLookupAfter)
	}

	// 2. Zero audit rows for vault.recover or recovery_key.consume, zero notices, zero River jobs, zero emails.
	var recAudits, notices, jobs int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_log WHERE user_id = $1 AND event IN ($2, $3)`,
		meA.User.ID, vault.EventVaultRecover, vault.EventRecoveryKeyConsume,
	).Scan(&recAudits); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM user_notification WHERE user_id = $1`,
		meA.User.ID,
	).Scan(&notices); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`,
	).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if recAudits != 0 || notices != 0 || jobs != 0 {
		t.Fatalf("leftover side effects after rollback: audits=%d notices=%d jobs=%d, want 0/0/0", recAudits, notices, jobs)
	}
	if delivered := h.countSecurityMailsDelivered(email); delivered != 0 {
		t.Fatalf("delivered emails after rollback = %d, want 0", delivered)
	}

	// 3. No finalized idempotency response, and the new owner's claim is preserved.
	idemRow, err := gen.New(h.pool).GetIdempotencyKey(ctx, gen.GetIdempotencyKeyParams{
		UserID: meA.User.ID,
		Key:    idemKey,
		Now:    pgtype.Timestamptz{Time: h.clk.Now(), Valid: true},
	})
	if err != nil {
		t.Fatalf("GetIdempotencyKey after rollback: %v", err)
	}
	if idemRow.Status != "in_progress" || idemRow.OwnerToken != newOwner || idemRow.StatusCode != nil || len(idemRow.Response) != 0 {
		t.Fatalf("idempotency row after rollback = %+v, want status=in_progress owner=%s status_code=NULL response=empty",
			idemRow, newOwner)
	}
}
