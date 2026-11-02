package lifecycle_test

import (
	"strconv"
	"testing"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/embedding/lifecycle"
	"github.com/zone17th/engram/apps/api/internal/embedding/reconcile"
)

// TestVerifySkipsRecallBelow200Vectors (N4/FS-33): a bootstrap generation with
// fewer than 200 vectors skips the recall sample, yet one missing vector, or one
// vector of a deleted target, still blocks the flip.
func TestVerifySkipsRecallBelow200Vectors(t *testing.T) {
	e := newEnv(t)
	m := e.model(8, "rev-a")
	g1 := e.bootstrap(m)
	deps := e.deps(e.clientSet(m, nil))
	u := e.user("skip-recall@example.com")
	ids := make([]uuid.UUID, 0, 5)
	for i := 0; i < 5; i++ {
		ids = append(ids, e.newItem(u, "Yankee "+strconv.Itoa(i), ""))
	}
	e.newTag(u, "tag-zulu")
	e.drain(deps, 0)

	rep, err := lifecycle.Verify(e.ctx, e.pool, g1.ID, lifecycle.VerifyOpts{})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !rep.Passed || !rep.RecallSkippedBelow200 || rep.Recall != nil || rep.ItemRows != 5 || rep.TagRows != 1 || !rep.IndexReady {
		t.Fatalf("Verify with 6 vectors = %+v, want passed, recall skipped, index ready", rep)
	}

	// (a) one missing vector blocks the flip.
	e.exec(`DELETE FROM item_embedding_g1 WHERE target_id = $1`, ids[0])
	rep, err = lifecycle.Verify(e.ctx, e.pool, g1.ID, lifecycle.VerifyOpts{})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if rep.Passed || rep.Reason != lifecycle.ReasonCoverageIncomplete || rep.Coverage.Missing != 1 {
		t.Fatalf("Verify with one missing vector = %+v, want coverage_incomplete (1 missing)", rep)
	}
	out, err := lifecycle.AutoFlipBootstrap(e.ctx, e.pool, lifecycle.AutoFlipOpts{})
	if err != nil {
		t.Fatalf("AutoFlipBootstrap: %v", err)
	}
	if out.Action != lifecycle.ActionNotReady || out.Reason != lifecycle.ReasonCoverageIncomplete {
		t.Fatalf("AutoFlipBootstrap with a missing vector = %+v, want not_ready/%s", out, lifecycle.ReasonCoverageIncomplete)
	}
	if e.gen(g1.ID).State != generation.StatePending || e.hasActive() {
		t.Fatal("flipped with a missing vector")
	}
	e.backfill(g1)
	e.drain(deps, 0)

	// (b) a vector of a deleted target (the delete bypassed the hook) blocks it too.
	e.exec(`UPDATE item SET deleted_at = now() WHERE id = $1`, ids[1])
	rep, err = lifecycle.Verify(e.ctx, e.pool, g1.ID, lifecycle.VerifyOpts{})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if rep.Passed || rep.Reason != lifecycle.ReasonCoverageIncomplete || rep.Coverage.WouldDeleteOrphan != 1 {
		t.Fatalf("Verify with a deleted target's vector = %+v, want coverage_incomplete (1 orphan)", rep)
	}
	out, err = lifecycle.AutoFlipBootstrap(e.ctx, e.pool, lifecycle.AutoFlipOpts{})
	if err != nil {
		t.Fatalf("AutoFlipBootstrap: %v", err)
	}
	if out.Action != lifecycle.ActionNotReady || e.hasActive() {
		t.Fatalf("AutoFlipBootstrap with an orphan vector = %+v (active %v), want not_ready", out, e.hasActive())
	}

	// Reconcile removes the orphan; with 4 + 1 vectors recall is still skipped
	// and the generation flips.
	res, err := reconcile.Reconcile(e.ctx, e.pool, e.gen(g1.ID), reconcile.All(), reconcile.ModeEnqueue,
		jobs.ReembedEnqueueFunc(jobs.RiverClientInserter{Client: e.insert}))
	if err != nil || res.OrphanDeleted != 1 {
		t.Fatalf("Reconcile = %+v, %v; want 1 orphan deleted", res, err)
	}
	out, err = lifecycle.AutoFlipBootstrap(e.ctx, e.pool, lifecycle.AutoFlipOpts{})
	if err != nil {
		t.Fatalf("AutoFlipBootstrap: %v", err)
	}
	if out.Action != lifecycle.ActionFlipped || e.activeID() != g1.ID {
		t.Fatalf("AutoFlipBootstrap after cleanup = %+v, want flipped", out)
	}
}

// TestVerifyRecallSample: with enough vectors for the configured sample the
// ANN-vs-exact recall runs (no provider call) and must meet C2; below the sample
// size it is skipped.
func TestVerifyRecallSample(t *testing.T) {
	e := newEnv(t)
	m := e.model(8, "rev-a")
	g1 := e.bootstrap(m)
	deps := e.deps(e.clientSet(m, nil))
	u := e.user("recall-sample@example.com")
	for i := 0; i < 30; i++ {
		e.newItem(u, "Sample item "+strconv.Itoa(1000+i), "")
	}
	for i := 0; i < 10; i++ {
		e.newTag(u, "sample-tag-"+strconv.Itoa(i))
	}
	e.drain(deps, 0)
	docsBefore := m.srv.Stats().DocumentRequests
	queriesBefore := m.srv.Stats().QueryRequests

	rep, err := lifecycle.Verify(e.ctx, e.pool, g1.ID, lifecycle.VerifyOpts{RecallSampleSize: 10})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !rep.Passed || rep.RecallSkippedBelow200 || rep.Recall == nil {
		t.Fatalf("Verify with a sample of 10 = %+v, want passed with a recall report", rep)
	}
	r := rep.Recall
	if r.Sampled == 0 || r.Eligible == 0 || !r.Passed || r.MeanRecall < lifecycle.RecallMean || r.QueryShareOK < lifecycle.RecallPerQueryShare || r.FalsePositives != 0 || r.K != lifecycle.RecallK {
		t.Fatalf("recall report = %+v, want a passing sample from stored vectors", *r)
	}
	if m.srv.Stats().DocumentRequests != docsBefore || m.srv.Stats().QueryRequests != queriesBefore {
		t.Fatal("recall sampling called the embedding provider; it must use stored vectors")
	}

	// 40 vectors < the default 200: recall is skipped.
	rep, err = lifecycle.Verify(e.ctx, e.pool, g1.ID, lifecycle.VerifyOpts{})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !rep.Passed || !rep.RecallSkippedBelow200 || rep.Recall != nil {
		t.Fatalf("Verify with 40 vectors and the default sample = %+v, want recall skipped", rep)
	}
}
