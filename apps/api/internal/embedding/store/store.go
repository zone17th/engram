// Package store provides hand-written dynamic-table vector storage operations
// (Upsert, DeleteTarget, DeleteUserExternal, ScanStale) across per-generation
// partitioned vector tables item_embedding_g<N> and tag_embedding_g<N> (plan
// P05 mục 2.15, 2.17, 2.18, Task 6; ADR 0007).
//
// Dynamic table safety (OQ-22, ADR 0007 §5):
//   - Every table name goes through generation.TableIdent /
//     generation.TableIdentFromName and pgx.Identifier.Sanitize().
//   - Table names are never constructed by raw string concatenation of user or
//     unvalidated inputs.
//   - Vector values are encoded via github.com/pgvector/pgvector-go (OQ-13).
//
// Import direction (M2/FS-24): store imports generation, embedid, internal/db/gen,
// pgx, pgvector-go, and stdlib; it never imports top-level internal/embedding,
// reconcile, jobs, or lifecycle.
package store

import (
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

const (
	// InputHashBytes is the required byte length (SHA-256 = 32 B) for input_hash.
	InputHashBytes = 32

	// DefaultScanLimit is the default page size for ScanStale when n <= 0 (plan
	// mục 2.17: Reconcile scans batches of 500).
	DefaultScanLimit = 500

	// MaxScanLimit caps ScanStale page size.
	MaxScanLimit = 5000
)

var (
	// ErrNilDB is returned when a nil database or transaction handle is passed.
	ErrNilDB = errors.New("store: nil database handle")

	// ErrDimsMismatch is returned before any SQL execution when len(vec) does
	// not match the target generation's configured Dims (plan P05 mục 2.15).
	ErrDimsMismatch = errors.New("store: vector length does not match generation dims")

	// ErrInvalidInputHash is returned when input_hash is not exactly 32 bytes.
	ErrInvalidInputHash = errors.New("store: input_hash must be 32 bytes")
)

func resolveTableSQL(g generation.Generation, kind generation.Corpus) (string, error) {
	ident, err := g.TableIdent(kind)
	if err != nil {
		return "", err
	}
	return ident.Sanitize(), nil
}

func validateVectorDims(vec []float32, dims int) error {
	if dims <= 0 || len(vec) != dims {
		return fmt.Errorf("%w: got %d, want %d", ErrDimsMismatch, len(vec), dims)
	}
	return nil
}

func validateInputHash(hash []byte) error {
	if len(hash) != InputHashBytes {
		return fmt.Errorf("%w: got %d bytes", ErrInvalidInputHash, len(hash))
	}
	return nil
}

// SanitizedTable returns the validated and pgx.Identifier.Sanitize()-quoted SQL
// identifier for generation g and corpus kind.
func SanitizedTable(g generation.Generation, kind generation.Corpus) (string, error) {
	var ident pgx.Identifier
	var err error
	ident, err = g.TableIdent(kind)
	if err != nil {
		return "", err
	}
	return ident.Sanitize(), nil
}
