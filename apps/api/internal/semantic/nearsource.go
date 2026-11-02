package semantic

import (
	"context"
	"errors"
	"sync"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// requestPinState caches the single ActivePin read within an HTTP request when
// Task 4's /search page-1 path calls ActiveGeneration(ctx, userID) first and
// Near(ctx, req) second (`internal/suggest/search.go:101,240`).
//
// Keying by ctx.Done() (the per-request context cancellation channel created by
// net/http Server or per-request context.WithTimeout/WithCancel) allows Near to
// consume the exact Pin resolved by ActiveGeneration even though suggest.Service
// does not return a mutated context from ActiveGeneration. The entry is
// one-shot (deleted on consumption by Near, or on context cancellation when
// Near is not called on cursor pages).
type requestPinEntry struct {
	userID uuid.UUID
	pin    generation.Pin
	hasPin bool
}

type nearSource struct {
	rt      *Runtime
	reqMu   sync.Mutex
	reqPins map[<-chan struct{}]requestPinEntry
}

// NearSource returns the suggest.NearSource backed by this Runtime.
func (r *Runtime) NearSource() suggest.NearSource {
	if r == nil {
		return suggest.NewNoopNearSource()
	}
	return &nearSource{
		rt:      r,
		reqPins: make(map[<-chan struct{}]requestPinEntry),
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
//   - Records the resolved Pin in the request-scoped slot keyed by ctx.Done() so
//     a subsequent Near(ctx, req) call in the same page-1 `/search` request reuses
//     the exact same Pin without a second ActivePin read (preventing a generation
//     flip between ActiveGeneration and Near from producing response.generation != cursor.gen).
func (s *nearSource) ActiveGeneration(ctx context.Context, userID uuid.UUID) (*int, error) {
	if s == nil || s.rt == nil || s.rt.pinner == nil {
		return nil, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}

	pin, err := s.rt.readActivePin(ctx)
	if err != nil {
		if errors.Is(err, generation.ErrNoActiveGeneration) {
			s.storeRequestPin(ctx, userID, generation.Pin{}, false)
			return nil, nil
		}
		if isCallerCanceled(ctx, err) {
			return nil, context.Canceled
		}
		logSafeError(ctx, s.rt.logger, "semantic active generation lookup failed", "active_generation_lookup_failed")
		return nil, err
	}

	s.storeRequestPin(ctx, userID, pin, true)
	genID := pin.GenID
	return &genID, nil
}

func (s *nearSource) storeRequestPin(ctx context.Context, userID uuid.UUID, pin generation.Pin, hasPin bool) {
	if s == nil || ctx == nil {
		return
	}
	done := ctx.Done()
	if done == nil {
		return
	}
	s.reqMu.Lock()
	if s.reqPins == nil {
		s.reqPins = make(map[<-chan struct{}]requestPinEntry)
	}
	_, alreadyTracked := s.reqPins[done]
	s.reqPins[done] = requestPinEntry{
		userID: userID,
		pin:    pin,
		hasPin: hasPin,
	}
	s.reqMu.Unlock()

	if !alreadyTracked {
		go func() {
			<-done
			s.reqMu.Lock()
			delete(s.reqPins, done)
			s.reqMu.Unlock()
		}()
	}
}

func (s *nearSource) takeRequestPin(ctx context.Context, userID uuid.UUID) (generation.Pin, bool, bool) {
	if s == nil || ctx == nil {
		return generation.Pin{}, false, false
	}
	done := ctx.Done()
	if done == nil {
		return generation.Pin{}, false, false
	}
	s.reqMu.Lock()
	entry, ok := s.reqPins[done]
	if ok && entry.userID == userID {
		delete(s.reqPins, done)
		s.reqMu.Unlock()
		return entry.pin, entry.hasPin, true
	}
	s.reqMu.Unlock()
	return generation.Pin{}, false, false
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
	var (
		pin    generation.Pin
		reason string
		ok     bool
	)
	if cachedPin, hasPin, found := s.takeRequestPin(ctx, req.UserID); found {
		if !hasPin {
			rt.recordDecisionMetric(suggest.ReasonDisabledServer)
			return disabledNearResult(suggest.ReasonDisabledServer), nil
		}
		pin, reason, ok = rt.decideServerWithPin(ctx, cachedPin)
	} else {
		pin, reason, ok = rt.decideServerAndPin(ctx)
	}
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
