package semantic

import (
	"bytes"
	"slices"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// Row represents a single lexical or semantic result row in the pure AppendZone
// merge function (plan P05 mục 2.19, Task 12; SPEC §6.4).
//
// Security invariant: never carries cosine similarity or item.hint on the wire
// representation; Match is always set to "semantic" for appended near-zone rows.
type Row struct {
	Kind       string // "item" or "tag"
	ID         uuid.UUID
	Name       string    // item name (when Kind == "item")
	Display    string    // tag display (when Kind == "tag")
	Count      int32     // entry_count (item) or item_count (tag)
	CreatedAt  time.Time // UTC (for items)
	LastUsedAt time.Time // UTC
	Tags       []TagRef  // non-nil slice of up to 3 TagRefs (for items)
	TagTotal   int32     // total live tag count (for items)
	Match      string    // "prefix" | "prefix_folded" | "fuzzy" | "semantic"
}

// KindID returns the suggest.KindID key `(Kind, ID)` for deduplication.
func (r Row) KindID() suggest.KindID {
	return suggest.KindID{Kind: r.Kind, ID: r.ID}
}

// ToSuggestNearRow converts a semantic Row into a suggest.SuggestNearRow
// (`suggest.SuggestTag` or `suggest.SuggestItem` with `match: "semantic"` and
// no cosine score, matching OpenAPI schema `SuggestNearRow`, plan P05 mục 2.5).
func (r Row) ToSuggestNearRow() suggest.SuggestNearRow {
	if r.Kind == suggest.CorpusTag {
		return suggest.SuggestTag{
			Kind:       suggest.CorpusTag,
			ID:         r.ID,
			Display:    r.Display,
			ItemCount:  r.Count,
			LastUsedAt: r.LastUsedAt.UTC(),
			Match:      suggest.MatchSemantic,
		}
	}
	tags := make([]suggest.TagRef, len(r.Tags))
	for i, t := range r.Tags {
		tags[i] = suggest.TagRef{
			ID:      t.ID,
			Display: t.Display,
		}
	}
	return suggest.SuggestItem{
		Kind:       suggest.CorpusItem,
		ID:         r.ID,
		Name:       r.Name,
		EntryCount: r.Count,
		CreatedAt:  r.CreatedAt.UTC(),
		LastUsedAt: r.LastUsedAt.UTC(),
		Tags:       tags,
		TagTotal:   r.TagTotal,
		Match:      suggest.MatchSemantic,
	}
}

// AppendZone merges lexical rows with semantic item and tag candidates into a
// combined slice (plan P05 mục 2.19, Task 12; SPEC §6.4):
//
//   - Pure function: never mutates the input slices.
//   - Lexical prefix is preserved verbatim (never cut or reordered).
//   - Any candidate whose `(kind, id)` already appears in `lexical` (or earlier
//     in the semantic zone) is dropped.
//   - Within the appended near zone, semantic tags come first, followed by
//     semantic items (OQ-11, SPEC §6.4).
//   - Within each semantic group (tags, then items), candidates are ordered by
//     `cos DESC, last_used_at DESC, count DESC, id ASC`.
//   - The appended near zone contains at most `zoneQuota` rows (where callers pass
//     `min(quota.near, limit - len(lexical))`).
//   - Appended rows have `Match: "semantic"` and never expose `Cos`.
func AppendZone(lexical []Row, semItems, semTags []Candidate, zoneQuota int) []Row {
	out := make([]Row, len(lexical))
	seen := make(map[suggest.KindID]struct{}, len(lexical)+len(semItems)+len(semTags))
	for i, r := range lexical {
		out[i] = cloneRow(r)
		seen[r.KindID()] = struct{}{}
	}
	if zoneQuota <= 0 || (len(semItems) == 0 && len(semTags) == 0) {
		return out
	}

	sortedTags := sortAndFilterCandidates(semTags, suggest.CorpusTag, seen)
	sortedItems := sortAndFilterCandidates(semItems, suggest.CorpusItem, seen)

	appended := 0
	for _, c := range sortedTags {
		if appended >= zoneQuota {
			break
		}
		out = append(out, candidateToSemanticRow(c, suggest.CorpusTag))
		appended++
	}
	for _, c := range sortedItems {
		if appended >= zoneQuota {
			break
		}
		out = append(out, candidateToSemanticRow(c, suggest.CorpusItem))
		appended++
	}
	return out
}

func sortAndFilterCandidates(
	in []Candidate,
	kind string,
	seen map[suggest.KindID]struct{},
) []Candidate {
	if len(in) == 0 {
		return nil
	}
	sorted := make([]Candidate, len(in))
	copy(sorted, in)
	slices.SortFunc(sorted, compareCandidates)

	filtered := make([]Candidate, 0, len(sorted))
	for _, c := range sorted {
		k := suggest.KindID{Kind: kind, ID: c.ID}
		if _, exists := seen[k]; exists {
			continue
		}
		seen[k] = struct{}{}
		filtered = append(filtered, c)
	}
	return filtered
}

// compareCandidates orders Candidates by:
//  1. Cos DESC
//  2. LastUsedAt DESC
//  3. Count DESC
//  4. ID ASC
func compareCandidates(a, b Candidate) int {
	if a.Cos > b.Cos {
		return -1
	}
	if a.Cos < b.Cos {
		return 1
	}
	if a.LastUsedAt.After(b.LastUsedAt) {
		return -1
	}
	if a.LastUsedAt.Before(b.LastUsedAt) {
		return 1
	}
	if a.Count > b.Count {
		return -1
	}
	if a.Count < b.Count {
		return 1
	}
	return bytes.Compare(a.ID[:], b.ID[:])
}

func candidateToSemanticRow(c Candidate, kind string) Row {
	if kind == suggest.CorpusTag {
		return Row{
			Kind:       suggest.CorpusTag,
			ID:         c.ID,
			Display:    c.Display,
			Count:      c.Count,
			LastUsedAt: c.LastUsedAt.UTC(),
			Match:      suggest.MatchSemantic,
		}
	}
	tags := make([]TagRef, len(c.Tags))
	copy(tags, c.Tags)
	return Row{
		Kind:       suggest.CorpusItem,
		ID:         c.ID,
		Name:       c.Name,
		Count:      c.Count,
		CreatedAt:  c.CreatedAt.UTC(),
		LastUsedAt: c.LastUsedAt.UTC(),
		Tags:       tags,
		TagTotal:   c.TagTotal,
		Match:      suggest.MatchSemantic,
	}
}

func cloneRow(r Row) Row {
	cp := r
	if r.Tags != nil {
		cp.Tags = make([]TagRef, len(r.Tags))
		copy(cp.Tags, r.Tags)
	}
	return cp
}
