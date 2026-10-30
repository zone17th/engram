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
	"strings"
	"unicode/utf8"
)

// Hằng số cho KDF Argon2id, vault_key_id, public key và recovery key (ADR 0002 §3, §4, §7, plan mục 2.1, 2.2).
const (
	KDFAlg             = "argon2id13"
	KDFOpsMin          = 3
	KDFOpsMax          = 10
	KDFMemMin          = 67_108_864  // 64 MiB
	KDFMemMax          = 268_435_456 // 256 MiB
	KDFParallelism     = 1
	KDFSaltBytes       = 16
	VaultKeyIDRandLen  = 16
	PublicKey32Bytes   = 32
	RecoveryKeySlots   = 10
	RecoveryKeySlotMin = 1
	RecoveryKeySlotMax = 10
)

var vaultKeyIDFormatRegex = regexp.MustCompile(`^vk:[A-Za-z0-9_-]{22}$`)

// KDFParams biểu diễn object `vault.kdf` gồm đúng 5 trường bắt buộc (ADR 0002 §4, plan mục 2.1).
type KDFParams struct {
	Alg         string `json:"alg"`
	Ops         int    `json:"ops"`
	Mem         int    `json:"mem"`
	Parallelism int    `json:"parallelism"`
	Salt        string `json:"salt"`
}

// GenerateVaultKeyID sinh định danh khoá vault từ 16 byte CSPRNG: `"vk:" + base64url(16B)`
// (25 ký tự ASCII, khớp `^vk:[A-Za-z0-9_-]{22}$`, plan mục 2.1, ADR 0002 §3).
func GenerateVaultKeyID() (string, error) {
	var raw [VaultKeyIDRandLen]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("vault: generate vault_key_id: %w", err)
	}
	id := "vk:" + EncodeBase64URL(raw[:])
	if !ValidateVaultKeyID(id) {
		return "", errors.New("vault: generated vault_key_id failed format check")
	}
	return id, nil
}

// ValidateVaultKeyID kiểm tra chuỗi khớp chính xác `^vk:[A-Za-z0-9_-]{22}$`
// và giải mã strict base64url phần sau `vk:` ra đúng 16 byte.
func ValidateVaultKeyID(id string) bool {
	if !vaultKeyIDFormatRegex.MatchString(id) {
		return false
	}
	_, err := DecodeBase64URLStrict(id[3:], VaultKeyIDRandLen)
	return err == nil
}

// ValidatePublicKey32Base64URL giải mã strict base64url không padding và kiểm tra
// độ dài đúng 32 byte cho `x25519_public` hoặc `ed25519_public` (plan mục 2.1, Task 8).
// Khi vi phạm trả `ErrVaultWrapInvalid` (hoặc `ErrInvalidRequest` nếu rỗng/sai kiểu).
func ValidatePublicKey32Base64URL(encoded string) ([]byte, error) {
	raw, err := DecodeBase64URLStrict(encoded, PublicKey32Bytes)
	if err != nil {
		return nil, ErrVaultWrapInvalid
	}
	return raw, nil
}

// ValidateLookupHashBase64URL giải mã strict base64url không padding và kiểm tra
// độ dài đúng 32 byte cho `lookup_hash` của recovery key (`RKHashBytes = 32`).
func ValidateLookupHashBase64URL(encoded string) ([]byte, error) {
	raw, err := DecodeBase64URLStrict(encoded, RKHashBytes)
	if err != nil {
		return nil, ErrInvalidRequest
	}
	return raw, nil
}

// ValidateKDFParamsRawJSON kiểm tra nghiêm ngặt raw JSON của `vault.kdf` (ADR 0002 §4, plan mục 2.1):
//   - Chuỗi UTF-8 hợp lệ, không chứa surrogate lẻ (`\uD800`..`\uDFFF` không ghép cặp).
//   - Quét token bằng `json.Decoder.Token()` (với `UseNumber()`) để từ chối khoá trùng lặp,
//     trường thiếu, trường thừa hoặc kiểu không phải số nguyên JSON.
//   - `alg == "argon2id13"`, `3 <= ops <= 10`, `67108864 <= mem <= 268435456`, `parallelism == 1`.
//   - `salt` là chuỗi base64url không padding giải mã strict ra đúng 16 byte.
//
// Trả về `KDFParams` đã parse, mảng 16 byte `salt` đã giải mã và chuỗi JSON canonical để lưu DB.
// Mọi vi phạm trả `ErrVaultKDFInvalid`.
func ValidateKDFParamsRawJSON(rawJSON []byte) (KDFParams, []byte, []byte, error) {
	var zero KDFParams
	if len(bytes.TrimSpace(rawJSON)) == 0 || !utf8.Valid(rawJSON) {
		return zero, nil, nil, ErrVaultKDFInvalid
	}
	if err := rejectLoneUTF16SurrogateEscapes(rawJSON); err != nil {
		return zero, nil, nil, ErrVaultKDFInvalid
	}

	dec := json.NewDecoder(bytes.NewReader(rawJSON))
	dec.UseNumber()

	tok, err := dec.Token()
	if err != nil {
		return zero, nil, nil, ErrVaultKDFInvalid
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return zero, nil, nil, ErrVaultKDFInvalid
	}

	seen := make(map[string]struct{}, 5)
	var params KDFParams

	for dec.More() {
		kTok, err := dec.Token()
		if err != nil {
			return zero, nil, nil, ErrVaultKDFInvalid
		}
		key, ok := kTok.(string)
		if !ok {
			return zero, nil, nil, ErrVaultKDFInvalid
		}
		if _, dup := seen[key]; dup {
			return zero, nil, nil, ErrVaultKDFInvalid
		}
		seen[key] = struct{}{}

		vTok, err := dec.Token()
		if err != nil {
			return zero, nil, nil, ErrVaultKDFInvalid
		}
		if _, isDelim := vTok.(json.Delim); isDelim {
			return zero, nil, nil, ErrVaultKDFInvalid
		}

		switch key {
		case "alg":
			s, ok := vTok.(string)
			if !ok || s != KDFAlg {
				return zero, nil, nil, ErrVaultKDFInvalid
			}
			params.Alg = s
		case "ops":
			n, err := parseStrictIntToken(vTok)
			if err != nil || n < KDFOpsMin || n > KDFOpsMax {
				return zero, nil, nil, ErrVaultKDFInvalid
			}
			params.Ops = n
		case "mem":
			n, err := parseStrictIntToken(vTok)
			if err != nil || n < KDFMemMin || n > KDFMemMax {
				return zero, nil, nil, ErrVaultKDFInvalid
			}
			params.Mem = n
		case "parallelism":
			n, err := parseStrictIntToken(vTok)
			if err != nil || n != KDFParallelism {
				return zero, nil, nil, ErrVaultKDFInvalid
			}
			params.Parallelism = n
		case "salt":
			s, ok := vTok.(string)
			if !ok {
				return zero, nil, nil, ErrVaultKDFInvalid
			}
			params.Salt = s
		default:
			return zero, nil, nil, ErrVaultKDFInvalid
		}
	}

	endTok, err := dec.Token()
	if err != nil {
		return zero, nil, nil, ErrVaultKDFInvalid
	}
	if endDelim, ok := endTok.(json.Delim); !ok || endDelim != '}' {
		return zero, nil, nil, ErrVaultKDFInvalid
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return zero, nil, nil, ErrVaultKDFInvalid
	}
	if len(seen) != 5 {
		return zero, nil, nil, ErrVaultKDFInvalid
	}

	saltBytes, err := DecodeBase64URLStrict(params.Salt, KDFSaltBytes)
	if err != nil {
		return zero, nil, nil, ErrVaultKDFInvalid
	}

	normalizedJSON, err := json.Marshal(params)
	if err != nil {
		return zero, nil, nil, ErrVaultKDFInvalid
	}
	return params, saltBytes, normalizedJSON, nil
}

// ValidateKDFParamsForCreate kiểm tra `vault.kdf` khi tạo vault mới (`POST /vault`).
// Theo `advisor-dec-004` và ADR 0002 §4: tạo mới phải có tham số hợp lệ trong khoảng
// (`3 <= ops <= 10`, `64 MiB <= mem <= 256 MiB`, `parallelism = 1`, `alg = "argon2id13"`, salt 16 B).
func ValidateKDFParamsForCreate(rawJSON []byte) (KDFParams, []byte, []byte, error) {
	return ValidateKDFParamsRawJSON(rawJSON)
}

// ValidateKDFParamsForRewrap kiểm tra `newKDFRaw` đối chiếu với `currentKDFRaw` đang lưu trên bảng `vault`
// khi thực hiện rewrap (`PUT /vault/kek`) hoặc recover (`POST /vault/recover/complete`)
// (ADR 0002 §4–§5, `advisor-dec-004`, plan mục 2.1, Task 9, Task 10):
//   - Cả `newKDFRaw` và `currentKDFRaw` đều phải hợp lệ theo `ValidateKDFParamsRawJSON`.
//   - `new.salt` phải khác `current.salt` (so sánh trên 16 byte đã giải mã).
//   - Không hạ cấp tham số: `new.ops >= current.ops` và `new.mem >= current.mem`.
//
// Vi phạm bất kỳ điều kiện nào trả `ErrVaultKDFInvalid`.
func ValidateKDFParamsForRewrap(newKDFRaw, currentKDFRaw []byte) (KDFParams, []byte, error) {
	newParams, newSalt, normalizedJSON, err := ValidateKDFParamsRawJSON(newKDFRaw)
	if err != nil {
		return KDFParams{}, nil, ErrVaultKDFInvalid
	}
	curParams, curSalt, _, err := ValidateKDFParamsRawJSON(currentKDFRaw)
	if err != nil {
		return KDFParams{}, nil, ErrVaultKDFInvalid
	}
	if bytes.Equal(newSalt, curSalt) {
		return KDFParams{}, nil, ErrVaultKDFInvalid
	}
	if newParams.Ops < curParams.Ops || newParams.Mem < curParams.Mem {
		return KDFParams{}, nil, ErrVaultKDFInvalid
	}
	return newParams, normalizedJSON, nil
}

func parseStrictIntToken(tok any) (int, error) {
	num, ok := tok.(json.Number)
	if !ok {
		return 0, errors.New("not a number")
	}
	s := num.String()
	if strings.ContainsAny(s, ".eE") {
		return 0, errors.New("float or exponent not allowed")
	}
	return strconv.Atoi(s)
}
