package semantic

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

// DefaultVectorBranchTimeout is the default per-branch budget (80 ms) for item
// and tag vector queries (SPEC §6.4, plan P05 mục 2.13, 2.19).
const DefaultVectorBranchTimeout = 80 * time.Millisecond

// DefaultNearCandidateK is the number of top vector candidates requested per
// corpus branch (SPEC §6.3: LIMIT 20).
const DefaultNearCandidateK = 20

// ErrDimsMismatch is returned before any SQL execution when len(qvec) does not
// match the pinned generation's Identity.Dims (plan P05 mục 2.15, 2.16).
var ErrDimsMismatch = errors.New("semantic: query vector dimensions do not match pinned generation")

// VectorPath identifies the execution path taken by VectorSearcher (aligned
// with Task 14 store.VectorPath, plan P05 mục 2.16, 2.21).
type VectorPath = store.VectorPath

const (
	VectorPathExact            VectorPath = store.VectorPathExact
	VectorPathANN              VectorPath = store.VectorPathANN
	VectorPathANNFallbackExact VectorPath = store.VectorPathANNFallbackExact
	VectorPathANNShort         VectorPath = store.VectorPathANNShort
)

// VectorSearchKnobs holds the query-time vector search parameters and optional
// metrics/clock dependencies passed to VectorSearcher (aligned with Task 14
// store.VectorSearchKnobs, plan P05 mục 2.13, 2.16, 2.21; RV-T12-BE-6).
type VectorSearchKnobs struct {
	ExactMaxVectors    int
	FallbackMaxVectors int
	EfSearch           int
	MaxScanTuples      int
	IterativeScan      string
	BranchTimeout      time.Duration
	FallbackMinBudget  time.Duration
	Metrics            *obs.SearchMetrics
	Now                func() time.Time
}

// DefaultVectorSearchKnobs returns the default query-time vector search knobs
// matching store.DefaultVectorSearchKnobs().
func DefaultVectorSearchKnobs() VectorSearchKnobs {
	d := store.DefaultVectorSearchKnobs()
	return VectorSearchKnobs{
		ExactMaxVectors:    d.ExactMaxVectors,
		FallbackMaxVectors: d.FallbackMaxVectors,
		EfSearch:           d.EfSearch,
		MaxScanTuples:      d.MaxScanTuples,
		IterativeScan:      d.IterativeScan,
		BranchTimeout:      d.BranchTimeout,
		FallbackMinBudget:  d.FallbackMinBudget,
	}
}

// VectorHit represents a single candidate returned by VectorSearcher (aligned
// with Task 14 store.Hit, plan P05 mục 2.16, 2.19; RV-T12-BE-6).
//
// Security invariant (user-dec-016): never includes item.hint or entry content.
// Cos is used only in-memory by AppendZone to order the near zone and is never
// serialized to the wire.
type VectorHit struct {
	ID         uuid.UUID
	Cos        float64
	Dist       float64
	Name       string    // populated when corpus == generation.CorpusItem
	Display    string    // populated when corpus == generation.CorpusTag
	Count      int       // entry_count (item) or item_count (tag)
	LastUsedAt time.Time // UTC
	CreatedAt  time.Time // UTC (populated for items)
}

// VectorPathStats records the execution path and timeout outcome of a single
// corpus vector search branch (aligned with Task 14 store.PathStats; RV-T12-BE-6).
type VectorPathStats struct {
	Corpus        generation.Corpus
	Path          VectorPath // "exact" | "ann" | "ann_fallback_exact" | "ann_short"
	CappedCount   int
	ANNCandidates int
	Returned      int
	Underfill     bool
	FallbackUsed  bool
	TimedOut      bool
}

// VectorSearcher abstracts the per-corpus vector search execution for unit spies
// while production uses StoreVectorSearcher backed by Task 14 store.VectorSearch
// (plan P05 mục 2.16, 2.19, Task 12 / Task 14 seam; dec-293, RV-T12-BE-6).
//
// Contract & adapter conversions (StoreVectorSearcher -> store.VectorSearch):
//   - Forwards VectorSearchKnobs (ExactMaxVectors, FallbackMaxVectors, EfSearch,
//     MaxScanTuples, IterativeScan, BranchTimeout, FallbackMinBudget) plus
//     obs.Metrics.Search and the runtime clock (Now) into store.VectorSearchKnobs.
//   - Normalizes store.ErrDimsMismatch to semantic.ErrDimsMismatch before any SQL
//     when len(qvec) != pin.Identity.Dims so Candidates records
//     embedding_generation_mismatch_total{reason="dims"} and degrades.
//   - Maps SQL statement_timeout (57014) or branch deadline expiry (PathStats.TimedOut
//     with partial hits and err == nil) to request-local degraded in Candidates
//     without touching the provider circuit breaker.
//   - Propagates caller context.Canceled as context.Canceled.
type VectorSearcher interface {
	VectorSearch(
		ctx context.Context,
		pin generation.Pin,
		userID uuid.UUID,
		corpus generation.Corpus,
		qvec []float32,
		k int,
		deadline time.Time,
		knobs VectorSearchKnobs,
	) ([]VectorHit, VectorPathStats, error)
}

// StoreVectorSearcher adapts Task 14 store.VectorSearch to VectorSearcher.
type StoreVectorSearcher struct {
	db store.VectorQueryDB
}

// NewStoreVectorSearcher constructs a VectorSearcher backed by store.VectorSearch
// over db (typically *pgxpool.Pool).
func NewStoreVectorSearcher(db store.VectorQueryDB) *StoreVectorSearcher {
	return &StoreVectorSearcher{db: db}
}

// VectorSearch delegates to store.VectorSearch, forwarding knobs, metrics, and
// clock, and converting store.Hit / store.PathStats / store.ErrDimsMismatch.
func (s *StoreVectorSearcher) VectorSearch(
	ctx context.Context,
	pin generation.Pin,
	userID uuid.UUID,
	corpus generation.Corpus,
	qvec []float32,
	k int,
	deadline time.Time,
	knobs VectorSearchKnobs,
) ([]VectorHit, VectorPathStats, error) {
	if pin.Identity.Dims <= 0 || len(qvec) != pin.Identity.Dims {
		return nil, VectorPathStats{Corpus: corpus}, ErrDimsMismatch
	}
	if s == nil || s.db == nil {
		return nil, VectorPathStats{Corpus: corpus, Path: VectorPathExact}, nil
	}
	if k <= 0 {
		k = DefaultNearCandidateK
	}

	storeKnobs := store.DefaultVectorSearchKnobs()
	storeKnobs.ExactMaxVectors = knobs.ExactMaxVectors
	storeKnobs.FallbackMaxVectors = knobs.FallbackMaxVectors
	if knobs.EfSearch > 0 {
		storeKnobs.EfSearch = knobs.EfSearch
	}
	if knobs.MaxScanTuples > 0 {
		storeKnobs.MaxScanTuples = knobs.MaxScanTuples
	}
	if knobs.IterativeScan != "" {
		storeKnobs.IterativeScan = knobs.IterativeScan
	}
	if knobs.BranchTimeout > 0 {
		storeKnobs.BranchTimeout = knobs.BranchTimeout
	}
	if knobs.FallbackMinBudget > 0 {
		storeKnobs.FallbackMinBudget = knobs.FallbackMinBudget
	}
	if storeKnobs.FallbackMinBudget > storeKnobs.BranchTimeout {
		storeKnobs.FallbackMinBudget = storeKnobs.BranchTimeout
	}
	storeKnobs.Metrics = knobs.Metrics
	storeKnobs.Now = knobs.Now

	hits, st, err := store.VectorSearch(ctx, s.db, pin, userID, corpus, qvec, k, deadline, storeKnobs)
	outStats := VectorPathStats{
		Corpus:        st.Corpus,
		Path:          st.Path,
		CappedCount:   st.CappedCount,
		ANNCandidates: st.ANNCandidates,
		Returned:      st.Returned,
		Underfill:     st.Underfill,
		FallbackUsed:  st.FallbackUsed,
		TimedOut:      st.TimedOut,
	}
	outHits := make([]VectorHit, len(hits))
	for i, h := range hits {
		outHits[i] = VectorHit{
			ID:         h.ID,
			Cos:        h.Cos,
			Dist:       h.Dist,
			Name:       h.Name,
			Display:    h.Display,
			Count:      h.Count,
			LastUsedAt: h.LastUsedAt.UTC(),
			CreatedAt:  h.CreatedAt.UTC(),
		}
	}
	if err != nil {
		if errors.Is(err, store.ErrDimsMismatch) {
			return nil, outStats, ErrDimsMismatch
		}
		return outHits, outStats, err
	}
	return outHits, outStats, nil
}

func isCallerCanceled(parentCtx context.Context, err error) bool {
	if parentCtx != nil && errors.Is(parentCtx.Err(), context.Canceled) {
		return true
	}
	return errors.Is(err, context.Canceled) && (parentCtx == nil || !errors.Is(parentCtx.Err(), context.DeadlineExceeded))
}

func isSQLOrBranchTimeout(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr != nil {
		// 57014 = query_canceled (PostgreSQL statement_timeout).
		if pgErr.Code == "57014" {
			return true
		}
	}
	return false
}

// ItemTagRefLoader loads up to 3 live TagRefs and tag_total per item ID for a
// user so semantic item rows have the exact same tags/tag_total shape as
// lexical item rows (plan P05 mục 2.3, 2.5, Task 12).
type ItemTagRefLoader interface {
	LoadItemTagRefs(ctx context.Context, userID uuid.UUID, itemIDs []uuid.UUID) (map[uuid.UUID]ItemTagSummary, error)
}

// NewDBItemTagRefLoader constructs an ItemTagRefLoader backed by db.
func NewDBItemTagRefLoader(db gen.DBTX) ItemTagRefLoader {
	return &dbItemTagRefLoader{db: db}
}

// ItemTagSummary holds the up-to-3 TagRefs and total tag count for an item.
type ItemTagSummary struct {
	Tags     []TagRef
	TagTotal int32
}

// TagRef mirrors suggest.TagRef (`{id, display}`).
type TagRef struct {
	ID      uuid.UUID
	Display string
}

type dbItemTagRefLoader struct {
	db gen.DBTX
}

func (l *dbItemTagRefLoader) LoadItemTagRefs(ctx context.Context, userID uuid.UUID, itemIDs []uuid.UUID) (map[uuid.UUID]ItemTagSummary, error) {
	if l == nil || l.db == nil || len(itemIDs) == 0 {
		return nil, nil
	}
	rows, err := gen.New(l.db).ListTagRefsForItems(ctx, gen.ListTagRefsForItemsParams{
		UserID:  userID,
		ItemIds: itemIDs,
	})
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]ItemTagSummary, len(itemIDs))
	for _, r := range rows {
		cur := out[r.ItemID]
		if len(cur.Tags) < 3 {
			cur.Tags = append(cur.Tags, TagRef{
				ID:      r.TagID,
				Display: r.Display,
			})
		}
		cur.TagTotal = r.TagTotal
		out[r.ItemID] = cur
	}
	return out, nil
}
