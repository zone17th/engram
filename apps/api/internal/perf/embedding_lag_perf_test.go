//go:build lagperf

// Package perf_test: P05 Task 21 (B2) embedding-lag acceptance test.
//
// TestEmbeddingLagP95 drives the real embed_item / embed_tag River workers, the
// real transactional enqueue path (jobs.Enqueuer, Task 11b) and the real
// provider clients + worker breaker against a local fake provider that speaks
// the real wire format with a fixed per-request delay. Lag per sample is
// embedded_at - river_job.created_at (raw samples, nearest-rank percentiles).
//
// The file is self-contained and guarded by the lagperf build tag: the P04
// Content perf job (-tags perf) neither compiles nor runs it. It is run by the
// embedding-lag CI job:
//
//	go test -tags lagperf ./internal/perf/... -run '^TestEmbeddingLagP95$' -count=1 -timeout 35m -v
//
// Privacy (user-dec-016): all names, hints and e-mail addresses are synthetic;
// nothing from the provider wire (URLs, keys, bodies) is logged.
package perf_test

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	mrand "math/rand/v2"
	"net/url"
	"os"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/item"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

const (
	// lagPGImage is the same image tag as internal/db/dbtest.
	lagPGImage = "pgvector/pgvector:pg16"
	// lagPinsFile is read only to log a digest mismatch (never fails the test).
	lagPinsFile = "../../../../infra/image-pins.env"

	lagArrivalRate  = 0.4 // Poisson total arrivals per second across all users
	lagUsers        = 10
	lagScheduleSeed = 0x5EED_0021 // fixed seed: identical schedule on every run
	lagDims         = 1024
	lagGenerationID = 1
	lagItemShare    = 0.7 // share of item mutations (the rest are tags)

	// lagP95Limit is the acceptance threshold (plan P05 section 5 gate 10, L7).
	lagP95Limit = 10 * time.Second
)

// lagProfile describes one parallel subtest.
type lagProfile struct {
	name         string
	provider     string // embedding.ProviderOpenAICompat | embedding.ProviderTEI
	delay        time.Duration
	mutations    int
	drainTimeout time.Duration
	// wantReject marks the negative control: the shared acceptance rule must
	// reject this profile.
	wantReject bool
}

// accept is the single acceptance rule used by every profile (the negative
// control included), so the rule that gates the real profiles is the very rule
// proven to reject an overloaded provider.
func accept(p95 time.Duration) bool {
	return p95 < lagP95Limit
}

// nearestRank returns the nearest-rank percentile (0 < p <= 100) of an
// ascending-sorted, non-empty sample slice.
func nearestRank(sorted []time.Duration, p float64) time.Duration {
	rank := int(math.Ceil(p / 100 * float64(len(sorted))))
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

type lagArrival struct {
	offset time.Duration // from the profile start
	user   int
	isItem bool
}

// lagSchedule builds a fixed Poisson schedule: exponential inter-arrival gaps
// with total rate lagArrivalRate, uniform user assignment, fixed seed.
func lagSchedule(n int) []lagArrival {
	rng := mrand.New(mrand.NewPCG(lagScheduleSeed, lagScheduleSeed^0x9E3779B97F4A7C15))
	out := make([]lagArrival, 0, n)
	at := 0.0
	for i := 0; i < n; i++ {
		at += rng.ExpFloat64() / lagArrivalRate
		out = append(out, lagArrival{
			offset: time.Duration(at * float64(time.Second)),
			user:   rng.IntN(lagUsers),
			isItem: rng.Float64() < lagItemShare,
		})
	}
	return out
}

// TestEmbeddingLagP95 is the D12 / L7 / FS-1 / BE-5 acceptance test: embedding
// lag p95 < 10 s with a 2.3 s/request openai_compat provider and a 300 ms TEI
// provider at 0.4 mutations/s, and the same rule must reject a 12 s/request
// provider (negative control).
func TestEmbeddingLagP95(t *testing.T) {
	logRunnerInfo(t)
	baseDSN := startLagPostgres(t)

	profiles := []lagProfile{
		{
			name:         "openai_compat_2300ms",
			provider:     embedding.ProviderOpenAICompat,
			delay:        2300 * time.Millisecond,
			mutations:    200,
			drainTimeout: 3 * time.Minute,
		},
		{
			name:         "tei_300ms",
			provider:     embedding.ProviderTEI,
			delay:        300 * time.Millisecond,
			mutations:    200,
			drainTimeout: 3 * time.Minute,
		},
		{
			name:         "negative_control_12s",
			provider:     embedding.ProviderOpenAICompat,
			delay:        12 * time.Second,
			mutations:    40,
			drainTimeout: 8 * time.Minute,
			wantReject:   true,
		},
	}

	for _, p := range profiles {
		t.Run(p.name, func(t *testing.T) {
			t.Parallel()
			runLagProfile(t, baseDSN, p)
		})
	}
}

func runLagProfile(t *testing.T, baseDSN string, p lagProfile) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	dsn := createLagDatabase(t, baseDSN)
	pool := openLagPool(t, dsn)

	// Fake provider: real wire format, fixed per-request delay. The TEI client
	// reads /info at construction, so the delay is armed after the client
	// exists (SetSlow only affects the embed endpoints for new requests).
	srv := embedtest.NewServer(embedtest.Options{Dims: lagDims})
	t.Cleanup(srv.Close)
	client := newLagClient(t, srv, p.provider)
	srv.SetSlow(p.delay)
	clients := embedding.NewClientSet(client, nil)

	seedLagGeneration(t, ctx, pool, client.Identity)
	userIDs := seedLagUsers(t, ctx, pool)

	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	_, metrics := obs.NewRegistry()
	deps := jobs.Dependencies{
		Pool:      pool,
		ClientSet: clients,
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
		t.Fatalf("river.NewClient: %v", err)
	}
	if err := rc.Start(ctx); err != nil {
		t.Fatalf("river Start: %v", err)
	}
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer stopCancel()
		if err := rc.StopAndCancel(stopCtx); err != nil {
			t.Logf("river StopAndCancel: %v", err)
		}
	})

	// The same transactional enqueue path the API uses (Task 11b).
	enq := jobs.NewEnqueuer(rc, true, p.provider, discard)

	schedule := lagSchedule(p.mutations)
	start := time.Now()
	for i, a := range schedule {
		timer := time.NewTimer(time.Until(start.Add(a.offset)))
		select {
		case <-ctx.Done():
			timer.Stop()
			t.Fatalf("context done before mutation %d", i)
		case <-timer.C:
		}
		if err := lagMutate(ctx, pool, enq, userIDs[a.user], i, a.isItem); err != nil {
			t.Fatalf("mutation %d: %v", i, err)
		}
	}
	arrivalSpan := time.Since(start)

	// Drain: wait for every mutation's vector (polling with a deadline).
	got := waitLagDrained(ctx, t, pool, p.mutations, p.drainTimeout)

	samples := collectLagSamples(ctx, t, pool)
	missing := max(p.mutations-len(samples), 0)
	logLagJobStats(ctx, t, pool)

	if len(samples) == 0 {
		t.Fatalf("[%s] no lag samples collected (missing=%d of %d)", p.name, missing, p.mutations)
	}
	slices.Sort(samples)
	p50 := nearestRank(samples, 50)
	p95 := nearestRank(samples, 95)
	p99 := nearestRank(samples, 99)
	t.Logf("profile=%s provider=%s delay=%s N=%d vectors=%d samples=%d missing=%d arrival_span=%s "+
		"lag p50=%s p95=%s p99=%s max=%s limit=%s doc_requests=%d",
		p.name, p.provider, p.delay, p.mutations, got, len(samples), missing, arrivalSpan.Round(time.Second),
		p50.Round(time.Millisecond), p95.Round(time.Millisecond), p99.Round(time.Millisecond),
		samples[len(samples)-1].Round(time.Millisecond), lagP95Limit, srv.Stats().DocumentRequests)

	accepted := accept(p95)
	if p.wantReject {
		// The negative control only attests the rule if it drained completely
		// (otherwise the p95 is of a partial population).
		if missing > 0 {
			t.Fatalf("[%s] negative control did not drain (missing=%d of %d): cannot attest rejection",
				p.name, missing, p.mutations)
		}
		if accepted {
			t.Fatalf("[%s] acceptance rule accepted the negative control (p95=%s < %s): the rule does not reject overload",
				p.name, p95, lagP95Limit)
		}
		t.Logf("[%s] negative control correctly REJECTED by the acceptance rule (p95=%s >= %s)",
			p.name, p95.Round(time.Millisecond), lagP95Limit)
		return
	}
	if missing > 0 {
		t.Fatalf("[%s] %d of %d samples missing after the drain deadline (%s): counts as failure",
			p.name, missing, p.mutations, p.drainTimeout)
	}
	if !accepted {
		t.Fatalf("[%s] embedding lag p95=%s, want < %s (plan says: fail -> micro-batch OQ-14, never change the target)",
			p.name, p95.Round(time.Millisecond), lagP95Limit)
	}
}

// lagMutate creates one synthetic item or tag and enqueues its embed job in the
// same transaction through the production Enqueuer hook.
func lagMutate(ctx context.Context, pool *pgxpool.Pool, enq *jobs.Enqueuer, userID uuid.UUID, seq int, isItem bool) (err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() {
		if err == nil {
			return
		}
		if rbErr := tx.Rollback(context.Background()); rbErr != nil && !errors.Is(rbErr, pgx.ErrTxClosed) {
			err = fmt.Errorf("%w (rollback: %v)", err, rbErr)
		}
	}()
	q := gen.New(tx)
	if isItem {
		name := fmt.Sprintf("Lagperf Item %04d", seq)
		hint := fmt.Sprintf("synthetic hint %04d", seq)
		row, ierr := q.InsertItem(ctx, gen.InsertItemParams{
			UserID:         userID,
			Name:           name,
			NameNormalized: strings.ToLower(name),
			Hint:           &hint,
		})
		if ierr != nil {
			return fmt.Errorf("insert item: %w", ierr)
		}
		if err := enq.OnUpsert(ctx, tx, userID, item.EmbedKindItem, row.ID, embedding.ItemInput(name, hint)); err != nil {
			return fmt.Errorf("enqueue item: %w", err)
		}
	} else {
		display := fmt.Sprintf("lagperf-tag-%04d", seq)
		row, terr := q.InsertTag(ctx, gen.InsertTagParams{
			UserID:     userID,
			Display:    display,
			Normalized: display,
		})
		if terr != nil {
			return fmt.Errorf("insert tag: %w", terr)
		}
		if err := enq.OnUpsert(ctx, tx, userID, item.EmbedKindTag, row.ID, embedding.TagInput(display)); err != nil {
			return fmt.Errorf("enqueue tag: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// waitLagDrained polls until want vectors exist or the deadline passes, and
// returns the vector count seen last.
func waitLagDrained(ctx context.Context, t *testing.T, pool *pgxpool.Pool, want int, timeout time.Duration) int {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	got := 0
	for {
		if err := pool.QueryRow(ctx, `
			SELECT (SELECT count(*) FROM item_embedding_g1) + (SELECT count(*) FROM tag_embedding_g1)
		`).Scan(&got); err != nil {
			t.Fatalf("count vectors: %v", err)
		}
		if got >= want {
			return got
		}
		select {
		case <-ctx.Done():
			t.Fatalf("context done while draining (%d/%d vectors)", got, want)
		case <-deadline.C:
			return got
		case <-tick.C:
		}
	}
}

// collectLagSamples returns embedded_at - river_job.created_at for every embed
// job whose vector exists (raw per-job samples, no histogram interpolation).
func collectLagSamples(ctx context.Context, t *testing.T, pool *pgxpool.Pool) []time.Duration {
	t.Helper()
	rows, err := pool.Query(ctx, `
		SELECT EXTRACT(EPOCH FROM (e.embedded_at - j.created_at))::float8
		FROM river_job j
		JOIN item_embedding_g1 e ON e.target_id = (j.args->>'target_id')::uuid
		WHERE j.kind = 'embed_item' AND (j.args->>'generation_id')::int = $1
		UNION ALL
		SELECT EXTRACT(EPOCH FROM (e.embedded_at - j.created_at))::float8
		FROM river_job j
		JOIN tag_embedding_g1 e ON e.target_id = (j.args->>'target_id')::uuid
		WHERE j.kind = 'embed_tag' AND (j.args->>'generation_id')::int = $1
	`, lagGenerationID)
	if err != nil {
		t.Fatalf("query lag samples: %v", err)
	}
	defer rows.Close()
	var out []time.Duration
	for rows.Next() {
		var secs float64
		if err := rows.Scan(&secs); err != nil {
			t.Fatalf("scan lag sample: %v", err)
		}
		out = append(out, time.Duration(secs*float64(time.Second)))
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate lag samples: %v", err)
	}
	return out
}

// logLagJobStats logs River job counts by state and the max attempt, so a
// retrying or stuck run is visible in the CI log.
func logLagJobStats(ctx context.Context, t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	rows, err := pool.Query(ctx, `
		SELECT state::text, count(*), COALESCE(max(attempt), 0)
		FROM river_job WHERE kind IN ('embed_item', 'embed_tag')
		GROUP BY state ORDER BY state::text
	`)
	if err != nil {
		t.Logf("query job stats: %v", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var state string
		var n, maxAttempt int
		if err := rows.Scan(&state, &n, &maxAttempt); err != nil {
			t.Logf("scan job stats: %v", err)
			return
		}
		t.Logf("river_job state=%s count=%d max_attempt=%d", state, n, maxAttempt)
	}
	if err := rows.Err(); err != nil {
		t.Logf("iterate job stats: %v", err)
	}
}

func newLagClient(t *testing.T, srv *embedtest.Server, provider string) embedding.Client {
	t.Helper()
	cfg := embedding.ClientConfig{Provider: provider, Dims: lagDims}
	switch provider {
	case embedding.ProviderOpenAICompat:
		cfg.BaseURL = embedding.NewEndpoint(srv.URL() + "/v1")
		cfg.APIKey = embedding.NewSecret("sk-lagperf-synthetic-key")
		cfg.Model = "lagperf/synthetic-embedding"
		cfg.QueryInstruction = "Given a short search query, retrieve matching item names or tags"
	case embedding.ProviderTEI:
		cfg.BaseURL = embedding.NewEndpoint(srv.URL())
		cfg.QueryPrefix = "query: "
		cfg.DocPrefix = "passage: "
	default:
		t.Fatalf("unsupported lag provider %q", provider)
	}
	c, err := embedding.NewClientFromConfig(context.Background(), cfg, embedding.RolePrimary, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("build %s client: %v", provider, err)
	}
	return c
}

// seedLagGeneration creates an active generation 1 whose identity matches the
// configured client (same seven fields), so ClientSet.Match succeeds.
func seedLagGeneration(t *testing.T, ctx context.Context, pool *pgxpool.Pool, ident embedid.Identity) {
	t.Helper()
	q := gen.New(pool)
	const partitions = 4
	if _, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 lagGenerationID,
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
		ID:                 lagGenerationID,
		Dims:               int32(ident.Dims),
		Partitions:         partitions,
		WithHnsw:           false,
		HnswM:              16,
		HnswEfConstruction: 64,
	}); err != nil {
		t.Fatalf("CreateEmbeddingGenerationTables: %v", err)
	}
	if _, err := q.ActivateEmbeddingGeneration(ctx, lagGenerationID); err != nil {
		t.Fatalf("ActivateEmbeddingGeneration: %v", err)
	}
	reason := "lagperf"
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
		GenerationID:  lagGenerationID,
		FlippedReason: &reason,
	}); err != nil {
		t.Fatalf("UpsertEmbeddingActive: %v", err)
	}
	if g, err := generation.GetByID(ctx, pool, lagGenerationID); err != nil || g.State != generation.StateActive {
		t.Fatalf("generation %d not active after seed (err=%v)", lagGenerationID, err)
	}
}

func seedLagUsers(t *testing.T, ctx context.Context, pool *pgxpool.Pool) []uuid.UUID {
	t.Helper()
	q := gen.New(pool)
	ids := make([]uuid.UUID, 0, lagUsers)
	for i := 0; i < lagUsers; i++ {
		u, err := q.InsertUser(ctx, gen.InsertUserParams{
			Email:  fmt.Sprintf("lagperf-user-%02d@example.invalid", i),
			Locale: "vi",
		})
		if err != nil {
			t.Fatalf("InsertUser %d: %v", i, err)
		}
		ids = append(ids, u.ID)
	}
	return ids
}

// startLagPostgres starts the single shared container and returns a DSN for
// its default database; every profile creates its own database from it.
func startLagPostgres(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	c, err := tcpostgres.Run(ctx, lagPGImage,
		tcpostgres.WithDatabase("engram"),
		tcpostgres.WithUsername("engram"),
		tcpostgres.WithPassword("engram"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(120*time.Second)),
	)
	if err != nil {
		t.Fatalf("start Postgres container: %v", err)
	}
	t.Cleanup(func() {
		if err := testcontainers.TerminateContainer(c); err != nil {
			t.Logf("terminate Postgres container: %v", err)
		}
	})
	logImageDigest(ctx, t)
	dsn, err := c.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("container DSN: %v", err)
	}
	return dsn
}

// logImageDigest logs the resolved repo digest of the Postgres image and notes
// (log only, never fails) when it differs from the digest pinned in
// infra/image-pins.env.
func logImageDigest(ctx context.Context, t *testing.T) {
	t.Helper()
	provider, err := testcontainers.NewDockerProvider()
	if err != nil {
		t.Logf("image digest: docker provider unavailable: %v", err)
		return
	}
	defer func() {
		if err := provider.Close(); err != nil {
			t.Logf("close docker provider: %v", err)
		}
	}()
	res, err := provider.Client().ImageInspect(ctx, lagPGImage)
	if err != nil {
		t.Logf("image digest: inspect %s: %v", lagPGImage, err)
		return
	}
	t.Logf("postgres image=%s id=%s repo_digests=%v", lagPGImage, res.ID, res.RepoDigests)

	pinned := readPinnedPostgresDigest()
	if pinned == "" {
		t.Logf("image digest: no pinned POSTGRES_IMAGE digest found in %s", lagPinsFile)
		return
	}
	for _, rd := range res.RepoDigests {
		if strings.HasSuffix(rd, "@"+pinned) || rd == pinned {
			t.Logf("image digest matches the pinned digest %s", pinned)
			return
		}
	}
	t.Logf("NOTE: image digest MISMATCH vs pinned digest %s (resolved: %v); logged only, not a failure",
		pinned, res.RepoDigests)
}

// readPinnedPostgresDigest returns the sha256:... part of POSTGRES_IMAGE in
// infra/image-pins.env, or "" when unavailable.
func readPinnedPostgresDigest() string {
	f, err := os.Open(lagPinsFile)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		val, ok := strings.CutPrefix(line, "POSTGRES_IMAGE=")
		if !ok {
			continue
		}
		if _, digest, found := strings.Cut(strings.TrimSpace(val), "@"); found {
			return digest
		}
	}
	return ""
}

func logRunnerInfo(t *testing.T) {
	t.Helper()
	t.Logf("runner: GOOS=%s GOARCH=%s NumCPU=%d GOMAXPROCS=%d go=%s",
		runtime.GOOS, runtime.GOARCH, runtime.NumCPU(), runtime.GOMAXPROCS(0), runtime.Version())
	for _, k := range []string{"RUNNER_NAME", "ImageOS", "ImageVersion"} {
		if v := os.Getenv(k); v != "" {
			t.Logf("runner: %s=%s", k, v)
		}
	}
	t.Logf("acceptance: p95 < %s; arrivals Poisson total %.1f/s across %d users, seed %#x",
		lagP95Limit, lagArrivalRate, lagUsers, lagScheduleSeed)
}

// createLagDatabase creates a fresh database on the shared container, migrates
// it and drops it at cleanup.
func createLagDatabase(t *testing.T, baseDSN string) string {
	t.Helper()
	u, err := url.Parse(baseDSN)
	if err != nil {
		t.Fatalf("parse base DSN: %v", err)
	}
	var nonce [6]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatalf("random database name: %v", err)
	}
	dbName := "lagperf_" + hex.EncodeToString(nonce[:])

	admin := *u
	admin.Path = "/postgres"
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin.String())
	if err != nil {
		t.Fatalf("connect admin DB: %v", err)
	}
	_, execErr := conn.Exec(ctx, `CREATE DATABASE `+pgx.Identifier{dbName}.Sanitize())
	if closeErr := conn.Close(ctx); closeErr != nil {
		t.Logf("close admin conn: %v", closeErr)
	}
	if execErr != nil {
		t.Fatalf("CREATE DATABASE: %v", execErr)
	}
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), admin.String())
		if err != nil {
			t.Logf("drop %s: connect: %v", dbName, err)
			return
		}
		if _, err := c.Exec(context.Background(), `DROP DATABASE IF EXISTS `+pgx.Identifier{dbName}.Sanitize()+` WITH (FORCE)`); err != nil {
			t.Logf("drop %s: %v", dbName, err)
		}
		if err := c.Close(context.Background()); err != nil {
			t.Logf("drop %s: close: %v", dbName, err)
		}
	})

	u.Path = "/" + dbName
	dsn := u.String()
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	return dsn
}

func openLagPool(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}
	cfg.MaxConns = 12
	cfg.MinConns = 0
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("NewWithConfig: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("Ping: %v", err)
	}
	return pool
}
