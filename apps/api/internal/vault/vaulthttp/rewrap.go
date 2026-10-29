package vaulthttp

import (
	"net/http"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// Rewrap xử lý `PUT /api/v1/vault/kek` (`vaultRewrap`, plan Task 9).
// TODO(P03-T9): decode VaultRewrapRequest, parse If-Match via httpx.ParseVaultIfMatchFromRequest, call a.svc.Rewrap and return 200 {version}.
func (a *API) Rewrap(w http.ResponseWriter, r *http.Request) {
	if _, ok := httpx.ParseVaultIfMatchFromRequest(w, r); !ok {
		return
	}
	WriteNotImplementedStub(w, r)
}
