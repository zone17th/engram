package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pgvector/pgvector-go"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

func counterValue(t *testing.T, c prometheus.Collector) float64 {
	t.Helper()
	ch := make(chan prometheus.Metric, 1)
	c.Collect(ch)
	close(ch)
	m, ok := <-ch
	if !ok {
		t.Fatal("collector produced no metric")
	}
	var pb dto.Metric
	if err := m.Write(&pb); err != nil {
		t.Fatalf("metric.Write: %v", err)
	}
	if pb.GetCounter() == nil {
		t.Fatal("metric is not a counter")
	}
	return pb.GetCounter().GetValue()
}

func seedGenerationForVectorSearch(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	id int,
	dims int,
	partitions int,
	minCos float32,
	withHNSW bool,
) (generation.Generation, generation.Pin) {
	t.Helper()
	q := gen.New(pool)

	row, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 int32(id),
		Provider:           generation.ProviderTEI,
		Model:              "tei/model-g" + string(rune('0'+id)),
		ModelVersion:       "v1",
		Preprocessing:      "v1",
		QueryPrefix:        "",
		DocPrefix:          "",
		Dims:               int32(dims),
		Partitions:         int32(partitions),
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     minCos,
		CalibrationRef:     "docs/benchmarks/semantic-eval/report.json",
		Bootstrap:          id == 1,
	})
	if err != nil {
		t.Fatalf("InsertPendingEmbeddingGeneration g%d: %v", id, err)
	}
	if err := q.CreateEmbeddingGenerationTables(ctx, gen.CreateEmbeddingGenerationTablesParams{
		ID:                 int32(id),
		Dims:               int32(dims),
		Partitions:         int32(partitions),
		WithHnsw:           withHNSW,
		HnswM:              16,
		HnswEfConstruction: 64,
	}); err != nil {
		t.Fatalf("CreateEmbeddingGenerationTables g%d: %v", id, err)
	}
	row, err = q.ActivateEmbeddingGeneration(ctx, int32(id))
	if err != nil {
		t.Fatalf("ActivateEmbeddingGeneration g%d: %v", id, err)
	}
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
		GenerationID:  int32(id),
		FlippedReason: new("test"),
	}); err != nil {
		t.Fatalf("UpsertEmbeddingActive g%d: %v", id, err)
	}

	g, err := generation.FromDBRow(row)
	if err != nil {
		t.Fatalf("FromDBRow g%d: %v", id, err)
	}
	pin, err := generation.PinFromGeneration(g)
	if err != nil {
		t.Fatalf("PinFromGeneration g%d: %v", id, err)
	}
	return g, pin
}

func explainContainsHNSW(v any) bool {
	switch node := v.(type) {
	case map[string]any:
		if idx, ok := node["Index Name"].(string); ok {
			if strings.Contains(strings.ToLower(idx), "hnsw") {
				return true
			}
		}
		for _, child := range node {
			if explainContainsHNSW(child) {
				return true
			}
		}
	case []any:
		for _, elem := range node {
			if explainContainsHNSW(elem) {
				return true
			}
		}
	}
	return false
}

func TestExactBelowThresholdNoHNSW(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	// Create g1 WITH per-partition HNSW indexes enabled so the planner has an
	// HNSW index available, then prove that ExactSearchSQL's MATERIALIZED PK
	// pre-selection CTE blocks the planner from using any *_hnsw index.
	g1, pin := seedGenerationForVectorSearch(t, ctx, pool, 1, 3, 4, 0.50, true)

	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "exact-nohnsw@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}

	hash := makeHash(0x61)
	itemMatch, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u.ID,
		Name:           "Exact Match Item",
		NameNormalized: "exact match item",
	})
	if err != nil {
		t.Fatal(err)
	}
	itemLowCos, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u.ID,
		Name:           "Orthogonal Item",
		NameNormalized: "orthogonal item",
	})
	if err != nil {
		t.Fatal(err)
	}
	tagMatch, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     u.ID,
		Display:    "ExactTag",
		Normalized: "exacttag",
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, u.ID, itemMatch.ID, []float32{1, 0, 0}, hash); err != nil {
		t.Fatal(err)
	}
	if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, u.ID, itemLowCos.ID, []float32{0, 1, 0}, hash); err != nil {
		t.Fatal(err)
	}
	if err := store.Upsert(ctx, pool, g1, generation.CorpusTag, u.ID, tagMatch.ID, []float32{1, 0, 0}, hash); err != nil {
		t.Fatal(err)
	}

	// Verify EXPLAIN (FORMAT JSON, COSTS OFF) on ExactSearchSQL (even with
	// enable_seqscan = off inside a read-only transaction to tempt index usage)
	// never touches any *_hnsw index for either corpus.
	for _, corpus := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		ident, err := pin.TableIdent(corpus)
		if err != nil {
			t.Fatal(err)
		}
		sqlStr, err := store.ExactSearchSQL(ident.Sanitize(), corpus)
		if err != nil {
			t.Fatal(err)
		}

		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `SET LOCAL enable_seqscan = off`); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
		var rawPlan []byte
		if err := tx.QueryRow(ctx,
			`EXPLAIN (FORMAT JSON, COSTS OFF) `+sqlStr,
			u.ID,
			pgvector.NewVector([]float32{1, 0, 0}),
			pin.MinCos,
			10,
		).Scan(&rawPlan); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("EXPLAIN exact (%s): %v", corpus, err)
		}
		_ = tx.Rollback(ctx)

		var planPayload []map[string]any
		if err := json.Unmarshal(rawPlan, &planPayload); err != nil {
			t.Fatalf("unmarshal EXPLAIN JSON (%s): %v\nRaw:\n%s", corpus, err, string(rawPlan))
		}
		if explainContainsHNSW(planPayload) {
			t.Fatalf("expected ExactSearchSQL (%s) plan to contain NO hnsw index, got plan:\n%s", corpus, string(rawPlan))
		}
	}

	// Execute VectorSearch below ExactMaxVectors (2 <= 5) and verify path "exact" + metric delta.
	_, m := obs.NewRegistry()
	knobs := store.DefaultVectorSearchKnobs()
	knobs.ExactMaxVectors = 5
	knobs.FallbackMaxVectors = 10
	knobs.Metrics = m.Search

	beforeExact := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "exact"))
	beforeUnderfill := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item"))

	hits, stats, err := store.VectorSearch(
		ctx,
		pool,
		pin,
		u.ID,
		generation.CorpusItem,
		[]float32{1, 0, 0},
		10,
		time.Now().Add(2*time.Second),
		knobs,
	)
	if err != nil {
		t.Fatalf("VectorSearch exact: %v", err)
	}
	if stats.Path != store.VectorPathExact {
		t.Fatalf("stats.Path = %q, want %q", stats.Path, store.VectorPathExact)
	}
	if stats.CappedCount != 2 {
		t.Fatalf("stats.CappedCount = %d, want 2", stats.CappedCount)
	}
	if len(hits) != 1 || hits[0].ID != itemMatch.ID {
		t.Fatalf("hits = %+v, want [itemMatch %s]", hits, itemMatch.ID)
	}
	if got := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "exact")) - beforeExact; got != 1 {
		t.Fatalf("VectorPathTotal{item,exact} delta = %v, want 1", got)
	}
	if got := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item")) - beforeUnderfill; got != 0 {
		t.Fatalf("VectorUnderfillTotal{item} delta = %v, want 0", got)
	}
}

func TestSoftDeletedNeverReturned(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	g1, pin := seedGenerationForVectorSearch(t, ctx, pool, 1, 3, 4, 0.50, true)

	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "softdel@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}

	hash := makeHash(0x62)
	liveItem, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u.ID,
		Name:           "Live Item",
		NameNormalized: "live item",
	})
	if err != nil {
		t.Fatal(err)
	}
	delItem, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u.ID,
		Name:           "Deleted Item",
		NameNormalized: "deleted item",
	})
	if err != nil {
		t.Fatal(err)
	}
	liveTag, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     u.ID,
		Display:    "LiveTag",
		Normalized: "livetag",
	})
	if err != nil {
		t.Fatal(err)
	}
	delTag, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     u.ID,
		Display:    "DeletedTag",
		Normalized: "deletedtag",
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, id := range []uuid.UUID{liveItem.ID, delItem.ID} {
		if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, u.ID, id, []float32{1, 0, 0}, hash); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []uuid.UUID{liveTag.ID, delTag.ID} {
		if err := store.Upsert(ctx, pool, g1, generation.CorpusTag, u.ID, id, []float32{1, 0, 0}, hash); err != nil {
			t.Fatal(err)
		}
	}

	// Soft-delete delItem and delTag in the primary tables while leaving their
	// vector rows in item_embedding_g1 / tag_embedding_g1 (simulating a stale
	// or in-flight state). Both exact and ANN paths must filter them out via
	// `deleted_at IS NULL`.
	if _, err := pool.Exec(ctx, `UPDATE item SET deleted_at = now() WHERE user_id = $1 AND id = $2`, u.ID, delItem.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tag SET deleted_at = now() WHERE user_id = $1 AND id = $2`, u.ID, delTag.ID); err != nil {
		t.Fatal(err)
	}

	// 1. Exact path (ExactMaxVectors = 10 >= count 2).
	exactKnobs := store.DefaultVectorSearchKnobs()
	exactKnobs.ExactMaxVectors = 10
	exactKnobs.FallbackMaxVectors = 20

	itemHitsExact, itemStatsExact, err := store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusItem, []float32{1, 0, 0}, 5, time.Now().Add(2*time.Second), exactKnobs,
	)
	if err != nil {
		t.Fatalf("exact item VectorSearch: %v", err)
	}
	if itemStatsExact.Path != store.VectorPathExact {
		t.Fatalf("itemStatsExact.Path = %q, want exact", itemStatsExact.Path)
	}
	if len(itemHitsExact) != 1 || itemHitsExact[0].ID != liveItem.ID {
		t.Fatalf("exact item hits = %+v, want only liveItem %s (soft-deleted %s must never be returned)", itemHitsExact, liveItem.ID, delItem.ID)
	}

	tagHitsExact, tagStatsExact, err := store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusTag, []float32{1, 0, 0}, 5, time.Now().Add(2*time.Second), exactKnobs,
	)
	if err != nil {
		t.Fatalf("exact tag VectorSearch: %v", err)
	}
	if tagStatsExact.Path != store.VectorPathExact {
		t.Fatalf("tagStatsExact.Path = %q, want exact", tagStatsExact.Path)
	}
	if len(tagHitsExact) != 1 || tagHitsExact[0].ID != liveTag.ID {
		t.Fatalf("exact tag hits = %+v, want only liveTag %s", tagHitsExact, liveTag.ID)
	}

	// 2. ANN path (ExactMaxVectors = 0 -> force ANN, k = 2 so 2 vectors in HNSW satisfies annCandidates >= k).
	annKnobs := store.DefaultVectorSearchKnobs()
	annKnobs.ExactMaxVectors = 0
	annKnobs.FallbackMaxVectors = 20

	itemHitsANN, itemStatsANN, err := store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusItem, []float32{1, 0, 0}, 2, time.Now().Add(2*time.Second), annKnobs,
	)
	if err != nil {
		t.Fatalf("ann item VectorSearch: %v", err)
	}
	if itemStatsANN.Path != store.VectorPathANN {
		t.Fatalf("itemStatsANN.Path = %q, want ann", itemStatsANN.Path)
	}
	if len(itemHitsANN) != 1 || itemHitsANN[0].ID != liveItem.ID {
		t.Fatalf("ann item hits = %+v, want only liveItem %s", itemHitsANN, liveItem.ID)
	}

	tagHitsANN, tagStatsANN, err := store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusTag, []float32{1, 0, 0}, 2, time.Now().Add(2*time.Second), annKnobs,
	)
	if err != nil {
		t.Fatalf("ann tag VectorSearch: %v", err)
	}
	if tagStatsANN.Path != store.VectorPathANN {
		t.Fatalf("tagStatsANN.Path = %q, want ann", tagStatsANN.Path)
	}
	if len(tagHitsANN) != 1 || tagHitsANN[0].ID != liveTag.ID {
		t.Fatalf("ann tag hits = %+v, want only liveTag %s", tagHitsANN, liveTag.ID)
	}
}

func TestExactSearchSQLRejectsInvalidCorpus(t *testing.T) {
	if _, err := store.ExactSearchSQL(`"item_embedding_g1"`, generation.Corpus("entry")); !errors.Is(err, generation.ErrInvalidCorpus) {
		t.Fatalf("ExactSearchSQL invalid corpus = %v, want ErrInvalidCorpus", err)
	}
}
