package store

import (
	"cmp"
	"context"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pgvector/pgvector-go"
	"math"
	"slices"
	"strconv"
	"time"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

// ANNSearchSQL builds the HNSW ANN vector search SQL query for corpus ("item"
// or "tag") using the already-validated and pgx.Identifier.Sanitize()-quoted
// table name tbl (plan P05 mục 2.16, Task 14; SPEC §6.3).
//
// Design invariants:
//   - The `ann` CTE is `MATERIALIZED` and selects up to `$4` (`k`) candidates
//     for `WHERE e.user_id = $1 ORDER BY e.embedding <=> $2 LIMIT $4`. Because
//     `e.user_id = $1` matches the hash-partition key, Postgres prunes to the
//     single hash partition for `user_id` and scans its HNSW index.
//   - To observe both the pre-filter candidate count (`ann_candidates`, needed
//     for the underfill check `candidates before threshold filter < K`) and the
//     surviving live hits above `semantic_min_cos` in a single query inside the
//     `pgx.Batch`, `ann_count` counts the materialized `ann` CTE rows and is
//     LEFT JOINed against `filtered` (the live-joined, threshold-filtered hits).
//     When `ann` is empty, `ann_count` is 0 and 1 row with `ann_candidates = 0`
//     and `id = NULL` is emitted; when `ann` is non-empty but `filtered` is
//     empty, 1 row with `ann_candidates = |ann|` and `id = NULL` is emitted.
//   - Hits are re-sorted by `(dist ASC, id ASC)` both in SQL and via
//     `ResortHitsByDistAndID` in Go (mandatory when `hnsw.iterative_scan =
//     relaxed_order`).
func ANNSearchSQL(tbl string, corpus generation.Corpus) (string, error) {
	switch corpus {
	case generation.CorpusItem:
		// #nosec G202 -- tbl is validated against allowlist ^(item|tag)_embedding_g[1-9][0-9]{0,3}$ and quoted via pgx.Identifier.Sanitize().
		return `WITH ann AS MATERIALIZED (
	SELECT e.user_id, e.target_id, (e.embedding <=> $2) AS dist
	FROM ` + tbl + ` e
	WHERE e.user_id = $1
	ORDER BY e.embedding <=> $2
	LIMIT $4
),
ann_count AS (
	SELECT count(*)::int AS cnt FROM ann
),
filtered AS (
	SELECT
		i.id,
		i.name,
		i.entry_count,
		i.last_used_at,
		i.created_at,
		a.dist,
		1 - a.dist AS cos
	FROM ann a
	JOIN item i ON i.id = a.target_id AND i.user_id = a.user_id
	WHERE i.deleted_at IS NULL
	  AND 1 - a.dist >= $3
)
SELECT
	c.cnt AS ann_candidates,
	f.id,
	f.name,
	f.entry_count,
	f.last_used_at,
	f.created_at,
	f.dist,
	f.cos
FROM ann_count c
LEFT JOIN filtered f ON true
ORDER BY f.dist ASC NULLS LAST, f.id ASC NULLS LAST`, nil

	case generation.CorpusTag:
		// #nosec G202 -- tbl is validated against allowlist ^(item|tag)_embedding_g[1-9][0-9]{0,3}$ and quoted via pgx.Identifier.Sanitize().
		return `WITH ann AS MATERIALIZED (
	SELECT e.user_id, e.target_id, (e.embedding <=> $2) AS dist
	FROM ` + tbl + ` e
	WHERE e.user_id = $1
	ORDER BY e.embedding <=> $2
	LIMIT $4
),
ann_count AS (
	SELECT count(*)::int AS cnt FROM ann
),
filtered AS (
	SELECT
		t.id,
		t.display,
		t.item_count,
		t.last_used_at,
		t.created_at,
		a.dist,
		1 - a.dist AS cos
	FROM ann a
	JOIN tag t ON t.id = a.target_id AND t.user_id = a.user_id
	WHERE t.deleted_at IS NULL
	  AND 1 - a.dist >= $3
)
SELECT
	c.cnt AS ann_candidates,
	f.id,
	f.display,
	f.item_count,
	f.last_used_at,
	f.created_at,
	f.dist,
	f.cos
FROM ann_count c
LEFT JOIN filtered f ON true
ORDER BY f.dist ASC NULLS LAST, f.id ASC NULLS LAST`, nil

	default:
		return "", generation.ErrInvalidCorpus
	}
}

// ResortHitsByDistAndID sorts hits in place by (Dist ASC, ID ASC) (plan P05
// mục 2.16: mandatory re-sort after `hnsw.iterative_scan = relaxed_order`).
// When Dist is equal, Cos is synchronized to 1 - Dist and ties are broken by
// UUID byte order ascending (`id ASC` in Postgres).
func ResortHitsByDistAndID(hits []Hit) {
	slices.SortFunc(hits, func(a, b Hit) int {
		if c := cmp.Compare(a.Dist, b.Dist); c != 0 {
			return c
		}
		return cmp.Compare(a.ID.String(), b.ID.String())
	})
}

// FormatANNRandomPageCostSQL returns the validated `SET LOCAL random_page_cost = <v>`
// statement for the read-only ANN transaction, or "" when disabled via
// ANNRandomPageCostOff (-1). Zero defaults to DefaultANNRandomPageCost (1.1).
// Values outside [MinANNRandomPageCost, MaxANNRandomPageCost] (0.5..4.0) return
// ErrInvalidKnobs.
func FormatANNRandomPageCostSQL(cost float64) (string, error) {
	if cost == ANNRandomPageCostOff {
		return "", nil
	}
	if cost == 0 {
		cost = DefaultANNRandomPageCost
	}
	if math.IsNaN(cost) || math.IsInf(cost, 0) || cost < MinANNRandomPageCost || cost > MaxANNRandomPageCost {
		return "", fmt.Errorf("%w: RandomPageCost out of range", ErrInvalidKnobs)
	}
	// #nosec G202 -- cost is a validated finite float64 in [0.5, 4.0] formatted via strconv.FormatFloat.
	return `SET LOCAL random_page_cost = ` + strconv.FormatFloat(cost, 'f', -1, 64), nil
}

// ANNSetLocalStatements returns the ordered list of SET LOCAL statements
// executed inside the read-only ANN transaction before ANNSearchSQL (advisor-dec-348).
func ANNSetLocalStatements(cfg VectorSearchKnobs, budget time.Duration) ([]string, error) {
	return buildANNSetLocalStatements(cfg, budget)
}

func buildANNSetLocalStatements(cfg VectorSearchKnobs, budget time.Duration) ([]string, error) {
	var iterLiteral string
	switch cfg.IterativeScan {
	case IterativeScanOff:
		iterLiteral = IterativeScanOff
	case IterativeScanRelaxedOrder:
		iterLiteral = IterativeScanRelaxedOrder
	case IterativeScanStrictOrder:
		iterLiteral = IterativeScanStrictOrder
	default:
		return nil, fmt.Errorf("%w: invalid IterativeScan mode", ErrInvalidKnobs)
	}
	if cfg.EfSearch < MinHNSWEfSearch || cfg.EfSearch > MaxHNSWEfSearch {
		return nil, fmt.Errorf("%w: EfSearch out of range", ErrInvalidKnobs)
	}
	if cfg.MaxScanTuples < MinHNSWMaxScanTuples || cfg.MaxScanTuples > MaxHNSWMaxScanTuples {
		return nil, fmt.Errorf("%w: MaxScanTuples out of range", ErrInvalidKnobs)
	}
	costSQL, err := FormatANNRandomPageCostSQL(cfg.RandomPageCost)
	if err != nil {
		return nil, err
	}

	timeoutLiteral := formatStatementTimeoutMS(budget)

	stmts := make([]string, 0, 5)
	// #nosec G202 -- SET LOCAL values come exclusively from validated enum/integer/float config bounds.
	stmts = append(stmts, `SET LOCAL hnsw.iterative_scan = `+iterLiteral)
	// #nosec G202 -- EfSearch is a validated int in [1, 2000].
	stmts = append(stmts, `SET LOCAL hnsw.ef_search = `+strconv.Itoa(cfg.EfSearch))
	// #nosec G202 -- MaxScanTuples is a validated int in [1, 1000000].
	stmts = append(stmts, `SET LOCAL hnsw.max_scan_tuples = `+strconv.Itoa(cfg.MaxScanTuples))
	if costSQL != "" {
		stmts = append(stmts, costSQL)
	}
	// #nosec G202 -- timeoutLiteral is formatted strictly from a clamped integer millisecond duration.
	stmts = append(stmts, `SET LOCAL statement_timeout = '`+timeoutLiteral+`'`)
	return stmts, nil
}

func runANNSearchTx(
	ctx context.Context,
	db VectorQueryDB,
	tbl string,
	corpus generation.Corpus,
	userID uuid.UUID,
	qvec pgvector.Vector,
	minCos float64,
	k int,
	budget time.Duration,
	cfg VectorSearchKnobs,
) ([]Hit, int, error) {
	querySQL, err := ANNSearchSQL(tbl, corpus)
	if err != nil {
		return nil, 0, err
	}
	setLocalStmts, err := buildANNSetLocalStatements(cfg, budget)
	if err != nil {
		return nil, 0, err
	}

	tx, err := db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, 0, fmt.Errorf("store: begin ann read-only tx: %w", sanitizeQueryErr(err))
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	var batch pgx.Batch
	for _, stmt := range setLocalStmts {
		batch.Queue(stmt)
	}
	batch.Queue(querySQL, userID, qvec, minCos, k)

	br := tx.SendBatch(ctx, &batch)
	closed := false
	closeBatch := func() error {
		if closed {
			return nil
		}
		closed = true
		return br.Close()
	}
	defer func() {
		_ = closeBatch()
	}()

	for range len(setLocalStmts) {
		if _, err := br.Exec(); err != nil {
			return nil, 0, fmt.Errorf("store: ann set local: %w", sanitizeQueryErr(err))
		}
	}

	rows, err := br.Query()
	if err != nil {
		return nil, 0, fmt.Errorf("store: ann query: %w", sanitizeQueryErr(err))
	}

	hits, annCandidates, scanErr := scanANNHits(rows, corpus)
	rows.Close()
	if scanErr != nil {
		ResortHitsByDistAndID(hits)
		return hits, annCandidates, scanErr
	}
	if err := closeBatch(); err != nil {
		ResortHitsByDistAndID(hits)
		return hits, annCandidates, fmt.Errorf("store: close ann batch: %w", sanitizeQueryErr(err))
	}
	if err := tx.Commit(ctx); err != nil {
		ResortHitsByDistAndID(hits)
		return hits, annCandidates, fmt.Errorf("store: commit ann read-only tx: %w", sanitizeQueryErr(err))
	}

	ResortHitsByDistAndID(hits)
	return hits, annCandidates, nil
}

func scanANNHits(rows pgx.Rows, corpus generation.Corpus) ([]Hit, int, error) {
	out := make([]Hit, 0)
	annCandidates := 0

	for rows.Next() {
		var (
			candCnt    int
			idPtr      *uuid.UUID
			textVal    *string
			countVal   *int
			lastUsedAt *time.Time
			createdAt  *time.Time
			distVal    *float64
			cosVal     *float64
		)
		if err := rows.Scan(
			&candCnt,
			&idPtr,
			&textVal,
			&countVal,
			&lastUsedAt,
			&createdAt,
			&distVal,
			&cosVal,
		); err != nil {
			return out, annCandidates, fmt.Errorf("store: scan ann hit: %w", sanitizeQueryErr(err))
		}
		annCandidates = candCnt
		if idPtr == nil {
			continue
		}

		h := Hit{
			ID: *idPtr,
		}
		if textVal != nil {
			if corpus == generation.CorpusItem {
				h.Name = *textVal
			} else {
				h.Display = *textVal
			}
		}
		if countVal != nil {
			h.Count = *countVal
		}
		if lastUsedAt != nil {
			h.LastUsedAt = *lastUsedAt
		}
		if createdAt != nil {
			h.CreatedAt = *createdAt
		}
		if distVal != nil {
			h.Dist = *distVal
		}
		if cosVal != nil {
			h.Cos = *cosVal
		}
		out = append(out, h)
	}
	if err := rows.Err(); err != nil {
		return out, annCandidates, fmt.Errorf("store: iterate ann hits: %w", sanitizeQueryErr(err))
	}
	return out, annCandidates, nil
}
