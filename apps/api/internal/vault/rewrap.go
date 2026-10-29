package vault

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/secevent"
)

// RewrapInput là đầu vào cho `PUT /vault/kek` (`vaultRewrap`, plan Task 9, SPEC §3.9, §8, §9.2).
type RewrapInput struct {
	KDFRaw               json.RawMessage    `json:"kdf"`
	VaultKeyWrappedByKEK string             `json:"vault_key_wrapped_by_kek"`
	IfMatch              httpx.VaultIfMatch `json:"-"`
	IP                   string             `json:"-"`
	UA                   string             `json:"-"`
}

// Rewrap đổi passphrase mã hoá vault (`PUT /vault/kek`, plan Task 9, mục 2.1, 2.3, 2.7, 3):
//   - Khoá hàng `vault` của user (`SELECT ... FOR UPDATE`), so `If-Match` (không có hàng -> 404 `vault_absent`
//     trước 412 `version_mismatch` kèm `current_version`).
//   - Kiểm tra `kdf` bằng `ValidateKDFParamsForRewrap` (bắt buộc salt 16 B mới khác salt hiện tại và
//     không hạ `ops`/`mem` so với hiện tại -> sai trả `400 vault_kdf_invalid`).
//   - Kiểm tra `vault_key_wrapped_by_kek` bằng `ValidateWrapBase64URL(..., WrapKindKEK)` (73 B, byte đầu `0x01`
//     -> sai trả `400 vault_wrap_invalid`).
//   - Cập nhật `kdf` + `vault_key_wrapped_by_kek`, tăng `version = version + 1` (không đổi `vault_key_id`,
//     không đụng RK hay passkey).
//   - Ghi audit `vault.rewrap`, tạo in-app security notice (`user_notification` + job `security_notice_mail`
//     qua P02 `Notifier`) và đánh dấu `idempotency_key` `status = 'done'` trong cùng transaction trước khi `COMMIT`.
//     Worker gửi email sau khi `COMMIT`, nên lỗi gửi mail không bao giờ làm rollback mutation đã commit.
func (s *Service) Rewrap(ctx context.Context, p authctx.Principal, in RewrapInput) (VaultVersionResponse, error) {
	if s.KeyMutationsDisabled() {
		return VaultVersionResponse{}, ErrVaultMutationsDisabled
	}
	if !ValidateVaultKeyID(in.IfMatch.VaultKeyID) || in.IfMatch.Version < 1 {
		return VaultVersionResponse{}, ErrPreconditionRequired
	}

	tx, err := s.BeginMutationTx(ctx)
	if err != nil {
		return VaultVersionResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)

	// 1. Lock vault row FOR UPDATE and verify If-Match (404 vault_absent takes precedence over 412 version_mismatch).
	curVault, err := LockVaultAndCheckIfMatch(ctx, q, p.UserID, in.IfMatch)
	if err != nil {
		return VaultVersionResponse{}, err
	}

	// 2. Validate KDF params against current vault KDF (fresh salt != current salt, ops/mem not lowered).
	_, kdfJSON, err := ValidateKDFParamsForRewrap(in.KDFRaw, curVault.Kdf)
	if err != nil {
		return VaultVersionResponse{}, ErrVaultKDFInvalid
	}

	// 3. Validate new KEK wrap (strict base64url, 73 bytes, leading version byte 0x01).
	kekWrapBytes, err := ValidateWrapBase64URL(in.VaultKeyWrappedByKEK, WrapKindKEK)
	if err != nil {
		return VaultVersionResponse{}, ErrVaultWrapInvalid
	}

	// 4. Update kdf + vault_key_wrapped_by_kek and bump version in the locked vault row.
	updatedVault, err := q.RewrapVaultKEK(ctx, gen.RewrapVaultKEKParams{
		Kdf:                  kdfJSON,
		VaultKeyWrappedByKek: kekWrapBytes,
		UserID:               p.UserID,
		ExpectedVersion:      curVault.Version,
	})
	if err != nil {
		return VaultVersionResponse{}, err
	}

	// 5. Record audit event `vault.rewrap` in the same transaction (metadata sanitized, no secrets).
	if err := s.RecordAuditTx(ctx, tx, p, EventVaultRewrap, in.IP, in.UA, secevent.Meta{}); err != nil {
		return VaultVersionResponse{}, err
	}

	// 6. Create in-app security notice (and transactional River mail job if email verified) in the same transaction.
	if err := s.RecordSecurityNoticeTx(ctx, tx, p.UserID, secevent.Meta{}); err != nil {
		return VaultVersionResponse{}, err
	}

	resp := VaultVersionResponse{
		Version: updatedVault.Version,
	}

	// 7. Record idempotency done-row with owner_token check and COMMIT transaction.
	if _, err := s.CommitMutationWithIdempotency(ctx, tx, http.StatusOK, resp); err != nil {
		return VaultVersionResponse{}, err
	}

	return resp, nil
}
