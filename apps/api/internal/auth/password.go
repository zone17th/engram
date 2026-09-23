package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	PasswordMinRunes = 12
	PasswordMaxBytes = 1024

	argonTime    = 3
	argonMemory  = 64 * 1024 // KiB = 64 MiB
	argonThreads = 1
	argonKeyLen  = 32
	argonSaltLen = 16
	argonVersion = argon2.Version
	maxArgonMem  = 256 * 1024 // từ chối hash đòi > 256 MiB trước khi cấp phát
)

// DummyHash dùng cùng params, chuẩn bị lúc init cho login email vắng mặt.
var DummyHash string

func init() {
	h, err := HashPassword("dummy-password-for-timing")
	if err != nil {
		panic("không tạo được dummy password hash")
	}
	DummyHash = h
}

// HashPassword băm Argon2id theo policy P02. Không trim/normalize plain.
func HashPassword(plain string) (string, error) {
	if err := ValidatePassword(plain); err != nil {
		return "", err
	}
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("sinh salt: %w", err)
	}
	key := argon2.IDKey([]byte(plain), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return encodePHC(salt, key, argonTime, argonMemory, argonThreads), nil
}

// VerifyPassword so khớp; hash malformed trả false, error — không panic/OOM.
func VerifyPassword(encodedHash, plain string) (bool, error) {
	salt, key, timeCost, mem, threads, err := decodePHC(encodedHash)
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(plain), salt, timeCost, mem, threads, uint32(len(key)))
	if subtle.ConstantTimeCompare(got, key) == 1 {
		return true, nil
	}
	return false, nil
}

// ValidatePassword: ≥12 rune Unicode, ≤1024 byte UTF-8, không trim.
func ValidatePassword(plain string) error {
	if !utf8.ValidString(plain) {
		return ErrPasswordWeak
	}
	if len(plain) > PasswordMaxBytes {
		return ErrPasswordWeak
	}
	if utf8.RuneCountInString(plain) < PasswordMinRunes {
		return ErrPasswordWeak
	}
	return nil
}

func encodePHC(salt, key []byte, timeCost, mem uint32, threads uint8) string {
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argonVersion, mem, timeCost, threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	)
}

func decodePHC(encoded string) (salt, key []byte, timeCost, mem uint32, threads uint8, err error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return nil, nil, 0, 0, 0, ErrInvalidRequest
	}
	var version int
	if _, err = fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argonVersion {
		return nil, nil, 0, 0, 0, ErrInvalidRequest
	}
	if _, err = fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &timeCost, &threads); err != nil {
		return nil, nil, 0, 0, 0, ErrInvalidRequest
	}
	if mem == 0 || mem > maxArgonMem || timeCost == 0 || timeCost > 10 || threads == 0 || threads > 4 {
		return nil, nil, 0, 0, 0, ErrInvalidRequest
	}
	salt, err = base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) < 8 || len(salt) > 64 {
		return nil, nil, 0, 0, 0, ErrInvalidRequest
	}
	key, err = base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(key) < 16 || len(key) > 64 {
		return nil, nil, 0, 0, 0, ErrInvalidRequest
	}
	return salt, key, timeCost, mem, threads, nil
}
