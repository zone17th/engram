package authhttp_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/authhttp"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/oauth"
)

func noRedirect() *http.Client {
	return &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func (h *harness) followOAuth(startPath string) string {
	h.t.Helper()
	client := noRedirect()
	req, err := http.NewRequest(http.MethodGet, h.srv.URL+startPath, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	h.jar.apply(req)
	resp, err := client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	h.jar.capture(resp)
	if resp.StatusCode != http.StatusFound && resp.StatusCode != http.StatusOK {
		h.t.Fatalf("oauth start = %d %s", resp.StatusCode, h.body(resp))
	}
	loc := resp.Header.Get("Location")
	_ = resp.Body.Close()
	if strings.Contains(loc, "authorization_url") {
		h.t.Fatalf("start trả JSON không phải redirect: %s", loc)
	}

	req2, err := http.NewRequest(http.MethodGet, loc, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	resp2, err := client.Do(req2)
	if err != nil {
		h.t.Fatal(err)
	}
	cb := resp2.Header.Get("Location")
	_ = resp2.Body.Close()

	req3, err := http.NewRequest(http.MethodGet, cb, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	h.jar.apply(req3)
	resp3, err := client.Do(req3)
	if err != nil {
		h.t.Fatal(err)
	}
	h.jar.capture(resp3)
	if resp3.StatusCode != http.StatusSeeOther {
		h.t.Fatalf("callback = %d %s", resp3.StatusCode, h.body(resp3))
	}
	web := resp3.Header.Get("Location")
	_ = resp3.Body.Close()
	return web
}

func (h *harness) followOAuthURL(authURL string) string {
	h.t.Helper()
	client := noRedirect()
	req, err := http.NewRequest(http.MethodGet, authURL, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	cb := resp.Header.Get("Location")
	_ = resp.Body.Close()
	if cb == "" {
		h.t.Fatalf("fake authorize không redirect")
	}
	req, err = http.NewRequest(http.MethodGet, cb, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	h.jar.apply(req)
	resp, err = client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	h.jar.capture(resp)
	if resp.StatusCode != http.StatusSeeOther {
		h.t.Fatalf("callback = %d %s", resp.StatusCode, h.body(resp))
	}
	status := statusFromCallback(resp.Header.Get("Location"))
	_ = resp.Body.Close()
	return status
}

func statusFromCallback(loc string) string {
	const key = "status="
	i := strings.Index(loc, key)
	if i < 0 {
		return ""
	}
	s := loc[i+len(key):]
	if j := strings.IndexAny(s, "&"); j >= 0 {
		s = s[:j]
	}
	return s
}

func (h *harness) grantAs(xff, action, password string) string {
	h.t.Helper()
	resp := h.doAs(h.jar, http.MethodPost, "/api/v1/auth/reauth", `{"action":"`+action+`","password":"`+password+`"}`, true, xff)
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

func (h *harness) withGrantAs(xff, method, path, body, grant string) *http.Response {
	h.t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, h.srv.URL+path, rdr)
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", h.origin)
	req.Header.Set(authhttp.HeaderReauth, grant)
	req.Header.Set("X-Forwarded-For", xff)
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

func TestOauthInvalidCallbackPreservesBindingAndCancelClears(t *testing.T) {
	fake := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "g-cookie", Email: "cookie@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fake})
	fake.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")
	client := noRedirect()

	start := func(j jar, outcome string) string {
		h.t.Helper()
		req, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/v1/auth/oauth/google/start", nil)
		if err != nil {
			h.t.Fatal(err)
		}
		j.apply(req)
		resp, err := client.Do(req)
		if err != nil {
			h.t.Fatal(err)
		}
		j.capture(resp)
		if resp.StatusCode != http.StatusFound {
			h.t.Fatalf("oauth start = %d %s", resp.StatusCode, h.body(resp))
		}
		authURL := resp.Header.Get("Location")
		_ = resp.Body.Close()
		u, err := url.Parse(authURL)
		if err != nil {
			h.t.Fatal(err)
		}
		if outcome != "" {
			q := u.Query()
			q.Set("outcome", outcome)
			u.RawQuery = q.Encode()
		}
		resp, err = client.Get(u.String())
		if err != nil {
			h.t.Fatal(err)
		}
		cb := resp.Header.Get("Location")
		_ = resp.Body.Close()
		if cb == "" {
			h.t.Fatal("fake authorize không redirect")
		}
		return cb
	}

	cbA := start(h.jar, "")
	bindingA := h.jar[authhttp.CookieOAuth].Value
	other := jar{}
	cbB := start(other, "")

	wrongStateURL, err := url.Parse(cbA)
	if err != nil {
		t.Fatal(err)
	}
	wrongStateQuery := wrongStateURL.Query()
	wrongStateQuery.Set("state", "invalid-state")
	wrongStateURL.RawQuery = wrongStateQuery.Encode()
	wrongStateReq, err := http.NewRequest(http.MethodGet, wrongStateURL.String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.apply(wrongStateReq)
	resp, err := client.Do(wrongStateReq)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.capture(resp)
	if statusFromCallback(resp.Header.Get("Location")) != "invalid_flow" {
		t.Fatalf("wrong state callback = %s", resp.Header.Get("Location"))
	}
	_ = resp.Body.Close()
	if got := h.jar[authhttp.CookieOAuth]; got == nil || got.Value != bindingA {
		t.Fatalf("wrong state cleared active cookie: %+v", got)
	}

	wrongReq, err := http.NewRequest(http.MethodGet, cbB, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.apply(wrongReq)
	resp, err = client.Do(wrongReq)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.capture(resp)
	if statusFromCallback(resp.Header.Get("Location")) != "invalid_flow" {
		t.Fatalf("wrong binding callback = %s", resp.Header.Get("Location"))
	}
	_ = resp.Body.Close()
	if got := h.jar[authhttp.CookieOAuth]; got == nil || got.Value != bindingA {
		t.Fatalf("wrong binding cleared active cookie: %+v", got)
	}

	validReq, err := http.NewRequest(http.MethodGet, cbA, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.apply(validReq)
	resp, err = client.Do(validReq)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.capture(resp)
	if statusFromCallback(resp.Header.Get("Location")) != "login_ready" {
		t.Fatalf("valid callback = %s", resp.Header.Get("Location"))
	}
	_ = resp.Body.Close()

	cbCancel := start(h.jar, "cancel")
	cancelReq, err := http.NewRequest(http.MethodGet, cbCancel, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.apply(cancelReq)
	resp, err = client.Do(cancelReq)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.capture(resp)
	if statusFromCallback(resp.Header.Get("Location")) != "cancelled" {
		t.Fatalf("cancel callback = %s", resp.Header.Get("Location"))
	}
	_ = resp.Body.Close()
	if h.jar[authhttp.CookieOAuth] != nil {
		t.Fatal("cancel callback phải xoá OAuth cookie")
	}
}

func TestRevokeOthersRejectsOtherDeviceJWT(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"dev-a@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	b := jar{}
	h.csrfJar(b)
	resp = h.doAs(b, http.MethodPost, "/api/v1/auth/login", `{"email":"dev-a@example.com","password":"correcthorse"}`, true, "203.0.113.20")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login B = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	if b[authhttp.CookieSession] == nil {
		t.Fatal("thiếu session B")
	}

	grant := h.grant("session.revoke_others", "correcthorse")
	resp = h.withGrant(http.MethodPost, "/api/v1/auth/sessions/revoke-others", "", grant)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("revoke-others = %d %s", resp.StatusCode, h.body(resp))
	}
	var out struct {
		Revoked int64 `json:"revoked"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if out.Revoked < 1 {
		t.Fatalf("revoked = %d", out.Revoked)
	}

	resp = h.doAs(b, http.MethodGet, "/api/v1/auth/me", "", false, "203.0.113.20")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("device B sau revoke = %d %s", resp.StatusCode, h.body(resp))
	}
	raw := h.body(resp)
	if !strings.Contains(raw, `"session_invalid"`) || !strings.Contains(raw, `"revoked"`) {
		t.Fatalf("muốn session_invalid revoked, được %s", raw)
	}

	resp = h.doAs(b, http.MethodPatch, "/api/v1/me/settings", `{"theme":"dark"}`, true, "203.0.113.20")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("mutation sau revoke = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
}

func TestEmailChangeConfirmUniquenessRace(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.doAs(h.jar, http.MethodPost, "/api/v1/auth/signup", `{"email":"race-a@example.com","password":"correcthorse"}`, true, "203.0.113.31")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup A = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	grantA := h.grant("account.email_change", "correcthorse")
	resp = h.withGrant(http.MethodPost, "/api/v1/me/email", `{"new_email":"taken-race@example.com"}`, grantA)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("email A = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	entsA, err := h.mail.EntriesFor("taken-race@example.com", "email_change")
	if err != nil || len(entsA) != 1 {
		t.Fatalf("mail A=%d err=%v", len(entsA), err)
	}
	tokA := entsA[0].Link[strings.LastIndex(entsA[0].Link, "token=")+6:]
	sessionA := h.jar[authhttp.CookieSession]
	refreshA := h.jar[authhttp.CookieRefresh]
	csrfA := h.jar[authhttp.CookieCSRF]

	b := jar{}
	h.csrfJar(b)
	resp = h.doAs(b, http.MethodPost, "/api/v1/auth/signup", `{"email":"race-b@example.com","password":"correcthorse"}`, true, "203.0.113.32")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup B = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	oldJar := h.jar
	h.jar = b
	grantB := h.grant("account.email_change", "correcthorse")
	resp = h.withGrant(http.MethodPost, "/api/v1/me/email", `{"new_email":"taken-race@example.com"}`, grantB)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("email B = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	entsB, err := h.mail.EntriesFor("taken-race@example.com", "email_change")
	if err != nil || len(entsB) < 2 {
		t.Fatalf("mail B=%d err=%v", len(entsB), err)
	}
	var tokB string
	for _, ent := range entsB {
		candidate := ent.Link[strings.LastIndex(ent.Link, "token=")+6:]
		if candidate != tokA {
			tokB = candidate
			break
		}
	}
	if tokB == "" {
		t.Fatalf("không tìm token B khác A trong %d mail", len(entsB))
	}
	jarB := h.jar
	h.jar = jar{authhttp.CookieSession: sessionA, authhttp.CookieRefresh: refreshA, authhttp.CookieCSRF: csrfA}
	h.csrf()

	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+tokA+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("confirm A = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	h.jar = jarB
	h.csrf()
	resp = h.do(http.MethodPost, "/api/v1/auth/verify-email/confirm", `{"token":"`+tokB+`"}`, true)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("confirm B muốn email_taken, được %d %s", resp.StatusCode, h.body(resp))
	}
	raw := h.body(resp)
	if !strings.Contains(raw, "email_taken") {
		t.Fatalf("body = %s", raw)
	}
	_ = oldJar
}

func TestUnlinkLastMethodSerialized(t *testing.T) {
	fake := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "g-unlink", Email: "unlink@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fake})
	fake.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")
	h.csrf()
	web := h.followOAuth("/api/v1/auth/oauth/google/start")
	if statusFromCallback(web) != "login_ready" {
		t.Fatalf("callback = %s", web)
	}
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/oauth/complete", "", true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("complete = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodPost, "/api/v1/auth/password/enroll/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("enroll send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	ents, err := h.mail.EntriesFor("unlink@example.com", "password_enroll")
	if err != nil || len(ents) != 1 {
		t.Fatalf("enroll mail=%d err=%v", len(ents), err)
	}
	etok := ents[0].Link[strings.LastIndex(ents[0].Link, "token=")+6:]
	resp = h.do(http.MethodPost, "/api/v1/me/password", `{"new_password":"enrolledpass1","enrollment_token":"`+etok+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("enroll = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	grant := h.grant("account.identity_unlink", "enrolledpass1")
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, provider := range []string{"google", "password"} {
		provider := provider
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, err := http.NewRequest(http.MethodDelete, h.srv.URL+"/api/v1/auth/identities/"+provider, nil)
			if err != nil {
				t.Error(err)
				return
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
				t.Error(err)
				return
			}
			codes <- resp.StatusCode
			_, _ = io.ReadAll(resp.Body)
			_ = resp.Body.Close()
		}()
	}
	wg.Wait()
	close(codes)
	var ok, conflict int
	for c := range codes {
		switch c {
		case http.StatusNoContent:
			ok++
		case http.StatusForbidden:
			conflict++
		default:
			t.Fatalf("unlink status lạ %d", c)
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("muốn 1 unlink + 1 last-method, ok=%d conflict=%d", ok, conflict)
	}

	resp = h.do(http.MethodGet, "/api/v1/auth/me", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("me = %d %s", resp.StatusCode, h.body(resp))
	}
	var me auth.Me
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if len(me.Identities) != 1 {
		t.Fatalf("còn %d identity", len(me.Identities))
	}
}

func TestReauthReceiptReplayAndMissingFreshness(t *testing.T) {
	fake := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "g-reauth", Email: "reauth@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fake})
	fake.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")
	fake.Now = h.clk.Now
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"reauth@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	grant := h.grant("account.identity_link", "correcthorse")
	resp = h.withGrant(http.MethodPost, "/api/v1/auth/oauth/google/link", "", grant)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("link start = %d %s", resp.StatusCode, h.body(resp))
	}
	var linkStart struct {
		URL string `json:"authorization_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&linkStart); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if got := h.followOAuthURL(linkStart.URL); got != "linked" {
		t.Fatalf("link callback = %s", got)
	}

	resp = h.do(http.MethodPost, "/api/v1/auth/oauth/google/reauth", `{"action":"account.password_change"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reauth start = %d %s", resp.StatusCode, h.body(resp))
	}
	var start struct {
		URL string `json:"authorization_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	client := noRedirect()
	req, _ := http.NewRequest(http.MethodGet, start.URL, nil)
	resp2, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
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
	if statusFromCallback(resp3.Header.Get("Location")) != "reauth_ready" {
		t.Fatalf("callback = %s", resp3.Header.Get("Location"))
	}
	_ = resp3.Body.Close()
	if h.jar[authhttp.CookieReauth] == nil {
		t.Fatal("thiếu receipt cookie")
	}

	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/reauth", `{"action":"account.password_change","provider":"google"}`, true, "198.51.100.41")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("exchange receipt = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodPost, "/api/v1/auth/reauth", `{"action":"account.password_change","provider":"google"}`, true)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replay muốn reauth_invalid, được %d %s", resp.StatusCode, h.body(resp))
	}
	raw := h.body(resp)
	if !strings.Contains(raw, "reauth_invalid") {
		t.Fatalf("replay body = %s", raw)
	}

	fake.DropAuthTime = true
	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/oauth/google/reauth", `{"action":"account.email_change"}`, true, "198.51.100.42")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reauth start 2 = %d %s", resp.StatusCode, h.body(resp))
	}
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	req, _ = http.NewRequest(http.MethodGet, start.URL, nil)
	resp2, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	cb = resp2.Header.Get("Location")
	_ = resp2.Body.Close()
	req3, _ = http.NewRequest(http.MethodGet, cb, nil)
	h.jar.apply(req3)
	resp3, err = client.Do(req3)
	if err != nil {
		t.Fatal(err)
	}
	h.jar.capture(resp3)
	if statusFromCallback(resp3.Header.Get("Location")) != "reauth_unavailable" {
		t.Fatalf("thiếu auth_time phải fail-closed, được %s", resp3.Header.Get("Location"))
	}
	_ = resp3.Body.Close()
}

func TestReauthRejectsUnlinkedAndForeignProviderSubjects(t *testing.T) {
	fake := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "g-unlinked", Email: "victim@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fake})
	fake.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")
	fake.Now = h.clk.Now
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"victim@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup victim = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/oauth/google/reauth", `{"action":"account.password_change"}`, true, "203.0.113.43")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reauth unlinked start = %d %s", resp.StatusCode, h.body(resp))
	}
	var start struct {
		URL string `json:"authorization_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if got := h.followOAuthURL(start.URL); got != "reauth_unavailable" {
		t.Fatalf("unlinked subject callback = %s", got)
	}

	grant := h.grant("account.identity_link", "correcthorse")
	resp = h.withGrant(http.MethodPost, "/api/v1/auth/oauth/google/link", "", grant)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("victim link start = %d %s", resp.StatusCode, h.body(resp))
	}
	var linkStart struct {
		URL string `json:"authorization_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&linkStart); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if got := h.followOAuthURL(linkStart.URL); got != "linked" {
		t.Fatalf("victim link callback = %s", got)
	}

	other := jar{}
	h.csrfJar(other)
	resp = h.doAs(other, http.MethodPost, "/api/v1/auth/signup", `{"email":"other@example.com","password":"correcthorse"}`, true, "203.0.113.42")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup other = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	oldJar := h.jar
	h.jar = other
	fake.Identity = oauth.Identity{Provider: "google", UID: "g-foreign", Email: "other@example.com", EmailVerified: true}
	grant = h.grantAs("203.0.113.42", "account.identity_link", "correcthorse")
	resp = h.withGrantAs("203.0.113.42", http.MethodPost, "/api/v1/auth/oauth/google/link", "", grant)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("other link start = %d %s", resp.StatusCode, h.body(resp))
	}
	if err := json.NewDecoder(resp.Body).Decode(&linkStart); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if got := h.followOAuthURL(linkStart.URL); got != "linked" {
		t.Fatalf("other link callback = %s", got)
	}
	h.jar = oldJar

	fake.Identity = oauth.Identity{Provider: "google", UID: "g-foreign", Email: "victim@example.com", EmailVerified: true}
	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/oauth/google/reauth", `{"action":"account.password_change"}`, true, "198.51.100.44")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("foreign reauth start = %d %s", resp.StatusCode, h.body(resp))
	}
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if got := h.followOAuthURL(start.URL); got != "reauth_unavailable" {
		t.Fatalf("foreign subject callback = %s", got)
	}

	fake.Identity = oauth.Identity{Provider: "google", UID: "g-unlinked", Email: "victim@example.com", EmailVerified: true}
	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/oauth/google/reauth", `{"action":"account.password_change"}`, true, "198.51.100.45")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("valid reauth start = %d %s", resp.StatusCode, h.body(resp))
	}
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if got := h.followOAuthURL(start.URL); got != "reauth_ready" {
		t.Fatalf("valid subject callback = %s", got)
	}
	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/reauth", `{"action":"account.password_change","provider":"google"}`, true, "198.51.100.46")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("valid receipt consume = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
}

func TestRevokeSessionRejectsStalePrincipal(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"stale@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	principalA, err := h.svc.Sessions().Authenticate(context.Background(), h.jar[authhttp.CookieSession].Value)
	if err != nil {
		t.Fatal(err)
	}

	b := jar{}
	h.csrfJar(b)
	resp = h.doAs(b, http.MethodPost, "/api/v1/auth/login", `{"email":"stale@example.com","password":"correcthorse"}`, true, "203.0.113.51")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login B = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	principalB, err := h.svc.Sessions().Authenticate(context.Background(), b[authhttp.CookieSession].Value)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := h.svc.RevokeSession(context.Background(), principalB, principalA.SessionID); err != nil {
		t.Fatalf("revoke A = %v", err)
	}
	if _, err := h.svc.RevokeSession(context.Background(), principalA, principalB.SessionID); err == nil {
		t.Fatal("stale principal revoked another session")
	} else if de, ok := auth.AsError(err); !ok || de.Code != "session_invalid" {
		t.Fatalf("stale principal error = %v", err)
	}
	if _, err := h.svc.Sessions().Authenticate(context.Background(), b[authhttp.CookieSession].Value); err != nil {
		t.Fatalf("session B bị revoke bởi principal stale: %v", err)
	}
}

func TestChangePasswordRejectsExpiredPrincipalSession(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"expired@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	principal, err := h.svc.Sessions().Authenticate(context.Background(), h.jar[authhttp.CookieSession].Value)
	if err != nil {
		t.Fatal(err)
	}
	h.clk.Advance(auth.SessionTTL + time.Second)
	grant, err := h.svc.Grants().Issue(principal, "account.password_change")
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = h.svc.ChangePassword(context.Background(), principal, "newpassword12", "", grant.Grant, "", "")
	if err == nil {
		t.Fatal("expired principal changed password")
	}
	de, ok := auth.AsError(err)
	if !ok || de.Code != "session_invalid" || de.Reason != "expired" {
		t.Fatalf("expired principal error = %v", err)
	}
}

func TestOauthLinkAndGithubReauthUnsupported(t *testing.T) {
	google := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "g-link", Email: "linkg@example.com", EmailVerified: true,
	})
	github := oauth.NewFake("github", false, oauth.Identity{
		Provider: "github", UID: "gh-1", Email: "linkgh@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{google, github})
	google.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"haspw@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodPost, "/api/v1/auth/oauth/github/reauth", `{"action":"account.password_change"}`, true)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("github reauth = %d %s", resp.StatusCode, h.body(resp))
	}
	raw := h.body(resp)
	if !strings.Contains(raw, "reauth_unsupported_provider") {
		t.Fatalf("body = %s", raw)
	}

	grant := h.grant("account.identity_link", "correcthorse")
	resp = h.withGrant(http.MethodPost, "/api/v1/auth/oauth/google/link", "", grant)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("link start = %d %s", resp.StatusCode, h.body(resp))
	}
	var start struct {
		URL string `json:"authorization_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	client := noRedirect()
	req, _ := http.NewRequest(http.MethodGet, start.URL, nil)
	resp2, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
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
	if statusFromCallback(resp3.Header.Get("Location")) != "linked" {
		t.Fatalf("link callback = %s body=%s", resp3.Header.Get("Location"), h.body(resp3))
	}
	_ = resp3.Body.Close()

	resp = h.do(http.MethodGet, "/api/v1/auth/me", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("me = %d %s", resp.StatusCode, h.body(resp))
	}
	var me auth.Me
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if len(me.Identities) != 2 {
		t.Fatalf("identities = %+v", me.Identities)
	}

	resp = h.do(http.MethodPost, "/api/v1/auth/oauth/google/link", "", true)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("link thiếu grant = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
}

func TestRefreshWithoutAccessCookie(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"noaccess@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	delete(h.jar, authhttp.CookieSession)
	resp = h.do(http.MethodPost, "/api/v1/auth/refresh", "", true)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("refresh không access = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	if h.jar[authhttp.CookieSession] == nil {
		t.Fatal("refresh phải cấp lại sabk_session")
	}
}

func TestLockoutCrossIPSameShape(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	for i := 0; i < 5; i++ {
		xff := []string{"203.0.113.11", "203.0.113.12", "203.0.113.13", "203.0.113.14", "203.0.113.15"}[i]
		resp := h.doAs(h.jar, http.MethodPost, "/api/v1/auth/login", `{"email":"ghost@example.com","password":"wrongpassword"}`, true, xff)
		if resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusTooManyRequests {
			t.Fatalf("lần %d = %d %s", i+1, resp.StatusCode, h.body(resp))
		}
		_ = resp.Body.Close()
	}
	resp := h.doAs(h.jar, http.MethodPost, "/api/v1/auth/login", `{"email":"ghost@example.com","password":"wrongpassword"}`, true, "203.0.113.80")
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("cross-IP lockout = %d %s", resp.StatusCode, h.body(resp))
	}
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("thiếu Retry-After")
	}
	raw := h.body(resp)
	if strings.Contains(raw, "ghost@example.com") {
		t.Fatalf("lộ email: %s", raw)
	}
}
