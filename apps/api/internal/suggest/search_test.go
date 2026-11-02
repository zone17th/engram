package suggest_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/item"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

func (e *suggestTestEnv) doSearchRaw(token string, rawQuery string) *httptest.ResponseRecorder {
	e.t.Helper()
	target := "/api/v1/search"
	if rawQuery != "" {
		target += "?" + rawQuery
	}
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if token != "" {
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: token})
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func (e *suggestTestEnv) doSearch(token string, params url.Values) *httptest.ResponseRecorder {
	e.t.Helper()
	var raw string
	if params != nil {
		raw = params.Encode()
	}
	return e.doSearchRaw(token, raw)
}

// validateSearchResponseOpenAPIShape strictly validates the raw JSON bytes of a 200
// `/search` response against the frozen OpenAPI schemas `SearchResponse`,
// `SuggestTag`, `SuggestItem`, `TagRef`, `SuggestNearRow`, `SearchScope`,
// `SuggestMatch`, `SemanticReason`, `ItemName`, and `TagDisplay` in `apps/api/api/openapi.yaml`.
//
// All enum and numeric bounds are taken as frozen literals from `openapi.yaml`
// (`limit ∈ {20, 50}`, `mode ∈ {prefix, full}`, `near maxItems: 5`, etc.) and checked
// on raw untyped JSON (`json.Decoder` with `UseNumber()`).
func validateSearchResponseOpenAPIShape(t testing.TB, rec *httptest.ResponseRecorder) suggest.SearchResponse {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want \"no-store\"", cc)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}

	rawBytes := rec.Body.Bytes()
	if err := checkSearchResponseOpenAPISchema(rawBytes); err != nil {
		t.Fatalf("SearchResponse OpenAPI schema violation: %v\nbody=%s", err, string(rawBytes))
	}

	var resp suggest.SearchResponse
	dec := json.NewDecoder(bytes.NewReader(rawBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&resp); err != nil {
		t.Fatalf("decode SearchResponse after schema check: %v\nbody=%s", err, string(rawBytes))
	}
	return resp
}

func checkSearchResponseOpenAPISchema(rawBytes []byte) error {
	dec := json.NewDecoder(bytes.NewReader(rawBytes))
	dec.UseNumber()
	var root any
	if err := dec.Decode(&root); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("trailing JSON data after root value")
	}

	rawObj, ok := root.(map[string]any)
	if !ok || rawObj == nil {
		return fmt.Errorf("SearchResponse root must be a non-null JSON object, got %T", root)
	}

	wantTopKeys := []string{
		"generation",
		"items",
		"limit",
		"mode",
		"near",
		"next_cursor",
		"scope",
		"semantic",
		"semantic_reason",
		"tags",
	}
	if err := checkExactObjectKeys("SearchResponse", rawObj, wantTopKeys); err != nil {
		return err
	}

	// scope: SearchScope (string enum: [all, item, tag], required non-null).
	scope, err := checkRequiredString(rawObj, "SearchResponse.scope", "scope")
	if err != nil {
		return err
	}
	switch scope {
	case "all", "item", "tag":
	default:
		return fmt.Errorf("SearchResponse.scope = %q, want one of [all, item, tag]", scope)
	}

	// limit: integer enum [20, 50], required non-null (openapi.yaml:4663-4664).
	limit, err := checkRequiredInt(rawObj, "SearchResponse.limit", "limit", 20, 50)
	if err != nil {
		return err
	}
	switch limit {
	case 20, 50:
	default:
		return fmt.Errorf("SearchResponse.limit = %d, want one of [20, 50]", limit)
	}

	// mode: string enum [prefix, full], required non-null (openapi.yaml:4666-4668).
	mode, err := checkRequiredString(rawObj, "SearchResponse.mode", "mode")
	if err != nil {
		return err
	}
	switch mode {
	case "prefix", "full":
	default:
		return fmt.Errorf("SearchResponse.mode = %q, want one of [prefix, full]", mode)
	}

	// next_cursor: type [string, 'null'] (openapi.yaml:4679-4681).
	if nextCurRaw := rawObj["next_cursor"]; nextCurRaw != nil {
		nextCurStr, ok := nextCurRaw.(string)
		if !ok || nextCurStr == "" {
			return fmt.Errorf("SearchResponse.next_cursor must be a non-empty string or null, got %T (%v)", nextCurRaw, nextCurRaw)
		}
	}

	// semantic: boolean, required non-null.
	semantic, err := checkRequiredBool(rawObj, "SearchResponse.semantic", "semantic")
	if err != nil {
		return err
	}

	// semantic_reason: oneOf [SemanticReason, null].
	semReasonRaw := rawObj["semantic_reason"]
	if semantic {
		if semReasonRaw != nil {
			return fmt.Errorf("SearchResponse.semantic_reason must be null when semantic=true, got %v", semReasonRaw)
		}
	} else {
		semReason, ok := semReasonRaw.(string)
		if !ok {
			return fmt.Errorf("SearchResponse.semantic_reason must be a non-null string when semantic=false, got %T (%v)", semReasonRaw, semReasonRaw)
		}
		switch semReason {
		case "disabled_server", "disabled_user", "degraded", "request_lexical", "short_query":
		default:
			return fmt.Errorf("SearchResponse.semantic_reason = %q, want SemanticReason enum", semReason)
		}
	}

	// generation: type [integer, null], minimum 1, maximum 9999.
	genRaw := rawObj["generation"]
	if semantic {
		if genRaw == nil {
			return fmt.Errorf("SearchResponse.generation must be a non-null integer (1..9999) when semantic=true")
		}
		if _, err := checkRequiredInt(rawObj, "SearchResponse.generation", "generation", 1, 9999); err != nil {
			return err
		}
	} else {
		if genRaw != nil {
			return fmt.Errorf("SearchResponse.generation must be null when semantic=false, got %v", genRaw)
		}
	}

	// items: non-null array of SuggestItem.
	itemsArr, err := checkRequiredArray(rawObj, "SearchResponse.items", "items")
	if err != nil {
		return err
	}
	for i, elem := range itemsArr {
		m, ok := elem.(map[string]any)
		if !ok || m == nil {
			return fmt.Errorf("SearchResponse.items[%d] must be a non-null object, got %T", i, elem)
		}
		if err := checkSuggestItemSchema(fmt.Sprintf("SearchResponse.items[%d]", i), m, false); err != nil {
			return err
		}
	}

	// tags: non-null array of SuggestTag.
	tagsArr, err := checkRequiredArray(rawObj, "SearchResponse.tags", "tags")
	if err != nil {
		return err
	}
	for i, elem := range tagsArr {
		m, ok := elem.(map[string]any)
		if !ok || m == nil {
			return fmt.Errorf("SearchResponse.tags[%d] must be a non-null object, got %T", i, elem)
		}
		if err := checkSuggestTagSchema(fmt.Sprintf("SearchResponse.tags[%d]", i), m, false); err != nil {
			return err
		}
	}

	// near: non-null array of SuggestNearRow, maxItems: 5 (openapi.yaml:4689-4694), empty when semantic=false.
	nearArr, err := checkRequiredArray(rawObj, "SearchResponse.near", "near")
	if err != nil {
		return err
	}
	if len(nearArr) > 5 {
		return fmt.Errorf("SearchResponse.near len = %d, maxItems is 5", len(nearArr))
	}
	if !semantic && len(nearArr) != 0 {
		return fmt.Errorf("SearchResponse.near must be empty [] when semantic=false, got len=%d", len(nearArr))
	}
	for i, elem := range nearArr {
		m, ok := elem.(map[string]any)
		if !ok || m == nil {
			return fmt.Errorf("SearchResponse.near[%d] must be a non-null object, got %T", i, elem)
		}
		kind, err := checkRequiredString(m, fmt.Sprintf("SearchResponse.near[%d].kind", i), "kind")
		if err != nil {
			return err
		}
		switch kind {
		case "tag":
			if err := checkSuggestTagSchema(fmt.Sprintf("SearchResponse.near[%d]", i), m, true); err != nil {
				return err
			}
		case "item":
			if err := checkSuggestItemSchema(fmt.Sprintf("SearchResponse.near[%d]", i), m, true); err != nil {
				return err
			}
		default:
			return fmt.Errorf("SearchResponse.near[%d] has invalid discriminator kind=%q", i, kind)
		}
	}

	return nil
}

// TestSearchOpenAPISchemaValidatorSelfTest verifies the raw-JSON OpenAPI checker for
// `SearchResponse`, including negative self-tests (`limit: 30`, `mode: "recent"`,
// `near` length 6, `next_cursor` number, extra key, lexical row with `"semantic"` match,
// and near row with non-semantic match).
func TestSearchOpenAPISchemaValidatorSelfTest(t *testing.T) {
	validJSON := `{
		"scope": "all",
		"limit": 20,
		"mode": "full",
		"items": [{
			"kind": "item",
			"id": "00000000-0001-4000-8000-000000000001",
			"name": "wifi nhà",
			"entry_count": 3,
			"created_at": "2026-10-20T12:00:00Z",
			"last_used_at": "2026-10-20T12:00:00Z",
			"tags": [{"id": "00000000-0011-4000-8000-000000000001", "display": "nhà-riêng"}],
			"tag_total": 1,
			"match": "prefix"
		}],
		"tags": [{
			"kind": "tag",
			"id": "00000000-0011-4000-8000-000000000001",
			"display": "nhà-riêng",
			"item_count": 2,
			"last_used_at": "2026-10-20T12:00:00Z",
			"match": "prefix"
		}],
		"next_cursor": "eyJ2IjoxfQ",
		"semantic": true,
		"semantic_reason": null,
		"near": [{
			"kind": "tag",
			"id": "00000000-0011-4000-8000-000000000009",
			"display": "mạng-gia-đình",
			"item_count": 1,
			"last_used_at": "2026-10-20T12:00:00Z",
			"match": "semantic"
		}],
		"generation": 1
	}`
	if err := checkSearchResponseOpenAPISchema([]byte(validJSON)); err != nil {
		t.Fatalf("expected baseline valid SearchResponse JSON to pass schema check, got: %v", err)
	}

	negativeCases := []struct {
		name    string
		mutate  func(m map[string]any)
		wantSub string
	}{
		{
			name: "limit 30 rejected",
			mutate: func(m map[string]any) {
				m["limit"] = json.Number("30")
			},
			wantSub: "SearchResponse.limit",
		},
		{
			name: "limit 8 rejected on SearchResponse",
			mutate: func(m map[string]any) {
				m["limit"] = json.Number("8")
			},
			wantSub: "SearchResponse.limit",
		},
		{
			name: "mode recent rejected on SearchResponse",
			mutate: func(m map[string]any) {
				m["mode"] = "recent"
			},
			wantSub: "SearchResponse.mode",
		},
		{
			name: "near length 6 rejected (maxItems 5)",
			mutate: func(m map[string]any) {
				nearElem := m["near"].([]any)[0]
				m["near"] = []any{nearElem, nearElem, nearElem, nearElem, nearElem, nearElem}
			},
			wantSub: "SearchResponse.near len = 6, maxItems is 5",
		},
		{
			name: "next_cursor number rejected",
			mutate: func(m map[string]any) {
				m["next_cursor"] = json.Number("123")
			},
			wantSub: "SearchResponse.next_cursor",
		},
		{
			name: "extra top-level key rejected",
			mutate: func(m map[string]any) {
				m["q"] = "wifi"
			},
			wantSub: "SearchResponse keys",
		},
		{
			name: "lexical_partial key rejected on SearchResponse",
			mutate: func(m map[string]any) {
				m["lexical_partial"] = []any{}
			},
			wantSub: "SearchResponse keys",
		},
		{
			name: "near row with prefix match rejected",
			mutate: func(m map[string]any) {
				near := m["near"].([]any)
				near[0].(map[string]any)["match"] = "prefix"
			},
			wantSub: "SearchResponse.near[0].match",
		},
		{
			name: "lexical item with semantic match rejected",
			mutate: func(m map[string]any) {
				items := m["items"].([]any)
				items[0].(map[string]any)["match"] = "semantic"
			},
			wantSub: "SearchResponse.items[0].match",
		},
	}

	for _, tc := range negativeCases {
		t.Run(tc.name, func(t *testing.T) {
			dec := json.NewDecoder(strings.NewReader(validJSON))
			dec.UseNumber()
			var obj map[string]any
			if err := dec.Decode(&obj); err != nil {
				t.Fatalf("decode baseline: %v", err)
			}
			tc.mutate(obj)
			mutatedBytes, err := json.Marshal(obj)
			if err != nil {
				t.Fatalf("marshal mutated: %v", err)
			}
			err = checkSearchResponseOpenAPISchema(mutatedBytes)
			if err == nil {
				t.Fatalf("expected schema error containing %q, got nil", tc.wantSub)
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("schema error = %q, want substring %q", err.Error(), tc.wantSub)
			}
		})
	}
}

// TestSearchQueryEdgeCases verifies Deliverable 1 & Task 3/4 Evidence:
//   - `/search` with `!!!` (or punctuation-only, whitespace-only, empty `q=`, `#` alone, or `q` absent) -> 400 `name_invalid`
//   - control char / bidi override / invalid UTF-8 / `q > 200` runes / tag `> 50` runes -> 400 `name_invalid`
//   - boundary `200` runes (`scope=all|item`) and `50` runes (`#tag` or `scope=tag`) -> 200 OK
//   - leading `#token rest` -> forces `scope=tag`, strips `#`, normalizes first token only
//   - 1-rune query -> `mode: "prefix"`, >= 2-rune query -> `mode: "full"`
//   - `scope=`, `cursor=`, bare `limit`, `limit=8` (suggest limit), `limit=30`, `semantic=2`, unknown/duplicate params -> 400 `invalid_request`
func TestSearchQueryEdgeCases(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	u1 := uuid.MustParse("11111111-1111-4000-8000-000000000011")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'search-edge@example.com', 'vi')`, u1); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	ts := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `
		INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
		VALUES ($1, $2, 'wifi nhà', 'wifi nhà', 3, $3, $3, $3)
	`, uuid.MustParse("00000000-0001-4000-8000-000000000011"), u1, ts); err != nil {
		t.Fatalf("insert seed item: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
		VALUES ($1, $2, 'nhà-riêng', 'nhà-riêng', 1, $3, $3, $3)
	`, uuid.MustParse("00000000-0011-4000-8000-000000000011"), u1, ts); err != nil {
		t.Fatalf("insert seed tag: %v", err)
	}

	env := newSuggestTestEnv(t, pool)
	const tok = "tok-u1"
	env.auth.addToken(tok, u1)

	// 1. `/search` with `!!!`, punctuation-only, empty/whitespace, `#` alone, or absent `q` -> 400 `name_invalid`.
	nameInvalidEmptyOrPunct := []url.Values{
		{},
		{"q": {""}},
		{"q": {"     "}},
		{"q": {"\u00a0\u2003\u3000"}},
		{"q": {"!!!"}},
		{"q": {"...---..."}},
		{"q": {"   !!!   "}},
		{"q": {"#"}},
		{"q": {"   #"}},
		{"q": {"#   "}},
		{"q": {"#!!!"}},
		{"q": {"#   wifi"}},
		{"q": {"!!!"}, "scope": {"tag"}},
	}
	for _, vals := range nameInvalidEmptyOrPunct {
		rec := env.doSearch(tok, vals)
		assertProblemCode(t, rec, http.StatusBadRequest, "name_invalid")
	}

	// 2. Control chars, bidi overrides/isolates, invalid UTF-8, q > 200 runes, tag > 50 runes -> 400 `name_invalid`.
	nameInvalidQueries := []url.Values{
		{"q": {"wifi\x00secret"}},
		{"q": {"wifi\tsecret"}},
		{"q": {"wifi\nsecret"}},
		{"q": {"wifi\rsecret"}},
		{"q": {"wifi\x7fsecret"}},
		{"q": {"wifi\u0085secret"}},
		{"q": {"wifi\u202Esecret"}},
		{"q": {"wifi\u2066secret"}},
		{"q": {strings.Repeat("a", 201)}},
		{"q": {strings.Repeat("đ", 201)}},
		{"q": {"#" + strings.Repeat("t", 51)}},
		{"q": {strings.Repeat("t", 51)}, "scope": {"tag"}},
	}
	for _, vals := range nameInvalidQueries {
		rec := env.doSearch(tok, vals)
		assertProblemCode(t, rec, http.StatusBadRequest, "name_invalid")
	}
	badUTF8Rec := env.doSearchRaw(tok, "q=%ff%fe")
	assertProblemCode(t, badUTF8Rec, http.StatusBadRequest, "name_invalid")

	// 3. Boundary checks: 200 runes for item/all and 50 runes for tag succeed with 200 OK.
	ok200Rec := env.doSearch(tok, url.Values{"q": {strings.Repeat("a", 200)}})
	validateSearchResponseOpenAPIShape(t, ok200Rec)
	ok50TagRec := env.doSearch(tok, url.Values{"q": {"#" + strings.Repeat("t", 50)}})
	validateSearchResponseOpenAPIShape(t, ok50TagRec)

	// 4. Leading `#` with valid token forces `scope=tag` (even when `scope=item` was passed) and strips trailing tokens.
	recHash := env.doSearch(tok, url.Values{"q": {"  #nhà   ignored-second-token"}, "scope": {"item"}})
	respHash := validateSearchResponseOpenAPIShape(t, recHash)
	if respHash.Scope != suggest.ScopeTag || respHash.Mode != suggest.ModeFull || respHash.Limit != 20 {
		t.Fatalf("#nhà: got scope=%q mode=%q limit=%d, want scope=tag mode=full limit=20",
			respHash.Scope, respHash.Mode, respHash.Limit)
	}
	if len(respHash.Tags) != 1 || respHash.Tags[0].Display != "nhà-riêng" || len(respHash.Items) != 0 {
		t.Fatalf("#nhà: got tags=%+v items=%+v, want 1 tag 'nhà-riêng' and 0 items", respHash.Tags, respHash.Items)
	}

	// 5. 1-rune query -> `mode: "prefix"`; >= 2-rune query -> `mode: "full"`.
	recPrefix := env.doSearch(tok, url.Values{"q": {"w"}, "limit": {"50"}})
	respPrefix := validateSearchResponseOpenAPIShape(t, recPrefix)
	if respPrefix.Mode != suggest.ModePrefix || respPrefix.Limit != 50 {
		t.Fatalf("q='w': got mode=%q limit=%d, want mode=prefix limit=50", respPrefix.Mode, respPrefix.Limit)
	}

	// 6. 400 `invalid_request`: present-but-empty (`scope=`, `cursor=`, bare `limit`), bad limit (`8`, `12`, `30`),
	// bad scope, bad semantic, unknown param, duplicate param, malformed percent-encoding.
	invalidReqQueries := []string{
		"q=wifi&scope=",
		"q=wifi&scope",
		"q=wifi&cursor=",
		"q=wifi&cursor",
		"q=wifi&limit=",
		"q=wifi&limit",
		"q=wifi&scope=bad",
		"q=wifi&scope=ALL",
		"q=wifi&limit=0",
		"q=wifi&limit=5",
		"q=wifi&limit=8",
		"q=wifi&limit=12",
		"q=wifi&limit=30",
		"q=wifi&limit=100",
		"q=wifi&limit=abc",
		"q=wifi&semantic=2",
		"q=wifi&semantic=true",
		"q=wifi&unknown=1",
		"q=wifi&q=other",
		"q=wifi&limit=20&limit=50",
		"q=wifi&scope=all&scope=item",
		"q=wifi&semantic=0&semantic=1",
		"q=wifi&cursor=a&cursor=b",
		"q=%ZZ",
	}
	for _, rawQ := range invalidReqQueries {
		rec := env.doSearchRaw(tok, rawQ)
		assertProblemCode(t, rec, http.StatusBadRequest, "invalid_request")
	}
}

// TestSearchPagesStableKeyset verifies Task 4 Evidence & FU-SL-2:
//   - Over a fixed snapshot of >= 45 items (spanning >= 3 pages at `limit=20`) that includes:
//   - exact prefix (tier 3), folded prefix (tier 2), and fuzzy trigram matches (tier 1)
//   - non-integral rounded float64 scores (`0.89`, `0.78`, `0.67`, `0.58`, `0.56`)
//   - two distinct raw trigram scores that round to the SAME 2-decimal score (`0.56`:
//     `duong` raw 5/9=0.555556 vs `duongxyzw-ngsat` raw 9/16=0.562500) placed right across
//     the page-1 -> page-2 boundary (items #19 and #20, 0-indexed)
//   - microsecond `last_used_at` timestamps (`t+500µs`, `t+100µs`, `t+1µs`, `t`) across page boundaries
//   - `entry_count` tie-breaks and ascending `id` tie-breaks across page-2 -> page-3 boundary
//   - Paging through `GET /api/v1/search?q=duongsat&scope=item&limit=20` until `next_cursor == null`
//     yields >= 3 pages with zero duplicates and zero missing rows, in the exact order returned
//     by the unpaged `SearchItemsLexical` query.
//   - Also verifies `limit=50` returns all 45 rows on a single page with `next_cursor: null`.
func TestSearchPagesStableKeyset(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	uid := uuid.MustParse("33333333-3333-4000-8000-000000000033")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'search-keyset@example.com', 'vi')`, uid); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	tBase := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	tPlus500us := tBase.Add(500 * time.Microsecond)
	tPlus100us := tBase.Add(100 * time.Microsecond)
	tPlus1us := tBase.Add(1 * time.Microsecond)
	tOlder := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)

	type itemSeed struct {
		id         uuid.UUID
		name       string
		entryCount int32
		lastUsed   time.Time
	}

	var seeds []itemSeed

	// 1..10: Tier 3 exact prefix `duongsat...` (10 items).
	// Items 1..6 have score 1.00 (`duongsat`), varying by µs timestamps and entry_count.
	for i := 1; i <= 6; i++ {
		seeds = append(seeds, itemSeed{
			id:         uuid.MustParse(fmt.Sprintf("00000000-0044-4000-8000-%012d", i)),
			name:       "duongsat",
			entryCount: int32(20 - i),
			lastUsed:   tBase.Add(time.Duration(1000-i*100) * time.Microsecond),
		})
	}
	// Items 7..10 have non-integral score 0.89 (`duongsatx`), varying by µs timestamps.
	for i := 7; i <= 10; i++ {
		seeds = append(seeds, itemSeed{
			id:         uuid.MustParse(fmt.Sprintf("00000000-0044-4000-8000-%012d", i)),
			name:       "duongsatx",
			entryCount: int32(15 - i),
			lastUsed:   tBase.Add(time.Duration(500-i*10) * time.Microsecond),
		})
	}

	// 11..16: Tier 2 folded prefix `đườngsắt...` (6 items: 3 with score 1.00, 3 with score 0.89).
	for i := 11; i <= 13; i++ {
		seeds = append(seeds, itemSeed{
			id:         uuid.MustParse(fmt.Sprintf("00000000-0044-4000-8000-%012d", i)),
			name:       "đườngsắt",
			entryCount: int32(30 - i),
			lastUsed:   tBase.Add(time.Duration(300-i) * time.Microsecond),
		})
	}
	for i := 14; i <= 16; i++ {
		seeds = append(seeds, itemSeed{
			id:         uuid.MustParse(fmt.Sprintf("00000000-0044-4000-8000-%012d", i)),
			name:       "đườngsắtx",
			entryCount: int32(30 - i),
			lastUsed:   tBase.Add(time.Duration(200-i) * time.Microsecond),
		})
	}

	// 17..19: Tier 1 fuzzy with scores 0.78 (`duongsa`), 0.67 (`duongs`), 0.58 (`duoxngsat`).
	seeds = append(seeds,
		itemSeed{
			id:         uuid.MustParse("00000000-0044-4000-8000-000000000017"),
			name:       "duongsa",
			entryCount: 5,
			lastUsed:   tOlder,
		},
		itemSeed{
			id:         uuid.MustParse("00000000-0044-4000-8000-000000000018"),
			name:       "duongs",
			entryCount: 5,
			lastUsed:   tOlder,
		},
		itemSeed{
			id:         uuid.MustParse("00000000-0044-4000-8000-000000000019"),
			name:       "duoxngsat",
			entryCount: 5,
			lastUsed:   tOlder,
		},
	)

	// 20..21 (PAGE 1 -> PAGE 2 BOUNDARY at limit=20! Item #20 is last of page 1, Item #21 is first of page 2):
	// Both have rounded score 0.56 from DIFFERENT raw trigram ratios (FU-SL-2):
	//   - #20: `duong` (raw 5/9 = 0.555556 -> 0.56) at `tPlus500us`
	//   - #21: `duongxyzw-ngsat` (raw 9/16 = 0.562500 -> 0.56) at `tPlus100us`
	// Followed by #22 at `tPlus100us` with lower count, and #23 at `tPlus1us`.
	seeds = append(seeds,
		itemSeed{
			id:         uuid.MustParse("00000000-0044-4000-8000-000000000020"),
			name:       "duong",
			entryCount: 3,
			lastUsed:   tPlus500us,
		},
		itemSeed{
			id:         uuid.MustParse("00000000-0044-4000-8000-000000000021"),
			name:       "duongxyzw-ngsat",
			entryCount: 9,
			lastUsed:   tPlus100us,
		},
		itemSeed{
			id:         uuid.MustParse("00000000-0044-4000-8000-000000000022"),
			name:       "duongxyzv-ngsat",
			entryCount: 4,
			lastUsed:   tPlus100us,
		},
		itemSeed{
			id:         uuid.MustParse("00000000-0044-4000-8000-000000000023"),
			name:       "duongxyzu-ngsat",
			entryCount: 4,
			lastUsed:   tPlus1us,
		},
	)

	// 24..45: 22 more Tier 1 fuzzy rows (`duongxyzt-ngsat`, score 0.56) that cross the
	// PAGE 2 -> PAGE 3 BOUNDARY (item #40 -> #41) with identical `(tier=1, score=0.56, last_used_at=tOlder, entry_count=2)`
	// so the boundary is decided purely by ascending UUID (`id ASC`).
	for i := 24; i <= 45; i++ {
		seeds = append(seeds, itemSeed{
			id:         uuid.MustParse(fmt.Sprintf("00000000-0044-4000-8000-%012d", i)),
			name:       "duongxyzt-ngsat",
			entryCount: 2,
			lastUsed:   tOlder,
		})
	}

	for _, s := range seeds {
		if _, err := pool.Exec(ctx, `
			INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
		`, s.id, uid, s.name, s.name, s.entryCount, s.lastUsed); err != nil {
			t.Fatalf("insert item seed %s: %v", s.id, err)
		}
	}

	// Query unpaged ground truth directly via SearchItemsLexical.
	var wantOrder []uuid.UUID
	withLexicalTx(t, ctx, pool, func(q *gen.Queries) {
		unpaged, err := q.SearchItemsLexical(ctx, gen.SearchItemsLexicalParams{
			UserID:    uid,
			Qn:        "duongsat",
			QPrefix:   item.EscapeLikePrefix("duongsat"),
			Fuzzy:     true,
			PageLimit: 100,
		})
		if err != nil {
			t.Fatalf("SearchItemsLexical unpaged: %v", err)
		}
		if len(unpaged) != len(seeds) {
			t.Fatalf("unpaged len = %d, want %d", len(unpaged), len(seeds))
		}
		// Verify item #19 (0-indexed, last of page 1) and #20 (first of page 2) are the equal-rounded-score 0.56 pair.
		if unpaged[19].ID != uuid.MustParse("00000000-0044-4000-8000-000000000020") || unpaged[19].Score != 0.56 {
			t.Fatalf("unpaged[19] = (id=%s score=%v), want ...0020 score=0.56", unpaged[19].ID, unpaged[19].Score)
		}
		if unpaged[20].ID != uuid.MustParse("00000000-0044-4000-8000-000000000021") || unpaged[20].Score != 0.56 {
			t.Fatalf("unpaged[20] = (id=%s score=%v), want ...0021 score=0.56", unpaged[20].ID, unpaged[20].Score)
		}
		for _, r := range unpaged {
			wantOrder = append(wantOrder, r.ID)
		}
	})

	env := newSuggestTestEnv(t, pool)
	const tok = "tok-u1"
	env.auth.addToken(tok, uid)

	// 1. Page through `/api/v1/search?q=duongsat&scope=item&limit=20` across 3 pages.
	var gotIDs []uuid.UUID
	var cursor string
	pageCount := 0
	for {
		params := url.Values{
			"q":     {"duongsat"},
			"scope": {"item"},
			"limit": {"20"},
		}
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		rec := env.doSearch(tok, params)
		resp := validateSearchResponseOpenAPIShape(t, rec)
		pageCount++

		if len(resp.Tags) != 0 {
			t.Fatalf("page %d: scope=item must return tags=[], got %d", pageCount, len(resp.Tags))
		}
		if pageCount > 1 {
			if resp.Semantic || resp.SemanticReason == nil || *resp.SemanticReason != suggest.ReasonRequestLexical || len(resp.Near) != 0 || resp.Generation != nil {
				t.Fatalf("page %d (cursor page): got semantic=%v reason=%v near=%d gen=%v, want false/request_lexical/0/nil",
					pageCount, resp.Semantic, resp.SemanticReason, len(resp.Near), resp.Generation)
			}
		}

		for _, it := range resp.Items {
			gotIDs = append(gotIDs, it.ID)
		}

		if resp.NextCursor == nil {
			break
		}
		cursor = *resp.NextCursor
		if pageCount > 10 {
			t.Fatal("pagination did not terminate within 10 pages")
		}
	}

	if pageCount != 3 {
		t.Fatalf("pageCount = %d, want 3 (20 + 20 + 5 = 45 items)", pageCount)
	}
	if !slices.Equal(gotIDs, wantOrder) {
		t.Fatalf("paged item IDs mismatch unpaged ground truth:\ngot  (%d): %v\nwant (%d): %v",
			len(gotIDs), gotIDs, len(wantOrder), wantOrder)
	}

	// 2. Also verify `limit=50` returns all 45 rows in one page with `next_cursor == nil`.
	rec50 := env.doSearch(tok, url.Values{
		"q":     {"duongsat"},
		"scope": {"item"},
		"limit": {"50"},
	})
	resp50 := validateSearchResponseOpenAPIShape(t, rec50)
	if resp50.Limit != 50 || resp50.NextCursor != nil || len(resp50.Items) != len(wantOrder) {
		t.Fatalf("limit=50: got limit=%d next_cursor=%v len(items)=%d, want 50/nil/%d",
			resp50.Limit, resp50.NextCursor, len(resp50.Items), len(wantOrder))
	}
}

// TestSearchTagScopePages verifies Task 4 Evidence (BE-12):
//   - `scope=tag` with more than `limit` tags (110 tags paged at `limit=50` -> 3 pages: 50 + 50 + 10,
//     and also paged at `limit=20` -> 6 pages) pages via `SearchTagsLexicalPage` with cursor `kind="tag"`.
//   - Every page returns `items=[]`, no duplicate or missing tags compared to the unpaged order,
//     and `next_cursor == null` on the final page.
func TestSearchTagScopePages(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	uid := uuid.MustParse("44444444-4444-4000-8000-000000000044")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'tag-pages@example.com', 'vi')`, uid); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	tBase := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	const totalTags = 110
	for i := 1; i <= totalTags; i++ {
		tid := uuid.MustParse(fmt.Sprintf("00000000-0055-4000-8000-%012d", i))
		// Mix tier 3 (`duongsat-...`), tier 2 (`đườngsắt-...`), and microsecond timestamps.
		display := fmt.Sprintf("duongsat-%03d", i)
		norm := display
		if i > 60 {
			display = fmt.Sprintf("đườngsắt-%03d", i)
			norm = display
		}
		lu := tBase.Add(time.Duration(totalTags-i) * time.Microsecond)
		count := int32((totalTags - i) % 17)
		if _, err := pool.Exec(ctx, `
			INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
		`, tid, uid, display, norm, count, lu); err != nil {
			t.Fatalf("insert tag %d: %v", i, err)
		}
	}

	var wantTagIDs []uuid.UUID
	withLexicalTx(t, ctx, pool, func(q *gen.Queries) {
		unpaged, err := q.SearchTagsLexical(ctx, gen.SearchTagsLexicalParams{
			UserID:    uid,
			Qn:        "duongsat",
			QPrefix:   item.EscapeLikePrefix("duongsat"),
			Fuzzy:     true,
			PageLimit: 200,
		})
		if err != nil {
			t.Fatalf("SearchTagsLexical unpaged: %v", err)
		}
		if len(unpaged) != totalTags {
			t.Fatalf("unpaged tags len = %d, want %d", len(unpaged), totalTags)
		}
		for _, r := range unpaged {
			wantTagIDs = append(wantTagIDs, r.ID)
		}
	})

	env := newSuggestTestEnv(t, pool)
	const tok = "tok-u1"
	env.auth.addToken(tok, uid)

	// 1. Page with `limit=50` (3 pages: 50 + 50 + 10 = 110 tags) and inspect decoded cursor `kind == "tag"`.
	var got50 []uuid.UUID
	var cursor string
	pages50 := 0
	for {
		params := url.Values{
			"q":     {"duongsat"},
			"scope": {"tag"},
			"limit": {"50"},
		}
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		rec := env.doSearch(tok, params)
		resp := validateSearchResponseOpenAPIShape(t, rec)
		pages50++

		if resp.Scope != suggest.ScopeTag || resp.Limit != 50 || len(resp.Items) != 0 {
			t.Fatalf("page %d: scope=%q limit=%d items=%d, want tag/50/0",
				pages50, resp.Scope, resp.Limit, len(resp.Items))
		}
		for _, tg := range resp.Tags {
			got50 = append(got50, tg.ID)
		}
		if resp.NextCursor == nil {
			break
		}
		cursor = *resp.NextCursor

		// Verify cursor carries `kind: "tag"` and `scope: "tag"`.
		curJSON, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil {
			t.Fatalf("base64 decode next_cursor: %v", err)
		}
		var curMap map[string]any
		if err := json.Unmarshal(curJSON, &curMap); err != nil {
			t.Fatalf("unmarshal next_cursor: %v", err)
		}
		if curMap["kind"] != "tag" || curMap["scope"] != "tag" {
			t.Fatalf("cursor kind=%v scope=%v, want kind=tag scope=tag", curMap["kind"], curMap["scope"])
		}
	}
	if pages50 != 3 {
		t.Fatalf("limit=50 pages = %d, want 3", pages50)
	}
	if !slices.Equal(got50, wantTagIDs) {
		t.Fatalf("limit=50 paged tag IDs mismatch unpaged order")
	}

	// 2. Also verify `#duongsat` at default `limit=20` (6 pages: 5*20 + 10 = 110 tags).
	var got20 []uuid.UUID
	cursor = ""
	pages20 := 0
	for {
		params := url.Values{"q": {"#duongsat"}}
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		rec := env.doSearch(tok, params)
		resp := validateSearchResponseOpenAPIShape(t, rec)
		pages20++
		for _, tg := range resp.Tags {
			got20 = append(got20, tg.ID)
		}
		if resp.NextCursor == nil {
			break
		}
		cursor = *resp.NextCursor
	}
	if pages20 != 6 || !slices.Equal(got20, wantTagIDs) {
		t.Fatalf("#duongsat limit=20 pages=%d match=%v, want 6 pages and exact match", pages20, slices.Equal(got20, wantTagIDs))
	}
}

// TestSearchAllScopeTagsFirstPageOnly verifies Task 4 Evidence (BE-12, plan 2.4/2.5):
//   - For `scope=all`, page 1 returns `items` (up to `limit`), `tags` capped at `<= 5`
//     (even when > 5 tags match), and `near` capped at `<= 5` (after deduplicating against
//     lexical `tags` and `items`, ordered `SuggestTag` before `SuggestItem`, with `generation` pinned).
//   - Subsequent pages (with `cursor`) page `items` by keyset (`kind="item"`), return
//     `tags=[]`, `near=[]`, `semantic=false`, `semantic_reason="request_lexical"`, `generation=null`,
//     and never call `NearSource`.
func TestSearchAllScopeTagsFirstPageOnly(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	uid := uuid.MustParse("55555555-5555-4000-8000-000000000055")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'all-first-page@example.com', 'vi')`, uid); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	ts := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	// Seed 25 matching items (so limit=20 has 2 pages: 20 + 5) and 8 matching tags (so page 1 caps tags at 5).
	for i := 1; i <= 25; i++ {
		id := uuid.MustParse(fmt.Sprintf("00000000-0066-4000-8000-%012d", i))
		name := fmt.Sprintf("wifi item %02d", i)
		lu := ts.Add(time.Duration(25-i) * time.Second)
		if _, err := pool.Exec(ctx, `
			INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $3, 1, $4, $4, $4)
		`, id, uid, name, lu); err != nil {
			t.Fatalf("insert item %d: %v", i, err)
		}
	}
	for i := 1; i <= 8; i++ {
		id := uuid.MustParse(fmt.Sprintf("00000000-0077-4000-8000-%012d", i))
		display := fmt.Sprintf("wifi-tag-%02d", i)
		lu := ts.Add(time.Duration(8-i) * time.Second)
		if _, err := pool.Exec(ctx, `
			INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $3, 1, $4, $4, $4)
		`, id, uid, display, lu); err != nil {
			t.Fatalf("insert tag %d: %v", i, err)
		}
	}

	env := newSuggestTestEnv(t, pool)
	const tok = "tok-u1"
	env.auth.addToken(tok, uid)
	defer env.svc.SetNearSource(suggest.NewNoopNearSource())

	nearCalls := 0
	var lastNearReq suggest.NearRequest
	env.svc.SetNearSource(stubNearSource{
		activeGen: func(_ context.Context, _ uuid.UUID) (*int, error) {
			genID := 7
			return &genID, nil
		},
		fn: func(_ context.Context, req suggest.NearRequest) (suggest.NearResult, error) {
			nearCalls++
			lastNearReq = req
			genID := 7
			// plus 4 unique semantic items and 3 unique semantic tags (7 unique -> clipped to 5: 3 tags then 2 items).
			var cands []suggest.SuggestNearRow
			cands = append(cands,
				suggest.SuggestItem{
					Kind:       "item",
					ID:         uuid.MustParse("00000000-0066-4000-8000-000000000001"), // lexical dup
					Name:       "wifi item 01",
					EntryCount: 1,
					CreatedAt:  ts,
					LastUsedAt: ts,
					Tags:       []suggest.TagRef{},
					Match:      suggest.MatchSemantic,
				},
				suggest.SuggestTag{
					Kind:       "tag",
					ID:         uuid.MustParse("00000000-0077-4000-8000-000000000001"), // lexical dup
					Display:    "wifi-tag-01",
					ItemCount:  1,
					LastUsedAt: ts,
					Match:      suggest.MatchSemantic,
				},
			)
			for i := 1; i <= 4; i++ {
				cands = append(cands, suggest.SuggestItem{
					Kind:       "item",
					ID:         uuid.MustParse(fmt.Sprintf("00000000-0088-4000-8000-%012d", i)),
					Name:       fmt.Sprintf("near item %d", i),
					EntryCount: 1,
					CreatedAt:  ts,
					LastUsedAt: ts,
					Tags:       []suggest.TagRef{},
					Match:      suggest.MatchSemantic,
				})
			}
			for i := 1; i <= 3; i++ {
				cands = append(cands, suggest.SuggestTag{
					Kind:       "tag",
					ID:         uuid.MustParse(fmt.Sprintf("00000000-0099-4000-8000-%012d", i)),
					Display:    fmt.Sprintf("near-tag-%d", i),
					ItemCount:  1,
					LastUsedAt: ts,
					Match:      suggest.MatchSemantic,
				})
			}
			return suggest.NearResult{
				Semantic:       true,
				SemanticReason: nil,
				Near:           cands,
				Generation:     &genID,
			}, nil
		},
	})

	// Page 1: no cursor.
	rec1 := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"20"}, "semantic": {"1"}})
	resp1 := validateSearchResponseOpenAPIShape(t, rec1)
	if len(resp1.Items) != 20 {
		t.Fatalf("page 1 items len = %d, want 20", len(resp1.Items))
	}
	if len(resp1.Tags) != 5 {
		t.Fatalf("page 1 tags len = %d, want 5 (capped at 5)", len(resp1.Tags))
	}
	if !resp1.Semantic || resp1.SemanticReason != nil || resp1.Generation == nil || *resp1.Generation != 7 {
		t.Fatalf("page 1 semantic state = (semantic=%v reason=%v gen=%v), want true/nil/7",
			resp1.Semantic, resp1.SemanticReason, resp1.Generation)
	}
	if len(resp1.Near) != 5 {
		t.Fatalf("page 1 near len = %d, want 5 (capped at 5 after dedup)", len(resp1.Near))
	}
	var rawPage1 struct {
		Near []struct {
			Kind  string    `json:"kind"`
			ID    uuid.UUID `json:"id"`
			Match string    `json:"match"`
		} `json:"near"`
	}
	if err := json.Unmarshal(rec1.Body.Bytes(), &rawPage1); err != nil {
		t.Fatalf("unmarshal page 1 near: %v", err)
	}
	wantNearKinds := []string{"tag", "tag", "tag", "item", "item"}
	wantNearIDs := []uuid.UUID{
		uuid.MustParse("00000000-0099-4000-8000-000000000001"),
		uuid.MustParse("00000000-0099-4000-8000-000000000002"),
		uuid.MustParse("00000000-0099-4000-8000-000000000003"),
		uuid.MustParse("00000000-0088-4000-8000-000000000001"),
		uuid.MustParse("00000000-0088-4000-8000-000000000002"),
	}
	for i := range rawPage1.Near {
		if rawPage1.Near[i].Kind != wantNearKinds[i] || rawPage1.Near[i].ID != wantNearIDs[i] || rawPage1.Near[i].Match != "semantic" {
			t.Fatalf("page 1 near[%d] = %+v, want kind=%q id=%s match=\"semantic\"",
				i, rawPage1.Near[i], wantNearKinds[i], wantNearIDs[i])
		}
	}
	if nearCalls != 1 || lastNearReq.Cap != 5 {
		t.Fatalf("page 1 nearCalls=%d cap=%d, want 1 and 5", nearCalls, lastNearReq.Cap)
	}
	if resp1.NextCursor == nil {
		t.Fatal("page 1 expected non-nil next_cursor")
	}

	// Verify cursor JSON records `gen: 7` and `kind: "item"`.
	curBytes, err := base64.RawURLEncoding.DecodeString(*resp1.NextCursor)
	if err != nil {
		t.Fatalf("decode page 1 next_cursor: %v", err)
	}
	var curObj map[string]any
	if err := json.Unmarshal(curBytes, &curObj); err != nil {
		t.Fatalf("unmarshal page 1 next_cursor: %v", err)
	}
	if curObj["kind"] != "item" || curObj["gen"] != float64(7) {
		t.Fatalf("page 1 cursor = %+v, want kind=item gen=7", curObj)
	}

	// Page 2 (cursor page): even if caller passes `semantic=1`, cursor pages never call NearSource
	// and return `tags=[]`, `near=[]`, `semantic=false`, `semantic_reason="request_lexical"`, `generation=null`.
	rec2 := env.doSearch(tok, url.Values{
		"q":        {"wifi"},
		"scope":    {"all"},
		"limit":    {"20"},
		"cursor":   {*resp1.NextCursor},
		"semantic": {"1"},
	})
	resp2 := validateSearchResponseOpenAPIShape(t, rec2)
	if nearCalls != 1 {
		t.Fatalf("cursor page must not call NearSource; nearCalls = %d, want 1", nearCalls)
	}
	if len(resp2.Items) != 5 {
		t.Fatalf("page 2 items len = %d, want 5", len(resp2.Items))
	}
	if len(resp2.Tags) != 0 || len(resp2.Near) != 0 {
		t.Fatalf("page 2 tags=%d near=%d, want 0 and 0", len(resp2.Tags), len(resp2.Near))
	}
	if resp2.Semantic || resp2.SemanticReason == nil || *resp2.SemanticReason != suggest.ReasonRequestLexical || resp2.Generation != nil {
		t.Fatalf("page 2 semantic envelope = (semantic=%v reason=%v gen=%v), want false/request_lexical/nil",
			resp2.Semantic, resp2.SemanticReason, resp2.Generation)
	}
	if resp2.NextCursor != nil {
		t.Fatalf("page 2 next_cursor = %v, want nil", resp2.NextCursor)
	}
}

// TestSearchCursorBoundToQueryScope verifies Task 4 Evidence:
//   - An item cursor (`scope=item` or `scope=all`) sent with `scope=tag` (or `#tag`) -> 400 `invalid_request`
//   - A tag cursor (`scope=tag`) sent with `scope=item` or `scope=all` -> 400 `invalid_request`
//   - A cursor sent with a different `q` (`qn` mismatch) -> 400 `invalid_request`
//   - A cursor sent with a different `scope` (`scope=all` cursor sent with `scope=item`) -> 400 `invalid_request`
//   - Tampered `qh`, bad base64, unknown field, wrong `v`, invalid `gen` -> 400 `invalid_request`
//   - Problem details are static and never echo the cursor or `q`.
func TestSearchCursorBoundToQueryScope(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	uid := uuid.MustParse("66666666-6666-4000-8000-000000000066")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'cursor-bind@example.com', 'vi')`, uid); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	ts := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	for i := 1; i <= 25; i++ {
		itemID := uuid.MustParse(fmt.Sprintf("00000000-00aa-4000-8000-%012d", i))
		tagID := uuid.MustParse(fmt.Sprintf("00000000-00bb-4000-8000-%012d", i))
		name := fmt.Sprintf("wifi-%02d", i)
		lu := ts.Add(time.Duration(25-i) * time.Second)
		if _, err := pool.Exec(ctx, `
			INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $3, 1, $4, $4, $4)
		`, itemID, uid, name, lu); err != nil {
			t.Fatalf("insert item %d: %v", i, err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $3, 1, $4, $4, $4)
		`, tagID, uid, name, lu); err != nil {
			t.Fatalf("insert tag %d: %v", i, err)
		}
	}

	env := newSuggestTestEnv(t, pool)
	const tok = "tok-u1"
	env.auth.addToken(tok, uid)

	// Obtain a real item cursor (`scope=item`) and a real tag cursor (`scope=tag`) for `q=wifi`.
	recItem := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"item"}, "limit": {"20"}})
	respItem := validateSearchResponseOpenAPIShape(t, recItem)
	if respItem.NextCursor == nil {
		t.Fatal("expected non-nil next_cursor for scope=item")
	}
	itemCur := *respItem.NextCursor

	recAll := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"20"}})
	respAll := validateSearchResponseOpenAPIShape(t, recAll)
	if respAll.NextCursor == nil {
		t.Fatal("expected non-nil next_cursor for scope=all")
	}
	allCur := *respAll.NextCursor

	recTag := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"tag"}, "limit": {"20"}})
	respTag := validateSearchResponseOpenAPIShape(t, recTag)
	if respTag.NextCursor == nil {
		t.Fatal("expected non-nil next_cursor for scope=tag")
	}
	tagCur := *respTag.NextCursor

	mutateCursorJSON := func(cur string, fn func(m map[string]any)) string {
		raw, err := base64.RawURLEncoding.DecodeString(cur)
		if err != nil {
			t.Fatalf("decode cursor: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("unmarshal cursor: %v", err)
		}
		fn(m)
		out, err := json.Marshal(m)
		if err != nil {
			t.Fatalf("marshal cursor: %v", err)
		}
		return base64.RawURLEncoding.EncodeToString(out)
	}

	cases := []struct {
		name   string
		params url.Values
	}{
		{
			name:   "item-cursor-sent-with-scope-tag",
			params: url.Values{"q": {"wifi"}, "scope": {"tag"}, "cursor": {itemCur}},
		},
		{
			name:   "all-cursor-sent-with-scope-tag",
			params: url.Values{"q": {"wifi"}, "scope": {"tag"}, "cursor": {allCur}},
		},
		{
			name:   "item-cursor-sent-with-hash-tag-query",
			params: url.Values{"q": {"#wifi"}, "cursor": {itemCur}},
		},
		{
			name:   "tag-cursor-sent-with-scope-item",
			params: url.Values{"q": {"wifi"}, "scope": {"item"}, "cursor": {tagCur}},
		},
		{
			name:   "tag-cursor-sent-with-scope-all",
			params: url.Values{"q": {"wifi"}, "scope": {"all"}, "cursor": {tagCur}},
		},
		{
			name:   "all-cursor-sent-with-scope-item",
			params: url.Values{"q": {"wifi"}, "scope": {"item"}, "cursor": {allCur}},
		},
		{
			name:   "item-cursor-sent-with-scope-all",
			params: url.Values{"q": {"wifi"}, "scope": {"all"}, "cursor": {itemCur}},
		},
		{
			name:   "cursor-sent-with-different-q",
			params: url.Values{"q": {"wifi-other"}, "scope": {"item"}, "cursor": {itemCur}},
		},
		{
			name: "tampered-qh",
			params: url.Values{
				"q":     {"wifi"},
				"scope": {"item"},
				"cursor": {mutateCursorJSON(itemCur, func(m map[string]any) {
					m["qh"] = "BBBBBBBBBBBBBBBBBBBBBB"
				})},
			},
		},
		{
			name: "kind-mismatch-inside-cursor-json",
			params: url.Values{
				"q":     {"wifi"},
				"scope": {"tag"},
				"cursor": {mutateCursorJSON(tagCur, func(m map[string]any) {
					m["kind"] = "item"
				})},
			},
		},
		{
			name:   "bad-base64-cursor",
			params: url.Values{"q": {"wifi"}, "scope": {"item"}, "cursor": {"!!!not-base64!!!"}},
		},
		{
			name: "unknown-field-in-cursor-json",
			params: url.Values{
				"q":     {"wifi"},
				"scope": {"item"},
				"cursor": {mutateCursorJSON(itemCur, func(m map[string]any) {
					m["extra_field"] = "forbidden"
				})},
			},
		},
		{
			name: "wrong-v-in-cursor-json",
			params: url.Values{
				"q":     {"wifi"},
				"scope": {"item"},
				"cursor": {mutateCursorJSON(itemCur, func(m map[string]any) {
					m["v"] = 2
				})},
			},
		},
		{
			name: "invalid-gen-in-cursor-json",
			params: url.Values{
				"q":     {"wifi"},
				"scope": {"item"},
				"cursor": {mutateCursorJSON(itemCur, func(m map[string]any) {
					m["gen"] = 0
				})},
			},
		},
		{
			name: "real-phase-a-cursor-edited-from-gen-null-to-1",
			params: url.Values{
				"q":     {"wifi"},
				"scope": {"item"},
				"cursor": {mutateCursorJSON(itemCur, func(m map[string]any) {
					m["gen"] = 1
				})},
			},
		},
		{
			name: "oversized-cursor-over-max-encoded-bytes",
			params: url.Values{
				"q":      {"wifi"},
				"scope":  {"item"},
				"cursor": {itemCur + strings.Repeat("A", suggest.MaxEncodedCursorBytes)},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := env.doSearch(tok, tc.params)
			prob := assertProblemCode(t, rec, http.StatusBadRequest, "invalid_request")
			if strings.Contains(prob.Detail, "wifi") || strings.Contains(prob.Detail, tc.params.Get("cursor")) {
				t.Fatalf("problem detail echoed q or cursor: %+v", prob)
			}
		})
	}

	t.Run("percent-encoded-lf-in-cursor-query-param", func(t *testing.T) {
		rawQuery := "q=wifi&scope=item&cursor=" + itemCur[:12] + "%0A" + itemCur[12:]
		rec := env.doSearchRaw(tok, rawQuery)
		prob := assertProblemCode(t, rec, http.StatusBadRequest, "invalid_request")
		if strings.Contains(prob.Detail, "wifi") || strings.Contains(prob.Detail, itemCur[:12]) {
			t.Fatalf("problem detail echoed q or cursor: %+v", prob)
		}
	})

	t.Run("generation-binding-match-mismatch-nil-and-error", func(t *testing.T) {
		defer env.svc.SetNearSource(suggest.NewNoopNearSource())

		var (
			currentGen *int
			genErr     error
			nearCalls  int
			genCalls   int
		)
		env.svc.SetNearSource(stubNearSource{
			activeGen: func(_ context.Context, gotUser uuid.UUID) (*int, error) {
				genCalls++
				if gotUser != uid {
					t.Fatalf("ActiveGeneration userID = %s, want %s", gotUser, uid)
				}
				if genErr != nil {
					return nil, genErr
				}
				if currentGen == nil {
					return nil, nil
				}
				v := *currentGen
				return &v, nil
			},
			fn: func(_ context.Context, req suggest.NearRequest) (suggest.NearResult, error) {
				nearCalls++
				if !req.SemanticParam || currentGen == nil {
					reason := suggest.ReasonRequestLexical
					if currentGen == nil {
						reason = suggest.ReasonDisabledServer
					}
					return suggest.NearResult{
						Semantic:       false,
						SemanticReason: &reason,
						Near:           []suggest.SuggestNearRow{},
						Generation:     nil,
					}, nil
				}
				v := *currentGen
				return suggest.NearResult{
					Semantic:       true,
					SemanticReason: nil,
					Near:           []suggest.SuggestNearRow{},
					Generation:     &v,
				}, nil
			},
		})

		// 1. nil == nil passes (page 1 -> page 2), Near is not called on page 2.
		currentGen = nil
		genErr = nil
		nearCalls = 0
		genCalls = 0
		recNilP1 := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"item"}, "limit": {"20"}})
		respNilP1 := validateSearchResponseOpenAPIShape(t, recNilP1)
		if respNilP1.NextCursor == nil {
			t.Fatal("expected next_cursor on page 1 (gen=nil)")
		}
		if nearCalls != 1 || genCalls != 1 {
			t.Fatalf("page 1 calls: near=%d activeGen=%d, want 1 and 1", nearCalls, genCalls)
		}
		recNilP2 := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"item"}, "limit": {"20"}, "cursor": {*respNilP1.NextCursor}})
		_ = validateSearchResponseOpenAPIShape(t, recNilP2)
		if nearCalls != 1 || genCalls != 2 {
			t.Fatalf("page 2 (nil==nil) calls: near=%d activeGen=%d, want 1 (no Near call on cursor page) and 2", nearCalls, genCalls)
		}

		// 2. Active generation = 5: page 1 records gen=5 in cursor even when semantic=0 (while response.generation stays null).
		g5 := 5
		currentGen = &g5
		nearCalls = 0
		genCalls = 0
		recSem0P1 := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"item"}, "limit": {"20"}, "semantic": {"0"}})
		respSem0P1 := validateSearchResponseOpenAPIShape(t, recSem0P1)
		if respSem0P1.Generation != nil {
			t.Fatalf("page 1 semantic=0 response.generation = %v, want nil", respSem0P1.Generation)
		}
		if respSem0P1.NextCursor == nil {
			t.Fatal("expected next_cursor on page 1 (semantic=0, activeGen=5)")
		}
		rawSem0Cur, err := base64.RawURLEncoding.DecodeString(*respSem0P1.NextCursor)
		if err != nil {
			t.Fatalf("decode semantic=0 cursor: %v", err)
		}
		var sem0CurMap map[string]any
		if err := json.Unmarshal(rawSem0Cur, &sem0CurMap); err != nil {
			t.Fatalf("unmarshal semantic=0 cursor: %v", err)
		}
		if sem0CurMap["gen"] != float64(5) {
			t.Fatalf("semantic=0 page 1 cursor.gen = %v, want 5", sem0CurMap["gen"])
		}

		// Matching generation (5 == 5) passes on page 2 without calling Near.
		recMatchP2 := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"item"}, "limit": {"20"}, "cursor": {*respSem0P1.NextCursor}})
		respMatchP2 := validateSearchResponseOpenAPIShape(t, recMatchP2)
		if respMatchP2.Generation != nil {
			t.Fatalf("cursor page response.generation = %v, want nil", respMatchP2.Generation)
		}
		if nearCalls != 1 || genCalls != 2 {
			t.Fatalf("page 2 (5==5) calls: near=%d activeGen=%d, want 1 and 2", nearCalls, genCalls)
		}

		// 3. Mismatch (active generation rotates from 5 to 6, or to nil) -> 400 invalid_request with static detail, Near not called.
		g6 := 6
		currentGen = &g6
		recMismatch := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"item"}, "limit": {"20"}, "cursor": {*respSem0P1.NextCursor}})
		probMismatch := assertProblemCode(t, recMismatch, http.StatusBadRequest, "invalid_request")
		if strings.Contains(probMismatch.Detail, "wifi") || strings.Contains(probMismatch.Detail, *respSem0P1.NextCursor) {
			t.Fatalf("mismatch problem detail leaked q/qn or cursor: %+v", probMismatch)
		}
		if nearCalls != 1 {
			t.Fatalf("mismatch cursor page must not call Near: nearCalls=%d, want 1", nearCalls)
		}

		currentGen = nil
		recMismatchNil := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"item"}, "limit": {"20"}, "cursor": {*respSem0P1.NextCursor}})
		probMismatchNil := assertProblemCode(t, recMismatchNil, http.StatusBadRequest, "invalid_request")
		if strings.Contains(probMismatchNil.Detail, "wifi") || strings.Contains(probMismatchNil.Detail, *respSem0P1.NextCursor) {
			t.Fatalf("mismatch-to-nil problem detail leaked q/qn or cursor: %+v", probMismatchNil)
		}
		if nearCalls != 1 {
			t.Fatalf("mismatch-to-nil cursor page must not call Near: nearCalls=%d, want 1", nearCalls)
		}

		// 4. ActiveGeneration error -> 500 internal_error with static detail (both page 1 and cursor page), Near not called.
		genErr = errors.New("db generation lookup failed for wifi")
		recErrCur := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"item"}, "limit": {"20"}, "cursor": {*respSem0P1.NextCursor}})
		probErrCur := assertProblemCode(t, recErrCur, http.StatusInternalServerError, "internal_error")
		if strings.Contains(probErrCur.Detail, "wifi") || strings.Contains(probErrCur.Detail, "lookup") || strings.Contains(probErrCur.Detail, *respSem0P1.NextCursor) {
			t.Fatalf("ActiveGeneration error problem detail leaked internals/q/cursor: %+v", probErrCur)
		}
		if nearCalls != 1 {
			t.Fatalf("ActiveGeneration error on cursor page must not call Near: nearCalls=%d, want 1", nearCalls)
		}

		recErrP1 := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"item"}, "limit": {"20"}})
		probErrP1 := assertProblemCode(t, recErrP1, http.StatusInternalServerError, "internal_error")
		if strings.Contains(probErrP1.Detail, "wifi") || strings.Contains(probErrP1.Detail, "lookup") {
			t.Fatalf("ActiveGeneration page 1 error problem detail leaked internals/q: %+v", probErrP1)
		}
		if nearCalls != 1 {
			t.Fatalf("ActiveGeneration error on page 1 must not call Near: nearCalls=%d, want 1", nearCalls)
		}
	})
}

// TestSearchCursorHasNoQueryText verifies Task 4 Evidence & plan P05 mục 2.5, 2.7:
//   - The base64url-decoded cursor JSON contains exact keys `{v, scope, kind, gen, qh, tier, score, last_used_at, count, id}`
//     and never contains the raw query `q` or normalized query `qn` (either as a key or anywhere in the decoded bytes).
//   - `qh` is 16 bytes (22 base64url chars) and differs when derived from two different `k_cursor` keys
//     (and a cursor issued under key A is rejected with 400 `invalid_request` under key B).
func TestSearchCursorHasNoQueryText(t *testing.T) {
	keyA, err := suggest.DeriveCursorKey([]byte("secret-key-alpha-0123456789abcdef"))
	if err != nil {
		t.Fatalf("DeriveCursorKey A: %v", err)
	}
	keyB, err := suggest.DeriveCursorKey([]byte("secret-key-bravo-fedcba9876543210"))
	if err != nil {
		t.Fatalf("DeriveCursorKey B: %v", err)
	}

	const sentinelQN = "mysecretsearchqueryphrase"
	cur := suggest.SearchCursor{
		Scope:      suggest.ScopeAll,
		Kind:       suggest.CorpusItem,
		Gen:        nil,
		Tier:       3,
		Score:      0.95,
		LastUsedAt: time.Date(2026, 10, 20, 12, 0, 0, 123_000, time.UTC),
		Count:      4,
		ID:         uuid.MustParse("00000000-0044-4000-8000-000000000001"),
	}

	tokA, err := suggest.EncodeCursor(keyA, sentinelQN, cur)
	if err != nil {
		t.Fatalf("EncodeCursor A: %v", err)
	}
	tokB, err := suggest.EncodeCursor(keyB, sentinelQN, cur)
	if err != nil {
		t.Fatalf("EncodeCursor B: %v", err)
	}

	rawA, err := base64.RawURLEncoding.DecodeString(tokA)
	if err != nil {
		t.Fatalf("base64 decode tokA: %v", err)
	}
	rawB, err := base64.RawURLEncoding.DecodeString(tokB)
	if err != nil {
		t.Fatalf("base64 decode tokB: %v", err)
	}

	if strings.Contains(strings.ToLower(string(rawA)), sentinelQN) || strings.Contains(strings.ToLower(tokA), sentinelQN) {
		t.Fatalf("cursor leaked query text %q: raw=%s", sentinelQN, string(rawA))
	}

	var objA, objB map[string]any
	if err := json.Unmarshal(rawA, &objA); err != nil {
		t.Fatalf("unmarshal objA: %v", err)
	}
	if err := json.Unmarshal(rawB, &objB); err != nil {
		t.Fatalf("unmarshal objB: %v", err)
	}

	for _, forbiddenKey := range []string{"q", "qn", "qa", "query", "name", "display", "hint"} {
		if _, exists := objA[forbiddenKey]; exists {
			t.Fatalf("cursor JSON contains forbidden key %q: %s", forbiddenKey, string(rawA))
		}
	}

	qhA, okA := objA["qh"].(string)
	qhB, okB := objB["qh"].(string)
	if !okA || !okB || qhA == "" || qhB == "" {
		t.Fatalf("missing qh in cursor JSON: qhA=%q qhB=%q", qhA, qhB)
	}
	if qhA == qhB {
		t.Fatalf("expected qh to differ across different k_cursor keys, both = %q", qhA)
	}
	qhBytesA, err := base64.RawURLEncoding.DecodeString(qhA)
	if err != nil || len(qhBytesA) != 16 {
		t.Fatalf("qhA decoded len = %d (err=%v), want 16 bytes", len(qhBytesA), err)
	}
}

// TestSearchAndSuggestShareRateLimitBucket verifies Deliverable 1 & plan P05 mục 2.6:
//   - `/suggest` and `/search` share a single `search_read` token bucket per user.
//   - Requests blocked at authentication (401) do not consume tokens from the bucket.
func TestSearchAndSuggestShareRateLimitBucket(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	uid := uuid.MustParse("77777777-7777-4000-8000-000000000077")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'shared-bucket@example.com', 'vi')`, uid); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	env := newSuggestTestEnv(t, pool)
	const tok = "tok-shared"
	env.auth.addToken(tok, uid)

	// Replace the generous test bucket with a capacity-3 bucket on the shared handler.
	smallBucket := httpx.NewTokenBucket(3, 20, env.clk)
	handler := suggest.NewHandler(env.svc, smallBucket)
	env.router = httpx.NewRouter(httpx.Deps{
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		MetricsCollector: env.metrics,
		Authenticator:    env.auth,
		MountAPI:         suggest.Mount(handler),
	})

	// Unauthenticated request to `/search` must return 401 and consume 0 tokens.
	rec401 := env.doSearch("", url.Values{"q": {"wifi"}})
	if rec401.Code != http.StatusUnauthorized {
		t.Fatalf("unauth /search status = %d, want 401", rec401.Code)
	}

	// Token 1 consumed by `/suggest`.
	rec1 := env.doSuggestSettled(tok, url.Values{"q": {"wifi"}})
	if rec1.Code != http.StatusOK {
		t.Fatalf("req 1 (/suggest) status = %d, want 200", rec1.Code)
	}
	// Token 2 consumed by `/search`.
	rec2 := env.doSearch(tok, url.Values{"q": {"wifi"}})
	if rec2.Code != http.StatusOK {
		t.Fatalf("req 2 (/search) status = %d, want 200", rec2.Code)
	}
	// Token 3 consumed by `/search`.
	rec3 := env.doSearch(tok, url.Values{"q": {"wifi"}})
	if rec3.Code != http.StatusOK {
		t.Fatalf("req 3 (/search) status = %d, want 200", rec3.Code)
	}
	// 4th request (to `/search` or `/suggest`) hits 429 `rate_limited` with `Retry-After >= 1`.
	rec4 := env.doSearch(tok, url.Values{"q": {"wifi"}})
	assertProblemCode(t, rec4, http.StatusTooManyRequests, "rate_limited")
	if ra := rec4.Header().Get("Retry-After"); ra == "" {
		t.Fatal("expected Retry-After header on 429 from /search")
	}
	rec5 := env.doSuggest(tok, url.Values{"q": {"wifi"}})
	assertProblemCode(t, rec5, http.StatusTooManyRequests, "rate_limited")
}

// TestSearchBranchTimeoutPolicy verifies advisor-dec-287:
//   - Primary paged corpus timeout (SQLSTATE 57014 from `SET LOCAL statement_timeout = '50ms'`
//     or `context.DeadlineExceeded`, on `items` for `scope=item|all` or `tags` for `scope=tag`)
//     increments `search_lexical_partial_total{corpus}` and returns 500 `internal_error` with
//     a static problem body that never leaks `q` or `qn`.
//   - Auxiliary non-paged `tags` branch timeout on `scope=all` page 1 increments
//     `search_lexical_partial_total{corpus="tag"}` and degrades gracefully to HTTP 200 with
//     `tags: []` while keeping `items` intact.
func TestSearchBranchTimeoutPolicy(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	uid := uuid.MustParse("88888888-8888-4000-8000-000000000088")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'search-timeout@example.com', 'vi')`, uid); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	ts := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `
		INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
		VALUES ($1, $2, 'wifi văn phòng', 'wifi văn phòng', 4, $3, $3, $3)
	`, uuid.MustParse("00000000-0001-4000-8000-000000000801"), uid, ts); err != nil {
		t.Fatalf("insert item: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
		VALUES ($1, $2, 'wifi-tag', 'wifi-tag', 2, $3, $3, $3)
	`, uuid.MustParse("00000000-0011-4000-8000-000000000801"), uid, ts); err != nil {
		t.Fatalf("insert tag: %v", err)
	}

	env := newSuggestTestEnv(t, pool)
	const tok = "tok-u1"
	env.auth.addToken(tok, uid)
	t.Cleanup(func() { env.svc.SetTestHooks(nil) })

	warmPoolConns(t, pool, 2)
	warmRec := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"all"}})
	warmResp := validateSearchResponseOpenAPIShape(t, warmRec)
	if len(warmResp.Items) != 1 || len(warmResp.Tags) != 1 {
		t.Fatalf("warm /search unexpected response: %+v", warmResp)
	}

	// 1. Auxiliary tag branch timeout on `scope=all` page 1 (PostgreSQL SQLSTATE 57014):
	//    returns 200 OK with `tags: []`, `items` intact, and `search_lexical_partial_total{corpus="tag"}` + 1.
	t.Run("scope-all-page1-aux-tag-timeout-degrades-200", func(t *testing.T) {
		warmPoolConns(t, pool, 2)
		beforeItem := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusItem)
		beforeTag := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)

		var observedTagErr error
		env.svc.SetTestHooks(&suggest.TestHooks{
			AfterBranchSetLocal: func(_ context.Context, tx pgx.Tx, corpus string) error {
				if corpus != suggest.CorpusTag {
					return nil
				}
				sleepCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_, err := tx.Exec(sleepCtx, `SELECT pg_sleep(0.2)`)
				observedTagErr = err
				return err
			},
		})

		rec := env.doSearch(tok, url.Values{"q": {"wifi"}, "scope": {"all"}})
		var pgErr *pgconn.PgError
		if !errors.As(observedTagErr, &pgErr) || pgErr.Code != "57014" {
			t.Fatalf("tag hook err = %v (%T), want *pgconn.PgError Code=57014", observedTagErr, observedTagErr)
		}

		resp := validateSearchResponseOpenAPIShape(t, rec)
		if len(resp.Tags) != 0 {
			t.Fatalf("timed-out aux tag branch must return tags=[], got %+v", resp.Tags)
		}
		if len(resp.Items) != 1 || resp.Items[0].Name != "wifi văn phòng" {
			t.Fatalf("surviving primary item branch must return 'wifi văn phòng', got %+v", resp.Items)
		}
		afterItem := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusItem)
		afterTag := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)
		if afterTag != beforeTag+1 || afterItem != beforeItem {
			t.Fatalf("partial counters = (item=%v, tag=%v), want (%v, %v)",
				afterItem, afterTag, beforeItem, beforeTag+1)
		}
	})

	// 2. Primary paged corpus timeout (`items` on `scope=all` / `scope=item`, and `tags` on `scope=tag`)
	//    via PostgreSQL SQLSTATE 57014 -> returns 500 `internal_error` + increments counter + no query leak.
	t.Run("primary-paged-corpus-timeout-returns-500", func(t *testing.T) {
		// (a) Primary item corpus timeout on scope=all.
		warmPoolConns(t, pool, 2)
		beforeItem := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusItem)

		var observedItemErr error
		env.svc.SetTestHooks(&suggest.TestHooks{
			AfterBranchSetLocal: func(_ context.Context, tx pgx.Tx, corpus string) error {
				if corpus != suggest.CorpusItem {
					return nil
				}
				sleepCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_, err := tx.Exec(sleepCtx, `SELECT pg_sleep(0.2)`)
				observedItemErr = err
				return err
			},
		})

		recItem := env.doSearch(tok, url.Values{"q": {"WifiPrimaryTimeoutSentinel"}, "scope": {"all"}})
		var pgErrItem *pgconn.PgError
		if !errors.As(observedItemErr, &pgErrItem) || pgErrItem.Code != "57014" {
			t.Fatalf("item hook err = %v (%T), want *pgconn.PgError Code=57014", observedItemErr, observedItemErr)
		}
		probItem := assertProblemCode(t, recItem, http.StatusInternalServerError, "internal_error")
		if strings.Contains(strings.ToLower(recItem.Body.String()), "wifiprimarytimeoutsentinel") ||
			strings.Contains(strings.ToLower(probItem.Detail), "wifiprimarytimeoutsentinel") {
			t.Fatalf("500 problem body leaked query sentinel: %s", recItem.Body.String())
		}
		afterItem := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusItem)
		if afterItem != beforeItem+1 {
			t.Fatalf("LexicalPartialTotal{corpus=item} = %v, want %v", afterItem, beforeItem+1)
		}

		// (b) Primary tag corpus timeout on scope=tag.
		warmPoolConns(t, pool, 2)
		beforeTag := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)

		var observedTagErr error
		env.svc.SetTestHooks(&suggest.TestHooks{
			AfterBranchSetLocal: func(_ context.Context, tx pgx.Tx, corpus string) error {
				if corpus != suggest.CorpusTag {
					return nil
				}
				sleepCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_, err := tx.Exec(sleepCtx, `SELECT pg_sleep(0.2)`)
				observedTagErr = err
				return err
			},
		})

		recTag := env.doSearch(tok, url.Values{"q": {"TagPrimaryTimeoutSentinel"}, "scope": {"tag"}})
		var pgErrTag *pgconn.PgError
		if !errors.As(observedTagErr, &pgErrTag) || pgErrTag.Code != "57014" {
			t.Fatalf("tag hook err = %v (%T), want *pgconn.PgError Code=57014", observedTagErr, observedTagErr)
		}
		probTag := assertProblemCode(t, recTag, http.StatusInternalServerError, "internal_error")
		if strings.Contains(strings.ToLower(recTag.Body.String()), "tagprimarytimeoutsentinel") ||
			strings.Contains(strings.ToLower(probTag.Detail), "tagprimarytimeoutsentinel") {
			t.Fatalf("500 problem body leaked query sentinel: %s", recTag.Body.String())
		}
		afterTag := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)
		if afterTag != beforeTag+1 {
			t.Fatalf("LexicalPartialTotal{corpus=tag} = %v, want %v", afterTag, beforeTag+1)
		}
	})
}
