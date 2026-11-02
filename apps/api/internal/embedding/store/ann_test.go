package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/searchbench"
)

func collectPlanPartitionRelations(v any, prefix string, out map[string]struct{}) {
	switch node := v.(type) {
	case map[string]any:
		if rel, ok := node["Relation Name"].(string); ok {
			if strings.HasPrefix(rel, prefix) {
				out[rel] = struct{}{}
			}
		}
		for k, child := range node {
			if k == "Index Name" {
				continue
			}
			collectPlanPartitionRelations(child, prefix, out)
		}
	case []any:
		for _, elem := range node {
			collectPlanPartitionRelations(elem, prefix, out)
		}
	}
}

// annCTEScansPartitionIndex reports whether the "CTE ann" subplan contains a
// scan node on relation `partition` that uses exactly index `index`. It is
// scoped to the ann CTE subtree so an HNSW-named index elsewhere in the plan
// (or a different index on the same partition, e.g. the PK) cannot satisfy it.
func annCTEScansPartitionIndex(v any, partition, index string) bool {
	switch node := v.(type) {
	case map[string]any:
		if name, ok := node["Subplan Name"].(string); ok && name == "CTE ann" {
			return planScansIndex(node, partition, index)
		}
		for _, child := range node {
			if annCTEScansPartitionIndex(child, partition, index) {
				return true
			}
		}
	case []any:
		for _, elem := range node {
			if annCTEScansPartitionIndex(elem, partition, index) {
				return true
			}
		}
	}
	return false
}

func planScansIndex(v any, partition, index string) bool {
	switch node := v.(type) {
	case map[string]any:
		rel, _ := node["Relation Name"].(string)
		idx, _ := node["Index Name"].(string)
		if rel == partition && idx == index {
			return true
		}
		for _, child := range node {
			if planScansIndex(child, partition, index) {
				return true
			}
		}
	case []any:
		for _, elem := range node {
			if planScansIndex(elem, partition, index) {
				return true
			}
		}
	}
	return false
}

func TestANNAboveThresholdPrunesPartition(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	// Create g1 with 16 hash partitions and per-partition HNSW indexes.
	g1, pin := seedGenerationForVectorSearch(t, ctx, pool, 1, 3, 16, 0.50, true)

	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "ann-prune@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}

	hash := makeHash(0x71)
	var seededIDs []uuid.UUID
	for i := range 4 {
		it, err := q.InsertItem(ctx, gen.InsertItemParams{
			UserID:         u.ID,
			Name:           "ANN Item " + string(rune('A'+i)),
			NameNormalized: "ann item " + string(rune('a'+i)),
		})
		if err != nil {
			t.Fatal(err)
		}
		seededIDs = append(seededIDs, it.ID)
		if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, u.ID, it.ID, []float32{1, 0, 0}, hash); err != nil {
			t.Fatal(err)
		}
	}

	// 1. Verify EXPLAIN (FORMAT JSON, COSTS OFF) on ANNSearchSQL touches
	// exactly 1 partition of item_embedding_g1 (15 of 16 partitions pruned)
	// and that the ann candidate CTE is HNSW-eligible, i.e. scans that
	// partition via its <partition>_hnsw index (migration 0009 naming).
	ident, err := pin.TableIdent(generation.CorpusItem)
	if err != nil {
		t.Fatal(err)
	}
	annSQL, err := store.ANNSearchSQL(ident.Sanitize(), generation.CorpusItem)
	if err != nil {
		t.Fatal(err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// With only 4 tiny rows the planner would otherwise prefer a bitmap scan
	// on the partition PK plus Sort over the HNSW index. Disable those
	// alternatives (EXPLAIN-only transaction) so the assertion proves the ANN
	// SQL shape is HNSW-eligible and partition-pruned. Planner choice on real
	// volumes (whale/mid tenants) is measured in Task 23 search-bench, not here.
	for _, setting := range []string{
		`SET LOCAL enable_seqscan = off`,
		`SET LOCAL enable_bitmapscan = off`,
		`SET LOCAL enable_sort = off`,
	} {
		if _, err := tx.Exec(ctx, setting); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
	}
	var rawPlan []byte
	if err := tx.QueryRow(ctx,
		`EXPLAIN (FORMAT JSON, COSTS OFF) `+annSQL,
		u.ID,
		pgvector.NewVector([]float32{1, 0, 0}),
		pin.MinCos,
		3,
	).Scan(&rawPlan); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("EXPLAIN ANNSearchSQL: %v", err)
	}
	_ = tx.Rollback(ctx)

	var planPayload []map[string]any
	if err := json.Unmarshal(rawPlan, &planPayload); err != nil {
		t.Fatalf("unmarshal EXPLAIN JSON: %v\nRaw:\n%s", err, string(rawPlan))
	}

	seenPartitions := make(map[string]struct{})
	for _, root := range planPayload {
		collectPlanPartitionRelations(root, "item_embedding_g1_p", seenPartitions)
	}
	if len(seenPartitions) != 1 {
		t.Fatalf("expected ANNSearchSQL EXPLAIN to touch exactly 1 partition of item_embedding_g1, touched %d (%v)\nPlan:\n%s",
			len(seenPartitions), seenPartitions, string(rawPlan))
	}
	var prunedPartition string
	for rel := range seenPartitions {
		prunedPartition = rel
	}
	wantIndex := prunedPartition + "_hnsw"
	if !annCTEScansPartitionIndex(planPayload, prunedPartition, wantIndex) {
		t.Fatalf("expected ANNSearchSQL ann CTE to scan %s via HNSW index %s, plan:\n%s",
			prunedPartition, wantIndex, string(rawPlan))
	}

	// 2. Execute VectorSearch above injected ExactMaxVectors (4 > 2) with k=3
	// and verify path "ann" + metric delta.
	_, m := obs.NewRegistry()
	knobs := store.DefaultVectorSearchKnobs()
	knobs.ExactMaxVectors = 2
	knobs.FallbackMaxVectors = 10
	knobs.Metrics = m.Search

	beforeANN := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann"))

	hits, stats, err := store.VectorSearch(
		ctx,
		pool,
		pin,
		u.ID,
		generation.CorpusItem,
		[]float32{1, 0, 0},
		3,
		time.Now().Add(2*time.Second),
		knobs,
	)
	if err != nil {
		t.Fatalf("VectorSearch ANN: %v", err)
	}
	if stats.Path != store.VectorPathANN {
		t.Fatalf("stats.Path = %q, want %q", stats.Path, store.VectorPathANN)
	}
	if stats.ANNCandidates != 3 || len(hits) != 3 {
		t.Fatalf("stats=%+v len(hits)=%d, want ANNCandidates=3 and 3 hits", stats, len(hits))
	}
	if got := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann")) - beforeANN; got != 1 {
		t.Fatalf("VectorPathTotal{item,ann} delta = %v, want 1", got)
	}
	_ = seededIDs
}

func TestNoCrossTenantRowsEvenOnUnderfill(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	const partitions = 4
	g1, pin := seedGenerationForVectorSearch(t, ctx, pool, 1, 3, partitions, 0.50, true)

	// Draw two tenant UUIDs that deterministically land in the SAME hash
	// partition (verified both by searchbench.PostgresUUIDPartitionRemainder
	// and Postgres satisfies_hash_partition).
	uSmall, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "coloc-small@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	targetRem := searchbench.PostgresUUIDPartitionRemainder(uSmall.ID, partitions)

	var uBig gen.AppUser
	for attempt := range 256 {
		cand, err := q.InsertUser(ctx, gen.InsertUserParams{
			Email:  "coloc-big-" + string(rune('a'+(attempt%26))) + "-" + uuid.NewString() + "@example.com",
			Locale: "en",
		})
		if err != nil {
			t.Fatal(err)
		}
		if searchbench.PostgresUUIDPartitionRemainder(cand.ID, partitions) == targetRem {
			uBig = cand
			break
		}
	}
	if uBig.ID == uuid.Nil {
		t.Fatal("failed to find colocated tenant UUID")
	}

	// Verify in Postgres that uSmall and uBig satisfy the exact same hash partition.
	var samePartition bool
	if err := pool.QueryRow(ctx,
		`SELECT satisfies_hash_partition('item_embedding_g1'::regclass, $1, $2, $3::uuid)
		    AND satisfies_hash_partition('item_embedding_g1'::regclass, $1, $2, $4::uuid)`,
		partitions, targetRem, uSmall.ID, uBig.ID,
	).Scan(&samePartition); err != nil || !samePartition {
		t.Fatalf("expected uSmall and uBig to share partition remainder %d: same=%v err=%v", targetRem, samePartition, err)
	}

	hash := makeHash(0x72)
	// Seed 2 matching items for uSmall and 25 matching items for uBig in the same partition.
	smallIDs := make(map[uuid.UUID]struct{}, 2)
	for i := range 2 {
		it, err := q.InsertItem(ctx, gen.InsertItemParams{
			UserID:         uSmall.ID,
			Name:           "Small Tenant Item " + string(rune('1'+i)),
			NameNormalized: "small tenant item " + string(rune('1'+i)),
		})
		if err != nil {
			t.Fatal(err)
		}
		smallIDs[it.ID] = struct{}{}
		if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, uSmall.ID, it.ID, []float32{1, 0, 0}, hash); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 25 {
		it, err := q.InsertItem(ctx, gen.InsertItemParams{
			UserID:         uBig.ID,
			Name:           "Big Tenant Item " + uuid.NewString(),
			NameNormalized: "big tenant item " + string(rune('a'+(i%26))) + uuid.NewString()[:8],
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, uBig.ID, it.ID, []float32{1, 0, 0}, hash); err != nil {
			t.Fatal(err)
		}
	}

	// Query uSmall for k=10 (so uSmall underfills with only 2 vectors while 25
	// identical vectors belonging to uBig sit in the same partition's HNSW index).
	// Case A: Underfill with fallback to exact (FallbackMaxVectors = 10 >= count 2).
	knobsFallback := store.DefaultVectorSearchKnobs()
	knobsFallback.ExactMaxVectors = 1
	knobsFallback.FallbackMaxVectors = 10

	hitsA, statsA, err := store.VectorSearch(
		ctx, pool, pin, uSmall.ID, generation.CorpusItem, []float32{1, 0, 0}, 10, time.Now().Add(2*time.Second), knobsFallback,
	)
	if err != nil {
		t.Fatalf("VectorSearch uSmall (fallback): %v", err)
	}
	if statsA.Path != store.VectorPathANNFallbackExact {
		t.Fatalf("statsA.Path = %q, want %q", statsA.Path, store.VectorPathANNFallbackExact)
	}
	if len(hitsA) != 2 {
		t.Fatalf("len(hitsA) = %d, want 2", len(hitsA))
	}
	for _, h := range hitsA {
		if _, ok := smallIDs[h.ID]; !ok {
			t.Fatalf("cross-tenant leak in fallback path: returned item %s not owned by uSmall", h.ID)
		}
	}

	// Case B: Underfill without fallback (ExactMaxVectors = 0, FallbackMaxVectors = 1 < count 2 -> ann_short).
	knobsShort := store.DefaultVectorSearchKnobs()
	knobsShort.ExactMaxVectors = 0
	knobsShort.FallbackMaxVectors = 1

	hitsB, statsB, err := store.VectorSearch(
		ctx, pool, pin, uSmall.ID, generation.CorpusItem, []float32{1, 0, 0}, 10, time.Now().Add(2*time.Second), knobsShort,
	)
	if err != nil {
		t.Fatalf("VectorSearch uSmall (ann_short): %v", err)
	}
	if statsB.Path != store.VectorPathANNShort {
		t.Fatalf("statsB.Path = %q, want %q", statsB.Path, store.VectorPathANNShort)
	}
	if len(hitsB) != 2 {
		t.Fatalf("len(hitsB) = %d, want 2", len(hitsB))
	}
	for _, h := range hitsB {
		if _, ok := smallIDs[h.ID]; !ok {
			t.Fatalf("cross-tenant leak in ann_short path: returned item %s not owned by uSmall", h.ID)
		}
	}
}

func TestResortAfterRelaxedOrder(t *testing.T) {
	// 1. Deterministic unit test on ResortHitsByDistAndID: feed out-of-order
	// distances and tied distances with out-of-order UUIDs (simulating
	// hnsw.iterative_scan = relaxed_order returning slightly out-of-order
	// tuples across HNSW graph hops) and assert strict (Dist ASC, ID ASC).
	idLow := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	idMid := uuid.MustParse("00000000-0000-0000-0000-000000000002")
	idHigh := uuid.MustParse("00000000-0000-0000-0000-000000000003")
	idFar := uuid.MustParse("00000000-0000-0000-0000-000000000004")

	unsorted := []store.Hit{
		{ID: idFar, Dist: 0.25, Cos: 0.75, Name: "far"},
		{ID: idHigh, Dist: 0.10, Cos: 0.90, Name: "tie-high"},
		{ID: idLow, Dist: 0.05, Cos: 0.95, Name: "closest"},
		{ID: idMid, Dist: 0.10, Cos: 0.90, Name: "tie-mid"},
	}
	store.ResortHitsByDistAndID(unsorted)

	wantOrder := []uuid.UUID{idLow, idMid, idHigh, idFar}
	for i, wantID := range wantOrder {
		if unsorted[i].ID != wantID {
			t.Fatalf("ResortHitsByDistAndID[%d].ID = %s, want %s (full=%+v)", i, unsorted[i].ID, wantID, unsorted)
		}
	}

	// 2. End-to-end DB verification on the ANN path with IterativeScan =
	// "relaxed_order": insert items with distinct distances and tied distances,
	// run VectorSearch on the ANN path, and verify strict (Dist ASC, ID ASC).
	if testing.Short() {
		return
	}
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	g1, pin := seedGenerationForVectorSearch(t, ctx, pool, 1, 3, 4, 0.50, true)
	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "resort-db@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}

	hash := makeHash(0x73)
	// Insert in reverse UUID / reverse distance order so insertion order is the
	// opposite of (Dist ASC, ID ASC).
	specs := []struct {
		id  uuid.UUID
		vec []float32
	}{
		{id: idFar, vec: []float32{0.8, 0.6, 0}},      // cos = 0.8, dist = 0.2
		{id: idHigh, vec: []float32{0.9, 0.43589, 0}}, // cos ~ 0.9, dist ~ 0.1
		{id: idMid, vec: []float32{0.9, 0.43589, 0}},  // tied dist with idHigh, smaller UUID
		{id: idLow, vec: []float32{1, 0, 0}},          // cos = 1.0, dist = 0.0
	}
	for idx, sp := range specs {
		_, err := q.InsertItem(ctx, gen.InsertItemParams{
			ID:             &sp.id,
			UserID:         u.ID,
			Name:           "Resort Item " + string(rune('A'+idx)),
			NameNormalized: "resort item " + string(rune('a'+idx)),
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, u.ID, sp.id, sp.vec, hash); err != nil {
			t.Fatal(err)
		}
	}

	knobs := store.DefaultVectorSearchKnobs()
	knobs.ExactMaxVectors = 1
	knobs.FallbackMaxVectors = 20
	knobs.IterativeScan = store.IterativeScanRelaxedOrder

	hits, stats, err := store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusItem, []float32{1, 0, 0}, 4, time.Now().Add(2*time.Second), knobs,
	)
	if err != nil {
		t.Fatalf("VectorSearch ANN relaxed_order: %v", err)
	}
	if stats.Path != store.VectorPathANN {
		t.Fatalf("stats.Path = %q, want ann", stats.Path)
	}
	if len(hits) != 4 {
		t.Fatalf("len(hits) = %d, want 4", len(hits))
	}
	for i, wantID := range wantOrder {
		if hits[i].ID != wantID {
			t.Fatalf("hits[%d].ID = %s (dist=%v), want %s", i, hits[i].ID, hits[i].Dist, wantID)
		}
	}
}

func TestANNSearchSQLRejectsInvalidCorpus(t *testing.T) {
	if _, err := store.ANNSearchSQL(`"item_embedding_g1"`, generation.Corpus("invalid")); !errors.Is(err, generation.ErrInvalidCorpus) {
		t.Fatalf("ANNSearchSQL invalid corpus = %v, want ErrInvalidCorpus", err)
	}
}
