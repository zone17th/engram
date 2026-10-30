package vault

import (
	"context"

	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
)

const (
	StatusAbsent  = "absent"
	StatusPresent = "present"
)

// NewVaultStatus tạo hàm kiểm tra trạng thái vault cho auth.NewService (plan Task 8).
// Truy vấn bảng `vault` theo `user_id` để `Me.vault.status` trả về `"present"` khi đã tạo
// và `"absent"` khi chưa tạo hoặc sau khi reset.
func NewVaultStatus(db gen.DBTX) func(ctx context.Context, userID uuid.UUID) (string, error) {
	q := gen.New(db)
	return func(ctx context.Context, userID uuid.UUID) (string, error) {
		if db == nil {
			return StatusAbsent, nil
		}
		exists, err := q.VaultExistsByUser(ctx, userID)
		if err != nil {
			return StatusAbsent, err
		}
		if exists {
			return StatusPresent, nil
		}
		return StatusAbsent, nil
	}
}

// VaultStatus trả về trạng thái vault (`"present"` | `"absent"`) của user thông qua Service.
func (s *Service) VaultStatus(ctx context.Context, userID uuid.UUID) (string, error) {
	if s == nil || s.pool == nil {
		return StatusAbsent, nil
	}
	return NewVaultStatus(s.pool)(ctx, userID)
}
