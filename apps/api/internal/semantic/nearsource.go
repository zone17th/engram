package semantic

import (
	"context"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

type nearSource struct {
	rt *Runtime
}

// NearSource returns the suggest.NearSource backed by this Runtime.
func (r *Runtime) NearSource() suggest.NearSource {
	if r == nil {
		return suggest.NewNoopNearSource()
	}
	return &nearSource{
		rt: r,
	}
}

// ActiveGeneration implements suggest.NearSource (advisor-dec-290, dec-294, Task 4 / Task 12).
//
// Contract:
//   - Reads only the pinned active generation from Pinner.ActivePin; never calls
//     the embedding provider or VectorSearcher, never inspects q/qn, and never logs
//     user input.
//   - NOT gated on user setting (`semantic_suggest`), request `semantic` flag,
//     ClientSet.Match, or static availability (`SEARCH_SEMANTIC_ENABLED` /
//     `provider != "noop"`), because `/search` cursors bind `gen` on lexical
//     requests too (`internal/suggest/search.go:92,101`, `cursor.go:52-55`).
//   - Returns `nil, nil` when the runtime has no pinner or when no generation is
//     active (`generation.ErrNoActiveGeneration`).
//   - Propagates non-ErrNoActiveGeneration Pinner/DB errors (logged only with a
//     fixed error_class="active_generation_lookup_failed") so `/search` maps them
//     to HTTP 500 `internal_error` with a static problem detail (`search.go:93-95,102-104`).
//   - When a request-scoped carrier is present in ctx (installed via
//     WithRequestScope or RequestScopeMiddleware), resolves ActivePin once and
//     stores the outcome (including no-active and lookup error outcomes) on the
//     carrier for userID so a subsequent Near(ctx, req) call for the same userID
//     reuses that exact resolution without a second ActivePin read (preventing a
//     generation flip between ActiveGeneration and Near from producing
//     response.generation != cursor.gen, RV-T12-BE-10). Without a carrier in ctx,
//     reads ActivePin directly on each call; callers needing cursor/response
//     consistency must install the scope via WithRequestScope or RequestScopeMiddleware.
func (s *nearSource) ActiveGeneration(ctx context.Context, userID uuid.UUID) (*int, error) {
	if s == nil || s.rt == nil || s.rt.pinner == nil {
		return nil, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}

	pin, hasPin, err := s.rt.resolveOrReadPin(ctx, userID)
	if err != nil {
		if isCallerCanceled(ctx, err) {
			return nil, context.Canceled
		}
		logSafeError(ctx, s.rt.logger, "semantic active generation lookup failed", "active_generation_lookup_failed")
		return nil, err
	}
	if !hasPin {
		return nil, nil
	}

	genID := pin.GenID
	return &genID, nil
}

// Near implements suggest.NearSource on top of Runtime.Decide, Runtime.Candidates,
// and AppendZone (plan P05 mục 2.18, 2.19, 2.21, Task 12; SPEC §6.4, §6.10).
//
// Invariants:
//   - ActivePin is read at most once per request inside Decide; the same Pin is
//     reused for ClientSet.Match, query-cache lookup/insert, both parallel
//     VectorSearch branches, and the returned Generation ID (BE-1, BE-13).
//   - Only inspect user settings in DB after deployment + active generation +
//     ClientSet.Match + calibration checks pass (so disabled_server / unconfigured
//     generations require 0 user-settings DB queries and 0 provider calls).
//   - Increments semantic_decisions_total{reason} exactly once per request
//     ("disabled_server", "disabled_user", "degraded", "request_lexical",
//     "short_query", or "ran").
//   - Returns Semantic=true, SemanticReason=nil, Generation=&pin.GenID only when
//     semantic ran without degrading; otherwise Semantic=false, SemanticReason=&reason,
//     Near=[], Generation=nil.
func (s *nearSource) Near(ctx context.Context, req suggest.NearRequest) (suggest.NearResult, error) {
	if s == nil || s.rt == nil {
		return disabledNearResult(suggest.ReasonDisabledServer), nil
	}

	rt := s.rt
	if !rt.enabled || rt.provider == "" || rt.provider == embedding.ProviderNoop || rt.clients == nil || rt.pinner == nil {
		rt.recordDecisionMetric(suggest.ReasonDisabledServer)
		return disabledNearResult(suggest.ReasonDisabledServer), nil
	}

	resolvedPin, hasPin, err := rt.resolveOrReadPin(ctx, req.UserID)
	if err != nil || !hasPin {
		rt.recordDecisionMetric(suggest.ReasonDisabledServer)
		return disabledNearResult(suggest.ReasonDisabledServer), nil
	}
	pin, reason, ok := rt.decideServerWithPin(ctx, resolvedPin)
	if !ok {
		rt.recordDecisionMetric(reason)
		return disabledNearResult(reason), nil
	}
	// Step 2: Deployment + generation + client match + calibration all succeeded.
	// Read user's semantic_suggest setting to evaluate steps 3..6 in strict order
	// without re-reading ActivePin (BE-1, BE-13).
	userEnabled := true
	if rt.settings != nil {
		enabled, err := rt.settings.SemanticSuggestEnabled(ctx, req.UserID)
		if err != nil {
			if isCallerCanceled(ctx, err) {
				return suggest.NearResult{}, context.Canceled
			}
			rt.recordDecisionMetric(suggest.ReasonDegraded)
			return disabledNearResult(suggest.ReasonDegraded), nil
		}
		userEnabled = enabled
	}

	dec := rt.decideWithPin(pin, UserSettings{SemanticSuggest: userEnabled}, DecideRequest{
		QN:            req.QN,
		Scope:         req.Scope,
		SemanticParam: req.SemanticParam,
	})
	if !dec.Effective {
		rt.recordDecisionMetric(dec.Reason)
		return disabledNearResult(dec.Reason), nil
	}

	// Step 3: Semantic decision is Effective == true. Run Candidates using dec.Pin.
	cands, err := rt.Candidates(ctx, req.UserID, dec, req.QN, req.Scope)
	if err != nil {
		if isCallerCanceled(ctx, err) {
			return suggest.NearResult{}, context.Canceled
		}
		rt.recordDecisionMetric(suggest.ReasonDegraded)
		return disabledNearResult(suggest.ReasonDegraded), nil
	}
	if cands.Degraded {
		degReason := cands.Reason
		if degReason == "" {
			degReason = suggest.ReasonDegraded
		}
		rt.recordDecisionMetric(degReason)
		return disabledNearResult(degReason), nil
	}

	// Build lexical placeholder rows from req.Exclude so AppendZone drops any
	// `(kind, id)` already present in the lexical prefix and caps the appended
	// near zone to zoneQuota.
	lexicalRows := make([]Row, len(req.Exclude))
	for i, ex := range req.Exclude {
		lexicalRows[i] = Row{
			Kind: ex.Kind,
			ID:   ex.ID,
		}
	}

	zoneQuota := req.Cap
	if req.Limit > 0 {
		if rem := req.Limit - len(lexicalRows); rem < zoneQuota {
			zoneQuota = rem
		}
	}
	if zoneQuota < 0 {
		zoneQuota = 0
	}

	merged := AppendZone(lexicalRows, cands.Items, cands.Tags, zoneQuota)
	nearSlice := merged[len(lexicalRows):]
	nearOut := make([]suggest.SuggestNearRow, len(nearSlice))
	for i, r := range nearSlice {
		nearOut[i] = r.ToSuggestNearRow()
	}

	rt.recordDecisionMetric(MetricDecisionRan)
	genID := dec.Pin.GenID
	return suggest.NearResult{
		Semantic:       true,
		SemanticReason: nil,
		Near:           nearOut,
		Generation:     &genID,
	}, nil
}

func disabledNearResult(reason string) suggest.NearResult {
	r := reason
	return suggest.NearResult{
		Semantic:       false,
		SemanticReason: &r,
		Near:           []suggest.SuggestNearRow{},
		Generation:     nil,
	}
}
