package httpx_test

import (
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/httpx"
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

	// Số operation có I tham chiếu IdempotencyConflict (P03 7 + P04 16) kiểm ở TestOpenAPIP04ContractInvariants.
	reIdemRetry := regexp.MustCompile(`(?s)IdempotencyConflict:.*?headers:.*?Retry-After:`)
	if !reIdemRetry.MatchString(spec) {
		t.Error("IdempotencyConflict phải khai báo header Retry-After")
	}
}

var p04OperationIDs = []string{
	"itemsList",
	"itemsLookupExact",
	"itemCreate",
	"itemGet",
	"itemUpdate",
	"itemDelete",
	"itemRestore",
	"itemTagsAdd",
	"itemTagRemove",
	"itemEntriesReorder",
	"tagsList",
	"tagUpsert",
	"tagRename",
	"tagDelete",
	"tagRestore",
	"itemEntriesList",
	"entryCreate",
	"entryImportJson",
	"entryGet",
	"entryUpdate",
	"entryDelete",
	"entryRestore",
	"entriesChanges",
}

// p04ProblemStatus là bảng mã lỗi mới của plan P04 mục 3, đúng thứ tự thêm cuối catalog.
var p04ProblemStatus = []struct {
	code   string
	status int
}{
	{"name_invalid", 400},
	{"hint_invalid", 400},
	{"tag_display_invalid", 400},
	{"item_id_conflict", 409},
	{"item_deleted", 409},
	{"item_tag_limit", 409},
	{"item_entry_limit", 409},
	{"tag_conflict", 409},
	{"entry_invalid", 400},
	{"entry_too_large", 413},
	{"entry_id_conflict", 409},
	{"entry_key_mismatch", 409},
	{"entry_nonce_reused", 400},
	{"entry_restore_via_item", 409},
	{"reorder_mismatch", 409},
	{"changes_window_expired", 410},
}

// openAPIBlock trả block YAML bắt đầu ở dòng `header` (đúng indent) tới trước dòng kế tiếp
// có indent nhỏ hơn hoặc bằng. Chuẩn hoá CRLF để test chạy được trên checkout Windows.
func openAPIBlock(t *testing.T, spec, header string) string {
	t.Helper()
	spec = strings.ReplaceAll(spec, "\r\n", "\n")
	start := strings.Index(spec, "\n"+header+"\n")
	if start < 0 {
		t.Fatalf("openapi.yaml thiếu block %q", strings.TrimSpace(header))
	}
	indent := len(header) - len(strings.TrimLeft(header, " "))
	rest := spec[start+1+len(header)+1:]
	var b strings.Builder
	for _, line := range strings.Split(rest, "\n") {
		trimmed := strings.TrimLeft(line, " ")
		if trimmed != "" && len(line)-len(trimmed) <= indent {
			break
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

func TestOpenAPIHasUniqueP04OperationIDs(t *testing.T) {
	spec := readOpenAPI(t)
	seen := map[string]int{}
	re := regexp.MustCompile(`(?m)^[ \t]*operationId: ([A-Za-z][A-Za-z0-9]+)\s*$`)
	for _, m := range re.FindAllStringSubmatch(spec, -1) {
		seen[m[1]]++
	}
	for _, id := range p04OperationIDs {
		if seen[id] == 0 {
			t.Errorf("thiếu operationId %s", id)
		}
		if seen[id] > 1 {
			t.Errorf("operationId %s bị trùng (%d)", id, seen[id])
		}
	}
	if len(p04OperationIDs) != 23 {
		t.Fatalf("catalog test phải đủ 23 operation P04 (plan P04 mục 3), có %d", len(p04OperationIDs))
	}
	if total := len(p02OperationIDs) + len(p03OperationIDs) + len(p04OperationIDs) + 3; len(seen) != total {
		t.Errorf("openapi.yaml có %d operationId, catalog test (P01 3 + P02 + P03 + P04) có %d", len(seen), total)
	}
}

func TestProblemCatalogP04AppendedAtEnd(t *testing.T) {
	n := len(p04ProblemStatus)
	if len(httpx.ProblemCodes) < n {
		t.Fatalf("catalog quá ngắn: %d", len(httpx.ProblemCodes))
	}
	tail := httpx.ProblemCodes[len(httpx.ProblemCodes)-n:]
	for i, want := range p04ProblemStatus {
		if tail[i] != want.code {
			t.Errorf("mã P04 thứ %d phải là %s ở cuối catalog, có %s", i, want.code, tail[i])
		}
	}
	if httpx.ProblemCodes[len(httpx.ProblemCodes)-n-1] != "passkey_not_found" {
		t.Error("mã P04 phải nối ngay sau passkey_not_found (mã cuối của P03), không chèn giữa catalog")
	}
}

func TestContentProblemStatusMatchesPlan(t *testing.T) {
	for _, want := range p04ProblemStatus {
		if got := httpx.ContentProblemStatus(want.code); got != want.status {
			t.Errorf("ContentProblemStatus(%s) = %d, plan P04 mục 3 = %d", want.code, got, want.status)
		}
	}
	reused := map[string]int{
		"not_found":               404,
		"invalid_request":         400,
		"rate_limited":            429,
		"precondition_required":   428,
		"version_mismatch":        412,
		"idempotency_conflict":    409,
		"idempotency_in_progress": 409,
		"vault_absent":            404,
		"dependency_unavailable":  503,
	}
	for code, status := range reused {
		if got := httpx.ContentProblemStatus(code); got != status {
			t.Errorf("ContentProblemStatus(%s) = %d, muốn %d", code, got, status)
		}
	}
	if got := httpx.ContentProblemStatus("passkey_exists"); got != 500 {
		t.Errorf("code ngoài API content phải trả 500, có %d", got)
	}
}

func TestOpenAPIP04ContractInvariants(t *testing.T) {
	spec := readOpenAPI(t)

	// Mọi operation có Idempotency-Key (P03 7 + P04 16) khai báo 409 qua IdempotencyConflict.
	keyRefs := strings.Count(spec, "$ref: '#/components/parameters/IdempotencyKey'")
	conflictRefs := strings.Count(spec, "$ref: '#/components/responses/IdempotencyConflict'")
	if keyRefs != 23 || conflictRefs != 23 {
		t.Errorf("phải có đúng 23 operation có I (P03 7 + P04 16) tham chiếu IdempotencyKey và IdempotencyConflict, có %d / %d", keyRefs, conflictRefs)
	}

	// If-Match version của content tách khỏi pattern vault.
	versionIfMatch := openAPIBlock(t, spec, "    VersionIfMatch:")
	if !strings.Contains(versionIfMatch, `pattern: '^"[1-9][0-9]{0,9}"$'`) {
		t.Error(`VersionIfMatch phải có pattern '^"[1-9][0-9]{0,9}"$'`)
	}
	if got := strings.Count(spec, "$ref: '#/components/parameters/VersionIfMatch'"); got != 2 {
		t.Errorf("chỉ itemUpdate và entryUpdate dùng VersionIfMatch, có %d tham chiếu", got)
	}

	// Mảng bắt buộc không bao giờ nullable (bài học HOTFIX-OAUTH-NULL, advisor-dec-089).
	arrays := map[string][]string{
		"ItemSummary":                {"tags"},
		"ItemList":                   {"items"},
		"ItemLookupResult":           {"items"},
		"TagList":                    {"items"},
		"EntryMetaList":              {"items"},
		"EntryChangesPage":           {"changes"},
		"ItemEntriesReorderResponse": {"entries"},
		"ItemTagsAddRequest":         {"tag_ids"},
		"ItemEntriesReorderRequest":  {"entry_ids"},
	}
	for schema, fields := range arrays {
		block := openAPIBlock(t, spec, "    "+schema+":")
		required := regexp.MustCompile(`(?m)^      required: \[([^\]]*)\]`).FindStringSubmatch(block)
		if required == nil {
			t.Errorf("%s thiếu required", schema)
			continue
		}
		for _, field := range fields {
			if !slices.Contains(strings.Split(strings.ReplaceAll(required[1], " ", ""), ","), field) {
				t.Errorf("%s.%s phải nằm trong required", schema, field)
			}
			prop := openAPIBlock(t, block, "        "+field+":")
			if !strings.Contains(prop, "          type: array\n") {
				t.Errorf("%s.%s phải là `type: array` không nullable", schema, field)
			}
		}
		if strings.Contains(block, "array, 'null'") || strings.Contains(block, "'null', array") {
			t.Errorf("%s có mảng nullable", schema)
		}
	}

	// Metadata entry (list, feed, response ghi) không mang envelope/ciphertext.
	for _, schema := range []string{"EntryMeta", "EntryChange"} {
		block := openAPIBlock(t, spec, "    "+schema+":")
		if strings.Contains(block, "\n        envelope:") || strings.Contains(block, "\n        ciphertext:") {
			t.Errorf("%s không được có envelope/ciphertext", schema)
		}
	}

	// Import không nhận filename; không có PUT thay cả bộ tag.
	if block := openAPIBlock(t, spec, "    EntryImportJsonRequest:"); strings.Contains(block, "filename") {
		t.Error("EntryImportJsonRequest không được có filename (Q7)")
	}
	if block := openAPIBlock(t, spec, "  /items/{id}/tags:"); strings.Contains(block, "\n    put:") {
		t.Error("không được có PUT /items/{id}/tags (Q3)")
	}
}
