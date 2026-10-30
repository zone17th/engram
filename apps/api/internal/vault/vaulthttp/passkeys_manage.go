package vaulthttp

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
)

// PasskeyRename xử lý `PATCH /api/v1/vault/passkeys/{id}` (`vaultPasskeyRename`, plan Task 13, mục 2.5, 3).
// Chuỗi middleware trên route: S + C + R("vault_sensitive") (không A, không I, không K, không M).
func (a *API) PasskeyRename(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	var req struct {
		Name *string `json:"name"`
	}
	if !DecodeVaultJSON(w, r, &req) {
		return
	}
	if req.Name == nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", httpx.ProblemTitle("invalid_request")+".")
		return
	}
	passkeyID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		passkeyID = uuid.Nil
	}
	item, err := a.svc.RenamePasskey(r.Context(), p, vault.RenamePasskeyInput{
		PasskeyID: passkeyID,
		Name:      *req.Name,
	})
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, item)
}

// PasskeyRevoke xử lý `DELETE /api/v1/vault/passkeys/{id}` (`vaultPasskeyRevoke`, plan Task 13, mục 2.5, 3).
// Chuỗi middleware trên route: S + C(AllowEmptyDelete) + A("vault.passkey_revoke") + R("vault_sensitive") (không I, không K, không M).
func (a *API) PasskeyRevoke(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	passkeyID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		passkeyID = uuid.Nil
	}
	if err := a.svc.RevokePasskey(r.Context(), p, vault.RevokePasskeyInput{
		PasskeyID: passkeyID,
		IP:        a.ip(r),
		UA:        r.UserAgent(),
	}); err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	w.WriteHeader(http.StatusNoContent)
}

// PasskeyUnlockOptions xử lý `POST /api/v1/vault/unlock/passkey/options` (`vaultPasskeyUnlockOptions`, plan Task 13, mục 2.5, 3).
// Chuỗi middleware trên route: S + C + R("vault_passkey_options") (chung bucket 20/phút/user với register options; không I, không K, không M).
func (a *API) PasskeyUnlockOptions(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	if !decodeOptionalEmptyJSONObject(w, r) {
		return
	}
	res, err := a.svc.PasskeyUnlockOptions(r.Context(), p)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, res)
}
