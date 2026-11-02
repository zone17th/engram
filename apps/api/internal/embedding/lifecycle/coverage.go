package lifecycle

import (
	"bytes"
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
)

// coverageInTx proves, inside the caller's EXCLUSIVE generation-lock
// transaction, that g covers every eligible live target right now (GL-1; plan
// 2.15 steps 5/6; ADR 0007 no-uncovered-mutation fence). It returns
// ErrCoverageIncomplete as soon as one gap is found, nil when there is none.
//
// Why it exists: the dry run in coverageOf runs outside the lock and cannot see
// what commits between its last page and the lock. Counting unfinished
// embed_item/embed_tag jobs does not see changes that create no such job (a user
// switching semantic_suggest off -> on for an openai_compat generation queues at
// most one reembed_user job, which the auth rate limiter may even skip). While
// the exclusive lock is held, every mutation that fans out to R is either
// already committed (so visible here) or blocked on the shared lock until we
// commit (and then sees the new R), so a read made now is the truth at the
// moment of the swap.
//
// Same rules as reconcile.Reconcile(All, ModeDryRun): the same store.ScanStale
// eligibility (live target, live user, semantic_suggest for openai_compat), the
// same input helpers and hash/model/model_version comparison, no vector of a
// soft-deleted or missing target (store.ScanOrphans) and, for openai_compat, no
// vector of a user-off user. It is read-only and uses only tx: it never calls
// reconcile.Reconcile or anything that takes the shared lock on another
// connection (that would self-deadlock against the exclusive lock we hold).
//
// Cost (recorded for Task 23/24): mutations wait on the shared lock for the whole
// scan, so the exclusive section lasts O(live targets + vectors) of this
// generation. The outside-lock dry run stays as the cheap pre-check, which makes
// this scan normally find nothing after one pass over the keyset; at the plan's
// deployment sizes this is seconds. Operators flip off-peak.
func coverageInTx(ctx context.Context, tx pgx.Tx, g generation.Generation) error {
	ident := g.Identity()
	corpora := []generation.Corpus{generation.CorpusItem, generation.CorpusTag}
	for _, corpus := range corpora {
		var cursor *store.ScanCursor
		for {
			page, err := store.ScanStale(ctx, tx, g, corpus, cursor, nil, store.MaxScanLimit)
			if err != nil {
				return fmt.Errorf("lifecycle: in-lock coverage scan failed: %w", sanitizeDBErr(err))
			}
			for _, row := range page {
				var input string
				if corpus == generation.CorpusItem {
					var hint string
					if row.Hint != nil {
						hint = *row.Hint
					}
					input = embedding.ItemInput(row.Name, hint)
				} else {
					input = embedding.TagInput(row.Display)
				}
				want := embedding.InputHashFor(ident, input)
				if !row.HasVector() ||
					!bytes.Equal(row.InputHash, want[:]) ||
					row.Model != g.Model ||
					row.ModelVersion != g.ModelVersion {
					return ErrCoverageIncomplete
				}
			}
			if len(page) < store.MaxScanLimit {
				break
			}
			last := page[len(page)-1]
			cursor = &store.ScanCursor{UserID: last.UserID, TargetID: last.TargetID}
		}

		orphans, err := store.ScanOrphans(ctx, tx, g, corpus, nil, nil, 1)
		if err != nil {
			return fmt.Errorf("lifecycle: in-lock orphan scan failed: %w", sanitizeDBErr(err))
		}
		if len(orphans) > 0 {
			return ErrCoverageIncomplete
		}
	}

	if g.Provider == generation.ProviderOpenAICompat {
		for _, corpus := range corpora {
			tbl, err := store.SanitizedTable(g, corpus)
			if err != nil {
				return err
			}
			var found bool
			// #nosec G202 -- tbl is validated against allowlist ^(item|tag)_embedding_g[1-9][0-9]{0,3}$ and quoted via pgx.Identifier.Sanitize().
			if err := tx.QueryRow(ctx, `SELECT EXISTS (
	SELECT 1 FROM `+tbl+` e
	JOIN app_user u ON u.id = e.user_id
	WHERE u.deleted_at IS NULL
	  AND COALESCE((u.settings->>'semantic_suggest')::boolean, true) = false)`).Scan(&found); err != nil {
				return fmt.Errorf("lifecycle: in-lock user-off scan failed: %w", sanitizeDBErr(err))
			}
			if found {
				return ErrCoverageIncomplete
			}
		}
	}
	return nil
}
