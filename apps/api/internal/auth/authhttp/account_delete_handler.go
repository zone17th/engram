package authhttp

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/httpx"
)

type accountDeleteReauth struct {
	httpx.ReauthVerifier
}

func (r accountDeleteReauth) VerifyReauth(ctx context.Context, p authctx.Principal, action, token string) error {
	if strings.TrimSpace(token) == "" {
		return &httpx.AuthError{Code: "reauth_required"}
	}
	return r.ReauthVerifier.VerifyReauth(ctx, p, action, token)
}

// AccountDeleteRoute builds DELETE /api/v1/me (`accountDelete`, plan P06 mục
// 2.9, 3): RequireOrigin + RequireSession + RequireCSRF + RequireJSONContent +
// body limit 16 KiB + Idempotency.Lookup + RequireReauth("account.delete") +
// UserLimiter(vault_sensitive) + Idempotency.Claim.
func (a *API) AccountDeleteRoute(d httpx.Deps) http.Handler {
	origin := ""
	if d.Config != nil {
		origin = d.Config.AppOrigin
	}
	var reauth httpx.ReauthVerifier
	if d.Reauth != nil {
		reauth = accountDeleteReauth{d.Reauth}
	}
	pool, clk := a.svc.Pool(), a.svc.Clock()
	return httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:     origin,
		Authenticator: d.Authenticator,
		CSRF:          d.CSRF,
		Idempotency:   httpx.NewIdempotency(pool, clk),
		Reauth:        reauth,
		ReauthAction:  "account.delete",
		RateLimit:     httpx.NewUserLimiter(pool, clk).Middleware(httpx.ScopeVaultSensitive),
		BodyLimit:     httpx.IdempotencyBodyLimit{Bytes: httpx.AuthJSONLimit},
	}, http.HandlerFunc(a.AccountDelete))
}

// AccountDelete handles DELETE /api/v1/me after the middleware chain.
func (a *API) AccountDelete(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		WriteDomainError(w, r, auth.ErrUnauthenticated)
		return
	}
	var in struct {
		ConfirmEmail string `json:"confirm_email"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}
	err := a.svc.DeleteAccount(r.Context(), p, in.ConfirmEmail, a.ip(r), r.UserAgent())
	switch {
	case err == nil:
	case errors.Is(err, auth.ErrAccountDeleteConfirmInvalid):
		httpx.WriteProblem(w, r, http.StatusBadRequest, "account_delete_confirm_invalid",
			httpx.ProblemTitle("account_delete_confirm_invalid")+".")
		return
	case httpx.IsContentRetryableTxError(err):
		WriteDomainError(w, r, auth.ErrDependencyUnavailable)
		return
	default:
		WriteDomainError(w, r, err)
		return
	}
	ClearAuthCookies(w)
	NoStore(w)
	w.WriteHeader(http.StatusNoContent)
}
