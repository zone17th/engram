package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
)

const (
	// HeaderIfMatch là tên header điều kiện version.
	HeaderIfMatch = "If-Match"

	ifMatchKey ctxKey = iota + 100
)

var vaultKeyIDRegex = regexp.MustCompile(`^vk:[A-Za-z0-9_-]{22}$`)

// IfMatchFrom trả chuỗi bên trong dấu ngoặc kép của strong ETag đã được
// middleware RequireIfMatch xác thực. Trả ("", false) nếu chưa qua middleware.
func IfMatchFrom(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(ifMatchKey).(string)
	return v, ok && v != ""
}

// WithIfMatch gắn giá trị strong ETag (không gồm ngoặc kép) vào context.
func WithIfMatch(ctx context.Context, tag string) context.Context {
	return context.WithValue(ctx, ifMatchKey, tag)
}

// ParseStrongETag kiểm tra đúng một strong entity-tag theo RFC 9110 §8.8.1:
// bắt đầu và kết thúc bằng `"`, không rỗng bên trong, không là `*`, không có
// tiền tố weak `W/` hay `w/`, không chứa `"` hay ký tự điều khiển bên trong
// (danh sách `"a", "b"` sẽ bị từ chối vì chứa `"` ở giữa).
func ParseStrongETag(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if len(s) < 3 {
		return "", false
	}
	if s[0] != '"' || s[len(s)-1] != '"' {
		return "", false
	}
	inner := s[1 : len(s)-1]
	for i := range len(inner) {
		b := inner[i]
		// etagc theo RFC 9110: %x21 / %x23-7E / obs-text (%x80-FF)
		// Từ chối DQUOTE (0x22), khoảng trắng/control (<= 0x20 trừ khi cần, nhưng ETag của vault/entry không chứa control hay DQUOTE) và DEL (0x7F).
		if b == '"' || b < 0x20 || b == 0x7f {
			return "", false
		}
	}
	return inner, true
}

// RequireIfMatch là middleware bước 5 (mục 2.3): bắt buộc đúng một header
// If-Match mang một strong tag `"..."`, đưa phần bên trong ngoặc kép vào context.
// Thiếu header, có nhiều header If-Match, `*`, weak tag `W/"..."` hoặc danh sách
// đều trả 428 precondition_required.
func RequireIfMatch(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		vals := r.Header.Values(HeaderIfMatch)
		if len(vals) != 1 {
			WriteProblem(w, r, http.StatusPreconditionRequired, "precondition_required", "Thiếu hoặc sai định dạng If-Match.")
			return
		}
		tag, ok := ParseStrongETag(vals[0])
		if !ok {
			WriteProblem(w, r, http.StatusPreconditionRequired, "precondition_required", "Thiếu hoặc sai định dạng If-Match.")
			return
		}
		next.ServeHTTP(w, r.WithContext(WithIfMatch(r.Context(), tag)))
	})
}

// VaultIfMatch chứa cặp vault_key_id và version đã tách từ strong tag.
type VaultIfMatch struct {
	VaultKeyID string
	Version    int32
}

// ParseVaultIfMatch tách chuỗi bên trong strong ETag (hoặc nguyên chuỗi `"..."`
// nếu truyền cả dấu ngoặc kép) ở dấu `:` CUỐI CÙNG vì `vault_key_id` đã có
// tiền tố `vk:`. Phần trước phải khớp `^vk:[A-Za-z0-9_-]{22}$`, phần sau là
// số nguyên dương thập phân không có số 0 đứng đầu (`^[1-9][0-9]*$`, vừa int32).
func ParseVaultIfMatch(tag string) (VaultIfMatch, bool) {
	s := strings.TrimSpace(tag)
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		var ok bool
		s, ok = ParseStrongETag(s)
		if !ok {
			return VaultIfMatch{}, false
		}
	}
	idx := strings.LastIndexByte(s, ':')
	if idx <= 0 || idx == len(s)-1 {
		return VaultIfMatch{}, false
	}
	vkID := s[:idx]
	verStr := s[idx+1:]
	if !vaultKeyIDRegex.MatchString(vkID) {
		return VaultIfMatch{}, false
	}
	if verStr[0] < '1' || verStr[0] > '9' {
		return VaultIfMatch{}, false
	}
	for i := 1; i < len(verStr); i++ {
		if verStr[i] < '0' || verStr[i] > '9' {
			return VaultIfMatch{}, false
		}
	}
	v64, err := strconv.ParseInt(verStr, 10, 32)
	if err != nil || v64 < 1 {
		return VaultIfMatch{}, false
	}
	return VaultIfMatch{
		VaultKeyID: vkID,
		Version:    int32(v64),
	}, true
}

// ParseVaultIfMatchFromRequest lấy strong tag từ context (hoặc parse trực tiếp
// từ header If-Match nếu chưa qua RequireIfMatch) rồi tách `<vault_key_id>:<version>`.
// Nếu thiếu hoặc sai dạng, hàm ghi ngay 428 precondition_required và trả false.
func ParseVaultIfMatchFromRequest(w http.ResponseWriter, r *http.Request) (VaultIfMatch, bool) {
	tag, ok := IfMatchFrom(r.Context())
	if !ok {
		vals := r.Header.Values(HeaderIfMatch)
		if len(vals) != 1 {
			WriteProblem(w, r, http.StatusPreconditionRequired, "precondition_required", "Thiếu hoặc sai định dạng If-Match.")
			return VaultIfMatch{}, false
		}
		tag, ok = ParseStrongETag(vals[0])
		if !ok {
			WriteProblem(w, r, http.StatusPreconditionRequired, "precondition_required", "Thiếu hoặc sai định dạng If-Match.")
			return VaultIfMatch{}, false
		}
	}
	vim, ok := ParseVaultIfMatch(tag)
	if !ok {
		WriteProblem(w, r, http.StatusPreconditionRequired, "precondition_required", "Thiếu hoặc sai định dạng If-Match.")
		return VaultIfMatch{}, false
	}
	return vim, true
}

type versionMismatchProblem struct {
	Problem
	CurrentVersion int32 `json:"current_version"`
}

// WriteVersionMismatch ghi lỗi 412 version_mismatch kèm extension `current_version`
// theo đúng SPEC §9.1 và OpenAPI schema Problem.
func WriteVersionMismatch(w http.ResponseWriter, r *http.Request, currentVersion int32) {
	const code = "version_mismatch"
	p := versionMismatchProblem{
		Problem: Problem{
			Type:     ProblemBase + code,
			Title:    ProblemTitle(code),
			Status:   http.StatusPreconditionFailed,
			Detail:   "Phiên bản hoặc định danh khoá vault không khớp.",
			Instance: RequestIDFrom(r.Context()),
			Code:     code,
		},
		CurrentVersion: currentVersion,
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusPreconditionFailed)
	if err := json.NewEncoder(w).Encode(p); err != nil {
		slog.ErrorContext(r.Context(), "không ghi được version_mismatch response", slog.String("code", code))
	}
}

// LockAndVerifyVaultIfMatch thực hiện đúng quy tắc mục 2.3 trong transaction của handler:
//  1. Tách và kiểm định dạng `<vault_key_id>:<version>` từ If-Match (sai → 428 precondition_required).
//  2. Khóa hàng vault của user (`SELECT ... FOR UPDATE`).
//  3. Không có hàng vault → 404 vault_absent (ưu tiên hơn 412).
//  4. Lệch `vault_key_id` hoặc `version` → 412 version_mismatch kèm `current_version`.
func LockAndVerifyVaultIfMatch(ctx context.Context, w http.ResponseWriter, r *http.Request, q *gen.Queries, userID uuid.UUID) (gen.Vault, bool) {
	vim, ok := ParseVaultIfMatchFromRequest(w, r)
	if !ok {
		return gen.Vault{}, false
	}
	v, err := q.GetVaultByUserForUpdate(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			WriteProblem(w, r, http.StatusNotFound, "vault_absent", "Chưa khởi tạo vault.")
			return gen.Vault{}, false
		}
		WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi máy chủ.")
		return gen.Vault{}, false
	}
	if v.VaultKeyID != vim.VaultKeyID || v.Version != vim.Version {
		WriteVersionMismatch(w, r, v.Version)
		return gen.Vault{}, false
	}
	return v, true
}

// RequireJSONContentExceptEmptyDelete kiểm tra Content-Type application/json giống
// RequireJSONContent của P02, nhưng bỏ qua đối với request DELETE không có body
// (ContentLength == 0 và Content-Type rỗng) theo mục 2.3 bước 1.
//
// Lưu ý kết quả kiểm tra P02: `httpx.RequireJSONContent` trong `auth.go` kiểm tra
// mọi method POST/PUT/PATCH/DELETE và trả 415 Unsupported Media Type nếu thiếu
// `Content-Type: application/json`, kể cả khi DELETE không có body. Vì vậy các route
// DELETE không body (như `DELETE /vault`, `DELETE /vault/passkeys/{id}`) không được
// gắn trực tiếp `RequireJSONContent` mà dùng middleware này hoặc tách nhóm route.
func RequireJSONContentExceptEmptyDelete(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && (r.ContentLength == 0 || r.Body == nil || r.Body == http.NoBody) && strings.TrimSpace(r.Header.Get("Content-Type")) == "" {
			next.ServeHTTP(w, r)
			return
		}
		RequireJSONContent(next).ServeHTTP(w, r)
	})
}
