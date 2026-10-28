package secevent_test

import (
	"strings"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/secevent"
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
