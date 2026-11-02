package jobs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/reconcile"
)

const (
	// PriorityReembedUser is the River priority of reembed_user (plan P05 mục
	// 2.17: priority 3).
	PriorityReembedUser = 3

	// PriorityReembedAll is the River priority of reembed_all (plan P05 mục 2.17:
	// priority 4).
	PriorityReembedAll = 4

	// MaxReembedAttempts caps River attempts of reembed_user and reembed_all; a
	// failed run is idempotent and the next periodic reembed_all repairs the gap.
	MaxReembedAttempts = 5

	// ReembedAllInterval is the periodic reembed_all interval (OQ-15).
	ReembedAllInterval = 24 * time.Hour

	// ReembedAllPeriodicID identifies the periodic reembed_all in the River client.
	ReembedAllPeriodicID = "reembed_all_24h"

	reembedUserTimeout = 15 * time.Minute
	reembedAllTimeout  = 2 * time.Hour
)

// ReembedUserInsertOpts returns the River InsertOpts for reembed_user (queue
// "embedding", priority 3, ByArgs unique across not-yet-finalized states).
func ReembedUserInsertOpts() *river.InsertOpts {
	return reembedInsertOpts(PriorityReembedUser)
}

// ReembedAllInsertOpts returns the River InsertOpts for reembed_all (queue
// "embedding", priority 4, ByArgs unique across not-yet-finalized states).
func ReembedAllInsertOpts() *river.InsertOpts {
	return reembedInsertOpts(PriorityReembedAll)
}

func reembedInsertOpts(priority int) *river.InsertOpts {
	states := make([]rivertype.JobState, len(embedUniqueByState))
	copy(states, embedUniqueByState)
	return &river.InsertOpts{
		Queue:       QueueEmbedding,
		Priority:    priority,
		MaxAttempts: MaxReembedAttempts,
		UniqueOpts:  river.UniqueOpts{ByArgs: true, ByState: states},
	}
}

// ReembedAllPeriodicConstructor is the periodic-job constructor for the 24h
// reembed_all (generation_id omitted = every generation in R).
func ReembedAllPeriodicConstructor() (river.JobArgs, *river.InsertOpts) {
	return jobargs.ReembedAllArgs{}, ReembedAllInsertOpts()
}

// ReembedAllPeriodicJob returns the periodic reembed_all job (every
// ReembedAllInterval; no RunOnStart because worker boot inserts its own
// deduplicated reembed_all, BE-4).
func ReembedAllPeriodicJob() *river.PeriodicJob {
	return river.NewPeriodicJob(
		river.PeriodicInterval(ReembedAllInterval),
		ReembedAllPeriodicConstructor,
		&river.PeriodicJobOpts{ID: ReembedAllPeriodicID},
	)
}

// InsertReembedAll inserts one reembed_all job (generationID 0 = every
// generation in R). Identical not-yet-finalized jobs deduplicate by args.
func InsertReembedAll(ctx context.Context, ins JobInserter, generationID int) (*rivertype.JobInsertResult, error) {
	if ins == nil {
		return nil, errors.New("jobs: nil job inserter")
	}
	return ins.Insert(ctx, jobargs.ReembedAllArgs{GenerationID: generationID}, ReembedAllInsertOpts())
}

// ReembedEnqueueFunc adapts a JobInserter to reconcile.EnqueueFunc so the
// reconcile package never imports jobs (M2/FS-24): every embed_item/embed_tag
// job is inserted inside the reconcile transaction with EmbedInsertOpts.
func ReembedEnqueueFunc(ins JobInserter) reconcile.EnqueueFunc {
	return func(ctx context.Context, tx pgx.Tx, args river.JobArgs) error {
		if ins == nil {
			return errors.New("jobs: nil job inserter")
		}
		_, err := ins.InsertTx(ctx, tx, args, EmbedInsertOpts(args.Kind()))
		return err
	}
}

// inserter resolves the job inserter: the explicit one, else the River client
// carried by the worker context.
func (d Dependencies) inserter(ctx context.Context) (JobInserter, error) {
	if d.Inserter != nil {
		return d.Inserter, nil
	}
	c, err := river.ClientFromContextSafely[pgx.Tx](ctx)
	if err != nil {
		return nil, errors.New("jobs: no river client in context")
	}
	return RiverClientInserter{Client: c}, nil
}

func (d Dependencies) logger() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// reconcileGenerations runs Reconcile(scope, enqueue) on each generation and
// logs generation_id plus counts only (user-dec-016).
func (d Dependencies) reconcileGenerations(ctx context.Context, kind string, gens []generation.Generation, scope reconcile.Scope) error {
	ins, err := d.inserter(ctx)
	if err != nil {
		return err
	}
	enq := ReembedEnqueueFunc(ins)
	for _, g := range gens {
		res, err := reconcile.Reconcile(ctx, d.Pool, g, scope, reconcile.ModeEnqueue, enq)
		if err != nil {
			return fmt.Errorf("%s: reconcile generation %d failed", kind, g.ID)
		}
		d.logger().LogAttrs(ctx, slog.LevelInfo, kind+" generation reconciled",
			slog.Int("generation_id", g.ID),
			slog.Int("scanned", res.Scanned),
			slog.Int("missing", res.Missing),
			slog.Int("stale", res.Stale),
			slog.Int("orphan_deleted", res.OrphanDeleted),
			slog.Int("user_off_deleted", res.UserOffDeleted),
			slog.Int("enqueued", res.Enqueued),
			slog.Int("skipped_user_off", res.SkippedUserOff),
			slog.String("stop_reason", res.StopReason),
		)
	}
	return nil
}

// ReembedUserWorker reconciles one user across every generation in R (plan P05
// mục 2.17, Task 15; Task 13 enqueues it when semantic_suggest turns on).
type ReembedUserWorker struct {
	river.WorkerDefaults[jobargs.ReembedUserArgs]
	deps Dependencies
}

// NewReembedUserWorker constructs a ReembedUserWorker.
func NewReembedUserWorker(deps Dependencies) *ReembedUserWorker {
	return &ReembedUserWorker{deps: deps.withDefaults()}
}

// Timeout overrides River's 1-minute default: a user can own many targets.
func (w *ReembedUserWorker) Timeout(*river.Job[jobargs.ReembedUserArgs]) time.Duration {
	return reembedUserTimeout
}

// Work runs Reconcile(User) on every generation in R.
func (w *ReembedUserWorker) Work(ctx context.Context, job *river.Job[jobargs.ReembedUserArgs]) error {
	uid, err := uuid.Parse(job.Args.UserID)
	if err != nil || uid == uuid.Nil {
		return river.JobCancel(errors.New("reembed_user: invalid user_id"))
	}
	gens, err := generation.ReceivingGenerations(ctx, w.deps.Pool)
	if err != nil {
		return errors.New("reembed_user: read receiving generations failed")
	}
	return w.deps.reconcileGenerations(ctx, jobargs.KindReembedUser, gens, reconcile.User(uid))
}

// ReembedAllWorker reconciles every user on one generation (args.GenerationID >
// 0, which must be in R) or on every generation in R.
type ReembedAllWorker struct {
	river.WorkerDefaults[jobargs.ReembedAllArgs]
	deps Dependencies
}

// NewReembedAllWorker constructs a ReembedAllWorker.
func NewReembedAllWorker(deps Dependencies) *ReembedAllWorker {
	return &ReembedAllWorker{deps: deps.withDefaults()}
}

// Timeout overrides River's 1-minute default for a full-corpus scan.
func (w *ReembedAllWorker) Timeout(*river.Job[jobargs.ReembedAllArgs]) time.Duration {
	return reembedAllTimeout
}

// Work runs Reconcile(All) on the requested generation or on every generation
// in R.
func (w *ReembedAllWorker) Work(ctx context.Context, job *river.Job[jobargs.ReembedAllArgs]) error {
	gens, err := generation.ReceivingGenerations(ctx, w.deps.Pool)
	if err != nil {
		return errors.New("reembed_all: read receiving generations failed")
	}
	if id := job.Args.GenerationID; id > 0 {
		var picked []generation.Generation
		for _, g := range gens {
			if g.ID == id {
				picked = append(picked, g)
			}
		}
		if len(picked) == 0 {
			return river.JobCancel(fmt.Errorf("reembed_all: generation %d is not in the receiving set", id))
		}
		gens = picked
	}
	return w.deps.reconcileGenerations(ctx, jobargs.KindReembedAll, gens, reconcile.All())
}
