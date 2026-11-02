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

	pasteMeta := secevent.Meta{
		Provider:     secevent.ProviderGitHub,
		Reason:       secevent.ReasonExpired,
		Fields:       []string{secevent.FieldTheme, "unknown_field"},
		Count:        5,
		ImportSource: secevent.ImportSourcePaste,
	}.Sanitize()
	if pasteMeta.ImportSource != secevent.ImportSourcePaste ||
		pasteMeta.Provider != secevent.ProviderGitHub ||
		pasteMeta.Reason != secevent.ReasonExpired ||
		pasteMeta.Count != 5 ||
		len(pasteMeta.Fields) != 1 || pasteMeta.Fields[0] != secevent.FieldTheme {
		t.Fatalf("Sanitize giữ sai trường hợp lệ: %+v", pasteMeta)
	}

	fileMeta := secevent.Meta{ImportSource: secevent.ImportSourceFile}.Sanitize()
	if fileMeta.ImportSource != secevent.ImportSourceFile {
		t.Fatalf("ImportSourceFile bị rớt: %+v", fileMeta)
	}

	for _, unknownSource := range []string{"", "url", "clipboard", "PASTE", "file.json", `{"secret":1}`} {
		got := secevent.Meta{
			Provider:     secevent.ProviderGoogle,
			ImportSource: unknownSource,
		}.Sanitize()
		if got.ImportSource != "" {
			t.Fatalf("ImportSource lạ %q không bị bỏ: %+v", unknownSource, got)
		}
		if got.Provider != secevent.ProviderGoogle {
			t.Fatalf("Provider hợp lệ bị ảnh hưởng khi ImportSource=%q: %+v", unknownSource, got)
		}
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
