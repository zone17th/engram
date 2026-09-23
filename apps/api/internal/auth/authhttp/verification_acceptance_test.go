package authhttp_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/authhttp"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/oauth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/compose"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

func acceptanceToken(t *testing.T, h *harness, recipient, purpose string) string {
	t.Helper()
	entries, err := h.mail.EntriesFor(recipient, purpose)
	if err != nil || len(entries) != 1 {
		t.Fatalf("mail %s/%s = %d, err=%v", recipient, purpose, len(entries), err)
	}
	u, err := url.Parse(entries[0].Link)
	if err != nil {
		t.Fatal(err)
	}
	token := u.Fragment
	if values, err := url.ParseQuery(u.Fragment); err == nil {
		token = values.Get("token")
	}
	if token == "" {
		t.Fatal("mail link missing token")
	}
	return token
}

func requireAcceptanceProblem(t *testing.T, h *harness, resp *http.Response, status int, code string) string {
	t.Helper()
	raw := h.body(resp)
	if resp.StatusCode != status {
		t.Fatalf("want %s/%d, got %d %s", code, status, resp.StatusCode, raw)
	}
	var p struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatalf("problem JSON: %v (%s)", err, raw)
	}
	if p.Code != code {
		t.Fatalf("problem code = %q, want %q (%s)", p.Code, code, raw)
	}
	return raw
}

func completeAcceptanceOAuth(t *testing.T, h *harness) auth.Me {
	t.Helper()
	if got := statusFromCallback(h.followOAuth("/api/v1/auth/oauth/google/start")); got != "login_ready" {
		t.Fatalf("OAuth callback = %s", got)
	}
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/oauth/complete", "", true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("OAuth complete = %d %s", resp.StatusCode, h.body(resp))
	}
	var me auth.Me
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return me
}

func cloneAcceptanceJar(in jar) jar {
	out := make(jar, len(in))
	for name, cookie := range in {
		copyCookie := *cookie
		out[name] = &copyCookie
	}
	return out
}

func acceptanceCaptchaServer(t *testing.T, h *harness, captcha auth.Captcha) *httptest.Server {
	t.Helper()
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	authn, csrfv, reauth := compose.Adapters(h.svc)
	api := authhttp.NewAPI(h.svc, &oauth.Service{}, captcha, cfg.TrustedProxyContains)
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

func TestVerificationTokenExpiryOverHTTP(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"expiry@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("verification send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	token := acceptanceToken(t, h, "expiry@example.com", "signup")

	h.clk.Advance(24*time.Hour + time.Second)
	resp = h.do(http.MethodPost, "/api/v1/auth/refresh", "", true)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("refresh after clock advance = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+token+`"}`, true)
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "verification_invalid")
	_ = resp.Body.Close()
}

func TestVerificationTokenReplayOverHTTP(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"replay@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("verification send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	token := acceptanceToken(t, h, "replay@example.com", "signup")

	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+token+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("first confirm = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+token+`"}`, true)
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "verification_invalid")
	_ = resp.Body.Close()
}

func TestVerificationCreatesNoticeForPreviouslyUnverifiedAccount(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"notice@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("verification send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	token := acceptanceToken(t, h, "notice@example.com", "signup")
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+token+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("verification confirm = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodGet, "/api/v1/me/notifications", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("notifications = %d %s", resp.StatusCode, h.body(resp))
	}
	var page auth.CursorPage[auth.NotificationItem]
	if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if len(page.Items) == 0 || page.Items[0].Kind != "security" {
		t.Fatalf("verification notice = %+v", page.Items)
	}
}

func TestVerificationTokenPurposeCannotEnrollViaEmailConfirm(t *testing.T) {
	fake := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "purpose-user", Email: "purpose@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fake})
	fake.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")
	h.csrf()
	me := completeAcceptanceOAuth(t, h)
	if !me.Features.PasswordEnrollmentAvailable {
		t.Fatal("OAuth-only verified account should allow enrollment")
	}
	resp := h.do(http.MethodPost, "/api/v1/auth/password/enroll/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("enrollment send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	token := acceptanceToken(t, h, "purpose@example.com", "password_enroll")

	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+token+`"}`, true)
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "verification_invalid")
	_ = resp.Body.Close()
	resp = h.do(http.MethodPost, "/api/v1/me/password", `{"new_password":"enrolledpass1","enrollment_token":"`+token+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("enrollment after wrong-purpose probe = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
}

func TestPasswordEnrollmentRejectsForeignSession(t *testing.T) {
	fake := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "enroll-a", Email: "enroll-a@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fake})
	fake.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")
	h.csrf()
	completeAcceptanceOAuth(t, h)
	resp := h.do(http.MethodPost, "/api/v1/auth/password/enroll/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("enrollment A send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	tokenA := acceptanceToken(t, h, "enroll-a@example.com", "password_enroll")
	jarA := cloneAcceptanceJar(h.jar)

	jarB := jar{}
	h.csrfJar(jarB)
	h.jar = jarB
	fake.Identity = oauth.Identity{
		Provider: "google", UID: "enroll-b", Email: "enroll-b@example.com", EmailVerified: true,
	}
	completeAcceptanceOAuth(t, h)
	jarB = h.jar
	resp = h.doAs(jarB, http.MethodPost, "/api/v1/me/password", `{"new_password":"enrolledpass1","enrollment_token":"`+tokenA+`"}`, true, "198.51.100.91")
	requireAcceptanceProblem(t, h, resp, http.StatusBadRequest, "verification_invalid")
	_ = resp.Body.Close()

	resp = h.doAs(jarB, http.MethodGet, "/api/v1/auth/me", "", false, "198.51.100.91")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("account B me = %d %s", resp.StatusCode, h.body(resp))
	}
	var meB auth.Me
	if err := json.NewDecoder(resp.Body).Decode(&meB); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if !meB.Features.PasswordEnrollmentAvailable {
		t.Fatal("foreign enrollment should preserve B's enrollment access")
	}
	for _, identity := range meB.Identities {
		if identity.Provider == "password" {
			t.Fatal("foreign enrollment created a password identity for B")
		}
	}

	h.jar = jarA
	resp = h.do(http.MethodPost, "/api/v1/me/password", `{"new_password":"enrolledpass1","enrollment_token":"`+tokenA+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("owner enrollment after foreign probe = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
}

func TestVerificationSendQuotaOverHTTP(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"quota@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("first send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/send", "", true)
	raw := requireAcceptanceProblem(t, h, resp, http.StatusTooManyRequests, "rate_limited")
	_ = resp.Body.Close()
	if resp.Header.Get("Retry-After") == "" || !strings.Contains(raw, `"retry_after"`) {
		t.Fatalf("quota response missing Retry-After: %s", raw)
	}
}

func TestInjectedCaptchaGateAfterLoginLockout(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"captcha@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	srv := acceptanceCaptchaServer(t, h, auth.StaticCaptcha{Accept: "captcha-ok"})
	t.Cleanup(srv.Close)
	oldSrv := h.srv
	h.srv = srv
	t.Cleanup(func() { h.srv = oldSrv })
	for i := 0; i < auth.LockoutFailThreshold; i++ {
		xff := fmt.Sprintf("198.51.100.%d", i+1)
		resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/login", `{"email":"captcha@example.com","password":"wrongpassword","captcha_token":"wrong-captcha"}`, true, xff)
		if i < auth.LockoutFailThreshold-1 {
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("failed login %d = %d %s", i+1, resp.StatusCode, h.body(resp))
			}
			_ = resp.Body.Close()
			continue
		}
		raw := requireAcceptanceProblem(t, h, resp, http.StatusTooManyRequests, "rate_limited")
		_ = resp.Body.Close()
		if !strings.Contains(raw, `"captcha_required":true`) || resp.Header.Get("Retry-After") == "" {
			t.Fatalf("lockout response missing CAPTCHA/Retry-After: %s", raw)
		}
	}

	h.clk.Advance(auth.LockoutInitial + time.Second)
	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/login", `{"email":"captcha@example.com","password":"correcthorse","captcha_token":"wrong-captcha"}`, true, "198.51.100.80")
	requireAcceptanceProblem(t, h, resp, http.StatusForbidden, "captcha_required")
	_ = resp.Body.Close()
	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/login", `{"email":"captcha@example.com","password":"correcthorse","captcha_token":"captcha-ok"}`, true, "198.51.100.80")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("accepted CAPTCHA login = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/login", `{"email":"captcha@example.com","password":"wrongpassword"}`, true, "198.51.100.81")
	requireAcceptanceProblem(t, h, resp, http.StatusUnauthorized, "invalid_credentials")
	_ = resp.Body.Close()
}
