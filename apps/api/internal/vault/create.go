package vault

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/secevent"
)

// CreateVaultInput là đầu vào của `POST /vault` (`vaultCreate`, plan Task 8, SPEC §3.2, §8, §9.2).
type CreateVaultInput struct {
	KDFRaw               json.RawMessage         `json:"kdf"`
	VaultKeyWrappedByKEK string                  `json:"vault_key_wrapped_by_kek"`
	X25519Public         string                  `json:"x25519_public"`
	Ed25519Public        string                  `json:"ed25519_public"`
	PrivateKeysWrapped   string                  `json:"private_keys_wrapped"`
	RecoveryKeys         []RecoveryKeyUploadItem `json:"recovery_keys"`
	IP                   string                  `json:"-"`
	UA                   string                  `json:"-"`
}

type validatedRecoveryKeyRow struct {
	slot       int32
	lookupHash []byte
	wrap       []byte
}

// ValidateRecoveryKeyBatchForCreateOrRotate kiểm tra lô đúng 10 recovery key cho `POST /vault`
// và `POST /vault/recovery-keys/rotate` (plan mục 2.2, 2.7, Task 8, Task 11):
//   - Đúng 10 phần tử (`len != 10` -> `400 recovery_keys_count`).
//   - `slot` nằm trong `1..10`, không trùng `slot` trong cùng request (`400 recovery_keys_count` cho create,
//     hoặc caller rotate có thể map theo ngữ cảnh).
//   - `lookup_hash` giải mã strict base64url ra đúng 32 byte; không trùng `lookup_hash` trong cùng request
//     (`409 recovery_key_conflict`).
//   - `wrap` giải mã strict base64url và qua `ValidateWrapBase64URL(..., WrapKindRK)` (73 B, byte đầu `0x01`;
//     sai -> `400 vault_wrap_invalid`).
func ValidateRecoveryKeyBatchForCreateOrRotate(items []RecoveryKeyUploadItem) ([]validatedRecoveryKeyRow, error) {
	if len(items) != RecoveryKeySlots {
		return nil, ErrRecoveryKeysCount
	}
	seenSlots := make(map[int]struct{}, RecoveryKeySlots)
	seenHashes := make(map[[RKHashBytes]byte]struct{}, RecoveryKeySlots)
	out := make([]validatedRecoveryKeyRow, 0, RecoveryKeySlots)

	for _, item := range items {
		if item.Slot < RecoveryKeySlotMin || item.Slot > RecoveryKeySlotMax {
			return nil, ErrRecoveryKeysCount
		}
		if _, dupSlot := seenSlots[item.Slot]; dupSlot {
			return nil, ErrRecoveryKeysCount
		}
		seenSlots[item.Slot] = struct{}{}

		hashBytes, err := ValidateLookupHashBase64URL(item.LookupHash)
		if err != nil {
			return nil, err
		}
		var hashKey [RKHashBytes]byte
		copy(hashKey[:], hashBytes)
		if _, dupHash := seenHashes[hashKey]; dupHash {
			return nil, ErrRecoveryKeyConflict
		}
		seenHashes[hashKey] = struct{}{}

		wrapBytes, err := ValidateWrapBase64URL(item.Wrap, WrapKindRK)
		if err != nil {
			return nil, ErrVaultWrapInvalid
		}

		out = append(out, validatedRecoveryKeyRow{
			slot:       int32(item.Slot),
			lookupHash: hashBytes,
			wrap:       wrapBytes,
		})
	}
	return out, nil
}

// Create khởi tạo vault mới kèm đúng 10 recovery key trong một transaction duy nhất
// cùng bản ghi `audit_log` (`vault.create`) và hoàn tất `idempotency_key` (`status = 'done'`)
// trước khi COMMIT (plan Task 8, mục 2.1, 2.2, 2.3, 2.7).
func (s *Service) Create(ctx context.Context, p authctx.Principal, in CreateVaultInput) (VaultCreatedResponse, error) {
	if s.KeyMutationsDisabled() {
		return VaultCreatedResponse{}, ErrVaultMutationsDisabled
	}

	// 1. Validate KDF params (strict 5 fields, no duplicate keys, argon2id13, ops 3..10, mem 64..256 MiB, p=1, 16B salt).
	_, _, kdfJSON, err := ValidateKDFParamsForCreate(in.KDFRaw)
	if err != nil {
		return VaultCreatedResponse{}, ErrVaultKDFInvalid
	}

	// 2. Validate wraps and public keys using shared crypto-lane validators.
	kekWrapBytes, err := ValidateWrapBase64URL(in.VaultKeyWrappedByKEK, WrapKindKEK)
	if err != nil {
		return VaultCreatedResponse{}, ErrVaultWrapInvalid
	}
	privWrapBytes, err := ValidateWrapBase64URL(in.PrivateKeysWrapped, WrapKindPriv)
	if err != nil {
		return VaultCreatedResponse{}, ErrVaultWrapInvalid
	}
	x25519PubBytes, err := ValidatePublicKey32Base64URL(in.X25519Public)
	if err != nil {
		return VaultCreatedResponse{}, err
	}
	ed25519PubBytes, err := ValidatePublicKey32Base64URL(in.Ed25519Public)
	if err != nil {
		return VaultCreatedResponse{}, err
	}

	// 3. Validate 10 recovery keys (slots 1..10, no duplicate slot, no duplicate lookup_hash, valid 73B RK wraps).
	rkRows, err := ValidateRecoveryKeyBatchForCreateOrRotate(in.RecoveryKeys)
	if err != nil {
		return VaultCreatedResponse{}, err
	}

	// 4. Begin mutation transaction with lock_timeout & statement_timeout 30s.
	tx, err := s.BeginMutationTx(ctx)
	if err != nil {
		return VaultCreatedResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := s.q.WithTx(tx)

	// 5. Lock user row and check AUTH_REQUIRE_EMAIL_VERIFICATION + email_verified_at.
	u, err := q.GetUserByIDForUpdate(ctx, p.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return VaultCreatedResponse{}, ErrUnauthenticated
		}
		return VaultCreatedResponse{}, err
	}
	if s.cfg.RequireEmailVerification && !u.EmailVerifiedAt.Valid {
		return VaultCreatedResponse{}, ErrEmailNotVerified
	}

	// 6. Check if user already has a vault.
	exists, err := q.VaultExistsByUser(ctx, p.UserID)
	if err != nil {
		return VaultCreatedResponse{}, err
	}
	if exists {
		return VaultCreatedResponse{}, ErrVaultExists
	}

	// 7. Generate unique vault_key_id ("vk:" + 16B base64url) and insert vault row.
	vaultKeyID, err := GenerateVaultKeyID()
	if err != nil {
		return VaultCreatedResponse{}, err
	}
	insertedVault, err := q.InsertVault(ctx, gen.InsertVaultParams{
		UserID:               p.UserID,
		Kdf:                  kdfJSON,
		VaultKeyID:           vaultKeyID,
		VaultKeyWrappedByKek: kekWrapBytes,
		X25519Public:         x25519PubBytes,
		Ed25519Public:        ed25519PubBytes,
		PrivateKeysWrapped:   privWrapBytes,
	})
	if err != nil {
		if IsUniqueViolation(err) {
			if UniqueConstraintName(err) == "vault_pkey" {
				return VaultCreatedResponse{}, ErrVaultExists
			}
		}
		return VaultCreatedResponse{}, err
	}

	// 8. Insert all 10 recovery keys in the same transaction.
	// Cross-user duplicate lookup_hash (UNIQUE violation) maps to generic 409 recovery_key_conflict
	// without revealing the owner.
	for _, rk := range rkRows {
		if _, err := q.InsertRecoveryKey(ctx, gen.InsertRecoveryKeyParams{
			UserID:     p.UserID,
			Slot:       rk.slot,
			LookupHash: rk.lookupHash,
			Wrap:       rk.wrap,
		}); err != nil {
			return VaultCreatedResponse{}, MapRecoveryKeyUniqueError(err)
		}
	}

	// 9. Record audit event `vault.create` in the same transaction (metadata contains no secrets).
	if err := s.RecordAuditTx(ctx, tx, p, EventVaultCreate, in.IP, in.UA, secevent.Meta{}); err != nil {
		return VaultCreatedResponse{}, err
	}

	resp := VaultCreatedResponse{
		VaultKeyID: insertedVault.VaultKeyID,
		Version:    insertedVault.Version,
	}

	// 10. Update idempotency_key status='done' with owner_token check before COMMIT.
	if _, err := s.CommitMutationWithIdempotency(ctx, tx, http.StatusCreated, resp); err != nil {
		return VaultCreatedResponse{}, err
	}

	return resp, nil
}
