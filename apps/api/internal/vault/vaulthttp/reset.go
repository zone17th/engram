package vaulthttp

import (
	"net/http"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// Reset xử lý `DELETE /api/v1/vault` (`vaultReset`, plan Task 12).
// TODO(P03-T12): parse If-Match via httpx.ParseVaultIfMatchFromRequest, call a.svc.Reset and return 204 No Content.
func (a *API) Reset(w http.ResponseWriter, r *http.Request) {
	if _, ok := httpx.ParseVaultIfMatchFromRequest(w, r); !ok {
		return
	}
	WriteNotImplementedStub(w, r)
}
