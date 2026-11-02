package embedding_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{
		now: time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC),
	}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type fixedRand struct {
	val int64
}

func (r fixedRand) Int64N(n int64) int64 {
	if n <= 0 {
		return 0
	}
	if r.val < 0 {
		return 0
	}
	if r.val >= n {
		return n - 1
	}
	return r.val
}

func gaugeValue(t *testing.T, reg *prometheus.Registry, name string, wantLabels map[string]string) float64 {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("reg.Gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() != name {
			continue
		}
		for _, m := range f.GetMetric() {
			matched := 0
			for _, lp := range m.GetLabel() {
				if v, ok := wantLabels[lp.GetName()]; ok && v == lp.GetValue() {
					matched++
				}
			}
			if matched == len(wantLabels) && m.GetGauge() != nil {
				return m.GetGauge().GetValue()
			}
		}
	}
	t.Fatalf("gauge %s with labels %v not found", name, wantLabels)
	return 0
}

func TestBreakerAPIOneFailureOpensAndHalfOpenLifecycle(t *testing.T) {
	clk := newFakeClock()
	reg, m := obs.NewRegistry()

	b := embedding.NewAPIBreaker(embedding.ProviderOpenAICompat, clk.Now, m.Embedding)
	labels := map[string]string{"provider": "openai_compat", "process": "api"}

	if b.IsOpen() {
		t.Fatal("breaker should start closed")
	}
	if got := gaugeValue(t, reg, "embedding_breaker_open", labels); got != 0 {
		t.Fatalf("initial BreakerOpen gauge = %v, want 0", got)
	}

	// Failure classes that must open the API breaker on a single error.
	failureErrors := []error{
		&embedding.ProviderError{Class: embedding.ClassTimeout},
		&embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 503},
		&embedding.ProviderError{Class: embedding.Class429, HTTPStatus: 429},
		&embedding.ProviderError{Class: embedding.ClassRefused},
		&embedding.ProviderError{Class: embedding.ClassBadResponse, Err: embedding.ErrBadResponse},
	}

	for _, failErr := range failureErrors {
		ok, retryIn, finish := b.Acquire()
		if !ok || retryIn != 0 {
			t.Fatalf("Acquire() when closed = (%v, %v), want (true, 0)", ok, retryIn)
		}
		finish(failErr)

		if !b.IsOpen() {
			t.Fatalf("breaker should be open after 1 failure (%v)", failErr)
		}
		if got := gaugeValue(t, reg, "embedding_breaker_open", labels); got != 1 {
			t.Fatalf("BreakerOpen gauge after failure = %v, want 1", got)
		}

		// At t + 25s, still open with 35s remaining.
		clk.Advance(25 * time.Second)
		ok, retryIn, _ = b.Acquire()
		if ok || retryIn != 35*time.Second {
			t.Fatalf("Acquire() at +25s = (%v, %v), want (false, 35s)", ok, retryIn)
		}

		// Advance to +60s -> half-open admits one trial.
		clk.Advance(35 * time.Second)
		ok, retryIn, finishTrial1 := b.Acquire()
		if !ok || retryIn != 0 {
			t.Fatalf("Acquire() at +60s (half-open trial) = (%v, %v), want (true, 0)", ok, retryIn)
		}

		// Trial fails -> re-opens for another 60s.
		finishTrial1(failErr)
		ok, retryIn, _ = b.Acquire()
		if ok || retryIn != 60*time.Second {
			t.Fatalf("Acquire() right after failed trial = (%v, %v), want (false, 60s)", ok, retryIn)
		}

		// Advance another 60s -> trial succeeds -> closes breaker and sets gauge to 0.
		clk.Advance(60 * time.Second)
		ok, retryIn, finishTrial2 := b.Acquire()
		if !ok || retryIn != 0 {
			t.Fatalf("Acquire() at second half-open = (%v, %v), want (true, 0)", ok, retryIn)
		}
		finishTrial2(nil)

		if b.IsOpen() {
			t.Fatal("breaker should be closed after successful trial")
		}
		if got := gaugeValue(t, reg, "embedding_breaker_open", labels); got != 0 {
			t.Fatalf("BreakerOpen gauge after recovery = %v, want 0", got)
		}
	}
}

func TestBreakerHalfOpenAdmitsExactlyOneTrialUnderConcurrency(t *testing.T) {
	clk := newFakeClock()
	b := embedding.NewAPIBreaker(embedding.ProviderOpenAICompat, clk.Now, nil)

	// Open the breaker.
	ok, _, finishInit := b.Acquire()
	if !ok {
		t.Fatal("initial Acquire() failed")
	}
	finishInit(&embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 500})

	// Advance clock by 60s so the breaker is ready to transition to half-open.
	clk.Advance(embedding.BreakerOpenWindow)

	const goroutines = 64
	startGate := make(chan struct{})
	var admitted atomic.Int32
	var rejected atomic.Int32
	var trialFinishMu sync.Mutex
	var trialFinish func(error)
	var wg sync.WaitGroup
	wg.Add(goroutines)

	for range goroutines {
		go func() {
			defer wg.Done()
			<-startGate
			allowed, retryIn, finish := b.Acquire()
			if allowed {
				admitted.Add(1)
				trialFinishMu.Lock()
				trialFinish = finish
				trialFinishMu.Unlock()
			} else {
				if retryIn <= 0 {
					t.Errorf("rejected caller received non-positive retryIn: %v", retryIn)
				}
				rejected.Add(1)
			}
		}()
	}

	close(startGate)
	wg.Wait()

	if got := admitted.Load(); got != 1 {
		t.Fatalf("half-open admitted %d callers concurrently, want exactly 1", got)
	}
	if got := rejected.Load(); got != goroutines-1 {
		t.Fatalf("half-open rejected %d callers, want %d", got, goroutines-1)
	}

	// Complete the single trial with success; subsequent callers must all be allowed.
	trialFinish(nil)
	for i := range 10 {
		allowed, retryIn, finish := b.Acquire()
		if !allowed || retryIn != 0 {
			t.Fatalf("post-recovery Acquire() #%d = (%v, %v), want (true, 0)", i, allowed, retryIn)
		}
		finish(nil)
	}
}

func TestBreakerWorkerThreeConsecutiveFailuresAndSuccessReset(t *testing.T) {
	clk := newFakeClock()
	reg, m := obs.NewRegistry()

	b := embedding.NewWorkerBreaker(embedding.ProviderTEI, clk.Now, m.Embedding)
	labels := map[string]string{"provider": "tei", "process": "worker"}
	failErr := &embedding.ProviderError{Class: embedding.ClassTimeout}

	// 2 consecutive failures followed by 1 success must reset failure count to 0.
	for i := 1; i <= 2; i++ {
		ok, _, finish := b.Acquire()
		if !ok {
			t.Fatalf("failure #%d: expected Acquire()=true", i)
		}
		finish(failErr)
		if b.IsOpen() {
			t.Fatalf("worker breaker opened prematurely after %d failures (want 3)", i)
		}
	}
	if b.ConsecutiveFailures() != 2 {
		t.Fatalf("ConsecutiveFailures = %d, want 2", b.ConsecutiveFailures())
	}

	// Success resets count.
	ok, _, finishReset := b.Acquire()
	if !ok {
		t.Fatal("Acquire() before reset success failed")
	}
	finishReset(nil)
	if b.ConsecutiveFailures() != 0 {
		t.Fatalf("ConsecutiveFailures after success = %d, want 0", b.ConsecutiveFailures())
	}

	// Now 3 consecutive failures must open the worker breaker for 60s.
	for i := 1; i <= 3; i++ {
		ok, _, finish := b.Acquire()
		if !ok {
			t.Fatalf("run2 failure #%d: expected Acquire()=true", i)
		}
		finish(failErr)
	}
	if !b.IsOpen() {
		t.Fatal("worker breaker should be open after 3 consecutive failures")
	}
	if got := gaugeValue(t, reg, "embedding_breaker_open", labels); got != 1 {
		t.Fatalf("worker BreakerOpen gauge = %v, want 1", got)
	}

	ok, retryIn, _ := b.Acquire()
	if ok || retryIn != 60*time.Second {
		t.Fatalf("Acquire() when worker breaker open = (%v, %v), want (false, 60s)", ok, retryIn)
	}

	// Advance 60s, half-open trial succeeds -> closes breaker.
	clk.Advance(60 * time.Second)
	ok, _, finishTrial := b.Acquire()
	if !ok {
		t.Fatal("worker half-open trial should be allowed at +60s")
	}
	finishTrial(nil)
	if b.IsOpen() || b.ConsecutiveFailures() != 0 {
		t.Fatalf("worker breaker after trial ok: IsOpen=%v failures=%d", b.IsOpen(), b.ConsecutiveFailures())
	}
	if got := gaugeValue(t, reg, "embedding_breaker_open", labels); got != 0 {
		t.Fatalf("worker BreakerOpen gauge after close = %v, want 0", got)
	}
}

func TestSnoozeForRetryAfterCapAndJitterBounds(t *testing.T) {
	// 1. 429 with Retry-After < 1h uses exact Retry-After.
	err429Short := &embedding.ProviderError{
		Class:      embedding.Class429,
		HTTPStatus: 429,
		RetryAfter: 90 * time.Second,
	}
	if got := embedding.SnoozeFor(err429Short, 60*time.Second, fixedRand{val: int64(5 * time.Second)}); got != 90*time.Second {
		t.Fatalf("SnoozeFor(429 90s) = %v, want 90s", got)
	}

	// 2. 429 with Retry-After > 1h is capped at 1h (MaxRetryAfterSnooze).
	err429Long := &embedding.ProviderError{
		Class:      embedding.Class429,
		HTTPStatus: 429,
		RetryAfter: 3 * time.Hour,
	}
	if got := embedding.SnoozeFor(err429Long, 60*time.Second, fixedRand{val: int64(5 * time.Second)}); got != time.Hour {
		t.Fatalf("SnoozeFor(429 3h) = %v, want 1h cap", got)
	}

	// 3. Breaker remaining + jitter bounds [0, 10s].
	rem := 42 * time.Second
	minSnooze := embedding.SnoozeFor(nil, rem, fixedRand{val: 0})
	if minSnooze != rem {
		t.Fatalf("minSnooze = %v, want %v", minSnooze, rem)
	}

	maxSnooze := embedding.SnoozeFor(nil, rem, fixedRand{val: int64(100 * time.Second)})
	if maxSnooze != rem+10*time.Second {
		t.Fatalf("maxSnooze = %v, want %v", maxSnooze, rem+10*time.Second)
	}

	// Sample default RNG to verify bounds [rem, rem+10s].
	otherErr := errors.New("breaker open")
	for range 100 {
		d := embedding.SnoozeFor(otherErr, rem, nil)
		if d < rem || d > rem+embedding.MaxBreakerJitter {
			t.Fatalf("SnoozeFor jitter out of bounds [%v, %v]: got %v", rem, rem+embedding.MaxBreakerJitter, d)
		}
	}
}

func TestBreakerStaleAdmissionsCannotFinishLiveProbeOrReopenRecoveredCircuit(t *testing.T) {
	clk := newFakeClock()
	b := embedding.NewAPIBreaker(embedding.ProviderOpenAICompat, clk.Now, nil)
	failErr := &embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 502}

	// 1. Admit A, B, and D while closed.
	okA, _, finishA := b.Acquire()
	okB, _, finishB := b.Acquire()
	okD, _, finishD := b.Acquire()
	if !okA || !okB || !okD {
		t.Fatalf("closed Acquire = (%v, %v, %v), want all true", okA, okB, okD)
	}

	// A fails and opens the breaker while B and D are still in flight.
	finishA(failErr)
	if !b.IsOpen() {
		t.Fatal("breaker should be open after A fails")
	}

	// Advance 60s and admit half-open trial C while B is still in flight.
	clk.Advance(embedding.BreakerOpenWindow)
	okC, _, finishC := b.Acquire()
	if !okC {
		t.Fatal("expected trial C to be admitted after 60s")
	}

	// Pre-trip request B finishes with success while trial C is in flight:
	// B MUST NOT close the breaker or finish C's trial.
	finishB(nil)
	if !b.IsOpen() {
		t.Fatal("stale pre-trip success B closed breaker while probe C was still in flight")
	}
	if allowed, _, _ := b.Acquire(); allowed {
		t.Fatal("general traffic was admitted before probe C completed")
	}

	// Now trial C succeeds and legitimately closes the breaker.
	finishC(nil)
	if b.IsOpen() {
		t.Fatal("breaker should close when probe C succeeds")
	}

	// 2. Stale pre-trip request D finishes with failure AFTER recovery:
	// D MUST NOT increment failures or reopen the recovered circuit.
	finishD(failErr)
	if b.IsOpen() || b.ConsecutiveFailures() != 0 {
		t.Fatalf("stale pre-trip failure D reopened or incremented recovered breaker: IsOpen=%v failures=%d",
			b.IsOpen(), b.ConsecutiveFailures())
	}
}

func TestBreakerIgnoresCallerCancellationAndLocalBatchErrors(t *testing.T) {
	clk := newFakeClock()
	apiBreaker := embedding.NewAPIBreaker(embedding.ProviderOpenAICompat, clk.Now, nil)

	ignoredErrs := []error{
		context.Canceled,
		fmt.Errorf("caller aborted: %w", context.Canceled),
		embedding.ErrEmptyBatch,
		fmt.Errorf("%w: got 65, max 64", embedding.ErrBatchTooLarge),
	}

	// 1. API breaker: caller cancellation and local batch errors never open the breaker.
	for _, ignErr := range ignoredErrs {
		ok, _, finish := apiBreaker.Acquire()
		if !ok {
			t.Fatalf("Acquire() before %v failed", ignErr)
		}
		finish(ignErr)
		if apiBreaker.IsOpen() || apiBreaker.ConsecutiveFailures() != 0 {
			t.Fatalf("ignored error %v affected API breaker: IsOpen=%v failures=%d",
				ignErr, apiBreaker.IsOpen(), apiBreaker.ConsecutiveFailures())
		}
	}

	// 2. Worker breaker: ignored errors neither increment the failure streak nor reset an existing streak.
	workerBreaker := embedding.NewWorkerBreaker(embedding.ProviderTEI, clk.Now, nil)
	failErr := &embedding.ProviderError{Class: embedding.ClassTimeout, Err: context.DeadlineExceeded}

	for range 2 {
		ok, _, finish := workerBreaker.Acquire()
		if !ok {
			t.Fatal("worker Acquire() failed")
		}
		finish(failErr)
	}
	if workerBreaker.ConsecutiveFailures() != 2 {
		t.Fatalf("worker ConsecutiveFailures = %d, want 2", workerBreaker.ConsecutiveFailures())
	}

	for _, ignErr := range ignoredErrs {
		ok, _, finish := workerBreaker.Acquire()
		if !ok {
			t.Fatal("worker Acquire() failed")
		}
		finish(ignErr)
		if workerBreaker.IsOpen() {
			t.Fatalf("ignored error %v opened worker breaker at streak 2", ignErr)
		}
		if workerBreaker.ConsecutiveFailures() != 2 {
			t.Fatalf("ignored error %v changed worker streak to %d, want 2", ignErr, workerBreaker.ConsecutiveFailures())
		}
	}

	// A 3rd real provider failure after ignored errors must still trip the worker breaker.
	ok, _, finishThird := workerBreaker.Acquire()
	if !ok {
		t.Fatal("worker Acquire() for 3rd real failure failed")
	}
	finishThird(failErr)
	if !workerBreaker.IsOpen() {
		t.Fatal("expected 3rd real provider failure to open worker breaker")
	}

	// 3. Half-open probe canceled by caller releases the probe slot without closing
	// the circuit or starting a new 60s open window.
	clk.Advance(embedding.BreakerOpenWindow)
	okProbe1, _, finishProbe1 := workerBreaker.Acquire()
	if !okProbe1 {
		t.Fatal("expected first half-open probe to be admitted")
	}
	finishProbe1(context.Canceled)
	if !workerBreaker.IsOpen() {
		t.Fatal("canceled half-open probe must not mark circuit healthy/closed")
	}

	// Next caller can immediately acquire the released half-open probe slot without waiting another 60s.
	okProbe2, retryIn2, finishProbe2 := workerBreaker.Acquire()
	if !okProbe2 || retryIn2 != 0 {
		t.Fatalf("Acquire() after canceled probe = (%v, %v), want (true, 0)", okProbe2, retryIn2)
	}
	finishProbe2(nil)
	if workerBreaker.IsOpen() {
		t.Fatal("breaker should close after replacement probe succeeds")
	}
}
