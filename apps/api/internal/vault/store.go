package vault

import (
	"context"
	"encoding/json"
	"errors"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// LockVaultAndCheckIfMatch khoá hàng `vault` của user (`SELECT ... FOR UPDATE`) trong `tx`
// và kiểm tra điều kiện tiên quyết `If-Match: "<vault_key_id>:<version>"` theo đúng thứ tự
// ưu tiên của plan mục 2.3 và SPEC §9.1:
//  1. `SELECT * FROM vault WHERE user_id = $1 FOR UPDATE`.
//  2. Nếu không có hàng vault (`pgx.ErrNoRows`) -> trả `ErrVaultAbsent` (404 ưu tiên hơn 412).
//  3. Nếu lệch `vault_key_id` hoặc `version` -> trả `*Error{Code: "version_mismatch", CurrentVersion: &v.Version}` (412 kèm `current_version`).
func LockVaultAndCheckIfMatch(ctx context.Context, q *gen.Queries, userID uuid.UUID, expected httpx.VaultIfMatch) (gen.Vault, error) {
	v, err := q.GetVaultByUserForUpdate(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.Vault{}, ErrVaultAbsent
		}
		return gen.Vault{}, err
	}
	if v.VaultKeyID != expected.VaultKeyID || v.Version != expected.Version {
		return gen.Vault{}, VersionMismatchError(v.Version)
	}
	return v, nil
}

// ComputeEmptySlots trả danh sách các slot từ `1..10` chưa có mặt trong `occupiedSlots` (sắp xếp tăng dần).
// Luôn trả slice khác nil (`[]int{}` khi đầy đủ 10 slot) để JSON serialize thành `[]` chứ không phải `null`.
func ComputeEmptySlots(occupiedSlots []int32) []int {
	taken := make(map[int]struct{}, len(occupiedSlots))
	for _, s := range occupiedSlots {
		taken[int(s)] = struct{}{}
	}
	empty := make([]int, 0, RecoveryKeySlots)
	for slot := RecoveryKeySlotMin; slot <= RecoveryKeySlotMax; slot++ {
		if _, ok := taken[slot]; !ok {
			empty = append(empty, slot)
		}
	}
	sort.Ints(empty)
	return empty
}

// FormatPasskeyItem chuyển đổi `gen.VaultPasskey` sang DTO `PasskeyItem` (chỉ trả metadata:
// `id`, `name`, `aaguid`, `created_at`; không bao giờ trả `vk_wrap`, `prf_salt`, `cred_id`, `pubkey`).
func FormatPasskeyItem(row gen.VaultPasskey) PasskeyItem {
	var aaguid *string
	if len(row.Aaguid) == 16 {
		if u, err := uuid.FromBytes(row.Aaguid); err == nil {
			s := u.String()
			aaguid = &s
		}
	}
	return PasskeyItem{
		ID:        row.ID,
		Name:      row.Name,
		AAGUID:    aaguid,
		CreatedAt: row.CreatedAt.Time.UTC(),
	}
}

// FormatVaultState chuyển đổi hàng `gen.Vault`, số lượng RK còn lại và danh sách passkey
// sang DTO `VaultState` trả về trên `GET /vault` (plan mục 3, OpenAPI `VaultState`).
func FormatVaultState(row gen.Vault, remaining int32, passkeyRows []gen.VaultPasskey) (VaultState, error) {
	var kdf KDFParams
	if err := json.Unmarshal(row.Kdf, &kdf); err != nil {
		return VaultState{}, err
	}
	passkeys := make([]PasskeyItem, 0, len(passkeyRows))
	for _, pk := range passkeyRows {
		passkeys = append(passkeys, FormatPasskeyItem(pk))
	}
	return VaultState{
		VaultKeyID:            row.VaultKeyID,
		Version:               row.Version,
		KDF:                   kdf,
		VaultKeyWrappedByKEK:  EncodeBase64URL(row.VaultKeyWrappedByKek),
		X25519Public:          EncodeBase64URL(row.X25519Public),
		Ed25519Public:         EncodeBase64URL(row.Ed25519Public),
		PrivateKeysWrapped:    EncodeBase64URL(row.PrivateKeysWrapped),
		RecoveryKeysRemaining: int(remaining),
		Passkeys:              passkeys,
	}, nil
}
