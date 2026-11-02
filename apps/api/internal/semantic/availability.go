package semantic

import (
	"context"
	"errors"
	"time"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

// AvailabilityCacheTTL is the 30-second RAM cache TTL for static semantic
// availability (plan P05 mục 2.18, SPEC §6.10). It is invalidated immediately
// whenever NOTIFY embedding_generation_changed arrives via Pinner.Subscribe
// (M3, FS-25).
const AvailabilityCacheTTL = 30 * time.Second

// InvalidateAvailability immediately clears the cached Availability() and
// External() snapshot. Registered automatically with Pinner.Subscribe in
// NewRuntime.
func (r *Runtime) InvalidateAvailability() {
	if r == nil {
		return
	}
	r.availMu.Lock()
	r.availHasCache = false
	r.availProvider = ""
	r.availExpires = time.Time{}
	r.availEpoch++
	r.availMu.Unlock()
}

// Availability reports static semantic search availability (`features.semantic_available`
// on `/auth/me`, `PATCH /me/settings`, and `/readyz`, plan P05 mục 2.18, SPEC §6.10):
//
//	SEARCH_SEMANTIC_ENABLED
//	  && provider != "noop"
//	  && active generation exists
//	  && ClientSet.Match(pin.Identity) (full 7-field identity)
//	  && calibration exists for pin.Identity
//
// Invariants:
//   - Cached in RAM for 30 s and invalidated immediately on NOTIFY
//     embedding_generation_changed (M3, FS-25).
//   - Never performs a network call to the embedding provider.
//   - Never flips to false when the API circuit breaker opens (avoiding UI toggle
//     flicker; breaker state is checked separately via IsBreakerOpen()).
func (r *Runtime) Availability(ctx context.Context) bool {
	avail, _ := r.resolveStaticAvailability(ctx)
	return avail
}

// Available implements the auth.SemanticProbe-compatible method signature
// `Available(ctx context.Context) bool` by delegating to Availability(ctx).
func (r *Runtime) Available(ctx context.Context) bool {
	return r.Availability(ctx)
}

// External reports whether the active generation's provider is "openai_compat"
// (`features.semantic_external` on `/auth/me`, plan P05 mục 2.18, 2.24 item 4,
// Task 13; SPEC §6.10).
//
// When no active generation exists yet, External falls back to checking whether
// the configured deployment provider is "openai_compat".
func (r *Runtime) External(ctx context.Context) bool {
	_, ext := r.resolveStaticAvailability(ctx)
	return ext
}

// IsBreakerOpen reports whether the API circuit breaker for the active
// generation's provider (or the primary provider when no active generation is
// cached) is currently open or half-open with a trial in flight (used by
// Task 13 `PATCH /me/settings` -> 409 semantic_unavailable, plan P05 mục 2.18).
func (r *Runtime) IsBreakerOpen() bool {
	if r == nil {
		return false
	}
	r.availMu.Lock()
	prov := r.availProvider
	r.availMu.Unlock()
	if prov != "" {
		b := r.BreakerForProvider(prov)
		return b != nil && b.IsOpen()
	}
	return r.primaryBreaker != nil && r.primaryBreaker.IsOpen()
}

func (r *Runtime) resolveStaticAvailability(ctx context.Context) (available bool, external bool) {
	if r == nil {
		return false, false
	}
	defaultExternal := r.provider == embedding.ProviderOpenAICompat
	if !r.enabled || r.provider == "" || r.provider == embedding.ProviderNoop {
		return false, defaultExternal
	}

	now := r.clk.Now()
	r.availMu.Lock()
	if r.availHasCache && now.Before(r.availExpires) {
		avail := r.availCached
		ext := r.availExternal
		r.availMu.Unlock()
		return avail, ext
	}
	epoch := r.availEpoch
	r.availMu.Unlock()

	if r.pinner == nil {
		return false, defaultExternal
	}

	if ctx == nil {
		ctx = context.Background()
	}
	pin, err := r.pinner.ActivePin(ctx)
	if err != nil {
		// Cache negative result only when there is genuinely no active generation
		// (so transient DB errors do not pin false for 30 s).
		if errors.Is(err, generation.ErrNoActiveGeneration) {
			r.storeAvailabilityCache(epoch, false, defaultExternal, "")
		}
		return false, defaultExternal
	}

	ext := pin.Identity.Provider == embedding.ProviderOpenAICompat
	avail := r.checkPinConfiguredAndCalibrated(pin)
	r.storeAvailabilityCache(epoch, avail, ext, pin.Identity.Provider)
	return avail, ext
}

func (r *Runtime) checkPinConfiguredAndCalibrated(pin generation.Pin) bool {
	if r == nil || !r.enabled || r.provider == "" || r.provider == embedding.ProviderNoop {
		return false
	}
	if r.clients == nil {
		return false
	}
	if _, ok := r.clients.Match(pin.Identity); !ok {
		return false
	}
	if r.calibration == nil {
		return false
	}
	if _, _, ok := r.calibration(pin.Identity); !ok {
		return false
	}
	return true
}

func (r *Runtime) storeAvailabilityCache(epoch uint64, avail bool, external bool, activeProvider string) {
	r.availMu.Lock()
	if r.availEpoch == epoch {
		r.availCached = avail
		r.availExternal = external
		r.availProvider = activeProvider
		r.availHasCache = true
		r.availExpires = r.clk.Now().Add(AvailabilityCacheTTL)
	}
	r.availMu.Unlock()
}

// recordActiveProvider updates the cached active provider on a successful
// ActivePin read when no availability snapshot has recorded a provider yet
// in the current notification epoch.
func (r *Runtime) recordActiveProvider(epoch uint64, activeProvider string) {
	if r == nil || activeProvider == "" {
		return
	}
	r.availMu.Lock()
	if r.availEpoch == epoch && r.availProvider == "" {
		r.availProvider = activeProvider
	}
	r.availMu.Unlock()
}
