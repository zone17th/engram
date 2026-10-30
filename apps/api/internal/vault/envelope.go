package vault

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"unicode/utf8"

	"github.com/gowebpki/jcs"
	"golang.org/x/crypto/chacha20poly1305"
)

// Hằng số cho entry envelope v1 và AAD (SPEC §5.5, ADR 0002 §1, §3).
const (
	EnvelopeVersion        = 1
	EnvelopeAlg            = "xchacha20poly1305-ietf"
	EnvelopeCtEnc          = "utf8"
	EnvelopeAADLabel       = "sabk.entry.v1"
	EntryPlaintextMaxBytes = 262_144 // 256 KiB
	EntryCiphertextMax     = 263_168 // 256 KiB + AEAD slack
)

var (
	// ErrEnvelopeInvalid trả về khi envelope hoặc entry_id không hợp lệ (thiếu/thừa field,
	// trùng khoá JSON kể cả qua unicode escape, sai kiểu, sai key_id/nonce/ct_enc/v).
	ErrEnvelopeInvalid = errors.New("vault: invalid entry envelope")

	keyIDPattern   = regexp.MustCompile(`^(?:vk|sk):[A-Za-z0-9_-]{22}$`)
	entryIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// EntryEnvelopeV1 biểu diễn object `entry.envelope` phiên bản 1 gồm đúng 5 trường bắt buộc (SPEC §5.5).
type EntryEnvelopeV1 struct {
	V     int    `json:"v"`
	Alg   string `json:"alg"`
	KeyID string `json:"key_id"`
	Nonce string `json:"nonce"`
	CtEnc string `json:"ct_enc"`
}

// ValidateEntryID kiểm tra `entry_id` là UUID chữ thường dạng `8-4-4-4-12` (SPEC §5.5, ADR 0002 §3).
func ValidateEntryID(entryID string) error {
	if !entryIDPattern.MatchString(entryID) {
		return fmt.Errorf("%w: entry_id must be lowercase hyphenated UUID (8-4-4-4-12)", ErrEnvelopeInvalid)
	}
	return nil
}

// ValidateEnvelopeStruct kiểm tra giá trị của 5 trường trong EntryEnvelopeV1 đã được giải mã.
func ValidateEnvelopeStruct(env EntryEnvelopeV1) error {
	if env.V != EnvelopeVersion {
		return fmt.Errorf("%w: unsupported envelope version %d", ErrEnvelopeInvalid, env.V)
	}
	if env.Alg != EnvelopeAlg {
		return fmt.Errorf("%w: unsupported envelope alg %q", ErrEnvelopeInvalid, env.Alg)
	}
	if !utf8.ValidString(env.KeyID) || !keyIDPattern.MatchString(env.KeyID) {
		return fmt.Errorf("%w: invalid envelope key_id", ErrEnvelopeInvalid)
	}
	if _, err := DecodeBase64URLStrict(env.Nonce, WrapNonceBytes); err != nil {
		return fmt.Errorf("%w: invalid envelope nonce: %w", ErrEnvelopeInvalid, err)
	}
	if env.CtEnc != EnvelopeCtEnc {
		return fmt.Errorf("%w: unsupported envelope ct_enc %q", ErrEnvelopeInvalid, env.CtEnc)
	}
	return nil
}

// ValidateEntryEnvelope kiểm tra nghiêm ngặt raw JSON của `entry.envelope` (SPEC §5.5, ADR 0002 §3, Task 6):
//   - Bắt buộc là chuỗi UTF-8 hợp lệ, không chứa surrogate lẻ (`\uD800`..`\uDFFF` không ghép cặp).
//   - Quét token bằng `json.Decoder.Token()` (với `UseNumber()`) trên các khoá đã giải mã escape TRƯỚC khi
//     chuyển thành struct/map để phát hiện và từ chối mọi khoá trùng lặp (ví dụ `"ct_enc"` và `"ct\u005fenc"`
//     hoặc `"\u0063t_enc"`), trường thiếu, trường thừa hoặc kiểu dữ liệu sai.
//   - Không tự động điền giá trị mặc định cho `ct_enc`.
//   - Exported để P04 tái sử dụng khi validate entry request/response.
func ValidateEntryEnvelope(rawJSON []byte) (EntryEnvelopeV1, error) {
	var zero EntryEnvelopeV1
	if !utf8.Valid(rawJSON) {
		return zero, fmt.Errorf("%w: envelope JSON contains invalid UTF-8", ErrEnvelopeInvalid)
	}
	if err := rejectLoneUTF16SurrogateEscapes(rawJSON); err != nil {
		return zero, err
	}

	dec := json.NewDecoder(bytes.NewReader(rawJSON))
	dec.UseNumber()

	tok, err := dec.Token()
	if err != nil {
		return zero, fmt.Errorf("%w: %v", ErrEnvelopeInvalid, err)
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return zero, fmt.Errorf("%w: envelope must be a JSON object", ErrEnvelopeInvalid)
	}

	seenKeys := make(map[string]struct{}, 5)
	var env EntryEnvelopeV1

	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return zero, fmt.Errorf("%w: %v", ErrEnvelopeInvalid, err)
		}
		key, ok := keyTok.(string)
		if !ok {
			return zero, fmt.Errorf("%w: expected string key in JSON object", ErrEnvelopeInvalid)
		}
		if _, dup := seenKeys[key]; dup {
			return zero, fmt.Errorf("%w: duplicate JSON object key %q", ErrEnvelopeInvalid, key)
		}
		seenKeys[key] = struct{}{}

		valTok, err := dec.Token()
		if err != nil {
			return zero, fmt.Errorf("%w: %v", ErrEnvelopeInvalid, err)
		}
		if _, isDelim := valTok.(json.Delim); isDelim {
			return zero, fmt.Errorf("%w: nested object or array not allowed in field %q", ErrEnvelopeInvalid, key)
		}

		switch key {
		case "v":
			num, ok := valTok.(json.Number)
			if !ok {
				return zero, fmt.Errorf("%w: field \"v\" must be a JSON integer", ErrEnvelopeInvalid)
			}
			numStr := num.String()
			if numStr != "1" {
				// Kiểm tra xem có phải số thực/mũ (như 1.0, 1e0) hay số nguyên khác 1.
				if _, intErr := strconv.ParseInt(numStr, 10, 64); intErr != nil {
					return zero, fmt.Errorf("%w: field \"v\" must be an integer without fraction or exponent, got %q", ErrEnvelopeInvalid, numStr)
				}
				return zero, fmt.Errorf("%w: unsupported envelope version %s", ErrEnvelopeInvalid, numStr)
			}
			env.V = EnvelopeVersion
		case "alg":
			s, ok := valTok.(string)
			if !ok {
				return zero, fmt.Errorf("%w: field \"alg\" must be a string", ErrEnvelopeInvalid)
			}
			env.Alg = s
		case "key_id":
			s, ok := valTok.(string)
			if !ok {
				return zero, fmt.Errorf("%w: field \"key_id\" must be a string", ErrEnvelopeInvalid)
			}
			env.KeyID = s
		case "nonce":
			s, ok := valTok.(string)
			if !ok {
				return zero, fmt.Errorf("%w: field \"nonce\" must be a string", ErrEnvelopeInvalid)
			}
			env.Nonce = s
		case "ct_enc":
			s, ok := valTok.(string)
			if !ok {
				return zero, fmt.Errorf("%w: field \"ct_enc\" must be a string", ErrEnvelopeInvalid)
			}
			env.CtEnc = s
		default:
			return zero, fmt.Errorf("%w: unexpected envelope field %q", ErrEnvelopeInvalid, key)
		}
	}

	endTok, err := dec.Token()
	if err != nil {
		return zero, fmt.Errorf("%w: %v", ErrEnvelopeInvalid, err)
	}
	if endDelim, ok := endTok.(json.Delim); !ok || endDelim != '}' {
		return zero, fmt.Errorf("%w: expected closing '}' for envelope object", ErrEnvelopeInvalid)
	}

	// Không cho phép dữ liệu thừa sau dấu `}` của object gốc.
	if extraTok, err := dec.Token(); !errors.Is(err, io.EOF) {
		return zero, fmt.Errorf("%w: unexpected trailing JSON token %v", ErrEnvelopeInvalid, extraTok)
	}

	if len(seenKeys) != 5 {
		return zero, fmt.Errorf("%w: envelope must contain all 5 required fields, got %d", ErrEnvelopeInvalid, len(seenKeys))
	}

	if err := ValidateEnvelopeStruct(env); err != nil {
		return zero, err
	}
	return env, nil
}

// ValidateEntryEnvelopeString là hàm tiện ích gọi ValidateEntryEnvelope trên chuỗi JSON.
func ValidateEntryEnvelopeString(rawJSON string) (EntryEnvelopeV1, error) {
	return ValidateEntryEnvelope([]byte(rawJSON))
}

// CanonicalizeEnvelopeJCS chuẩn hoá EntryEnvelopeV1 đã qua kiểm tra thành chuỗiバイト RFC 8785 (JCS)
// bằng thư viện `github.com/gowebpki/jcs` v1.0.2 (ADR 0002 §3, §12).
func CanonicalizeEnvelopeJCS(env EntryEnvelopeV1) ([]byte, error) {
	if err := ValidateEnvelopeStruct(env); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(env)
	if err != nil {
		return nil, fmt.Errorf("%w: marshal envelope: %v", ErrEnvelopeInvalid, err)
	}
	canonical, err := jcs.Transform(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: jcs transform: %v", ErrEnvelopeInvalid, err)
	}
	return canonical, nil
}

// CanonicalizeRawEnvelopeJCS kiểm tra nghiêm ngặt raw JSON của envelope (kể cả phát hiện trùng khoá)
// rồi chuẩn hoá theo RFC 8785 (JCS) bằng `github.com/gowebpki/jcs` v1.0.2.
func CanonicalizeRawEnvelopeJCS(rawJSON []byte) (EntryEnvelopeV1, []byte, error) {
	env, err := ValidateEntryEnvelope(rawJSON)
	if err != nil {
		return EntryEnvelopeV1{}, nil, err
	}
	// Chạy jcs.Transform trực tiếp trên rawJSON đã được validate (hoặc struct đã marshal)
	// và đảm bảo kết quả khớp tuyệt đối.
	canonical, err := jcs.Transform(rawJSON)
	if err != nil {
		return EntryEnvelopeV1{}, nil, fmt.Errorf("%w: jcs transform: %v", ErrEnvelopeInvalid, err)
	}
	return env, canonical, nil
}

// BuildEntryAAD dựng chuỗi byte AAD cho entry theo SPEC §5.5 và ADR 0002 §1, §3:
// `UTF8("sabk.entry.v1") || 0x00 || UTF8(JCS(envelope)) || 0x00 || ASCII(entry_id)`
func BuildEntryAAD(env EntryEnvelopeV1, entryID string) ([]byte, error) {
	if err := ValidateEntryID(entryID); err != nil {
		return nil, err
	}
	jcsBytes, err := CanonicalizeEnvelopeJCS(env)
	if err != nil {
		return nil, err
	}
	aad := make([]byte, 0, len(EnvelopeAADLabel)+1+len(jcsBytes)+1+len(entryID))
	aad = append(aad, EnvelopeAADLabel...)
	aad = append(aad, 0x00)
	aad = append(aad, jcsBytes...)
	aad = append(aad, 0x00)
	aad = append(aad, entryID...)
	return aad, nil
}

// SealEntry mã hoá nội dung entry UTF-8 (tối đa 256 KiB) bằng XChaCha20-Poly1305 IETF dưới khoá `vk`
// với AAD `UTF8("sabk.entry.v1") || 0x00 || UTF8(JCS(envelope)) || 0x00 || ASCII(entry_id)`.
// Ciphertext trả về là output AEAD thuần (`ciphertext_body || tag(16)`), không có byte version hay nonce ở đầu.
func SealEntry(entryID, keyID string, plaintext, vk, nonce []byte) (EntryEnvelopeV1, []byte, error) {
	var zero EntryEnvelopeV1
	if err := ValidateEntryID(entryID); err != nil {
		return zero, nil, err
	}
	if len(vk) != VKBytes {
		return zero, nil, fmt.Errorf("%w: entry VK must be %d bytes, got %d", ErrWrapInvalid, VKBytes, len(vk))
	}
	if !utf8.Valid(plaintext) {
		return zero, nil, fmt.Errorf("%w: entry plaintext must be valid UTF-8", ErrEnvelopeInvalid)
	}
	if len(plaintext) > EntryPlaintextMaxBytes {
		return zero, nil, fmt.Errorf("%w: entry plaintext exceeds %d bytes", ErrEnvelopeInvalid, EntryPlaintextMaxBytes)
	}

	var n []byte
	if nonce == nil {
		n = make([]byte, WrapNonceBytes)
		if _, err := rand.Read(n); err != nil {
			return zero, nil, fmt.Errorf("vault: read random entry nonce: %w", err)
		}
	} else {
		if len(nonce) != WrapNonceBytes {
			return zero, nil, fmt.Errorf("%w: entry nonce must be %d bytes, got %d", ErrEnvelopeInvalid, WrapNonceBytes, len(nonce))
		}
		n = nonce
	}

	env := EntryEnvelopeV1{
		V:     EnvelopeVersion,
		Alg:   EnvelopeAlg,
		KeyID: keyID,
		Nonce: EncodeBase64URL(n),
		CtEnc: EnvelopeCtEnc,
	}
	if err := ValidateEnvelopeStruct(env); err != nil {
		return zero, nil, err
	}

	aad, err := BuildEntryAAD(env, entryID)
	if err != nil {
		return zero, nil, err
	}

	aead, err := chacha20poly1305.NewX(vk)
	if err != nil {
		return zero, nil, fmt.Errorf("%w: %v", ErrWrapInvalid, err)
	}

	ciphertext := aead.Seal(nil, n, plaintext, aad)
	return env, ciphertext, nil
}

// OpenEntry kiểm tra nghiêm ngặt raw JSON của `envelope` (bao gồm phát hiện trùng khoá),
// chuẩn hoá bằng JCS, dựng AAD `sabk.entry.v1 || 0x00 || JCS(envelope) || 0x00 || entry_id`,
// giải mã `ciphertext` bằng XChaCha20-Poly1305 IETF và kiểm tra plaintext là UTF-8 hợp lệ.
func OpenEntry(rawEnvelopeJSON []byte, entryID string, ciphertext, vk []byte) (EntryEnvelopeV1, []byte, error) {
	var zero EntryEnvelopeV1
	if err := ValidateEntryID(entryID); err != nil {
		return zero, nil, err
	}
	if len(vk) != VKBytes {
		return zero, nil, fmt.Errorf("%w: entry VK must be %d bytes, got %d", ErrWrapInvalid, VKBytes, len(vk))
	}

	env, jcsBytes, err := CanonicalizeRawEnvelopeJCS(rawEnvelopeJSON)
	if err != nil {
		return zero, nil, err
	}

	nonceBytes, err := DecodeBase64URLStrict(env.Nonce, WrapNonceBytes)
	if err != nil {
		return zero, nil, fmt.Errorf("%w: %w", ErrEnvelopeInvalid, err)
	}

	if len(ciphertext) < WrapTagBytes || len(ciphertext) > EntryCiphertextMax {
		return zero, nil, fmt.Errorf("%w: invalid entry ciphertext length %d", ErrEnvelopeInvalid, len(ciphertext))
	}

	aad := make([]byte, 0, len(EnvelopeAADLabel)+1+len(jcsBytes)+1+len(entryID))
	aad = append(aad, EnvelopeAADLabel...)
	aad = append(aad, 0x00)
	aad = append(aad, jcsBytes...)
	aad = append(aad, 0x00)
	aad = append(aad, entryID...)

	aead, err := chacha20poly1305.NewX(vk)
	if err != nil {
		return zero, nil, fmt.Errorf("%w: %v", ErrWrapInvalid, err)
	}

	plaintext, err := aead.Open(nil, nonceBytes, ciphertext, aad)
	if err != nil {
		return zero, nil, fmt.Errorf("%w: entry AEAD decryption failed", ErrAEADDecryptFailed)
	}

	if len(plaintext) > EntryPlaintextMaxBytes {
		clear(plaintext)
		return zero, nil, fmt.Errorf("%w: decrypted entry plaintext exceeds %d bytes", ErrEnvelopeInvalid, EntryPlaintextMaxBytes)
	}
	if !utf8.Valid(plaintext) {
		clear(plaintext)
		return zero, nil, fmt.Errorf("%w: decrypted entry plaintext is not valid UTF-8", ErrEnvelopeInvalid)
	}

	return env, plaintext, nil
}

// OpenEntryBase64URL giải mã strict base64url cho `ciphertextB64` rồi gọi OpenEntry.
func OpenEntryBase64URL(rawEnvelopeJSON []byte, entryID, ciphertextB64 string, vk []byte) (EntryEnvelopeV1, []byte, error) {
	ctBytes, err := DecodeBase64URLStrict(ciphertextB64, 0)
	if err != nil {
		return EntryEnvelopeV1{}, nil, fmt.Errorf("%w: invalid ciphertext base64url: %w", ErrEnvelopeInvalid, err)
	}
	return OpenEntry(rawEnvelopeJSON, entryID, ctBytes, vk)
}

// rejectLoneUTF16SurrogateEscapes quét các chuỗi JSON để phát hiện escape `\uD800`..`\uDFFF`
// đứng lẻ (vì `encoding/json` của Go thay thế surrogate lẻ bằng U+FFFD thay vì báo lỗi).
func rejectLoneUTF16SurrogateEscapes(raw []byte) error {
	inString := false
	for i := 0; i < len(raw); i++ {
		b := raw[i]
		if !inString {
			if b == '"' {
				inString = true
			}
			continue
		}
		if b == '"' {
			inString = false
			continue
		}
		if b != '\\' {
			continue
		}
		i++
		if i >= len(raw) {
			return fmt.Errorf("%w: unterminated escape sequence in JSON", ErrEnvelopeInvalid)
		}
		if raw[i] != 'u' {
			continue
		}
		if i+4 >= len(raw) {
			return fmt.Errorf("%w: incomplete \\uXXXX escape in JSON", ErrEnvelopeInvalid)
		}
		u1, ok := parseHex4(raw[i+1 : i+5])
		if !ok {
			return fmt.Errorf("%w: invalid hex in \\uXXXX escape", ErrEnvelopeInvalid)
		}
		i += 4
		if u1 >= 0xdc00 && u1 <= 0xdfff {
			return fmt.Errorf("%w: lone low UTF-16 surrogate in JSON escape", ErrEnvelopeInvalid)
		}
		if u1 >= 0xd800 && u1 <= 0xdbff {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return fmt.Errorf("%w: high UTF-16 surrogate not followed by low surrogate in JSON escape", ErrEnvelopeInvalid)
			}
			u2, ok := parseHex4(raw[i+3 : i+7])
			if !ok || u2 < 0xdc00 || u2 > 0xdfff {
				return fmt.Errorf("%w: invalid low UTF-16 surrogate in JSON escape", ErrEnvelopeInvalid)
			}
			i += 6
		}
	}
	return nil
}

func parseHex4(b []byte) (uint16, bool) {
	if len(b) != 4 {
		return 0, false
	}
	var v uint16
	for _, c := range b {
		v <<= 4
		switch {
		case c >= '0' && c <= '9':
			v |= uint16(c - '0')
		case c >= 'a' && c <= 'f':
			v |= uint16(c - 'a' + 10)
		case c >= 'A' && c <= 'F':
			v |= uint16(c - 'A' + 10)
		default:
			return 0, false
		}
	}
	return v, true
}
