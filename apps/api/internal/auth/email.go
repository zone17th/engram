package auth

import (
	"net/mail"
	"strings"
	"unicode"
)

// NormalizeEmail trim khoảng trắng ngoài, kiểm một addr-spec.
// Không xoá dấu chấm hay +suffix. Trả địa chỉ đã parse (không display name).
func NormalizeEmail(raw string) (string, error) {
	trimmed := strings.TrimFunc(raw, unicode.IsSpace)
	if trimmed == "" {
		return "", ErrInvalidRequest
	}
	if strings.ContainsAny(trimmed, " \t\r\n") {
		return "", ErrInvalidRequest
	}
	addr, err := mail.ParseAddress(trimmed)
	if err != nil || addr.Address == "" {
		return "", ErrInvalidRequest
	}
	if addr.Name != "" {
		return "", ErrInvalidRequest
	}
	if !strings.EqualFold(trimmed, addr.Address) {
		return "", ErrInvalidRequest
	}
	return addr.Address, nil
}

// EmailSubject trả dạng chữ thường để HMAC throttle (citext-equivalent).
func EmailSubject(normalized string) string {
	return strings.ToLower(normalized)
}
