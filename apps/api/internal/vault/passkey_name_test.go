package vault_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
)

func TestValidatePasskeyName(t *testing.T) {
	validCases := []struct {
		name string
		in   string
		want string
	}{
		{"simple ASCII", "YubiKey 5C NFC", "YubiKey 5C NFC"},
		{"trimmed spaces", "   Windows Hello Laptop   ", "Windows Hello Laptop"},
		{"single rune", "A", "A"},
		{"Vietnamese 64 runes", strings.Repeat("ă", 64), strings.Repeat("ă", 64)},
	}
	for _, tc := range validCases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := vault.ValidatePasskeyName(tc.in)
			if err != nil {
				t.Fatalf("ValidatePasskeyName(%q) unexpected error: %v", tc.in, err)
			}
			if got != tc.want {
				t.Fatalf("ValidatePasskeyName(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}

	invalidCases := []struct {
		name string
		in   string
	}{
		{"empty", ""},
		{"spaces only", "     "},
		{"65 ASCII runes", strings.Repeat("a", 65)},
		{"65 Vietnamese runes", strings.Repeat("đ", 65)},
		{"null byte", "Key\x00Name"},
		{"newline", "Key\nName"},
		{"tab", "Key\tName"},
		{"DEL control", "Key\x7fName"},
		{"C1 control U+0085", "Key\u0085Name"},
		{"bidi LRE U+202A", "Key\u202AName"},
		{"bidi RLE U+202B", "Key\u202BName"},
		{"bidi PDF U+202C", "Key\u202CName"},
		{"bidi LRO U+202D", "Key\u202DName"},
		{"bidi RLO U+202E", "Key\u202EName"},
		{"bidi LRI U+2066", "Key\u2066Name"},
		{"bidi RLI U+2067", "Key\u2067Name"},
		{"bidi FSI U+2068", "Key\u2068Name"},
		{"bidi PDI U+2069", "Key\u2069Name"},
		{"bidi LRM U+200E", "Key\u200EName"},
		{"bidi RLM U+200F", "Key\u200FName"},
		{"bidi ALM U+061C", "Key\u061CName"},
		{"invalid UTF-8", string([]byte{0xff, 0xfe, 'a'})},
	}
	for _, tc := range invalidCases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := vault.ValidatePasskeyName(tc.in)
			if !errors.Is(err, vault.ErrPasskeyNameInvalid) {
				t.Fatalf("ValidatePasskeyName(%q) err = %v, want ErrPasskeyNameInvalid", tc.in, err)
			}
		})
	}
}
