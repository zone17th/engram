package lifecycle_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/embedding/lifecycle"
	"github.com/zone17th/engram/apps/api/internal/semantic"
)

// TestBootstrapAutoFlipAfterVerify: g1 bootstrap pending + data -> not flipped
// while embed jobs are unfinished -> backfill -> verify passes -> auto flip ->
// NOTIFY -> semantic availability turns true without advancing the clock.
func TestBootstrapAutoFlipAfterVerify(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(e.ctx, 60*time.Second)
	defer cancel()
	m := e.model(8, "rev-a")
	g1 := e.bootstrap(m)

	// Availability through the real Runtime, listening to the real NOTIFY. The
	// fixed clock never advances, so only NOTIFY can drop a cached "false".
	clk := clock.NewFixed(time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC))
	pinner := generation.NewPinner(e.pool, generation.WithPinNowFunc(clk.Now))
	defer pinner.Close()
	if err := pinner.StartListener(ctx); err != nil {
		t.Fatalf("StartListener: %v", err)
	}
	rt := semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:     true,
		Provider:    embedding.ProviderTEI,
		ClientSet:   e.clientSet(m, nil),
		Pinner:      pinner,
		Calibration: calib,
		Clock:       clk,
	})
	notified := make(chan struct{}, 1)
	pinner.Subscribe(func() {
		select {
		case notified <- struct{}{}:
		default:
		}
	})

	// Data written while g1 is pending fans out to it (BE-4).
	alice := e.user("flip-alice@example.com")
	bob := e.user("flip-bob@example.com")
	names := []string{"Alpha ledger", "Bravo ledger", "Charlie ledger"}
	for _, n := range names {
		e.newItem(alice, n, "hint "+n)
		e.newItem(bob, n+" b", "")
	}
	e.newTag(alice, "tag-one")
	e.newTag(bob, "tag-two")

	if rt.Availability(ctx) {
		t.Fatal("semantic available while g1 is pending")
	}

	// Embed jobs are unfinished: verify fails on them and nothing flips.
	out, err := lifecycle.AutoFlipBootstrap(ctx, e.pool, lifecycle.AutoFlipOpts{})
	if err != nil {
		t.Fatalf("AutoFlipBootstrap (jobs pending): %v", err)
	}
	if out.Action != lifecycle.ActionNotReady || out.Reason != lifecycle.ReasonJobsPending || out.GenerationID != g1.ID {
		t.Fatalf("AutoFlipBootstrap with unfinished jobs = %+v, want not_ready/%s", out, lifecycle.ReasonJobsPending)
	}
	if e.gen(g1.ID).State != generation.StatePending || e.hasActive() {
		t.Fatal("generation flipped although embed jobs are unfinished")
	}
	if rt.Availability(ctx) {
		t.Fatal("semantic available before the flip")
	}

	// Backfill (idempotent against the jobs already queued), run every job.
	e.backfill(g1)
	if n := e.drain(e.deps(e.clientSet(m, nil)), 0); n == 0 {
		t.Fatal("no embed job ran")
	}

	out, err = lifecycle.AutoFlipBootstrap(ctx, e.pool, lifecycle.AutoFlipOpts{})
	if err != nil {
		t.Fatalf("AutoFlipBootstrap (covered): %v", err)
	}
	if out.Action != lifecycle.ActionFlipped || out.Reason != lifecycle.ReasonBootstrapAuto {
		t.Fatalf("AutoFlipBootstrap after backfill = %+v, want flipped", out)
	}

	got := e.gen(g1.ID)
	if got.State != generation.StateActive || !got.IndexReady || got.ActivatedAt == nil || got.VerifiedAt == nil {
		t.Fatalf("g1 after flip = %+v, want active + index_ready + activated + verified", got)
	}
	if e.activeID() != g1.ID {
		t.Fatalf("embedding_active = %d, want %d", e.activeID(), g1.ID)
	}
	var reason string
	if err := e.pool.QueryRow(ctx, `SELECT flipped_reason FROM embedding_active`).Scan(&reason); err != nil || reason != lifecycle.ReasonBootstrapAuto {
		t.Fatalf("flipped_reason = %q (err %v), want %q", reason, err, lifecycle.ReasonBootstrapAuto)
	}

	// The persisted report is counts only and records the pass.
	var rep lifecycle.VerifyReport
	if err := json.Unmarshal(got.VerifyReport, &rep); err != nil {
		t.Fatalf("decode verify_report: %v", err)
	}
	if !rep.Passed || rep.Reason != lifecycle.ReasonOK || !rep.RecallSkippedBelow200 || rep.Recall != nil {
		t.Fatalf("verify_report = %+v, want passed with recall skipped below 200 vectors", rep)
	}
	if rep.ItemRows != 6 || rep.TagRows != 2 || rep.Coverage.Scanned != 8 || rep.JobsPendingBeforeWatermark != 0 {
		t.Fatalf("verify_report counts = %+v, want 6 item rows, 2 tag rows, 8 scanned, 0 jobs", rep)
	}
	raw := strings.ToLower(string(got.VerifyReport))
	for _, forbidden := range []string{"alpha", "ledger", "tag-one", "flip-alice", "hint"} {
		if strings.Contains(raw, forbidden) {
			t.Fatalf("verify_report leaks %q: %s", forbidden, got.VerifyReport)
		}
	}

	// NOTIFY dropped the cached "false"; the clock never moved.
	select {
	case <-notified:
	case <-ctx.Done():
		t.Fatal("timed out waiting for NOTIFY embedding_generation_changed")
	}
	if !rt.Availability(ctx) {
		t.Fatal("semantic not available right after the flip NOTIFY (cache not dropped)")
	}
}

// TestNonBootstrapGenerationNeverAutoFlips: a fully backfilled, indexed and
// verified non-bootstrap pending generation stays pending under the periodic
// job; only the manual Flip moves it.
func TestNonBootstrapGenerationNeverAutoFlips(t *testing.T) {
	e := newEnv(t)
	mA := e.model(8, "rev-a")
	mB := e.model(8, "rev-b")
	g1 := e.bootstrapActive(mA)
	u := e.user("never-auto@example.com")
	e.newItem(u, "Delta archive", "")
	e.newTag(u, "tag-delta")
	cs := e.clientSet(mA, &mB)
	e.drain(e.deps(cs), 0)

	g2 := e.create(mB)
	e.ready(g2, cs) // backfilled, indexed, verified: only the bootstrap flag can stop it

	out, err := lifecycle.AutoFlipBootstrap(e.ctx, e.pool, lifecycle.AutoFlipOpts{})
	if err != nil {
		t.Fatalf("AutoFlipBootstrap: %v", err)
	}
	if out.Action != lifecycle.ActionNoop || out.Reason != lifecycle.ReasonNotBootstrap || out.GenerationID != g2.ID {
		t.Fatalf("AutoFlipBootstrap with a ready non-bootstrap generation = %+v, want noop/%s", out, lifecycle.ReasonNotBootstrap)
	}
	if e.gen(g2.ID).State != generation.StatePending || e.activeID() != g1.ID {
		t.Fatal("non-bootstrap generation was flipped by the periodic job")
	}

	// Control: the same generation does flip when an operator asks.
	if err := lifecycle.Flip(e.ctx, e.pool, g2.ID, lifecycle.FlipOpts{Reason: "test"}); err != nil {
		t.Fatalf("manual Flip: %v", err)
	}
	if e.activeID() != g2.ID {
		t.Fatalf("active after manual Flip = %d, want %d", e.activeID(), g2.ID)
	}
}

// TestAutoFlipNoopWithoutPending: nothing pending is a quiet no-op, and an
// existing active generation blocks a bootstrap auto-flip.
func TestAutoFlipNoopWithoutPending(t *testing.T) {
	e := newEnv(t)
	out, err := lifecycle.AutoFlipBootstrap(e.ctx, e.pool, lifecycle.AutoFlipOpts{})
	if err != nil {
		t.Fatalf("AutoFlipBootstrap on an empty database: %v", err)
	}
	if out.Action != lifecycle.ActionNoop || out.Reason != lifecycle.ReasonNoPending {
		t.Fatalf("outcome = %+v, want noop/%s", out, lifecycle.ReasonNoPending)
	}

	m := e.model(8, "rev-a")
	e.bootstrapActive(m)
	out, err = lifecycle.AutoFlipBootstrap(e.ctx, e.pool, lifecycle.AutoFlipOpts{})
	if err != nil {
		t.Fatalf("AutoFlipBootstrap with active generation: %v", err)
	}
	if out.Action != lifecycle.ActionNoop || out.Reason != lifecycle.ReasonNoPending {
		t.Fatalf("outcome = %+v, want noop/%s", out, lifecycle.ReasonNoPending)
	}
}

// TestBootstrapFlipInsertOpts pins the job options of the periodic job.
func TestBootstrapFlipInsertOpts(t *testing.T) {
	opts := lifecycle.BootstrapFlipInsertOpts()
	if opts.Queue != jobs.QueueEmbedding || opts.Priority != 2 {
		t.Fatalf("insert opts = queue %q priority %d, want %q priority 2", opts.Queue, opts.Priority, jobs.QueueEmbedding)
	}
	if lifecycle.QueueEmbedding != jobs.QueueEmbedding {
		t.Fatalf("lifecycle.QueueEmbedding = %q, jobs.QueueEmbedding = %q", lifecycle.QueueEmbedding, jobs.QueueEmbedding)
	}
	if !opts.UniqueOpts.ByArgs {
		t.Fatal("bootstrap flip job is not unique by args; slow verifications could stack")
	}
}
