package jobs

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
)

func riverpgxv5Driver(pool *pgxpool.Pool) riverdriver.Driver[pgx.Tx] {
	return riverpgxv5.New(pool)
}

// EmbedItemWorker processes embed_item River jobs using the five-step flow
// defined in plan P05 mục 2.17 and SPEC §6.6.
type EmbedItemWorker struct {
	river.WorkerDefaults[jobargs.EmbedItemArgs]
	deps Dependencies
}

// NewEmbedItemWorker constructs an EmbedItemWorker with the given dependencies.
func NewEmbedItemWorker(deps Dependencies) *EmbedItemWorker {
	return &EmbedItemWorker{deps: deps.withDefaults()}
}

// NextRetry computes the retry timestamp for a failed embed_item job using the
// positive-only jitter backoff formula from plan P05 mục 2.17 / BE-9.
func (w *EmbedItemWorker) NextRetry(job *river.Job[jobargs.EmbedItemArgs]) time.Time {
	deps := w.deps.withDefaults()
	attempt := 1
	if job != nil && job.Attempt > 0 {
		attempt = job.Attempt
	}
	return NextRetry(attempt, deps.Now(), deps.Jitter())
}

// Work executes the five-step embed_item pipeline.
func (w *EmbedItemWorker) Work(ctx context.Context, job *river.Job[jobargs.EmbedItemArgs]) error {
	attempt := 1
	var args jobargs.EmbedItemArgs
	if job != nil {
		args = job.Args
		if job.Attempt > 0 {
			attempt = job.Attempt
		}
	}
	return executeEmbedJob(ctx, w.deps, embedPayload{
		kind:         jobargs.KindEmbedItem,
		corpus:       generation.CorpusItem,
		generationID: args.GenerationID,
		userIDRaw:    args.UserID,
		targetIDRaw:  args.TargetID,
		inputHashHex: args.InputHash,
		attempt:      attempt,
	})
}
