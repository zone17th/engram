package embedding

import (
	"crypto/sha256"
	"strings"

	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
)

// ItemInput builds the v1 document embedding input text for an item from its
// plaintext name and optional hint (plan P05 mục 2.14, SPEC §6.6):
//
//	strings.TrimSpace(name) + (" — " + strings.TrimSpace(hint) when non-empty after trim)
//
// Both name and hint are trimmed with strings.TrimSpace so whitespace-only
// hints are omitted and surrounding whitespace on hints is not embedded.
// ItemInput never reads or accepts entry body, entry_count, tags, or
// name_normalized.
func ItemInput(name, hint string) string {
	trimmedName := strings.TrimSpace(name)
	trimmedHint := strings.TrimSpace(hint)
	if trimmedHint == "" {
		return trimmedName
	}
	return trimmedName + " — " + trimmedHint
}

// TagInput returns the v1 document embedding input text for a tag from its
// display name (plan P05 mục 2.14, SPEC §6.6). It uses display verbatim (not
// tag.normalized).
func TagInput(display string) string {
	return display
}

// InputHash computes the 32-byte SHA-256 digest of the UTF-8 RFC 8785 JSON
// Canonicalization Scheme (JCS) representation of:
//
//	{"input":input,"input_prefix":inputPrefix,"model":model,"model_version":modelVersion}
//
// In JCS (RFC 8785 §3.2.3), object member names are sorted lexicographically by
// UTF-16 code units: "input" < "input_prefix" < "model" < "model_version".
// Unlike Go's encoding/json, JCS does NOT escape '<', '>', '&', U+2028, or
// U+2029; it escapes only '"' (0x22), '\\' (0x5C), and control characters
// U+0000..U+001F (using \b, \t, \n, \f, \r, or lowercase \u00xx).
func InputHash(input, inputPrefix, model, modelVersion string) [32]byte {
	jcs := encodeInputHashJCS(input, inputPrefix, model, modelVersion)
	return sha256.Sum256([]byte(jcs))
}

// InputHashFor computes InputHash for input under the given generation/client
// identity using id.DocPrefix, id.Model, and id.ModelVersion (plan P05 mục
// 2.14, SPEC §6.6).
func InputHashFor(id embedid.Identity, input string) [32]byte {
	return InputHash(input, id.DocPrefix, id.Model, id.ModelVersion)
}

func encodeInputHashJCS(input, inputPrefix, model, modelVersion string) string {
	var b strings.Builder
	b.Grow(len(input) + len(inputPrefix) + len(model) + len(modelVersion) + 80)
	b.WriteString(`{"input":`)
	writeJCSString(&b, input)
	b.WriteString(`,"input_prefix":`)
	writeJCSString(&b, inputPrefix)
	b.WriteString(`,"model":`)
	writeJCSString(&b, model)
	b.WriteString(`,"model_version":`)
	writeJCSString(&b, modelVersion)
	b.WriteByte('}')
	return b.String()
}

const lowerHex = "0123456789abcdef"

// writeJCSString appends s to b as a RFC 8785 §3.2.2.2 JCS JSON string literal
// (surrounded by double quotes).
func writeJCSString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for i := range len(s) {
		c := s[i]
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if c < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte(lowerHex[c>>4])
				b.WriteByte(lowerHex[c&0x0f])
			} else {
				b.WriteByte(c)
			}
		}
	}
	b.WriteByte('"')
}
