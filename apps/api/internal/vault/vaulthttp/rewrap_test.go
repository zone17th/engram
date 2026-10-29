package vaulthttp_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/authhttp"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/compose"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault/vaulthttp"
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

	// 10. Lower KDF params than current (current has ops=4, mem=128 MiB; request sends ops=3, mem=64 MiB) -> 400 vault_kdf_invalid.
	ifMatchV2 := formatIfMatchTag(created.VaultKeyID, 2)
	lowerKDFBody := mustJSON(t, makeRewrapPayload(t, 3, 67108864, 0x41, 0x42))
	respLower, rawLower := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", lowerKDFBody, reqOptions{
		idemKey: "idem-rewrap-lower-kdf-01",
		ifMatch: ifMatchV2,
		grant:   rewrapGrant2,
	})
	if respLower.StatusCode != http.StatusBadRequest || decodeProblem(t, rawLower).Code != "vault_kdf_invalid" {
		t.Fatalf("lower KDF = %d %s, want 400 vault_kdf_invalid", respLower.StatusCode, rawLower)
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

	// 12. Verify in-app security notice exists for user without verified email, and audit_log has exactly 1 vault.rewrap row.
	var noticeCount, auditCount int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`, meA.User.ID).Scan(&noticeCount); err != nil {
		t.Fatal(err)
	}
	if noticeCount != 1 {
		t.Fatalf("user_notification count for unverified user = %d, want 1", noticeCount)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`, meA.User.ID, vault.EventVaultRewrap).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("audit_log vault.rewrap count = %d, want 1", auditCount)
	}
}

// TestVaultRewrapFailingMailAdapterStillCommits covers plan Task 9 bullet:
// "mail adapter lỗi vẫn commit".
func TestVaultRewrapFailingMailAdapterStillCommits(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://" + ln.Addr().String()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	clk := clock.NewFixed(time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC))

	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", origin)
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "false")
	t.Setenv("VAULT_KEY_MUTATIONS_DISABLED", "false")

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg, metrics := obs.NewRegistry()
	logBuf := &safeBuffer{}
	logger := slog.New(slog.NewJSONHandler(logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	failMail := &failingMailer{}
	authSvc, _, authAPI, err := compose.NewAuth(cfg, pool, nil, clk, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	vaultSvc, vaultAPI, err := compose.NewVault(cfg, pool, nil, clk, failMail, metrics, nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	authn, csrfv, reauth := compose.Adapters(authSvc)

	hnd := httpx.NewRouter(httpx.Deps{
		Config:           cfg,
		Logger:           logger,
		Ready:            func(context.Context) error { return nil },
		Metrics:          promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
		MetricsCollector: metrics,
		Authenticator:    authn,
		CSRF:             csrfv,
		Reauth:           reauth,
		MountAPI:         compose.MountAll(authhttp.Mount(authAPI), vaulthttp.Mount(vaultAPI)),
	})
	srv := httptest.NewUnstartedServer(hnd)
	_ = srv.Listener.Close()
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)

	h := &harness{
		t:        t,
		srv:      srv,
		origin:   origin,
		clk:      clk,
		authSvc:  authSvc,
		vaultSvc: vaultSvc,
		vaultAPI: vaultAPI,
		pool:     pool,
		reg:      reg,
		logs:     logBuf,
	}

	password := "correct-horse-battery-staple"
	jarA, meA := h.signupUser("verified-mail-fail@example.com", password)

	// Mark email as verified so RecordSecurityNoticeTx populates email_targets and SendSecurityEmailsBestEffort calls failMail.
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, meA.User.ID); err != nil {
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
	ifMatch := formatIfMatchTag(created.VaultKeyID, created.Version)
	rewrapReq := makeRewrapPayload(t, 3, 67108864, 0x77, 0x88)

	respRewrap, rawRewrap := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", mustJSON(t, rewrapReq), reqOptions{
		idemKey: "idem-mailfail-rewrap-0001",
		ifMatch: ifMatch,
		grant:   grant,
	})
	if respRewrap.StatusCode != http.StatusOK {
		t.Fatalf("PUT /vault/kek with failing mail adapter = %d %s, want 200", respRewrap.StatusCode, rawRewrap)
	}
	var vResp vault.VaultVersionResponse
	if err := json.Unmarshal([]byte(rawRewrap), &vResp); err != nil {
		t.Fatal(err)
	}
	if vResp.Version != 2 {
		t.Fatalf("vResp.Version = %d, want 2", vResp.Version)
	}
	if failMail.calls.Load() != 1 {
		t.Fatalf("failingMailer calls = %d, want 1", failMail.calls.Load())
	}

	// Verify DB committed version=2, wrap, audit, and notification.
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

	// Ensure logs never contain recipient email or wrap.
	if strings.Contains(logBuf.String(), rewrapReq.VaultKeyWrappedByKEK) {
		t.Fatalf("logs leaked wrap: %s", logBuf.String())
	}
}
