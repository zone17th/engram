package vaulthttp

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
)

// RecoveryLookup xử lý `POST /api/v1/vault/unlock/recovery` (`vaultRecoveryLookup`, plan Task 10, mục 3).
// Chuỗi middleware trên route: S + C + R("vault_recovery_lookup") (đếm mọi request, kể cả trúng).
func (a *API) RecoveryLookup(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	var req struct {
		LookupHash string `json:"lookup_hash"`
	}
	if !DecodeVaultJSON(w, r, &req) {
		return
	}
	res, err := a.svc.RecoveryLookup(r.Context(), p, vault.RecoveryLookupInput{
		LookupHash: req.LookupHash,
	})
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, res)
}

// RecoverComplete xử lý `POST /api/v1/vault/recover/complete` (`vaultRecoverComplete`, plan Task 10, mục 3).
// Chuỗi middleware trên route: S + C + I.Lookup + K + A("vault.recover") + R("vault_recovery_complete") + M + I.Claim.
func (a *API) RecoverComplete(w http.ResponseWriter, r *http.Request) {
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
		RecoveryKeyID        string          `json:"recovery_key_id"`
		KDF                  json.RawMessage `json:"kdf"`
		VaultKeyWrappedByKEK string          `json:"vault_key_wrapped_by_kek"`
	}
	if !DecodeVaultJSON(w, r, &req) {
		return
	}
	rkID, err := uuid.Parse(req.RecoveryKeyID)
	if err != nil || rkID == uuid.Nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", httpx.ProblemTitle("invalid_request")+".")
		return
	}
	res, err := a.svc.RecoverComplete(r.Context(), p, vault.RecoverCompleteInput{
		RecoveryKeyID:        rkID,
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
