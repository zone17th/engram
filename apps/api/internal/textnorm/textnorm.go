// Package textnorm implements name, tag, hint, and search query normalization
// and validation per P04 plan mục 2.2, 2.3 and SPEC §2.4, §8, §9.2.
//
// It is a pure leaf package with no dependency on httpx or database layers.
// Callers map ErrNameInvalid, ErrTagDisplayInvalid, and ErrHintInvalid to the
// corresponding RFC 9457 problem codes ("name_invalid", "tag_display_invalid",
// "hint_invalid").
//
// Whitespace vs. C0/C1 control characters (reading of plan mục 2.2 step 1 & SPEC §2.4):
//   - Step 1 rejects invalid UTF-8, all C0/C1 control characters (U+0000–U+001F,
//     U+007F–U+009F) EXCEPT ASCII space U+0020 ("ký tự điều khiển C0/C1 (trừ space)"),
//     and bidi override/isolate code points (U+202A–U+202E, U+2066–U+2069).
//     Consequently, U+0009 (TAB), U+000A (LF), U+000B (VT), U+000C (FF), U+000D (CR),
//     and U+0085 (NEL) are rejected in step 1 as C0/C1 controls (the "tab" case in
//     packages/content-fixtures/normalize.json is a negative/error fixture case).
//   - Step 2 collapses every run of Unicode White_Space (unicode.IsSpace, which after
//     step 1 comprises U+0020 plus non-control Unicode spaces: NBSP U+00A0, Ogham space
//     mark U+1680, En/Em/Thin/Hair spaces U+2000–U+200A, Line/Paragraph separators
//     U+2028–U+2029, Narrow No-Break Space U+202F, Medium Mathematical Space U+205F,
//     and Ideographic Space U+3000) to a single U+0020 space and trims both ends.
//   - Hint validation (ValidateHint) performs the same step 1 forbidden-character check
//     (invalid UTF-8, C0/C1 except U+0020, bidi overrides/isolates -> ErrHintInvalid)
//     and trims leading/trailing Unicode White_Space without lowercasing or stripping
//     punctuation, enforcing 0–120 runes on the trimmed result.
package textnorm

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Rune length bounds (plan mục 2.3, SPEC §2.4 / §8 / §9.2).
const (
	NameMinRunes = 1
	NameMaxRunes = 200

	TagMinRunes = 1
	TagMaxRunes = 50

	HintMaxRunes = 120

	QueryMaxRunes    = 200
	TagQueryMaxRunes = 50
)

// Error is a typed sentinel error returned by textnorm functions.
// Error() returns the exact RFC 9457 ProblemCode string ("name_invalid",
// "tag_display_invalid", or "hint_invalid") and never embeds user input.
type Error struct {
	Code string
}

func (e *Error) Error() string { return e.Code }

// Is supports shallow, nil-safe errors.Is comparisons against sentinel errors
// in this package.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && e != nil && t != nil && e.Code == t.Code
}

var (
	// ErrNameInvalid maps to HTTP 400 "name_invalid".
	ErrNameInvalid = &Error{Code: "name_invalid"}
	// ErrTagDisplayInvalid maps to HTTP 400 "tag_display_invalid".
	ErrTagDisplayInvalid = &Error{Code: "tag_display_invalid"}
	// ErrHintInvalid maps to HTTP 400 "hint_invalid".
	ErrHintInvalid = &Error{Code: "hint_invalid"}
)

// AsError extracts a *Error from err if present.
func AsError(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// Normalize normalizes a raw name or tag string according to plan mục 2.2 steps 1–3:
//  1. Reject invalid UTF-8, C0/C1 control characters (U+0000–U+001F, U+007F–U+009F)
//     except U+0020 space, bidi overrides/isolates (U+202A–U+202E, U+2066–U+2069),
//     or strings that are empty after trimming Unicode White_Space.
//  2. Apply Unicode NFC -> per-rune unicode.ToLower (without locale-specific special
//     casing) -> Unicode NFC again (advisor-dec-125) -> collapse every contiguous
//     run of Unicode White_Space (unicode.IsSpace) to a single ASCII space U+0020 ->
//     trim leading/trailing space -> strip leading and trailing punctuation runes
//     (Unicode category P*, unicode.IsPunct) repeatedly until neither end is P*
//     (also trimming any space exposed by stripping outer P*).
//     Vietnamese diacritics are preserved (`mã` != `ma`).
//  3. If the resulting string is empty (e.g. `"!!!"`), reject with ErrNameInvalid.
//
// Normalize does not enforce a maximum rune count; use NormalizeName, NormalizeTag,
// NormalizeLookupName, or NormalizeQuery (or NormalizeTagQuery) when validating
// field-specific rune limits and error codes.
func Normalize(s string) (string, error) {
	_, normStr, err := normalizeAndTrim(s, ErrNameInvalid)
	if err != nil {
		return "", err
	}
	return normStr, nil
}

// NormalizeName validates and normalizes an item name (plan mục 2.2, 2.3):
//   - Step 1–3 normalization via Normalize.
//   - Both the trimmed original display string and the normalized string must have
//     between 1 and 200 runes (NameMinRunes..NameMaxRunes).
//   - Returns (trimmedDisplay, normalized, nil) or ("", "", ErrNameInvalid).
func NormalizeName(s string) (trimmed string, normalized string, err error) {
	trimmed, normalized, err = normalizeAndTrim(s, ErrNameInvalid)
	if err != nil {
		return "", "", err
	}
	if !runeCountBetween(trimmed, NameMinRunes, NameMaxRunes) ||
		!runeCountBetween(normalized, NameMinRunes, NameMaxRunes) {
		return "", "", ErrNameInvalid
	}
	return trimmed, normalized, nil
}

// NormalizeLookupName validates and normalizes the `name` query parameter for
// exact lookup `GET /items/lookup?name=` (plan mục 2.3, 2.7):
//   - Enforces the same rules and 1–200 rune limits (on both trimmed input and
//     normalized output) as NormalizeName.
//   - Returns (normalized, nil) or ("", ErrNameInvalid).
func NormalizeLookupName(s string) (string, error) {
	_, normalized, err := NormalizeName(s)
	if err != nil {
		return "", err
	}
	return normalized, nil
}

// NormalizeTag validates and normalizes a tag display string (plan mục 2.2, 2.3):
//   - Step 1–3 normalization, mapping failures to ErrTagDisplayInvalid.
//   - Both the trimmed original display string and the normalized string must have
//     between 1 and 50 runes (TagMinRunes..TagMaxRunes).
//   - Returns (trimmedDisplay, normalized, nil) or ("", "", ErrTagDisplayInvalid).
func NormalizeTag(s string) (trimmed string, normalized string, err error) {
	trimmed, normalized, err = normalizeAndTrim(s, ErrTagDisplayInvalid)
	if err != nil {
		return "", "", err
	}
	if !runeCountBetween(trimmed, TagMinRunes, TagMaxRunes) ||
		!runeCountBetween(normalized, TagMinRunes, TagMaxRunes) {
		return "", "", ErrTagDisplayInvalid
	}
	return trimmed, normalized, nil
}

// ValidateHint validates an item hint (plan mục 2.3):
//   - Hint is NOT normalized (case, internal whitespace, and punctuation are kept),
//     but receives the step 1 forbidden-character check (invalid UTF-8, C0/C1 controls
//     except U+0020, bidi overrides/isolates U+202A–U+202E and U+2066–U+2069).
//   - Leading and trailing Unicode White_Space (unicode.IsSpace) are trimmed.
//   - The trimmed result must have 0..120 runes (HintMaxRunes).
//   - Returns (trimmedHint, nil) or ("", ErrHintInvalid).
func ValidateHint(s string) (string, error) {
	if !utf8.ValidString(s) || hasForbiddenRune(s) {
		return "", ErrHintInvalid
	}
	trimmed := strings.TrimFunc(s, unicode.IsSpace)
	if utf8.RuneCountInString(trimmed) > HintMaxRunes {
		return "", ErrHintInvalid
	}
	return trimmed, nil
}

// NormalizeQuery validates and normalizes the optional `q` prefix filter for
// `GET /items?q=` (plan mục 2.2, 2.3, 2.7):
//   - Rejects invalid UTF-8, C0/C1 controls except U+0020, and bidi overrides/isolates
//     with ErrNameInvalid.
//   - If empty after trimming Unicode White_Space, returns ("", nil) (no filter).
//   - Trimmed rune count must be <= 200 (QueryMaxRunes).
//   - Normalizes via steps 2–3; if normalization produces an empty string (e.g. `"!!!"`)
//     or > 200 runes, returns ErrNameInvalid.
func NormalizeQuery(q string) (string, error) {
	return normalizeOptionalQuery(q, QueryMaxRunes, ErrNameInvalid)
}

// NormalizeTagQuery validates and normalizes the optional `q` prefix filter for
// `GET /tags?q=` (plan mục 2.7, 3: "`q` prefix trên `normalized`, ≤ 50 rune"):
//   - Rejects invalid UTF-8, C0/C1 controls except U+0020, and bidi overrides/isolates
//     with ErrNameInvalid (or caller error mapping).
//   - If empty after trimming Unicode White_Space, returns ("", nil) (no filter).
//   - Trimmed rune count and normalized rune count must be <= 50 (TagQueryMaxRunes)
//     and non-empty after normalization.
func NormalizeTagQuery(q string) (string, error) {
	return normalizeOptionalQuery(q, TagQueryMaxRunes, ErrNameInvalid)
}

func normalizeOptionalQuery(q string, maxRunes int, invalidErr error) (string, error) {
	if !utf8.ValidString(q) || hasForbiddenRune(q) {
		return "", invalidErr
	}
	trimmed := strings.TrimFunc(q, unicode.IsSpace)
	if trimmed == "" {
		return "", nil
	}
	if utf8.RuneCountInString(trimmed) > maxRunes {
		return "", invalidErr
	}
	normalized := normalizeStep2(trimmed)
	if normalized == "" || utf8.RuneCountInString(normalized) > maxRunes {
		return "", invalidErr
	}
	return normalized, nil
}

func normalizeAndTrim(s string, invalidErr error) (trimmed string, normalized string, err error) {
	if !utf8.ValidString(s) || hasForbiddenRune(s) {
		return "", "", invalidErr
	}
	trimmed = strings.TrimFunc(s, unicode.IsSpace)
	if trimmed == "" {
		return "", "", invalidErr
	}
	normalized = normalizeStep2(trimmed)
	if normalized == "" {
		return "", "", invalidErr
	}
	return trimmed, normalized, nil
}

// normalizeStep2 executes plan mục 2.2 step 2 on a valid UTF-8 string that has
// already passed step 1 (advisor-dec-125):
// NFC -> per-rune unicode.ToLower -> NFC again -> collapse White_Space runs to
// ' ' -> trim -> repeatedly strip leading/trailing P* (and any newly exposed
// edge spaces).
func normalizeStep2(s string) string {
	nfc := norm.NFC.String(s)

	var lowered strings.Builder
	lowered.Grow(len(nfc))
	for _, r := range nfc {
		lowered.WriteRune(unicode.ToLower(r))
	}
	nfc = norm.NFC.String(lowered.String())

	var b strings.Builder
	b.Grow(len(nfc))
	inSpace := false
	for _, r := range nfc {
		if unicode.IsSpace(r) {
			if b.Len() > 0 {
				inSpace = true
			}
			continue
		}
		if inSpace {
			b.WriteByte(' ')
			inSpace = false
		}
		b.WriteRune(r)
	}
	res := b.String()
	// Strip category P* (unicode.IsPunct) at both ends repeatedly, also trimming
	// any ASCII spaces exposed when outer punctuation was separated by whitespace
	// (e.g. `"! foo !"` -> `"foo"`).
	for res != "" {
		before := res
		res = strings.TrimFunc(res, unicode.IsPunct)
		res = strings.TrimPrefix(res, " ")
		res = strings.TrimSuffix(res, " ")
		if res == before {
			break
		}
	}
	return res
}

// hasForbiddenRune checks whether s contains any C0/C1 control character
// (except U+0020 space) or any bidi override/isolate character
// (U+202A–U+202E, U+2066–U+2069).
func hasForbiddenRune(s string) bool {
	for _, r := range s {
		if isForbiddenRune(r) {
			return true
		}
	}
	return false
}

func isForbiddenRune(r rune) bool {
	if r == ' ' {
		return false
	}
	// C0 controls (U+0000–U+001F), DEL (U+007F), and C1 controls (U+0080–U+009F).
	if r <= 0x001F || (r >= 0x007F && r <= 0x009F) {
		return true
	}
	// Bidi overrides (LRE, RLE, PDF, LRO, RLO: U+202A–U+202E) and
	// bidi isolates (LRI, RLI, FSI, PDI: U+2066–U+2069).
	if (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069) {
		return true
	}
	return false
}

func runeCountBetween(s string, minRunes, maxRunes int) bool {
	n := utf8.RuneCountInString(s)
	return n >= minRunes && n <= maxRunes
}
