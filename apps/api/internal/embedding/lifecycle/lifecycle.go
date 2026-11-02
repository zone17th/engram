// Package lifecycle implements the embedding generation lifecycle (plan P05
// mục 2.15 steps 1-7, Task 19; ADR 0007): create, backfill, index, verify,
// flip, rollback, retire, drop, and the periodic bootstrap auto-flip.
//
// Import direction (M2/FS-24): lifecycle imports embedding (input helpers),
// generation, store, reconcile, jobargs, embedid and internal/db/gen; only internal/worker and cmd/worker
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
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
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
	if pool == nil {
		return generation.Generation{}, generation.ErrNilTx
	}
	if ident.Provider != generation.ProviderTEI && ident.Provider != generation.ProviderOpenAICompat {
		return generation.Generation{}, fmt.Errorf("%w: unsupported provider", generation.ErrInvalidBootstrapIdentity)
	}
	if strings.TrimSpace(ident.Model) == "" ||
		strings.TrimSpace(ident.ModelVersion) == "" ||
		strings.TrimSpace(ident.Preprocessing) == "" {
		return generation.Generation{}, fmt.Errorf("%w: model, model_version and preprocessing are required", generation.ErrInvalidBootstrapIdentity)
	}
	if ident.Dims < 1 || ident.Dims > 2000 {
		return generation.Generation{}, fmt.Errorf("%w: dims out of range 1..2000", generation.ErrInvalidBootstrapIdentity)
	}
	partitions, m, efc := opts.Partitions, opts.M, opts.EfConstruction
	if partitions == 0 {
		partitions = generation.DefaultPartitions
	}
	if m == 0 {
		m = generation.DefaultHnswM
	}
	if efc == 0 {
		efc = generation.DefaultHnswEfConstruction
	}
	if partitions < 1 || partitions > 256 || m < 2 || m > 100 || efc < 4 || efc > 1000 || efc < 2*m {
		return generation.Generation{}, errors.New("lifecycle: create options out of range")
	}

	tx, err := beginExclusive(ctx, pool)
	if err != nil {
		return generation.Generation{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	q := gen.New(tx)
	if _, err := q.GetPendingEmbeddingGeneration(ctx); err == nil {
		return generation.Generation{}, ErrPendingExists
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return generation.Generation{}, err
	}

	if calib == nil {
		return generation.Generation{}, ErrCalibrationMissing
	}
	minCos, reportPath, ok := calib(ident)
	if !ok || strings.TrimSpace(reportPath) == "" || minCos <= 0 || minCos >= 1 {
		return generation.Generation{}, ErrCalibrationMissing
	}

	nextID, err := q.NextEmbeddingGenerationID(ctx)
	if err != nil {
		return generation.Generation{}, err
	}
	if nextID > generation.MaxGenerationID {
		return generation.Generation{}, errors.New("lifecycle: generation id space exhausted")
	}

	row, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 nextID,
		Provider:           ident.Provider,
		Model:              ident.Model,
		ModelVersion:       ident.ModelVersion,
		Preprocessing:      ident.Preprocessing,
		QueryPrefix:        ident.QueryPrefix,
		DocPrefix:          ident.DocPrefix,
		Dims:               int32(ident.Dims),
		Partitions:         int32(partitions),
		HnswM:              int32(m),
		HnswEfConstruction: int32(efc),
		SemanticMinCos:     float32(minCos),
		CalibrationRef:     reportPath,
		Bootstrap:          false,
	})
	if err != nil {
		return generation.Generation{}, err
	}
	// Tables WITHOUT HNSW: the indexes are built by Index after the backfill.
	if err := q.CreateEmbeddingGenerationTables(ctx, gen.CreateEmbeddingGenerationTablesParams{
		ID:                 nextID,
		Dims:               int32(ident.Dims),
		Partitions:         int32(partitions),
		WithHnsw:           false,
		HnswM:              int32(m),
		HnswEfConstruction: int32(efc),
	}); err != nil {
		return generation.Generation{}, err
	}
	g, err := generation.FromDBRow(row)
	if err != nil {
		return generation.Generation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return generation.Generation{}, err
	}
	return g, nil
}

// lockTimeout bounds how long a lifecycle transaction waits for the generation
// lock or for DDL locks on item/tag, so a stuck peer cannot stall mutations
// queued behind us indefinitely.
const lockTimeout = "30s"

// beginExclusive starts a transaction that holds the exclusive generation-set
// lock (OQ-16) for its whole life.
func beginExclusive(ctx context.Context, pool *pgxpool.Pool) (pgx.Tx, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '"+lockTimeout+"'"); err != nil {
		_ = tx.Rollback(context.Background())
		return nil, err
	}
	if err := generation.LockGenerationSetExclusive(ctx, tx); err != nil {
		_ = tx.Rollback(context.Background())
		return nil, err
	}
	return tx, nil
}

// clockNow returns the time a lifecycle decision is made at (GL-3). The
// production source is the database clock (clock_timestamp(), the clock R uses
// for "rollback_until > now()" and that stamps verified_at), so Go/DB skew can
// never widen a window. Precedence: a non-nil inj (the Now option of
// FlipOpts/RollbackOpts/DropOpts; tests only) replaces the database clock at
// every call, entry check and final decision alike, so an injected clock must be
// coherent with the stored timestamps it is compared against.
func clockNow(ctx context.Context, db gen.DBTX, inj func() time.Time) (time.Time, error) {
	if inj != nil {
		return inj(), nil
	}
	var t time.Time
	if err := db.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&t); err != nil {
		return time.Time{}, fmt.Errorf("lifecycle: read database clock failed: %w", sanitizeDBErr(err))
	}
	return t, nil
}

// getPending loads genID and requires state pending.
func getPending(ctx context.Context, db gen.DBTX, genID int) (generation.Generation, error) {
	g, err := generation.GetByID(ctx, db, genID)
	if err != nil {
		return generation.Generation{}, err
	}
	if g.State != generation.StatePending {
		return generation.Generation{}, ErrNotPending
	}
	return g, nil
}

// notifyGenerationChanged sends the NOTIFY in the caller's transaction so it
// is delivered only if the state change commits (M3/FS-25).
func notifyGenerationChanged(ctx context.Context, tx pgx.Tx, genID int) error {
	_, err := tx.Exec(ctx, `SELECT pg_notify($1, $2)`, generation.NotifyChannel, strconv.Itoa(genID))
	return err
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
	if pool == nil {
		return reconcile.Result{}, generation.ErrNilTx
	}
	g, err := getPending(ctx, pool, genID)
	if err != nil {
		return reconcile.Result{}, err
	}
	return reconcile.Reconcile(ctx, pool, g, reconcile.All(), reconcile.ModeEnqueue, enq)
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
	if pool == nil {
		return IndexResult{}, generation.ErrNilTx
	}
	g, err := getPending(ctx, pool, genID)
	if err != nil {
		return IndexResult{}, err
	}
	parts, err := partitionTables(g)
	if err != nil {
		return IndexResult{}, err
	}
	res := IndexResult{GenerationID: g.ID, Expected: len(parts)}

	for _, p := range parts {
		valid, exists, err := indexValidity(ctx, pool, p.index, p.table)
		if err != nil {
			return res, err
		}
		switch {
		case valid:
			res.AlreadyValid++
			continue
		case exists:
			// A crashed CREATE INDEX CONCURRENTLY leaves an invalid index that
			// IF NOT EXISTS would silently keep: drop it and rebuild.
			if _, err := pool.Exec(ctx, "DROP INDEX CONCURRENTLY IF EXISTS "+pgx.Identifier{p.index}.Sanitize()); err != nil { // #nosec G202 -- index name derived from the validated table allowlist and quoted via pgx.Identifier.Sanitize().
				return res, fmt.Errorf("lifecycle: drop invalid index failed: %w", sanitizeDBErr(err))
			}
			res.Repaired++
		default:
			res.Built++
		}
		if _, err := pool.Exec(ctx, hnswIndexSQL(p.index, p.table, g.HnswM, g.HnswEfConstruction, true)); err != nil {
			return res, fmt.Errorf("lifecycle: create partition index failed: %w", sanitizeDBErr(err))
		}
	}

	// Parent (ON ONLY) index + ATTACH PARTITION per corpus; idempotent.
	for _, corpus := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		if err := ensureParentIndex(ctx, pool, g, corpus, parts); err != nil {
			return res, err
		}
	}

	valid, err := countValidPartitionIndexes(ctx, pool, parts)
	if err != nil {
		return res, err
	}
	res.Valid = valid
	res.Ready = valid == res.Expected
	if _, err := gen.New(pool).SetEmbeddingGenerationIndexReady(ctx, gen.SetEmbeddingGenerationIndexReadyParams{
		IndexReady: res.Ready,
		ID:         int32(g.ID),
	}); err != nil {
		return res, err
	}
	if !res.Ready {
		return res, ErrIndexNotReady
	}
	return res, nil
}

// partTable names one partition table and the HNSW index expected on it.
type partTable struct {
	corpus generation.Corpus
	parent string
	table  string
	index  string
}

// partitionTables lists every per-partition table and index name of g, derived
// from the validated parent table names (never from input).
func partitionTables(g generation.Generation) ([]partTable, error) {
	var out []partTable
	for _, corpus := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		ident, err := g.TableIdent(corpus)
		if err != nil {
			return nil, err
		}
		parent := ident[0]
		for i := 0; i < g.Partitions; i++ {
			part := parent + "_p" + strconv.Itoa(i)
			out = append(out, partTable{corpus: corpus, parent: parent, table: part, index: part + "_hnsw"})
		}
	}
	return out, nil
}

func hnswIndexSQL(index, table string, m, efc int, concurrently bool) string {
	conc := ""
	if concurrently {
		conc = "CONCURRENTLY "
	}
	// #nosec G202 -- index/table names derive from the validated allowlist and are quoted via pgx.Identifier.Sanitize(); m and efc are validated ints.
	return "CREATE INDEX " + conc + "IF NOT EXISTS " + pgx.Identifier{index}.Sanitize() +
		" ON " + pgx.Identifier{table}.Sanitize() +
		" USING hnsw (embedding vector_cosine_ops) WITH (m = " + strconv.Itoa(m) +
		", ef_construction = " + strconv.Itoa(efc) + ")"
}

// indexValidity reports whether an hnsw index named index exists on table and
// whether it is valid.
func indexValidity(ctx context.Context, db gen.DBTX, index, table string) (valid, exists bool, err error) {
	err = db.QueryRow(ctx, `
SELECT i.indisvalid AND i.indisready
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_am am ON am.oid = c.relam
WHERE c.relname = $1 AND t.relname = $2 AND am.amname = 'hnsw' AND pg_table_is_visible(c.oid)`,
		index, table).Scan(&valid)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	return valid, true, nil
}

// countValidPartitionIndexes counts the per-partition hnsw indexes of parts
// that are valid (pg_index.indisvalid and indisready).
func countValidPartitionIndexes(ctx context.Context, db gen.DBTX, parts []partTable) (int, error) {
	idx := make([]string, 0, len(parts))
	tbl := make([]string, 0, len(parts))
	for _, p := range parts {
		idx = append(idx, p.index)
		tbl = append(tbl, p.table)
	}
	var n int
	err := db.QueryRow(ctx, `
SELECT count(DISTINCT c.relname)::int
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_am am ON am.oid = c.relam
WHERE am.amname = 'hnsw'
  AND i.indisvalid AND i.indisready
  AND pg_table_is_visible(c.oid)
  AND c.relname = ANY($1::text[])
  AND t.relname = ANY($2::text[])
  AND c.relname = t.relname || '_hnsw'`, idx, tbl).Scan(&n)
	return n, err
}

// ensureParentIndex creates the ON ONLY parent index of corpus and attaches
// every partition index that is not attached yet. Re-running is a no-op.
func ensureParentIndex(ctx context.Context, pool *pgxpool.Pool, g generation.Generation, corpus generation.Corpus, parts []partTable) error {
	var parent string
	for _, p := range parts {
		if p.corpus == corpus {
			parent = p.parent
			break
		}
	}
	if parent == "" {
		return nil
	}
	parentIdx := parent + "_hnsw"
	// #nosec G202 -- names derive from the validated allowlist and are quoted via pgx.Identifier.Sanitize(); m and efc are validated ints.
	create := "CREATE INDEX IF NOT EXISTS " + pgx.Identifier{parentIdx}.Sanitize() +
		" ON ONLY " + pgx.Identifier{parent}.Sanitize() +
		" USING hnsw (embedding vector_cosine_ops) WITH (m = " + strconv.Itoa(g.HnswM) +
		", ef_construction = " + strconv.Itoa(g.HnswEfConstruction) + ")"
	if _, err := pool.Exec(ctx, create); err != nil {
		return fmt.Errorf("lifecycle: create parent index failed: %w", sanitizeDBErr(err))
	}
	for _, p := range parts {
		if p.corpus != corpus {
			continue
		}
		var attached bool
		if err := pool.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM pg_inherits
  WHERE inhrelid = to_regclass($1) AND inhparent = to_regclass($2))`,
			pgx.Identifier{p.index}.Sanitize(), pgx.Identifier{parentIdx}.Sanitize()).Scan(&attached); err != nil {
			return err
		}
		if attached {
			continue
		}
		// #nosec G202 -- names derive from the validated allowlist and are quoted via pgx.Identifier.Sanitize().
		attach := "ALTER INDEX " + pgx.Identifier{parentIdx}.Sanitize() + " ATTACH PARTITION " + pgx.Identifier{p.index}.Sanitize()
		if _, err := pool.Exec(ctx, attach); err != nil {
			return fmt.Errorf("lifecycle: attach partition index failed: %w", sanitizeDBErr(err))
		}
	}
	return nil
}

// sanitizeDBErr reduces a database error to its SQLSTATE so logs and CLI output
// never carry statement text or row data.
func sanitizeDBErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	var pe interface{ SQLState() string }
	if errors.As(err, &pe) {
		return fmt.Errorf("sqlstate %s", pe.SQLState())
	}
	return errors.New("database error")
}

// FlipOpts parameterises Flip and AutoFlipBootstrap.
type FlipOpts struct {
	// Reason is stored in embedding_active.flipped_reason (short operator
	// token, at most 200 bytes; never printed back with user data).
	Reason string
	// RollbackWindow is the rollback window of the retired old active
	// generation. Zero means DefaultRollbackWindow.
	RollbackWindow time.Duration
	// Now replaces the database clock at every decision (tests only; see
	// clockNow). Default: the database clock read at the decision (GL-3).
	Now func() time.Time
	// BeforeExclusive is a test-only hook called after the outside-lock checks
	// (including the coverage dry run) and right before the exclusive
	// transaction begins: the window in which a committed mutation is invisible
	// to the dry run but must still be fenced (GL-1).
	BeforeExclusive func()
}

// Flip is plan 2.15 step 5: pending -> active; the old active (if any) ->
// retired with rollback_until = now + RollbackWindow; embedding_active upsert;
// pg_notify in the same transaction. It refuses (a) a generation that is not
// pending (ErrNotPending), (b) index_ready=false (ErrIndexNotReady), (c) no
// passing verification (ErrNotVerified) or one older than MaxVerifyAge
// (ErrVerifyStale), (d) incomplete coverage (ErrCoverageIncomplete): the dry
// run is re-checked before the lock as a cheap pre-check, and inside the
// exclusive transaction no non-final embed job of the generation may exist and
// coverageInTx re-proves coverage (target edits AND eligibility changes) while
// the lock fences every mutation (GL-1). Non-bootstrap flips are manual only; the
// CLI requires --yes.
func Flip(ctx context.Context, pool *pgxpool.Pool, genID int, opts FlipOpts) error {
	return flip(ctx, pool, genID, opts, false)
}

// errActiveExists is internal: a bootstrap auto-flip found an active generation
// (nothing to flip to; bootstrap only ever fills an empty deployment).
var errActiveExists = errors.New("lifecycle: an active generation exists")

// flip implements Flip and the bootstrap auto-flip. requireNoActive makes it
// refuse (errActiveExists) when embedding_active already points somewhere.
func flip(ctx context.Context, pool *pgxpool.Pool, genID int, opts FlipOpts, requireNoActive bool) error {
	if pool == nil {
		return generation.ErrNilTx
	}
	window := opts.RollbackWindow
	if window <= 0 {
		window = DefaultRollbackWindow
	}
	reason := flipReason(opts.Reason, "manual")

	g, err := generation.GetByID(ctx, pool, genID)
	if err != nil {
		return err
	}
	// Fast-fail only: the authoritative checks and the replaced generation's
	// window use the clock re-read at the decision inside the exclusive tx (GL-3).
	now, err := clockNow(ctx, pool, opts.Now)
	if err != nil {
		return err
	}
	if err := checkFlippable(g, now); err != nil {
		return err
	}
	// Coverage re-check outside the lock (a Reconcile dry run can take a while
	// and takes no lock itself); the transaction below closes the remaining gap
	// by refusing while any embed job of g is unfinished.
	cov, err := coverageOf(ctx, pool, g)
	if err != nil {
		return err
	}
	if !cov.Complete {
		return ErrCoverageIncomplete
	}
	if opts.BeforeExclusive != nil {
		opts.BeforeExclusive()
	}

	tx, err := beginExclusive(ctx, pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	row, err := gen.New(tx).GetEmbeddingGenerationByIDForUpdate(ctx, int32(genID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return generation.ErrGenerationNotFound
		}
		return err
	}
	g, err = generation.FromDBRow(row)
	if err != nil {
		return err
	}
	// Cheap precondition check before the (possibly long) in-lock scan.
	if now, err = clockNow(ctx, tx, opts.Now); err != nil {
		return err
	}
	if err := checkFlippable(g, now); err != nil {
		return err
	}
	if requireNoActive {
		if _, err := gen.New(tx).GetEmbeddingActiveRow(ctx); err == nil {
			return errActiveExists
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	// With the exclusive lock held no mutation can fan out a new job; an
	// unfinished embed job of g means a mutation after the verification
	// watermark that is not covered yet.
	n, err := countEmbedJobs(ctx, tx, g.ID, nil)
	if err != nil {
		return err
	}
	if n > 0 {
		return ErrCoverageIncomplete
	}
	// Jobs only see target edits. Re-prove coverage itself under the lock so an
	// eligibility change that created no embed job cannot slip through (GL-1).
	if err := coverageInTx(ctx, tx, g); err != nil {
		return err
	}
	// The decision: verification freshness is judged, and the replaced
	// generation's rollback window starts, at this instant - not at the start of
	// the operation, which may be long before (verification, scan, lock wait).
	if now, err = clockNow(ctx, tx, opts.Now); err != nil {
		return err
	}
	if err := checkFlippable(g, now); err != nil {
		return err
	}
	if err := swapActive(ctx, tx, g, now, window, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// checkFlippable applies the preconditions of a flip that need only the row:
// pending, index ready, a passing verification no older than MaxVerifyAge.
func checkFlippable(g generation.Generation, now time.Time) error {
	if g.State != generation.StatePending {
		return ErrNotPending
	}
	if !g.IndexReady {
		return ErrIndexNotReady
	}
	var rep VerifyReport
	if g.VerifiedAt == nil || len(g.VerifyReport) == 0 || json.Unmarshal(g.VerifyReport, &rep) != nil ||
		!rep.Passed || rep.GenerationID != g.ID {
		return ErrNotVerified
	}
	if now.Sub(*g.VerifiedAt) > MaxVerifyAge {
		return ErrVerifyStale
	}
	return nil
}

func flipReason(reason, fallback string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return fallback
	}
	if len(reason) > 200 {
		reason = reason[:200]
	}
	return strings.ToValidUTF8(reason, "")
}

// swapActive makes to the active generation inside the caller's exclusive
// transaction: the previous active generation (if different) is retired with a
// rollback window, embedding_active is upserted and NOTIFY is sent, all in tx.
func swapActive(ctx context.Context, tx pgx.Tx, to generation.Generation, now time.Time, window time.Duration, reason string) error {
	q := gen.New(tx)
	active, err := q.GetEmbeddingActiveRow(ctx)
	switch {
	case err == nil:
		if int(active.GenerationID) != to.ID {
			if _, err := q.RetireEmbeddingGeneration(ctx, gen.RetireEmbeddingGenerationParams{
				RollbackUntil: pgtype.Timestamptz{Time: now.Add(window), Valid: true},
				ID:            active.GenerationID,
			}); err != nil {
				return err
			}
		}
	case errors.Is(err, pgx.ErrNoRows):
	default:
		return err
	}
	if _, err := q.ActivateEmbeddingGeneration(ctx, int32(to.ID)); err != nil {
		return err
	}
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
		GenerationID:  int32(to.ID),
		FlippedReason: &reason,
	}); err != nil {
		return err
	}
	return notifyGenerationChanged(ctx, tx, to.ID)
}

// countEmbedJobs counts unfinished embed_item/embed_tag jobs of generation
// genID, optionally only those created before before. Only the generation_id
// argument is matched; no other argument is read.
func countEmbedJobs(ctx context.Context, db gen.DBTX, genID int, before *time.Time) (int, error) {
	var n int
	err := db.QueryRow(ctx, `
SELECT count(*)::int FROM river_job
WHERE kind IN ($1, $2)
  AND state IN ('available', 'pending', 'retryable', 'running', 'scheduled')
  AND args @> $3::jsonb
  AND ($4::timestamptz IS NULL OR created_at < $4::timestamptz)`,
		jobargs.KindEmbedItem, jobargs.KindEmbedTag,
		`{"generation_id":`+strconv.Itoa(genID)+`}`, before).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("lifecycle: count embed jobs failed: %w", sanitizeDBErr(err))
	}
	return n, nil
}

// RollbackOpts parameterises Rollback.
type RollbackOpts struct {
	// Reason is stored in embedding_active.flipped_reason.
	Reason string
	// RollbackWindow is the window given to the generation being replaced.
	// Zero means DefaultRollbackWindow.
	RollbackWindow time.Duration
	// Now replaces the database clock at every decision (tests only; see
	// clockNow). Default: the database clock read at the decision (GL-3).
	Now func() time.Time
	// Verify tunes the catch-up verification (zero value: defaults).
	Verify VerifyOpts
	// BeforeExclusive is a test-only hook called after the outside-lock
	// verification and right before the exclusive transaction begins (GL-1).
	BeforeExclusive func()
}

// Rollback is plan 2.15 step 6: reactivates the retired generation toGenID
// inside its rollback window, only if it catches up under the verify
// conditions: verified before the lock as a pre-check, then re-proved inside the
// exclusive transaction by coverageInTx (GL-1). Errors: ErrNotRetired,
// ErrRollbackWindowClosed, ErrGenerationNotCaughtUp (an in-lock coverage gap
// also matches ErrCoverageIncomplete).
func Rollback(ctx context.Context, pool *pgxpool.Pool, toGenID int, opts RollbackOpts) error {
	if pool == nil {
		return generation.ErrNilTx
	}
	window := opts.RollbackWindow
	if window <= 0 {
		window = DefaultRollbackWindow
	}
	reason := flipReason(opts.Reason, "rollback")

	g, err := generation.GetByID(ctx, pool, toGenID)
	if err != nil {
		return err
	}
	// Fast-fail only: the window is enforced again at the decision, after the
	// verification and the lock wait, with a clock re-read then (GL-3).
	now, err := clockNow(ctx, pool, opts.Now)
	if err != nil {
		return err
	}
	if err := checkRollbackTarget(g, now); err != nil {
		return err
	}
	vopts := opts.Verify
	if vopts.Now == nil {
		vopts.Now = opts.Now
	}
	rep, err := verifyGeneration(ctx, pool, g, vopts, generation.StateRetired)
	if err != nil {
		return err
	}
	if !rep.Passed {
		return ErrGenerationNotCaughtUp
	}
	if opts.BeforeExclusive != nil {
		opts.BeforeExclusive()
	}

	tx, err := beginExclusive(ctx, pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	row, err := gen.New(tx).GetEmbeddingGenerationByIDForUpdate(ctx, int32(toGenID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return generation.ErrGenerationNotFound
		}
		return err
	}
	g, err = generation.FromDBRow(row)
	if err != nil {
		return err
	}
	if now, err = clockNow(ctx, tx, opts.Now); err != nil {
		return err
	}
	if err := checkRollbackTarget(g, now); err != nil {
		return err
	}
	n, err := countEmbedJobs(ctx, tx, g.ID, nil)
	if err != nil {
		return err
	}
	if n > 0 {
		return ErrGenerationNotCaughtUp
	}
	if err := coverageInTx(ctx, tx, g); err != nil {
		if errors.Is(err, ErrCoverageIncomplete) {
			return fmt.Errorf("%w: %w", ErrGenerationNotCaughtUp, ErrCoverageIncomplete)
		}
		return err
	}
	// The decision: the rollback deadline is enforced, and the replaced
	// generation's new window starts, at this instant (GL-3). MaxVerifyAge needs
	// no check here: the catch-up proof above was made under this same lock.
	if now, err = clockNow(ctx, tx, opts.Now); err != nil {
		return err
	}
	if err := checkRollbackTarget(g, now); err != nil {
		return err
	}
	if err := swapActive(ctx, tx, g, now, window, reason); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func checkRollbackTarget(g generation.Generation, now time.Time) error {
	if g.State != generation.StateRetired {
		return ErrNotRetired
	}
	if g.RollbackUntil == nil || !g.RollbackUntil.After(now) {
		return ErrRollbackWindowClosed
	}
	return nil
}

// RetireOpts parameterises Retire.
type RetireOpts struct {
	// Now replaces the database clock at every decision (tests only; see
	// clockNow). Default: the database clock read at the decision (GL-3).
	Now func() time.Time
}

// Retire ends the life of a non-active generation: a pending generation is
// abandoned (state retired, window closed, leaves R); a retired generation's
// rollback window is closed early. The active generation is refused with
// ErrIsActive. Afterwards Drop may remove the tables.
func Retire(ctx context.Context, pool *pgxpool.Pool, genID int, opts RetireOpts) error {
	if pool == nil {
		return generation.ErrNilTx
	}
	tx, err := beginExclusive(ctx, pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	q := gen.New(tx)
	row, err := q.GetEmbeddingGenerationByIDForUpdate(ctx, int32(genID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return generation.ErrGenerationNotFound
		}
		return err
	}
	switch row.State {
	case generation.StateActive:
		return ErrIsActive
	case generation.StatePending:
		// Abandon: retired without a window leaves R immediately.
		if _, err := q.RetireEmbeddingGeneration(ctx, gen.RetireEmbeddingGenerationParams{
			RollbackUntil: pgtype.Timestamptz{},
			ID:            int32(genID),
		}); err != nil {
			return err
		}
	case generation.StateRetired:
		// Close the rollback window early.
		if _, err := tx.Exec(ctx,
			`UPDATE embedding_generation SET rollback_until = now() WHERE id = $1 AND state = 'retired' AND rollback_until > now()`,
			int32(genID)); err != nil {
			return err
		}
	default:
		return ErrNotRetired
	}
	return tx.Commit(ctx)
}

// DropOpts parameterises Drop.
type DropOpts struct {
	// AcceptedEvidence is the path of the accepted-evidence file (OQ-19). The
	// CLI checks that the file exists; lifecycle only requires non-empty.
	AcceptedEvidence string
	// Now replaces the database clock at every decision (tests only; see
	// clockNow). Default: the database clock read at the decision (GL-3).
	Now func() time.Time
}

// Drop is plan 2.15 step 7: drops the vector tables of a retired generation
// whose rollback_until has passed, with a non-empty AcceptedEvidence, then
// marks it dropped. Never active (ErrIsActive), never pending, never inside the
// window (ErrDropGuard).
func Drop(ctx context.Context, pool *pgxpool.Pool, genID int, opts DropOpts) error {
	if pool == nil {
		return generation.ErrNilTx
	}
	if strings.TrimSpace(opts.AcceptedEvidence) == "" {
		return fmt.Errorf("%w: accepted evidence is required", ErrDropGuard)
	}

	tx, err := beginExclusive(ctx, pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	q := gen.New(tx)
	row, err := q.GetEmbeddingGenerationByIDForUpdate(ctx, int32(genID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return generation.ErrGenerationNotFound
		}
		return err
	}
	activeRow, activeErr := q.GetEmbeddingActiveRow(ctx)
	if activeErr != nil && !errors.Is(activeErr, pgx.ErrNoRows) {
		return activeErr
	}
	if row.State == generation.StateActive || (activeErr == nil && int(activeRow.GenerationID) == genID) {
		return fmt.Errorf("%w: %w", ErrDropGuard, ErrIsActive)
	}
	if row.State != generation.StateRetired {
		return fmt.Errorf("%w: %w", ErrDropGuard, ErrNotRetired)
	}
	now, err := clockNow(ctx, tx, opts.Now)
	if err != nil {
		return err
	}
	if row.RollbackUntil.Valid && row.RollbackUntil.Time.After(now) {
		return fmt.Errorf("%w: inside the rollback window", ErrDropGuard)
	}
	if err := q.DropEmbeddingGenerationTables(ctx, int32(genID)); err != nil {
		return fmt.Errorf("lifecycle: drop tables failed: %w", sanitizeDBErr(err))
	}
	if _, err := q.MarkEmbeddingGenerationDropped(ctx, int32(genID)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
