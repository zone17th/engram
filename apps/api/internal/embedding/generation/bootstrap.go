package generation

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
)

const (
	// BootstrapGenerationID is the fixed ID (1) of the bootstrap generation g1.
	BootstrapGenerationID = 1

	// DefaultPartitions is the default hash partition count per generation table.
	DefaultPartitions = 16

	// DefaultHnswM is the default HNSW m parameter.
	DefaultHnswM = 16

	// DefaultHnswEfConstruction is the default HNSW ef_construction parameter.
	DefaultHnswEfConstruction = 128
)

var (
	// ErrCalibrationMissing is returned by Bootstrap when CalibrationLookup
	// reports no valid calibration entry for the target identity (plan P05
	// mục 2.15, 2.20, Gate 5; ADR 0007 §8, §10).
	ErrCalibrationMissing = errors.New("generation: calibration missing for embedding identity")

	// ErrInvalidBootstrapIdentity is returned when the embedding identity has an
	// unsupported provider (e.g. "noop") or invalid dimensions/fields.
	ErrInvalidBootstrapIdentity = errors.New("generation: invalid bootstrap identity")
)

// BootstrapResult describes the outcome of calling Bootstrap.
type BootstrapResult struct {
	// Created is true when Bootstrap inserted g1 as pending (bootstrap=true) and
	// created its partitioned tables and HNSW indexes. False when a generation
	// row already existed (no-op).
	Created bool
	// Generation holds the newly created g1 row when Created is true.
	Generation Generation
}

// Bootstrap creates the initial generation g1 in state 'pending' with
// bootstrap=true, its 16 hash partitions, and per-partition HNSW indexes if and
// only if no row exists in embedding_generation and calib returns ok=true for
// ident (plan P05 mục 2.15, Task 6; BE-4, L8, FS-8, FS-23; ADR 0007 §8).
//
// It executes inside a single transaction holding LockGenerationSetExclusive:
//   - If any row already exists in embedding_generation (even retired/dropped),
//     it commits as a no-op (Result.Created = false, err = nil).
//   - If calib is nil or returns ok = false (or an invalid minCos / empty
//     reportPath), it rolls back without writing anything and returns
//     ErrCalibrationMissing.
//   - It does NOT activate g1 or send NOTIFY; auto-flip happens after verify in
//     the periodic embedding_bootstrap_flip job (Task 19).
func Bootstrap(
	ctx context.Context,
	pool *pgxpool.Pool,
	ident embedid.Identity,
	calib embedid.CalibrationLookup,
) (BootstrapResult, error) {
	if pool == nil {
		return BootstrapResult{}, ErrNilTx
	}
	if ident.Provider != ProviderTEI && ident.Provider != ProviderOpenAICompat {
		return BootstrapResult{}, fmt.Errorf("%w: unsupported provider %q", ErrInvalidBootstrapIdentity, ident.Provider)
	}
	if strings.TrimSpace(ident.Model) == "" ||
		strings.TrimSpace(ident.ModelVersion) == "" ||
		strings.TrimSpace(ident.Preprocessing) == "" {
		return BootstrapResult{}, fmt.Errorf("%w: model, model_version, and preprocessing are required", ErrInvalidBootstrapIdentity)
	}
	if ident.Dims < 1 || ident.Dims > 2000 {
		return BootstrapResult{}, fmt.Errorf("%w: dims %d out of range 1..2000", ErrInvalidBootstrapIdentity, ident.Dims)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return BootstrapResult{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if err := LockGenerationSetExclusive(ctx, tx); err != nil {
		return BootstrapResult{}, err
	}

	q := gen.New(tx)
	count, err := q.CountEmbeddingGenerations(ctx)
	if err != nil {
		return BootstrapResult{}, err
	}
	if count > 0 {
		if err := tx.Commit(ctx); err != nil {
			return BootstrapResult{}, err
		}
		return BootstrapResult{Created: false}, nil
	}

	if calib == nil {
		return BootstrapResult{}, ErrCalibrationMissing
	}
	minCos, reportPath, ok := calib(ident)
	if !ok || strings.TrimSpace(reportPath) == "" || minCos <= 0 || minCos >= 1 {
		return BootstrapResult{}, ErrCalibrationMissing
	}

	row, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 BootstrapGenerationID,
		Provider:           ident.Provider,
		Model:              ident.Model,
		ModelVersion:       ident.ModelVersion,
		Preprocessing:      ident.Preprocessing,
		QueryPrefix:        ident.QueryPrefix,
		DocPrefix:          ident.DocPrefix,
		Dims:               int32(ident.Dims),
		Partitions:         DefaultPartitions,
		HnswM:              DefaultHnswM,
		HnswEfConstruction: DefaultHnswEfConstruction,
		SemanticMinCos:     float32(minCos),
		CalibrationRef:     reportPath,
		Bootstrap:          true,
	})
	if err != nil {
		return BootstrapResult{}, err
	}

	if err := q.CreateEmbeddingGenerationTables(ctx, gen.CreateEmbeddingGenerationTablesParams{
		ID:                 BootstrapGenerationID,
		Dims:               int32(ident.Dims),
		Partitions:         DefaultPartitions,
		WithHnsw:           true,
		HnswM:              DefaultHnswM,
		HnswEfConstruction: DefaultHnswEfConstruction,
	}); err != nil {
		return BootstrapResult{}, err
	}

	g, err := FromDBRow(row)
	if err != nil {
		return BootstrapResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return BootstrapResult{}, err
	}
	return BootstrapResult{
		Created:    true,
		Generation: g,
	}, nil
}
