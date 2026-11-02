package generation

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
)

// State constants for embedding_generation.state (plan P05 mục 2.15).
const (
	StatePending = "pending"
	StateActive  = "active"
	StateRetired = "retired"
	StateDropped = "dropped"
)

// Provider constants for embedding_generation.provider (plan P05 mục 2.12, 2.15).
const (
	ProviderTEI          = "tei"
	ProviderOpenAICompat = "openai_compat"
)

// ErrGenerationNotFound is returned when a requested generation ID does not exist.
var ErrGenerationNotFound = errors.New("generation: embedding generation not found")

// Generation represents a validated row from embedding_generation (plan P05
// mục 2.15, ADR 0007).
type Generation struct {
	ID                 int
	Provider           string
	Model              string
	ModelVersion       string
	Preprocessing      string
	QueryPrefix        string
	DocPrefix          string
	Dims               int
	Partitions         int
	HnswM              int
	HnswEfConstruction int
	SemanticMinCos     float64
	CalibrationRef     string
	Canary             []byte
	ItemTable          string
	TagTable           string
	State              string
	Bootstrap          bool
	RollbackUntil      *time.Time
	IndexReady         bool
	VerifiedAt         *time.Time
	VerifyReport       []byte
	CreatedAt          time.Time
	ActivatedAt        *time.Time
	RetiredAt          *time.Time
	DroppedAt          *time.Time
}

// Identity returns the full seven-field embedid.Identity for g, populated
// directly from this generation row (plan P05 mục 2.12, 2.15; M1, BE-13).
func (g Generation) Identity() embedid.Identity {
	return embedid.Identity{
		Provider:      g.Provider,
		Model:         g.Model,
		ModelVersion:  g.ModelVersion,
		Dims:          g.Dims,
		QueryPrefix:   g.QueryPrefix,
		DocPrefix:     g.DocPrefix,
		Preprocessing: g.Preprocessing,
	}
}

// TableIdent validates and returns the pgx.Identifier for corpus ("item" or "tag")
// on this generation. It verifies both the derived name from g.ID and the stored
// table column (g.ItemTable / g.TagTable) when non-empty.
func (g Generation) TableIdent(corpus Corpus) (pgx.Identifier, error) {
	switch corpus {
	case CorpusItem:
		if g.ItemTable != "" {
			return TableIdentFromName(g.ID, CorpusItem, g.ItemTable)
		}
		return TableIdent(g.ID, CorpusItem)
	case CorpusTag:
		if g.TagTable != "" {
			return TableIdentFromName(g.ID, CorpusTag, g.TagTable)
		}
		return TableIdent(g.ID, CorpusTag)
	default:
		return nil, fmt.Errorf("%w: %q", ErrInvalidCorpus, corpus)
	}
}

// FromDBRow converts a sqlc gen.EmbeddingGeneration row into a Generation and
// validates its stored item_table and tag_table names against the allowlist and
// derived generation ID before returning.
func FromDBRow(row gen.EmbeddingGeneration) (Generation, error) {
	id := int(row.ID)
	if err := ValidateRowTableNames(id, row.ItemTable, row.TagTable); err != nil {
		return Generation{}, err
	}
	g := Generation{
		ID:                 id,
		Provider:           row.Provider,
		Model:              row.Model,
		ModelVersion:       row.ModelVersion,
		Preprocessing:      row.Preprocessing,
		QueryPrefix:        row.QueryPrefix,
		DocPrefix:          row.DocPrefix,
		Dims:               int(row.Dims),
		Partitions:         int(row.Partitions),
		HnswM:              int(row.HnswM),
		HnswEfConstruction: int(row.HnswEfConstruction),
		SemanticMinCos:     float64(row.SemanticMinCos),
		CalibrationRef:     row.CalibrationRef,
		Canary:             row.Canary,
		ItemTable:          row.ItemTable,
		TagTable:           row.TagTable,
		State:              row.State,
		Bootstrap:          row.Bootstrap,
		IndexReady:         row.IndexReady,
		VerifyReport:       row.VerifyReport,
		CreatedAt:          row.CreatedAt.Time,
	}
	if row.RollbackUntil.Valid {
		t := row.RollbackUntil.Time
		g.RollbackUntil = &t
	}
	if row.VerifiedAt.Valid {
		t := row.VerifiedAt.Time
		g.VerifiedAt = &t
	}
	if row.ActivatedAt.Valid {
		t := row.ActivatedAt.Time
		g.ActivatedAt = &t
	}
	if row.RetiredAt.Valid {
		t := row.RetiredAt.Time
		g.RetiredAt = &t
	}
	if row.DroppedAt.Valid {
		t := row.DroppedAt.Time
		g.DroppedAt = &t
	}
	return g, nil
}

func fromDBRows(rows []gen.EmbeddingGeneration) ([]Generation, error) {
	out := make([]Generation, 0, len(rows))
	for _, r := range rows {
		g, err := FromDBRow(r)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, nil
}

// GetByID reads a single generation row by ID and validates its table names.
func GetByID(ctx context.Context, db gen.DBTX, id int) (Generation, error) {
	if db == nil {
		return Generation{}, ErrNilTx
	}
	row, err := gen.New(db).GetEmbeddingGenerationByID(ctx, int32(id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Generation{}, ErrGenerationNotFound
		}
		return Generation{}, err
	}
	return FromDBRow(row)
}

// ReceivingGenerations returns the receiving set
// R = {active} ∪ {pending} ∪ {retired with rollback_until > now()} ordered by
// ID ascending (plan P05 mục 2.15, ADR 0007 §3).
//
// Callers in mutation transactions MUST acquire LockGenerationSetShared(ctx, tx)
// before calling ReceivingGenerations.
func ReceivingGenerations(ctx context.Context, tx gen.DBTX) ([]Generation, error) {
	if tx == nil {
		return nil, ErrNilTx
	}
	rows, err := gen.New(tx).ListReceivingEmbeddingGenerations(ctx)
	if err != nil {
		return nil, err
	}
	return fromDBRows(rows)
}

// ExistingGenerations returns every generation whose vector tables still exist
// (state <> 'dropped'), ordered by ID ascending (plan P05 mục 2.15, ADR 0007 §3).
// Soft-delete vector cleanup uses ExistingGenerations rather than R so retired
// generations past their rollback window never retain deleted targets' vectors.
func ExistingGenerations(ctx context.Context, tx gen.DBTX) ([]Generation, error) {
	if tx == nil {
		return nil, ErrNilTx
	}
	rows, err := gen.New(tx).ListExistingEmbeddingGenerations(ctx)
	if err != nil {
		return nil, err
	}
	return fromDBRows(rows)
}

// ExistingExternalGenerations returns every generation with state <> 'dropped'
// and provider = 'openai_compat', ordered by ID ascending (plan P05 mục 2.15,
// 2.18; BE-3).
func ExistingExternalGenerations(ctx context.Context, tx gen.DBTX) ([]Generation, error) {
	if tx == nil {
		return nil, ErrNilTx
	}
	rows, err := gen.New(tx).ListExistingExternalEmbeddingGenerations(ctx)
	if err != nil {
		return nil, err
	}
	return fromDBRows(rows)
}
