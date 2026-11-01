package secevent_test

import (
	"strings"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/secevent"
)

func TestMetaSanitizeDropsSecrets(t *testing.T) {
	m := secevent.Meta{
		Provider: "password",
		Reason:   "invalid",
		Fields:   []string{secevent.FieldLocale, "password", "token"},
		Count:    2,
	}
	out := m.Sanitize()
	if out.Provider != "password" || out.Reason != "invalid" || out.Count != 2 {
		t.Fatalf("%+v", out)
	}
	for _, f := range out.Fields {
		if f == "password" || strings.Contains(f, "token") {
			t.Fatalf("field lạ còn lại: %q", f)
		}
	}
	bad := secevent.Meta{Provider: "not-a-provider", Reason: "password=supersecret"}
	if got := bad.Sanitize(); got.Provider != "" || got.Reason != "" {
		t.Fatalf("phải bỏ enum lạ: %+v", got)
	}
}

func TestMetaSanitizePasswordResetAndUnlinkedProviders(t *testing.T) {
	m := secevent.Meta{
		Event:             secevent.EventPasswordReset,
		UnlinkedProviders: []string{secevent.ProviderGoogle, "google", secevent.ProviderGitHub, "password", "evil-token"},
	}
	out := m.Sanitize()
	if out.Event != secevent.EventPasswordReset {
		t.Fatalf("Event = %q, want %q", out.Event, secevent.EventPasswordReset)
	}
	if len(out.UnlinkedProviders) != 2 || out.UnlinkedProviders[0] != "google" || out.UnlinkedProviders[1] != "github" {
		t.Fatalf("UnlinkedProviders = %v, want [google github]", out.UnlinkedProviders)
	}
	bad := secevent.Meta{
		Event:             "auth.login.success",
		UnlinkedProviders: []string{"password", "secret"},
	}.Sanitize()
	if bad.Event != "" || len(bad.UnlinkedProviders) != 0 {
		t.Fatalf("unexpected sanitized meta: %+v", bad)
	}
}
