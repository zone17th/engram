package generation

import (
	"context"
	"errors"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
)

// GenerationSetLockKey is the single exported Postgres transaction-level
// advisory lock key protecting the embedding generation set R and lifecycle
// transitions (plan P05 mục 2.15, OQ-16, ADR 0007 §3).
//
// Protocol:
//   - Every mutation transaction that enqueues embedding jobs or deletes vectors
//     acquires LockGenerationSetShared(ctx, tx) BEFORE reading R.
//   - Lifecycle operations (Bootstrap, create, flip, rollback, retire, drop, and
//     capturing verification watermark W) acquire LockGenerationSetExclusive(ctx, tx).
//
// Value: ASCII "ENGMGEN1" = 0x454e474d47454e31.
const GenerationSetLockKey int64 = 0x454e474d47454e31

// ErrNilTx is returned when a lock or registry operation that requires a
// database handle receives nil.
var ErrNilTx = errors.New("generation: nil database handle")

// LockGenerationSetShared acquires pg_advisory_xact_lock_shared on
// GenerationSetLockKey for the duration of tx.
func LockGenerationSetShared(ctx context.Context, tx gen.DBTX) error {
	if tx == nil {
		return ErrNilTx
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared($1)`, GenerationSetLockKey)
	return err
}

// LockGenerationSetExclusive acquires pg_advisory_xact_lock (exclusive) on
// GenerationSetLockKey for the duration of tx.
func LockGenerationSetExclusive(ctx context.Context, tx gen.DBTX) error {
	if tx == nil {
		return ErrNilTx
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, GenerationSetLockKey)
	return err
}
