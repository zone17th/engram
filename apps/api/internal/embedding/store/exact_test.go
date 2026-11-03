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

	_, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
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
	row, err := q.ActivateEmbeddingGeneration(ctx, int32(id))
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

// explainContainsHNSW reports whether any node of an EXPLAIN (FORMAT JSON)
// payload references an index whose name contains "hnsw". It accepts the
// payload as decoded into []map[string]any (the typed root list), as well as
// the generic map[string]any / []any shapes. A type it does not recognise would
// silently report false, so every decoded shape must be listed here.
func explainContainsHNSW(v any) bool {
	switch node := v.(type) {
	case []map[string]any:
		for _, root := range node {
			if explainContainsHNSW(root) {
				return true
			}
		}
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

func TestExplainContainsHNSW(t *testing.T) {
	cases := []struct {
		name string
		plan string
		want bool
	}{
		{
			name: "index scan via the partition hnsw index",
			plan: `[{"Plan": {"Node Type": "Limit", "Plans": [
				{"Node Type": "Index Scan", "Parent Relationship": "Outer",
				 "Index Name": "item_embedding_g1_p5_hnsw", "Relation Name": "item_embedding_g1_p5", "Alias": "e"}
			]}}]`,
			want: true,
		},
		{
			name: "bitmap scan via the partition pkey (CI plan shape)",
			plan: `[{"Plan": {"Node Type": "Sort", "Sort Key": ["a.dist", "i.id"], "Plans": [
				{"Node Type": "Limit", "Parent Relationship": "InitPlan", "Subplan Name": "CTE ann", "Plans": [
					{"Node Type": "Sort", "Parent Relationship": "Outer", "Plans": [
						{"Node Type": "Bitmap Heap Scan", "Parent Relationship": "Outer",
						 "Relation Name": "item_embedding_g1_p5", "Alias": "e", "Plans": [
							{"Node Type": "Bitmap Index Scan", "Parent Relationship": "Outer",
							 "Index Name": "item_embedding_g1_p5_pkey",
							 "Index Cond": "(user_id = 'fd0c9201-952f-415d-95b5-d4a554937c80'::uuid)"}
						]}
					]}
				]},
				{"Node Type": "Nested Loop", "Parent Relationship": "Outer", "Plans": [
					{"Node Type": "CTE Scan", "Parent Relationship": "Outer", "CTE Name": "ann", "Alias": "a"},
					{"Node Type": "Index Scan", "Parent Relationship": "Inner",
					 "Index Name": "item_user_unaccent_prefix", "Relation Name": "item", "Alias": "i"}
				]}
			]}}]`,
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var plan []map[string]any
			if err := json.Unmarshal([]byte(tc.plan), &plan); err != nil {
				t.Fatalf("unmarshal fixture: %v", err)
			}
			if got := explainContainsHNSW(plan); got != tc.want {
				t.Fatalf("explainContainsHNSW(typed roots) = %v, want %v", got, tc.want)
			}
			for _, root := range plan {
				if got := explainContainsHNSW(root); got != tc.want {
					t.Fatalf("explainContainsHNSW(root) = %v, want %v", got, tc.want)
				}
			}
		})
	}
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
		for _, root := range planPayload {
			if explainContainsHNSW(root) {
				t.Fatalf("expected ExactSearchSQL (%s) plan to contain NO hnsw index, got plan:\n%s", corpus, string(rawPlan))
			}
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

func TestExactSearchSQLDistanceFilterPushdownShape(t *testing.T) {
	for _, tc := range []struct {
		corpus   generation.Corpus
		tbl      string
		liveJoin string
		orderKey string
	}{
		{
			corpus:   generation.CorpusItem,
			tbl:      `"item_embedding_g1"`,
			liveJoin: "JOIN item i ON i.id = e.target_id AND i.user_id = e.user_id",
			orderKey: "ORDER BY e.dist ASC, i.id ASC",
		},
		{
			corpus:   generation.CorpusTag,
			tbl:      `"tag_embedding_g1"`,
			liveJoin: "JOIN tag t ON t.id = e.target_id AND t.user_id = e.user_id",
			orderKey: "ORDER BY e.dist ASC, t.id ASC",
		},
	} {
		t.Run(string(tc.corpus), func(t *testing.T) {
			sqlStr, err := store.ExactSearchSQL(tc.tbl, tc.corpus)
			if err != nil {
				t.Fatalf("ExactSearchSQL(%s): %v", tc.corpus, err)
			}
			cteStart := strings.Index(sqlStr, "WITH tenant_vecs AS MATERIALIZED (")
			joinIdx := strings.Index(sqlStr, tc.liveJoin)
			if cteStart < 0 || joinIdx <= cteStart {
				t.Fatalf("unexpected SQL structure:\n%s", sqlStr)
			}
			cteBody := sqlStr[cteStart:joinIdx]
			outerBody := sqlStr[joinIdx:]

			// 1. Distance and threshold filter must be inside the MATERIALIZED CTE before the join.
			if !strings.Contains(cteBody, "(embedding <=> $2) AS dist") {
				t.Fatalf("expected MATERIALIZED CTE to project (embedding <=> $2) AS dist:\n%s", cteBody)
			}
			if !strings.Contains(cteBody, "AND 1 - (embedding <=> $2) >= $3") {
				t.Fatalf("expected MATERIALIZED CTE to filter 1 - (embedding <=> $2) >= $3 before join:\n%s", cteBody)
			}
			if !strings.Contains(cteBody, "ORDER BY user_id, target_id") {
				t.Fatalf("expected MATERIALIZED CTE to preserve ORDER BY user_id, target_id:\n%s", cteBody)
			}

			// 2. Outer query must reuse e.dist and never re-evaluate <=> or detoast e.embedding.
			if strings.Contains(outerBody, "<=>") || strings.Contains(outerBody, "embedding") {
				t.Fatalf("outer query after MATERIALIZED CTE must not reference embedding or <=>:\n%s", outerBody)
			}
			if !strings.Contains(outerBody, "1 - e.dist AS cos") {
				t.Fatalf("expected outer query to compute 1 - e.dist AS cos:\n%s", outerBody)
			}
			if !strings.Contains(outerBody, tc.orderKey) {
				t.Fatalf("expected outer query to order by %q:\n%s", tc.orderKey, outerBody)
			}
		})
	}
}

func TestExactSearchPushdownPreservesIDsAndOrder(t *testing.T) {
	if testing.Short() {
		return
	}
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	g1, pin := seedGenerationForVectorSearch(t, ctx, pool, 1, 4, 4, 0.50, true)
	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "exact-pushdown-order@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}

	idBest := uuid.MustParse("00000000-0000-0000-0000-000000000011")
	idTieA := uuid.MustParse("00000000-0000-0000-0000-000000000012")
	idTieB := uuid.MustParse("00000000-0000-0000-0000-000000000013")
	idNearMin := uuid.MustParse("00000000-0000-0000-0000-000000000014")
	idExactMin := uuid.MustParse("00000000-0000-0000-0000-000000000015")
	idBelowMin := uuid.MustParse("00000000-0000-0000-0000-000000000016")

	hash := makeHash(0x69)
	// Insert in reverse/mixed order to verify deterministic (dist ASC, id ASC),
	// exact equality at semantic_min_cos (0.50), and truncation across a tie.
	fixture := []struct {
		id  uuid.UUID
		vec []float32
	}{
		{id: idBelowMin, vec: []float32{0.40, 0.916515, 0, 0}},   // cos = 0.40 < 0.50 (filtered out inside CTE)
		{id: idExactMin, vec: []float32{0.50, 0.50, 0.50, 0.50}}, // cos = 0.50 == 0.50 (exact threshold boundary, included)
		{id: idNearMin, vec: []float32{0.60, 0.80, 0, 0}},        // cos = 0.60 >= 0.50
		{id: idTieB, vec: []float32{0.80, 0.60, 0, 0}},           // cos = 0.80 (tie, higher UUID)
		{id: idBest, vec: []float32{1.0, 0.0, 0, 0}},             // cos = 1.00
		{id: idTieA, vec: []float32{0.80, 0.60, 0, 0}},           // cos = 0.80 (tie, lower UUID)
	}
	for idx, f := range fixture {
		_, err := q.InsertItem(ctx, gen.InsertItemParams{
			ID:             &f.id,
			UserID:         u.ID,
			Name:           "Pushdown Item " + string(rune('A'+idx)),
			NameNormalized: "pushdown item " + string(rune('a'+idx)),
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, u.ID, f.id, f.vec, hash); err != nil {
			t.Fatal(err)
		}
		_, err = pool.Exec(ctx,
			`INSERT INTO tag (id, user_id, display, normalized) VALUES ($1, $2, $3, $4)`,
			f.id, u.ID, "PushdownTag"+string(rune('A'+idx)), "pushdowntag"+string(rune('a'+idx)),
		)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Upsert(ctx, pool, g1, generation.CorpusTag, u.ID, f.id, f.vec, hash); err != nil {
			t.Fatal(err)
		}
	}

	knobs := store.DefaultVectorSearchKnobs()
	knobs.ExactMaxVectors = 10
	knobs.FallbackMaxVectors = 20
	qvec := []float32{1, 0, 0, 0}

	cases := []struct {
		name    string
		k       int
		wantIDs []uuid.UUID
	}{
		{
			name:    "full_eligible_includes_exact_threshold_boundary",
			k:       10,
			wantIDs: []uuid.UUID{idBest, idTieA, idTieB, idNearMin, idExactMin},
		},
		{
			name:    "limit_cuts_through_distance_tie_by_id_asc",
			k:       2,
			wantIDs: []uuid.UUID{idBest, idTieA},
		},
	}

	for _, corpus := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		for _, tc := range cases {
			hits, stats, err := store.VectorSearch(
				ctx, pool, pin, u.ID, corpus, qvec, tc.k, time.Now().Add(2*time.Second), knobs,
			)
			if err != nil {
				t.Fatalf("VectorSearch (%s/%s): %v", corpus, tc.name, err)
			}
			if stats.Path != store.VectorPathExact {
				t.Fatalf("stats.Path (%s/%s) = %q, want exact", corpus, tc.name, stats.Path)
			}
			if len(hits) != len(tc.wantIDs) {
				t.Fatalf("len(hits) (%s/%s) = %d, want %d (hits=%+v)", corpus, tc.name, len(hits), len(tc.wantIDs), hits)
			}
			for i, wantID := range tc.wantIDs {
				if hits[i].ID != wantID {
					t.Fatalf("hits[%d].ID (%s/%s) = %s, want %s (hits=%+v)", i, corpus, tc.name, hits[i].ID, wantID, hits)
				}
			}
		}
	}
}
