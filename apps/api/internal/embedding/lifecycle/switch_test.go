package lifecycle_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/embedding/lifecycle"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/semantic"
)

// TestGenerationSwitchSameDims: model A -> model B at the same dims (1024 ->
// 1024). Create, rename, delete and restore run while the backfill is enqueuing;
// after verify both generations hold the right hash for every live target and
// nothing for the deleted one.
func TestGenerationSwitchSameDims(t *testing.T) {
	e := newEnv(t)
	mA := e.model(1024, "rev-a")
	mB := e.model(1024, "rev-b")
	g1 := e.bootstrapActive(mA)
	cs := e.clientSet(mA, &mB)
	deps := e.deps(cs)

	u1 := e.user("same-dims-1@example.com")
	u2 := e.user("same-dims-2@example.com")
	i1 := e.newItem(u1, "Golf rename-me", "h1")
	i2 := e.newItem(u1, "Hotel delete-me", "")
	i3 := e.newItem(u2, "India cycle", "h3")
	i4 := e.newItem(u2, "Juliet steady", "")
	t1 := e.newTag(u1, "tag-kilo")
	e.drain(deps, 0)

	g2 := e.create(mB)

	// The first enqueue batch of the backfill triggers the concurrent mutations
	// (a barrier, no sleep): they commit before that batch's own insert.
	var i5 uuid.UUID
	var once sync.Once
	base := jobs.ReembedEnqueueFunc(jobs.RiverClientInserter{Client: e.insert})
	enq := func(ctx context.Context, tx pgx.Tx, args river.JobArgs) error {
		once.Do(func() {
			e.renameItem(u1, i1, "Golf renamed", "h1")
			e.deleteItem(u1, i2)
			i5 = e.newItem(u2, "Lima created", "")
			e.deleteItem(u2, i3)
			e.restoreItem(u2, i3, "India cycle", "h3")
		})
		return base(ctx, tx, args)
	}
	if _, err := lifecycle.Backfill(e.ctx, e.pool, g2.ID, enq); err != nil {
		t.Fatalf("Backfill: %v", err)
	}
	if i5 == uuid.Nil {
		t.Fatal("the concurrent mutations never ran")
	}
	e.drain(deps, 0)
	if _, err := lifecycle.Index(e.ctx, e.pool, g2.ID); err != nil {
		t.Fatalf("Index: %v", err)
	}
	rep, err := lifecycle.Verify(e.ctx, e.pool, g2.ID, lifecycle.VerifyOpts{})
	if err != nil || !rep.Passed {
		t.Fatalf("Verify = %+v, %v; want passed", rep, err)
	}

	for _, g := range []generation.Generation{e.gen(g1.ID), e.gen(g2.ID)} {
		e.wantVector(g, generation.CorpusItem, u1, i1, embedding.ItemInput("Golf renamed", "h1"))
		e.wantNoVector(g, generation.CorpusItem, u1, i2)
		e.wantVector(g, generation.CorpusItem, u2, i3, embedding.ItemInput("India cycle", "h3"))
		e.wantVector(g, generation.CorpusItem, u2, i4, embedding.ItemInput("Juliet steady", ""))
		e.wantVector(g, generation.CorpusItem, u2, i5, embedding.ItemInput("Lima created", ""))
		e.wantVector(g, generation.CorpusTag, u1, t1, embedding.TagInput("tag-kilo"))
		if n := e.rows(g, generation.CorpusItem); n != 4 {
			t.Fatalf("generation %d item vectors = %d, want 4 (no orphan, none missing)", g.ID, n)
		}
		if n := e.rows(g, generation.CorpusTag); n != 1 {
			t.Fatalf("generation %d tag vectors = %d, want 1", g.ID, n)
		}
		if dims := e.vectorDims(g, generation.CorpusItem); len(dims) != 1 || dims[0] != 1024 {
			t.Fatalf("generation %d vector dims = %v, want [1024]", g.ID, dims)
		}
	}

	if err := lifecycle.Flip(e.ctx, e.pool, g2.ID, lifecycle.FlipOpts{Reason: "test", RollbackWindow: time.Hour}); err != nil {
		t.Fatalf("Flip: %v", err)
	}
	if e.activeID() != g2.ID {
		t.Fatalf("active = %d, want %d", e.activeID(), g2.ID)
	}
}

// TestGenerationSwitchDifferentDims: 1024 -> 768. A 768-wide vector never reaches
// a 1024 table: a job whose generation has no matching client writes nothing,
// and a direct write of a wrong-width vector is refused before any SQL.
func TestGenerationSwitchDifferentDims(t *testing.T) {
	e := newEnv(t)
	mA := e.model(1024, "rev-a")
	mB := e.model(768, "rev-b")
	g1 := e.bootstrapActive(mA)
	cs := e.clientSet(mA, &mB)
	deps := e.deps(cs)

	u := e.user("diff-dims@example.com")
	for _, n := range []string{"November one", "Oscar two", "Papa three"} {
		e.newItem(u, n, "")
	}
	e.newTag(u, "tag-quebec")
	e.drain(deps, 0)

	g2 := e.create(mB)
	if g2.Dims != 768 || g1.Dims != 1024 {
		t.Fatalf("dims = %d / %d, want 1024 / 768", g1.Dims, g2.Dims)
	}

	// Only the 768 model is configured: the g1 job must snooze, not write.
	csB := e.clientSet(mB, nil)
	late := e.newItem(u, "Romeo late", "")
	rowsBefore := e.rows(g1, generation.CorpusItem)
	g1Jobs := e.availableJobs(g1.ID)
	if len(g1Jobs) != 1 {
		t.Fatalf("g1 jobs = %d, want 1", len(g1Jobs))
	}
	err := e.runJob(e.deps(csB), g1Jobs[0].id, g1Jobs[0].kind, g1Jobs[0].raw)
	var snooze *river.JobSnoozeError
	if !errors.As(err, &snooze) {
		t.Fatalf("g1 job without a matching client: err = %v, want a snooze", err)
	}
	if got := e.rows(g1, generation.CorpusItem); got != rowsBefore {
		t.Fatalf("g1 item vectors %d -> %d: a job without a matching client wrote", rowsBefore, got)
	}
	if mB.srv.Stats().DocumentRequests != 0 {
		t.Fatal("the 768 provider was asked to embed a document for the 1024 generation")
	}

	// A wrong-width vector for g1 is refused before SQL.
	h := embedding.InputHashFor(g1.Identity(), "x")
	err = store.Upsert(e.ctx, e.pool, g1, generation.CorpusItem, u, late, make([]float32, 768), h[:])
	mustErrorIs(t, "Upsert of a 768 vector into g1", err, store.ErrDimsMismatch)
	if got := e.rows(g1, generation.CorpusItem); got != rowsBefore {
		t.Fatalf("g1 item vectors changed to %d after a refused upsert", got)
	}

	// Everything configured: backfill g2 and run all jobs (including the snoozed one).
	e.backfill(g2)
	e.drain(deps, 0)
	if _, err := lifecycle.Index(e.ctx, e.pool, g2.ID); err != nil {
		t.Fatalf("Index: %v", err)
	}
	rep, verr := lifecycle.Verify(e.ctx, e.pool, g2.ID, lifecycle.VerifyOpts{})
	if verr != nil || !rep.Passed || !rep.DimsOK {
		t.Fatalf("Verify = %+v, %v; want passed with dims ok", rep, verr)
	}
	for _, tc := range []struct {
		g    generation.Generation
		dims int
	}{{e.gen(g1.ID), 1024}, {e.gen(g2.ID), 768}} {
		for _, corpus := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
			if dims := e.vectorDims(tc.g, corpus); len(dims) != 1 || dims[0] != tc.dims {
				t.Fatalf("generation %d %s vector dims = %v, want [%d]", tc.g.ID, corpus, dims, tc.dims)
			}
		}
	}
	e.wantVector(e.gen(g1.ID), generation.CorpusItem, u, late, embedding.ItemInput("Romeo late", ""))
	e.wantVector(e.gen(g2.ID), generation.CorpusItem, u, late, embedding.ItemInput("Romeo late", ""))

	// After the flip, a request pin has 768 dims and a 1024-wide query vector is
	// refused before any SQL.
	if err := lifecycle.Flip(e.ctx, e.pool, g2.ID, lifecycle.FlipOpts{Reason: "test", RollbackWindow: time.Hour}); err != nil {
		t.Fatalf("Flip: %v", err)
	}
	pinner := generation.NewPinner(e.pool)
	defer pinner.Close()
	pin, err := pinner.ActivePin(e.ctx)
	if err != nil || pin.GenID != g2.ID || pin.Identity.Dims != 768 {
		t.Fatalf("pin after flip = %+v, %v; want generation %d with 768 dims", pin, err, g2.ID)
	}
	_, _, err = store.VectorSearch(e.ctx, e.pool, pin, u, generation.CorpusItem, make([]float32, 1024), 5,
		time.Now().Add(time.Second), store.DefaultVectorSearchKnobs())
	mustErrorIs(t, "1024-wide query against the 768 pin", err, store.ErrDimsMismatch)
}

// TestFlipPinsInflightRequests: a request pinned to g1 before the flip finishes
// on g1; the next request pins g2; the two never share cache-key namespace.
func TestFlipPinsInflightRequests(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(e.ctx, 60*time.Second)
	defer cancel()
	mA := e.model(8, "rev-a")
	mB := e.model(8, "rev-b")
	g1 := e.bootstrapActive(mA)
	cs := e.clientSet(mA, &mB)
	u := e.user("pins@example.com")
	target := e.newItem(u, "Sierra pinned", "")
	e.drain(e.deps(cs), 0)
	g2 := e.create(mB)
	e.ready(g2, cs)

	pinner := generation.NewPinner(e.pool)
	defer pinner.Close()
	if err := pinner.StartListener(ctx); err != nil {
		t.Fatalf("StartListener: %v", err)
	}
	notified := make(chan struct{}, 1)
	pinner.Subscribe(func() {
		select {
		case notified <- struct{}{}:
		default:
		}
	})

	// The flip completes (commit + NOTIFY) right after this request read its pin.
	var flipErr error
	var flipped bool
	reqCtx := generation.WithAfterPinReadHook(ctx, func(p generation.Pin) {
		if p.GenID != g1.ID {
			t.Errorf("request pinned generation %d, want %d", p.GenID, g1.ID)
		}
		flipErr = lifecycle.Flip(ctx, e.pool, g2.ID, lifecycle.FlipOpts{Reason: "test", RollbackWindow: time.Hour})
		flipped = true
	})
	pin1, err := pinner.ActivePin(reqCtx)
	if err != nil {
		t.Fatalf("ActivePin: %v", err)
	}
	if !flipped || flipErr != nil {
		t.Fatalf("flip during the request: ran=%v err=%v", flipped, flipErr)
	}
	if e.activeID() != g2.ID {
		t.Fatalf("active = %d, want %d", e.activeID(), g2.ID)
	}

	// The in-flight request keeps using g1: its tables still answer, with the
	// vector of model A.
	knobs := store.DefaultVectorSearchKnobs()
	q1 := e.storedVector(g1, generation.CorpusItem, u, target)
	hits, _, err := store.VectorSearch(ctx, e.pool, pin1, u, generation.CorpusItem, q1, 5, time.Now().Add(2*time.Second), knobs)
	if err != nil || len(hits) != 1 || hits[0].ID != target {
		t.Fatalf("pinned request hits = %v, %v; want the target from g1", hits, err)
	}

	// The next request, after the NOTIFY, pins g2.
	select {
	case <-notified:
	case <-ctx.Done():
		t.Fatal("timed out waiting for NOTIFY embedding_generation_changed")
	}
	pin2, err := pinner.ActivePin(ctx)
	if err != nil {
		t.Fatalf("ActivePin after flip: %v", err)
	}
	if pin1.GenID != g1.ID || pin2.GenID != g2.ID || pin1.ItemTable == pin2.ItemTable || pin1.Identity.Key() == pin2.Identity.Key() {
		t.Fatalf("pins = %+v / %+v, want g1 then g2 with different tables and identities", pin1, pin2)
	}
	q2 := e.storedVector(g2, generation.CorpusItem, u, target)
	hits, _, err = store.VectorSearch(ctx, e.pool, pin2, u, generation.CorpusItem, q2, 5, time.Now().Add(2*time.Second), knobs)
	if err != nil || len(hits) != 1 || hits[0].ID != target {
		t.Fatalf("second request hits = %v, %v; want the target from g2", hits, err)
	}

	// Query-embedding cache keys are namespaced by generation.
	cache := semantic.NewQueryCache(0, 0, nil)
	k1 := cache.Key(u, pin1.GenID, "same query")
	k2 := cache.Key(u, pin2.GenID, "same query")
	if k1 == k2 {
		t.Fatal("cache keys of g1 and g2 are equal")
	}
	if string(k1[:16]) != string(k2[:16]) || string(k1[20:]) != string(k2[20:]) || string(k1[16:20]) == string(k2[16:20]) {
		t.Fatal("cache keys differ in more than the generation namespace")
	}
}
