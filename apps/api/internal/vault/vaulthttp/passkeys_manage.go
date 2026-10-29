package vaulthttp

import "net/http"

// PasskeyRename xử lý `PATCH /api/v1/vault/passkeys/{id}` (`vaultPasskeyRename`, Task 13).
// TODO(P03-T13-B): implement passkey rename handler.
func (a *API) PasskeyRename(w http.ResponseWriter, r *http.Request) {
	WriteNotImplementedStub(w, r)
}

// PasskeyRevoke xử lý `DELETE /api/v1/vault/passkeys/{id}` (`vaultPasskeyRevoke`, Task 13).
// TODO(P03-T13-B): implement passkey revoke handler.
func (a *API) PasskeyRevoke(w http.ResponseWriter, r *http.Request) {
	WriteNotImplementedStub(w, r)
}

// PasskeyUnlockOptions xử lý `POST /api/v1/vault/unlock/passkey/options` (`vaultPasskeyUnlockOptions`, Task 13).
// TODO(P03-T13-B): implement passkey unlock options handler.
func (a *API) PasskeyUnlockOptions(w http.ResponseWriter, r *http.Request) {
	WriteNotImplementedStub(w, r)
}
