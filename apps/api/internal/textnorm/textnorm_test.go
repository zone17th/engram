package textnorm

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

type normalizeFixtureSuite struct {
	Version     int                    `json:"version"`
	Schema      string                 `json:"schema"`
	Description string                 `json:"description"`
	Cases       []normalizeFixtureCase `json:"cases"`
}

type normalizeFixtureCase struct {
	Name       string  `json:"name"`
	Kind       string  `json:"kind"`
	Input      *string `json:"input,omitempty"`
	InputBytes *string `json:"input_bytes,omitempty"`
	Trimmed    *string `json:"trimmed,omitempty"`
	Normalized *string `json:"normalized,omitempty"`
	Error      *string `json:"error,omitempty"`
}

func loadNormalizeFixtureSuite(t *testing.T) normalizeFixtureSuite {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "packages", "content-fixtures", "normalize.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if len(raw) == 0 {
		t.Fatalf("fixture file %s is empty", path)
	}
	var suite normalizeFixtureSuite
	if err := json.Unmarshal(raw, &suite); err != nil {
		t.Fatalf("unmarshal %s: %v", path, err)
	}
	if suite.Version != 1 {
		t.Fatalf("unexpected fixture version %d (want 1)", suite.Version)
	}
	if len(suite.Cases) == 0 {
		t.Fatalf("fixture %s contains no cases", path)
	}
	return suite
}

func (c normalizeFixtureCase) resolveInput(t *testing.T) string {
	t.Helper()
	switch {
	case c.Input != nil && c.InputBytes != nil:
		t.Fatalf("case %q sets both input and input_bytes", c.Name)
	case c.Input != nil:
		return *c.Input
	case c.InputBytes != nil:
		b, err := hex.DecodeString(*c.InputBytes)
		if err != nil {
			t.Fatalf("case %q invalid input_bytes hex %q: %v", c.Name, *c.InputBytes, err)
		}
		return string(b)
	default:
		t.Fatalf("case %q sets neither input nor input_bytes", c.Name)
	}
	return ""
}

func TestNormalizeFixtures(t *testing.T) {
	suite := loadNormalizeFixtureSuite(t)
	seen := make(map[string]bool, len(suite.Cases))

	for _, tc := range suite.Cases {
		if tc.Name == "" {
			t.Fatalf("fixture case has empty name")
		}
		if seen[tc.Name] {
			t.Fatalf("duplicate fixture case name %q", tc.Name)
		}
		seen[tc.Name] = true

		t.Run(tc.Name, func(t *testing.T) {
			in := tc.resolveInput(t)

			switch tc.Kind {
			case "name":
				trimmed, norm, err := NormalizeName(in)
				if tc.Error != nil {
					if err == nil {
						t.Fatalf("NormalizeName(%q) = (%q, %q, nil), want error %q", in, trimmed, norm, *tc.Error)
					}
					if err.Error() != *tc.Error {
						t.Fatalf("NormalizeName(%q) error = %q, want %q", in, err.Error(), *tc.Error)
					}
					if !errors.Is(err, ErrNameInvalid) {
						t.Fatalf("NormalizeName(%q) error does not match ErrNameInvalid", in)
					}
					if _, lerr := NormalizeLookupName(in); !errors.Is(lerr, ErrNameInvalid) {
						t.Fatalf("NormalizeLookupName(%q) = %v, want ErrNameInvalid", in, lerr)
					}
					return
				}
				if err != nil {
					t.Fatalf("NormalizeName(%q) unexpected error: %v", in, err)
				}
				if tc.Normalized == nil {
					t.Fatalf("case %q missing expected normalized field", tc.Name)
				}
				if norm != *tc.Normalized {
					t.Fatalf("NormalizeName(%q) normalized = %q, want %q", in, norm, *tc.Normalized)
				}
				if tc.Trimmed != nil && trimmed != *tc.Trimmed {
					t.Fatalf("NormalizeName(%q) trimmed = %q, want %q", in, trimmed, *tc.Trimmed)
				}
				// Base Normalize and NormalizeLookupName must agree on valid names.
				baseNorm, err := Normalize(in)
				if err != nil || baseNorm != *tc.Normalized {
					t.Fatalf("Normalize(%q) = (%q, %v), want (%q, nil)", in, baseNorm, err, *tc.Normalized)
				}
				lookupNorm, err := NormalizeLookupName(in)
				if err != nil || lookupNorm != *tc.Normalized {
					t.Fatalf("NormalizeLookupName(%q) = (%q, %v), want (%q, nil)", in, lookupNorm, err, *tc.Normalized)
				}
				// Idempotency on accepted name.
				idem, err := Normalize(norm)
				if err != nil || idem != norm {
					t.Fatalf("idempotency failed: Normalize(%q) = (%q, %v)", norm, idem, err)
				}

			case "tag":
				trimmed, norm, err := NormalizeTag(in)
				if tc.Error != nil {
					if err == nil {
						t.Fatalf("NormalizeTag(%q) = (%q, %q, nil), want error %q", in, trimmed, norm, *tc.Error)
					}
					if err.Error() != *tc.Error {
						t.Fatalf("NormalizeTag(%q) error = %q, want %q", in, err.Error(), *tc.Error)
					}
					if !errors.Is(err, ErrTagDisplayInvalid) {
						t.Fatalf("NormalizeTag(%q) error does not match ErrTagDisplayInvalid", in)
					}
					return
				}
				if err != nil {
					t.Fatalf("NormalizeTag(%q) unexpected error: %v", in, err)
				}
				if tc.Normalized == nil {
					t.Fatalf("case %q missing expected normalized field", tc.Name)
				}
				if norm != *tc.Normalized {
					t.Fatalf("NormalizeTag(%q) normalized = %q, want %q", in, norm, *tc.Normalized)
				}
				if tc.Trimmed != nil && trimmed != *tc.Trimmed {
					t.Fatalf("NormalizeTag(%q) trimmed = %q, want %q", in, trimmed, *tc.Trimmed)
				}
				// Base Normalize must also produce the same normalized string.
				baseNorm, err := Normalize(in)
				if err != nil || baseNorm != *tc.Normalized {
					t.Fatalf("Normalize(%q) = (%q, %v), want (%q, nil)", in, baseNorm, err, *tc.Normalized)
				}
				// Idempotency on accepted tag.
				idem, err := Normalize(norm)
				if err != nil || idem != norm {
					t.Fatalf("idempotency failed: Normalize(%q) = (%q, %v)", norm, idem, err)
				}

			case "hint":
				trimmed, err := ValidateHint(in)
				if tc.Error != nil {
					if err == nil {
						t.Fatalf("ValidateHint(%q) = (%q, nil), want error %q", in, trimmed, *tc.Error)
					}
					if err.Error() != *tc.Error {
						t.Fatalf("ValidateHint(%q) error = %q, want %q", in, err.Error(), *tc.Error)
					}
					if !errors.Is(err, ErrHintInvalid) {
						t.Fatalf("ValidateHint(%q) error does not match ErrHintInvalid", in)
					}
					return
				}
				if err != nil {
					t.Fatalf("ValidateHint(%q) unexpected error: %v", in, err)
				}
				if tc.Trimmed == nil {
					t.Fatalf("case %q missing expected trimmed field", tc.Name)
				}
				if trimmed != *tc.Trimmed {
					t.Fatalf("ValidateHint(%q) = %q, want %q", in, trimmed, *tc.Trimmed)
				}

			case "query":
				norm, err := NormalizeQuery(in)
				if tc.Error != nil {
					if err == nil {
						t.Fatalf("NormalizeQuery(%q) = (%q, nil), want error %q", in, norm, *tc.Error)
					}
					if err.Error() != *tc.Error {
						t.Fatalf("NormalizeQuery(%q) error = %q, want %q", in, err.Error(), *tc.Error)
					}
					if !errors.Is(err, ErrNameInvalid) {
						t.Fatalf("NormalizeQuery(%q) error does not match ErrNameInvalid", in)
					}
					return
				}
				if err != nil {
					t.Fatalf("NormalizeQuery(%q) unexpected error: %v", in, err)
				}
				if tc.Normalized == nil {
					t.Fatalf("case %q missing expected normalized field", tc.Name)
				}
				if norm != *tc.Normalized {
					t.Fatalf("NormalizeQuery(%q) = %q, want %q", in, norm, *tc.Normalized)
				}

			default:
				t.Fatalf("unknown fixture case kind %q in case %q", tc.Kind, tc.Name)
			}
		})
	}
}

func TestNormalizeDirectUnits(t *testing.T) {
	t.Run("Vietnamese diacritics remain distinct", func(t *testing.T) {
		maTilde, err := Normalize("Mã")
		if err != nil {
			t.Fatalf("Normalize(Mã): %v", err)
		}
		maPlain, err := Normalize("Ma")
		if err != nil {
			t.Fatalf("Normalize(Ma): %v", err)
		}
		if maTilde == maPlain {
			t.Fatalf("expected Mã (%q) != Ma (%q)", maTilde, maPlain)
		}
		if maTilde != "mã" || maPlain != "ma" {
			t.Fatalf("got (%q, %q), want (\"mã\", \"ma\")", maTilde, maPlain)
		}
	})

	t.Run("all C0 and C1 controls except U+0020 rejected", func(t *testing.T) {
		for r := rune(0); r <= 0x009F; r++ {
			if r > 0x001F && r < 0x007F {
				continue
			}
			in := "a" + string(r) + "b"
			if _, err := Normalize(in); !errors.Is(err, ErrNameInvalid) {
				t.Fatalf("Normalize with rune U+%04X: got err=%v, want ErrNameInvalid", r, err)
			}
			if _, _, err := NormalizeTag(in); !errors.Is(err, ErrTagDisplayInvalid) {
				t.Fatalf("NormalizeTag with rune U+%04X: got err=%v, want ErrTagDisplayInvalid", r, err)
			}
			if _, err := ValidateHint(in); !errors.Is(err, ErrHintInvalid) {
				t.Fatalf("ValidateHint with rune U+%04X: got err=%v, want ErrHintInvalid", r, err)
			}
		}
	})

	t.Run("all bidi override and isolate code points rejected", func(t *testing.T) {
		bidiRunes := []rune{
			0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
			0x2066, 0x2067, 0x2068, 0x2069,
		}
		for _, r := range bidiRunes {
			in := "item" + string(r) + "name"
			if _, err := Normalize(in); !errors.Is(err, ErrNameInvalid) {
				t.Fatalf("Normalize with bidi U+%04X: got err=%v, want ErrNameInvalid", r, err)
			}
			if _, _, err := NormalizeTag(in); !errors.Is(err, ErrTagDisplayInvalid) {
				t.Fatalf("NormalizeTag with bidi U+%04X: got err=%v, want ErrTagDisplayInvalid", r, err)
			}
			if _, err := ValidateHint(in); !errors.Is(err, ErrHintInvalid) {
				t.Fatalf("ValidateHint with bidi U+%04X: got err=%v, want ErrHintInvalid", r, err)
			}
		}
	})

	t.Run("NormalizeTagQuery enforces 50 rune limit", func(t *testing.T) {
		if q, err := NormalizeTagQuery("   "); err != nil || q != "" {
			t.Fatalf("empty tag query = (%q, %v), want (\"\", nil)", q, err)
		}
		q50 := strings.Repeat("t", 50)
		if got, err := NormalizeTagQuery(q50); err != nil || got != q50 {
			t.Fatalf("50-rune tag query = (%q, %v), want (%q, nil)", got, err, q50)
		}
		q51 := strings.Repeat("t", 51)
		if _, err := NormalizeTagQuery(q51); !errors.Is(err, ErrNameInvalid) {
			t.Fatalf("51-rune tag query err = %v, want ErrNameInvalid", err)
		}
	})

	t.Run("AsError and Error.Is semantics", func(t *testing.T) {
		_, _, err := NormalizeName("")
		te, ok := AsError(err)
		if !ok || te.Code != "name_invalid" {
			t.Fatalf("AsError(%v) = (%v, %v), want code name_invalid", err, te, ok)
		}
		if errors.Is(err, ErrTagDisplayInvalid) || errors.Is(err, errors.New("other")) {
			t.Fatalf("unexpected errors.Is match for %v", err)
		}
		if _, ok := AsError(errors.New("plain")); ok {
			t.Fatalf("AsError should return false for non-textnorm error")
		}
	})
}

func FuzzNormalizeIdempotent(f *testing.F) {
	path := filepath.Join("..", "..", "..", "..", "packages", "content-fixtures", "normalize.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		f.Fatalf("read %s: %v", path, err)
	}
	var suite normalizeFixtureSuite
	if err := json.Unmarshal(raw, &suite); err != nil {
		f.Fatalf("unmarshal %s: %v", path, err)
	}
	if len(suite.Cases) == 0 {
		f.Fatalf("fixture %s contains no cases", path)
	}
	for _, tc := range suite.Cases {
		if tc.Input != nil {
			f.Add(*tc.Input)
		} else if tc.InputBytes != nil {
			if b, err := hex.DecodeString(*tc.InputBytes); err == nil {
				f.Add(string(b))
			}
		}
	}
	seeds := []string{
		"wifi",
		"  Wi-Fi   Nhà  ",
		"\"c++\"",
		"Ti\u0065\u0302\u0301ng Vi\u0065\u0323\u0302t",
		"\u0130STANBUL STRA\u1e9eE \u03a3\u039f\u03a6\u039f\u03a3",
		"...!@# wifi #@!...",
		"\U0001f510 Key",
		"!!!",
		"",
		"a\u00a0\u2003\u3000b",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, input string) {
		norm1, err := Normalize(input)
		if err != nil {
			if !errors.Is(err, ErrNameInvalid) {
				t.Fatalf("Normalize(%q) returned non-ErrNameInvalid error: %v", input, err)
			}
			return
		}
		if norm1 == "" {
			t.Fatalf("Normalize(%q) succeeded with empty string", input)
		}
		if !utf8.ValidString(norm1) {
			t.Fatalf("Normalize(%q) produced invalid UTF-8 %q", input, norm1)
		}
		// Idempotency property: Normalize(Normalize(x)) == Normalize(x).
		norm2, err := Normalize(norm1)
		if err != nil {
			t.Fatalf("Normalize(Normalize(%q)) failed on %q: %v", input, norm1, err)
		}
		if norm2 != norm1 {
			t.Fatalf("not idempotent for %q: first=%q second=%q", input, norm1, norm2)
		}
		// Normalized output invariants: no leading/trailing space or P*, no consecutive spaces,
		// no non-ASCII whitespace, no forbidden runes.
		firstRune, _ := utf8.DecodeRuneInString(norm1)
		lastRune, _ := utf8.DecodeLastRuneInString(norm1)
		if unicode.IsSpace(firstRune) || unicode.IsPunct(firstRune) {
			t.Fatalf("Normalize(%q) = %q has leading space/punct U+%04X", input, norm1, firstRune)
		}
		if unicode.IsSpace(lastRune) || unicode.IsPunct(lastRune) {
			t.Fatalf("Normalize(%q) = %q has trailing space/punct U+%04X", input, norm1, lastRune)
		}
		if strings.Contains(norm1, "  ") {
			t.Fatalf("Normalize(%q) = %q contains consecutive spaces", input, norm1)
		}
		for _, r := range norm1 {
			if isForbiddenRune(r) {
				t.Fatalf("Normalize(%q) = %q contains forbidden rune U+%04X", input, norm1, r)
			}
			if unicode.IsSpace(r) && r != ' ' {
				t.Fatalf("Normalize(%q) = %q contains non-ASCII whitespace U+%04X", input, norm1, r)
			}
		}
	})
}
