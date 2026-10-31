package authhttp_test

import (
	"net/http"
	"strings"
	"testing"
)

// disableOAuth pins the environment a production deploy without OAuth runs with: fake OAuth off, no
// provider credentials and no Google re-auth. CI enables AUTH_FAKE_OAUTH in some jobs, which hides
// the empty-list case, so the test sets every input explicitly.
func disableOAuth(t *testing.T) {
	t.Helper()
	t.Setenv("AUTH_FAKE_OAUTH", "false")
	t.Setenv("AUTH_GOOGLE_REAUTH_ENABLED", "false")
	for _, k := range []string{
		"OAUTH_GOOGLE_CLIENT_ID", "OAUTH_GOOGLE_CLIENT_SECRET",
		"OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET",
	} {
		t.Setenv(k, "")
	}
}

// HOTFIX-OAUTH-NULL: with OAuth off, GET /auth/config returned "oauth_providers":null and
// /app/settings crashed on `.filter`. OpenAPI declares the field a required, non-nullable array.
func TestAuthConfigOAuthProvidersEmptyArrayWhenOAuthOff(t *testing.T) {
	disableOAuth(t)
	h := newHarness(t, nil)
	resp := h.do(http.MethodGet, "/api/v1/auth/config", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("config = %d %s", resp.StatusCode, h.body(resp))
	}
	raw := h.body(resp)
	if !strings.Contains(raw, `"oauth_providers":[]`) {
		t.Fatalf(`auth/config must contain "oauth_providers":[]; body = %s`, raw)
	}
}

// The same nil slices reached GET /auth/me features (oauth_providers, oauth_reauth_providers).
func TestMeFeaturesOAuthListsEmptyArraysWhenOAuthOff(t *testing.T) {
	disableOAuth(t)
	t.Setenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "false")
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"oauth-off@example.com","password":"correcthorse","locale":"vi"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	resp = h.do(http.MethodGet, "/api/v1/auth/me", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("me = %d %s", resp.StatusCode, h.body(resp))
	}
	raw := h.body(resp)
	for _, want := range []string{`"oauth_providers":[]`, `"oauth_reauth_providers":[]`} {
		if !strings.Contains(raw, want) {
			t.Fatalf("me must contain %s; body = %s", want, raw)
		}
	}
}
