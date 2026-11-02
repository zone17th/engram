package semantic

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/pgvector/pgvector-go"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
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

// VectorSearchKnobs holds the query-time vector search parameters passed to
// VectorSearcher (mirroring Task 14 store.VectorSearchKnobs, plan P05 mục 2.13, 2.16).
type VectorSearchKnobs struct {
	ExactMaxVectors         int
	ExactFallbackMaxVectors int
	HNSWEfSearch            int
	HNSWMaxScanTuples       int
	HNSWIterativeScan       string
	VectorBranchTimeout     time.Duration
	VectorFallbackMinBudget time.Duration
}

// VectorHit represents a single candidate returned by VectorSearcher (mirroring
// Task 14 store.Hit, plan P05 mục 2.16, 2.19).
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
	Count      int32     // entry_count (item) or item_count (tag)
	LastUsedAt time.Time // UTC
	CreatedAt  time.Time // UTC (populated for items)
}

// VectorPathStats records the execution path and timeout outcome of a single
// corpus vector search branch (mirroring Task 14 store.PathStats).
type VectorPathStats struct {
	Path      string // "exact" | "ann" | "ann_fallback_exact" | "ann_short"
	Underfill bool
	TimedOut  bool
}

// VectorSearcher abstracts the per-corpus vector search execution (plan P05
// mục 2.16, 2.19, Task 12 / Task 14 seam).
//
// Contract (matching Task 14 store.VectorSearch):
//   - Returns ErrDimsMismatch before any SQL when len(qvec) != pin.Identity.Dims.
//   - On SQL statement_timeout (57014) or branch deadline exceeded, returns
//     partial/empty hits with PathStats{TimedOut: true} and err == nil.
//   - On caller context cancellation, returns context.Canceled.
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

// VectorTxStarter abstracts pgxpool.Pool.BeginTx for ExactVectorSearcher.
type VectorTxStarter interface {
	BeginTx(ctx context.Context, txOptions pgx.TxOptions) (pgx.Tx, error)
}

// ExactVectorSearcher is the minimal exact vector search implementation used
// by semantic.Runtime until Task 14 (store.VectorSearch with exact/ANN/underfill)
// merges (plan P05 Task 12, SPEC §6.3).
type ExactVectorSearcher struct {
	txStarter VectorTxStarter
}

// NewExactVectorSearcher constructs an ExactVectorSearcher over txStarter
// (typically *pgxpool.Pool).
func NewExactVectorSearcher(txStarter VectorTxStarter) *ExactVectorSearcher {
	return &ExactVectorSearcher{txStarter: txStarter}
}

// VectorSearch executes an exact cosine-similarity query against the pinned
// generation's table within a read-only transaction bounded by deadline.
func (s *ExactVectorSearcher) VectorSearch(
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
		return nil, VectorPathStats{}, ErrDimsMismatch
	}
	if err := ctx.Err(); err != nil {
		if errors.Is(err, context.Canceled) {
			return nil, VectorPathStats{}, context.Canceled
		}
		if isSQLOrBranchTimeout(err) {
			return nil, VectorPathStats{Path: "exact", TimedOut: true}, nil
		}
		return nil, VectorPathStats{}, err
	}
	if s == nil || s.txStarter == nil {
		return nil, VectorPathStats{Path: "exact"}, nil
	}
	if k <= 0 {
		k = DefaultNearCandidateK
	}

	ident, err := pin.TableIdent(corpus)
	if err != nil {
		return nil, VectorPathStats{}, err
	}
	tbl := ident.Sanitize()

	branchCtx := ctx
	var cancel context.CancelFunc
	if !deadline.IsZero() {
		branchCtx, cancel = context.WithDeadline(ctx, deadline)
		defer cancel()
	}

	tx, err := s.txStarter.BeginTx(branchCtx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		if isCallerCanceled(ctx, err) {
			return nil, VectorPathStats{}, context.Canceled
		}
		if isSQLOrBranchTimeout(err) {
			return nil, VectorPathStats{Path: "exact", TimedOut: true}, nil
		}
		return nil, VectorPathStats{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	timeoutMS := int64(DefaultVectorBranchTimeout / time.Millisecond)
	if knobs.VectorBranchTimeout > 0 {
		timeoutMS = max(1, knobs.VectorBranchTimeout.Milliseconds())
	}
	if !deadline.IsZero() {
		if rem := time.Until(deadline).Milliseconds(); rem > 0 && rem < timeoutMS {
			timeoutMS = rem
		}
	}
	if _, err := tx.Exec(branchCtx, fmt.Sprintf("SET LOCAL statement_timeout = '%dms'", timeoutMS)); err != nil {
		if isCallerCanceled(ctx, err) {
			return nil, VectorPathStats{}, context.Canceled
		}
		if isSQLOrBranchTimeout(err) {
			return nil, VectorPathStats{Path: "exact", TimedOut: true}, nil
		}
		return nil, VectorPathStats{}, err
	}

	vecParam := pgvector.NewVector(qvec)
	switch corpus {
	case generation.CorpusItem:
		query := `WITH tenant_vecs AS MATERIALIZED (
			SELECT target_id, embedding
			FROM ` + tbl + `
			WHERE user_id = $1
		)
		SELECT
			i.id,
			i.name,
			i.entry_count,
			i.last_used_at,
			i.created_at,
			(1 - (e.embedding <=> $2))::float8 AS cos_sim,
			(e.embedding <=> $2)::float8 AS dist
		FROM tenant_vecs e
		JOIN item i ON i.user_id = $1 AND i.id = e.target_id
		WHERE i.deleted_at IS NULL
		  AND (1 - (e.embedding <=> $2)) >= $3
		ORDER BY dist ASC, i.id ASC
		LIMIT $4`

		rows, err := tx.Query(branchCtx, query, userID, vecParam, pin.MinCos, k)
		if err != nil {
			if isCallerCanceled(ctx, err) {
				return nil, VectorPathStats{}, context.Canceled
			}
			if isSQLOrBranchTimeout(err) {
				return nil, VectorPathStats{Path: "exact", TimedOut: true}, nil
			}
			return nil, VectorPathStats{}, err
		}
		defer rows.Close()

		var hits []VectorHit
		for rows.Next() {
			var (
				h          VectorHit
				lastUsedAt time.Time
				createdAt  time.Time
			)
			if err := rows.Scan(&h.ID, &h.Name, &h.Count, &lastUsedAt, &createdAt, &h.Cos, &h.Dist); err != nil {
				if isCallerCanceled(ctx, err) {
					return nil, VectorPathStats{}, context.Canceled
				}
				if isSQLOrBranchTimeout(err) {
					return nil, VectorPathStats{Path: "exact", TimedOut: true}, nil
				}
				return nil, VectorPathStats{}, err
			}
			h.LastUsedAt = lastUsedAt.UTC()
			h.CreatedAt = createdAt.UTC()
			hits = append(hits, h)
		}
		if err := rows.Err(); err != nil {
			if isCallerCanceled(ctx, err) {
				return nil, VectorPathStats{}, context.Canceled
			}
			if isSQLOrBranchTimeout(err) {
				return nil, VectorPathStats{Path: "exact", TimedOut: true}, nil
			}
			return nil, VectorPathStats{}, err
		}
		return hits, VectorPathStats{Path: "exact"}, nil

	case generation.CorpusTag:
		query := `WITH tenant_vecs AS MATERIALIZED (
			SELECT target_id, embedding
			FROM ` + tbl + `
			WHERE user_id = $1
		)
		SELECT
			t.id,
			t.display,
			t.item_count,
			t.last_used_at,
			(1 - (e.embedding <=> $2))::float8 AS cos_sim,
			(e.embedding <=> $2)::float8 AS dist
		FROM tenant_vecs e
		JOIN tag t ON t.user_id = $1 AND t.id = e.target_id
		WHERE t.deleted_at IS NULL
		  AND (1 - (e.embedding <=> $2)) >= $3
		ORDER BY dist ASC, t.id ASC
		LIMIT $4`

		rows, err := tx.Query(branchCtx, query, userID, vecParam, pin.MinCos, k)
		if err != nil {
			if isCallerCanceled(ctx, err) {
				return nil, VectorPathStats{}, context.Canceled
			}
			if isSQLOrBranchTimeout(err) {
				return nil, VectorPathStats{Path: "exact", TimedOut: true}, nil
			}
			return nil, VectorPathStats{}, err
		}
		defer rows.Close()

		var hits []VectorHit
		for rows.Next() {
			var (
				h          VectorHit
				lastUsedAt time.Time
			)
			if err := rows.Scan(&h.ID, &h.Display, &h.Count, &lastUsedAt, &h.Cos, &h.Dist); err != nil {
				if isCallerCanceled(ctx, err) {
					return nil, VectorPathStats{}, context.Canceled
				}
				if isSQLOrBranchTimeout(err) {
					return nil, VectorPathStats{Path: "exact", TimedOut: true}, nil
				}
				return nil, VectorPathStats{}, err
			}
			h.LastUsedAt = lastUsedAt.UTC()
			hits = append(hits, h)
		}
		if err := rows.Err(); err != nil {
			if isCallerCanceled(ctx, err) {
				return nil, VectorPathStats{}, context.Canceled
			}
			if isSQLOrBranchTimeout(err) {
				return nil, VectorPathStats{Path: "exact", TimedOut: true}, nil
			}
			return nil, VectorPathStats{}, err
		}
		return hits, VectorPathStats{Path: "exact"}, nil

	default:
		return nil, VectorPathStats{}, generation.ErrInvalidCorpus
	}
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
