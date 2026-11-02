package suggest

// Scope, mode, and limit constants for /suggest and /search (SPEC §6.4, §9.2,
// OpenAPI schemas SearchScope, SuggestMode, SuggestQuota, plan P05 mục 2.4, 2.24).
const (
	ScopeAll  = "all"
	ScopeItem = "item"
	ScopeTag  = "tag"

	ModeRecent = "recent"
	ModePrefix = "prefix"
	ModeFull   = "full"

	DefaultSuggestLimit = 8
	MobileSuggestLimit  = 5
	MaxSuggestLimit     = 12

	DefaultSearchLimit = 20
	MaxSearchLimit     = 50
)

// QuotaCell holds the static quota parameters for a (scope, limit) cell
// matching packages/search-fixtures/quota.json (plan P05 mục 2.4, 2.24, FS-26).
type QuotaCell struct {
	Scope      string
	Limit      int
	TagMax     int
	LexMax     int
	NearBase   int
	NearMaxCap int
	RecentTag  int
	RecentItem int
}

// SuggestQuotaTable embeds the 9-row quota table from packages/search-fixtures/quota.json.
// TestSuggestQuotaTable verifies every cell against quota.json.
var SuggestQuotaTable = []QuotaCell{
	{Scope: ScopeAll, Limit: 5, TagMax: 2, LexMax: 4, NearBase: 1, NearMaxCap: 2, RecentTag: 2, RecentItem: 3},
	{Scope: ScopeAll, Limit: 8, TagMax: 3, LexMax: 6, NearBase: 2, NearMaxCap: 3, RecentTag: 3, RecentItem: 5},
	{Scope: ScopeAll, Limit: 12, TagMax: 4, LexMax: 9, NearBase: 3, NearMaxCap: 4, RecentTag: 4, RecentItem: 8},

	{Scope: ScopeItem, Limit: 5, TagMax: 0, LexMax: 4, NearBase: 1, NearMaxCap: 2, RecentTag: 0, RecentItem: 5},
	{Scope: ScopeItem, Limit: 8, TagMax: 0, LexMax: 6, NearBase: 2, NearMaxCap: 3, RecentTag: 0, RecentItem: 8},
	{Scope: ScopeItem, Limit: 12, TagMax: 0, LexMax: 9, NearBase: 3, NearMaxCap: 4, RecentTag: 0, RecentItem: 12},

	{Scope: ScopeTag, Limit: 5, TagMax: 4, LexMax: 4, NearBase: 1, NearMaxCap: 2, RecentTag: 5, RecentItem: 0},
	{Scope: ScopeTag, Limit: 8, TagMax: 6, LexMax: 6, NearBase: 2, NearMaxCap: 3, RecentTag: 8, RecentItem: 0},
	{Scope: ScopeTag, Limit: 12, TagMax: 9, LexMax: 9, NearBase: 3, NearMaxCap: 4, RecentTag: 12, RecentItem: 0},
}

// ValidSuggestScope returns true if scope is one of "all", "item", "tag".
func ValidSuggestScope(scope string) bool {
	return scope == ScopeAll || scope == ScopeItem || scope == ScopeTag
}

// ValidSuggestLimit returns true if limit is one of 5, 8, 12.
func ValidSuggestLimit(limit int) bool {
	return limit == 5 || limit == 8 || limit == 12
}

// LookupQuotaCell returns the QuotaCell for (scope, limit).
func LookupQuotaCell(scope string, limit int) (QuotaCell, bool) {
	for _, c := range SuggestQuotaTable {
		if c.Scope == scope && c.Limit == limit {
			return c, true
		}
	}
	return QuotaCell{}, false
}

// CorpusQueryCaps returns the maximum number of lexical rows (before +1 for has_more)
// that each corpus branch can possibly use for the given (scope, limit, mode).
// Calling SQL with `cap + 1` suffices to determine `has_more` and to fill spare slots
// when the sibling corpus has fewer hits (plan mục 2.3, 2.4).
func CorpusQueryCaps(scope string, limit int, mode string) (tagCap int, itemCap int) {
	cell, ok := LookupQuotaCell(scope, limit)
	if !ok {
		return 0, 0
	}
	if mode == ModeRecent {
		switch scope {
		case ScopeItem:
			return 0, cell.Limit
		case ScopeTag:
			return cell.Limit, 0
		default:
			// In recent mode: tags_used = min(tag_hits, recent_tag),
			// items_used = min(item_hits, limit - tags_used) <= limit.
			return cell.RecentTag, cell.Limit
		}
	}
	switch scope {
	case ScopeItem:
		return 0, cell.LexMax
	case ScopeTag:
		return cell.LexMax, 0
	default:
		// In prefix/full mode for scope=all, either corpus can expand up to lex_max
		// if the other corpus returns 0 hits.
		return cell.LexMax, cell.LexMax
	}
}

// Allocation holds the computed slot counts and wire SuggestQuota for a response.
type Allocation struct {
	TagsUsed  int
	ItemsUsed int
	NearUsed  int
	WireQuota SuggestQuota
}

// ComputeQuota computes `tags_used`, `items_used`, `near_used`, and the wire
// `SuggestQuota{Tag, Lexical, Near}` according to plan P05 mục 2.4 and 2.24 item 5
// (advisor-dec-256/259, SPEC §6.4, packages/search-fixtures/quota.json):
//
// For mode == "recent":
//   - WireQuota = {Tag: recent_tag, Lexical: recent_tag + recent_item (= limit), Near: 0}
//   - tags_used = min(tagHits, recent_tag)
//   - items_used = min(itemHits, limit - tags_used)
//   - near_used = 0
//
// For mode == "prefix" or "full":
//   - tags_used = min(tagHits, max(tag_max, lex_max - itemHits))
//   - items_used = min(itemHits, lex_max - tags_used)
//   - near_eff = min(near_max_cap, near_base + max(0, lex_max - tags_used - items_used))
//   - WireQuota = {Tag: tag_max, Lexical: lex_max, Near: near_eff}
//   - near_used = min(nearHitsAfterDedup, near_eff, limit - tags_used - items_used)
//
// Notice that `tags_used`, `items_used`, and `WireQuota` depend ONLY on
// `(scope, limit, mode, tagHits, itemHits)` and are completely independent of
// whether semantic is enabled or how many near hits were returned.
func ComputeQuota(scope string, limit int, mode string, tagHits, itemHits, nearHitsAfterDedup int) Allocation {
	cell, ok := LookupQuotaCell(scope, limit)
	if !ok {
		return Allocation{}
	}
	if tagHits < 0 {
		tagHits = 0
	}
	if itemHits < 0 {
		itemHits = 0
	}
	if nearHitsAfterDedup < 0 {
		nearHitsAfterDedup = 0
	}

	if mode == ModeRecent {
		tagsUsed := min(tagHits, cell.RecentTag)
		itemsUsed := 0
		if scope != ScopeTag {
			itemsUsed = min(itemHits, cell.Limit-tagsUsed)
		}
		return Allocation{
			TagsUsed:  tagsUsed,
			ItemsUsed: itemsUsed,
			NearUsed:  0,
			WireQuota: SuggestQuota{
				Tag:     cell.RecentTag,
				Lexical: cell.RecentTag + cell.RecentItem,
				Near:    0,
			},
		}
	}

	var tagsUsed, itemsUsed int
	switch scope {
	case ScopeItem:
		tagsUsed = 0
		itemsUsed = min(itemHits, cell.LexMax)
	case ScopeTag:
		tagsUsed = min(tagHits, cell.LexMax)
		itemsUsed = 0
	default:
		tagsCap := max(cell.TagMax, cell.LexMax-itemHits)
		tagsUsed = min(tagHits, tagsCap)
		itemsUsed = min(itemHits, cell.LexMax-tagsUsed)
	}

	lexShortfall := max(0, cell.LexMax-tagsUsed-itemsUsed)
	nearEff := min(cell.NearMaxCap, cell.NearBase+lexShortfall)
	nearUsed := min(nearHitsAfterDedup, min(nearEff, cell.Limit-tagsUsed-itemsUsed))
	if nearUsed < 0 {
		nearUsed = 0
	}

	return Allocation{
		TagsUsed:  tagsUsed,
		ItemsUsed: itemsUsed,
		NearUsed:  nearUsed,
		WireQuota: SuggestQuota{
			Tag:     cell.TagMax,
			Lexical: cell.LexMax,
			Near:    nearEff,
		},
	}
}
