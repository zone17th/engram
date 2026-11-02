// Package jobs implements the River background workers and insertion options
// for the P05 embedding pipeline (plan P05 mục 2.15, 2.17, 2.21, Task 11a;
// SPEC §6.6; ADR 0007).
//
// Import direction (M2/FS-24): jobs imports embedding, generation, store,
// jobargs, obs, db/gen, River, pgx, and stdlib; it never imports lifecycle.
//
// Privacy invariant (user-dec-016, dec-262/268/271): workers never read entry
// bodies or ciphertexts, and logs/metrics never contain user IDs, item/tag
// names, hints, input strings, vectors, provider URLs, API keys, or HTTP
// bodies.
package jobs

import (
	"math/rand/v2"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

const (
	// QueueEmbedding is the dedicated River queue for embedding workers (plan
	// P05 mục 2.17: MaxWorkers = 2).
	QueueEmbedding = "embedding"

	// MaxEmbedWorkers is the maximum concurrency of the embedding queue per
	// worker process (plan P05 mục 2.13, 2.17).
	MaxEmbedWorkers = 2

	// PriorityEmbed is the River job priority for embed_item and embed_tag jobs
	// (plan P05 mục 2.17: priority 1).
	PriorityEmbed = 1

	// PriorityCanary is the River job priority for embedding_canary periodic
	// jobs (plan P05 mục 2.17: priority 2).
	PriorityCanary = 2

	// MaxEmbedAttempts is the maximum number of River attempts for embed_item
	// and embed_tag before transitioning to discarded / dead-letter (plan P05
	// mục 2.17, BE-9: 30 attempts -> 29 waits >= 24h03m at j=0).
	MaxEmbedAttempts = 30

	// RetryBaseWait is the initial retry wait before attempt 2 (1 minute).
	RetryBaseWait = time.Minute

	// RetryMaxWait caps the exponential base wait at 1 hour (reached at
	// attempt >= 7).
	RetryMaxWait = time.Hour

	// MaxRetryJitter is the maximum positive jitter fraction (+20%) applied to
	// NextRetry (plan P05 mục 2.17, BE-9: j in [0, 0.20]).
	MaxRetryJitter = 0.20

	// UnconfiguredSnoozeDuration is the snooze duration when a receiving
	// generation has no matching configured client in ClientSet (plan P05 mục
	// 2.12, 2.17, SPEC §6.6: JobSnooze(5m)).
	UnconfiguredSnoozeDuration = 5 * time.Minute

	// CanaryInterval is the periodic interval for embedding_canary (1 hour).
	CanaryInterval = time.Hour
)

// Job outcome constants for embedding_jobs_total{kind,outcome} owned by Task 11a
// (plan P05 mục 2.17, 2.21, FS-28; retry and dead belong to Task 20a).
const (
	OutcomeUpserted            = "upserted"
	OutcomeSkippedStale        = "skipped_stale"
	OutcomeSkippedFresh        = "skipped_fresh"
	OutcomeSkippedDeleted      = "skipped_deleted"
	OutcomeSkippedUserOff      = "skipped_user_off"
	OutcomeDiscardedGeneration = "discarded_generation"
	OutcomeSnoozed             = "snoozed"
)

// Mismatch reason constants for embedding_generation_mismatch_total{reason}
// (plan P05 mục 2.21, obs.MismatchReasons).
const (
	MismatchReasonUnconfigured = "unconfigured"
	MismatchReasonDims         = "dims"
	MismatchReasonModel        = "model"
	MismatchReasonHash         = "hash"
)

// embedUniqueByState lists the River job states across which embed_item and
// embed_tag jobs are deduplicated by arguments.
//
// River v0.31 index-backed uniqueness (internal/dbunique + UniqueOpts.validate)
// requires custom ByState lists to include all four active lifecycle states:
// available, pending, running, and scheduled. Including retryable alongside
// those four deduplicates all not-yet-finalized jobs while excluding completed,
// cancelled, and discarded so that re-inserts after a prior completion (for
// example A -> B -> A rename cycles) are never blocked by retained completed
// rows in river_job.
var embedUniqueByState = []rivertype.JobState{
	rivertype.JobStateAvailable,
	rivertype.JobStatePending,
	rivertype.JobStateRetryable,
	rivertype.JobStateRunning,
	rivertype.JobStateScheduled,
}

// EmbedInsertOpts returns the River InsertOpts for an embed job of the given
// kind (jobargs.KindEmbedItem or jobargs.KindEmbedTag; plan P05 mục 2.17, Task
// 11a):
//   - Queue: "embedding"
//   - Priority: 1
//   - MaxAttempts: 30
//   - UniqueOpts: ByArgs = true, ByState = available|pending|retryable|running|scheduled.
//     Two generations never deduplicate against each other because generation_id
//     is part of the JSON-encoded job arguments.
func EmbedInsertOpts(_ string) *river.InsertOpts {
	states := make([]rivertype.JobState, len(embedUniqueByState))
	copy(states, embedUniqueByState)
	return &river.InsertOpts{
		Queue:       QueueEmbedding,
		Priority:    PriorityEmbed,
		MaxAttempts: MaxEmbedAttempts,
		UniqueOpts: river.UniqueOpts{
			ByArgs:  true,
			ByState: states,
		},
	}
}

// CanaryInsertOpts returns the River InsertOpts for the periodic
// embedding_canary job (queue "embedding", priority 2).
func CanaryInsertOpts() *river.InsertOpts {
	return &river.InsertOpts{
		Queue:    QueueEmbedding,
		Priority: PriorityCanary,
	}
}

// NextRetry computes the next retry timestamp for an embed job after a failed
// attempt (1-indexed: attempt=1 is the first failure, scheduling attempt 2)
// using the pure formula from plan P05 mục 2.17 / BE-9 and SPEC §6.6:
//
//	wait = min(1m * 2^(attempt-1), 1h) * (1 + j),  j in [0, 0.20]
//
// Jitter j is clamped to [0, MaxRetryJitter] (positive-only) so that the sum of
// the 29 waits before MaxAttempts=30 is guaranteed to be at least 24h03m
// (86,580s) even when j=0.
func NextRetry(attempt int, now time.Time, j float64) time.Time {
	return now.Add(RetryWait(attempt, j))
}

// RetryWait returns the backoff duration for the given 1-indexed failed attempt
// and jitter fraction j (clamped to [0, 0.20]).
func RetryWait(attempt int, j float64) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if j < 0 {
		j = 0
	} else if j > MaxRetryJitter {
		j = MaxRetryJitter
	}

	base := RetryBaseWait
	for i := 1; i < attempt && base < RetryMaxWait; i++ {
		base *= 2
		if base > RetryMaxWait {
			base = RetryMaxWait
			break
		}
	}
	if base > RetryMaxWait {
		base = RetryMaxWait
	}

	scaledNs := float64(base) * (1.0 + j)
	return time.Duration(scaledNs)
}

func defaultJitter() float64 {
	return rand.Float64() * MaxRetryJitter
}
