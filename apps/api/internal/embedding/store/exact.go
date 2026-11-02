package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pgvector/pgvector-go"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

// ExactSearchSQL builds the exact vector search SQL query for corpus ("item" or
// "tag") using the already-validated and pgx.Identifier.Sanitize()-quoted table
// name tbl (plan P05 mục 2.16, Task 14; SPEC §6.3).
//
// Design invariants:
//   - Pre-selects the tenant's rows via a MATERIALIZED CTE ordered by
//     (user_id, target_id) — the composite primary key on each partition —
//     which blocks the Postgres planner from choosing the per-partition HNSW
//     index (`ORDER BY embedding <=> $2`) when count <= ExactMaxVectors.
//   - Joins the live target table (`item` or `tag`) on `id = target_id AND
//     user_id = user_id` with `deleted_at IS NULL`, so soft-deleted rows and
//     other tenants' rows are never returned.
//   - Filters `1 - (e.embedding <=> $2) >= $3` (`semantic_min_cos`).
//   - Orders deterministically by `dist ASC, id ASC` with `LIMIT $4`.
func ExactSearchSQL(tbl string, corpus generation.Corpus) (string, error) {
	switch corpus {
	case generation.CorpusItem:
		// #nosec G202 -- tbl is validated against allowlist ^(item|tag)_embedding_g[1-9][0-9]{0,3}$ and quoted via pgx.Identifier.Sanitize().
		return `WITH tenant_vecs AS MATERIALIZED (
	SELECT user_id, target_id, embedding
	FROM ` + tbl + `
	WHERE user_id = $1
	ORDER BY user_id, target_id
)
SELECT
	i.id,
	i.name,
	i.entry_count,
	i.last_used_at,
	i.created_at,
	(e.embedding <=> $2) AS dist,
	1 - (e.embedding <=> $2) AS cos
FROM tenant_vecs e
JOIN item i ON i.id = e.target_id AND i.user_id = e.user_id
WHERE i.deleted_at IS NULL
  AND 1 - (e.embedding <=> $2) >= $3
ORDER BY dist ASC, i.id ASC
LIMIT $4`, nil

	case generation.CorpusTag:
		// #nosec G202 -- tbl is validated against allowlist ^(item|tag)_embedding_g[1-9][0-9]{0,3}$ and quoted via pgx.Identifier.Sanitize().
		return `WITH tenant_vecs AS MATERIALIZED (
	SELECT user_id, target_id, embedding
	FROM ` + tbl + `
	WHERE user_id = $1
	ORDER BY user_id, target_id
)
SELECT
	t.id,
	t.display,
	t.item_count,
	t.last_used_at,
	t.created_at,
	(e.embedding <=> $2) AS dist,
	1 - (e.embedding <=> $2) AS cos
FROM tenant_vecs e
JOIN tag t ON t.id = e.target_id AND t.user_id = e.user_id
WHERE t.deleted_at IS NULL
  AND 1 - (e.embedding <=> $2) >= $3
ORDER BY dist ASC, t.id ASC
LIMIT $4`, nil

	default:
		return "", generation.ErrInvalidCorpus
	}
}

func runExactSearchWithTimeout(
	ctx context.Context,
	db VectorQueryDB,
	tbl string,
	corpus generation.Corpus,
	userID uuid.UUID,
	qvec pgvector.Vector,
	minCos float64,
	k int,
	budget time.Duration,
) ([]Hit, error) {
	querySQL, err := ExactSearchSQL(tbl, corpus)
	if err != nil {
		return nil, err
	}

	timeoutLiteral := formatStatementTimeoutMS(budget)

	tx, err := db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("store: begin exact read-only tx: %w", sanitizeQueryErr(err))
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	var batch pgx.Batch
	// #nosec G202 -- timeoutLiteral is formatted strictly from a clamped integer millisecond duration via strconv.FormatInt.
	batch.Queue(`SET LOCAL statement_timeout = '` + timeoutLiteral + `'`)
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

	if _, err := br.Exec(); err != nil {
		return nil, fmt.Errorf("store: exact set statement_timeout: %w", sanitizeQueryErr(err))
	}

	rows, err := br.Query()
	if err != nil {
		return nil, fmt.Errorf("store: exact query: %w", sanitizeQueryErr(err))
	}

	hits, scanErr := scanExactHits(rows, corpus)
	rows.Close()
	if scanErr != nil {
		ResortHitsByDistAndID(hits)
		return hits, scanErr
	}
	if err := closeBatch(); err != nil {
		ResortHitsByDistAndID(hits)
		return hits, fmt.Errorf("store: close exact batch: %w", sanitizeQueryErr(err))
	}
	if err := tx.Commit(ctx); err != nil {
		ResortHitsByDistAndID(hits)
		return hits, fmt.Errorf("store: commit exact read-only tx: %w", sanitizeQueryErr(err))
	}
	return hits, nil
}

func scanExactHits(rows pgx.Rows, corpus generation.Corpus) ([]Hit, error) {
	out := make([]Hit, 0)
	for rows.Next() {
		var h Hit
		switch corpus {
		case generation.CorpusItem:
			if err := rows.Scan(
				&h.ID,
				&h.Name,
				&h.Count,
				&h.LastUsedAt,
				&h.CreatedAt,
				&h.Dist,
				&h.Cos,
			); err != nil {
				return out, fmt.Errorf("store: scan exact item hit: %w", sanitizeQueryErr(err))
			}
		case generation.CorpusTag:
			if err := rows.Scan(
				&h.ID,
				&h.Display,
				&h.Count,
				&h.LastUsedAt,
				&h.CreatedAt,
				&h.Dist,
				&h.Cos,
			); err != nil {
				return out, fmt.Errorf("store: scan exact tag hit: %w", sanitizeQueryErr(err))
			}
		default:
			return nil, generation.ErrInvalidCorpus
		}
		out = append(out, h)
	}
	if err := rows.Err(); err != nil {
		return out, fmt.Errorf("store: iterate exact hits: %w", sanitizeQueryErr(err))
	}
	return out, nil
}
