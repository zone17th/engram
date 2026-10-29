package vault

import (
	"net/http"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// RequireKeyMutationsEnabled là middleware công tắc dừng khẩn cấp (kill switch) cho các route
// thuộc cột K (plan mục 3, mục 7, Task 8):
//   - POST /vault
//   - PUT /vault/kek
//   - DELETE /vault
//   - POST /vault/recover/complete
//   - POST /vault/recovery-keys/regenerate
//   - POST /vault/recovery-keys/rotate
//   - POST /vault/passkeys
//
// Khi `disabled == true` (`VAULT_KEY_MUTATIONS_DISABLED=true`), middleware trả ngay
// `503 vault_mutations_disabled`. Theo advisor-dec-022 (plan mục 2.3 bước 2), đặt ngay SAU
// `Idempotency.Lookup` (để replay của mutation đã commit trả lại response đã lưu và các lỗi 409
// ở bước 2 giữ nguyên) và TRƯỚC `RequireReauth`, `UserLimiter`, `RequireIfMatch` và `Idempotency.Claim`
// để mọi request tạo mutation mới hoặc giành lại hàng `in_progress` quá hạn (> 60s) bị chặn với 503
// mà không tiêu tốn rate-limit event và không claim khoá idempotency.
func RequireKeyMutationsEnabled(disabled bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if disabled {
				httpx.WriteProblem(
					w,
					r,
					http.StatusServiceUnavailable,
					"vault_mutations_disabled",
					httpx.ProblemTitle("vault_mutations_disabled")+".",
				)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
