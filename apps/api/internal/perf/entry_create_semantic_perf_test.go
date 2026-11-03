//go:build perf

// P05 Task 23 part B (BE-8): the P04 A10 entry-create regression with semantic search ON.
//
// TestEntryCreatePerformanceA10SemanticOn re-runs the three A10 populations of
// entry_create_perf_test.go (same seed, same sample counts, same p95 < 150 ms
// nearest-rank ceiling, same Postgres + real HTTP router) with the whole P05
// write-path machinery live:
//
//   - an ACTIVE embedding generation g1 (provider "tei", in-process fake provider,
//     never dials a network),
//   - the transactional embed hook (jobs.Enqueuer, Task 11b) wired into the content
//     routes through compose.WithEmbedHook,
//   - a started River client with the real embed_item / embed_tag workers (queue
//     "embedding", MaxWorkers 2), whose step-5 transaction takes FOR SHARE on the
//     target item row,
//   - a concurrent short rename/upsert load on the very items the creates target,
//     same user, same locks as PATCH /items/{id} (LockUserContent, item FOR UPDATE,
//     UPDATE, Enqueuer.OnUpsert, COMMIT), so worker FOR SHARE contends with the
//     entry-create item FOR UPDATE (entryhttp/mount.go, lock step 3).
//
// The rename load calls the same sequence as the PATCH handler directly against the
// pool instead of going through HTTP: the per-user content-write limiter (10 req/s)
// would otherwise count the load against the measured creates and turn bursts of 10
// into 429s. Everything after the HTTP layer is the production code path.
//
// Negative control (one, as the task allows): the P04 Self-Check A style 20 ms
// injection in the create lock must still make Population 2 FAIL the ceiling with
// semantic on (the harness is still sensitive). It reuses perfQueryTracer.
//
// Separate number, NOT called A10 and with no ceiling: the cost of the shared
// generation advisory lock on POST /items (LockGenerationSetShared + R read + policy
// read + River insert), measured as POST /items p50/p95 with semantic on vs off on
// the same seed, interleaved, sequential and burst of 10; it is logged as a delta.
//
// Privacy (user-dec-016): logs carry counts, durations and ids only. No names,
// hints, vault key ids, nonces, ciphertexts, tokens or provider payloads are logged;
// envelopes are synthetic random bytes as in A10.
package perf_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/entry/entryhttp"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/item"
	"github.com/zone17th/engram/apps/api/internal/item/itemhttp"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/tag/taghttp"
	"github.com/zone17th/engram/apps/api/internal/vault/vaulthttp"
)

const (
	// semDims is the fake generation's vector dimension (any value in 1..2000 is valid; small keeps the
	// vector tables cheap, the measured effect is lock contention, not vector size).
	semDims = 64
	// semProviderDelay is the fixed in-process latency of the fake provider per EmbedDocuments call.
	semProviderDelay = 3 * time.Millisecond
	// semGenerationID is the generation id of the active bootstrap-style generation.
	semGenerationID = 1

	// semRenameInterval paces the concurrent rename load: one rename every 25 ms (about 40 per second,
	// four times the 10 req/s per-user content-write limit that production enforces on HTTP, so a
	// deliberate stress level, deterministic and independent of the sample counts).
	semRenameInterval = 25 * time.Millisecond
	// semDrainTimeout bounds the wait for the embedding queue to go idle between measurements.
	semDrainTimeout = 30 * time.Second

	// POST /items cost measurement: rounds x (sequential + bursts) per arm, arms interleaved per round so
	// slow drift of the shared database hits both arms equally.
	semItemRounds         = 10
	semItemSeqPerRound    = 20
	semItemBurstsPerRound = 2
	semItemBurstSize      = 10
)

// ---------------------------------------------------------------------------------------------
// In-process fake embedding provider (no sockets, no network).
// ---------------------------------------------------------------------------------------------

// semFakeProvider implements embedding.Provider entirely in memory: deterministic non-zero unit vectors
// derived from a SHA-256 of the input, after a fixed context-aware delay that stands in for provider latency.
// Inputs are never stored or logged.
type semFakeProvider struct {
	dims  int
	delay time.Duration
	calls atomic.Int64
}

func (p *semFakeProvider) Name() string         { return embedding.ProviderTEI }
func (p *semFakeProvider) Model() string        { return "tei/semperf-fake" }
func (p *semFakeProvider) ModelVersion() string { return "semperf-fake-v1" }
func (p *semFakeProvider) Dims() int            { return p.dims }
func (p *semFakeProvider) MaxBatch() int        { return embedding.MaxBatch }

func (p *semFakeProvider) wait(ctx context.Context) error {
	if p.delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(p.delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (p *semFakeProvider) vector(input string) []float32 {
	sum := sha256.Sum256([]byte(input))
	v := make([]float32, p.dims)
	var norm float64
	for i := range v {
		x := float32(int(sum[i%len(sum)])-127) + float32(i)*0.01 + 1
		v[i] = x
		norm += float64(x) * float64(x)
	}
	n := float32(math.Sqrt(norm))
	for i := range v {
		v[i] /= n
	}
	return v
}

func (p *semFakeProvider) EmbedDocuments(ctx context.Context, inputs []string) ([][]float32, error) {
	if len(inputs) == 0 {
		return nil, embedding.ErrEmptyBatch
	}
	if len(inputs) > embedding.MaxBatch {
		return nil, embedding.ErrBatchTooLarge
	}
	if err := p.wait(ctx); err != nil {
		return nil, err
	}
	p.calls.Add(1)
	out := make([][]float32, len(inputs))
	for i, in := range inputs {
		out[i] = p.vector(in)
	}
	return out, nil
}

func (p *semFakeProvider) EmbedQuery(ctx context.Context, q string) ([]float32, error) {
	if err := p.wait(ctx); err != nil {
		return nil, err
	}
	return p.vector(q), nil
}

// ---------------------------------------------------------------------------------------------
// Latency tap: observes entry-create handler time so the per-population max can be logged
// without touching the A10 population runners (they only return percentiles).
// ---------------------------------------------------------------------------------------------

// semLatencyTap wraps the harness router. While armed it records the ServeHTTP duration of every
// POST .../entries that returned 201 (the same inner call that A10's doServeHTTP times, so the numbers
// agree to microseconds). For Population 3 it also sees the discarded rounds, which A10 excludes from its
// confirmed sample; the max logged for that population is therefore labelled as over all attempts.
type semLatencyTap struct {
	next    http.Handler
	armed   atomic.Bool
	mu      sync.Mutex
	samples []time.Duration
}

func (tp *semLatencyTap) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !tp.armed.Load() || r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/entries") {
		tp.next.ServeHTTP(w, r)
		return
	}
	start := time.Now()
	tp.next.ServeHTTP(w, r)
	d := time.Since(start)
	if rec, ok := w.(*httptest.ResponseRecorder); ok && rec.Code != http.StatusCreated {
		return
	}
	tp.mu.Lock()
	tp.samples = append(tp.samples, d)
	tp.mu.Unlock()
}

func (tp *semLatencyTap) arm() {
	tp.mu.Lock()
	tp.samples = nil
	tp.mu.Unlock()
	tp.armed.Store(true)
}

func (tp *semLatencyTap) disarm() (maxSample time.Duration, n int) {
	tp.armed.Store(false)
	tp.mu.Lock()
	defer tp.mu.Unlock()
	if len(tp.samples) == 0 {
		return 0, 0
	}
	return slices.Max(tp.samples), len(tp.samples)
}

// ---------------------------------------------------------------------------------------------
// Semantic-on environment.
// ---------------------------------------------------------------------------------------------

// semEnv is the A10 perfHarness (same Postgres, tracer, router, clock, observation pool) plus the P05
// pieces: active generation, started embed workers, in-process provider, and the two hook variants.
type semEnv struct {
	h        *perfHarness
	user     perfUser
	content  *compose.Content
	rc       *river.Client[pgx.Tx]
	enqOn    *jobs.Enqueuer // semantic ON: the production Enqueuer, enabled
	enqOff   *jobs.Enqueuer // semantic OFF: the production Enqueuer with Enabled=false (returns before the lock)
	provider *semFakeProvider
	tap      *semLatencyTap

	renameSeq atomic.Int64
}

// newSemanticEnv mirrors newPerfHarness (same config, router and mounts) and adds the P05 wiring. The
// content routes get the semantic-ON hook; RiverInsert for auth/vault stays an insert-only client as in A10,
// so worker registration never has to know the auth/vault job kinds.
func newSemanticEnv(t *testing.T) *semEnv {
	t.Helper()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)

	tracer := &perfQueryTracer{}
	pool := newTracedPool(t, dsn, 32, tracer)
	obsPool := newTracedPool(t, dsn, 8, nil)

	clk := clock.NewFixed(time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	origin := "http://127.0.0.1:18080"

	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", origin)
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "false")
	t.Setenv("VAULT_KEY_MUTATIONS_DISABLED", "false")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	mail, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatalf("NewSinkMailer: %v", err)
	}
	reg, metrics := obs.NewRegistry()

	logBuf := &contenttest.SafeBuffer{}
	logger := slog.New(slog.NewJSONHandler(logBuf, &slog.HandlerOptions{Level: slog.LevelWarn}))
	discard := slog.New(slog.NewTextHandler(io.Discard, nil))

	// Active generation g1 whose identity matches the in-process provider (ClientSet.Match succeeds).
	provider := &semFakeProvider{dims: semDims, delay: semProviderDelay}
	client := embedding.NewClient(provider, "", "")
	seedSemGeneration(t, pool, client.Identity)

	// Real embed workers on a started River client (queue "embedding", MaxWorkers 2).
	deps := jobs.Dependencies{
		Pool:      pool,
		ClientSet: embedding.NewClientSet(client, nil),
		Breakers:  jobs.NewWorkerBreakers(time.Now, metrics.Embedding),
		Metrics:   metrics.Embedding,
		Logger:    discard,
	}
	workers := river.NewWorkers()
	if err := river.AddWorkerSafely(workers, jobs.NewEmbedItemWorker(deps)); err != nil {
		t.Fatalf("register embed_item worker: %v", err)
	}
	if err := river.AddWorkerSafely(workers, jobs.NewEmbedTagWorker(deps)); err != nil {
		t.Fatalf("register embed_tag worker: %v", err)
	}
	rc, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:  discard,
		Workers: workers,
		Queues: map[string]river.QueueConfig{
			jobs.QueueEmbedding: {MaxWorkers: jobs.MaxEmbedWorkers},
		},
	})
	if err != nil {
		t.Fatalf("river.NewClient (embed workers): %v", err)
	}
	riverCtx, riverCancel := context.WithCancel(context.Background())
	if err := rc.Start(riverCtx); err != nil {
		riverCancel()
		t.Fatalf("river Start: %v", err)
	}
	// Registered after the pools, so it runs before pool.Close (cleanups are LIFO).
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer stopCancel()
		if err := rc.StopAndCancel(stopCtx); err != nil {
			t.Logf("river StopAndCancel: %v", err)
		}
		riverCancel()
	})

	riverInsert, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		t.Fatalf("river.NewClient (insert-only): %v", err)
	}
	authSvc, _, authAPI, err := compose.NewAuth(cfg, pool, riverInsert, clk, mail, nil)
	if err != nil {
		t.Fatalf("compose.NewAuth: %v", err)
	}
	_, vaultAPI, err := compose.NewVault(cfg, pool, riverInsert, clk, mail, metrics, entry.ResetHook, logger)
	if err != nil {
		t.Fatalf("compose.NewVault: %v", err)
	}

	enqOn := jobs.NewEnqueuer(rc, true, embedding.ProviderTEI, discard)
	enqOff := jobs.NewEnqueuer(rc, false, embedding.ProviderTEI, discard)
	contentComp, err := compose.NewContent(cfg, pool, clk, metrics, logger, compose.WithEmbedHook(enqOn))
	if err != nil {
		t.Fatalf("compose.NewContent: %v", err)
	}
	authn, csrfv, reauth := compose.Adapters(authSvc)

	mounts := []func(v1 chi.Router, d httpx.Deps){
		authhttp.Mount(authAPI),
		vaulthttp.Mount(vaultAPI),
		itemhttp.Mount(contentComp),
		taghttp.Mount(contentComp),
		entryhttp.Mount(contentComp),
	}
	router := httpx.NewRouter(httpx.Deps{
		Config:           cfg,
		Logger:           logger,
		Ready:            func(context.Context) error { return nil },
		Metrics:          promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
		MetricsCollector: metrics,
		Authenticator:    authn,
		CSRF:             csrfv,
		Reauth:           reauth,
		MountAPI:         compose.MountAll(mounts...),
	})
	tap := &semLatencyTap{next: router}

	return &semEnv{
		h: &perfHarness{
			T:       t,
			DSN:     dsn,
			Pool:    pool,
			ObsPool: obsPool,
			Tracer:  tracer,
			Clock:   clk,
			Origin:  origin,
			Router:  tap,
			Logs:    logBuf,
		},
		content:  contentComp,
		rc:       rc,
		enqOn:    enqOn,
		enqOff:   enqOff,
		provider: provider,
		tap:      tap,
	}
}

// seedSemGeneration creates and activates generation g1 (provider "tei") with its vector tables, the same
// way the bootstrap path ends up: ReceivingGenerations returns {g1} so every item write enqueues one job.
func seedSemGeneration(t *testing.T, pool *pgxpool.Pool, ident embedid.Identity) {
	t.Helper()
	ctx := context.Background()
	q := gen.New(pool)
	const partitions = 4
	if _, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 semGenerationID,
		Provider:           ident.Provider,
		Model:              ident.Model,
		ModelVersion:       ident.ModelVersion,
		Preprocessing:      ident.Preprocessing,
		QueryPrefix:        ident.QueryPrefix,
		DocPrefix:          ident.DocPrefix,
		Dims:               int32(ident.Dims),
		Partitions:         partitions,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.55,
		CalibrationRef:     "docs/benchmarks/semantic-eval/report.json",
		Bootstrap:          true,
	}); err != nil {
		t.Fatalf("InsertPendingEmbeddingGeneration: %v", err)
	}
	if err := q.CreateEmbeddingGenerationTables(ctx, gen.CreateEmbeddingGenerationTablesParams{
		ID:                 semGenerationID,
		Dims:               int32(ident.Dims),
		Partitions:         partitions,
		WithHnsw:           false,
		HnswM:              16,
		HnswEfConstruction: 64,
	}); err != nil {
		t.Fatalf("CreateEmbeddingGenerationTables: %v", err)
	}
	if _, err := q.ActivateEmbeddingGeneration(ctx, semGenerationID); err != nil {
		t.Fatalf("ActivateEmbeddingGeneration: %v", err)
	}
	reason := "semperf"
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
		GenerationID:  semGenerationID,
		FlippedReason: &reason,
	}); err != nil {
		t.Fatalf("UpsertEmbeddingActive: %v", err)
	}
	g, err := generation.GetByID(ctx, pool, semGenerationID)
	if err != nil || g.State != generation.StateActive {
		t.Fatalf("generation %d not active after seed (err=%v)", semGenerationID, err)
	}
	if g.Identity().Key() != ident.Key() {
		t.Fatalf("generation %d identity does not match the in-process client", semGenerationID)
	}
}

// ---------------------------------------------------------------------------------------------
// Embedding queue observation.
// ---------------------------------------------------------------------------------------------

type semJobCounts struct {
	completed int64
	discarded int64
	active    int64 // available + running + retryable + scheduled + pending
}

func (e *semEnv) jobCounts(t *testing.T) semJobCounts {
	t.Helper()
	var c semJobCounts
	if err := e.h.Pool.QueryRow(context.Background(), `
		SELECT
			count(*) FILTER (WHERE state::text = 'completed')::bigint,
			count(*) FILTER (WHERE state::text = 'discarded')::bigint,
			count(*) FILTER (WHERE state::text IN ('available', 'running', 'retryable', 'scheduled', 'pending'))::bigint
		FROM river_job
		WHERE kind IN ('embed_item', 'embed_tag')
	`).Scan(&c.completed, &c.discarded, &c.active); err != nil {
		t.Fatalf("count embed jobs: %v", err)
	}
	return c
}

// drainJobs waits until no embed job is available, running, retryable or scheduled, so the next
// measurement starts without a backlog of the previous one. A backlog that never drains means the worker
// is not keeping up, which is itself a failure of the semantic-on setup.
func (e *semEnv) drainJobs(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(semDrainTimeout)
	for {
		c := e.jobCounts(t)
		if c.active == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("embedding queue did not drain within %s (active=%d completed=%d discarded=%d)",
				semDrainTimeout, c.active, c.completed, c.discarded)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// ---------------------------------------------------------------------------------------------
// Concurrent rename/upsert load.
// ---------------------------------------------------------------------------------------------

type semRenameLoad struct {
	cancel   context.CancelFunc
	done     chan struct{}
	once     sync.Once
	ops      atomic.Int64
	failures atomic.Int64
}

// renameOnce is the PATCH /items/{id} write sequence minus HTTP: mutation tx (30 s lock/statement
// timeouts), LockUserContent then item FOR UPDATE, UPDATE name+hint, Enqueuer.OnUpsert in the same tx, COMMIT.
func (e *semEnv) renameOnce(ctx context.Context, userID, itemID uuid.UUID, seq int64) error {
	tx, err := httpx.BeginMutationTx(ctx, e.h.Pool)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	q := gen.New(tx)
	locked, err := item.LockUserContentAndItem(ctx, q, userID, itemID, true)
	if err != nil {
		return fmt.Errorf("lock: %w", err)
	}
	name := fmt.Sprintf("Semperf rename %d", seq)
	hint := fmt.Sprintf("synthetic hint %d", seq)
	row, err := q.UpdateItemNameAndHint(ctx, gen.UpdateItemNameAndHintParams{
		Name:            name,
		NameNormalized:  strings.ToLower(name),
		Hint:            &hint,
		UserID:          userID,
		ID:              itemID,
		ExpectedVersion: locked.Version,
	})
	if err != nil {
		return fmt.Errorf("update: %w", err)
	}
	if err := e.enqOn.OnUpsert(ctx, tx, userID, item.EmbedKindItem, row.ID, embedding.ItemInput(row.Name, hint)); err != nil {
		return fmt.Errorf("enqueue: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// startRenameLoad renames the given items round-robin, one per semRenameInterval, until stop.
func (e *semEnv) startRenameLoad(items []uuid.UUID) *semRenameLoad {
	ctx, cancel := context.WithCancel(context.Background())
	l := &semRenameLoad{cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(l.done)
		tick := time.NewTicker(semRenameInterval)
		defer tick.Stop()
		for i := 0; ; i++ {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
			itemID := items[i%len(items)]
			if err := e.renameOnce(ctx, e.user.UserID, itemID, e.renameSeq.Add(1)); err != nil {
				if ctx.Err() != nil {
					return
				}
				l.failures.Add(1)
				continue
			}
			l.ops.Add(1)
		}
	}()
	return l
}

func (l *semRenameLoad) stop() (ops, failures int64) {
	l.once.Do(func() {
		l.cancel()
		<-l.done
	})
	return l.ops.Load(), l.failures.Load()
}

// ---------------------------------------------------------------------------------------------
// One measured population under load.
// ---------------------------------------------------------------------------------------------

// semPopReport carries the per-population numbers beyond what populationStats holds.
type semPopReport struct {
	stats          populationStats
	maxCreate      time.Duration
	tapSamples     int
	embedJobsDone  int64
	providerCalls  int64
	renameOps      int64
	renameFailures int64
}

// measurePopulation runs one A10 population runner while the rename load hits renameItems and the embed
// workers process the resulting jobs, then logs the required per-population line. It asserts the load was
// real (renames happened, none failed, the worker completed jobs) but leaves the p95 verdict to the caller.
func (e *semEnv) measurePopulation(t *testing.T, label string, renameItems []uuid.UUID, run func() populationStats) semPopReport {
	t.Helper()
	e.drainJobs(t)
	jobsBefore := e.jobCounts(t)
	callsBefore := e.provider.calls.Load()

	e.tap.arm()
	load := e.startRenameLoad(renameItems)
	defer load.stop()
	defer e.tap.disarm()

	stats := run()

	ops, failures := load.stop()
	maxCreate, tapN := e.tap.disarm()
	jobsAfter := e.jobCounts(t)
	rep := semPopReport{
		stats:          stats,
		maxCreate:      maxCreate,
		tapSamples:     tapN,
		embedJobsDone:  jobsAfter.completed - jobsBefore.completed,
		providerCalls:  e.provider.calls.Load() - callsBefore,
		renameOps:      ops,
		renameFailures: failures,
	}
	t.Logf("SEMANTIC-ON POPULATION %s: n=%d p50=%s p95=%s p99=%s max=%s (max over %d tapped 201 creates; for pop3 this includes discarded rounds) ceiling=%s embed_jobs_completed=%d provider_calls=%d rename_ops=%d rename_failures=%d",
		label, stats.Samples, stats.P50, stats.P95, stats.P99, maxCreate, tapN, p95Ceiling,
		rep.embedJobsDone, rep.providerCalls, ops, failures)

	if ops == 0 {
		t.Fatalf("%s: rename load performed 0 operations; the contention load was not applied", label)
	}
	if failures != 0 {
		t.Fatalf("%s: %d of %d rename operations failed under semantic-on load", label, failures, ops+failures)
	}
	if rep.embedJobsDone == 0 {
		t.Fatalf("%s: embed worker completed 0 jobs during the population; the worker was not live", label)
	}
	e.drainJobs(t)
	return rep
}

// ---------------------------------------------------------------------------------------------
// POST /items generation-lock cost (separate number, not A10).
// ---------------------------------------------------------------------------------------------

type semItemArm struct {
	name  string
	hook  item.EmbedHook
	seq   []time.Duration
	burst []time.Duration
	ids   []uuid.UUID
}

func (e *semEnv) createItemOnce(t *testing.T, arm *semItemArm, idx int) time.Duration {
	t.Helper()
	id := uuid.New()
	body := fmt.Sprintf(`{"id":%q,"name":%q,"hint":%q}`,
		id.String(), fmt.Sprintf("Semperf item %s %05d", arm.name, idx), "synthetic hint")
	idem := "idem_semitem_" + strings.ReplaceAll(id.String(), "-", "")
	code, _, dur := e.h.doServeHTTP(context.Background(), e.user.Jar, http.MethodPost, "/api/v1/items", body, idem)
	if code != http.StatusCreated {
		t.Fatalf("POST /items (%s) = %d, want 201", arm.name, code)
	}
	arm.ids = append(arm.ids, id)
	return dur
}

// runItemSequential issues n sequential POST /items. POST /items is limited by httpx.ScopeContentWrite (10 per
// 1 s sliding window per user, counted in rate_event against the harness fake clock), so the window is advanced
// before the first request (the previous arm's burst, or the previous population, may have used all 10 slots
// and no real time passes on the fake clock) and again after every 9 requests. The rename load writes through
// the pool directly, so no other HTTP write consumes content_write slots during the measurement.
func (e *semEnv) runItemSequential(t *testing.T, arm *semItemArm, n int) {
	t.Helper()
	e.h.advanceRateLimitWindow()
	pace := 0
	for range n {
		arm.seq = append(arm.seq, e.createItemOnce(t, arm, len(arm.ids)))
		pace++
		if pace >= 9 {
			e.h.advanceRateLimitWindow()
			pace = 0
		}
	}
	e.h.advanceRateLimitWindow()
}

func (e *semEnv) runItemBurst(t *testing.T, arm *semItemArm) {
	t.Helper()
	e.h.advanceRateLimitWindow()
	type result struct {
		id   uuid.UUID
		code int
		dur  time.Duration
	}
	results := make([]result, semItemBurstSize)
	base := len(arm.ids)
	gate := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(semItemBurstSize)
	for j := range semItemBurstSize {
		id := uuid.New()
		body := fmt.Sprintf(`{"id":%q,"name":%q,"hint":%q}`,
			id.String(), fmt.Sprintf("Semperf item %s %05d", arm.name, base+j), "synthetic hint")
		idem := "idem_semitem_" + strings.ReplaceAll(id.String(), "-", "")
		go func(slot int) {
			defer wg.Done()
			<-gate
			code, _, dur := e.h.doServeHTTP(context.Background(), e.user.Jar, http.MethodPost, "/api/v1/items", body, idem)
			results[slot] = result{id: id, code: code, dur: dur}
		}(j)
	}
	close(gate)
	wg.Wait()
	for j, r := range results {
		if r.code != http.StatusCreated {
			t.Fatalf("POST /items burst (%s) slot %d = %d, want 201", arm.name, j, r.code)
		}
		arm.ids = append(arm.ids, r.id)
		arm.burst = append(arm.burst, r.dur)
	}
}

func semSummarize(samples []time.Duration) (p50, p95, p99, maxSample time.Duration) {
	if len(samples) == 0 {
		return 0, 0, 0, 0
	}
	return nearestRankPercentile(samples, 50), nearestRankPercentile(samples, 95),
		nearestRankPercentile(samples, 99), slices.Max(samples)
}

// measureItemCreateLockCost measures POST /items with semantic off vs on on the same seeded database. The
// arms alternate order every round and the embedding queue is drained before each arm, so the off arm never
// pays for the on arm's worker backlog. The on arm keeps its own worker activity (real behaviour).
func (e *semEnv) measureItemCreateLockCost(t *testing.T) {
	t.Helper()
	off := &semItemArm{name: "off", hook: e.enqOff}
	on := &semItemArm{name: "on", hook: e.enqOn}
	defer e.content.SetEmbedHook(e.enqOn)

	for r := range semItemRounds {
		e.h.refreshSession(e.user.Jar)
		order := []*semItemArm{off, on}
		if r%2 == 1 {
			order = []*semItemArm{on, off}
		}
		for _, arm := range order {
			e.drainJobs(t)
			e.content.SetEmbedHook(arm.hook)
			e.runItemSequential(t, arm, semItemSeqPerRound)
			for range semItemBurstsPerRound {
				e.runItemBurst(t, arm)
			}
		}
	}
	e.drainJobs(t)

	wantSeq := semItemRounds * semItemSeqPerRound
	wantBurst := semItemRounds * semItemBurstsPerRound * semItemBurstSize
	for _, arm := range []*semItemArm{off, on} {
		if len(arm.seq) != wantSeq || len(arm.burst) != wantBurst {
			t.Fatalf("POST /items arm %s samples seq=%d burst=%d, want %d and %d (non-zero, all 201)",
				arm.name, len(arm.seq), len(arm.burst), wantSeq, wantBurst)
		}
	}

	// The arms must really differ: the on arm enqueued one embed job per created item (R = {g1}), the off arm none.
	countJobs := func(ids []uuid.UUID) int {
		strs := make([]string, len(ids))
		for i, id := range ids {
			strs[i] = id.String()
		}
		var n int
		if err := e.h.Pool.QueryRow(context.Background(), `
			SELECT count(*)::int FROM river_job
			WHERE kind = 'embed_item' AND args->>'target_id' = ANY($1::text[])
		`, strs).Scan(&n); err != nil {
			t.Fatalf("count embed jobs for created items: %v", err)
		}
		return n
	}
	onJobs, offJobs := countJobs(on.ids), countJobs(off.ids)
	if onJobs != len(on.ids) || offJobs != 0 {
		t.Fatalf("POST /items arms are not distinguishable: on_arm_jobs=%d (want %d) off_arm_jobs=%d (want 0)",
			onJobs, len(on.ids), offJobs)
	}

	line := func(mode string, offS, onS []time.Duration) {
		o50, o95, o99, oMax := semSummarize(offS)
		n50, n95, n99, nMax := semSummarize(onS)
		t.Logf("POST /items %s: off n=%d p50=%s p95=%s p99=%s max=%s | on n=%d p50=%s p95=%s p99=%s max=%s | delta(on-off) p50=%s p95=%s",
			mode, len(offS), o50, o95, o99, oMax, len(onS), n50, n95, n99, nMax, n50-o50, n95-o95)
	}
	t.Logf("GENERATION-LOCK COST ON POST /items (reported number, NOT A10, no ceiling): rounds=%d seq_per_round=%d bursts_per_round=%d burst_size=%d, same seed, arms interleaved, off = Enqueuer disabled, on = LockGenerationSetShared + R read + policy read + River InsertTx; on_arm_embed_jobs=%d off_arm_embed_jobs=%d",
		semItemRounds, semItemSeqPerRound, semItemBurstsPerRound, semItemBurstSize, onJobs, offJobs)
	line("sequential", off.seq, on.seq)
	line("burst of 10", off.burst, on.burst)
}

// ---------------------------------------------------------------------------------------------
// The test.
// ---------------------------------------------------------------------------------------------

// TestEntryCreatePerformanceA10SemanticOn is plan P05 Task 23 "Hồi quy P04 A10 (BE-8)": the A10 populations with
// semantic ON and a concurrent rename/upsert load, p95 < 150 ms each, plus one retained negative control, plus the
// separately reported POST /items generation-lock cost. See the file comment for what is wired.
func TestEntryCreatePerformanceA10SemanticOn(t *testing.T) {
	env := newSemanticEnv(t)
	h := env.h
	env.user = h.signupAndCreateVault("perf-a10-semantic-user@example.com", 0x20)
	user := env.user
	seeded := seedPerfDataset(t, h.Pool, user)

	t.Logf("SEMANTIC-ON SETUP: generation=g%d provider=%s dims=%d provider_delay=%s embed_queue_workers=%d rename_interval=%s ceiling=%s",
		semGenerationID, embedding.ProviderTEI, semDims, semProviderDelay, jobs.MaxEmbedWorkers, semRenameInterval, p95Ceiling)

	// Disjoint item slices (every item stays far below the 200-entry limit):
	//   - [0..29]    Population 1 (30 items; the rename load hits the same 30)
	//   - [30..39]   Population 2 (10 items; every burst touches every renamed item)
	//   - [40..59]   Population 3 (20 items rotated by the runner, 10 per round; the rename load hits the same 20)
	//   - [430..439] negative control Population 2
	//   - [810]      parent of Population 3's 500 expired tombstones
	pop1Items := seeded.NonFullItemIDs[0:30]
	pop2Items := seeded.NonFullItemIDs[30:40]
	pop3Items := seeded.NonFullItemIDs[40:60]
	negPop2Items := seeded.NonFullItemIDs[430:440]
	tombstoneItemID := seeded.NonFullItemIDs[810]

	t.Run("RealPopulations_1_2_3_SemanticOn", func(t *testing.T) {
		h.Tracer.setCreateLockHeldDelay(0)

		h.refreshSession(user.Jar)
		rep1 := env.measurePopulation(t, "pop1_sequential", pop1Items, func() populationStats {
			return runPopulation1Sequential(t, h, user, seeded.Item199ID, pop1Items, "sem_pop1_sequential")
		})
		if !rep1.stats.passesCeiling(p95Ceiling) {
			t.Fatalf("Population 1 (semantic on) p95 = %s >= ceiling %s", rep1.stats.P95, p95Ceiling)
		}

		h.refreshSession(user.Jar)
		rep2 := env.measurePopulation(t, "pop2_burst_no_purge", pop2Items, func() populationStats {
			return runPopulation2BurstNoPurge(t, h, user, pop2Items, "sem_pop2_burst_no_purge")
		})
		if !rep2.stats.passesCeiling(p95Ceiling) {
			t.Fatalf("Population 2 (semantic on) p95 = %s >= ceiling %s", rep2.stats.P95, p95Ceiling)
		}

		h.refreshSession(user.Jar)
		rep3 := env.measurePopulation(t, "pop3_burst_purge_overlap", pop3Items, func() populationStats {
			return runPopulation3ConfirmedPurgeOverlap(t, h, user, tombstoneItemID, pop3Items, 0, "sem_pop3_burst_purge_overlap")
		})
		if !rep3.stats.passesCeiling(p95Ceiling) {
			t.Fatalf("Population 3 (semantic on) p95 = %s >= ceiling %s (decision_required per plan)", rep3.stats.P95, p95Ceiling)
		}

		t.Logf("SEMANTIC-ON A10 PASS: p95 pop1=%s pop2=%s pop3=%s (< %s each, nearest-rank, samples %d/%d/%d)",
			rep1.stats.P95, rep2.stats.P95, rep3.stats.P95, p95Ceiling,
			rep1.stats.Samples, rep2.stats.Samples, rep3.stats.Samples)
		contenttest.AssertInvariants(t, h.Pool, user.UserID)
	})

	// Negative control (the one retained from P04): Self-Check A, 20 ms inside the create request's lock-held
	// region. With semantic on and the rename load running, Population 2 must still FAIL the ceiling and the
	// injection must have fired on every one of its 300 creates (the rename load carries no trace key, so it
	// is never delayed and never counted).
	t.Run("NegativeControl_SelfCheckA_20msInCreateLock_Pop2Fails", func(t *testing.T) {
		h.Tracer.resetDelayedCreateLockGrants()
		h.Tracer.setCreateLockHeldDelay(20 * time.Millisecond)
		defer h.Tracer.setCreateLockHeldDelay(0)

		h.refreshSession(user.Jar)
		rep := env.measurePopulation(t, "negctl_pop2_20ms", negPop2Items, func() populationStats {
			return runPopulation2BurstNoPurge(t, h, user, negPop2Items, "sem_negctl_pop2_20ms")
		})
		if got := h.Tracer.delayedCreateLockGrantCount(); got != int64(pop2TargetSamples) {
			t.Fatalf("negative control: delayed LockUserContent grants = %d, want %d (injection did not fire on every create)", got, pop2TargetSamples)
		}
		if rep.stats.passesCeiling(p95Ceiling) {
			t.Fatalf("negative control: expected Population 2 to FAIL ceiling %s with 20 ms injected in the create lock (semantic on), but got p95=%s",
				p95Ceiling, rep.stats.P95)
		}
		t.Logf("NEGATIVE CONTROL VERIFIED (semantic on): 20 ms injected in create lock (delayed_grants=%d) -> Pop2 FAIL (p95=%s >= %s)",
			pop2TargetSamples, rep.stats.P95, p95Ceiling)
		contenttest.AssertInvariants(t, h.Pool, user.UserID)
	})

	t.Run("ReportedNumber_PostItemsGenerationLockCost", func(t *testing.T) {
		h.Tracer.setCreateLockHeldDelay(0)
		env.measureItemCreateLockCost(t)
		contenttest.AssertInvariants(t, h.Pool, user.UserID)
	})

	// Final health of the semantic side: nothing dead-lettered, vectors really written, no leak in server logs.
	env.drainJobs(t)
	c := env.jobCounts(t)
	var vectors int
	if err := h.Pool.QueryRow(context.Background(), `SELECT count(*)::int FROM item_embedding_g1`).Scan(&vectors); err != nil {
		t.Fatalf("count item vectors: %v", err)
	}
	t.Logf("SEMANTIC-ON FINAL: embed_jobs_completed=%d embed_jobs_discarded=%d item_vectors=%d provider_calls=%d rename_ops_total=%d",
		c.completed, c.discarded, vectors, env.provider.calls.Load(), env.renameSeq.Load())
	if c.discarded != 0 {
		t.Fatalf("embed jobs discarded (dead-lettered) = %d, want 0", c.discarded)
	}
	if vectors == 0 {
		t.Fatalf("no item vector was written by the embed workers")
	}
	if strings.Contains(h.Logs.String(), user.VaultKeyID) {
		t.Fatalf("server logs leaked vault_key_id")
	}
}
