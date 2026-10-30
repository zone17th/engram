// Package httpx chứa router, middleware và định dạng lỗi dùng chung của API.
package httpx

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
)

// ProblemBase là namespace của các type URI theo RFC 9457.
const ProblemBase = "https://key.zone17th.click/problems/"

// Problem là body lỗi thống nhất của toàn bộ API (SPEC §5.5 / §9.1).
// Detail luôn là câu do server soạn sẵn — không bao giờ phản chiếu input người dùng.
type Problem struct {
	Type            string `json:"type"`
	Title           string `json:"title"`
	Status          int    `json:"status"`
	Detail          string `json:"detail,omitempty"`
	Instance        string `json:"instance,omitempty"`
	Code            string `json:"code"`
	RetryAfter      *int   `json:"retry_after,omitempty"`
	Reason          string `json:"reason,omitempty"`
	CaptchaRequired *bool  `json:"captcha_required,omitempty"`
}

// ProblemExtra là các extension RFC 9457 tuỳ chọn.
type ProblemExtra struct {
	RetryAfter      *int
	Reason          string
	CaptchaRequired *bool
}

// problemTitles ánh xạ code sang title ngắn, ổn định theo hợp đồng.
var problemTitles = map[string]string{
	"invalid_request":             "Yêu cầu không hợp lệ",
	"dependency_unavailable":      "Phụ thuộc chưa sẵn sàng",
	"internal_error":              "Lỗi máy chủ",
	"not_found":                   "Không tìm thấy",
	"unauthenticated":             "Chưa xác thực",
	"access_expired":              "Phiên truy cập đã hết hạn",
	"session_invalid":             "Phiên không hợp lệ",
	"invalid_credentials":         "Thông tin đăng nhập không đúng",
	"csrf_invalid":                "CSRF không hợp lệ",
	"forbidden":                   "Không có quyền",
	"reauth_required":             "Cần xác thực lại",
	"reauth_invalid":              "Xác thực lại không hợp lệ",
	"reauth_unsupported_provider": "Nhà cung cấp không hỗ trợ xác thực lại",
	"rate_limited":                "Quá nhiều yêu cầu",
	"captcha_required":            "Cần xác minh CAPTCHA",
	"email_not_verified":          "Email chưa xác minh",
	"email_taken":                 "Email đã được dùng",
	"identity_conflict":           "Danh tính đã gắn với tài khoản khác",
	"identity_last_method":        "Không thể gỡ phương thức đăng nhập cuối",
	"oauth_state_invalid":         "Phiên OAuth không hợp lệ",
	"oauth_provider_error":        "Nhà cung cấp OAuth gặp lỗi",
	"verification_invalid":        "Mã xác minh không hợp lệ",
	"password_weak":               "Mật khẩu không đạt yêu cầu",
	"semantic_unavailable":        "Gợi ý ngữ nghĩa chưa sẵn sàng",
	"mail_delivery_unavailable":   "Không gửi được email",
	"vault_exists":                "Vault đã tồn tại",
	"vault_absent":                "Chưa khởi tạo vault",
	"vault_kdf_invalid":           "Tham số KDF không hợp lệ",
	"vault_wrap_invalid":          "Bản bọc khoá không hợp lệ",
	"vault_mutations_disabled":    "Thao tác thay đổi khoá tạm thời bị tắt",
	"recovery_keys_count":         "Số lượng khoá khôi phục không hợp lệ",
	"recovery_key_slot_taken":     "Vị trí khoá khôi phục không hợp lệ",
	"recovery_key_invalid":        "Khoá khôi phục không hợp lệ",
	"recovery_key_conflict":       "Khoá khôi phục bị trùng",
	"precondition_required":       "Thiếu điều kiện tiên quyết",
	"version_mismatch":            "Phiên bản không khớp",
	"idempotency_conflict":        "Xung đột khoá idempotency",
	"idempotency_in_progress":     "Yêu cầu cùng khoá idempotency đang xử lý",
	"passkey_challenge_invalid":   "Thử thách passkey không hợp lệ",
	"passkey_attestation_invalid": "Chứng thực passkey không hợp lệ",
	"passkey_name_invalid":        "Tên passkey không hợp lệ",
	"passkey_exists":              "Passkey đã được đăng ký",
	"passkey_not_found":           "Không tìm thấy passkey",
}

// ProblemTitle trả title ổn định; code lạ trả "Lỗi".
func ProblemTitle(code string) string {
	if title, ok := problemTitles[code]; ok {
		return title
	}
	return "Lỗi"
}

// WriteProblem ghi một lỗi RFC 9457. Instance dùng request ID chứ không dùng URL.
func WriteProblem(w http.ResponseWriter, r *http.Request, status int, code, detail string) {
	WriteProblemExtra(w, r, status, code, detail, ProblemExtra{})
}

// WriteProblemExtra ghi problem kèm extension (retry_after, reason, captcha_required).
func WriteProblemExtra(w http.ResponseWriter, r *http.Request, status int, code, detail string, extra ProblemExtra) {
	title, ok := problemTitles[code]
	if !ok {
		title = "Lỗi"
	}
	p := Problem{
		Type:            ProblemBase + code,
		Title:           title,
		Status:          status,
		Detail:          detail,
		Instance:        RequestIDFrom(r.Context()),
		Code:            code,
		RetryAfter:      extra.RetryAfter,
		Reason:          extra.Reason,
		CaptchaRequired: extra.CaptchaRequired,
	}
	if extra.RetryAfter != nil && *extra.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(*extra.RetryAfter))
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(p); err != nil {
		slog.ErrorContext(r.Context(), "không ghi được problem response", slog.String("code", code))
	}
}
