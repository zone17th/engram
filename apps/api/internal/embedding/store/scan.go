package store

import (
	"context"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

// ScanCursor represents the keyset pagination cursor (UserID, TargetID) for
// ScanStale, ScanOrphans, and ScanUserOffVectors. A zero value (or nil pointer)
// starts from the beginning.
type ScanCursor struct {
	UserID   uuid.UUID
	TargetID uuid.UUID
}

// Valid reports whether c has a non-zero cursor position.
func (c *ScanCursor) Valid() bool {
	return c != nil && (c.UserID != uuid.Nil || c.TargetID != uuid.Nil)
}

// ScanTargetRow represents a live target (item or tag) of an eligible user
// paired with its current vector metadata (if any) in the scanned generation.
//
// Contract for Reconcile (Task 15, plan P05 mục 2.15, 2.17):
//   - For kind == CorpusItem: Name is item.name and Hint is item.hint (nil if NULL).
//   - For kind == CorpusTag: Display is tag.display.
//   - InputHash is the stored 32-byte input_hash from the generation's vector
//     table, or nil when no vector row exists for (UserID, TargetID).
//   - Model and ModelVersion are the stored model and model_version from the
//     generation's vector table (empty when InputHash == nil).
//   - Rows are ordered strictly by (UserID ASC, TargetID ASC) so callers can
//     page with ScanCursor{UserID: last.UserID, TargetID: last.TargetID}.
type ScanTargetRow struct {
	UserID       uuid.UUID
	TargetID     uuid.UUID
	Name         string
	Hint         *string
	Display      string
	InputHash    []byte
	Model        string
	ModelVersion string
}

// HasVector reports whether a vector row currently exists for this target in
// the scanned generation.
func (r ScanTargetRow) HasVector() bool {
	return len(r.InputHash) > 0
}

// ScanStale scans a keyset page of up to n live targets (deleted_at IS NULL) in
// corpus kind for eligible users (app_user.deleted_at IS NULL, and when
// g.Provider == 'openai_compat', coalesce((u.settings->>'semantic_suggest')::boolean, true) = true
// per BE-3), LEFT JOINed with generation g's vector table (plan P05 mục 2.15,
// 2.17, Task 6).
//
// Every returned row includes the live plaintext fields needed by Reconcile
// (Task 15) to compute the expected input_hash (Name + Hint for items, Display
// for tags) alongside the stored InputHash (nil if missing), Model, and
// ModelVersion so the caller can compare hash/model/model_version and decide
// whether the target is missing, stale, or fresh.
//
// Parameters:
//   - cursor: optional keyset position (UserID, TargetID); nil or zero starts at the first row.
//   - userFilter: optional single-user filter (for Reconcile(User)); nil or uuid.Nil scans all eligible users.
//   - n: page size (defaults to DefaultScanLimit = 500 when n <= 0; capped at MaxScanLimit = 5000).
//
// Results are ordered by (UserID ASC, TargetID ASC). Every table name is
// validated via generation.TableIdent + pgx.Identifier.Sanitize().
func ScanStale(
	ctx context.Context,
	q gen.DBTX,
	g generation.Generation,
	kind generation.Corpus,
	cursor *ScanCursor,
	userFilter *uuid.UUID,
	n int,
) ([]ScanTargetRow, error) {
	if q == nil {
		return nil, ErrNilDB
	}
	tbl, err := resolveTableSQL(g, kind)
	if err != nil {
		return nil, err
	}

	limit := normalizeScanLimit(n)
	hasCursor := cursor.Valid()
	var curUser, curTarget uuid.UUID
	if hasCursor {
		curUser = cursor.UserID
		curTarget = cursor.TargetID
	}

	hasUserFilter := userFilter != nil && *userFilter != uuid.Nil
	var filterUID uuid.UUID
	if hasUserFilter {
		filterUID = *userFilter
	}

	requireUserSuggestOn := g.Provider == generation.ProviderOpenAICompat

	switch kind {
	case generation.CorpusItem:
		query := `SELECT
				t.user_id,
				t.id AS target_id,
				t.name,
				t.hint,
				e.input_hash,
				COALESCE(e.model, '') AS model,
				COALESCE(e.model_version, '') AS model_version
			FROM item t
			JOIN app_user u ON u.id = t.user_id AND u.deleted_at IS NULL
			LEFT JOIN ` + tbl + ` e ON e.user_id = t.user_id AND e.target_id = t.id
			WHERE t.deleted_at IS NULL
			  AND (NOT $1::boolean OR COALESCE((u.settings->>'semantic_suggest')::boolean, true) = true)
			  AND (NOT $2::boolean OR t.user_id = $3::uuid)
			  AND (NOT $4::boolean OR (t.user_id, t.id) > ($5::uuid, $6::uuid))
			ORDER BY t.user_id ASC, t.id ASC
			LIMIT $7`

		rows, err := q.Query(ctx, query,
			requireUserSuggestOn,
			hasUserFilter, filterUID,
			hasCursor, curUser, curTarget,
			limit,
		)
		if err != nil {
			return nil, err
		}
		defer rows.Close()

		var out []ScanTargetRow
		for rows.Next() {
			var r ScanTargetRow
			if err := rows.Scan(
				&r.UserID,
				&r.TargetID,
				&r.Name,
				&r.Hint,
				&r.InputHash,
				&r.Model,
				&r.ModelVersion,
			); err != nil {
				return nil, err
			}
			out = append(out, r)
		}
		return out, rows.Err()

	case generation.CorpusTag:
		query := `SELECT
				t.user_id,
				t.id AS target_id,
				t.display,
				e.input_hash,
				COALESCE(e.model, '') AS model,
				COALESCE(e.model_version, '') AS model_version
			FROM tag t
			JOIN app_user u ON u.id = t.user_id AND u.deleted_at IS NULL
			LEFT JOIN ` + tbl + ` e ON e.user_id = t.user_id AND e.target_id = t.id
			WHERE t.deleted_at IS NULL
			  AND (NOT $1::boolean OR COALESCE((u.settings->>'semantic_suggest')::boolean, true) = true)
			  AND (NOT $2::boolean OR t.user_id = $3::uuid)
			  AND (NOT $4::boolean OR (t.user_id, t.id) > ($5::uuid, $6::uuid))
			ORDER BY t.user_id ASC, t.id ASC
			LIMIT $7`

		rows, err := q.Query(ctx, query,
			requireUserSuggestOn,
			hasUserFilter, filterUID,
			hasCursor, curUser, curTarget,
			limit,
		)
		if err != nil {
			return nil, err
		}
		defer rows.Close()

		var out []ScanTargetRow
		for rows.Next() {
			var r ScanTargetRow
			if err := rows.Scan(
				&r.UserID,
				&r.TargetID,
				&r.Display,
				&r.InputHash,
				&r.Model,
				&r.ModelVersion,
			); err != nil {
				return nil, err
			}
			out = append(out, r)
		}
		return out, rows.Err()

	default:
		return nil, generation.ErrInvalidCorpus
	}
}

// OrphanVectorRow identifies a vector row in generation g whose underlying item
// or tag is soft-deleted (deleted_at IS NOT NULL) or missing.
type OrphanVectorRow struct {
	UserID   uuid.UUID
	TargetID uuid.UUID
}

// ScanOrphans returns a keyset page of up to n vector rows in generation g's
// corpus table whose target item/tag has been soft-deleted (deleted_at IS NOT NULL),
// ordered by (UserID ASC, TargetID ASC). Used by Reconcile (Task 15) and Verify
// (Task 19).
func ScanOrphans(
	ctx context.Context,
	q gen.DBTX,
	g generation.Generation,
	kind generation.Corpus,
	cursor *ScanCursor,
	userFilter *uuid.UUID,
	n int,
) ([]OrphanVectorRow, error) {
	if q == nil {
		return nil, ErrNilDB
	}
	tbl, err := resolveTableSQL(g, kind)
	if err != nil {
		return nil, err
	}
	targetTbl := "item"
	if kind == generation.CorpusTag {
		targetTbl = "tag"
	}

	limit := normalizeScanLimit(n)
	hasCursor := cursor.Valid()
	var curUser, curTarget uuid.UUID
	if hasCursor {
		curUser = cursor.UserID
		curTarget = cursor.TargetID
	}

	hasUserFilter := userFilter != nil && *userFilter != uuid.Nil
	var filterUID uuid.UUID
	if hasUserFilter {
		filterUID = *userFilter
	}

	query := `SELECT e.user_id, e.target_id
		FROM ` + tbl + ` e
		LEFT JOIN ` + targetTbl + ` t ON t.user_id = e.user_id AND t.id = e.target_id
		WHERE (t.id IS NULL OR t.deleted_at IS NOT NULL)
		  AND (NOT $1::boolean OR e.user_id = $2::uuid)
		  AND (NOT $3::boolean OR (e.user_id, e.target_id) > ($4::uuid, $5::uuid))
		ORDER BY e.user_id ASC, e.target_id ASC
		LIMIT $6`

	rows, err := q.Query(ctx, query,
		hasUserFilter, filterUID,
		hasCursor, curUser, curTarget,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []OrphanVectorRow
	for rows.Next() {
		var r OrphanVectorRow
		if err := rows.Scan(&r.UserID, &r.TargetID); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func normalizeScanLimit(n int) int {
	if n <= 0 {
		return DefaultScanLimit
	}
	if n > MaxScanLimit {
		return MaxScanLimit
	}
	return n
}
