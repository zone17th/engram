package lifecycle_test

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/lifecycle"
)

// openAICompat turns a fake model into an openai_compat identity (same dims, same
// embedding space rules); no provider call is made by these tests.
func openAICompat(m model) model {
	m.client.Identity.Provider = generation.ProviderOpenAICompat
	return m
}

// setSuggest flips app_user.settings.semantic_suggest the way the real settings
// mutation does: under the shared generation lock, in one transaction. It
// deliberately enqueues nothing (the reembed_user job may be skipped by the auth
// rate limiter, and is unprocessed here).
func (e *env) setSuggest(user uuid.UUID, on bool) {
	e.t.Helper()
	e.mutate(func(tx pgx.Tx) error {
		if err := generation.LockGenerationSetShared(e.ctx, tx); err != nil {
			return err
		}
		_, err := tx.Exec(e.ctx,
			`UPDATE app_user SET settings = jsonb_set(settings, '{semantic_suggest}', to_jsonb($2::boolean)) WHERE id = $1`,
			user, on)
		return err
	})
}

func (e *env) embedJobCount(genID int) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(e.ctx,
		`SELECT count(*)::int FROM river_job WHERE kind IN ('embed_item', 'embed_tag') AND (args->>'generation_id')::int = $1`,
		genID).Scan(&n); err != nil {
		e.t.Fatalf("count embed jobs: %v", err)
	}
	return n
}

// TestFlipRefusedWhenEligibilityChangesAfterDryRun (GL-1): an openai_compat
// user switching semantic_suggest off -> on between the outside-lock dry run and
// the exclusive lock creates missing vectors but no embed_item/embed_tag job.
// The exclusive transaction must prove coverage itself and refuse.
func TestFlipRefusedWhenEligibilityChangesAfterDryRun(t *testing.T) {
	e := newEnv(t)
	mA := e.model(8, "rev-a")
	mB := openAICompat(e.model(8, "rev-b"))
	g1 := e.bootstrapActive(mA)
	cs := e.clientSet(mA, nil)
	u := e.user("offon-flip@example.com")
	e.setSuggest(u, false)
	e.newItem(u, "Alpha live target", "")
	e.newTag(u, "tag-alpha-live")
	e.drain(e.deps(cs), 0)

	// The pending openai_compat generation correctly holds nothing for U while U
	// is off, so verification passes with zero vectors.
	g2 := e.create(mB)
	e.ready(g2, cs)
	if e.rows(g2, generation.CorpusItem)+e.rows(g2, generation.CorpusTag) != 0 {
		t.Fatal("test needs a pending generation without vectors")
	}

	hookRuns := 0
	opts := lifecycle.FlipOpts{
		Reason:         "test",
		RollbackWindow: time.Hour,
		BeforeExclusive: func() {
			hookRuns++
			e.setSuggest(u, true)
		},
	}
	err := lifecycle.Flip(e.ctx, e.pool, g2.ID, opts)
	mustErrorIs(t, "Flip after off->on between dry run and lock", err, lifecycle.ErrCoverageIncomplete)
	if hookRuns != 1 {
		t.Fatalf("BeforeExclusive ran %d times, want 1", hookRuns)
	}
	if e.embedJobCount(g2.ID) != 0 {
		t.Fatal("test premise broken: the eligibility change created an embed job of the pending generation")
	}
	if e.activeID() != g1.ID || e.gen(g1.ID).State != generation.StateActive || e.gen(g2.ID).State != generation.StatePending {
		t.Fatal("a refused Flip changed the active pointer or generation states")
	}

	// Control: with the user off again the same generation flips, so the refusal
	// above came from the in-lock coverage proof and nothing else.
	e.setSuggest(u, false)
	if err := lifecycle.Flip(e.ctx, e.pool, g2.ID, lifecycle.FlipOpts{Reason: "test", RollbackWindow: time.Hour}); err != nil {
		t.Fatalf("Flip with full coverage: %v", err)
	}
	if e.activeID() != g2.ID {
		t.Fatalf("active = %d, want %d", e.activeID(), g2.ID)
	}
}

// TestRollbackRefusedWhenEligibilityChangesAfterVerify (GL-1): the same gap on
// the rollback path - the retired openai_compat generation passes its catch-up
// verification while the user is off, the user switches on before the exclusive
// lock, and no job exists for the retired generation.
func TestRollbackRefusedWhenEligibilityChangesAfterVerify(t *testing.T) {
	e := newEnv(t)
	mOld := openAICompat(e.model(8, "rev-a"))
	mNew := e.model(8, "rev-b")
	g1 := e.bootstrapActive(mOld)
	cs := e.clientSet(mNew, nil)
	u := e.user("offon-rollback@example.com")
	e.setSuggest(u, false)
	e.newItem(u, "Bravo live target", "")
	e.newTag(u, "tag-bravo-live")

	g2 := e.create(mNew)
	e.ready(g2, cs)
	if err := lifecycle.Flip(e.ctx, e.pool, g2.ID, lifecycle.FlipOpts{Reason: "test", RollbackWindow: time.Hour}); err != nil {
		t.Fatalf("Flip: %v", err)
	}
	retired := e.gen(g1.ID)
	if retired.State != generation.StateRetired || retired.RollbackUntil == nil {
		t.Fatalf("old generation = %+v, want retired with a window", retired)
	}
	if e.embedJobCount(g1.ID) != 0 {
		t.Fatal("test premise broken: the retired generation has embed jobs")
	}

	hookRuns := 0
	err := lifecycle.Rollback(e.ctx, e.pool, g1.ID, lifecycle.RollbackOpts{
		Reason: "test",
		BeforeExclusive: func() {
			hookRuns++
			e.setSuggest(u, true)
		},
	})
	mustErrorIs(t, "Rollback after off->on between verification and lock", err, lifecycle.ErrCoverageIncomplete)
	mustErrorIs(t, "Rollback after off->on (CLI sentinel)", err, lifecycle.ErrGenerationNotCaughtUp)
	if hookRuns != 1 {
		t.Fatalf("BeforeExclusive ran %d times, want 1", hookRuns)
	}
	after := e.gen(g1.ID)
	if e.activeID() != g2.ID || after.State != generation.StateRetired ||
		after.RollbackUntil == nil || !after.RollbackUntil.Equal(*retired.RollbackUntil) {
		t.Fatalf("a refused Rollback changed state: active %d, target %+v", e.activeID(), after)
	}
	if e.embedJobCount(g1.ID) != 0 {
		t.Fatal("test premise broken: the eligibility change created an embed job of the retired generation")
	}

	// Control: with the user off the rollback succeeds.
	e.setSuggest(u, false)
	if err := lifecycle.Rollback(e.ctx, e.pool, g1.ID, lifecycle.RollbackOpts{Reason: "test"}); err != nil {
		t.Fatalf("Rollback with full coverage: %v", err)
	}
	if e.activeID() != g1.ID {
		t.Fatalf("active after rollback = %d, want %d", e.activeID(), g1.ID)
	}
}
