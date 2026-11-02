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
//     (half-open probes + backoff attempts), work invocations bounded, every
//     returned snooze at least the breaker's remaining window (+ positive jitter).
//   - TestRecoveryNoStorm: the provider comes back after a short outage -> every
//     job completes with exactly one provider request, none is dead-lettered;
//     the API half-open admits ONE concurrent probe, then closes.
//   - TestNoStormEvidenceRejectsMutations: negative controls — an immediate
//     snooze, raised queue concurrency and a too-small persisted MaxAttempts each
//     make the job evidence helper report a violation.
//
// Time is driven through the product's clock seams only (clock.Fixed for the API
// runtime/breaker/rate bucket, jobs.Dependencies.Now + the worker breaker clock);
// there are no sleeps. The only real waits are the provider's own 200 ms query
// timeout in the outage fixture and bounded channel receives.
//
// What the job scheduler models, and what it does not. River's scheduler cannot
// be fast-forwarded, so the job tests drive the REAL embed_item worker
// (jobs.EmbedItemWorker.Work, real DB, real breakers, real snooze + jitter) from
// a small virtual-time simulator that applies River's contract: a returned
// JobSnooze reschedules at completion + duration without consuming an attempt, any
// other error consumes one and retries at worker.NextRetry, and the attempt that
// reaches the persisted row's MaxAttempts is the last. The simulator is event
// driven: the next event is the earliest due job, rounded up to River's 1 s fetch
// poll; backoff always comes from the worker's own snooze/retry (a snooze below
// the breaker's remaining window, or an immediate one, is a violation and aborts
// the run). Work runs on jobs.MaxEmbedWorkers overlapping slots, and the provider
// measures the peak number of simultaneous requests and the largest document batch
// through entry/release channels. MaxAttempts and the queue come from the rows
// River actually persisted for the inserted jobs. Not covered here, by design:
// final river_job states (completed/discarded) and River's own fetch/producer
// loop; those need a River-backed run on a real clock and are left to the worker
// package's integration tests. The simulator's rules were checked against River
// v0.31.0's job executor (JobSnooze handling precedes error/max-attempt handling).
//
// One shared Postgres container per package run for the fixtures in this file
// (plan gate 10): TestMain below owns it and every test gets its own database on
// it. The pre-existing vault_test.go keeps its own container (outside this
// change's file scope, recorded exception), so a full package run starts two
// containers. The fake provider is an in-process httptest server wrapping
// embedtest (TEI protocol) with a counting mode switch.

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
	dgDims         = 8
	dgQueryTimeout = 200 * time.Millisecond // outage fixture: real time the hung provider costs one query
	// dgRecoveryQueryTimeout is the recovery fixture's generous query timeout: the
	// half-open trial is parked at the provider until the competing requests are
	// answered, which must never race a 200 ms deadline on a loaded runner.
	dgRecoveryQueryTimeout = 30 * time.Second
	dgJobDocTimeout        = 60 * time.Second // job fixtures park requests at the provider on purpose
	dgJobCount             = 200
	dgFetchPoll            = time.Second // River's default FetchPollInterval: events are rounded up to it
	dgOutageWindow         = 10 * time.Minute
	dgShortOutage          = 3 * time.Minute
	dgRecoveryLimit        = 10 * time.Minute

	// Plan P05 2.17 limits, spelled out so a regression of the product constant is
	// not silently followed by the test: 2 workers on the embedding queue, 30
	// attempts (>= 24 h of backoff).
	dgPlanMaxEmbedWorkers = 2
	dgPlanMaxAttempts     = 30

	dgHoldDeadline = 30 * time.Second // upper bound a parked provider request waits for its release
	dgRecvDeadline = 30 * time.Second // upper bound of every test-side channel receive
)

var (
	dgBaseOnce      sync.Once
	dgBaseDSN       string
	dgBaseErr       error
	dgSharedBaseCtr testcontainers.Container
)

// TestMain owns the shared Postgres container of the degrade fixtures (plan P05
// gate 10). vault_test.go keeps its own container (recorded exception: not in this
// change's file scope); it is unaffected and is terminated by its own cleanup.
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
)

// dgHold parks every /embed request at the provider until the test lets it go.
// entered: the provider tells the test a request has arrived (a barrier, not a
// poll). release: the test lets ONE parked request continue. closed: lets every
// current and future request continue (cleanup, abort).
type dgHold struct {
	entered chan struct{}
	release chan struct{}
	closed  chan struct{}
	once    sync.Once
}

func newDGHold() *dgHold {
	return &dgHold{
		entered: make(chan struct{}, 4096),
		release: make(chan struct{}, 4096),
		closed:  make(chan struct{}),
	}
}

// openAll releases everything parked now or later. Idempotent.
func (h *dgHold) openAll() { h.once.Do(func() { close(h.closed) }) }

// park signals entry and waits for a release, bounded by dgHoldDeadline. It
// reports whether the request should go on to be answered.
func (h *dgHold) park(ctx context.Context) bool {
	select {
	case h.entered <- struct{}{}:
	default: // buffer full: the receiver is long gone, never block the provider
	}
	timer := time.NewTimer(dgHoldDeadline)
	defer timer.Stop()
	select {
	case <-h.release:
		return true
	case <-h.closed:
		return true
	case <-ctx.Done():
		return false
	case <-timer.C:
		return false
	}
}

type dgProvider struct {
	backend *embedtest.Server
	srv     *httptest.Server

	mode      atomic.Int32
	queries   atomic.Int64 // POST /embed carrying the query prefix
	docs      atomic.Int64 // every other POST /embed
	active    atomic.Int64 // POST /embed requests being handled right now (parked ones included)
	peak      atomic.Int64 // highest value active ever reached
	maxInputs atomic.Int64 // largest number of inputs in one POST /embed (document batch length)

	holdMu sync.Mutex
	hold   *dgHold
}

func newDGProvider(t *testing.T) *dgProvider {
	t.Helper()
	p := &dgProvider{
		backend: embedtest.NewHandler(embedtest.Options{
			Dims: dgDims, ModelID: "BAAI/bge-m3", ModelSHA: "rev-degrade", QueryPrefix: "query: ",
		}),
	}
	p.srv = httptest.NewServer(p)
	t.Cleanup(p.srv.Close)
	return p
}

func (p *dgProvider) setMode(m dgMode) { p.mode.Store(int32(m)) }

// setHold installs (or, with nil, removes) the barrier every /embed request passes.
func (p *dgProvider) setHold(h *dgHold) {
	p.holdMu.Lock()
	p.hold = h
	p.holdMu.Unlock()
}

func (p *dgProvider) currentHold() *dgHold {
	p.holdMu.Lock()
	defer p.holdMu.Unlock()
	return p.hold
}

// total is the number of embedding requests (query + document) the provider received.
func (p *dgProvider) total() int64 { return p.queries.Load() + p.docs.Load() }

func dgInputCount(body []byte) int64 {
	var req struct {
		Inputs json.RawMessage `json:"inputs"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return 0
	}
	raw := bytes.TrimSpace(req.Inputs)
	if len(raw) == 0 {
		return 0
	}
	if raw[0] != '[' {
		return 1
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return 0
	}
	return int64(len(arr))
}

func (p *dgProvider) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost && r.URL.Path == "/embed" {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		r.Body = io.NopCloser(bytes.NewReader(body))
		if bytes.Contains(body, []byte("query: ")) {
			p.queries.Add(1)
		} else {
			p.docs.Add(1)
		}
		if n := dgInputCount(body); n > p.maxInputs.Load() {
			for {
				old := p.maxInputs.Load()
				if n <= old || p.maxInputs.CompareAndSwap(old, n) {
					break
				}
			}
		}
		now := p.active.Add(1)
		defer p.active.Add(-1)
		for {
			old := p.peak.Load()
			if now <= old || p.peak.CompareAndSwap(old, now) {
				break
			}
		}
		if h := p.currentHold(); h != nil && !h.park(r.Context()) {
			return
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
		}
	}
	p.backend.ServeHTTP(w, r)
}

func dgTEIClient(t *testing.T, p *dgProvider, queryTimeout, docTimeout time.Duration) embedding.Client {
	t.Helper()
	c, err := embedding.NewClientFromConfig(context.Background(), embedding.ClientConfig{
		Provider:        embedding.ProviderTEI,
		BaseURL:         embedding.NewEndpoint(p.srv.URL),
		Dims:            dgDims,
		QueryPrefix:     "query: ",
		DocPrefix:       "passage: ",
		QueryTimeout:    queryTimeout,
		DocumentTimeout: docTimeout,
	}, embedding.RolePrimary, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("tei client: %v", err)
	}
	return c
}

// dgRecv is a bounded, non-polling receive: it fails the test instead of hanging.
func dgRecv[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	timer := time.NewTimer(dgRecvDeadline)
	defer timer.Stop()
	select {
	case v := <-ch:
		return v
	case <-timer.C:
		t.Fatalf("timed out after %s waiting for %s", dgRecvDeadline, what)
	}
	panic("unreachable")
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

// newDGEnv builds the API stack. queryTimeout is the provider client's real
// query timeout: dgQueryTimeout (200 ms) for the outage fixture that needs a hung
// provider to time out, dgRecoveryQueryTimeout for fixtures that park a request.
func newDGEnv(t *testing.T, queryTimeout time.Duration) *dgEnv {
	t.Helper()
	e := &dgEnv{t: t, pool: dgNewPool(t), clk: clock.NewFixed(time.Now().UTC())}
	e.prov = newDGProvider(t)
	client := dgTEIClient(t, e.prov, queryTimeout, 5*time.Second)
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
	// Failure messages carry route label, status, decode error and counts only:
	// response bodies hold item/tag names and must never reach the Actions log.
	code, raw := e.do(http.MethodPost, path, body)
	if code != http.StatusCreated {
		e.t.Fatalf("POST %s = %d, want 201", path, code)
	}
	var out struct {
		ID uuid.UUID `json:"id"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		e.t.Fatalf("decode created %s id: %v", corpus, err)
	}
	if out.ID == uuid.Nil {
		e.t.Fatalf("created %s response has no id", corpus)
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
		t.Fatalf("GET %s = %d, want 200", route, code)
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
	if code, _ := e.do(http.MethodGet, "/api/v1/readyz", ""); code != http.StatusOK {
		e.t.Fatalf("GET /readyz = %d, want 200 while the provider is down", code)
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
	e := newDGEnv(t, dgQueryTimeout)
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
	e := newDGEnv(t, dgQueryTimeout)
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
	if code, _ := e.do(http.MethodGet, "/api/v1/items/"+itemID.String(), ""); code != http.StatusOK {
		t.Fatalf("GET /items/{id} = %d, want 200", code)
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
// Jobs: the REAL embed_item worker under an event-driven virtual-time scheduler
// (see the file header for exactly what this models and what it does not).
// ---------------------------------------------------------------------------

// dgWorkFunc is the worker entry point the simulator invokes. The default is the
// real jobs.EmbedItemWorker.Work; negative controls wrap it to mutate its result.
type dgWorkFunc func(context.Context, *river.Job[jobargs.EmbedItemArgs]) error

type dgSimJob struct {
	args        jobargs.EmbedItemArgs
	itemID      uuid.UUID
	due         time.Time
	attempt     int // River attempt number of the next run (1-based)
	maxAttempts int // MaxAttempts of the river_job row River persisted for this job
	done        bool
	dead        bool
	errors      int // failed attempts that consumed an attempt (River backoff retries)
	snoozes     int
}

type dgJobsOpts struct {
	slots      int                                 // overlapping worker slots; default jobs.MaxEmbedWorkers
	insertOpts func(kind string) *river.InsertOpts // default jobs.EmbedInsertOpts
	wrapWork   func(dgWorkFunc) dgWorkFunc         // negative controls only
}

// dgLockedRand makes the seeded snooze-jitter source safe for the overlapping
// worker slots (math/rand/v2 generators are not goroutine-safe).
type dgLockedRand struct {
	mu sync.Mutex
	r  *mrand.Rand
}

func (l *dgLockedRand) Int64N(n int64) int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.r.Int64N(n)
}

type dgWorkResult struct {
	idx int
	err error
}

type dgJobsEnv struct {
	t       *testing.T
	pool    *pgxpool.Pool
	clk     *clock.Fixed
	prov    *dgProvider
	hold    *dgHold
	user    uuid.UUID
	gen     generation.Generation
	worker  *jobs.EmbedItemWorker
	breaker *embedding.Breaker // the worker-mode breaker the worker was built with
	work    dgWorkFunc
	slots   int
	sims    []*dgSimJob
	start   time.Time

	// What River persisted for the inserted jobs (read from the returned rows).
	persistedMaxAttempts []int
	persistedQueues      []string

	invocations int // Work calls so far
	guard       int // hard cap on Work calls: a spinning scheduler aborts here
	rounds      int
	lastRound   time.Time
	tripAt      time.Time // virtual time the worker breaker last opened
	aborted     bool
	violations  []string
}

func newDGJobsEnv(t *testing.T, n int, opts dgJobsOpts) *dgJobsEnv {
	t.Helper()
	ctx := context.Background()
	e := &dgJobsEnv{t: t, pool: dgNewPool(t), clk: clock.NewFixed(time.Now().UTC()), slots: opts.slots}
	if e.slots <= 0 {
		e.slots = jobs.MaxEmbedWorkers
	}
	e.prov = newDGProvider(t)
	e.hold = newDGHold()
	e.prov.setHold(e.hold)
	t.Cleanup(e.hold.openAll) // registered after the provider server: runs before its Close
	client := dgTEIClient(t, e.prov, dgQueryTimeout, dgJobDocTimeout)
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
	// virtual clock as the scheduler, seeded snooze jitter, zero retry jitter.
	breakers := jobs.NewWorkerBreakers(e.clk.Now, metrics.Embedding)
	e.breaker = breakers[embedding.ProviderTEI]
	e.worker = jobs.NewEmbedItemWorker(jobs.Dependencies{
		Pool:       e.pool,
		ClientSet:  cs,
		Breakers:   breakers,
		Metrics:    metrics.Embedding,
		Now:        e.clk.Now,
		Jitter:     func() float64 { return 0 },
		RandSource: &dgLockedRand{r: mrand.New(mrand.NewPCG(20, 26))},
		Inserter:   jobs.RiverClientInserter{Client: insert},
	})
	e.work = e.worker.Work
	if opts.wrapWork != nil {
		e.work = opts.wrapWork(e.work)
	}
	insertOpts := opts.insertOpts
	if insertOpts == nil {
		insertOpts = jobs.EmbedInsertOpts
	}

	e.start = e.clk.Now()
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
		res, err := insert.Insert(ctx, args, insertOpts(jobargs.KindEmbedItem))
		if err != nil {
			t.Fatalf("enqueue embed_item %d: %v", i, err)
		}
		if res.UniqueSkippedAsDuplicate || res.Job == nil {
			t.Fatalf("enqueue embed_item %d did not insert a row", i)
		}
		e.persistedMaxAttempts = append(e.persistedMaxAttempts, res.Job.MaxAttempts)
		e.persistedQueues = append(e.persistedQueues, res.Job.Queue)
		e.sims = append(e.sims, &dgSimJob{args: args, itemID: row.ID, due: e.start, attempt: 1, maxAttempts: res.Job.MaxAttempts})
	}
	e.guard = dgInvocationBudget(n, dgOutageWindow+dgShortOutage+dgRecoveryLimit)
	return e
}

// dgInvocationBudget bounds Work calls over a horizon: a correct scheduler runs a
// job at most about once per breaker window (every reschedule is >= the remaining
// window), plus the first run and one boundary run.
func dgInvocationBudget(jobCount int, horizon time.Duration) int {
	return jobCount * (int(horizon/embedding.BreakerOpenWindow) + 2)
}

func (e *dgJobsEnv) violate(format string, args ...any) {
	e.violations = append(e.violations, fmt.Sprintf(format, args...))
}

func (e *dgJobsEnv) allFinal() bool {
	for _, sj := range e.sims {
		if !sj.done && !sj.dead {
			return false
		}
	}
	return true
}

// nextEvent is the earliest due pending job, rounded up to River's fetch poll
// (relative to the start). It never invents backoff: it only quantises a due
// time the worker itself chose.
func (e *dgJobsEnv) nextEvent() (time.Time, bool) {
	var earliest time.Time
	found := false
	for _, sj := range e.sims {
		if sj.done || sj.dead {
			continue
		}
		if !found || sj.due.Before(earliest) {
			earliest, found = sj.due, true
		}
	}
	if !found {
		return time.Time{}, false
	}
	off := max(earliest.Sub(e.start), 0)
	ticks := (off + dgFetchPoll - 1) / dgFetchPoll
	return e.start.Add(ticks * dgFetchPoll), true
}

// run executes events until `until` (virtual) or, when stopWhenDone, until every
// job is final. It stops early, with violations recorded, on an immediate
// reschedule or when the invocation cap is hit; it never spins.
func (e *dgJobsEnv) run(until time.Time, stopWhenDone bool) {
	e.t.Helper()
	for !e.aborted {
		if stopWhenDone && e.allFinal() {
			return
		}
		next, ok := e.nextEvent()
		if !ok || next.After(until) {
			break
		}
		if e.rounds > 0 && !next.After(e.lastRound) {
			e.violate("scheduler cannot advance: a job is due again at the instant it just ran (immediate reschedule)")
			e.aborted = true
			return
		}
		e.clk.Set(next)
		e.round()
	}
	if !e.aborted && e.clk.Now().Before(until) {
		e.clk.Set(until)
	}
}

// round runs every job due at the current virtual instant on e.slots overlapping
// worker slots. The provider parks each request at the hold barrier; the
// scheduler releases the parked requests only once every running worker is either
// parked or finished and either all slots are busy or nothing is left to start.
// That makes the overlap maximal and deterministic (no sleeps, no polling), so the
// provider's peak counter is the real peak concurrency the slots allow.
func (e *dgJobsEnv) round() {
	now := e.clk.Now()
	var queue []int
	for i, sj := range e.sims {
		if !sj.done && !sj.dead && !sj.due.After(now) {
			queue = append(queue, i)
		}
	}
	if len(queue) == 0 {
		return
	}
	e.rounds++
	e.lastRound = now
	before := e.breaker.State()

	ctx := context.Background()
	results := make(chan dgWorkResult, len(queue))
	var snoozed []time.Duration
	running, blocked, next := 0, 0, 0
	opened := false
	timer := time.NewTimer(dgRecvDeadline)
	defer timer.Stop()

	for (next < len(queue) && !e.aborted) || running > 0 {
		if e.aborted && !opened {
			e.hold.openAll() // never leave a parked request behind an aborted run
			opened = true
		}
		for !e.aborted && running < e.slots && next < len(queue) {
			idx := queue[next]
			sj := e.sims[idx]
			job := &river.Job[jobargs.EmbedItemArgs]{
				JobRow: &rivertype.JobRow{Attempt: sj.attempt, MaxAttempts: sj.maxAttempts},
				Args:   sj.args,
			}
			go func() { results <- dgWorkResult{idx: idx, err: e.work(ctx, job)} }()
			next++
			running++
		}
		if !e.aborted && blocked > 0 && blocked == running && (running == e.slots || next == len(queue)) {
			for ; blocked > 0; blocked-- {
				e.hold.release <- struct{}{}
			}
			continue
		}
		if running == 0 {
			continue
		}
		timer.Reset(dgRecvDeadline)
		select {
		case <-e.hold.entered:
			blocked++
		case r := <-results:
			running--
			e.handle(r, now, &snoozed)
		case <-timer.C:
			e.violate("scheduler round stalled for %s with %d workers running", dgRecvDeadline, running)
			e.aborted = true
			return
		}
	}
	e.verifySnoozes(now, before, snoozed)
}

// handle applies River's contract to one Work result.
func (e *dgJobsEnv) handle(r dgWorkResult, now time.Time, snoozed *[]time.Duration) {
	sj := e.sims[r.idx]
	e.invocations++
	if e.invocations > e.guard {
		e.violate("work invocations exceeded the hard cap of %d: the scheduler is spinning", e.guard)
		e.aborted = true
		return
	}
	var snooze *river.JobSnoozeError
	switch {
	case r.err == nil:
		sj.done = true
	case errors.As(r.err, &snooze):
		// River: a snooze reschedules at completion + duration and does not consume an attempt.
		sj.snoozes++
		if snooze.Duration < dgFetchPoll {
			e.violate("immediate reschedule: a job was snoozed for %s (< %s); backoff must come from the worker, not the scheduler", snooze.Duration, dgFetchPoll)
			e.aborted = true
			return
		}
		sj.due = now.Add(snooze.Duration)
		*snoozed = append(*snoozed, snooze.Duration)
	default:
		sj.errors++
		if sj.attempt >= sj.maxAttempts {
			sj.dead = true // River discards (dead-letters) at attempt >= the row's MaxAttempts
			return
		}
		job := &river.Job[jobargs.EmbedItemArgs]{
			JobRow: &rivertype.JobRow{Attempt: sj.attempt, MaxAttempts: sj.maxAttempts},
			Args:   sj.args,
		}
		sj.due = e.worker.NextRetry(job)
		if wait, floor := sj.due.Sub(now), jobs.RetryWait(sj.attempt, 0); wait < floor {
			e.violate("retry after failed attempt %d is %s away, want >= %s", sj.attempt, wait, floor)
		}
		sj.attempt++
	}
}

// verifySnoozes checks the snoozes a round returned against the worker breaker:
// never shorter than the remaining open window (the lower bound includes the
// positive jitter floor of 0), never longer than a full window plus MaxBreakerJitter.
func (e *dgJobsEnv) verifySnoozes(now time.Time, before embedding.BreakerState, snoozed []time.Duration) {
	after := e.breaker.State()
	if after == embedding.BreakerStateOpen && before != embedding.BreakerStateOpen {
		e.tripAt = now // opened (or reopened by a failed half-open trial) in this round
	}
	upper := embedding.BreakerOpenWindow + embedding.MaxBreakerJitter
	lower := embedding.BreakerOpenWindow // trial in flight or fresh trip: a full window
	if after == embedding.BreakerStateOpen {
		lower = e.tripAt.Add(embedding.BreakerOpenWindow).Sub(now)
	}
	for _, d := range snoozed {
		if d < lower {
			e.violate("snooze %s is below the breaker's remaining window %s", d, lower)
		}
		if d > upper {
			e.violate("snooze %s is above window + max jitter %s", d, upper)
		}
	}
}

// finalChecks records the end-of-run evidence: persisted retry limits and queue,
// worker-slot concurrency (modelled and measured at the provider) and the batch bound.
func (e *dgJobsEnv) finalChecks() {
	for i, m := range e.persistedMaxAttempts {
		if m < dgPlanMaxAttempts || m < jobs.MaxEmbedAttempts {
			e.violate("persisted MaxAttempts of job %d is %d, want >= %d (plan 2.17 / jobs.MaxEmbedAttempts %d)", i, m, dgPlanMaxAttempts, jobs.MaxEmbedAttempts)
			break
		}
	}
	for i, queue := range e.persistedQueues {
		if queue != jobs.QueueEmbedding {
			e.violate("job %d was persisted on a queue other than %q", i, jobs.QueueEmbedding)
			break
		}
	}
	if jobs.MaxEmbedWorkers > dgPlanMaxEmbedWorkers {
		e.violate("jobs.MaxEmbedWorkers = %d exceeds the plan's %d workers", jobs.MaxEmbedWorkers, dgPlanMaxEmbedWorkers)
	}
	if e.slots > dgPlanMaxEmbedWorkers {
		e.violate("modelled worker slots %d exceed the plan's %d workers", e.slots, dgPlanMaxEmbedWorkers)
	}
	if peak := e.prov.peak.Load(); peak > int64(jobs.MaxEmbedWorkers) {
		e.violate("peak in-flight provider requests %d > jobs.MaxEmbedWorkers %d", peak, jobs.MaxEmbedWorkers)
	}
	if batch := e.prov.maxInputs.Load(); batch > int64(embedding.MaxBatch) {
		e.violate("largest document batch %d > embedding.MaxBatch %d", batch, embedding.MaxBatch)
	}
}

// requireClean fails the test when any evidence violation was recorded. Messages
// carry durations and counts only.
func (e *dgJobsEnv) requireClean(t *testing.T) {
	t.Helper()
	if len(e.violations) > 0 {
		t.Fatalf("%d evidence violation(s):\n  %s", len(e.violations), strings.Join(e.violations, "\n  "))
	}
}

// requireViolation is the negative-control assertion: the helper must have flagged
// the mutation.
func (e *dgJobsEnv) requireViolation(t *testing.T, substr string) {
	t.Helper()
	for _, v := range e.violations {
		if strings.Contains(v, substr) {
			return
		}
	}
	t.Fatalf("evidence helper accepted the mutation: no violation mentions %q (got %d: %v)", substr, len(e.violations), e.violations)
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

func (e *dgJobsEnv) totalSnoozes() int {
	n := 0
	for _, sj := range e.sims {
		n += sj.snoozes
	}
	return n
}

func TestDegradeBreakerNoStorm(t *testing.T) {
	e := newDGJobsEnv(t, dgJobCount, dgJobsOpts{})
	e.prov.setMode(dgModeDown) // every embed request answers 503

	e.run(e.start.Add(dgOutageWindow), false)
	e.finalChecks()
	e.requireClean(t)

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
	// And the jobs really were parked (snoozed with jitter, every snooze verified
	// against the breaker window by verifySnoozes), not spun.
	if snoozes := e.totalSnoozes(); snoozes < dgJobCount-errored {
		t.Fatalf("snoozes = %d, want >= %d (every job without a failed attempt parks on the open breaker)", snoozes, dgJobCount-errored)
	}
	// The worker is not invoked more often than the breaker windows allow, which is
	// what keeps the DB/fetch load of 200 parked jobs bounded (not just provider calls).
	if budget := dgInvocationBudget(dgJobCount, dgOutageWindow); e.invocations < dgJobCount || e.invocations > budget {
		t.Fatalf("work invocations over %s = %d, want within [%d, %d]", dgOutageWindow, e.invocations, dgJobCount, budget)
	}
	// Overlap really happened (two slots both reached the provider) and stayed within the queue limit.
	if peak := e.prov.peak.Load(); peak != int64(jobs.MaxEmbedWorkers) {
		t.Fatalf("peak in-flight provider requests = %d, want exactly %d (both worker slots overlapped)", peak, jobs.MaxEmbedWorkers)
	}
	if batch := e.prov.maxInputs.Load(); batch != 1 {
		t.Fatalf("largest document batch = %d, want 1 (the worker embeds one target per request)", batch)
	}
}

func TestRecoveryNoStorm(t *testing.T) {
	t.Run("jobs_complete_none_dead_lettered", func(t *testing.T) {
		e := newDGJobsEnv(t, dgJobCount, dgJobsOpts{})
		e.prov.setMode(dgModeDown)
		e.run(e.start.Add(dgShortOutage), false)
		if done, _, _, _ := e.counts(); done != 0 {
			t.Fatalf("jobs done during the outage = %d, want 0", done)
		}
		duringOutage := e.prov.total()

		// The provider recovers: the next half-open trial succeeds, the breaker
		// closes, and the jobs drain on two overlapping slots.
		e.prov.setMode(dgModeOK)
		e.prov.peak.Store(0) // measure the recovery phase on its own
		recoveredAt := e.clk.Now()
		e.run(recoveredAt.Add(dgRecoveryLimit), true)
		e.finalChecks()
		e.requireClean(t)

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
		if budget := dgInvocationBudget(dgJobCount, dgShortOutage+dgRecoveryLimit); e.invocations > budget {
			t.Fatalf("work invocations = %d, want <= %d", e.invocations, budget)
		}
		// The drain ran on both slots at once, never more.
		if peak := e.prov.peak.Load(); peak != int64(jobs.MaxEmbedWorkers) {
			t.Fatalf("peak in-flight provider requests during recovery = %d, want exactly %d", peak, jobs.MaxEmbedWorkers)
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
		// Generous query timeout: the trial is parked at the provider while the
		// competing requests are answered, which must not race the outage fixture's
		// real 200 ms deadline.
		e := newDGEnv(t, dgRecoveryQueryTimeout)
		wifi := e.create("item", "Wifi router upstairs")

		// A failing provider (503, no timeout involved) opens the API breaker.
		e.prov.setMode(dgModeDown)
		if r := e.query("suggest", "wifi down", time.Second); r.Semantic {
			t.Fatal("query against a failing provider must degrade")
		}
		if st := e.rt.Breaker().State(); st != embedding.BreakerStateOpen {
			t.Fatalf("breaker = %s, want open", st)
		}

		// The window elapses and the provider is back. A burst of concurrent
		// suggests arrives: ONE becomes the half-open trial and parks at the
		// provider, all others are rejected without touching it.
		e.clk.Advance(61 * time.Second)
		e.prov.setMode(dgModeOK)
		hold := newDGHold()
		e.prov.setHold(hold)
		const burst = 8
		results := make(chan dgHTTPResult, burst)
		var wg sync.WaitGroup
		t.Cleanup(func() { hold.openAll(); wg.Wait() }) // release the gate even when a barrier fails
		before := e.prov.total()
		for i := 0; i < burst; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				code, raw, err := e.rawGET(dgQueryPath("suggest", fmt.Sprintf("wifi burst %d", i)))
				results <- dgHTTPResult{code, raw, err}
			}(i)
		}

		// Barrier 1: the trial announces itself at the provider (no polling).
		dgRecv(t, hold.entered, "the half-open trial to reach the provider")
		// Barrier 2: the burst-1 competing requests answer while the trial stays parked.
		collected := make([]dgHTTPResult, 0, burst-1)
		for len(collected) < burst-1 {
			collected = append(collected, dgRecv(t, results, "a rejected burst request to answer"))
		}
		if got := e.prov.active.Load(); got != 1 {
			t.Fatalf("requests held at the provider = %d, want exactly 1 (the half-open trial)", got)
		}
		if got := e.prov.total() - before; got != 1 {
			t.Fatalf("provider requests during the half-open burst = %d, want exactly 1", got)
		}
		select {
		case <-hold.entered:
			t.Fatal("a second burst request reached the provider while the trial was in flight")
		default:
		}
		for i, r := range collected {
			if r.err != nil {
				t.Fatalf("burst request %d failed at the transport (%T)", i, r.err)
			}
			resp := dgDecode(t, "suggest", r.code, string(r.raw))
			if resp.Semantic || resp.reason() != "degraded" {
				t.Fatalf("rejected burst request %d: semantic=%v reason=%q, want false/degraded", i, resp.Semantic, resp.reason())
			}
		}

		// The trial completes: it answers semantically and the breaker closes.
		hold.release <- struct{}{}
		last := dgRecv(t, results, "the half-open trial to answer")
		if last.err != nil {
			t.Fatalf("trial request failed at the transport (%T)", last.err)
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
		hold.openAll()
		next := e.query("suggest", "router", time.Second)
		if !next.Semantic || next.reason() != "" || !next.hasItem(wifi) {
			t.Fatalf("after recovery: semantic=%v reason=%q hasItem=%v, want true/null/true", next.Semantic, next.reason(), next.hasItem(wifi))
		}
	})
}

// dgHTTPResult is one non-test-goroutine HTTP outcome (rawGET never calls t.Fatal).
type dgHTTPResult struct {
	code int
	raw  []byte
	err  error
}

// TestNoStormEvidenceRejectsMutations are the negative controls of the job
// evidence helper: each mutation of the behaviour the no-storm checkbox relies on
// must make the helper report a violation, so a green TestDegradeBreakerNoStorm /
// TestRecoveryNoStorm cannot come from a helper that cannot fail.
func TestNoStormEvidenceRejectsMutations(t *testing.T) {
	t.Run("immediate_snooze", func(t *testing.T) {
		const n = 6
		e := newDGJobsEnv(t, n, dgJobsOpts{wrapWork: func(work dgWorkFunc) dgWorkFunc {
			return func(ctx context.Context, job *river.Job[jobargs.EmbedItemArgs]) error {
				err := work(ctx, job)
				var snooze *river.JobSnoozeError
				if errors.As(err, &snooze) {
					return river.JobSnooze(0) // the worker "forgets" its backoff
				}
				return err
			}
		}})
		e.prov.setMode(dgModeDown)
		e.run(e.start.Add(dgOutageWindow), false)
		e.finalChecks()
		e.requireViolation(t, "immediate reschedule")
		if !e.aborted || e.invocations > n {
			t.Fatalf("a zero snooze must abort the run at once: aborted=%v invocations=%d (jobs=%d)", e.aborted, e.invocations, n)
		}
	})

	t.Run("raised_queue_concurrency", func(t *testing.T) {
		const n = 50
		e := newDGJobsEnv(t, n, dgJobsOpts{slots: n}) // queue MaxWorkers regressed from 2 to 50
		e.prov.setMode(dgModeDown)
		e.run(e.start.Add(30*time.Second), false)
		e.finalChecks()
		e.requireViolation(t, "peak in-flight provider requests")
		e.requireViolation(t, "modelled worker slots")
	})

	t.Run("too_small_persisted_max_attempts", func(t *testing.T) {
		e := newDGJobsEnv(t, 3, dgJobsOpts{insertOpts: func(kind string) *river.InsertOpts {
			o := jobs.EmbedInsertOpts(kind)
			o.MaxAttempts = 3 // EmbedInsertOpts regressed: the row would dead-letter after 3 attempts
			return o
		}})
		e.finalChecks()
		e.requireViolation(t, "persisted MaxAttempts")
	})
}
