package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

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
	return AutoFlipOutcome{}, errors.New("not implemented")
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
func (w *BootstrapFlipWorker) Work(ctx context.Context, job *river.Job[jobargs.BootstrapFlipArgs]) error {
	return errors.New("not implemented")
}

// BootstrapFlipInsertOpts returns the InsertOpts of the periodic job: queue
// "embedding", priority 2.
func BootstrapFlipInsertOpts() *river.InsertOpts {
	return &river.InsertOpts{Queue: QueueEmbedding, Priority: PriorityBootstrapFlip}
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
		&river.PeriodicJobOpts{RunOnStart: true},
	)
}
