package authhttp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/riverqueue/river"

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

type clockFixedWindow struct {
	mu      sync.Mutex
	windows map[string]struct {
		count int
		start time.Time
	}
	limit  int
	window time.Duration
	now    func() time.Time
}

func newClockFixedWindow(limit int, d time.Duration, now func() time.Time) *clockFixedWindow {
	return &clockFixedWindow{
		windows: make(map[string]struct {
			count int
			start time.Time
		}),
		limit:  limit,
		window: d,
		now:    now,
	}
}

func (f *clockFixedWindow) Allow(key string) (bool, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	w, exists := f.windows[key]
	if !exists || now.Sub(w.start) >= f.window {
		f.windows[key] = struct {
			count int
			start time.Time
		}{count: 1, start: now}
		return true, 0
	}
	if w.count >= f.limit {
		left := int(f.window.Seconds() - now.Sub(w.start).Seconds())
		if left < 1 {
			left = 1
		}
		return false, left
	}
	w.count++
	f.windows[key] = w
	return true, 0
}

func snapshotResetMailLinks(t *testing.T, h *harness, recipient string) map[string]struct{} {
	t.Helper()
	entries, err := h.mail.EntriesFor(recipient, auth.PurposePasswordReset)
	if err != nil {
		t.Fatalf("EntriesFor(%s): %v", recipient, err)
	}
	seen := make(map[string]struct{}, len(entries))
	for _, e := range entries {
		seen[e.Link] = struct{}{}
	}
	return seen
}

func extractNewResetTokenFromSink(t *testing.T, h *harness, recipient string, before map[string]struct{}) (token string, link string) {
	t.Helper()
	entries, err := h.mail.EntriesFor(recipient, auth.PurposePasswordReset)
	if err != nil || len(entries) == 0 {
		t.Fatalf("reset mail for %s = %d, err=%v", recipient, len(entries), err)
	}
	var added []auth.SinkEntry
	for _, e := range entries {
		if _, ok := before[e.Link]; !ok {
			added = append(added, e)
		}
	}
	if len(added) != 1 {
		t.Fatalf("expected exactly 1 new reset mail for %s (before=%d total=%d), got %d", recipient, len(before), len(entries), len(added))
	}
	return parseResetTokenLink(t, added[0].Link), added[0].Link
}

func extractResetTokenFromSink(t *testing.T, h *harness, recipient string) (token string, link string) {
	t.Helper()
	return extractNewResetTokenFromSink(t, h, recipient, nil)
}

func parseResetTokenLink(t *testing.T, link string) string {
	t.Helper()
	u, err := url.Parse(link)
	if err != nil {
		t.Fatalf("parse reset link %q: %v", link, err)
	}
	vals, err := url.ParseQuery(u.Fragment)
	if err != nil || vals.Get("token") == "" {
		t.Fatalf("reset link fragment missing token: %q", link)
	}
	return vals.Get("token")
}

func issueResetTokenForTest(t *testing.T, h *harness, email string) string {
	t.Helper()
	before := snapshotResetMailLinks(t, h, email)
	if err := h.svc.ProcessForgotJob(context.Background(), auth.ForgotJob{Email: email, Locale: "en"}); err != nil {
		t.Fatalf("ProcessForgotJob(%s): %v", email, err)
	}
	tok, _ := extractNewResetTokenFromSink(t, h, email, before)
	return tok
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

type asyncHTTPResult struct {
	status int
	body   string
	err    error
}

func doAsContextNoFatal(ctx context.Context, srvURL, origin string, j jar, method, path, body string, withCSRF bool, xff string) asyncHTTPResult {
	client := &http.Client{Timeout: 5 * time.Second}
	if withCSRF && j[authhttp.CookieCSRF] == nil {
		csrfReq, err := http.NewRequestWithContext(ctx, http.MethodGet, srvURL+"/api/v1/auth/csrf", nil)
		if err != nil {
			return asyncHTTPResult{err: fmt.Errorf("build csrf request: %w", err)}
		}
		j.apply(csrfReq)
		csrfResp, err := client.Do(csrfReq)
		if err != nil {
			return asyncHTTPResult{err: fmt.Errorf("do csrf request: %w", err)}
		}
		csrfBody, _ := io.ReadAll(csrfResp.Body)
		_ = csrfResp.Body.Close()
		j.capture(csrfResp)
		if csrfResp.StatusCode != http.StatusNoContent {
			return asyncHTTPResult{
				status: csrfResp.StatusCode,
				body:   string(csrfBody),
				err:    fmt.Errorf("csrf status %d: %s", csrfResp.StatusCode, csrfBody),
			}
		}
	}
	var rdr io.Reader
	if body != "" {
		rdr = bytes.NewBufferString(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, srvURL+path, rdr)
	if err != nil {
		return asyncHTTPResult{err: fmt.Errorf("build request: %w", err)}
	}
	if method != http.MethodGet && method != http.MethodHead {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
	}
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	j.apply(req)
	if withCSRF {
		if c := j[authhttp.CookieCSRF]; c != nil {
			req.Header.Set(authhttp.HeaderCSRF, c.Value)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return asyncHTTPResult{err: err}
	}
	rawBytes, readErr := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	j.capture(resp)
	return asyncHTTPResult{status: resp.StatusCode, body: string(rawBytes), err: readErr}
}

func startAsyncRequestWithURL(t *testing.T, srvURL, origin string, j jar, method, path, body string, withCSRF bool, xff string, reqTimeout time.Duration, releaseBarrier func()) (func() asyncHTTPResult, func()) {
	t.Helper()
	reqCtx, cancelReq := context.WithTimeout(context.Background(), reqTimeout)
	doneCh := make(chan asyncHTTPResult, 1)
	var joinOnce sync.Once
	var finalRes asyncHTTPResult

	joinBounded := func(wait time.Duration) asyncHTTPResult {
		joinOnce.Do(func() {
			select {
			case finalRes = <-doneCh:
			case <-time.After(wait):
				if releaseBarrier != nil {
					releaseBarrier()
				}
				cancelReq()
				select {
				case finalRes = <-doneCh:
				case <-time.After(2 * time.Second):
					finalRes = asyncHTTPResult{err: fmt.Errorf("timed out joining async %s %s after cancellation", method, path)}
				}
			}
		})
		return finalRes
	}
	abortAndJoin := func() {
		if releaseBarrier != nil {
			releaseBarrier()
		}
		cancelReq()
		_ = joinBounded(2 * time.Second)
	}
	t.Cleanup(abortAndJoin)

	jCopy := cloneAcceptanceJar(j)
	go func() {
		var res asyncHTTPResult
		defer func() {
			cancelReq()
			doneCh <- res
		}()
		res = doAsContextNoFatal(reqCtx, srvURL, origin, jCopy, method, path, body, withCSRF, xff)
	}()

	return func() asyncHTTPResult {
		return joinBounded(reqTimeout)
	}, abortAndJoin
}

func startAsyncRequest(t *testing.T, h *harness, j jar, method, path, body string, withCSRF bool, xff string, releaseBarrier func()) (func() asyncHTTPResult, func()) {
	t.Helper()
	return startAsyncRequestWithURL(t, h.srv.URL, h.origin, j, method, path, body, withCSRF, xff, 5*time.Second, releaseBarrier)
}

func requireAsyncProblem(t *testing.T, res asyncHTTPResult, status int, code string) string {
	t.Helper()
	if res.err != nil {
		t.Fatalf("async request failed (want %s/%d): %v", code, status, res.err)
	}
	if res.status != status {
		t.Fatalf("want %s/%d, got %d %s", code, status, res.status, res.body)
	}
	var p struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal([]byte(res.body), &p); err != nil {
		t.Fatalf("problem JSON: %v (%s)", err, res.body)
	}
	if p.Code != code {
		t.Fatalf("problem code = %q, want %q (%s)", p.Code, code, res.body)
	}
	return res.body
}

func oauthCallbackURLAs(t *testing.T, h *harness, startPath, xff string) string {
	t.Helper()
	client := noRedirect()
	req, err := http.NewRequest(http.MethodGet, h.srv.URL+startPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	h.jar.apply(req)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.capture(resp)
	loc := resp.Header.Get("Location")
	raw := h.body(resp)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusFound || loc == "" {
		t.Fatalf("oauth start = %d %s", resp.StatusCode, raw)
	}
	req2, err := http.NewRequest(http.MethodGet, loc, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp2, err := client.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	cb := resp2.Header.Get("Location")
	_ = resp2.Body.Close()
	if cb == "" {
		t.Fatal("fake authorize did not redirect to callback")
	}
	return cb
}

func followOAuthAs(t *testing.T, h *harness, startPath, xff string) string {
	t.Helper()
	cb := oauthCallbackURLAs(t, h, startPath, xff)
	client := noRedirect()
	req, err := http.NewRequest(http.MethodGet, cb, nil)
	if err != nil {
		t.Fatal(err)
	}
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	h.jar.apply(req)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.capture(resp)
	loc := resp.Header.Get("Location")
	raw := h.body(resp)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("callback = %d %s", resp.StatusCode, raw)
	}
	return loc
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
	_ = resp.Body.Close()
	if captchaCalled.Load() {
		t.Fatal("503 mail_delivery_unavailable must return before CAPTCHA verification")
	}
	// Invalid email syntax still returns 400 invalid_request before 503.
	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/forgot", `{"email":"not-an-email"}`, true, "203.0.113.10")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "invalid_request")
	_ = resp.Body.Close()
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
	var unblockOnce sync.Once
	unblock := func() { unblockOnce.Do(func() { close(blockWorker) }) }
	startedFirst := make(chan struct{}, 1)
	doneCh := make(chan auth.ForgotJob, auth.ForgotQueueSize+16)
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
			select {
			case doneCh <- job:
			default:
			}
		},
	})
	t.Cleanup(func() {
		unblock()
		h.svc.SetForgotHooks(auth.ForgotHooks{})
	})

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
		_ = resp.Body.Close()
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

	// Test queue overflow while worker is blocked: fill queue to capacity (1 in flight + 2 in queue + 126 overflow = 128 queued)
	// and assert HTTP still returns 202 with Cache-Control: no-store while dropping the overflow job.
	<-startedFirst
	for range auth.ForgotQueueSize + 5 {
		h.svc.EnqueueForgotPassword("overflow@example.com", "en")
	}
	jOverflow := jar{}
	h.csrfJar(jOverflow)
	resp := h.doAs(jOverflow, http.MethodPost, "/api/v1/auth/password/forgot", `{"email":"overflow-http@example.com"}`, true, "198.51.100.99")
	rawOverflow := h.body(resp)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted || rawOverflow != "" {
		t.Fatalf("overflow forgot status = %d, want 202 empty", resp.StatusCode)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("overflow Cache-Control = %q, want no-store", got)
	}

	// Unblock worker and drain all 1 + ForgotQueueSize (129) queued jobs so none remain in flight.
	unblock()
	const totalAcceptedJobs = 1 + auth.ForgotQueueSize
	for i := range totalAcceptedJobs {
		select {
		case <-doneCh:
		case <-time.After(10 * time.Second):
			t.Fatalf("timed out draining forgot jobs (%d/%d)", i, totalAcceptedJobs)
		}
	}
	h.svc.SetForgotHooks(auth.ForgotHooks{})

	// Verify password user got a password_reset email with locale=vi and 43-char token.
	tok, link := extractResetTokenFromSink(t, h, "pw-user@example.com")
	if len(tok) != 43 || !strings.Contains(link, "locale=vi") {
		t.Fatalf("password user reset token=%q link=%q", tok, link)
	}
	// Verify stored token_hash equals SHA-256(decoded raw token) and raw token is never stored.
	rawTok, err := auth.ParseResetToken(tok)
	if err != nil {
		t.Fatalf("ParseResetToken(%q): %v", tok, err)
	}
	var dbTokenHash []byte
	if err := h.pool.QueryRow(context.Background(), `SELECT token_hash FROM password_reset_token LIMIT 1`).Scan(&dbTokenHash); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(dbTokenHash, auth.SHA256Bytes(rawTok)) {
		t.Fatalf("stored token_hash %x != SHA256(raw) %x", dbTokenHash, auth.SHA256Bytes(rawTok))
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

	// Verify unknown user and dropped overflow request got no mail and no DB rows.
	unkMails, _ := h.mail.EntriesFor("unknown-user@example.com", auth.PurposePasswordReset)
	overflowMails, _ := h.mail.EntriesFor("overflow-http@example.com", auth.PurposePasswordReset)
	if len(unkMails) != 0 || len(overflowMails) != 0 {
		t.Fatalf("unknown/overflow emails must receive 0 mails, got unknown=%d overflow=%d", len(unkMails), len(overflowMails))
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
		_ = resp.Body.Close()
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
		_ = resp.Body.Close()
	}

	// Weak password (< 12 runes or > 1024 UTF-8 bytes) with valid 43-char token -> 400 password_weak.
	resp := h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","new_password":"short"}`, true, "198.51.100.60")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "password_weak")
	_ = resp.Body.Close()
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
		_ = r.Body.Close()
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
		_ = resp.Body.Close()
		if !strings.Contains(raw, `"revoked"`) {
			t.Fatalf("Alice session %d expected reason=revoked, got %s", idx+1, raw)
		}
	}

	// Single-use: replaying the same token returns 400 reset_token_invalid.
	h.csrfJar(jarB1)
	resp = h.doAs(jarB1, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok+`","new_password":"anotherpassword12"}`, true, "203.0.113.6")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")
	_ = resp.Body.Close()
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
	if !strings.Contains(notices[0].Link, "Mật khẩu đăng nhập engram của bạn vừa được đặt lại") || strings.Contains(notices[0].Link, "Subject") || strings.Contains(notices[0].Link, "unlinked") {
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

	h.api.SetMailLimiters(
		newClockFixedWindow(1, time.Minute, h.clk.Now),
		newClockFixedWindow(3, time.Hour, h.clk.Now),
	)
	requestResetToken := func(email, xff string) string {
		t.Helper()
		before := snapshotResetMailLinks(t, h, email)
		done := make(chan struct{}, 1)
		h.svc.SetForgotHooks(auth.ForgotHooks{
			OnJobDone: func(_ auth.ForgotJob, _ error) {
				select {
				case done <- struct{}{}:
				default:
				}
			},
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
		tok, _ := extractNewResetTokenFromSink(t, h, email, before)
		return tok
	}

	// (a) Issuing a second token expires the first token; advancing clock past 30m expires the second.
	tok1 := requestResetToken("inv-a@example.com", "198.51.100.1")
	h.clk.Advance(2 * time.Minute)
	tok2 := requestResetToken("inv-a@example.com", "198.51.100.11")
	if tok1 == tok2 {
		t.Fatal("expected distinct tokens")
	}

	j := jar{}
	h.csrfJar(j)
	resp := h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok1+`","new_password":"newpassword123"}`, true, "198.51.100.2")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")
	_ = resp.Body.Close()

	// Advance clock > 30 minutes: tok2 expires (and anonymous CSRF TTL 10m also elapses, so bootstrap fresh CSRF).
	h.clk.Advance(auth.PasswordResetTTL + time.Second)
	j = jar{}
	h.csrfJar(j)
	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok2+`","new_password":"newpassword123"}`, true, "198.51.100.3")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")
	_ = resp.Body.Close()
	// Refresh session after clock advance.
	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/refresh", "", true, "198.51.100.21")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("refresh = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	h.csrf()
	// (a2) AU3-BE1-2: Token expiry boundary while waiting on token lock after user lock + RevokeAllUserSessions.
	// Issue tokWait, advance clock to 1s before expiry, hold FOR UPDATE on password_reset_token in an external tx,
	// let ResetPassword acquire app_user FOR UPDATE and execute RevokeAllUserSessions, advance clock past expiry while
	// ResetPassword blocks on GetPasswordResetTokenByHashForUpdate, then release the token lock.
	// ResetPassword must re-read the clock after acquiring the token lock, return 400 reset_token_invalid,
	// leave password unchanged, and roll back the early RevokeAllUserSessions so the live session remains usable!
	tokWait := issueResetTokenForTest(t, h, "inv-a@example.com")
	rawWait, err := auth.ParseResetToken(tokWait)
	if err != nil {
		t.Fatal(err)
	}
	hashWait := auth.SHA256Bytes(rawWait)
	h.clk.Advance(auth.PasswordResetTTL - time.Second)

	holdTokTx, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holdTokTx.Rollback(ctx) }()
	var holdTokPID int32
	if err := holdTokTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&holdTokPID); err != nil {
		t.Fatalf("holdTokTx pid: %v", err)
	}
	if _, err := holdTokTx.Exec(ctx, `SELECT id FROM password_reset_token WHERE token_hash = $1 FOR UPDATE`, hashWait); err != nil {
		t.Fatal(err)
	}

	var resetTxPID atomic.Int32
	h.svc.SetOnResetAttempt(func(txCtx context.Context, tx pgx.Tx, _ int) error {
		var pid int32
		if err := tx.QueryRow(txCtx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			return err
		}
		resetTxPID.Store(pid)
		return nil
	})
	resetLockedExpiry := make(chan struct{})
	var onceExpiry sync.Once
	h.svc.SetOnResetLocked(func() {
		onceExpiry.Do(func() { close(resetLockedExpiry) })
	})
	t.Cleanup(func() {
		h.svc.SetOnResetAttempt(nil)
		h.svc.SetOnResetLocked(nil)
		_ = holdTokTx.Rollback(ctx)
	})
	joinResetWait, _ := startAsyncRequest(t, h, jar{}, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tokWait+`","new_password":"expiredwhilewaiting12"}`, true, "198.51.100.31", func() {
		_ = holdTokTx.Rollback(ctx)
	})

	<-resetLockedExpiry
	waiterPID := resetTxPID.Load()
	if waiterPID == 0 {
		t.Fatal("expected reset transaction backend PID to be recorded before OnResetLocked")
	}
	// Positively observe the specific reset backend waiting on the token lock held by holdTokTx
	// BEFORE advancing the fake clock (AU3-BE2-2). Because RevokeAllUserSessions (and in pre-fix code,
	// the stale clock sample) executes before GetPasswordResetTokenByHashForUpdate, observing
	// waiterPID blocked on holdTokPID proves the pre-lock statements already ran while the clock was still valid.
	var observedWaitOnTok bool
	tokWaitDeadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(tokWaitDeadline) {
		var blocked int
		qErr := h.pool.QueryRow(ctx,
			`SELECT count(*) FROM pg_locks w WHERE w.pid = $1 AND NOT w.granted AND $2 = ANY(pg_blocking_pids(w.pid))`,
			waiterPID, holdTokPID,
		).Scan(&blocked)
		if qErr != nil {
			t.Fatalf("query pg_locks for token lock wait: %v", qErr)
		}
		if blocked > 0 {
			observedWaitOnTok = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !observedWaitOnTok {
		t.Fatalf("reset backend pid=%d was not observed waiting on token lock holder pid=%d before deadline", waiterPID, holdTokPID)
	}

	// Advance clock past token expiry while ResetPassword is confirmed blocked on GetPasswordResetTokenByHashForUpdate,
	// then release the external token lock.
	h.clk.Advance(2 * time.Second)
	if err := holdTokTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	respWait := joinResetWait()
	h.svc.SetOnResetAttempt(nil)
	h.svc.SetOnResetLocked(nil)
	requireAsyncProblem(t, respWait, http.StatusBadRequest, "reset_token_invalid")
	// Verify the early RevokeAllUserSessions was rolled back: refresh and /auth/me still succeed, and old password still works.
	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/refresh", "", true, "198.51.100.22")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("session must survive rolled-back expired reset: refresh = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	h.csrf()
	resp = h.doAs(h.jar, http.MethodGet, "/api/v1/auth/me", "", false, "198.51.100.22")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("session must remain usable after rolled-back expired reset: me = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	// (b) Invalidation on ChangePassword.
	tokBeforePwChange := issueResetTokenForTest(t, h, "inv-a@example.com")
	grant := h.grantAs("198.51.100.23", "account.password_change", "correcthorse")
	resp = h.withGrantAs("198.51.100.23", http.MethodPost, "/api/v1/me/password", `{"new_password":"changedpassword12"}`, grant)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("password change = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	h.csrf()

	j = jar{}
	h.csrfJar(j)
	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tokBeforePwChange+`","new_password":"otherpassword12"}`, true, "198.51.100.4")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")
	_ = resp.Body.Close()
	// (c) Email change A -> B -> A must NOT revive token issued at A (AU2-BE1-7).
	tokAtEmailA := issueResetTokenForTest(t, h, "inv-a@example.com")

	// Change email A -> B.
	grantEmail1 := h.grantAs("198.51.100.24", "account.email_change", "changedpassword12")
	resp = h.withGrantAs("198.51.100.24", http.MethodPost, "/api/v1/me/email", `{"new_email":"inv-b@example.com"}`, grantEmail1)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("email change to B = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	confirmTokB := acceptanceToken(t, h, "inv-b@example.com", "email_change")
	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+confirmTokB+`"}`, true, "198.51.100.25")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("confirm email B = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	h.csrf()

	// Change email B -> A (via service to avoid 1/min HTTP mail limiter on same user).
	principalNow, err := h.svc.Sessions().Authenticate(ctx, h.jar[authhttp.CookieSession].Value)
	if err != nil {
		t.Fatal(err)
	}
	grantEmail2 := h.grantAs("198.51.100.26", "account.email_change", "changedpassword12")
	if err := h.svc.RequestEmailChange(ctx, principalNow, "inv-a@example.com", grantEmail2); err != nil {
		t.Fatalf("RequestEmailChange back to A: %v", err)
	}
	confirmTokA := acceptanceToken(t, h, "inv-a@example.com", "email_change")
	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+confirmTokA+`"}`, true, "198.51.100.27")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("confirm email A = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	h.csrf()

	// Now email is inv-a@example.com again and password is still changedpassword12,
	// but tokAtEmailA MUST be rejected because ConfirmEmailToken expired pending reset tokens!
	j = jar{}
	h.csrfJar(j)
	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tokAtEmailA+`","new_password":"revivedpassword12"}`, true, "198.51.100.5")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")
	_ = resp.Body.Close()
	// (d) Unlink password identity expires pending reset tokens.
	tokBeforeUnlink := issueResetTokenForTest(t, h, "inv-a@example.com")
	grantLink := h.grantAs("198.51.100.28", "account.identity_link", "changedpassword12")
	resp = h.withGrantAs("198.51.100.28", http.MethodPost, "/api/v1/auth/oauth/google/link", "", grantLink)
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
	grantUnlink := h.grantAs("198.51.100.29", "account.identity_unlink", "changedpassword12")
	resp = h.withGrantAs("198.51.100.29", http.MethodDelete, "/api/v1/auth/identities/password", "", grantUnlink)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("unlink password = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	h.csrf()

	j = jar{}
	h.csrfJar(j)
	resp = h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tokBeforeUnlink+`","new_password":"afterunlinkpassword12"}`, true, "198.51.100.6")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "reset_token_invalid")
	_ = resp.Body.Close()
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
	_ = resp.Body.Close()
	if resp.Header.Get("Retry-After") == "" || !strings.Contains(raw, `"retry_after"`) {
		t.Fatalf("missing Retry-After on email rate limit: %s", raw)
	}
	// Email 3/hour rate limit at HTTP handler level (AU3-BE1-10):
	// Inject clock-backed minute (1/min) and hourly (3/hour) limiters into h.api,
	// advance the injected clock past the 1-minute window (but within 1 hour) for both known and unknown normalized emails.
	// The 1st, 2nd, and 3rd hourly requests succeed (202), and the 4th within the hour returns 429 rate_limited with Retry-After.
	h.api.SetMailLimiters(
		newClockFixedWindow(1, time.Minute, h.clk.Now),
		newClockFixedWindow(3, time.Hour, h.clk.Now),
	)
	signupAcceptance(t, h, "hourly-known@example.com")
	for _, target := range []string{"hourly-known@example.com", "hourly-unknown@example.com"} {
		for attempt := 1; attempt <= 3; attempt++ {
			h.clk.Advance(61 * time.Second)
			reqEmail := target
			if attempt == 2 {
				reqEmail = strings.ToUpper(target)
			}
			r := h.doAs(j, http.MethodPost, "/api/v1/auth/password/forgot", fmt.Sprintf(`{"email":%q}`, reqEmail), true, fmt.Sprintf("198.51.100.%d", 120+attempt))
			if r.StatusCode != http.StatusAccepted {
				t.Fatalf("hourly %s attempt %d = %d %s, want 202", target, attempt, r.StatusCode, h.body(r))
			}
			_ = r.Body.Close()
		}
		// Advance 61s again (still well within 1 hour): 4th attempt for the same normalized email must hit 429!
		h.clk.Advance(61 * time.Second)
		r4 := h.doAs(j, http.MethodPost, "/api/v1/auth/password/forgot", fmt.Sprintf(`{"email":%q}`, strings.ToUpper(target)), true, "198.51.100.129")
		raw4 := requireAcceptanceProblem(t, h, r4, http.StatusTooManyRequests, "rate_limited")
		_ = r4.Body.Close()
		if r4.Header.Get("Retry-After") == "" || !strings.Contains(raw4, `"retry_after"`) {
			t.Fatalf("hourly 4th attempt for %s missing Retry-After: %s", target, raw4)
		}
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
	_ = resp.Body.Close()
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
	_ = resp.Body.Close()
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
	_ = resp.Body.Close()
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

// 7. Concurrent issuance serialization under app_user FOR UPDATE (AU2-BE1-6, AU3-BE1-9, AU3-BE2-3).
func TestPasswordForgotConcurrentIssuanceLeavesOneLiveToken(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	signupAcceptance(t, h, "concurrent-issue@example.com")
	var userID uuid.UUID
	if err := h.pool.QueryRow(ctx, `SELECT id FROM app_user WHERE email = 'concurrent-issue@example.com'`).Scan(&userID); err != nil {
		t.Fatalf("select user id: %v", err)
	}

	// Deterministically overlap two ProcessForgotJob calls using OnJobLocked (AU3-BE2-3):
	// Issuer 1 (Locale="en") acquires app_user FOR UPDATE and pauses inside OnJobLocked.
	// Issuer 2 (Locale="vi") starts while Issuer 1 holds the root lock and blocks on GetUserByIDForUpdate.
	// We positively observe in pg_locks that a second backend is waiting on the exact backend PID
	// holding the granted RowShareLock/ExclusiveLock on app_user BEFORE releasing Issuer 1.
	// Because each issuer uses a distinct Locale ("en" vs "vi"), each delivered reset link is
	// independently associated with its issuer (locale=en for Issuer 1, locale=vi for Issuer 2).
	job1Locked := make(chan struct{})
	var job1LockedOnce sync.Once
	releaseJob1 := make(chan struct{})
	var releaseJob1Once sync.Once
	unblockJob1 := func() { releaseJob1Once.Do(func() { close(releaseJob1) }) }

	var inCriticalSection atomic.Int32
	var overlapDetected atomic.Bool
	var callSeq atomic.Int32

	h.svc.SetForgotHooks(auth.ForgotHooks{
		OnJobLocked: func(_ uuid.UUID) {
			seq := callSeq.Add(1)
			if inCriticalSection.Add(1) > 1 {
				overlapDetected.Store(true)
			}
			if seq == 1 {
				job1LockedOnce.Do(func() { close(job1Locked) })
				<-releaseJob1
			}
			inCriticalSection.Add(-1)
		},
	})
	t.Cleanup(func() {
		unblockJob1()
		h.svc.SetForgotHooks(auth.ForgotHooks{})
	})

	beforeMails := snapshotResetMailLinks(t, h, "concurrent-issue@example.com")

	errCh1 := make(chan error, 1)
	go func() {
		errCh1 <- h.svc.ProcessForgotJob(ctx, auth.ForgotJob{Email: "concurrent-issue@example.com", Locale: "en"})
	}()
	<-job1Locked

	errCh2 := make(chan error, 1)
	go func() {
		errCh2 <- h.svc.ProcessForgotJob(ctx, auth.ForgotJob{Email: "concurrent-issue@example.com", Locale: "vi"})
	}()

	// Positively observe in pg_locks that the second issuer is blocked on the first issuer's app_user lock,
	// or that overlapDetected fired if the root lock was removed. Fail if the deadline expires without observation!
	var observedBlockedOnRoot bool
	waitDeadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(waitDeadline) {
		if overlapDetected.Load() {
			break
		}
		var blocked int
		qErr := h.pool.QueryRow(ctx, `
			SELECT count(*)
			FROM pg_locks w
			JOIN pg_locks h ON h.pid = ANY(pg_blocking_pids(w.pid))
			WHERE NOT w.granted
			  AND h.granted
			  AND h.relation = 'app_user'::regclass
		`).Scan(&blocked)
		if qErr != nil {
			t.Fatalf("query pg_locks for concurrent issuance block: %v", qErr)
		}
		if blocked > 0 {
			observedBlockedOnRoot = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	unblockJob1()
	if err := <-errCh1; err != nil {
		t.Fatalf("issuer 1 ProcessForgotJob: %v", err)
	}
	if err := <-errCh2; err != nil {
		t.Fatalf("issuer 2 ProcessForgotJob: %v", err)
	}
	h.svc.SetForgotHooks(auth.ForgotHooks{})

	if overlapDetected.Load() {
		t.Fatal("concurrent ProcessForgotJob entered critical section simultaneously; app_user FOR UPDATE lock missing")
	}
	if !observedBlockedOnRoot {
		t.Fatalf("second issuer was never positively observed blocked on first issuer's app_user lock for user %s", userID)
	}
	if got := callSeq.Load(); got != 2 {
		t.Fatalf("expected exactly 2 OnJobLocked invocations, got %d", got)
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

	// Associate each delivered mail/token with its known issuer via its distinct locale parameter
	// (Issuer 1 = locale=en, controlled last Issuer 2 = locale=vi) rather than deriving from DB state.
	entries, err := h.mail.EntriesFor("concurrent-issue@example.com", auth.PurposePasswordReset)
	if err != nil || len(entries) != 2 {
		t.Fatalf("expected 2 reset mails, got %d err=%v (before=%d)", len(entries), err, len(beforeMails))
	}
	var job1Tok, job2Tok string
	for _, e := range entries {
		tok := parseResetTokenLink(t, e.Link)
		switch {
		case strings.Contains(e.Link, "locale=en"):
			job1Tok = tok
		case strings.Contains(e.Link, "locale=vi"):
			job2Tok = tok
		default:
			t.Fatalf("unexpected reset mail link without issuer locale marker: %q", e.Link)
		}
	}
	if job1Tok == "" || job2Tok == "" || job1Tok == job2Tok {
		t.Fatalf("failed to associate distinct tokens with Issuer 1 (en=%q) and Issuer 2 (vi=%q)", job1Tok, job2Tok)
	}

	// Verify in DB that Issuer 2's token is the unconsumed live row and Issuer 1's token was expired.
	rawJob2, err := auth.ParseResetToken(job2Tok)
	if err != nil {
		t.Fatal(err)
	}
	var liveHash []byte
	if err := h.pool.QueryRow(ctx, `SELECT token_hash FROM password_reset_token WHERE consumed_at IS NULL`).Scan(&liveHash); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(auth.SHA256Bytes(rawJob2), liveHash) {
		t.Fatalf("expected controlled last issuer (Job 2, locale=vi) token hash %x to match surviving DB token hash %x", auth.SHA256Bytes(rawJob2), liveHash)
	}

	j := jar{}
	h.csrfJar(j)
	respExp := h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+job1Tok+`","new_password":"winnerpassword12"}`, true, "198.51.100.140")
	requireAcceptanceProblem(t, h, respExp, http.StatusBadRequest, "reset_token_invalid")
	_ = respExp.Body.Close()

	respLive := h.doAs(j, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+job2Tok+`","new_password":"winnerpassword12"}`, true, "198.51.100.141")
	if respLive.StatusCode != http.StatusNoContent {
		t.Fatalf("surviving Job 2 token reset = %d %s, want 204", respLive.StatusCode, h.body(respLive))
	}
	_ = respLive.Body.Close()
}

// 8. D2 deterministic barrier race: old-password Login vs ResetPassword (AU2-BE1-3, AU3-BE1-6, AU3-BE2-5).
func TestLoginOldPasswordBarrierRaceAgainstResetPassword(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	signupAcceptance(t, h, "d2-race@example.com")

	tok := issueResetTokenForTest(t, h, "d2-race@example.com")

	loginVerified := make(chan struct{})
	var verifiedOnce sync.Once
	releaseLogin := make(chan struct{})
	var releaseOnce sync.Once
	unblockLogin := func() { releaseOnce.Do(func() { close(releaseLogin) }) }

	h.svc.SetOnLoginVerified(func() {
		verifiedOnce.Do(func() { close(loginVerified) })
		<-releaseLogin
	})
	t.Cleanup(func() {
		h.svc.SetOnLoginVerified(nil)
		unblockLogin()
	})
	joinLogin, _ := startAsyncRequest(t, h, jar{}, http.MethodPost, "/api/v1/auth/login", `{"email":"d2-race@example.com","password":"correcthorse"}`, true, "203.0.113.88", unblockLogin)

	// Wait until Login has verified the old password outside the transaction.
	select {
	case <-loginVerified:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Login to reach OnLoginVerified barrier")
	}

	// Now execute ResetPassword to completion.
	jReset := jar{}
	h.csrfJar(jReset)
	respReset := h.doAs(jReset, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok+`","new_password":"resetwinnerpassword12"}`, true, "203.0.113.89")
	if respReset.StatusCode != http.StatusNoContent {
		t.Fatalf("reset = %d %s", respReset.StatusCode, h.body(respReset))
	}
	_ = respReset.Body.Close()

	// Release Login to enter its session-issuance transaction.
	unblockLogin()
	respLogin := joinLogin()
	h.svc.SetOnLoginVerified(nil)
	requireAsyncProblem(t, respLogin, http.StatusUnauthorized, "invalid_credentials")

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
// deterministic barrier races on oauth.Service.Complete, pending link/reauth/receipt cancellation,
// independent owner recheck proof, and genuinely in-flight Callback held in Exchange while claimed (AU3-BE1-8).
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
	grantLink := h.grantAs("198.51.100.191", "account.identity_link", "correcthorse")
	resp := h.withGrantAs("198.51.100.191", http.MethodPost, "/api/v1/auth/oauth/google/link", "", grantLink)
	requireAcceptanceProblem(t, h, resp, http.StatusForbidden, "email_not_verified")
	_ = resp.Body.Close()
	// Temporarily mark verified to start link flow, then set email_verified_at = NULL before callback.
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE email = 'victim-d3@example.com'`); err != nil {
		t.Fatal(err)
	}
	resp = h.withGrantAs("198.51.100.192", http.MethodPost, "/api/v1/auth/oauth/google/link", "", grantLink)
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
	// plus pending link, pending reauth, and unconsumed oauth_reauth_receipt rows for the user,
	// issue a reset token while unverified (was_email_unverified = true), then verify the email
	// BEFORE consuming the reset token (AU2-BE2-3, AU3-BE1-8).
	var victimID, victimSessID uuid.UUID
	if err := h.pool.QueryRow(ctx, `SELECT id FROM app_user WHERE email = 'victim-d3@example.com'`).Scan(&victimID); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT id FROM session WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1`, victimID).Scan(&victimSessID); err != nil {
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
	tok := issueResetTokenForTest(t, h, "victim-d3@example.com")

	// Attacker starts an OAuth login flow and reaches login_ready BEFORE reset.
	jarAttacker := jar{}
	h.csrfJar(jarAttacker)
	oldJar := h.jar
	h.jar = jarAttacker
	if got := statusFromCallback(followOAuthAs(t, h, "/api/v1/auth/oauth/google/start", "198.51.100.193")); got != "login_ready" {
		t.Fatalf("attacker oauth callback = %s", got)
	}
	jarAttacker = cloneAcceptanceJar(h.jar)
	h.jar = oldJar

	// Attacker also verifies the account's email between reset token issuance and consumption (AU2-BE2-3),
	// and creates pending link, pending reauth, and unconsumed reauth receipt rows bound to victimID.
	if _, err := h.pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, victimID); err != nil {
		t.Fatal(err)
	}
	for idx, mode := range []string{"link", "reauth"} {
		if _, err := h.pool.Exec(ctx,
			`INSERT INTO oauth_transaction (provider, mode, status, state_hash, cookie_binding_hash, expected_user_id, expected_session_id, expires_at) VALUES ('google', $1, 'pending', $2, $3, $4, $5, now() + interval '10 minutes')`,
			mode, bytes.Repeat([]byte{byte(0x90 + idx)}, 32), bytes.Repeat([]byte{byte(0xA0 + idx)}, 32), victimID, victimSessID,
		); err != nil {
			t.Fatalf("insert pending %s tx: %v", mode, err)
		}
	}
	if _, err := h.pool.Exec(ctx,
		`INSERT INTO oauth_reauth_receipt (user_id, session_id, provider, action, token_hash, expires_at) VALUES ($1, $2, 'google', 'account.password_change', $3, now() + interval '5 minutes')`,
		victimID, victimSessID, bytes.Repeat([]byte{0xB1}, 32),
	); err != nil {
		t.Fatalf("insert reauth receipt: %v", err)
	}

	// Start genuinely in-flight OAuth login callbacks (same-email Google and different-email GitHub)
	// BEFORE reset, and hold them inside fakeProvider.Exchange while their oauth_transaction status is 'claimed' (AU3-BE1-8, AU3-BE2-5)!
	// startClaimedCallback registers idempotent cleanup and completion ownership BEFORE starting the request
	// and uses a bounded select for Exchange entry, early completion (if callback rejects before Exchange), or deadline.
	tryStartClaimedCallbackWithTimeout := func(provider string, fake *oauth.Fake, cbURL string, jFlow jar, xff string, waitTimeout time.Duration) (bool, string, <-chan string, func()) {
		t.Helper()
		exchEntered := make(chan struct{})
		var enterOnce sync.Once
		exchRelease := make(chan struct{})
		var relOnce sync.Once
		unblockExch := func() { relOnce.Do(func() { close(exchRelease) }) }

		fake.SetOnExchange(func(_ oauth.ExchangeRequest) {
			enterOnce.Do(func() { close(exchEntered) })
			<-exchRelease
		})

		reqCtx, cancelReq := context.WithTimeout(context.Background(), 5*time.Second)
		cbStatusCh := make(chan string, 1)
		outCh := make(chan string, 1)
		var joinOnce sync.Once
		var finalStatus string
		joinBounded := func(wait time.Duration) string {
			joinOnce.Do(func() {
				select {
				case finalStatus = <-cbStatusCh:
				case <-time.After(wait):
					unblockExch()
					cancelReq()
					select {
					case finalStatus = <-cbStatusCh:
					case <-time.After(2 * time.Second):
						finalStatus = "join_timeout"
					}
				}
				outCh <- finalStatus
				close(outCh)
			})
			return finalStatus
		}
		releaseAndJoin := func() {
			fake.SetOnExchange(nil)
			unblockExch()
			_ = joinBounded(2 * time.Second)
		}
		abortAndJoin := func() {
			fake.SetOnExchange(nil)
			unblockExch()
			cancelReq()
			_ = joinBounded(2 * time.Second)
		}
		// Register cleanup BEFORE launching the request goroutine so any early return or fatal
		// always clears the hook, cancels the request context, releases the Exchange barrier, and joins with a bound.
		t.Cleanup(abortAndJoin)

		jCopy := cloneAcceptanceJar(jFlow)
		go func() {
			var status string
			defer func() {
				cancelReq()
				cbStatusCh <- status
			}()
			client := noRedirect()
			req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, cbURL, nil)
			if err != nil {
				status = "request_build_error:" + err.Error()
				return
			}
			req.Header.Set("X-Forwarded-For", xff)
			jCopy.apply(req)
			resp, err := client.Do(req)
			if err != nil {
				status = "request_do_error:" + err.Error()
				return
			}
			loc := resp.Header.Get("Location")
			_ = resp.Body.Close()
			status = statusFromCallback(loc)
		}()

		select {
		case <-exchEntered:
			return true, "", outCh, releaseAndJoin
		case earlyStatus := <-cbStatusCh:
			// Record early completion so joinBounded is already satisfied without blocking.
			joinOnce.Do(func() {
				finalStatus = earlyStatus
				outCh <- earlyStatus
				close(outCh)
			})
			fake.SetOnExchange(nil)
			unblockExch()
			cancelReq()
			return false, earlyStatus, outCh, releaseAndJoin
		case <-time.After(waitTimeout):
			abortAndJoin()
			return false, "timeout", outCh, abortAndJoin
		}
	}

	tryStartClaimedCallback := func(provider string, fake *oauth.Fake, cbURL string, jFlow jar, xff string) (bool, string, <-chan string, func()) {
		t.Helper()
		return tryStartClaimedCallbackWithTimeout(provider, fake, cbURL, jFlow, xff, 5*time.Second)
	}

	startClaimedCallback := func(provider string, fake *oauth.Fake, xff string) (jar, <-chan string, func()) {
		t.Helper()
		jFlow := jar{}
		h.csrfJar(jFlow)
		saved := h.jar
		h.jar = jFlow
		cbURL := oauthCallbackURLAs(t, h, "/api/v1/auth/oauth/"+provider+"/start", xff)
		jFlow = cloneAcceptanceJar(h.jar)
		h.jar = saved

		entered, earlyStatus, outCh, releaseAndJoin := tryStartClaimedCallback(provider, fake, cbURL, jFlow, xff)
		if !entered {
			t.Fatalf("%s OAuth callback exited before reaching Exchange with status=%q", provider, earlyStatus)
		}
		return jFlow, outCh, releaseAndJoin
	}

	// AU3-BE2-5 & AU3-BE3-2: Exercise all three non-Exchange teardown paths:
	// (i) early HTTP rejection before Exchange (missing OAuth binding cookie -> "invalid_flow"),
	// (ii) callback stalled before Exchange (bounded wait timeout cancels request context and joins cleanly without hanging),
	// (iii) producer transport error on closed server (publishes error completion without calling t.Fatal inside goroutine).
	{
		jEarly := jar{}
		h.csrfJar(jEarly)
		saved := h.jar
		h.jar = jEarly
		earlyCbURL := oauthCallbackURLAs(t, h, "/api/v1/auth/oauth/google/start", "198.51.100.204")
		h.jar = saved
		// (i) Pass an empty jar (no binding cookie) so OAuth Callback rejects before calling fakeGoogle.Exchange!
		enteredEarly, earlyStatus, _, releaseEarly := tryStartClaimedCallback("google", fakeGoogle, earlyCbURL, jar{}, "198.51.100.204")
		releaseEarly()
		if enteredEarly || earlyStatus != "invalid_flow" {
			t.Fatalf("expected failure-before-Exchange callback to return entered=false status=invalid_flow immediately, got entered=%v status=%q", enteredEarly, earlyStatus)
		}

		// (ii) Stalled-before-Exchange server handler that blocks until request context is cancelled.
		stalledHandlerExited := make(chan struct{})
		stalledSrv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
			close(stalledHandlerExited)
		}))
		t.Cleanup(stalledSrv.Close)
		enteredStalled, stalledStatus, stalledOutCh, releaseStalled := tryStartClaimedCallbackWithTimeout("google", fakeGoogle, stalledSrv.URL, jar{}, "198.51.100.204", 50*time.Millisecond)
		releaseStalled()
		if enteredStalled || stalledStatus != "timeout" {
			t.Fatalf("expected stalled-before-Exchange callback to time out and abort cleanly, got entered=%v status=%q", enteredStalled, stalledStatus)
		}
		select {
		case <-stalledHandlerExited:
		case <-time.After(2 * time.Second):
			t.Fatal("stalled callback handler was not cancelled by tryStartClaimedCallback timeout teardown")
		}
		if gotOut := <-stalledOutCh; !strings.HasPrefix(gotOut, "request_do_error:") {
			t.Fatalf("expected cancelled stalled callback to publish request_do_error completion, got %q", gotOut)
		}

		// (iii) Transport error against a closed server on both tryStartClaimedCallback and startAsyncRequestWithURL.
		closedSrv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		closedSrv.Close()
		enteredConnErr, connErrStatus, _, releaseConnErr := tryStartClaimedCallbackWithTimeout("google", fakeGoogle, closedSrv.URL+"/cb", jar{}, "198.51.100.204", time.Second)
		releaseConnErr()
		if enteredConnErr || !strings.HasPrefix(connErrStatus, "request_do_error:") {
			t.Fatalf("expected transport-error callback to publish request_do_error without hanging, got entered=%v status=%q", enteredConnErr, connErrStatus)
		}
		joinClosedAsync, abortClosedAsync := startAsyncRequestWithURL(t, closedSrv.URL, h.origin, jar{}, http.MethodPost, "/api/v1/auth/login", `{"email":"x@example.com","password":"correcthorse"}`, true, "198.51.100.204", time.Second, nil)
		abortClosedAsync()
		if closedRes := joinClosedAsync(); closedRes.err == nil {
			t.Fatal("expected startAsyncRequestWithURL against closed server to publish non-nil transport error")
		}
	}

	jarInFlightSame, sameCbCh, releaseSameExch := startClaimedCallback("google", fakeGoogle, "198.51.100.205")
	jarInFlightDiff, diffCbCh, releaseDiffExch := startClaimedCallback("github", fakeGitHub, "198.51.100.206")

	// Verify both in-flight callbacks are genuinely in status = 'claimed' in DB before reset runs!
	var claimedCount int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM oauth_transaction WHERE mode = 'login' AND status = 'claimed' AND consumed_at IS NULL`).Scan(&claimedCount); err != nil {
		t.Fatal(err)
	}
	if claimedCount != 2 {
		t.Fatalf("expected 2 in-flight OAuth login transactions in status='claimed' across reset, got %d", claimedCount)
	}

	// Set deterministic barrier in oauth.Service.Complete right after non-locking owner discovery (E1 A).
	ownerDiscovered := make(chan struct{})
	var discOnce sync.Once
	releaseComplete := make(chan struct{})
	var relCompOnce sync.Once
	unblockComplete := func() { relCompOnce.Do(func() { close(releaseComplete) }) }
	h.oa.SetOnOwnerDiscovered(func() {
		discOnce.Do(func() { close(ownerDiscovered) })
		<-releaseComplete
	})
	t.Cleanup(func() {
		h.oa.SetOnOwnerDiscovered(nil)
		unblockComplete()
	})
	joinComplete, _ := startAsyncRequest(t, h, jarAttacker, http.MethodPost, "/api/v1/auth/oauth/complete", "", true, "198.51.100.200", unblockComplete)
	select {
	case <-ownerDiscovered:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for oauth.Service.Complete to reach OnOwnerDiscovered")
	}

	// Victim consumes reset token while Complete is paused after owner discovery and while the two callbacks are held in Exchange ('claimed').
	jVictim := jar{}
	h.csrfJar(jVictim)
	respReset := h.doAs(jVictim, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok+`","new_password":"victimrecovered12"}`, true, "198.51.100.201")
	if respReset.StatusCode != http.StatusNoContent {
		t.Fatalf("victim reset = %d %s", respReset.StatusCode, h.body(respReset))
	}
	_ = respReset.Body.Close()

	// Release Complete -> must fail with 400 oauth_state_invalid and issue 0 sessions!
	unblockComplete()
	respComplete := joinComplete()
	h.oa.SetOnOwnerDiscovered(nil)
	requireAsyncProblem(t, respComplete, http.StatusBadRequest, "oauth_state_invalid")
	// Assert pending link/reauth flows and unconsumed reauth receipts for victim were all cancelled by reset!
	var uncancelledUserOAuth, uncancelledReceipts int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM oauth_transaction WHERE expected_user_id = $1 AND consumed_at IS NULL`, victimID).Scan(&uncancelledUserOAuth); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM oauth_reauth_receipt WHERE user_id = $1 AND consumed_at IS NULL`, victimID).Scan(&uncancelledReceipts); err != nil {
		t.Fatal(err)
	}
	if uncancelledUserOAuth != 0 || uncancelledReceipts != 0 {
		t.Fatalf("expected 0 unconsumed user-bound oauth_transaction and oauth_reauth_receipt rows after D3 reset, got tx=%d receipts=%d", uncancelledUserOAuth, uncancelledReceipts)
	}

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

	// (c) Release the two genuinely in-flight callbacks that were held in Exchange ('claimed') across reset (AU3-BE1-8):
	releaseSameExch()
	if got := <-sameCbCh; got != "login_ready" {
		t.Fatalf("in-flight same-email callback status after exchange release = %q, want login_ready", got)
	}
	h.csrfJar(jarInFlightSame)
	respSame := h.doAs(jarInFlightSame, http.MethodPost, "/api/v1/auth/oauth/complete", "", true, "198.51.100.202")
	requireAcceptanceProblem(t, h, respSame, http.StatusConflict, "email_taken")
	_ = respSame.Body.Close()
	releaseDiffExch()
	if got := <-diffCbCh; got != "login_ready" {
		t.Fatalf("in-flight diff-email callback status after exchange release = %q, want login_ready", got)
	}
	h.csrfJar(jarInFlightDiff)
	respDiff := h.doAs(jarInFlightDiff, http.MethodPost, "/api/v1/auth/oauth/complete", "", true, "198.51.100.203")
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

	// (d) Independently prove oauth.Service.Complete's final owner recheck under app_user FOR UPDATE (AU3-BE1-8):
	// Re-link Google on the now-verified victim account, reach login_ready, pause Complete at OnOwnerDiscovered,
	// unlink Google via DeleteIdentity (which does NOT cancel ready login oauth_transaction rows, unlike D3 reset),
	// and release Complete. Because the oauth_transaction row is still status='ready', ONLY Complete's
	// GetIdentityByProviderUID recheck under GetUserByIDForUpdate prevents session issuance and returns 400 oauth_state_invalid!
	if _, err := q.InsertOAuthIdentity(ctx, gen.InsertOAuthIdentityParams{
		UserID: victimID, Provider: "google", ProviderUid: new("g-attacker"),
	}); err != nil {
		t.Fatal(err)
	}
	jarRecheck := jar{}
	h.csrfJar(jarRecheck)
	oldJar = h.jar
	h.jar = jarRecheck
	if got := statusFromCallback(followOAuthAs(t, h, "/api/v1/auth/oauth/google/start", "198.51.100.208")); got != "login_ready" {
		t.Fatalf("recheck oauth callback = %s", got)
	}
	jarRecheck = cloneAcceptanceJar(h.jar)
	h.jar = oldJar

	disc2 := make(chan struct{})
	var disc2Once sync.Once
	rel2 := make(chan struct{})
	var rel2Once sync.Once
	unblock2 := func() { rel2Once.Do(func() { close(rel2) }) }
	h.oa.SetOnOwnerDiscovered(func() {
		disc2Once.Do(func() { close(disc2) })
		<-rel2
	})
	t.Cleanup(func() {
		h.oa.SetOnOwnerDiscovered(nil)
		unblock2()
	})
	joinComp2, _ := startAsyncRequest(t, h, jarRecheck, http.MethodPost, "/api/v1/auth/oauth/complete", "", true, "198.51.100.209", unblock2)
	select {
	case <-disc2:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for second oauth.Service.Complete to reach OnOwnerDiscovered")
	}
	// Remove the Google identity directly while leaving the oauth_transaction in status='ready'.
	if _, err := h.pool.Exec(ctx, `DELETE FROM auth_identity WHERE user_id = $1 AND provider = 'google'`, victimID); err != nil {
		t.Fatal(err)
	}
	unblock2()
	respComp2 := joinComp2()
	h.oa.SetOnOwnerDiscovered(nil)
	requireAsyncProblem(t, respComp2, http.StatusBadRequest, "oauth_state_invalid")
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM session WHERE user_id = $1 AND revoked_at IS NULL`, victimID).Scan(&sessionCount); err != nil {
		t.Fatal(err)
	}
	if sessionCount != 0 {
		t.Fatalf("owner recheck failure must issue 0 sessions, got %d", sessionCount)
	}
}

// 10. E2 forced collision between ResetPassword and Logout / lock timeout retry + 503 dependency_unavailable (AU2-BE2-2, AU3-BE1-7).
func TestPasswordResetDeadlockRetryWithLogoutAndExhaustedRetry503(t *testing.T) {
	h := newHarness(t, nil)
	ctx := context.Background()
	signupAcceptance(t, h, "e2-collision@example.com")
	jarLogout := cloneAcceptanceJar(h.jar)

	tok := issueResetTokenForTest(t, h, "e2-collision@example.com")

	// Part A: True forced 40P01 deadlock collision between ResetPassword (locks app_user -> session)
	// and Logout (locks session -> audit_log FK FOR KEY SHARE on app_user), with 0 sleeps:
	// 1. ResetPassword attempt 0 acquires app_user FOR UPDATE and signals resetLocked.
	// 2. Logout starts, executes RevokeSession (acquiring FOR NO KEY UPDATE lock on session),
	//    signals logoutLockedSession, and continues to audit.Record where INSERT INTO audit_log
	//    blocks waiting for FOR KEY SHARE on app_user!
	// 3. Once pg_locks confirms Logout is blocked on app_user, release ResetPassword attempt 0:
	//    ResetPassword executes RevokeAllUserSessions, which blocks on the session lock held by Logout,
	//    completing the cycle app_user <-> session!
	// 4. Postgres deadlock detector raises 40P01; ResetPassword catches 40P01 if chosen as victim,
	//    retries automatically, and commits cleanly with 204 No Content!
	resetLocked := make(chan struct{})
	var onceResetLocked sync.Once
	releaseReset := make(chan struct{})
	var onceReleaseReset sync.Once
	unblockReset := func() { onceReleaseReset.Do(func() { close(releaseReset) }) }

	logoutLockedSession := make(chan struct{})
	var onceLogoutLocked sync.Once

	var partAAttempts atomic.Int32
	h.svc.SetOnResetAttempt(func(_ context.Context, _ pgx.Tx, _ int) error {
		partAAttempts.Add(1)
		return nil
	})
	h.svc.SetOnResetLocked(func() {
		onceResetLocked.Do(func() {
			close(resetLocked)
			<-releaseReset
		})
	})
	h.svc.SetOnLogoutRevoked(func() {
		onceLogoutLocked.Do(func() { close(logoutLockedSession) })
	})

	t.Cleanup(func() {
		h.svc.SetOnResetAttempt(nil)
		h.svc.SetOnResetLocked(nil)
		h.svc.SetOnLogoutRevoked(nil)
		unblockReset()
	})

	joinReset, _ := startAsyncRequest(t, h, jar{}, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok+`","new_password":"aftercollision12"}`, true, "203.0.113.91", unblockReset)
	<-resetLocked

	joinLogout, _ := startAsyncRequest(t, h, jarLogout, http.MethodPost, "/api/v1/auth/logout", "", true, "203.0.113.92", unblockReset)
	// Prove Logout holds its session lock before releasing ResetPassword!
	<-logoutLockedSession
	waitDeadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(waitDeadline) {
		var ungranted int
		_ = h.pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE NOT granted`).Scan(&ungranted)
		if ungranted > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	unblockReset()

	respReset := joinReset()
	if respReset.err != nil || respReset.status != http.StatusNoContent {
		t.Fatalf("ResetPassword under Logout collision = %d %s err=%v, want 204", respReset.status, respReset.body, respReset.err)
	}

	_ = joinLogout()
	h.svc.SetOnResetLocked(nil)
	h.svc.SetOnLogoutRevoked(nil)
	h.svc.SetOnResetAttempt(nil)
	if got := partAAttempts.Load(); got < 1 || got > 2 {
		t.Fatalf("unexpected Part A reset attempt count = %d, want 1 or 2", got)
	}

	// Verify all sessions are revoked.
	var liveSessions int
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM session s JOIN app_user u ON u.id = s.user_id WHERE u.email = 'e2-collision@example.com' AND s.revoked_at IS NULL`).Scan(&liveSessions); err != nil {
		t.Fatal(err)
	}
	if liveSessions != 0 {
		t.Fatalf("expected 0 live sessions after reset-vs-logout collision, got %d", liveSessions)
	}

	// Part B1: First attempt hits real PostgreSQL 55P03 (lock_not_available) on the exact reset tx connection
	// via SET LOCAL lock_timeout = '25ms' while an external tx holds app_user FOR UPDATE; once attempt 0 fails,
	// the external lock is released before attempt 1 runs, proving ResetPassword retries once (attempts == 2) and succeeds with 204!
	tokRetryOnce := issueResetTokenForTest(t, h, "e2-collision@example.com")
	holdRetryOnceTx, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holdRetryOnceTx.Rollback(ctx) }()
	if _, err := holdRetryOnceTx.Exec(ctx, `SELECT id FROM app_user WHERE email = 'e2-collision@example.com' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}

	var retryOnceAttempts atomic.Int32
	h.svc.SetOnResetAttempt(func(txCtx context.Context, tx pgx.Tx, attempt int) error {
		retryOnceAttempts.Add(1)
		if _, err := tx.Exec(txCtx, `SET LOCAL lock_timeout = '25ms'`); err != nil {
			return err
		}
		if attempt == 1 {
			// Release the external lock right as attempt 1 starts so attempt 0 failed with 55P03 and attempt 1 succeeds!
			if err := holdRetryOnceTx.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
				return err
			}
		}
		return nil
	})

	jRetry := jar{}
	h.csrfJar(jRetry)
	respRetry204 := h.doAs(jRetry, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tokRetryOnce+`","new_password":"retrysucceeded12"}`, true, "203.0.113.94")
	h.svc.SetOnResetAttempt(nil)
	if respRetry204.StatusCode != http.StatusNoContent {
		t.Fatalf("first-attempt 55P03 + second-attempt success = %d %s, want 204", respRetry204.StatusCode, h.body(respRetry204))
	}
	_ = respRetry204.Body.Close()
	if got := retryOnceAttempts.Load(); got != 2 {
		t.Fatalf("expected exactly 2 attempts (1 retry) on first-attempt 55P03, got %d", got)
	}

	// Part B2: Both attempts hit real PostgreSQL 55P03 on the exact reset tx connection ->
	// returns 503 dependency_unavailable + Retry-After: 1 after exactly 2 attempts, leaving token unconsumed and password unchanged.
	tok2 := issueResetTokenForTest(t, h, "e2-collision@example.com")
	lockTx, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lockTx.Rollback(ctx) }()
	if _, err := lockTx.Exec(ctx, `SELECT id FROM app_user WHERE email = 'e2-collision@example.com' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}

	var exhaustedAttempts atomic.Int32
	h.svc.SetOnResetAttempt(func(txCtx context.Context, tx pgx.Tx, _ int) error {
		exhaustedAttempts.Add(1)
		_, err := tx.Exec(txCtx, `SET LOCAL lock_timeout = '25ms'`)
		return err
	})

	h.csrfJar(jRetry)
	resp503 := h.doAs(jRetry, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok2+`","new_password":"retryexhausted12"}`, true, "203.0.113.95")
	h.svc.SetOnResetAttempt(nil)
	raw503 := requireAcceptanceProblem(t, h, resp503, http.StatusServiceUnavailable, "dependency_unavailable")
	_ = resp503.Body.Close()
	if resp503.Header.Get("Retry-After") != "1" || !strings.Contains(raw503, `"retry_after":1`) {
		t.Fatalf("503 dependency_unavailable must include Retry-After: 1 header and retry_after: 1 body, got header=%q body=%s", resp503.Header.Get("Retry-After"), raw503)
	}
	if got := exhaustedAttempts.Load(); got != 2 {
		t.Fatalf("expected exactly 2 attempts before 503 dependency_unavailable, got %d", got)
	}

	// Release the external lock: token was not consumed on rollback, so retry now succeeds with 204!
	if err := lockTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	resp204 := h.doAs(jRetry, http.MethodPost, "/api/v1/auth/password/reset", `{"token":"`+tok2+`","new_password":"retryexhausted12"}`, true, "203.0.113.96")
	if resp204.StatusCode != http.StatusNoContent {
		t.Fatalf("retry after lock release = %d %s, want 204", resp204.StatusCode, h.body(resp204))
	}
	_ = resp204.Body.Close()
}

// 12. Service.Close cancels active blocked forgot-worker DB work and waits for worker exit before pool teardown (AU3-BE1-1, AU3-BE2-1).
func TestServiceCloseCancelsBlockedWorkerAndWaitsForExit(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	clk := clock.NewFixed(time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", "http://127.0.0.1:3000")
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_MAIL_CAPTURE_AS_DELIVERY", "true")
	cfg := loadTestConfig(t)
	sink, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc, _, _, err := compose.NewAuth(cfg, pool, nil, clk, sink, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Register svc.Close immediately after construction so any failure before the explicit Close call
	// still cancels and joins the worker before dbtest.Pool's cleanup closes the pool (AU3-BE2-1).
	t.Cleanup(func() {
		svc.SetForgotHooks(auth.ForgotHooks{})
		svc.Close()
	})

	// Seed a user and hold app_user FOR UPDATE in an external transaction so the forgot worker
	// blocks inside GetUserByIDForUpdate(ctx, u.ID).
	var uid uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email, locale) VALUES ('close-worker@example.com', 'en') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	holdTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holdTx.Rollback(ctx) }()
	var holderPID int32
	if err := holdTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&holderPID); err != nil {
		t.Fatalf("holder pid: %v", err)
	}
	if _, err := holdTx.Exec(ctx, `SELECT id FROM app_user WHERE id = $1 FOR UPDATE`, uid); err != nil {
		t.Fatal(err)
	}

	jobStarted := make(chan struct{})
	jobDone := make(chan error, 1)
	svc.SetForgotHooks(auth.ForgotHooks{
		OnJobStart: func(_ auth.ForgotJob) {
			close(jobStarted)
		},
		OnJobDone: func(_ auth.ForgotJob, err error) {
			jobDone <- err
		},
	})

	svc.EnqueueForgotPassword("close-worker@example.com", "en")
	<-jobStarted

	// Positively identify the blocked worker query waiting on holderPID in pg_locks and fail if not observed.
	var observedBlocked bool
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var blocked int
		qErr := pool.QueryRow(ctx,
			`SELECT count(*) FROM pg_locks w WHERE NOT w.granted AND $1 = ANY(pg_blocking_pids(w.pid))`,
			holderPID,
		).Scan(&blocked)
		if qErr != nil {
			t.Fatalf("query pg_locks for blocked worker: %v", qErr)
		}
		if blocked > 0 {
			observedBlocked = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !observedBlocked {
		t.Fatalf("worker was never observed blocked on holderPID=%d before svc.Close()", holderPID)
	}

	// Part 1: svc.Close() cancels the blocked DB query and returns within the external deadline.
	closeReturned := make(chan struct{})
	go func() {
		svc.Close()
		close(closeReturned)
	}()
	select {
	case <-closeReturned:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for svc.Close() to cancel blocked DB query and return")
	}
	select {
	case jobErr := <-jobDone:
		if jobErr == nil {
			t.Fatal("expected cancelled worker job to report non-nil error")
		}
	default:
		t.Fatal("expected jobDone result after svc.Close() returned")
	}

	// Part 2 (AU3-BE3-1): Deterministic scheduler-controlled proof using testing/synctest that
	// svc.Close() joins the worker goroutine (<-s.forgotDone) rather than returning after cancel-only.
	// Inside a synctest bubble, synctest.Wait() advances all runnable goroutines until every goroutine
	// in the bubble is durably blocked or exited: on a cancel-only Close() (without <-s.forgotDone),
	// the closer goroutine never blocks in Close(), so synctest.Wait() runs it straight through
	// closeSyncReturned = true and fails deterministically with zero scheduling gap.
	synctest.Test(t, func(t *testing.T) {
		cfgSync := *cfg
		cfgSync.MailCaptureAsDelivery = false
		svcSync, _, _, err := compose.NewAuth(&cfgSync, pool, nil, clk, sink, nil)
		if err != nil {
			t.Fatalf("compose.NewAuth inside synctest: %v", err)
		}

		releaseCallback := make(chan struct{})
		var releaseCallbackOnce sync.Once
		unblockCallback := func() { releaseCallbackOnce.Do(func() { close(releaseCallback) }) }
		defer func() {
			unblockCallback()
			svcSync.Close()
		}()
		var callbackEntered, callbackCompleted bool
		var callbackErr error
		svcSync.SetForgotHooks(auth.ForgotHooks{
			OnJobDone: func(_ auth.ForgotJob, err error) {
				callbackEntered = true
				<-releaseCallback
				callbackErr = err
				callbackCompleted = true
			},
		})

		svcSync.EnqueueForgotPassword("synctest-close@example.com", "en")
		synctest.Wait()
		if !callbackEntered {
			t.Fatal("expected forgot worker to enter OnJobDone and durably block on releaseCallback")
		}

		var closeSyncEntered, closeSyncReturned bool
		go func() {
			closeSyncEntered = true
			svcSync.Close()
			closeSyncReturned = true
		}()
		synctest.Wait()
		if !closeSyncEntered {
			t.Fatal("expected closer goroutine to enter svc.Close() before synctest.Wait() returned")
		}
		if closeSyncReturned {
			t.Fatal("svc.Close() returned while worker was still durably blocked in OnJobDone")
		}

		unblockCallback()
		synctest.Wait()
		if !callbackCompleted || !closeSyncReturned {
			t.Fatalf("expected worker callback and svc.Close() to complete after releasing callback (callbackCompleted=%v closeSyncReturned=%v)", callbackCompleted, closeSyncReturned)
		}
		if !errors.Is(callbackErr, auth.ErrMailDeliveryUnavailable) {
			t.Fatalf("expected ErrMailDeliveryUnavailable from synctest job, got %v", callbackErr)
		}
	})
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
