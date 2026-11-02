package authhttp_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/auth"
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
