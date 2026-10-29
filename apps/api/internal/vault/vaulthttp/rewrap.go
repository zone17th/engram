package vaulthttp

import (
	"encoding/json"
	"net/http"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
)

// Rewrap xử lý `PUT /api/v1/vault/kek` (`vaultRewrap`, plan Task 9, mục 3).
// Chuỗi middleware trên route: S + C + K + I.Lookup + A("vault.rewrap") + R("vault_sensitive") + M + I.Claim.
func (a *API) Rewrap(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	ifm, ok := httpx.ParseVaultIfMatchFromRequest(w, r)
	if !ok {
		return
	}
	var req struct {
		KDF                  json.RawMessage `json:"kdf"`
		VaultKeyWrappedByKEK string          `json:"vault_key_wrapped_by_kek"`
	}
	if !DecodeVaultJSON(w, r, &req) {
		return
	}
	res, err := a.svc.Rewrap(r.Context(), p, vault.RewrapInput{
		KDFRaw:               req.KDF,
		VaultKeyWrappedByKEK: req.VaultKeyWrappedByKEK,
		IfMatch:              ifm,
		IP:                   a.ip(r),
		UA:                   r.UserAgent(),
	})
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, res)
}
