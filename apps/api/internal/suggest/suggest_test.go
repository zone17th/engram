package suggest_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

type suggestTestEnv struct {
	t       *testing.T
	pool    *pgxpool.Pool
	clk     *clock.Fixed
	reg     *prometheus.Registry
	metrics *obs.Metrics
	bucket  *httpx.TokenBucket
	svc     *suggest.Service
	handler *suggest.Handler
	router  http.Handler
	auth    *suggestTestAuth
}

type suggestTestAuth struct {
	mu      sync.Mutex
	cookies map[string]authctx.Principal
}

func (a *suggestTestAuth) Authenticate(_ context.Context, access string) (authctx.Principal, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if p, ok := a.cookies[access]; ok {
		return p, nil
	}
	return authctx.Principal{}, &httpx.AuthError{Code: "unauthenticated"}
}

func (a *suggestTestAuth) addToken(token string, userID uuid.UUID) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cookies == nil {
		a.cookies = make(map[string]authctx.Principal)
	}
	a.cookies[token] = authctx.Principal{
		UserID:    userID,
		SessionID: uuid.New(),
	}
}

func newSuggestTestEnv(t *testing.T, pool *pgxpool.Pool) *suggestTestEnv {
	t.Helper()
	clk := clock.NewFixed(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	reg, metrics := obs.NewRegistry()
	cursorKey, err := suggest.DeriveCursorKey([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("DeriveCursorKey: %v", err)
	}
	// Use a generous token bucket in functional suggest tests; rate-limit 429 is tested
	// specifically in TestTokenBucketBurst40Rate20 and TestSuggestNeverLogsQuery.
	bucket := httpx.NewTokenBucket(10_000, 10_000, clk)
	svc := suggest.NewService(pool, clk, suggest.NewNoopNearSource(), metrics, cursorKey)
	handler := suggest.NewHandler(svc, bucket)
	auth := &suggestTestAuth{cookies: make(map[string]authctx.Principal)}

	router := httpx.NewRouter(httpx.Deps{
		MetricsCollector: metrics,
		Authenticator:    auth,
		MountAPI:         suggest.Mount(handler),
	})

	return &suggestTestEnv{
		t:       t,
		pool:    pool,
		clk:     clk,
		reg:     reg,
		metrics: metrics,
		bucket:  bucket,
		svc:     svc,
		handler: handler,
		router:  router,
		auth:    auth,
	}
}

func (e *suggestTestEnv) doSuggestRaw(token string, rawQuery string) *httptest.ResponseRecorder {
	e.t.Helper()
	target := "/api/v1/suggest"
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

func (e *suggestTestEnv) doSuggest(token string, params url.Values) *httptest.ResponseRecorder {
	e.t.Helper()
	var raw string
	if params != nil {
		raw = params.Encode()
	}
	return e.doSuggestRaw(token, raw)
}

// validateSuggestResponseOpenAPIShape strictly validates the raw JSON bytes of a 200
// `/suggest` response against the frozen OpenAPI schemas `SuggestResponse`,
// `SuggestQuota`, `SuggestTag`, `SuggestItem`, `TagRef`, `SuggestNearRow`,
// `SuggestMode`, `SuggestMatch`, and `SemanticReason`.
func validateSuggestResponseOpenAPIShape(t testing.TB, rec *httptest.ResponseRecorder) suggest.SuggestResponse {
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

	// 1. Validate raw JSON top-level and nested object keys (additionalProperties: false,
	// required fields present, non-null arrays, enum values, no hint/q/qn/cos fields).
	var rawObj map[string]any
	if err := json.Unmarshal(rawBytes, &rawObj); err != nil {
		t.Fatalf("unmarshal raw JSON object: %v\nbody=%s", err, string(rawBytes))
	}
	wantTopKeys := []string{
		"generation",
		"has_more",
		"items",
		"lexical_partial",
		"limit",
		"mode",
		"near",
		"quota",
		"scope",
		"semantic",
		"semantic_reason",
		"tags",
	}
	gotTopKeys := make([]string, 0, len(rawObj))
	for k := range rawObj {
		gotTopKeys = append(gotTopKeys, k)
	}
	slices.Sort(gotTopKeys)
	if !slices.Equal(gotTopKeys, wantTopKeys) {
		t.Fatalf("SuggestResponse top-level keys = %v, want exact %v", gotTopKeys, wantTopKeys)
	}

	// Non-nullable array fields must never be JSON null.
	for _, arrField := range []string{"tags", "items", "lexical_partial", "near"} {
		if rawObj[arrField] == nil {
			t.Fatalf("SuggestResponse.%s is JSON null, must be array []", arrField)
		}
		if _, ok := rawObj[arrField].([]any); !ok {
			t.Fatalf("SuggestResponse.%s is not a JSON array: %T", arrField, rawObj[arrField])
		}
	}

	// Quota object keys.
	quotaMap, ok := rawObj["quota"].(map[string]any)
	if !ok {
		t.Fatalf("SuggestResponse.quota is not an object: %T", rawObj["quota"])
	}
	wantQuotaKeys := []string{"lexical", "near", "tag"}
	gotQuotaKeys := make([]string, 0, len(quotaMap))
	for k := range quotaMap {
		gotQuotaKeys = append(gotQuotaKeys, k)
	}
	slices.Sort(gotQuotaKeys)
	if !slices.Equal(gotQuotaKeys, wantQuotaKeys) {
		t.Fatalf("SuggestQuota keys = %v, want exact %v", gotQuotaKeys, wantQuotaKeys)
	}

	// Validate each tag and item object in `tags`, `items`, and `near`.
	for i, elem := range rawObj["tags"].([]any) {
		m, ok := elem.(map[string]any)
		if !ok {
			t.Fatalf("tags[%d] not an object", i)
		}
		validateSuggestTagMap(t, fmt.Sprintf("tags[%d]", i), m, false)
	}
	for i, elem := range rawObj["items"].([]any) {
		m, ok := elem.(map[string]any)
		if !ok {
			t.Fatalf("items[%d] not an object", i)
		}
		validateSuggestItemMap(t, fmt.Sprintf("items[%d]", i), m, false)
	}
	for i, elem := range rawObj["near"].([]any) {
		m, ok := elem.(map[string]any)
		if !ok {
			t.Fatalf("near[%d] not an object", i)
		}
		switch m["kind"] {
		case "tag":
			validateSuggestTagMap(t, fmt.Sprintf("near[%d]", i), m, true)
		case "item":
			validateSuggestItemMap(t, fmt.Sprintf("near[%d]", i), m, true)
		default:
			t.Fatalf("near[%d] has invalid discriminator kind=%v", i, m["kind"])
		}
	}

	// 2. Decode into typed SuggestResponse with DisallowUnknownFields.
	var resp suggest.SuggestResponse
	dec := json.NewDecoder(bytes.NewReader(rawBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&resp); err != nil {
		t.Fatalf("strict decode SuggestResponse: %v\nbody=%s", err, string(rawBytes))
	}

	if !suggest.ValidSuggestScope(resp.Scope) {
		t.Fatalf("invalid scope %q", resp.Scope)
	}
	if !suggest.ValidSuggestLimit(resp.Limit) {
		t.Fatalf("invalid limit %d", resp.Limit)
	}
	switch resp.Mode {
	case suggest.ModeRecent, suggest.ModePrefix, suggest.ModeFull:
	default:
		t.Fatalf("invalid mode %q", resp.Mode)
	}
	if resp.Semantic {
		if resp.SemanticReason != nil {
			t.Fatalf("semantic=true must have semantic_reason=null, got %q", *resp.SemanticReason)
		}
	} else {
		if resp.SemanticReason == nil {
			t.Fatal("semantic=false must have non-null semantic_reason")
		}
		switch *resp.SemanticReason {
		case suggest.ReasonDisabledServer,
			suggest.ReasonDisabledUser,
			suggest.ReasonDegraded,
			suggest.ReasonRequestLexical,
			suggest.ReasonShortQuery:
		default:
			t.Fatalf("invalid semantic_reason %q", *resp.SemanticReason)
		}
		if resp.Generation != nil {
			t.Fatalf("semantic=false must have generation=null, got %v", *resp.Generation)
		}
	}

	return resp
}

func validateSuggestTagMap(t testing.TB, path string, m map[string]any, isNear bool) {
	t.Helper()
	wantKeys := []string{"display", "id", "item_count", "kind", "last_used_at", "match"}
	gotKeys := make([]string, 0, len(m))
	for k := range m {
		gotKeys = append(gotKeys, k)
	}
	slices.Sort(gotKeys)
	if !slices.Equal(gotKeys, wantKeys) {
		t.Fatalf("%s keys = %v, want exact %v", path, gotKeys, wantKeys)
	}
	if m["kind"] != "tag" {
		t.Fatalf("%s.kind = %v, want \"tag\"", path, m["kind"])
	}
	if isNear && m["match"] != suggest.MatchSemantic {
		t.Fatalf("%s.match = %v, want \"semantic\"", path, m["match"])
	}
}

func validateSuggestItemMap(t testing.TB, path string, m map[string]any, isNear bool) {
	t.Helper()
	wantKeys := []string{"created_at", "entry_count", "id", "kind", "last_used_at", "match", "name", "tag_total", "tags"}
	gotKeys := make([]string, 0, len(m))
	for k := range m {
		gotKeys = append(gotKeys, k)
	}
	slices.Sort(gotKeys)
	if !slices.Equal(gotKeys, wantKeys) {
		t.Fatalf("%s keys = %v, want exact %v (must never include hint)", path, gotKeys, wantKeys)
	}
	if m["kind"] != "item" {
		t.Fatalf("%s.kind = %v, want \"item\"", path, m["kind"])
	}
	if isNear && m["match"] != suggest.MatchSemantic {
		t.Fatalf("%s.match = %v, want \"semantic\"", path, m["match"])
	}
	tagsRaw, ok := m["tags"].([]any)
	if !ok {
		t.Fatalf("%s.tags is not a non-null array: %T", path, m["tags"])
	}
	if len(tagsRaw) > 3 {
		t.Fatalf("%s.tags len = %d, maxItems is 3", path, len(tagsRaw))
	}
	for i, tr := range tagsRaw {
		trMap, ok := tr.(map[string]any)
		if !ok {
			t.Fatalf("%s.tags[%d] not an object", path, i)
		}
		wantRefKeys := []string{"display", "id"}
		gotRefKeys := make([]string, 0, len(trMap))
		for k := range trMap {
			gotRefKeys = append(gotRefKeys, k)
		}
		slices.Sort(gotRefKeys)
		if !slices.Equal(gotRefKeys, wantRefKeys) {
			t.Fatalf("%s.tags[%d] keys = %v, want %v", path, i, gotRefKeys, wantRefKeys)
		}
	}
}

func assertProblemCode(t testing.TB, rec *httptest.ResponseRecorder, wantStatus int, wantCode string) httpx.Problem {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, wantStatus, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("problem Cache-Control = %q, want \"no-store\"", cc)
	}
	var prob httpx.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &prob); err != nil {
		t.Fatalf("unmarshal problem: %v; body=%s", err, rec.Body.String())
	}
	if prob.Code != wantCode || prob.Status != wantStatus {
		t.Fatalf("problem = %+v, want status=%d code=%q", prob, wantStatus, wantCode)
	}
	return prob
}

// TestSuggestQueryEdgeCases verifies plan P05 mục 2.2, 3, Task 3:
//   - `!!!` -> 200 empty (mode = prefix)
//   - absent / empty / whitespace-only -> 200 mode = recent
//   - `#` alone (or `#   `) -> 200 empty (scope = tag, mode = prefix)
//   - leading `#token rest` -> forces scope = tag, normalizes first token only
//   - control char / bidi override / bad UTF-8 / q > 200 runes / tag > 50 runes -> 400 `name_invalid`
//   - bad scope / bad limit / bad semantic / unknown param / duplicate param -> 400 `invalid_request`
//   - Note: `/search` with `!!!` -> 400 belongs to Task 4 (W2).
func TestSuggestQueryEdgeCases(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	u1 := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'edge@example.com', 'vi')`, u1); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	ts := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `
		INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
		VALUES ($1, $2, 'wifi nhà', 'wifi nhà', 3, $3, $3, $3)
	`, uuid.MustParse("00000000-0001-4000-8000-000000000001"), u1, ts); err != nil {
		t.Fatalf("insert seed item: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
		VALUES ($1, $2, 'nhà-riêng', 'nhà-riêng', 1, $3, $3, $3)
	`, uuid.MustParse("00000000-0011-4000-8000-000000000001"), u1, ts); err != nil {
		t.Fatalf("insert seed tag: %v", err)
	}

	env := newSuggestTestEnv(t, pool)
	const tok = "tok-u1"
	env.auth.addToken(tok, u1)

	// 1. Punctuation-only `!!!` -> 200 empty, mode=prefix.
	for _, q := range []string{"!!!", "...---...", "   !!!   "} {
		rec := env.doSuggest(tok, url.Values{"q": {q}})
		resp := validateSuggestResponseOpenAPIShape(t, rec)
		if resp.Mode != suggest.ModePrefix || resp.Scope != suggest.ScopeAll {
			t.Fatalf("q=%q: got mode=%q scope=%q, want mode=prefix scope=all", q, resp.Mode, resp.Scope)
		}
		if len(resp.Tags) != 0 || len(resp.Items) != 0 || len(resp.Near) != 0 || resp.HasMore {
			t.Fatalf("q=%q: expected empty arrays and has_more=false, got %+v", q, resp)
		}
	}

	// 2. `#` alone (or `#` followed by whitespace or punctuation-only token) -> 200 empty, scope=tag, mode=prefix.
	for _, q := range []string{"#", "   #", "#   ", "#!!!", "#   wifi"} {
		rec := env.doSuggest(tok, url.Values{"q": {q}})
		resp := validateSuggestResponseOpenAPIShape(t, rec)
		if resp.Scope != suggest.ScopeTag || resp.Mode != suggest.ModePrefix {
			t.Fatalf("q=%q: got scope=%q mode=%q, want scope=tag mode=prefix", q, resp.Scope, resp.Mode)
		}
		if len(resp.Tags) != 0 || len(resp.Items) != 0 {
			t.Fatalf("q=%q: expected empty tags/items, got tags=%d items=%d", q, len(resp.Tags), len(resp.Items))
		}
	}

	// 3. Leading `#` with valid token forces scope=tag (even if scope=item was passed) and strips trailing tokens.
	recHash := env.doSuggest(tok, url.Values{"q": {"  #nhà   ignored-second-token"}, "scope": {"item"}})
	respHash := validateSuggestResponseOpenAPIShape(t, recHash)
	if respHash.Scope != suggest.ScopeTag || respHash.Mode != suggest.ModeFull {
		t.Fatalf("#nhà: got scope=%q mode=%q, want scope=tag mode=full", respHash.Scope, respHash.Mode)
	}
	if len(respHash.Tags) != 1 || respHash.Tags[0].Display != "nhà-riêng" || len(respHash.Items) != 0 {
		t.Fatalf("#nhà: got tags=%+v items=%+v, want 1 tag 'nhà-riêng' and 0 items", respHash.Tags, respHash.Items)
	}

	// 4. Absent `q`, empty `q=""`, or whitespace-only `q="   \u00a0\u3000 "` -> 200 mode=recent.
	for _, vals := range []url.Values{
		{},
		{"q": {""}},
		{"q": {"     "}},
		{"q": {"\u00a0\u2003\u3000"}},
	} {
		rec := env.doSuggest(tok, vals)
		resp := validateSuggestResponseOpenAPIShape(t, rec)
		if resp.Mode != suggest.ModeRecent {
			t.Fatalf("vals=%v: got mode=%q, want recent", vals, resp.Mode)
		}
		if resp.Quota != (suggest.SuggestQuota{Tag: 3, Lexical: 8, Near: 0}) {
			t.Fatalf("recent default quota = %+v, want {Tag:3, Lexical:8, Near:0}", resp.Quota)
		}
		if len(resp.Items) != 1 || len(resp.Tags) != 1 {
			t.Fatalf("recent items=%d tags=%d, want 1 and 1", len(resp.Items), len(resp.Tags))
		}
	}

	// 5. 400 `name_invalid`: control chars, bidi overrides/isolates, invalid UTF-8, q > 200 runes, tag > 50 runes.
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
		rec := env.doSuggest(tok, vals)
		assertProblemCode(t, rec, http.StatusBadRequest, "name_invalid")
	}
	// Invalid UTF-8 bytes in raw query string -> 400 `name_invalid`.
	badUTF8Rec := env.doSuggestRaw(tok, "q=%ff%fe")
	assertProblemCode(t, badUTF8Rec, http.StatusBadRequest, "name_invalid")

	// Boundary checks: exactly 200 runes for item/all and 50 runes for tag must succeed with 200.
	ok200Rec := env.doSuggest(tok, url.Values{"q": {strings.Repeat("a", 200)}})
	validateSuggestResponseOpenAPIShape(t, ok200Rec)
	ok50TagRec := env.doSuggest(tok, url.Values{"q": {"#" + strings.Repeat("t", 50)}})
	validateSuggestResponseOpenAPIShape(t, ok50TagRec)

	// 6. 400 `invalid_request`: bad scope, bad limit, bad semantic, unknown param, duplicate param, malformed query encoding.
	invalidReqQueries := []string{
		"scope=bad",
		"scope=ALL",
		"limit=0",
		"limit=4",
		"limit=6",
		"limit=10",
		"limit=20",
		"limit=abc",
		"limit=-5",
		"semantic=2",
		"semantic=-1",
		"semantic=true",
		"semantic=false",
		"unknown=1",
		"cursor=abc",
		"q=a&q=b",
		"limit=5&limit=8",
		"scope=all&scope=item",
		"semantic=0&semantic=1",
		"q=%ZZ",
	}
	for _, rawQ := range invalidReqQueries {
		rec := env.doSuggestRaw(tok, rawQ)
		assertProblemCode(t, rec, http.StatusBadRequest, "invalid_request")
	}
}

// TestSuggestLexicalCorpusViEn verifies `/suggest` over `packages/search-fixtures/corpus-lexical.json`:
//   - prefix (tier 3 -> `match: "prefix"`)
//   - wrong diacritics / folded prefix (tier 2 -> `match: "prefix_folded"`, incl. full-width `ｗｉｆｉ` -> `wifi`)
//   - `đ` / `Đ` vs `d`
//   - typo >= 5 chars (`pasword` -> `password`, `wiifi` -> `wifi`, `wi-fi` -> `wifi`, tier 1 -> `match: "fuzzy"`)
//   - `#` prefix forcing `scope=tag`
//   - duplicate item names ordered by `last_used_at DESC` + tag refs attached (`<= 3` + `tag_total`)
//   - empty `q` = `mode: "recent"` (`last_used_at DESC, id DESC`)
//   - 1-char `q` = `mode: "prefix"` (prefix-only, `fuzzy = false`)
func TestSuggestLexicalCorpusViEn(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	fx, users := loadAndSeedCorpus(t, ctx, pool)

	// Attach 4 live tags to duplicate-name item `00000000-0001-4000-8000-00000000000b`
	// so `/suggest` also exercises `ListTagRefsForItems` (max 3 TagRefs sorted by display + tag_total=4).
	dupItemID := uuid.MustParse("00000000-0001-4000-8000-00000000000b")
	attachedTagIDs := []uuid.UUID{
		uuid.MustParse("00000000-0011-4000-8000-000000000001"), // wifi-khách
		uuid.MustParse("00000000-0011-4000-8000-000000000002"), // wifi-nhà
		uuid.MustParse("00000000-0011-4000-8000-000000000010"), // gia-đình
		uuid.MustParse("00000000-0011-4000-8000-000000000011"), // công-việc
	}
	for _, tid := range attachedTagIDs {
		if _, err := pool.Exec(ctx, `INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)`, dupItemID, tid); err != nil {
			t.Fatalf("attach tag %s to dup item: %v", tid, err)
		}
	}

	env := newSuggestTestEnv(t, pool)
	env.auth.addToken("tok-u1", users["u1"])
	env.auth.addToken("tok-u2", users["u2"])

	// 1. Run every query case in corpus-lexical.json through GET /api/v1/suggest.
	for _, qc := range fx.Queries {
		t.Run(qc.Name, func(t *testing.T) {
			tok := "tok-" + qc.User
			rec := env.doSuggest(tok, url.Values{
				"q":     {qc.Q},
				"scope": {qc.Scope},
				"limit": {"12"},
			})
			resp := validateSuggestResponseOpenAPIShape(t, rec)
			if resp.Scope != qc.Scope {
				t.Fatalf("scope = %q, want %q", resp.Scope, qc.Scope)
			}

			switch qc.Scope {
			case suggest.ScopeItem:
				if len(resp.Tags) != 0 {
					t.Fatalf("scope=item returned %d tags, want 0", len(resp.Tags))
				}
				if qc.ExpectEmpty {
					if len(resp.Items) != 0 {
						t.Fatalf("expected 0 items for q=%q, got %d", qc.Q, len(resp.Items))
					}
					return
				}
				if len(resp.Items) < len(qc.ExpectTop) {
					t.Fatalf("got %d items, want at least %d", len(resp.Items), len(qc.ExpectTop))
				}
				for i, exp := range qc.ExpectTop {
					got := resp.Items[i]
					if got.ID.String() != exp.ID {
						t.Fatalf("item[%d].ID = %s (%q), want %s (%q)", i, got.ID, got.Name, exp.ID, exp.Name)
					}
					if exp.Name != "" && got.Name != exp.Name {
						t.Fatalf("item[%d].Name = %q, want %q", i, got.Name, exp.Name)
					}
					if got.Match != exp.Match {
						t.Fatalf("item[%d].Match = %q, want %q", i, got.Match, exp.Match)
					}
				}
			case suggest.ScopeTag:
				if len(resp.Items) != 0 {
					t.Fatalf("scope=tag returned %d items, want 0", len(resp.Items))
				}
				if qc.ExpectEmpty {
					if len(resp.Tags) != 0 {
						t.Fatalf("expected 0 tags for q=%q, got %d", qc.Q, len(resp.Tags))
					}
					return
				}
				if len(resp.Tags) < len(qc.ExpectTop) {
					t.Fatalf("got %d tags, want at least %d", len(resp.Tags), len(qc.ExpectTop))
				}
				for i, exp := range qc.ExpectTop {
					got := resp.Tags[i]
					if got.ID.String() != exp.ID {
						t.Fatalf("tag[%d].ID = %s (%q), want %s (%q)", i, got.ID, got.Display, exp.ID, exp.Display)
					}
					if exp.Display != "" && got.Display != exp.Display {
						t.Fatalf("tag[%d].Display = %q, want %q", i, got.Display, exp.Display)
					}
					if got.Match != exp.Match {
						t.Fatalf("tag[%d].Match = %q, want %q", i, got.Match, exp.Match)
					}
				}
			}
		})
	}

	// 2. Duplicate item names include <= 3 tag refs ordered by display and accurate tag_total=4.
	t.Run("duplicate-item-tags-and-tag-total", func(t *testing.T) {
		rec := env.doSuggest("tok-u1", url.Values{"q": {"tài khoản ngân hàng"}, "scope": {"item"}, "limit": {"8"}})
		resp := validateSuggestResponseOpenAPIShape(t, rec)
		if len(resp.Items) < 2 {
			t.Fatalf("expected at least 2 duplicate items, got %d", len(resp.Items))
		}
		first := resp.Items[0]
		if first.ID != dupItemID {
			t.Fatalf("first duplicate item ID = %s, want %s", first.ID, dupItemID)
		}
		if first.TagTotal != 4 || len(first.Tags) != 3 {
			t.Fatalf("first duplicate item TagTotal=%d len(Tags)=%d, want TagTotal=4 len(Tags)=3", first.TagTotal, len(first.Tags))
		}
	})

	// 3. `#` prefix query `#duong` forces scope=tag and returns tier 3 `duong-sat` then tier 2 `đường-bộ`.
	t.Run("hash-prefix-forces-tag-scope", func(t *testing.T) {
		rec := env.doSuggest("tok-u1", url.Values{"q": {"#duong"}})
		resp := validateSuggestResponseOpenAPIShape(t, rec)
		if resp.Scope != suggest.ScopeTag || resp.Mode != suggest.ModeFull {
			t.Fatalf("got scope=%q mode=%q, want scope=tag mode=full", resp.Scope, resp.Mode)
		}
		if len(resp.Items) != 0 || len(resp.Tags) < 2 {
			t.Fatalf("got items=%d tags=%d, want 0 items and >=2 tags", len(resp.Items), len(resp.Tags))
		}
		if resp.Tags[0].Display != "duong-sat" || resp.Tags[0].Match != suggest.MatchPrefix {
			t.Fatalf("tags[0] = %+v, want duong-sat (prefix)", resp.Tags[0])
		}
		if resp.Tags[1].Display != "đường-bộ" || resp.Tags[1].Match != suggest.MatchPrefixFolded {
			t.Fatalf("tags[1] = %+v, want đường-bộ (prefix_folded)", resp.Tags[1])
		}
	})

	// 4. Empty `q` = recent mode (`last_used_at DESC, id DESC`), `has_more = true` on corpus > limit.
	t.Run("empty-q-recent-mode", func(t *testing.T) {
		rec := env.doSuggest("tok-u1", url.Values{"limit": {"8"}})
		resp := validateSuggestResponseOpenAPIShape(t, rec)
		if resp.Mode != suggest.ModeRecent || resp.Scope != suggest.ScopeAll {
			t.Fatalf("got mode=%q scope=%q, want mode=recent scope=all", resp.Mode, resp.Scope)
		}
		if len(resp.Tags) != 3 || len(resp.Items) != 5 || !resp.HasMore {
			t.Fatalf("recent limit=8: got tags=%d items=%d has_more=%v, want tags=3 items=5 has_more=true",
				len(resp.Tags), len(resp.Items), resp.HasMore)
		}
		// Top recent item in corpus-lexical.json for u1 is Tiebreak Alpha `00000000-0001-4000-8000-00000000000d` (2026-10-25T10:00:00Z).
		if resp.Items[0].ID.String() != "00000000-0001-4000-8000-00000000000d" {
			t.Fatalf("recent items[0].ID = %s, want 00000000-0001-4000-8000-00000000000d", resp.Items[0].ID)
		}
	})

	// 5. 1-char `q` = `mode: "prefix"` (prefix-only, no fuzzy matches).
	t.Run("one-char-q-prefix-only", func(t *testing.T) {
		rec := env.doSuggest("tok-u1", url.Values{"q": {"đ"}, "limit": {"8"}})
		resp := validateSuggestResponseOpenAPIShape(t, rec)
		if resp.Mode != suggest.ModePrefix {
			t.Fatalf("1-char q='đ': got mode=%q, want prefix", resp.Mode)
		}
		for i, it := range resp.Items {
			if it.Match == suggest.MatchFuzzy {
				t.Fatalf("1-char prefix mode must not return fuzzy item[%d]: %+v", i, it)
			}
		}
		for i, tg := range resp.Tags {
			if tg.Match == suggest.MatchFuzzy {
				t.Fatalf("1-char prefix mode must not return fuzzy tag[%d]: %+v", i, tg)
			}
		}
	})
}

// TestSuggestUserScope verifies strict per-user isolation and soft-delete exclusion on `/suggest`:
//   - User u1 never sees user u2's items, tags, or tag refs in recent, prefix, or full modes.
//   - Soft-deleted items and soft-deleted tags are excluded from `/suggest`.
func TestSuggestUserScope(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	u1 := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	u2 := uuid.MustParse("22222222-2222-4000-8000-000000000002")
	for _, u := range []struct {
		id    uuid.UUID
		email string
	}{
		{u1, "u1-scope@example.com"},
		{u2, "u2-scope@example.com"},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, $2, 'vi')`, u.id, u.email); err != nil {
			t.Fatalf("insert user %s: %v", u.email, err)
		}
	}

	ts := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	u1LiveItem := uuid.MustParse("00000000-0001-4000-8000-000000000101")
	u1DeletedItem := uuid.MustParse("00000000-0001-4000-8000-000000000102")
	u2LiveItem := uuid.MustParse("00000000-0002-4000-8000-000000000201")

	u1LiveTag := uuid.MustParse("00000000-0011-4000-8000-000000000101")
	u1DeletedTag := uuid.MustParse("00000000-0011-4000-8000-000000000102")
	u2LiveTag := uuid.MustParse("00000000-0022-4000-8000-000000000201")

	if _, err := pool.Exec(ctx, `
		INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at, deleted_at)
		VALUES
			($1, $4, 'Alpha Shared Vault', 'alpha shared vault', 2, $6, $6, $6, NULL),
			($2, $4, 'Alpha Deleted Vault', 'alpha deleted vault', 1, $6, $6, $6, $6),
			($3, $5, 'Alpha Foreign U2 Vault', 'alpha foreign u2 vault', 9, $6, $6, $6, NULL)
	`, u1LiveItem, u1DeletedItem, u2LiveItem, u1, u2, ts); err != nil {
		t.Fatalf("insert items: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at, deleted_at)
		VALUES
			($1, $4, 'alpha-u1-live', 'alpha-u1-live', 1, $6, $6, $6, NULL),
			($2, $4, 'alpha-u1-deleted', 'alpha-u1-deleted', 1, $6, $6, $6, $6),
			($3, $5, 'alpha-u2-foreign', 'alpha-u2-foreign', 5, $6, $6, $6, NULL)
	`, u1LiveTag, u1DeletedTag, u2LiveTag, u1, u2, ts); err != nil {
		t.Fatalf("insert tags: %v", err)
	}

	// Attach u1LiveTag, u1DeletedTag, and cross-tenant u2LiveTag to u1LiveItem.
	for _, tid := range []uuid.UUID{u1LiveTag, u1DeletedTag, u2LiveTag} {
		if _, err := pool.Exec(ctx, `INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)`, u1LiveItem, tid); err != nil {
			t.Fatalf("insert item_tag %s: %v", tid, err)
		}
	}

	env := newSuggestTestEnv(t, pool)
	env.auth.addToken("tok-u1", u1)
	env.auth.addToken("tok-u2", u2)

	for _, q := range []string{"", "a", "alpha", "#alpha"} {
		rec := env.doSuggest("tok-u1", url.Values{"q": {q}, "limit": {"12"}})
		resp := validateSuggestResponseOpenAPIShape(t, rec)
		for _, it := range resp.Items {
			if it.ID == u2LiveItem || it.ID == u1DeletedItem {
				t.Fatalf("u1 q=%q leaked forbidden item %+v", q, it)
			}
			if it.ID == u1LiveItem {
				if it.TagTotal != 1 || len(it.Tags) != 1 || it.Tags[0].ID != u1LiveTag {
					t.Fatalf("u1LiveItem tags = %+v (total=%d), want only u1LiveTag", it.Tags, it.TagTotal)
				}
			}
		}
		for _, tg := range resp.Tags {
			if tg.ID == u2LiveTag || tg.ID == u1DeletedTag {
				t.Fatalf("u1 q=%q leaked forbidden tag %+v", q, tg)
			}
		}
	}
}

// TestSuggestQuotaTable reads `packages/search-fixtures/quota.json` and verifies:
//  1. Every cell in `SuggestQuotaTable` matches `quota.json` (scope, limit, tag_max, lex_max,
//     near_base, near_max_cap, recent_tag, recent_item).
//  2. Every `(scope, limit)` cell in `prefix`/`full` mode across all combinations of
//     `(tagHits, itemHits, nearHitsAfterDedup)` produces exact `tags_used`, `items_used`,
//     effective wire `quota.near = min(near_max_cap, near_base + max(0, lex_max - tags_used - items_used))`,
//     and `near_used = min(near_hits_after_dedup, quota.near, limit - tags_used - items_used)`.
//  3. Every `(scope, limit)` cell in `recent` mode produces `quota = {tag: recent_tag, lexical: limit, near: 0}`,
//     `tags_used = min(tagHits, recent_tag)`, `items_used = min(itemHits, limit - tags_used)`, `near_used = 0`.
func TestSuggestQuotaTable(t *testing.T) {
	raw, err := os.ReadFile(fixturePath(t, "quota.json"))
	if err != nil {
		t.Fatalf("read quota.json: %v", err)
	}
	var fx quotaFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("unmarshal quota.json: %v", err)
	}
	if fx.Version != 1 || fx.Schema != "engram-search-quota-v1" {
		t.Fatalf("unexpected quota.json header: version=%d schema=%q", fx.Version, fx.Schema)
	}
	if !slices.Equal(fx.Suggest.Limits, []int{5, 8, 12}) || fx.Suggest.DefaultLimit != suggest.DefaultSuggestLimit || fx.Suggest.MobileLimit != suggest.MobileSuggestLimit {
		t.Fatalf("suggest limits metadata mismatch: %+v", fx.Suggest)
	}
	if len(fx.Suggest.Table) != len(suggest.SuggestQuotaTable) {
		t.Fatalf("quota.json table len = %d, SuggestQuotaTable len = %d", len(fx.Suggest.Table), len(suggest.SuggestQuotaTable))
	}

	for i, want := range fx.Suggest.Table {
		got, ok := suggest.LookupQuotaCell(want.Scope, want.Limit)
		if !ok {
			t.Fatalf("row %d: LookupQuotaCell(%q, %d) not found", i, want.Scope, want.Limit)
		}
		wantCell := suggest.QuotaCell{
			Scope:      want.Scope,
			Limit:      want.Limit,
			TagMax:     want.TagMax,
			LexMax:     want.LexMax,
			NearBase:   want.NearBase,
			NearMaxCap: want.NearMaxCap,
			RecentTag:  want.RecentTag,
			RecentItem: want.RecentItem,
		}
		if got != wantCell {
			t.Fatalf("row %d (%s, %d): got %+v, want %+v", i, want.Scope, want.Limit, got, wantCell)
		}
		if want.RecentTag+want.RecentItem != want.Limit {
			t.Fatalf("row %d (%s, %d): recent_tag (%d) + recent_item (%d) != limit (%d)",
				i, want.Scope, want.Limit, want.RecentTag, want.RecentItem, want.Limit)
		}

		// Exhaustively verify prefix/full and recent allocation formulas across hit counts 0..limit+3.
		for tagHits := range want.Limit + 4 {
			for itemHits := range want.Limit + 4 {
				for nearHits := range want.Limit + 4 {
					effTagHits := tagHits
					effItemHits := itemHits
					if want.Scope == suggest.ScopeItem {
						effTagHits = 0
					}
					if want.Scope == suggest.ScopeTag {
						effItemHits = 0
					}

					for _, mode := range []string{suggest.ModePrefix, suggest.ModeFull} {
						alloc := suggest.ComputeQuota(want.Scope, want.Limit, mode, effTagHits, effItemHits, nearHits)

						wantTagsUsed := min(effTagHits, max(want.TagMax, want.LexMax-effItemHits))
						wantItemsUsed := min(effItemHits, want.LexMax-wantTagsUsed)
						wantNearEff := min(want.NearMaxCap, want.NearBase+max(0, want.LexMax-wantTagsUsed-wantItemsUsed))
						wantNearUsed := min(nearHits, min(wantNearEff, want.Limit-wantTagsUsed-wantItemsUsed))

						if alloc.TagsUsed != wantTagsUsed || alloc.ItemsUsed != wantItemsUsed || alloc.NearUsed != wantNearUsed {
							t.Fatalf("(%s,%d,%s) hits=(%d,%d,%d): got used=(%d,%d,%d), want (%d,%d,%d)",
								want.Scope, want.Limit, mode, effTagHits, effItemHits, nearHits,
								alloc.TagsUsed, alloc.ItemsUsed, alloc.NearUsed,
								wantTagsUsed, wantItemsUsed, wantNearUsed)
						}
						wantWire := suggest.SuggestQuota{
							Tag:     want.TagMax,
							Lexical: want.LexMax,
							Near:    wantNearEff,
						}
						if alloc.WireQuota != wantWire {
							t.Fatalf("(%s,%d,%s) hits=(%d,%d,%d): got WireQuota=%+v, want %+v",
								want.Scope, want.Limit, mode, effTagHits, effItemHits, nearHits,
								alloc.WireQuota, wantWire)
						}
					}

					// Recent mode verification.
					recAlloc := suggest.ComputeQuota(want.Scope, want.Limit, suggest.ModeRecent, effTagHits, effItemHits, nearHits)
					wantRecTags := min(effTagHits, want.RecentTag)
					wantRecItems := 0
					if want.Scope != suggest.ScopeTag {
						wantRecItems = min(effItemHits, want.Limit-wantRecTags)
					}
					wantRecWire := suggest.SuggestQuota{
						Tag:     want.RecentTag,
						Lexical: want.Limit,
						Near:    0,
					}
					if recAlloc.TagsUsed != wantRecTags || recAlloc.ItemsUsed != wantRecItems || recAlloc.NearUsed != 0 || recAlloc.WireQuota != wantRecWire {
						t.Fatalf("(%s,%d,recent) hits=(%d,%d,%d): got %+v, want tags=%d items=%d near=0 wire=%+v",
							want.Scope, want.Limit, effTagHits, effItemHits, nearHits,
							recAlloc, wantRecTags, wantRecItems, wantRecWire)
					}
				}
			}
		}
	}
}

type stubNearSource struct {
	fn func(ctx context.Context, req suggest.NearRequest) (suggest.NearResult, error)
}

func (s stubNearSource) Near(ctx context.Context, req suggest.NearRequest) (suggest.NearResult, error) {
	return s.fn(ctx, req)
}

// TestSuggestLexicalIdenticalSemanticOnOff verifies plan P05 mục 2.4 & Task 3:
// When a stub `NearSource` returns semantic hits (including duplicates of lexical hits,
// semantic tags, and semantic items) for `semantic=1` vs `semantic=0` on the same snapshot:
//   - The serialized JSON bytes of `tags`, `items`, and `quota` are byte-identical between
//     `semantic=0` and `semantic=1`.
//   - `semantic=1` deduplicates against lexical `(kind, id)`, orders `SuggestTag` before
//     `SuggestItem` in `near`, sets `match: "semantic"`, clips to `near_used`, and sets
//     `semantic: true, semantic_reason: null, generation: 1`.
func TestSuggestLexicalIdenticalSemanticOnOff(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	fx, users := loadAndSeedCorpus(t, ctx, pool)
	_ = fx
	u1 := users["u1"]

	env := newSuggestTestEnv(t, pool)
	env.auth.addToken("tok-u1", u1)

	nearTagID := uuid.MustParse("00000000-0011-4000-8000-000000000010")  // gia-đình
	nearItemID := uuid.MustParse("00000000-0001-4000-8000-000000000007") // password (unrelated to query 'wifi')
	lexDupItemID := uuid.MustParse("00000000-0001-4000-8000-000000000009")
	lexDupTagID := uuid.MustParse("00000000-0011-4000-8000-000000000001")
	ts := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

	env.svc.SetNearSource(stubNearSource{
		fn: func(_ context.Context, req suggest.NearRequest) (suggest.NearResult, error) {
			if !req.SemanticParam {
				reason := suggest.ReasonRequestLexical
				return suggest.NearResult{
					Semantic:       false,
					SemanticReason: &reason,
					Near:           []suggest.SuggestNearRow{},
					Generation:     nil,
				}, nil
			}
			genID := 1
			return suggest.NearResult{
				Semantic:       true,
				SemanticReason: nil,
				Generation:     &genID,
				// Intentionally pass item before tag and include duplicates of lexical hits
				// to verify deduplication and tag-before-item ordering in `near`.
				Near: []suggest.SuggestNearRow{
					suggest.SuggestItem{
						Kind:       "item",
						ID:         lexDupItemID,
						Name:       "wifi",
						EntryCount: 12,
						CreatedAt:  ts,
						LastUsedAt: ts,
						Tags:       []suggest.TagRef{},
						TagTotal:   0,
						Match:      suggest.MatchSemantic,
					},
					suggest.SuggestItem{
						Kind:       "item",
						ID:         nearItemID,
						Name:       "password",
						EntryCount: 10,
						CreatedAt:  ts,
						LastUsedAt: ts,
						Tags:       []suggest.TagRef{},
						TagTotal:   0,
						Match:      suggest.MatchSemantic,
					},
					suggest.SuggestTag{
						Kind:       "tag",
						ID:         lexDupTagID,
						Display:    "wifi-khách",
						ItemCount:  4,
						LastUsedAt: ts,
						Match:      suggest.MatchSemantic,
					},
					suggest.SuggestTag{
						Kind:       "tag",
						ID:         nearTagID,
						Display:    "gia-đình",
						ItemCount:  3,
						LastUsedAt: ts,
						Match:      suggest.MatchSemantic,
					},
				},
			}, nil
		},
	})

	for _, scope := range []string{suggest.ScopeAll, suggest.ScopeItem, suggest.ScopeTag} {
		for _, limitStr := range []string{"5", "8", "12"} {
			recOff := env.doSuggest("tok-u1", url.Values{
				"q":        {"wifi"},
				"scope":    {scope},
				"limit":    {limitStr},
				"semantic": {"0"},
			})
			respOff := validateSuggestResponseOpenAPIShape(t, recOff)

			recOn := env.doSuggest("tok-u1", url.Values{
				"q":        {"wifi"},
				"scope":    {scope},
				"limit":    {limitStr},
				"semantic": {"1"},
			})
			respOn := validateSuggestResponseOpenAPIShape(t, recOn)

			tagsOffJSON, _ := json.Marshal(respOff.Tags)
			tagsOnJSON, _ := json.Marshal(respOn.Tags)
			if !bytes.Equal(tagsOffJSON, tagsOnJSON) {
				t.Fatalf("(%s,%s) tags JSON differs between semantic=0 and semantic=1:\noff=%s\non =%s",
					scope, limitStr, string(tagsOffJSON), string(tagsOnJSON))
			}

			itemsOffJSON, _ := json.Marshal(respOff.Items)
			itemsOnJSON, _ := json.Marshal(respOn.Items)
			if !bytes.Equal(itemsOffJSON, itemsOnJSON) {
				t.Fatalf("(%s,%s) items JSON differs between semantic=0 and semantic=1:\noff=%s\non =%s",
					scope, limitStr, string(itemsOffJSON), string(itemsOnJSON))
			}

			quotaOffJSON, _ := json.Marshal(respOff.Quota)
			quotaOnJSON, _ := json.Marshal(respOn.Quota)
			if !bytes.Equal(quotaOffJSON, quotaOnJSON) {
				t.Fatalf("(%s,%s) quota JSON differs between semantic=0 and semantic=1:\noff=%s\non =%s",
					scope, limitStr, string(quotaOffJSON), string(quotaOnJSON))
			}

			if respOff.Semantic || respOff.SemanticReason == nil || *respOff.SemanticReason != suggest.ReasonRequestLexical || len(respOff.Near) != 0 {
				t.Fatalf("(%s,%s) semantic=0 unexpected near state: %+v", scope, limitStr, respOff)
			}
			if !respOn.Semantic || respOn.SemanticReason != nil || respOn.Generation == nil || *respOn.Generation != 1 {
				t.Fatalf("(%s,%s) semantic=1 unexpected near state: %+v", scope, limitStr, respOn)
			}
			if len(respOn.Near) == 0 {
				t.Fatalf("(%s,%s) semantic=1 expected non-empty near hits", scope, limitStr)
			}
		}
	}

	// Verify tag-before-item ordering and lexical deduplication on (scope=all, limit=8).
	recAll8 := env.doSuggest("tok-u1", url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}, "semantic": {"1"}})
	var rawAll8 struct {
		Near []struct {
			Kind string    `json:"kind"`
			ID   uuid.UUID `json:"id"`
		} `json:"near"`
	}
	if err := json.Unmarshal(recAll8.Body.Bytes(), &rawAll8); err != nil {
		t.Fatalf("unmarshal near: %v", err)
	}
	if len(rawAll8.Near) != 2 {
		t.Fatalf("near len = %d, want 2 (1 deduped tag + 1 deduped item)", len(rawAll8.Near))
	}
	if rawAll8.Near[0].Kind != "tag" || rawAll8.Near[0].ID != nearTagID {
		t.Fatalf("near[0] = %+v, want tag %s", rawAll8.Near[0], nearTagID)
	}
	if rawAll8.Near[1].Kind != "item" || rawAll8.Near[1].ID != nearItemID {
		t.Fatalf("near[1] = %+v, want item %s", rawAll8.Near[1], nearItemID)
	}
}

// TestSuggestRecencyOnlyTieBreak verifies SPEC §6.2, §6.4 & plan P05 mục 2.3:
//   - Recency (`last_used_at`) and count (`entry_count` / `item_count`) ONLY break ties
//     within the same `(tier, score)`; a newer or higher-count lower-tier or lower-score row
//     never outranks a higher-tier or higher-score row.
//   - Within equal `(tier, score)`, rows order by `last_used_at DESC, count DESC, id ASC`.
func TestSuggestRecencyOnlyTieBreak(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	u1 := uuid.MustParse("33333333-3333-4000-8000-000000000003")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'tiebreak@example.com', 'vi')`, u1); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	tOld := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tMid := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	tNew := time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)

	// Query will be "mã":
	// 1. Exact accent prefix (tier 3), older & fewer entries:
	idTier3Old := uuid.MustParse("00000000-0001-4000-8000-000000000001")
	// 2. Equal (tier 3, score 1.00) tie-break group on identical name "mã pin":
	//    - idTieRecent: newest last_used_at, low entry_count (1) -> first in group
	//    - idTieHighCount: older last_used_at (tMid), higher entry_count (50) -> second
	//    - idTieLowCountA: same last_used_at (tMid), lower entry_count (5), smaller UUID -> third
	//    - idTieLowCountB: same last_used_at (tMid), lower entry_count (5), larger UUID -> fourth
	idTieRecent := uuid.MustParse("00000000-0001-4000-8000-000000000010")
	idTieHighCount := uuid.MustParse("00000000-0001-4000-8000-000000000020")
	idTieLowCountA := uuid.MustParse("00000000-0001-4000-8000-000000000030")
	idTieLowCountB := uuid.MustParse("00000000-0001-4000-8000-000000000040")
	// 3. Folded prefix (tier 2) "ma pin", even though it has the newest timestamp and max entry_count (199),
	//    must rank AFTER all tier 3 items when querying "mã" (actually for query "ma", "ma pin" is tier 3
	//    and "mã pin" is tier 2 — let's query "ma" so "ma pin" is tier 3 and "mã pin" is tier 2!).
	items := []struct {
		id         uuid.UUID
		name       string
		norm       string
		entryCount int32
		lastUsed   time.Time
	}{
		// When querying "ma":
		// Tier 3 ("ma pin"):
		{idTieRecent, "ma pin", "ma pin", 1, tNew},
		{idTieHighCount, "ma pin", "ma pin", 50, tMid},
		{idTieLowCountA, "ma pin", "ma pin", 5, tMid},
		{idTieLowCountB, "ma pin", "ma pin", 5, tMid},
		// Tier 2 ("mã pin") with even newer last_used_at and entry_count=199 -> still behind all Tier 3!
		{idTier3Old, "mã pin", "mã pin", 199, tNew.Add(24 * time.Hour)},
	}
	for _, it := range items {
		if _, err := pool.Exec(ctx, `
			INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
		`, it.id, u1, it.name, it.norm, it.entryCount, it.lastUsed, tOld); err != nil {
			t.Fatalf("insert item %s: %v", it.id, err)
		}
	}

	env := newSuggestTestEnv(t, pool)
	env.auth.addToken("tok-u1", u1)

	rec := env.doSuggest("tok-u1", url.Values{"q": {"ma"}, "scope": {"item"}, "limit": {"8"}})
	resp := validateSuggestResponseOpenAPIShape(t, rec)

	wantOrder := []uuid.UUID{
		idTieRecent,
		idTieHighCount,
		idTieLowCountA,
		idTieLowCountB,
		idTier3Old,
	}
	if len(resp.Items) != len(wantOrder) {
		t.Fatalf("got %d items, want %d: %+v", len(resp.Items), len(wantOrder), resp.Items)
	}
	for i, wantID := range wantOrder {
		if resp.Items[i].ID != wantID {
			t.Fatalf("items[%d].ID = %s (name=%q, match=%q), want %s",
				i, resp.Items[i].ID, resp.Items[i].Name, resp.Items[i].Match, wantID)
		}
	}
	if resp.Items[4].Match != suggest.MatchPrefixFolded {
		t.Fatalf("items[4].Match = %q, want prefix_folded", resp.Items[4].Match)
	}
}

func counterValueByCorpus(t *testing.T, reg *prometheus.Registry, familyName, corpus string) float64 {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() != familyName {
			continue
		}
		for _, m := range f.GetMetric() {
			for _, lp := range m.GetLabel() {
				if lp.GetName() == "corpus" && lp.GetValue() == corpus {
					return m.GetCounter().GetValue()
				}
			}
		}
	}
	t.Fatalf("metric %s{corpus=%q} not found", familyName, corpus)
	return 0
}

// TestSuggestBranchTimeoutPartial verifies plan P05 mục 2.3, 2.21, Task 3:
//   - When one lexical branch exceeds the 50 ms statement_timeout (forced deterministically
//     via `pg_sleep(0.2)` inside `AfterBranchSetLocal` on that branch's read tx, which has
//     `SET LOCAL statement_timeout = '50ms'`), `/suggest` still returns HTTP 200 with the
//     surviving branch's hits, `lexical_partial: ["item"]` (or `["tag"]`), and increments
//     `search_lexical_partial_total{corpus}` without returning an error to the client.
func TestSuggestBranchTimeoutPartial(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	u1 := uuid.MustParse("55555555-5555-4000-8000-000000000005")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'timeout@example.com', 'vi')`, u1); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	ts := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `
		INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
		VALUES ($1, $2, 'wifi văn phòng', 'wifi văn phòng', 4, $3, $3, $3)
	`, uuid.MustParse("00000000-0001-4000-8000-000000000501"), u1, ts); err != nil {
		t.Fatalf("insert item: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
		VALUES ($1, $2, 'wifi-tag', 'wifi-tag', 2, $3, $3, $3)
	`, uuid.MustParse("00000000-0011-4000-8000-000000000501"), u1, ts); err != nil {
		t.Fatalf("insert tag: %v", err)
	}

	env := newSuggestTestEnv(t, pool)
	env.auth.addToken("tok-u1", u1)

	// 1. Force the item branch past the 50ms Postgres statement_timeout.
	env.svc.SetTestHooks(&suggest.TestHooks{
		AfterBranchSetLocal: func(ctx context.Context, tx pgx.Tx, corpus string) error {
			if corpus == suggest.CorpusItem {
				_, err := tx.Exec(ctx, `SELECT pg_sleep(0.2)`)
				return err
			}
			return nil
		},
	})
	t.Cleanup(func() { env.svc.SetTestHooks(nil) })

	beforeItemPartial := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusItem)
	beforeTagPartial := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)

	recItemTimeout := env.doSuggest("tok-u1", url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}})
	respItemTimeout := validateSuggestResponseOpenAPIShape(t, recItemTimeout)

	if !slices.Equal(respItemTimeout.LexicalPartial, []string{"item"}) {
		t.Fatalf("lexical_partial = %v, want [\"item\"]", respItemTimeout.LexicalPartial)
	}
	if len(respItemTimeout.Items) != 0 {
		t.Fatalf("timed-out item branch must return 0 items, got %d", len(respItemTimeout.Items))
	}
	if len(respItemTimeout.Tags) != 1 || respItemTimeout.Tags[0].Display != "wifi-tag" {
		t.Fatalf("surviving tag branch must return 'wifi-tag', got %+v", respItemTimeout.Tags)
	}
	afterItemPartial := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusItem)
	afterTagPartial := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)
	if afterItemPartial != beforeItemPartial+1 {
		t.Fatalf("LexicalPartialTotal{corpus=item} = %v, want %v", afterItemPartial, beforeItemPartial+1)
	}
	if afterTagPartial != beforeTagPartial {
		t.Fatalf("LexicalPartialTotal{corpus=tag} = %v, want unchanged %v", afterTagPartial, beforeTagPartial)
	}
	// 2. Force the tag branch past the 50ms Postgres statement_timeout.
	env.svc.SetTestHooks(&suggest.TestHooks{
		AfterBranchSetLocal: func(ctx context.Context, tx pgx.Tx, corpus string) error {
			if corpus == suggest.CorpusTag {
				_, err := tx.Exec(ctx, `SELECT pg_sleep(0.2)`)
				return err
			}
			return nil
		},
	})

	recTagTimeout := env.doSuggest("tok-u1", url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}})
	respTagTimeout := validateSuggestResponseOpenAPIShape(t, recTagTimeout)

	if !slices.Equal(respTagTimeout.LexicalPartial, []string{"tag"}) {
		t.Fatalf("lexical_partial = %v, want [\"tag\"]", respTagTimeout.LexicalPartial)
	}
	if len(respTagTimeout.Tags) != 0 {
		t.Fatalf("timed-out tag branch must return 0 tags, got %d", len(respTagTimeout.Tags))
	}
	if len(respTagTimeout.Items) != 1 || respTagTimeout.Items[0].Name != "wifi văn phòng" {
		t.Fatalf("surviving item branch must return 'wifi văn phòng', got %+v", respTagTimeout.Items)
	}
	afterTagPartial2 := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)
	if afterTagPartial2 != beforeTagPartial+1 {
		t.Fatalf("LexicalPartialTotal{corpus=tag} = %v, want %v", afterTagPartial2, beforeTagPartial+1)
	}
}
