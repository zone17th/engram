package authhttp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/httpx"
)

type delOpts struct {
	csrf    bool
	grant   string
	idemKey string
}

func (h *harness) deleteMe(body string, o delOpts) (int, string) {
	h.t.Helper()
	req, err := http.NewRequest(http.MethodDelete, h.srv.URL+"/api/v1/me", bytes.NewBufferString(body))
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", h.origin)
	if o.idemKey != "" {
		req.Header.Set(httpx.HeaderIdempotencyKey, o.idemKey)
	}
	if o.grant != "" {
		req.Header.Set(authhttp.HeaderReauth, o.grant)
	}
	if c := h.jar[authhttp.CookieCSRF]; o.csrf && c != nil {
		req.Header.Set(authhttp.HeaderCSRF, c.Value)
	}
	h.jar.apply(req)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	h.jar.capture(resp)
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

// TestDeleteAccount_SecurityGates: DELETE /me rejects a missing CSRF token
// (403), a missing or wrong-action re-auth grant (401 reauth_required /
// reauth_invalid) and a wrong confirm_email (400) without deleting anything;
// the correct request returns 204, clears the auth cookies and removes the
// user.
func TestDeleteAccount_SecurityGates(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"Del.Me@example.com","password":"correcthorse"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	body := `{"confirm_email":"  del.me@EXAMPLE.com "}`

	code, raw := h.deleteMe(body, delOpts{csrf: false, grant: h.grant("account.delete", "correcthorse"), idemKey: "idem-accdel-nocsrf-01"})
	if code != http.StatusForbidden || problemCode(t, raw) != "csrf_invalid" {
		t.Fatalf("no CSRF = %d %s, want 403 csrf_invalid", code, raw)
	}

	code, raw = h.deleteMe(body, delOpts{csrf: true, idemKey: "idem-accdel-nograin-01"})
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

	code, raw = h.deleteMe(`{"confirm_email":"other@example.com"}`, delOpts{csrf: true, grant: h.grant("account.delete", "correcthorse"), idemKey: "idem-accdel-wrongmail1"})
	if code != http.StatusBadRequest || problemCode(t, raw) != "account_delete_confirm_invalid" {
		t.Fatalf("wrong email = %d %s, want 400 account_delete_confirm_invalid", code, raw)
	}

	var users int
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM app_user`).Scan(&users); err != nil || users != 1 {
		t.Fatalf("users after rejected requests = %d (%v), want 1", users, err)
	}

	code, raw = h.deleteMe(body, delOpts{csrf: true, grant: h.grant("account.delete", "correcthorse"), idemKey: "idem-accdel-success-01"})
	if code != http.StatusNoContent {
		t.Fatalf("delete = %d %s, want 204", code, raw)
	}
	if h.jar[authhttp.CookieSession] != nil || h.jar[authhttp.CookieRefresh] != nil {
		t.Fatal("204 must clear session and refresh cookies")
	}
	if err := h.pool.QueryRow(context.Background(), `SELECT count(*) FROM app_user`).Scan(&users); err != nil || users != 0 {
		t.Fatalf("users after delete = %d (%v), want 0", users, err)
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
