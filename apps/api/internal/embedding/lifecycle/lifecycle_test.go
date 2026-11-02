package lifecycle_test

import (
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/embedding/lifecycle"
)

// TestCreateRefusals: create is exclusive and gated (plan 2.15 step 1): no write
// without calibration, one pending at a time, tables without HNSW.
func TestCreateRefusals(t *testing.T) {
	e := newEnv(t)
	mA := e.model(8, "rev-a")
	mB := e.model(8, "rev-b")
	mC := e.model(8, "rev-c")
	e.bootstrapActive(mA)

	opts := lifecycle.CreateOpts{Partitions: 2, M: 8, EfConstruction: 32}
	var before int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*)::int FROM embedding_generation`).Scan(&before); err != nil {
		t.Fatalf("count generations: %v", err)
	}
	_, err := lifecycle.Create(e.ctx, e.pool, mB.ident(), noCalib, opts)
	mustErrorIs(t, "Create without calibration", err, lifecycle.ErrCalibrationMissing)
	var after int
	var tableExists bool
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*)::int, to_regclass('item_embedding_g2') IS NOT NULL FROM embedding_generation`).Scan(&after, &tableExists); err != nil {
		t.Fatalf("recount: %v", err)
	}
	if after != before || tableExists {
		t.Fatalf("refused Create left state behind: rows %d -> %d, table exists %v", before, after, tableExists)
	}
	_, err = lifecycle.Create(e.ctx, e.pool, mB.ident(), nil, opts)
	mustErrorIs(t, "Create with nil calibration", err, lifecycle.ErrCalibrationMissing)

	g2 := e.create(mB)
	if g2.ID != 2 || g2.Partitions != 2 || g2.IndexReady || g2.Dims != 8 || g2.Provider != generation.ProviderTEI {
		t.Fatalf("created generation = %+v, want id 2, 2 partitions, not index_ready", g2)
	}
	var hnsw int
	if err := e.pool.QueryRow(e.ctx,
		`SELECT count(*)::int FROM pg_indexes WHERE tablename LIKE 'item\_embedding\_g2%' AND indexdef LIKE '%hnsw%'`).Scan(&hnsw); err != nil {
		t.Fatalf("count hnsw indexes: %v", err)
	}
	if hnsw != 0 {
		t.Fatalf("freshly created generation has %d hnsw indexes, want 0 (built by Index after the backfill)", hnsw)
	}

	// A pending generation exists: refused before the calibration check.
	_, err = lifecycle.Create(e.ctx, e.pool, mC.ident(), noCalib, opts)
	mustErrorIs(t, "Create while pending exists", err, lifecycle.ErrPendingExists)
	_, err = lifecycle.Create(e.ctx, e.pool, mC.ident(), calib, opts)
	mustErrorIs(t, "Create while pending exists (calibrated)", err, lifecycle.ErrPendingExists)

	// Option validation: efc < 2*m is refused by the DDL range check up front.
	if err := lifecycle.Retire(e.ctx, e.pool, g2.ID, lifecycle.RetireOpts{}); err != nil {
		t.Fatalf("Retire pending: %v", err)
	}
	if _, err := lifecycle.Create(e.ctx, e.pool, mC.ident(), calib, lifecycle.CreateOpts{Partitions: 2, M: 16, EfConstruction: 20}); err == nil {
		t.Fatal("Create accepted ef_construction < 2*m")
	}
}

// TestIndexBuildsAndRepairs: index is concurrent per partition, attaches the
// parent, sets index_ready only when every per-partition index is valid, is
// idempotent, and rebuilds an invalid index left by a crash.
func TestIndexBuildsAndRepairs(t *testing.T) {
	e := newEnv(t)
	m := e.model(8, "rev-a")
	g2 := e.create(m)
	id2 := g2.ID

	res, err := lifecycle.Index(e.ctx, e.pool, g2.ID)
	if err != nil {
		t.Fatalf("Index: %v", err)
	}
	if res.Expected != 4 || res.Built != 4 || res.Valid != 4 || !res.Ready || res.Repaired != 0 || res.AlreadyValid != 0 {
		t.Fatalf("Index result = %+v, want 4 built, 4 valid, ready", res)
	}
	if !e.gen(g2.ID).IndexReady {
		t.Fatal("index_ready not set after a complete Index")
	}
	var validParts int
	if err := e.pool.QueryRow(e.ctx, `
SELECT count(*)::int FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname ~ $1 AND i.indisvalid`, fmt.Sprintf(`^(item|tag)_embedding_g%d_p[0-9]+_hnsw$`, id2)).Scan(&validParts); err != nil || validParts != 4 {
		t.Fatalf("valid per-partition indexes = %d (err %v), want 4", validParts, err)
	}
	var parentValid bool
	if err := e.pool.QueryRow(e.ctx,
		`SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = to_regclass($1)`, fmt.Sprintf("item_embedding_g%d_hnsw", id2)).Scan(&parentValid); err != nil || !parentValid {
		t.Fatalf("parent index valid = %v (err %v), want true after every partition is attached", parentValid, err)
	}

	res, err = lifecycle.Index(e.ctx, e.pool, g2.ID)
	if err != nil {
		t.Fatalf("Index (re-run): %v", err)
	}
	if res.AlreadyValid != 4 || res.Built != 0 || res.Repaired != 0 || !res.Ready {
		t.Fatalf("re-run result = %+v, want 4 already valid", res)
	}

	// Only a pending generation is indexed.
	if err := lifecycle.Retire(e.ctx, e.pool, g2.ID, lifecycle.RetireOpts{}); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	_, err = lifecycle.Index(e.ctx, e.pool, g2.ID)
	mustErrorIs(t, "Index on a retired generation", err, lifecycle.ErrNotPending)

	// Crash repair: an invalid (never attached) index is dropped and rebuilt.
	g3 := e.create(m)
	idx3 := fmt.Sprintf("item_embedding_g%d_p0_hnsw", g3.ID)
	e.exec(fmt.Sprintf(`CREATE INDEX %s ON item_embedding_g%d_p0 USING hnsw (embedding vector_cosine_ops) WITH (m = 8, ef_construction = 32)`, idx3, g3.ID))
	e.exec(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass($1)`, idx3)
	res, err = lifecycle.Index(e.ctx, e.pool, g3.ID)
	if err != nil {
		t.Fatalf("Index repairing: %v", err)
	}
	if res.Repaired != 1 || res.Built != 3 || res.Valid != 4 || !res.Ready {
		t.Fatalf("repair result = %+v, want 1 repaired, 3 built, ready", res)
	}
	var valid bool
	if err := e.pool.QueryRow(e.ctx,
		`SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = to_regclass($1)`, idx3).Scan(&valid); err != nil || !valid {
		t.Fatalf("repaired index valid = %v (err %v)", valid, err)
	}
}

// TestFlipPreconditions: flip refuses without index, without a passing
// verification, with a stale or failed one, and for a generation that is not
// pending.
func TestFlipPreconditions(t *testing.T) {
	e := newEnv(t)
	mA := e.model(8, "rev-a")
	mB := e.model(8, "rev-b")
	g1 := e.bootstrapActive(mA)
	cs := e.clientSet(mA, &mB)
	u := e.user("preconditions@example.com")
	e.newItem(u, "Nov precondition", "")
	e.drain(e.deps(cs), 0)

	g2 := e.create(mB)
	opts := lifecycle.FlipOpts{Reason: "test"}

	mustErrorIs(t, "Flip without index", lifecycle.Flip(e.ctx, e.pool, g2.ID, opts), lifecycle.ErrIndexNotReady)

	e.backfill(g2)
	e.drain(e.deps(cs), 0)
	if _, err := lifecycle.Index(e.ctx, e.pool, g2.ID); err != nil {
		t.Fatalf("Index: %v", err)
	}
	mustErrorIs(t, "Flip never verified", lifecycle.Flip(e.ctx, e.pool, g2.ID, opts), lifecycle.ErrNotVerified)

	rep, err := lifecycle.Verify(e.ctx, e.pool, g2.ID, lifecycle.VerifyOpts{})
	if err != nil || !rep.Passed {
		t.Fatalf("Verify = %+v, %v; want passed", rep, err)
	}

	e.exec(`UPDATE embedding_generation SET verified_at = now() - interval '2 hours' WHERE id = $1`, g2.ID)
	mustErrorIs(t, "Flip with a stale verification", lifecycle.Flip(e.ctx, e.pool, g2.ID, opts), lifecycle.ErrVerifyStale)

	e.exec(`UPDATE embedding_generation SET verified_at = now(), verify_report = jsonb_set(verify_report, '{passed}', 'false'::jsonb) WHERE id = $1`, g2.ID)
	mustErrorIs(t, "Flip with a failed verification", lifecycle.Flip(e.ctx, e.pool, g2.ID, opts), lifecycle.ErrNotVerified)
	if e.activeID() != g1.ID {
		t.Fatal("a refused Flip changed the active generation")
	}

	if rep, err = lifecycle.Verify(e.ctx, e.pool, g2.ID, lifecycle.VerifyOpts{}); err != nil || !rep.Passed {
		t.Fatalf("re-Verify = %+v, %v; want passed", rep, err)
	}
	if err := lifecycle.Flip(e.ctx, e.pool, g2.ID, lifecycle.FlipOpts{Reason: "test", RollbackWindow: time.Hour}); err != nil {
		t.Fatalf("Flip: %v", err)
	}
	if e.activeID() != g2.ID {
		t.Fatalf("active = %d, want %d", e.activeID(), g2.ID)
	}
	old := e.gen(g1.ID)
	if old.State != generation.StateRetired || old.RollbackUntil == nil || !old.RollbackUntil.After(time.Now()) {
		t.Fatalf("old active after flip = %+v, want retired with an open rollback window", old)
	}
	mustErrorIs(t, "Flip of the active generation", lifecycle.Flip(e.ctx, e.pool, g2.ID, opts), lifecycle.ErrNotPending)
}

// TestFlipRefusedBelowFullCoverage: 99 of 100 vectors is not enough (no "95 %"),
// and an unfinished embed job of the generation blocks the flip inside the
// exclusive transaction even when the dry run looks complete.
func TestFlipRefusedBelowFullCoverage(t *testing.T) {
	e := newEnv(t)
	mA := e.model(8, "rev-a")
	mB := e.model(8, "rev-b")
	g1 := e.bootstrapActive(mA)
	cs := e.clientSet(mA, &mB)
	deps := e.deps(cs)
	u := e.user("coverage@example.com")
	victim, anyItem := e.newItem(u, "Item 000", ""), e.newItem(u, "Item 001", "")
	for i := 2; i < 100; i++ {
		e.newItem(u, "Item "+strconv.Itoa(1000+i), "")
	}
	e.drain(deps, 0)

	g2 := e.create(mB)
	e.ready(g2, cs)
	if got := e.rows(g2, generation.CorpusItem); got != 100 {
		t.Fatalf("g2 item vectors = %d, want 100", got)
	}

	// 99 %: one vector gone after the verification passed.
	e.exec(`DELETE FROM item_embedding_g2 WHERE target_id = $1`, victim)
	flipOpts := lifecycle.FlipOpts{Reason: "test", RollbackWindow: time.Hour}
	mustErrorIs(t, "Flip at 99 %", lifecycle.Flip(e.ctx, e.pool, g2.ID, flipOpts), lifecycle.ErrCoverageIncomplete)
	if e.activeID() != g1.ID || e.gen(g2.ID).State != generation.StatePending {
		t.Fatal("flip at 99 % coverage changed state")
	}

	rep, err := lifecycle.Verify(e.ctx, e.pool, g2.ID, lifecycle.VerifyOpts{})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if rep.Passed || rep.Reason != lifecycle.ReasonCoverageIncomplete || rep.Coverage.Missing != 1 || rep.Coverage.Complete {
		t.Fatalf("Verify at 99 %% = %+v, want failed with exactly 1 missing", rep)
	}
	mustErrorIs(t, "Flip after a failed verify", lifecycle.Flip(e.ctx, e.pool, g2.ID, flipOpts), lifecycle.ErrNotVerified)

	// Repair, verify, then queue one more embed job after the watermark: the
	// dry run is complete but the generation is not caught up.
	e.backfill(g2)
	e.drain(deps, 0)
	if rep, err = lifecycle.Verify(e.ctx, e.pool, g2.ID, lifecycle.VerifyOpts{}); err != nil || !rep.Passed {
		t.Fatalf("Verify after repair = %+v, %v; want passed", rep, err)
	}
	var itemID, userID string
	if err := e.pool.QueryRow(e.ctx, `SELECT id::text, user_id::text FROM item WHERE id = $1`, anyItem).Scan(&itemID, &userID); err != nil {
		t.Fatalf("read item: %v", err)
	}
	res, err := e.insert.Insert(e.ctx, jobargs.EmbedItemArgs{
		GenerationID: g2.ID, UserID: userID, TargetID: itemID,
		InputHash: hashHex(g2, embedding.ItemInput("Item 001", "")),
	}, jobs.EmbedInsertOpts(jobargs.KindEmbedItem))
	if err != nil {
		t.Fatalf("insert late job: %v", err)
	}
	mustErrorIs(t, "Flip with an unfinished embed job", lifecycle.Flip(e.ctx, e.pool, g2.ID, flipOpts), lifecycle.ErrCoverageIncomplete)
	e.complete(res.Job.ID)
	if err := lifecycle.Flip(e.ctx, e.pool, g2.ID, flipOpts); err != nil {
		t.Fatalf("Flip at full coverage: %v", err)
	}
	if e.activeID() != g2.ID {
		t.Fatalf("active = %d, want %d", e.activeID(), g2.ID)
	}
}

// TestRollbackRequiresCatchUp: rollback only inside the window and only once
// the retired generation has caught up with every mutation since the flip.
func TestRollbackRequiresCatchUp(t *testing.T) {
	e := newEnv(t)
	mA := e.model(8, "rev-a")
	mB := e.model(8, "rev-b")
	g1 := e.bootstrapActive(mA)
	cs := e.clientSet(mA, &mB)
	deps := e.deps(cs)
	u := e.user("rollback@example.com")
	for _, n := range []string{"Oscar one", "Papa two", "Quebec three"} {
		e.newItem(u, n, "")
	}
	e.newTag(u, "tag-romeo")
	e.drain(deps, 0)

	g2 := e.create(mB)
	e.ready(g2, cs)
	if err := lifecycle.Flip(e.ctx, e.pool, g2.ID, lifecycle.FlipOpts{Reason: "test", RollbackWindow: time.Hour}); err != nil {
		t.Fatalf("Flip: %v", err)
	}

	// A mutation after the flip fans out to g2 (active) and g1 (retired, in the
	// window). Only g2 is worked: g1 falls behind.
	late := e.newItem(u, "Sierra late", "")
	e.drain(deps, g2.ID)
	err := lifecycle.Rollback(e.ctx, e.pool, g1.ID, lifecycle.RollbackOpts{Reason: "test"})
	mustErrorIs(t, "Rollback of a generation that is behind", err, lifecycle.ErrGenerationNotCaughtUp)
	if e.activeID() != g2.ID || e.gen(g1.ID).State != generation.StateRetired {
		t.Fatal("a refused Rollback changed state")
	}

	// Catch up, then roll back.
	e.drain(deps, g1.ID)
	if err := lifecycle.Rollback(e.ctx, e.pool, g1.ID, lifecycle.RollbackOpts{Reason: "test", RollbackWindow: time.Hour}); err != nil {
		t.Fatalf("Rollback after catch-up: %v", err)
	}
	if e.activeID() != g1.ID {
		t.Fatalf("active after rollback = %d, want %d", e.activeID(), g1.ID)
	}
	e.wantVector(e.gen(g1.ID), generation.CorpusItem, u, late, embedding.ItemInput("Sierra late", ""))
	replaced := e.gen(g2.ID)
	if replaced.State != generation.StateRetired || replaced.RollbackUntil == nil {
		t.Fatalf("replaced generation = %+v, want retired with a rollback window", replaced)
	}

	// Outside the window: refused, whatever the state of the vectors.
	e.exec(`UPDATE embedding_generation SET rollback_until = now() - interval '1 minute' WHERE id = $1`, g2.ID)
	mustErrorIs(t, "Rollback outside the window",
		lifecycle.Rollback(e.ctx, e.pool, g2.ID, lifecycle.RollbackOpts{}), lifecycle.ErrRollbackWindowClosed)
	mustErrorIs(t, "Rollback to the active generation",
		lifecycle.Rollback(e.ctx, e.pool, g1.ID, lifecycle.RollbackOpts{}), lifecycle.ErrNotRetired)
}

// TestDropGuards: drop only a retired generation whose window has ended, with
// accepted evidence; never active, pending or inside the window.
func TestDropGuards(t *testing.T) {
	e := newEnv(t)
	mA := e.model(8, "rev-a")
	mB := e.model(8, "rev-b")
	mC := e.model(8, "rev-c")
	g1 := e.bootstrapActive(mA)
	g2 := e.create(mB)
	const evidence = "docs/benchmarks/P05-search/results/accepted.md"

	// Active generation.
	err := lifecycle.Drop(e.ctx, e.pool, g1.ID, lifecycle.DropOpts{AcceptedEvidence: evidence})
	mustErrorIs(t, "Drop active", err, lifecycle.ErrDropGuard)
	mustErrorIs(t, "Drop active (reason)", err, lifecycle.ErrIsActive)
	mustErrorIs(t, "Retire active", lifecycle.Retire(e.ctx, e.pool, g1.ID, lifecycle.RetireOpts{}), lifecycle.ErrIsActive)
	if e.activeID() != g1.ID {
		t.Fatal("active generation changed")
	}

	// Pending generation.
	err = lifecycle.Drop(e.ctx, e.pool, g2.ID, lifecycle.DropOpts{AcceptedEvidence: evidence})
	mustErrorIs(t, "Drop pending", err, lifecycle.ErrDropGuard)
	mustErrorIs(t, "Drop pending (reason)", err, lifecycle.ErrNotRetired)

	// Retired, no evidence.
	if err := lifecycle.Retire(e.ctx, e.pool, g2.ID, lifecycle.RetireOpts{}); err != nil {
		t.Fatalf("Retire pending: %v", err)
	}
	mustErrorIs(t, "Drop without evidence", lifecycle.Drop(e.ctx, e.pool, g2.ID, lifecycle.DropOpts{}), lifecycle.ErrDropGuard)
	mustErrorIs(t, "Drop with blank evidence", lifecycle.Drop(e.ctx, e.pool, g2.ID, lifecycle.DropOpts{AcceptedEvidence: "  "}), lifecycle.ErrDropGuard)

	// Retired, still inside the window.
	e.exec(`UPDATE embedding_generation SET rollback_until = now() + interval '1 hour' WHERE id = $1`, g2.ID)
	mustErrorIs(t, "Drop inside the window",
		lifecycle.Drop(e.ctx, e.pool, g2.ID, lifecycle.DropOpts{AcceptedEvidence: evidence}), lifecycle.ErrDropGuard)
	var exists bool
	if err := e.pool.QueryRow(e.ctx, `SELECT to_regclass('item_embedding_g2') IS NOT NULL`).Scan(&exists); err != nil || !exists {
		t.Fatalf("tables of a refused drop exist = %v (err %v), want true", exists, err)
	}

	// Closing the window early (Retire on a retired generation) allows the drop.
	if err := lifecycle.Retire(e.ctx, e.pool, g2.ID, lifecycle.RetireOpts{}); err != nil {
		t.Fatalf("Retire (close window): %v", err)
	}
	if err := lifecycle.Drop(e.ctx, e.pool, g2.ID, lifecycle.DropOpts{
		AcceptedEvidence: evidence,
		Now:              func() time.Time { return time.Now().Add(time.Minute) },
	}); err != nil {
		t.Fatalf("Drop after the window: %v", err)
	}
	dropped := e.gen(g2.ID)
	if dropped.State != generation.StateDropped || dropped.DroppedAt == nil {
		t.Fatalf("dropped generation = %+v", dropped)
	}
	if err := e.pool.QueryRow(e.ctx, `SELECT to_regclass('item_embedding_g2') IS NOT NULL OR to_regclass('tag_embedding_g2') IS NOT NULL`).Scan(&exists); err != nil || exists {
		t.Fatalf("tables after Drop exist = %v (err %v), want false", exists, err)
	}
	mustErrorIs(t, "Drop twice",
		lifecycle.Drop(e.ctx, e.pool, g2.ID, lifecycle.DropOpts{AcceptedEvidence: evidence}), lifecycle.ErrDropGuard)

	// Ids are never reused: the next generation is 3.
	g3 := e.create(mC)
	if g3.ID != 3 {
		t.Fatalf("next generation id = %d, want 3", g3.ID)
	}
}

// TestOldGenerationJobNeverWritesNewTables: a job carries its own generation id;
// it writes only that generation's tables, and after the generation left R it
// writes nothing at all and never calls the provider.
func TestOldGenerationJobNeverWritesNewTables(t *testing.T) {
	e := newEnv(t)
	mA := e.model(8, "rev-a")
	mB := e.model(8, "rev-b")
	g1 := e.bootstrapActive(mA)
	cs := e.clientSet(mA, &mB)
	deps := e.deps(cs)
	u := e.user("old-gen@example.com")

	x := e.newItem(u, "Tango manual", "") // fans out to g1 only: g2 does not exist yet
	g2 := e.create(mB)
	g1Jobs := e.availableJobs(g1.ID)
	if len(g1Jobs) != 1 {
		t.Fatalf("g1 jobs = %d, want 1", len(g1Jobs))
	}
	if err := e.runJob(deps, g1Jobs[0].id, g1Jobs[0].kind, g1Jobs[0].raw); err != nil {
		t.Fatalf("g1 job: %v", err)
	}
	e.complete(g1Jobs[0].id)
	input := embedding.ItemInput("Tango manual", "")
	e.wantVector(g1, generation.CorpusItem, u, x, input)
	e.wantNoVector(g2, generation.CorpusItem, u, x)
	if e.rows(g2, generation.CorpusItem) != 0 {
		t.Fatal("a g1 job wrote into g2's tables")
	}

	// The g2 job writes g2 only and leaves g1's vector (model A) untouched.
	e.backfill(g2)
	g2Jobs := e.availableJobs(g2.ID)
	if len(g2Jobs) != 1 {
		t.Fatalf("g2 jobs = %d, want 1", len(g2Jobs))
	}
	if err := e.runJob(deps, g2Jobs[0].id, g2Jobs[0].kind, g2Jobs[0].raw); err != nil {
		t.Fatalf("g2 job: %v", err)
	}
	e.complete(g2Jobs[0].id)
	e.wantVector(g2, generation.CorpusItem, u, x, input)
	e.wantVector(g1, generation.CorpusItem, u, x, input)

	// Cut over, then let g1's window end: a leftover g1 job is discarded.
	e.ready(g2, cs)
	if err := lifecycle.Flip(e.ctx, e.pool, g2.ID, lifecycle.FlipOpts{Reason: "test", RollbackWindow: time.Hour}); err != nil {
		t.Fatalf("Flip: %v", err)
	}
	e.exec(`UPDATE embedding_generation SET rollback_until = now() - interval '1 minute' WHERE id = $1`, g1.ID)
	y := e.newItem(u, "Uniform late", "") // R = {g2} now: one g2 job
	inputY := embedding.ItemInput("Uniform late", "")
	res, err := e.insert.Insert(e.ctx, jobargs.EmbedItemArgs{
		GenerationID: g1.ID, UserID: u.String(), TargetID: y.String(), InputHash: hashHex(g1, inputY),
	}, jobs.EmbedInsertOpts(jobargs.KindEmbedItem))
	if err != nil {
		t.Fatalf("insert leftover g1 job: %v", err)
	}
	before := mA.srv.Stats().TotalRequests
	beforeB := mB.srv.Stats().TotalRequests
	if err := e.runJob(deps, res.Job.ID, jobargs.KindEmbedItem, res.Job.EncodedArgs); err != nil {
		t.Fatalf("leftover g1 job: %v", err)
	}
	e.wantNoVector(g1, generation.CorpusItem, u, y)
	e.wantNoVector(g2, generation.CorpusItem, u, y)
	if mA.srv.Stats().TotalRequests != before || mB.srv.Stats().TotalRequests != beforeB {
		t.Fatal("a job of a generation outside R called a provider")
	}
}

// TestJobsNotDedupedAcrossGenerations: the same target and input hash in two
// generations are two jobs (generation_id is part of the args), while the same
// job twice in one generation is deduplicated.
func TestJobsNotDedupedAcrossGenerations(t *testing.T) {
	e := newEnv(t)
	mA := e.model(8, "rev-a")
	g1 := e.bootstrapActive(mA)
	g2 := e.create(mA) // identical identity: identical input_hash in both
	if g1.Identity().Key() != g2.Identity().Key() {
		t.Fatal("test needs two generations of one identity")
	}
	u := e.user("nodedupe@example.com")
	target := e.newItem(u, "Victor twin", "")

	rows, err := e.pool.Query(e.ctx, `
SELECT (args->>'generation_id')::int, args->>'input_hash' FROM river_job
WHERE kind = $1 AND args->>'target_id' = $2 ORDER BY 1`, jobargs.KindEmbedItem, target.String())
	if err != nil {
		t.Fatalf("query jobs: %v", err)
	}
	type jobRow struct {
		gen  int
		hash string
	}
	var got []jobRow
	for rows.Next() {
		var r jobRow
		if err := rows.Scan(&r.gen, &r.hash); err != nil {
			rows.Close()
			t.Fatalf("scan: %v", err)
		}
		got = append(got, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	want := hashHex(g1, embedding.ItemInput("Victor twin", ""))
	if len(got) != 2 || got[0].gen != g1.ID || got[1].gen != g2.ID || got[0].hash != want || got[1].hash != want {
		t.Fatalf("jobs = %+v, want one job per generation with the same hash %s", got, want)
	}

	// Control: dedupe still works inside one generation.
	res, err := e.insert.Insert(e.ctx, jobargs.EmbedItemArgs{
		GenerationID: g1.ID, UserID: u.String(), TargetID: target.String(), InputHash: want,
	}, jobs.EmbedInsertOpts(jobargs.KindEmbedItem))
	if err != nil {
		t.Fatalf("insert duplicate: %v", err)
	}
	if !res.UniqueSkippedAsDuplicate {
		t.Fatal("same args in the same generation were not deduplicated")
	}
	var n int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*)::int FROM river_job WHERE kind = $1 AND args->>'target_id' = $2`,
		jobargs.KindEmbedItem, target.String()).Scan(&n); err != nil || n != 2 {
		t.Fatalf("jobs for the target = %d (err %v), want 2", n, err)
	}
}

// TestVerifyWatermarkJobs: a job created after W does
// not count towards jobs_pending_before_watermark, one created before does.
func TestVerifyWatermarkJobs(t *testing.T) {
	e := newEnv(t)
	mA := e.model(8, "rev-a")
	mB := e.model(8, "rev-b")
	e.bootstrapActive(mA)
	cs := e.clientSet(mA, &mB)
	u := e.user("watermark@example.com")
	e.newItem(u, "Whiskey early", "")
	e.drain(e.deps(cs), 0)

	g2 := e.create(mB)
	e.backfill(g2)
	e.drain(e.deps(cs), 0)
	if _, err := lifecycle.Index(e.ctx, e.pool, g2.ID); err != nil {
		t.Fatalf("Index: %v", err)
	}

	// A mutation that lands right after the watermark is not "before" it.
	var lateGen int
	rep, err := lifecycle.Verify(e.ctx, e.pool, g2.ID, lifecycle.VerifyOpts{
		AfterWatermark: func() {
			e.newItem(u, "Xray after watermark", "")
			lateGen++
		},
	})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if lateGen != 1 {
		t.Fatalf("AfterWatermark ran %d times, want 1", lateGen)
	}
	if rep.JobsPendingBeforeWatermark != 0 {
		t.Fatalf("jobs before watermark = %d, want 0 (the job was created after W)", rep.JobsPendingBeforeWatermark)
	}
	// ...but the new target has no vector yet, so coverage is incomplete.
	if rep.Passed || rep.Reason != lifecycle.ReasonCoverageIncomplete || rep.Coverage.Missing != 1 {
		t.Fatalf("report = %+v, want coverage_incomplete with 1 missing", rep)
	}

	// A job created before W and unfinished blocks verify with jobs_pending.
	rep, err = lifecycle.Verify(e.ctx, e.pool, g2.ID, lifecycle.VerifyOpts{})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if rep.JobsPendingBeforeWatermark != 1 || rep.Passed || rep.Reason != lifecycle.ReasonJobsPending {
		t.Fatalf("report = %+v, want 1 unfinished job before W and reason %s", rep, lifecycle.ReasonJobsPending)
	}
	e.drain(e.deps(cs), 0)
	if rep, err = lifecycle.Verify(e.ctx, e.pool, g2.ID, lifecycle.VerifyOpts{}); err != nil || !rep.Passed {
		t.Fatalf("Verify after the job ran = %+v, %v; want passed", rep, err)
	}
}
