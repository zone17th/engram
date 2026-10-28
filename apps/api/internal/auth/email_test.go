package auth_test

import (
	"bytes"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
)

func TestNormalizeEmail(t *testing.T) {
	got, err := auth.NormalizeEmail("  User+tag@Example.com  ")
	if err != nil {
		t.Fatal(err)
	}
	if got != "User+tag@Example.com" {
		t.Fatalf("giữ +suffix và không lower: %q", got)
	}
	if _, err := auth.NormalizeEmail("not-an-email"); err == nil {
		t.Fatal("email xấu phải lỗi")
	}
	if _, err := auth.NormalizeEmail("Name <a@b.com>"); err == nil {
		t.Fatal("display name không phải một addr-spec")
	}
}

func TestHMACDomainSeparator(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	a := auth.HashEmailSubject(key, "A@Example.com")
	b := auth.HashEmailSubject(key, "a@example.com")
	if !bytes.Equal(a, b) {
		t.Fatal("subject HMAC phải case-insensitive")
	}
	ip := auth.HashIP(key, "a@example.com")
	if bytes.Equal(a, ip) {
		t.Fatal("domain separator phải tách IP và email")
	}
	if len(a) != 32 {
		t.Fatalf("HMAC length = %d", len(a))
	}
}
