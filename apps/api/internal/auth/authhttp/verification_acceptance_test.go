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
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/auth/oauth"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/httpx"
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

func signupAcceptance(t *testing.T, h *harness, email string) {
	t.Helper()
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"`+email+`","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup %s = %d %s", email, resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
}

func notificationsAcceptance(t *testing.T, h *harness) auth.CursorPage[auth.NotificationItem] {
	t.Helper()
	resp := h.do(http.MethodGet, "/api/v1/me/notifications", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("notifications = %d %s", resp.StatusCode, h.body(resp))
	}
	var page auth.CursorPage[auth.NotificationItem]
	if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return page
}

// Tài khoản B không được đọc notice của A, cũng không được đánh dấu read theo id
// của A: endpoint owner-checked trả 404, không phải 403 hay thành công.
func TestNotificationFeedIsOwnerScoped(t *testing.T) {
	h := newHarness(t, nil)
	signupAcceptance(t, h, "feed-owner@example.com")
	resp := h.do(http.MethodPost, "/api/v1/auth/verify-email/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("verification send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	token := acceptanceToken(t, h, "feed-owner@example.com", "signup")
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+token+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("verification confirm = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	pageA := notificationsAcceptance(t, h)
	if len(pageA.Items) == 0 {
		t.Fatal("A phải có notice sau verification")
	}
	ownerJar := cloneAcceptanceJar(h.jar)
	foreignID := pageA.Items[0].ID

	jarB := jar{}
	h.csrfJar(jarB)
	h.jar = jarB
	signupAcceptance(t, h, "feed-other@example.com")

	if pageB := notificationsAcceptance(t, h); len(pageB.Items) != 0 {
		t.Fatalf("feed B thấy notice của A: %+v", pageB.Items)
	}

	resp = h.do(http.MethodPatch, "/api/v1/me/notifications/"+foreignID, `{"read":true}`, true)
	requireAcceptanceProblem(t, h, resp, http.StatusNotFound, "not_found")
	_ = resp.Body.Close()

	h.jar = ownerJar
	if got := notificationsAcceptance(t, h).Items[0]; got.ReadAt != nil {
		t.Fatalf("B đánh dấu read được notice của A: %v", *got.ReadAt)
	}
}

// Audit feed theo cùng quy tắc: B không thấy dòng audit của A.
func TestAuditFeedIsOwnerScoped(t *testing.T) {
	h := newHarness(t, nil)
	signupAcceptance(t, h, "audit-owner@example.com")

	resp := h.do(http.MethodGet, "/api/v1/auth/audit", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("audit A = %d %s", resp.StatusCode, h.body(resp))
	}
	var pageA auth.CursorPage[auth.AuditItem]
	if err := json.NewDecoder(resp.Body).Decode(&pageA); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if len(pageA.Items) == 0 {
		t.Fatal("A phải có audit signup")
	}
	ownerJar := cloneAcceptanceJar(h.jar)

	jarB := jar{}
	h.csrfJar(jarB)
	h.jar = jarB
	signupAcceptance(t, h, "audit-other@example.com")

	resp = h.do(http.MethodGet, "/api/v1/auth/audit", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("audit B = %d %s", resp.StatusCode, h.body(resp))
	}
	var pageB auth.CursorPage[auth.AuditItem]
	if err := json.NewDecoder(resp.Body).Decode(&pageB); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	seen := make(map[string]struct{}, len(pageA.Items))
	for _, item := range pageA.Items {
		seen[item.ID] = struct{}{}
	}
	for _, item := range pageB.Items {
		if _, ok := seen[item.ID]; ok {
			t.Fatalf("audit B thấy dòng của A: %+v", item)
		}
	}

	// A vẫn đọc được dòng của chính mình sau khi B đã truy vấn.
	h.jar = ownerJar
	resp = h.do(http.MethodGet, "/api/v1/auth/audit", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("audit A lần hai = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
}

// Notice cho signup-verify không có email đã verified, nên email_targets rỗng —
// nhưng notice vẫn phải thấy trong app (không chờ mail adapter), và meta không
// được mang recipient hay token.
func TestSecurityNoticeWithoutVerifiedEmailStillReachesFeed(t *testing.T) {
	h := newHarness(t, nil)
	signupAcceptance(t, h, "snapshot@example.com")
	resp := h.do(http.MethodPost, "/api/v1/auth/verify-email/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("verification send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	token := acceptanceToken(t, h, "snapshot@example.com", "signup")
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+token+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("verification confirm = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	var targets, meta string
	if err := h.pool.QueryRow(context.Background(),
		`SELECT COALESCE(email_targets::text, '{}'), meta::text FROM user_notification ORDER BY id DESC LIMIT 1`).Scan(&targets, &meta); err != nil {
		t.Fatalf("đọc notice: %v", err)
	}
	if targets != "{}" && targets != "[]" {
		t.Fatalf("signup-verify chưa có email verified nên email_targets phải rỗng, được %s", targets)
	}
	if strings.Contains(meta, "@") || strings.Contains(meta, "token") {
		t.Fatalf("meta notice lộ recipient/token: %s", meta)
	}
	if page := notificationsAcceptance(t, h); len(page.Items) == 0 {
		t.Fatal("notice không có email target vẫn phải thấy trong feed")
	}
}

// Notice của email-change phải snapshot địa chỉ CŨ tại thời điểm confirm, không
// phải địa chỉ mới: cảnh báo phải tới hộp thư đang bị chiếm.
func TestEmailChangeNoticeSnapshotsTheOldAddress(t *testing.T) {
	h := newHarness(t, nil)
	signupAcceptance(t, h, "old-address@example.com")
	// Đặt verified trực tiếp: gửi mail trước đó sẽ tiêu quota 1/phút/user mà
	// RequestEmailChange cũng dùng, và verification signup đã có ca riêng.
	if _, err := h.pool.Exec(context.Background(),
		`UPDATE app_user SET email_verified_at = now() WHERE email = 'old-address@example.com'`); err != nil {
		t.Fatalf("set verified: %v", err)
	}

	grant := h.grant("account.email_change", "correcthorse")
	resp := h.withGrant(http.MethodPost, "/api/v1/me/email", `{"new_email":"new-address@example.com"}`, grant)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("email change request = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	changeToken := acceptanceToken(t, h, "new-address@example.com", "email_change")
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+changeToken+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("email change confirm = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	var targets string
	if err := h.pool.QueryRow(context.Background(),
		`SELECT email_targets::text FROM user_notification ORDER BY id DESC LIMIT 1`).Scan(&targets); err != nil {
		t.Fatalf("đọc notice: %v", err)
	}
	if !strings.Contains(targets, "old-address@example.com") {
		t.Fatalf("email_targets phải giữ địa chỉ cũ: %s", targets)
	}
	if strings.Contains(targets, "new-address@example.com") {
		t.Fatalf("email_targets không được theo địa chỉ mới: %s", targets)
	}
}

// Signup cạnh tranh cùng email: đúng một tài khoản thắng, và kẻ thua không để
// lại user/identity/session nửa chừng vì toàn bộ nằm trong một transaction.
func TestConcurrentSignupLeavesNoPartialAccount(t *testing.T) {
	h := newHarness(t, nil)

	var wg sync.WaitGroup
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			j := jar{}
			h.csrfJar(j)
			resp := h.doAs(j, http.MethodPost, "/api/v1/auth/signup", `{"email":"rollback@example.com","password":"correcthorse"}`, true, "198.51.100.9")
			results <- resp.StatusCode
			_ = h.body(resp)
		}()
	}
	wg.Wait()
	close(results)
	var created, conflict int
	for code := range results {
		switch code {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			conflict++
		default:
			t.Fatalf("signup cạnh tranh trả %d", code)
		}
	}
	if created != 1 || conflict != 1 {
		t.Fatalf("muốn 1 tạo + 1 conflict, được created=%d conflict=%d", created, conflict)
	}

	ctx := context.Background()
	counts := map[string]int{}
	for label, query := range map[string]string{
		"user":     `SELECT count(*) FROM app_user WHERE email = 'rollback@example.com'`,
		"identity": `SELECT count(*) FROM auth_identity i JOIN app_user u ON u.id = i.user_id WHERE u.email = 'rollback@example.com'`,
		"session":  `SELECT count(*) FROM session s JOIN app_user u ON u.id = s.user_id WHERE u.email = 'rollback@example.com'`,
	} {
		var n int
		if err := h.pool.QueryRow(ctx, query).Scan(&n); err != nil {
			t.Fatalf("đếm %s: %v", label, err)
		}
		counts[label] = n
	}
	if counts["user"] != 1 || counts["identity"] != 1 || counts["session"] != 1 {
		t.Fatalf("tài khoản thua để lại rác: %+v", counts)
	}
}

// Password đăng nhập và refresh token không được nằm dạng plaintext trong DB.
func TestStoredCredentialsAreNotPlaintext(t *testing.T) {
	h := newHarness(t, nil)
	const password = "correcthorsebatterystaple"
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"plaintext@example.com","password":"`+password+`"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	refresh := h.jar[authhttp.CookieRefresh]
	if refresh == nil || refresh.Value == "" {
		t.Fatal("thiếu refresh cookie để đối chiếu")
	}

	ctx := context.Background()
	for label, query := range map[string]string{
		"password_hash":    `SELECT password_hash FROM auth_identity i JOIN app_user u ON u.id = i.user_id WHERE u.email = 'plaintext@example.com'`,
		"refresh_hash_hex": `SELECT encode(refresh_token_hash, 'hex') FROM session s JOIN app_user u ON u.id = s.user_id WHERE u.email = 'plaintext@example.com'`,
	} {
		var stored string
		if err := h.pool.QueryRow(ctx, query).Scan(&stored); err != nil {
			t.Fatalf("đọc %s: %v", label, err)
		}
		if strings.Contains(stored, password) || strings.Contains(stored, refresh.Value) {
			t.Fatalf("%s lưu plaintext", label)
		}
		if stored == "" {
			t.Fatalf("%s rỗng", label)
		}
	}

	var hashed string
	if err := h.pool.QueryRow(ctx,
		`SELECT password_hash FROM auth_identity i JOIN app_user u ON u.id = i.user_id WHERE u.email = 'plaintext@example.com'`).Scan(&hashed); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hashed, "$argon2id$") {
		t.Fatalf("password_hash không phải argon2id: %s", hashed)
	}
}

// Hai request /oauth/complete song song trên cùng binding: chỉ một session được
// cấp, request còn lại bị từ chối vì transaction đã consumed.
// oauthCallbackURL chạy start → fake authorize nhưng dừng trước callback và trả
// URL callback, để test có thể gọi callback đó nhiều lần hoặc song song.
func oauthCallbackURL(t *testing.T, h *harness, startPath string) string {
	t.Helper()
	client := noRedirect()
	req, err := http.NewRequest(http.MethodGet, h.srv.URL+startPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.apply(req)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.capture(resp)
	loc := resp.Header.Get("Location")
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusFound || loc == "" {
		t.Fatalf("oauth start = %d %s", resp.StatusCode, h.body(resp))
	}
	req, err = http.NewRequest(http.MethodGet, loc, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	cb := resp.Header.Get("Location")
	_ = resp.Body.Close()
	if cb == "" {
		t.Fatal("fake authorize không redirect về callback")
	}
	return cb
}

// Hai callback song song trên cùng state: một cái claim flow, cái kia thấy
// transaction đã bị claim nên trả invalid_flow; chỉ một session được cấp sau đó.
func TestConcurrentOauthCallbackClaimsOnce(t *testing.T) {
	fake := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "g-cb-race", Email: "cb-race@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fake})
	fake.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")
	h.csrf()
	cb := oauthCallbackURL(t, h, "/api/v1/auth/oauth/google/start")

	client := noRedirect()
	var wg sync.WaitGroup
	results := make(chan string, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req, err := http.NewRequest(http.MethodGet, cb, nil)
			if err != nil {
				t.Error(err)
				return
			}
			cloneAcceptanceJar(h.jar).apply(req)
			resp, err := client.Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			loc := resp.Header.Get("Location")
			_ = resp.Body.Close()
			results <- statusFromCallback(loc)
		}(i)
	}
	wg.Wait()
	close(results)

	var ready, invalid int
	for status := range results {
		switch status {
		case "login_ready":
			ready++
		case "invalid_flow", "provider_error", "cancelled":
			invalid++
		default:
			t.Fatalf("callback cạnh tranh trả status %q", status)
		}
	}
	if ready != 1 || invalid != 1 {
		t.Fatalf("muốn 1 ready + 1 từ chối, được ready=%d invalid=%d", ready, invalid)
	}

	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/oauth/complete", "", true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("complete sau race = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	var sessions int
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM session s JOIN app_user u ON u.id = s.user_id WHERE u.email = 'cb-race@example.com'`).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 {
		t.Fatalf("session = %d, muốn 1", sessions)
	}
}

// Hai confirm song song cùng token: một lần consume, một lần bị từ chối, và
// chỉ một notice được tạo.
func TestConcurrentEmailConfirmConsumesOnce(t *testing.T) {
	h := newHarness(t, nil)
	signupAcceptance(t, h, "parallel-confirm@example.com")
	resp := h.do(http.MethodPost, "/api/v1/auth/verify-email/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	token := acceptanceToken(t, h, "parallel-confirm@example.com", "signup")

	var wg sync.WaitGroup
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			j := cloneAcceptanceJar(h.jar)
			resp := h.doAs(j, http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+token+`"}`, true, fmt.Sprintf("198.51.100.%d", 80+i))
			results <- resp.StatusCode
			_ = h.body(resp)
		}(i)
	}
	wg.Wait()
	close(results)
	var ok, rejected int
	for code := range results {
		switch code {
		case http.StatusOK:
			ok++
		case http.StatusBadRequest:
			rejected++
		default:
			t.Fatalf("confirm cạnh tranh trả %d", code)
		}
	}
	if ok != 1 || rejected != 1 {
		t.Fatalf("muốn 1 confirm + 1 từ chối, được ok=%d rejected=%d", ok, rejected)
	}

	ctx := context.Background()
	var verified bool
	var notices int
	if err := h.pool.QueryRow(ctx,
		`SELECT email_verified_at IS NOT NULL FROM app_user WHERE email = 'parallel-confirm@example.com'`).Scan(&verified); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(ctx,
		`SELECT count(*) FROM user_notification n JOIN app_user u ON u.id = n.user_id WHERE u.email = 'parallel-confirm@example.com'`).Scan(&notices); err != nil {
		t.Fatal(err)
	}
	if !verified || notices != 1 {
		t.Fatalf("verified=%v notices=%d, muốn true/1", verified, notices)
	}
}

func TestConcurrentOauthCompleteIssuesOneSession(t *testing.T) {
	fake := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "g-concurrent", Email: "concurrent@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fake})
	fake.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")
	h.csrf()
	if got := statusFromCallback(h.followOAuth("/api/v1/auth/oauth/google/start")); got != "login_ready" {
		t.Fatalf("OAuth callback = %s", got)
	}

	var wg sync.WaitGroup
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			j := cloneAcceptanceJar(h.jar)
			resp := h.doAs(j, http.MethodPost, "/api/v1/auth/oauth/complete", "", true, fmt.Sprintf("198.51.100.%d", 60+i))
			results <- resp.StatusCode
			_ = h.body(resp)
		}()
	}
	wg.Wait()
	close(results)
	var ok, rejected int
	for code := range results {
		if code == http.StatusOK {
			ok++
			continue
		}
		if code == http.StatusBadRequest || code == http.StatusUnauthorized {
			rejected++
			continue
		}
		t.Fatalf("complete cạnh tranh trả %d", code)
	}
	if ok != 1 || rejected != 1 {
		t.Fatalf("muốn 1 thành công + 1 từ chối, được ok=%d rejected=%d", ok, rejected)
	}

	var sessions int
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM session s JOIN app_user u ON u.id = s.user_id WHERE u.email = 'concurrent@example.com'`).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 {
		t.Fatalf("session = %d, muốn 1", sessions)
	}
}
