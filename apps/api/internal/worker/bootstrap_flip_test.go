package worker

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/lifecycle"
)

// TestEmptyDeploymentBootstrapFlipsImmediately verifies plan P05 Task 19 /
// N4 / FS-33: on an empty deployment the real river client runs the periodic
// embedding_bootstrap_flip on its FIRST (RunOnStart) run and flips g1 from
// pending to active with reason bootstrap_auto. The configured interval is one
// hour, so only the start run can have done it within the wait below.
func TestEmptyDeploymentBootstrapFlipsImmediately(t *testing.T) {
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
		Env:                            "development",
		DatabaseURL:                    dsn,
		AppOrigin:                      "http://localhost:3000",
		EmbeddingProvider:              embedding.ProviderTEI,
		TEIURL:                         embedding.NewEndpoint(teiSrv.URL()),
		EmbeddingDimensions:            1024,
		EmbeddingQueryTimeout:          300 * time.Millisecond,
		EmbeddingDocumentTimeout:       5 * time.Second,
		EmbeddingBootstrapFlipInterval: time.Hour,
		SearchSemanticEnabled:          true,
		AuditRetentionDays:             90,
		ShutdownTimeout:                5 * time.Second,
	}

	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()

	var stateBeforeStart string
	var beforeErr error
	var activeBefore bool
	var waitErr error
	var flipJobs int
	var jobsErr error
	err := Run(runCtx, cfg, discardLogger(), RunOptions{
		beforeClientStart: func(hookCtx context.Context, p *pgxpool.Pool) {
			g, gerr := generation.GetByID(hookCtx, p, generation.BootstrapGenerationID)
			beforeErr = gerr
			stateBeforeStart = g.State
			activeBefore = pgBool(hookCtx, p, `SELECT EXISTS (SELECT 1 FROM embedding_active)`)
		},
		afterClientStart: func(hookCtx context.Context, p *pgxpool.Pool) {
			defer cancelRun()
			// The periodic RunOnStart job runs on the embedding queue; wait (bounded)
			// for the observable effect, not for a fixed delay.
			waitCtx, cancel := context.WithTimeout(hookCtx, 45*time.Second)
			defer cancel()
			for !pgBool(waitCtx, p, `SELECT EXISTS (SELECT 1 FROM embedding_active)`) {
				select {
				case <-waitCtx.Done():
					waitErr = waitCtx.Err()
					return
				case <-time.After(50 * time.Millisecond):
				}
			}
			jobsErr = p.QueryRow(hookCtx,
				`SELECT count(*)::int FROM river_job WHERE kind = $1`,
				jobargs.KindBootstrapFlip).Scan(&flipJobs)
		},
	})
	if err != nil {
		t.Fatalf("worker.Run: %v", err)
	}
	if beforeErr != nil || stateBeforeStart != generation.StatePending || activeBefore {
		t.Fatalf("before client.Start: state=%q active=%v err=%v, want g1 pending and no active generation",
			stateBeforeStart, activeBefore, beforeErr)
	}
	if waitErr != nil {
		t.Fatalf("g1 was not flipped by the RunOnStart bootstrap flip within the wait: %v", waitErr)
	}
	if jobsErr != nil {
		t.Fatalf("count embedding_bootstrap_flip jobs: %v", jobsErr)
	}
	if flipJobs != 1 {
		t.Fatalf("embedding_bootstrap_flip jobs = %d, want exactly 1 (the start run; the interval is 1h)", flipJobs)
	}

	g, err := generation.GetByID(ctx, pool, generation.BootstrapGenerationID)
	if err != nil {
		t.Fatalf("GetByID(1): %v", err)
	}
	if g.State != generation.StateActive || !g.IndexReady || g.ActivatedAt == nil || g.VerifiedAt == nil {
		t.Fatalf("g1 = %+v, want active + index_ready + activated + verified", g)
	}
	var reason string
	if err := pool.QueryRow(ctx, `SELECT flipped_reason FROM embedding_active`).Scan(&reason); err != nil || reason != lifecycle.ReasonBootstrapAuto {
		t.Fatalf("flipped_reason = %q (err %v), want %q", reason, err, lifecycle.ReasonBootstrapAuto)
	}
}

// TestBootstrapFlipPeriodicRegistered: the periodic job exists exactly when the
// embedding deps are present.
func TestBootstrapFlipPeriodicRegistered(t *testing.T) {
	dsn := newEmbeddingWorkerTestDSN(t)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	srv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "rev-bf1"})
	defer srv.Close()
	primary, err := embedding.NewClientFromConfig(ctx, embedding.ClientConfig{
		Provider: embedding.ProviderTEI,
		BaseURL:  embedding.NewEndpoint(srv.URL()),
		Dims:     8,
	}, embedding.RolePrimary, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("tei client: %v", err)
	}
	client, err := NewWithMail(pool, discardLogger(), 90, nil, Deps{
		Embedding: &EmbeddingDeps{ClientSet: embedding.NewClientSet(primary, nil)},
	})
	if err != nil {
		t.Fatalf("NewWithMail: %v", err)
	}
	if !client.PeriodicJobs().RemoveByID(lifecycle.BootstrapFlipPeriodicID) {
		t.Fatalf("periodic job %q is not registered with embedding deps", lifecycle.BootstrapFlipPeriodicID)
	}

	plain, err := NewWithMail(pool, discardLogger(), 90, nil)
	if err != nil {
		t.Fatalf("NewWithMail(plain): %v", err)
	}
	if plain.PeriodicJobs().RemoveByID(lifecycle.BootstrapFlipPeriodicID) {
		t.Fatal("bootstrap flip periodic job registered without embedding deps")
	}
}

func pgBool(ctx context.Context, p *pgxpool.Pool, sql string) bool {
	var b bool
	if err := p.QueryRow(ctx, sql).Scan(&b); err != nil {
		return false
	}
	return b
}
