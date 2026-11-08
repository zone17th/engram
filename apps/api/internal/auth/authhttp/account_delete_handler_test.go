package authhttp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/auth/oauth"
	"github.com/zone17th/engram/apps/api/internal/httpx"
)

type delOpts struct {
	csrf        bool
	grant       string
	idemKey     string
	origin      string // "-" omits Origin; "" uses h.origin
	contentType string // "" uses application/json
	useJar      jar    // nil uses h.jar
}

func (h *harness) deleteMeResp(body string, o delOpts) *http.Response {
	h.t.Helper()
	req, err := http.NewRequest(http.MethodDelete, h.srv.URL+"/api/v1/me", bytes.NewBufferString(body))
	if err != nil {
		h.t.Fatal(err)
	}
	ct := o.contentType
	if ct == "" {
		ct = "application/json"
	}
	req.Header.Set("Content-Type", ct)
	switch o.origin {
	case "-":
	case "":
		req.Header.Set("Origin", h.origin)
	default:
		req.Header.Set("Origin", o.origin)
	}
	if o.idemKey != "" {
		req.Header.Set(httpx.HeaderIdempotencyKey, o.idemKey)
	}
	if o.grant != "" {
		req.Header.Set(authhttp.HeaderReauth, o.grant)
	}
	j := h.jar
	if o.useJar != nil {
		j = o.useJar
	}
	if c := j[authhttp.CookieCSRF]; o.csrf && c != nil {
		req.Header.Set(authhttp.HeaderCSRF, c.Value)
	}
	j.apply(req)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	j.capture(resp)
	return resp
}

func (h *harness) deleteMe(body string, o delOpts) (int, string) {
	h.t.Helper()
	resp := h.deleteMeResp(body, o)
	return resp.StatusCode, h.body(resp)
}

func problemCode(t *testing.T, raw string) string {
	t.Helper()
	var p struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal([]byte(raw), &p)
	return p.Code
}

// TestDeleteAccount_SecurityGates exercises every mounted gate on DELETE
// /api/v1/me (origin, session, CSRF, JSON content-type, Idempotency-Key
// missing/invalid/conflict, re-auth missing/wrong-action/malformed/expired/
// other-session, vault_sensitive rate limit 429 + Retry-After, and
// confirm_email mismatch) and verifies that none of them deletes the user;
// the valid request returns 204, clears auth cookies and removes the user.
func TestDeleteAccount_SecurityGates(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"Del.Me@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	body := `{"confirm_email":"  del.me@EXAMPLE.com "}`

	// 1. Origin gate: missing or cross-origin is rejected with 403 csrf_invalid.
	code, raw := h.deleteMe(body, delOpts{csrf: true, origin: "-", grant: h.grant("account.delete", "correcthorse"), idemKey: "idem-accdel-noorigin01"})
	if code != http.StatusForbidden || problemCode(t, raw) != "csrf_invalid" {
		t.Fatalf("missing Origin = %d %s, want 403 csrf_invalid", code, raw)
	}
	code, raw = h.deleteMe(body, delOpts{csrf: true, origin: "https://evil.example", grant: h.grant("account.delete", "correcthorse"), idemKey: "idem-accdel-badorigin1"})
	if code != http.StatusForbidden || problemCode(t, raw) != "csrf_invalid" {
		t.Fatalf("cross Origin = %d %s, want 403 csrf_invalid", code, raw)
	}

	// 2. Session gate: absent session and revoked session both return 401.
	noSessJar := jar{}
	h.csrfJar(noSessJar)
	code, raw = h.deleteMe(body, delOpts{csrf: true, useJar: noSessJar, grant: h.grant("account.delete", "correcthorse"), idemKey: "idem-accdel-nosession1"})
	if code != http.StatusUnauthorized || problemCode(t, raw) != "unauthenticated" {
		t.Fatalf("absent session = %d %s, want 401 unauthenticated", code, raw)
	}
	revokedJar := jar{}
	h.csrfJar(revokedJar)
	loginResp := h.doAs(revokedJar, http.MethodPost, "/api/v1/auth/login", `{"email":"del.me@example.com","password":"correcthorse"}`, true, "")
	if loginResp.StatusCode != http.StatusOK {
		t.Fatalf("second login = %d %s", loginResp.StatusCode, h.body(loginResp))
	}
	_ = loginResp.Body.Close()
	savedSession := revokedJar[authhttp.CookieSession]
	logoutResp := h.doAs(revokedJar, http.MethodPost, "/api/v1/auth/logout", "", true, "")
	if logoutResp.StatusCode != http.StatusNoContent {
		t.Fatalf("logout = %d", logoutResp.StatusCode)
	}
	_ = logoutResp.Body.Close()
	revokedJar[authhttp.CookieSession] = savedSession
	h.csrfJar(revokedJar)
	code, raw = h.deleteMe(body, delOpts{csrf: true, useJar: revokedJar, grant: h.grant("account.delete", "correcthorse"), idemKey: "idem-accdel-revoked001"})
	if code != http.StatusUnauthorized || problemCode(t, raw) != "session_invalid" {
		t.Fatalf("revoked session = %d %s, want 401 session_invalid", code, raw)
	}

	// 3. CSRF gate: missing CSRF header returns 403 csrf_invalid.
	code, raw = h.deleteMe(body, delOpts{csrf: false, grant: h.grant("account.delete", "correcthorse"), idemKey: "idem-accdel-nocsrf-01"})
	if code != http.StatusForbidden || problemCode(t, raw) != "csrf_invalid" {
		t.Fatalf("no CSRF = %d %s, want 403 csrf_invalid", code, raw)
	}

	// 4. Content-Type gate: non-JSON body returns 400 invalid_request.
	code, raw = h.deleteMe(body, delOpts{csrf: true, contentType: "text/plain", grant: h.grant("account.delete", "correcthorse"), idemKey: "idem-accdel-nonjson01"})
	if code != http.StatusBadRequest || problemCode(t, raw) != "invalid_request" {
		t.Fatalf("text/plain = %d %s, want 400 invalid_request", code, raw)
	}

	// 5. Idempotency-Key gate: missing key, too-short key, and in-progress conflict.
	code, raw = h.deleteMe(body, delOpts{csrf: true, grant: h.grant("account.delete", "correcthorse")})
	if code != http.StatusBadRequest || problemCode(t, raw) != "invalid_request" {
		t.Fatalf("missing Idempotency-Key = %d %s, want 400 invalid_request", code, raw)
	}
	code, raw = h.deleteMe(body, delOpts{csrf: true, grant: h.grant("account.delete", "correcthorse"), idemKey: "short"})
	if code != http.StatusBadRequest || problemCode(t, raw) != "invalid_request" {
		t.Fatalf("short Idempotency-Key = %d %s, want 400 invalid_request", code, raw)
	}
	if _, err := h.pool.Exec(context.Background(), `
INSERT INTO idempotency_key (user_id, key, method, path, request_hash, status, owner_token, claimed_at, expires_at)
SELECT id, 'idem-accdel-conflict01', 'DELETE', '/api/v1/me', '\x00'::bytea, 'in_progress', gen_random_uuid(), $1, $2
FROM app_user WHERE email = 'del.me@example.com'`, h.clk.Now(), h.clk.Now().Add(15*time.Minute)); err != nil {
		t.Fatalf("seed in_progress idempotency_key: %v", err)
	}
	code, raw = h.deleteMe(body, delOpts{csrf: true, grant: h.grant("account.delete", "correcthorse"), idemKey: "idem-accdel-conflict01"})
	if code != http.StatusConflict || problemCode(t, raw) != "idempotency_conflict" {
		t.Fatalf("conflicting Idempotency-Key = %d %s, want 409 idempotency_conflict", code, raw)
	}

	// 6. Re-auth gate: missing, wrong-action, malformed, other-session/user, and expired grant.
	code, raw = h.deleteMe(body, delOpts{csrf: true, idemKey: "idem-accdel-nogrant-01"})
	if code != http.StatusUnauthorized || problemCode(t, raw) != "reauth_required" {
		t.Fatalf("no grant = %d %s, want 401 reauth_required", code, raw)
	}
	code, raw = h.deleteMe(body, delOpts{csrf: true, grant: h.grant("vault.reset", "correcthorse"), idemKey: "idem-accdel-wrongact-1"})
	if code != http.StatusUnauthorized || problemCode(t, raw) != "reauth_invalid" {
		t.Fatalf("wrong-action grant = %d %s, want 401 reauth_invalid", code, raw)
	}
	code, raw = h.deleteMe(body, delOpts{csrf: true, grant: "garbage.grant", idemKey: "idem-accdel-badgrant-1"})
	if code != http.StatusUnauthorized || problemCode(t, raw) != "reauth_invalid" {
		t.Fatalf("garbage grant = %d %s, want 401 reauth_invalid", code, raw)
	}
	otherJar := jar{}
	h.csrfJar(otherJar)
	otherSignup := h.doAs(otherJar, http.MethodPost, "/api/v1/auth/signup", `{"email":"other-user@example.com","password":"correcthorse"}`, true, "")
	if otherSignup.StatusCode != http.StatusCreated {
		t.Fatalf("other signup = %d %s", otherSignup.StatusCode, h.body(otherSignup))
	}
	_ = otherSignup.Body.Close()
	otherReauth := h.doAs(otherJar, http.MethodPost, "/api/v1/auth/reauth", `{"action":"account.delete","password":"correcthorse"}`, true, "")
	if otherReauth.StatusCode != http.StatusOK {
		t.Fatalf("other reauth = %d %s", otherReauth.StatusCode, h.body(otherReauth))
	}
	var otherGrantObj auth.ReauthGrant
	if err := json.NewDecoder(otherReauth.Body).Decode(&otherGrantObj); err != nil {
		t.Fatal(err)
	}
	_ = otherReauth.Body.Close()
	otherGrant := otherGrantObj.Grant
	code, raw = h.deleteMe(body, delOpts{csrf: true, grant: otherGrant, idemKey: "idem-accdel-othergrnt1"})
	if code != http.StatusUnauthorized || problemCode(t, raw) != "reauth_invalid" {
		t.Fatalf("other-user/session grant = %d %s, want 401 reauth_invalid", code, raw)
	}
	expGrant := h.grant("account.delete", "correcthorse")
	h.clk.Advance(6 * time.Minute)
	code, raw = h.deleteMe(body, delOpts{csrf: true, grant: expGrant, idemKey: "idem-accdel-expgrant01"})
	if code != http.StatusUnauthorized || problemCode(t, raw) != "reauth_invalid" {
		t.Fatalf("expired grant = %d %s, want 401 reauth_invalid", code, raw)
	}

	// 7. Wrong confirm_email (400 account_delete_confirm_invalid) and rate limit
	// vault_sensitive (5 requests / 10m -> 6th returns 429 rate_limited + Retry-After).
	for i := 1; i <= 5; i++ {
		code, raw = h.deleteMe(`{"confirm_email":"other@example.com"}`, delOpts{
			csrf:    true,
			grant:   h.grant("account.delete", "correcthorse"),
			idemKey: "idem-accdel-wrongmail" + string(rune('0'+i)),
		})
		if code != http.StatusBadRequest || problemCode(t, raw) != "account_delete_confirm_invalid" {
			t.Fatalf("attempt %d wrong email = %d %s, want 400 account_delete_confirm_invalid", i, code, raw)
		}
	}
	rlResp := h.deleteMeResp(body, delOpts{
		csrf:    true,
		grant:   h.grant("account.delete", "correcthorse"),
		idemKey: "idem-accdel-ratelimit6",
	})
	rlRaw := h.body(rlResp)
	if rlResp.StatusCode != http.StatusTooManyRequests || problemCode(t, rlRaw) != "rate_limited" {
		t.Fatalf("6th request in 10m window = %d %s, want 429 rate_limited", rlResp.StatusCode, rlRaw)
	}
	if rlResp.Header.Get("Retry-After") == "" {
		t.Fatal("429 rate_limited must set Retry-After header")
	}

	var users int
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM app_user`).Scan(&users); err != nil || users != 2 {
		t.Fatalf("users after rejected requests = %d (%v), want 2", users, err)
	}

	// Advance past the 10-minute vault_sensitive window and execute valid delete.
	h.clk.Advance(11 * time.Minute)
	code, raw = h.deleteMe(body, delOpts{csrf: true, grant: h.grant("account.delete", "correcthorse"), idemKey: "idem-accdel-success-01"})
	if code != http.StatusNoContent {
		t.Fatalf("delete = %d %s, want 204", code, raw)
	}
	if h.jar[authhttp.CookieSession] != nil || h.jar[authhttp.CookieRefresh] != nil {
		t.Fatal("204 must clear session and refresh cookies")
	}
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM app_user WHERE email = 'del.me@example.com'`).Scan(&users); err != nil || users != 0 {
		t.Fatalf("deleted user after delete = %d (%v), want 0", users, err)
	}
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM app_user WHERE email = 'other-user@example.com'`).Scan(&users); err != nil || users != 1 {
		t.Fatalf("other user after delete = %d (%v), want 1", users, err)
	}
	var auditNull int
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE event = 'account.delete' AND user_id IS NULL AND result = 'success' AND meta = '{}'::jsonb`,
	).Scan(&auditNull); err != nil || auditNull != 1 {
		t.Fatalf("account.delete audit rows = %d (%v), want 1 with user_id NULL and meta {}", auditNull, err)
	}

	resp = h.do(http.MethodGet, "/api/v1/auth/me", "", false)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me after delete = %d, want 401", resp.StatusCode)
	}
	_ = resp.Body.Close()
}

// TestDeleteAccount_OAuthLoginTransactionsRemoved verifies R1-1: when an OAuth
// login flow has stored the user's provider UID/email in oauth_transaction with
// NULL expected_user_id and expected_session_id (both completed and unconsumed
// ready login rows), DELETE /api/v1/me deletes those rows in the shared tx and
// POST /api/v1/auth/oauth/complete with the pre-delete binding fails closed
// instead of recreating the user or issuing a session.
func TestDeleteAccount_OAuthLoginTransactionsRemoved(t *testing.T) {
	fake := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "g-del-login-1", Email: "oauth-del@example.com", EmailVerified: true,
	})
	h := newHarness(t, []oauth.Provider{fake})
	fake.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")

	// 1. Sign up via Google OAuth (leaves a completed login oauth_transaction with NULL expected FKs).
	h.csrf()
	if got := statusFromCallback(h.followOAuth("/api/v1/auth/oauth/google/start")); got != "login_ready" {
		t.Fatalf("initial oauth callback = %s, want login_ready", got)
	}
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/oauth/complete", "", true)
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		t.Fatalf("oauth complete = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	// Enroll a password so we can obtain a password reauth grant for account.delete.
	resp = h.do(http.MethodPost, "/api/v1/auth/password/enroll/send", "", true)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("enroll send = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	ents, err := h.mail.EntriesFor("oauth-del@example.com", "password_enroll")
	if err != nil || len(ents) != 1 {
		t.Fatalf("enroll mail = %d (%v)", len(ents), err)
	}
	const tokPrefix = "token="
	idx := bytes.LastIndex([]byte(ents[0].Link), []byte(tokPrefix))
	if idx < 0 {
		t.Fatalf("missing token in link %q", ents[0].Link)
	}
	etok := ents[0].Link[idx+len(tokPrefix):]
	resp = h.do(http.MethodPost, "/api/v1/me/password", `{"new_password":"enrolledpass1","enrollment_token":"`+etok+`"}`, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("enroll password = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	// 2. Start a second login-mode OAuth flow in a separate browser jar and
	// drive its callback to status='ready' (expected_user_id/session_id NULL).
	loginJar := jar{}
	client := noRedirect()
	req, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/v1/auth/oauth/google/start", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	loginJar.capture(resp)
	authURL := resp.Header.Get("Location")
	_ = resp.Body.Close()
	resp, err = client.Get(authURL)
	if err != nil {
		t.Fatal(err)
	}
	cbURL := resp.Header.Get("Location")
	_ = resp.Body.Close()
	cbReq, err := http.NewRequest(http.MethodGet, cbURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	loginJar.apply(cbReq)
	resp, err = client.Do(cbReq)
	if err != nil {
		t.Fatal(err)
	}
	loginJar.capture(resp)
	if got := statusFromCallback(resp.Header.Get("Location")); got != "login_ready" {
		t.Fatalf("second login callback = %s, want login_ready", got)
	}
	_ = resp.Body.Close()

	var preTxCount int
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM oauth_transaction WHERE identity_provider_uid = 'g-del-login-1' OR identity_email = 'oauth-del@example.com'`,
	).Scan(&preTxCount); err != nil || preTxCount < 2 {
		t.Fatalf("pre-delete oauth_transaction count = %d (%v), want >= 2", preTxCount, err)
	}

	// 3. Delete the account via DELETE /api/v1/me.
	code, raw := h.deleteMe(`{"confirm_email":"oauth-del@example.com"}`, delOpts{
		csrf:    true,
		grant:   h.grant("account.delete", "enrolledpass1"),
		idemKey: "idem-accdel-oauth-login1",
	})
	if code != http.StatusNoContent {
		t.Fatalf("DELETE /me = %d %s, want 204", code, raw)
	}

	var postTxCount int
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM oauth_transaction WHERE identity_provider_uid = 'g-del-login-1' OR identity_email = 'oauth-del@example.com'`,
	).Scan(&postTxCount); err != nil || postTxCount != 0 {
		t.Fatalf("post-delete oauth_transaction count = %d (%v), want 0", postTxCount, err)
	}

	// 4. Attempting to complete the pre-delete ready login binding fails and
	// does not recreate the deleted user.
	h.csrfJar(loginJar)
	compResp := h.doAs(loginJar, http.MethodPost, "/api/v1/auth/oauth/complete", "", true, "")
	compRaw := h.body(compResp)
	if compResp.StatusCode != http.StatusBadRequest || problemCode(t, compRaw) != "oauth_state_invalid" {
		t.Fatalf("oauth/complete after delete = %d %s, want 400 oauth_state_invalid", compResp.StatusCode, compRaw)
	}
	var users int
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM app_user`).Scan(&users); err != nil || users != 0 {
		t.Fatalf("app_user count after rejected oauth/complete = %d (%v), want 0", users, err)
	}
}
