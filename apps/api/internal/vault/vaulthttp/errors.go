package vaulthttp

import (
	"errors"
	"net/http"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
)

// WriteDomainError ánh xạ lỗi domain của `vault` (và `httpx` / `auth`) sang response RFC 9457 chuẩn
// (plan mục 2.7, SPEC §9.1). Không bao giờ phản chiếu input của người dùng hay làm lộ bí mật.
func WriteDomainError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	if errors.Is(err, httpx.ErrIdempotencyOwnerMismatch) {
		retry := 1
		httpx.WriteProblemExtra(
			w,
			r,
			http.StatusConflict,
			"idempotency_in_progress",
			httpx.ProblemTitle("idempotency_in_progress")+".",
			httpx.ProblemExtra{RetryAfter: &retry},
		)
		return
	}
	if ve, ok := vault.AsError(err); ok {
		if ve.Code == "version_mismatch" && ve.CurrentVersion != nil {
			httpx.WriteVersionMismatch(w, r, *ve.CurrentVersion)
			return
		}
		status := StatusFor(ve.Code)
		httpx.WriteProblem(w, r, status, ve.Code, httpx.ProblemTitle(ve.Code)+".")
		return
	}
	var ae *auth.Error
	if errors.As(err, &ae) {
		status := StatusFor(ae.Code)
		httpx.WriteProblemExtra(w, r, status, ae.Code, httpx.ProblemTitle(ae.Code)+".", httpx.ProblemExtra{Reason: ae.Reason})
		return
	}
	var he *httpx.AuthError
	if errors.As(err, &he) {
		status := StatusFor(he.Code)
		httpx.WriteProblemExtra(w, r, status, he.Code, httpx.ProblemTitle(he.Code)+".", httpx.ProblemExtra{Reason: he.Reason})
		return
	}
	httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
}

// WriteNotImplementedStub ghi response 501 Not Implemented (RFC 9457) cho các route stub P03-T9..T12
// trước khi các task tương ứng điền thân hàm.
func WriteNotImplementedStub(w http.ResponseWriter, r *http.Request) {
	httpx.WriteProblem(w, r, http.StatusNotImplemented, "dependency_unavailable", httpx.ProblemTitle("dependency_unavailable")+".")
}

// StatusFor trả mã HTTP status ứng với code RFC 9457 của vault/auth (plan mục 2.7).
func StatusFor(code string) int {
	switch code {
	case "invalid_request",
		"vault_kdf_invalid",
		"vault_wrap_invalid",
		"recovery_keys_count",
		"passkey_challenge_invalid",
		"passkey_attestation_invalid",
		"passkey_name_invalid":
		return http.StatusBadRequest
	case "unauthenticated",
		"access_expired",
		"session_invalid",
		"reauth_required",
		"reauth_invalid",
		"recovery_key_invalid":
		return http.StatusUnauthorized
	case "csrf_invalid",
		"forbidden",
		"email_not_verified",
		"reauth_unsupported_provider":
		return http.StatusForbidden
	case "not_found",
		"vault_absent",
		"passkey_not_found":
		return http.StatusNotFound
	case "vault_exists",
		"recovery_key_slot_taken",
		"recovery_key_conflict",
		"idempotency_conflict",
		"idempotency_in_progress",
		"passkey_exists":
		return http.StatusConflict
	case "version_mismatch":
		return http.StatusPreconditionFailed
	case "precondition_required":
		return http.StatusPreconditionRequired
	case "rate_limited":
		return http.StatusTooManyRequests
	case "vault_mutations_disabled",
		"dependency_unavailable":
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}
