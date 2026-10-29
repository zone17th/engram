package vaulthttp

import (
	"net/http"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// RecoveryKeysRegenerate xử lý `POST /api/v1/vault/recovery-keys/regenerate` (`vaultRecoveryKeysRegenerate`, plan Task 11).
// TODO(P03-T11): decode VaultRecoveryKeysRegenerateRequest, parse If-Match via httpx.ParseVaultIfMatchFromRequest, call a.svc.RegenerateRecoveryKeys and return 200 {remaining, version}.
func (a *API) RecoveryKeysRegenerate(w http.ResponseWriter, r *http.Request) {
	if _, ok := httpx.ParseVaultIfMatchFromRequest(w, r); !ok {
		return
	}
	WriteNotImplementedStub(w, r)
}

// RecoveryKeysRotate xử lý `POST /api/v1/vault/recovery-keys/rotate` (`vaultRecoveryKeysRotate`, plan Task 11).
// TODO(P03-T11): decode VaultRecoveryKeysRotateRequest, parse If-Match via httpx.ParseVaultIfMatchFromRequest, call a.svc.RotateRecoveryKeys and return 200 {remaining: 10, version}.
func (a *API) RecoveryKeysRotate(w http.ResponseWriter, r *http.Request) {
	if _, ok := httpx.ParseVaultIfMatchFromRequest(w, r); !ok {
		return
	}
	WriteNotImplementedStub(w, r)
}
