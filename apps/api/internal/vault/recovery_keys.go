package vault

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"

	"github.com/jackc/pgx/v5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/secevent"
)

// regenerateBeforeTxHook cho phép test đồng bộ hai request `POST /vault/recovery-keys/regenerate`
// song song ngay sau bước `Idempotency.Claim` để kiểm chứng trên Postgres thật không bao giờ vượt 10 RK.
var regenerateBeforeTxHook atomic.Pointer[func(context.Context)]

// SetRegenerateTestHook đăng ký (hoặc gỡ bỏ khi truyền nil) hook đồng bộ cho test song song Task 11.
func SetRegenerateTestHook(fn func(context.Context)) {
	if fn == nil {
		regenerateBeforeTxHook.Store(nil)
		return
	}
	regenerateBeforeTxHook.Store(&fn)
}

// RecoveryKeysRegenerateInput là đầu vào cho `POST /vault/recovery-keys/regenerate` (`vaultRecoveryKeysRegenerate`, plan Task 11).
type RecoveryKeysRegenerateInput struct {
	RecoveryKeys []RecoveryKeyUploadItem `json:"recovery_keys"`
	IfMatch      httpx.VaultIfMatch      `json:"-"`
	IP           string                  `json:"-"`
	UA           string                  `json:"-"`
}

// RecoveryKeysRotateInput là đầu vào cho `POST /vault/recovery-keys/rotate` (`vaultRecoveryKeysRotate`, plan Task 11).
type RecoveryKeysRotateInput struct {
	RecoveryKeys []RecoveryKeyUploadItem `json:"recovery_keys"`
	IfMatch      httpx.VaultIfMatch      `json:"-"`
	IP           string                  `json:"-"`
	UA           string                  `json:"-"`
}

func validateRecoveryKeyUploadItems(items []RecoveryKeyUploadItem) ([]validatedRecoveryKeyRow, error) {
	out := make([]validatedRecoveryKeyRow, 0, len(items))
	for _, item := range items {
		wrapBytes, err := ValidateWrapBase64URL(item.Wrap, WrapKindRK)
		if err != nil {
			return nil, ErrVaultWrapInvalid
		}
		hashBytes, err := ValidateLookupHashBase64URL(item.LookupHash)
		if err != nil {
			return nil, ErrInvalidRequest
		}
		if item.Slot < RecoveryKeySlotMin || item.Slot > RecoveryKeySlotMax {
			return nil, ErrRecoveryKeySlotTaken
		}
		out = append(out, validatedRecoveryKeyRow{
			slot:       int32(item.Slot),
			lookupHash: hashBytes,
			wrap:       wrapBytes,
		})
	}
	return out, nil
}

// RegenerateRecoveryKeys bù các recovery key mới vào các slot đang trống
// (`POST /vault/recovery-keys/regenerate`, plan Task 11, mục 2.2, 2.3, 2.7, 3, SPEC §3.12, §8, §9.2):
//   - Khoá hàng `vault` của user (`SELECT ... FOR UPDATE`) và kiểm tra `If-Match` (`404 vault_absent`
//     trước `412 version_mismatch` kèm `current_version`).
//   - Đếm số RK hiện còn (`remaining`); số lượng phần tử gửi lên phải nằm trong `1..(10 - remaining)`
//     (khi `remaining == 10` hoặc gửi `0` / vượt số slot trống -> `400 recovery_keys_count`).
//   - Kiểm tra từng phần tử (`wrap` 73B version `0x01` -> sai trả `400 vault_wrap_invalid`; `lookup_hash`
//     32B base64url; `slot` trong `1..10` và đang trống -> sai/đã có key trả `409 recovery_key_slot_taken`).
//   - Insert các RK mới vào `vault_recovery_key` (ánh xạ mọi vi phạm `UNIQUE(lookup_hash)` sang
//     `409 recovery_key_conflict` không lộ chủ sở hữu và `UNIQUE(vault_id, slot)` sang `409 recovery_key_slot_taken`).
//   - Đảm bảo tổng số RK sau khi bù không bao giờ vượt 10, tăng `vault.version = version + 1`,
//     ghi audit `recovery_key.regenerate` và cập nhật `idempotency_key` `status = 'done'` trong cùng transaction.
func (s *Service) RegenerateRecoveryKeys(ctx context.Context, p authctx.Principal, in RecoveryKeysRegenerateInput) (RecoveryKeysMutationResponse, error) {
	if s.KeyMutationsDisabled() {
		return RecoveryKeysMutationResponse{}, ErrVaultMutationsDisabled
	}
	if !ValidateVaultKeyID(in.IfMatch.VaultKeyID) || in.IfMatch.Version < 1 {
		return RecoveryKeysMutationResponse{}, ErrPreconditionRequired
	}

	if fnPtr := regenerateBeforeTxHook.Load(); fnPtr != nil && *fnPtr != nil {
		(*fnPtr)(ctx)
	}

	tx, err := s.BeginMutationTx(ctx)
	if err != nil {
		return RecoveryKeysMutationResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)

	// 1. Lock vault row FOR UPDATE and verify If-Match (serializes concurrent regenerates for the user).
	curVault, err := LockVaultAndCheckIfMatch(ctx, q, p.UserID, in.IfMatch)
	if err != nil {
		return RecoveryKeysMutationResponse{}, err
	}

	// 2. Count remaining RKs while holding the vault lock; accept 1..(10-remaining) items.
	rem, err := q.CountRecoveryKeysByUser(ctx, p.UserID)
	if err != nil {
		return RecoveryKeysMutationResponse{}, err
	}
	emptyCount := RecoveryKeySlots - int(rem)
	if len(in.RecoveryKeys) < 1 || len(in.RecoveryKeys) > emptyCount {
		return RecoveryKeysMutationResponse{}, ErrRecoveryKeysCount
	}

	// 3. Validate wraps, lookup_hash encoding, and slot bounds (1..10).
	rkRows, err := validateRecoveryKeyUploadItems(in.RecoveryKeys)
	if err != nil {
		return RecoveryKeysMutationResponse{}, err
	}

	// 4. Insert into EMPTY slots only; map UNIQUE(lookup_hash) -> 409 recovery_key_conflict
	// and UNIQUE(vault_id, slot) -> 409 recovery_key_slot_taken.
	for _, rk := range rkRows {
		if _, err := q.InsertRecoveryKey(ctx, gen.InsertRecoveryKeyParams{
			UserID:     p.UserID,
			Slot:       rk.slot,
			LookupHash: rk.lookupHash,
			Wrap:       rk.wrap,
		}); err != nil {
			return RecoveryKeysMutationResponse{}, MapRecoveryKeyUniqueError(err)
		}
	}

	// 5. Verify total remaining RKs never exceeds 10.
	newRem, err := q.CountRecoveryKeysByUser(ctx, p.UserID)
	if err != nil {
		return RecoveryKeysMutationResponse{}, err
	}
	if int(newRem) > RecoveryKeySlots {
		return RecoveryKeysMutationResponse{}, ErrRecoveryKeysCount
	}

	// 6. Bump vault.version.
	updatedVault, err := q.BumpVaultVersion(ctx, gen.BumpVaultVersionParams{
		UserID:          p.UserID,
		ExpectedVersion: curVault.Version,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RecoveryKeysMutationResponse{}, VersionMismatchError(curVault.Version)
		}
		return RecoveryKeysMutationResponse{}, err
	}

	// 7. Record audit event `recovery_key.regenerate` in the same transaction.
	if err := s.RecordAuditTx(ctx, tx, p, EventRecoveryKeyRegenerate, in.IP, in.UA, secevent.Meta{}); err != nil {
		return RecoveryKeysMutationResponse{}, err
	}

	resp := RecoveryKeysMutationResponse{
		Remaining: int(newRem),
		Version:   updatedVault.Version,
	}

	// 8. Update idempotency_key status='done' with owner_token check right before COMMIT.
	if _, err := s.CommitMutationWithIdempotency(ctx, tx, http.StatusOK, resp); err != nil {
		return RecoveryKeysMutationResponse{}, err
	}

	return resp, nil
}

// RotateRecoveryKeys thay thế toàn bộ 10 recovery key trong một transaction
// (`POST /vault/recovery-keys/rotate`, plan Task 11, mục 2.2, 2.3, 2.7, 3, SPEC §3.12, §8, §9.2):
//   - Khoá hàng `vault` của user (`SELECT ... FOR UPDATE`) và kiểm tra `If-Match` (`404 vault_absent`
//     trước `412 version_mismatch` kèm `current_version`).
//   - Bắt buộc đúng 10 phần tử (`len != 10` -> `400 recovery_keys_count`) ứng với các slot `1..10`.
//   - Kiểm tra từng phần tử (`wrap` 73B version `0x01` -> sai trả `400 vault_wrap_invalid`; `lookup_hash`
//     32B base64url; `slot` trong `1..10` -> sai trả `409 recovery_key_slot_taken`).
//   - Xoá toàn bộ RK hiện có của user và insert đủ 10 RK mới trong cùng transaction; ánh xạ mọi vi phạm
//     `UNIQUE(lookup_hash)` (trong cùng request hoặc trùng với user khác) sang `409 recovery_key_conflict`
//     (không lộ chủ sở hữu) và `UNIQUE(vault_id, slot)` sang `409 recovery_key_slot_taken`.
//   - Tăng `vault.version = version + 1`, ghi audit `recovery_key.rotate`, tạo in-app security notice
//     (kèm job mail River trong tx) và cập nhật `idempotency_key` `status = 'done'` trước khi `COMMIT`.
func (s *Service) RotateRecoveryKeys(ctx context.Context, p authctx.Principal, in RecoveryKeysRotateInput) (RecoveryKeysMutationResponse, error) {
	if s.KeyMutationsDisabled() {
		return RecoveryKeysMutationResponse{}, ErrVaultMutationsDisabled
	}
	if !ValidateVaultKeyID(in.IfMatch.VaultKeyID) || in.IfMatch.Version < 1 {
		return RecoveryKeysMutationResponse{}, ErrPreconditionRequired
	}

	tx, err := s.BeginMutationTx(ctx)
	if err != nil {
		return RecoveryKeysMutationResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)

	// 1. Lock vault row FOR UPDATE and verify If-Match.
	curVault, err := LockVaultAndCheckIfMatch(ctx, q, p.UserID, in.IfMatch)
	if err != nil {
		return RecoveryKeysMutationResponse{}, err
	}

	// 2. Must have exactly 10 recovery keys.
	if len(in.RecoveryKeys) != RecoveryKeySlots {
		return RecoveryKeysMutationResponse{}, ErrRecoveryKeysCount
	}

	// 3. Validate wraps, lookup_hash encoding, and slot bounds (1..10).
	rkRows, err := validateRecoveryKeyUploadItems(in.RecoveryKeys)
	if err != nil {
		return RecoveryKeysMutationResponse{}, err
	}

	// 4. Delete all existing RKs of the user and insert all 10 new RKs in the same transaction.
	// Any duplicate slot in the 10 items or duplicate lookup_hash (in-request or cross-user) hits
	// PostgreSQL 23505 and is mapped by MapRecoveryKeyUniqueError to 409 recovery_key_slot_taken
	// or 409 recovery_key_conflict (rolling back the transaction so old RKs remain intact).
	if _, err := q.DeleteRecoveryKeysByUser(ctx, p.UserID); err != nil {
		return RecoveryKeysMutationResponse{}, err
	}
	for _, rk := range rkRows {
		if _, err := q.InsertRecoveryKey(ctx, gen.InsertRecoveryKeyParams{
			UserID:     p.UserID,
			Slot:       rk.slot,
			LookupHash: rk.lookupHash,
			Wrap:       rk.wrap,
		}); err != nil {
			return RecoveryKeysMutationResponse{}, MapRecoveryKeyUniqueError(err)
		}
	}

	// 5. Bump vault.version.
	updatedVault, err := q.BumpVaultVersion(ctx, gen.BumpVaultVersionParams{
		UserID:          p.UserID,
		ExpectedVersion: curVault.Version,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RecoveryKeysMutationResponse{}, VersionMismatchError(curVault.Version)
		}
		return RecoveryKeysMutationResponse{}, err
	}

	// 6. Record audit event `recovery_key.rotate` in the same transaction.
	if err := s.RecordAuditTx(ctx, tx, p, EventRecoveryKeyRotate, in.IP, in.UA, secevent.Meta{}); err != nil {
		return RecoveryKeysMutationResponse{}, err
	}

	// 7. Create in-app security notice (and transactional River mail job if email verified) in the same transaction.
	if err := s.RecordSecurityNoticeTx(ctx, tx, p.UserID, secevent.Meta{}); err != nil {
		return RecoveryKeysMutationResponse{}, err
	}

	resp := RecoveryKeysMutationResponse{
		Remaining: RecoveryKeySlots,
		Version:   updatedVault.Version,
	}

	// 8. Update idempotency_key status='done' with owner_token check right before COMMIT.
	if _, err := s.CommitMutationWithIdempotency(ctx, tx, http.StatusOK, resp); err != nil {
		return RecoveryKeysMutationResponse{}, err
	}

	return resp, nil
}
