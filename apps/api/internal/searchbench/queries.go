//go:build searchbench

package searchbench

import (
	"math/rand/v2"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// Deterministic benchmark query sets (plan mục 2.23, protocol §1).
//
// Query text is synthetic (derived from W1 item names). It is never logged and
// never written into the report: the report only carries counts and kinds.

// QueryKind is the vector-query primitive family (70/20/10 mix).
type QueryKind string

const (
	KindNearItem  QueryKind = "near_item"
	KindNearTopic QueryKind = "near_topic"
	KindRandom    QueryKind = "random"
)

// MixKind returns the primitive for the i-th query of a set: exactly 70 %
// near-item, 20 % near-topic, 10 % random for any multiple of ten queries.
func MixKind(i int) QueryKind {
	switch i % 10 {
	case 7, 8:
		return KindNearTopic
	case 9:
		return KindRandom
	default:
		return KindNearItem
	}
}

// TenantClass groups tenants for C2 (recall / latency per class).
type TenantClass string

const (
	ClassWhale           TenantClass = "whale"            // smoke: the single 10k tenant
	ClassMediumColocated TenantClass = "medium_colocated" // 6k/12k forced into whale 0's partition
	ClassMedium          TenantClass = "medium"
	ClassSmall           TenantClass = "small"
)

// ClassOrder is the stable report order.
var ClassOrder = []TenantClass{ClassWhale, ClassMediumColocated, ClassMedium, ClassSmall}

// ClassifyTenants maps every class to its tenant indices (ascending).
func ClassifyTenants(spec ProfileSpec) map[TenantClass][]int {
	out := map[TenantClass][]int{}
	for _, t := range spec.Tenants {
		switch {
		case t.Tier == TierWhale:
			out[ClassWhale] = append(out[ClassWhale], t.Index)
		case t.Tier == TierMedium && t.ColocatedWithWhale:
			out[ClassMediumColocated] = append(out[ClassMediumColocated], t.Index)
		case t.Tier == TierMedium:
			out[ClassMedium] = append(out[ClassMedium], t.Index)
		default:
			out[ClassSmall] = append(out[ClassSmall], t.Index)
		}
	}
	return out
}

// pickIdx is a pure-integer deterministic index draw in [0, n).
func pickIdx(seed uint64, salt uint64, tenant, i, n int) int {
	if n <= 0 {
		return 0
	}
	z := splitMix64(seed ^ (salt * 0x9E3779B97F4A7C15) ^ (uint64(uint32(tenant)+1) << 32) ^ uint64(uint32(i)+1))
	return int(z % uint64(n))
}

// VectorQuery is one C2 query: a unit vector aimed at one tenant's corpus.
type VectorQuery struct {
	Corpus    generation.Corpus
	Class     TenantClass
	TenantIdx int
	Kind      QueryKind
	Index     int
	Vec       []float32
}

// BuildVectorQueries builds n deterministic queries for (corpus, class).
// tenants are spread round-robin; `limits` (optional) caps the item/tag index
// range per tenant so truncated self-check seeds only target seeded rows.
func BuildVectorQueries(g *Generator, corpus generation.Corpus, class TenantClass, tenants []int, n int, limits map[int]int) []VectorQuery {
	spec := g.Profile()
	out := make([]VectorQuery, 0, n)
	if len(tenants) == 0 {
		return out
	}
	for i := range n {
		t := tenants[i%len(tenants)]
		var count int
		if corpus == generation.CorpusItem {
			count = spec.Tenants[t].ItemCount
		} else {
			count = spec.Tenants[t].TagCount
		}
		if l := limits[t]; l > 0 && l < count {
			count = l
		}
		kind := MixKind(i)
		vec := make([]float32, VectorDims)
		qi := i % 1024
		switch kind {
		case KindNearItem:
			idx := pickIdx(g.Seed(), 1, t, i, count)
			if corpus == generation.CorpusItem {
				g.NearItemQueryVector(t, idx, qi, vec)
			} else {
				// "near-item" for the tag corpus = near a tag of the tenant.
				var base [VectorDims]float32
				g.TagVector(t, idx, base[:])
				rng := DerivePCG(g.Seed(), t, StreamQueryNearItem, (1<<22)+idx*1024+qi)
				perturbAndNormalize(rand.New(rng), base[:], NearItemNoiseScale, vec)
			}
		case KindNearTopic:
			idx := pickIdx(g.Seed(), 2, t, i, count)
			var topic int
			if corpus == generation.CorpusItem {
				topic = g.itemTopicID(t, idx)
			} else {
				topic = g.tagTopicID(t, idx)
			}
			g.NearTopicQueryVector(topic, qi, vec)
		default:
			g.RandomQueryVector(i, vec)
		}
		out = append(out, VectorQuery{Corpus: corpus, Class: class, TenantIdx: t, Kind: kind, Index: i, Vec: vec})
	}
	return out
}

// TextQuery is one /suggest query string (lexical or hybrid).
type TextQuery struct {
	TenantIdx int
	Variant   string // prefix | folded | typo
	Text      string // raw q (never logged)
	QN        string // normalized form (stub provider key)
	Kind      QueryKind
	Vec       []float32 // hybrid only: the dataset query vector the stub returns
}

var foldTransformer = transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)

// foldDiacritics strips combining marks and maps đ/Đ (the folded query form a
// user without a Vietnamese keyboard would type).
func foldDiacritics(s string) string {
	out, _, err := transform.String(foldTransformer, s)
	if err != nil {
		out = s
	}
	return strings.NewReplacer("đ", "d", "Đ", "D").Replace(out)
}

func runePrefix(s string, k int) string {
	if utf8.RuneCountInString(s) <= k {
		return s
	}
	n := 0
	for i := range s {
		if n == k {
			return s[:i]
		}
		n++
	}
	return s
}

// typoOf swaps two adjacent runes (>= 5 runes) or drops the second rune.
func typoOf(w string) string {
	r := []rune(w)
	if len(r) >= 5 {
		r[1], r[2] = r[2], r[1]
		return string(r)
	}
	if len(r) >= 3 {
		return string(append([]rune{r[0]}, r[2:]...))
	}
	return w
}

// lexicalText derives the query string of one variant from a normalized item name.
func lexicalText(variant string, name string, i int, seed uint64, tenant int) string {
	words := strings.Fields(name)
	if len(words) == 0 {
		return name
	}
	w := words[pickIdx(seed, 5, tenant, i, len(words))]
	switch variant {
	case "folded":
		f := foldDiacritics(w)
		if utf8.RuneCountInString(f) < 3 {
			f = foldDiacritics(name)
		}
		return runePrefix(f, 6+pickIdx(seed, 6, tenant, i, 4))
	case "typo":
		if utf8.RuneCountInString(w) < 4 {
			w = name
		}
		return typoOf(runePrefix(w, 8))
	default: // prefix of the whole normalized name
		k := 3 + pickIdx(seed, 7, tenant, i, 4)
		return runePrefix(name, k)
	}
}

var textVariants = []string{"prefix", "prefix", "folded", "typo", "prefix", "folded"}

// BuildLexicalQueries builds n deterministic lexical query strings (prefix /
// folded / typo variants) from item names of `tenants` (round-robin). Query
// strings are >= 2 runes after normalization so /suggest enters full mode.
func BuildLexicalQueries(g *Generator, tenants []int, n int, itemLimit map[int]int) []TextQuery {
	spec := g.Profile()
	out := make([]TextQuery, 0, n)
	if len(tenants) == 0 {
		return out
	}
	for i := range n {
		t := tenants[i%len(tenants)]
		count := spec.Tenants[t].ItemCount
		if l := itemLimit[t]; l > 0 && l < count {
			count = l
		}
		it := g.ItemAt(t, pickIdx(g.Seed(), 3, t, i, count))
		variant := textVariants[i%len(textVariants)]
		text := lexicalText(variant, it.NameNormalized, i, g.Seed(), t)
		if utf8.RuneCountInString(text) < 3 {
			text = it.NameNormalized
		}
		out = append(out, TextQuery{TenantIdx: t, Variant: variant, Text: text, QN: qnOf(text)})
	}
	return out
}

func qnOf(text string) string {
	p, err := suggest.ParseSuggestQuery(text, suggest.ScopeAll)
	if err != nil {
		return ""
	}
	return p.QN
}

// BuildHybridQueries builds n hybrid queries for one tenant with their dataset
// query vectors. When unique is true every query text carries a unique ordinal
// suffix (cache MISS scenario: no query repeats, so every request embeds);
// ordinals start at `ordinalBase`. When unique is false the query strings are
// de-duplicated by normalized form (cache HIT scenario). Queries whose
// normalized form is shorter than 3 runes are lengthened so the semantic branch
// is never skipped as short_query.
func BuildHybridQueries(g *Generator, tenant int, n int, unique bool, ordinalBase int, itemLimit int) []TextQuery {
	spec := g.Profile()
	count := spec.Tenants[tenant].ItemCount
	if itemLimit > 0 && itemLimit < count {
		count = itemLimit
	}
	out := make([]TextQuery, 0, n)
	seen := map[string]struct{}{}
	for i := 0; len(out) < n && i < n*20; i++ {
		ordinal := ordinalBase + i
		itemIdx := pickIdx(g.Seed(), 4, tenant, ordinal, count)
		it := g.ItemAt(tenant, itemIdx)
		variant := textVariants[ordinal%len(textVariants)]
		text := lexicalText(variant, it.NameNormalized, ordinal, g.Seed(), tenant)
		if unique {
			text = text + " z" + strconv.FormatInt(int64(ordinal), 36)
		}
		qn := qnOf(text)
		if utf8.RuneCountInString(qn) < 3 {
			text = it.NameNormalized + " " + strconv.FormatInt(int64(ordinal), 36)
			qn = qnOf(text)
		}
		if qn == "" || utf8.RuneCountInString(qn) < 3 {
			continue
		}
		if _, dup := seen[qn]; dup {
			continue
		}
		seen[qn] = struct{}{}
		kind := MixKind(len(out))
		vec := make([]float32, VectorDims)
		qi := ordinal % 1024
		switch kind {
		case KindNearItem:
			g.NearItemQueryVector(tenant, itemIdx, qi, vec)
		case KindNearTopic:
			g.NearTopicQueryVector(g.itemTopicID(tenant, itemIdx), qi, vec)
		default:
			g.RandomQueryVector(ordinal, vec)
		}
		out = append(out, TextQuery{TenantIdx: tenant, Variant: variant, Text: text, QN: qn, Kind: kind, Vec: vec})
	}
	return out
}
