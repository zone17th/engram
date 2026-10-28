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

var p03OperationIDs = []string{
	"vaultGet",
	"vaultCreate",
	"vaultRewrap",
	"vaultReset",
	"vaultRecoveryKeysGet",
	"vaultRecoveryLookup",
	"vaultRecoverComplete",
	"vaultRecoveryKeysRegenerate",
	"vaultRecoveryKeysRotate",
	"vaultPasskeyRegisterOptions",
	"vaultPasskeyCreate",
	"vaultPasskeysList",
	"vaultPasskeyRename",
	"vaultPasskeyRevoke",
	"vaultPasskeyUnlockOptions",
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

func TestOpenAPIHasUniqueP03OperationIDs(t *testing.T) {
	spec := readOpenAPI(t)
	seen := map[string]int{}
	re := regexp.MustCompile(`(?m)^[ \t]*operationId: ([A-Za-z][A-Za-z0-9]+)\s*$`)
	for _, m := range re.FindAllStringSubmatch(spec, -1) {
		seen[m[1]]++
	}
	for _, id := range p03OperationIDs {
		if seen[id] == 0 {
			t.Errorf("thiếu operationId %s", id)
		}
		if seen[id] > 1 {
			t.Errorf("operationId %s bị trùng (%d)", id, seen[id])
		}
	}
	if len(p03OperationIDs) != 15 {
		t.Fatalf("catalog test phải đủ 15 operation P03, có %d", len(p03OperationIDs))
	}
}

func TestProblemCatalogParityWithOpenAPI(t *testing.T) {
	spec := readOpenAPI(t)
	blockRe := regexp.MustCompile(`(?m)^    ProblemCode:\r?\n      type: string\r?\n      enum:\r?\n((?:        - [a-z0-9_]+\r?\n)+)`)
	m := blockRe.FindStringSubmatch(spec)
	if m == nil {
		t.Fatal("không tìm thấy block ProblemCode.enum trong openapi.yaml")
	}
	itemRe := regexp.MustCompile(`(?m)^        - ([a-z0-9_]+)\r?$`)
	var openAPICodes []string
	for _, sub := range itemRe.FindAllStringSubmatch(m[1], -1) {
		openAPICodes = append(openAPICodes, sub[1])
	}
	for _, code := range httpx.ProblemCodes {
		if !slices.Contains(openAPICodes, code) {
			t.Errorf("OpenAPI thiếu problem code %s", code)
		}
		if title := httpx.ProblemTitle(code); title == "Lỗi" {
			t.Errorf("httpx thiếu title cho %s", code)
		}
	}
	for _, code := range openAPICodes {
		if !slices.Contains(httpx.ProblemCodes, code) {
			t.Errorf("httpx.ProblemCodes thiếu problem code %s có trong OpenAPI", code)
		}
	}
	if !slices.Equal(openAPICodes, httpx.ProblemCodes) {
		t.Errorf("thứ tự/tập hợp ProblemCode lệch giữa OpenAPI (%v) và httpx (%v)", openAPICodes, httpx.ProblemCodes)
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

func TestOpenAPIP03ContractInvariants(t *testing.T) {
	spec := readOpenAPI(t)

	if !strings.Contains(spec, "$ref: '#/components/headers/NoStoreNoTransform'") {
		t.Error("vaultGet phải tham chiếu header NoStoreNoTransform")
	}
	if !strings.Contains(spec, "const: no-store, no-transform") {
		t.Error("NoStoreNoTransform phải có const: no-store, no-transform")
	}
	if strings.Contains(spec, "P02 luôn absent") {
		t.Error("Me.vault.status không được giữ mô tả lỗi thời 'P02 luôn absent'")
	}

	re403Reauth := regexp.MustCompile(`(?m)'403':\r?\n[ \t]*description:.*reauth_(required|invalid)`)
	if re403Reauth.MatchString(spec) {
		t.Error("reauth_required / reauth_invalid thuộc HTTP 401 theo ClassifyAuthError, không được đặt dưới 403")
	}

	re401Reauth := regexp.MustCompile(`(?m)'401':\r?\n[ \t]*description:.*reauth_required, reauth_invalid`)
	if got := len(re401Reauth.FindAllString(spec, -1)); got != 7 {
		t.Errorf("phải có đúng 7 operation có A ghi nhận reauth_required, reauth_invalid dưới 401, tìm thấy %d", got)
	}

	if got := strings.Count(spec, "$ref: '#/components/responses/IdempotencyConflict'"); got != 7 {
		t.Errorf("phải có đúng 7 operation có I tham chiếu IdempotencyConflict cho 409, tìm thấy %d", got)
	}
	reIdemRetry := regexp.MustCompile(`(?s)IdempotencyConflict:.*?headers:.*?Retry-After:`)
	if !reIdemRetry.MatchString(spec) {
		t.Error("IdempotencyConflict phải khai báo header Retry-After")
	}
}
