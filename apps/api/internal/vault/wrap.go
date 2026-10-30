package vault

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"

	"golang.org/x/crypto/chacha20poly1305"
)

// Hằng số bố cục byte và độ dài cho các bản wrap (ADR 0002 §1, plan mục 2.1).
const (
	WrapVersion    byte = 0x01
	WrapNonceBytes      = chacha20poly1305.NonceSizeX // 24
	WrapTagBytes        = chacha20poly1305.Overhead   // 16
	VKBytes             = chacha20poly1305.KeySize    // 32
	SeedBytes           = 32
	PrivPlainBytes      = SeedBytes * 2                                      // 64 (x25519_seed || ed25519_seed)
	VKWrapBytes         = 1 + WrapNonceBytes + VKBytes + WrapTagBytes        // 73
	PrivWrapBytes       = 1 + WrapNonceBytes + PrivPlainBytes + WrapTagBytes // 105
)

// WrapLabel định nghĩa các nhãn miền AAD có tiền tố sabk.* (ADR 0002 §1).
type WrapLabel string

const (
	LabelWrapKEK  WrapLabel = "sabk.vk.kek.v1"
	LabelWrapRK   WrapLabel = "sabk.vk.rk.v1"
	LabelWrapPRF  WrapLabel = "sabk.vk.prf.v1"
	LabelWrapPriv WrapLabel = "sabk.priv.v1"
)

// WrapKind phân loại 4 loại bản wrap lưu trên server.
type WrapKind string

const (
	WrapKindKEK  WrapKind = "kek"
	WrapKindRK   WrapKind = "rk"
	WrapKindPRF  WrapKind = "prf"
	WrapKindPriv WrapKind = "priv"
)

// Các lỗi chuẩn của package vault cho thao tác base64url và wrap.
var (
	ErrBase64URLInvalid   = errors.New("vault: invalid strict base64url encoding")
	ErrWrapInvalid        = errors.New("vault: invalid wrap layout or version")
	ErrWrapKindInvalid    = errors.New("vault: unknown wrap kind")
	ErrAEADDecryptFailed  = errors.New("vault: aead decryption failed")
	ErrKeyPairSeedInvalid = errors.New("vault: invalid private key seed length")
)

// ExpectedLen trả về độ dài byte bắt buộc của bản wrap theo WrapKind (73 B hoặc 105 B).
func (k WrapKind) ExpectedLen() (int, bool) {
	switch k {
	case WrapKindKEK, WrapKindRK, WrapKindPRF:
		return VKWrapBytes, true
	case WrapKindPriv:
		return PrivWrapBytes, true
	default:
		return 0, false
	}
}

// ExpectedPlaintextLen trả về độ dài plaintext bắt buộc của bản wrap theo WrapKind (32 B hoặc 64 B).
func (k WrapKind) ExpectedPlaintextLen() (int, bool) {
	switch k {
	case WrapKindKEK, WrapKindRK, WrapKindPRF:
		return VKBytes, true
	case WrapKindPriv:
		return PrivPlainBytes, true
	default:
		return 0, false
	}
}

// Label trả về nhãn miền AAD tương ứng với WrapKind.
func (k WrapKind) Label() (WrapLabel, bool) {
	switch k {
	case WrapKindKEK:
		return LabelWrapKEK, true
	case WrapKindRK:
		return LabelWrapRK, true
	case WrapKindPRF:
		return LabelWrapPRF, true
	case WrapKindPriv:
		return LabelWrapPriv, true
	default:
		return "", false
	}
}

// KindFromLabel ánh xạ nhãn miền sang WrapKind.
func KindFromLabel(label WrapLabel) (WrapKind, bool) {
	switch label {
	case LabelWrapKEK:
		return WrapKindKEK, true
	case LabelWrapRK:
		return WrapKindRK, true
	case LabelWrapPRF:
		return WrapKindPRF, true
	case LabelWrapPriv:
		return WrapKindPriv, true
	default:
		return "", false
	}
}

// EncodeBase64URL mã hoá mảng byte sang chuỗi base64url không padding (RFC 4648 §5).
func EncodeBase64URL(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

// DecodeBase64URLStrict giải mã chuỗi base64url không padding ở chế độ strict (ADR 0002 §3):
//   - Từ chối ký tự padding `=`, ký tự bảng chuẩn `+`/`/`, khoảng trắng/newline (`\r`, `\n`), ký tự ngoài bảng.
//   - Từ chối độ dài chuỗi có `len % 4 == 1` hoặc các bit dư cuối chuỗi khác 0 (`base64.RawURLEncoding.Strict()`).
//   - Nếu expectedLen > 0, từ chối nếu độ dài mảng byte sau giải mã khác expectedLen.
func DecodeBase64URLStrict(s string, expectedLen int) ([]byte, error) {
	for i := range len(s) {
		c := s[i]
		isUpper := c >= 'A' && c <= 'Z'
		isLower := c >= 'a' && c <= 'z'
		isDigit := c >= '0' && c <= '9'
		isURLPunct := c == '-' || c == '_'
		if !isUpper && !isLower && !isDigit && !isURLPunct {
			return nil, fmt.Errorf("%w: invalid character at index %d", ErrBase64URLInvalid, i)
		}
	}
	if len(s)%4 == 1 {
		return nil, fmt.Errorf("%w: invalid base64url length %d", ErrBase64URLInvalid, len(s))
	}

	decodedLen := base64.RawURLEncoding.DecodedLen(len(s))
	if expectedLen > 0 && decodedLen != expectedLen {
		return nil, fmt.Errorf("%w: expected %d bytes, got %d", ErrBase64URLInvalid, expectedLen, decodedLen)
	}

	buf := make([]byte, decodedLen)
	n, err := base64.RawURLEncoding.Strict().Decode(buf, []byte(s))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBase64URLInvalid, err)
	}
	if n != decodedLen || (expectedLen > 0 && n != expectedLen) {
		return nil, fmt.Errorf("%w: decoded length mismatch", ErrBase64URLInvalid)
	}
	return buf[:n], nil
}

// BuildWrapAAD tạo chuỗi AAD cho bản wrap lưu trên server (ADR 0002 §1, plan mục 2.1):
// `UTF8(label) || 0x00 || version(1)`
func BuildWrapAAD(label WrapLabel, version byte) []byte {
	aad := make([]byte, len(label)+2)
	copy(aad, label)
	aad[len(label)] = 0x00
	aad[len(label)+1] = version
	return aad
}

// ValidateWrapBytes là validator dùng chung (plan mục 2.1, Task 6/8) kiểm tra độ dài byte
// (73 B cho KEK/RK/PRF wrap, 105 B cho private key wrap) và byte đầu `version == 0x01`.
func ValidateWrapBytes(raw []byte, kind WrapKind) error {
	expectedLen, ok := kind.ExpectedLen()
	if !ok {
		return fmt.Errorf("%w: %q", ErrWrapKindInvalid, kind)
	}
	if len(raw) != expectedLen {
		return fmt.Errorf("%w: expected %d bytes for %s wrap, got %d", ErrWrapInvalid, expectedLen, kind, len(raw))
	}
	if raw[0] != WrapVersion {
		return fmt.Errorf("%w: unsupported wrap version 0x%02x", ErrWrapInvalid, raw[0])
	}
	return nil
}

// ValidateWrapBase64URL giải mã strict base64url không padding và kiểm tra bố cục byte
// (độ dài 73 B / 105 B, byte đầu `version == 0x01`) bằng validator dùng chung.
func ValidateWrapBase64URL(encoded string, kind WrapKind) ([]byte, error) {
	expectedLen, ok := kind.ExpectedLen()
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrWrapKindInvalid, kind)
	}
	raw, err := DecodeBase64URLStrict(encoded, expectedLen)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrWrapInvalid, err)
	}
	if err := ValidateWrapBytes(raw, kind); err != nil {
		return nil, err
	}
	return raw, nil
}

// SealWrap đóng gói plaintext (32 B cho VK hoặc 64 B cho private seeds) bằng XChaCha20-Poly1305 IETF:
// `version(1)=0x01 || nonce(24) || ciphertext || tag(16)` với AAD `UTF8(label) || 0x00 || 0x01`.
// Nếu nonce == nil, hàm tự sinh 24 byte ngẫu nhiên từ crypto/rand.
func SealWrap(kind WrapKind, plaintext, key, nonce []byte) ([]byte, error) {
	expectedPtLen, ok := kind.ExpectedPlaintextLen()
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrWrapKindInvalid, kind)
	}
	label, _ := kind.Label()
	if len(plaintext) != expectedPtLen {
		return nil, fmt.Errorf("%w: plaintext for %s wrap must be %d bytes, got %d", ErrWrapInvalid, kind, expectedPtLen, len(plaintext))
	}
	if len(key) != VKBytes {
		return nil, fmt.Errorf("%w: key for %s wrap must be %d bytes, got %d", ErrWrapInvalid, kind, VKBytes, len(key))
	}

	var n []byte
	if nonce == nil {
		n = make([]byte, WrapNonceBytes)
		if _, err := rand.Read(n); err != nil {
			return nil, fmt.Errorf("vault: read random nonce: %w", err)
		}
	} else {
		if len(nonce) != WrapNonceBytes {
			return nil, fmt.Errorf("%w: nonce must be %d bytes, got %d", ErrWrapInvalid, WrapNonceBytes, len(nonce))
		}
		n = nonce
	}

	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrWrapInvalid, err)
	}

	aad := BuildWrapAAD(label, WrapVersion)
	out := make([]byte, 1+WrapNonceBytes, 1+WrapNonceBytes+len(plaintext)+WrapTagBytes)
	out[0] = WrapVersion
	copy(out[1:], n)
	out = aead.Seal(out, n, plaintext, aad)
	return out, nil
}

// SealWrapBase64URL thực hiện SealWrap và trả về chuỗi base64url không padding.
func SealWrapBase64URL(kind WrapKind, plaintext, key, nonce []byte) (string, error) {
	raw, err := SealWrap(kind, plaintext, key, nonce)
	if err != nil {
		return "", err
	}
	return EncodeBase64URL(raw), nil
}

// OpenWrap mở một bản wrap (73 B cho VK hoặc 105 B cho private keys) bằng XChaCha20-Poly1305 IETF.
// Lưu ý (ADR 0002 §1, Task 6 bullet 5): byte `version` ở đầu blob được đưa vào cuối chuỗi AAD
// (`UTF8(label) || 0x00 || version(1)`), nên nếu byte `version` của một bản wrap bị sửa đổi mà không
// đổi khoá, bước xác thực tag AEAD sẽ thất bại ngay lập tức (`ErrAEADDecryptFailed`).
func OpenWrap(kind WrapKind, wrapBytes, key []byte) ([]byte, error) {
	expectedLen, ok := kind.ExpectedLen()
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrWrapKindInvalid, kind)
	}
	label, _ := kind.Label()
	if len(wrapBytes) != expectedLen {
		return nil, fmt.Errorf("%w: expected %d bytes for %s wrap, got %d", ErrWrapInvalid, expectedLen, kind, len(wrapBytes))
	}
	if len(key) != VKBytes {
		return nil, fmt.Errorf("%w: key for %s wrap must be %d bytes, got %d", ErrWrapInvalid, kind, VKBytes, len(key))
	}

	versionByte := wrapBytes[0]
	nonce := wrapBytes[1 : 1+WrapNonceBytes]
	ctAndTag := wrapBytes[1+WrapNonceBytes:]

	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrWrapInvalid, err)
	}

	aad := BuildWrapAAD(label, versionByte)
	plaintext, err := aead.Open(nil, nonce, ctAndTag, aad)
	if err != nil {
		return nil, fmt.Errorf("%w: %s wrap authentication failed", ErrAEADDecryptFailed, kind)
	}
	if versionByte != WrapVersion {
		clear(plaintext)
		return nil, fmt.Errorf("%w: unsupported wrap version 0x%02x", ErrAEADDecryptFailed, versionByte)
	}
	return plaintext, nil
}

// OpenWrapBase64URL giải mã strict base64url không padding rồi mở bản wrap bằng OpenWrap.
func OpenWrapBase64URL(kind WrapKind, encoded string, key []byte) ([]byte, error) {
	expectedLen, ok := kind.ExpectedLen()
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrWrapKindInvalid, kind)
	}
	raw, err := DecodeBase64URLStrict(encoded, expectedLen)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrWrapInvalid, err)
	}
	return OpenWrap(kind, raw, key)
}

// PackPrivateKeySeeds ghép `x25519Seed(32) || ed25519Seed(32)` thành mảng 64 byte.
func PackPrivateKeySeeds(x25519Seed, ed25519Seed []byte) ([]byte, error) {
	if len(x25519Seed) != SeedBytes || len(ed25519Seed) != SeedBytes {
		return nil, fmt.Errorf("%w: expected 32-byte x25519 and ed25519 seeds", ErrKeyPairSeedInvalid)
	}
	combined := make([]byte, PrivPlainBytes)
	copy(combined[:SeedBytes], x25519Seed)
	copy(combined[SeedBytes:], ed25519Seed)
	return combined, nil
}

// UnpackPrivateKeySeeds tách mảng 64 byte thành hai bản sao độc lập `x25519Seed(32)` và `ed25519Seed(32)`.
func UnpackPrivateKeySeeds(combined []byte) (x25519Seed, ed25519Seed []byte, err error) {
	if len(combined) != PrivPlainBytes {
		return nil, nil, fmt.Errorf("%w: expected 64-byte combined seeds, got %d", ErrKeyPairSeedInvalid, len(combined))
	}
	x25519Seed = make([]byte, SeedBytes)
	ed25519Seed = make([]byte, SeedBytes)
	copy(x25519Seed, combined[:SeedBytes])
	copy(ed25519Seed, combined[SeedBytes:])
	return x25519Seed, ed25519Seed, nil
}
