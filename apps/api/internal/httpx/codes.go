package httpx

// ProblemCodes là danh sách code RFC 9457 ổn định. Mọi code mới phải xuất hiện
// cùng lúc ở đây, packages/shared-types/src/problem.ts và OpenAPI.
var ProblemCodes = []string{
	"invalid_request",
	"dependency_unavailable",
	"internal_error",
	"not_found",
	"unauthenticated",
	"access_expired",
	"session_invalid",
	"invalid_credentials",
	"csrf_invalid",
	"forbidden",
	"reauth_required",
	"reauth_invalid",
	"reauth_unsupported_provider",
	"rate_limited",
	"captcha_required",
	"email_not_verified",
	"email_taken",
	"identity_conflict",
	"identity_last_method",
	"oauth_state_invalid",
	"oauth_provider_error",
	"verification_invalid",
	"password_weak",
	"semantic_unavailable",
	"mail_delivery_unavailable",
	"vault_exists",
	"vault_absent",
	"vault_kdf_invalid",
	"vault_wrap_invalid",
	"vault_mutations_disabled",
	"recovery_keys_count",
	"recovery_key_slot_taken",
	"recovery_key_invalid",
	"recovery_key_conflict",
	"precondition_required",
	"version_mismatch",
	"idempotency_conflict",
	"idempotency_in_progress",
	"passkey_challenge_invalid",
	"passkey_attestation_invalid",
	"passkey_name_invalid",
	"passkey_exists",
	"passkey_not_found",
	// P04 content (plan P04 mục 3): thêm cuối catalog, thứ tự cố định.
	"name_invalid",
	"hint_invalid",
	"tag_display_invalid",
	"item_id_conflict",
	"item_deleted",
	"item_tag_limit",
	"item_entry_limit",
	"tag_conflict",
	"entry_invalid",
	"entry_too_large",
	"entry_id_conflict",
	"entry_key_mismatch",
	"entry_nonce_reused",
	"entry_restore_via_item",
	"reorder_mismatch",
	"changes_window_expired",
}

// SessionInvalidReason là extension `reason` khi code = session_invalid.
const (
	SessionReasonRevoked = "revoked"
	SessionReasonExpired = "expired"
	SessionReasonInvalid = "invalid"
)
