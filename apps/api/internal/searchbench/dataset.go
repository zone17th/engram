package searchbench

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"math/bits"
	"math/rand/v2"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/textnorm"
)

// DefaultSeed is the canonical benchmark PRNG seed (plan mục 2.23, protocol §1).
// In W3, the runner may override the seed from the SEARCH_BENCH_SEED environment
// variable and pass it into NewGenerator; the generator itself never reads env.
const DefaultSeed uint64 = 20261102

// DefaultPartitions is the default Postgres hash partition modulus for
// item_embedding_g<N> and tag_embedding_g<N> (plan mục 2.15).
const DefaultPartitions = 16

// Vector dimensions and topic count (plan mục 2.23, protocol §1).
const (
	VectorDims = 1024
	TopicCount = 4096
)

// Benchmark cosine similarity threshold and expected query primitive cosine
// ranges (docs/benchmarks/P05-search/targets.md §2–§3, advisor-dec-255).
//
// MinCos = 0.50 is a frozen benchmark parameter for synthetic 1024-d vectors
// only; it is never used as production semantic_min_cos (plan mục 2.20, 2.24 #6).
const (
	MinCos = float32(0.50)

	// EntityTopicNoiseScale is the per-coordinate Gaussian noise scale added to
	// a unit topic vector when generating an item or tag vector (~0.014 -> cos
	// to topic ~ 0.90).
	EntityTopicNoiseScale = float32(0.014)

	// NearItemNoiseScale is the per-coordinate Gaussian noise scale added to an
	// item vector for a near-item query (~0.008 -> cos to item >= 0.85, well
	// above MinCos = 0.50).
	NearItemNoiseScale = float32(0.008)

	// NearTopicNoiseScale is the per-coordinate Gaussian noise scale added to a
	// topic vector for a near-topic query (~0.012 -> cos to topic >= 0.80).
	NearTopicNoiseScale = float32(0.012)

	// Expected cosine bounds for query primitives (targets.md §3).
	NearItemExpectedMinCos  = float32(0.80)
	NearItemExpectedMaxCos  = float32(0.999)
	NearTopicExpectedMinCos = float32(0.75)
	NearTopicExpectedMaxCos = float32(0.999)
	RandomExpectedMaxCos    = float32(0.25) // strictly below MinCos = 0.50
)

// Query mix ratios for W3 benchmark scenarios (protocol.md §1: 70% near-item,
// 20% near-topic, 10% random).
const (
	QueryMixNearItemRatio  = 0.70
	QueryMixNearTopicRatio = 0.20
	QueryMixRandomRatio    = 0.10
)

// ProfileName identifies a benchmark dataset size profile (plan mục 2.23).
type ProfileName string

const (
	ProfileSmoke ProfileName = "smoke"
	ProfileFull  ProfileName = "full"
)

// TenantTier classifies a synthetic benchmark tenant.
type TenantTier string

const (
	TierWhale  TenantTier = "whale"
	TierMedium TenantTier = "medium"
	TierSmall  TenantTier = "small"
)

// Exact profile counts per plan mục 2.23 and protocol.md §1.
const (
	FullWhaleTenants      = 2
	FullWhaleItems        = 100_000
	FullWhaleTags         = 20_000
	FullMediumTenants     = 6
	FullSmallTenants      = 200
	SmokeWhaleTenants     = 1
	SmokeWhaleItems       = 10_000
	SmokeWhaleTags        = 2_000
	SmokeSmallTenants     = 20
	SmallTenantMinItems   = 10
	SmallTenantMaxItems   = 500
	TagPerItemDivisor     = 5
	MaxTagsAttachedToItem = 4
)

// FullMediumItemCounts holds the exact item counts for the 6 medium tenants in
// the full profile (plan mục 2.23). The 6k (index 1) and 12k (index 2) medium
// tenants are colocated in the same Postgres hash partition as whale 0.
var FullMediumItemCounts = [FullMediumTenants]int{
	4_000,
	6_000,
	12_000,
	30_000,
	50_000,
	75_000,
}

// TenantSpec describes a single tenant in a benchmark dataset profile,
// exposing resolved counts and partition routing for W3 seeding and reporting.
type TenantSpec struct {
	Index              int
	UserID             uuid.UUID
	Tier               TenantTier
	ItemCount          int
	TagCount           int
	ColocatedWithWhale bool
	ColocatedWhaleIdx  int
	PartitionRemainder int
}

// ProfileSpec describes a resolved benchmark profile and its tenant layout.
type ProfileSpec struct {
	Name        ProfileName
	Seed        uint64
	Partitions  int
	Tenants     []TenantSpec
	TotalItems  int
	TotalTags   int
	WhaleCount  int
	MediumCount int
	SmallCount  int
}

// ItemRow matches the P04 item schema in apps/api/migrations/0006_content.up.sql.
// No entry bodies or real user data are ever generated (user-dec-016).
type ItemRow struct {
	ID             uuid.UUID
	UserID         uuid.UUID
	Name           string
	NameNormalized string
	Hint           *string
	TopicID        int
	TagIndices     []int
}

// TagRow matches the P04 tag schema in apps/api/migrations/0006_content.up.sql.
// Normalized is guaranteed unique per tenant.
type TagRow struct {
	ID         uuid.UUID
	UserID     uuid.UUID
	Display    string
	Normalized string
	TopicID    int
}

// ItemTagRow matches the P04 item_tag join table in
// apps/api/migrations/0006_content.up.sql.
type ItemTagRow struct {
	ItemID uuid.UUID
	TagID  uuid.UUID
}

// StreamKind identifies an independent deterministic PRNG stream derived from
// the root seed and (tenant, kind, index) coordinates.
type StreamKind uint64

const (
	StreamTenantUUID     StreamKind = 1
	StreamTenantSmallCnt StreamKind = 2
	StreamTopicVector    StreamKind = 3
	StreamItemRow        StreamKind = 4
	StreamItemVector     StreamKind = 5
	StreamTagRow         StreamKind = 6
	StreamTagVector      StreamKind = 7
	StreamQueryNearItem  StreamKind = 8
	StreamQueryNearTopic StreamKind = 9
	StreamQueryRandom    StreamKind = 10
)

// DerivePCG returns an independent math/rand/v2 PCG seeded deterministically
// from (rootSeed, tenantIndex, kind, entityIndex) using two-stream 64-bit
// SplitMix64 mixing.
//
// Mixing specification:
//   - s0 = splitMix64(rootSeed ^ (uint64(tenantIndex+1) * 0x9E3779B97F4A7C15) ^ (uint64(kind) * 0xBF58476D1CE4E5B9))
//   - s1 = splitMix64((uint64(entityIndex+1) * 0x94D049BB133111EB) ^ (rootSeed + 0xD1B54A32D192ED03) ^ (uint64(kind)<<32 | uint64(uint32(tenantIndex))))
//   - rand.NewPCG(s0, s1)
//
// Because each (tenantIndex, kind, entityIndex) triple maps to its own PCG
// state without stepping a shared cursor, rows and vectors can be generated
// lazily in any order or streamed without holding all vectors in memory.
func DerivePCG(rootSeed uint64, tenantIndex int, kind StreamKind, entityIndex int) *rand.PCG {
	t := uint64(uint32(tenantIndex)) + 1
	idx := uint64(uint32(entityIndex)) + 1
	k := uint64(kind)

	s0 := splitMix64(rootSeed ^ (t * 0x9E3779B97F4A7C15) ^ (k * 0xBF58476D1CE4E5B9))
	s1 := splitMix64((idx * 0x94D049BB133111EB) ^ (rootSeed + 0xD1B54A32D192ED03) ^ ((k << 32) | uint64(uint32(tenantIndex))))
	return rand.NewPCG(s0, s1)
}

func splitMix64(z uint64) uint64 {
	z += 0x9E3779B97F4A7C15
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

// Generator lazily produces deterministic tenants, items, tags, item_tag pairs,
// 1024-d vectors, query primitives, and canonical dataset hashes.
type Generator struct {
	seed    uint64
	profile ProfileSpec
	lexicon *Lexicon
}

// NewGenerator constructs a deterministic dataset generator for the given
// profile, seed, partition modulus, and lexicon. If partitions <= 0,
// DefaultPartitions (16) is used.
func NewGenerator(profile ProfileName, seed uint64, partitions int, lex *Lexicon) (*Generator, error) {
	if lex == nil {
		return nil, fmt.Errorf("searchbench: lexicon is required")
	}
	if err := lex.Validate(); err != nil {
		return nil, err
	}
	if partitions <= 0 {
		partitions = DefaultPartitions
	}
	spec, err := BuildProfileSpec(profile, seed, partitions)
	if err != nil {
		return nil, err
	}
	return &Generator{
		seed:    seed,
		profile: spec,
		lexicon: lex,
	}, nil
}

// Seed returns the root PRNG seed of the generator.
func (g *Generator) Seed() uint64 { return g.seed }

// Profile returns a copy of the resolved ProfileSpec.
func (g *Generator) Profile() ProfileSpec {
	out := g.profile
	out.Tenants = append([]TenantSpec(nil), g.profile.Tenants...)
	return out
}

// Lexicon returns the generator's lexicon.
func (g *Generator) Lexicon() *Lexicon { return g.lexicon }

// BuildProfileSpec resolves the exact tenant counts, UUIDs, and hash-partition
// colocation remainders for `full` or `smoke` (plan mục 2.23).
func BuildProfileSpec(name ProfileName, seed uint64, partitions int) (ProfileSpec, error) {
	if partitions <= 0 {
		partitions = DefaultPartitions
	}
	spec := ProfileSpec{
		Name:       name,
		Seed:       seed,
		Partitions: partitions,
	}

	switch name {
	case ProfileFull:
		spec.WhaleCount = FullWhaleTenants
		spec.MediumCount = FullMediumTenants
		spec.SmallCount = FullSmallTenants
		totalTenants := spec.WhaleCount + spec.MediumCount + spec.SmallCount
		spec.Tenants = make([]TenantSpec, 0, totalTenants)

		// 1. Whales (2 tenants: 100k items, 20k tags each).
		for range FullWhaleTenants {
			tIdx := len(spec.Tenants)
			pcg := DerivePCG(seed, tIdx, StreamTenantUUID, 0)
			uid := drawUUID(pcg)
			rem := PostgresUUIDPartitionRemainder(uid, partitions)
			spec.Tenants = append(spec.Tenants, TenantSpec{
				Index:              tIdx,
				UserID:             uid,
				Tier:               TierWhale,
				ItemCount:          FullWhaleItems,
				TagCount:           FullWhaleTags,
				ColocatedWithWhale: false,
				ColocatedWhaleIdx:  -1,
				PartitionRemainder: rem,
			})
			spec.TotalItems += FullWhaleItems
			spec.TotalTags += FullWhaleTags
		}

		whale0Rem := spec.Tenants[0].PartitionRemainder

		// 2. Medium tenants (6 tenants: 4k, 6k, 12k, 30k, 50k, 75k items; tag = item/5).
		// The 6k (mIdx=1) and 12k (mIdx=2) medium tenants are colocated in the same
		// hash partition as whale 0 (plan mục 2.23).
		for mIdx, itemCount := range FullMediumItemCounts {
			tIdx := len(spec.Tenants)
			tagCount := itemCount / TagPerItemDivisor
			colocate := itemCount == 6_000 || itemCount == 12_000
			pcg := DerivePCG(seed, tIdx, StreamTenantUUID, mIdx)
			var uid uuid.UUID
			if colocate {
				uid = drawColocatedUUID(pcg, partitions, whale0Rem)
			} else {
				uid = drawUUID(pcg)
			}
			rem := PostgresUUIDPartitionRemainder(uid, partitions)
			whaleIdx := -1
			if colocate {
				whaleIdx = 0
			}
			spec.Tenants = append(spec.Tenants, TenantSpec{
				Index:              tIdx,
				UserID:             uid,
				Tier:               TierMedium,
				ItemCount:          itemCount,
				TagCount:           tagCount,
				ColocatedWithWhale: colocate,
				ColocatedWhaleIdx:  whaleIdx,
				PartitionRemainder: rem,
			})
			spec.TotalItems += itemCount
			spec.TotalTags += tagCount
		}

		// 3. Small tenants (200 tenants: 10..500 items deterministic draw, tag = max(1, item/5)).
		for sIdx := range FullSmallTenants {
			tIdx := len(spec.Tenants)
			cntPCG := DerivePCG(seed, tIdx, StreamTenantSmallCnt, sIdx)
			cntRNG := rand.New(cntPCG)
			itemCount := SmallTenantMinItems + cntRNG.IntN(SmallTenantMaxItems-SmallTenantMinItems+1)
			tagCount := max(1, itemCount/TagPerItemDivisor)

			uuidPCG := DerivePCG(seed, tIdx, StreamTenantUUID, sIdx)
			uid := drawUUID(uuidPCG)
			rem := PostgresUUIDPartitionRemainder(uid, partitions)
			spec.Tenants = append(spec.Tenants, TenantSpec{
				Index:              tIdx,
				UserID:             uid,
				Tier:               TierSmall,
				ItemCount:          itemCount,
				TagCount:           tagCount,
				ColocatedWithWhale: false,
				ColocatedWhaleIdx:  -1,
				PartitionRemainder: rem,
			})
			spec.TotalItems += itemCount
			spec.TotalTags += tagCount
		}

	case ProfileSmoke:
		spec.WhaleCount = SmokeWhaleTenants
		spec.MediumCount = 0
		spec.SmallCount = SmokeSmallTenants
		totalTenants := spec.WhaleCount + spec.SmallCount
		spec.Tenants = make([]TenantSpec, 0, totalTenants)

		// 1. Primary tenant (10k items, 2k tags).
		{
			tIdx := 0
			pcg := DerivePCG(seed, tIdx, StreamTenantUUID, 0)
			uid := drawUUID(pcg)
			rem := PostgresUUIDPartitionRemainder(uid, partitions)
			spec.Tenants = append(spec.Tenants, TenantSpec{
				Index:              tIdx,
				UserID:             uid,
				Tier:               TierWhale,
				ItemCount:          SmokeWhaleItems,
				TagCount:           SmokeWhaleTags,
				ColocatedWithWhale: false,
				ColocatedWhaleIdx:  -1,
				PartitionRemainder: rem,
			})
			spec.TotalItems += SmokeWhaleItems
			spec.TotalTags += SmokeWhaleTags
		}

		// 2. Small tenants (20 tenants: 10..500 items deterministic draw, tag = max(1, item/5)).
		for sIdx := range SmokeSmallTenants {
			tIdx := len(spec.Tenants)
			cntPCG := DerivePCG(seed, tIdx, StreamTenantSmallCnt, sIdx)
			cntRNG := rand.New(cntPCG)
			itemCount := SmallTenantMinItems + cntRNG.IntN(SmallTenantMaxItems-SmallTenantMinItems+1)
			tagCount := max(1, itemCount/TagPerItemDivisor)

			uuidPCG := DerivePCG(seed, tIdx, StreamTenantUUID, sIdx)
			uid := drawUUID(uuidPCG)
			rem := PostgresUUIDPartitionRemainder(uid, partitions)
			spec.Tenants = append(spec.Tenants, TenantSpec{
				Index:              tIdx,
				UserID:             uid,
				Tier:               TierSmall,
				ItemCount:          itemCount,
				TagCount:           tagCount,
				ColocatedWithWhale: false,
				ColocatedWhaleIdx:  -1,
				PartitionRemainder: rem,
			})
			spec.TotalItems += itemCount
			spec.TotalTags += tagCount
		}

	default:
		return ProfileSpec{}, fmt.Errorf("searchbench: unknown profile %q (want %q or %q)", name, ProfileSmoke, ProfileFull)
	}

	return spec, nil
}

// drawUUID draws a deterministic RFC 4122 v4 UUID from pcg.
func drawUUID(pcg *rand.PCG) uuid.UUID {
	lo := pcg.Uint64()
	hi := pcg.Uint64()
	var u uuid.UUID
	binary.BigEndian.PutUint64(u[0:8], lo)
	binary.BigEndian.PutUint64(u[8:16], hi)
	u[6] = (u[6] & 0x0f) | 0x40 // version 4
	u[8] = (u[8] & 0x3f) | 0x80 // variant RFC 4122
	return u
}

// drawColocatedUUID repeatedly draws candidate UUIDs from pcg until
// PostgresUUIDPartitionRemainder(u, modulus) == targetRemainder.
func drawColocatedUUID(pcg *rand.PCG, modulus int, targetRemainder int) uuid.UUID {
	for {
		u := drawUUID(pcg)
		if PostgresUUIDPartitionRemainder(u, modulus) == targetRemainder {
			return u
		}
	}
}

// TagAt generates the tagIndex-th TagRow for tenantIndex deterministically
// without requiring prior tags to be generated.
//
// Tag uniqueness invariant (0006_content.up.sql: UNIQUE (user_id, normalized)):
// Every tag display string reserves rune space for a separated base-36 ordinal
// suffix (`-<ordinal>` or ` <ordinal>`) before truncating the lexicon word
// prefix to at most `textnorm.TagMaxRunes - len(suffix)` runes. Because the
// separator (`-` or ` `) cannot occur inside the alphanumeric base-36 ordinal
// and the suffix is never truncated, `TagAt(t, i)` is intrinsically unique per
// tenant after `textnorm.NormalizeTag` for any valid lexicon (even one
// consisting of repeated 50-rune words), and `TenantTags(t)[i]` equals
// `TagAt(t, i)` field for field.
func (g *Generator) TagAt(tenantIndex int, tagIndex int) TagRow {
	tSpec := g.profile.Tenants[tenantIndex]
	pcg := DerivePCG(g.seed, tenantIndex, StreamTagRow, tagIndex)
	rng := rand.New(pcg)

	id := drawUUID(pcg)
	topicID := rng.IntN(TopicCount)

	ord := strconv.FormatInt(int64(tagIndex), 36)
	w1 := g.pickWord(rng)
	var prefix, sep string
	if rng.IntN(2) == 0 {
		prefix = w1
		sep = "-"
	} else {
		w2 := g.pickWord(rng)
		prefix = w1 + " " + w2
		sep = " "
	}

	suffix := sep + ord
	maxPrefixRunes := max(1, textnorm.TagMaxRunes-utf8.RuneCountInString(suffix))
	prefix = truncateRunes(prefix, maxPrefixRunes)
	rawDisplay := prefix + suffix
	display, norm, err := textnorm.NormalizeTag(rawDisplay)
	if err != nil {
		fallback := "tag-" + ord
		display, norm, _ = textnorm.NormalizeTag(fallback)
	}

	return TagRow{
		ID:         id,
		UserID:     tSpec.UserID,
		Display:    display,
		Normalized: norm,
		TopicID:    topicID,
	}
}

// TenantTags generates all TagRows for tenantIndex by calling TagAt(tenantIndex, i)
// for each index i in [0, TagCount). Because TagAt is intrinsically unique per
// tenant by construction, TenantTags(t)[i] equals TagAt(t, i) field for field.
func (g *Generator) TenantTags(tenantIndex int) []TagRow {
	tSpec := g.profile.Tenants[tenantIndex]
	tags := make([]TagRow, tSpec.TagCount)
	for i := range tSpec.TagCount {
		tags[i] = g.TagAt(tenantIndex, i)
	}
	return tags
}

// ItemAt generates the itemIndex-th ItemRow for tenantIndex deterministically
// without requiring other items to be generated.
//
// Name composition (requirement 3 & 4):
//   - 1 to 4 words mixed from Vietnamese (with diacritics) and English word
//     lists, including long words for typo paths in W3.
//   - Normalized via real textnorm.NormalizeName (<= 200 runes).
//   - Optional Hint (present on ~50% of items), validated via real
//     textnorm.ValidateHint (<= 120 runes).
//   - Deterministic 0..MaxTagsAttachedToItem distinct tag indices in
//     [0, tenant.TagCount), sorted ascending so item_tag pairs never duplicate.
func (g *Generator) ItemAt(tenantIndex int, itemIndex int) ItemRow {
	tSpec := g.profile.Tenants[tenantIndex]
	pcg := DerivePCG(g.seed, tenantIndex, StreamItemRow, itemIndex)
	rng := rand.New(pcg)

	id := drawUUID(pcg)
	topicID := rng.IntN(TopicCount)

	wordCount := 1 + rng.IntN(4) // 1..4 words mixed
	var sb strings.Builder
	for w := range wordCount {
		if w > 0 {
			sb.WriteByte(' ')
		}
		sb.WriteString(g.pickWord(rng))
	}
	rawName := truncateRunes(sb.String(), textnorm.NameMaxRunes)
	name, nameNorm, err := textnorm.NormalizeName(rawName)
	if err != nil {
		fallback := "mục " + strconv.Itoa(itemIndex)
		name, nameNorm, _ = textnorm.NormalizeName(fallback)
	}

	var hintPtr *string
	if rng.IntN(2) == 1 {
		hintWords := 2 + rng.IntN(4)
		var hb strings.Builder
		for w := range hintWords {
			if w > 0 {
				hb.WriteByte(' ')
			}
			hb.WriteString(g.pickWord(rng))
		}
		rawHint := truncateRunes(hb.String(), textnorm.HintMaxRunes)
		if validHint, herr := textnorm.ValidateHint(rawHint); herr == nil && validHint != "" {
			hintPtr = &validHint
		}
	}

	maxAttach := min(MaxTagsAttachedToItem, tSpec.TagCount)
	var tagIndices []int
	if maxAttach > 0 {
		nTags := rng.IntN(maxAttach + 1) // 0..maxAttach
		if nTags > 0 {
			tagIndices = make([]int, 0, nTags)
			for len(tagIndices) < nTags {
				cand := rng.IntN(tSpec.TagCount)
				dup := false
				for _, existing := range tagIndices {
					if existing == cand {
						dup = true
						break
					}
				}
				if !dup {
					tagIndices = append(tagIndices, cand)
				}
			}
			// Sort ascending for canonical ordering.
			for i := 1; i < len(tagIndices); i++ {
				for j := i; j > 0 && tagIndices[j] < tagIndices[j-1]; j-- {
					tagIndices[j], tagIndices[j-1] = tagIndices[j-1], tagIndices[j]
				}
			}
		}
	}

	return ItemRow{
		ID:             id,
		UserID:         tSpec.UserID,
		Name:           name,
		NameNormalized: nameNorm,
		Hint:           hintPtr,
		TopicID:        topicID,
		TagIndices:     tagIndices,
	}
}

// ItemTagRows resolves the ItemTagRow join pairs for an ItemRow given the
// tenant's TagRow slice (or lazily via TagAt if tags is nil).
func (g *Generator) ItemTagRows(tenantIndex int, item ItemRow, tags []TagRow) []ItemTagRow {
	if len(item.TagIndices) == 0 {
		return nil
	}
	pairs := make([]ItemTagRow, len(item.TagIndices))
	for i, tagIdx := range item.TagIndices {
		var tagID uuid.UUID
		if tags != nil {
			tagID = tags[tagIdx].ID
		} else {
			tagID = g.TagAt(tenantIndex, tagIdx).ID
		}
		pairs[i] = ItemTagRow{
			ItemID: item.ID,
			TagID:  tagID,
		}
	}
	return pairs
}

func (g *Generator) pickWord(rng *rand.Rand) string {
	// Mix Vietnamese and English words 50/50.
	if rng.IntN(2) == 0 {
		return g.lexicon.Vi[rng.IntN(len(g.lexicon.Vi))]
	}
	return g.lexicon.En[rng.IntN(len(g.lexicon.En))]
}

func truncateRunes(s string, maxRunes int) string {
	if utf8.RuneCountInString(s) <= maxRunes {
		return s
	}
	count := 0
	for idx := range s {
		if count == maxRunes {
			return strings.TrimSpace(s[:idx])
		}
		count++
	}
	return s
}

// TopicVector writes the deterministic 1024-d unit vector for topicID
// (0 <= topicID < TopicCount) into dst (which must have len >= VectorDims)
// and returns dst[:VectorDims].
func (g *Generator) TopicVector(topicID int, dst []float32) []float32 {
	out := ensureVectorSlice(dst)
	pcg := DerivePCG(g.seed, 0, StreamTopicVector, topicID)
	rng := rand.New(pcg)
	fillGaussianUnit(rng, out)
	return out
}

// ItemVector writes the deterministic 1024-d unit vector for (tenantIndex,
// itemIndex) into dst:
//
//	v = normalise(topicVector(item.TopicID) + EntityTopicNoiseScale * N(0, I))
//
// Because TopicVector and the item noise PCG are derived purely from the root
// seed, ItemVector does not require holding a topic table or prior vectors in
// memory; callers with a precomputed topic table may use ItemVectorWithTopic.
func (g *Generator) ItemVector(tenantIndex int, itemIndex int, dst []float32) []float32 {
	topicID := g.itemTopicID(tenantIndex, itemIndex)
	var topicBuf [VectorDims]float32
	g.TopicVector(topicID, topicBuf[:])
	return g.ItemVectorWithTopic(tenantIndex, itemIndex, topicBuf[:], dst)
}

// ItemVectorWithTopic computes the deterministic 1024-d unit vector for
// (tenantIndex, itemIndex) given its precomputed unit topic vector.
func (g *Generator) ItemVectorWithTopic(tenantIndex int, itemIndex int, topicVec []float32, dst []float32) []float32 {
	out := ensureVectorSlice(dst)
	pcg := DerivePCG(g.seed, tenantIndex, StreamItemVector, itemIndex)
	rng := rand.New(pcg)
	perturbAndNormalize(rng, topicVec[:VectorDims], EntityTopicNoiseScale, out)
	return out
}

// TagVector writes the deterministic 1024-d unit vector for (tenantIndex,
// tagIndex) into dst:
//
//	v = normalise(topicVector(tag.TopicID) + EntityTopicNoiseScale * N(0, I))
func (g *Generator) TagVector(tenantIndex int, tagIndex int, dst []float32) []float32 {
	topicID := g.tagTopicID(tenantIndex, tagIndex)
	var topicBuf [VectorDims]float32
	g.TopicVector(topicID, topicBuf[:])
	return g.TagVectorWithTopic(tenantIndex, tagIndex, topicBuf[:], dst)
}

// TagVectorWithTopic computes the deterministic 1024-d unit vector for
// (tenantIndex, tagIndex) given its precomputed unit topic vector.
func (g *Generator) TagVectorWithTopic(tenantIndex int, tagIndex int, topicVec []float32, dst []float32) []float32 {
	out := ensureVectorSlice(dst)
	pcg := DerivePCG(g.seed, tenantIndex, StreamTagVector, tagIndex)
	rng := rand.New(pcg)
	perturbAndNormalize(rng, topicVec[:VectorDims], EntityTopicNoiseScale, out)
	return out
}

// NearItemQueryVector generates a deterministic 1024-d unit query vector near
// the target item (tenantIndex, itemIndex) for queryIndex:
//
//	q = normalise(itemVec + NearItemNoiseScale * N(0, I))
//
// Cosine similarity to itemVec is >= NearItemExpectedMinCos (0.80), well above
// MinCos = 0.50 (targets.md §3).
func (g *Generator) NearItemQueryVector(tenantIndex int, itemIndex int, queryIndex int, dst []float32) []float32 {
	var itemVec [VectorDims]float32
	g.ItemVector(tenantIndex, itemIndex, itemVec[:])
	out := ensureVectorSlice(dst)
	pcg := DerivePCG(g.seed, tenantIndex, StreamQueryNearItem, itemIndex*1024+queryIndex)
	rng := rand.New(pcg)
	perturbAndNormalize(rng, itemVec[:], NearItemNoiseScale, out)
	return out
}

// NearTopicQueryVector generates a deterministic 1024-d unit query vector near
// topicID for queryIndex:
//
//	q = normalise(topicVec + NearTopicNoiseScale * N(0, I))
//
// Cosine similarity to topicVec is >= NearTopicExpectedMinCos (0.75).
func (g *Generator) NearTopicQueryVector(topicID int, queryIndex int, dst []float32) []float32 {
	var topicVec [VectorDims]float32
	g.TopicVector(topicID, topicVec[:])
	out := ensureVectorSlice(dst)
	pcg := DerivePCG(g.seed, topicID, StreamQueryNearTopic, queryIndex)
	rng := rand.New(pcg)
	perturbAndNormalize(rng, topicVec[:], NearTopicNoiseScale, out)
	return out
}

// RandomQueryVector generates a deterministic 1024-d isotropic unit vector for
// queryIndex that is independent of all topics and items. In 1024 dimensions,
// the cosine similarity to any fixed vector has standard deviation 1/32 ~ 0.031,
// staying well below RandomExpectedMaxCos (0.25) and MinCos (0.50) so |E| = 0
// cases are reliably exercised (targets.md §2–§3).
func (g *Generator) RandomQueryVector(queryIndex int, dst []float32) []float32 {
	out := ensureVectorSlice(dst)
	pcg := DerivePCG(g.seed, 0, StreamQueryRandom, queryIndex)
	rng := rand.New(pcg)
	fillGaussianUnit(rng, out)
	return out
}

// CosineSimilarity computes the inner product of two unit-normalised vectors
// a and b of length VectorDims.
func CosineSimilarity(a, b []float32) float32 {
	var dot float64
	for i := range VectorDims {
		dot += mulRound64(float64(a[i]), float64(b[i]))
	}
	return float32(dot)
}

func (g *Generator) itemTopicID(tenantIndex int, itemIndex int) int {
	pcg := DerivePCG(g.seed, tenantIndex, StreamItemRow, itemIndex)
	rng := rand.New(pcg)
	_ = drawUUID(pcg)
	return rng.IntN(TopicCount)
}

func (g *Generator) tagTopicID(tenantIndex int, tagIndex int) int {
	pcg := DerivePCG(g.seed, tenantIndex, StreamTagRow, tagIndex)
	rng := rand.New(pcg)
	_ = drawUUID(pcg)
	return rng.IntN(TopicCount)
}

func ensureVectorSlice(dst []float32) []float32 {
	if len(dst) >= VectorDims {
		return dst[:VectorDims]
	}
	return make([]float32, VectorDims)
}

// mulRound32 multiplies two float32 values and rounds the product to IEEE-754
// binary32 via an explicit float32(...) conversion.
//
// Per the Go Language Specification ("Floating-point operators",
// https://go.dev/ref/spec#Floating_point_operators), an implementation may fuse
// multiple floating-point operations into a single fused operation (such as FMA
// on arm64) across expressions or statements, whereas an explicit floating-point
// type conversion rounds to the precision of the target type and prevents fusion
// that would discard that rounding. Wrapping every intermediate product in
// mulRound32/mulRound64 guarantees bit-for-bit identical vector bytes across
// amd64 and arm64.
func mulRound32(a, b float32) float32 {
	return float32(a * b)
}

// mulRound64 multiplies two float64 values and rounds the product to IEEE-754
// binary64 via an explicit float64(...) conversion, preventing FMA fusion when
// accumulating into a running sum (Go spec: "Floating-point operators").
func mulRound64(a, b float64) float64 {
	return float64(a * b)
}

// gaussianUniforms is the number of uniform draws summed by gaussianSample.
const gaussianUniforms = 12

// twoPowMinus53 is 2^-53, exactly representable: scaling by it never rounds.
const twoPowMinus53 = 0x1p-53

// gaussianSample returns one deterministic approximately-standard-normal draw
// (Irwin-Hall: the sum of 12 independent U[0,1) draws minus 6, mean 0, variance
// exactly 1, support [-6, 6)). It replaces rand.Rand.NormFloat64 because the
// dataset hash must be identical on amd64 and arm64 and NormFloat64 cannot give
// that: its ziggurat slow path (about 1% of draws) calls math.Exp and math.Log,
// which have separate exp_amd64.s / exp_arm64.s implementations, and it
// evaluates `fn[i]+float32(r.Float64())*(fn[i-1]-fn[i])` inside the standard
// library where arm64 may fuse a multiply-add. Neither can be guarded from here
// (R0 full run 41561911393: the arm64 smoke hash differed from the amd64
// golden). This sampler uses only
//
//   - rng.Uint64, an integer-only PCG step;
//   - integer shifts and one integer sum (12 values below 2^53, so below 2^57);
//   - one int64 -> float64 conversion (IEEE-754 round-to-nearest-even on both
//     architectures; exact below 2^53, correctly rounded above);
//   - a multiplication by the power of two 2^-53 (exact), and
//   - one subtraction of 6,
//
// with the product wrapped in mulRound64 so the compiler cannot fuse it with the
// subtraction. No math.Exp, math.Log, math.Sin or math.Cos is involved.
//
// Statistics: variance 1 holds exactly, so the isotropic-vector expectations
// (cos of two independent vectors has standard deviation 1/32; the entity
// vector is topic + scale*noise, so its expected cosine to the topic is
// 1/sqrt(1 + 1024*scale^2)) are unchanged. The tails are bounded at 6 sigma and
// the excess kurtosis is -0.1, which only makes the cosine bounds of
// TestLexiconAndVectorCosineRanges easier to meet. Cost: 12 PCG steps per
// coordinate instead of about one, i.e. roughly 25 microseconds per 1024-d
// vector (about 13 s of CPU for the ~0.5 M vectors of the full profile, which
// seeding spreads over its COPY streams).
func gaussianSample(rng *rand.Rand) float64 {
	var sum int64
	for range gaussianUniforms {
		sum += int64(rng.Uint64() >> 11)
	}
	x := mulRound64(float64(sum), twoPowMinus53)
	return float64(x - 6)
}

func fillGaussianUnit(rng *rand.Rand, dst []float32) {
	var sumSq float64
	for i := range VectorDims {
		v := float32(gaussianSample(rng))
		dst[i] = v
		fv := float64(v)
		sumSq = float64(sumSq + mulRound64(fv, fv))
	}
	normalizeInPlace(dst, sumSq)
}

func perturbAndNormalize(rng *rand.Rand, base []float32, noiseScale float32, dst []float32) {
	var sumSq float64
	for i := range VectorDims {
		noise := mulRound32(noiseScale, float32(gaussianSample(rng)))
		v := float32(base[i] + noise)
		dst[i] = v
		fv := float64(v)
		sumSq = float64(sumSq + mulRound64(fv, fv))
	}
	normalizeInPlace(dst, sumSq)
}

func normalizeInPlace(vec []float32, sumSq float64) {
	if sumSq <= 0 {
		vec[0] = 1
		for i := 1; i < len(vec); i++ {
			vec[i] = 0
		}
		return
	}
	invNorm := float32(float64(1.0 / math.Sqrt(sumSq)))
	for i := range vec {
		vec[i] = mulRound32(vec[i], invNorm)
	}
}

// ComputeHash computes a streamed SHA-256 hex digest over the canonical binary
// serialisation of every tenant, tag row + tag vector, item row + item_tag
// pairs + item vector in the profile (requirement 7).
//
// Canonical binary framing (little-endian integers and IEEE-754 float32 bits):
//   - Header: "engram-searchbench-v1\x00", uint64(seed), len-prefixed profile
//     name, uint32(partitions), uint32(len(tenants)).
//   - Per tenant (in index order 0..len(tenants)-1):
//   - byte('U'), uint32(tenant.Index), 16-byte UserID, len-prefixed Tier,
//     uint32(ItemCount), uint32(TagCount), byte(colocated), uint32(PartitionRemainder).
//   - Per tag (0..TagCount-1):
//   - byte('T'), 16-byte Tag.ID, 16-byte Tag.UserID, len-prefixed Display,
//     len-prefixed Normalized, uint32(TopicID), followed by 1024 x uint32
//     IEEE-754 little-endian float32 bits of the tag vector.
//   - Per item (0..ItemCount-1):
//   - byte('I'), 16-byte Item.ID, 16-byte Item.UserID, len-prefixed Name,
//     len-prefixed NameNormalized, byte(hasHint), optional len-prefixed Hint,
//     uint32(TopicID), uint32(len(item_tag)), each 16-byte TagID in
//     item_tag, followed by 1024 x uint32 IEEE-754 little-endian float32
//     bits of the item vector.
//
// Memory bound: topics are precomputed in a single 4096 x 1024 float32 buffer
// (16 MiB) and a single 1024-float32 scratch slice is reused across all rows,
// so no per-item or per-tag vectors are retained in memory.
func (g *Generator) ComputeHash() string {
	h := sha256.New()
	var scratch [4096]byte
	var vecBuf [VectorDims]float32

	// Precompute the 4096 shared topic vectors once so streaming all entity
	// vectors does not recompute TopicVector per row.
	topics := make([][VectorDims]float32, TopicCount)
	for t := range TopicCount {
		g.TopicVector(t, topics[t][:])
	}

	h.Write([]byte("engram-searchbench-v1\x00"))
	binary.LittleEndian.PutUint64(scratch[:8], g.seed)
	h.Write(scratch[:8])
	writeLenString(h, scratch[:], string(g.profile.Name))
	binary.LittleEndian.PutUint32(scratch[:4], uint32(g.profile.Partitions))
	binary.LittleEndian.PutUint32(scratch[4:8], uint32(len(g.profile.Tenants)))
	h.Write(scratch[:8])

	for tIdx, tSpec := range g.profile.Tenants {
		scratch[0] = 'U'
		binary.LittleEndian.PutUint32(scratch[1:5], uint32(tSpec.Index))
		copy(scratch[5:21], tSpec.UserID[:])
		h.Write(scratch[:21])
		writeLenString(h, scratch[:], string(tSpec.Tier))
		binary.LittleEndian.PutUint32(scratch[0:4], uint32(tSpec.ItemCount))
		binary.LittleEndian.PutUint32(scratch[4:8], uint32(tSpec.TagCount))
		if tSpec.ColocatedWithWhale {
			scratch[8] = 1
		} else {
			scratch[8] = 0
		}
		binary.LittleEndian.PutUint32(scratch[9:13], uint32(tSpec.PartitionRemainder))
		h.Write(scratch[:13])

		tags := g.TenantTags(tIdx)
		for tagIdx, tag := range tags {
			scratch[0] = 'T'
			copy(scratch[1:17], tag.ID[:])
			copy(scratch[17:33], tag.UserID[:])
			h.Write(scratch[:33])
			writeLenString(h, scratch[:], tag.Display)
			writeLenString(h, scratch[:], tag.Normalized)
			binary.LittleEndian.PutUint32(scratch[:4], uint32(tag.TopicID))
			h.Write(scratch[:4])

			g.TagVectorWithTopic(tIdx, tagIdx, topics[tag.TopicID][:], vecBuf[:])
			writeVectorLE(h, scratch[:], vecBuf[:])
		}

		for itemIdx := range tSpec.ItemCount {
			item := g.ItemAt(tIdx, itemIdx)
			scratch[0] = 'I'
			copy(scratch[1:17], item.ID[:])
			copy(scratch[17:33], item.UserID[:])
			h.Write(scratch[:33])
			writeLenString(h, scratch[:], item.Name)
			writeLenString(h, scratch[:], item.NameNormalized)
			if item.Hint != nil {
				scratch[0] = 1
				h.Write(scratch[:1])
				writeLenString(h, scratch[:], *item.Hint)
			} else {
				scratch[0] = 0
				h.Write(scratch[:1])
			}
			binary.LittleEndian.PutUint32(scratch[0:4], uint32(item.TopicID))
			binary.LittleEndian.PutUint32(scratch[4:8], uint32(len(item.TagIndices)))
			h.Write(scratch[:8])

			for _, tagIdx := range item.TagIndices {
				tagID := tags[tagIdx].ID
				h.Write(tagID[:])
			}

			g.ItemVectorWithTopic(tIdx, itemIdx, topics[item.TopicID][:], vecBuf[:])
			writeVectorLE(h, scratch[:], vecBuf[:])
		}
	}

	return hex.EncodeToString(h.Sum(nil))
}

func writeLenString(h interface{ Write([]byte) (int, error) }, scratch []byte, s string) {
	binary.LittleEndian.PutUint32(scratch[:4], uint32(len(s)))
	_, _ = h.Write(scratch[:4])
	_, _ = h.Write([]byte(s))
}

func writeVectorLE(h interface{ Write([]byte) (int, error) }, scratch []byte, vec []float32) {
	for i := range VectorDims {
		binary.LittleEndian.PutUint32(scratch[i*4:(i+1)*4], math.Float32bits(vec[i]))
	}
	_, _ = h.Write(scratch[:VectorDims*4])
}

// -----------------------------------------------------------------------------
// Postgres 16 UUID Hash Partition Routing Port (Requirement 6)
//
// Sources in PostgreSQL 16 (REL_16_STABLE):
//   - src/include/catalog/partition.h:
//       HASH_PARTITION_SEED = UINT64CONST(0x7A5B22367996DCFD)
//   - src/backend/utils/adt/uuid.c:
//       uuid_hash_extended(PG_FUNCTION_ARGS) -> hash_any_extended(key->data, 16, seed)
//   - src/common/hashfn.c:
//       hash_bytes_extended(const unsigned char *k, int keylen, uint64 seed)
//       (Bob Jenkins lookup3 mix() and final(), little-endian word fetches)
//   - src/include/common/hashfn.h:
//       hash_combine64(uint64 a, uint64 b):
//         a ^= b + UINT64CONST(0x49a0f4dd15e5a8e3) + (a << 54) + (a >> 7)
//   - src/backend/partitioning/partbounds.c:
//       compute_partition_hash_value / satisfies_hash_partition:
//         rowHash = hash_combine64(0, hash_any_extended(uuid, 16, HASH_PARTITION_SEED))
//         remainder = rowHash % uint64(modulus)
// -----------------------------------------------------------------------------

// PostgresHashPartitionSeed is HASH_PARTITION_SEED from
// src/include/catalog/partition.h.
const PostgresHashPartitionSeed uint64 = 0x7A5B22367996DCFD

// PostgresUUIDHashExtended ports Postgres `hashuuidextended(uuid, seed)`
// (`uuid_hash_extended` in `src/backend/utils/adt/uuid.c`, which delegates to
// `hash_any_extended(u[:], 16, seed)` / `hash_bytes_extended` in
// `src/common/hashfn.c` on little-endian architectures).
func PostgresUUIDHashExtended(u uuid.UUID, seed uint64) uint64 {
	return postgresHashBytesExtended16(u, seed)
}

// PostgresCombine64 ports `hash_combine64(a, b)` from
// `src/include/common/hashfn.h`.
func PostgresCombine64(a, b uint64) uint64 {
	return a ^ (b + 0x49a0f4dd15e5a8e3 + (a << 54) + (a >> 7))
}

// PostgresUUIDPartitionRemainder computes the hash partition remainder in
// [0, modulus) for a single `uuid` partition key, matching Postgres
// `satisfies_hash_partition(relid, modulus, remainder, user_id)` in
// `src/backend/partitioning/partbounds.c`.
func PostgresUUIDPartitionRemainder(u uuid.UUID, modulus int) int {
	if modulus <= 0 {
		modulus = DefaultPartitions
	}
	h := PostgresUUIDHashExtended(u, PostgresHashPartitionSeed)
	rowHash := PostgresCombine64(0, h)
	return int(rowHash % uint64(modulus))
}

// postgresHashBytesExtended16 is an exact port of `hash_bytes_extended(k, 16, seed)`
// from `src/common/hashfn.c` (little-endian word order, matching x86_64 and
// ARM64 Linux/Windows).
func postgresHashBytesExtended16(k [16]byte, seed uint64) uint64 {
	const keylen = 16
	var a, b, c uint32
	a = 0x9e3779b9 + keylen + 3923095
	b = a
	c = a

	if seed != 0 {
		a += uint32(seed >> 32)
		b += uint32(seed)
		a, b, c = lookup3Mix(a, b, c)
	}

	// First 12 bytes (len >= 12 loop iteration in hash_bytes_extended).
	a += binary.LittleEndian.Uint32(k[0:4])
	b += binary.LittleEndian.Uint32(k[4:8])
	c += binary.LittleEndian.Uint32(k[8:12])
	a, b, c = lookup3Mix(a, b, c)

	// Remaining 4 bytes (case 4 in hash_bytes_extended).
	a += binary.LittleEndian.Uint32(k[12:16])

	_, b, c = lookup3Final(a, b, c)
	return (uint64(b) << 32) | uint64(c)
}

func lookup3Mix(a, b, c uint32) (uint32, uint32, uint32) {
	a -= c
	a ^= bits.RotateLeft32(c, 4)
	c += b
	b -= a
	b ^= bits.RotateLeft32(a, 6)
	a += c
	c -= b
	c ^= bits.RotateLeft32(b, 8)
	b += a
	a -= c
	a ^= bits.RotateLeft32(c, 16)
	c += b
	b -= a
	b ^= bits.RotateLeft32(a, 19)
	a += c
	c -= b
	c ^= bits.RotateLeft32(b, 4)
	b += a
	return a, b, c
}

func lookup3Final(a, b, c uint32) (uint32, uint32, uint32) {
	c ^= b
	c -= bits.RotateLeft32(b, 14)
	a ^= c
	a -= bits.RotateLeft32(c, 11)
	b ^= a
	b -= bits.RotateLeft32(a, 25)
	c ^= b
	c -= bits.RotateLeft32(b, 16)
	a ^= c
	a -= bits.RotateLeft32(c, 4)
	b ^= a
	b -= bits.RotateLeft32(a, 14)
	c ^= b
	c -= bits.RotateLeft32(b, 24)
	return a, b, c
}
