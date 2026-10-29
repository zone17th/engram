package vaulthttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
)

// PasskeyRegisterOptions xử lý `POST /api/v1/vault/passkeys/register/options`
// (`vaultPasskeyRegisterOptions`, plan Task 13, mục 2.5, mục 3).
func (a *API) PasskeyRegisterOptions(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	if !decodeOptionalEmptyJSONObject(w, r) {
		return
	}
	res, err := a.svc.RegisterPasskeyOptions(r.Context(), p)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusOK, res)
}

// PasskeyCreate xử lý `POST /api/v1/vault/passkeys` (`vaultPasskeyCreate`, plan Task 13, mục 2.5, mục 3).
// Lưu ý (ADR 0003 §3, OpenAPI `VaultPasskeyCreateRequest`): Nếu client gửi kèm các trường dẫn xuất
// `cred_id`, `pubkey`, `aaguid` (ở mức gốc hoặc trong `attestation`), handler chấp nhận trong schema
// nhưng bỏ qua hoàn toàn — server chỉ trích xuất chúng từ `attestation_object` đã xác minh.
func (a *API) PasskeyCreate(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	var req struct {
		ChallengeID string `json:"challenge_id"`
		Attestation *struct {
			ClientDataJSON    string `json:"client_data_json"`
			AttestationObject string `json:"attestation_object"`
			CredID            any    `json:"cred_id"`
			PubKey            any    `json:"pubkey"`
			AAGUID            any    `json:"aaguid"`
		} `json:"attestation"`
		PRFSalt string `json:"prf_salt"`
		VKWrap  string `json:"vk_wrap"`
		Name    string `json:"name"`
		CredID  any    `json:"cred_id"`
		PubKey  any    `json:"pubkey"`
		AAGUID  any    `json:"aaguid"`
	}
	if !DecodeVaultJSON(w, r, &req) {
		return
	}
	if req.Attestation == nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return
	}
	challengeID, err := uuid.Parse(req.ChallengeID)
	if err != nil || challengeID == uuid.Nil {
		WriteDomainError(w, r, vault.ErrPasskeyChallengeInvalid)
		return
	}

	res, err := a.svc.RegisterPasskey(r.Context(), p, vault.RegisterPasskeyInput{
		ChallengeID:       challengeID,
		ClientDataJSON:    req.Attestation.ClientDataJSON,
		AttestationObject: req.Attestation.AttestationObject,
		PRFSalt:           req.PRFSalt,
		VKWrap:            req.VKWrap,
		Name:              req.Name,
		IP:                a.ip(r),
		UA:                r.UserAgent(),
	})
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	NoStore(w)
	writeJSON(w, http.StatusCreated, res)
}

// decodeOptionalEmptyJSONObject chấp nhận body rỗng hoặc `{}` cho các endpoint POST options
// không yêu cầu requestBody trong OpenAPI (`register/options`, `unlock/passkey/options`).
func decodeOptionalEmptyJSONObject(w http.ResponseWriter, r *http.Request) bool {
	if r.Body == nil || r.Body == http.NoBody {
		return true
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, VaultJSONLimit+1))
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Không đọc được nội dung.")
		return false
	}
	if len(body) > VaultJSONLimit {
		httpx.WriteProblem(w, r, http.StatusRequestEntityTooLarge, "invalid_request", "Nội dung quá lớn.")
		return false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return true
	}
	var empty struct{}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&empty); err != nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return false
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON có dữ liệu thừa.")
		return false
	}
	return true
}
