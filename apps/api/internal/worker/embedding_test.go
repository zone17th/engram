package worker

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
)

var (
	sharedEmbedDSNOnce   sync.Once
	sharedEmbedDSN       string
	sharedEmbedErr       error
	sharedEmbedContainer testcontainers.Container
)

func TestMain(m *testing.M) {
	code := m.Run()
	if sharedEmbedContainer != nil {
		_ = testcontainers.TerminateContainer(sharedEmbedContainer)
	}
	os.Exit(code)
}

func newEmbeddingWorkerTestDSN(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("bỏ qua test cần Docker ở chế độ -short")
	}
	if envDSN := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL")); envDSN != "" {
		sharedEmbedDSN = envDSN
	} else {
		sharedEmbedDSNOnce.Do(func() {
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
				sharedEmbedErr = err
				return
			}
			sharedEmbedContainer = c
			sharedEmbedDSN, sharedEmbedErr = c.ConnectionString(ctx, "sslmode=disable")
		})
		if sharedEmbedErr != nil {
			t.Fatalf("start shared Postgres container: %v", sharedEmbedErr)
		}
	}
	u, err := url.Parse(sharedEmbedDSN)
	if err != nil {
		t.Fatalf("parse shared DSN: %v", err)
	}
	var nonce [6]byte
	_, _ = rand.Read(nonce[:])
	dbName := "engram_wboot_" + hex.EncodeToString(nonce[:])

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
	return dsn
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

// TestWorkerBootCallsBootstrap verifies plan P05 Task 11a / N4 / FS-33:
// When SEARCH_SEMANTIC_ENABLED=true and EMBEDDING_PROVIDER="tei" with a valid
// calibration entry (dec-262 fakeembed in development), worker.Run calls
// generation.Bootstrap and commits g1 in state 'pending' (bootstrap=true)
// BEFORE river.Client.Start runs (proved deterministically via the
// beforeClientStart barrier, with zero sleeps).
func TestWorkerBootCallsBootstrap(t *testing.T) {
	dsn := newEmbeddingWorkerTestDSN(t)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	teiSrv := embedtest.NewServer(embedtest.Options{
		Dims:     1024,
		ModelID:  "engram-fakeembed",
		ModelSHA: embedding.FakeEmbedModelSHA,
	})
	defer teiSrv.Close()

	cfg := &config.Config{
		Env:                      "development",
		DatabaseURL:              dsn,
		AppOrigin:                "http://localhost:3000",
		EmbeddingProvider:        embedding.ProviderTEI,
		TEIURL:                   embedding.NewEndpoint(teiSrv.URL()),
		EmbeddingDimensions:      1024,
		EmbeddingQueryTimeout:    300 * time.Millisecond,
		EmbeddingDocumentTimeout: 5 * time.Second,
		SearchSemanticEnabled:    true,
		AuditRetentionDays:       90,
		ShutdownTimeout:          5 * time.Second,
	}

	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()

	var preStartGen generation.Generation
	var preStartErr error
	var preStartCalled atomic.Bool

	err := Run(runCtx, cfg, discardLogger(), RunOptions{
		beforeClientStart: func(hookCtx context.Context, _ *pgxpool.Pool) {
			preStartCalled.Store(true)
			// Read using a separate connection from pool to prove the bootstrap
			// transaction has already COMMITTED before client.Start is invoked.
			preStartGen, preStartErr = generation.GetByID(hookCtx, pool, generation.BootstrapGenerationID)
			cancelRun()
		},
	})
	if err != nil {
		t.Fatalf("worker.Run: %v", err)
	}
	if !preStartCalled.Load() {
		t.Fatal("beforeClientStart hook was not called")
	}
	if preStartErr != nil {
		t.Fatalf("GetByID(1) before client.Start failed (bootstrap tx not committed before Start): %v", preStartErr)
	}
	if preStartGen.ID != 1 || preStartGen.State != generation.StatePending || !preStartGen.Bootstrap {
		t.Fatalf("g1 state before client.Start = %+v, want ID=1 State=pending Bootstrap=true", preStartGen)
	}
	if preStartGen.Model != embedding.FakeEmbedModel {
		t.Fatalf("g1.Model = %q, want %q", preStartGen.Model, embedding.FakeEmbedModel)
	}
}

// TestRunOnRegistryCalledBeforeStart verifies plan P05 Task 11a / FS-35:
// RunOptions.OnRegistry is called synchronously inside worker.Run right after
// obs.NewRegistry() and before river.Client.Start or the blocking wait, and the
// registry already has embedding_jobs_total pre-initialized across outcomes.
func TestRunOnRegistryCalledBeforeStart(t *testing.T) {
	dsn := newEmbeddingWorkerTestDSN(t)
	ctx := context.Background()

	cfg := &config.Config{
		Env:                   "development",
		DatabaseURL:           dsn,
		AppOrigin:             "http://localhost:3000",
		EmbeddingProvider:     embedding.ProviderNoop,
		SearchSemanticEnabled: false,
		AuditRetentionDays:    90,
		ShutdownTimeout:       5 * time.Second,
	}

	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()

	var step atomic.Int32
	var onRegistryStep int32
	var beforeStartStep int32
	var capturedReg *prometheus.Registry

	err := Run(runCtx, cfg, discardLogger(), RunOptions{
		OnRegistry: func(reg *prometheus.Registry) {
			onRegistryStep = step.Add(1)
			capturedReg = reg
		},
		beforeClientStart: func(_ context.Context, _ *pgxpool.Pool) {
			beforeStartStep = step.Add(1)
			cancelRun()
		},
	})
	if err != nil {
		t.Fatalf("worker.Run: %v", err)
	}
	if onRegistryStep != 1 || beforeStartStep != 2 {
		t.Fatalf("call order: onRegistryStep=%d beforeStartStep=%d, want 1 then 2", onRegistryStep, beforeStartStep)
	}
	if capturedReg == nil {
		t.Fatal("OnRegistry received nil *prometheus.Registry")
	}

	families, err := capturedReg.Gather()
	if err != nil {
		t.Fatalf("capturedReg.Gather: %v", err)
	}
	var foundJobsTotal bool
	for _, f := range families {
		if f.GetName() == "embedding_jobs_total" {
			foundJobsTotal = true
			break
		}
	}
	if !foundJobsTotal {
		t.Fatal("expected embedding_jobs_total to be registered on the worker Prometheus registry")
	}
}

// TestNoopProviderRegistersNoEmbeddingQueue verifies that when
// SearchSemanticEnabled is false or EmbeddingProvider is "noop", worker.Run
// and NewWithMail do NOT register the "embedding" queue, do NOT call
// generation.Bootstrap, and leave the "default" queue intact.
func TestNoopProviderRegistersNoEmbeddingQueue(t *testing.T) {
	dsn := newEmbeddingWorkerTestDSN(t)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	client, err := NewWithMail(pool, discardLogger(), 90, nil)
	if err != nil {
		t.Fatalf("NewWithMail(nil embedding): %v", err)
	}
	// Default queue is already registered -> adding it again errors.
	if err := client.Queues().Add(river.QueueDefault, river.QueueConfig{MaxWorkers: 1}); err == nil {
		t.Fatal("expected queue 'default' to already be registered on NewWithMail(nil embedding)")
	}
	// Embedding workers are not registered -> inserting EmbedItemArgs fails unknown-job check.
	if _, err := client.Insert(ctx, jobargs.EmbedItemArgs{GenerationID: 1}, nil); err == nil {
		t.Fatal("expected Insert(EmbedItemArgs) to fail on client without EmbeddingDeps")
	}
	// Embedding queue is not registered -> adding it succeeds.
	if err := client.Queues().Add(jobs.QueueEmbedding, river.QueueConfig{MaxWorkers: 1}); err != nil {
		t.Fatalf("expected queue %q to not be registered on NewWithMail(nil embedding), got err: %v", jobs.QueueEmbedding, err)
	}

	// Also verify via Run with EMBEDDING_PROVIDER=noop and SearchSemanticEnabled=true:
	// no generation row is created.
	cfg := &config.Config{
		Env:                   "development",
		DatabaseURL:           dsn,
		AppOrigin:             "http://localhost:3000",
		EmbeddingProvider:     embedding.ProviderNoop,
		SearchSemanticEnabled: true,
		AuditRetentionDays:    90,
		ShutdownTimeout:       5 * time.Second,
	}
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()

	if err := Run(runCtx, cfg, discardLogger(), RunOptions{
		beforeClientStart: func(_ context.Context, _ *pgxpool.Pool) {
			cancelRun()
		},
	}); err != nil {
		t.Fatalf("Run(noop): %v", err)
	}

	var genCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM embedding_generation`).Scan(&genCount); err != nil {
		t.Fatalf("count embedding_generation: %v", err)
	}
	if genCount != 0 {
		t.Fatalf("embedding_generation count under noop provider = %d, want 0", genCount)
	}
}

// TestClientSetBootFailureKeepsP04Worker verifies the lead decision (Jev q001):
// When EMBEDDING_PROVIDER="tei" and GET /info fails at worker boot (e.g. 503),
// worker.Run logs a structured warning with provider + error_class only (never
// logging the URL or response body), skips Bootstrap and the embedding queue,
// and keeps the P04 worker running without returning an error.
func TestClientSetBootFailureKeepsP04Worker(t *testing.T) {
	dsn := newEmbeddingWorkerTestDSN(t)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	const (
		secretURLPath  = "/secret-tei-boot-subpath"
		secretRespBody = "tei-boot-failure-internal-body-secret-9988"
	)
	downTEI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(secretRespBody))
	}))
	defer downTEI.Close()

	fullTEIURL := downTEI.URL + secretURLPath
	cfg := &config.Config{
		Env:                      "development",
		DatabaseURL:              dsn,
		AppOrigin:                "http://localhost:3000",
		EmbeddingProvider:        embedding.ProviderTEI,
		TEIURL:                   embedding.NewEndpoint(fullTEIURL),
		EmbeddingDimensions:      1024,
		EmbeddingQueryTimeout:    100 * time.Millisecond,
		EmbeddingDocumentTimeout: 200 * time.Millisecond,
		SearchSemanticEnabled:    true,
		AuditRetentionDays:       90,
		ShutdownTimeout:          5 * time.Second,
	}

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()

	if err := Run(runCtx, cfg, logger, RunOptions{
		beforeClientStart: func(_ context.Context, _ *pgxpool.Pool) {
			cancelRun()
		},
	}); err != nil {
		t.Fatalf("worker.Run when TEI /info is 503 at boot returned error: %v, want nil (run without embedding)", err)
	}

	var genCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM embedding_generation`).Scan(&genCount); err != nil {
		t.Fatalf("count embedding_generation: %v", err)
	}
	if genCount != 0 {
		t.Fatalf("embedding_generation count when TEI /info fails = %d, want 0", genCount)
	}

	logs := logBuf.String()
	if !strings.Contains(logs, `"error_class":"provider_5xx"`) {
		t.Fatalf("expected warn log with error_class=provider_5xx, got: %s", logs)
	}
	for _, forbidden := range []string{secretURLPath, fullTEIURL, secretRespBody} {
		if strings.Contains(logs, forbidden) {
			t.Fatalf("boot failure log leaked forbidden string %q: %s", forbidden, logs)
		}
	}
}
