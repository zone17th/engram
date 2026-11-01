package authhttp

import (
	"errors"
	"net/http"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/httpx"
)

func mapDomainError(err error) error {
	if err == nil {
		return nil
	}
	var de *auth.Error
	if errors.As(err, &de) {
		return &httpx.AuthError{Code: de.Code, Reason: de.Reason}
	}
	return err
}

func WriteDomainError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	var rl *auth.RateLimitedError
	if errors.As(err, &rl) {
		captcha := rl.Captcha
		httpx.WriteProblemExtra(w, r, http.StatusTooManyRequests, "rate_limited", httpx.ProblemTitle("rate_limited")+".", httpx.ProblemExtra{
			RetryAfter:      &rl.RetryAfter,
			CaptchaRequired: &captcha,
		})
		return
	}
	var de *auth.Error
	if errors.As(err, &de) {
		extra := httpx.ProblemExtra{Reason: de.Reason}
		if de.Code == "captcha_required" {
			t := true
			extra.CaptchaRequired = &t
		}
		httpx.WriteProblemExtra(w, r, statusFor(de.Code), de.Code, httpx.ProblemTitle(de.Code)+".", extra)
		return
	}
	var ae *httpx.AuthError
	if errors.As(err, &ae) {
		httpx.WriteProblemExtra(w, r, statusFor(ae.Code), ae.Code, httpx.ProblemTitle(ae.Code)+".", httpx.ProblemExtra{Reason: ae.Reason})
		return
	}
	httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
}

func statusFor(code string) int {
	switch code {
	case "invalid_request", "password_weak", "verification_invalid", "reset_token_invalid", "oauth_state_invalid":
		return http.StatusBadRequest
	case "unauthenticated", "access_expired", "session_invalid", "invalid_credentials", "reauth_required", "reauth_invalid":
		return http.StatusUnauthorized
	case "csrf_invalid", "forbidden", "captcha_required", "reauth_unsupported_provider",
		"identity_last_method", "identity_conflict", "email_not_verified", "oauth_provider_error":
		return http.StatusForbidden
	case "not_found":
		return http.StatusNotFound
	case "email_taken", "semantic_unavailable":
		return http.StatusConflict
	case "rate_limited":
		return http.StatusTooManyRequests
	case "mail_delivery_unavailable", "dependency_unavailable":
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}
