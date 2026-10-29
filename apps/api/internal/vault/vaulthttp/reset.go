package vaulthttp

import (
	"net/http"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
)

// Reset xử lý `DELETE /api/v1/vault` (`vaultReset`, plan Task 12, mục 3).
// Chuỗi middleware trên route: S + C(AllowEmptyDelete) + K + I.Lookup + A("vault.reset") + R("vault_sensitive") + M + I.Claim.
func (a *API) Reset(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	ifm, ok := httpx.ParseVaultIfMatchFromRequest(w, r)
	if !ok {
		return
	}
	if err := a.svc.Reset(r.Context(), p, vault.ResetInput{
		IfMatch: ifm,
		IP:      a.ip(r),
		UA:      r.UserAgent(),
	}); err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	w.WriteHeader(http.StatusNoContent)
}
