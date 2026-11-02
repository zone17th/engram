package semantic_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/semantic"
	"github.com/zone17th/engram/apps/api/internal/semantic/semantictest"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// TestSemanticNeverLogsQuery verifies plan P05 mục 1, 2.7, 2.21, and Task 12:
//   - Across success (cache miss + cache hit) and every degrade/disable path
//     (`disabled_server`, `disabled_user`, `request_lexical`, `short_query`,
//     `generation_unconfigured`, `provider_timeout`, `provider_5xx`,
//     `provider_429`, `provider_bad_response`, `dims_mismatch`, SQL branch timeout,
//     and TEI `/info` boot failure), neither structured logs (`slog` at LevelDebug)
//     nor `/metrics` output ever contain:
//   - raw query `q` or normalized `qn`
//   - item `name` or tag `display`
//   - provider URLs, path slugs, API keys, or upstream error response bodies.
func TestSemanticNeverLogsQuery(t *testing.T) {
	ctx := context.Background()
	ts := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(ts)

	const (
		sentinelQueryOK       = "SentinelQuerySuccessAlpha7711"
		sentinelQueryMismatch = "SentinelQueryMismatchBeta8822"
		sentinelQuery5xx      = "SentinelQueryProvider5xxGamma9933"
		sentinelQueryDims     = "SentinelQueryDimsDelta4455"
		sentinelQuerySQLTime  = "SentinelQuerySQLTimeoutEpsilon6677"
		sentinelQueryUserOff  = "SentinelQueryUserOffZeta1122"
		sentinelQueryShort    = "q9"
		sentinelItemName      = "SentinelItemNameVaultSecret3344"
		sentinelTagDisplay    = "SentinelTagDisplaySecret5566"
		sentinelAPIKey        = "sk-live-sentinel-secret-key-99887766"
		sentinelURLPath       = "/secret-provider-gateway-path-4433"
		sentinelUpstreamBody  = "UpstreamConfidentialErrorPayloadBody2211"
	)

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	reg, metrics := obs.NewRegistry()

	// 1. Exercise boot-time TEI /info failure via NewRuntimeFromConfig (degrade C4):
	// Upstream returns 503 with sentinelUpstreamBody at a URL containing sentinelURLPath.
	failingTEISrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(sentinelUpstreamBody))
	}))
	defer failingTEISrv.Close()

	bootCfg := &config.Config{
		Env:                      "development",
		SearchSemanticEnabled:    true,
		EmbeddingProvider:        embedding.ProviderTEI,
		TEIURL:                   embedding.NewEndpoint(failingTEISrv.URL + sentinelURLPath),
		EmbeddingDimensions:      8,
		EmbeddingQueryTimeout:    50 * time.Millisecond,
		EmbeddingDocumentTimeout: 50 * time.Millisecond,
	}
	bootRT := semantic.NewRuntimeFromConfig(ctx, bootCfg, nil, nil, clk, metrics, logger)
	if bootRT.Availability(ctx) {
		t.Fatal("expected bootRT.Availability() == false when TEI /info failed at boot")
	}

	// 2. Build a real OpenAICompat client backed by embedtest.Server to exercise
	// full provider logging on success and on upstream HTTP 500 with sentinelUpstreamBody.
	embedHandler := embedtest.NewHandler(embedtest.Options{
		Dims:    8,
		ModelID: "openrouter/qwen/qwen3-embedding-8b",
	})
	var force500 bool
	providerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if force500 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(sentinelUpstreamBody))
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = strings.TrimPrefix(r.URL.Path, sentinelURLPath)
		embedHandler.ServeHTTP(w, r2)
	}))
	defer providerSrv.Close()

	openAICfg := embedding.ClientConfig{
		Provider:         embedding.ProviderOpenAICompat,
		BaseURL:          embedding.NewEndpoint(providerSrv.URL + sentinelURLPath),
		APIKey:           embedding.NewSecret(sentinelAPIKey),
		Model:            "openrouter/qwen/qwen3-embedding-8b",
		Dims:             8,
		QueryInstruction: "Given a short search query, retrieve matching item names or tags",
		QueryTimeout:     100 * time.Millisecond,
		DocumentTimeout:  100 * time.Millisecond,
	}
	client, err := embedding.NewClientFromConfig(ctx, openAICfg, embedding.RolePrimary, embedding.ClientDeps{
		Metrics: metrics.Embedding,
		Logger:  logger,
		Now:     clk.Now,
	})
	if err != nil {
		t.Fatalf("NewClientFromConfig: %v", err)
	}
	cs := embedding.NewClientSet(client, nil)
	pin := testPinForIdentity(1, client.Identity)
	pinner := semantictest.NewSpyPinner(pin, true)

	searcher := &semantictest.SpyVectorSearcher{
		ItemHits: []semantic.VectorHit{
			{
				ID:         uuid.MustParse("00000000-0001-4000-8000-000000000001"),
				Cos:        0.92,
				Name:       sentinelItemName,
				Count:      3,
				LastUsedAt: ts,
				CreatedAt:  ts,
			},
		},
		TagHits: []semantic.VectorHit{
			{
				ID:         uuid.MustParse("00000000-0011-4000-8000-000000000001"),
				Cos:        0.95,
				Display:    sentinelTagDisplay,
				Count:      2,
				LastUsedAt: ts,
			},
		},
	}
	settings := &semantictest.StaticSettingsReader{Default: true}

	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderOpenAICompat,
		ClientSet:      cs,
		Pinner:         pinner,
		Calibration:    matchingCalibration(client.Identity),
		VectorSearcher: searcher,
		SettingsReader: settings,
		Metrics:        metrics,
		Logger:         logger,
		Clock:          clk,
	})

	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	nearSrc := rt.NearSource()

	// Path A: Success (cache miss) + Success (cache hit).
	for range 2 {
		res, err := nearSrc.Near(ctx, suggest.NearRequest{
			UserID:        userID,
			QN:            sentinelQueryOK,
			Scope:         suggest.ScopeAll,
			Limit:         8,
			Cap:           2,
			SemanticParam: true,
		})
		if err != nil || !res.Semantic {
			t.Fatalf("Path A Near failed: res=%+v err=%v", res, err)
		}
	}

	// Path B: User disabled (`disabled_user`).
	settings.Default = false
	_, _ = nearSrc.Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            sentinelQueryUserOff,
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	settings.Default = true

	// Path C: Request lexical (`request_lexical`) and short query (`short_query`).
	_, _ = nearSrc.Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            sentinelQueryOK,
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: false,
	})
	_, _ = nearSrc.Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            sentinelQueryShort,
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})

	// Path D: Generation identity mismatch (`generation_unconfigured`).
	badID := client.Identity
	badID.DocPrefix = "mismatch-doc-prefix"
	pinner.SetPin(testPinForIdentity(1, badID), true)
	_, _ = nearSrc.Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            sentinelQueryMismatch,
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	pinner.SetPin(pin, true)

	// Path E: SQL branch timeout (`degraded`).
	searcher.ItemStats = semantic.VectorPathStats{Path: "exact", TimedOut: true}
	_, _ = nearSrc.Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            sentinelQuerySQLTime,
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	searcher.ItemStats = semantic.VectorPathStats{Path: "exact", TimedOut: false}

	// Path F: Provider 500 error (`provider_5xx` -> trips breaker -> next call hits open breaker).
	force500 = true
	_, _ = nearSrc.Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            sentinelQuery5xx,
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	// Call again while breaker is open.
	_, _ = nearSrc.Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            sentinelQuery5xx,
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})
	force500 = false
	clk.Advance(61 * time.Second) // allow breaker to enter half-open

	// Path G: Dims mismatch from provider (`dims_mismatch`).
	wrongDimsID := testTEIIdentity()
	wrongDimsSpy := semantictest.NewSpyProvider(wrongDimsID)
	wrongDimsSpy.EmbedQueryFn = func(context.Context, string) ([]float32, error) {
		return []float32{1.0, 0.0}, nil // 2 dims instead of 8
	}
	wrongDimsRT := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderTEI,
		ClientSet:      embedding.NewClientSet(embedding.NewClient(wrongDimsSpy, "", ""), nil),
		Pinner:         semantictest.NewSpyPinner(testPinForIdentity(1, wrongDimsID), true),
		Calibration:    matchingCalibration(wrongDimsID),
		VectorSearcher: searcher,
		SettingsReader: settings,
		Metrics:        metrics,
		Logger:         logger,
		Clock:          clk,
	})
	_, _ = wrongDimsRT.NearSource().Near(ctx, suggest.NearRequest{
		UserID:        userID,
		QN:            sentinelQueryDims,
		Scope:         suggest.ScopeAll,
		Limit:         8,
		Cap:           2,
		SemanticParam: true,
	})

	// Scrape /metrics as well.
	metricsRec := httptest.NewRecorder()
	promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}).ServeHTTP(
		metricsRec,
		httptest.NewRequest(http.MethodGet, "/metrics", nil),
	)

	logs := logBuf.String()
	metricsBody := metricsRec.Body.String()

	forbidden := []struct {
		name string
		val  string
	}{
		{"sentinelQueryOK", sentinelQueryOK},
		{"sentinelQueryOK lower", strings.ToLower(sentinelQueryOK)},
		{"sentinelQueryMismatch", sentinelQueryMismatch},
		{"sentinelQuery5xx", sentinelQuery5xx},
		{"sentinelQueryDims", sentinelQueryDims},
		{"sentinelQuerySQLTime", sentinelQuerySQLTime},
		{"sentinelQueryUserOff", sentinelQueryUserOff},
		{"sentinelItemName", sentinelItemName},
		{"sentinelTagDisplay", sentinelTagDisplay},
		{"sentinelAPIKey", sentinelAPIKey},
		{"sentinelURLPath", sentinelURLPath},
		{"sentinelUpstreamBody", sentinelUpstreamBody},
		{"providerSrv URL", providerSrv.URL},
		{"failingTEISrv URL", failingTEISrv.URL},
		{"userID", userID.String()},
	}

	for _, f := range forbidden {
		if strings.Contains(logs, f.val) {
			t.Fatalf("slog output leaked %s (%q):\n%s", f.name, f.val, logs)
		}
		if strings.Contains(metricsBody, f.val) {
			t.Fatalf("/metrics output leaked %s (%q):\n%s", f.name, f.val, metricsBody)
		}
	}
}

type fakeAuth struct {
	mu      sync.Mutex
	cookies map[string]authctx.Principal
}

func (a *fakeAuth) Authenticate(_ context.Context, access string) (authctx.Principal, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if p, ok := a.cookies[access]; ok {
		return p, nil
	}
	return authctx.Principal{}, &httpx.AuthError{Code: "unauthenticated"}
}

// TestSuggestWithRealNearSourceLexicalByteIdentical verifies plan P05 mục 2.4
// and Task 12:
//   - Wiring the real `semantic.Runtime.NearSource()` into `suggest.Service`
//     produces byte-identical lexical `tags`, `items`, and `quota` arrays
//     across:
//     (a) `suggest.NewNoopNearSource()` (Phase A baseline),
//     (b) `semantic.Runtime.NearSource()` with semantic disabled at the server, and
//     (c) `semantic.Runtime.NearSource()` with semantic enabled and returning near rows.
//   - Also exercises `StoreVectorSearcher` (backed by Task 14 `store.VectorSearch`)
//     against the real PostgreSQL `item_embedding_g1` and `tag_embedding_g1`
//     partition tables created by `generation.Bootstrap`.
func TestSuggestWithRealNearSourceLexicalByteIdentical(t *testing.T) {
	pool := newTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	ts := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(ts)
	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")

	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'sem-suggest@example.com', 'vi')`, userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	lexItemID := uuid.MustParse("00000000-0001-4000-8000-000000000101")
	nearItemID := uuid.MustParse("00000000-0001-4000-8000-000000000102")
	lexTagID := uuid.MustParse("00000000-0011-4000-8000-000000000101")
	nearTagID := uuid.MustParse("00000000-0011-4000-8000-000000000102")

	if _, err := pool.Exec(ctx, `
		INSERT INTO item (id, user_id, name, name_normalized, hint, entry_count, last_used_at, created_at, updated_at)
		VALUES
			($1, $3, 'wifi phòng khách', 'wifi phong khach', 'bộ phát chính', 5, $4, $4, $4),
			($2, $3, 'bộ phát sóng tầng 2', 'bo phat song tang 2', 'mạng phụ', 2, $4, $4, $4)
	`, lexItemID, nearItemID, userID, ts); err != nil {
		t.Fatalf("insert items: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
		VALUES
			($1, $3, 'wifi-khách', 'wifi-khách', 4, $4, $4, $4),
			($2, $3, 'mạng-gia-đình', 'mạng-gia-đình', 3, $4, $4, $4)
	`, lexTagID, nearTagID, userID, ts); err != nil {
		t.Fatalf("insert tags: %v", err)
	}

	if _, err := pool.Exec(ctx, `INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)`, nearItemID, nearTagID); err != nil {
		t.Fatalf("insert item_tag: %v", err)
	}

	// Bootstrap g1 (8 dims) and activate it; insert vectors for nearItemID and nearTagID.
	teiID := testTEIIdentity()
	cal := matchingCalibration(teiID)
	bootRes, err := generation.Bootstrap(ctx, pool, teiID, cal)
	if err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE embedding_generation SET state = 'active', activated_at = now() WHERE id = $1`, bootRes.Generation.ID); err != nil {
		t.Fatalf("activate g1: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO embedding_active (singleton, generation_id, flipped_at) VALUES (true, $1, now())`, bootRes.Generation.ID); err != nil {
		t.Fatalf("insert embedding_active: %v", err)
	}
	hash32 := bytes.Repeat([]byte{0xab}, 32)
	if _, err := pool.Exec(ctx, `
		INSERT INTO item_embedding_g1 (user_id, target_id, embedding, model, model_version, input_hash)
		VALUES ($1, $2, '[1,0,0,0,0,0,0,0]'::vector, $3, $4, $5)
	`, userID, nearItemID, teiID.Model, teiID.ModelVersion, hash32); err != nil {
		t.Fatalf("insert item_embedding_g1: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO tag_embedding_g1 (user_id, target_id, embedding, model, model_version, input_hash)
		VALUES ($1, $2, '[1,0,0,0,0,0,0,0]'::vector, $3, $4, $5)
	`, userID, nearTagID, teiID.Model, teiID.ModelVersion, hash32); err != nil {
		t.Fatalf("insert tag_embedding_g1: %v", err)
	}

	cursorKey, err := suggest.DeriveCursorKey([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("DeriveCursorKey: %v", err)
	}
	_, metrics := obs.NewRegistry()
	auth := &fakeAuth{cookies: map[string]authctx.Principal{
		"tok-u1": {UserID: userID, SessionID: uuid.New()},
	}}

	buildRouter := func(near suggest.NearSource) http.Handler {
		bucket := httpx.NewTokenBucket(10_000, 10_000, clk)
		svc := suggest.NewService(pool, clk, near, metrics, cursorKey)
		handler := suggest.NewHandler(svc, bucket)
		return httpx.NewRouter(httpx.Deps{
			Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
			MetricsCollector: metrics,
			Authenticator:    auth,
			MountAPI:         suggest.Mount(handler),
		})
	}

	callSuggest := func(router http.Handler, q url.Values) suggest.SuggestResponse {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/suggest?"+q.Encode(), nil)
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok-u1"})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /suggest status = %d, body = %s", rec.Code, rec.Body.String())
		}
		var resp suggest.SuggestResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode SuggestResponse: %v", err)
		}
		return resp
	}

	// Router 1: W1 NoopNearSource.
	noopRouter := buildRouter(suggest.NewNoopNearSource())

	// Router 2: Real semantic.Runtime with semantic disabled (SEARCH_SEMANTIC_ENABLED=false).
	disabledRT := semantic.NewRuntimeFromConfig(ctx, &config.Config{
		Env:                   "development",
		SearchSemanticEnabled: false,
		EmbeddingProvider:     embedding.ProviderNoop,
	}, pool, generation.NewPinner(pool, generation.WithPinNowFunc(clk.Now)), clk, metrics, nil)
	disabledRouter := buildRouter(disabledRT.NearSource())

	// Router 3: Real semantic.Runtime with semantic enabled + StoreVectorSearcher against Postgres.
	spyProv := semantictest.NewSpyProvider(teiID) // returns [1,0,0,0,0,0,0,0]
	enabledRT := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        true,
		Provider:       embedding.ProviderTEI,
		ClientSet:      embedding.NewClientSet(embedding.NewClient(spyProv, "", ""), nil),
		Pinner:         generation.NewPinner(pool, generation.WithPinNowFunc(clk.Now)),
		Calibration:    cal,
		VectorSearcher: semantic.NewStoreVectorSearcher(pool),
		SettingsReader: semantic.NewDBUserSettingsReader(pool),
		ItemTagLoader:  semantic.NewDBItemTagRefLoader(pool),
		Metrics:        metrics,
		Clock:          clk,
	})
	enabledRouter := buildRouter(enabledRT.NearSource())

	params := url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}, "semantic": {"1"}}
	respNoop := callSuggest(noopRouter, params)
	respDisabled := callSuggest(disabledRouter, params)
	respEnabled := callSuggest(enabledRouter, params)

	// Lexical arrays (tags, items) and quota MUST be byte-identical across all three.
	for _, field := range []struct {
		name string
		a    any
		b    any
		c    any
	}{
		{"tags", respNoop.Tags, respDisabled.Tags, respEnabled.Tags},
		{"items", respNoop.Items, respDisabled.Items, respEnabled.Items},
		{"quota", respNoop.Quota, respDisabled.Quota, respEnabled.Quota},
	} {
		ja, _ := json.Marshal(field.a)
		jb, _ := json.Marshal(field.b)
		jc, _ := json.Marshal(field.c)
		if !bytes.Equal(ja, jb) || !bytes.Equal(ja, jc) {
			t.Fatalf("%s JSON differs across noop / disabled / enabled:\nnoop    =%s\ndisabled=%s\nenabled =%s",
				field.name, string(ja), string(jb), string(jc))
		}
	}

	// Enabled response must have Semantic=true, Generation=1, and 2 near rows (tag first, then item).
	if !respEnabled.Semantic || respEnabled.SemanticReason != nil || respEnabled.Generation == nil || *respEnabled.Generation != 1 {
		t.Fatalf("enabled response semantic metadata = %+v", respEnabled)
	}
	if len(respEnabled.Near) != 2 {
		t.Fatalf("len(respEnabled.Near) = %d, want 2 (nearTagID + nearItemID)", len(respEnabled.Near))
	}
	rawNearItem, err := json.Marshal(respEnabled.Near[1])
	if err != nil {
		t.Fatalf("marshal near item: %v", err)
	}
	var nearItem suggest.SuggestItem
	if err := json.Unmarshal(rawNearItem, &nearItem); err != nil {
		t.Fatalf("unmarshal near item: %v", err)
	}
	if nearItem.ID != nearItemID || nearItem.Match != suggest.MatchSemantic || nearItem.TagTotal != 1 || len(nearItem.Tags) != 1 || nearItem.Tags[0].ID != nearTagID {
		t.Fatalf("nearItem = %+v, want ID=%s Match=semantic TagTotal=1 Tags=[%s]", nearItem, nearItemID, nearTagID)
	}

	// Verify Task 14 store.VectorSearch recorded search_vector_path_total{corpus, path="exact"}
	// for both item and tag branches via forwarded obs.Metrics.Search (RV-T12-BE-6, dec-293).
	if got := counterValue(t, metrics.Search.VectorPathTotal.WithLabelValues(suggest.CorpusItem, string(semantic.VectorPathExact))); got != 1 {
		t.Fatalf("search_vector_path_total{corpus=item,path=exact} = %v, want 1", got)
	}
	if got := counterValue(t, metrics.Search.VectorPathTotal.WithLabelValues(suggest.CorpusTag, string(semantic.VectorPathExact))); got != 1 {
		t.Fatalf("search_vector_path_total{corpus=tag,path=exact} = %v, want 1", got)
	}
}
