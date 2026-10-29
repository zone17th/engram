package vault

import (
	"context"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// ResetInput là đầu vào cho `DELETE /vault` (`vaultReset`, plan Task 12).
type ResetInput struct {
	IfMatch httpx.VaultIfMatch
	IP      string
	UA      string
}

// Reset xoá toàn bộ vault, RK, passkey, challenge và các khoá idempotency vault khác của user
// cùng gọi `ResetHook` trong một transaction (`DELETE /vault`).
// TODO(P03-T12): implement DELETE /vault with ResetHook, PurgeOtherVaultIdempotencyKeysTx, audit, notice/mail.
func (s *Service) Reset(_ context.Context, _ authctx.Principal, _ ResetInput) error {
	return errCode("dependency_unavailable")
}
