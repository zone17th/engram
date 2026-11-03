package searchbench

import (
	"context"
	"math"
	"math/rand/v2"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/textnorm"
)

// PinnedSmokeDatasetHash is the canonical SHA-256 hex digest of the smoke
// profile dataset with DefaultSeed (20261102) and DefaultPartitions (16).
// If the generator or bench-lexicon.json changes, TestDatasetDeterministic
// fails and prints the newly computed hash so it can be pinned from CI.
const PinnedSmokeDatasetHash = "dbd476280948338ac693ad5d1001ece7dfdad08e86bab42a2dcc908fb6c2d31f"

func TestDatasetDeterministic(t *testing.T) {
	lex, err := LoadDefaultLexicon()
	if err != nil {
		t.Fatalf("LoadDefaultLexicon: %v", err)
	}

	gen1, err := NewGenerator(ProfileSmoke, DefaultSeed, DefaultPartitions, lex)
	if err != nil {
		t.Fatalf("NewGenerator(gen1): %v", err)
	}
	gen2, err := NewGenerator(ProfileSmoke, DefaultSeed, DefaultPartitions, lex)
	if err != nil {
		t.Fatalf("NewGenerator(gen2): %v", err)
	}

	// Verify order-independent lazy generation on gen2 before computing the full
	// streamed hash: sample entities in reverse order and compare against gen1
	// forward order.
	prof := gen1.Profile()
	if len(prof.Tenants) != SmokeWhaleTenants+SmokeSmallTenants {
		t.Fatalf("unexpected smoke tenant count %d", len(prof.Tenants))
	}

	var vForward, vReverse [VectorDims]float32
	for tIdx := len(prof.Tenants) - 1; tIdx >= 0; tIdx-- {
		tSpec := prof.Tenants[tIdx]
		lastItem := tSpec.ItemCount - 1
		lastTag := tSpec.TagCount - 1

		rowRev := gen2.ItemAt(tIdx, lastItem)
		rowFwd := gen1.ItemAt(tIdx, lastItem)
		if rowRev.ID != rowFwd.ID || rowRev.Name != rowFwd.Name || rowRev.NameNormalized != rowFwd.NameNormalized || rowRev.TopicID != rowFwd.TopicID {
			t.Fatalf("tenant %d item %d mismatch between reverse and forward lazy calls: %+v vs %+v", tIdx, lastItem, rowRev, rowFwd)
		}

		gen2.ItemVector(tIdx, lastItem, vReverse[:])
		gen1.ItemVector(tIdx, lastItem, vForward[:])
		for d := range VectorDims {
			if math.Float32bits(vReverse[d]) != math.Float32bits(vForward[d]) {
				t.Fatalf("tenant %d item %d vector bit mismatch at dim %d", tIdx, lastItem, d)
			}
		}

		tagRev := gen2.TagAt(tIdx, lastTag)
		tagFwd := gen1.TagAt(tIdx, lastTag)
		if tagRev.ID != tagFwd.ID || tagRev.Display != tagFwd.Display || tagRev.Normalized != tagFwd.Normalized {
			t.Fatalf("tenant %d tag %d mismatch between reverse and forward lazy calls", tIdx, lastTag)
		}

		gen2.TagVector(tIdx, lastTag, vReverse[:])
		gen1.TagVector(tIdx, lastTag, vForward[:])
		for d := range VectorDims {
			if math.Float32bits(vReverse[d]) != math.Float32bits(vForward[d]) {
				t.Fatalf("tenant %d tag %d vector bit mismatch at dim %d", tIdx, lastTag, d)
			}
		}
	}

	hash1 := gen1.ComputeHash()
	hash2 := gen2.ComputeHash()
	if hash1 != hash2 {
		t.Fatalf("ComputeHash is not deterministic across runs: %s != %s", hash1, hash2)
	}

	// Different seed must produce a distinct hash.
	genDiff, err := NewGenerator(ProfileSmoke, DefaultSeed+1, DefaultPartitions, lex)
	if err != nil {
		t.Fatalf("NewGenerator(genDiff): %v", err)
	}
	hashDiff := genDiff.ComputeHash()
	if hashDiff == hash1 {
		t.Fatalf("different seed %d produced identical hash %s", DefaultSeed+1, hash1)
	}

	if hash1 != PinnedSmokeDatasetHash {
		t.Fatalf("smoke dataset hash mismatch: computed %s, want pinned %s\nSMOKE_DATASET_HASH=%s", hash1, PinnedSmokeDatasetHash, hash1)
	}
}

func TestProfileCountsAndConstraints(t *testing.T) {
	lex, err := LoadDefaultLexicon()
	if err != nil {
		t.Fatalf("LoadDefaultLexicon: %v", err)
	}

	t.Run("smoke", func(t *testing.T) {
		gen, err := NewGenerator(ProfileSmoke, DefaultSeed, DefaultPartitions, lex)
		if err != nil {
			t.Fatalf("NewGenerator(smoke): %v", err)
		}
		p := gen.Profile()
		if p.WhaleCount != 1 || p.MediumCount != 0 || p.SmallCount != 20 {
			t.Fatalf("unexpected smoke tier counts: whale=%d medium=%d small=%d", p.WhaleCount, p.MediumCount, p.SmallCount)
		}
		if len(p.Tenants) != 21 {
			t.Fatalf("want 21 smoke tenants, got %d", len(p.Tenants))
		}
		if p.Tenants[0].Tier != TierWhale || p.Tenants[0].ItemCount != 10_000 || p.Tenants[0].TagCount != 2_000 {
			t.Fatalf("unexpected smoke whale spec: %+v", p.Tenants[0])
		}

		for i := 1; i < len(p.Tenants); i++ {
			ts := p.Tenants[i]
			if ts.Tier != TierSmall {
				t.Fatalf("tenant %d tier = %s, want small", i, ts.Tier)
			}
			if ts.ItemCount < SmallTenantMinItems || ts.ItemCount > SmallTenantMaxItems {
				t.Fatalf("tenant %d item count %d out of [10, 500]", i, ts.ItemCount)
			}
			wantTags := max(1, ts.ItemCount/TagPerItemDivisor)
			if ts.TagCount != wantTags {
				t.Fatalf("tenant %d tag count %d != %d", i, ts.TagCount, wantTags)
			}
		}

		// Verify all smoke tags are unique per tenant and valid via textnorm,
		// and sample items + item_tag pairs for schema compliance.
		for tIdx, ts := range p.Tenants {
			tags := gen.TenantTags(tIdx)
			if len(tags) != ts.TagCount {
				t.Fatalf("tenant %d tag slice len %d != %d", tIdx, len(tags), ts.TagCount)
			}
			seenNorm := make(map[string]struct{}, len(tags))
			for tagIdx, tr := range tags {
				if tr.UserID != ts.UserID {
					t.Fatalf("tenant %d tag %d user_id mismatch", tIdx, tagIdx)
				}
				disp, norm, nerr := textnorm.NormalizeTag(tr.Display)
				if nerr != nil || disp != tr.Display || norm != tr.Normalized {
					t.Fatalf("tenant %d tag %d failed NormalizeTag(%q): disp=%q norm=%q err=%v", tIdx, tagIdx, tr.Display, disp, norm, nerr)
				}
				if _, dup := seenNorm[tr.Normalized]; dup {
					t.Fatalf("tenant %d duplicate normalized tag %q at index %d", tIdx, tr.Normalized, tagIdx)
				}
				seenNorm[tr.Normalized] = struct{}{}
				if lazyTag := gen.TagAt(tIdx, tagIdx); lazyTag != tr {
					t.Fatalf("tenant %d tag %d lazy TagAt %+v != TenantTags %+v", tIdx, tagIdx, lazyTag, tr)
				}
			}
			sampleItems := min(ts.ItemCount, 200)
			for itemIdx := range sampleItems {
				ir := gen.ItemAt(tIdx, itemIdx)
				if ir.UserID != ts.UserID {
					t.Fatalf("tenant %d item %d user_id mismatch", tIdx, itemIdx)
				}
				nameDisp, nameNorm, nerr := textnorm.NormalizeName(ir.Name)
				if nerr != nil || nameDisp != ir.Name || nameNorm != ir.NameNormalized {
					t.Fatalf("tenant %d item %d failed NormalizeName(%q): err=%v", tIdx, itemIdx, ir.Name, nerr)
				}
				if utf8.RuneCountInString(ir.Name) > textnorm.NameMaxRunes {
					t.Fatalf("tenant %d item %d name exceeds 200 runes", tIdx, itemIdx)
				}
				if ir.Hint != nil {
					h, herr := textnorm.ValidateHint(*ir.Hint)
					if herr != nil || h != *ir.Hint || utf8.RuneCountInString(h) > textnorm.HintMaxRunes {
						t.Fatalf("tenant %d item %d invalid hint %q: err=%v", tIdx, itemIdx, *ir.Hint, herr)
					}
				}
				pairs := gen.ItemTagRows(tIdx, ir, tags)
				seenTagID := make(map[uuid.UUID]struct{}, len(pairs))
				for _, pair := range pairs {
					if pair.ItemID != ir.ID {
						t.Fatalf("item_tag item_id mismatch")
					}
					if _, dup := seenTagID[pair.TagID]; dup {
						t.Fatalf("duplicate item_tag pair (%s, %s)", pair.ItemID, pair.TagID)
					}
					seenTagID[pair.TagID] = struct{}{}
				}
			}
		}
	})

	t.Run("full_structure_and_colocation", func(t *testing.T) {
		// Structure, counts, colocation, and tag collision helper only (no vector
		// generation for full in unit tests per advisor-dec-261 / requirement 8).
		gen, err := NewGenerator(ProfileFull, DefaultSeed, DefaultPartitions, lex)
		if err != nil {
			t.Fatalf("NewGenerator(full): %v", err)
		}
		p := gen.Profile()
		if p.WhaleCount != 2 || p.MediumCount != 6 || p.SmallCount != 200 {
			t.Fatalf("unexpected full tier counts: whale=%d medium=%d small=%d", p.WhaleCount, p.MediumCount, p.SmallCount)
		}
		if len(p.Tenants) != 208 {
			t.Fatalf("want 208 full tenants, got %d", len(p.Tenants))
		}

		// Whales: 2 x (100k items, 20k tags).
		for i := range 2 {
			w := p.Tenants[i]
			if w.Tier != TierWhale || w.ItemCount != 100_000 || w.TagCount != 20_000 {
				t.Fatalf("whale %d spec mismatch: %+v", i, w)
			}
			if w.PartitionRemainder != PostgresUUIDPartitionRemainder(w.UserID, DefaultPartitions) {
				t.Fatalf("whale %d remainder mismatch", i)
			}
		}

		whale0Rem := p.Tenants[0].PartitionRemainder
		wantMedium := []int{4_000, 6_000, 12_000, 30_000, 50_000, 75_000}
		for mIdx, wantItems := range wantMedium {
			m := p.Tenants[2+mIdx]
			if m.Tier != TierMedium || m.ItemCount != wantItems || m.TagCount != wantItems/5 {
				t.Fatalf("medium tenant %d spec mismatch: %+v", mIdx, m)
			}
			gotRem := PostgresUUIDPartitionRemainder(m.UserID, DefaultPartitions)
			if m.PartitionRemainder != gotRem {
				t.Fatalf("medium tenant %d cached remainder %d != computed %d", mIdx, m.PartitionRemainder, gotRem)
			}
			if wantItems == 6_000 || wantItems == 12_000 {
				if !m.ColocatedWithWhale || m.ColocatedWhaleIdx != 0 {
					t.Fatalf("medium tenant %d (%d items) must be marked colocated with whale 0", mIdx, wantItems)
				}
				if gotRem != whale0Rem {
					t.Fatalf("colocated medium tenant %d (%d items) remainder %d != whale0 remainder %d", mIdx, wantItems, gotRem, whale0Rem)
				}
			} else if m.ColocatedWithWhale {
				t.Fatalf("medium tenant %d (%d items) should not be marked colocated", mIdx, wantItems)
			}
		}

		for sIdx := range 200 {
			s := p.Tenants[8+sIdx]
			if s.Tier != TierSmall {
				t.Fatalf("small tenant %d tier = %s", sIdx, s.Tier)
			}
			if s.ItemCount < 10 || s.ItemCount > 500 {
				t.Fatalf("small tenant %d item count %d out of [10, 500]", sIdx, s.ItemCount)
			}
			if s.TagCount != max(1, s.ItemCount/5) {
				t.Fatalf("small tenant %d tag count %d != %d", sIdx, s.TagCount, max(1, s.ItemCount/5))
			}
		}

		// Verify whale 0 tags (20k) are all unique per tenant and match TagAt field for field.
		whaleTags := gen.TenantTags(0)
		if len(whaleTags) != 20_000 {
			t.Fatalf("whale 0 tags len %d != 20000", len(whaleTags))
		}
		seenWhaleTags := make(map[string]struct{}, len(whaleTags))
		for i, tr := range whaleTags {
			if _, exists := seenWhaleTags[tr.Normalized]; exists {
				t.Fatalf("whale 0 duplicate normalized tag %q at %d", tr.Normalized, i)
			}
			seenWhaleTags[tr.Normalized] = struct{}{}
			if lazyTag := gen.TagAt(0, i); lazyTag != tr {
				t.Fatalf("whale 0 tag %d lazy TagAt %+v != TenantTags %+v", i, lazyTag, tr)
			}
		}
	})

	t.Run("long_50_rune_repeated_lexicon_tag_uniqueness_and_lazy_parity", func(t *testing.T) {
		// Regression for SB-1-2: a synthetic lexicon of repeated 50-rune accented
		// words in Vi and repeated 50-rune ASCII words in En must pass
		// Lexicon.Validate, and for a tenant with >= 2,000 tags every normalized
		// tag must be unique and TagAt(t, i) == TenantTags(t)[i] for all i.
		viWord50 := strings.Repeat("ă", textnorm.TagMaxRunes)
		enWord50 := strings.Repeat("a", textnorm.TagMaxRunes)
		if utf8.RuneCountInString(viWord50) != 50 || utf8.RuneCountInString(enWord50) != 50 {
			t.Fatalf("expected 50-rune synthetic lexicon words")
		}
		syntheticLex := &Lexicon{
			Version: LexiconVersion,
			Schema:  LexiconSchema,
			Vi:      make([]string, 100),
			En:      make([]string, 100),
		}
		for i := range 100 {
			syntheticLex.Vi[i] = viWord50
			syntheticLex.En[i] = enWord50
		}
		if err := syntheticLex.Validate(); err != nil {
			t.Fatalf("synthetic 50-rune lexicon failed Validate: %v", err)
		}

		gen, err := NewGenerator(ProfileSmoke, DefaultSeed, DefaultPartitions, syntheticLex)
		if err != nil {
			t.Fatalf("NewGenerator(synthetic 50-rune lexicon): %v", err)
		}
		if gen.Profile().Tenants[0].TagCount < 2_000 {
			t.Fatalf("expected tenant 0 to have >= 2000 tags, got %d", gen.Profile().Tenants[0].TagCount)
		}

		bulkTags := gen.TenantTags(0)
		seenNorm := make(map[string]struct{}, len(bulkTags))
		for i, bulk := range bulkTags {
			lazy := gen.TagAt(0, i)
			if lazy != bulk {
				t.Fatalf("tag %d lazy TagAt %+v != TenantTags %+v", i, lazy, bulk)
			}
			disp, norm, nerr := textnorm.NormalizeTag(lazy.Display)
			if nerr != nil || disp != lazy.Display || norm != lazy.Normalized {
				t.Fatalf("tag %d failed NormalizeTag(%q): disp=%q norm=%q err=%v", i, lazy.Display, disp, norm, nerr)
			}
			if _, exists := seenNorm[lazy.Normalized]; exists {
				t.Fatalf("duplicate normalized tag %q at index %d with 50-rune lexicon", lazy.Normalized, i)
			}
			seenNorm[lazy.Normalized] = struct{}{}
		}
	})
}

func TestLexiconAndVectorCosineRanges(t *testing.T) {
	lex, err := LoadDefaultLexicon()
	if err != nil {
		t.Fatalf("LoadDefaultLexicon: %v", err)
	}
	raw, err := ReadLexicon(strings.NewReader(`{"version":1,"schema":"engram-search-bench-lexicon-v1","vi":` + mustJSON(t, lex.Vi) + `,"en":` + mustJSON(t, lex.En) + `}`))
	if err != nil || len(raw.Vi) != len(lex.Vi) || len(raw.En) != len(lex.En) {
		t.Fatalf("ReadLexicon roundtrip failed: %v", err)
	}

	gen, err := NewGenerator(ProfileSmoke, DefaultSeed, DefaultPartitions, lex)
	if err != nil {
		t.Fatalf("NewGenerator: %v", err)
	}

	var itemVec, tagVec, topicVec, qVec [VectorDims]float32

	// Check unit normalisation and cosine bounds across 50 deterministic samples.
	for i := range 50 {
		gen.ItemVector(0, i, itemVec[:])
		assertUnitVector(t, itemVec[:])

		gen.TagVector(0, i, tagVec[:])
		assertUnitVector(t, tagVec[:])

		// Near-item query must have cosine >= NearItemExpectedMinCos (0.80 > MinCos 0.50).
		gen.NearItemQueryVector(0, i, i, qVec[:])
		assertUnitVector(t, qVec[:])
		cosItem := CosineSimilarity(itemVec[:], qVec[:])
		if cosItem < NearItemExpectedMinCos || cosItem > NearItemExpectedMaxCos {
			t.Fatalf("sample %d near-item cos = %.4f, want in [%.3f, %.3f] (well above MinCos=%.2f)",
				i, cosItem, NearItemExpectedMinCos, NearItemExpectedMaxCos, MinCos)
		}

		// Near-topic query must have cosine >= NearTopicExpectedMinCos (0.75 > MinCos 0.50).
		topicID := i % TopicCount
		gen.TopicVector(topicID, topicVec[:])
		assertUnitVector(t, topicVec[:])
		gen.NearTopicQueryVector(topicID, i, qVec[:])
		assertUnitVector(t, qVec[:])
		cosTopic := CosineSimilarity(topicVec[:], qVec[:])
		if cosTopic < NearTopicExpectedMinCos || cosTopic > NearTopicExpectedMaxCos {
			t.Fatalf("sample %d near-topic cos = %.4f, want in [%.3f, %.3f]",
				i, cosTopic, NearTopicExpectedMinCos, NearTopicExpectedMaxCos)
		}

		// Random query must have cosine < RandomExpectedMaxCos (< MinCos = 0.50).
		gen.RandomQueryVector(i, qVec[:])
		assertUnitVector(t, qVec[:])
		cosRandItem := float32(math.Abs(float64(CosineSimilarity(itemVec[:], qVec[:]))))
		if cosRandItem >= MinCos || cosRandItem > RandomExpectedMaxCos {
			t.Fatalf("sample %d random query |cos| = %.4f >= RandomExpectedMaxCos %.2f (MinCos %.2f)",
				i, cosRandItem, RandomExpectedMaxCos, MinCos)
		}
	}
}

func TestPartitionHashMatchesPostgres(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	conn := dbtest.Connect(t, dsn)
	ctx := context.Background()

	_, err := conn.Exec(ctx, `CREATE TABLE bench_hash_probe (user_id uuid) PARTITION BY HASH (user_id)`)
	if err != nil {
		t.Fatalf("CREATE TABLE bench_hash_probe: %v", err)
	}

	fullSpec, err := BuildProfileSpec(ProfileFull, DefaultSeed, DefaultPartitions)
	if err != nil {
		t.Fatalf("BuildProfileSpec(full): %v", err)
	}
	if len(fullSpec.Tenants) < 208 {
		t.Fatalf("expected >= 208 tenants in full profile, got %d", len(fullSpec.Tenants))
	}

	// Verify whale 0 and its colocated 6k and 12k medium tenants share the exact
	// same remainder before probing Postgres.
	whale0 := fullSpec.Tenants[0]
	med6k := fullSpec.Tenants[3]  // 4k is index 2, 6k is index 3
	med12k := fullSpec.Tenants[4] // 12k is index 4
	if med6k.ItemCount != 6_000 || med12k.ItemCount != 12_000 {
		t.Fatalf("unexpected medium tenant indices: med6k=%d med12k=%d", med6k.ItemCount, med12k.ItemCount)
	}
	if whale0.PartitionRemainder != med6k.PartitionRemainder || whale0.PartitionRemainder != med12k.PartitionRemainder {
		t.Fatalf("colocation remainder mismatch: whale0=%d med6k=%d med12k=%d",
			whale0.PartitionRemainder, med6k.PartitionRemainder, med12k.PartitionRemainder)
	}

	// Check satisfies_hash_partition('bench_hash_probe'::regclass, 16, r, $1::uuid)
	// is true for Go remainder r and false for (r+1)%16 across all 208 deterministic
	// full-profile tenant UUIDs (including the whale and colocated medium tenants).
	for i, tenant := range fullSpec.Tenants {
		r := PostgresUUIDPartitionRemainder(tenant.UserID, DefaultPartitions)
		if r != tenant.PartitionRemainder {
			t.Fatalf("tenant %d remainder mismatch: %d != %d", i, r, tenant.PartitionRemainder)
		}
		wrongR := (r + 1) % DefaultPartitions

		var matchRight, matchWrong bool
		err := conn.QueryRow(ctx,
			`SELECT satisfies_hash_partition('bench_hash_probe'::regclass, $1, $2, $3::uuid),
			        satisfies_hash_partition('bench_hash_probe'::regclass, $1, $4, $3::uuid)`,
			DefaultPartitions, r, tenant.UserID, wrongR,
		).Scan(&matchRight, &matchWrong)
		if err != nil {
			t.Fatalf("tenant %d (%s) satisfies_hash_partition query failed: %v", i, tenant.UserID, err)
		}
		if !matchRight {
			t.Fatalf("tenant %d (%s): Postgres satisfies_hash_partition returned false for Go remainder %d", i, tenant.UserID, r)
		}
		if matchWrong {
			t.Fatalf("tenant %d (%s): Postgres satisfies_hash_partition returned true for wrong remainder %d", i, tenant.UserID, wrongR)
		}
	}
}

func assertUnitVector(t *testing.T, v []float32) {
	t.Helper()
	if len(v) != VectorDims {
		t.Fatalf("vector length %d != %d", len(v), VectorDims)
	}
	norm := CosineSimilarity(v, v)
	if math.Abs(float64(norm-1.0)) > 1e-4 {
		t.Fatalf("vector norm^2 = %.6f, want 1.0", norm)
	}
}

func mustJSON(t *testing.T, words []string) string {
	t.Helper()
	var sb strings.Builder
	sb.WriteByte('[')
	for i, w := range words {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteByte('"')
		sb.WriteString(w)
		sb.WriteByte('"')
	}
	sb.WriteByte(']')
	return sb.String()
}

// TestGaussianSampleMoments: the arch-independent Gaussian sampler that feeds the
// dataset hash (gaussianSample, R0 41561911393) is unit-variance, zero-mean,
// bounded at 6 sigma and deterministic for a fixed PCG stream.
func TestGaussianSampleMoments(t *testing.T) {
	const n = 200_000
	draw := func() []float64 {
		rng := rand.New(rand.NewPCG(20261102, 42))
		out := make([]float64, n)
		for i := range out {
			out[i] = gaussianSample(rng)
		}
		return out
	}
	a, b := draw(), draw()
	var sum, sumSq float64
	for i, x := range a {
		if x != b[i] {
			t.Fatalf("sample %d differs between identical streams: %v != %v", i, x, b[i])
		}
		if x < -6 || x >= 6 {
			t.Fatalf("sample %d = %v outside [-6, 6)", i, x)
		}
		sum += x
		sumSq += x * x
	}
	mean := sum / n
	variance := sumSq/n - mean*mean
	if math.Abs(mean) > 0.02 {
		t.Errorf("mean = %.4f, want |mean| <= 0.02", mean)
	}
	if variance < 0.97 || variance > 1.03 {
		t.Errorf("variance = %.4f, want within [0.97, 1.03]", variance)
	}
}
