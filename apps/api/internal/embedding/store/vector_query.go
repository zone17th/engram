package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/pgvector/pgvector-go"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

// VectorPath identifies the execution path taken by VectorSearch (plan P05
// mục 2.16, 2.21; obs.VectorPaths).
type VectorPath string

const (
	// VectorPathExact indicates count <= ExactMaxVectors: exact search via a
	// MATERIALIZED PK pre-selection CTE (no HNSW).
	VectorPathExact VectorPath = "exact"

	// VectorPathANN indicates count > ExactMaxVectors and ANN returned >= k
	// candidates before threshold filtering (or did not underfill).
	VectorPathANN VectorPath = "ann"

	// VectorPathANNFallbackExact indicates count > ExactMaxVectors, ANN
	// candidates before threshold filtering < k, remaining budget >=
	// FallbackMinBudget, and count <= FallbackMaxVectors, so VectorSearch ran
	// an exact query within the remaining budget.
	VectorPathANNFallbackExact VectorPath = "ann_fallback_exact"

	// VectorPathANNShort indicates count > ExactMaxVectors, ANN candidates
	// before threshold filtering < k, and exact fallback was not taken (either
	// count > FallbackMaxVectors, such as a whale tenant, or remaining budget <
	// FallbackMinBudget), or the exact fallback timed out and returned partial
	// ANN results.
	VectorPathANNShort VectorPath = "ann_short"
)

// IterativeScanMode values allowed for SET LOCAL hnsw.iterative_scan (plan P05
// mục 2.13, 2.16).
const (
	IterativeScanOff          = "off"
	IterativeScanRelaxedOrder = "relaxed_order"
	IterativeScanStrictOrder  = "strict_order"
)

// Default and boundary values for VectorSearchKnobs (plan P05 mục 2.13, 2.16;
// SPEC §4.4, §6.3, §6.4).
const (
	DefaultExactMaxVectors         = 3000
	DefaultExactFallbackMaxVectors = 3000
	MaxExactCapVectors             = 1000000

	DefaultHNSWEfSearch      = 64
	MinHNSWEfSearch          = 1
	MaxHNSWEfSearch          = 2000
	DefaultHNSWMaxScanTuples = 250
	MinHNSWMaxScanTuples     = 1
	MaxHNSWMaxScanTuples     = 1000000

	DefaultANNRandomPageCost = 1.1
	MinANNRandomPageCost     = 0.5
	MaxANNRandomPageCost     = 4.0
	// ANNRandomPageCostOff disables SET LOCAL random_page_cost inside the ANN tx.
	ANNRandomPageCostOff = -1.0

	DefaultVectorBranchTimeout     = 80 * time.Millisecond
	DefaultVectorFallbackMinBudget = 30 * time.Millisecond
	MinVectorTimeout               = time.Millisecond
	MaxVectorTimeout               = 30 * time.Second
)

var (
	// ErrInvalidK is returned when k <= 0.
	ErrInvalidK = errors.New("store: k must be > 0")

	// ErrInvalidKnobs is returned when VectorSearchKnobs fails validation.
	ErrInvalidKnobs = errors.New("store: invalid vector search knobs")
)

// VectorQueryDB abstracts *pgxpool.Pool (or a test double) capable of running
// both single queries and read-only transactions for SET LOCAL + pgx.Batch.
type VectorQueryDB interface {
	gen.DBTX
	BeginTx(ctx context.Context, txOptions pgx.TxOptions) (pgx.Tx, error)
}

// VectorSearchKnobs holds the validated configuration knobs and optional
// metrics/clock dependencies for VectorSearch (plan P05 mục 2.13, 2.16, 2.21).
//
// Thresholds are injectable so boundary and whale integration tests can verify
// exact/ANN/fallback transitions with small row counts while exercising
// identical SQL and branching semantics (Task 14).
type VectorSearchKnobs struct {
	// ExactMaxVectors is SEARCH_EXACT_MAX_VECTORS (0..1000000; 0 forces ANN).
	ExactMaxVectors int

	// FallbackMaxVectors is SEARCH_EXACT_FALLBACK_MAX_VECTORS (>= ExactMaxVectors,
	// 0..1000000). The single capped count query uses LIMIT FallbackMaxVectors + 1.
	FallbackMaxVectors int

	// EfSearch is SEARCH_HNSW_EF_SEARCH (1..2000, default 64).
	EfSearch int

	// MaxScanTuples is SEARCH_HNSW_MAX_SCAN_TUPLES (1..1000000, default 250).
	MaxScanTuples int

	// IterativeScan is SEARCH_HNSW_ITERATIVE_SCAN ("off", "relaxed_order", or
	// "strict_order"; default "relaxed_order").
	IterativeScan string

	// RandomPageCost is SEARCH_ANN_RANDOM_PAGE_COST (0.5..4.0, default 1.1;
	// ANNRandomPageCostOff = -1 skips SET LOCAL random_page_cost).
	RandomPageCost float64

	// BranchTimeout is SEARCH_VECTOR_BRANCH_TIMEOUT (default 80ms). Used when
	// the caller passes a zero deadline or to cap the remaining budget.
	BranchTimeout time.Duration

	// FallbackMinBudget is SEARCH_VECTOR_FALLBACK_MIN_BUDGET (default 30ms).
	// Underfill fallback to exact only runs when remaining budget >= FallbackMinBudget.
	FallbackMinBudget time.Duration

	// Metrics is the optional *obs.SearchMetrics collector bundle (dec-268).
	// When non-nil, VectorSearch increments VectorPathTotal{corpus, path} and
	// VectorUnderfillTotal{corpus}.
	Metrics *obs.SearchMetrics

	// Now is an optional clock function for deterministic budget tests
	// (defaults to time.Now when nil).
	Now func() time.Time

	// AfterANN is an optional test-only hook invoked right after the ANN query
	// finishes and before the remaining budget is checked for underfill fallback.
	AfterANN func()
}

// DefaultVectorSearchKnobs returns the production default knobs per plan P05
// mục 2.13 and SPEC §6.4.
func DefaultVectorSearchKnobs() VectorSearchKnobs {
	return VectorSearchKnobs{
		ExactMaxVectors:    DefaultExactMaxVectors,
		FallbackMaxVectors: DefaultExactFallbackMaxVectors,
		EfSearch:           DefaultHNSWEfSearch,
		MaxScanTuples:      DefaultHNSWMaxScanTuples,
		IterativeScan:      IterativeScanRelaxedOrder,
		RandomPageCost:     DefaultANNRandomPageCost,
		BranchTimeout:      DefaultVectorBranchTimeout,
		FallbackMinBudget:  DefaultVectorFallbackMinBudget,
	}
}

func (k VectorSearchKnobs) withDefaultsAndValidate() (VectorSearchKnobs, error) {
	out := k
	if out.EfSearch == 0 {
		out.EfSearch = DefaultHNSWEfSearch
	}
	if out.MaxScanTuples == 0 {
		out.MaxScanTuples = DefaultHNSWMaxScanTuples
	}
	if out.IterativeScan == "" {
		out.IterativeScan = IterativeScanRelaxedOrder
	}
	if out.RandomPageCost == 0 {
		out.RandomPageCost = DefaultANNRandomPageCost
	}
	if out.BranchTimeout == 0 {
		out.BranchTimeout = DefaultVectorBranchTimeout
	}
	if out.FallbackMinBudget == 0 {
		out.FallbackMinBudget = DefaultVectorFallbackMinBudget
	}
	if out.Now == nil {
		out.Now = time.Now
	}

	if out.ExactMaxVectors < 0 || out.ExactMaxVectors > MaxExactCapVectors {
		return VectorSearchKnobs{}, fmt.Errorf("%w: ExactMaxVectors out of range", ErrInvalidKnobs)
	}
	if out.FallbackMaxVectors < out.ExactMaxVectors || out.FallbackMaxVectors > MaxExactCapVectors {
		return VectorSearchKnobs{}, fmt.Errorf("%w: FallbackMaxVectors must be in [ExactMaxVectors, %d]", ErrInvalidKnobs, MaxExactCapVectors)
	}
	if out.EfSearch < MinHNSWEfSearch || out.EfSearch > MaxHNSWEfSearch {
		return VectorSearchKnobs{}, fmt.Errorf("%w: EfSearch out of range", ErrInvalidKnobs)
	}
	if out.MaxScanTuples < MinHNSWMaxScanTuples || out.MaxScanTuples > MaxHNSWMaxScanTuples {
		return VectorSearchKnobs{}, fmt.Errorf("%w: MaxScanTuples out of range", ErrInvalidKnobs)
	}
	switch out.IterativeScan {
	case IterativeScanOff, IterativeScanRelaxedOrder, IterativeScanStrictOrder:
	default:
		return VectorSearchKnobs{}, fmt.Errorf("%w: invalid IterativeScan mode", ErrInvalidKnobs)
	}
	if _, err := FormatANNRandomPageCostSQL(out.RandomPageCost); err != nil {
		return VectorSearchKnobs{}, err
	}
	if out.BranchTimeout < MinVectorTimeout || out.BranchTimeout > MaxVectorTimeout {
		return VectorSearchKnobs{}, fmt.Errorf("%w: BranchTimeout out of range", ErrInvalidKnobs)
	}
	if out.FallbackMinBudget < MinVectorTimeout || out.FallbackMinBudget > out.BranchTimeout {
		return VectorSearchKnobs{}, fmt.Errorf("%w: FallbackMinBudget out of range", ErrInvalidKnobs)
	}
	return out, nil
}

// Hit represents a single live vector search candidate returned by VectorSearch
// (plan P05 mục 2.16, 2.19; SPEC §6.3, §6.4).
//
// Cos (= 1 - cosine_distance) is used by internal/semantic only to order the
// near zone (Cos DESC, LastUsedAt DESC, Count DESC, ID ASC) and is never
// exposed on the wire.
type Hit struct {
	ID         uuid.UUID
	Cos        float64
	Dist       float64
	Name       string    // item.name when corpus == CorpusItem
	Display    string    // tag.display when corpus == CorpusTag
	Count      int       // item.entry_count or tag.item_count
	LastUsedAt time.Time // item.last_used_at or tag.last_used_at
	CreatedAt  time.Time // item.created_at or tag.created_at
}

// PathStats records telemetry and diagnostic counters for a single VectorSearch
// call (plan P05 mục 2.16, 2.21, 2.23).
type PathStats struct {
	Corpus        generation.Corpus
	Path          VectorPath
	CappedCount   int  // Result of the single capped count query (<= FallbackMaxVectors + 1)
	ANNCandidates int  // Candidates returned by the HNSW CTE before live/min_cos filtering
	Returned      int  // Final hits returned after live join and min_cos filtering
	Underfill     bool // True when ANN candidates before threshold filter < k
	FallbackUsed  bool // True when exact fallback executed
	TimedOut      bool // True when statement_timeout or deadline expired mid-branch
}

// VectorSearch executes a tenant-scoped vector query for (userID, corpus) on
// the request-pinned generation (plan P05 mục 2.16, Task 14; SPEC §6.3, §6.4).
//
// Contract summary:
//   - Pre-SQL validation: verifies db != nil, corpus ∈ {item, tag}, k > 0,
//     validated table name via pin.TableIdent(corpus), validated knobs, and
//     len(qvec) == pin.Identity.Dims (returns ErrDimsMismatch before any SQL).
//   - Single capped count (BE-2): runs
//     `SELECT count(*) FROM (SELECT 1 FROM <tbl> WHERE user_id = $1 LIMIT $2) s`
//     with $2 = FallbackMaxVectors + 1, and compares that single count against
//     both ExactMaxVectors and FallbackMaxVectors. No count cache.
//   - Exact path (count <= ExactMaxVectors): runs exact search using a
//     MATERIALIZED CTE over PK (user_id, target_id) to block the planner from
//     choosing HNSW, joins live item/tag (deleted_at IS NULL), filters
//     1 - (e.embedding <=> $2) >= pin.MinCos, and orders by dist ASC, id ASC
//     LIMIT k.
//   - ANN path (count > ExactMaxVectors): runs in a single read-only tx with a
//     single pgx.Batch issuing SET LOCAL hnsw.iterative_scan, hnsw.ef_search,
//     hnsw.max_scan_tuples, statement_timeout, and the HNSW MATERIALIZED CTE
//     query, then re-sorts hits by (dist ASC, id ASC).
//   - Underfill: if ANN candidates before threshold filter < k AND remaining
//     budget >= FallbackMinBudget AND count <= FallbackMaxVectors, runs exact
//     within the remaining budget (path "ann_fallback_exact"); otherwise
//     returns the ANN hits (path "ann_short", incrementing
//     search_vector_underfill_total{corpus}). A whale tenant (count ==
//     FallbackMaxVectors + 1) never takes the exact fallback.
//   - Deadlines: respects ctx and deadline. A branch deadline / SQL statement
//     timeout returns partial results + stats (TimedOut=true, err=nil), whereas
//     caller-initiated context.Canceled is returned as context.Canceled.
func VectorSearch(
	ctx context.Context,
	db VectorQueryDB,
	pin generation.Pin,
	userID uuid.UUID,
	corpus generation.Corpus,
	qvec []float32,
	k int,
	deadline time.Time,
	knobs VectorSearchKnobs,
) ([]Hit, PathStats, error) {
	stats := PathStats{Corpus: corpus}

	if db == nil {
		return nil, stats, ErrNilDB
	}
	if !corpus.Valid() {
		return nil, stats, generation.ErrInvalidCorpus
	}
	if k <= 0 {
		return nil, stats, ErrInvalidK
	}
	if err := validateVectorDims(qvec, pin.Identity.Dims); err != nil {
		return nil, stats, err
	}
	ident, err := pin.TableIdent(corpus)
	if err != nil {
		return nil, stats, err
	}
	tbl := ident.Sanitize()

	cfg, err := knobs.withDefaultsAndValidate()
	if err != nil {
		return nil, stats, err
	}

	if err := ctx.Err(); err != nil {
		if errors.Is(err, context.Canceled) {
			return nil, stats, context.Canceled
		}
		stats.TimedOut = true
		return []Hit{}, stats, nil
	}
	// Always derive the real context deadline from the wall clock sampled at call
	// time so context.WithDeadline never receives a fixed/fake timestamp (VQ-1).
	// Elapsed budget accounting uses cfg.Now() relative to the initial sample so
	// tests can deterministically advance elapsed time without wall-clock dependence.
	realStart := time.Now()
	clockStart := cfg.Now()
	realDeadline := resolveEffectiveDeadline(ctx, realStart, deadline, cfg.BranchTimeout)
	initialBudget := realDeadline.Sub(realStart)
	if initialBudget <= 0 {
		stats.TimedOut = true
		return []Hit{}, stats, nil
	}
	remainingBudget := func() time.Duration {
		return initialBudget - cfg.Now().Sub(clockStart)
	}

	branchCtx, cancel := context.WithDeadline(ctx, realDeadline)
	defer cancel()

	// Step 1: One capped count query per call (plan mục 2.16, BE-2).
	countCap := cfg.FallbackMaxVectors + 1
	count, err := CappedVectorCount(branchCtx, db, tbl, userID, countCap)
	if err != nil {
		if isCallerCanceled(ctx, err) {
			return nil, stats, context.Canceled
		}
		if isTimeoutOrDeadline(branchCtx, err) {
			stats.TimedOut = true
			return []Hit{}, stats, nil
		}
		return nil, stats, err
	}
	stats.CappedCount = count

	qvecParam := pgvector.NewVector(qvec)

	// Step 2: Compare the same capped count against ExactMaxVectors.
	// Note: when ExactMaxVectors == 0 (benchmark force-ANN), count >= 0 means
	// count <= 0 is only true when the tenant has 0 vectors; any tenant with
	// >= 1 vector goes to ANN while still honouring FallbackMaxVectors. When
	// ExactMaxVectors == 0, even 0 vectors should take the ANN path per
	// "SEARCH_EXACT_MAX_VECTORS=0 = always ANN".
	useExact := cfg.ExactMaxVectors > 0 && count <= cfg.ExactMaxVectors
	if useExact {
		stats.Path = VectorPathExact
		rem := remainingBudget()
		if rem <= 0 {
			stats.TimedOut = true
			recordVectorMetrics(cfg.Metrics, corpus, stats.Path, false)
			return []Hit{}, stats, nil
		}
		hits, err := runExactSearchWithTimeout(branchCtx, db, tbl, corpus, userID, qvecParam, pin.MinCos, k, rem)
		if err != nil {
			if isCallerCanceled(ctx, err) {
				return nil, stats, context.Canceled
			}
			if isTimeoutOrDeadline(branchCtx, err) {
				if hits == nil {
					hits = []Hit{}
				}
				ResortHitsByDistAndID(hits)
				stats.Returned = len(hits)
				stats.TimedOut = true
				recordVectorMetrics(cfg.Metrics, corpus, stats.Path, false)
				return hits, stats, nil
			}
			return nil, stats, err
		}
		stats.Returned = len(hits)
		recordVectorMetrics(cfg.Metrics, corpus, stats.Path, false)
		return hits, stats, nil
	}

	// Step 3: ANN path (count > ExactMaxVectors, or ExactMaxVectors == 0).
	rem := remainingBudget()
	if rem <= 0 {
		stats.Path = VectorPathANNShort
		stats.Underfill = true
		stats.TimedOut = true
		recordVectorMetrics(cfg.Metrics, corpus, stats.Path, true)
		return []Hit{}, stats, nil
	}

	annHits, annCandidates, err := runANNSearchTx(branchCtx, db, tbl, corpus, userID, qvecParam, pin.MinCos, k, rem, cfg)
	if err != nil {
		if isCallerCanceled(ctx, err) {
			return nil, stats, context.Canceled
		}
		if isTimeoutOrDeadline(branchCtx, err) {
			if annHits == nil {
				annHits = []Hit{}
			}
			ResortHitsByDistAndID(annHits)
			stats.ANNCandidates = annCandidates
			stats.Returned = len(annHits)
			stats.TimedOut = true
			if annCandidates >= k {
				stats.Path = VectorPathANN
				recordVectorMetrics(cfg.Metrics, corpus, stats.Path, false)
			} else {
				stats.Path = VectorPathANNShort
				stats.Underfill = true
				recordVectorMetrics(cfg.Metrics, corpus, stats.Path, true)
			}
			return annHits, stats, nil
		}
		return nil, stats, err
	}

	stats.ANNCandidates = annCandidates
	stats.Returned = len(annHits)

	if cfg.AfterANN != nil {
		cfg.AfterANN()
	}

	// Step 4: Check underfill BEFORE threshold filter (plan mục 2.16:
	// "candidates before threshold filter < K").
	if annCandidates >= k {
		stats.Path = VectorPathANN
		recordVectorMetrics(cfg.Metrics, corpus, stats.Path, false)
		return annHits, stats, nil
	}

	// Underfill detected (annCandidates < k).
	stats.Underfill = true
	remAfterANN := remainingBudget()

	// Exact fallback condition:
	//   1) annCandidates < k (already true)
	//   2) remaining budget >= FallbackMinBudget
	//   3) count <= FallbackMaxVectors (whale has count == FallbackMaxVectors + 1, so never falls back)
	if remAfterANN >= cfg.FallbackMinBudget && count <= cfg.FallbackMaxVectors {
		exactHits, fErr := runExactSearchWithTimeout(branchCtx, db, tbl, corpus, userID, qvecParam, pin.MinCos, k, remAfterANN)
		if fErr != nil {
			if isCallerCanceled(ctx, fErr) {
				return nil, stats, context.Canceled
			}
			if isTimeoutOrDeadline(branchCtx, fErr) {
				// Fallback timed out: if exact fallback already yielded more
				// validated hits than the partial ANN pass, prefer them;
				// otherwise keep the partial ANN hits already gathered.
				bestHits := annHits
				if len(exactHits) > len(annHits) {
					ResortHitsByDistAndID(exactHits)
					bestHits = exactHits
				}
				stats.Path = VectorPathANNShort
				stats.Returned = len(bestHits)
				stats.TimedOut = true
				recordVectorMetrics(cfg.Metrics, corpus, stats.Path, true)
				return bestHits, stats, nil
			}
			return nil, stats, fErr
		}
		stats.Path = VectorPathANNFallbackExact
		stats.FallbackUsed = true
		stats.Returned = len(exactHits)
		// Note: when exact fallback succeeds, path is ann_fallback_exact.
		// Underfill before fallback happened, but fallback resolved it; per
		// T14 contract ("otherwise return what you have (path ann_short if under K,
		// increment VectorUnderfillTotal)"), VectorUnderfillTotal tracks
		// unrecovered underfill (ann_short).
		recordVectorMetrics(cfg.Metrics, corpus, stats.Path, false)
		return exactHits, stats, nil
	}

	// Cannot fall back to exact (either whale count > FallbackMaxVectors or
	// remaining budget < FallbackMinBudget): return partial ANN hits with
	// path "ann_short" and increment VectorUnderfillTotal.
	stats.Path = VectorPathANNShort
	if remAfterANN < cfg.FallbackMinBudget {
		stats.TimedOut = remAfterANN <= 0
	}
	recordVectorMetrics(cfg.Metrics, corpus, stats.Path, true)
	return annHits, stats, nil
}

// CappedVectorCount executes the single capped count query per VectorSearch
// call:
//
//	SELECT count(*) FROM (SELECT 1 FROM <tbl> WHERE user_id = $1 LIMIT $2) s
//
// where $2 = FallbackMaxVectors + 1 (plan P05 mục 2.16, BE-2).
// tbl MUST be a pgx.Identifier.Sanitize()-quoted table name from Pin.TableIdent.
func CappedVectorCount(
	ctx context.Context,
	q gen.DBTX,
	tbl string,
	userID uuid.UUID,
	limit int,
) (int, error) {
	// #nosec G202 -- tbl is validated against allowlist ^(item|tag)_embedding_g[1-9][0-9]{0,3}$ and quoted via pgx.Identifier.Sanitize().
	query := `SELECT count(*)::int FROM (SELECT 1 FROM ` + tbl + ` WHERE user_id = $1 LIMIT $2) s`
	var cnt int
	if err := q.QueryRow(ctx, query, userID, limit).Scan(&cnt); err != nil {
		return 0, fmt.Errorf("store: capped vector count query failed: %w", sanitizeQueryErr(err))
	}
	return cnt, nil
}

func resolveEffectiveDeadline(ctx context.Context, now, callerDeadline time.Time, branchTimeout time.Duration) time.Time {
	d := now.Add(branchTimeout)
	if !callerDeadline.IsZero() && callerDeadline.Before(d) {
		d = callerDeadline
	}
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(d) {
		d = ctxDeadline
	}
	return d
}

func formatStatementTimeoutMS(budget time.Duration) string {
	ms := budget.Milliseconds()
	if ms < 1 {
		ms = 1
	}
	if ms > MaxVectorTimeout.Milliseconds() {
		ms = MaxVectorTimeout.Milliseconds()
	}
	return strconv.FormatInt(ms, 10) + "ms"
}

func isCallerCanceled(callerCtx context.Context, err error) bool {
	if errors.Is(callerCtx.Err(), context.Canceled) {
		return true
	}
	return errors.Is(err, context.Canceled) && !errors.Is(callerCtx.Err(), context.DeadlineExceeded)
}

// isTimeoutOrDeadline classifies err as a branch timeout (partial results, nil
// error) or not (the error is returned to the caller). Order matters:
//
//  1. A genuine context.DeadlineExceeded is a timeout.
//  2. An explicit *pgconn.PgError is classified by its SQLSTATE only: 57014
//     (query_canceled / statement_timeout) is a timeout; every other code stays
//     an error even when the branch deadline has already expired, so an
//     unrelated SQL failure is never turned into a silent TimedOut success.
//  3. Only otherwise-unclassified (transport-style) errors fall back to the
//     branch context: an expired branch deadline means the failure is most
//     likely the deadline tearing the connection down.
//
// Caller cancellation is handled earlier by isCallerCanceled and stays an error.
func isTimeoutOrDeadline(branchCtx context.Context, err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		// 57014 = query_canceled (statement_timeout)
		return pgErr.Code == "57014"
	}
	return errors.Is(branchCtx.Err(), context.DeadlineExceeded)
}

func recordVectorMetrics(m *obs.SearchMetrics, corpus generation.Corpus, path VectorPath, underfillShort bool) {
	if m == nil {
		return
	}
	c := string(corpus)
	if m.VectorPathTotal != nil && path != "" {
		m.VectorPathTotal.WithLabelValues(c, string(path)).Inc()
	}
	if underfillShort && m.VectorUnderfillTotal != nil {
		m.VectorUnderfillTotal.WithLabelValues(c).Inc()
	}
}

// sanitizeQueryErr preserves context errors and *pgconn.PgError codes for
// timeout/cancellation classification without propagating row values.
func sanitizeQueryErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return &pgconn.PgError{
			Code:    pgErr.Code,
			Message: "database error",
		}
	}
	return errors.New("database query failed")
}
