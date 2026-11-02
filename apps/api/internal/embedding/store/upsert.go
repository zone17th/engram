package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pgvector/pgvector-go"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

// StoredVector represents the metadata of an existing row in item_embedding_g<N>
// or tag_embedding_g<N>.
type StoredVector struct {
	UserID       uuid.UUID
	TargetID     uuid.UUID
	Model        string
	ModelVersion string
	InputHash    []byte
	EmbeddedAt   time.Time
}

// Upsert inserts or updates the embedding vector and input_hash for
// (userID, targetID) in the target generation's corpus table (plan P05 mục 2.15,
// 2.17; ADR 0007 §3).
//
// Pre-SQL checks:
//   - Validates the target table name via generation.TableIdent + pgx.Identifier.Sanitize().
//   - Verifies len(vec) == g.Dims (returns ErrDimsMismatch before touching the DB).
//   - Verifies len(hash) == 32 (returns ErrInvalidInputHash).
//
// Locking contract (plan P05 mục 2.15, OQ-16):
//   - Upsert does NOT acquire the content advisory lock or the generation-set
//     advisory lock.
//   - In worker embed jobs (step 5), the caller is responsible for acquiring
//     row-level locks in strict order BEFORE calling Upsert:
//     (1) target item or tag row FOR SHARE -> (2) app_user row FOR SHARE ->
//     (3) Upsert on the embedding row, after re-verifying input_hash,
//     deleted_at IS NULL, user semantic policy, and generation ∈ R.
func Upsert(
	ctx context.Context,
	tx gen.DBTX,
	g generation.Generation,
	kind generation.Corpus,
	userID uuid.UUID,
	targetID uuid.UUID,
	vec []float32,
	hash []byte,
) error {
	if tx == nil {
		return ErrNilDB
	}
	tbl, err := resolveTableSQL(g, kind)
	if err != nil {
		return err
	}
	if err := validateVectorDims(vec, g.Dims); err != nil {
		return err
	}
	if err := validateInputHash(hash); err != nil {
		return err
	}

	query := `INSERT INTO ` + tbl + ` (
		user_id, target_id, embedding, model, model_version, input_hash, embedded_at
	) VALUES (
		$1, $2, $3, $4, $5, $6, clock_timestamp()
	)
	ON CONFLICT (user_id, target_id) DO UPDATE SET
		embedding     = EXCLUDED.embedding,
		model         = EXCLUDED.model,
		model_version = EXCLUDED.model_version,
		input_hash    = EXCLUDED.input_hash,
		embedded_at   = clock_timestamp()`

	_, err = tx.Exec(ctx, query,
		userID,
		targetID,
		pgvector.NewVector(vec),
		g.Model,
		g.ModelVersion,
		hash,
	)
	return err
}

// GetTargetMeta reads the stored model, model_version, input_hash, and
// embedded_at for (userID, targetID) in generation g's corpus table. It returns
// ok=false, err=nil when no vector row exists for that target.
func GetTargetMeta(
	ctx context.Context,
	q gen.DBTX,
	g generation.Generation,
	kind generation.Corpus,
	userID uuid.UUID,
	targetID uuid.UUID,
) (StoredVector, bool, error) {
	if q == nil {
		return StoredVector{}, false, ErrNilDB
	}
	tbl, err := resolveTableSQL(g, kind)
	if err != nil {
		return StoredVector{}, false, err
	}

	query := `SELECT user_id, target_id, model, model_version, input_hash, embedded_at
		FROM ` + tbl + `
		WHERE user_id = $1 AND target_id = $2`

	var sv StoredVector
	err = q.QueryRow(ctx, query, userID, targetID).Scan(
		&sv.UserID,
		&sv.TargetID,
		&sv.Model,
		&sv.ModelVersion,
		&sv.InputHash,
		&sv.EmbeddedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return StoredVector{}, false, nil
		}
		return StoredVector{}, false, err
	}
	return sv, true, nil
}
