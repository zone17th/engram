package lifecycle_test

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/lifecycle"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
)

// TestSplitRecallQuota (GL-2): half per corpus when both are populated, the rest
// filled from the corpus that still has vectors, never more than a corpus holds.
func TestSplitRecallQuota(t *testing.T) {
	cases := []struct {
		name        string
		items, tags int64
		want        int
		got         [2]int
	}{
		{"both plenty", 300, 300, 200, [2]int{100, 100}},
		{"tags empty", 300, 0, 200, [2]int{200, 0}},
		{"items empty", 0, 300, 200, [2]int{0, 200}},
		{"tags short", 300, 10, 200, [2]int{190, 10}},
		{"items short", 10, 300, 200, [2]int{10, 190}},
		{"odd sample", 50, 50, 11, [2]int{5, 6}},
		{"exactly enough", 120, 80, 200, [2]int{120, 80}},
		{"not enough", 100, 50, 200, [2]int{100, 50}},
		{"zero sample", 10, 10, 0, [2]int{0, 0}},
	}
	for _, tc := range cases {
		got := lifecycle.SplitRecallQuota(tc.items, tc.tags, tc.want)
		if got != tc.got {
			t.Errorf("%s: SplitRecallQuota(%d, %d, %d) = %v, want %v", tc.name, tc.items, tc.tags, tc.want, got, tc.got)
		}
	}
}

// TestRecallOracleIsExactSQL (GL-4): the recall baseline is the store exact SQL
// (materialized primary-key CTE that the planner cannot move onto HNSW), run
// directly - not the VectorSearch router, whose exact threshold is capped and
// routes to ANN above 1,000,000 vectors of a tenant.
func TestRecallOracleIsExactSQL(t *testing.T) {
	g := generation.Generation{ID: 1}
	for _, corpus := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		got, err := lifecycle.ExactOracleSQL(g, corpus)
		if err != nil {
			t.Fatalf("ExactOracleSQL(%s): %v", corpus, err)
		}
		tbl, err := store.SanitizedTable(g, corpus)
		if err != nil {
			t.Fatalf("SanitizedTable: %v", err)
		}
		want, err := store.ExactSearchSQL(tbl, corpus)
		if err != nil {
			t.Fatalf("ExactSearchSQL: %v", err)
		}
		if got != want {
			t.Fatalf("%s oracle SQL is not store.ExactSearchSQL", corpus)
		}
		for _, frag := range []string{"AS MATERIALIZED", "ORDER BY user_id, target_id"} {
			if !strings.Contains(got, frag) {
				t.Fatalf("%s oracle SQL lacks %q: it could be planned onto the ANN index", corpus, frag)
			}
		}
		if strings.Contains(strings.ToLower(got), "hnsw") {
			t.Fatalf("%s oracle SQL mentions hnsw", corpus)
		}
	}
	if _, err := lifecycle.ExactOracleSQL(g, generation.Corpus("bogus")); err == nil {
		t.Fatal("ExactOracleSQL accepted an invalid corpus")
	}
}

// TestVerifyRecallSamplesFullSizeFromOneTenant (GL-2): one tenant, 210 vectors in
// one corpus and none in the other. The recall sample is 200 distinct vectors
// spread over the key range (not the first ten, not a prefix), the unused quota
// of the empty corpus is filled from the populated one, and a sample that comes
// back short while enough vectors existed when it was sized fails verification
// with a reason code instead of passing.
func TestVerifyRecallSamplesFullSizeFromOneTenant(t *testing.T) {
	e := newEnv(t)
	m := e.model(8, "rev-a") // dims 8: the sampling semantics do not depend on dims
	g1 := e.bootstrap(m)
	deps := e.deps(e.clientSet(m, nil))
	u := e.user("sample-200@example.com")
	const total = 210
	e.exec(`INSERT INTO item (user_id, name, name_normalized)
SELECT $1, 'Sample item ' || n, 'sample item ' || n FROM generate_series(1, $2::int) AS n`, u, total)
	e.backfill(g1)
	e.drain(deps, 0)
	if got := e.rows(g1, generation.CorpusItem); got != total {
		t.Fatalf("item vectors = %d, want %d", got, total)
	}
	if got := e.rows(g1, generation.CorpusTag); got != 0 {
		t.Fatalf("tag vectors = %d, want 0", got)
	}

	// The sampler itself: 200 distinct keys, spread over the whole key order.
	rows, err := e.pool.Query(e.ctx, `SELECT target_id FROM item_embedding_g1 ORDER BY user_id, target_id`)
	if err != nil {
		t.Fatalf("list keys: %v", err)
	}
	pos := map[uuid.UUID]int{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			t.Fatalf("scan key: %v", err)
		}
		pos[id] = len(pos)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("keys rows: %v", err)
	}
	ids, err := lifecycle.SampleTargetIDs(e.ctx, e.pool, g1, generation.CorpusItem, total, 200)
	if err != nil {
		t.Fatalf("SampleTargetIDs: %v", err)
	}
	if len(ids) != 200 {
		t.Fatalf("sampler returned %d keys, want 200", len(ids))
	}
	seen := map[uuid.UUID]bool{}
	last := -1
	for _, id := range ids {
		p, ok := pos[id]
		if !ok || seen[id] {
			t.Fatal("sampler returned a duplicate or unknown key")
		}
		seen[id] = true
		if p > last {
			last = p
		}
	}
	if last < 205 {
		t.Fatalf("sample reaches key position %d of %d: it is a prefix, not spread over the key range", last, total)
	}

	// Verify end to end: 200 sampled queries, the empty tag corpus half is
	// filled from the item corpus.
	rep, err := lifecycle.Verify(e.ctx, e.pool, g1.ID, lifecycle.VerifyOpts{})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if rep.Recall == nil || rep.RecallSkippedBelow200 {
		t.Fatalf("Verify with %d vectors = %+v, want a recall report", total, rep)
	}
	if rep.Recall.Requested != 200 || rep.Recall.Sampled != 200 {
		t.Fatalf("recall sample = %d of %d requested, want 200 of 200", rep.Recall.Sampled, rep.Recall.Requested)
	}
	if !rep.Passed || !rep.Recall.Passed {
		t.Fatalf("Verify = %+v (recall %+v), want passed", rep, *rep.Recall)
	}

	// A sample that comes back short although enough vectors existed when it was
	// sized (12 vectors vanish in between) must fail with a reason code.
	rep, err = lifecycle.Verify(e.ctx, e.pool, g1.ID, lifecycle.VerifyOpts{
		AfterSampleCount: func() {
			e.exec(`DELETE FROM item_embedding_g1 WHERE target_id IN (SELECT target_id FROM item_embedding_g1 ORDER BY user_id DESC, target_id DESC LIMIT 12)`)
		},
	})
	if err != nil {
		t.Fatalf("Verify with a short sample: %v", err)
	}
	if rep.Passed || rep.Reason != lifecycle.ReasonRecallSampleShort || rep.Recall == nil || rep.Recall.Sampled >= 200 || rep.Recall.Requested != 200 {
		t.Fatalf("Verify with a short sample = %+v, want failed with %s", rep, lifecycle.ReasonRecallSampleShort)
	}
}
