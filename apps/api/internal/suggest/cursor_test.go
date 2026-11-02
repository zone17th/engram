package suggest_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// TestCursorRoundTripPrecision verifies FU-SL-2 (follow-ups.md) and plan P05 mục 2.5, Task 4:
//   - The cursor round-trips non-integral float64 scores (e.g. 0.56, 0.89, 0.78, 0.35, 1.00)
//     and microsecond `last_used_at` timestamps in UTC (`RFC3339Nano`) with zero precision loss.
//   - Both `gen: null` (`Gen == nil`) and `gen: 1..9999` round-trip accurately.
//   - Both `scope=all|item` (`kind=item`) and `scope=tag` (`kind=tag`) round-trip accurately.
func TestCursorRoundTripPrecision(t *testing.T) {
	key, err := suggest.DeriveCursorKey([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("DeriveCursorKey: %v", err)
	}

	baseTime := time.Date(2026, 10, 20, 12, 34, 56, 0, time.UTC)
	scores := []float64{1.00, 0.89, 0.78, 0.67, 0.58, 0.56, 0.35, 0.00}
	microOffsets := []time.Duration{
		0,
		1 * time.Microsecond,
		7 * time.Microsecond,
		100 * time.Microsecond,
		500 * time.Microsecond,
		999_999 * time.Microsecond,
	}

	genOne := 1
	genMax := 9999
	gens := []*int{nil, &genOne, &genMax}

	scopes := []struct {
		scope string
		kind  string
	}{
		{suggest.ScopeAll, suggest.CorpusItem},
		{suggest.ScopeItem, suggest.CorpusItem},
		{suggest.ScopeTag, suggest.CorpusTag},
	}

	for _, sc := range scopes {
		for _, g := range gens {
			for _, tier := range []int32{3, 2, 1} {
				for _, score := range scores {
					for _, off := range microOffsets {
						ts := baseTime.Add(off)
						id := uuid.MustParse("00000000-0044-4000-8000-000000000099")
						inCur := suggest.SearchCursor{
							Scope:      sc.scope,
							Kind:       sc.kind,
							Gen:        g,
							Tier:       tier,
							Score:      score,
							LastUsedAt: ts,
							Count:      42,
							ID:         id,
						}

						encoded, err := suggest.EncodeCursor(key, "duongsat", inCur)
						if err != nil {
							t.Fatalf("EncodeCursor(%+v): %v", inCur, err)
						}
						if strings.Contains(encoded, "=") {
							t.Fatalf("cursor must use unpadded base64url, got %q", encoded)
						}

						decoded, err := suggest.DecodeCursor(key, encoded, sc.scope, "duongsat")
						if err != nil {
							t.Fatalf("DecodeCursor(%+v): %v", inCur, err)
						}

						if decoded.Scope != inCur.Scope ||
							decoded.Kind != inCur.Kind ||
							decoded.Tier != inCur.Tier ||
							math.Float64bits(decoded.Score) != math.Float64bits(inCur.Score) ||
							!decoded.LastUsedAt.Equal(inCur.LastUsedAt) ||
							decoded.Count != inCur.Count ||
							decoded.ID != inCur.ID {
							t.Fatalf("round-trip mismatch:\ngot  %+v (score bits=%x, ts=%s)\nwant %+v (score bits=%x, ts=%s)",
								decoded, math.Float64bits(decoded.Score), decoded.LastUsedAt.Format(time.RFC3339Nano),
								inCur, math.Float64bits(inCur.Score), inCur.LastUsedAt.Format(time.RFC3339Nano))
						}
						if (decoded.Gen == nil) != (inCur.Gen == nil) || (decoded.Gen != nil && *decoded.Gen != *inCur.Gen) {
							t.Fatalf("Gen mismatch: got %v, want %v", decoded.Gen, inCur.Gen)
						}
					}
				}
			}
		}
	}
}

// TestCursorStrictDecodeRejectsMalformed verifies Deliverable 3:
// DecodeCursor strictly rejects bad base64url, padded base64, malformed JSON,
// trailing tokens, duplicate keys, unknown fields, missing fields, wrong `v`,
// wrong types, out-of-range values, non-UTC/sub-microsecond timestamps, nil UUID,
// and mismatched `scope`/`kind`/`qh` with `ErrInvalidRequest` and a static detail.
func TestCursorStrictDecodeRejectsMalformed(t *testing.T) {
	key, err := suggest.DeriveCursorKey([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("DeriveCursorKey: %v", err)
	}
	otherKey, err := suggest.DeriveCursorKey([]byte("fedcba9876543210fedcba9876543210"))
	if err != nil {
		t.Fatalf("DeriveCursorKey other: %v", err)
	}

	ts := time.Date(2026, 10, 20, 12, 0, 0, 500_000, time.UTC)
	validCur := suggest.SearchCursor{
		Scope:      suggest.ScopeAll,
		Kind:       suggest.CorpusItem,
		Gen:        nil,
		Tier:       2,
		Score:      0.56,
		LastUsedAt: ts,
		Count:      5,
		ID:         uuid.MustParse("00000000-0044-4000-8000-000000000010"),
	}
	validToken, err := suggest.EncodeCursor(key, "wifi", validCur)
	if err != nil {
		t.Fatalf("EncodeCursor valid: %v", err)
	}

	rawJSONBytes, err := base64.RawURLEncoding.DecodeString(validToken)
	if err != nil {
		t.Fatalf("decode validToken base64: %v", err)
	}

	b64 := func(s string) string {
		return base64.RawURLEncoding.EncodeToString([]byte(s))
	}

	mutateJSON := func(mutate func(m map[string]any)) string {
		var m map[string]any
		if err := json.Unmarshal(rawJSONBytes, &m); err != nil {
			t.Fatalf("unmarshal valid cursor JSON: %v", err)
		}
		mutate(m)
		out, err := json.Marshal(m)
		if err != nil {
			t.Fatalf("marshal mutated cursor JSON: %v", err)
		}
		return base64.RawURLEncoding.EncodeToString(out)
	}

	// Build a valid cursor padded with trailing JSON spaces to reach the exact 768-byte raw JSON
	// boundary that base64url-encodes to `suggest.MaxEncodedCursorBytes` (1024 bytes).
	maxDecodedBytes := (suggest.MaxEncodedCursorBytes * 3) / 4
	if len(rawJSONBytes) >= maxDecodedBytes {
		t.Fatalf("unexpected rawJSONBytes len %d >= %d", len(rawJSONBytes), maxDecodedBytes)
	}
	exactMaxToken := b64(string(rawJSONBytes) + strings.Repeat(" ", maxDecodedBytes-len(rawJSONBytes)))
	if len(exactMaxToken) != suggest.MaxEncodedCursorBytes {
		t.Fatalf("got exactMaxToken len %d, want %d", len(exactMaxToken), suggest.MaxEncodedCursorBytes)
	}
	if _, err := suggest.DecodeCursor(key, exactMaxToken, suggest.ScopeAll, "wifi"); err != nil {
		t.Fatalf("expected cursor of exact MaxEncodedCursorBytes (%d) to succeed, got: %v", suggest.MaxEncodedCursorBytes, err)
	}

	maxPlusOneToken := b64(string(rawJSONBytes) + strings.Repeat(" ", maxDecodedBytes-len(rawJSONBytes)+1))
	if len(maxPlusOneToken) <= suggest.MaxEncodedCursorBytes {
		t.Fatalf("expected maxPlusOneToken len > %d, got %d", suggest.MaxEncodedCursorBytes, len(maxPlusOneToken))
	}

	hugeWhitespaceToken := b64(string(rawJSONBytes) + strings.Repeat(" \t", 4096))

	manyUnknownMembersToken := mutateJSON(func(m map[string]any) {
		for i := range 64 {
			m[fmt.Sprintf("u%02d", i)] = i
		}
	})
	inLimitManyUnknownMembersToken := mutateJSON(func(m map[string]any) {
		for i := range 12 {
			m[fmt.Sprintf("u%d", i)] = 1
		}
	})
	if len(inLimitManyUnknownMembersToken) > suggest.MaxEncodedCursorBytes {
		t.Fatalf("expected inLimitManyUnknownMembersToken len <= %d, got %d", suggest.MaxEncodedCursorBytes, len(inLimitManyUnknownMembersToken))
	}

	badTokens := []struct {
		name  string
		token string
		scope string
		qn    string
	}{
		{"empty-token", "", suggest.ScopeAll, "wifi"},
		{"bad-base64-chars", "not!valid!base64!", suggest.ScopeAll, "wifi"},
		{"padded-base64", validToken + "=", suggest.ScopeAll, "wifi"},
		{"outer-token-cr", validToken[:12] + "\r" + validToken[12:], suggest.ScopeAll, "wifi"},
		{"outer-token-lf", validToken[:12] + "\n" + validToken[12:], suggest.ScopeAll, "wifi"},
		{"outer-token-trailing-lf", validToken + "\n", suggest.ScopeAll, "wifi"},
		{"not-json", b64("hello"), suggest.ScopeAll, "wifi"},
		{"json-array-root", b64("[]"), suggest.ScopeAll, "wifi"},
		{"trailing-json", b64(string(rawJSONBytes) + "{}"), suggest.ScopeAll, "wifi"},
		{"duplicate-key", b64(`{"v":1,"v":1,"scope":"all","kind":"item","gen":null,"qh":"AAAAAAAAAAAAAAAAAAAAAA","tier":2,"score":0.56,"last_used_at":"2026-10-20T12:00:00.0005Z","count":5,"id":"00000000-0044-4000-8000-000000000010"}`), suggest.ScopeAll, "wifi"},
		{"unknown-field", mutateJSON(func(m map[string]any) { m["extra"] = 1 }), suggest.ScopeAll, "wifi"},
		{"missing-field-count", mutateJSON(func(m map[string]any) { delete(m, "count") }), suggest.ScopeAll, "wifi"},
		{"wrong-v-2", mutateJSON(func(m map[string]any) { m["v"] = 2 }), suggest.ScopeAll, "wifi"},
		{"wrong-v-0", mutateJSON(func(m map[string]any) { m["v"] = 0 }), suggest.ScopeAll, "wifi"},
		{"v-float", mutateJSON(func(m map[string]any) { m["v"] = 1.5 }), suggest.ScopeAll, "wifi"},
		{"v-string", mutateJSON(func(m map[string]any) { m["v"] = "1" }), suggest.ScopeAll, "wifi"},
		{"wrong-scope", validToken, suggest.ScopeItem, "wifi"},
		{"wrong-scope-tag", validToken, suggest.ScopeTag, "wifi"},
		{"wrong-qn", validToken, suggest.ScopeAll, "wifii"},
		{"kind-mismatch-tag-on-all", mutateJSON(func(m map[string]any) { m["kind"] = "tag" }), suggest.ScopeAll, "wifi"},
		{"tampered-qh", mutateJSON(func(m map[string]any) { m["qh"] = "BBBBBBBBBBBBBBBBBBBBBB" }), suggest.ScopeAll, "wifi"},
		{"short-qh", mutateJSON(func(m map[string]any) { m["qh"] = "AAAA" }), suggest.ScopeAll, "wifi"},
		{"long-qh", mutateJSON(func(m map[string]any) { m["qh"] = strings.Repeat("A", suggest.CursorQueryHashEncodedLen+4) }), suggest.ScopeAll, "wifi"},
		{"qh-with-escaped-newline-inside-json", b64(strings.Replace(string(rawJSONBytes), `"qh":"`, `"qh":"\n`, 1)), suggest.ScopeAll, "wifi"},
		{"qh-with-escaped-newline-same-len", mutateJSON(func(m map[string]any) {
			qh := m["qh"].(string)
			m["qh"] = qh[:10] + "\n" + qh[11:]
		}), suggest.ScopeAll, "wifi"},
		{"over-max-encoded-cursor-len-by-one", exactMaxToken + "A", suggest.ScopeAll, "wifi"},
		{"over-max-encoded-cursor-valid-json", maxPlusOneToken, suggest.ScopeAll, "wifi"},
		{"huge-json-whitespace", hugeWhitespaceToken, suggest.ScopeAll, "wifi"},
		{"many-unknown-members-over-max", manyUnknownMembersToken, suggest.ScopeAll, "wifi"},
		{"many-unknown-members-in-limit", inLimitManyUnknownMembersToken, suggest.ScopeAll, "wifi"},
		{"gen-zero", mutateJSON(func(m map[string]any) { m["gen"] = 0 }), suggest.ScopeAll, "wifi"},
		{"gen-10000", mutateJSON(func(m map[string]any) { m["gen"] = 10000 }), suggest.ScopeAll, "wifi"},
		{"gen-string", mutateJSON(func(m map[string]any) { m["gen"] = "1" }), suggest.ScopeAll, "wifi"},
		{"tier-0", mutateJSON(func(m map[string]any) { m["tier"] = 0 }), suggest.ScopeAll, "wifi"},
		{"tier-4", mutateJSON(func(m map[string]any) { m["tier"] = 4 }), suggest.ScopeAll, "wifi"},
		{"score-negative", mutateJSON(func(m map[string]any) { m["score"] = -0.01 }), suggest.ScopeAll, "wifi"},
		{"score-gt-1", mutateJSON(func(m map[string]any) { m["score"] = 1.01 }), suggest.ScopeAll, "wifi"},
		{"score-string", mutateJSON(func(m map[string]any) { m["score"] = "0.56" }), suggest.ScopeAll, "wifi"},
		{"count-negative", mutateJSON(func(m map[string]any) { m["count"] = -1 }), suggest.ScopeAll, "wifi"},
		{"count-item-gt-200", mutateJSON(func(m map[string]any) { m["count"] = 201 }), suggest.ScopeAll, "wifi"},
		{"bad-last-used-at", mutateJSON(func(m map[string]any) { m["last_used_at"] = "not-a-timestamp" }), suggest.ScopeAll, "wifi"},
		{"sub-microsecond-last-used-at", mutateJSON(func(m map[string]any) { m["last_used_at"] = "2026-10-20T12:00:00.0000001Z" }), suggest.ScopeAll, "wifi"},
		{"nil-uuid", mutateJSON(func(m map[string]any) { m["id"] = uuid.Nil.String() }), suggest.ScopeAll, "wifi"},
		{"uppercase-uuid", mutateJSON(func(m map[string]any) { m["id"] = "00000000-0044-4000-8000-00000000001A" }), suggest.ScopeAll, "wifi"},
		{"nested-object-value", b64(`{"v":1,"scope":"all","kind":"item","gen":{},"qh":"AAAAAAAAAAAAAAAAAAAAAA","tier":2,"score":0.56,"last_used_at":"2026-10-20T12:00:00.0005Z","count":5,"id":"00000000-0044-4000-8000-000000000010"}`), suggest.ScopeAll, "wifi"},
	}

	for _, tc := range badTokens {
		t.Run(tc.name, func(t *testing.T) {
			_, err := suggest.DecodeCursor(key, tc.token, tc.scope, tc.qn)
			if err == nil {
				t.Fatalf("expected DecodeCursor to fail for %s, got nil", tc.name)
			}
			se, ok := suggest.AsError(err)
			if !ok || se.Code != "invalid_request" {
				t.Fatalf("got err = %v (se=%+v), want ErrInvalidRequest", err, se)
			}
			if strings.Contains(se.Detail, "wifi") || (tc.token != "" && strings.Contains(se.Detail, tc.token)) {
				t.Fatalf("error detail leaked query or cursor: %q", se.Detail)
			}
		})
	}

	// Cursor signed by key must be rejected when verified with otherKey.
	if _, err := suggest.DecodeCursor(otherKey, validToken, suggest.ScopeAll, "wifi"); err == nil {
		t.Fatal("expected cursor decoded with different k_cursor to fail")
	}
}
