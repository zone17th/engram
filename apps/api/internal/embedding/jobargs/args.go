// Package jobargs defines the River job argument structs for the embedding
// pipeline (plan P05 mục 2.15, 2.17; ADR 0007; M2/FS-24).
//
// It is a pure stdlib leaf package with no internal or external dependencies so
// that jobs, reconcile, lifecycle, and auth settings can share job payload
// contracts without import cycles.
//
// Privacy invariant (user-dec-016, plan mục 5 item 7): job arguments carry ONLY
// generation IDs, UUIDs, and hex-encoded SHA-256 input hashes — never item
// names, hints, tag display strings, query text, or entry bodies.
package jobargs

// Kind constants for embedding River jobs (plan P05 mục 2.17).
const (
	KindEmbedItem     = "embed_item"
	KindEmbedTag      = "embed_tag"
	KindReembedUser   = "reembed_user"
	KindReembedAll    = "reembed_all"
	KindCanary        = "embedding_canary"
	KindBootstrapFlip = "embedding_bootstrap_flip"
)

// EmbedItemArgs is the River job payload for embedding a single item in a
// specific generation.
type EmbedItemArgs struct {
	GenerationID int    `json:"generation_id"`
	UserID       string `json:"user_id"`
	TargetID     string `json:"target_id"`
	InputHash    string `json:"input_hash"`
}

// Kind returns the River job kind "embed_item".
func (EmbedItemArgs) Kind() string { return KindEmbedItem }

// EmbedTagArgs is the River job payload for embedding a single tag in a
// specific generation.
type EmbedTagArgs struct {
	GenerationID int    `json:"generation_id"`
	UserID       string `json:"user_id"`
	TargetID     string `json:"target_id"`
	InputHash    string `json:"input_hash"`
}

// Kind returns the River job kind "embed_tag".
func (EmbedTagArgs) Kind() string { return KindEmbedTag }

// ReembedUserArgs is the River job payload for reconciling all receiving
// generations for a single user (e.g. when re-enabling semantic_suggest).
type ReembedUserArgs struct {
	UserID string `json:"user_id"`
}

// Kind returns the River job kind "reembed_user".
func (ReembedUserArgs) Kind() string { return KindReembedUser }

// ReembedAllArgs is the River job payload for reconciling all users across all
// receiving generations (or a specific generation when GenerationID > 0).
type ReembedAllArgs struct {
	GenerationID int `json:"generation_id,omitempty"`
}

// Kind returns the River job kind "reembed_all".
func (ReembedAllArgs) Kind() string { return KindReembedAll }

// CanaryArgs is the River job payload for the periodic embedding drift canary.
type CanaryArgs struct{}

// Kind returns the River job kind "embedding_canary".
func (CanaryArgs) Kind() string { return KindCanary }

// BootstrapFlipArgs is the River job payload for the periodic bootstrap
// verification and auto-flip check (g1 with bootstrap=true only).
type BootstrapFlipArgs struct{}

// Kind returns the River job kind "embedding_bootstrap_flip".
func (BootstrapFlipArgs) Kind() string { return KindBootstrapFlip }
