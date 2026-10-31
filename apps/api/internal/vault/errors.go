package vault

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// Error là lỗi domain của vault. Error() chỉ trả về code RFC 9457 chuẩn —
// tuyệt đối không bao giờ chứa passphrase, KEK, VK, RK, lookup_hash, wrap hay dữ liệu người dùng.
type Error struct {
	Code           string
	CurrentVersion *int32
}

func (e *Error) Error() string { return e.Code }

func (e *Error) Is(target error) bool {
	var o *Error
	if !errors.As(target, &o) {
		return false
	}
	return e.Code == o.Code
}

func errCode(code string) *Error { return &Error{Code: code} }

// VersionMismatchError trả về lỗi 412 version_mismatch kèm current_version.
func VersionMismatchError(currentVersion int32) *Error {
	v := currentVersion
	return &Error{Code: "version_mismatch", CurrentVersion: &v}
}

var (
	ErrInvalidRequest            = errCode("invalid_request")
	ErrUnauthenticated           = errCode("unauthenticated")
	ErrForbidden                 = errCode("forbidden")
	ErrEmailNotVerified          = errCode("email_not_verified")
	ErrVaultExists               = errCode("vault_exists")
	ErrVaultAbsent               = errCode("vault_absent")
	ErrVaultKDFInvalid           = errCode("vault_kdf_invalid")
	ErrVaultWrapInvalid          = errCode("vault_wrap_invalid")
	ErrVaultMutationsDisabled    = errCode("vault_mutations_disabled")
	ErrDependencyUnavailable     = errCode("dependency_unavailable")
	ErrRecoveryKeysCount         = errCode("recovery_keys_count")
	ErrRecoveryKeySlotTaken      = errCode("recovery_key_slot_taken")
	ErrRecoveryKeyConflict       = errCode("recovery_key_conflict")
	ErrPreconditionRequired      = errCode("precondition_required")
	ErrVersionMismatch           = errCode("version_mismatch")
	ErrIdempotencyConflict       = errCode("idempotency_conflict")
	ErrIdempotencyInProgress     = errCode("idempotency_in_progress")
	ErrPasskeyChallengeInvalid   = errCode("passkey_challenge_invalid")
	ErrPasskeyAttestationInvalid = errCode("passkey_attestation_invalid")
	ErrPasskeyNameInvalid        = errCode("passkey_name_invalid")
	ErrPasskeyExists             = errCode("passkey_exists")
	ErrPasskeyNotFound           = errCode("passkey_not_found")
)

// AsError kiểm tra và trích xuất *Error từ chuỗi lỗi (kể cả ErrRecoveryKeyInvalid từ recovery.go).
func AsError(err error) (*Error, bool) {
	if err == nil {
		return nil, false
	}
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	if errors.Is(err, ErrRecoveryKeyInvalid) {
		return errCode("recovery_key_invalid"), true
	}
	if errors.Is(err, ErrWrapInvalid) || errors.Is(err, ErrBase64URLInvalid) {
		return ErrVaultWrapInvalid, true
	}
	return nil, false
}

// IsUniqueViolation kiểm tra lỗi PostgreSQL 23505 (unique_violation).
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// UniqueConstraintName trả về tên constraint khi gặp lỗi PostgreSQL 23505 (hoặc chuỗi rỗng).
func UniqueConstraintName(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return pgErr.ConstraintName
	}
	return ""
}

// MapRecoveryKeyUniqueError ánh xạ vi phạm UNIQUE trên bảng vault_recovery_key
// sang mã lỗi domain chuẩn (plan mục 2.7, Task 8/11):
//   - Trùng lookup_hash (kể cả khác user) -> 409 recovery_key_conflict (không lộ chủ sở hữu).
//   - Trùng (vault_id, slot) -> 409 recovery_key_slot_taken.
func MapRecoveryKeyUniqueError(err error) error {
	if !IsUniqueViolation(err) {
		return err
	}
	switch UniqueConstraintName(err) {
	case "vault_recovery_key_vault_id_slot_key":
		return ErrRecoveryKeySlotTaken
	case "vault_recovery_key_lookup_hash_key":
		return ErrRecoveryKeyConflict
	default:
		return ErrRecoveryKeyConflict
	}
}
