package suggest

import (
	"time"

	"github.com/google/uuid"
)

// Match channel constants (OpenAPI schema `SuggestMatch`, SPEC §6.2, §6.4).
const (
	MatchPrefix       = "prefix"
	MatchPrefixFolded = "prefix_folded"
	MatchFuzzy        = "fuzzy"
	MatchSemantic     = "semantic"
)

// SemanticReason enum values (OpenAPI schema `SemanticReason`, SPEC §6.10, plan mục 2.5, 2.18).
const (
	ReasonDisabledServer = "disabled_server"
	ReasonDisabledUser   = "disabled_user"
	ReasonDegraded       = "degraded"
	ReasonRequestLexical = "request_lexical"
	ReasonShortQuery     = "short_query"
)

// SuggestLexicalCorpus values for `lexical_partial` (OpenAPI schema `SuggestLexicalCorpus`).
const (
	CorpusItem = "item"
	CorpusTag  = "tag"
)

// TierToMatch maps SQL lexical tier (3, 2, 1) to OpenAPI `SuggestMatch` string.
func TierToMatch(tier int32) string {
	switch tier {
	case 3:
		return MatchPrefix
	case 2:
		return MatchPrefixFolded
	default:
		return MatchFuzzy
	}
}

// SuggestQuota matches OpenAPI schema `SuggestQuota`.
type SuggestQuota struct {
	Tag     int `json:"tag"`
	Lexical int `json:"lexical"`
	Near    int `json:"near"`
}

// TagRef matches OpenAPI schema `TagRef` (`{id, display}`).
type TagRef struct {
	ID      uuid.UUID `json:"id"`
	Display string    `json:"display"`
}

// SuggestTag matches OpenAPI schema `SuggestTag`.
type SuggestTag struct {
	Kind       string    `json:"kind"`
	ID         uuid.UUID `json:"id"`
	Display    string    `json:"display"`
	ItemCount  int32     `json:"item_count"`
	LastUsedAt time.Time `json:"last_used_at"`
	Match      string    `json:"match"`
}

// SuggestItem matches OpenAPI schema `SuggestItem`.
// Never includes `hint` or entry data (SPEC §6.1, §9.2, user-dec-016).
// `Tags` is always a non-nil slice (`[]` when empty), max 3 items.
type SuggestItem struct {
	Kind       string    `json:"kind"`
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	EntryCount int32     `json:"entry_count"`
	CreatedAt  time.Time `json:"created_at"`
	LastUsedAt time.Time `json:"last_used_at"`
	Tags       []TagRef  `json:"tags"`
	TagTotal   int32     `json:"tag_total"`
	Match      string    `json:"match"`
}

// SuggestNearRow represents an element in `near` (OpenAPI `SuggestNearRow`:
// `oneOf: [SuggestTag, SuggestItem]` with `match: "semantic"` and no cosine score).
// Concrete elements are either `SuggestTag` or `SuggestItem`.
type SuggestNearRow any

// SuggestResponse matches OpenAPI schema `SuggestResponse` (plan mục 2.5).
// Never echoes `q` or `qn`, never includes `hint` or entry content.
// All array fields (`Tags`, `Items`, `LexicalPartial`, `Near`) are guaranteed non-nil (`[]` when empty).
type SuggestResponse struct {
	Scope          string           `json:"scope"`
	Limit          int              `json:"limit"`
	Mode           string           `json:"mode"`
	Quota          SuggestQuota     `json:"quota"`
	Tags           []SuggestTag     `json:"tags"`
	Items          []SuggestItem    `json:"items"`
	HasMore        bool             `json:"has_more"`
	LexicalPartial []string         `json:"lexical_partial"`
	Semantic       bool             `json:"semantic"`
	SemanticReason *string          `json:"semantic_reason"`
	Near           []SuggestNearRow `json:"near"`
	Generation     *int             `json:"generation"`
}

// NormalizeSlices ensures all required JSON array fields on SuggestResponse are non-nil
// so `encoding/json` always serializes `[]` instead of `null` (OpenAPI contract).
func (r *SuggestResponse) NormalizeSlices() {
	if r.Tags == nil {
		r.Tags = []SuggestTag{}
	}
	for i := range r.Items {
		if r.Items[i].Tags == nil {
			r.Items[i].Tags = []TagRef{}
		}
	}
	if r.Items == nil {
		r.Items = []SuggestItem{}
	}
	if r.LexicalPartial == nil {
		r.LexicalPartial = []string{}
	}
	if r.Near == nil {
		r.Near = []SuggestNearRow{}
	}
}
