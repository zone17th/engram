package compose_test

// P05 Task 20b (PR 20b-1, lane semops): degrade C4 and "no storm" acceptance
// (plan P05 mục 2.13, 2.17, 2.21; SPEC §6.6 l.~1155-1157).
//
//   - TestDegradeProviderDownLexicalStillServes: provider hangs -> the first
//     query times out and opens the API breaker; the next 50 suggests inside the
//     60 s window reach the provider 0 times and answer 200, lexical,
//     semantic_reason "degraded"; /readyz stays 200; after 60 s exactly ONE
//     half-open probe goes out.
//   - TestQuickAddWhileProviderDown: POST /items and /tags stay 201 and enqueue
//     their embed jobs while the provider is dead.
//   - TestDegradeBreakerNoStorm: 200 real T11a embed jobs against a provider
//     that answers 503 for 10 (virtual) minutes -> provider requests <= 2 x
//     (half-open probes + backoff attempts).
//   - TestRecoveryNoStorm: the provider comes back after a short outage -> every
//     job completes with exactly one provider request, none is dead-lettered;
//     the API half-open admits ONE concurrent probe, then closes.
//
// Time is driven through the product's clock seams only (clock.Fixed for the API
// runtime/breaker/rate bucket, jobs.Dependencies.Now + the worker breaker clock);
// there are no real waits beyond the provider's own 200 ms query timeout. River's
// scheduler is the one thing we cannot fast-forward, so the job tests drive the
// REAL embed_item worker (jobs.EmbedItemWorker.Work) from a small virtual-time
// scheduler that applies River's contract: a returned JobSnooze reschedules
// without consuming an attempt, any other error consumes one and retries at
// worker.NextRetry, attempt MaxEmbedAttempts is the last.
//
// One Postgres container per package run (plan gate 10): TestMain below owns it;
// every test gets its own database on it. The fake provider is an in-process
// httptest server wrapping embedtest (TEI protocol) with a counting mode switch.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	mrand "math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/entry/entryhttp"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/item/itemhttp"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/semantic"
	"github.com/zone17th/engram/apps/api/internal/tag/taghttp"
	"github.com/zone17th/engram/apps/api/internal/vault/vaulthttp"
)

const (
	dgDims          = 8
	dgQueryTimeout  = 200 * time.Millisecond // real time the hung provider costs one query
	dgJobCount      = 200
	dgVirtualStep   = 5 * time.Second
	dgOutageWindow  = 10 * time.Minute
	dgShortOutage   = 3 * time.Minute
	dgRecoveryLimit = 10 * time.Minute
)

var (
	dgBaseOnce      sync.Once
	dgBaseDSN       string
	dgBaseErr       error
	dgSharedBaseCtr testcontainers.Container
)

// TestMain owns the single shared Postgres container of this package (plan P05
// gate 10). vault_test.go keeps its own per-test containers; they are unaffected.
func TestMain(m *testing.M) {
	code := m.Run()
	if dgSharedBaseCtr != nil {
		_ = testcontainers.TerminateContainer(dgSharedBaseCtr)
	}
	os.Exit(code)
}

func dgBasePostgresDSN(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping Postgres integration test in -short mode")
	}
	if envDSN := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL")); envDSN != "" {
		return envDSN
	}
	dgBaseOnce.Do(func() {
		ctx := context.Background()
		c, err := tcpostgres.Run(ctx, "pgvector/pgvector:pg16",
			tcpostgres.WithDatabase("engram"),
			tcpostgres.WithUsername("engram"),
			tcpostgres.WithPassword("engram"),
			testcontainers.WithWaitStrategy(
				wait.ForLog("database system is ready to accept connections").
					WithOccurrence(2).WithStartupTimeout(90*time.Second)),
		)
		if err != nil {
			dgBaseErr = err
			return
		}
		dgSharedBaseCtr = c
		dgBaseDSN, dgBaseErr = c.ConnectionString(ctx, "sslmode=disable")
	})
	if dgBaseErr != nil {
		t.Fatalf("start shared Postgres container: %v", dgBaseErr)
	}
	return dgBaseDSN
}

// dgNewPool creates a migrated database of its own on the shared container.
func dgNewPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	base := dgBasePostgresDSN(t)
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse base DSN: %v", err)
	}
	var nonce [6]byte
	_, _ = rand.Read(nonce[:])
	dbName := "engram_degrade_" + hex.EncodeToString(nonce[:])

	admin := *u
	admin.Path = "/postgres"
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin.String())
	if err != nil {
		t.Fatalf("connect admin DB: %v", err)
	}
	if _, err := conn.Exec(ctx, `CREATE DATABASE "`+dbName+`"`); err != nil {
		_ = conn.Close(ctx)
		t.Fatalf("CREATE DATABASE %s: %v", dbName, err)
	}
	_ = conn.Close(ctx)

	u.Path = "/" + dbName
	dsn := u.String()
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), admin.String())
		if err != nil {
			return
		}
		defer func() { _ = c.Close(context.Background()) }()
		_, _ = c.Exec(context.Background(), `DROP DATABASE IF EXISTS "`+dbName+`" WITH (FORCE)`)
	})
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	return dbtest.Pool(t, dsn)
}

// ---------------------------------------------------------------------------
// Fake provider: embedtest (TEI protocol) behind a counting mode switch.
// ---------------------------------------------------------------------------

type dgMode int32

const (
	dgModeOK   dgMode = iota // answer normally
	dgModeHang               // hold /embed until the client gives up (timeout)
	dgModeDown               // 503 on /embed
	dgModeGate               // hold /embed until the gate is released, then answer
)

type dgProvider struct {
	backend *embedtest.Server
	srv     *httptest.Server

	mode     atomic.Int32
	queries  atomic.Int64 // POST /embed carrying the query prefix
	docs     atomic.Int64 // every other POST /embed
	inflight atomic.Int64 // POST /embed currently held by the gate

	gateMu sync.Mutex
	gate   chan struct{}
}

func newDGProvider(t *testing.T) *dgProvider {
	t.Helper()
	p := &dgProvider{
		backend: embedtest.NewHandler(embedtest.Options{
			Dims: dgDims, ModelID: "BAAI/bge-m3", ModelSHA: "rev-degrade", QueryPrefix: "query: ",
		}),
		gate: make(chan struct{}),
	}
	p.srv = httptest.NewServer(p)
	t.Cleanup(p.srv.Close)
	return p
}

func (p *dgProvider) setMode(m dgMode) { p.mode.Store(int32(m)) }

// armGate switches to gate mode with a fresh, closed-on-release gate.
func (p *dgProvider) armGate() {
	p.gateMu.Lock()
	p.gate = make(chan struct{})
	p.gateMu.Unlock()
	p.setMode(dgModeGate)
}

func (p *dgProvider) releaseGate() {
	p.gateMu.Lock()
	defer p.gateMu.Unlock()
	select {
	case <-p.gate:
	default:
		close(p.gate)
	}
}

func (p *dgProvider) currentGate() chan struct{} {
	p.gateMu.Lock()
	defer p.gateMu.Unlock()
	return p.gate
}

// total is the number of embedding requests (query + document) the provider received.
func (p *dgProvider) total() int64 { return p.queries.Load() + p.docs.Load() }

func (p *dgProvider) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost && r.URL.Path == "/embed" {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		r.Body = io.NopCloser(bytes.NewReader(body))
		if bytes.Contains(body, []byte("query: ")) {
			p.queries.Add(1)
		} else {
			p.docs.Add(1)
		}
		switch dgMode(p.mode.Load()) {
		case dgModeHang:
			<-r.Context().Done()
			return
		case dgModeDown:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":"unavailable"}`))
			return
		case dgModeGate:
			p.inflight.Add(1)
			defer p.inflight.Add(-1)
			select {
			case <-p.currentGate():
			case <-r.Context().Done():
				return
			}
		}
	}
	p.backend.ServeHTTP(w, r)
}

func dgTEIClient(t *testing.T, p *dgProvider) embedding.Client {
	t.Helper()
	c, err := embedding.NewClientFromConfig(context.Background(), embedding.ClientConfig{
		Provider:        embedding.ProviderTEI,
		BaseURL:         embedding.NewEndpoint(p.srv.URL),
		Dims:            dgDims,
		QueryPrefix:     "query: ",
		DocPrefix:       "passage: ",
		QueryTimeout:    dgQueryTimeout,
		DocumentTimeout: 5 * time.Second,
	}, embedding.RolePrimary, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("tei client: %v", err)
	}
	return c
}

// dgSeedActiveGeneration inserts g1 (bootstrap, active) and its vector tables.
func dgSeedActiveGeneration(t *testing.T, pool *pgxpool.Pool, ident embedid.Identity) generation.Generation {
	t.Helper()
	ctx := context.Background()
	q := gen.New(pool)
	if _, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 1,
		Provider:           ident.Provider,
		Model:              ident.Model,
		ModelVersion:       ident.ModelVersion,
		Preprocessing:      ident.Preprocessing,
		QueryPrefix:        ident.QueryPrefix,
		DocPrefix:          ident.DocPrefix,
		Dims:               int32(ident.Dims),
		Partitions:         4,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.55,
		CalibrationRef:     "docs/benchmarks/semantic-eval/report.json",
		Bootstrap:          true,
	}); err != nil {
		t.Fatalf("InsertPendingEmbeddingGeneration: %v", err)
	}
	if err := q.CreateEmbeddingGenerationTables(ctx, gen.CreateEmbeddingGenerationTablesParams{
		ID:                 1,
		Dims:               int32(ident.Dims),
		Partitions:         4,
		WithHnsw:           false,
		HnswM:              16,
		HnswEfConstruction: 64,
	}); err != nil {
		t.Fatalf("CreateEmbeddingGenerationTables: %v", err)
	}
	row, err := q.ActivateEmbeddingGeneration(ctx, 1)
	if err != nil {
		t.Fatalf("ActivateEmbeddingGeneration: %v", err)
	}
	reason := "test"
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{GenerationID: 1, FlippedReason: &reason}); err != nil {
		t.Fatalf("UpsertEmbeddingActive: %v", err)
	}
	g, err := generation.FromDBRow(row)
	if err != nil {
		t.Fatalf("FromDBRow: %v", err)
	}
	return g
}

// dgMetricValue reads the first counter/gauge sample of name whose labels match.
func dgMetricValue(t *testing.T, reg *prometheus.Registry, name string, labels map[string]string) float64 {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("reg.Gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() != name {
			continue
		}
		for _, m := range f.GetMetric() {
			matched := 0
			for _, lp := range m.GetLabel() {
				if v, ok := labels[lp.GetName()]; ok && v == lp.GetValue() {
					matched++
				}
			}
			if matched != len(labels) {
				continue
			}
			if m.GetCounter() != nil {
				return m.GetCounter().GetValue()
			}
			if m.GetGauge() != nil {
				return m.GetGauge().GetValue()
			}
		}
	}
	return 0
}

// ---------------------------------------------------------------------------
// API environment: the real router, compose wiring as cmd/api/main.go builds it.
// ---------------------------------------------------------------------------

type dgEnv struct {
	t      *testing.T
	pool   *pgxpool.Pool
	h      *contenttest.Harness
	jar    contenttest.CookieJar
	userID uuid.UUID
	rt     *semantic.Runtime
	reg    *prometheus.Registry
	clk    *clock.Fixed // runtime, API breaker and the search_read bucket
	prov   *dgProvider
	gen    generation.Generation
	sent   int // semantic=1 requests sent
}

func newDGEnv(t *testing.T) *dgEnv {
	t.Helper()
	e := &dgEnv{t: t, pool: dgNewPool(t), clk: clock.NewFixed(time.Now().UTC())}
	e.prov = newDGProvider(t)
	client := dgTEIClient(t, e.prov)
	e.gen = dgSeedActiveGeneration(t, e.pool, client.Identity)
	cs := embedding.NewClientSet(client, nil)

	reg, metrics := obs.NewRegistry()
	e.reg = reg
	pinner := generation.NewPinner(e.pool)
	t.Cleanup(pinner.Close)
	knobs := semantic.DefaultVectorSearchKnobs()
	knobs.BranchTimeout = 3 * time.Second // CI headroom: this is not a latency test
	key := e.gen.Identity().Key()
	e.rt = semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:   true,
		Provider:  embedding.ProviderTEI,
		ClientSet: cs,
		Pinner:    pinner,
		Calibration: func(id embedid.Identity) (float64, string, bool) {
			if id.Key() == key {
				return 0.62, "docs/benchmarks/semantic-eval/report.json", true
			}
			return 0, "", false
		},
		Knobs:          knobs,
		VectorSearcher: semantic.NewStoreVectorSearcher(e.pool),
		SettingsReader: semantic.NewDBUserSettingsReader(e.pool),
		ItemTagLoader:  semantic.NewDBItemTagRefLoader(e.pool),
		Metrics:        metrics,
		Clock:          e.clk,
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://" + ln.Addr().String()
	t.Setenv("DATABASE_URL", e.pool.Config().ConnString())
	t.Setenv("APP_ORIGIN", origin)
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "false")
	t.Setenv("VAULT_KEY_MUTATIONS_DISABLED", "false")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.SearchSemanticEnabled = true
	cfg.EmbeddingProvider = embedding.ProviderTEI

	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	insert, err := river.NewClient(riverpgxv5.New(e.pool), &river.Config{})
	if err != nil {
		t.Fatal(err)
	}
	mail, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc, _, authAPI, err := compose.NewAuth(cfg, e.pool, insert, nil, mail, nil, compose.WithSemantic(e.rt))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Close)
	authn, csrfv, reauth := compose.Adapters(svc)
	_, vaultAPI, err := compose.NewVault(cfg, e.pool, insert, nil, mail, metrics, entry.ResetHook, logger)
	if err != nil {
		t.Fatal(err)
	}
	contentComp, err := compose.NewContent(cfg, e.pool, nil, metrics, logger, compose.WithEmbedRiver(insert))
	if err != nil {
		t.Fatal(err)
	}
	searchComp, err := compose.NewSearch(cfg, e.pool, e.clk, metrics, logger, e.rt.NearSource())
	if err != nil {
		t.Fatal(err)
	}
	router := httpx.NewRouter(httpx.Deps{
		Config:               cfg,
		Logger:               logger,
		Ready:                db.ReadyCheck(e.pool),
		Metrics:              promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
		MetricsCollector:     metrics,
		Authenticator:        authn,
		CSRF:                 csrfv,
		Reauth:               reauth,
		MountAPI:             compose.MountAll(authhttp.Mount(authAPI), vaulthttp.Mount(vaultAPI), itemhttp.Mount(contentComp), taghttp.Mount(contentComp), entryhttp.Mount(contentComp), searchComp.Mount),
		SemanticAvailability: e.rt.Availability,
	})
	srv := httptest.NewUnstartedServer(router)
	_ = srv.Listener.Close()
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)

	e.h = &contenttest.Harness{T: t, Server: srv, Origin: origin, Pool: e.pool}
	jar, me := e.h.SignupUser("degrade-"+uuid.NewString()+"@example.com", "correct-horse-battery-staple-a")
	e.jar = jar
	e.userID = me.User.ID
	return e
}

func (e *dgEnv) do(method, path, body string) (int, string) {
	e.t.Helper()
	opt := contenttest.ReqOptions{}
	if method != http.MethodGet && (strings.HasPrefix(path, "/api/v1/items") || strings.HasPrefix(path, "/api/v1/tags")) {
		opt.IdemKey = "idem-" + uuid.NewString()
	}
	resp, raw := e.h.DoReq(e.jar, method, path, body, opt)
	return resp.StatusCode, raw
}

func (e *dgEnv) create(corpus, name string) uuid.UUID {
	e.t.Helper()
	path, body := "/api/v1/items", fmt.Sprintf(`{"name":%q}`, name)
	if corpus == "tag" {
		path, body = "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, name)
	}
	code, raw := e.do(http.MethodPost, path, body)
	if code != http.StatusCreated {
		e.t.Fatalf("POST %s = %d %s, want 201", path, code, raw)
	}
	var out struct {
		ID uuid.UUID `json:"id"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil || out.ID == uuid.Nil {
		e.t.Fatalf("decode created %s id: %v (%s)", corpus, err, raw)
	}
	return out.ID
}

// dgResponse is the subset of /suggest and /search the degrade tests assert on.
type dgResponse struct {
	Semantic       bool    `json:"semantic"`
	SemanticReason *string `json:"semantic_reason"`
	Items          []struct {
		ID uuid.UUID `json:"id"`
	} `json:"items"`
	Tags []struct {
		ID uuid.UUID `json:"id"`
	} `json:"tags"`
	Near []struct {
		ID uuid.UUID `json:"id"`
	} `json:"near"`
}

func (r dgResponse) reason() string {
	if r.SemanticReason == nil {
		return ""
	}
	return *r.SemanticReason
}

func (r dgResponse) hasItem(id uuid.UUID) bool {
	for _, it := range r.Items {
		if it.ID == id {
			return true
		}
	}
	return false
}

func dgQueryPath(route, q string) string {
	v := url.Values{}
	v.Set("q", q)
	v.Set("scope", "all")
	v.Set("semantic", "1")
	return "/api/v1/" + route + "?" + v.Encode()
}

func dgDecode(t *testing.T, route string, code int, raw string) dgResponse {
	t.Helper()
	if code != http.StatusOK {
		t.Fatalf("GET %s = %d %s, want 200", route, code, raw)
	}
	var out dgResponse
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("decode %s response: %v", route, err)
	}
	return out
}

// query sends one semantic=1 request after advancing the shared clock by step
// (the search_read bucket refills 20/s; 1 s per request keeps it from 429-ing).
func (e *dgEnv) query(route, q string, step time.Duration) dgResponse {
	e.t.Helper()
	e.clk.Advance(step)
	e.sent++
	code, raw := e.do(http.MethodGet, dgQueryPath(route, q), "")
	return dgDecode(e.t, route, code, raw)
}

// rawGET is safe to call from non-test goroutines (no t.Fatal): the harness
// DoReq is not.
func (e *dgEnv) rawGET(path string) (int, []byte, error) {
	req, err := http.NewRequest(http.MethodGet, e.h.Server.URL+path, nil)
	if err != nil {
		return 0, nil, err
	}
	maps.Clone(e.jar).Apply(req)
	resp, err := e.h.Server.Client().Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	return resp.StatusCode, raw, err
}

func (e *dgEnv) assertReadyz() {
	e.t.Helper()
	code, raw := e.do(http.MethodGet, "/api/v1/readyz", "")
	if code != http.StatusOK {
		e.t.Fatalf("GET /readyz = %d %s, want 200 while the provider is down", code, raw)
	}
}

func (e *dgEnv) assertDegradedLexical(r dgResponse, wantItem uuid.UUID, what string) {
	e.t.Helper()
	if r.Semantic || r.reason() != "degraded" {
		e.t.Fatalf("%s: semantic=%v reason=%q, want false/degraded", what, r.Semantic, r.reason())
	}
	if len(r.Near) != 0 {
		e.t.Fatalf("%s: near has %d rows, want 0", what, len(r.Near))
	}
	if !r.hasItem(wantItem) {
		e.t.Fatalf("%s: lexical rows lost the item while degraded", what)
	}
}

func (e *dgEnv) breakerOpenGauge() float64 {
	return dgMetricValue(e.t, e.reg, "embedding_breaker_open", map[string]string{"provider": embedding.ProviderTEI, "process": "api"})
}

func (e *dgEnv) degradedDecisions() float64 {
	return dgMetricValue(e.t, e.reg, "semantic_decisions_total", map[string]string{"reason": "degraded"})
}

// ---------------------------------------------------------------------------
// Evidence tests (plan P05 Task 20b, PR 20b-1)
// ---------------------------------------------------------------------------

func TestDegradeProviderDownLexicalStillServes(t *testing.T) {
	e := newDGEnv(t)
	wifi := e.create("item", "Wifi router upstairs")

	// Sanity: while the provider is healthy the same request runs semantically.
	if r := e.query("suggest", "wifi", time.Second); !r.Semantic || r.reason() != "" {
		t.Fatalf("healthy baseline: semantic=%v reason=%q, want true/null", r.Semantic, r.reason())
	}
	if e.rt.Breaker().State() != embedding.BreakerStateClosed {
		t.Fatalf("breaker = %s before the outage, want closed", e.rt.Breaker().State())
	}

	// The provider now hangs: the FIRST query times out (dgQueryTimeout), the API
	// breaker (threshold 1) opens, and the response is still a 200 lexical one.
	e.prov.setMode(dgModeHang)
	beforeFirst := e.prov.total()
	degradedBefore := e.degradedDecisions()
	sentBefore := e.sent
	first := e.query("suggest", "router", time.Second)
	e.assertDegradedLexical(first, wifi, "first query (timeout)")
	if got := e.prov.total() - beforeFirst; got != 1 {
		t.Fatalf("provider requests for the first query = %d, want exactly 1", got)
	}
	if st := e.rt.Breaker().State(); st != embedding.BreakerStateOpen {
		t.Fatalf("breaker = %s after a timed-out query, want open", st)
	}
	if g := e.breakerOpenGauge(); g != 1 {
		t.Fatalf("embedding_breaker_open{tei,api} = %v, want 1", g)
	}

	// Next 50 suggests inside the 60 s window (50 x 1 s of virtual time): the
	// provider receives NOTHING, every answer is 200 / lexical / degraded.
	afterOpen := e.prov.total()
	queries := []string{"wifi", "wifi router", "router", "upstairs", "wifi router upstairs"}
	for i := 0; i < 50; i++ {
		r := e.query("suggest", queries[i%len(queries)], time.Second)
		e.assertDegradedLexical(r, wifi, fmt.Sprintf("suggest #%d inside the breaker window", i+1))
	}
	if got := e.prov.total() - afterOpen; got != 0 {
		t.Fatalf("provider requests during 50 suggests inside the 60 s window = %d, want 0", got)
	}
	// /search takes the same near path: lexical results, degraded, no provider call.
	rs := e.query("search", "wifi", time.Second)
	e.assertDegradedLexical(rs, wifi, "/search inside the breaker window")
	if got := e.prov.total() - afterOpen; got != 0 {
		t.Fatalf("provider requests after /search = %d, want 0", got)
	}
	e.assertReadyz()

	// Past the 60 s window exactly ONE half-open probe goes out (still hanging ->
	// times out -> the breaker reopens); everything else stays at 0.
	e.clk.Advance(11 * time.Second) // 51 s since open + 11 s + the probe's own 1 s > 60 s
	beforeProbe := e.prov.total()
	probe := e.query("suggest", "upstairs", time.Second)
	e.assertDegradedLexical(probe, wifi, "half-open probe")
	if got := e.prov.total() - beforeProbe; got != 1 {
		t.Fatalf("provider requests for the half-open probe = %d, want exactly 1", got)
	}
	if st := e.rt.Breaker().State(); st != embedding.BreakerStateOpen {
		t.Fatalf("breaker = %s after a failed probe, want open (reopened for another 60 s)", st)
	}
	afterProbe := e.prov.total()
	for i := 0; i < 10; i++ {
		r := e.query("suggest", queries[i%len(queries)], time.Second)
		e.assertDegradedLexical(r, wifi, fmt.Sprintf("suggest #%d after the probe", i+1))
	}
	if got := e.prov.total() - afterProbe; got != 0 {
		t.Fatalf("provider requests after the failed probe = %d, want 0", got)
	}
	e.assertReadyz()

	// Metrics: every degraded request was counted as a degraded decision (>=:
	// other code paths may add, never fewer), and the gauge still says open.
	if got, want := e.degradedDecisions()-degradedBefore, float64(e.sent-sentBefore); got < want {
		t.Fatalf("semantic_decisions_total{degraded} grew by %v, want >= %v", got, want)
	}
	if g := e.breakerOpenGauge(); g != 1 {
		t.Fatalf("embedding_breaker_open{tei,api} = %v at the end, want 1", g)
	}
}

func TestQuickAddWhileProviderDown(t *testing.T) {
	e := newDGEnv(t)
	e.prov.setMode(dgModeDown) // dead from the first request on: every embed call is a 503
	docsBefore := e.prov.docs.Load()

	// Quick-add (item + tag): enqueue is transactional and never talks to the
	// provider, so it cannot fail because of it.
	itemID := e.create("item", "Quick add while provider down")
	tagID := e.create("tag", "quicktag")
	for _, tc := range []struct {
		kind, corpus string
		id           uuid.UUID
	}{
		{jobargs.KindEmbedItem, "item", itemID},
		{jobargs.KindEmbedTag, "tag", tagID},
	} {
		var n int
		if err := e.pool.QueryRow(context.Background(),
			`SELECT count(*)::int FROM river_job WHERE kind = $1 AND args->>'target_id' = $2 AND (args->>'generation_id')::int = $3`,
			tc.kind, tc.id.String(), e.gen.ID).Scan(&n); err != nil {
			t.Fatalf("count %s jobs: %v", tc.corpus, err)
		}
		if n != 1 {
			t.Fatalf("%s embed jobs enqueued for g%d = %d, want 1 (enqueue must not fail while the provider is dead)", tc.corpus, e.gen.ID, n)
		}
	}
	if got := e.prov.docs.Load() - docsBefore; got != 0 {
		t.Fatalf("provider document requests during quick-add = %d, want 0 (workers did not run)", got)
	}

	// Reads and lexical suggest keep working; the new item is findable at once and
	// the semantic leg reports degraded (the query path hit the dead provider).
	if code, raw := e.do(http.MethodGet, "/api/v1/items/"+itemID.String(), ""); code != http.StatusOK {
		t.Fatalf("GET /items/{id} = %d %s, want 200", code, raw)
	}
	r := e.query("suggest", "quick add", time.Second)
	e.assertDegradedLexical(r, itemID, "suggest right after quick-add")
	e.assertReadyz()

	// A second quick-add after the breaker opened is just as fine.
	e.create("item", "Second quick add while breaker open")
	if got := e.prov.docs.Load() - docsBefore; got != 0 {
		t.Fatalf("provider document requests after the second quick-add = %d, want 0", got)
	}
}

// ---------------------------------------------------------------------------
// Jobs: the REAL embed_item worker under a virtual-time scheduler.
// ---------------------------------------------------------------------------

type dgSimJob struct {
	args    jobargs.EmbedItemArgs
	itemID  uuid.UUID
	due     time.Time
	attempt int // River attempt number of the next run (1-based)
	done    bool
	dead    bool
	errors  int // failed attempts that consumed an attempt (River backoff retries)
	snoozes int
}

type dgJobsEnv struct {
	t      *testing.T
	pool   *pgxpool.Pool
	clk    *clock.Fixed
	prov   *dgProvider
	user   uuid.UUID
	gen    generation.Generation
	worker *jobs.EmbedItemWorker
	sims   []*dgSimJob
}

func newDGJobsEnv(t *testing.T, n int) *dgJobsEnv {
	t.Helper()
	ctx := context.Background()
	e := &dgJobsEnv{t: t, pool: dgNewPool(t), clk: clock.NewFixed(time.Now().UTC())}
	e.prov = newDGProvider(t)
	client := dgTEIClient(t, e.prov)
	e.gen = dgSeedActiveGeneration(t, e.pool, client.Identity)
	cs := embedding.NewClientSet(client, nil)
	_, metrics := obs.NewRegistry()

	insert, err := river.NewClient(riverpgxv5.New(e.pool), &river.Config{})
	if err != nil {
		t.Fatalf("river insert client: %v", err)
	}
	q := gen.New(e.pool)
	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "degrade-jobs-" + uuid.NewString() + "@example.com", Locale: "vi"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	e.user = user.ID

	// Real worker deps: the worker-mode breaker (3 failures -> 60 s) on the same
	// virtual clock as the scheduler, deterministic snooze jitter and retry jitter.
	rnd := mrand.New(mrand.NewPCG(20, 26))
	e.worker = jobs.NewEmbedItemWorker(jobs.Dependencies{
		Pool:       e.pool,
		ClientSet:  cs,
		Breakers:   jobs.NewWorkerBreakers(e.clk.Now, metrics.Embedding),
		Metrics:    metrics.Embedding,
		Now:        e.clk.Now,
		Jitter:     func() float64 { return 0 },
		RandSource: rnd,
		Inserter:   jobs.RiverClientInserter{Client: insert},
	})

	for i := 0; i < n; i++ {
		name := fmt.Sprintf("degrade job item %03d", i)
		row, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: user.ID, Name: name, NameNormalized: strings.ToLower(name)})
		if err != nil {
			t.Fatalf("InsertItem %d: %v", i, err)
		}
		hash := embedding.InputHashFor(e.gen.Identity(), embedding.ItemInput(name, ""))
		args := jobargs.EmbedItemArgs{
			GenerationID: e.gen.ID,
			UserID:       user.ID.String(),
			TargetID:     row.ID.String(),
			InputHash:    hex.EncodeToString(hash[:]),
		}
		if _, err := insert.Insert(ctx, args, jobs.EmbedInsertOpts(jobargs.KindEmbedItem)); err != nil {
			t.Fatalf("enqueue embed_item %d: %v", i, err)
		}
		e.sims = append(e.sims, &dgSimJob{args: args, itemID: row.ID, due: e.clk.Now(), attempt: 1})
	}
	return e
}

// runUntil advances virtual time in dgVirtualStep ticks, running every due job
// through the real worker once per tick, until `until` or (when stopWhenDone) all
// jobs are final.
func (e *dgJobsEnv) runUntil(until time.Time, stopWhenDone bool) {
	e.t.Helper()
	ctx := context.Background()
	for e.clk.Now().Before(until) {
		now := e.clk.Now()
		pending := 0
		for _, sj := range e.sims {
			if sj.done || sj.dead {
				continue
			}
			pending++
			if sj.due.After(now) {
				continue
			}
			job := &river.Job[jobargs.EmbedItemArgs]{JobRow: &rivertype.JobRow{Attempt: sj.attempt}, Args: sj.args}
			err := e.worker.Work(ctx, job)
			var snooze *river.JobSnoozeError
			switch {
			case err == nil:
				sj.done = true
			case asSnooze(err, &snooze):
				// River: a snooze does not consume an attempt.
				sj.snoozes++
				sj.due = now.Add(snooze.Duration)
			default:
				sj.errors++
				if sj.attempt >= jobs.MaxEmbedAttempts {
					sj.dead = true // River would discard (dead-letter) it here
					continue
				}
				sj.due = e.worker.NextRetry(job)
				sj.attempt++
			}
		}
		if stopWhenDone && pending == 0 {
			return
		}
		e.clk.Advance(dgVirtualStep)
	}
}

func asSnooze(err error, target **river.JobSnoozeError) bool {
	return errors.As(err, target)
}

func (e *dgJobsEnv) counts() (done, dead, errored, maxAttempt int) {
	for _, sj := range e.sims {
		if sj.done {
			done++
		}
		if sj.dead {
			dead++
		}
		errored += sj.errors
		if sj.attempt > maxAttempt {
			maxAttempt = sj.attempt
		}
	}
	return done, dead, errored, maxAttempt
}

func TestDegradeBreakerNoStorm(t *testing.T) {
	e := newDGJobsEnv(t, dgJobCount)
	e.prov.setMode(dgModeDown) // every embed request answers 503
	start := e.clk.Now()

	e.runUntil(start.Add(dgOutageWindow), false)

	requests := e.prov.total()
	done, dead, errored, maxAttempt := e.counts()
	if done != 0 || dead != 0 {
		t.Fatalf("during a 503 outage done=%d dead=%d, want 0/0", done, dead)
	}
	// Plan 2.21: requests over the 10 min window <= 2 x (half-open probes + backoff
	// attempts). Half-open: one probe per 60 s window. Backoff attempts: the
	// failures the worker breaker needs to open (BreakerWorkerFailureThreshold), each
	// of which consumes a River attempt and retries at the 1 min backoff.
	probes := int(dgOutageWindow/embedding.BreakerOpenWindow) + 1
	backoffAttempts := embedding.BreakerWorkerFailureThreshold
	limit := int64(2 * (probes + backoffAttempts))
	if requests > limit {
		t.Fatalf("provider requests over %s with %d jobs = %d, want <= 2 x (%d probes + %d backoff) = %d",
			dgOutageWindow, dgJobCount, requests, probes, backoffAttempts, limit)
	}
	// Not vacuous: the provider was reached (the breaker had to open first) and the
	// bound is far below one request per job.
	if requests < int64(embedding.BreakerWorkerFailureThreshold) {
		t.Fatalf("provider requests = %d, want >= %d (the breaker needs %d failures to open)",
			requests, embedding.BreakerWorkerFailureThreshold, embedding.BreakerWorkerFailureThreshold)
	}
	if requests >= dgJobCount/4 {
		t.Fatalf("provider requests = %d for %d jobs: that is a retry storm", requests, dgJobCount)
	}
	// Only the failures before the breaker opened consumed attempts; every later
	// outcome was a snooze, so nothing is anywhere near the 30-attempt dead letter.
	if errored > embedding.BreakerWorkerFailureThreshold {
		t.Fatalf("attempt-consuming failures = %d, want <= %d (the rest must snooze)", errored, embedding.BreakerWorkerFailureThreshold)
	}
	if maxAttempt >= jobs.MaxEmbedAttempts {
		t.Fatalf("a job reached attempt %d of %d during a 10 min outage", maxAttempt, jobs.MaxEmbedAttempts)
	}
	// And the 200 jobs really were parked (snoozed with jitter), not spun.
	snoozes := 0
	for _, sj := range e.sims {
		snoozes += sj.snoozes
	}
	if snoozes < dgJobCount-errored {
		t.Fatalf("snoozes = %d, want >= %d (every job without a failed attempt parks on the open breaker)", snoozes, dgJobCount-errored)
	}
}

func TestRecoveryNoStorm(t *testing.T) {
	t.Run("jobs_complete_none_dead_lettered", func(t *testing.T) {
		e := newDGJobsEnv(t, dgJobCount)
		e.prov.setMode(dgModeDown)
		start := e.clk.Now()
		e.runUntil(start.Add(dgShortOutage), false)
		if done, _, _, _ := e.counts(); done != 0 {
			t.Fatalf("jobs done during the outage = %d, want 0", done)
		}
		duringOutage := e.prov.total()

		// The provider recovers: the next half-open probe succeeds, the breaker
		// closes, and the jobs drain.
		e.prov.setMode(dgModeOK)
		recoveredAt := e.clk.Now()
		e.runUntil(recoveredAt.Add(dgRecoveryLimit), true)

		done, dead, errored, maxAttempt := e.counts()
		if dead != 0 || maxAttempt >= jobs.MaxEmbedAttempts {
			t.Fatalf("dead-lettered jobs = %d (max attempt %d): a %s outage must not exhaust attempts", dead, maxAttempt, dgShortOutage)
		}
		if errored > embedding.BreakerWorkerFailureThreshold {
			t.Fatalf("attempt-consuming failures = %d, want <= %d", errored, embedding.BreakerWorkerFailureThreshold)
		}
		if done != dgJobCount {
			t.Fatalf("jobs completed after recovery = %d of %d within %s of virtual time", done, dgJobCount, dgRecoveryLimit)
		}
		// No storm on the way back: each job costs exactly one provider request.
		if got := e.prov.total() - duringOutage; got != dgJobCount {
			t.Fatalf("provider requests during recovery = %d, want exactly %d (one per job)", got, dgJobCount)
		}
		// Every job left a vector with its hash in the active generation.
		ctx := context.Background()
		for i, sj := range e.sims {
			meta, ok, err := store.GetTargetMeta(ctx, e.pool, e.gen, generation.CorpusItem, e.user, sj.itemID)
			if err != nil {
				t.Fatalf("GetTargetMeta job %d: %v", i, err)
			}
			if !ok {
				t.Fatalf("job %d has no vector after recovery", i)
			}
			want := embedding.InputHashFor(e.gen.Identity(), embedding.ItemInput(fmt.Sprintf("degrade job item %03d", i), ""))
			if !bytes.Equal(meta.InputHash, want[:]) {
				t.Fatalf("job %d stored hash differs from its input hash", i)
			}
		}
	})

	t.Run("api_half_open_admits_one_probe", func(t *testing.T) {
		e := newDGEnv(t)
		wifi := e.create("item", "Wifi router upstairs")

		e.prov.setMode(dgModeHang)
		if r := e.query("suggest", "wifi hang", time.Second); r.Semantic {
			t.Fatal("query against a hung provider must degrade")
		}
		if st := e.rt.Breaker().State(); st != embedding.BreakerStateOpen {
			t.Fatalf("breaker = %s, want open", st)
		}

		// The window elapses and the provider is back but slow (gated). A burst of
		// concurrent suggests arrives: ONE becomes the half-open trial and holds the
		// gate, all others are rejected without touching the provider.
		e.clk.Advance(61 * time.Second)
		e.prov.armGate()
		before := e.prov.total()
		const burst = 8
		type result struct {
			code int
			raw  []byte
			err  error
		}
		results := make(chan result, burst)
		var wg sync.WaitGroup
		for i := 0; i < burst; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				code, raw, err := e.rawGET(dgQueryPath("suggest", fmt.Sprintf("wifi burst %d", i)))
				results <- result{code, raw, err}
			}(i)
		}
		t.Cleanup(func() { e.prov.releaseGate(); wg.Wait() })

		// Deterministic wait (no fixed sleep): the trial is parked at the gate and
		// the other burst-1 requests have already come back degraded.
		var collected []result
		deadline := time.Now().Add(20 * time.Second)
		for len(collected) < burst-1 {
			select {
			case r := <-results:
				collected = append(collected, r)
			case <-time.After(time.Until(deadline)):
				t.Fatalf("only %d of %d rejected burst requests returned before the trial finished", len(collected), burst-1)
			}
		}
		for time.Now().Before(deadline) && e.prov.inflight.Load() != 1 {
			time.Sleep(10 * time.Millisecond)
		}
		if got := e.prov.inflight.Load(); got != 1 {
			t.Fatalf("requests held at the provider = %d, want exactly 1 (the half-open trial)", got)
		}
		if got := e.prov.total() - before; got != 1 {
			t.Fatalf("provider requests during the half-open burst = %d, want exactly 1", got)
		}
		for i, r := range collected {
			if r.err != nil {
				t.Fatalf("burst request: %v", r.err)
			}
			resp := dgDecode(t, "suggest", r.code, string(r.raw))
			if resp.Semantic || resp.reason() != "degraded" {
				t.Fatalf("rejected burst request %d: semantic=%v reason=%q, want false/degraded", i, resp.Semantic, resp.reason())
			}
		}

		// The trial completes: it answers semantically and the breaker closes.
		e.prov.releaseGate()
		last := <-results
		if last.err != nil {
			t.Fatalf("trial request: %v", last.err)
		}
		trial := dgDecode(t, "suggest", last.code, string(last.raw))
		if !trial.Semantic || trial.reason() != "" {
			t.Fatalf("trial request: semantic=%v reason=%q, want true/null", trial.Semantic, trial.reason())
		}
		wg.Wait()
		if st := e.rt.Breaker().State(); st != embedding.BreakerStateClosed {
			t.Fatalf("breaker = %s after the trial succeeded, want closed", st)
		}
		if g := e.breakerOpenGauge(); g != 0 {
			t.Fatalf("embedding_breaker_open{tei,api} = %v after recovery, want 0", g)
		}
		// Recovered: the next query reaches the provider normally and runs semantic.
		e.prov.setMode(dgModeOK)
		next := e.query("suggest", "router", time.Second)
		if !next.Semantic || next.reason() != "" || !next.hasItem(wifi) {
			t.Fatalf("after recovery: semantic=%v reason=%q hasItem=%v, want true/null/true", next.Semantic, next.reason(), next.hasItem(wifi))
		}
	})
}
