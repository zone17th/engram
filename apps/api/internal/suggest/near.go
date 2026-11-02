package suggest

import (
	"context"
	"unicode/utf8"

	"github.com/google/uuid"
)

// KindID identifies a lexical hit by corpus kind ("item" or "tag") and UUID
// so the semantic near zone can deduplicate against lexical results (SPEC §6.4, plan 2.19).
type KindID struct {
	Kind string
	ID   uuid.UUID
}

// NearRequest is the input to NearSource.Near (plan P05 mục 2.19, Task 3).
type NearRequest struct {
	UserID        uuid.UUID
	QN            string
	Scope         string
	Limit         int
	Exclude       []KindID
	Cap           int
	SemanticParam bool
}

// NearResult is the output of NearSource.Near (plan P05 mục 2.5, 2.18, 2.19, Task 3).
type NearResult struct {
	Semantic       bool
	SemanticReason *string
	Near           []SuggestNearRow
	Generation     *int
}

// NearSource computes the semantic "Gần nghĩa" zone for /suggest and /search.
// Task 3 wires NoopNearSource; Task 12 replaces it with the real semantic runtime
// via a single hunk in compose/search.go.
type NearSource interface {
	Near(ctx context.Context, req NearRequest) (NearResult, error)
}

// NoopNearSource is the Phase A / W1 NearSource implementation when semantic search
// is not yet wired or disabled at the server level (plan P05 mục 2.5, 2.18, Task 3).
//
// Precedence (SPEC §6.4, §6.10, plan 2.18, 2.19):
// deployment -> generation -> user -> request -> breaker -> length.
// Because deployment/generation is disabled on a NoopNearSource, `disabled_server`
// is the default reason, while explicit `request_lexical` (when SemanticParam == false
// and DefaultReason == "") or `short_query` can be observed when configured.
type NoopNearSource struct {
	// ServerEnabled controls whether the noop source simulates a server where deployment
	// + generation + user are enabled (only used by tests; false in production W1).
	ServerEnabled bool
}

// NewNoopNearSource returns the default NoopNearSource (ServerEnabled = false -> disabled_server).
func NewNoopNearSource() NoopNearSource {
	return NoopNearSource{}
}

// Near implements NearSource.
func (n NoopNearSource) Near(_ context.Context, req NearRequest) (NearResult, error) {
	reason := ReasonDisabledServer
	if n.ServerEnabled {
		switch {
		case !req.SemanticParam:
			reason = ReasonRequestLexical
		case utf8.RuneCountInString(req.QN) < 3:
			reason = ReasonShortQuery
		default:
			reason = ReasonDisabledServer
		}
	}
	return NearResult{
		Semantic:       false,
		SemanticReason: &reason,
		Near:           []SuggestNearRow{},
		Generation:     nil,
	}, nil
}
