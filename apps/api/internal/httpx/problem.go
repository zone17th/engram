// Package httpx chứa router, middleware và định dạng lỗi dùng chung của API.
package httpx

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// ProblemBase là namespace của các type URI theo RFC 9457.
const ProblemBase = "https://key.zone17th.click/problems/"

// Problem là body lỗi thống nhất của toàn bộ API (SPEC §5.5).
// Detail luôn là câu do server soạn sẵn — không bao giờ phản chiếu input người dùng,
// vì query có thể chứa từ khoá riêng tư.
type Problem struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Status   int    `json:"status"`
	Detail   string `json:"detail,omitempty"`
	Instance string `json:"instance,omitempty"`
	Code     string `json:"code"`
}

// problemTitles ánh xạ code sang title ngắn, ổn định theo hợp đồng.
var problemTitles = map[string]string{
	"invalid_request":        "Yêu cầu không hợp lệ",
	"dependency_unavailable": "Phụ thuộc chưa sẵn sàng",
	"internal_error":         "Lỗi máy chủ",
	"not_found":              "Không tìm thấy",
}

// WriteProblem ghi một lỗi RFC 9457. Instance dùng request ID chứ không dùng URL,
// để log và client đối chiếu được mà không lưu lại path chứa tham số.
func WriteProblem(w http.ResponseWriter, r *http.Request, status int, code, detail string) {
	title, ok := problemTitles[code]
	if !ok {
		title = "Lỗi"
	}
	p := Problem{
		Type:     ProblemBase + code,
		Title:    title,
		Status:   status,
		Detail:   detail,
		Instance: RequestIDFrom(r.Context()),
		Code:     code,
	}
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(p); err != nil {
		slog.ErrorContext(r.Context(), "không ghi được problem response", slog.String("code", code))
	}
}
