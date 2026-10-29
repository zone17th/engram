package vault

import (
	"context"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// RecoveryKeysRegenerateInput là đầu vào cho `POST /vault/recovery-keys/regenerate` (`vaultRecoveryKeysRegenerate`, plan Task 11).
type RecoveryKeysRegenerateInput struct {
	RecoveryKeys []RecoveryKeyUploadItem `json:"recovery_keys"`
	IfMatch      httpx.VaultIfMatch
	IP           string
	UA           string
}

// RecoveryKeysRotateInput là đầu vào cho `POST /vault/recovery-keys/rotate` (`vaultRecoveryKeysRotate`, plan Task 11).
type RecoveryKeysRotateInput struct {
	RecoveryKeys []RecoveryKeyUploadItem `json:"recovery_keys"`
	IfMatch      httpx.VaultIfMatch
	IP           string
	UA           string
}

// RegenerateRecoveryKeys bù các recovery key mới vào các slot đang trống (`POST /vault/recovery-keys/regenerate`).
// TODO(P03-T11): implement POST /vault/recovery-keys/regenerate + audit recovery_key.regenerate.
func (s *Service) RegenerateRecoveryKeys(_ context.Context, _ authctx.Principal, _ RecoveryKeysRegenerateInput) (RecoveryKeysMutationResponse, error) {
	return RecoveryKeysMutationResponse{}, errCode("dependency_unavailable")
}

// RotateRecoveryKeys thay thế toàn bộ 10 recovery key (`POST /vault/recovery-keys/rotate`).
// TODO(P03-T11): implement POST /vault/recovery-keys/rotate + audit recovery_key.rotate + notice/mail.
func (s *Service) RotateRecoveryKeys(_ context.Context, _ authctx.Principal, _ RecoveryKeysRotateInput) (RecoveryKeysMutationResponse, error) {
	return RecoveryKeysMutationResponse{}, errCode("dependency_unavailable")
}
