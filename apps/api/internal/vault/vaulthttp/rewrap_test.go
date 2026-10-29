package vaulthttp_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/notification"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/worker"
)

type rewrapPayload struct {
	KDF                  vault.KDFParams `json:"kdf"`
	VaultKeyWrappedByKEK string          `json:"vault_key_wrapped_by_kek"`
}

func makeRewrapPayload(t *testing.T, ops, mem int, saltSeed, wrapSeed byte) rewrapPayload {
	t.Helper()
	return rewrapPayload{
		KDF: vault.KDFParams{
			Alg:         "argon2id13",
			Ops:         ops,
			Mem:         mem,
			Parallelism: 1,
			Salt:        vault.EncodeBase64URL(seqTestBytes(16, saltSeed)),
		},
		VaultKeyWrappedByKEK: makeWrapB64U(t, vault.WrapKindKEK, wrapSeed),
	}
}

type failingMailer struct {
	calls atomic.Int32
}

func (m *failingMailer) Send(_ context.Context, _, _, _ string) error {
	m.calls.Add(1)
	return errors.New("simulated mail delivery error")
}

type versionMismatchResp struct {
	httpx.Problem
	CurrentVersion *int32 `json:"current_version"`
}

func formatIfMatchTag(vaultKeyID string, version int32) string {
	return `"` + vaultKeyID + `:` + strconv.Itoa(int(version)) + `"`
}

// TestVaultRewrapGrantsPreconditionsKDFValidationAndUntouchedRKsPasskeys covers plan Task 9 bullets:
// - missing/invalid grant, wrong action grant -> P02 reauth error (401 reauth_invalid)
// - missing If-Match -> 428 precondition_required
// - old version -> 412 version_mismatch (with current_version)
// - lower KDF than current or reused salt -> 400 vault_kdf_invalid
// - invalid wrap -> 400 vault_wrap_invalid
// - RK rows and passkeys of vault unchanged after rewrap
// - retry with same Idempotency-Key after lost response returns original response (no second version bump)
// - notice exists when user has no verified email
func TestVaultRewrapGrantsPreconditionsKDFValidationAndUntouchedRKsPasskeys(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	jarA, meA := h.signupUser("rewrap-http@example.com", password)

	// Create vault for user A (email is unverified by default on signup).
	createReq := makeCreatePayload(t, 0x10)
	respCreate, rawCreate := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, createReq), reqOptions{
		idemKey: "idem-rewrap-setup-create01",
	})
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault = %d %s", respCreate.StatusCode, rawCreate)
	}
	var created vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawCreate), &created); err != nil {
		t.Fatal(err)
	}

	// Insert a passkey row and snapshot RKs + passkeys before rewrap.
	ctx := context.Background()
	q := gen.New(h.pool)
	aaguid := uuid.MustParse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
	aaguidBytes, _ := aaguid.MarshalBinary()
	pkBefore, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID:  meA.User.ID,
		CredID:  seqTestBytes(32, 0xC1),
		Pubkey:  seqTestBytes(32, 0xC2),
		PrfSalt: seqTestBytes(32, 0xC3),
		VkWrap:  seqTestBytes(vault.VKWrapBytes, 0x01),
		Aaguid:  aaguidBytes,
		Name:    "MacBook Touch ID",
	})
	if err != nil {
		t.Fatalf("InsertPasskey: %v", err)
	}

	ifMatchV1 := formatIfMatchTag(created.VaultKeyID, created.Version)
	validBody1 := mustJSON(t, makeRewrapPayload(t, 4, 134217728, 0x21, 0x22))

	// 1. Missing grant -> 401 reauth_invalid.
	resp, raw := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", validBody1, reqOptions{
		idemKey: "idem-rewrap-missing-grant",
		ifMatch: ifMatchV1,
	})
	if resp.StatusCode != http.StatusUnauthorized || decodeProblem(t, raw).Code != "reauth_invalid" {
		t.Fatalf("missing grant = %d %s, want 401 reauth_invalid", resp.StatusCode, raw)
	}

	// 2. Malformed/invalid grant -> 401 reauth_invalid.
	resp, raw = h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", validBody1, reqOptions{
		idemKey: "idem-rewrap-malformed-grant",
		ifMatch: ifMatchV1,
		grant:   "invalid-grant-token",
	})
	if resp.StatusCode != http.StatusUnauthorized || decodeProblem(t, raw).Code != "reauth_invalid" {
		t.Fatalf("malformed grant = %d %s, want 401 reauth_invalid", resp.StatusCode, raw)
	}

	// 3. Wrong action grant (e.g. vault.reset instead of vault.rewrap) -> 401 reauth_invalid.
	wrongGrant := h.reauthGrant(jarA, "vault.reset", password)
	resp, raw = h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", validBody1, reqOptions{
		idemKey: "idem-rewrap-wrong-action",
		ifMatch: ifMatchV1,
		grant:   wrongGrant,
	})
	if resp.StatusCode != http.StatusUnauthorized || decodeProblem(t, raw).Code != "reauth_invalid" {
		t.Fatalf("wrong action grant = %d %s, want 401 reauth_invalid", resp.StatusCode, raw)
	}

	rewrapGrant := h.reauthGrant(jarA, "vault.rewrap", password)

	// 4. Missing If-Match -> 428 precondition_required.
	resp, raw = h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", validBody1, reqOptions{
		idemKey: "idem-rewrap-missing-ifmatch",
		grant:   rewrapGrant,
	})
	if resp.StatusCode != http.StatusPreconditionRequired || decodeProblem(t, raw).Code != "precondition_required" {
		t.Fatalf("missing If-Match = %d %s, want 428 precondition_required", resp.StatusCode, raw)
	}

	// 5. Reused salt (same salt as current vault.kdf) -> 400 vault_kdf_invalid.
	reusedSaltPayload := makeRewrapPayload(t, 3, 67108864, 0x21, 0x22)
	reusedSaltPayload.KDF.Salt = createReq.KDF.Salt
	resp, raw = h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", mustJSON(t, reusedSaltPayload), reqOptions{
		idemKey: "idem-rewrap-reused-salt01",
		ifMatch: ifMatchV1,
		grant:   rewrapGrant,
	})
	if resp.StatusCode != http.StatusBadRequest || decodeProblem(t, raw).Code != "vault_kdf_invalid" {
		t.Fatalf("reused salt = %d %s, want 400 vault_kdf_invalid", resp.StatusCode, raw)
	}

	// 6. Invalid wrap -> 400 vault_wrap_invalid.
	badWrapPayload := makeRewrapPayload(t, 3, 67108864, 0x25, 0x26)
	badWrapPayload.VaultKeyWrappedByKEK = vault.EncodeBase64URL(seqTestBytes(73, 0x02)) // version byte 0x02 != 0x01
	resp, raw = h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", mustJSON(t, badWrapPayload), reqOptions{
		idemKey: "idem-rewrap-bad-wrap-ver",
		ifMatch: ifMatchV1,
		grant:   rewrapGrant,
	})
	if resp.StatusCode != http.StatusBadRequest || decodeProblem(t, raw).Code != "vault_wrap_invalid" {
		t.Fatalf("bad wrap = %d %s, want 400 vault_wrap_invalid", resp.StatusCode, raw)
	}

	// 7. Successful rewrap (v1 -> v2, raising KDF to ops=4, mem=128 MiB):
	// returns 200 {version: 2}, records audit vault.rewrap, creates in-app notice even though user has no verified email.
	idemKeyRewrap1 := "idem-rewrap-success-0001"
	respOK, rawOK := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", validBody1, reqOptions{
		idemKey: idemKeyRewrap1,
		ifMatch: ifMatchV1,
		grant:   rewrapGrant,
	})
	if respOK.StatusCode != http.StatusOK {
		t.Fatalf("PUT /vault/kek = %d %s, want 200", respOK.StatusCode, rawOK)
	}
	var vResp vault.VaultVersionResponse
	if err := json.Unmarshal([]byte(rawOK), &vResp); err != nil {
		t.Fatal(err)
	}
	if vResp.Version != 2 {
		t.Fatalf("vResp.Version = %d, want 2", vResp.Version)
	}

	// 8. Retry with the SAME Idempotency-Key + same body after lost response (even after advancing clock past 5m grant TTL
	// and sending the old If-Match v1): returns the original 200 {version: 2} without bumping version a second time.
	h.clk.Advance(6 * time.Minute)
	respRetry, rawRetry := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", validBody1, reqOptions{
		idemKey: idemKeyRewrap1,
		ifMatch: ifMatchV1,
		grant:   rewrapGrant, // expired grant still replays committed idempotency record at step 2
	})
	if respRetry.StatusCode != http.StatusOK {
		t.Fatalf("idempotent retry PUT /vault/kek = %d %s, want 200", respRetry.StatusCode, rawRetry)
	}
	var vRespRetry vault.VaultVersionResponse
	if err := json.Unmarshal([]byte(rawRetry), &vRespRetry); err != nil {
		t.Fatal(err)
	}
	if vRespRetry.Version != 2 {
		t.Fatalf("retry Version = %d, want 2 (no second bump)", vRespRetry.Version)
	}

	// Issue fresh grant after clock advance.
	rewrapGrant2 := h.reauthGrant(jarA, "vault.rewrap", password)

	// 9. Old version (If-Match version=1 when current version=2) -> 412 version_mismatch with current_version=2.
	validBody2 := mustJSON(t, makeRewrapPayload(t, 4, 134217728, 0x31, 0x32))
	respStale, rawStale := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", validBody2, reqOptions{
		idemKey: "idem-rewrap-stale-version1",
		ifMatch: ifMatchV1,
		grant:   rewrapGrant2,
	})
	if respStale.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("stale If-Match status = %d %s, want 412", respStale.StatusCode, rawStale)
	}
	var probStale versionMismatchResp
	if err := json.Unmarshal([]byte(rawStale), &probStale); err != nil {
		t.Fatalf("decode stale problem (%s): %v", rawStale, err)
	}
	if probStale.Code != "version_mismatch" || probStale.CurrentVersion == nil || *probStale.CurrentVersion != 2 {
		t.Fatalf("stale If-Match problem = %+v, want version_mismatch with current_version=2", probStale)
	}

	// 10. Lower KDF params than current (current has ops=4, mem=134217728):
	// independently reject fresh-salt {ops:3, mem:134217728}, {ops:4, mem:67108864}, and {ops:3, mem:67108864} -> 400 vault_kdf_invalid (BE1-14).
	ifMatchV2 := formatIfMatchTag(created.VaultKeyID, 2)
	for i, tc := range []struct {
		name string
		ops  int
		mem  int
	}{
		{name: "lower_ops_only", ops: 3, mem: 134217728},
		{name: "lower_mem_only", ops: 4, mem: 67108864},
		{name: "lower_both", ops: 3, mem: 67108864},
	} {
		lowerKDFBody := mustJSON(t, makeRewrapPayload(t, tc.ops, tc.mem, byte(0x41+i*3), byte(0x42+i*3)))
		respLower, rawLower := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", lowerKDFBody, reqOptions{
			idemKey: "idem-rewrap-lower-kdf-" + tc.name,
			ifMatch: ifMatchV2,
			grant:   rewrapGrant2,
		})
		if respLower.StatusCode != http.StatusBadRequest || decodeProblem(t, rawLower).Code != "vault_kdf_invalid" {
			t.Fatalf("lower KDF (%s) = %d %s, want 400 vault_kdf_invalid", tc.name, respLower.StatusCode, rawLower)
		}
	}
	// 11. Verify RK rows and passkeys are completely unchanged after rewrap, and vault_key_id is unchanged.
	respGet, rawGet := h.doReq(jarA, http.MethodGet, "/api/v1/vault", "", reqOptions{})
	if respGet.StatusCode != http.StatusOK {
		t.Fatalf("GET /vault = %d %s", respGet.StatusCode, rawGet)
	}
	var state vault.VaultState
	if err := json.Unmarshal([]byte(rawGet), &state); err != nil {
		t.Fatal(err)
	}
	if state.VaultKeyID != created.VaultKeyID || state.Version != 2 || state.RecoveryKeysRemaining != 10 {
		t.Fatalf("state after rewrap = %+v", state)
	}
	if len(state.Passkeys) != 1 || state.Passkeys[0].ID != pkBefore.ID || state.Passkeys[0].Name != "MacBook Touch ID" {
		t.Fatalf("passkeys after rewrap = %+v", state.Passkeys)
	}
	for i, rk := range createReq.RecoveryKeys {
		var gotHash, gotWrap []byte
		if err := h.pool.QueryRow(ctx,
			`SELECT lookup_hash, wrap FROM vault_recovery_key WHERE vault_id = $1 AND slot = $2`,
			meA.User.ID, rk.Slot,
		).Scan(&gotHash, &gotWrap); err != nil {
			t.Fatalf("slot %d missing after rewrap: %v", rk.Slot, err)
		}
		if vault.EncodeBase64URL(gotHash) != rk.LookupHash || vault.EncodeBase64URL(gotWrap) != rk.Wrap {
			t.Fatalf("slot %d RK altered at index %d", rk.Slot, i)
		}
	}

	// 12. Verify in-app security notice exists for user without verified email, no security_notice_mail job is queued,
	// and audit_log has exactly 1 vault.rewrap row.
	var noticeCount, jobCount, auditCount int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`, meA.User.ID).Scan(&noticeCount); err != nil {
		t.Fatal(err)
	}
	if noticeCount != 1 {
		t.Fatalf("user_notification count for unverified user = %d, want 1", noticeCount)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`).Scan(&jobCount); err != nil {
		t.Fatal(err)
	}
	if jobCount != 0 {
		t.Fatalf("river_job security_notice_mail count for unverified user = %d, want 0", jobCount)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`, meA.User.ID, vault.EventVaultRewrap).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("audit_log vault.rewrap count = %d, want 1", auditCount)
	}
}

// TestVaultRewrapFailingMailAdapterStillCommits covers plan Task 9 ("mail adapter lỗi vẫn commit")
// and BE1-12 + BE1-16 with a real River-backed notifier + SecurityNoticeWorker:
//   - failed mutation leaves 0 user_notification rows and 0 river_job rows;
//   - one committed mutation creates 1 user_notification row and 1 river_job row, with 0 immediate direct sends;
//   - idempotent replay adds 0 notices, 0 jobs, and 0 delivered emails;
//   - failing mail delivery in SecurityNoticeWorker never rolls back the committed mutation;
//   - successful worker execution delivers exactly 1 message (never 2).
func TestVaultRewrapFailingMailAdapterStillCommits(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	email := "verified-mail-fail@example.com"
	jarA, meA := h.signupUser(email, password)

	ctx := context.Background()
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, meA.User.ID); err != nil {
		t.Fatal(err)
	}

	createReq := makeCreatePayload(t, 0x20)
	respCreate, rawCreate := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, createReq), reqOptions{
		idemKey: "idem-mailfail-create-0001",
	})
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault = %d %s", respCreate.StatusCode, rawCreate)
	}
	var created vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawCreate), &created); err != nil {
		t.Fatal(err)
	}

	grant := h.reauthGrant(jarA, "vault.rewrap", password)
	rewrapReq := makeRewrapPayload(t, 3, 67108864, 0x77, 0x88)
	rewrapBody := mustJSON(t, rewrapReq)

	// 1. Failed mutation (stale If-Match -> 412) leaves 0 notices and 0 queued jobs.
	respFail, rawFail := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", rewrapBody, reqOptions{
		idemKey: "idem-mailfail-rewrap-stale",
		ifMatch: formatIfMatchTag(created.VaultKeyID, 99),
		grant:   grant,
	})
	if respFail.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("stale PUT /vault/kek = %d %s, want 412", respFail.StatusCode, rawFail)
	}
	var noticesAfterFail, jobsAfterFail int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1`, meA.User.ID).Scan(&noticesAfterFail); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`).Scan(&jobsAfterFail); err != nil {
		t.Fatal(err)
	}
	if noticesAfterFail != 0 || jobsAfterFail != 0 {
		t.Fatalf("failed mutation left notices=%d jobs=%d, want 0/0", noticesAfterFail, jobsAfterFail)
	}

	// 2. Successful mutation -> 200 {version: 2}, 1 notice, 1 River job, 0 direct emails before worker runs.
	ifMatch := formatIfMatchTag(created.VaultKeyID, created.Version)
	idemKeyOK := "idem-mailfail-rewrap-0001"
	respRewrap, rawRewrap := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", rewrapBody, reqOptions{
		idemKey: idemKeyOK,
		ifMatch: ifMatch,
		grant:   grant,
	})
	if respRewrap.StatusCode != http.StatusOK {
		t.Fatalf("PUT /vault/kek = %d %s, want 200", respRewrap.StatusCode, rawRewrap)
	}
	var vResp vault.VaultVersionResponse
	if err := json.Unmarshal([]byte(rawRewrap), &vResp); err != nil || vResp.Version != 2 {
		t.Fatalf("vResp = %+v (err=%v), want version=2", vResp, err)
	}
	if gotDirect := h.countSecurityMailsDelivered(email); gotDirect != 0 {
		t.Fatalf("immediate security emails delivered before worker run = %d, want 0 (single queued owner)", gotDirect)
	}

	// 3. Idempotent replay adds 0 notices and 0 jobs.
	respReplay, rawReplay := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", rewrapBody, reqOptions{
		idemKey: idemKeyOK,
		ifMatch: ifMatch,
		grant:   grant,
	})
	if respReplay.StatusCode != http.StatusOK {
		t.Fatalf("replay PUT /vault/kek = %d %s, want 200", respReplay.StatusCode, rawReplay)
	}

	var noticeID int64
	var noticesAfterOK, jobsAfterOK int
	if err := h.pool.QueryRow(ctx, `SELECT count(*), coalesce(max(id), 0) FROM user_notification WHERE user_id = $1`, meA.User.ID).Scan(&noticesAfterOK, &noticeID); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`).Scan(&jobsAfterOK); err != nil {
		t.Fatal(err)
	}
	if noticesAfterOK != 1 || jobsAfterOK != 1 || noticeID == 0 {
		t.Fatalf("after commit + replay: notices=%d jobs=%d noticeID=%d, want 1/1/>0", noticesAfterOK, jobsAfterOK, noticeID)
	}

	// 4. Failing mail delivery in SecurityNoticeWorker returns the adapter error and NEVER rolls back the committed mutation.
	failMail := &failingMailer{}
	var rawArgs []byte
	if err := h.pool.QueryRow(ctx, `SELECT args FROM river_job WHERE kind = 'security_notice_mail' LIMIT 1`).Scan(&rawArgs); err != nil {
		t.Fatal(err)
	}
	var jobArgs notification.SecurityNoticeArgs
	if err := json.Unmarshal(rawArgs, &jobArgs); err != nil {
		t.Fatal(err)
	}
	failWorker := worker.NewSecurityNoticeWorker(h.pool, failMail, slog.New(slog.NewJSONHandler(h.logs, nil)))
	if err := failWorker.Work(ctx, &river.Job[notification.SecurityNoticeArgs]{Args: jobArgs}); err == nil {
		t.Fatal("expected SecurityNoticeWorker with failingMailer to return error")
	}
	if failMail.calls.Load() != 1 {
		t.Fatalf("failingMailer calls = %d, want 1", failMail.calls.Load())
	}

	// Verify DB committed version=2, wrap, audit, and notification remain intact after worker mail failure.
	respGet, rawGet := h.doReq(jarA, http.MethodGet, "/api/v1/vault", "", reqOptions{})
	if respGet.StatusCode != http.StatusOK {
		t.Fatalf("GET /vault = %d %s", respGet.StatusCode, rawGet)
	}
	var state vault.VaultState
	if err := json.Unmarshal([]byte(rawGet), &state); err != nil {
		t.Fatal(err)
	}
	if state.Version != 2 || state.VaultKeyWrappedByKEK != rewrapReq.VaultKeyWrappedByKEK {
		t.Fatalf("state after failing mail = %+v", state)
	}

	// 5. Running the queued job with the working SinkMailer delivers 1 message; total delivered across all purposes is 1 (never 2).
	ranJobs, err := h.runSecurityNoticeWorker(ctx, h.mail)
	if err != nil || ranJobs != 1 {
		t.Fatalf("runSecurityNoticeWorker = (%d, %v), want (1, nil)", ranJobs, err)
	}
	if totalDelivered := h.countSecurityMailsDelivered(email); totalDelivered != 1 {
		t.Fatalf("total security emails delivered for one rewrap = %d, want 1", totalDelivered)
	}

	// Ensure logs never contain wrap.
	if strings.Contains(h.logs.String(), rewrapReq.VaultKeyWrappedByKEK) {
		t.Fatalf("logs leaked wrap: %s", h.logs.String())
	}
}

// TestVaultRewrapRealWorkerRunDefaultDevelopmentMailSink covers BE2-1 and BE2-4 (advisor-dec-024):
// with AUTH_MAIL_SINK_DIR unset/empty in development, committing a verified-email vault rewrap
// over HTTP and running the REAL worker.Run delivers exactly 1 security email to the shared
// default sink (.data/mail-sink in the temp working directory), and an idempotent replay adds none.
func TestVaultRewrapRealWorkerRunDefaultDevelopmentMailSink(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("AUTH_MAIL_SINK_DIR", "")

	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	email := "rewrap-real-worker-default-sink@example.com"
	jarA, meA := h.signupUser(email, password)

	ctx := context.Background()
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, meA.User.ID); err != nil {
		t.Fatal(err)
	}

	createReq := makeCreatePayload(t, 0x31)
	respCreate, rawCreate := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, createReq), reqOptions{
		idemKey: "idem-real-worker-create-01",
	})
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault = %d %s", respCreate.StatusCode, rawCreate)
	}
	var created vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawCreate), &created); err != nil {
		t.Fatal(err)
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	cfg.ShutdownTimeout = 5 * time.Second
	wantSink := filepath.Join(".data", "mail-sink")
	if cfg.MailSinkDir != "" || cfg.EffectiveMailSinkDir() != wantSink {
		t.Fatalf("MailSinkDir=%q EffectiveMailSinkDir()=%q, want empty and %q", cfg.MailSinkDir, cfg.EffectiveMailSinkDir(), wantSink)
	}

	grant := h.reauthGrant(jarA, "vault.rewrap", password)
	rewrapReq := makeRewrapPayload(t, 3, 67108864, 0x51, 0x61)
	rewrapBody := mustJSON(t, rewrapReq)
	ifMatch := formatIfMatchTag(created.VaultKeyID, created.Version)
	idemKey := "idem-real-worker-rewrap-01"

	runCtx, cancelRun := context.WithCancel(ctx)
	runDone := make(chan error, 1)
	silentLog := slog.New(slog.NewJSONHandler(io.Discard, nil))
	go func() {
		runDone <- worker.Run(runCtx, cfg, silentLog)
	}()
	defer func() {
		cancelRun()
		select {
		case <-runDone:
		case <-time.After(10 * time.Second):
		}
	}()
	time.Sleep(150 * time.Millisecond)

	respRewrap, rawRewrap := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", rewrapBody, reqOptions{
		idemKey: idemKey,
		ifMatch: ifMatch,
		grant:   grant,
	})
	if respRewrap.StatusCode != http.StatusOK {
		t.Fatalf("PUT /vault/kek = %d %s, want 200", respRewrap.StatusCode, rawRewrap)
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		var state, jobErrors string
		err := h.pool.QueryRow(ctx,
			`SELECT state::text, coalesce(errors::text, '') FROM river_job WHERE kind = 'security_notice_mail' ORDER BY id DESC LIMIT 1`,
		).Scan(&state, &jobErrors)
		if err == nil {
			if strings.Contains(jobErrors, "not registered") || strings.Contains(jobErrors, "Unhandled job kind") {
				t.Fatalf("security_notice_mail failed with unhandled job kind under worker.Run: state=%q errors=%s", state, jobErrors)
			}
			if state == "completed" {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for real worker.Run to complete security_notice_mail (state=%q errors=%s)", state, jobErrors)
		}
		time.Sleep(25 * time.Millisecond)
	}

	defaultSinkMailer, err := auth.NewSinkMailer(wantSink)
	if err != nil {
		t.Fatalf("NewSinkMailer(%q): %v", wantSink, err)
	}
	entries, err := defaultSinkMailer.EntriesFor(email, "security")
	if err != nil {
		t.Fatalf("EntriesFor after rewrap: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("delivered security emails in default sink %q = %d, want 1", wantSink, len(entries))
	}

	// Idempotent replay while worker.Run is active returns 200 and adds no notice, job, or delivered message.
	respReplay, rawReplay := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", rewrapBody, reqOptions{
		idemKey: idemKey,
		ifMatch: ifMatch,
		grant:   grant,
	})
	if respReplay.StatusCode != http.StatusOK {
		t.Fatalf("replay PUT /vault/kek = %d %s, want 200", respReplay.StatusCode, rawReplay)
	}

	var noticesCount, jobsCount int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1`, meA.User.ID).Scan(&noticesCount); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`).Scan(&jobsCount); err != nil {
		t.Fatal(err)
	}
	if noticesCount != 1 || jobsCount != 1 {
		t.Fatalf("after replay: notices=%d jobs=%d, want 1/1", noticesCount, jobsCount)
	}

	cancelRun()
	if err := <-runDone; err != nil {
		t.Fatalf("worker.Run returned error: %v", err)
	}

	entriesAfterReplay, err := defaultSinkMailer.EntriesFor(email, "security")
	if err != nil {
		t.Fatalf("EntriesFor after replay: %v", err)
	}
	if len(entriesAfterReplay) != 1 {
		t.Fatalf("delivered security emails after replay = %d, want 1", len(entriesAfterReplay))
	}
}
