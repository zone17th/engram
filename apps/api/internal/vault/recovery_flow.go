package vault

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync/atomic"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/secevent"
)

var dummyRKWrapBytes [VKWrapBytes]byte

// recoverCompleteBeforeTxHook cho phép barrier test trên Postgres thật giữ hai request
// `POST /vault/recover/complete` ngay sau khi cả hai đã qua bước `Idempotency.Claim`
// (bước 6) và chuẩn bị vào transaction khoá hàng `vault` + `vault_recovery_key` (bước 7).
var recoverCompleteBeforeTxHook atomic.Pointer[func(context.Context)]

// SetRecoverCompleteTestHook đăng ký (hoặc gỡ bỏ khi truyền nil) hook đồng bộ cho barrier test Task 10.
func SetRecoverCompleteTestHook(fn func(context.Context)) {
	if fn == nil {
		recoverCompleteBeforeTxHook.Store(nil)
		return
	}
	recoverCompleteBeforeTxHook.Store(&fn)
}

// RecoveryLookupInput là đầu vào cho `POST /vault/unlock/recovery` (`vaultRecoveryLookup`, plan Task 10).
type RecoveryLookupInput struct {
	LookupHash string `json:"lookup_hash"`
}

// RecoverCompleteInput là đầu vào cho `POST /vault/recover/complete` (`vaultRecoverComplete`, plan Task 10).
type RecoverCompleteInput struct {
	RecoveryKeyID        uuid.UUID          `json:"recovery_key_id"`
	KDFRaw               json.RawMessage    `json:"kdf"`
	VaultKeyWrappedByKEK string             `json:"vault_key_wrapped_by_kek"`
	IfMatch              httpx.VaultIfMatch `json:"-"`
	IP                   string             `json:"-"`
	UA                   string             `json:"-"`
}

// RecoveryLookup tra cứu bản bọc VK theo `lookup_hash` thuộc vault của user hiện tại
// (`POST /vault/unlock/recovery`, plan Task 10, SPEC §3.10, §9.1, §9.2, §10.3):
//   - Giải mã strict base64url 32 byte cho `lookup_hash` (`400 invalid_request` nếu sai định dạng).
//   - Tìm bản ghi RK theo `(user_id, lookup_hash)` trên `vault_recovery_key`; KHÔNG xoá (consume) RK.
//   - Mọi trường hợp không khớp (RK không tồn tại, đã tiêu thụ, thuộc vault của user khác hoặc user chưa có RK)
//     đều đi qua cùng một câu truy vấn đơn và trả về `401 recovery_key_invalid` đồng nhất (cùng body, cùng nhánh
//     encode base64url để giảm thiểu chênh lệch thời gian), đồng thời tăng counter
//     `vault_unlock_failures_total{method="recovery"}`.
func (s *Service) RecoveryLookup(ctx context.Context, p authctx.Principal, in RecoveryLookupInput) (RecoveryLookupResponse, error) {
	hashBytes, err := ValidateLookupHashBase64URL(in.LookupHash)
	if err != nil {
		return RecoveryLookupResponse{}, ErrInvalidRequest
	}

	row, err := s.q.GetRecoveryKeyByUserAndHash(ctx, gen.GetRecoveryKeyByUserAndHashParams{
		UserID:     p.UserID,
		LookupHash: hashBytes,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			_ = EncodeBase64URL(dummyRKWrapBytes[:])
			s.IncRecoveryUnlockFailure()
			return RecoveryLookupResponse{}, ErrRecoveryKeyInvalid
		}
		return RecoveryLookupResponse{}, err
	}

	return RecoveryLookupResponse{
		RecoveryKeyID: row.ID,
		Wrap:          EncodeBase64URL(row.Wrap),
	}, nil
}

// RecoverComplete hoàn tất khôi phục bằng recovery key, cập nhật KEK mới và xoá hàng RK
// (`POST /vault/recover/complete`, plan Task 10, mục 2.1, 2.2, 2.3, 2.7, 3, SPEC §3.10, §8, §9.2, §10.3):
//   - Trong một transaction có `lock_timeout` & `statement_timeout` 30s:
//     1. Khoá hàng `vault` của user (`SELECT ... FOR UPDATE`) và kiểm tra `If-Match` (`404 vault_absent`
//     ưu tiên hơn `412 version_mismatch` kèm `current_version`).
//     2. Khoá hàng `vault_recovery_key` của chính user theo `(user_id, recovery_key_id)` (`FOR UPDATE`);
//     nếu không tồn tại / đã bị tiêu thụ / thuộc user khác -> `401 recovery_key_invalid`.
//     3. Kiểm tra `kdf` dùng `salt` 16 B mới (khác `salt` hiện tại) và không hạ `ops`/`mem` so với hiện tại
//     (`400 vault_kdf_invalid` khi vi phạm).
//     4. Kiểm tra `vault_key_wrapped_by_kek` hợp lệ (`73 B`, byte đầu `0x01`, strict base64url;
//     sai -> `400 vault_wrap_invalid`).
//     5. Cập nhật `kdf` + `vault_key_wrapped_by_kek` và tăng `vault.version = version + 1`.
//     6. Xoá hẳn (`DELETE`) hàng RK vừa dùng khỏi `vault_recovery_key`.
//     7. Ghi 2 bản ghi `audit_log`: `vault.recover` và `recovery_key.consume` (metadata không chứa bí mật).
//     8. Tạo in-app security notice (`user_notification`) trong cùng transaction.
//     9. Cập nhật `idempotency_key` `status = 'done'` kèm kiểm tra `owner_token` ngay trước `COMMIT`.
//   - Sau khi `COMMIT` thành công: tăng `vault_recover_total` và gửi email thông báo bảo mật best-effort.
func (s *Service) RecoverComplete(ctx context.Context, p authctx.Principal, in RecoverCompleteInput) (VaultVersionResponse, error) {
	if s.KeyMutationsDisabled() {
		return VaultVersionResponse{}, ErrVaultMutationsDisabled
	}
	if !ValidateVaultKeyID(in.IfMatch.VaultKeyID) || in.IfMatch.Version < 1 {
		return VaultVersionResponse{}, ErrPreconditionRequired
	}
	if in.RecoveryKeyID == uuid.Nil {
		return VaultVersionResponse{}, ErrInvalidRequest
	}

	if fnPtr := recoverCompleteBeforeTxHook.Load(); fnPtr != nil && *fnPtr != nil {
		(*fnPtr)(ctx)
	}

	tx, err := s.BeginMutationTx(ctx)
	if err != nil {
		return VaultVersionResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)

	// 1. Lock vault row FOR UPDATE and verify If-Match (404 vault_absent before 412 version_mismatch).
	curVault, err := LockVaultAndCheckIfMatch(ctx, q, p.UserID, in.IfMatch)
	if err != nil {
		return VaultVersionResponse{}, err
	}

	// 2. Lock the user's recovery key row FOR UPDATE; must exist and belong to this user.
	rkRow, err := q.GetRecoveryKeyByUserAndIDForUpdate(ctx, gen.GetRecoveryKeyByUserAndIDForUpdateParams{
		UserID: p.UserID,
		ID:     in.RecoveryKeyID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return VaultVersionResponse{}, ErrRecoveryKeyInvalid
		}
		return VaultVersionResponse{}, err
	}

	// 3. Validate new KDF params against current vault KDF (fresh salt != current salt, ops/mem not lowered).
	_, kdfJSON, err := ValidateKDFParamsForRewrap(in.KDFRaw, curVault.Kdf)
	if err != nil {
		return VaultVersionResponse{}, ErrVaultKDFInvalid
	}

	// 4. Validate new KEK wrap (strict base64url, 73 bytes, leading version byte 0x01).
	kekWrapBytes, err := ValidateWrapBase64URL(in.VaultKeyWrappedByKEK, WrapKindKEK)
	if err != nil {
		return VaultVersionResponse{}, ErrVaultWrapInvalid
	}

	// 5. Rewrap KEK and increment vault.version.
	updatedVault, err := q.RewrapVaultKEK(ctx, gen.RewrapVaultKEKParams{
		Kdf:                  kdfJSON,
		VaultKeyWrappedByKek: kekWrapBytes,
		UserID:               p.UserID,
		ExpectedVersion:      curVault.Version,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return VaultVersionResponse{}, VersionMismatchError(curVault.Version)
		}
		return VaultVersionResponse{}, err
	}

	// 6. DELETE (consume) the recovery key row in the same transaction.
	deleted, err := q.ConsumeRecoveryKeyByID(ctx, gen.ConsumeRecoveryKeyByIDParams{
		UserID: p.UserID,
		ID:     rkRow.ID,
	})
	if err != nil {
		return VaultVersionResponse{}, err
	}
	if deleted != 1 {
		return VaultVersionResponse{}, ErrRecoveryKeyInvalid
	}

	// 7. Record both audit events `vault.recover` and `recovery_key.consume` in the same transaction.
	if err := s.RecordAuditTx(ctx, tx, p, EventVaultRecover, in.IP, in.UA, secevent.Meta{}); err != nil {
		return VaultVersionResponse{}, err
	}
	if err := s.RecordAuditTx(ctx, tx, p, EventRecoveryKeyConsume, in.IP, in.UA, secevent.Meta{}); err != nil {
		return VaultVersionResponse{}, err
	}

	// 8. Create in-app security notice in the same transaction (created even if user has no verified email).
	emailTargets, err := s.RecordSecurityNoticeTx(ctx, tx, p.UserID, secevent.Meta{})
	if err != nil {
		return VaultVersionResponse{}, err
	}

	resp := VaultVersionResponse{
		Version: updatedVault.Version,
	}

	// 9. Update idempotency_key status='done' with owner_token check right before COMMIT.
	if _, err := s.CommitMutationWithIdempotency(ctx, tx, http.StatusOK, resp); err != nil {
		return VaultVersionResponse{}, err
	}

	// 10. After COMMIT, increment Prometheus counter `vault_recover_total` and send best-effort security emails.
	s.IncRecoverTotal()
	s.SendSecurityEmailsBestEffort(ctx, emailTargets, EventVaultRecover)

	return resp, nil
}
