package httpx_test

import (
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

var p02OperationIDs = []string{
	"authConfig",
	"authCsrf",
	"authSignup",
	"authLogin",
	"authRefresh",
	"authLogout",
	"authMe",
	"authOauthStart",
	"authOauthLinkStart",
	"authOauthReauthStart",
	"authOauthCallback",
	"authOauthComplete",
	"authReauth",
	"authVerifyEmailSend",
	"authVerifyEmailConfirm",
	"authPasswordEnrollSend",
	"authSessionsList",
	"authSessionRevoke",
	"authSessionsRevokeOthers",
	"authIdentityUnlink",
	"authAuditList",
	"meNotificationsList",
	"meNotificationRead",
	"meSettingsPatch",
	"meEmailChange",
	"mePasswordChange",
}

func readOpenAPI(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatalf("đọc openapi.yaml: %v", err)
	}
	return string(raw)
}

func TestOpenAPIDeclaresP01AndP02Paths(t *testing.T) {
	spec := readOpenAPI(t)

	for _, p := range []string{"  /healthz:", "  /readyz:", "  /metrics:"} {
		if !strings.Contains(spec, p) {
			t.Errorf("openapi.yaml thiếu path %q", strings.TrimSpace(p))
		}
	}
	if !strings.Contains(spec, "url: /api/v1") {
		t.Error("server URL phải là /api/v1 (một origin, đường tương đối)")
	}
	if strings.Contains(spec, "http://localhost:8080") {
		t.Error("openapi.yaml không được hardcode origin của API — dev đi qua proxy")
	}
	if strings.Contains(spec, "bearer") || strings.Contains(spec, "http:") && strings.Contains(spec, "scheme: bearer") {
		if strings.Contains(spec, "type: http") && strings.Contains(spec, "bearer") {
			t.Error("auth P02 dùng cookie, không gán bearer scheme")
		}
	}
}

func TestOpenAPIHasUniqueP02OperationIDs(t *testing.T) {
	spec := readOpenAPI(t)
	seen := map[string]int{}
	re := regexp.MustCompile(`(?m)^[ \t]*operationId: ([A-Za-z][A-Za-z0-9]+)\s*$`)
	for _, m := range re.FindAllStringSubmatch(spec, -1) {
		seen[m[1]]++
	}
	for _, id := range p02OperationIDs {
		if seen[id] == 0 {
			t.Errorf("thiếu operationId %s", id)
		}
		if seen[id] > 1 {
			t.Errorf("operationId %s bị trùng (%d)", id, seen[id])
		}
	}
	if len(p02OperationIDs) != 26 {
		t.Fatalf("catalog test phải đủ 26 operation P02, có %d", len(p02OperationIDs))
	}
}

func TestProblemCatalogParityWithOpenAPI(t *testing.T) {
	spec := readOpenAPI(t)
	for _, code := range httpx.ProblemCodes {
		if !strings.Contains(spec, "- "+code) {
			t.Errorf("OpenAPI thiếu problem code %s", code)
		}
		if title := httpx.ProblemTitle(code); title == "Lỗi" {
			t.Errorf("httpx thiếu title cho %s", code)
		}
	}
}

func TestProblemCodesStableOrderNoDup(t *testing.T) {
	seen := map[string]struct{}{}
	for _, c := range httpx.ProblemCodes {
		if _, ok := seen[c]; ok {
			t.Errorf("trùng code %s", c)
		}
		seen[c] = struct{}{}
	}
	if !slices.Contains(httpx.ProblemCodes, "semantic_unavailable") {
		t.Error("thiếu semantic_unavailable")
	}
}
