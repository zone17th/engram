package authhttp

import (
	"context"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/authctx"
)

// GrantAdapter triển khai httpx.ReauthVerifier — không success giả.
type GrantAdapter struct {
	Grants   *auth.Grants
	Sessions *auth.SessionStore
}

func (a GrantAdapter) VerifyReauth(ctx context.Context, p authctx.Principal, action, token string) error {
	if a.Grants == nil || a.Sessions == nil {
		return mapInternal{}
	}
	if err := a.Sessions.EnsureLive(ctx, p); err != nil {
		return mapDomainError(err)
	}
	return mapDomainError(a.Grants.Verify(p, action, token))
}

// VerifyGrant verifies the re-authentication grant HMAC, principal binding, action, and TTL
// using the same Grants authority as VerifyReauth without performing a database session query.
func (a GrantAdapter) VerifyGrant(p authctx.Principal, action, token string) error {
	if a.Grants == nil {
		return mapInternal{}
	}
	return mapDomainError(a.Grants.Verify(p, action, token))
}
