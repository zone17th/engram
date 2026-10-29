package vault

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Get trả trạng thái vault hiện tại của `userID` cho `GET /vault` (`vaultGet`, plan Task 8, mục 3).
// Chỉ đọc dữ liệu của chính `userID` từ principal; nếu chưa tạo vault trả `ErrVaultAbsent` (404).
func (s *Service) Get(ctx context.Context, userID uuid.UUID) (VaultState, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return VaultState{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)
	row, err := q.GetVaultByUser(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return VaultState{}, ErrVaultAbsent
		}
		return VaultState{}, err
	}
	remaining, err := q.CountRecoveryKeysByUser(ctx, userID)
	if err != nil {
		return VaultState{}, err
	}
	passkeys, err := q.ListPasskeysByUser(ctx, userID)
	if err != nil {
		return VaultState{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return VaultState{}, err
	}
	return FormatVaultState(row, remaining, passkeys)
}

// GetRecoveryKeysStatus trả số lượng RK còn lại, tổng số slot (10) và danh sách các slot trống (`1..10`)
// của `userID` cho `GET /vault/recovery-keys` (`vaultRecoveryKeysGet`, plan Task 8, mục 3).
// Không bao giờ trả lại `lookup_hash` hay `wrap`. Nếu chưa có vault trả `ErrVaultAbsent` (404).
func (s *Service) GetRecoveryKeysStatus(ctx context.Context, userID uuid.UUID) (RecoveryKeysStatus, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return RecoveryKeysStatus{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)
	exists, err := q.VaultExistsByUser(ctx, userID)
	if err != nil {
		return RecoveryKeysStatus{}, err
	}
	if !exists {
		return RecoveryKeysStatus{}, ErrVaultAbsent
	}
	slots, err := q.ListRecoveryKeySlotsByUser(ctx, userID)
	if err != nil {
		return RecoveryKeysStatus{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RecoveryKeysStatus{}, err
	}
	empty := ComputeEmptySlots(slots)
	return RecoveryKeysStatus{
		Remaining:  len(slots),
		Slots:      RecoveryKeySlots,
		EmptySlots: empty,
	}, nil
}

// ListPasskeys trả danh sách metadata passkey (`{id, name, aaguid, created_at}`) của `userID`
// cho `GET /vault/passkeys` (`vaultPasskeysList`, plan Task 8, mục 3).
// Không bao giờ trả `vk_wrap`, `prf_salt`, `cred_id` hay `pubkey`. Nếu chưa có vault trả `ErrVaultAbsent` (404).
func (s *Service) ListPasskeys(ctx context.Context, userID uuid.UUID) (PasskeyList, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return PasskeyList{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)
	exists, err := q.VaultExistsByUser(ctx, userID)
	if err != nil {
		return PasskeyList{}, err
	}
	if !exists {
		return PasskeyList{}, ErrVaultAbsent
	}
	rows, err := q.ListPasskeysByUser(ctx, userID)
	if err != nil {
		return PasskeyList{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PasskeyList{}, err
	}
	items := make([]PasskeyItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, FormatPasskeyItem(r))
	}
	return PasskeyList{Items: items}, nil
}
