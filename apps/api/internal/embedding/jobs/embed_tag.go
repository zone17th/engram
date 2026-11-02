package jobs

import (
	"context"
	"time"

	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
)

// EmbedTagWorker processes embed_tag River jobs using the five-step flow
// defined in plan P05 mục 2.17 and SPEC §6.6.
type EmbedTagWorker struct {
	river.WorkerDefaults[jobargs.EmbedTagArgs]
	deps Dependencies
}

// NewEmbedTagWorker constructs an EmbedTagWorker with the given dependencies.
func NewEmbedTagWorker(deps Dependencies) *EmbedTagWorker {
	return &EmbedTagWorker{deps: deps.withDefaults()}
}

// NextRetry computes the retry timestamp for a failed embed_tag job using the
// positive-only jitter backoff formula from plan P05 mục 2.17 / BE-9.
func (w *EmbedTagWorker) NextRetry(job *river.Job[jobargs.EmbedTagArgs]) time.Time {
	deps := w.deps.withDefaults()
	attempt := 1
	if job != nil && job.Attempt > 0 {
		attempt = job.Attempt
	}
	return NextRetry(attempt, deps.Now(), deps.Jitter())
}

// Work executes the five-step embed_tag pipeline.
func (w *EmbedTagWorker) Work(ctx context.Context, job *river.Job[jobargs.EmbedTagArgs]) error {
	attempt := 1
	var args jobargs.EmbedTagArgs
	if job != nil {
		args = job.Args
		if job.Attempt > 0 {
			attempt = job.Attempt
		}
	}
	return executeEmbedJob(ctx, w.deps, embedPayload{
		kind:         jobargs.KindEmbedTag,
		corpus:       generation.CorpusTag,
		generationID: args.GenerationID,
		userIDRaw:    args.UserID,
		targetIDRaw:  args.TargetID,
		inputHashHex: args.InputHash,
		attempt:      attempt,
	})
}
