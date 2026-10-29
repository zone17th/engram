package vault

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// RecoveryLookupInput là đầu vào cho `POST /vault/unlock/recovery` (`vaultRecoveryLookup`, plan Task 10).
type RecoveryLookupInput struct {
	LookupHash string `json:"lookup_hash"`
}

// RecoverCompleteInput là đầu vào cho `POST /vault/recover/complete` (`vaultRecoverComplete`, plan Task 10).
type RecoverCompleteInput struct {
	RecoveryKeyID        uuid.UUID       `json:"recovery_key_id"`
	KDFRaw               json.RawMessage `json:"kdf"`
	VaultKeyWrappedByKEK string          `json:"vault_key_wrapped_by_kek"`
	IfMatch              httpx.VaultIfMatch
	IP                   string
	UA                   string
}

// RecoveryLookup tra cứu bản bọc VK theo `lookup_hash` thuộc vault của user hiện tại (`POST /vault/unlock/recovery`).
// TODO(P03-T10): implement POST /vault/unlock/recovery lookup without consuming RK.
func (s *Service) RecoveryLookup(_ context.Context, _ authctx.Principal, _ RecoveryLookupInput) (RecoveryLookupResponse, error) {
	return RecoveryLookupResponse{}, errCode("dependency_unavailable")
}

// RecoverComplete hoàn tất khôi phục bằng recovery key, cập nhật KEK mới và xoá hàng RK (`POST /vault/recover/complete`).
// TODO(P03-T10): implement POST /vault/recover/complete in one transaction with idempotency, audit, notice/mail.
func (s *Service) RecoverComplete(_ context.Context, _ authctx.Principal, _ RecoverCompleteInput) (VaultVersionResponse, error) {
	return VaultVersionResponse{}, errCode("dependency_unavailable")
}
