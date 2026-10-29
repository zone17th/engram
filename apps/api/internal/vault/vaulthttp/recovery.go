package vaulthttp

import (
	"net/http"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// RecoveryLookup xử lý `POST /api/v1/vault/unlock/recovery` (`vaultRecoveryLookup`, plan Task 10).
// TODO(P03-T10): decode VaultRecoveryLookupRequest, call a.svc.RecoveryLookup and return 200 {recovery_key_id, wrap} or 401 recovery_key_invalid.
func (a *API) RecoveryLookup(w http.ResponseWriter, r *http.Request) {
	WriteNotImplementedStub(w, r)
}

// RecoverComplete xử lý `POST /api/v1/vault/recover/complete` (`vaultRecoverComplete`, plan Task 10).
// TODO(P03-T10): decode VaultRecoverCompleteRequest, parse If-Match via httpx.ParseVaultIfMatchFromRequest, call a.svc.RecoverComplete and return 200 {version}.
func (a *API) RecoverComplete(w http.ResponseWriter, r *http.Request) {
	if _, ok := httpx.ParseVaultIfMatchFromRequest(w, r); !ok {
		return
	}
	WriteNotImplementedStub(w, r)
}
