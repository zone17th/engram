// Package lifecycle implements the embedding generation lifecycle (plan P05
// mục 2.15 steps 1-7, Task 19; ADR 0007): create, backfill, index, verify,
// flip, rollback, retire, drop, and the periodic bootstrap auto-flip.
//
// Import direction (M2/FS-24): lifecycle imports generation, store, reconcile,
// jobargs, embedid and internal/db/gen; only internal/worker and cmd/worker
// import lifecycle (TestEmbeddingImportDirection). It never imports jobs: the
// Backfill caller supplies the reconcile.EnqueueFunc.
//
// Locking (OQ-16): create, flip, rollback, retire, drop and the verification
// watermark take generation.LockGenerationSetExclusive inside their own
// transaction. No lock is ever held across a network call, and every change of
// the active generation sends pg_notify(generation.NotifyChannel, ...) in the
// same transaction so Pin and availability caches drop immediately (M3/FS-25).
//
// Privacy: errors, logs and reports carry only generation ids, counts and
// reason codes; never names, hints, tag text, query text, vectors or job args.
package lifecycle

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/reconcile"
)

// Sentinel errors. Their text is stable and privacy-safe; the CLI maps them to
// reason codes.
var (
	// ErrNotPending is returned when an operation that needs a pending
	// generation (backfill, index, verify, flip) targets another state.
	ErrNotPending = errors.New("lifecycle: generation is not pending")
	// ErrNotRetired is returned when rollback, retire-window or drop targets a
	// generation that is not retired.
	ErrNotRetired = errors.New("lifecycle: generation is not retired")
	// ErrPendingExists is returned by Create when a pending generation exists.
	ErrPendingExists = errors.New("lifecycle: a pending generation already exists")
	// ErrCalibrationMissing aliases generation.ErrCalibrationMissing (gate 5).
	ErrCalibrationMissing = generation.ErrCalibrationMissing
	// ErrDimsMismatch is returned when a generation's tables do not match its
	// declared dims.
	ErrDimsMismatch = errors.New("lifecycle: generation tables do not match declared dims")
	// ErrIndexNotReady is returned when index_ready is false (or per-partition
	// indexes are not all valid) where an operation needs it.
	ErrIndexNotReady = errors.New("lifecycle: generation index is not ready")
	// ErrNotVerified is returned by Flip when the generation has no passing
	// verify report.
	ErrNotVerified = errors.New("lifecycle: generation has no passing verification")
	// ErrVerifyStale is returned by Flip when the last verification is older
	// than MaxVerifyAge (1 h).
	ErrVerifyStale = errors.New("lifecycle: last verification is older than one hour")
	// ErrCoverageIncomplete is returned when vectors or embed jobs of the
	// generation do not cover every eligible live target (flip refuses below
	// full coverage; there is no "95 %").
	ErrCoverageIncomplete = errors.New("lifecycle: generation does not cover every eligible target")
	// ErrGenerationNotCaughtUp is returned by Rollback when the retired
	// generation fails the verify conditions (plan 2.15 step 6).
	ErrGenerationNotCaughtUp = errors.New("lifecycle: generation_not_caught_up")
	// ErrRollbackWindowClosed is returned by Rollback when the retired
	// generation's rollback window has ended.
	ErrRollbackWindowClosed = errors.New("lifecycle: rollback window closed")
	// ErrDropGuard is returned by Drop (and Retire) when a guard refuses:
	// generation is active, not retired, still inside the rollback window, or
	// accepted evidence is missing.
	ErrDropGuard = errors.New("lifecycle: drop refused by guard")
	// ErrIsActive is returned when the target is the active generation.
	ErrIsActive = errors.New("lifecycle: generation is active")
)

const (
	// MaxVerifyAge is how old a passing verification may be at flip time.
	MaxVerifyAge = time.Hour
	// DefaultRollbackWindow is used when FlipOpts.RollbackWindow is zero
	// (matches SEARCH_ROLLBACK_WINDOW's default).
	DefaultRollbackWindow = 168 * time.Hour
	// ReasonBootstrapAuto is the flipped_reason written by AutoFlipBootstrap.
	ReasonBootstrapAuto = "bootstrap_auto"
)

// CreateOpts overrides the HNSW/partition shape of a new generation. Zero
// values mean generation.DefaultPartitions / DefaultHnswM /
// DefaultHnswEfConstruction.
type CreateOpts struct {
	Partitions     int
	M              int
	EfConstruction int
}

// Create is plan 2.15 step 1: under the exclusive generation lock it refuses
// when a pending generation exists (ErrPendingExists) or calibration for ident
// is missing (ErrCalibrationMissing, gate 5), then inserts the next generation
// id as pending (bootstrap=false) and creates its item/tag partitioned tables
// WITHOUT HNSW indexes. From commit, mutations fan out to active and pending.
//
// "create --bootstrap" does not use this function; it calls
// generation.Bootstrap, the same function as worker boot.
func Create(
	ctx context.Context,
	pool *pgxpool.Pool,
	ident embedid.Identity,
	calib embedid.CalibrationLookup,
	opts CreateOpts,
) (generation.Generation, error) {
	return generation.Generation{}, errors.New("not implemented")
}

// Backfill is plan 2.15 step 2: Reconcile(All, ModeEnqueue) on a pending
// generation using enq to insert embed jobs. Returns ErrNotPending for any
// other state. Batch size, queue concurrency and Retry-After handling are those
// of reconcile and the embedding queue.
func Backfill(
	ctx context.Context,
	pool *pgxpool.Pool,
	genID int,
	enq reconcile.EnqueueFunc,
) (reconcile.Result, error) {
	return reconcile.Result{}, errors.New("not implemented")
}

// IndexResult counts what Index did. Counts only.
type IndexResult struct {
	GenerationID int `json:"generation_id"`
	// Expected is partitions x 2 corpora.
	Expected int `json:"expected"`
	// Built counts per-partition indexes created by this call.
	Built int `json:"built"`
	// Repaired counts invalid indexes dropped and rebuilt by this call.
	Repaired int `json:"repaired"`
	// AlreadyValid counts per-partition indexes that were already valid.
	AlreadyValid int `json:"already_valid"`
	// Valid is the number of valid per-partition indexes after the call.
	Valid int `json:"valid"`
	// Ready is true when Valid == Expected and index_ready was set.
	Ready bool `json:"ready"`
}

// Index is plan 2.15 step 3: CREATE INDEX CONCURRENTLY per partition (outside a
// transaction), then CREATE INDEX ... ON ONLY on each parent and ALTER INDEX
// ... ATTACH PARTITION. index_ready is set only when every per-partition index
// has pg_index.indisvalid. Idempotent: a re-run after a crash drops and
// rebuilds invalid indexes and re-attaches. Returns ErrNotPending for other
// states and ErrIndexNotReady when indexes are still invalid afterwards.
func Index(ctx context.Context, pool *pgxpool.Pool, genID int) (IndexResult, error) {
	return IndexResult{}, errors.New("not implemented")
}

// FlipOpts parameterises Flip and AutoFlipBootstrap.
type FlipOpts struct {
	// Reason is stored in embedding_active.flipped_reason (short operator
	// token, at most 200 bytes; never printed back with user data).
	Reason string
	// RollbackWindow is the rollback window of the retired old active
	// generation. Zero means DefaultRollbackWindow.
	RollbackWindow time.Duration
	// Now is an injectable clock (default time.Now).
	Now func() time.Time
}

// Flip is plan 2.15 step 5: pending -> active; the old active (if any) ->
// retired with rollback_until = now + RollbackWindow; embedding_active upsert;
// pg_notify in the same transaction. It refuses (a) a generation that is not
// pending (ErrNotPending), (b) index_ready=false (ErrIndexNotReady), (c) no
// passing verification (ErrNotVerified) or one older than MaxVerifyAge
// (ErrVerifyStale), (d) incomplete coverage (ErrCoverageIncomplete): the dry
// run is re-checked before the lock, and inside the exclusive transaction no
// non-final embed job of the generation may exist. Non-bootstrap flips are
// manual only; the CLI requires --yes.
func Flip(ctx context.Context, pool *pgxpool.Pool, genID int, opts FlipOpts) error {
	return errors.New("not implemented")
}

// RollbackOpts parameterises Rollback.
type RollbackOpts struct {
	// Reason is stored in embedding_active.flipped_reason.
	Reason string
	// RollbackWindow is the window given to the generation being replaced.
	// Zero means DefaultRollbackWindow.
	RollbackWindow time.Duration
	// Now is an injectable clock (default time.Now).
	Now func() time.Time
	// Verify tunes the catch-up verification (zero value: defaults).
	Verify VerifyOpts
}

// Rollback is plan 2.15 step 6: reactivates the retired generation toGenID
// inside its rollback window, only if it catches up under the verify
// conditions. Errors: ErrNotRetired, ErrRollbackWindowClosed,
// ErrGenerationNotCaughtUp.
func Rollback(ctx context.Context, pool *pgxpool.Pool, toGenID int, opts RollbackOpts) error {
	return errors.New("not implemented")
}

// RetireOpts parameterises Retire.
type RetireOpts struct {
	// Now is an injectable clock (default time.Now).
	Now func() time.Time
}

// Retire ends the life of a non-active generation: a pending generation is
// abandoned (state retired, window closed, leaves R); a retired generation's
// rollback window is closed early. The active generation is refused with
// ErrIsActive. Afterwards Drop may remove the tables.
func Retire(ctx context.Context, pool *pgxpool.Pool, genID int, opts RetireOpts) error {
	return errors.New("not implemented")
}

// DropOpts parameterises Drop.
type DropOpts struct {
	// AcceptedEvidence is the path of the accepted-evidence file (OQ-19). The
	// CLI checks that the file exists; lifecycle only requires non-empty.
	AcceptedEvidence string
	// Now is an injectable clock (default time.Now).
	Now func() time.Time
}

// Drop is plan 2.15 step 7: drops the vector tables of a retired generation
// whose rollback_until has passed, with a non-empty AcceptedEvidence, then
// marks it dropped. Never active (ErrIsActive), never pending, never inside the
// window (ErrDropGuard).
func Drop(ctx context.Context, pool *pgxpool.Pool, genID int, opts DropOpts) error {
	return errors.New("not implemented")
}
