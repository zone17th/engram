package vault

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/protocol/webauthncose"
)

// Hằng số cấu hình WebAuthn PRF (ADR 0003 §1–§3, SPEC §5.10, plan mục 2.5).
const (
	DefaultWebAuthnRPName     = "engram"
	WebAuthnChallengeBytes    = 32
	WebAuthnPRFSaltBytes      = 32
	WebAuthnChallengeTTL      = 5 * time.Minute
	WebAuthnCeremonyTimeoutMS = 60000
	WebAuthnAAGUIDBytes       = 16
)

// WebAuthnRPConfig giữ cấu hình Relying Party đã validate lúc boot.
type WebAuthnRPConfig struct {
	RPID     string
	RPOrigin string
	RPName   string
}

// WebAuthnConfig trả về cấu hình Relying Party của Service.
func (s *Service) WebAuthnConfig() WebAuthnRPConfig {
	return WebAuthnRPConfig{
		RPID:     s.WebAuthnRPID(),
		RPOrigin: s.WebAuthnRPOrigin(),
		RPName:   DefaultWebAuthnRPName,
	}
}

// DefaultCredentialParameters trả về danh sách thuật toán COSE cho phép khi tạo credential WebAuthn.
func DefaultCredentialParameters() []protocol.CredentialParameter {
	return []protocol.CredentialParameter{
		{
			Type:      protocol.PublicKeyCredentialType,
			Algorithm: webauthncose.AlgES256,
		},
		{
			Type:      protocol.PublicKeyCredentialType,
			Algorithm: webauthncose.AlgEdDSA,
		},
		{
			Type:      protocol.PublicKeyCredentialType,
			Algorithm: webauthncose.AlgRS256,
		},
	}
}

// VerifiedAttestation chứa các trường định danh và khoá công khai của credential
// được server tự trích xuất trực tiếp từ `AttData` sau khi `ParsedCredentialCreationData.Verify`
// thành công (ADR 0003 §3, plan mục 2.5).
type VerifiedAttestation struct {
	CredID []byte
	PubKey []byte
	AAGUID []byte
}

// ExtractClientDataChallenge giải mã strict base64url `client_data_json`, đọc trường `challenge`
// từ `CollectedClientData`, kiểm tra `challenge` là base64url strict của đúng 32 byte, và trả về
// chuỗi `challenge` (base64url) cùng `SHA-256(challenge_bytes)` để tra cứu/tiêu thụ bản ghi
// `webauthn_challenge` (ADR 0003 §2 bước 1–2).
func ExtractClientDataChallenge(clientDataJSONB64 string) (challengeB64 string, challengeHash [32]byte, err error) {
	if clientDataJSONB64 == "" {
		return "", [32]byte{}, ErrPasskeyAttestationInvalid
	}
	rawClientData, err := DecodeBase64URLStrict(clientDataJSONB64, 0)
	if err != nil || len(rawClientData) == 0 {
		return "", [32]byte{}, ErrPasskeyAttestationInvalid
	}

	var cd protocol.CollectedClientData
	if err := json.Unmarshal(rawClientData, &cd); err != nil {
		return "", [32]byte{}, ErrPasskeyAttestationInvalid
	}
	if cd.Challenge == "" {
		return "", [32]byte{}, ErrPasskeyChallengeInvalid
	}

	challengeBytes, err := DecodeBase64URLStrict(cd.Challenge, WebAuthnChallengeBytes)
	if err != nil {
		return "", [32]byte{}, ErrPasskeyChallengeInvalid
	}

	return cd.Challenge, sha256.Sum256(challengeBytes), nil
}

// VerifyRegistrationAttestation xác minh dữ liệu đăng ký WebAuthn bằng thư viện đã pin
// `github.com/go-webauthn/webauthn/protocol` (`ParseCredentialCreationResponseBody` +
// `ParsedCredentialCreationData.Verify`) theo đúng ADR 0003 §2–§3:
//   - Kiểm tra strict base64url trên `client_data_json` và `attestation_object`.
//   - Parse qua `protocol.ParseCredentialCreationResponseBody` (không tự parse CBOR ngoài thư viện).
//   - Gọi `pcc.Verify` với `storedChallenge`, `verifyUser = true` (UV required),
//     `verifyUserPresence = true` (UP required), `relyingPartyID = rp.RPID`,
//     `rpOrigins = []string{rp.RPOrigin}` và `DefaultCredentialParameters()`.
//   - Tự trích xuất `cred_id`, `pubkey`, `aaguid` trực tiếp từ `pcc.Response.AttestationObject.AuthData.AttData`
//     và kiểm tra `webauthncose.ParsePublicKey(pubkey)` hợp lệ.
func VerifyRegistrationAttestation(
	rp WebAuthnRPConfig,
	clientDataJSONB64 string,
	attestationObjectB64 string,
	storedChallengeB64 string,
) (VerifiedAttestation, error) {
	if rp.RPID == "" || rp.RPOrigin == "" || storedChallengeB64 == "" {
		return VerifiedAttestation{}, ErrPasskeyAttestationInvalid
	}
	if _, err := DecodeBase64URLStrict(clientDataJSONB64, 0); err != nil {
		return VerifiedAttestation{}, ErrPasskeyAttestationInvalid
	}
	if _, err := DecodeBase64URLStrict(attestationObjectB64, 0); err != nil {
		return VerifiedAttestation{}, ErrPasskeyAttestationInvalid
	}

	// Dựng cấu trúc JSON chuẩn cho `protocol.ParseCredentialCreationResponseBody`.
	// Trường `id`/`rawId` ở mức bao ngoài chỉ là placeholder hợp lệ cho bộ parser;
	// sau khi Verify thành công, server CHỈ lấy `cred_id`, `pubkey`, `aaguid` từ `AttData`
	// bên trong `attestationObject` đã verify (ADR 0003 §3).
	const placeholderID = "AA"
	wirePayload := struct {
		ID       string `json:"id"`
		RawID    string `json:"rawId"`
		Type     string `json:"type"`
		Response struct {
			ClientDataJSON    string `json:"clientDataJSON"`
			AttestationObject string `json:"attestationObject"`
		} `json:"response"`
	}{
		ID:    placeholderID,
		RawID: placeholderID,
		Type:  string(protocol.PublicKeyCredentialType),
	}
	wirePayload.Response.ClientDataJSON = clientDataJSONB64
	wirePayload.Response.AttestationObject = attestationObjectB64

	encodedWire, err := json.Marshal(wirePayload)
	if err != nil {
		return VerifiedAttestation{}, ErrPasskeyAttestationInvalid
	}

	pcc, err := protocol.ParseCredentialCreationResponseBody(bytes.NewReader(encodedWire))
	if err != nil || pcc == nil {
		return VerifiedAttestation{}, ErrPasskeyAttestationInvalid
	}

	if _, err := pcc.Verify(
		storedChallengeB64,
		true, // verifyUser (UV required)
		true, // verifyUserPresence (UP required)
		rp.RPID,
		[]string{rp.RPOrigin},
		nil,
		protocol.TopOriginDefaultVerificationMode,
		nil,
		DefaultCredentialParameters(),
	); err != nil {
		return VerifiedAttestation{}, ErrPasskeyAttestationInvalid
	}

	attData := pcc.Response.AttestationObject.AuthData.AttData
	if len(attData.CredentialID) == 0 || len(attData.CredentialPublicKey) == 0 {
		return VerifiedAttestation{}, ErrPasskeyAttestationInvalid
	}
	if _, err := webauthncose.ParsePublicKey(attData.CredentialPublicKey); err != nil {
		return VerifiedAttestation{}, ErrPasskeyAttestationInvalid
	}

	var aaguid []byte
	if len(attData.AAGUID) == WebAuthnAAGUIDBytes {
		aaguid = make([]byte, WebAuthnAAGUIDBytes)
		copy(aaguid, attData.AAGUID)
	} else if len(attData.AAGUID) != 0 {
		return VerifiedAttestation{}, ErrPasskeyAttestationInvalid
	}

	credID := make([]byte, len(attData.CredentialID))
	copy(credID, attData.CredentialID)
	pubKey := make([]byte, len(attData.CredentialPublicKey))
	copy(pubKey, attData.CredentialPublicKey)

	return VerifiedAttestation{
		CredID: credID,
		PubKey: pubKey,
		AAGUID: aaguid,
	}, nil
}
