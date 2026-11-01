package vaulthttp

import (
	"net/http"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

// RecoveryKeysRegenerate xử lý `POST /api/v1/vault/recovery-keys/regenerate` (`vaultRecoveryKeysRegenerate`, plan Task 11, mục 3).
// Chuỗi middleware trên route: S + C + I.Lookup + K + A("vault.recovery_keys_regenerate") + R("vault_sensitive") + M + I.Claim.
func (a *API) RecoveryKeysRegenerate(w http.ResponseWriter, r *http.Request) {
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
		RecoveryKeys []vault.RecoveryKeyUploadItem `json:"recovery_keys"`
	}
	if !DecodeVaultJSON(w, r, &req) {
		return
	}
	if req.RecoveryKeys == nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "recovery_keys_count", httpx.ProblemTitle("recovery_keys_count")+".")
		return
	}
	res, err := a.svc.RegenerateRecoveryKeys(r.Context(), p, vault.RecoveryKeysRegenerateInput{
		RecoveryKeys: req.RecoveryKeys,
		IfMatch:      ifm,
		IP:           a.ip(r),
		UA:           r.UserAgent(),
	})
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, res)
}

// RecoveryKeysRotate xử lý `POST /api/v1/vault/recovery-keys/rotate` (`vaultRecoveryKeysRotate`, plan Task 11, mục 3).
// Chuỗi middleware trên route: S + C + I.Lookup + K + A("vault.recovery_keys_rotate") + R("vault_sensitive") + M + I.Claim.
func (a *API) RecoveryKeysRotate(w http.ResponseWriter, r *http.Request) {
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
		RecoveryKeys []vault.RecoveryKeyUploadItem `json:"recovery_keys"`
	}
	if !DecodeVaultJSON(w, r, &req) {
		return
	}
	if req.RecoveryKeys == nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "recovery_keys_count", httpx.ProblemTitle("recovery_keys_count")+".")
		return
	}
	res, err := a.svc.RotateRecoveryKeys(r.Context(), p, vault.RecoveryKeysRotateInput{
		RecoveryKeys: req.RecoveryKeys,
		IfMatch:      ifm,
		IP:           a.ip(r),
		UA:           r.UserAgent(),
	})
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, res)
}
