package authhttp

import (
	"context"
	"net/http"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
)

type anonKey struct{}

func withAnon(ctx context.Context, nonce string) context.Context {
	return context.WithValue(ctx, anonKey{}, nonce)
}

func anonFrom(ctx context.Context) string {
	s, _ := ctx.Value(anonKey{}).(string)
	return s
}

// AttachAnon đưa sabk_anon vào context cho CSRF anonymous.
func AttachAnon(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(withAnon(r.Context(), CookieValue(r, CookieAnon))))
	})
}

// CSRFAdapter triển khai httpx.CSRFVerifier.
type CSRFAdapter struct {
	CSRF *auth.CSRF
}

func (a CSRFAdapter) VerifyCSRF(ctx context.Context, principal *authctx.Principal, cookie, header string) error {
	if a.CSRF == nil {
		return mapDomainError(auth.ErrCSRFInvalid)
	}
	if principal != nil {
		return mapDomainError(a.CSRF.Verify(cookie, header, auth.CSRFKindSession, principal.SessionID.String()))
	}
	subject := anonFrom(ctx)
	if subject == "" {
		return mapDomainError(auth.ErrCSRFInvalid)
	}
	return mapDomainError(a.CSRF.Verify(cookie, header, auth.CSRFKindAnon, subject))
}

// SessionAdapter triển khai httpx.Authenticator.
type SessionAdapter struct {
	Sessions *auth.SessionStore
}

func (a SessionAdapter) Authenticate(ctx context.Context, access string) (authctx.Principal, error) {
	if a.Sessions == nil {
		return authctx.Principal{}, &mapInternal{}
	}
	p, err := a.Sessions.Authenticate(ctx, access)
	if err != nil {
		return authctx.Principal{}, mapDomainError(err)
	}
	return p, nil
}

type mapInternal struct{}

func (mapInternal) Error() string { return "internal_error" }
