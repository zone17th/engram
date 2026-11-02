package suggest

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// CursorVersion is the schema version of the `/search` opaque keyset cursor (plan P05 mục 2.5, Task 4).
const CursorVersion = 1

// CursorQueryHashBytes is the truncated byte length (16 B = 128 bits) of
// `HMAC-SHA256(k_cursor, scope ‖ 0x00 ‖ qn)` stored in `qh` (SPEC §6.6, §9.2, plan P05 mục 2.5).
const CursorQueryHashBytes = 16

// CursorQueryHashEncodedLen is the canonical unpadded base64url character length of a
// 16-byte `qh` (`ceil(16 * 8 / 6) = 22` characters).
const CursorQueryHashEncodedLen = 22

// MaxEncodedCursorBytes is the upper bound on the byte length of an incoming base64url-encoded
// `/search` cursor accepted by `DecodeCursor` before allocating/decoding (RV-T4-BE-2).
//
// Largest legitimate canonical encoding produced by `EncodeCursor`:
//   - Compact JSON `{"v":1,"scope":"item","kind":"item","gen":9999,"qh":"<22 chars>","tier":3,"score":<up to 24 chars>,"last_used_at":"9999-12-31T23:59:59.999999Z","count":2147483647,"id":"<36 chars>"}`
//     is at most ~205–218 raw JSON bytes (~274–291 unpadded base64url bytes).
//   - Setting `MaxEncodedCursorBytes = 1024` (768 decoded JSON bytes) stays comfortably above
//     any valid cursor while bounding base64/JSON allocation before decoding.
const MaxEncodedCursorBytes = 1024

// SearchCursor holds the keyset pagination state for `GET /api/v1/search`
// (SPEC §6.6, §9.2, plan P05 mục 2.4, 2.5, BE-12, FU-SL-2, Task 4).
//
// Wire representation is base64url (no padding) of JSON:
//
//	{v, scope, kind, gen, qh, tier, score, last_used_at, count, id}
//
// Privacy & security invariants (user-dec-016, advisor-dec-243, plan P05 mục 2.7):
//   - Never contains raw `q` or normalized `qn`; query binding uses only the 16-byte
//     truncated `HMAC-SHA256(k_cursor, scope ‖ 0x00 ‖ qn)` (`qh`, base64url no padding),
//     compared in constant time.
//   - `Gen` records the embedding generation pinned on page 1 (`nil` when `generation: null`
//     on page 1, or `1..9999` when semantic ran on page 1); cursor pages never call
//     `NearSource` (they run lexical only with `semantic: false, semantic_reason: "request_lexical"`),
//     so `gen` is NOT validated against live server generation state on subsequent pages,
//     only structurally validated (`null` or integer `1..9999`) and preserved across pages.
//   - FU-SL-2 precision: `Score` round-trips as the exact `float64` returned by PostgreSQL
//     `round(...::numeric, 2)::float8`, and `LastUsedAt` round-trips as `RFC3339Nano` in UTC
//     preserving exact microsecond (`timestamptz`) precision so the keyset predicate neither
//     skips nor repeats boundary rows.
type SearchCursor struct {
	Scope      string
	Kind       string
	Gen        *int
	Tier       int32
	Score      float64
	LastUsedAt time.Time
	Count      int32
	ID         uuid.UUID
}

type cursorWire struct {
	V          int       `json:"v"`
	Scope      string    `json:"scope"`
	Kind       string    `json:"kind"`
	Gen        *int      `json:"gen"`
	QH         string    `json:"qh"`
	Tier       int32     `json:"tier"`
	Score      float64   `json:"score"`
	LastUsedAt string    `json:"last_used_at"`
	Count      int32     `json:"count"`
	ID         uuid.UUID `json:"id"`
}

var cursorRequiredKeys = []string{
	"count",
	"gen",
	"id",
	"kind",
	"last_used_at",
	"qh",
	"scope",
	"score",
	"tier",
	"v",
}

// ExpectedCursorKindForScope returns the required cursor `kind` for a `/search` `scope`
// (plan P05 mục 2.4, BE-12):
//   - `scope = "all"` or `"item"` -> `kind = "item"`
//   - `scope = "tag"` -> `kind = "tag"`
func ExpectedCursorKindForScope(scope string) (string, bool) {
	switch scope {
	case ScopeAll, ScopeItem:
		return CorpusItem, true
	case ScopeTag:
		return CorpusTag, true
	default:
		return "", false
	}
}

// ComputeCursorQueryHash computes the first 16 bytes of `HMAC-SHA256(cursorKey, scope ‖ 0x00 ‖ qn)`
// (SPEC §6.6, §9.2, plan P05 mục 2.5).
func ComputeCursorQueryHash(cursorKey []byte, scope string, qn string) ([]byte, error) {
	if len(cursorKey) == 0 {
		return nil, ErrInvalidRequest
	}
	mac := hmac.New(sha256.New, cursorKey)
	_, _ = mac.Write([]byte(scope))
	_, _ = mac.Write([]byte{0x00})
	_, _ = mac.Write([]byte(qn))
	sum := mac.Sum(nil)
	out := make([]byte, CursorQueryHashBytes)
	copy(out, sum[:CursorQueryHashBytes])
	return out, nil
}

// EncodeCursor encodes a `SearchCursor` bound to `(scope, qn)` with `cursorKey` into an
// opaque base64url (no padding) string.
func EncodeCursor(cursorKey []byte, qn string, cur SearchCursor) (string, error) {
	wantKind, ok := ExpectedCursorKindForScope(cur.Scope)
	if !ok || cur.Kind != wantKind {
		return "", ErrInvalidRequest
	}
	if cur.ID == uuid.Nil {
		return "", ErrInvalidRequest
	}
	if cur.Tier < 1 || cur.Tier > 3 {
		return "", ErrInvalidRequest
	}
	if math.IsNaN(cur.Score) || math.IsInf(cur.Score, 0) || cur.Score < 0 || cur.Score > 1 {
		return "", ErrInvalidRequest
	}
	if cur.Count < 0 {
		return "", ErrInvalidRequest
	}
	if cur.Gen != nil && (*cur.Gen < 1 || *cur.Gen > 9999) {
		return "", ErrInvalidRequest
	}

	qhBytes, err := ComputeCursorQueryHash(cursorKey, cur.Scope, qn)
	if err != nil {
		return "", err
	}

	// Preserve microsecond precision in UTC (PostgreSQL timestamptz resolution is 1 µs; FU-SL-2).
	tsUTC := cur.LastUsedAt.UTC().Truncate(time.Microsecond)
	wire := cursorWire{
		V:          CursorVersion,
		Scope:      cur.Scope,
		Kind:       cur.Kind,
		Gen:        cur.Gen,
		QH:         base64.RawURLEncoding.EncodeToString(qhBytes),
		Tier:       cur.Tier,
		Score:      cur.Score,
		LastUsedAt: tsUTC.Format(time.RFC3339Nano),
		Count:      cur.Count,
		ID:         cur.ID,
	}

	rawJSON, err := json.Marshal(wire)
	if err != nil {
		return "", ErrInvalidRequest
	}
	return base64.RawURLEncoding.EncodeToString(rawJSON), nil
}

// DecodeCursor strictly decodes and validates an opaque base64url cursor against
// `expectedScope`, `qn`, and `cursorKey`.
//
// Any structural error (bad base64url, padding characters, trailing bytes, unknown or
// missing JSON fields, duplicate keys, wrong types, wrong `v`, invalid `gen`/`tier`/`score`/
// `count`/`last_used_at`/`id`) or binding mismatch (`scope`, `kind` for `scope`, or `qh`
// HMAC mismatch) returns `ErrInvalidRequest` with a static detail that never echoes the
// cursor or query (SPEC §9.2, plan P05 mục 2.5, 2.7, Task 4).
func DecodeCursor(cursorKey []byte, raw string, expectedScope string, qn string) (SearchCursor, error) {
	if raw == "" || len(raw) > MaxEncodedCursorBytes || len(cursorKey) == 0 {
		return SearchCursor{}, ErrInvalidRequest
	}
	wantKind, ok := ExpectedCursorKindForScope(expectedScope)
	if !ok {
		return SearchCursor{}, ErrInvalidRequest
	}

	jsonBytes, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	if err != nil {
		return SearchCursor{}, ErrInvalidRequest
	}

	obj, err := decodeStrictCursorObject(jsonBytes)
	if err != nil {
		return SearchCursor{}, ErrInvalidRequest
	}

	// 1. v: integer == CursorVersion (1).
	vInt, err := parseCursorInt(obj["v"], CursorVersion, CursorVersion)
	if err != nil || int(vInt) != CursorVersion {
		return SearchCursor{}, ErrInvalidRequest
	}

	// 2. scope: string matching expectedScope.
	scopeStr, ok := obj["scope"].(string)
	if !ok || !ValidSuggestScope(scopeStr) || scopeStr != expectedScope {
		return SearchCursor{}, ErrInvalidRequest
	}

	// 3. kind: string matching the corpus paged by expectedScope ("item" for all/item, "tag" for tag).
	kindStr, ok := obj["kind"].(string)
	if !ok || kindStr != wantKind {
		return SearchCursor{}, ErrInvalidRequest
	}

	// 4. gen: null or integer in [1..9999].
	var genPtr *int
	if genRaw := obj["gen"]; genRaw != nil {
		g64, err := parseCursorInt(genRaw, 1, 9999)
		if err != nil {
			return SearchCursor{}, ErrInvalidRequest
		}
		g := int(g64)
		genPtr = &g
	}

	// 5. qh: base64url (no padding) of 16-byte truncated HMAC-SHA256(k_cursor, scope ‖ 0x00 ‖ qn).
	qhStr, ok := obj["qh"].(string)
	if !ok || len(qhStr) != CursorQueryHashEncodedLen {
		return SearchCursor{}, ErrInvalidRequest
	}
	gotQH, err := base64.RawURLEncoding.Strict().DecodeString(qhStr)
	if err != nil || len(gotQH) != CursorQueryHashBytes {
		return SearchCursor{}, ErrInvalidRequest
	}
	wantQH, err := ComputeCursorQueryHash(cursorKey, expectedScope, qn)
	if err != nil {
		return SearchCursor{}, ErrInvalidRequest
	}
	if subtle.ConstantTimeCompare(gotQH, wantQH) != 1 {
		return SearchCursor{}, ErrInvalidRequest
	}

	// 6. tier: integer in [1..3].
	tier64, err := parseCursorInt(obj["tier"], 1, 3)
	if err != nil {
		return SearchCursor{}, ErrInvalidRequest
	}

	// 7. score: finite float64 in [0..1].
	score, err := parseCursorFloat(obj["score"], 0.0, 1.0)
	if err != nil {
		return SearchCursor{}, ErrInvalidRequest
	}

	// 8. last_used_at: RFC3339Nano timestamp string; normalize to UTC microsecond precision.
	luStr, ok := obj["last_used_at"].(string)
	if !ok || luStr == "" {
		return SearchCursor{}, ErrInvalidRequest
	}
	luTime, err := time.Parse(time.RFC3339Nano, luStr)
	if err != nil {
		return SearchCursor{}, ErrInvalidRequest
	}
	luUTC := luTime.UTC()
	// Reject sub-microsecond nanoseconds that PostgreSQL timestamptz cannot represent.
	if luUTC.Nanosecond()%1000 != 0 {
		return SearchCursor{}, ErrInvalidRequest
	}

	// 9. count: integer >= 0 (and <= 200 when kind == "item", matching SuggestItem.entry_count).
	maxCount := int64(math.MaxInt32)
	if kindStr == CorpusItem {
		maxCount = 200
	}
	count64, err := parseCursorInt(obj["count"], 0, maxCount)
	if err != nil {
		return SearchCursor{}, ErrInvalidRequest
	}

	// 10. id: non-nil canonical UUID string.
	idStr, ok := obj["id"].(string)
	if !ok || len(idStr) != 36 || strings.ToLower(idStr) != idStr {
		return SearchCursor{}, ErrInvalidRequest
	}
	parsedID, err := uuid.Parse(idStr)
	if err != nil || parsedID == uuid.Nil {
		return SearchCursor{}, ErrInvalidRequest
	}

	return SearchCursor{
		Scope:      scopeStr,
		Kind:       kindStr,
		Gen:        genPtr,
		Tier:       int32(tier64),
		Score:      score,
		LastUsedAt: luUTC,
		Count:      int32(count64),
		ID:         parsedID,
	}, nil
}

// decodeStrictCursorObject parses a flat JSON object with `UseNumber()`, rejecting
// duplicate keys, unknown or missing keys, nested objects/arrays, or trailing tokens.
func decodeStrictCursorObject(jsonBytes []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(jsonBytes))
	dec.UseNumber()

	tok, err := dec.Token()
	if err != nil {
		return nil, ErrInvalidRequest
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return nil, ErrInvalidRequest
	}

	obj := make(map[string]any, len(cursorRequiredKeys))
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, ErrInvalidRequest
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, ErrInvalidRequest
		}
		if _, dup := obj[key]; dup {
			return nil, ErrInvalidRequest
		}
		if len(obj) >= len(cursorRequiredKeys) {
			return nil, ErrInvalidRequest
		}

		valTok, err := dec.Token()
		if err != nil {
			return nil, ErrInvalidRequest
		}
		// Cursor fields are all scalar (string, json.Number, bool, or nil); reject nested `{` or `[`.
		if _, isDelim := valTok.(json.Delim); isDelim {
			return nil, ErrInvalidRequest
		}
		obj[key] = valTok
	}

	endTok, err := dec.Token()
	if err != nil {
		return nil, ErrInvalidRequest
	}
	endDelim, ok := endTok.(json.Delim)
	if !ok || endDelim != '}' {
		return nil, ErrInvalidRequest
	}

	if _, err := dec.Token(); err != io.EOF {
		return nil, ErrInvalidRequest
	}

	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	if !slices.Equal(keys, cursorRequiredKeys) {
		return nil, ErrInvalidRequest
	}
	return obj, nil
}

func parseCursorInt(v any, minVal, maxVal int64) (int64, error) {
	num, ok := v.(json.Number)
	if !ok {
		return 0, ErrInvalidRequest
	}
	raw := string(num)
	if strings.ContainsAny(raw, ".eE") {
		return 0, ErrInvalidRequest
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || parsed < minVal || parsed > maxVal {
		return 0, ErrInvalidRequest
	}
	return parsed, nil
}

func parseCursorFloat(v any, minVal, maxVal float64) (float64, error) {
	num, ok := v.(json.Number)
	if !ok {
		return 0, ErrInvalidRequest
	}
	parsed, err := strconv.ParseFloat(string(num), 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < minVal || parsed > maxVal {
		return 0, ErrInvalidRequest
	}
	return parsed, nil
}
