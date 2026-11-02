package generation_test

import (
	"context"
	"errors"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

func sampleBootstrapIdentity() embedid.Identity {
	return embedid.Identity{
		Provider:      generation.ProviderOpenAICompat,
		Model:         "openai_compat/openrouter/qwen/qwen3-embedding-8b",
		ModelVersion:  "dims=3;instr=abcd1234",
		Dims:          3,
		QueryPrefix:   "Instruct: Given a short search query, retrieve matching item names or tags\nQuery:",
		DocPrefix:     "passage: ",
		Preprocessing: "v1",
	}
}

func TestBootstrapCreatesPendingOnce(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	ident := sampleBootstrapIdentity()

	calib := func(got embedid.Identity) (float64, string, bool) {
		if got.Key() != ident.Key() {
			return 0, "", false
		}
		return 0.58, "docs/benchmarks/semantic-eval/report-qwen3-3-20261102.json", true
	}

	res1, err := generation.Bootstrap(ctx, pool, ident, calib)
	if err != nil {
		t.Fatalf("first Bootstrap: %v", err)
	}
	if !res1.Created {
		t.Fatal("first Bootstrap: expected Created=true")
	}
	if res1.Generation.ID != 1 ||
		res1.Generation.State != generation.StatePending ||
		!res1.Generation.Bootstrap ||
		res1.Generation.Identity().Key() != ident.Key() ||
		res1.Generation.CalibrationRef != "docs/benchmarks/semantic-eval/report-qwen3-3-20261102.json" {
		t.Fatalf("first Bootstrap generation mismatch: %+v", res1.Generation)
	}

	// Verify g1 is NOT active yet (no row in embedding_active).
	pinner := generation.NewPinner(pool)
	if _, err := pinner.ActivePin(ctx); !errors.Is(err, generation.ErrNoActiveGeneration) {
		t.Fatalf("ActivePin after Bootstrap = %v, want ErrNoActiveGeneration", err)
	}

	// Verify g1 IS in ReceivingGenerations (R includes pending).
	receiving, err := generation.ReceivingGenerations(ctx, pool)
	if err != nil {
		t.Fatalf("ReceivingGenerations: %v", err)
	}
	if len(receiving) != 1 || receiving[0].ID != 1 || !receiving[0].Bootstrap {
		t.Fatalf("ReceivingGenerations = %+v, want [g1 bootstrap pending]", receiving)
	}

	// Verify 16 item partitions + 16 tag partitions and 32 HNSW indexes exist.
	var partCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'item_embedding_g1_p%' OR table_name LIKE 'tag_embedding_g1_p%'`,
	).Scan(&partCount); err != nil || partCount != 32 {
		t.Fatalf("partition count = %d err=%v, want 32 (16 item + 16 tag)", partCount, err)
	}
	var hnswCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM pg_indexes WHERE indexname LIKE 'item_embedding_g1_p%_hnsw' OR indexname LIKE 'tag_embedding_g1_p%_hnsw'`,
	).Scan(&hnswCount); err != nil || hnswCount != 32 {
		t.Fatalf("HNSW index count = %d err=%v, want 32", hnswCount, err)
	}

	// Calling Bootstrap a second time is an idempotent no-op.
	res2, err := generation.Bootstrap(ctx, pool, ident, calib)
	if err != nil {
		t.Fatalf("second Bootstrap: %v", err)
	}
	if res2.Created {
		t.Fatal("second Bootstrap: expected Created=false")
	}

	totalCount, err := gen.New(pool).CountEmbeddingGenerations(ctx)
	if err != nil || totalCount != 1 {
		t.Fatalf("CountEmbeddingGenerations = %d err=%v, want 1", totalCount, err)
	}
}

func TestBootstrapRefusesWithoutCalibration(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	ident := sampleBootstrapIdentity()

	// 1. CalibrationLookup returns ok=false.
	_, err := generation.Bootstrap(ctx, pool, ident, func(embedid.Identity) (float64, string, bool) {
		return 0, "", false
	})
	if !errors.Is(err, generation.ErrCalibrationMissing) {
		t.Fatalf("Bootstrap with ok=false: err=%v, want ErrCalibrationMissing", err)
	}

	// 2. Nil CalibrationLookup.
	_, err = generation.Bootstrap(ctx, pool, ident, nil)
	if !errors.Is(err, generation.ErrCalibrationMissing) {
		t.Fatalf("Bootstrap with nil calib: err=%v, want ErrCalibrationMissing", err)
	}

	// 3. Provider = noop rejected before writing anything.
	noopIdent := ident
	noopIdent.Provider = "noop"
	_, err = generation.Bootstrap(ctx, pool, noopIdent, func(embedid.Identity) (float64, string, bool) {
		return 0.5, "report.json", true
	})
	if !errors.Is(err, generation.ErrInvalidBootstrapIdentity) {
		t.Fatalf("Bootstrap with provider=noop: err=%v, want ErrInvalidBootstrapIdentity", err)
	}

	// Verify nothing was written to embedding_generation or tables.
	count, err := gen.New(pool).CountEmbeddingGenerations(ctx)
	if err != nil || count != 0 {
		t.Fatalf("CountEmbeddingGenerations = %d err=%v, want 0", count, err)
	}
	var gTables int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'item_embedding_g%' OR table_name LIKE 'tag_embedding_g%'`,
	).Scan(&gTables); err != nil || gTables != 0 {
		t.Fatalf("g<N> tables count = %d err=%v, want 0", gTables, err)
	}
}

func TestBootstrapSkipsWhenGenerationExists(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	// Pre-populate a generation row (even a retired/dropped one).
	if _, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 1,
		Provider:           generation.ProviderTEI,
		Model:              "tei/BAAI/bge-m3",
		ModelVersion:       "v1",
		Preprocessing:      "v1",
		QueryPrefix:        "",
		DocPrefix:          "",
		Dims:               3,
		Partitions:         4,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.55,
		CalibrationRef:     "docs/benchmarks/semantic-eval/report-bge.json",
		Bootstrap:          false,
	}); err != nil {
		t.Fatalf("seed g1: %v", err)
	}
	if _, err := q.MarkEmbeddingGenerationDropped(ctx, 1); err != nil {
		t.Fatalf("MarkEmbeddingGenerationDropped g1: %v", err)
	}

	// Bootstrap must be a no-op when any generation row already exists, even if
	// calibration would fail.
	calibCalled := false
	res, err := generation.Bootstrap(ctx, pool, sampleBootstrapIdentity(), func(embedid.Identity) (float64, string, bool) {
		calibCalled = true
		return 0, "", false
	})
	if err != nil {
		t.Fatalf("Bootstrap when generation exists: %v", err)
	}
	if res.Created {
		t.Fatal("Bootstrap when generation exists: expected Created=false")
	}
	if calibCalled {
		t.Fatal("expected Bootstrap to short-circuit before calling calib when generation exists")
	}

	count, err := q.CountEmbeddingGenerations(ctx)
	if err != nil || count != 1 {
		t.Fatalf("CountEmbeddingGenerations = %d err=%v, want 1", count, err)
	}
}
