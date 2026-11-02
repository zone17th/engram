package semantic

import (
	"context"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// MetricDecisionRan is the label value recorded on semantic_decisions_total
// when the semantic branch actually ran and succeeded (plan P05 mục 2.21,
// obs.SemanticDecisionReasons).
const MetricDecisionRan = "ran"

// MismatchReasonUnconfigured is the label value recorded on
// embedding_generation_mismatch_total when the active generation's 7-field
// Identity does not match any configured client in ClientSet (plan P05 mục
// 2.12, 2.21, BE-1, BE-13).
const MismatchReasonUnconfigured = "unconfigured"

// MismatchReasonDims is the label value recorded on
// embedding_generation_mismatch_total when len(qvec) != pin.Identity.Dims
// (plan P05 mục 2.15, 2.21).
const MismatchReasonDims = "dims"

// UserSettings holds the user's semantic preference for Decide.
type UserSettings struct {
	SemanticSuggest bool
}

// DecideRequest holds the request-level inputs for Decide.
type DecideRequest struct {
	QN            string
	Scope         string
	SemanticParam bool
}

// Decision is the result of Runtime.Decide (plan P05 mục 2.18, 2.19, Task 12;
// SPEC §6.4, §6.10).
//
// When Effective == true:
//   - Reason is "" (wire semantic_reason is nil unless Candidates subsequently degrades).
//   - Pin holds the single active generation Pin read for this request (BE-1, BE-13:
//     Candidates must use this exact Pin and never re-read the active generation).
type Decision struct {
	Effective bool
	Reason    string
	Pin       generation.Pin
}

// Decide evaluates whether semantic search should run for the given request in
// strict precedence order (SPEC §6.4, §6.10; plan P05 mục 2.18, 2.19, Task 12):
//
//  1. deployment: SEARCH_SEMANTIC_ENABLED && provider != "noop" && ClientSet != nil
//     -> false, "disabled_server"
//  2. generation: active generation exists (single ActivePin read per request),
//     ClientSet.Match(pin.Identity) (all 7 Identity fields via Key()), and
//     calibration exists for pin.Identity:
//     - no active generation -> false, "disabled_server"
//     - active generation identity does not match any configured client ->
//     false, "degraded" + embedding_generation_mismatch_total{reason="unconfigured"}
//     + log error_class="generation_unconfigured" (BE-1, BE-13, TestPinClientIdentityMismatchDegrades)
//     - calibration missing for pin.Identity -> false, "disabled_server"
//  3. user: settings.SemanticSuggest == true -> false, "disabled_user"
//  4. request: req.SemanticParam == true -> false, "request_lexical"
//  5. breaker: API circuit breaker for pin.Identity.Provider is not Open within
//     its 60 s window -> false, "degraded" (HalfOpen admits via Candidates Acquire)
//  6. length: utf8.RuneCountInString(req.QN) >= 3 -> false, "short_query"
func (r *Runtime) Decide(
	ctx context.Context,
	_ uuid.UUID,
	settings UserSettings,
	req DecideRequest,
) Decision {
	pin, reason, ok := r.decideServerAndPin(ctx)
	if !ok {
		return Decision{
			Effective: false,
			Reason:    reason,
			Pin:       pin,
		}
	}
	return r.decideWithPin(pin, settings, req)
}

// decideServerAndPin evaluates steps 1 (deployment) and 2 (active generation,
// ClientSet.Match, calibration), reading ActivePin at most once.
func (r *Runtime) decideServerAndPin(ctx context.Context) (generation.Pin, string, bool) {
	if r == nil || !r.enabled || r.provider == "" || r.provider == embedding.ProviderNoop || r.clients == nil || r.pinner == nil {
		return generation.Pin{}, suggest.ReasonDisabledServer, false
	}

	pin, err := r.readActivePin(ctx)
	if err != nil {
		return generation.Pin{}, suggest.ReasonDisabledServer, false
	}
	return r.decideServerWithPin(ctx, pin)
}

// readActivePin reads the active generation Pin from r.pinner and updates the
// active provider snapshot for the current notification epoch.
func (r *Runtime) readActivePin(ctx context.Context) (generation.Pin, error) {
	if r == nil || r.pinner == nil {
		return generation.Pin{}, generation.ErrNoActiveGeneration
	}
	if ctx == nil {
		ctx = context.Background()
	}
	r.availMu.Lock()
	epoch := r.availEpoch
	r.availMu.Unlock()
	pin, err := r.pinner.ActivePin(ctx)
	if err != nil {
		return generation.Pin{}, err
	}
	r.recordActiveProvider(epoch, pin.Identity.Provider)
	return pin, nil
}

// decideServerWithPin evaluates steps 1 (deployment) and 2 (active generation,
// ClientSet.Match, calibration) using an already-resolved active Pin (or
// generation.ErrNoActiveGeneration when hasPin is false) so callers that
// already called ActiveGeneration in the same request never re-read ActivePin.
func (r *Runtime) decideServerWithPin(ctx context.Context, pin generation.Pin) (generation.Pin, string, bool) {
	if r == nil || !r.enabled || r.provider == "" || r.provider == embedding.ProviderNoop || r.clients == nil || r.pinner == nil {
		return generation.Pin{}, suggest.ReasonDisabledServer, false
	}
	if pin.GenID <= 0 {
		return generation.Pin{}, suggest.ReasonDisabledServer, false
	}
	if _, ok := r.clients.Match(pin.Identity); !ok {
		r.incGenerationMismatch(MismatchReasonUnconfigured)
		logSafeError(ctx, r.logger, "semantic active generation unconfigured", "generation_unconfigured")
		return pin, suggest.ReasonDegraded, false
	}

	if r.calibration == nil {
		return pin, suggest.ReasonDisabledServer, false
	}
	if _, _, ok := r.calibration(pin.Identity); !ok {
		return pin, suggest.ReasonDisabledServer, false
	}

	return pin, "", true
}

// decideWithPin evaluates steps 3 (user) -> 4 (request) -> 5 (breaker) ->
// 6 (length) using the already-pinned generation Pin so ActivePin is never
// called a second time in the same request (BE-1, BE-13).
func (r *Runtime) decideWithPin(
	pin generation.Pin,
	settings UserSettings,
	req DecideRequest,
) Decision {
	if !settings.SemanticSuggest {
		return Decision{
			Effective: false,
			Reason:    suggest.ReasonDisabledUser,
			Pin:       pin,
		}
	}

	if !req.SemanticParam {
		return Decision{
			Effective: false,
			Reason:    suggest.ReasonRequestLexical,
			Pin:       pin,
		}
	}

	if b := r.BreakerForProvider(pin.Identity.Provider); b != nil && b.State() == embedding.BreakerStateOpen {
		return Decision{
			Effective: false,
			Reason:    suggest.ReasonDegraded,
			Pin:       pin,
		}
	}

	if utf8.RuneCountInString(req.QN) < 3 {
		return Decision{
			Effective: false,
			Reason:    suggest.ReasonShortQuery,
			Pin:       pin,
		}
	}

	return Decision{
		Effective: true,
		Reason:    "",
		Pin:       pin,
	}
}

func (r *Runtime) recordDecisionMetric(reason string) {
	if r == nil || r.metrics == nil || r.metrics.Search == nil || r.metrics.Search.SemanticDecisionsTotal == nil {
		return
	}
	if reason == "" {
		reason = MetricDecisionRan
	}
	r.metrics.Search.SemanticDecisionsTotal.WithLabelValues(reason).Inc()
}

func (r *Runtime) incGenerationMismatch(reason string) {
	if r == nil || r.metrics == nil || r.metrics.Embedding == nil || r.metrics.Embedding.GenerationMismatchTotal == nil {
		return
	}
	r.metrics.Embedding.GenerationMismatchTotal.WithLabelValues(reason).Inc()
}
