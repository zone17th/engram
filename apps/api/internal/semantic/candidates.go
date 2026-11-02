package semantic

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// Candidate represents a single semantic vector candidate (item or tag) prior
// to AppendZone deduplication and clipping (plan P05 mục 2.19, Task 12; SPEC §6.4).
//
// Security invariant: never contains item.hint or entry content. Cos is used
// only for in-memory sorting and is stripped before wire serialization.
type Candidate struct {
	Kind       string // "item" or "tag"
	ID         uuid.UUID
	Cos        float64
	Name       string    // item name (when Kind == "item")
	Display    string    // tag display (when Kind == "tag")
	Count      int32     // entry_count (item) or item_count (tag)
	LastUsedAt time.Time // UTC
	CreatedAt  time.Time // UTC (for items)
	Tags       []TagRef  // up to 3 live TagRefs (for items)
	TagTotal   int32     // total live tag count (for items)
}

// CandidatesResult holds the output of Runtime.Candidates.
type CandidatesResult struct {
	Items    []Candidate
	Tags     []Candidate
	Degraded bool
	Reason   string
}

type branchResult struct {
	hits  []VectorHit
	stats VectorPathStats
	err   error
}

// Candidates executes the semantic query pipeline using the single Pin already
// resolved in decision (plan P05 mục 2.15, 2.18, 2.19, 2.21, Task 12; BE-1, BE-13):
//
//  1. Never re-reads the active generation; uses decision.Pin throughout.
//  2. Looks up (userID, decision.Pin.GenID, qn) in the query-vector cache and
//     increments semantic_query_cache_total{hit|miss}.
//  3. On cache miss:
//     - Matches decision.Pin.Identity against ClientSet.Match(pin.Identity)
//     (full 7-field Key()). If no client matches -> Degraded=true,
//     Reason="degraded", embedding_generation_mismatch_total{reason="unconfigured"},
//     0 provider calls.
//     - Acquires the API circuit breaker for the matched provider. If open ->
//     Degraded=true, Reason="degraded", 0 provider calls.
//     - Calls client.Provider.EmbedQuery(ctx, qn) and passes the error to
//     finish(err) exactly once (caller context.Canceled does not open the breaker).
//     - Validates len(qvec) == decision.Pin.Identity.Dims before caching or DB
//     queries; mismatch -> Degraded=true, Reason="degraded",
//     embedding_generation_mismatch_total{reason="dims"}, log error_class="dims_mismatch".
//     - Stores qvec in the query cache.
//  4. Runs VectorSearch in parallel for the requested corpora ("all" -> item + tag;
//     "item" -> item only; "tag" -> tag only), each with its own context bounded
//     by SEARCH_VECTOR_BRANCH_TIMEOUT (default 80 ms).
//  5. Any SQL branch timeout or vector search error degrades this request
//     (Degraded=true, Reason="degraded") WITHOUT touching or opening the API
//     circuit breaker.
func (r *Runtime) Candidates(
	ctx context.Context,
	userID uuid.UUID,
	decision Decision,
	qn string,
	scope string,
) (CandidatesResult, error) {
	if !decision.Effective {
		reason := decision.Reason
		if reason == "" {
			reason = suggest.ReasonDisabledServer
		}
		return CandidatesResult{
			Degraded: reason == suggest.ReasonDegraded,
			Reason:   reason,
		}, nil
	}

	if r == nil {
		return CandidatesResult{
			Degraded: false,
			Reason:   suggest.ReasonDisabledServer,
		}, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}

	pin := decision.Pin
	if pin.GenID <= 0 || pin.Identity.Dims <= 0 {
		return CandidatesResult{
			Degraded: false,
			Reason:   suggest.ReasonDisabledServer,
		}, nil
	}

	var (
		qvec     []float32
		cacheHit bool
	)
	if cache := r.Cache(); cache != nil {
		if cachedVec, ok := cache.Get(userID, pin.GenID, qn); ok {
			qvec = cachedVec
			cacheHit = true
		}
	}

	if cacheHit {
		r.recordCacheMetric(CacheResultHit)
	} else {
		r.recordCacheMetric(CacheResultMiss)

		if r.clients == nil {
			r.incGenerationMismatch(MismatchReasonUnconfigured)
			logSafeError(ctx, r.logger, "semantic client set unconfigured", "generation_unconfigured")
			return CandidatesResult{
				Degraded: true,
				Reason:   suggest.ReasonDegraded,
			}, nil
		}

		client, ok := r.clients.Match(pin.Identity)
		if !ok || client.Provider == nil {
			r.incGenerationMismatch(MismatchReasonUnconfigured)
			logSafeError(ctx, r.logger, "semantic active generation unconfigured", "generation_unconfigured")
			return CandidatesResult{
				Degraded: true,
				Reason:   suggest.ReasonDegraded,
			}, nil
		}

		breaker := r.BreakerForProvider(pin.Identity.Provider)
		var finish func(error)
		if breaker != nil {
			admitted, _, fin := breaker.Acquire()
			if !admitted {
				return CandidatesResult{
					Degraded: true,
					Reason:   suggest.ReasonDegraded,
				}, nil
			}
			finish = fin
		} else {
			finish = func(error) {}
		}

		vec, embedErr := client.Provider.EmbedQuery(ctx, qn)
		if embedErr != nil {
			if isCallerCanceled(ctx, embedErr) {
				finish(context.Canceled)
				return CandidatesResult{}, context.Canceled
			}
			finish(embedErr)
			return CandidatesResult{
				Degraded: true,
				Reason:   suggest.ReasonDegraded,
			}, nil
		}

		if len(vec) != pin.Identity.Dims {
			// Bad vector dimensions from provider: record as bad_response on breaker
			// and increment generation mismatch {reason="dims"}.
			finish(ErrDimsMismatch)
			r.incGenerationMismatch(MismatchReasonDims)
			logSafeError(ctx, r.logger, "semantic query vector dims mismatch", "dims_mismatch")
			return CandidatesResult{
				Degraded: true,
				Reason:   suggest.ReasonDegraded,
			}, nil
		}

		finish(nil)
		qvec = vec
		if cache := r.Cache(); cache != nil {
			cache.Put(userID, pin.GenID, qn, qvec)
		}
	}

	if len(qvec) != pin.Identity.Dims {
		r.incGenerationMismatch(MismatchReasonDims)
		logSafeError(ctx, r.logger, "semantic cached vector dims mismatch", "dims_mismatch")
		return CandidatesResult{
			Degraded: true,
			Reason:   suggest.ReasonDegraded,
		}, nil
	}

	if r.searcher == nil {
		return CandidatesResult{
			Items: []Candidate{},
			Tags:  []Candidate{},
		}, nil
	}

	runItems := scope == "" || scope == suggest.ScopeAll || scope == suggest.ScopeItem
	runTags := scope == "" || scope == suggest.ScopeAll || scope == suggest.ScopeTag

	branchTimeout := r.knobs.VectorBranchTimeout
	if branchTimeout <= 0 {
		branchTimeout = DefaultVectorBranchTimeout
	}

	var (
		wg      sync.WaitGroup
		itemRes branchResult
		tagRes  branchResult
	)

	if runItems {
		wg.Add(1)
		go func() {
			defer wg.Done()
			itemRes = r.runVectorBranch(ctx, pin, userID, generation.CorpusItem, qvec, branchTimeout)
		}()
	}

	if runTags {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tagRes = r.runVectorBranch(ctx, pin, userID, generation.CorpusTag, qvec, branchTimeout)
		}()
	}

	wg.Wait()

	// Caller cancellation propagates without degrading or opening the breaker.
	if isCallerCanceled(ctx, itemRes.err) || isCallerCanceled(ctx, tagRes.err) {
		return CandidatesResult{}, context.Canceled
	}

	if errors.Is(itemRes.err, ErrDimsMismatch) || errors.Is(tagRes.err, ErrDimsMismatch) {
		r.incGenerationMismatch(MismatchReasonDims)
		logSafeError(ctx, r.logger, "semantic vector search dims mismatch", "dims_mismatch")
		return CandidatesResult{
			Degraded: true,
			Reason:   suggest.ReasonDegraded,
		}, nil
	}

	// SQL branch timeout or vector query failure degrades this request only
	// and never touches the provider circuit breaker (plan P05 mục 2.19,
	// TestSQLTimeoutDegradesWithoutOpeningBreaker).
	if itemRes.stats.TimedOut || tagRes.stats.TimedOut || itemRes.err != nil || tagRes.err != nil {
		return CandidatesResult{
			Degraded: true,
			Reason:   suggest.ReasonDegraded,
		}, nil
	}

	items := make([]Candidate, 0, len(itemRes.hits))
	for _, h := range itemRes.hits {
		items = append(items, Candidate{
			Kind:       suggest.CorpusItem,
			ID:         h.ID,
			Cos:        h.Cos,
			Name:       h.Name,
			Count:      h.Count,
			LastUsedAt: h.LastUsedAt.UTC(),
			CreatedAt:  h.CreatedAt.UTC(),
			Tags:       []TagRef{},
			TagTotal:   0,
		})
	}

	if len(items) > 0 && r.tagLoader != nil {
		tagCtx, cancel := context.WithTimeout(ctx, branchTimeout)
		ids := make([]uuid.UUID, len(items))
		for i := range items {
			ids[i] = items[i].ID
		}
		refsByItem, err := r.tagLoader.LoadItemTagRefs(tagCtx, userID, ids)
		cancel()
		if err != nil {
			if isCallerCanceled(ctx, err) {
				return CandidatesResult{}, context.Canceled
			}
			return CandidatesResult{
				Degraded: true,
				Reason:   suggest.ReasonDegraded,
			}, nil
		}
		for i := range items {
			if summary, ok := refsByItem[items[i].ID]; ok {
				if len(summary.Tags) > 0 {
					items[i].Tags = summary.Tags
				}
				items[i].TagTotal = summary.TagTotal
			}
		}
	}

	tags := make([]Candidate, 0, len(tagRes.hits))
	for _, h := range tagRes.hits {
		tags = append(tags, Candidate{
			Kind:       suggest.CorpusTag,
			ID:         h.ID,
			Cos:        h.Cos,
			Display:    h.Display,
			Count:      h.Count,
			LastUsedAt: h.LastUsedAt.UTC(),
		})
	}

	return CandidatesResult{
		Items: items,
		Tags:  tags,
	}, nil
}

func (r *Runtime) runVectorBranch(
	parentCtx context.Context,
	pin generation.Pin,
	userID uuid.UUID,
	corpus generation.Corpus,
	qvec []float32,
	branchTimeout time.Duration,
) branchResult {
	deadline := r.clk.Now().Add(branchTimeout)
	branchCtx, cancel := context.WithTimeout(parentCtx, branchTimeout)
	defer cancel()

	hits, stats, err := r.searcher.VectorSearch(
		branchCtx,
		pin,
		userID,
		corpus,
		qvec,
		DefaultNearCandidateK,
		deadline,
		r.knobs,
	)
	if err != nil {
		if isCallerCanceled(parentCtx, err) {
			return branchResult{err: context.Canceled}
		}
		if isSQLOrBranchTimeout(err) {
			stats.TimedOut = true
			return branchResult{hits: hits, stats: stats}
		}
		return branchResult{hits: hits, stats: stats, err: err}
	}
	return branchResult{hits: hits, stats: stats}
}

func (r *Runtime) recordCacheMetric(result string) {
	if r == nil || r.metrics == nil || r.metrics.Search == nil || r.metrics.Search.SemanticQueryCacheTotal == nil {
		return
	}
	r.metrics.Search.SemanticQueryCacheTotal.WithLabelValues(result).Inc()
}
