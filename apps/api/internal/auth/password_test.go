package auth_test

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
)

func TestValidatePasswordBounds(t *testing.T) {
	if err := auth.ValidatePassword(strings.Repeat("a", 11)); err == nil {
		t.Fatal("11 rune phải yếu")
	}
	if err := auth.ValidatePassword(strings.Repeat("á", 12)); err != nil {
		t.Fatalf("12 unicode rune phải đạt: %v", err)
	}
	if err := auth.ValidatePassword(strings.Repeat("a", 1024)); err != nil {
		t.Fatalf("1024 byte ASCII phải đạt: %v", err)
	}
	if err := auth.ValidatePassword(strings.Repeat("a", 1025)); err == nil {
		t.Fatal("1025 byte phải bị chặn trước hash")
	}
	// 12 rune nhưng > 1024 byte
	big := strings.Repeat("🙂", 300) // 4 byte * 300 = 1200
	if utf8.RuneCountInString(big) < 12 {
		t.Fatal("fixture")
	}
	if err := auth.ValidatePassword(big); err == nil {
		t.Fatal("quá 1024 byte phải yếu dù đủ rune")
	}
}

func TestPasswordWhitespaceNotTrimmed(t *testing.T) {
	plain := "  password12  " // 14 rune gồm space
	hash, err := auth.HashPassword(plain)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := auth.VerifyPassword(hash, plain)
	if err != nil || !ok {
		t.Fatalf("phải khớp nguyên văn có space: ok=%v err=%v", ok, err)
	}
	ok, err = auth.VerifyPassword(hash, strings.TrimSpace(plain))
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("không được trim rồi vẫn khớp")
	}
}

func TestHashSaltDiffersAndVerify(t *testing.T) {
	plain := "correct-horse"
	a, err := auth.HashPassword(plain)
	if err != nil {
		t.Fatal(err)
	}
	b, err := auth.HashPassword(plain)
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("salt khác nhau thì hash phải khác")
	}
	ok, err := auth.VerifyPassword(a, plain)
	if err != nil || !ok {
		t.Fatal("đúng password phải khớp")
	}
	ok, err = auth.VerifyPassword(a, "wrong-password")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("sai password không được khớp")
	}
}

func TestMalformedHashRejectedWithoutPanic(t *testing.T) {
	cases := []string{
		"",
		"not-a-hash",
		"$argon2i$v=19$m=65536,t=3,p=1$YWFh$YmJi",
		"$argon2id$v=16$m=65536,t=3,p=1$YWFh$YmJi",
		"$argon2id$v=19$m=999999999,t=3,p=1$YWFhYWFhYWFhYWFh$YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJi",
	}
	for _, h := range cases {
		ok, err := auth.VerifyPassword(h, "correct-horse")
		if ok {
			t.Errorf("hash malformed không được khớp: %q", h)
		}
		if err == nil && h != "" {
			// decodePHC trả ErrInvalidRequest
			t.Errorf("hash malformed phải có error: %q", h)
		}
	}
}

func TestDummyHashSameShape(t *testing.T) {
	if auth.DummyHash == "" {
		t.Fatal("DummyHash phải sẵn")
	}
	ok, err := auth.VerifyPassword(auth.DummyHash, "dummy-password-for-timing")
	if err != nil || !ok {
		t.Fatal("dummy hash phải verify được với mật khẩu init")
	}
}
