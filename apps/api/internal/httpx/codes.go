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
}

// SessionInvalidReason là extension `reason` khi code = session_invalid.
const (
	SessionReasonRevoked = "revoked"
	SessionReasonExpired = "expired"
	SessionReasonInvalid = "invalid"
)
