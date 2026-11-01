package authhttp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/auth/oauth"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

type jar map[string]*http.Cookie

func (j jar) apply(req *http.Request) {
	for _, c := range j {
		req.AddCookie(&http.Cookie{Name: c.Name, Value: c.Value})
	}
}

func (j jar) capture(resp *http.Response) {
	for _, c := range resp.Cookies() {
		if c.MaxAge < 0 || c.Value == "" {
			delete(j, c.Name)
			continue
		}
		j[c.Name] = c
	}
}

type harness struct {
	t      *testing.T
	srv    *httptest.Server
	jar    jar
	origin string
	clk    *clock.Fixed
	mail   *auth.SinkMailer
	svc    *auth.Service
	pool   *pgxpool.Pool
}

func newHarness(t *testing.T, providers []oauth.Provider) *harness {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://" + ln.Addr().String()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", origin)
	t.Setenv("APP_ENV", "development")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	mail, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc, _, api, err := compose.NewAuth(cfg, pool, nil, clk, mail, providers)
	if err != nil {
		t.Fatal(err)
	}
	authn, csrfv, reauth := compose.Adapters(svc)
	hnd := httpx.NewRouter(httpx.Deps{
		Config:        cfg,
		Logger:        obs.NewLogger("error", "test"),
		Ready:         func(context.Context) error { return nil },
		Metrics:       promhttp.Handler(),
		Authenticator: authn,
		CSRF:          csrfv,
		Reauth:        reauth,
		MountAPI:      authhttp.Mount(api),
	})
	srv := httptest.NewUnstartedServer(hnd)
	_ = srv.Listener.Close()
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	return &harness{t: t, srv: srv, jar: jar{}, origin: origin, clk: clk, mail: mail, svc: svc, pool: pool}
}

func (h *harness) do(method, path, body string, withCSRF bool) *http.Response {
	h.t.Helper()
	return h.doAs(h.jar, method, path, body, withCSRF, "")
}

func (h *harness) doAs(j jar, method, path, body string, withCSRF bool, xff string) *http.Response {
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
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", h.origin)
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
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	j.capture(resp)
	return resp
}

func (h *harness) csrfJar(j jar) {
	h.t.Helper()
	resp := h.doAs(j, http.MethodGet, "/api/v1/auth/csrf", "", false, "")
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNoContent {
		b, _ := io.ReadAll(resp.Body)
		h.t.Fatalf("csrf = %d %s", resp.StatusCode, b)
	}
}

func (h *harness) grant(action, password string) string {
	h.t.Helper()
	resp := h.do(http.MethodPost, "/api/v1/auth/reauth", `{"action":"`+action+`","password":"`+password+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("reauth %s = %d %s", action, resp.StatusCode, h.body(resp))
	}
	var g auth.ReauthGrant
	if err := json.NewDecoder(resp.Body).Decode(&g); err != nil {
		h.t.Fatal(err)
	}
	_ = resp.Body.Close()
	return g.Grant
}

func (h *harness) withGrant(method, path, body, grant string) *http.Response {
	h.t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = bytes.NewBufferString(body)
	}
	req, err := http.NewRequest(method, h.srv.URL+path, rdr)
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", h.origin)
	req.Header.Set(authhttp.HeaderReauth, grant)
	if c := h.jar[authhttp.CookieCSRF]; c != nil {
		req.Header.Set(authhttp.HeaderCSRF, c.Value)
	}
	h.jar.apply(req)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	h.jar.capture(resp)
	return resp
}

func (h *harness) csrf() {
	h.t.Helper()
	resp := h.do(http.MethodGet, "/api/v1/auth/csrf", "", false)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNoContent {
		b, _ := io.ReadAll(resp.Body)
		h.t.Fatalf("csrf = %d %s", resp.StatusCode, b)
	}
	c := h.jar[authhttp.CookieCSRF]
	if c == nil || !c.Secure || c.HttpOnly || c.SameSite != http.SameSiteLaxMode {
		h.t.Fatalf("cookie csrf flags: %+v", c)
	}
}

func (h *harness) body(resp *http.Response) string {
	b, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	return string(b)
}

func TestPasswordSignupLoginMeRefreshLogout(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"user@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	var me auth.Me
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if me.Vault.Status != "absent" || me.User.Email == "" {
		t.Fatalf("me = %+v", me)
	}
	if h.jar[authhttp.CookieSession] == nil || !h.jar[authhttp.CookieSession].HttpOnly {
		t.Fatal("thiếu sabk_session HttpOnly")
	}
	if h.jar[authhttp.CookieRefresh] == nil || h.jar[authhttp.CookieRefresh].Path != authhttp.PathAuth {
		t.Fatal("refresh path")
	}

	resp = h.do(http.MethodGet, "/api/v1/auth/me", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("me = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodPost, "/api/v1/auth/refresh", "", true)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("refresh = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodGet, "/api/v1/auth/config", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("config = %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodPost, "/api/v1/auth/logout", "", true)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("logout = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	if h.jar[authhttp.CookieSession] != nil {
		t.Fatal("logout phải xoá session cookie")
	}

	h.csrf()
	resp = h.do(http.MethodGet, "/api/v1/auth/me", "", false)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("signed-out me = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	h.csrf()
	resp = h.do(http.MethodPost, "/api/v1/auth/login", `{"email":"user@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodPost, "/api/v1/auth/login", `{"email":"nobody@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad login = %d %s", resp.StatusCode, h.body(resp))
	}
	raw := h.body(resp)
	if strings.Contains(raw, "nobody@example.com") || strings.Contains(raw, "correcthorse") {
		t.Fatalf("lỗi lộ credential: %s", raw)
	}
}

func TestSettingsAndSessionsHTTP(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"set@example.com","password":"correcthorse","locale":"vi"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodPatch, "/api/v1/me/settings", `{"theme":"dark"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("settings = %d %s", resp.StatusCode, h.body(resp))
	}
	var me auth.Me
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if me.Settings.Theme != "dark" || me.Settings.Locale != "vi" {
		t.Fatalf("partial patch: %+v", me.Settings)
	}

	resp = h.do(http.MethodPatch, "/api/v1/me/settings", `{"semantic_suggest":true}`, true)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("semantic unavailable = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodGet, "/api/v1/auth/sessions", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sessions = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodGet, "/api/v1/auth/audit", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("audit = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
}

func TestReauthGrantAndPasswordChange(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"pw@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodPost, "/api/v1/auth/reauth", `{"action":"account.password_change","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reauth = %d %s", resp.StatusCode, h.body(resp))
	}
	var grant auth.ReauthGrant
	if err := json.NewDecoder(resp.Body).Decode(&grant); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+"/api/v1/me/password", bytes.NewBufferString(`{"new_password":"newpassword12"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", h.origin)
	req.Header.Set(authhttp.HeaderReauth, grant.Grant)
	if c := h.jar[authhttp.CookieCSRF]; c != nil {
		req.Header.Set(authhttp.HeaderCSRF, c.Value)
	}
	h.jar.apply(req)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.capture(resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("password = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
}

func TestLoginLockoutSameShape(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	var last int
	var lastBody string
	for i := 0; i < 5; i++ {
		resp := h.do(http.MethodPost, "/api/v1/auth/login", `{"email":"missing@example.com","password":"wrongpassword"}`, true)
		last = resp.StatusCode
		lastBody = h.body(resp)
	}
	if last != http.StatusTooManyRequests && last != http.StatusUnauthorized {
		t.Fatalf("sau 5 lần sai status=%d %s", last, lastBody)
	}
	resp := h.do(http.MethodPost, "/api/v1/auth/login", `{"email":"missing@example.com","password":"wrongpassword"}`, true)
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("lần 6 muốn 429, được %d %s", resp.StatusCode, h.body(resp))
	}
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("thiếu Retry-After")
	}
	_ = resp.Body.Close()
}

func TestVerifyEmailSendAndConfirm(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"v@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	ents, err := h.mail.EntriesFor("v@example.com", "signup")
	if err != nil || len(ents) != 1 {
		t.Fatalf("mail entries=%d err=%v", len(ents), err)
	}
	token := ents[0].Link[strings.LastIndex(ents[0].Link, "token=")+6:]
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+token+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("confirm = %d %s", resp.StatusCode, h.body(resp))
	}
	var me auth.Me
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if !me.User.EmailVerified {
		t.Fatal("email phải verified")
	}
}

func TestOauthFakeLoginComplete(t *testing.T) {
	fake := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "g-1", Email: "g@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fake})
	fake.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")

	h.csrf()
	req, _ := http.NewRequest(http.MethodGet, h.srv.URL+"/api/v1/auth/oauth/google/start", nil)
	h.jar.apply(req)
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.capture(resp)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("start = %d %s", resp.StatusCode, h.body(resp))
	}
	loc := resp.Header.Get("Location")
	_ = resp.Body.Close()

	req2, _ := http.NewRequest(http.MethodGet, loc, nil)
	resp2, err := client.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	if resp2.StatusCode != http.StatusFound {
		t.Fatalf("fake authorize = %d", resp2.StatusCode)
	}
	cb := resp2.Header.Get("Location")
	_ = resp2.Body.Close()

	req3, _ := http.NewRequest(http.MethodGet, cb, nil)
	h.jar.apply(req3)
	resp3, err := client.Do(req3)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.capture(resp3)
	if resp3.StatusCode != http.StatusSeeOther {
		t.Fatalf("callback = %d %s", resp3.StatusCode, h.body(resp3))
	}
	if !strings.Contains(resp3.Header.Get("Location"), "status=login_ready") {
		t.Fatalf("redirect = %s", resp3.Header.Get("Location"))
	}
	_ = resp3.Body.Close()

	h.csrf()
	resp = h.do(http.MethodPost, "/api/v1/auth/oauth/complete", "", true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("complete = %d %s", resp.StatusCode, h.body(resp))
	}
	var me auth.Me
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if me.User.Email != "g@example.com" || me.Vault.Status != "absent" {
		t.Fatalf("oauth me = %+v", me)
	}
	if !me.Features.PasswordEnrollmentAvailable {
		t.Fatal("OAuth-only verified phải enroll được")
	}
	resp = h.do(http.MethodPost, "/api/v1/auth/password/enroll/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("enroll send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	ents, err := h.mail.EntriesFor("g@example.com", "password_enroll")
	if err != nil || len(ents) != 1 {
		t.Fatalf("enroll mail=%d err=%v", len(ents), err)
	}
	etok := ents[0].Link[strings.LastIndex(ents[0].Link, "token=")+6:]
	resp = h.do(http.MethodPost, "/api/v1/me/password", `{"new_password":"enrolledpass1","enrollment_token":"`+etok+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("enroll password = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
}
