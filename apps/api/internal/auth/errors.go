package auth

import "errors"

// Error là lỗi domain auth. Error() chỉ là code — không chứa email/password/token.
type Error struct {
	Code   string
	Reason string // session_invalid: revoked|expired|invalid
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

var (
	ErrPasswordWeak              = errCode("password_weak")
	ErrInvalidCredentials        = errCode("invalid_credentials")
	ErrInvalidRequest            = errCode("invalid_request")
	ErrUnauthenticated           = errCode("unauthenticated")
	ErrAccessExpired             = errCode("access_expired")
	ErrSessionInvalid            = errCode("session_invalid")
	ErrCSRFInvalid               = errCode("csrf_invalid")
	ErrForbidden                 = errCode("forbidden")
	ErrNotFound                  = errCode("not_found")
	ErrReauthRequired            = errCode("reauth_required")
	ErrReauthInvalid             = errCode("reauth_invalid")
	ErrReauthUnsupportedProvider = errCode("reauth_unsupported_provider")
	ErrRateLimited               = errCode("rate_limited")
	ErrCaptchaRequired           = errCode("captcha_required")
	ErrEmailNotVerified          = errCode("email_not_verified")
	ErrEmailTaken                = errCode("email_taken")
	ErrIdentityConflict          = errCode("identity_conflict")
	ErrIdentityLastMethod        = errCode("identity_last_method")
	ErrOAuthStateInvalid         = errCode("oauth_state_invalid")
	ErrOAuthProviderError        = errCode("oauth_provider_error")
	ErrVerificationInvalid       = errCode("verification_invalid")
	ErrSemanticUnavailable       = errCode("semantic_unavailable")
	ErrMailDeliveryUnavailable   = errCode("mail_delivery_unavailable")
	ErrResetTokenInvalid         = errCode("reset_token_invalid")
	ErrDependencyUnavailable     = errCode("dependency_unavailable")
)

func SessionInvalid(reason string) *Error {
	return &Error{Code: "session_invalid", Reason: reason}
}

// RateLimitedError là 429 kèm Retry-After và (tuỳ chọn) CAPTCHA.
type RateLimitedError struct {
	RetryAfter int
	Captcha    bool
}

func (e *RateLimitedError) Error() string { return "rate_limited" }

func AsError(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}
