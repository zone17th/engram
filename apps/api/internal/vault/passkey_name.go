package vault

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Hằng số giới hạn độ dài tên passkey theo số lượng rune Unicode (plan mục 2.5, ADR 0003 §3).
const (
	PasskeyNameMinRunes = 1
	PasskeyNameMaxRunes = 64
)

// ValidatePasskeyName chuẩn hoá và kiểm tra tên passkey theo đúng quy tắc mục 2.5 và ADR 0003 §3
// (dùng chung cho cả `POST /vault/passkeys` và `PATCH /vault/passkeys/{id}`):
//   - Chuỗi phải là UTF-8 hợp lệ.
//   - Từ chối mọi ký tự điều khiển Unicode (`unicode.IsControl`, kể cả ở đầu/cuối chuỗi)
//     và mọi ký tự điều hướng hai chiều (bidi override / isolate / mark:
//     U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C).
//   - Chuẩn hoá bằng `strings.TrimSpace`.
//   - Độ dài sau khi trim phải từ 1 đến 64 rune.
//   - Nếu vi phạm bất kỳ điều kiện nào, trả `ErrPasskeyNameInvalid` (`400 passkey_name_invalid`).
func ValidatePasskeyName(raw string) (string, error) {
	if !utf8.ValidString(raw) {
		return "", ErrPasskeyNameInvalid
	}
	for _, r := range raw {
		if unicode.IsControl(r) || isBidiOverrideOrControl(r) {
			return "", ErrPasskeyNameInvalid
		}
	}
	trimmed := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(trimmed)
	if n < PasskeyNameMinRunes || n > PasskeyNameMaxRunes {
		return "", ErrPasskeyNameInvalid
	}
	for _, r := range trimmed {
		if unicode.IsControl(r) || isBidiOverrideOrControl(r) {
			return "", ErrPasskeyNameInvalid
		}
	}
	return trimmed, nil
}

func isBidiOverrideOrControl(r rune) bool {
	switch {
	case r >= 0x202A && r <= 0x202E: // LRE, RLE, PDF, LRO, RLO
		return true
	case r >= 0x2066 && r <= 0x2069: // LRI, RLI, FSI, PDI
		return true
	case r == 0x200E || r == 0x200F: // LRM, RLM
		return true
	case r == 0x061C: // ALM (Arabic Letter Mark)
		return true
	default:
		return false
	}
}
