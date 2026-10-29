package vaulthttp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/authhttp"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/compose"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/notification"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault/vaulthttp"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/worker"
)

type cookieJar map[string]*http.Cookie

func (j cookieJar) apply(req *http.Request) {
	for _, c := range j {
		req.AddCookie(&http.Cookie{Name: c.Name, Value: c.Value})
	}
}

func (j cookieJar) capture(resp *http.Response) {
	for _, c := range resp.Cookies() {
		if c.MaxAge < 0 || c.Value == "" {
			delete(j, c.Name)
			continue
		}
		j[c.Name] = c
	}
}

type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type harness struct {
	t        *testing.T
	srv      *httptest.Server
	origin   string
	clk      *clock.Fixed
	mail     *auth.SinkMailer
	authSvc  *auth.Service
	vaultSvc *vault.Service
	vaultAPI *vaulthttp.API
	pool     *pgxpool.Pool
	reg      *prometheus.Registry
	logs     *safeBuffer
}

type harnessOpts struct {
	requireEmailVerification bool
	keyMutationsDisabled     bool
}

func newHarness(t *testing.T, opts harnessOpts) *harness {
	t.Helper()
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
	if opts.requireEmailVerification {
		t.Setenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "true")
	} else {
		t.Setenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "false")
	}
	if opts.keyMutationsDisabled {
		t.Setenv("VAULT_KEY_MUTATIONS_DISABLED", "true")
	} else {
		t.Setenv("VAULT_KEY_MUTATIONS_DISABLED", "false")
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	mail, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	reg, metrics := obs.NewRegistry()

	logBuf := &safeBuffer{}
	logger := slog.New(slog.NewJSONHandler(logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	riverInsert, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		t.Fatal(err)
	}
	authSvc, _, authAPI, err := compose.NewAuth(cfg, pool, riverInsert, clk, mail, nil)
	if err != nil {
		t.Fatal(err)
	}
	vaultSvc, vaultAPI, err := compose.NewVault(cfg, pool, riverInsert, clk, mail, metrics, nil, logger)
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

	return &harness{
		t:        t,
		srv:      srv,
		origin:   origin,
		clk:      clk,
		mail:     mail,
		authSvc:  authSvc,
		vaultSvc: vaultSvc,
		vaultAPI: vaultAPI,
		pool:     pool,
		reg:      reg,
		logs:     logBuf,
	}
}

// withKillSwitch starts a sibling httptest.Server sharing the same Postgres pool, clock, mailer,
// auth service, and APP_ORIGIN, with VAULT_KEY_MUTATIONS_DISABLED set to `disabled`.
func (h *harness) withKillSwitch(disabled bool) *harness {
	h.t.Helper()
	cfg, err := config.Load()
	if err != nil {
		h.t.Fatal(err)
	}
	cfg.AppOrigin = h.origin
	cfg.KeyMutationsDisabled = disabled
	reg, metrics := obs.NewRegistry()
	logger := slog.New(slog.NewJSONHandler(h.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	riverInsert, err := river.NewClient(riverpgxv5.New(h.pool), &river.Config{})
	if err != nil {
		h.t.Fatal(err)
	}
	_, _, authAPI, err := compose.NewAuth(cfg, h.pool, riverInsert, h.clk, h.mail, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	vaultSvc, vaultAPI, err := compose.NewVault(cfg, h.pool, riverInsert, h.clk, h.mail, metrics, nil, logger)
	if err != nil {
		h.t.Fatal(err)
	}
	authn, csrfv, reauth := compose.Adapters(h.authSvc)
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
	srv := httptest.NewServer(hnd)
	h.t.Cleanup(srv.Close)
	return &harness{
		t:        h.t,
		srv:      srv,
		origin:   h.origin,
		clk:      h.clk,
		mail:     h.mail,
		authSvc:  h.authSvc,
		vaultSvc: vaultSvc,
		vaultAPI: vaultAPI,
		pool:     h.pool,
		reg:      reg,
		logs:     h.logs,
	}
}

// runSecurityNoticeWorker runs all queued `security_notice_mail` jobs in `river_job` through the
// actual `worker.SecurityNoticeWorker` and removes each processed row so subsequent checks only see
// newly queued jobs.
func (h *harness) runSecurityNoticeWorker(ctx context.Context, mail auth.Mailer) (int, error) {
	h.t.Helper()
	rows, err := h.pool.Query(ctx, `SELECT id, args FROM river_job WHERE kind = 'security_notice_mail' ORDER BY id ASC`)
	if err != nil {
		return 0, err
	}
	type jobRow struct {
		id   int64
		args notification.SecurityNoticeArgs
	}
	var jobs []jobRow
	for rows.Next() {
		var id int64
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return 0, err
		}
		var a notification.SecurityNoticeArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			rows.Close()
			return 0, err
		}
		jobs = append(jobs, jobRow{id: id, args: a})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	w := worker.NewSecurityNoticeWorker(h.pool, mail, nil)
	var firstErr error
	for _, j := range jobs {
		if _, err := h.pool.Exec(ctx, `DELETE FROM river_job WHERE id = $1`, j.id); err != nil {
			return 0, err
		}
		if err := w.Work(ctx, &river.Job[notification.SecurityNoticeArgs]{Args: j.args}); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return len(jobs), firstErr
}

// countSecurityMailsDelivered counts all security emails delivered to `recipient` in `h.mail`
// across both `"security"` (queued worker) and any direct vault event purpose (`vault.rewrap`,
// `vault.recover`, `recovery_key.rotate`, `vault.reset`) so duplicate-owner regressions are caught.
func (h *harness) countSecurityMailsDelivered(recipient string) int {
	h.t.Helper()
	purposes := []string{
		"security",
		vault.EventVaultRewrap,
		vault.EventVaultRecover,
		vault.EventRecoveryKeyRotate,
		vault.EventVaultReset,
	}
	total := 0
	for _, p := range purposes {
		entries, err := h.mail.EntriesFor(recipient, p)
		if err != nil {
			h.t.Fatalf("EntriesFor(%q, %q): %v", recipient, p, err)
		}
		total += len(entries)
	}
	return total
}

type reqOptions struct {
	idemKey string
	ifMatch string
	grant   string
	noCSRF  bool
}

type testResponse struct {
	StatusCode int
	Header     http.Header
}

func (h *harness) doReq(j cookieJar, method, path, body string, opt reqOptions) (testResponse, string) {
	h.t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = bytes.NewBufferString(body)
	}
	req, err := http.NewRequest(method, h.srv.URL+path, rdr)
	if err != nil {
		h.t.Fatal(err)
	}
	if method != http.MethodGet && method != http.MethodHead {
		if body != "" || method != http.MethodDelete {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("Origin", h.origin)
	}
	j.apply(req)
	if !opt.noCSRF {
		if c := j[authhttp.CookieCSRF]; c != nil {
			req.Header.Set(authhttp.HeaderCSRF, c.Value)
		}
	}
	if opt.idemKey != "" {
		req.Header.Set(httpx.HeaderIdempotencyKey, opt.idemKey)
	}
	if opt.ifMatch != "" {
		req.Header.Set(httpx.HeaderIfMatch, opt.ifMatch)
	}
	if opt.grant != "" {
		req.Header.Set(authhttp.HeaderReauth, opt.grant)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	j.capture(resp)
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	return testResponse{
		StatusCode: resp.StatusCode,
		Header:     resp.Header,
	}, string(b)
}

func (h *harness) signupUser(email, password string) (cookieJar, auth.Me) {
	h.t.Helper()
	j := cookieJar{}
	resp, raw := h.doReq(j, http.MethodGet, "/api/v1/auth/csrf", "", reqOptions{noCSRF: true})
	if resp.StatusCode != http.StatusNoContent {
		h.t.Fatalf("csrf = %d %s", resp.StatusCode, raw)
	}
	payload := `{"email":"` + email + `","password":"` + password + `","locale":"en"}`
	resp, raw = h.doReq(j, http.MethodPost, "/api/v1/auth/signup", payload, reqOptions{})
	if resp.StatusCode != http.StatusCreated {
		h.t.Fatalf("signup %s = %d %s", email, resp.StatusCode, raw)
	}
	var me auth.Me
	if err := json.Unmarshal([]byte(raw), &me); err != nil {
		h.t.Fatalf("decode me: %v", err)
	}
	return j, me
}

func (h *harness) reauthGrant(j cookieJar, action, password string) string {
	h.t.Helper()
	payload := `{"action":"` + action + `","password":"` + password + `"}`
	resp, raw := h.doReq(j, http.MethodPost, "/api/v1/auth/reauth", payload, reqOptions{})
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("reauth %s = %d %s", action, resp.StatusCode, raw)
	}
	var g auth.ReauthGrant
	if err := json.Unmarshal([]byte(raw), &g); err != nil {
		h.t.Fatalf("decode grant: %v", err)
	}
	return g.Grant
}

func (h *harness) getMe(j cookieJar) auth.Me {
	h.t.Helper()
	resp, raw := h.doReq(j, http.MethodGet, "/api/v1/auth/me", "", reqOptions{})
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("GET /auth/me = %d %s", resp.StatusCode, raw)
	}
	var me auth.Me
	if err := json.Unmarshal([]byte(raw), &me); err != nil {
		h.t.Fatalf("decode me: %v", err)
	}
	return me
}

func seqTestBytes(n int, start byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = start + byte(i)
	}
	return out
}

func makeWrapB64U(t *testing.T, kind vault.WrapKind, seed byte) string {
	t.Helper()
	ptLen, _ := kind.ExpectedPlaintextLen()
	pt := seqTestBytes(ptLen, seed)
	key := seqTestBytes(vault.VKBytes, seed+0x11)
	nonce := seqTestBytes(vault.WrapNonceBytes, seed+0x22)
	s, err := vault.SealWrapBase64URL(kind, pt, key, nonce)
	if err != nil {
		t.Fatalf("SealWrapBase64URL: %v", err)
	}
	return s
}

type createPayload struct {
	KDF                  vault.KDFParams               `json:"kdf"`
	VaultKeyWrappedByKEK string                        `json:"vault_key_wrapped_by_kek"`
	X25519Public         string                        `json:"x25519_public"`
	Ed25519Public        string                        `json:"ed25519_public"`
	PrivateKeysWrapped   string                        `json:"private_keys_wrapped"`
	RecoveryKeys         []vault.RecoveryKeyUploadItem `json:"recovery_keys"`
}

func makeCreatePayload(t *testing.T, seed byte) createPayload {
	t.Helper()
	rks := make([]vault.RecoveryKeyUploadItem, 10)
	for i := range 10 {
		hashBytes := seqTestBytes(32, seed+byte(i*5+1))
		hashBytes[0] = byte(i + 1)
		hashBytes[1] = seed
		rks[i] = vault.RecoveryKeyUploadItem{
			Slot:       i + 1,
			LookupHash: vault.EncodeBase64URL(hashBytes),
			Wrap:       makeWrapB64U(t, vault.WrapKindRK, seed+byte(i+1)),
		}
	}
	return createPayload{
		KDF: vault.KDFParams{
			Alg:         "argon2id13",
			Ops:         3,
			Mem:         67108864,
			Parallelism: 1,
			Salt:        vault.EncodeBase64URL(seqTestBytes(16, seed+0x05)),
		},
		VaultKeyWrappedByKEK: makeWrapB64U(t, vault.WrapKindKEK, seed),
		X25519Public:         vault.EncodeBase64URL(seqTestBytes(32, seed+0x30)),
		Ed25519Public:        vault.EncodeBase64URL(seqTestBytes(32, seed+0x50)),
		PrivateKeysWrapped:   makeWrapB64U(t, vault.WrapKindPriv, seed+0x70),
		RecoveryKeys:         rks,
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func decodeProblem(t *testing.T, raw string) httpx.Problem {
	t.Helper()
	var p httpx.Problem
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatalf("decode problem (%s): %v", raw, err)
	}
	return p
}

// TestVaultCreateRejectsInvalidRKCountsDuplicateSlotAndDuplicateHash covers Task 8 bullet:
// "9/11/trùng RK/slot trùng bị từ chối" + invalid KDF/wrap validation.
func TestVaultCreateRejectsInvalidRKCountsDuplicateSlotAndDuplicateHash(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	jarA, _ := h.signupUser("user-a@example.com", "correct-horse-battery-staple")

	// 1. 9 recovery keys -> 400 recovery_keys_count
	p9 := makeCreatePayload(t, 0x10)
	p9.RecoveryKeys = p9.RecoveryKeys[:9]
	resp, raw := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, p9), reqOptions{
		idemKey: "idem-rk-count-0009",
	})
	if resp.StatusCode != http.StatusBadRequest || decodeProblem(t, raw).Code != "recovery_keys_count" {
		t.Fatalf("9 RKs: status=%d body=%s", resp.StatusCode, raw)
	}

	// 2. 11 recovery keys -> 400 recovery_keys_count
	p11 := makeCreatePayload(t, 0x20)
	extraRK := vault.RecoveryKeyUploadItem{
		Slot:       10,
		LookupHash: vault.EncodeBase64URL(seqTestBytes(32, 0xEE)),
		Wrap:       makeWrapB64U(t, vault.WrapKindRK, 0xEE),
	}
	p11.RecoveryKeys = append(p11.RecoveryKeys, extraRK)
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, p11), reqOptions{
		idemKey: "idem-rk-count-0011",
	})
	if resp.StatusCode != http.StatusBadRequest || decodeProblem(t, raw).Code != "recovery_keys_count" {
		t.Fatalf("11 RKs: status=%d body=%s", resp.StatusCode, raw)
	}

	// 3. Duplicate slot in request (two slot=1, missing slot=10) -> 400 recovery_keys_count
	pDupSlot := makeCreatePayload(t, 0x30)
	pDupSlot.RecoveryKeys[9].Slot = 1
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, pDupSlot), reqOptions{
		idemKey: "idem-rk-dup-slot-01",
	})
	if resp.StatusCode != http.StatusBadRequest || decodeProblem(t, raw).Code != "recovery_keys_count" {
		t.Fatalf("dup slot: status=%d body=%s", resp.StatusCode, raw)
	}

	// 4. Out-of-range slot (slot=11) -> 400 recovery_keys_count
	pBadSlot := makeCreatePayload(t, 0x35)
	pBadSlot.RecoveryKeys[9].Slot = 11
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, pBadSlot), reqOptions{
		idemKey: "idem-rk-bad-slot-11",
	})
	if resp.StatusCode != http.StatusBadRequest || decodeProblem(t, raw).Code != "recovery_keys_count" {
		t.Fatalf("slot 11: status=%d body=%s", resp.StatusCode, raw)
	}

	// 5. Duplicate lookup_hash within the same request -> 409 recovery_key_conflict
	pDupHash := makeCreatePayload(t, 0x40)
	pDupHash.RecoveryKeys[7].LookupHash = pDupHash.RecoveryKeys[2].LookupHash
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, pDupHash), reqOptions{
		idemKey: "idem-rk-dup-hash-01",
	})
	if resp.StatusCode != http.StatusConflict || decodeProblem(t, raw).Code != "recovery_key_conflict" {
		t.Fatalf("dup hash in request: status=%d body=%s", resp.StatusCode, raw)
	}

	// 6. Invalid KDF params -> 400 vault_kdf_invalid
	pBadKDF := makeCreatePayload(t, 0x50)
	pBadKDF.KDF.Ops = 2
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, pBadKDF), reqOptions{
		idemKey: "idem-bad-kdf-ops02",
	})
	if resp.StatusCode != http.StatusBadRequest || decodeProblem(t, raw).Code != "vault_kdf_invalid" {
		t.Fatalf("bad KDF: status=%d body=%s", resp.StatusCode, raw)
	}

	// 7. Invalid wrap length/version -> 400 vault_wrap_invalid
	pBadWrap := makeCreatePayload(t, 0x60)
	pBadWrap.VaultKeyWrappedByKEK = vault.EncodeBase64URL(seqTestBytes(40, 0x01))
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, pBadWrap), reqOptions{
		idemKey: "idem-bad-wrap-len1",
	})
	if resp.StatusCode != http.StatusBadRequest || decodeProblem(t, raw).Code != "vault_wrap_invalid" {
		t.Fatalf("bad wrap: status=%d body=%s", resp.StatusCode, raw)
	}
}

// TestVaultCreateSecondCreateIdempotentRetryAndCrossUserLookupHashConflict covers Task 8 bullets:
// - "lookup_hash trùng với vault user khác trả recovery_key_conflict chung, không lộ chủ sở hữu"
// - "tạo lần hai -> vault_exists"
// - "retry cùng key không tạo vault khác và trả cùng vault_key_id"
// - "Thay auth.VaultStatus mặc định bằng query bảng vault để Me.vault.status thành present sau khi tạo"
func TestVaultCreateSecondCreateIdempotentRetryAndCrossUserLookupHashConflict(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	jarA, meABefore := h.signupUser("alice-vault@example.com", "correct-horse-battery-staple")
	jarB, meBBefore := h.signupUser("bob-vault@example.com", "correct-horse-battery-staple")

	if meABefore.Vault.Status != "absent" || meBBefore.Vault.Status != "absent" {
		t.Fatalf("initial Me.Vault.Status = %q / %q, want absent", meABefore.Vault.Status, meBBefore.Vault.Status)
	}

	// Create vault for Alice.
	payloadA := makeCreatePayload(t, 0x10)
	bodyA := mustJSON(t, payloadA)
	idemKeyA := "idem-create-alice-0001"
	resp1, raw1 := h.doReq(jarA, http.MethodPost, "/api/v1/vault", bodyA, reqOptions{idemKey: idemKeyA})
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("first POST /vault = %d %s", resp1.StatusCode, raw1)
	}
	var created1 vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(raw1), &created1); err != nil {
		t.Fatalf("decode created1: %v", err)
	}
	if !vault.ValidateVaultKeyID(created1.VaultKeyID) || created1.Version != 1 {
		t.Fatalf("created1 = %+v", created1)
	}

	// Me.vault.status for Alice is now "present".
	meAAfter := h.getMe(jarA)
	if meAAfter.Vault.Status != "present" {
		t.Fatalf("Alice Me.Vault.Status after create = %q, want present", meAAfter.Vault.Status)
	}

	// Retry with the exact same Idempotency-Key and body -> returns 201 with the exact same vault_key_id, no second vault.
	respRetry, rawRetry := h.doReq(jarA, http.MethodPost, "/api/v1/vault", bodyA, reqOptions{idemKey: idemKeyA})
	if respRetry.StatusCode != http.StatusCreated {
		t.Fatalf("idempotent retry POST /vault = %d %s", respRetry.StatusCode, rawRetry)
	}
	var createdRetry vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawRetry), &createdRetry); err != nil {
		t.Fatalf("decode createdRetry: %v", err)
	}
	if createdRetry.VaultKeyID != created1.VaultKeyID || createdRetry.Version != created1.Version {
		t.Fatalf("retry response = %+v, want %+v", createdRetry, created1)
	}

	// Verify only 1 vault row and 1 audit `vault.create` row exist for Alice.
	var auditCount int
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`,
		meABefore.User.ID, vault.EventVaultCreate,
	).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("audit vault.create count after retry = %d, want 1", auditCount)
	}

	// Second create with a new Idempotency-Key -> 409 vault_exists.
	payloadA2 := makeCreatePayload(t, 0x25)
	resp2, raw2 := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadA2), reqOptions{
		idemKey: "idem-create-alice-0002",
	})
	if resp2.StatusCode != http.StatusConflict || decodeProblem(t, raw2).Code != "vault_exists" {
		t.Fatalf("second POST /vault = %d %s, want 409 vault_exists", resp2.StatusCode, raw2)
	}

	// Bob tries to create a vault whose slot 5 has the same lookup_hash as Alice's slot 1 ->
	// generic 409 recovery_key_conflict that does not reveal Alice's user_id, email, or vault_key_id.
	payloadBConflict := makeCreatePayload(t, 0x70)
	payloadBConflict.RecoveryKeys[4].LookupHash = payloadA.RecoveryKeys[0].LookupHash
	respB, rawB := h.doReq(jarB, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadBConflict), reqOptions{
		idemKey: "idem-create-bob-conflict1",
	})
	if respB.StatusCode != http.StatusConflict {
		t.Fatalf("cross-user lookup_hash POST /vault = %d %s, want 409", respB.StatusCode, rawB)
	}
	probB := decodeProblem(t, rawB)
	if probB.Code != "recovery_key_conflict" {
		t.Fatalf("probB.Code = %q, want recovery_key_conflict", probB.Code)
	}
	for _, forbidden := range []string{
		meABefore.User.ID.String(),
		"alice-vault@example.com",
		created1.VaultKeyID,
		payloadA.RecoveryKeys[0].LookupHash,
	} {
		if strings.Contains(rawB, forbidden) {
			t.Fatalf("cross-user conflict response leaked %q: %s", forbidden, rawB)
		}
	}

	// Bob's transaction rolled back completely: Bob still has no vault (`Me.vault.status == "absent"`),
	// and can immediately retry with the SAME Idempotency-Key once the body/key is fixed (because step 8 released the claim).
	if gotMeB := h.getMe(jarB); gotMeB.Vault.Status != "absent" {
		t.Fatalf("Bob Me.Vault.Status after failed create = %q, want absent", gotMeB.Vault.Status)
	}
}

// TestVaultCreateRequiresEmailVerificationWhenFlagEnabled covers Task 8 bullet:
// "cờ verify true + chưa verified -> 403" (email_not_verified), and succeeds after verifying email.
func TestVaultCreateRequiresEmailVerificationWhenFlagEnabled(t *testing.T) {
	h := newHarness(t, harnessOpts{requireEmailVerification: true})
	jarA, meA := h.signupUser("unverified-user@example.com", "correct-horse-battery-staple")

	payload := makeCreatePayload(t, 0x15)
	body := mustJSON(t, payload)

	// Unverified user -> 403 email_not_verified.
	resp, raw := h.doReq(jarA, http.MethodPost, "/api/v1/vault", body, reqOptions{
		idemKey: "idem-verify-gate-0001",
	})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("unverified POST /vault = %d %s, want 403", resp.StatusCode, raw)
	}
	if got := decodeProblem(t, raw).Code; got != "email_not_verified" {
		t.Fatalf("problem.Code = %q, want email_not_verified", got)
	}

	// Mark user's email verified in DB and retry with the same Idempotency-Key (claim was released on 403 before COMMIT).
	if _, err := h.pool.Exec(context.Background(),
		`UPDATE app_user SET email_verified_at = now() WHERE id = $1`,
		meA.User.ID,
	); err != nil {
		t.Fatal(err)
	}

	resp2, raw2 := h.doReq(jarA, http.MethodPost, "/api/v1/vault", body, reqOptions{
		idemKey: "idem-verify-gate-0001",
	})
	if resp2.StatusCode != http.StatusCreated {
		t.Fatalf("verified POST /vault = %d %s, want 201", resp2.StatusCode, raw2)
	}
}

// TestVaultReadsPrincipalIsolationNoStoreAndNoETag covers Task 8 bullets:
// - "GET /vault, GET /vault/recovery-keys, GET /vault/passkeys: chỉ dữ liệu của principal; no-store, không ETag (mục 2.3)"
// - "user B không đọc được vault user A"
func TestVaultReadsPrincipalIsolationNoStoreAndNoETag(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	jarA, meA := h.signupUser("reader-a@example.com", "correct-horse-battery-staple")
	jarB, _ := h.signupUser("reader-b@example.com", "correct-horse-battery-staple")

	payloadA := makeCreatePayload(t, 0x33)
	respCreate, rawCreate := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadA), reqOptions{
		idemKey: "idem-reader-a-create1",
	})
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault (A) = %d %s", respCreate.StatusCode, rawCreate)
	}
	var createdA vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawCreate), &createdA); err != nil {
		t.Fatal(err)
	}

	// Insert a passkey row for user A and consume 2 recovery keys (slots 2 and 7) so empty_slots is [2, 7].
	q := gen.New(h.pool)
	ctx := context.Background()
	aaguidUUID := uuid.MustParse("11111111-2222-3333-4444-555555555555")
	aaguidBytes, _ := aaguidUUID.MarshalBinary()
	pkRow, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID:  meA.User.ID,
		CredID:  seqTestBytes(32, 0x91),
		Pubkey:  seqTestBytes(32, 0xA1),
		PrfSalt: seqTestBytes(32, 0xB1),
		VkWrap:  seqTestBytes(vault.VKWrapBytes, 0x01),
		Aaguid:  aaguidBytes,
		Name:    "YubiKey 5",
	})
	if err != nil {
		t.Fatalf("InsertPasskey: %v", err)
	}
	if _, err := h.pool.Exec(ctx, `DELETE FROM vault_recovery_key WHERE vault_id = $1 AND slot IN (2, 7)`, meA.User.ID); err != nil {
		t.Fatalf("delete 2 RKs: %v", err)
	}

	// User B has no vault -> all three GETs for User B return 404 vault_absent (never User A's vault).
	for _, path := range []string{"/api/v1/vault", "/api/v1/vault/recovery-keys", "/api/v1/vault/passkeys"} {
		respB, rawB := h.doReq(jarB, http.MethodGet, path, "", reqOptions{})
		if respB.StatusCode != http.StatusNotFound || decodeProblem(t, rawB).Code != "vault_absent" {
			t.Fatalf("User B (no vault) GET %s = %d %s, want 404 vault_absent", path, respB.StatusCode, rawB)
		}
		if strings.Contains(rawB, createdA.VaultKeyID) || strings.Contains(rawB, pkRow.ID.String()) {
			t.Fatalf("User B GET %s leaked User A data: %s", path, rawB)
		}
	}

	// Now create a distinct vault for User B and verify User B only sees User B's vault on all 3 GETs.
	payloadB := makeCreatePayload(t, 0x88)
	respCreateB, rawCreateB := h.doReq(jarB, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadB), reqOptions{
		idemKey: "idem-reader-b-create1",
	})
	if respCreateB.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault (B) = %d %s", respCreateB.StatusCode, rawCreateB)
	}
	var createdB vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawCreateB), &createdB); err != nil {
		t.Fatal(err)
	}

	// Check User A's three GETs: headers (`Cache-Control: no-store, no-transform`, no `ETag`) and exact shapes.
	respGetA, rawGetA := h.doReq(jarA, http.MethodGet, "/api/v1/vault", "", reqOptions{})
	if respGetA.StatusCode != http.StatusOK {
		t.Fatalf("GET /vault (A) = %d %s", respGetA.StatusCode, rawGetA)
	}
	assertNoStoreNoTransformNoETag(t, "/api/v1/vault", respGetA)
	var stateA vault.VaultState
	if err := json.Unmarshal([]byte(rawGetA), &stateA); err != nil {
		t.Fatalf("decode VaultState A: %v", err)
	}
	if stateA.VaultKeyID != createdA.VaultKeyID || stateA.Version != 1 || stateA.RecoveryKeysRemaining != 8 {
		t.Fatalf("stateA = %+v", stateA)
	}
	if stateA.VaultKeyWrappedByKEK != payloadA.VaultKeyWrappedByKEK ||
		stateA.PrivateKeysWrapped != payloadA.PrivateKeysWrapped ||
		stateA.X25519Public != payloadA.X25519Public ||
		stateA.Ed25519Public != payloadA.Ed25519Public {
		t.Fatalf("stateA wraps/pubkeys mismatch: %+v", stateA)
	}
	if len(stateA.Passkeys) != 1 || stateA.Passkeys[0].ID != pkRow.ID || stateA.Passkeys[0].Name != "YubiKey 5" ||
		stateA.Passkeys[0].AAGUID == nil || *stateA.Passkeys[0].AAGUID != aaguidUUID.String() {
		t.Fatalf("stateA.Passkeys = %+v", stateA.Passkeys)
	}

	respRKA, rawRKA := h.doReq(jarA, http.MethodGet, "/api/v1/vault/recovery-keys", "", reqOptions{})
	if respRKA.StatusCode != http.StatusOK {
		t.Fatalf("GET /vault/recovery-keys (A) = %d %s", respRKA.StatusCode, rawRKA)
	}
	assertNoStoreNoTransformNoETag(t, "/api/v1/vault/recovery-keys", respRKA)
	var rkStatusA vault.RecoveryKeysStatus
	if err := json.Unmarshal([]byte(rawRKA), &rkStatusA); err != nil {
		t.Fatalf("decode RecoveryKeysStatus A: %v", err)
	}
	if rkStatusA.Remaining != 8 || rkStatusA.Slots != 10 || len(rkStatusA.EmptySlots) != 2 ||
		rkStatusA.EmptySlots[0] != 2 || rkStatusA.EmptySlots[1] != 7 {
		t.Fatalf("rkStatusA = %+v", rkStatusA)
	}

	respPKA, rawPKA := h.doReq(jarA, http.MethodGet, "/api/v1/vault/passkeys", "", reqOptions{})
	if respPKA.StatusCode != http.StatusOK {
		t.Fatalf("GET /vault/passkeys (A) = %d %s", respPKA.StatusCode, rawPKA)
	}
	assertNoStoreNoTransformNoETag(t, "/api/v1/vault/passkeys", respPKA)
	var pkListA vault.PasskeyList
	if err := json.Unmarshal([]byte(rawPKA), &pkListA); err != nil {
		t.Fatalf("decode PasskeyList A: %v", err)
	}
	if len(pkListA.Items) != 1 || pkListA.Items[0].ID != pkRow.ID {
		t.Fatalf("pkListA = %+v", pkListA)
	}
	// Ensure GET /vault/passkeys never includes vk_wrap or prf_salt.
	if strings.Contains(rawPKA, "vk_wrap") || strings.Contains(rawPKA, "prf_salt") {
		t.Fatalf("GET /vault/passkeys leaked wrap/salt: %s", rawPKA)
	}

	// Verify User B's GETs return only User B's vault (remaining=10, passkeys=[], vault_key_id=createdB.VaultKeyID).
	respGetB, rawGetB := h.doReq(jarB, http.MethodGet, "/api/v1/vault", "", reqOptions{})
	if respGetB.StatusCode != http.StatusOK {
		t.Fatalf("GET /vault (B) = %d %s", respGetB.StatusCode, rawGetB)
	}
	var stateB vault.VaultState
	if err := json.Unmarshal([]byte(rawGetB), &stateB); err != nil {
		t.Fatal(err)
	}
	if stateB.VaultKeyID != createdB.VaultKeyID || stateB.VaultKeyID == createdA.VaultKeyID ||
		stateB.RecoveryKeysRemaining != 10 || len(stateB.Passkeys) != 0 {
		t.Fatalf("User B saw wrong state: %+v", stateB)
	}
	if strings.Contains(rawGetB, createdA.VaultKeyID) || strings.Contains(rawGetB, pkRow.ID.String()) {
		t.Fatalf("User B GET /vault leaked User A data: %s", rawGetB)
	}
}

func assertNoStoreNoTransformNoETag(t *testing.T, route string, resp testResponse) {
	t.Helper()
	cc := resp.Header.Get("Cache-Control")
	if cc != "no-store, no-transform" {
		t.Fatalf("%s Cache-Control = %q, want %q", route, cc, "no-store, no-transform")
	}
	if etag := resp.Header.Get("ETag"); etag != "" {
		t.Fatalf("%s must not have ETag header, got %q", route, etag)
	}
}

// TestKillSwitchBlocksAllKRoutesWithoutConsumingRateLimitOrIdempotency covers Task 8 bullet:
// "mỗi route trong danh sách kill switch trả 503 khi bật" and advisor-dec-022 (BE1-11):
// Idempotency.Lookup runs before K, while K runs before RequireReauth, UserLimiter, RequireIfMatch
// and Idempotency.Claim so fresh mutations on every K route return 503 without recording rate_event
// or claiming idempotency_key, and non-K routes remain available.
func TestKillSwitchBlocksAllKRoutesWithoutConsumingRateLimitOrIdempotency(t *testing.T) {
	h := newHarness(t, harnessOpts{keyMutationsDisabled: true})
	password := "correct-horse-battery-staple"
	jarA, meA := h.signupUser("killswitch-user@example.com", password)

	// All 6 P03-A routes in the K column of plan mục 3 / Task 8:
	// (Note: POST /vault/passkeys is Task 13 and is recorded as pending Task 13 in the report.)
	kRoutes := []struct {
		name   string
		method string
		path   string
		action string
		body   string
	}{
		{
			name:   "POST /vault",
			method: http.MethodPost,
			path:   "/api/v1/vault",
			action: "",
			body:   mustJSON(t, makeCreatePayload(t, 0x10)),
		},
		{
			name:   "PUT /vault/kek",
			method: http.MethodPut,
			path:   "/api/v1/vault/kek",
			action: "vault.rewrap",
			body:   `{"kdf":{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"AAECAwQFBgcICQoLDA0ODw"},"vault_key_wrapped_by_kek":"` + makeWrapB64U(t, vault.WrapKindKEK, 0x11) + `"}`,
		},
		{
			name:   "DELETE /vault",
			method: http.MethodDelete,
			path:   "/api/v1/vault",
			action: "vault.reset",
			body:   "",
		},
		{
			name:   "POST /vault/recover/complete",
			method: http.MethodPost,
			path:   "/api/v1/vault/recover/complete",
			action: "vault.recover",
			body:   `{"recovery_key_id":"3b241101-e2bb-4255-8caf-4136c566a962","kdf":{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"AAECAwQFBgcICQoLDA0ODw"},"vault_key_wrapped_by_kek":"` + makeWrapB64U(t, vault.WrapKindKEK, 0x12) + `"}`,
		},
		{
			name:   "POST /vault/recovery-keys/regenerate",
			method: http.MethodPost,
			path:   "/api/v1/vault/recovery-keys/regenerate",
			action: "vault.recovery_keys_regenerate",
			body:   `{"recovery_keys":[{"slot":1,"lookup_hash":"` + vault.EncodeBase64URL(seqTestBytes(32, 0x21)) + `","wrap":"` + makeWrapB64U(t, vault.WrapKindRK, 0x21) + `"}]}`,
		},
		{
			name:   "POST /vault/recovery-keys/rotate",
			method: http.MethodPost,
			path:   "/api/v1/vault/recovery-keys/rotate",
			action: "vault.recovery_keys_rotate",
			body:   `{"recovery_keys":` + mustJSON(t, makeCreatePayload(t, 0x30).RecoveryKeys) + `}`,
		},
	}

	for idx, tc := range kRoutes {
		t.Run(tc.name, func(t *testing.T) {
			var grant string
			if tc.action != "" {
				g, err := h.authSvc.ReauthWithPassword(context.Background(), authctx.Principal{
					UserID:    meA.User.ID,
					SessionID: uuid.New(),
				}, tc.action, password)
				if err != nil {
					t.Fatalf("issue grant: %v", err)
				}
				grant = g.Grant
			}
			idemKey := "idem-killswitch-route-" + uuid.NewString()
			if len(idemKey) > 64 {
				idemKey = idemKey[:64]
			}
			_ = idx
			resp, raw := h.doReq(jarA, tc.method, tc.path, tc.body, reqOptions{
				idemKey: idemKey,
				ifMatch: `"vk:AAECAwQFBgcICQoLDA0ODw:1"`,
				grant:   grant,
			})
			if resp.StatusCode != http.StatusServiceUnavailable {
				t.Fatalf("%s status = %d, want 503 (%s)", tc.name, resp.StatusCode, raw)
			}
			prob := decodeProblem(t, raw)
			if prob.Code != "vault_mutations_disabled" {
				t.Fatalf("%s problem.Code = %q, want vault_mutations_disabled", tc.name, prob.Code)
			}
		})
	}

	// Verify K did not consume any rate_event or claim any idempotency_key row.
	ctx := context.Background()
	var rateEvents, idemRows int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM rate_event WHERE user_id = $1`, meA.User.ID).Scan(&rateEvents); err != nil {
		t.Fatal(err)
	}
	if rateEvents != 0 {
		t.Fatalf("kill-switch requests must not record rate_event, got %d", rateEvents)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1`, meA.User.ID).Scan(&idemRows); err != nil {
		t.Fatal(err)
	}
	if idemRows != 0 {
		t.Fatalf("kill-switch requests must not claim idempotency_key, got %d", idemRows)
	}

	// Verify non-K routes are NOT blocked by kill switch (GET /vault -> 404 vault_absent, not 503).
	respGet, rawGet := h.doReq(jarA, http.MethodGet, "/api/v1/vault", "", reqOptions{})
	if respGet.StatusCode != http.StatusNotFound || decodeProblem(t, rawGet).Code != "vault_absent" {
		t.Fatalf("GET /vault when kill switch on = %d %s, want 404 vault_absent", respGet.StatusCode, rawGet)
	}
}

// TestKillSwitchAllowsCommittedReplayPreservesStep2ConflictsAndBlocksStaleReclaim verifies
// BE1-11 / advisor-dec-022:
//  1. Committed mutations (create, rewrap, recover/complete, reset) replayed after restarting
//     with VAULT_KEY_MUTATIONS_DISABLED=true return their stored responses (201/200/204) even
//     when reauth grants have expired and If-Match is stale, with zero new rate_event, audit_log,
//     user_notification, idempotency_key claims, RK deletions, or version changes.
//  2. Step-2 409 responses (idempotency_conflict on mismatched body, idempotency_in_progress on
//     live in_progress row <= 60s) remain 409 when K is on.
//  3. A stale in_progress row (> 60s) that would be reclaimed for a new mutation is blocked by K
//     with 503 vault_mutations_disabled before reauth/rate-limit/If-Match/claim, leaving the stale
//     DB row untouched and recording no rate_event.
func TestKillSwitchAllowsCommittedReplayPreservesStep2ConflictsAndBlocksStaleReclaim(t *testing.T) {
	h := newHarness(t, harnessOpts{keyMutationsDisabled: false})
	password := "correct-horse-battery-staple"
	jarA, meA := h.signupUser("killswitch-replay@example.com", password)
	ctx := context.Background()

	// 1. Commit POST /vault (version 1).
	createPayload := makeCreatePayload(t, 0x12)
	createBody := mustJSON(t, createPayload)
	createKey := "idem-ks-replay-create-0001"
	respCreate, rawCreate := h.doReq(jarA, http.MethodPost, "/api/v1/vault", createBody, reqOptions{
		idemKey: createKey,
	})
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("initial POST /vault = %d %s", respCreate.StatusCode, rawCreate)
	}
	var created vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawCreate), &created); err != nil {
		t.Fatal(err)
	}

	// 2. Commit PUT /vault/kek (version 1 -> 2).
	rewrapGrant := h.reauthGrant(jarA, "vault.rewrap", password)
	rewrapPayload := makeRewrapPayload(t, 3, 67108864, 0x22, 0x23)
	rewrapBody := mustJSON(t, rewrapPayload)
	rewrapKey := "idem-ks-replay-rewrap-0001"
	ifMatchV1 := formatIfMatchTag(created.VaultKeyID, 1)
	respRewrap, rawRewrap := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", rewrapBody, reqOptions{
		idemKey: rewrapKey,
		ifMatch: ifMatchV1,
		grant:   rewrapGrant,
	})
	if respRewrap.StatusCode != http.StatusOK {
		t.Fatalf("initial PUT /vault/kek = %d %s", respRewrap.StatusCode, rawRewrap)
	}

	// 3. Commit POST /vault/recover/complete (version 2 -> 3, consumes slot 1 RK -> 9 remaining).
	respLookup, rawLookup := h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/recovery",
		`{"lookup_hash":"`+createPayload.RecoveryKeys[0].LookupHash+`"}`, reqOptions{})
	if respLookup.StatusCode != http.StatusOK {
		t.Fatalf("lookup RK = %d %s", respLookup.StatusCode, rawLookup)
	}
	var lookupRes vault.RecoveryLookupResponse
	if err := json.Unmarshal([]byte(rawLookup), &lookupRes); err != nil {
		t.Fatal(err)
	}
	recoverGrant := h.reauthGrant(jarA, "vault.recover", password)
	recoverPayload := makeRecoverCompletePayload(t, lookupRes.RecoveryKeyID, 0x33)
	recoverBody := mustJSON(t, recoverPayload)
	recoverKey := "idem-ks-replay-recover-0001"
	ifMatchV2 := formatIfMatchTag(created.VaultKeyID, 2)
	respRecover, rawRecover := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recover/complete", recoverBody, reqOptions{
		idemKey: recoverKey,
		ifMatch: ifMatchV2,
		grant:   recoverGrant,
	})
	if respRecover.StatusCode != http.StatusOK {
		t.Fatalf("initial POST /vault/recover/complete = %d %s", respRecover.StatusCode, rawRecover)
	}

	// Advance clock by 6 minutes so all previously issued 5m grants are expired while the 10m access token stays valid.
	h.clk.Advance(6 * time.Minute)
	now := h.clk.Now()

	// Seed one live in_progress row (claimed 10s ago) and one stale in_progress row (claimed 65s ago)
	// for PUT /api/v1/vault/kek.
	liveKey := "idem-ks-live-inprog-0001"
	staleKey := "idem-ks-stale-inprog-0001"
	inProgBody := mustJSON(t, makeRewrapPayload(t, 3, 67108864, 0x44, 0x45))
	inProgFP := httpx.ComputeIdempotencyFingerprint(http.MethodPut, "/api/v1/vault/kek", []byte(inProgBody))
	liveOwner := uuid.New()
	staleOwner := uuid.New()
	staleClaimedAt := now.Add(-65 * time.Second)
	q := gen.New(h.pool)
	if _, err := q.ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
		UserID:      meA.User.ID,
		Key:         liveKey,
		Method:      http.MethodPut,
		Path:        "/api/v1/vault/kek",
		RequestHash: inProgFP,
		OwnerToken:  liveOwner,
		Now:         pgtype.Timestamptz{Time: now.Add(-10 * time.Second), Valid: true},
	}); err != nil {
		t.Fatalf("seed live in_progress: %v", err)
	}
	if _, err := q.ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
		UserID:      meA.User.ID,
		Key:         staleKey,
		Method:      http.MethodPut,
		Path:        "/api/v1/vault/kek",
		RequestHash: inProgFP,
		OwnerToken:  staleOwner,
		Now:         pgtype.Timestamptz{Time: staleClaimedAt, Valid: true},
	}); err != nil {
		t.Fatalf("seed stale in_progress: %v", err)
	}

	// Restart composition with kill switch ON.
	hK := h.withKillSwitch(true)

	snapshotCounts := func() (rateEvents, audits, notices, idemRows, rks int, version int32) {
		t.Helper()
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM rate_event WHERE user_id = $1`, meA.User.ID).Scan(&rateEvents); err != nil {
			t.Fatal(err)
		}
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1`, meA.User.ID).Scan(&audits); err != nil {
			t.Fatal(err)
		}
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1`, meA.User.ID).Scan(&notices); err != nil {
			t.Fatal(err)
		}
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1`, meA.User.ID).Scan(&idemRows); err != nil {
			t.Fatal(err)
		}
		if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM vault_recovery_key WHERE vault_id = $1`, meA.User.ID).Scan(&rks); err != nil {
			t.Fatal(err)
		}
		if err := h.pool.QueryRow(ctx, `SELECT version FROM vault WHERE user_id = $1`, meA.User.ID).Scan(&version); err != nil {
			t.Fatal(err)
		}
		return
	}

	re0, au0, no0, id0, rk0, ver0 := snapshotCounts()

	// Replay committed POST /vault under K=on -> 201 with original body.
	repCreate, rawRepCreate := hK.doReq(jarA, http.MethodPost, "/api/v1/vault", createBody, reqOptions{
		idemKey: createKey,
	})
	if repCreate.StatusCode != http.StatusCreated {
		t.Fatalf("replay POST /vault with K on = %d %s, want 201", repCreate.StatusCode, rawRepCreate)
	}
	var repCreated vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(rawRepCreate), &repCreated); err != nil {
		t.Fatal(err)
	}
	if repCreated.VaultKeyID != created.VaultKeyID || repCreated.Version != 1 {
		t.Fatalf("replay POST /vault response = %+v, want %+v", repCreated, created)
	}

	// Replay committed PUT /vault/kek under K=on (with expired grant and stale If-Match) -> 200 original body.
	repRewrap, rawRepRewrap := hK.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", rewrapBody, reqOptions{
		idemKey: rewrapKey,
		ifMatch: ifMatchV1,
		grant:   rewrapGrant,
	})
	if repRewrap.StatusCode != http.StatusOK {
		t.Fatalf("replay PUT /vault/kek with K on = %d %s, want 200", repRewrap.StatusCode, rawRepRewrap)
	}
	var repRewrapRes vault.VaultVersionResponse
	if err := json.Unmarshal([]byte(rawRepRewrap), &repRewrapRes); err != nil || repRewrapRes.Version != 2 {
		t.Fatalf("replay PUT /vault/kek response = %+v (err=%v), want version=2", repRewrapRes, err)
	}

	// Replay committed POST /vault/recover/complete under K=on (expired grant, stale If-Match) -> 200 original body.
	repRecover, rawRepRecover := hK.doReq(jarA, http.MethodPost, "/api/v1/vault/recover/complete", recoverBody, reqOptions{
		idemKey: recoverKey,
		ifMatch: ifMatchV2,
		grant:   recoverGrant,
	})
	if repRecover.StatusCode != http.StatusOK {
		t.Fatalf("replay POST /vault/recover/complete with K on = %d %s, want 200", repRecover.StatusCode, rawRecover)
	}
	var repRecoverRes vault.VaultVersionResponse
	if err := json.Unmarshal([]byte(rawRepRecover), &repRecoverRes); err != nil || repRecoverRes.Version != 3 {
		t.Fatalf("replay POST /vault/recover/complete response = %+v (err=%v), want version=3", repRecoverRes, err)
	}

	// Step-2 409 checks with K on:
	// (a) done row + different fingerprint -> 409 idempotency_conflict
	respConflict, rawConflict := hK.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", inProgBody, reqOptions{
		idemKey: rewrapKey,
	})
	if respConflict.StatusCode != http.StatusConflict || decodeProblem(t, rawConflict).Code != "idempotency_conflict" {
		t.Fatalf("done key with different body under K on = %d %s, want 409 idempotency_conflict", respConflict.StatusCode, rawConflict)
	}

	// (b) live in_progress row (<= 60s) + same fingerprint -> 409 idempotency_in_progress with Retry-After: 1
	respInProg, rawInProg := hK.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", inProgBody, reqOptions{
		idemKey: liveKey,
	})
	if respInProg.StatusCode != http.StatusConflict || decodeProblem(t, rawInProg).Code != "idempotency_in_progress" || respInProg.Header.Get("Retry-After") != "1" {
		t.Fatalf("live in_progress key under K on = %d %s (Retry-After=%q), want 409 idempotency_in_progress", respInProg.StatusCode, rawInProg, respInProg.Header.Get("Retry-After"))
	}

	// (c) stale in_progress row (> 60s) + same fingerprint -> passes Lookup, hits K -> 503 vault_mutations_disabled, row untouched.
	respStaleReclaim, rawStaleReclaim := hK.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", inProgBody, reqOptions{
		idemKey: staleKey,
	})
	if respStaleReclaim.StatusCode != http.StatusServiceUnavailable || decodeProblem(t, rawStaleReclaim).Code != "vault_mutations_disabled" {
		t.Fatalf("stale in_progress reclaim under K on = %d %s, want 503 vault_mutations_disabled", respStaleReclaim.StatusCode, rawStaleReclaim)
	}
	staleRow, err := q.GetIdempotencyKey(ctx, gen.GetIdempotencyKeyParams{
		UserID: meA.User.ID,
		Key:    staleKey,
		Now:    pgtype.Timestamptz{Time: now, Valid: true},
	})
	if err != nil {
		t.Fatalf("GetIdempotencyKey staleKey: %v", err)
	}
	if staleRow.Status != "in_progress" || staleRow.OwnerToken != staleOwner || !staleRow.ClaimedAt.Time.Equal(staleClaimedAt) {
		t.Fatalf("stale in_progress row modified under K on: %+v", staleRow)
	}

	// (d) fresh request under K on -> 503 vault_mutations_disabled with no side effects.
	respFresh, rawFresh := hK.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", inProgBody, reqOptions{
		idemKey: "idem-ks-fresh-rewrap-blocked",
	})
	if respFresh.StatusCode != http.StatusServiceUnavailable || decodeProblem(t, rawFresh).Code != "vault_mutations_disabled" {
		t.Fatalf("fresh PUT /vault/kek under K on = %d %s, want 503 vault_mutations_disabled", respFresh.StatusCode, rawFresh)
	}

	// Verify zero side effects across all replays, 409s, stale reclaim, and fresh 503.
	re1, au1, no1, id1, rk1, ver1 := snapshotCounts()
	if re1 != re0 || au1 != au0 || no1 != no0 || id1 != id0 || rk1 != rk0 || ver1 != ver0 {
		t.Fatalf("side effects changed under K=on: before=(re=%d au=%d no=%d id=%d rk=%d ver=%d) after=(re=%d au=%d no=%d id=%d rk=%d ver=%d)",
			re0, au0, no0, id0, rk0, ver0, re1, au1, no1, id1, rk1, ver1)
	}

	// 4. Commit DELETE /vault on h (K=off), then replay on hK (K=on) after grant expiry -> 204 empty, no new side effects.
	resetGrant := h.reauthGrant(jarA, "vault.reset", password)
	resetKey := "idem-ks-replay-reset-0001"
	ifMatchV3 := formatIfMatchTag(created.VaultKeyID, 3)
	respReset, rawReset := h.doReq(jarA, http.MethodDelete, "/api/v1/vault", "", reqOptions{
		idemKey: resetKey,
		ifMatch: ifMatchV3,
		grant:   resetGrant,
	})
	if respReset.StatusCode != http.StatusNoContent || rawReset != "" {
		t.Fatalf("initial DELETE /vault = %d %q, want 204 empty", respReset.StatusCode, rawReset)
	}
	h.clk.Advance(6 * time.Minute)
	respRef, rawRef := h.doReq(jarA, http.MethodPost, "/api/v1/auth/refresh", "", reqOptions{})
	if respRef.StatusCode != http.StatusNoContent {
		t.Fatalf("refresh session = %d %s", respRef.StatusCode, rawRef)
	}

	var reBeforeResetReplay, auBeforeResetReplay, noBeforeResetReplay, idBeforeResetReplay int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM rate_event WHERE user_id = $1`, meA.User.ID).Scan(&reBeforeResetReplay); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1`, meA.User.ID).Scan(&auBeforeResetReplay); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1`, meA.User.ID).Scan(&noBeforeResetReplay); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1`, meA.User.ID).Scan(&idBeforeResetReplay); err != nil {
		t.Fatal(err)
	}

	repReset, rawRepReset := hK.doReq(jarA, http.MethodDelete, "/api/v1/vault", "", reqOptions{
		idemKey: resetKey,
		ifMatch: ifMatchV3,
		grant:   resetGrant,
	})
	if repReset.StatusCode != http.StatusNoContent || rawRepReset != "" {
		t.Fatalf("replay DELETE /vault with K on = %d %q, want 204 empty", repReset.StatusCode, rawRepReset)
	}

	var reAfterResetReplay, auAfterResetReplay, noAfterResetReplay, idAfterResetReplay int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM rate_event WHERE user_id = $1`, meA.User.ID).Scan(&reAfterResetReplay); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1`, meA.User.ID).Scan(&auAfterResetReplay); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1`, meA.User.ID).Scan(&noAfterResetReplay); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1`, meA.User.ID).Scan(&idAfterResetReplay); err != nil {
		t.Fatal(err)
	}
	if reAfterResetReplay != reBeforeResetReplay || auAfterResetReplay != auBeforeResetReplay ||
		noAfterResetReplay != noBeforeResetReplay || idAfterResetReplay != idBeforeResetReplay {
		t.Fatalf("side effects on DELETE /vault replay under K=on")
	}
}

// TestLogsAndAuditNeverContainLookupHashWrapOrRequestBody covers Task 8 bullet:
// "log và audit không chứa lookup_hash, wrap hay body request".
func TestLogsAndAuditNeverContainLookupHashWrapOrRequestBody(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	jarA, meA := h.signupUser("no-secret-logs@example.com", "correct-horse-battery-staple")

	payload := makeCreatePayload(t, 0x55)
	bodyJSON := mustJSON(t, payload)

	// 1. Successful POST /vault
	resp, raw := h.doReq(jarA, http.MethodPost, "/api/v1/vault", bodyJSON, reqOptions{
		idemKey: "idem-log-audit-check-01",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /vault = %d %s", resp.StatusCode, raw)
	}

	// 2. Failed POST /vault (duplicate create -> 409 vault_exists)
	_, _ = h.doReq(jarA, http.MethodPost, "/api/v1/vault", bodyJSON, reqOptions{
		idemKey: "idem-log-audit-check-02",
	})

	// 3. GET /vault, GET /vault/recovery-keys, GET /vault/passkeys
	_, _ = h.doReq(jarA, http.MethodGet, "/api/v1/vault", "", reqOptions{})
	_, _ = h.doReq(jarA, http.MethodGet, "/api/v1/vault/recovery-keys", "", reqOptions{})
	_, _ = h.doReq(jarA, http.MethodGet, "/api/v1/vault/passkeys", "", reqOptions{})

	// Collect all sensitive sentinels from the request.
	sentinels := []string{
		payload.VaultKeyWrappedByKEK,
		payload.PrivateKeysWrapped,
		payload.X25519Public,
		payload.Ed25519Public,
		payload.KDF.Salt,
	}
	for _, rk := range payload.RecoveryKeys {
		sentinels = append(sentinels, rk.LookupHash, rk.Wrap)
	}

	// Check captured structured logs.
	logOutput := h.logs.String()
	for _, s := range sentinels {
		if strings.Contains(logOutput, s) {
			t.Fatalf("server logs leaked sensitive value %q: %s", s, logOutput)
		}
	}

	// Check audit_log rows in Postgres (both via SQL and via GET /api/v1/auth/audit).
	rows, err := h.pool.Query(context.Background(), `SELECT event, meta::text FROM audit_log WHERE user_id = $1`, meA.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	foundVaultCreate := false
	for rows.Next() {
		var ev, metaText string
		if err := rows.Scan(&ev, &metaText); err != nil {
			t.Fatal(err)
		}
		if ev == vault.EventVaultCreate {
			foundVaultCreate = true
		}
		for _, s := range sentinels {
			if strings.Contains(metaText, s) {
				t.Fatalf("audit_log (%s) meta leaked sensitive value %q: %s", ev, s, metaText)
			}
		}
	}
	if !foundVaultCreate {
		t.Fatal("missing vault.create audit_log row")
	}

	respAudit, rawAudit := h.doReq(jarA, http.MethodGet, "/api/v1/auth/audit", "", reqOptions{})
	if respAudit.StatusCode != http.StatusOK {
		t.Fatalf("GET /auth/audit = %d %s", respAudit.StatusCode, rawAudit)
	}
	for _, s := range sentinels {
		if strings.Contains(rawAudit, s) {
			t.Fatalf("GET /auth/audit response leaked sensitive value %q: %s", s, rawAudit)
		}
	}
}

// TestT9ToT12RouteChainEnforcesReauthRateLimitIfMatchAndIdempotency verifies that the
// route registrations for T9-T12 in `vaulthttp/routes.go` enforce the exact middleware order
// of plan mục 2.3 & mục 3 (S, C, I.Lookup, A(action), R(scope), M, I.Claim) before reaching
// the T9-T12 handler stubs.
func TestT9ToT12RouteChainEnforcesReauthRateLimitIfMatchAndIdempotency(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	jarA, _ := h.signupUser("chain-user@example.com", password)

	// 1. Missing Reauth grant on PUT /vault/kek -> 401 reauth_invalid (before If-Match).
	resp, raw := h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", `{"kdf":{},"vault_key_wrapped_by_kek":"x"}`, reqOptions{
		idemKey: "idem-chain-rewrap-no-grant",
	})
	if resp.StatusCode != http.StatusUnauthorized || decodeProblem(t, raw).Code != "reauth_invalid" {
		t.Fatalf("PUT /vault/kek without grant = %d %s, want 401 reauth_invalid", resp.StatusCode, raw)
	}

	// 2. Wrong Reauth action grant on PUT /vault/kek -> 401 reauth_invalid.
	wrongGrant := h.reauthGrant(jarA, "vault.reset", password)
	resp, raw = h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", `{"kdf":{},"vault_key_wrapped_by_kek":"x"}`, reqOptions{
		idemKey: "idem-chain-rewrap-bad-grant",
		grant:   wrongGrant,
	})
	if resp.StatusCode != http.StatusUnauthorized || decodeProblem(t, raw).Code != "reauth_invalid" {
		t.Fatalf("PUT /vault/kek wrong grant = %d %s, want 401 reauth_invalid", resp.StatusCode, raw)
	}

	// 3. Valid Reauth grant but missing If-Match -> 428 precondition_required.
	validRewrapGrant := h.reauthGrant(jarA, "vault.rewrap", password)
	resp, raw = h.doReq(jarA, http.MethodPut, "/api/v1/vault/kek", `{"kdf":{},"vault_key_wrapped_by_kek":"x"}`, reqOptions{
		idemKey: "idem-chain-rewrap-no-ifmatch",
		grant:   validRewrapGrant,
	})
	if resp.StatusCode != http.StatusPreconditionRequired || decodeProblem(t, raw).Code != "precondition_required" {
		t.Fatalf("PUT /vault/kek without If-Match = %d %s, want 428 precondition_required", resp.StatusCode, raw)
	}

	// 4. DELETE /vault with empty body does NOT fail with 415 Unsupported Media Type;
	// with valid grant + If-Match it reaches the T12 handler and returns 404 vault_absent (since jarA has no vault).
	resetGrant := h.reauthGrant(jarA, "vault.reset", password)
	respDel, rawDel := h.doReq(jarA, http.MethodDelete, "/api/v1/vault", "", reqOptions{
		idemKey: "idem-chain-reset-empty-body",
		ifMatch: `"vk:AAECAwQFBgcICQoLDA0ODw:1"`,
		grant:   resetGrant,
	})
	if respDel.StatusCode != http.StatusNotFound || decodeProblem(t, rawDel).Code != "vault_absent" {
		t.Fatalf("DELETE /vault empty body = %d %s, want 404 vault_absent", respDel.StatusCode, rawDel)
	}
}
