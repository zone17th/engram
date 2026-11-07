package authhttp_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/auth/oauth"
)

func TestSettingsPatchRejectsExplicitNullAtomically(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"settings-null@example.com","password":"correcthorse","locale":"vi"}`, true)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	var before auth.Me
	if err := json.NewDecoder(resp.Body).Decode(&before); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	cases := []string{
		`{"locale":null,"theme":"dark"}`,
		`{"theme":null,"locale":"en"}`,
		`{"auto_lock_minutes":null,"theme":"light"}`,
		`{"semantic_suggest":null,"theme":"dark"}`,
	}
	for _, body := range cases {
		resp = h.do(http.MethodPatch, "/api/v1/me/settings", body, true)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("patch %s = %d %s", body, resp.StatusCode, h.body(resp))
		}
		raw := h.body(resp)
		if !strings.Contains(raw, `"invalid_request"`) {
			t.Fatalf("patch %s error body = %s", body, raw)
		}

		resp = h.do(http.MethodGet, "/api/v1/auth/me", "", false)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("me after patch %s = %d %s", body, resp.StatusCode, h.body(resp))
		}
		var after auth.Me
		if err := json.NewDecoder(resp.Body).Decode(&after); err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if after.Settings != before.Settings {
			t.Fatalf("patch %s changed settings: before=%+v after=%+v", body, before.Settings, after.Settings)
		}
	}
}

// decodeMe reads a 200 Me body and closes it.
func decodeMe(t *testing.T, h *harness, resp *http.Response, what string) auth.Me {
	t.Helper()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		t.Fatalf("%s = %d %s", what, resp.StatusCode, h.body(resp))
	}
	var me auth.Me
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return me
}

// storedConsent reads the raw DB row, independent of BuildMe's own defaults.
func storedConsent(t *testing.T, h *harness, email string) (semanticSuggest *bool, seenAt *time.Time) {
	t.Helper()
	if err := h.pool.QueryRow(context.Background(),
		`SELECT (settings->>'semantic_suggest')::boolean, semantic_consent_seen_at FROM app_user WHERE email = $1`, email,
	).Scan(&semanticSuggest, &seenAt); err != nil {
		t.Fatalf("read app_user %s: %v", email, err)
	}
	return semanticSuggest, seenAt
}

func assertConsentDefaults(t *testing.T, h *harness, me auth.Me, email string) {
	t.Helper()
	if me.Settings.SemanticSuggest {
		t.Errorf("new account Me.settings.semantic_suggest = true, want false (plan P06 mục 2.10)")
	}
	if me.SemanticConsentSeenAt != nil {
		t.Errorf("new account semantic_consent_seen_at = %v, want null", me.SemanticConsentSeenAt)
	}
	stored, seen := storedConsent(t, h, email)
	if stored == nil || *stored {
		t.Errorf("stored settings.semantic_suggest = %v, want explicit false from the DB default", stored)
	}
	if seen != nil {
		t.Errorf("stored semantic_consent_seen_at = %v, want NULL", seen)
	}
}

func TestSemanticConsentDefaultOffPassword(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	const email = "consent-pw@example.com"
	me := decodeMe(t, h, h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"`+email+`","password":"correcthorse"}`, true), "signup")
	assertConsentDefaults(t, h, me, email)
	raw := h.body(h.do(http.MethodGet, "/api/v1/auth/me", "", false))
	if !strings.Contains(raw, `"semantic_consent_seen_at":null`) {
		t.Errorf("GET /auth/me must carry semantic_consent_seen_at:null, got %s", raw)
	}
}

func TestSemanticConsentDefaultOffOAuth(t *testing.T) {
	const email = "consent-oauth@example.com"
	fake := oauth.NewFake("google", true, oauth.Identity{Provider: "google", UID: "g-consent", Email: email, EmailVerified: true})
	h := newHarness(t, []oauth.Provider{fake})
	fake.SetAuthorizeBase(h.srv.URL + "/api/v1/__fake/oauth/google")
	h.csrf()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	follow := func(url string, want int) string {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		h.jar.apply(req)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		h.jar.capture(resp)
		if resp.StatusCode != want {
			t.Fatalf("GET %s = %d %s", url, resp.StatusCode, h.body(resp))
		}
		_ = resp.Body.Close()
		return resp.Header.Get("Location")
	}
	authorize := follow(h.srv.URL+"/api/v1/auth/oauth/google/start", http.StatusFound)
	callback := follow(authorize, http.StatusFound)
	if loc := follow(callback, http.StatusSeeOther); !strings.Contains(loc, "status=login_ready") {
		t.Fatalf("callback redirect = %s", loc)
	}
	h.csrf()
	me := decodeMe(t, h, h.do(http.MethodPost, "/api/v1/auth/oauth/complete", "", true), "oauth complete")
	if me.User.Email != email {
		t.Fatalf("oauth me email = %q", me.User.Email)
	}
	assertConsentDefaults(t, h, me, email)
}

func TestPatchSettingsConsentSeenServerTime(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	const email = "consent-seen@example.com"
	decodeMe(t, h, h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"`+email+`","password":"correcthorse"}`, true), "signup")

	before := time.Now().Add(-5 * time.Second)
	me := decodeMe(t, h, h.do(http.MethodPatch, "/api/v1/me/settings", `{"semantic_consent_seen":true}`, true), "patch seen")
	after := time.Now().Add(5 * time.Second)
	if me.SemanticConsentSeenAt == nil {
		t.Fatal("PATCH semantic_consent_seen:true returned semantic_consent_seen_at null")
	}
	first := *me.SemanticConsentSeenAt
	// Server (DB) time: the harness app clock is pinned to 2026-09-15, so a value
	// in [before, after] proves the column comes from now(), not the client or app clock.
	if first.Before(before) || first.After(after) {
		t.Errorf("semantic_consent_seen_at = %v, want server time in [%v, %v]", first, before, after)
	}
	if me.Settings.SemanticSuggest {
		t.Error("acknowledging consent turned semantic_suggest on")
	}

	// Repeat (alone, then with another setting): COALESCE keeps the first stamp.
	time.Sleep(20 * time.Millisecond)
	for _, body := range []string{`{"semantic_consent_seen":true}`, `{"semantic_consent_seen":true,"semantic_suggest":false}`} {
		again := decodeMe(t, h, h.do(http.MethodPatch, "/api/v1/me/settings", body, true), "patch again "+body)
		if again.SemanticConsentSeenAt == nil || !again.SemanticConsentSeenAt.Equal(first) {
			t.Errorf("PATCH %s moved semantic_consent_seen_at: %v -> %v", body, first, again.SemanticConsentSeenAt)
		}
	}

	// Another session (device B) reads the same value through GET /auth/me.
	other := jar{}
	h.csrfJar(other)
	resp := h.doAs(other, http.MethodPost, "/api/v1/auth/login", `{"email":"`+email+`","password":"correcthorse"}`, true, "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login B = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()
	if other[authhttp.CookieSession] == nil || h.jar[authhttp.CookieSession] == nil ||
		other[authhttp.CookieSession].Value == h.jar[authhttp.CookieSession].Value {
		t.Fatal("device B must hold its own session cookie")
	}
	meB := decodeMe(t, h, h.doAs(other, http.MethodGet, "/api/v1/auth/me", "", false, ""), "me B")
	if meB.SemanticConsentSeenAt == nil || !meB.SemanticConsentSeenAt.Equal(first) {
		t.Errorf("session B semantic_consent_seen_at = %v, want %v", meB.SemanticConsentSeenAt, first)
	}
}

func TestPatchSettingsConsentSeenFalseRejected(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	const email = "consent-false@example.com"
	decodeMe(t, h, h.do(http.MethodPost, "/api/v1/auth/signup", `{"email":"`+email+`","password":"correcthorse"}`, true), "signup")
	for _, body := range []string{
		`{"semantic_consent_seen":false}`,
		`{"semantic_consent_seen":false,"theme":"dark"}`,
		`{"semantic_consent_seen":null}`,
		`{"semantic_consent_seen":"2026-11-07T00:00:00Z"}`,
	} {
		resp := h.do(http.MethodPatch, "/api/v1/me/settings", body, true)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("PATCH %s = %d %s, want 400", body, resp.StatusCode, h.body(resp))
		}
		if raw := h.body(resp); !strings.Contains(raw, `"invalid_request"`) {
			t.Fatalf("PATCH %s body = %s, want invalid_request", body, raw)
		}
	}
	// Nothing was written: no stamp, theme unchanged.
	me := decodeMe(t, h, h.do(http.MethodGet, "/api/v1/auth/me", "", false), "me")
	if me.SemanticConsentSeenAt != nil {
		t.Errorf("rejected PATCH stamped semantic_consent_seen_at = %v", me.SemanticConsentSeenAt)
	}
	if me.Settings.Theme == "dark" {
		t.Error("rejected PATCH still applied theme=dark")
	}
}
