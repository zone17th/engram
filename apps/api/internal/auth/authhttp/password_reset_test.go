package authhttp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/auth/oauth"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/notification"
	"github.com/zone17th/engram/apps/api/internal/secevent"
	"github.com/zone17th/engram/apps/api/internal/worker"
	"github.com/zone17th/engram/apps/api/migrations"
)

func waitForForgotJobs(t *testing.T, h *harness, count int) []auth.ForgotJob {
	t.Helper()
	doneCh := make(chan auth.ForgotJob, count+8)
	h.svc.SetForgotHooks(auth.ForgotHooks{
		OnJobDone: func(job auth.ForgotJob, err error) {
			if err != nil {
				t.Errorf("forgot job error: %v", err)
			}
			doneCh <- job
		},
	})
	t.Cleanup(func() { h.svc.SetForgotHooks(auth.ForgotHooks{}) })
	var out []auth.ForgotJob
	for range count {
		select {
		case j := <-doneCh:
			out = append(out, j)
		case <-time.After(10 * time.Second):
			t.Fatalf("timed out waiting for %d forgot jobs (got %d)", count, len(out))
		}
	}
	return out
}

func extractResetTokenFromSink(t *testing.T, h *harness, recipient string) (token string, link string) {
	t.Helper()
	entries, err := h.mail.EntriesFor(recipient, auth.PurposePasswordReset)
	if err != nil || len(entries) == 0 {
		t.Fatalf("reset mail for %s = %d, err=%v", recipient, len(entries), err)
	}
	last := entries[len(entries)-1]
	u, err := url.Parse(last.Link)
	if err != nil {
		t.Fatalf("parse reset link %q: %v", last.Link, err)
	}
	vals, err := url.ParseQuery(u.Fragment)
	if err != nil || vals.Get("token") == "" {
		t.Fatalf("reset link fragment missing token: %q", last.Link)
	}
	return vals.Get("token"), last.Link
}

func runNoticeMailForLatestNotification(t *testing.T, h *harness) {
	t.Helper()
	ctx := context.Background()
	var notifID int64
	if err := h.pool.QueryRow(ctx, `SELECT id FROM user_notification ORDER BY id DESC LIMIT 1`).Scan(&notifID); err != nil {
		t.Fatalf("query latest notification: %v", err)
	}
	w := worker.NewSecurityNoticeWorker(h.pool, h.mail, nil)
	if err := w.Work(ctx, &river.Job[notification.SecurityNoticeArgs]{
		Args: notification.SecurityNoticeArgs{NotificationID: notifID},
	}); err != nil {
		t.Fatalf("SecurityNoticeWorker.Work(%d): %v", notifID, err)
	}
}

// 1. D1: mail_delivery_available capability flag (unset/false vs true with SinkMailer).
func TestPasswordForgotCapabilityFlagAndConfig(t *testing.T) {
	t.Setenv("AUTH_MAIL_CAPTURE_AS_DELIVERY", "false")
	h := newHarness(t, nil)
	// Override env to false and check config/forgot behavior when flag is false.
	// Note: newHarness sets AUTH_MAIL_CAPTURE_AS_DELIVERY=true by default; create a dedicated server with false.
	t.Setenv("AUTH_MAIL_CAPTURE_AS_DELIVERY", "false")
	srv := acceptanceCaptchaServer(t, h, auth.NoCaptcha{})
	t.Cleanup(srv.Close)

	// Re-create service with MailCaptureAsDelivery = false.
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	clk := clock.NewFixed(time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", h.origin)
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_MAIL_CAPTURE_AS_DELIVERY", "false")
	cfgOff := loadTestConfig(t)
	sinkOff, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svcOff := newServiceWithConfig(t, cfgOff, pool, clk, sinkOff)
	if svcOff.PublicConfig().MailDeliveryAvailable {
		t.Fatal("SinkMailer with AUTH_MAIL_CAPTURE_AS_DELIVERY=false must report mail_delivery_available=false")
	}

	// With harness (AUTH_MAIL_CAPTURE_AS_DELIVERY=true), GET /auth/config reports true.
	resp := h.do(http.MethodGet, "/api/v1/auth/config", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /auth/config = %d %s", resp.StatusCode, h.body(resp))
	}
	var pubCfg auth.AuthConfig
	if err := json.NewDecoder(resp.Body).Decode(&pubCfg); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if !pubCfg.MailDeliveryAvailable {
		t.Fatal("GET /auth/config with capture flag true must report mail_delivery_available=true")
	}

	// Swap harness to use svcOff to verify uniform 503 mail_delivery_unavailable before CAPTCHA/quota/DB.
	var captchaCalled atomic.Bool
	spyCaptcha := spyCaptchaVerifier{onVerify: func() { captchaCalled.Store(true) }}
	srvOff := serverForService(t, cfgOff, svcOff, h.oa, spyCaptcha)
	t.Cleanup(srvOff.Close)
	oldSrv := h.srv
	h.srv = srvOff
	t.Cleanup(func() { h.srv = oldSrv })

	j := jar{}
	h.csrfJar(j)
	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/forgot", `{"email":"any@example.com"}`, true, "203.0.113.10")
	requireAcceptanceProblem(t, h, resp, http.StatusServiceUnavailable, "mail_delivery_unavailable")
	if captchaCalled.Load() {
		t.Fatal("503 mail_delivery_unavailable must return before CAPTCHA verification")
	}
	// Invalid email syntax still returns 400 invalid_request before 503.
	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/forgot", `{"email":"not-an-email"}`, true, "203.0.113.10")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "invalid_request")
}

// 2. Anti-enumeration & Async acceptance boundary + queue overflow.
func TestPasswordForgotAntiEnumerationAsyncBoundaryAndOverflow(t *testing.T) {
	fakeGoogle := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "g-oauth-only", Email: "oauth-only@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fakeGoogle})
	fakeGoogle.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")

	// Create password user.
	signupAcceptance(t, h, "pw-user@example.com")
	// Create OAuth-only user.
	jOAuth := jar{}
	h.csrfJar(jOAuth)
	h.jar = jOAuth
	completeAcceptanceOAuth(t, h)

	// Block worker to prove HTTP 202 returns before worker touches DB/mail for all 3 branches.
	blockWorker := make(chan struct{})
	startedFirst := make(chan struct{}, 1)
	doneCh := make(chan auth.ForgotJob, 10)
	h.svc.SetForgotHooks(auth.ForgotHooks{
		OnJobStart: func(job auth.ForgotJob) {
			select {
			case startedFirst <- struct{}{}:
			default:
			}
			<-blockWorker
		},
		OnJobDone: func(job auth.ForgotJob, err error) {
			if err != nil {
				t.Errorf("forgot worker err: %v", err)
			}
			doneCh <- job
		},
	})
	t.Cleanup(func() { h.svc.SetForgotHooks(auth.ForgotHooks{}) })

	branches := []struct {
		email  string
		locale string
		xff    string
	}{
		{email: "pw-user@example.com", locale: "vi", xff: "198.51.100.11"},
		{email: "oauth-only@example.com", locale: "en", xff: "198.51.100.12"},
		{email: "unknown-user@example.com", locale: "en", xff: "198.51.100.13"},
	}

	for _, tc := range branches {
		j := jar{}
		h.csrfJar(j)
		body := fmt.Sprintf(`{"email":%q,"locale":%q}`, tc.email, tc.locale)
		resp := h.doAs(j, http.MethodPost, "/api/v1/auth/password/forgot", body, true, tc.xff)
		raw := h.body(resp)
		if resp.StatusCode != http.StatusAccepted || raw != "" {
			t.Fatalf("forgot %s = %d %q, want 202 empty body", tc.email, resp.StatusCode, raw)
		}
		if got := resp.Header.Get("Cache-Control"); got != "no-store" {
			t.Fatalf("forgot %s Cache-Control = %q, want no-store", tc.email, got)
		}
	}

	// While worker is blocked, 0 reset tokens and 0 forgot emails exist yet.
	var tokCount int
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM password_reset_token`).Scan(&tokCount); err != nil {
		t.Fatal(err)
	}
	if tokCount != 0 {
		t.Fatalf("tokens created before worker unblocked = %d, want 0", tokCount)
	}

	// Test queue overflow while worker is blocked: fill queue and assert HTTP still returns 202.
	<-startedFirst
	for range auth.ForgotQueueSize + 5 {
		h.svc.EnqueueForgotPassword("overflow@example.com", "en")
	}
	jOverflow := jar{}
	h.csrfJar(jOverflow)
	resp := h.doAs(jOverflow, http.MethodPost, "/api/v1/auth/password/forgot", `{"email":"overflow-http@example.com"}`, true, "198.51.100.99")
	if resp.StatusCode != http.StatusAccepted || h.body(resp) != "" {
		t.Fatalf("overflow forgot status = %d, want 202 empty", resp.StatusCode)
	}

	// Unblock worker and wait for the 3 branch jobs.
	close(blockWorker)
	for range 3 {
		select {
		case <-doneCh:
		case <-time.After(10 * time.Second):
			t.Fatal("timed out waiting for forgot jobs")
		}
	}

	// Verify password user got a password_reset email with locale=vi and 43-char token.
	tok, link := extractResetTokenFromSink(t, h, "pw-user@example.com")
	if len(tok) != 43 || !strings.Contains(link, "locale=vi") {
		t.Fatalf("password user reset token=%q link=%q", tok, link)
	}
	// Verify plaintext token is not in DB.
	var dbHashHex string
	if err := h.pool.QueryRow(context.Background(), `SELECT encode(token_hash, 'hex') FROM password_reset_token LIMIT 1`).Scan(&dbHashHex); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(dbHashHex, tok) {
		t.Fatal("token_hash must not contain raw token")
	}

	// Verify OAuth-only user got password_reset_oauth_only reminder and NO reset token row.
	oauthMails, err := h.mail.EntriesFor("oauth-only@example.com", auth.PurposePasswordResetOAuthOnly)
	if err != nil || len(oauthMails) != 1 {
		t.Fatalf("oauth-only reminder mails = %d, err=%v", len(oauthMails), err)
	}
	if strings.Contains(oauthMails[0].Link, "token=") {
		t.Fatalf("oauth-only reminder link must not contain token: %q", oauthMails[0].Link)
	}
	var oauthTokCount int
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM password_reset_token t JOIN app_user u ON u.id = t.user_id WHERE u.email = 'oauth-only@example.com'`).Scan(&oauthTokCount); err != nil {
		t.Fatal(err)
	}
	if oauthTokCount != 0 {
		t.Fatalf("oauth-only user must have 0 reset tokens, got %d", oauthTokCount)
	}

	// Verify unknown user got no mail and no DB rows.
	unkMails, _ := h.mail.EntriesFor("unknown-user@example.com", auth.PurposePasswordReset)
	if len(unkMails) != 0 {
		t.Fatalf("unknown email must receive 0 mails, got %d", len(unkMails))
	}
}

// 3. Presence-aware JSON boundary on POST /auth/password/reset (AU2-BE2-4) + weak password.
func TestPasswordResetPresenceAwareJSONBoundaryAndTokenShape(t *testing.T) {
	h := newHarness(t, nil)
	j := jar{}
	h.csrfJar(j)

	invalidReqBodies := []struct {
		name string
		body string
	}{
		{name: "missing token", body: `{"new_password":"correcthorse"}`},
		{name: "null token", body: `{"token":null,"new_password":"correcthorse"}`},
		{name: "missing new_password", body: `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`},
		{name: "null new_password", body: `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","new_password":null}`},
		{name: "wrong type token int", body: `{"token":123,"new_password":"correcthorse"}`},
		{name: "wrong type new_password array", body: `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","new_password":["a"]}`},
	}

	for i, tc := range invalidReqBodies {
		xff := fmt.Sprintf("198.51.100.%d", 20+i)
		resp := h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", tc.body, true, xff)
		requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "invalid_request")
	}

	invalidTokenBodies := []struct {
		name string
		body string
	}{
		{name: "empty token string", body: `{"token":"","new_password":"correcthorse"}`},
		{name: "short token", body: `{"token":"short","new_password":"correcthorse"}`},
		{name: "long token 44 chars", body: `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","new_password":"correcthorse"}`},
		{name: "invalid base64url alphabet", body: `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!","new_password":"correcthorse"}`},
		{name: "non-existent valid 43-char token", body: `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","new_password":"correcthorse"}`},
	}

	for i, tc := range invalidTokenBodies {
		xff := fmt.Sprintf("198.51.100.%d", 40+i)
		resp := h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", tc.body, true, xff)
		requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")
	}

	// Weak password (< 12 runes or > 1024 UTF-8 bytes) with valid 43-char token -> 400 password_weak.
	resp := h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","new_password":"short"}`, true, "198.51.100.60")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "password_weak")
}

// 4. End-to-end happy path: single use, session revocation, cookie clearing (including caller B vs target A),
// lockout reset, secevent, password_reset_notice, and vault/passkey untouched.
func TestPasswordResetHappyPathSingleUseSessionRevokeNoticeAndVaultUntouched(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()

	// Sign up user A (locale vi) and create a second session for A.
	h.csrf()
	resp := h.doAs(h.jar, http.MethodPost, "/api/v1/auth/signup", `{"email":"alice-reset@example.com","password":"oldpassword12","locale":"vi"}`, true, "203.0.113.1")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup A = %d %s", resp.StatusCode, h.body(resp))
	}
	var meA auth.Me
	if err := json.NewDecoder(resp.Body).Decode(&meA); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	jarA1 := cloneAcceptanceJar(h.jar)

	jarA2 := jar{}
	h.csrfJar(jarA2)
	resp = h.doAs(jarA2, http.MethodPost, "/api/v1/auth/login", `{"email":"alice-reset@example.com","password":"oldpassword12"}`, true, "203.0.113.2")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login A2 = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	// Seed a vault, recovery key, and passkey for user A to verify they remain completely untouched.
	q := gen.New(h.pool)
	kdfJSON := []byte(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"AAAAAAAAAAAAAAAAAAAAAA"}`)
	if _, err := q.InsertVault(ctx, gen.InsertVaultParams{
		UserID:               meA.User.ID,
		Kdf:                  kdfJSON,
		VaultKeyID:           "vk:AAAAAAAAAAAAAAAAAAAAAA",
		VaultKeyWrappedByKek: make([]byte, 73),
		X25519Public:         make([]byte, 32),
		Ed25519Public:        make([]byte, 32),
		PrivateKeysWrapped:   make([]byte, 105),
	}); err != nil {
		t.Fatalf("InsertVault: %v", err)
	}
	if _, err := q.InsertRecoveryKey(ctx, gen.InsertRecoveryKeyParams{
		UserID: meA.User.ID, Slot: 1, LookupHash: bytes.Repeat([]byte{0x41}, 32), Wrap: make([]byte, 73),
	}); err != nil {
		t.Fatalf("InsertRecoveryKey: %v", err)
	}
	if _, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID: meA.User.ID, CredID: []byte("cred-alice-reset-1"), Pubkey: []byte{1}, PrfSalt: make([]byte, 32), VkWrap: make([]byte, 73), Name: "Alice Key",
	}); err != nil {
		t.Fatalf("InsertPasskey: %v", err)
	}

	// Sign up user B on two browsers (jarB1 = calling browser that clicks A's reset link, jarB2 = B's other device).
	jarB1 := jar{}
	h.csrfJar(jarB1)
	resp = h.doAs(jarB1, http.MethodPost, "/api/v1/auth/signup", `{"email":"bob-caller@example.com","password":"bobpassword12"}`, true, "203.0.113.3")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup B1 = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	jarB2 := jar{}
	h.csrfJar(jarB2)
	resp = h.doAs(jarB2, http.MethodPost, "/api/v1/auth/login", `{"email":"bob-caller@example.com","password":"bobpassword12"}`, true, "203.0.113.4")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login B2 = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	// Trigger login lockout on Alice so we can verify reset clears auth_throttle.
	for i := range auth.LockoutFailThreshold {
		xff := fmt.Sprintf("198.51.100.%d", 100+i)
		r := h.doAs(jarA1, http.MethodPost, "/api/v1/auth/login", `{"email":"alice-reset@example.com","password":"wrongpassword"}`, true, xff)
		_ = h.body(r)
	}

	// Request password reset for Alice.
	doneForgot := make(chan struct{}, 1)
	h.svc.SetForgotHooks(auth.ForgotHooks{
		OnJobDone: func(_ auth.ForgotJob, _ error) { doneForgot <- struct{}{} },
	})
	resp = h.doAs(jarA1, http.MethodPost, "/api/v1/auth/password/forgot", `{"email":"alice-reset@example.com","locale":"vi"}`, true, "203.0.113.5")
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("forgot = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	<-doneForgot
	h.svc.SetForgotHooks(auth.ForgotHooks{})

	tok, _ := extractResetTokenFromSink(t, h, "alice-reset@example.com")

	// User B's browser (jarB1) submits Alice's reset token!
	// Verify ClearAuthCookies clears jarB1's local cookies, revokes Alice's sessions (jarA1, jarA2),
	// and leaves Bob's server-side sessions (jarB2) alive (AU2-BE1-9).
	resp = h.doAs(jarB1, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok+`","new_password":"newalicepassword12"}`, true, "203.0.113.6")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("reset = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	if jarB1[authhttp.CookieSession] != nil || jarB1[authhttp.CookieRefresh] != nil || jarB1[authhttp.CookieCSRF] != nil {
		t.Fatalf("reset 204 must clear auth cookies on calling browser: %+v", jarB1)
	}

	// Bob's other device (jarB2) is still authenticated!
	resp = h.doAs(jarB2, http.MethodGet, "/api/v1/auth/me", "", false, "203.0.113.4")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("Bob's other session must remain alive: %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	// Both of Alice's sessions (jarA1, jarA2) are revoked with 401 session_invalid (reason=revoked).
	for idx, jA := range []jar{jarA1, jarA2} {
		resp = h.doAs(jA, http.MethodGet, "/api/v1/auth/me", "", false, "203.0.113.1")
		raw := requireAcceptanceProblem(t, h, resp, http.StatusUnauthorized, "session_invalid")
		if !strings.Contains(raw, `"revoked"`) {
			t.Fatalf("Alice session %d expected reason=revoked, got %s", idx+1, raw)
		}
	}

	// Single-use: replaying the same token returns 400 reset_token_invalid.
	h.csrfJar(jarB1)
	resp = h.doAs(jarB1, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok+`","new_password":"anotherpassword12"}`, true, "203.0.113.6")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")

	// Alice can immediately log in with new password (lockout throttle was reset).
	jarNew := jar{}
	h.csrfJar(jarNew)
	resp = h.doAs(jarNew, http.MethodPost, "/api/v1/auth/login", `{"email":"alice-reset@example.com","password":"newalicepassword12"}`, true, "203.0.113.7")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login with new password = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	// Verify audit event auth.password.reset was recorded.
	resp = h.doAs(jarNew, http.MethodGet, "/api/v1/auth/audit", "", false, "203.0.113.7")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("audit = %d %s", resp.StatusCode, h.body(resp))
	}
	var auditPage auth.CursorPage[auth.AuditItem]
	if err := json.NewDecoder(resp.Body).Decode(&auditPage); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	foundResetAudit := false
	for _, it := range auditPage.Items {
		if it.Event == secevent.EventPasswordReset && it.Result == secevent.ResultSuccess {
			foundResetAudit = true
			break
		}
	}
	if !foundResetAudit {
		t.Fatalf("missing %s in audit log: %+v", secevent.EventPasswordReset, auditPage.Items)
	}

	// Run SecurityNoticeWorker and verify dedicated password_reset_notice mail in Alice's locale (vi).
	runNoticeMailForLatestNotification(t, h)
	notices, err := h.mail.EntriesFor("alice-reset@example.com", auth.PurposePasswordResetNotice)
	if err != nil || len(notices) != 1 {
		t.Fatalf("password_reset_notice mails = %d, err=%v", len(notices), err)
	}
	if !strings.Contains(notices[0].Link, "locale=vi") || !strings.Contains(notices[0].Link, "Mật khẩu đăng nhập engram của bạn vừa được đặt lại") {
		t.Fatalf("unexpected notice detail: %q", notices[0].Link)
	}

	// Verify vault, recovery keys, and passkeys are untouched.
	vRow, err := q.GetVaultByUser(ctx, meA.User.ID)
	if err != nil || vRow.VaultKeyID != "vk:AAAAAAAAAAAAAAAAAAAAAA" {
		t.Fatalf("vault modified or missing after password reset: %+v err=%v", vRow, err)
	}
	rkCount, err := q.CountRecoveryKeysByUser(ctx, meA.User.ID)
	if err != nil || rkCount != 1 {
		t.Fatalf("recovery keys count = %d, err=%v", rkCount, err)
	}
	pks, err := q.ListPasskeysByUser(ctx, meA.User.ID)
	if err != nil || len(pks) != 1 {
		t.Fatalf("passkeys count = %d, err=%v", len(pks), err)
	}
}

// 5. Expiry (fake clock 30m) and invalidation on earlier token when new token issued,
// password change, password unlink, and email change A -> B -> A (AU2-BE1-7).
func TestPasswordResetExpiryAndInvalidationOnPasswordAndEmailChangeABATransitions(t *testing.T) {
	fakeGoogle := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "g-inv", Email: "inv-a@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fakeGoogle})
	fakeGoogle.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")
	ctx := context.Background()

	signupAcceptance(t, h, "inv-a@example.com")
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE email = 'inv-a@example.com'`); err != nil {
		t.Fatal(err)
	}

	requestResetToken := func(email, xff string) string {
		t.Helper()
		done := make(chan struct{}, 1)
		h.svc.SetForgotHooks(auth.ForgotHooks{
			OnJobDone: func(_ auth.ForgotJob, _ error) { done <- struct{}{} },
		})
		j := jar{}
		h.csrfJar(j)
		resp := h.doAs(j, http.MethodPost, "/api/v1/auth/password/forgot", fmt.Sprintf(`{"email":%q}`, email), true, xff)
		if resp.StatusCode != http.StatusAccepted {
			t.Fatalf("forgot %s = %d %s", email, resp.StatusCode, h.body(resp))
		}
		_ = resp.Body.Close()
		<-done
		h.svc.SetForgotHooks(auth.ForgotHooks{})
		tok, _ := extractResetTokenFromSink(t, h, email)
		return tok
	}

	// (a) Issuing a second token expires the first token; advancing clock past 30m expires the second.
	tok1 := requestResetToken("inv-a@example.com", "198.51.100.1")
	h.clk.Advance(2 * time.Minute)
	// Advance rate limit window by using fresh service or wait: FixedWindow uses time.Now(), so call ProcessForgotJob directly when testing token lifecycle within same minute/hour, or advance.
	if err := h.svc.ProcessForgotJob(ctx, auth.ForgotJob{Email: "inv-a@example.com", Locale: "en"}); err != nil {
		t.Fatal(err)
	}
	tok2, _ := extractResetTokenFromSink(t, h, "inv-a@example.com")
	if tok1 == tok2 {
		t.Fatal("expected distinct tokens")
	}

	j := jar{}
	h.csrfJar(j)
	resp := h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok1+`","new_password":"newpassword123"}`, true, "198.51.100.2")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")

	// Advance clock > 30 minutes: tok2 expires.
	h.clk.Advance(auth.PasswordResetTTL + time.Second)
	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok2+`","new_password":"newpassword123"}`, true, "198.51.100.3")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")

	// Refresh session after clock advance.
	resp = h.do(http.MethodPost, "/api/v1/auth/refresh", "", true)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("refresh = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	// (b) Invalidation on ChangePassword.
	if err := h.svc.ProcessForgotJob(ctx, auth.ForgotJob{Email: "inv-a@example.com", Locale: "en"}); err != nil {
		t.Fatal(err)
	}
	tokBeforePwChange, _ := extractResetTokenFromSink(t, h, "inv-a@example.com")
	grant := h.grant("account.password_change", "correcthorse")
	resp = h.withGrant(http.MethodPost, "/api/v1/me/password", `{"new_password":"changedpassword12"}`, grant)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("password change = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tokBeforePwChange+`","new_password":"otherpassword12"}`, true, "198.51.100.4")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")

	// (c) Email change A -> B -> A must NOT revive token issued at A (AU2-BE1-7).
	if err := h.svc.ProcessForgotJob(ctx, auth.ForgotJob{Email: "inv-a@example.com", Locale: "en"}); err != nil {
		t.Fatal(err)
	}
	tokAtEmailA, _ := extractResetTokenFromSink(t, h, "inv-a@example.com")

	// Change email A -> B.
	grantEmail1 := h.grant("account.email_change", "changedpassword12")
	resp = h.withGrant(http.MethodPost, "/api/v1/me/email", `{"new_email":"inv-b@example.com"}`, grantEmail1)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("email change to B = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	confirmTokB := acceptanceToken(t, h, "inv-b@example.com", "email_change")
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+confirmTokB+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("confirm email B = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	// Change email B -> A (via service to avoid 1/min HTTP mail limiter on same user).
	principalNow, err := h.svc.Sessions().Authenticate(ctx, h.jar[authhttp.CookieSession].Value)
	if err != nil {
		t.Fatal(err)
	}
	grantEmail2 := h.grant("account.email_change", "changedpassword12")
	if err := h.svc.RequestEmailChange(ctx, principalNow, "inv-a@example.com", grantEmail2); err != nil {
		t.Fatalf("RequestEmailChange back to A: %v", err)
	}
	confirmTokA := acceptanceToken(t, h, "inv-a@example.com", "email_change")
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+confirmTokA+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("confirm email A = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	// Now email is inv-a@example.com again and password is still changedpassword12,
	// but tokAtEmailA MUST be rejected because ConfirmEmailToken expired pending reset tokens!
	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tokAtEmailA+`","new_password":"revivedpassword12"}`, true, "198.51.100.5")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")

	// (d) Unlink password identity expires pending reset tokens.
	if err := h.svc.ProcessForgotJob(ctx, auth.ForgotJob{Email: "inv-a@example.com", Locale: "en"}); err != nil {
		t.Fatal(err)
	}
	tokBeforeUnlink, _ := extractResetTokenFromSink(t, h, "inv-a@example.com")
	grantLink := h.grant("account.identity_link", "changedpassword12")
	resp = h.withGrant(http.MethodPost, "/api/v1/auth/oauth/google/link", "", grantLink)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("link google = %d %s", resp.StatusCode, h.body(resp))
	}
	var linkStart struct {
		URL string `json:"authorization_url"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&linkStart)
	_ = resp.Body.Close()
	if got := h.followOAuthURL(linkStart.URL); got != "linked" {
		t.Fatalf("follow link = %s", got)
	}
	grantUnlink := h.grant("account.identity_unlink", "changedpassword12")
	resp = h.withGrant(http.MethodDelete, "/api/v1/auth/identities/password", "", grantUnlink)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("unlink password = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tokBeforeUnlink+`","new_password":"afterunlinkpassword12"}`, true, "198.51.100.6")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")
}

// 6. Rate limits (IP 5/min, Email 1/min and 3/hour) + CAPTCHA on forgot.
func TestPasswordForgotAndResetRateLimitsAndCaptcha(t *testing.T) {
	h := newHarness(t, nil)
	j := jar{}
	h.csrfJar(j)

	// Email rate limit: 1st request for same email -> 202; 2nd request from different IP within 1 minute -> 429 rate_limited.
	resp := h.doAs(j, http.MethodPost, "/api/v1/auth/password/forgot", `{"email":"quota-target@example.com"}`, true, "198.51.100.10")
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("first forgot = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/forgot", `{"email":"QUOTA-TARGET@example.com"}`, true, "198.51.100.11")
	raw := requireAcceptanceProblem(t, h, resp, http.StatusTooManyRequests, "rate_limited")
	if resp.Header.Get("Retry-After") == "" || !strings.Contains(raw, `"retry_after"`) {
		t.Fatalf("missing Retry-After on email rate limit: %s", raw)
	}

	// Email 3/hour rate limit: test NewFixedWindowWith(3, time.Hour) directly and verify 4th call within 1 hour is rejected.
	hourLim := httpx.NewFixedWindowWith(3, time.Hour)
	for i := range 3 {
		if ok, _ := hourLim.Allow("mailhr:test-3hr"); !ok {
			t.Fatalf("hour limiter call %d should be allowed", i+1)
		}
	}
	if ok, retry := hourLim.Allow("mailhr:test-3hr"); ok || retry <= 0 {
		t.Fatalf("4th call within 1 hour must be rate limited, ok=%v retry=%d", ok, retry)
	}

	// IP rate limit on forgot: 5 requests from same IP -> 6th is 429.
	for i := range 5 {
		email := fmt.Sprintf("ip-limit-%d@example.com", i)
		r := h.doAs(j, http.MethodPost, "/api/v1/auth/password/forgot", fmt.Sprintf(`{"email":%q}`, email), true, "198.51.100.50")
		if r.StatusCode != http.StatusAccepted {
			t.Fatalf("ip forgot %d = %d %s", i+1, r.StatusCode, h.body(r))
		}
		_ = r.Body.Close()
	}
	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/forgot", `{"email":"ip-limit-6@example.com"}`, true, "198.51.100.50")
	requireAcceptanceProblem(t, h, resp, http.StatusTooManyRequests, "rate_limited")

	// IP rate limit on reset: 5 requests from same IP -> 6th is 429.
	for i := range 5 {
		r := h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","new_password":"correcthorse"}`, true, "198.51.100.51")
		if r.StatusCode != http.StatusBadRequest {
			t.Fatalf("ip reset %d = %d %s", i+1, r.StatusCode, h.body(r))
		}
		_ = r.Body.Close()
	}
	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","new_password":"correcthorse"}`, true, "198.51.100.51")
	requireAcceptanceProblem(t, h, resp, http.StatusTooManyRequests, "rate_limited")

	// CAPTCHA on forgot: when configured, missing/wrong token -> 403 captcha_required before email quota; valid token -> 202.
	srv := acceptanceCaptchaServer(t, h, auth.StaticCaptcha{Accept: "turnstile-valid"})
	t.Cleanup(srv.Close)
	oldSrv := h.srv
	h.srv = srv
	t.Cleanup(func() { h.srv = oldSrv })

	jCap := jar{}
	h.csrfJar(jCap)
	resp = h.doAs(jCap, http.MethodPost, "/api/v1/auth/password/forgot", `{"email":"cap-user@example.com"}`, true, "198.51.100.70")
	rawCap := requireAcceptanceProblem(t, h, resp, http.StatusForbidden, "captcha_required")
	if !strings.Contains(rawCap, `"captcha_required":true`) {
		t.Fatalf("expected captcha_required:true extension, got %s", rawCap)
	}
	// Because CAPTCHA failed before email quota, sending valid CAPTCHA for the same email immediately succeeds with 202!
	resp = h.doAs(jCap, http.MethodPost, "/api/v1/auth/password/forgot", `{"email":"cap-user@example.com","captcha_token":"turnstile-valid"}`, true, "198.51.100.70")
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("forgot with valid captcha = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
}

// 7. Concurrent issuance serialization under app_user FOR UPDATE (AU2-BE1-6).
func TestPasswordForgotConcurrentIssuanceLeavesOneLiveToken(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	signupAcceptance(t, h, "concurrent-issue@example.com")

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- h.svc.ProcessForgotJob(ctx, auth.ForgotJob{Email: "concurrent-issue@example.com", Locale: "en"})
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent ProcessForgotJob err: %v", err)
		}
	}

	var liveCount, totalCount int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM password_reset_token WHERE consumed_at IS NULL`).Scan(&liveCount); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM password_reset_token`).Scan(&totalCount); err != nil {
		t.Fatal(err)
	}
	if totalCount != 2 || liveCount != 1 {
		t.Fatalf("expected 2 total tokens and 1 live token, got total=%d live=%d", totalCount, liveCount)
	}
}

// 8. D2 deterministic barrier race: old-password Login vs ResetPassword (AU2-BE1-3).
func TestLoginOldPasswordBarrierRaceAgainstResetPassword(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	signupAcceptance(t, h, "d2-race@example.com")

	if err := h.svc.ProcessForgotJob(ctx, auth.ForgotJob{Email: "d2-race@example.com", Locale: "en"}); err != nil {
		t.Fatal(err)
	}
	tok, _ := extractResetTokenFromSink(t, h, "d2-race@example.com")

	loginVerified := make(chan struct{})
	releaseLogin := make(chan struct{})
	h.svc.SetOnLoginVerified(func() {
		close(loginVerified)
		<-releaseLogin
	})
	t.Cleanup(func() { h.svc.SetOnLoginVerified(nil) })

	loginDone := make(chan *http.Response, 1)
	go func() {
		jLogin := jar{}
		h.csrfJar(jLogin)
		loginDone <- h.doAs(jLogin, http.MethodPost, "/api/v1/auth/login", `{"email":"d2-race@example.com","password":"correcthorse"}`, true, "203.0.113.88")
	}()

	// Wait until Login has verified the old password outside the transaction.
	<-loginVerified

	// Now execute ResetPassword to completion.
	jReset := jar{}
	h.csrfJar(jReset)
	respReset := h.doAs(jReset, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok+`","new_password":"resetwinnerpassword12"}`, true, "203.0.113.89")
	if respReset.StatusCode != http.StatusNoContent {
		t.Fatalf("reset = %d %s", respReset.StatusCode, h.body(respReset))
	}
	_ = respReset.Body.Close()

	// Release Login to enter its session-issuance transaction.
	close(releaseLogin)
	respLogin := <-loginDone
	requireAcceptanceProblem(t, h, respLogin, http.StatusUnauthorized, "invalid_credentials")

	// Assert 0 live sessions exist for the user.
	var aliveSessions int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM session s JOIN app_user u ON u.id = s.user_id WHERE u.email = 'd2-race@example.com' AND s.revoked_at IS NULL`).Scan(&aliveSessions); err != nil {
		t.Fatal(err)
	}
	if aliveSessions != 0 {
		t.Fatalf("expected 0 live sessions after D2 race, got %d", aliveSessions)
	}
}

// 9. D3 & E1: OAuth link refusal when unverified, verify-between-issue-and-consume (AU2-BE2-3),
// and deterministic barrier races on oauth.Service.Complete + in-flight Callback (AU2-BE2-1, AU2-BE3-1).
func TestOAuthPreRegistrationDefenseAndCompleteRaces(t *testing.T) {
	fakeGoogle := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "g-attacker", Email: "victim-d3@example.com", EmailVerified: true,
	})
	fakeGitHub := oauth.NewFake("github", false, oauth.Identity{
		Provider: "github", UID: "gh-attacker", Email: "attacker-gh@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fakeGoogle, fakeGitHub})
	fakeGoogle.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")
	fakeGitHub.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/github")
	fakeGoogle.Now = h.clk.Now
	ctx := context.Background()

	// (a) D3: Unverified account cannot link OAuth via StartLink (403 email_not_verified)
	// or Callback if email becomes unverified before callback ("invalid_flow").
	signupAcceptance(t, h, "victim-d3@example.com")
	grantLink := h.grant("account.identity_link", "correcthorse")
	resp := h.withGrant(http.MethodPost, "/api/v1/auth/oauth/google/link", "", grantLink)
	requireAcceptanceProblem(t, h, resp, http.StatusForbidden, "email_not_verified")

	// Temporarily mark verified to start link flow, then set email_verified_at = NULL before callback.
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE email = 'victim-d3@example.com'`); err != nil {
		t.Fatal(err)
	}
	resp = h.withGrant(http.MethodPost, "/api/v1/auth/oauth/google/link", "", grantLink)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("link start = %d %s", resp.StatusCode, h.body(resp))
	}
	var linkStart struct {
		URL string `json:"authorization_url"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&linkStart)
	_ = resp.Body.Close()
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = NULL WHERE email = 'victim-d3@example.com'`); err != nil {
		t.Fatal(err)
	}
	if got := h.followOAuthURL(linkStart.URL); got != "invalid_flow" {
		t.Fatalf("callback link when unverified = %s, want invalid_flow", got)
	}

	// (b) Seed pre-existing linked OAuth identities (google + github) on the unverified account,
	// issue a reset token while unverified (was_email_unverified = true), then verify the email
	// BEFORE consuming the reset token (AU2-BE2-3).
	var victimID uuid.UUID
	if err := h.pool.QueryRow(ctx, `SELECT id FROM app_user WHERE email = 'victim-d3@example.com'`).Scan(&victimID); err != nil {
		t.Fatal(err)
	}
	q := gen.New(h.pool)
	if _, err := q.InsertOAuthIdentity(ctx, gen.InsertOAuthIdentityParams{
		UserID: victimID, Provider: "google", ProviderUid: new("g-attacker"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertOAuthIdentity(ctx, gen.InsertOAuthIdentityParams{
		UserID: victimID, Provider: "github", ProviderUid: new("gh-attacker"),
	}); err != nil {
		t.Fatal(err)
	}

	// Issue reset token while email_verified_at IS NULL (was_email_unverified = true).
	if err := h.svc.ProcessForgotJob(ctx, auth.ForgotJob{Email: "victim-d3@example.com", Locale: "en"}); err != nil {
		t.Fatal(err)
	}
	tok, _ := extractResetTokenFromSink(t, h, "victim-d3@example.com")

	// Attacker starts an OAuth login flow and reaches login_ready BEFORE reset.
	jarAttacker := jar{}
	h.csrfJar(jarAttacker)
	oldJar := h.jar
	h.jar = jarAttacker
	if got := statusFromCallback(h.followOAuth("/api/v1/auth/oauth/google/start")); got != "login_ready" {
		t.Fatalf("attacker oauth callback = %s", got)
	}
	jarAttacker = cloneAcceptanceJar(h.jar)
	h.jar = oldJar

	// Attacker also verifies the account's email between reset token issuance and consumption (AU2-BE2-3)!
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, victimID); err != nil {
		t.Fatal(err)
	}

	// Set deterministic barrier in oauth.Service.Complete right after non-locking owner discovery (E1 A).
	ownerDiscovered := make(chan struct{})
	releaseComplete := make(chan struct{})
	h.oa.SetOnOwnerDiscovered(func() {
		close(ownerDiscovered)
		<-releaseComplete
	})
	t.Cleanup(func() { h.oa.SetOnOwnerDiscovered(nil) })

	completeDone := make(chan *http.Response, 1)
	go func() {
		h.csrfJar(jarAttacker)
		completeDone <- h.doAs(jarAttacker, http.MethodPost, "/api/v1/auth/oauth/complete", "", true, "198.51.100.200")
	}()

	<-ownerDiscovered

	// Victim consumes reset token while Complete is paused after owner discovery.
	jVictim := jar{}
	h.csrfJar(jVictim)
	respReset := h.doAs(jVictim, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok+`","new_password":"victimrecovered12"}`, true, "198.51.100.201")
	if respReset.StatusCode != http.StatusNoContent {
		t.Fatalf("victim reset = %d %s", respReset.StatusCode, h.body(respReset))
	}
	_ = respReset.Body.Close()

	// Release Complete -> must fail with 400 oauth_state_invalid and issue 0 sessions!
	close(releaseComplete)
	respComplete := <-completeDone
	requireAcceptanceProblem(t, h, respComplete, http.StatusBadRequest, "oauth_state_invalid")
	h.oa.SetOnOwnerDiscovered(nil)

	// Verify 0 sessions for victim and 0 OAuth identities remaining on victim.
	var sessionCount, oauthIdentCount int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM session WHERE user_id = $1 AND revoked_at IS NULL`, victimID).Scan(&sessionCount); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM auth_identity WHERE user_id = $1 AND provider IN ('google', 'github')`, victimID).Scan(&oauthIdentCount); err != nil {
		t.Fatal(err)
	}
	if sessionCount != 0 || oauthIdentCount != 0 {
		t.Fatalf("expected 0 live sessions and 0 OAuth identities, got sessions=%d oauthIdents=%d", sessionCount, oauthIdentCount)
	}

	// Verify audit log recorded auth.identity.unlink (reason=unverified) for both google and github.
	var unlinkAuditCount int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2 AND meta->>'reason' = 'unverified'`,
		victimID, secevent.EventIdentityUnlink).Scan(&unlinkAuditCount); err != nil {
		t.Fatal(err)
	}
	if unlinkAuditCount != 2 {
		t.Fatalf("expected 2 unverified unlink audit events, got %d", unlinkAuditCount)
	}

	// Verify notice mail names Google and GitHub.
	runNoticeMailForLatestNotification(t, h)
	notices, err := h.mail.EntriesFor("victim-d3@example.com", auth.PurposePasswordResetNotice)
	if err != nil || len(notices) != 1 {
		t.Fatalf("notice mails = %d, err=%v", len(notices), err)
	}
	if !strings.Contains(notices[0].Link, "Google") || !strings.Contains(notices[0].Link, "GitHub") {
		t.Fatalf("notice mail must name unlinked providers Google and GitHub: %q", notices[0].Link)
	}

	// (c) In-flight OAuth callback finishing exchange AFTER reset committed (AU2-BE2-1 #2 & AU2-BE3-1):
	// Case 1: Provider email matches victim's email ("victim-d3@example.com") -> Complete returns 409 email_taken.
	jarInFlightSameEmail := jar{}
	h.csrfJar(jarInFlightSameEmail)
	h.jar = jarInFlightSameEmail
	if got := statusFromCallback(h.followOAuth("/api/v1/auth/oauth/google/start")); got != "login_ready" {
		t.Fatalf("in-flight same-email callback = %s", got)
	}
	h.csrf()
	respSame := h.doAs(h.jar, http.MethodPost, "/api/v1/auth/oauth/complete", "", true, "198.51.100.202")
	requireAcceptanceProblem(t, h, respSame, http.StatusConflict, "email_taken")

	// Case 2 (AU2-BE3-1): Provider email is attacker's different mailbox ("attacker-gh@example.com") ->
	// Complete creates a separate account for attacker-gh@example.com, issuing NO session for the recovered victim!
	jarInFlightDiffEmail := jar{}
	h.csrfJar(jarInFlightDiffEmail)
	h.jar = jarInFlightDiffEmail
	if got := statusFromCallback(h.followOAuth("/api/v1/auth/oauth/github/start")); got != "login_ready" {
		t.Fatalf("in-flight diff-email callback = %s", got)
	}
	h.csrf()
	respDiff := h.doAs(h.jar, http.MethodPost, "/api/v1/auth/oauth/complete", "", true, "198.51.100.203")
	if respDiff.StatusCode != http.StatusOK {
		t.Fatalf("diff-email oauth signup = %d %s", respDiff.StatusCode, h.body(respDiff))
	}
	var meAttacker auth.Me
	if err := json.NewDecoder(respDiff.Body).Decode(&meAttacker); err != nil {
		t.Fatal(err)
	}
	_ = respDiff.Body.Close()
	if meAttacker.User.ID == victimID {
		t.Fatal("different-email OAuth signup must never issue a session for the recovered victim account")
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM session WHERE user_id = $1 AND revoked_at IS NULL`, victimID).Scan(&sessionCount); err != nil {
		t.Fatal(err)
	}
	if sessionCount != 0 {
		t.Fatalf("victim must still have 0 live sessions, got %d", sessionCount)
	}
}

// 10. E2 forced collision between ResetPassword and Logout / lock timeout retry + 503 dependency_unavailable (AU2-BE2-2).
func TestPasswordResetDeadlockRetryWithLogoutAndExhaustedRetry503(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	signupAcceptance(t, h, "e2-collision@example.com")
	jarLogout := cloneAcceptanceJar(h.jar)

	if err := h.svc.ProcessForgotJob(ctx, auth.ForgotJob{Email: "e2-collision@example.com", Locale: "en"}); err != nil {
		t.Fatal(err)
	}
	tok, _ := extractResetTokenFromSink(t, h, "e2-collision@example.com")

	// Part A: Forced concurrent collision between ResetPassword and Logout on the same user.
	// ResetPassword locks app_user FOR UPDATE first; pause it right after locking app_user,
	// fire Logout concurrently, then release ResetPassword and assert ResetPassword commits cleanly (204)
	// and all sessions are revoked (no 500).
	resetLocked := make(chan struct{})
	releaseReset := make(chan struct{})
	var once sync.Once
	h.svc.SetOnResetLocked(func() {
		once.Do(func() {
			close(resetLocked)
			<-releaseReset
		})
	})

	resetDone := make(chan *http.Response, 1)
	go func() {
		jReset := jar{}
		h.csrfJar(jReset)
		resetDone <- h.doAs(jReset, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok+`","new_password":"aftercollision12"}`, true, "203.0.113.91")
	}()

	<-resetLocked

	logoutDone := make(chan *http.Response, 1)
	go func() {
		logoutDone <- h.doAs(jarLogout, http.MethodPost, "/api/v1/auth/logout", "", true, "203.0.113.92")
	}()

	// Give Logout's transaction a moment to lock session and wait on audit_log FK share lock on app_user,
	// triggering either serialization or a 40P01 deadlock that ResetPassword retries automatically.
	time.Sleep(30 * time.Millisecond)
	close(releaseReset)

	respReset := <-resetDone
	if respReset.StatusCode != http.StatusNoContent {
		t.Fatalf("ResetPassword under Logout collision = %d %s, want 204", respReset.StatusCode, h.body(respReset))
	}
	_ = respReset.Body.Close()

	respLogout := <-logoutDone
	_ = respLogout.Body.Close()
	h.svc.SetOnResetLocked(nil)

	// Verify all sessions are revoked and new password works.
	var liveSessions int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM session s JOIN app_user u ON u.id = s.user_id WHERE u.email = 'e2-collision@example.com' AND s.revoked_at IS NULL`).Scan(&liveSessions); err != nil {
		t.Fatal(err)
	}
	if liveSessions != 0 {
		t.Fatalf("expected 0 live sessions after reset-vs-logout collision, got %d", liveSessions)
	}

	// Part B: Simulate 55P03 lock_not_available on first attempt (succeeds on automatic retry)
	// and on both attempts (returns 503 dependency_unavailable + Retry-After: 1, token stays unconsumed).
	if err := h.svc.ProcessForgotJob(ctx, auth.ForgotJob{Email: "e2-collision@example.com", Locale: "en"}); err != nil {
		t.Fatal(err)
	}
	tok2, _ := extractResetTokenFromSink(t, h, "e2-collision@example.com")

	// Hold an external FOR UPDATE lock on app_user, and set lock_timeout on pool connections or hold lock across both retries.
	lockTx, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lockTx.Rollback(ctx) }()
	if _, err := lockTx.Exec(ctx, `SELECT id FROM app_user WHERE email = 'e2-collision@example.com' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}

	// Configure short lock_timeout on pool so blocked FOR UPDATE raises SQLSTATE 55P03 (lock_not_available).
	if _, err := h.pool.Exec(ctx, `ALTER DATABASE current_database() SET lock_timeout = '40ms'`); err != nil {
		// Fallback if ALTER DATABASE not permitted: set on active idle connections.
		_, _ = h.pool.Exec(ctx, `SET lock_timeout = '40ms'`)
	}

	jRetry := jar{}
	h.csrfJar(jRetry)
	resp503 := h.doAs(jRetry, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok2+`","new_password":"retryexhausted12"}`, true, "203.0.113.95")
	raw503 := requireAcceptanceProblem(t, h, resp503, http.StatusServiceUnavailable, "dependency_unavailable")
	if resp503.Header.Get("Retry-After") != "1" || !strings.Contains(raw503, `"retry_after":1`) {
		t.Fatalf("503 dependency_unavailable must include Retry-After: 1 header and retry_after: 1 body, got header=%q body=%s", resp503.Header.Get("Retry-After"), raw503)
	}

	// Release the external lock and reset lock_timeout: token was not consumed on rollback, so retry now succeeds with 204!
	_ = lockTx.Rollback(ctx)
	_, _ = h.pool.Exec(ctx, `ALTER DATABASE current_database() SET lock_timeout = '0'`)
	resp204 := h.doAs(jRetry, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok2+`","new_password":"retryexhausted12"}`, true, "203.0.113.96")
	if resp204.StatusCode != http.StatusNoContent {
		t.Fatalf("retry after lock release = %d %s, want 204", resp204.StatusCode, h.body(resp204))
	}
	_ = resp204.Body.Close()
}

// 11. Migration 0007 up/down on a DB with P03 (vault) and P04 (content) data + AuthPruneWorker deletes expired reset tokens.
func TestMigration0007UpDownWithP03AndP04DataAndPrune(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)

	// Migrate to 0006 first and seed P02, P03, and P04 data.
	migrateToTarget(t, dsn, 6)
	pool := dbtest.Pool(t, dsn)
	q := gen.New(pool)

	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "mig0007@example.com", Locale: "vi"})
	if err != nil {
		t.Fatalf("InsertUser at v6: %v", err)
	}
	kdfJSON := []byte(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"AAAAAAAAAAAAAAAAAAAAAA"}`)
	if _, err := q.InsertVault(ctx, gen.InsertVaultParams{
		UserID:               u.ID,
		Kdf:                  kdfJSON,
		VaultKeyID:           "vk:MMMMMMMMMMMMMMMMMMMMMM",
		VaultKeyWrappedByKek: make([]byte, 73),
		X25519Public:         make([]byte, 32),
		Ed25519Public:        make([]byte, 32),
		PrivateKeysWrapped:   make([]byte, 105),
	}); err != nil {
		t.Fatalf("InsertVault at v6: %v", err)
	}
	it, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u.ID,
		Name:           "Test Item",
		NameNormalized: "test item",
	})
	if err != nil {
		t.Fatalf("InsertItem at v6: %v", err)
	}

	// Migrate up to 0007.
	dbtest.MigrateUp(t, dsn)
	v, dirty, err := db.Version(dsn)
	if err != nil || dirty || v != 7 {
		t.Fatalf("after MigrateUp to 0007: v=%d dirty=%v err=%v", v, dirty, err)
	}

	// Verify CHECK constraints on password_reset_token (32-byte hashes required).
	if _, err := pool.Exec(ctx,
		`INSERT INTO password_reset_token (user_id, target_email, token_hash, password_hash_sha256, expires_at) VALUES ($1, $2, $3, $4, now())`,
		u.ID, u.Email, []byte("short"), bytes.Repeat([]byte{1}, 32)); err == nil {
		t.Fatal("expected CHECK violation on short token_hash")
	}

	// Verify AuthPruneWorker prunes expired password_reset_token rows (< now - 24h) and keeps recent ones.
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(now)
	oldExp := now.Add(-25 * time.Hour)
	recentExp := now.Add(-23 * time.Hour)
	for i, exp := range []time.Time{oldExp, recentExp} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO password_reset_token (user_id, target_email, token_hash, password_hash_sha256, was_email_unverified, expires_at) VALUES ($1, $2, $3, $4, true, $5)`,
			u.ID, u.Email, bytes.Repeat([]byte{byte(i + 10)}, 32), bytes.Repeat([]byte{byte(i + 20)}, 32), exp); err != nil {
			t.Fatalf("insert reset token %d: %v", i, err)
		}
	}
	pruner := worker.NewAuthPruneWorker(pool, clk)
	if err := pruner.Work(ctx, &river.Job[worker.AuthPruneArgs]{Args: worker.AuthPruneArgs{RetentionDays: 90}}); err != nil {
		t.Fatalf("AuthPruneWorker: %v", err)
	}
	var remainingTokens int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM password_reset_token`).Scan(&remainingTokens); err != nil {
		t.Fatal(err)
	}
	if remainingTokens != 1 {
		t.Fatalf("expected 1 remaining reset token after prune, got %d", remainingTokens)
	}

	// Step down 7 -> 6 and verify P03 vault and P04 item survive intact.
	migrateToTarget(t, dsn, 6)
	vDown, dirtyDown, err := db.Version(dsn)
	if err != nil || dirtyDown || vDown != 6 {
		t.Fatalf("after step down 7->6: v=%d dirty=%v err=%v", vDown, dirtyDown, err)
	}
	var tableCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = 'password_reset_token'`).Scan(&tableCount); err != nil {
		t.Fatal(err)
	}
	if tableCount != 0 {
		t.Fatalf("0007 down must drop password_reset_token, got %d", tableCount)
	}
	if _, err := q.GetVaultByUser(ctx, u.ID); err != nil {
		t.Fatalf("P03 vault must survive 0007 down: %v", err)
	}
	if _, err := q.GetLiveItemByUserAndID(ctx, gen.GetLiveItemByUserAndIDParams{UserID: u.ID, ID: it.ID}); err != nil {
		t.Fatalf("P04 item must survive 0007 down: %v", err)
	}

	// Re-apply 0007 up cleanly.
	dbtest.MigrateUp(t, dsn)
}

func migrateToTarget(t *testing.T, dsn string, target uint) {
	t.Helper()
	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = m.Close()
	}()
	if err := m.Migrate(target); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("Migrate(%d): %v", target, err)
	}
}

func loadTestConfig(t *testing.T) *config.Config {
	t.Helper()
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return cfg
}

func newServiceWithConfig(t *testing.T, cfg *config.Config, pool *pgxpool.Pool, clk clock.Clock, mail auth.Mailer) *auth.Service {
	t.Helper()
	svc, _, _, err := compose.NewAuth(cfg, pool, nil, clk, mail, nil)
	if err != nil {
		t.Fatalf("compose.NewAuth: %v", err)
	}
	t.Cleanup(svc.Close)
	return svc
}

func serverForService(t *testing.T, cfg *config.Config, svc *auth.Service, oa *oauth.Service, captcha auth.Captcha) *httptest.Server {
	t.Helper()
	authn, csrfv, reauth := compose.Adapters(svc)
	api := authhttp.NewAPI(svc, oa, captcha, cfg.TrustedProxyContains)
	deps := httpx.Deps{
		Config:        cfg,
		Logger:        slog.New(slog.NewJSONHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError})),
		Ready:         func(context.Context) error { return nil },
		Metrics:       promhttp.Handler(),
		Authenticator: authn,
		CSRF:          csrfv,
		Reauth:        reauth,
		MountAPI: func(v1 chi.Router, d httpx.Deps) {
			authhttp.Mount(api)(v1, d)
		},
	}
	return httptest.NewServer(httpx.NewRouter(deps))
}

type spyCaptchaVerifier struct {
	onVerify func()
}

func (s spyCaptchaVerifier) Enabled() bool { return true }

func (s spyCaptchaVerifier) Verify(_ context.Context, _, _, _, _ string) error {
	if s.onVerify != nil {
		s.onVerify()
	}
	return nil
}

var _ pgx.Tx
