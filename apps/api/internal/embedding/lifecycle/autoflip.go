package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
)

const (
	// QueueEmbedding is the River queue of the periodic job (same value as
	// jobs.QueueEmbedding; lifecycle must not import jobs, M2).
	QueueEmbedding = "embedding"
	// PriorityBootstrapFlip is the River priority of embedding_bootstrap_flip.
	PriorityBootstrapFlip = 2
	// DefaultBootstrapFlipInterval is the production period.
	DefaultBootstrapFlipInterval = time.Minute

	// BootstrapFlipPeriodicID identifies the periodic job in the River client.
	BootstrapFlipPeriodicID = "embedding_bootstrap_flip"

	bootstrapFlipTimeout = 10 * time.Minute
)

// No-op reason codes of AutoFlipOutcome.Reason (besides the Reason* codes of
// verify).
const (
	ReasonNoPending    = "no_pending"
	ReasonNotBootstrap = "not_bootstrap"
	ReasonActiveExists = "active_exists"
	ReasonNotPending   = "not_pending"
)

// AutoFlip outcome actions.
const (
	ActionNoop     = "noop"
	ActionFlipped  = "flipped"
	ActionNotReady = "not_ready"
)

// AutoFlipOpts parameterises AutoFlipBootstrap.
type AutoFlipOpts struct {
	Logger *slog.Logger
	// Now is an injectable clock (default time.Now).
	Now func() time.Time
	// Verify tunes the verification (zero value: defaults).
	Verify VerifyOpts
}

// AutoFlipOutcome is what one AutoFlipBootstrap run did. Counts and codes only.
type AutoFlipOutcome struct {
	// Action is ActionNoop, ActionFlipped or ActionNotReady.
	Action string `json:"action"`
	// GenerationID is the bootstrap generation considered (0 for noop with no
	// pending generation).
	GenerationID int `json:"generation_id"`
	// Reason is a Reason* code or a noop reason (no_pending, not_bootstrap,
	// active_exists).
	Reason string `json:"reason"`
}

// AutoFlipBootstrap is the body of the periodic embedding_bootstrap_flip job
// (BE-4, N4/FS-33, M3/FS-25). It is a no-op unless a pending generation with
// bootstrap=true exists. For it: index_ready is set when every per-partition
// index is valid (HNSW is created at bootstrap), then Verify runs; on pass the
// generation is flipped (no old active) with NOTIFY in the same transaction.
// Non-bootstrap generations never auto-flip.
func AutoFlipBootstrap(ctx context.Context, pool *pgxpool.Pool, opts AutoFlipOpts) (AutoFlipOutcome, error) {
	if pool == nil {
		return AutoFlipOutcome{}, generation.ErrNilTx
	}
	q := gen.New(pool)
	row, err := q.GetPendingEmbeddingGeneration(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return AutoFlipOutcome{Action: ActionNoop, Reason: ReasonNoPending}, nil
	}
	if err != nil {
		return AutoFlipOutcome{}, err
	}
	g, err := generation.FromDBRow(row)
	if err != nil {
		return AutoFlipOutcome{}, err
	}
	out := AutoFlipOutcome{Action: ActionNoop, GenerationID: g.ID}
	if !g.Bootstrap {
		// Non-bootstrap generations never auto-flip (BE-4): manual CLI only.
		out.Reason = ReasonNotBootstrap
		return out, nil
	}
	if _, err := q.GetEmbeddingActiveRow(ctx); err == nil {
		out.Reason = ReasonActiveExists
		return out, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return AutoFlipOutcome{}, err
	}

	// N4/FS-33: HNSW was created at bootstrap (empty tables); index_ready is
	// simply "every per-partition index is valid".
	parts, err := partitionTables(g)
	if err != nil {
		return AutoFlipOutcome{}, err
	}
	valid, err := countValidPartitionIndexes(ctx, pool, parts)
	if err != nil {
		return AutoFlipOutcome{}, err
	}
	if valid != len(parts) {
		out.Action = ActionNotReady
		out.Reason = ReasonIndexNotReady
		return out, nil
	}
	if !g.IndexReady {
		if _, err := q.SetEmbeddingGenerationIndexReady(ctx, gen.SetEmbeddingGenerationIndexReadyParams{
			IndexReady: true,
			ID:         int32(g.ID),
		}); err != nil {
			return AutoFlipOutcome{}, err
		}
	}

	vopts := opts.Verify
	if vopts.Now == nil {
		vopts.Now = opts.Now
	}
	rep, err := Verify(ctx, pool, g.ID, vopts)
	if errors.Is(err, ErrNotPending) {
		// Raced with a manual retire/flip: nothing left to do.
		out.Reason = ReasonNotPending
		return out, nil
	}
	if err != nil {
		return AutoFlipOutcome{}, err
	}
	if !rep.Passed {
		out.Action = ActionNotReady
		out.Reason = rep.Reason
		return out, nil
	}

	err = flip(ctx, pool, g.ID, FlipOpts{Reason: ReasonBootstrapAuto, Now: opts.Now}, true)
	switch {
	case err == nil:
		out.Action = ActionFlipped
		out.Reason = ReasonBootstrapAuto
		return out, nil
	case errors.Is(err, ErrCoverageIncomplete):
		// A mutation after the watermark is not covered yet; next tick retries.
		out.Action = ActionNotReady
		out.Reason = ReasonCoverageIncomplete
		return out, nil
	case errors.Is(err, errActiveExists):
		out.Reason = ReasonActiveExists
		return out, nil
	case errors.Is(err, ErrNotPending):
		out.Reason = ReasonNotPending
		return out, nil
	default:
		return AutoFlipOutcome{}, err
	}
}

// BootstrapFlipDeps are the dependencies of the bootstrap flip worker.
type BootstrapFlipDeps struct {
	Pool   *pgxpool.Pool
	Logger *slog.Logger
	Now    func() time.Time
}

// BootstrapFlipWorker is the River worker for embedding_bootstrap_flip.
type BootstrapFlipWorker struct {
	river.WorkerDefaults[jobargs.BootstrapFlipArgs]
	deps BootstrapFlipDeps
}

// NewBootstrapFlipWorker constructs the worker.
func NewBootstrapFlipWorker(deps BootstrapFlipDeps) *BootstrapFlipWorker {
	return &BootstrapFlipWorker{deps: deps}
}

// Work runs one AutoFlipBootstrap pass.
func (w *BootstrapFlipWorker) Work(ctx context.Context, _ *river.Job[jobargs.BootstrapFlipArgs]) error {
	out, err := AutoFlipBootstrap(ctx, w.deps.Pool, AutoFlipOpts{Logger: w.deps.Logger, Now: w.deps.Now})
	if err != nil {
		// DB error text can carry statement fragments: log and return only a
		// class (the periodic tick retries anyway).
		class := dbErrClass(err)
		if w.deps.Logger != nil {
			w.deps.Logger.LogAttrs(ctx, slog.LevelWarn, "embedding_bootstrap_flip failed",
				slog.String("error_class", class))
		}
		return fmt.Errorf("embedding_bootstrap_flip: %s", class)
	}
	if w.deps.Logger != nil {
		level := slog.LevelDebug
		if out.Action != ActionNoop {
			level = slog.LevelInfo
		}
		w.deps.Logger.LogAttrs(ctx, level, "embedding_bootstrap_flip",
			slog.String("action", out.Action),
			slog.Int("generation_id", out.GenerationID),
			slog.String("reason", out.Reason))
	}
	return nil
}

// Timeout overrides River's one-minute default: verify scans every target.
func (w *BootstrapFlipWorker) Timeout(*river.Job[jobargs.BootstrapFlipArgs]) time.Duration {
	return bootstrapFlipTimeout
}

func dbErrClass(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	}
	var pe interface{ SQLState() string }
	if errors.As(err, &pe) {
		return "sqlstate_" + pe.SQLState()
	}
	return "internal"
}

// BootstrapFlipInsertOpts returns the InsertOpts of the periodic job: queue
// "embedding", priority 2. It is unique by args across unfinished states so a
// slow verification is never stacked behind itself.
func BootstrapFlipInsertOpts() *river.InsertOpts {
	return &river.InsertOpts{
		Queue:       QueueEmbedding,
		Priority:    PriorityBootstrapFlip,
		MaxAttempts: 3,
		UniqueOpts: river.UniqueOpts{
			ByArgs: true,
			ByState: []rivertype.JobState{
				rivertype.JobStateAvailable,
				rivertype.JobStatePending,
				rivertype.JobStateRetryable,
				rivertype.JobStateRunning,
				rivertype.JobStateScheduled,
			},
		},
	}
}

// BootstrapFlipPeriodicJob returns the periodic job registered in
// worker.NewWithMail: every interval (zero means DefaultBootstrapFlipInterval)
// with RunOnStart=true.
func BootstrapFlipPeriodicJob(interval time.Duration) *river.PeriodicJob {
	if interval <= 0 {
		interval = DefaultBootstrapFlipInterval
	}
	return river.NewPeriodicJob(
		river.PeriodicInterval(interval),
		func() (river.JobArgs, *river.InsertOpts) {
			return jobargs.BootstrapFlipArgs{}, BootstrapFlipInsertOpts()
		},
		&river.PeriodicJobOpts{ID: BootstrapFlipPeriodicID, RunOnStart: true},
	)
}
