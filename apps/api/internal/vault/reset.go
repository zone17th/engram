package vault

import (
	"context"
	"net/http"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/secevent"
)

// ResetInput là đầu vào cho `DELETE /vault` (`vaultReset`, plan Task 12, SPEC §3.10, §8, §9.2).
type ResetInput struct {
	IfMatch httpx.VaultIfMatch
	IP      string
	UA      string
}

// Reset xoá toàn bộ vault, RK, passkey, webauthn_challenge và các bản ghi idempotency vault khác của user
// cùng gọi `ResetHook` trong một transaction (`DELETE /vault`, plan Task 12, mục 2.3, 3, 7):
//   - Khoá hàng `vault` của user (`SELECT ... FOR UPDATE`), so `If-Match` (không có hàng -> 404 `vault_absent`
//     trước 412 `version_mismatch` kèm `current_version`).
//   - Gọi `ResetHook(ctx, tx, p.UserID)` trong cùng transaction (P03 mặc định no-op; P04 xoá entries;
//     nếu hook trả lỗi -> rollback toàn bộ transaction, giữ nguyên vault).
//   - Xoá recovery keys (`vault_recovery_key`), passkeys (`vault_passkey`), challenges (`webauthn_challenge`),
//     các bản ghi idempotency khác của user trên `/api/v1/vault%` (`path LIKE '/api/v1/vault%' AND key <> $k`,
//     giữ lại bản ghi của chính request reset hiện tại), và hàng `vault` (kèm FK `ON DELETE CASCADE`).
//   - Ghi audit `vault.reset`, tạo in-app security notice (`user_notification`) và đánh dấu `idempotency_key`
//     `status = 'done'` (`status_code = 204`, `response = NULL`) trong cùng transaction trước khi `COMMIT`.
//   - Sau khi `COMMIT`, gửi email thông báo bảo mật best-effort qua adapter P02 (lỗi gửi mail không rollback).
func (s *Service) Reset(ctx context.Context, p authctx.Principal, in ResetInput) error {
	if s.KeyMutationsDisabled() {
		return ErrVaultMutationsDisabled
	}
	if !ValidateVaultKeyID(in.IfMatch.VaultKeyID) || in.IfMatch.Version < 1 {
		return ErrPreconditionRequired
	}

	tx, err := s.BeginMutationTx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)

	// 1. Lock vault row FOR UPDATE and verify If-Match (404 vault_absent takes precedence over 412 version_mismatch).
	if _, err := LockVaultAndCheckIfMatch(ctx, q, p.UserID, in.IfMatch); err != nil {
		return err
	}

	// 2. Call ResetHook inside the same transaction (P03 no-op; P04 deletes all entries of user).
	if hook := s.ResetHook(); hook != nil {
		if err := hook(ctx, tx, p.UserID); err != nil {
			return err
		}
	}

	// 3. Delete recovery keys, passkeys, WebAuthn challenges, other vault idempotency keys, and the vault row.
	if _, err := q.DeleteRecoveryKeysByUser(ctx, p.UserID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM vault_passkey WHERE user_id = $1`, p.UserID); err != nil {
		return err
	}
	if _, err := q.DeleteWebAuthnChallengesByUser(ctx, p.UserID); err != nil {
		return err
	}
	if _, hasClaim := httpx.IdempotencyClaimFrom(ctx); hasClaim {
		if err := httpx.PurgeOtherVaultIdempotencyKeysTx(ctx, tx); err != nil {
			return err
		}
	} else {
		if _, err := q.PurgeVaultIdempotencyKeys(ctx, gen.PurgeVaultIdempotencyKeysParams{
			UserID: p.UserID,
			Key:    "",
		}); err != nil {
			return err
		}
	}
	if _, err := q.DeleteVaultByUser(ctx, p.UserID); err != nil {
		return err
	}

	// 4. Record audit event `vault.reset` in the same transaction.
	if err := s.RecordAuditTx(ctx, tx, p, EventVaultReset, in.IP, in.UA, secevent.Meta{}); err != nil {
		return err
	}

	// 5. Create in-app security notice in the same transaction.
	emailTargets, err := s.RecordSecurityNoticeTx(ctx, tx, p.UserID, secevent.Meta{})
	if err != nil {
		return err
	}

	// 6. Mark idempotency done-row (204 No Content, nil response body) and COMMIT transaction.
	if _, err := s.CommitMutationWithIdempotency(ctx, tx, http.StatusNoContent, nil); err != nil {
		return err
	}

	// 7. After COMMIT, send security email notification best-effort; mail errors never roll back.
	s.SendSecurityEmailsBestEffort(ctx, emailTargets, EventVaultReset)

	return nil
}
