package suggest

import (
	"crypto/hkdf"
	"crypto/sha256"
	"fmt"
)

// CursorKeyInfo is the HKDF info string for deriving the `/search` cursor HMAC key
// (SPEC §6.6, §9.2, plan P05 mục 2.5, Task 3).
const CursorKeyInfo = "engram/search-cursor/v1"

// CursorKeyLen is the length in bytes (32) of the derived HMAC-SHA256 cursor key.
const CursorKeyLen = 32

// DeriveCursorKey derives `k_cursor = HKDF-SHA256(ikm = authJWTSecret, info = "engram/search-cursor/v1")`
// using stdlib `crypto/hkdf` (Go 1.26+).
// Never log or expose the returned key bytes.
func DeriveCursorKey(authJWTSecret []byte) ([]byte, error) {
	if len(authJWTSecret) == 0 {
		return nil, fmt.Errorf("suggest: authJWTSecret rỗng khi dẫn xuất khoá cursor")
	}
	key, err := hkdf.Key(sha256.New, authJWTSecret, nil, CursorKeyInfo, CursorKeyLen)
	if err != nil {
		return nil, fmt.Errorf("suggest: hkdf cursor key: %w", err)
	}
	return key, nil
}
