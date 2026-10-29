// Package webauthntest cung cấp bộ giả lập thiết bị xác thực WebAuthn (virtual authenticator)
// chỉ dành cho kiểm thử (Task 13, ADR 0003).
//
// Bộ helper sinh khoá ES256 thật từ `crypto/ecdsa`, mã hoá `COSE_Key` và `attestationObject`
// (định dạng `none`) bằng `github.com/go-webauthn/webauthn/protocol/webauthncbor` và
// `webauthncose`, đồng thời cung cấp các nút vặn (knobs) để làm hỏng từng thuộc tính bảo mật
// (sai origin, sai port dev, sai rpIdHash, tắt cờ UV, tắt cờ UP, sai ceremony type,
// hỏng CBOR, sai challenge) mà không dùng bất kỳ blob cứng (hardcoded opaque blob) nào.
package webauthntest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/go-webauthn/webauthn/protocol/webauthncose"
	"github.com/google/uuid"
)

// DefaultAAGUID là AAGUID 16 byte mặc định của virtual authenticator khi caller không truyền riêng.
var DefaultAAGUID = uuid.MustParse("ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4")

// RegistrationOptions cấu hình một lần gọi tạo credential trên virtual authenticator.
type RegistrationOptions struct {
	RPID         string
	Origin       string
	ChallengeB64 string
	PRFSalt      []byte

	// Tuỳ chọn cố định CredentialID, AAGUID hoặc khoá ECDSA (nếu để nil sẽ tự sinh ngẫu nhiên).
	CredentialID []byte
	AAGUID       []byte
	PrivateKey   *ecdsa.PrivateKey
	SignCount    uint32

	// Các nút vặn (knobs) để kiểm thử từng nhánh từ chối của server:
	OverrideOrigin                string // ví dụ khác scheme, khác host hoặc sai port dev
	OverrideRPIDForHash           string // tính rpIdHash từ RP ID khác với RPID của server
	OverrideRPIDHash              []byte // ghi đè trực tiếp 32 byte rpIdHash
	OverrideChallengeB64          string // ghi đè challenge trong clientDataJSON
	OverrideCeremonyType          string // ví dụ "webauthn.get" thay vì "webauthn.create"
	OverrideFormat                string // mặc định "none"
	DisableUserVerification       bool   // tắt bit UV (0x04)
	DisableUserPresence           bool   // tắt bit UP (0x01)
	DisableAttestedCredentialFlag bool   // tắt bit AT (0x40)
	ExplicitFlags                 *protocol.AuthenticatorFlags
	CorruptAttestationCBOR        bool // trả về chuỗi CBOR hỏng không giải mã được
	CorruptClientDataJSON         bool // trả về chuỗi JSON hỏng trong client_data_json
	CorruptCOSEPublicKey          bool // ghi CBOR rác vào trường CredentialPublicKey
	UnsupportedCOSEAlgorithm      int64
}

// RegistrationResult chứa dữ liệu đăng ký do virtual authenticator sinh ra.
type RegistrationResult struct {
	ClientDataJSON       []byte
	ClientDataJSONB64    string
	AttestationObject    []byte
	AttestationObjectB64 string
	CredentialID         []byte
	CredentialIDB64      string
	PublicKeyCOSE        []byte
	PublicKeyB64         string
	AAGUID               []byte
	AAGUIDString         string
	PRFOutput            []byte
	PrivateKey           *ecdsa.PrivateKey
}

// VirtualAuthenticator mô phỏng một thiết bị xác thực WebAuthn hỗ trợ phần mở rộng PRF (`hmac-secret`).
type VirtualAuthenticator struct {
	aaguid     []byte
	prfSecrets map[string][]byte
}

// New tạo một `*VirtualAuthenticator` mới với AAGUID mặc định.
func New() *VirtualAuthenticator {
	aaguid := make([]byte, 16)
	copy(aaguid, DefaultAAGUID[:])
	return &VirtualAuthenticator{
		aaguid:     aaguid,
		prfSecrets: make(map[string][]byte),
	}
}

// CreateCredential thực hiện lễ đăng ký WebAuthn (`navigator.credentials.create()`) trên authenticator ảo.
func (va *VirtualAuthenticator) CreateCredential(opts RegistrationOptions) (*RegistrationResult, error) {
	if va == nil {
		va = New()
	}
	priv := opts.PrivateKey
	var err error
	if priv == nil {
		priv, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, fmt.Errorf("webauthntest: generate ES256 key: %w", err)
		}
	}

	credID := opts.CredentialID
	if len(credID) == 0 {
		credID = make([]byte, 32)
		if _, err := rand.Read(credID); err != nil {
			return nil, fmt.Errorf("webauthntest: random credential id: %w", err)
		}
	} else {
		cp := make([]byte, len(credID))
		copy(cp, credID)
		credID = cp
	}

	aaguid := opts.AAGUID
	if len(aaguid) == 0 {
		aaguid = make([]byte, 16)
		copy(aaguid, va.aaguid)
	} else {
		if len(aaguid) != 16 {
			return nil, errors.New("webauthntest: aaguid must be 16 bytes")
		}
		cp := make([]byte, 16)
		copy(cp, aaguid)
		aaguid = cp
	}

	coseKeyBytes, err := encodeES256COSEKey(&priv.PublicKey, opts.UnsupportedCOSEAlgorithm)
	if err != nil {
		return nil, err
	}
	if opts.CorruptCOSEPublicKey {
		coseKeyBytes = []byte{0xff, 0x00, 0x01}
	}

	var rpIDHash [32]byte
	switch {
	case len(opts.OverrideRPIDHash) == 32:
		copy(rpIDHash[:], opts.OverrideRPIDHash)
	case opts.OverrideRPIDForHash != "":
		rpIDHash = sha256.Sum256([]byte(opts.OverrideRPIDForHash))
	default:
		rpIDHash = sha256.Sum256([]byte(opts.RPID))
	}

	flags := protocol.FlagUserPresent | protocol.FlagUserVerified | protocol.FlagAttestedCredentialData
	if opts.DisableUserPresence {
		flags &^= protocol.FlagUserPresent
	}
	if opts.DisableUserVerification {
		flags &^= protocol.FlagUserVerified
	}
	if opts.DisableAttestedCredentialFlag {
		flags &^= protocol.FlagAttestedCredentialData
	}
	if opts.ExplicitFlags != nil {
		flags = *opts.ExplicitFlags
	}

	rawAuthData := buildAuthenticatorData(rpIDHash[:], flags, opts.SignCount, aaguid, credID, coseKeyBytes)

	format := opts.OverrideFormat
	if format == "" {
		format = string(protocol.AttestationFormatNone)
	}

	var attObjBytes []byte
	if opts.CorruptAttestationCBOR {
		attObjBytes = []byte{0xa3, 0x63, 'f', 'm', 't', 0xff, 0x00}
	} else {
		attObj := struct {
			Format       string         `cbor:"fmt"`
			AttStatement map[string]any `cbor:"attStmt"`
			AuthData     []byte         `cbor:"authData"`
		}{
			Format:       format,
			AttStatement: map[string]any{},
			AuthData:     rawAuthData,
		}
		attObjBytes, err = webauthncbor.Marshal(attObj)
		if err != nil {
			return nil, fmt.Errorf("webauthntest: marshal attestation object: %w", err)
		}
	}

	ceremonyType := string(protocol.CreateCeremony)
	if opts.OverrideCeremonyType != "" {
		ceremonyType = opts.OverrideCeremonyType
	}
	challengeB64 := opts.ChallengeB64
	if opts.OverrideChallengeB64 != "" {
		challengeB64 = opts.OverrideChallengeB64
	}
	origin := opts.Origin
	if opts.OverrideOrigin != "" {
		origin = opts.OverrideOrigin
	}

	var clientDataBytes []byte
	if opts.CorruptClientDataJSON {
		clientDataBytes = []byte(`{"type":"webauthn.create","challenge":`)
	} else {
		cd := protocol.CollectedClientData{
			Type:      protocol.CeremonyType(ceremonyType),
			Challenge: challengeB64,
			Origin:    origin,
		}
		clientDataBytes, err = json.Marshal(cd)
		if err != nil {
			return nil, fmt.Errorf("webauthntest: marshal clientDataJSON: %w", err)
		}
	}

	credIDB64 := base64.RawURLEncoding.EncodeToString(credID)
	prfSecret := make([]byte, 32)
	if _, err := rand.Read(prfSecret); err != nil {
		return nil, fmt.Errorf("webauthntest: random prf secret: %w", err)
	}
	if va.prfSecrets != nil {
		va.prfSecrets[credIDB64] = prfSecret
	}

	var prfOut []byte
	if len(opts.PRFSalt) > 0 {
		prfOut = evalPRF(prfSecret, opts.PRFSalt)
	}

	u, err := uuid.FromBytes(aaguid)
	if err != nil {
		return nil, err
	}

	return &RegistrationResult{
		ClientDataJSON:       clientDataBytes,
		ClientDataJSONB64:    base64.RawURLEncoding.EncodeToString(clientDataBytes),
		AttestationObject:    attObjBytes,
		AttestationObjectB64: base64.RawURLEncoding.EncodeToString(attObjBytes),
		CredentialID:         credID,
		CredentialIDB64:      credIDB64,
		PublicKeyCOSE:        coseKeyBytes,
		PublicKeyB64:         base64.RawURLEncoding.EncodeToString(coseKeyBytes),
		AAGUID:               aaguid,
		AAGUIDString:         u.String(),
		PRFOutput:            prfOut,
		PrivateKey:           priv,
	}, nil
}

// EvaluatePRF tính đầu ra 32 byte của phần mở rộng PRF (`hmac-secret`) cho một credential đã tạo
// trên `VirtualAuthenticator` với muối `prfSalt`.
func (va *VirtualAuthenticator) EvaluatePRF(credIDB64 string, prfSalt []byte) ([]byte, error) {
	if va == nil {
		return nil, errors.New("webauthntest: nil virtual authenticator")
	}
	secret, ok := va.prfSecrets[credIDB64]
	if !ok {
		return nil, fmt.Errorf("webauthntest: unknown credential %q", credIDB64)
	}
	if len(prfSalt) != 32 {
		return nil, fmt.Errorf("webauthntest: prfSalt must be 32 bytes, got %d", len(prfSalt))
	}
	return evalPRF(secret, prfSalt), nil
}

func evalPRF(credSecret, prfSalt []byte) []byte {
	mac := hmac.New(sha256.New, credSecret)
	mac.Write([]byte("WebAuthn PRF\x00"))
	mac.Write(prfSalt)
	return mac.Sum(nil)
}

func encodeES256COSEKey(pub *ecdsa.PublicKey, overrideAlg int64) ([]byte, error) {
	xBytes := make([]byte, 32)
	yBytes := make([]byte, 32)
	pub.X.FillBytes(xBytes)
	pub.Y.FillBytes(yBytes)

	alg := int64(webauthncose.AlgES256)
	if overrideAlg != 0 {
		alg = overrideAlg
	}

	coseKey := webauthncose.EC2PublicKeyData{
		PublicKeyData: webauthncose.PublicKeyData{
			KeyType:   int64(webauthncose.EllipticKey),
			Algorithm: alg,
		},
		Curve:  int64(webauthncose.P256),
		XCoord: xBytes,
		YCoord: yBytes,
	}
	return webauthncbor.Marshal(coseKey)
}

func buildAuthenticatorData(
	rpIDHash []byte,
	flags protocol.AuthenticatorFlags,
	signCount uint32,
	aaguid []byte,
	credID []byte,
	cosePubKey []byte,
) []byte {
	totalLen := 32 + 1 + 4 + 16 + 2 + len(credID) + len(cosePubKey)
	out := make([]byte, 0, totalLen)
	out = append(out, rpIDHash[:32]...)
	out = append(out, byte(flags))

	var countBuf [4]byte
	binary.BigEndian.PutUint32(countBuf[:], signCount)
	out = append(out, countBuf[:]...)

	out = append(out, aaguid[:16]...)

	var credLenBuf [2]byte
	binary.BigEndian.PutUint16(credLenBuf[:], uint16(len(credID)))
	out = append(out, credLenBuf[:]...)
	out = append(out, credID...)
	out = append(out, cosePubKey...)
	return out
}
