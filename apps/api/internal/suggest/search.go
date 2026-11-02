package suggest

import (
	"context"
	"errors"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/item"
)

// ErrSearchInternal maps a failed active-generation lookup or a primary paged-corpus
// branch timeout on `/search` to HTTP 500 `internal_error` with a static problem
// detail (advisor-dec-287). Service.Search returns it wrapped in an *InternalError whose Class
// tells the two causes apart; errors.Is(err, ErrSearchInternal) holds for both.
var ErrSearchInternal = errors.New("suggest: search internal error")

// SearchInput holds the validated query parameters for `GET /api/v1/search`.
type SearchInput struct {
	UserID   uuid.UUID
	RawQ     string
	Scope    string
	Limit    int
	Cursor   string
	Semantic bool
}

// ParseSearchQuery implements plan P05 mục 2.2 normalization and mode resolution for `/search`
// (SPEC §6.2, §6.4, §9.2, OpenAPI `search`):
//   - Rejects invalid UTF-8, forbidden control/bidi characters, `q > 200` runes, or tag `> 50` runes -> `ErrNameInvalid` (400 `name_invalid`).
//   - Unlike `/suggest`, `GET /search` requires a non-empty normalized query:
//     empty/whitespace-only `q`, `#` alone, or punctuation-only (`"!!!"`, `textnorm.ErrEmptyQuery`) -> `ErrNameInvalid` (400 `name_invalid`).
//   - Leading `#` forces `scope = "tag"`, strips `#`, and normalizes the first token.
//   - Mode is always `"prefix"` (`len_runes(qn) < 2`) or `"full"` (`len_runes(qn) >= 2`), never `"recent"`.
func ParseSearchQuery(rawQ string, requestedScope string) (ParsedSuggestQuery, error) {
	parsed, err := ParseSuggestQuery(rawQ, requestedScope)
	if err != nil {
		return ParsedSuggestQuery{}, err
	}
	if parsed.Mode == ModeRecent || parsed.EmptyAfter || parsed.QN == "" {
		return ParsedSuggestQuery{}, ErrNameInvalid
	}
	return parsed, nil
}

// Search executes `GET /api/v1/search` (`operationId: search`, SPEC §6.2–§6.4, §6.8, §9.2, §10.3,
// plan P05 mục 2.2–2.5, BE-12, FU-SL-2, Task 4):
//   - Keyset paging by `scope` (`tier DESC, score DESC, last_used_at DESC, count DESC, id ASC`):
//   - `scope=item`: pages `items` via `SearchItemsLexicalPage` (`kind="item"`), `tags=[]`.
//   - `scope=tag`: pages `tags` (`limit` per page) via `SearchTagsLexicalPage` (`kind="tag"`), `items=[]`.
//   - `scope=all`: pages `items` via `SearchItemsLexicalPage` (`kind="item"`); on page 1 (no `cursor`),
//     also returns `tags` (<= 5) and `near` (<= 5 after deduplicating against lexical `tags` and `items`).
//     On cursor pages, `tags=[]`, `near=[]`, `semantic=false`, `semantic_reason="request_lexical"`,
//     `generation=null`; `NearSource.ActiveGeneration` validates `cursor.gen` before the page query and `NearSource.Near` is never called (advisor-dec-290).
//   - Branch timeout policy (advisor-dec-287): because `SearchResponse` has no `lexical_partial` field,
//     a 50 ms branch timeout (SQLSTATE 57014 or `context.DeadlineExceeded`) on the PRIMARY paged corpus
//     (`items` for `scope=item|all`, `tags` for `scope=tag`) increments `search_lexical_partial_total{corpus}`
//     and returns `ErrSearchInternal` (500 `internal_error` with a static problem detail), whereas a timeout
//     on the auxiliary page-1 `tags` branch of `scope=all` increments `search_lexical_partial_total{corpus="tag"}`
//     and degrades gracefully to `tags: []` with HTTP 200. `/search` does not observe `suggest_latency_seconds`.
func (s *Service) Search(ctx context.Context, in SearchInput) (SearchResponse, error) {
	if in.UserID == uuid.Nil {
		return SearchResponse{}, ErrInvalidRequest
	}
	limit := in.Limit
	if limit == 0 {
		limit = DefaultSearchLimit
	}
	if !ValidSearchLimit(limit) {
		return SearchResponse{}, ErrInvalidRequest
	}

	parsed, err := ParseSearchQuery(in.RawQ, in.Scope)
	if err != nil {
		return SearchResponse{}, err
	}

	hasCursor := in.Cursor != ""
	var (
		decodedCur SearchCursor
		curPtr     *SearchCursor
		activeGen  *int
	)
	if hasCursor {
		decodedCur, err = DecodeCursor(s.cursorKey, in.Cursor, parsed.Scope, parsed.QN)
		if err != nil {
			return SearchResponse{}, ErrInvalidRequest
		}
		activeGen, err = s.activeGeneration(ctx, in.UserID)
		if err != nil {
			return SearchResponse{}, generationLookupError(parsed)
		}
		if !equalCursorGen(decodedCur.Gen, activeGen) {
			return SearchResponse{}, ErrInvalidRequest
		}
		curPtr = &decodedCur
	} else {
		activeGen, err = s.activeGeneration(ctx, in.UserID)
		if err != nil {
			return SearchResponse{}, generationLookupError(parsed)
		}
	}
	var (
		items      []SuggestItem
		tags       []SuggestTag
		nextCurVal *SearchCursor
	)

	switch parsed.Scope {
	case ScopeItem:
		out := s.runSearchItemPageBranch(ctx, in.UserID, parsed.Mode, parsed.QN, curPtr, limit)
		if out.partial {
			return SearchResponse{}, s.searchPrimaryTimeout(ctx, CorpusItem, parsed)
		}
		if out.err != nil {
			return SearchResponse{}, out.err
		}
		items = out.items
		tags = []SuggestTag{}
		nextCurVal = out.nextCursor

	case ScopeTag:
		out := s.runSearchTagPageBranch(ctx, in.UserID, parsed.Mode, parsed.QN, curPtr, limit)
		if out.partial {
			return SearchResponse{}, s.searchPrimaryTimeout(ctx, CorpusTag, parsed)
		}
		if out.err != nil {
			return SearchResponse{}, out.err
		}
		items = []SuggestItem{}
		tags = out.tags
		nextCurVal = out.nextCursor

	case ScopeAll:
		if hasCursor {
			out := s.runSearchItemPageBranch(ctx, in.UserID, parsed.Mode, parsed.QN, curPtr, limit)
			if out.partial {
				return SearchResponse{}, s.searchPrimaryTimeout(ctx, CorpusItem, parsed)
			}
			if out.err != nil {
				return SearchResponse{}, out.err
			}
			items = out.items
			tags = []SuggestTag{}
			nextCurVal = out.nextCursor
		} else {
			// Page 1 of scope=all: run primary item page branch (limit+1) and auxiliary
			// tag branch (up to 5 tags) in parallel, each with its own read-only tx + 50 ms budget.
			var (
				wg     sync.WaitGroup
				itmOut searchItemPageOutcome
				tagOut tagBranchOutcome
			)
			wg.Add(2)
			go func() {
				defer wg.Done()
				itmOut = s.runSearchItemPageBranch(ctx, in.UserID, parsed.Mode, parsed.QN, nil, limit)
			}()
			go func() {
				defer wg.Done()
				tagOut = s.runTagBranch(ctx, in.UserID, parsed.Mode, parsed.QN, int32(SearchAllFirstPageTagsMax))
			}()
			wg.Wait()

			// A request that ended since a branch was classified partial is not a partial:
			// the parent wins and nothing is counted (RV-SB1-BE-1).
			if tagOut.partial || itmOut.partial {
				if perr := parentDoneErr(ctx, "", parsed.Mode); perr != nil {
					return SearchResponse{}, withScope(perr, parsed.Scope, parsed.Mode)
				}
			}
			if tagOut.partial {
				s.incLexicalPartial(CorpusTag)
			}
			if itmOut.partial {
				return SearchResponse{}, s.searchPrimaryTimeout(ctx, CorpusItem, parsed)
			}
			if itmOut.err != nil {
				return SearchResponse{}, itmOut.err
			}
			if tagOut.err != nil {
				return SearchResponse{}, tagOut.err
			}

			items = itmOut.items
			nextCurVal = itmOut.nextCursor
			tags = tagOut.tags
			if len(tags) > SearchAllFirstPageTagsMax {
				tags = tags[:SearchAllFirstPageTagsMax]
			}
		}
	default:
		return SearchResponse{}, ErrInvalidRequest
	}

	// Cursor pages never call NearSource.Near; they always return semantic:false,
	// semantic_reason:"request_lexical", near:[], generation:null (SPEC §6.8, OpenAPI `search`).
	if hasCursor {
		var nextCursorStr *string
		if nextCurVal != nil {
			nextCurVal.Scope = parsed.Scope
			nextCurVal.Gen = activeGen
			enc, err := EncodeCursor(s.cursorKey, parsed.QN, *nextCurVal)
			if err != nil {
				return SearchResponse{}, err
			}
			nextCursorStr = &enc
		}
		reason := ReasonRequestLexical
		resp := SearchResponse{
			Scope:          parsed.Scope,
			Limit:          limit,
			Mode:           parsed.Mode,
			Items:          items,
			Tags:           tags,
			NextCursor:     nextCursorStr,
			Semantic:       false,
			SemanticReason: &reason,
			Near:           []SuggestNearRow{},
			Generation:     nil,
		}
		resp.NormalizeSlices()
		return resp, nil
	}

	// Page 1: build lexical exclusion set `(kind, id)` and call NearSource with Cap = 5.
	exclude := make([]KindID, 0, len(tags)+len(items))
	lexSet := make(map[KindID]struct{}, len(tags)+len(items))
	for _, t := range tags {
		k := KindID{Kind: CorpusTag, ID: t.ID}
		exclude = append(exclude, k)
		lexSet[k] = struct{}{}
	}
	for _, it := range items {
		k := KindID{Kind: CorpusItem, ID: it.ID}
		exclude = append(exclude, k)
		lexSet[k] = struct{}{}
	}

	nearRes, err := s.resolveNear(
		ctx,
		SuggestInput{
			UserID:   in.UserID,
			RawQ:     in.RawQ,
			Scope:    parsed.Scope,
			Limit:    limit,
			Semantic: in.Semantic,
		},
		parsed,
		limit,
		exclude,
		SearchFirstPageNearMax,
	)
	if err != nil {
		return SearchResponse{}, err
	}

	nearRows := filterAndClipSearchNear(nearRes.Near, lexSet, SearchFirstPageNearMax)

	var nextCursorStr *string
	if nextCurVal != nil {
		nextCurVal.Scope = parsed.Scope
		nextCurVal.Gen = activeGen
		enc, err := EncodeCursor(s.cursorKey, parsed.QN, *nextCurVal)
		if err != nil {
			return SearchResponse{}, err
		}
		nextCursorStr = &enc
	}

	resp := SearchResponse{
		Scope:          parsed.Scope,
		Limit:          limit,
		Mode:           parsed.Mode,
		Items:          items,
		Tags:           tags,
		NextCursor:     nextCursorStr,
		Semantic:       nearRes.Semantic,
		SemanticReason: nearRes.SemanticReason,
		Near:           nearRows,
		Generation:     nearRes.Generation,
	}
	resp.NormalizeSlices()
	return resp, nil
}

// searchPrimaryTimeout is the dec-287 outcome of a primary paged-corpus timeout: count it and
// return a static 500 whose cause stays distinguishable (ClassSearchPrimaryTimeout) so the
// handler logs exactly one WARN for it. A request that already ended is not a timeout: the
// parent wins, nothing is counted (RV-SB1-BE-1).
func (s *Service) searchPrimaryTimeout(ctx context.Context, corpus string, parsed ParsedSuggestQuery) error {
	if perr := parentDoneErr(ctx, corpus, parsed.Mode); perr != nil {
		return withScope(perr, parsed.Scope, parsed.Mode)
	}
	s.incLexicalPartial(corpus)
	return withScope(newInternalError(ClassSearchPrimaryTimeout, corpus, parsed.Mode, ErrSearchInternal), parsed.Scope, parsed.Mode)
}

// generationLookupError is the static 500 for a failed NearSource.ActiveGeneration. It carries
// ClassGenerationLookup, which the handler does not log because the source already did
// (RV-SB1-BE-3); errors.Is(err, ErrSearchInternal) still holds.
func generationLookupError(parsed ParsedSuggestQuery) error {
	return withScope(newInternalError(ClassGenerationLookup, "", parsed.Mode, ErrSearchInternal), parsed.Scope, parsed.Mode)
}

func (s *Service) activeGeneration(ctx context.Context, userID uuid.UUID) (*int, error) {
	if s.near == nil {
		return (NoopNearSource{}).ActiveGeneration(ctx, userID)
	}
	return s.near.ActiveGeneration(ctx, userID)
}

func equalCursorGen(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func (s *Service) incLexicalPartial(corpus string) {
	if s.metrics != nil && s.metrics.Search != nil && s.metrics.Search.LexicalPartialTotal != nil {
		s.metrics.Search.LexicalPartialTotal.WithLabelValues(corpus).Inc()
	}
}

type searchItemPageOutcome struct {
	items      []SuggestItem
	nextCursor *SearchCursor
	partial    bool
	err        error
}

type searchTagPageOutcome struct {
	tags       []SuggestTag
	nextCursor *SearchCursor
	partial    bool
	err        error
}

func (s *Service) runSearchItemPageBranch(
	ctx context.Context,
	userID uuid.UUID,
	mode string,
	qn string,
	cur *SearchCursor,
	pageLimit int,
) searchItemPageOutcome {
	branchCtx, cancel := context.WithTimeout(ctx, BranchTimeout)
	defer cancel()

	// fail classifies a failed step: branch budget expired -> partial (SPEC §6.8), client gone or
	// genuine error -> err (FU-SB-1, classifyBranchErr).
	fail := func(err error, class string) searchItemPageOutcome {
		partial, out := classifyBranchErr(ctx, branchCtx, err, CorpusItem, mode, class)
		if partial {
			return searchItemPageOutcome{items: []SuggestItem{}, partial: true}
		}
		return searchItemPageOutcome{err: out}
	}

	if h := s.activeHooks(); h != nil && h.BeforeBranch != nil {
		if err := h.BeforeBranch(branchCtx, CorpusItem); err != nil {
			return fail(err, ClassLexicalItemDB)
		}
	}

	tx, err := s.txStarter.BeginTx(branchCtx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return fail(err, ClassLexicalItemDB)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if err := configureLexicalTx(branchCtx, tx, true); err != nil {
		return fail(err, ClassLexicalItemDB)
	}

	if h := s.activeHooks(); h != nil && h.AfterBranchSetLocal != nil {
		if err := h.AfterBranchSetLocal(branchCtx, tx, CorpusItem); err != nil {
			return fail(err, ClassLexicalItemDB)
		}
	}

	params := gen.SearchItemsLexicalPageParams{
		PageLimit: int32(pageLimit + 1),
		Qn:        qn,
		QPrefix:   item.EscapeLikePrefix(qn),
		UserID:    userID,
		Fuzzy:     mode == ModeFull,
	}
	if cur != nil {
		idCopy := cur.ID
		tierCopy := cur.Tier
		scoreCopy := cur.Score
		countCopy := cur.Count
		params.CursorID = &idCopy
		params.CursorTier = &tierCopy
		params.CursorScore = &scoreCopy
		params.CursorLastUsedAt = pgtype.Timestamptz{
			Time:  cur.LastUsedAt.UTC(),
			Valid: true,
		}
		params.CursorCount = &countCopy
	}

	q := gen.New(tx)
	rows, err := q.SearchItemsLexicalPage(branchCtx, params)
	if err != nil {
		return fail(err, ClassLexicalItemDB)
	}

	hasMore := len(rows) > pageLimit
	if hasMore {
		rows = rows[:pageLimit]
	}

	out := make([]SuggestItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, SuggestItem{
			Kind:       CorpusItem,
			ID:         r.ID,
			Name:       r.Name,
			EntryCount: r.EntryCount,
			CreatedAt:  r.CreatedAt.Time.UTC(),
			LastUsedAt: r.LastUsedAt.Time.UTC(),
			Tags:       []TagRef{},
			TagTotal:   0,
			Match:      TierToMatch(r.Tier),
		})
	}

	if len(out) > 0 {
		if err := attachTagRefs(branchCtx, q, userID, out); err != nil {
			return fail(err, ClassLexicalItemTagRefs)
		}
	}

	var nextCur *SearchCursor
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		nextCur = &SearchCursor{
			Kind:       CorpusItem,
			Tier:       last.Tier,
			Score:      last.Score,
			LastUsedAt: last.LastUsedAt.Time.UTC(),
			Count:      last.EntryCount,
			ID:         last.ID,
		}
	}

	return searchItemPageOutcome{
		items:      out,
		nextCursor: nextCur,
	}
}

func (s *Service) runSearchTagPageBranch(
	ctx context.Context,
	userID uuid.UUID,
	mode string,
	qn string,
	cur *SearchCursor,
	pageLimit int,
) searchTagPageOutcome {
	branchCtx, cancel := context.WithTimeout(ctx, BranchTimeout)
	defer cancel()

	// fail classifies a failed step: branch budget expired -> partial (SPEC §6.8), client gone or
	// genuine error -> err (FU-SB-1, classifyBranchErr).
	fail := func(err error, class string) searchTagPageOutcome {
		partial, out := classifyBranchErr(ctx, branchCtx, err, CorpusTag, mode, class)
		if partial {
			return searchTagPageOutcome{tags: []SuggestTag{}, partial: true}
		}
		return searchTagPageOutcome{err: out}
	}

	if h := s.activeHooks(); h != nil && h.BeforeBranch != nil {
		if err := h.BeforeBranch(branchCtx, CorpusTag); err != nil {
			return fail(err, ClassLexicalTagDB)
		}
	}

	tx, err := s.txStarter.BeginTx(branchCtx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return fail(err, ClassLexicalTagDB)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if err := configureLexicalTx(branchCtx, tx, true); err != nil {
		return fail(err, ClassLexicalTagDB)
	}

	if h := s.activeHooks(); h != nil && h.AfterBranchSetLocal != nil {
		if err := h.AfterBranchSetLocal(branchCtx, tx, CorpusTag); err != nil {
			return fail(err, ClassLexicalTagDB)
		}
	}

	params := gen.SearchTagsLexicalPageParams{
		PageLimit: int32(pageLimit + 1),
		Qn:        qn,
		QPrefix:   item.EscapeLikePrefix(qn),
		UserID:    userID,
		Fuzzy:     mode == ModeFull,
	}
	if cur != nil {
		idCopy := cur.ID
		tierCopy := cur.Tier
		scoreCopy := cur.Score
		countCopy := cur.Count
		params.CursorID = &idCopy
		params.CursorTier = &tierCopy
		params.CursorScore = &scoreCopy
		params.CursorLastUsedAt = pgtype.Timestamptz{
			Time:  cur.LastUsedAt.UTC(),
			Valid: true,
		}
		params.CursorCount = &countCopy
	}

	q := gen.New(tx)
	rows, err := q.SearchTagsLexicalPage(branchCtx, params)
	if err != nil {
		return fail(err, ClassLexicalTagDB)
	}

	hasMore := len(rows) > pageLimit
	if hasMore {
		rows = rows[:pageLimit]
	}

	out := make([]SuggestTag, 0, len(rows))
	for _, r := range rows {
		out = append(out, SuggestTag{
			Kind:       CorpusTag,
			ID:         r.ID,
			Display:    r.Display,
			ItemCount:  r.ItemCount,
			LastUsedAt: r.LastUsedAt.Time.UTC(),
			Match:      TierToMatch(r.Tier),
		})
	}

	var nextCur *SearchCursor
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		nextCur = &SearchCursor{
			Kind:       CorpusTag,
			Tier:       last.Tier,
			Score:      last.Score,
			LastUsedAt: last.LastUsedAt.Time.UTC(),
			Count:      last.ItemCount,
			ID:         last.ID,
		}
	}

	return searchTagPageOutcome{
		tags:       out,
		nextCursor: nextCur,
	}
}

func filterAndClipSearchNear(
	raw []SuggestNearRow,
	lexSet map[KindID]struct{},
	maxNear int,
) []SuggestNearRow {
	return filterAndClipNear(
		raw,
		lexSet,
		SuggestQuota{Near: maxNear},
		maxNear,
		0,
		0,
	)
}
