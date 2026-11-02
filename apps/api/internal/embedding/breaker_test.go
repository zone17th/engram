package embedding_test

import (
	"errors"
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
		ok, retryIn := b.Allow()
		if !ok || retryIn != 0 {
			t.Fatalf("Allow() when closed = (%v, %v), want (true, 0)", ok, retryIn)
		}
		b.Done(failErr)

		if !b.IsOpen() {
			t.Fatalf("breaker should be open after 1 failure (%v)", failErr)
		}
		if got := gaugeValue(t, reg, "embedding_breaker_open", labels); got != 1 {
			t.Fatalf("BreakerOpen gauge after failure = %v, want 1", got)
		}

		// At t + 25s, still open with 35s remaining.
		clk.Advance(25 * time.Second)
		ok, retryIn = b.Allow()
		if ok || retryIn != 35*time.Second {
			t.Fatalf("Allow() at +25s = (%v, %v), want (false, 35s)", ok, retryIn)
		}

		// Advance to +60s -> half-open admits one trial.
		clk.Advance(35 * time.Second)
		ok, retryIn = b.Allow()
		if !ok || retryIn != 0 {
			t.Fatalf("Allow() at +60s (half-open trial) = (%v, %v), want (true, 0)", ok, retryIn)
		}

		// Trial fails -> re-opens for another 60s.
		b.Done(failErr)
		ok, retryIn = b.Allow()
		if ok || retryIn != 60*time.Second {
			t.Fatalf("Allow() right after failed trial = (%v, %v), want (false, 60s)", ok, retryIn)
		}

		// Advance another 60s -> trial succeeds -> closes breaker and sets gauge to 0.
		clk.Advance(60 * time.Second)
		ok, retryIn = b.Allow()
		if !ok || retryIn != 0 {
			t.Fatalf("Allow() at second half-open = (%v, %v), want (true, 0)", ok, retryIn)
		}
		b.Done(nil)

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
	ok, _ := b.Allow()
	if !ok {
		t.Fatal("initial Allow() failed")
	}
	b.Done(&embedding.ProviderError{Class: embedding.Class5xx, HTTPStatus: 500})

	// Advance clock by 60s so the breaker is ready to transition to half-open.
	clk.Advance(embedding.BreakerOpenWindow)

	const goroutines = 64
	startGate := make(chan struct{})
	var admitted atomic.Int32
	var rejected atomic.Int32
	var wg sync.WaitGroup
	wg.Add(goroutines)

	for range goroutines {
		go func() {
			defer wg.Done()
			<-startGate
			allowed, retryIn := b.Allow()
			if allowed {
				admitted.Add(1)
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
	b.Done(nil)
	for i := range 10 {
		allowed, retryIn := b.Allow()
		if !allowed || retryIn != 0 {
			t.Fatalf("post-recovery Allow() #%d = (%v, %v), want (true, 0)", i, allowed, retryIn)
		}
		b.Done(nil)
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
		ok, _ := b.Allow()
		if !ok {
			t.Fatalf("failure #%d: expected Allow()=true", i)
		}
		b.Done(failErr)
		if b.IsOpen() {
			t.Fatalf("worker breaker opened prematurely after %d failures (want 3)", i)
		}
	}
	if b.ConsecutiveFailures() != 2 {
		t.Fatalf("ConsecutiveFailures = %d, want 2", b.ConsecutiveFailures())
	}

	// Success resets count.
	ok, _ := b.Allow()
	if !ok {
		t.Fatal("Allow() before reset success failed")
	}
	b.Done(nil)
	if b.ConsecutiveFailures() != 0 {
		t.Fatalf("ConsecutiveFailures after success = %d, want 0", b.ConsecutiveFailures())
	}

	// Now 3 consecutive failures must open the worker breaker for 60s.
	for i := 1; i <= 3; i++ {
		ok, _ := b.Allow()
		if !ok {
			t.Fatalf("run2 failure #%d: expected Allow()=true", i)
		}
		b.Done(failErr)
	}
	if !b.IsOpen() {
		t.Fatal("worker breaker should be open after 3 consecutive failures")
	}
	if got := gaugeValue(t, reg, "embedding_breaker_open", labels); got != 1 {
		t.Fatalf("worker BreakerOpen gauge = %v, want 1", got)
	}

	ok, retryIn := b.Allow()
	if ok || retryIn != 60*time.Second {
		t.Fatalf("Allow() when worker breaker open = (%v, %v), want (false, 60s)", ok, retryIn)
	}

	// Advance 60s, half-open trial succeeds -> closes breaker.
	clk.Advance(60 * time.Second)
	ok, _ = b.Allow()
	if !ok {
		t.Fatal("worker half-open trial should be allowed at +60s")
	}
	b.Done(nil)
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
