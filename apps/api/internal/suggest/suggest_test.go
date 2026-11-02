package suggest_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	// Warm two concurrent pool connections so parallel item/tag lexical branches
	// (50 ms per-branch budget) do not pay cold TCP/auth handshake overhead on CI.
	if pool != nil {
		warmPoolConns(t, pool, 2)
	}
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
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
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

func warmPoolConns(t *testing.T, pool *pgxpool.Pool, n int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conns := make([]*pgxpool.Conn, 0, n)
	for range n {
		c, err := pool.Acquire(ctx)
		if err != nil {
			for _, prev := range conns {
				prev.Release()
			}
			t.Fatalf("warmPoolConns Acquire: %v", err)
		}
		conns = append(conns, c)
	}
	for _, c := range conns {
		c.Release()
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

// maxSettleAsks bounds doSuggestSettled.
const maxSettleAsks = 4

// doSuggestSettled is doSuggest for a test that REQUIRES real lexical rows from a database
// request taken on the production timing path (no TestHooks). It re-asks, a bounded number of
// times, ONLY when the response explicitly carries a non-empty `lexical_partial` (the SPEC 6.8
// degrade a slow first query on a cold backend can still produce: FU-SB-2 moved acquire, BEGIN and
// SET LOCAL out of the 50 ms budget, but the first Parse/plan of the item query on a fresh backend
// is still query work). A complete response is returned as is, so an empty list with
// `lexical_partial: []` is a real empty result and the caller's row assertions fail on it. A
// request that is still partial after maxSettleAsks fails the test.
func (e *suggestTestEnv) doSuggestSettled(token string, params url.Values) *httptest.ResponseRecorder {
	e.t.Helper()
	for ask := 1; ; ask++ {
		rec := e.doSuggest(token, params)
		if rec.Code != http.StatusOK {
			return rec
		}
		var body struct {
			LexicalPartial []string `json:"lexical_partial"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			e.t.Fatalf("doSuggestSettled: decode body: %v", err)
		}
		if len(body.LexicalPartial) == 0 {
			return rec
		}
		if ask >= maxSettleAsks {
			e.t.Fatalf("doSuggestSettled: still lexical_partial=%v after %d asks", body.LexicalPartial, ask)
		}
	}
}

func suggestItemsContain(items []suggest.SuggestItem, id uuid.UUID) bool {
	for _, it := range items {
		if it.ID == id {
			return true
		}
	}
	return false
}

func suggestTagsContain(tags []suggest.SuggestTag, id uuid.UUID) bool {
	for _, tg := range tags {
		if tg.ID == id {
			return true
		}
	}
	return false
}

// validateSuggestResponseOpenAPIShape strictly validates the raw JSON bytes of a 200
// `/suggest` response against the frozen OpenAPI schemas `SuggestResponse`,
// `SuggestQuota`, `SuggestTag`, `SuggestItem`, `TagRef`, `SuggestNearRow`,
// `SuggestLexicalCorpus`, `SearchScope`, `SuggestMode`, `SuggestMatch`, `SemanticReason`,
// `ItemName`, and `TagDisplay` in `apps/api/api/openapi.yaml`.
//
// All schema checks run directly on raw untyped JSON (`json.Decoder` with `UseNumber()`)
// rather than relying on round-tripping through the production DTO.
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
	if err := checkSuggestResponseOpenAPISchema(rawBytes); err != nil {
		t.Fatalf("SuggestResponse OpenAPI schema violation: %v\nbody=%s", err, string(rawBytes))
	}

	var resp suggest.SuggestResponse
	dec := json.NewDecoder(bytes.NewReader(rawBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&resp); err != nil {
		t.Fatalf("decode SuggestResponse after schema check: %v\nbody=%s", err, string(rawBytes))
	}
	return resp
}

func checkSuggestResponseOpenAPISchema(rawBytes []byte) error {
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
		return fmt.Errorf("SuggestResponse root must be a non-null JSON object, got %T", root)
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
	if err := checkExactObjectKeys("SuggestResponse", rawObj, wantTopKeys); err != nil {
		return err
	}

	// scope: SearchScope (string enum: [all, item, tag], required non-null).
	scope, err := checkRequiredString(rawObj, "SuggestResponse.scope", "scope")
	if err != nil {
		return err
	}
	switch scope {
	case "all", "item", "tag":
	default:
		return fmt.Errorf("SuggestResponse.scope = %q, want one of [all, item, tag]", scope)
	}

	// limit: integer enum [5, 8, 12], required non-null.
	limit, err := checkRequiredInt(rawObj, "SuggestResponse.limit", "limit", 5, 12)
	if err != nil {
		return err
	}
	switch limit {
	case 5, 8, 12:
	default:
		return fmt.Errorf("SuggestResponse.limit = %d, want one of [5, 8, 12]", limit)
	}

	// mode: SuggestMode (string enum: [recent, prefix, full], required non-null).
	mode, err := checkRequiredString(rawObj, "SuggestResponse.mode", "mode")
	if err != nil {
		return err
	}
	switch mode {
	case "recent", "prefix", "full":
	default:
		return fmt.Errorf("SuggestResponse.mode = %q, want one of [recent, prefix, full]", mode)
	}

	// quota: SuggestQuota (object, required non-null, additionalProperties: false, required: [tag, lexical, near], each integer >= 0).
	quotaMap, ok := rawObj["quota"].(map[string]any)
	if !ok || quotaMap == nil {
		return fmt.Errorf("SuggestResponse.quota must be a non-null object, got %T", rawObj["quota"])
	}
	if err := checkExactObjectKeys("SuggestQuota", quotaMap, []string{"lexical", "near", "tag"}); err != nil {
		return err
	}
	for _, qField := range []string{"tag", "lexical", "near"} {
		if _, err := checkRequiredInt(quotaMap, "SuggestQuota."+qField, qField, 0, math.MaxInt32); err != nil {
			return err
		}
	}

	// has_more: boolean, required non-null.
	if _, err := checkRequiredBool(rawObj, "SuggestResponse.has_more", "has_more"); err != nil {
		return err
	}

	// semantic: boolean, required non-null.
	semantic, err := checkRequiredBool(rawObj, "SuggestResponse.semantic", "semantic")
	if err != nil {
		return err
	}

	// semantic_reason: oneOf [SemanticReason, null].
	// OpenAPI contract: null when semantic=true; one of the 5 SemanticReason enum values when semantic=false.
	semReasonRaw := rawObj["semantic_reason"]
	if semantic {
		if semReasonRaw != nil {
			return fmt.Errorf("SuggestResponse.semantic_reason must be null when semantic=true, got %v", semReasonRaw)
		}
	} else {
		semReason, ok := semReasonRaw.(string)
		if !ok {
			return fmt.Errorf("SuggestResponse.semantic_reason must be a non-null string when semantic=false, got %T (%v)", semReasonRaw, semReasonRaw)
		}
		switch semReason {
		case "disabled_server", "disabled_user", "degraded", "request_lexical", "short_query":
		default:
			return fmt.Errorf("SuggestResponse.semantic_reason = %q, want SemanticReason enum", semReason)
		}
	}

	// generation: type [integer, null], minimum 1, maximum 9999.
	// OpenAPI contract: integer 1..9999 when semantic=true; null when semantic=false.
	genRaw := rawObj["generation"]
	if semantic {
		if genRaw == nil {
			return fmt.Errorf("SuggestResponse.generation must be a non-null integer (1..9999) when semantic=true")
		}
		if _, err := checkRequiredInt(rawObj, "SuggestResponse.generation", "generation", 1, 9999); err != nil {
			return err
		}
	} else {
		if genRaw != nil {
			return fmt.Errorf("SuggestResponse.generation must be null when semantic=false, got %v", genRaw)
		}
	}

	// lexical_partial: array of SuggestLexicalCorpus ("item" | "tag"), non-null, maxItems: 2, uniqueItems: true.
	partialArr, err := checkRequiredArray(rawObj, "SuggestResponse.lexical_partial", "lexical_partial")
	if err != nil {
		return err
	}
	if len(partialArr) > 2 {
		return fmt.Errorf("SuggestResponse.lexical_partial len = %d, maxItems is 2", len(partialArr))
	}
	seenPartial := make(map[string]struct{}, len(partialArr))
	for i, elem := range partialArr {
		s, ok := elem.(string)
		if !ok {
			return fmt.Errorf("SuggestResponse.lexical_partial[%d] must be a string, got %T", i, elem)
		}
		switch s {
		case "item", "tag":
		default:
			return fmt.Errorf("SuggestResponse.lexical_partial[%d] = %q, want \"item\" or \"tag\"", i, s)
		}
		if _, dup := seenPartial[s]; dup {
			return fmt.Errorf("SuggestResponse.lexical_partial has duplicate item %q (uniqueItems: true)", s)
		}
		seenPartial[s] = struct{}{}
	}

	// tags: non-null array of SuggestTag.
	tagsArr, err := checkRequiredArray(rawObj, "SuggestResponse.tags", "tags")
	if err != nil {
		return err
	}
	for i, elem := range tagsArr {
		m, ok := elem.(map[string]any)
		if !ok || m == nil {
			return fmt.Errorf("SuggestResponse.tags[%d] must be a non-null object, got %T", i, elem)
		}
		if err := checkSuggestTagSchema(fmt.Sprintf("SuggestResponse.tags[%d]", i), m, false); err != nil {
			return err
		}
	}

	// items: non-null array of SuggestItem.
	itemsArr, err := checkRequiredArray(rawObj, "SuggestResponse.items", "items")
	if err != nil {
		return err
	}
	for i, elem := range itemsArr {
		m, ok := elem.(map[string]any)
		if !ok || m == nil {
			return fmt.Errorf("SuggestResponse.items[%d] must be a non-null object, got %T", i, elem)
		}
		if err := checkSuggestItemSchema(fmt.Sprintf("SuggestResponse.items[%d]", i), m, false); err != nil {
			return err
		}
	}

	// near: non-null array of SuggestNearRow (empty when semantic=false).
	nearArr, err := checkRequiredArray(rawObj, "SuggestResponse.near", "near")
	if err != nil {
		return err
	}
	if !semantic && len(nearArr) != 0 {
		return fmt.Errorf("SuggestResponse.near must be empty [] when semantic=false, got len=%d", len(nearArr))
	}
	for i, elem := range nearArr {
		m, ok := elem.(map[string]any)
		if !ok || m == nil {
			return fmt.Errorf("SuggestResponse.near[%d] must be a non-null object, got %T", i, elem)
		}
		kind, err := checkRequiredString(m, fmt.Sprintf("SuggestResponse.near[%d].kind", i), "kind")
		if err != nil {
			return err
		}
		switch kind {
		case "tag":
			if err := checkSuggestTagSchema(fmt.Sprintf("SuggestResponse.near[%d]", i), m, true); err != nil {
				return err
			}
		case "item":
			if err := checkSuggestItemSchema(fmt.Sprintf("SuggestResponse.near[%d]", i), m, true); err != nil {
				return err
			}
		default:
			return fmt.Errorf("SuggestResponse.near[%d] has invalid discriminator kind=%q", i, kind)
		}
	}

	return nil
}

func checkSuggestTagSchema(path string, m map[string]any, isNear bool) error {
	wantKeys := []string{"display", "id", "item_count", "kind", "last_used_at", "match"}
	if err := checkExactObjectKeys(path, m, wantKeys); err != nil {
		return err
	}
	kind, err := checkRequiredString(m, path+".kind", "kind")
	if err != nil {
		return err
	}
	if kind != "tag" {
		return fmt.Errorf("%s.kind = %q, want const \"tag\"", path, kind)
	}
	if err := checkRequiredUUID(m, path+".id", "id"); err != nil {
		return err
	}
	// display: TagDisplay (string, minLength: 1, maxLength: 50).
	if err := checkRequiredBoundedString(m, path+".display", "display", 1, 50); err != nil {
		return err
	}
	// item_count: integer, minimum: 0.
	if _, err := checkRequiredInt(m, path+".item_count", "item_count", 0, math.MaxInt32); err != nil {
		return err
	}
	// last_used_at: string, format: date-time.
	if err := checkRequiredDateTime(m, path+".last_used_at", "last_used_at"); err != nil {
		return err
	}
	// match: SuggestMatch enum [prefix, prefix_folded, fuzzy, semantic].
	if err := checkSuggestMatch(m, path+".match", "match", isNear); err != nil {
		return err
	}
	return nil
}

func checkSuggestItemSchema(path string, m map[string]any, isNear bool) error {
	wantKeys := []string{"created_at", "entry_count", "id", "kind", "last_used_at", "match", "name", "tag_total", "tags"}
	if err := checkExactObjectKeys(path, m, wantKeys); err != nil {
		return err
	}
	kind, err := checkRequiredString(m, path+".kind", "kind")
	if err != nil {
		return err
	}
	if kind != "item" {
		return fmt.Errorf("%s.kind = %q, want const \"item\"", path, kind)
	}
	if err := checkRequiredUUID(m, path+".id", "id"); err != nil {
		return err
	}
	// name: ItemName (string, minLength: 1, maxLength: 200).
	if err := checkRequiredBoundedString(m, path+".name", "name", 1, 200); err != nil {
		return err
	}
	// entry_count: integer, minimum: 0, maximum: 200.
	if _, err := checkRequiredInt(m, path+".entry_count", "entry_count", 0, 200); err != nil {
		return err
	}
	// created_at, last_used_at: string, format: date-time.
	if err := checkRequiredDateTime(m, path+".created_at", "created_at"); err != nil {
		return err
	}
	if err := checkRequiredDateTime(m, path+".last_used_at", "last_used_at"); err != nil {
		return err
	}
	// tags: non-null array of TagRef, maxItems: 3.
	tagsRaw, err := checkRequiredArray(m, path+".tags", "tags")
	if err != nil {
		return err
	}
	if len(tagsRaw) > 3 {
		return fmt.Errorf("%s.tags len = %d, maxItems is 3", path, len(tagsRaw))
	}
	for i, tr := range tagsRaw {
		trMap, ok := tr.(map[string]any)
		if !ok || trMap == nil {
			return fmt.Errorf("%s.tags[%d] must be a non-null object, got %T", path, i, tr)
		}
		refPath := fmt.Sprintf("%s.tags[%d]", path, i)
		if err := checkExactObjectKeys(refPath, trMap, []string{"display", "id"}); err != nil {
			return err
		}
		if err := checkRequiredUUID(trMap, refPath+".id", "id"); err != nil {
			return err
		}
		if err := checkRequiredBoundedString(trMap, refPath+".display", "display", 1, 50); err != nil {
			return err
		}
	}
	// tag_total: integer, minimum: 0, maximum: 20.
	if _, err := checkRequiredInt(m, path+".tag_total", "tag_total", 0, 20); err != nil {
		return err
	}
	// match: SuggestMatch enum [prefix, prefix_folded, fuzzy, semantic].
	if err := checkSuggestMatch(m, path+".match", "match", isNear); err != nil {
		return err
	}
	return nil
}

func checkSuggestMatch(m map[string]any, path, key string, isNear bool) error {
	match, err := checkRequiredString(m, path, key)
	if err != nil {
		return err
	}
	// Frozen SuggestMatch enum in apps/api/api/openapi.yaml:4471-4474:
	// [prefix, prefix_folded, fuzzy, semantic].
	switch match {
	case "prefix", "prefix_folded", "fuzzy", "semantic":
	default:
		return fmt.Errorf("%s = %q, want SuggestMatch enum [prefix, prefix_folded, fuzzy, semantic]", path, match)
	}
	// Frozen SuggestNearRow rule in apps/api/api/openapi.yaml:4572-4581:
	// near rows must have match="semantic"; lexical rows must use lexical tiers only.
	if isNear {
		if match != "semantic" {
			return fmt.Errorf("%s = %q on near row, want %q", path, match, "semantic")
		}
	} else {
		if match == "semantic" {
			return fmt.Errorf("%s = %q on lexical row, want one of [prefix, prefix_folded, fuzzy]", path, match)
		}
	}
	return nil
}

func checkExactObjectKeys(path string, m map[string]any, wantSorted []string) error {
	got := make([]string, 0, len(m))
	for k := range m {
		got = append(got, k)
	}
	slices.Sort(got)
	if !slices.Equal(got, wantSorted) {
		return fmt.Errorf("%s keys = %v, want exact %v", path, got, wantSorted)
	}
	return nil
}

func checkRequiredString(m map[string]any, path, key string) (string, error) {
	v, exists := m[key]
	if !exists || v == nil {
		return "", fmt.Errorf("%s is required and non-null, got %v", path, v)
	}
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("%s must be a string, got %T (%v)", path, v, v)
	}
	return s, nil
}

func checkRequiredBoundedString(m map[string]any, path, key string, minRunes, maxRunes int) error {
	s, err := checkRequiredString(m, path, key)
	if err != nil {
		return err
	}
	if !utf8.ValidString(s) {
		return fmt.Errorf("%s is not valid UTF-8", path)
	}
	n := utf8.RuneCountInString(s)
	if n < minRunes || n > maxRunes {
		return fmt.Errorf("%s rune length = %d, want %d..%d", path, n, minRunes, maxRunes)
	}
	return nil
}

func checkRequiredUUID(m map[string]any, path, key string) error {
	s, err := checkRequiredString(m, path, key)
	if err != nil {
		return err
	}
	if _, err := uuid.Parse(s); err != nil {
		return fmt.Errorf("%s = %q is not a valid UUID: %w", path, s, err)
	}
	return nil
}

func checkRequiredDateTime(m map[string]any, path, key string) error {
	s, err := checkRequiredString(m, path, key)
	if err != nil {
		return err
	}
	if _, err := time.Parse(time.RFC3339Nano, s); err != nil {
		return fmt.Errorf("%s = %q is not a valid RFC3339 date-time: %w", path, s, err)
	}
	return nil
}

func checkRequiredBool(m map[string]any, path, key string) (bool, error) {
	v, exists := m[key]
	if !exists || v == nil {
		return false, fmt.Errorf("%s is required and non-null, got %v", path, v)
	}
	b, ok := v.(bool)
	if !ok {
		return false, fmt.Errorf("%s must be a boolean, got %T (%v)", path, v, v)
	}
	return b, nil
}

func checkRequiredInt(m map[string]any, path, key string, minVal, maxVal int64) (int64, error) {
	v, exists := m[key]
	if !exists || v == nil {
		return 0, fmt.Errorf("%s is required and non-null, got %v", path, v)
	}
	num, ok := v.(json.Number)
	if !ok {
		return 0, fmt.Errorf("%s must be an integer number, got %T (%v)", path, v, v)
	}
	raw := string(num)
	if strings.ContainsAny(raw, ".eE") {
		return 0, fmt.Errorf("%s = %q must be an integer, not float", path, raw)
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s = %q is not a valid integer: %w", path, raw, err)
	}
	if parsed < minVal || parsed > maxVal {
		return 0, fmt.Errorf("%s = %d out of bounds [%d..%d]", path, parsed, minVal, maxVal)
	}
	return parsed, nil
}

func checkRequiredArray(m map[string]any, path, key string) ([]any, error) {
	v, exists := m[key]
	if !exists || v == nil {
		return nil, fmt.Errorf("%s must be a non-null JSON array, got %v", path, v)
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be a JSON array, got %T", path, v)
	}
	return arr, nil
}

// TestSuggestOpenAPISchemaValidatorSelfTest verifies RV-T3-BE-3:
// The OpenAPI schema checker rejects invalid recent/lexical `match`, null required
// scalars, out-of-range counts/quotas/generation, invalid UUID/date-time/string bounds,
// and extra or missing keys.
func TestSuggestOpenAPISchemaValidatorSelfTest(t *testing.T) {
	validJSON := `{
		"scope": "all",
		"limit": 8,
		"mode": "recent",
		"quota": {"tag": 3, "lexical": 8, "near": 0},
		"tags": [{
			"kind": "tag",
			"id": "00000000-0011-4000-8000-000000000001",
			"display": "nhà-riêng",
			"item_count": 2,
			"last_used_at": "2026-10-20T12:00:00Z",
			"match": "prefix"
		}],
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
		"has_more": false,
		"lexical_partial": [],
		"semantic": false,
		"semantic_reason": "disabled_server",
		"near": [],
		"generation": null
	}`
	if err := checkSuggestResponseOpenAPISchema([]byte(validJSON)); err != nil {
		t.Fatalf("expected baseline valid JSON to pass schema check, got: %v", err)
	}

	validNearJSON := `{
		"scope": "all",
		"limit": 8,
		"mode": "full",
		"quota": {"tag": 2, "lexical": 6, "near": 3},
		"tags": [{
			"kind": "tag",
			"id": "00000000-0011-4000-8000-000000000001",
			"display": "nhà-riêng",
			"item_count": 2,
			"last_used_at": "2026-10-20T12:00:00Z",
			"match": "prefix"
		}],
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
		"has_more": false,
		"lexical_partial": [],
		"semantic": true,
		"semantic_reason": null,
		"near": [
			{
				"kind": "tag",
				"id": "00000000-0011-4000-8000-000000000009",
				"display": "mạng-gia-đình",
				"item_count": 1,
				"last_used_at": "2026-10-20T12:00:00Z",
				"match": "semantic"
			},
			{
				"kind": "item",
				"id": "00000000-0001-4000-8000-000000000009",
				"name": "bộ định tuyến phòng khách",
				"entry_count": 1,
				"created_at": "2026-10-20T12:00:00Z",
				"last_used_at": "2026-10-20T12:00:00Z",
				"tags": [],
				"tag_total": 0,
				"match": "semantic"
			}
		],
		"generation": 1
	}`
	if err := checkSuggestResponseOpenAPISchema([]byte(validNearJSON)); err != nil {
		t.Fatalf("expected valid semantic near baseline JSON to pass schema check, got: %v", err)
	}

	negativeCases := []struct {
		name    string
		mutate  func(m map[string]any)
		wantSub string
	}{
		{
			name: "invalid recent lexical item match",
			mutate: func(m map[string]any) {
				items := m["items"].([]any)
				items[0].(map[string]any)["match"] = "bogus_match"
			},
			wantSub: "SuggestResponse.items[0].match",
		},
		{
			name: "invalid recent lexical tag match",
			mutate: func(m map[string]any) {
				tags := m["tags"].([]any)
				tags[0].(map[string]any)["match"] = "recent"
			},
			wantSub: "SuggestResponse.tags[0].match",
		},
		{
			name: "lexical row with semantic match rejected",
			mutate: func(m map[string]any) {
				items := m["items"].([]any)
				items[0].(map[string]any)["match"] = "semantic"
			},
			wantSub: "SuggestResponse.items[0].match",
		},
		{
			name: "null required top-level scalar has_more",
			mutate: func(m map[string]any) {
				m["has_more"] = nil
			},
			wantSub: "SuggestResponse.has_more",
		},
		{
			name: "null required item entry_count",
			mutate: func(m map[string]any) {
				items := m["items"].([]any)
				items[0].(map[string]any)["entry_count"] = nil
			},
			wantSub: "SuggestResponse.items[0].entry_count",
		},
		{
			name: "out-of-range entry_count > 200",
			mutate: func(m map[string]any) {
				items := m["items"].([]any)
				items[0].(map[string]any)["entry_count"] = json.Number("201")
			},
			wantSub: "SuggestResponse.items[0].entry_count",
		},
		{
			name: "negative entry_count",
			mutate: func(m map[string]any) {
				items := m["items"].([]any)
				items[0].(map[string]any)["entry_count"] = json.Number("-1")
			},
			wantSub: "SuggestResponse.items[0].entry_count",
		},
		{
			name: "out-of-range tag_total > 20",
			mutate: func(m map[string]any) {
				items := m["items"].([]any)
				items[0].(map[string]any)["tag_total"] = json.Number("21")
			},
			wantSub: "SuggestResponse.items[0].tag_total",
		},
		{
			name: "negative tag item_count",
			mutate: func(m map[string]any) {
				tags := m["tags"].([]any)
				tags[0].(map[string]any)["item_count"] = json.Number("-1")
			},
			wantSub: "SuggestResponse.tags[0].item_count",
		},
		{
			name: "negative quota lexical",
			mutate: func(m map[string]any) {
				m["quota"].(map[string]any)["lexical"] = json.Number("-1")
			},
			wantSub: "SuggestQuota.lexical",
		},
		{
			name: "out-of-range generation > 9999 when semantic=true",
			mutate: func(m map[string]any) {
				m["semantic"] = true
				m["semantic_reason"] = nil
				m["generation"] = json.Number("10000")
			},
			wantSub: "SuggestResponse.generation",
		},
		{
			name: "extra top-level key rejected",
			mutate: func(m map[string]any) {
				m["q"] = "wifi"
			},
			wantSub: "SuggestResponse keys",
		},
		{
			name: "extra item hint key rejected",
			mutate: func(m map[string]any) {
				items := m["items"].([]any)
				items[0].(map[string]any)["hint"] = "secret"
			},
			wantSub: "SuggestResponse.items[0] keys",
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
			err = checkSuggestResponseOpenAPISchema(mutatedBytes)
			if err == nil {
				t.Fatalf("expected schema error containing %q, got nil", tc.wantSub)
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("schema error = %q, want substring %q", err.Error(), tc.wantSub)
			}
		})
	}

	nearNegativeCases := []struct {
		name    string
		mutate  func(m map[string]any)
		wantSub string
	}{
		{
			name: "near tag row with non-enum match 'near' rejected",
			mutate: func(m map[string]any) {
				near := m["near"].([]any)
				near[0].(map[string]any)["match"] = "near"
			},
			wantSub: "SuggestResponse.near[0].match",
		},
		{
			name: "near item row with lexical match 'prefix' rejected",
			mutate: func(m map[string]any) {
				near := m["near"].([]any)
				near[1].(map[string]any)["match"] = "prefix"
			},
			wantSub: "SuggestResponse.near[1].match",
		},
	}

	for _, tc := range nearNegativeCases {
		t.Run(tc.name, func(t *testing.T) {
			dec := json.NewDecoder(strings.NewReader(validNearJSON))
			dec.UseNumber()
			var obj map[string]any
			if err := dec.Decode(&obj); err != nil {
				t.Fatalf("decode near baseline: %v", err)
			}
			tc.mutate(obj)
			mutatedBytes, err := json.Marshal(obj)
			if err != nil {
				t.Fatalf("marshal mutated near baseline: %v", err)
			}
			err = checkSuggestResponseOpenAPISchema(mutatedBytes)
			if err == nil {
				t.Fatalf("expected schema error containing %q, got nil", tc.wantSub)
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("schema error = %q, want substring %q", err.Error(), tc.wantSub)
			}
		})
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
		rec := env.doSuggestSettled(tok, url.Values{"q": {q}})
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
		rec := env.doSuggestSettled(tok, url.Values{"q": {q}})
		resp := validateSuggestResponseOpenAPIShape(t, rec)
		if resp.Scope != suggest.ScopeTag || resp.Mode != suggest.ModePrefix {
			t.Fatalf("q=%q: got scope=%q mode=%q, want scope=tag mode=prefix", q, resp.Scope, resp.Mode)
		}
		if len(resp.Tags) != 0 || len(resp.Items) != 0 {
			t.Fatalf("q=%q: expected empty tags/items, got tags=%d items=%d", q, len(resp.Tags), len(resp.Items))
		}
	}

	// 3. Leading `#` with valid token forces scope=tag (even if scope=item was passed) and strips trailing tokens.
	recHash := env.doSuggestSettled(tok, url.Values{"q": {"  #nhà   ignored-second-token"}, "scope": {"item"}})
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
		rec := env.doSuggestSettled(tok, vals)
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
		rec := env.doSuggestSettled(tok, vals)
		assertProblemCode(t, rec, http.StatusBadRequest, "name_invalid")
	}
	// Invalid UTF-8 bytes in raw query string -> 400 `name_invalid`.
	badUTF8Rec := env.doSuggestRaw(tok, "q=%ff%fe")
	assertProblemCode(t, badUTF8Rec, http.StatusBadRequest, "name_invalid")

	// Boundary checks: exactly 200 runes for item/all and 50 runes for tag must succeed with 200.
	ok200Rec := env.doSuggestSettled(tok, url.Values{"q": {strings.Repeat("a", 200)}})
	validateSuggestResponseOpenAPIShape(t, ok200Rec)
	ok50TagRec := env.doSuggestSettled(tok, url.Values{"q": {"#" + strings.Repeat("t", 50)}})
	validateSuggestResponseOpenAPIShape(t, ok50TagRec)

	// 6. 400 `invalid_request`: bad scope, bad limit, bad semantic, unknown param, duplicate param, malformed query encoding.
	invalidReqQueries := []string{
		"scope=",
		"scope",
		"q=!!!&scope=",
		"q=!!!&scope",
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
			rec := env.doSuggestSettled(tok, url.Values{
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
		rec := env.doSuggestSettled("tok-u1", url.Values{"q": {"tài khoản ngân hàng"}, "scope": {"item"}, "limit": {"8"}})
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
		rec := env.doSuggestSettled("tok-u1", url.Values{"q": {"#duong"}})
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
		rec := env.doSuggestSettled("tok-u1", url.Values{"limit": {"8"}})
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
		rec := env.doSuggestSettled("tok-u1", url.Values{"q": {"đ"}, "limit": {"8"}})
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
		rec := env.doSuggestSettled("tok-u1", url.Values{"q": {q}, "limit": {"12"}})
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
	fn        func(ctx context.Context, req suggest.NearRequest) (suggest.NearResult, error)
	activeGen func(ctx context.Context, userID uuid.UUID) (*int, error)
}

func (s stubNearSource) Near(ctx context.Context, req suggest.NearRequest) (suggest.NearResult, error) {
	return s.fn(ctx, req)
}

func (s stubNearSource) ActiveGeneration(ctx context.Context, userID uuid.UUID) (*int, error) {
	if s.activeGen != nil {
		return s.activeGen(ctx, userID)
	}
	return nil, nil
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
			recOff := env.doSuggestSettled("tok-u1", url.Values{
				"q":        {"wifi"},
				"scope":    {scope},
				"limit":    {limitStr},
				"semantic": {"0"},
			})
			respOff := validateSuggestResponseOpenAPIShape(t, recOff)

			recOn := env.doSuggestSettled("tok-u1", url.Values{
				"q":        {"wifi"},
				"scope":    {scope},
				"limit":    {limitStr},
				"semantic": {"1"},
			})
			respOn := validateSuggestResponseOpenAPIShape(t, recOn)

			// Positive lexical rows on BOTH responses (RV-SB2-BE-2). Equality alone would pass a
			// complete-empty result (`lexical_partial: []`, no rows) on both sides, so every
			// (scope, limit) must also return the fixture's wifi rows. The seed fixes them: u1
			// owns items "wifi" and "wifi phòng khách" and tags "wifi-khách" and "wifi-nhà", all
			// exact-prefix hits that fit every quota cell.
			limitN, convErr := strconv.Atoi(limitStr)
			if convErr != nil {
				t.Fatalf("limit %q: %v", limitStr, convErr)
			}
			cell, ok := suggest.LookupQuotaCell(scope, limitN)
			if !ok {
				t.Fatalf("(%s,%s) no quota cell", scope, limitStr)
			}
			for label, resp := range map[string]suggest.SuggestResponse{"semantic=0": respOff, "semantic=1": respOn} {
				if len(resp.LexicalPartial) != 0 {
					t.Fatalf("(%s,%s) %s lexical_partial = %v, want none", scope, limitStr, label, resp.LexicalPartial)
				}
				if (scope == suggest.ScopeTag && len(resp.Items) != 0) || (scope == suggest.ScopeItem && len(resp.Tags) != 0) {
					t.Fatalf("(%s,%s) %s returned rows of the wrong corpus: items=%d tags=%d", scope, limitStr, label, len(resp.Items), len(resp.Tags))
				}
				if scope != suggest.ScopeTag {
					if len(resp.Items) == 0 || len(resp.Items) > cell.LexMax {
						t.Fatalf("(%s,%s) %s items = %d, want 1..%d wifi items (complete-empty lexical result?)", scope, limitStr, label, len(resp.Items), cell.LexMax)
					}
					if !suggestItemsContain(resp.Items, lexDupItemID) {
						t.Fatalf("(%s,%s) %s items %+v lack the fixture item %s", scope, limitStr, label, resp.Items, lexDupItemID)
					}
				}
				if scope != suggest.ScopeItem {
					if len(resp.Tags) == 0 || len(resp.Tags) > cell.LexMax {
						t.Fatalf("(%s,%s) %s tags = %d, want 1..%d wifi tags (complete-empty lexical result?)", scope, limitStr, label, len(resp.Tags), cell.LexMax)
					}
					if !suggestTagsContain(resp.Tags, lexDupTagID) {
						t.Fatalf("(%s,%s) %s tags %+v lack the fixture tag %s", scope, limitStr, label, resp.Tags, lexDupTagID)
					}
				}
			}

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
			var rawOn struct {
				Near []struct {
					Match string `json:"match"`
				} `json:"near"`
			}
			if err := json.Unmarshal(recOn.Body.Bytes(), &rawOn); err != nil {
				t.Fatalf("(%s,%s) unmarshal semantic=1 near rows: %v", scope, limitStr, err)
			}
			for i, nr := range rawOn.Near {
				if nr.Match != "semantic" {
					t.Fatalf("(%s,%s) near[%d].match = %q, want literal \"semantic\"", scope, limitStr, i, nr.Match)
				}
			}
		}
	}

	// Verify tag-before-item ordering, lexical deduplication, and literal match=="semantic" on (scope=all, limit=8).
	recAll8 := env.doSuggestSettled("tok-u1", url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}, "semantic": {"1"}})
	var rawAll8 struct {
		Near []struct {
			Kind  string    `json:"kind"`
			ID    uuid.UUID `json:"id"`
			Match string    `json:"match"`
		} `json:"near"`
	}
	if err := json.Unmarshal(recAll8.Body.Bytes(), &rawAll8); err != nil {
		t.Fatalf("unmarshal near: %v", err)
	}
	if len(rawAll8.Near) != 2 {
		t.Fatalf("near len = %d, want 2 (1 deduped tag + 1 deduped item)", len(rawAll8.Near))
	}
	if rawAll8.Near[0].Kind != "tag" || rawAll8.Near[0].ID != nearTagID || rawAll8.Near[0].Match != "semantic" {
		t.Fatalf("near[0] = %+v, want tag %s with match=\"semantic\"", rawAll8.Near[0], nearTagID)
	}
	if rawAll8.Near[1].Kind != "item" || rawAll8.Near[1].ID != nearItemID || rawAll8.Near[1].Match != "semantic" {
		t.Fatalf("near[1] = %+v, want item %s with match=\"semantic\"", rawAll8.Near[1], nearItemID)
	}

	// Verify RV-T3-BE-2: Recent mode delegates semantic_reason decision to NearSource
	// (both value NoopNearSource{}, pointer &NoopNearSource{}, and custom NearSource)
	// without requesting any near hits (Cap == 0, QN == "").
	t.Run("recent-mode-near-source-decision", func(t *testing.T) {
		defer env.svc.SetNearSource(suggest.NewNoopNearSource())

		// (a) Value NoopNearSource and pointer &NoopNearSource on recent (semantic=1 and semantic=0) -> disabled_server.
		for _, src := range []suggest.NearSource{
			suggest.NoopNearSource{},
			&suggest.NoopNearSource{},
		} {
			env.svc.SetNearSource(src)
			for _, semParam := range []string{"1", "0"} {
				rec := env.doSuggestSettled("tok-u1", url.Values{"semantic": {semParam}})
				resp := validateSuggestResponseOpenAPIShape(t, rec)
				if resp.Mode != suggest.ModeRecent {
					t.Fatalf("mode = %q, want recent", resp.Mode)
				}
				if resp.Semantic || resp.Generation != nil || len(resp.Near) != 0 || resp.Quota.Near != 0 {
					t.Fatalf("unexpected recent near envelope: semantic=%v gen=%v near=%d quota=%+v",
						resp.Semantic, resp.Generation, len(resp.Near), resp.Quota)
				}
				if resp.SemanticReason == nil || *resp.SemanticReason != suggest.ReasonDisabledServer {
					t.Fatalf("src=%T semantic=%s: got semantic_reason=%v, want %q",
						src, semParam, resp.SemanticReason, suggest.ReasonDisabledServer)
				}
			}
		}

		// (b) Custom NearSource reporting an earlier-precedence reason (disabled_user) wins over
		// request_lexical (semantic=0) and short_query (semantic=1) on recent, and receives Cap=0, QN="".
		var recordedReqs []suggest.NearRequest
		env.svc.SetNearSource(stubNearSource{
			fn: func(_ context.Context, req suggest.NearRequest) (suggest.NearResult, error) {
				recordedReqs = append(recordedReqs, req)
				reason := suggest.ReasonDisabledUser
				return suggest.NearResult{
					Semantic:       false,
					SemanticReason: &reason,
					Near:           []suggest.SuggestNearRow{},
					Generation:     nil,
				}, nil
			},
		})
		for _, semParam := range []string{"1", "0"} {
			rec := env.doSuggestSettled("tok-u1", url.Values{"semantic": {semParam}})
			resp := validateSuggestResponseOpenAPIShape(t, rec)
			if resp.Mode != suggest.ModeRecent || resp.Semantic || resp.Generation != nil || len(resp.Near) != 0 || resp.Quota.Near != 0 {
				t.Fatalf("unexpected recent state for stub disabled_user (semantic=%s): %+v", semParam, resp)
			}
			if resp.SemanticReason == nil || *resp.SemanticReason != suggest.ReasonDisabledUser {
				t.Fatalf("semantic=%s: got semantic_reason=%v, want %q", semParam, resp.SemanticReason, suggest.ReasonDisabledUser)
			}
		}
		if len(recordedReqs) != 2 {
			t.Fatalf("recordedReqs len = %d, want 2", len(recordedReqs))
		}
		for i, r := range recordedReqs {
			if r.Cap != 0 || r.QN != "" {
				t.Fatalf("recordedReqs[%d] = {Cap:%d, QN:%q}, want Cap=0 and QN=\"\" (no near work requested)", i, r.Cap, r.QN)
			}
		}
	})
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

	rec := env.doSuggestSettled("tok-u1", url.Values{"q": {"ma"}, "scope": {"item"}, "limit": {"8"}})
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

// TestSuggestBranchTimeoutPartial verifies plan P05 mục 2.3, 2.21, Task 3 and RV-T3-BE-4:
//   - (a) Deterministic client-deadline partial coverage (`context.DeadlineExceeded` via
//     `BeforeBranch` hook on item or tag branch).
//   - (b) PostgreSQL server-side statement cancellation coverage: `AfterBranchSetLocal` runs
//     `SELECT pg_sleep(0.2)` with an independent generously bounded test context (5 s) inside
//     the branch read tx so PostgreSQL's `SET LOCAL statement_timeout = '50ms'` fires first,
//     explicitly asserts `*pgconn.PgError` with `Code == "57014"` (`query_canceled`) before
//     returning the error to the service, and verifies surviving branch rows,
//     `lexical_partial` corpus, and exact `search_lexical_partial_total{corpus}` delta.
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
	t.Cleanup(func() { env.svc.SetTestHooks(nil) })

	// Warm both branches with a normal request first so pgxpool connections and prepared
	// statements are ready before exercising partial-timeout paths.
	warmPoolConns(t, pool, 2)
	warmRec := env.doSuggest("tok-u1", url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}})
	warmResp := validateSuggestResponseOpenAPIShape(t, warmRec)
	if len(warmResp.Items) != 1 || len(warmResp.Tags) != 1 || len(warmResp.LexicalPartial) != 0 {
		t.Fatalf("warm request unexpected response: %+v", warmResp)
	}

	// Part (a): Deterministic client-deadline partial coverage (`context.DeadlineExceeded`).
	t.Run("client-deadline-partial", func(t *testing.T) {
		// (a.1) Item branch hits client context.DeadlineExceeded; tag branch survives.
		warmPoolConns(t, pool, 2)
		beforeItem := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusItem)
		beforeTag := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)

		env.svc.SetTestHooks(&suggest.TestHooks{
			BeforeBranch: func(_ context.Context, corpus string) error {
				if corpus == suggest.CorpusItem {
					return context.DeadlineExceeded
				}
				return nil
			},
		})

		recItem := env.doSuggest("tok-u1", url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}})
		respItem := validateSuggestResponseOpenAPIShape(t, recItem)
		if !slices.Equal(respItem.LexicalPartial, []string{"item"}) {
			t.Fatalf("lexical_partial = %v, want [\"item\"]", respItem.LexicalPartial)
		}
		if len(respItem.Items) != 0 {
			t.Fatalf("timed-out item branch must return 0 items, got %d", len(respItem.Items))
		}
		if len(respItem.Tags) != 1 || respItem.Tags[0].Display != "wifi-tag" {
			t.Fatalf("surviving tag branch must return 'wifi-tag', got %+v", respItem.Tags)
		}
		afterItem := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusItem)
		afterTag := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)
		if afterItem != beforeItem+1 || afterTag != beforeTag {
			t.Fatalf("counters after item client deadline = (item=%v, tag=%v), want (%v, %v)",
				afterItem, afterTag, beforeItem+1, beforeTag)
		}

		// (a.2) Tag branch hits client context.DeadlineExceeded; item branch survives.
		warmPoolConns(t, pool, 2)
		env.svc.SetTestHooks(&suggest.TestHooks{
			BeforeBranch: func(_ context.Context, corpus string) error {
				if corpus == suggest.CorpusTag {
					return context.DeadlineExceeded
				}
				return nil
			},
		})

		recTag := env.doSuggest("tok-u1", url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}})
		respTag := validateSuggestResponseOpenAPIShape(t, recTag)
		if !slices.Equal(respTag.LexicalPartial, []string{"tag"}) {
			t.Fatalf("lexical_partial = %v, want [\"tag\"]", respTag.LexicalPartial)
		}
		if len(respTag.Tags) != 0 {
			t.Fatalf("timed-out tag branch must return 0 tags, got %d", len(respTag.Tags))
		}
		if len(respTag.Items) != 1 || respTag.Items[0].Name != "wifi văn phòng" {
			t.Fatalf("surviving item branch must return 'wifi văn phòng', got %+v", respTag.Items)
		}
		afterTag2 := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)
		if afterTag2 != beforeTag+1 {
			t.Fatalf("LexicalPartialTotal{corpus=tag} = %v, want %v", afterTag2, beforeTag+1)
		}
	})

	// Part (b): PostgreSQL server-side statement_timeout (`SET LOCAL statement_timeout = '50ms'`)
	// firing SQLSTATE 57014 (`query_canceled`) before any client context deadline.
	t.Run("postgres-statement-timeout-57014", func(t *testing.T) {
		// (b.1) Item branch canceled by PostgreSQL statement_timeout (SQLSTATE 57014); tag branch survives.
		warmPoolConns(t, pool, 2)
		beforeItem := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusItem)
		beforeTag := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)

		var observedItemErr error
		env.svc.SetTestHooks(&suggest.TestHooks{
			AfterBranchSetLocal: func(_ context.Context, tx pgx.Tx, corpus string) error {
				if corpus != suggest.CorpusItem {
					return nil
				}
				// Use an independent 5s context so client-side cancellation cannot preempt
				// PostgreSQL's transaction-local `SET LOCAL statement_timeout = '50ms'`.
				sleepCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_, err := tx.Exec(sleepCtx, `SELECT pg_sleep(0.2)`)
				observedItemErr = err
				return err
			},
		})

		recItem := env.doSuggest("tok-u1", url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}})
		var pgErrItem *pgconn.PgError
		if !errors.As(observedItemErr, &pgErrItem) || pgErrItem.Code != "57014" {
			t.Fatalf("item branch hook error = %v (type %T), want *pgconn.PgError with Code=\"57014\"",
				observedItemErr, observedItemErr)
		}

		respItem := validateSuggestResponseOpenAPIShape(t, recItem)
		if !slices.Equal(respItem.LexicalPartial, []string{"item"}) {
			t.Fatalf("lexical_partial = %v, want [\"item\"]", respItem.LexicalPartial)
		}
		if len(respItem.Items) != 0 {
			t.Fatalf("timed-out item branch must return 0 items, got %d", len(respItem.Items))
		}
		if len(respItem.Tags) != 1 || respItem.Tags[0].Display != "wifi-tag" {
			t.Fatalf("surviving tag branch must return 'wifi-tag', got %+v", respItem.Tags)
		}
		afterItem := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusItem)
		afterTag := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)
		if afterItem != beforeItem+1 {
			t.Fatalf("LexicalPartialTotal{corpus=item} = %v, want %v", afterItem, beforeItem+1)
		}
		if afterTag != beforeTag {
			t.Fatalf("LexicalPartialTotal{corpus=tag} = %v, want unchanged %v", afterTag, beforeTag)
		}

		// (b.2) Tag branch canceled by PostgreSQL statement_timeout (SQLSTATE 57014); item branch survives.
		warmPoolConns(t, pool, 2)
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

		recTag := env.doSuggest("tok-u1", url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}})
		var pgErrTag *pgconn.PgError
		if !errors.As(observedTagErr, &pgErrTag) || pgErrTag.Code != "57014" {
			t.Fatalf("tag branch hook error = %v (type %T), want *pgconn.PgError with Code=\"57014\"",
				observedTagErr, observedTagErr)
		}

		respTag := validateSuggestResponseOpenAPIShape(t, recTag)
		if !slices.Equal(respTag.LexicalPartial, []string{"tag"}) {
			t.Fatalf("lexical_partial = %v, want [\"tag\"]", respTag.LexicalPartial)
		}
		if len(respTag.Tags) != 0 {
			t.Fatalf("timed-out tag branch must return 0 tags, got %d", len(respTag.Tags))
		}
		if len(respTag.Items) != 1 || respTag.Items[0].Name != "wifi văn phòng" {
			t.Fatalf("surviving item branch must return 'wifi văn phòng', got %+v", respTag.Items)
		}
		afterTag2 := counterValueByCorpus(t, env.reg, "search_lexical_partial_total", suggest.CorpusTag)
		if afterTag2 != beforeTag+1 {
			t.Fatalf("LexicalPartialTotal{corpus=tag} = %v, want %v", afterTag2, beforeTag+1)
		}
	})
}

// delayTxStarter delays BeginTx (the stand-in for a slow pool acquire: pool wait, dial, handshake)
// and then delegates to the REAL pool, so the transaction, the SET LOCALs and the query run on a
// real pgx connection. The wait aborts if the setup context ends first.
type delayTxStarter struct {
	inner suggest.TxStarter
	delay time.Duration
	begun atomic.Int32
}

func (d *delayTxStarter) BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error) {
	d.begun.Add(1)
	timer := time.NewTimer(d.delay)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return d.inner.BeginTx(ctx, opts)
}

// TestSuggestSlowAcquireRealDBStillReturnsLexicalRows is the real-driver regression of FU-SB-2
// (RV-SB2-BE-3): BeginTx takes 120 ms, longer than the whole 50 ms query budget, and then hands a
// real pgx transaction to the branch. Before the fix the 50 ms context also covered acquire+BEGIN,
// so each branch expired before its query ran and returned `lexical_partial` with no rows. Now
// setup has its own bound and the query gets a fresh 50 ms, so the real SET LOCAL and the real
// query still return the fixture rows and nothing is partial.
//
// The query path is warmed with one normal settled request first, so a cold first Parse/plan (the
// FU-SB-2b residual owned by Task 23) is not the condition under test. There is deliberately no
// elapsed-time ceiling: the assertions are on rows, `lexical_partial` and the begin count.
func TestSuggestSlowAcquireRealDBStillReturnsLexicalRows(t *testing.T) {
	dsn := startTestDB(t) // skips under -short like the other DB tests
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	_, users := loadAndSeedCorpus(t, ctx, pool)
	env := newSuggestTestEnv(t, pool)
	env.auth.addToken("tok-u1", users["u1"])

	params := url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}}
	warm := validateSuggestResponseOpenAPIShape(t, env.doSuggestSettled("tok-u1", params))
	if len(warm.Items) == 0 || len(warm.Tags) == 0 {
		t.Fatalf("warm-up returned no lexical rows: items=%d tags=%d", len(warm.Items), len(warm.Tags))
	}

	slow := &delayTxStarter{inner: pool, delay: 120 * time.Millisecond}
	env.svc.SetTxStarter(slow)
	rec := env.doSuggest("tok-u1", params)
	resp := validateSuggestResponseOpenAPIShape(t, rec)

	if got := slow.begun.Load(); got < 2 {
		t.Fatalf("delayed BeginTx calls = %d, want >= 2 (one per lexical branch)", got)
	}
	if len(resp.LexicalPartial) != 0 {
		t.Fatalf("lexical_partial = %v after a 120 ms acquire, want none: setup must not spend the 50 ms query budget", resp.LexicalPartial)
	}
	if !suggestItemsContain(resp.Items, uuid.MustParse("00000000-0001-4000-8000-000000000009")) {
		t.Fatalf("items %+v lack the fixture item \"wifi\"", resp.Items)
	}
	if !suggestTagsContain(resp.Tags, uuid.MustParse("00000000-0011-4000-8000-000000000001")) {
		t.Fatalf("tags %+v lack the fixture tag \"wifi-khách\"", resp.Tags)
	}
}
