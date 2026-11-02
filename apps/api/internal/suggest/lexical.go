package suggest

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/item"
)

// TxStarter abstracts pgxpool.Pool.BeginTx so tests can inject a wrapper
// (e.g. to force one corpus branch past the 50 ms statement_timeout in
// TestSuggestBranchTimeoutPartial without sleeping in production code).
type TxStarter interface {
	BeginTx(ctx context.Context, txOptions pgx.TxOptions) (pgx.Tx, error)
}

// BranchTimeout is the per-branch budget for lexical item/tag QUERY work, started after acquire +
// BEGIN + SET LOCAL, which have their own BranchSetupTimeout (FU-SB-2) (SPEC §6.3, §6.4, plan mục 2.3).
const BranchTimeout = 50 * time.Millisecond

type itemBranchOutcome struct {
	items   []SuggestItem
	hasMore bool
	partial bool
	err     error
}

type tagBranchOutcome struct {
	tags    []SuggestTag
	hasMore bool
	partial bool
	err     error
}

// configureLexicalTx sets the required transaction-local GUCs on a read-only lexical tx
// (SPEC §6.3, plan P05 mục 2.3).
func configureLexicalTx(ctx context.Context, tx pgx.Tx, includeTrgmThresholds bool) error {
	if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout = '50ms'`); err != nil {
		return err
	}
	if includeTrgmThresholds {
		if _, err := tx.Exec(ctx, `SET LOCAL pg_trgm.similarity_threshold = 0.35`); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SET LOCAL pg_trgm.word_similarity_threshold = 0.5`); err != nil {
			return err
		}
	}
	return nil
}

// isBranchTimeout returns true if err represents a statement_timeout (SQLSTATE 57014)
// or context deadline exceeded on a lexical branch (plan P05 mục 2.3).
func isBranchTimeout(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		// 57014 = query_canceled (statement_timeout in PostgreSQL).
		if pgErr.Code == "57014" {
			return true
		}
	}
	return false
}

func (s *Service) runLexicalBranches(
	ctx context.Context,
	userID uuid.UUID,
	scope string,
	limit int,
	mode string,
	qn string,
) (tags []SuggestTag, items []SuggestItem, tagMore bool, itemMore bool, partial []string, err error) {
	tagCap, itemCap := CorpusQueryCaps(scope, limit, mode)
	runTags := scope == ScopeAll || scope == ScopeTag
	runItems := scope == ScopeAll || scope == ScopeItem

	var (
		wg     sync.WaitGroup
		tagOut tagBranchOutcome
		itmOut itemBranchOutcome
	)

	if runItems && itemCap > 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			itmOut = s.runItemBranch(ctx, userID, mode, qn, int32(itemCap+1))
		}()
	}

	if runTags && tagCap > 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tagOut = s.runTagBranch(ctx, userID, mode, qn, int32(tagCap+1))
		}()
	}

	wg.Wait()

	if itmOut.err != nil {
		return nil, nil, false, false, nil, itmOut.err
	}
	if tagOut.err != nil {
		return nil, nil, false, false, nil, tagOut.err
	}
	// A branch was classified partial while the request was alive, but the request may have
	// ended since: the parent wins, so a client disconnect never counts as a partial (RV-SB1-BE-1).
	if itmOut.partial || tagOut.partial {
		if perr := parentDoneErr(ctx, "", mode); perr != nil {
			return nil, nil, false, false, nil, perr
		}
	}

	partial = []string{}
	if itmOut.partial {
		partial = append(partial, CorpusItem)
		if s.metrics != nil && s.metrics.Search != nil && s.metrics.Search.LexicalPartialTotal != nil {
			s.metrics.Search.LexicalPartialTotal.WithLabelValues(CorpusItem).Inc()
		}
	}
	if tagOut.partial {
		partial = append(partial, CorpusTag)
		if s.metrics != nil && s.metrics.Search != nil && s.metrics.Search.LexicalPartialTotal != nil {
			s.metrics.Search.LexicalPartialTotal.WithLabelValues(CorpusTag).Inc()
		}
	}

	return tagOut.tags, itmOut.items, tagOut.hasMore, itmOut.hasMore, partial, nil
}

func (s *Service) runItemBranch(ctx context.Context, userID uuid.UUID, mode string, qn string, fetchLimit int32) itemBranchOutcome {
	isRecent := mode == ModeRecent
	var out []SuggestItem

	// Setup (acquire, BEGIN, SET LOCAL) and the 50 ms query budget are bounded separately
	// (FU-SB-2, runBranch); a stage that expired while the request is alive -> partial (SPEC §6.8),
	// client gone or genuine error -> err (FU-SB-1, classifyBranchErr).
	partial, err := s.runBranch(ctx, CorpusItem, mode, ClassLexicalItemDB, !isRecent, func(qctx context.Context, tx pgx.Tx) (string, error) {
		q := gen.New(tx)
		if isRecent {
			rows, err := q.RecentItemsForSuggest(qctx, gen.RecentItemsForSuggestParams{
				UserID:    userID,
				PageLimit: fetchLimit,
			})
			if err != nil {
				return ClassLexicalItemDB, err
			}
			out = make([]SuggestItem, 0, len(rows))
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
					Match:      MatchPrefix,
				})
			}
		} else {
			rows, err := q.SearchItemsLexical(qctx, gen.SearchItemsLexicalParams{
				UserID:    userID,
				Qn:        qn,
				QPrefix:   item.EscapeLikePrefix(qn),
				Fuzzy:     mode == ModeFull,
				PageLimit: fetchLimit,
			})
			if err != nil {
				return ClassLexicalItemDB, err
			}
			out = make([]SuggestItem, 0, len(rows))
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
		}

		if len(out) > 0 {
			if err := attachTagRefs(qctx, q, userID, out); err != nil {
				return ClassLexicalItemTagRefs, err
			}
		}
		return "", nil
	})
	if partial {
		return itemBranchOutcome{items: []SuggestItem{}, partial: true}
	}
	if err != nil {
		return itemBranchOutcome{err: err}
	}
	return itemBranchOutcome{
		items:   out,
		hasMore: int32(len(out)) >= fetchLimit,
	}
}

func (s *Service) runTagBranch(ctx context.Context, userID uuid.UUID, mode string, qn string, fetchLimit int32) tagBranchOutcome {
	isRecent := mode == ModeRecent
	var out []SuggestTag

	// Setup and the 50 ms query budget are bounded separately (FU-SB-2, runBranch).
	partial, err := s.runBranch(ctx, CorpusTag, mode, ClassLexicalTagDB, !isRecent, func(qctx context.Context, tx pgx.Tx) (string, error) {
		q := gen.New(tx)
		if isRecent {
			rows, err := q.RecentTagsForSuggest(qctx, gen.RecentTagsForSuggestParams{
				UserID:    userID,
				PageLimit: fetchLimit,
			})
			if err != nil {
				return ClassLexicalTagDB, err
			}
			out = make([]SuggestTag, 0, len(rows))
			for _, r := range rows {
				out = append(out, SuggestTag{
					Kind:       CorpusTag,
					ID:         r.ID,
					Display:    r.Display,
					ItemCount:  r.ItemCount,
					LastUsedAt: r.LastUsedAt.Time.UTC(),
					Match:      MatchPrefix,
				})
			}
		} else {
			rows, err := q.SearchTagsLexical(qctx, gen.SearchTagsLexicalParams{
				UserID:    userID,
				Qn:        qn,
				QPrefix:   item.EscapeLikePrefix(qn),
				Fuzzy:     mode == ModeFull,
				PageLimit: fetchLimit,
			})
			if err != nil {
				return ClassLexicalTagDB, err
			}
			out = make([]SuggestTag, 0, len(rows))
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
		}
		return "", nil
	})
	if partial {
		return tagBranchOutcome{tags: []SuggestTag{}, partial: true}
	}
	if err != nil {
		return tagBranchOutcome{err: err}
	}
	return tagBranchOutcome{
		tags:    out,
		hasMore: int32(len(out)) >= fetchLimit,
	}
}

func attachTagRefs(ctx context.Context, q *gen.Queries, userID uuid.UUID, items []SuggestItem) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, len(items))
	idxByID := make(map[uuid.UUID][]int, len(items))
	for i := range items {
		id := items[i].ID
		ids[i] = id
		idxByID[id] = append(idxByID[id], i)
	}
	refs, err := q.ListTagRefsForItems(ctx, gen.ListTagRefsForItemsParams{
		UserID:  userID,
		ItemIds: ids,
	})
	if err != nil {
		return err
	}
	for _, ref := range refs {
		for _, idx := range idxByID[ref.ItemID] {
			if len(items[idx].Tags) < 3 {
				items[idx].Tags = append(items[idx].Tags, TagRef{
					ID:      ref.TagID,
					Display: ref.Display,
				})
			}
			items[idx].TagTotal = ref.TagTotal
		}
	}
	return nil
}
