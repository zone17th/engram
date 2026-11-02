package semantic_test

import (
	"encoding/json"
	"math/rand/v2"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/semantic"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// TestAppendZoneProperty verifies plan P05 mục 2.19, Task 12, and SPEC §6.4:
//   - Output lexical prefix is always identical to input `lexical` (never cut or reordered).
//   - No duplicate `(kind, id)` ever appears in the output (either against lexical
//     or within the appended near zone).
//   - Appended near zone length is `<= zoneQuota` and `<= limit - len(lexical)`
//     when `zoneQuota = min(quota.near, limit - len(lexical))`.
//   - Within the appended near zone, semantic tags precede semantic items (OQ-11),
//     and each group is ordered strictly by `cos DESC, last_used_at DESC, count DESC, id ASC`.
//   - Every appended row has `Match == "semantic"` and wire conversion never exposes `cos`.
func TestAppendZoneProperty(t *testing.T) {
	t0 := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	t1 := t0.Add(1 * time.Hour)
	t2 := t0.Add(2 * time.Hour)

	lexTag1 := uuid.MustParse("00000000-0011-4000-8000-000000000001")
	lexItem1 := uuid.MustParse("00000000-0001-4000-8000-000000000001")

	semTagA := uuid.MustParse("00000000-0011-4000-8000-000000000010")
	semTagB := uuid.MustParse("00000000-0011-4000-8000-000000000020")
	semItemA := uuid.MustParse("00000000-0001-4000-8000-000000000010")
	semItemB := uuid.MustParse("00000000-0001-4000-8000-000000000020")
	semItemC := uuid.MustParse("00000000-0001-4000-8000-000000000030")
	semItemD := uuid.MustParse("00000000-0001-4000-8000-000000000040")

	// 1. Deterministic ordering & tie-break verification (tags before items,
	// cos DESC -> last_used_at DESC -> count DESC -> id ASC, lexical duplicates dropped).
	lexical := []semantic.Row{
		{Kind: suggest.CorpusTag, ID: lexTag1, Display: "wifi-khách", Count: 4, LastUsedAt: t2, Match: suggest.MatchPrefix},
		{Kind: suggest.CorpusItem, ID: lexItem1, Name: "wifi", Count: 12, CreatedAt: t0, LastUsedAt: t2, Match: suggest.MatchPrefix},
	}

	semTags := []semantic.Candidate{
		// Duplicate of lexical tag -> must be dropped even though cos is 0.99.
		{Kind: suggest.CorpusTag, ID: lexTag1, Cos: 0.99, Display: "wifi-khách", Count: 4, LastUsedAt: t2},
		// Lower cos tag -> second in near tags.
		{Kind: suggest.CorpusTag, ID: semTagB, Cos: 0.75, Display: "mạng", Count: 8, LastUsedAt: t2},
		// Higher cos tag -> first in near tags.
		{Kind: suggest.CorpusTag, ID: semTagA, Cos: 0.88, Display: "gia-đình", Count: 2, LastUsedAt: t0},
	}

	semItems := []semantic.Candidate{
		// Duplicate of lexical item -> must be dropped.
		{Kind: suggest.CorpusItem, ID: lexItem1, Cos: 0.99, Name: "wifi", Count: 12, LastUsedAt: t2, CreatedAt: t0},
		// Tie on cos=0.80, tie on last_used_at=t1, tie on count=5 -> ID ASC tie-break (semItemC < semItemD).
		{Kind: suggest.CorpusItem, ID: semItemD, Cos: 0.80, Name: "router D", Count: 5, LastUsedAt: t1, CreatedAt: t0},
		{Kind: suggest.CorpusItem, ID: semItemC, Cos: 0.80, Name: "router C", Count: 5, LastUsedAt: t1, CreatedAt: t0},
		// Same cos=0.80, same last_used_at=t1, higher count=9 -> beats C and D.
		{Kind: suggest.CorpusItem, ID: semItemB, Cos: 0.80, Name: "router B", Count: 9, LastUsedAt: t1, CreatedAt: t0},
		// Same cos=0.80, newer last_used_at=t2 -> beats B, C, D.
		{Kind: suggest.CorpusItem, ID: semItemA, Cos: 0.80, Name: "router A", Count: 1, LastUsedAt: t2, CreatedAt: t0},
	}

	merged := semantic.AppendZone(lexical, semItems, semTags, 10)
	wantOrder := []suggest.KindID{
		{Kind: suggest.CorpusTag, ID: lexTag1},
		{Kind: suggest.CorpusItem, ID: lexItem1},
		// Appended near zone: tags first (semTagA, semTagB), then items (A, B, C, D).
		{Kind: suggest.CorpusTag, ID: semTagA},
		{Kind: suggest.CorpusTag, ID: semTagB},
		{Kind: suggest.CorpusItem, ID: semItemA},
		{Kind: suggest.CorpusItem, ID: semItemB},
		{Kind: suggest.CorpusItem, ID: semItemC},
		{Kind: suggest.CorpusItem, ID: semItemD},
	}
	if len(merged) != len(wantOrder) {
		t.Fatalf("len(merged) = %d, want %d", len(merged), len(wantOrder))
	}
	for i, want := range wantOrder {
		if merged[i].KindID() != want {
			t.Fatalf("merged[%d] = %+v, want %+v", i, merged[i].KindID(), want)
		}
		if i >= len(lexical) {
			if merged[i].Match != suggest.MatchSemantic {
				t.Fatalf("near row[%d].Match = %q, want %q", i, merged[i].Match, suggest.MatchSemantic)
			}
			wireRow := merged[i].ToSuggestNearRow()
			rawJSON, err := json.Marshal(wireRow)
			if err != nil {
				t.Fatalf("marshal near wire row: %v", err)
			}
			if strings.Contains(string(rawJSON), `"cos"`) || strings.Contains(string(rawJSON), `"dist"`) {
				t.Fatalf("near wire row leaked cosine/distance field: %s", string(rawJSON))
			}
		}
	}

	// 2. Randomized property check across 250 generated inputs (seeded PCG for reproducibility).
	rng := rand.New(rand.NewPCG(20261102, 12))
	poolIDs := make([]uuid.UUID, 24)
	for i := range poolIDs {
		poolIDs[i] = uuid.MustParse("00000000-0000-4000-8000-" + padHex12(i+1))
	}

	limits := []int{5, 8, 12}
	for trial := range 250 {
		limit := limits[rng.IntN(len(limits))]
		quotaNear := rng.IntN(5) // 0..4
		lexLen := rng.IntN(limit + 2)

		var lexIn []semantic.Row
		seenLex := make(map[suggest.KindID]struct{})
		for range lexLen {
			kind := suggest.CorpusItem
			if rng.IntN(2) == 0 {
				kind = suggest.CorpusTag
			}
			id := poolIDs[rng.IntN(len(poolIDs))]
			k := suggest.KindID{Kind: kind, ID: id}
			if _, ok := seenLex[k]; ok {
				continue
			}
			seenLex[k] = struct{}{}
			lexIn = append(lexIn, semantic.Row{
				Kind:       kind,
				ID:         id,
				Name:       "lex",
				Display:    "lex",
				Count:      int32(rng.IntN(20)),
				LastUsedAt: t0.Add(time.Duration(rng.IntN(10)) * time.Minute),
				Match:      suggest.MatchPrefix,
			})
		}

		nSemItems := rng.IntN(15)
		sItems := make([]semantic.Candidate, nSemItems)
		for i := range nSemItems {
			sItems[i] = semantic.Candidate{
				Kind:       suggest.CorpusItem,
				ID:         poolIDs[rng.IntN(len(poolIDs))],
				Cos:        0.60 + float64(rng.IntN(40))/100.0,
				Name:       "sem-item",
				Count:      int32(rng.IntN(10)),
				LastUsedAt: t0.Add(time.Duration(rng.IntN(5)) * time.Minute),
				CreatedAt:  t0,
			}
		}

		nSemTags := rng.IntN(15)
		sTags := make([]semantic.Candidate, nSemTags)
		for i := range nSemTags {
			sTags[i] = semantic.Candidate{
				Kind:       suggest.CorpusTag,
				ID:         poolIDs[rng.IntN(len(poolIDs))],
				Cos:        0.60 + float64(rng.IntN(40))/100.0,
				Display:    "sem-tag",
				Count:      int32(rng.IntN(10)),
				LastUsedAt: t0.Add(time.Duration(rng.IntN(5)) * time.Minute),
			}
		}

		zoneQuota := min(quotaNear, max(0, limit-len(lexIn)))
		out := semantic.AppendZone(lexIn, sItems, sTags, zoneQuota)

		// Property A: lexical prefix in `out` equals `lexIn` verbatim.
		if len(out) < len(lexIn) {
			t.Fatalf("trial %d: len(out)=%d < len(lexIn)=%d", trial, len(out), len(lexIn))
		}
		for i := range lexIn {
			if out[i].KindID() != lexIn[i].KindID() || out[i].Match != lexIn[i].Match {
				t.Fatalf("trial %d: lexical prefix mutated at index %d: got %+v, want %+v",
					trial, i, out[i], lexIn[i])
			}
		}

		// Property B: near zone length <= quotaNear and <= max(0, limit - len(lexIn)).
		nearZone := out[len(lexIn):]
		if len(nearZone) > quotaNear {
			t.Fatalf("trial %d: nearZone len=%d > quotaNear=%d", trial, len(nearZone), quotaNear)
		}
		if len(nearZone) > max(0, limit-len(lexIn)) {
			t.Fatalf("trial %d: nearZone len=%d > limit-len(lexIn)=%d", trial, len(nearZone), max(0, limit-len(lexIn)))
		}

		// Property C: no duplicate `(kind, id)` anywhere in `out`.
		seenOut := make(map[suggest.KindID]struct{}, len(out))
		for i, r := range out {
			k := r.KindID()
			if _, dup := seenOut[k]; dup {
				t.Fatalf("trial %d: duplicate (kind,id)=%+v at index %d", trial, k, i)
			}
			seenOut[k] = struct{}{}
		}

		// Property D: in nearZone, all tags appear before any item, and every row has Match=="semantic".
		sawNearItem := false
		for i, r := range nearZone {
			if r.Match != suggest.MatchSemantic {
				t.Fatalf("trial %d: nearZone[%d].Match = %q, want semantic", trial, i, r.Match)
			}
			if r.Kind == suggest.CorpusItem {
				sawNearItem = true
			} else if r.Kind == suggest.CorpusTag && sawNearItem {
				t.Fatalf("trial %d: nearZone tag at %d appeared after an item", trial, i)
			}
		}
	}
}

func padHex12(n int) string {
	const digits = "0123456789abcdef"
	var buf [12]byte
	for i := 11; i >= 0; i-- {
		buf[i] = digits[n&0xf]
		n >>= 4
	}
	return string(buf[:])
}
