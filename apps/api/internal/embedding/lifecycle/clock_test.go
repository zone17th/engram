package lifecycle_test

import (
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/lifecycle"
)

// TestRollbackRefusedWhenVerificationCrossesDeadline (GL-3): a rollback that
// starts inside the window but whose verification ends after rollback_until is
// refused - the deadline is enforced with a clock re-read at the exclusive
// decision, not the one captured at the start of the operation.
func TestRollbackRefusedWhenVerificationCrossesDeadline(t *testing.T) {
	e := newEnv(t)
	mA := e.model(8, "rev-a")
	mB := e.model(8, "rev-b")
	g1 := e.bootstrapActive(mA)
	cs := e.clientSet(mA, &mB)
	u := e.user("deadline@example.com")
	e.newItem(u, "Charlie deadline", "")
	e.drain(e.deps(cs), 0)

	g2 := e.create(mB)
	e.ready(g2, cs)
	if err := lifecycle.Flip(e.ctx, e.pool, g2.ID, lifecycle.FlipOpts{Reason: "test", RollbackWindow: time.Hour}); err != nil {
		t.Fatalf("Flip: %v", err)
	}
	before := e.gen(g1.ID)
	if before.State != generation.StateRetired || before.RollbackUntil == nil {
		t.Fatalf("old generation = %+v, want retired with a window", before)
	}

	// The injected clock reads "inside the window" at the start and "two hours
	// later" once the verification has passed its watermark.
	base := time.Now()
	clock := base
	hookRuns := 0
	err := lifecycle.Rollback(e.ctx, e.pool, g1.ID, lifecycle.RollbackOpts{
		Reason: "test",
		Now:    func() time.Time { return clock },
		Verify: lifecycle.VerifyOpts{AfterWatermark: func() {
			hookRuns++
			clock = base.Add(2 * time.Hour)
		}},
	})
	mustErrorIs(t, "Rollback whose verification crosses the deadline", err, lifecycle.ErrRollbackWindowClosed)
	if hookRuns != 1 {
		t.Fatalf("AfterWatermark ran %d times, want 1", hookRuns)
	}
	after := e.gen(g1.ID)
	if e.activeID() != g2.ID || after.State != generation.StateRetired || after.RollbackUntil == nil ||
		!after.RollbackUntil.Equal(*before.RollbackUntil) {
		t.Fatalf("a refused Rollback changed state: active %d, target %+v", e.activeID(), after)
	}

	// Control: with the clock still inside the window the same rollback succeeds.
	clock = base
	if err := lifecycle.Rollback(e.ctx, e.pool, g1.ID, lifecycle.RollbackOpts{
		Reason: "test",
		Now:    func() time.Time { return clock },
	}); err != nil {
		t.Fatalf("Rollback inside the window: %v", err)
	}
	if e.activeID() != g1.ID {
		t.Fatalf("active after rollback = %d, want %d", e.activeID(), g1.ID)
	}
}

// TestFlipChecksVerifyAgeAtDecision (GL-3): a flip whose verification ages past
// MaxVerifyAge between the entry check and the exclusive decision is refused;
// a flip that is still fresh at the decision derives the replaced generation's
// rollback window from the decision time, not the operation start.
func TestFlipChecksVerifyAgeAtDecision(t *testing.T) {
	e := newEnv(t)
	mA := e.model(8, "rev-a")
	mB := e.model(8, "rev-b")
	g1 := e.bootstrapActive(mA)
	cs := e.clientSet(mA, &mB)
	u := e.user("verify-age@example.com")
	e.newItem(u, "Delta verify age", "")
	e.drain(e.deps(cs), 0)

	g2 := e.create(mB)
	e.ready(g2, cs)

	base := time.Now()
	clock := base
	opts := lifecycle.FlipOpts{
		Reason:         "test",
		RollbackWindow: time.Hour,
		Now:            func() time.Time { return clock },
		BeforeExclusive: func() {
			clock = base.Add(lifecycle.MaxVerifyAge + time.Minute)
		},
	}
	err := lifecycle.Flip(e.ctx, e.pool, g2.ID, opts)
	mustErrorIs(t, "Flip whose verification ages out before the decision", err, lifecycle.ErrVerifyStale)
	if e.activeID() != g1.ID || e.gen(g2.ID).State != generation.StatePending {
		t.Fatal("a refused Flip changed the active pointer or generation states")
	}

	// Still fresh at the decision (30 min after the start): flips, and the old
	// generation's window is measured from the decision time.
	clock = base
	decision := base.Add(30 * time.Minute)
	opts.BeforeExclusive = func() { clock = decision }
	if err := lifecycle.Flip(e.ctx, e.pool, g2.ID, opts); err != nil {
		t.Fatalf("Flip fresh at the decision: %v", err)
	}
	old := e.gen(g1.ID)
	if old.State != generation.StateRetired || old.RollbackUntil == nil {
		t.Fatalf("old generation = %+v, want retired with a window", old)
	}
	want := decision.Add(time.Hour)
	if d := old.RollbackUntil.Sub(want); d < -time.Millisecond || d > time.Millisecond {
		t.Fatalf("rollback_until = %v, want the decision time + 1h = %v", old.RollbackUntil, want)
	}
}
