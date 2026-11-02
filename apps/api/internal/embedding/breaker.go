package embedding

import (
	"errors"
	"math/rand/v2"
	"strings"
	"sync"
	"time"

	"github.com/zone17th/engram/apps/api/internal/obs"
)

// Circuit breaker constants (plan P05 mục 2.12, 2.17, 2.21; SPEC §6.6 l.~1155).
const (
	// BreakerOpenWindow is the 60-second duration the circuit breaker stays open
	// after reaching its failure threshold.
	BreakerOpenWindow = 60 * time.Second
	// BreakerAPIFailureThreshold is the consecutive failure threshold for API
	// (query) processes: 1 failure opens the breaker for 60 s.
	BreakerAPIFailureThreshold = 1
	// BreakerWorkerFailureThreshold is the consecutive failure threshold for
	// worker (document) processes: 3 consecutive failures open the breaker.
	BreakerWorkerFailureThreshold = 3
	// MaxRetryAfterSnooze is the 1-hour cap on snooze duration derived from a
	// 429 Retry-After header.
	MaxRetryAfterSnooze = time.Hour
	// MaxBreakerJitter is the maximum random jitter (10 seconds) added when a
	// worker job snoozes on an open breaker.
	MaxBreakerJitter = 10 * time.Second
)

// BreakerMode selects the process role and failure threshold of a Breaker
// ("api" or "worker", matching obs.BreakerProcesses).
type BreakerMode string

const (
	BreakerModeAPI    BreakerMode = "api"
	BreakerModeWorker BreakerMode = "worker"
)

// BreakerState represents the current state of a circuit breaker.
type BreakerState int

const (
	BreakerStateClosed BreakerState = iota
	BreakerStateOpen
	BreakerStateHalfOpen
)

func (s BreakerState) String() string {
	switch s {
	case BreakerStateClosed:
		return "closed"
	case BreakerStateOpen:
		return "open"
	case BreakerStateHalfOpen:
		return "half_open"
	default:
		return "unknown"
	}
}

// BreakerConfig configures a circuit breaker for a single provider in a single
// process (API or worker).
type BreakerConfig struct {
	Provider   string                // "openai_compat" | "tei"
	Mode       BreakerMode           // BreakerModeAPI ("api") | BreakerModeWorker ("worker")
	Threshold  int                   // Optional override; defaults to 1 (api) or 3 (worker)
	OpenWindow time.Duration         // Optional override; defaults to BreakerOpenWindow (60s)
	Clock      func() time.Time      // Optional injectable clock; defaults to time.Now
	Metrics    *obs.EmbeddingMetrics // Optional Prometheus collectors (nil-safe)
}

// Breaker implements a per-provider, per-process circuit breaker with an
// injectable clock and race-free single-trial half-open probing (plan P05 mục
// 2.12, SPEC §6.6):
//   - API mode (query): 1 failure (timeout, 5xx, 429, network/refused,
//     bad_response) opens the breaker for 60 s.
//   - Worker mode (document): 3 consecutive failures open the breaker for 60 s;
//     any success resets the consecutive failure counter to 0.
//   - After 60 s, the breaker enters half-open and admits exactly ONE trial
//     request while rejecting every other concurrent caller until the trial
//     completes. If the trial succeeds, the breaker closes; if it fails, the
//     breaker re-opens for another 60 s.
type Breaker struct {
	provider   string
	process    string
	threshold  int
	openWindow time.Duration
	now        func() time.Time
	metrics    *obs.EmbeddingMetrics

	mu            sync.Mutex
	state         BreakerState
	failures      int
	openedUntil   time.Time
	trialInFlight bool
	trialEpoch    uint64
}

// NewBreaker constructs a Breaker from cfg and initializes the
// embedding_breaker_open{provider,process} gauge to 0.
func NewBreaker(cfg BreakerConfig) *Breaker {
	prov := strings.TrimSpace(cfg.Provider)
	if prov == "" {
		prov = ProviderOpenAICompat
	}
	mode := cfg.Mode
	if mode != BreakerModeWorker {
		mode = BreakerModeAPI
	}
	threshold := cfg.Threshold
	if threshold <= 0 {
		if mode == BreakerModeWorker {
			threshold = BreakerWorkerFailureThreshold
		} else {
			threshold = BreakerAPIFailureThreshold
		}
	}
	openWin := cfg.OpenWindow
	if openWin <= 0 {
		openWin = BreakerOpenWindow
	}
	clock := cfg.Clock
	if clock == nil {
		clock = time.Now
	}

	b := &Breaker{
		provider:   prov,
		process:    string(mode),
		threshold:  threshold,
		openWindow: openWin,
		now:        clock,
		metrics:    cfg.Metrics,
		state:      BreakerStateClosed,
	}
	b.setGauge(0)
	return b
}

// NewAPIBreaker constructs an API-mode (query) Breaker where 1 failure opens
// the circuit for 60 s.
func NewAPIBreaker(provider string, clock func() time.Time, metrics *obs.EmbeddingMetrics) *Breaker {
	return NewBreaker(BreakerConfig{
		Provider: provider,
		Mode:     BreakerModeAPI,
		Clock:    clock,
		Metrics:  metrics,
	})
}

// NewWorkerBreaker constructs a worker-mode (document) Breaker where 3
// consecutive failures open the circuit for 60 s.
func NewWorkerBreaker(provider string, clock func() time.Time, metrics *obs.EmbeddingMetrics) *Breaker {
	return NewBreaker(BreakerConfig{
		Provider: provider,
		Mode:     BreakerModeWorker,
		Clock:    clock,
		Metrics:  metrics,
	})
}

// Allow checks whether a request is permitted to proceed.
//   - When the breaker is closed, Allow returns (true, 0).
//   - When the breaker is open and the 60 s window has not elapsed, Allow
//     returns (false, remainingWindow).
//   - When the 60 s window has elapsed, the first caller transitions the
//     breaker to half-open, acquires the single trial slot, and receives
//     (true, 0); every other concurrent caller while the trial is in flight
//     receives (false, OpenWindow).
//
// Callers that receive ok == true MUST call Done(err) when the request finishes.
func (b *Breaker) Allow() (ok bool, retryIn time.Duration) {
	ok, retryIn, _ = b.Acquire()
	return ok, retryIn
}

// Acquire is identical to Allow and additionally returns a one-shot completion
// callback finish(err). Calling finish(err) is equivalent to calling Done(err)
// and is idempotent if called more than once.
func (b *Breaker) Acquire() (ok bool, retryIn time.Duration, finish func(error)) {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := b.now()
	switch b.state {
	case BreakerStateClosed:
		epoch := b.trialEpoch
		var once sync.Once
		return true, 0, func(err error) {
			once.Do(func() { b.doneAtEpoch(err, false, epoch) })
		}

	case BreakerStateOpen:
		if now.Before(b.openedUntil) {
			rem := b.openedUntil.Sub(now)
			if rem < 0 {
				rem = 0
			}
			return false, rem, func(error) {}
		}
		// Open window has elapsed -> transition to half-open and admit this
		// caller as the single trial probe.
		b.state = BreakerStateHalfOpen
		b.trialInFlight = true
		b.trialEpoch++
		epoch := b.trialEpoch
		var once sync.Once
		return true, 0, func(err error) {
			once.Do(func() { b.doneAtEpoch(err, true, epoch) })
		}

	case BreakerStateHalfOpen:
		if !b.trialInFlight {
			b.trialInFlight = true
			b.trialEpoch++
			epoch := b.trialEpoch
			var once sync.Once
			return true, 0, func(err error) {
				once.Do(func() { b.doneAtEpoch(err, true, epoch) })
			}
		}
		// Another goroutine is currently executing the single half-open trial;
		// reject all other callers so they fall back to lexical / snooze.
		return false, b.openWindow, func(error) {}

	default:
		return false, b.openWindow, func(error) {}
	}
}

// Done records the outcome of a request that was permitted by Allow().
// Passing err == nil records a success; passing a non-nil error records a
// provider failure.
func (b *Breaker) Done(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.recordOutcomeLocked(err, b.state == BreakerStateHalfOpen && b.trialInFlight, b.trialEpoch)
}

func (b *Breaker) doneAtEpoch(err error, wasTrial bool, epoch uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.recordOutcomeLocked(err, wasTrial, epoch)
}

func (b *Breaker) recordOutcomeLocked(err error, wasTrial bool, epoch uint64) {
	now := b.now()

	if b.state == BreakerStateHalfOpen && b.trialInFlight && (wasTrial || epoch == b.trialEpoch) {
		b.trialInFlight = false
		if err == nil {
			b.state = BreakerStateClosed
			b.failures = 0
			b.openedUntil = time.Time{}
			b.setGauge(0)
			return
		}
		b.tripLocked(now)
		return
	}

	if err == nil {
		if b.state == BreakerStateClosed {
			b.failures = 0
		}
		return
	}

	// Ignore stale completions from before the breaker already tripped open.
	if b.state != BreakerStateClosed {
		return
	}

	b.failures++
	if b.failures >= b.threshold {
		b.tripLocked(now)
	}
}

func (b *Breaker) tripLocked(now time.Time) {
	b.state = BreakerStateOpen
	b.trialInFlight = false
	b.openedUntil = now.Add(b.openWindow)
	b.setGauge(1)
}

func (b *Breaker) setGauge(val float64) {
	if b.metrics == nil || b.metrics.BreakerOpen == nil {
		return
	}
	if (b.provider == ProviderOpenAICompat || b.provider == ProviderTEI) &&
		(b.process == string(BreakerModeAPI) || b.process == string(BreakerModeWorker)) {
		b.metrics.BreakerOpen.WithLabelValues(b.provider, b.process).Set(val)
	}
}

// IsOpen reports whether the breaker is currently blocking general traffic
// (either Open within its 60 s window, or HalfOpen with a trial already in
// flight) without consuming the half-open trial slot. Used by PATCH
// /me/settings (plan P05 mục 2.18, SPEC §6.10).
func (b *Breaker) IsOpen() bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	switch b.state {
	case BreakerStateOpen:
		return now.Before(b.openedUntil)
	case BreakerStateHalfOpen:
		return true
	default:
		return false
	}
}

// State returns the current BreakerState as of b's clock without mutating state
// or consuming the half-open trial slot.
func (b *Breaker) State() BreakerState {
	if b == nil {
		return BreakerStateClosed
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state == BreakerStateOpen && !b.now().Before(b.openedUntil) {
		return BreakerStateHalfOpen
	}
	return b.state
}

// ConsecutiveFailures returns the current consecutive failure count.
func (b *Breaker) ConsecutiveFailures() int {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.failures
}

// Int63nSource is the minimal random source interface accepted by SnoozeFor
// (satisfied by *math/rand/v2.Rand and custom deterministic test sources).
type Int63nSource interface {
	Int64N(n int64) int64
}

// SnoozeFor computes the River JobSnooze duration for a worker embedding job
// that encountered an open circuit breaker or a provider error (plan P05 mục
// 2.12, 2.17; SPEC §6.6):
//   - If err is a 429 (*ProviderError with Class429) and carries a positive
//     RetryAfter duration, SnoozeFor returns min(RetryAfter, 1h) (capped at
//     MaxRetryAfterSnooze = 1h).
//   - Otherwise, SnoozeFor returns retryIn (remaining breaker open window,
//     defaulting to BreakerOpenWindow = 60s when retryIn <= 0 and err != nil)
//     plus uniform random jitter in [0, 10s].
func SnoozeFor(err error, retryIn time.Duration, rnd Int63nSource) time.Duration {
	if err != nil {
		var pe *ProviderError
		if errors.As(err, &pe) && pe != nil && pe.Class == Class429 && pe.RetryAfter > 0 {
			if pe.RetryAfter > MaxRetryAfterSnooze {
				return MaxRetryAfterSnooze
			}
			return pe.RetryAfter
		}
	}

	base := retryIn
	if base < 0 {
		base = 0
	}
	if base == 0 && err != nil {
		base = BreakerOpenWindow
	}
	return base + drawJitter(rnd, MaxBreakerJitter)
}

func drawJitter(rnd Int63nSource, maxJitter time.Duration) time.Duration {
	if maxJitter <= 0 {
		return 0
	}
	limit := int64(maxJitter) + 1
	var n int64
	if rnd != nil {
		n = rnd.Int64N(limit)
	} else {
		n = rand.Int64N(limit)
	}
	if n < 0 {
		n = 0
	}
	if n > int64(maxJitter) {
		n = int64(maxJitter)
	}
	return time.Duration(n)
}
