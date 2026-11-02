//go:build searchbench

package searchbench

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// Entry points (contract with ci.yml, worker B):
//
//	go test -tags searchbench -run 'TestRecallDefinitionEdgeCases|TestHarnessCatchesSlowLexical|TestHarnessCatchesLowRecall|TestSearchBench' ./internal/searchbench/
//
// Tests that need Postgres read SEARCH_BENCH_DATABASE_URL (a superuser URL DSN)
// and create their own fresh database; with the variable empty they skip, except
// TestSearchBench, which fails when SEARCH_BENCH_REQUIRE=1.

// ---- helpers ---------------------------------------------------------------

func ids(n int) []uuid.UUID {
	out := make([]uuid.UUID, n)
	for i := range out {
		out[i] = uuid.New()
	}
	return out
}

func scored(idList []uuid.UUID, cos func(i int) float64) []ScoredID {
	out := make([]ScoredID, len(idList))
	for i, id := range idList {
		out[i] = ScoredID{ID: id, Cos: cos(i)}
	}
	return out
}

func annOutcome(e, got []uuid.UUID, path string, underfillBefore, fallback bool, capped int) QueryOutcome {
	return QueryOutcome{
		Corpus: "item", Class: "whale", Kind: KindNearItem, ESize: len(e), Rows: len(got),
		Hits: ScoreQuery(e, got), Path: path, UnderfillBefore: underfillBefore, FallbackUsed: fallback,
		CappedCount: capped, Latency: time.Millisecond,
	}
}

func dbEnvT(t *testing.T) Env {
	t.Helper()
	env, err := LoadEnv()
	if err != nil {
		t.Fatal(err)
	}
	if env.DatabaseURL == "" {
		t.Skip("SEARCH_BENCH_DATABASE_URL is empty: database tests are skipped")
	}
	return env
}

// freshSeed creates a fresh migrated database and seeds a (truncated) smoke subset.
func freshSeed(t *testing.T, env Env, opts SeedOptions) (string, *SeedResult) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	dsn, drop, err := CreateFreshDatabase(ctx, env.DatabaseURL)
	if err != nil {
		t.Fatalf("fresh database: %v", err)
	}
	t.Cleanup(drop)
	opts.Profile, opts.Seed = ProfileSmoke, DefaultSeed
	if opts.Logf == nil {
		opts.Logf = t.Logf
	}
	sr, err := SeedDatabase(ctx, dsn, opts)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	return dsn, sr
}

// ---- pure tests ------------------------------------------------------------

// TestRecallDefinitionEdgeCases pins the frozen recall/underfill definitions of
// targets.md section 2 on hand-built outcomes (no database).
func TestRecallDefinitionEdgeCases(t *testing.T) {
	const minCos = 0.50

	t.Run("fewer_than_20_eligible", func(t *testing.T) {
		all := ids(7)
		e := BuildExpected(scored(all, func(i int) float64 { return 0.9 - 0.01*float64(i) }), minCos, RecallK)
		if len(e) != 7 {
			t.Fatalf("|E| = %d, want 7 (N < 20: E is every eligible row)", len(e))
		}
		// ANN returns all 7: recall 1.0, no underfill although 7 < 20.
		c := AggregateCell("item", "small", "k", []QueryOutcome{annOutcome(e, e, "ann", false, false, 7)})
		if c.RecallMean != 1 || c.UnderfillAfter != 0 || c.ESmallerThanK != 1 {
			t.Fatalf("N<20 cell = recall %v underfill %v e<k %d, want 1, 0, 1", c.RecallMean, c.UnderfillAfter, c.ESmallerThanK)
		}
		// ANN returns 5 of the 7: recall 5/7 and an underfill after fallback.
		c = AggregateCell("item", "small", "k", []QueryOutcome{annOutcome(e, e[:5], "ann_short", true, false, 7)})
		if want := 5.0 / 7.0; c.RecallMean < want-1e-9 || c.RecallMean > want+1e-9 || c.UnderfillAfter != 1 {
			t.Fatalf("partial N<20 cell = recall %v underfill %v, want %v, 1", c.RecallMean, c.UnderfillAfter, want)
		}
	})

	t.Run("empty_expected_is_excluded_and_counts_false_positives", func(t *testing.T) {
		all := ids(20)
		e := BuildExpected(scored(all, func(int) float64 { return 0.30 }), minCos, RecallK)
		if len(e) != 0 {
			t.Fatalf("|E| = %d, want 0 (every row below min_cos)", len(e))
		}
		clean := annOutcome(e, nil, "ann", false, false, 5000)
		dirty := annOutcome(e, all[:3], "ann", false, false, 5000)
		c := AggregateCell("item", "whale", "k", []QueryOutcome{clean, dirty})
		if c.Eligible != 0 || c.ExcludedE0 != 2 {
			t.Fatalf("eligible %d excluded %d, want 0 and 2 (|E|=0 is excluded from C2-R/Q)", c.Eligible, c.ExcludedE0)
		}
		if c.FalsePositives != 1 {
			t.Fatalf("false positives = %d, want 1 (ANN returned rows although |E| = 0)", c.FalsePositives)
		}
		if v := EvaluateC2R([]CellAgg{c}, "k"); v.Applicable {
			t.Fatalf("C2-R applicable with only |E|=0 queries: %+v", v)
		}
		if v := EvaluateFalsePositives([]CellAgg{c}, "k"); !v.Applicable || v.Pass {
			t.Fatalf("false-positive verdict must fail: %+v", v)
		}
		// Without a false positive the same cell passes the FP check.
		c2 := AggregateCell("item", "whale", "k", []QueryOutcome{clean})
		if v := EvaluateFalsePositives([]CellAgg{c2}, "k"); !v.Pass {
			t.Fatalf("clean |E|=0 cell must pass the FP check: %+v", v)
		}
	})

	t.Run("threshold_cuts_part_of_top_20", func(t *testing.T) {
		all := ids(20)
		exact := scored(all, func(i int) float64 {
			if i < 12 {
				return 0.90 - 0.01*float64(i)
			}
			return 0.40 // below min_cos
		})
		e := BuildExpected(exact, minCos, RecallK)
		if len(e) != 12 || !slices.Equal(e, all[:12]) {
			t.Fatalf("|E| = %d, want the 12 rows above min_cos in oracle order", len(e))
		}
		// A row exactly at min_cos is eligible (>=).
		boundary := BuildExpected([]ScoredID{{ID: all[0], Cos: minCos}}, minCos, RecallK)
		if len(boundary) != 1 {
			t.Fatalf("cos == min_cos must be eligible, got |E| = %d", len(boundary))
		}
		// ANN returns exactly the 12 eligible rows: recall 1, no underfill (12 = |E|).
		c := AggregateCell("item", "whale", "k", []QueryOutcome{annOutcome(e, e, "ann", false, false, 9000)})
		if c.RecallMean != 1 || c.UnderfillAfter != 0 {
			t.Fatalf("recall %v underfill %v, want 1 and 0", c.RecallMean, c.UnderfillAfter)
		}
	})

	t.Run("real_ann_underfill_before_and_after_fallback", func(t *testing.T) {
		all := ids(20)
		e := BuildExpected(scored(all, func(i int) float64 { return 0.95 - 0.005*float64(i) }), minCos, RecallK)
		if len(e) != 20 {
			t.Fatalf("|E| = %d, want 20", len(e))
		}
		// Scan cap: 12 candidates only, whale too large for the fallback -> ann_short.
		short := annOutcome(e, e[:12], "ann_short", true, false, 40000)
		// Medium tenant: same underfill, recovered by the exact fallback.
		recovered := annOutcome(e, e, "ann_fallback_exact", true, true, 15000)
		c := AggregateCell("item", "medium", "k", []QueryOutcome{short, recovered})
		if c.ANNQueries != 2 || c.Eligible != 2 {
			t.Fatalf("ann %d eligible %d, want 2 and 2", c.ANNQueries, c.Eligible)
		}
		if c.UnderfillBeforeANN != 1 {
			t.Fatalf("underfill before fallback = %v, want 1 (both queries)", c.UnderfillBeforeANN)
		}
		if c.UnderfillAfter != 0.5 {
			t.Fatalf("underfill after fallback = %v, want 0.5 (only the ann_short query)", c.UnderfillAfter)
		}
		if c.FallbackUsed != 1 || c.ScanCapSuspect != 2 {
			t.Fatalf("fallback %d scan-cap suspects %d, want 1 and 2", c.FallbackUsed, c.ScanCapSuspect)
		}
		if want := (12.0/20.0 + 1.0) / 2; c.RecallMean < want-1e-9 || c.RecallMean > want+1e-9 {
			t.Fatalf("recall mean = %v, want %v", c.RecallMean, want)
		}
		// 50 % underfill violates C2-U (<= 1 %).
		if v := EvaluateC2U([]CellAgg{c}, "k"); !v.Applicable || v.Pass {
			t.Fatalf("C2-U must fail at 50%% underfill: %+v", v)
		}
	})

	t.Run("exact_path_is_not_a_c2r_input", func(t *testing.T) {
		all := ids(20)
		e := BuildExpected(scored(all, func(i int) float64 { return 0.9 - 0.001*float64(i) }), minCos, RecallK)
		c := AggregateCell("tag", "small", "k", []QueryOutcome{annOutcome(e, e, "exact", false, false, 300)})
		if c.ANNQueries != 0 || c.ExactQueries != 1 || c.ExactRecallMean != 1 {
			t.Fatalf("ann %d exact %d exact recall %v", c.ANNQueries, c.ExactQueries, c.ExactRecallMean)
		}
		if v := EvaluateC2R([]CellAgg{c}, "k"); v.Applicable {
			t.Fatalf("exact-path-only cell must be n/a for C2-R: %+v", v)
		}
	})

	t.Run("recall_and_q_thresholds", func(t *testing.T) {
		all := ids(20)
		e := all
		// 19 queries at recall 1.0 and 1 at 0.75 -> mean 0.9875 (pass), Q = 95 % (pass).
		var outs []QueryOutcome
		for range 19 {
			outs = append(outs, annOutcome(e, e, "ann", false, false, 9000))
		}
		outs = append(outs, annOutcome(e, e[:15], "ann", false, false, 9000))
		c := AggregateCell("item", "whale", "k", outs)
		if v := EvaluateC2R([]CellAgg{c}, "k"); !v.Pass {
			t.Fatalf("C2-R mean %.4f should pass: %+v", c.RecallMean, v)
		}
		if v := EvaluateC2Q([]CellAgg{c}, "k"); !v.Pass {
			t.Fatalf("C2-Q fraction %.4f should pass at exactly 95%% (19/20): %+v", c.QFraction, v)
		}
		// Two bad queries out of 20: Q fraction 90 % fails.
		outs[0] = annOutcome(e, e[:10], "ann", false, false, 9000)
		c = AggregateCell("item", "whale", "k", outs)
		if v := EvaluateC2Q([]CellAgg{c}, "k"); v.Pass {
			t.Fatalf("C2-Q at 90%% must fail: %+v", v)
		}
	})
}

// mdColumns counts the cells of a Markdown table row, honouring `\|` escapes.
func mdColumns(line string) int {
	n, esc := 0, false
	for _, r := range strings.TrimSpace(line) {
		switch {
		case esc:
			esc = false
		case r == '\\':
			esc = true
		case r == '|':
			n++
		}
	}
	return n - 1
}

// mdTableShapeErrors reports every table row whose cell count differs from its
// header (an unescaped pipe in a cell shifts the columns). Fenced blocks are skipped.
func mdTableShapeErrors(md string) []string {
	var errs []string
	fenced, want := false, -1
	for i, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(line, "```") {
			fenced = !fenced
			continue
		}
		if fenced || !strings.HasPrefix(line, "|") {
			want = -1
			continue
		}
		got := mdColumns(line)
		if want < 0 {
			want = got
			continue
		}
		if got != want {
			errs = append(errs, fmt.Sprintf("line %d: %d cells, header has %d: %.80s", i+1, got, want, line))
		}
	}
	return errs
}

// TestMarkdownTablesEscapePipes: |E|>0, |E|=0 and metric strings that contain a
// pipe must not add table columns (SBW3-1-6).
func TestMarkdownTablesEscapePipes(t *testing.T) {
	if got := mdCell("a|b\nc"); got != `a\|b c` {
		t.Fatalf("mdCell = %q", got)
	}
	e := ids(20)
	cell := AggregateCell("item", "whale", "k", []QueryOutcome{
		annOutcome(e, e, "ann", false, false, 9000),
		annOutcome(nil, e[:2], "ann", false, false, 9000), // |E| = 0 with rows: a false positive
	})
	r := &Report{
		Label: "t", Run: RunInfo{Profile: string(ProfileSmoke)},
		Verdicts: []Verdict{
			EvaluateFalsePositives([]CellAgg{cell}, "k"), // metric text contains |E|
			EvaluateC2R([]CellAgg{cell}, "k"),
			{ID: "X", Metric: "m|n", Target: "t|u", Measured: "a|b", Note: "c|d", Applicable: true},
		},
		C2: &C2Report{DefaultKnob: "k", Cells: []CellAgg{cell}},
	}
	md := RenderMarkdown(r)
	if errs := mdTableShapeErrors(md); len(errs) > 0 {
		t.Fatalf("Markdown table rows with a wrong cell count:\n%s", strings.Join(errs, "\n"))
	}
	if !strings.Contains(md, `\|E\|>0`) || !strings.Contains(md, `rows returned when \|E\| = 0`) {
		t.Fatal("|E| must be escaped in the C2 header and in the false-positive metric")
	}
}

func TestNearestRankPercentiles(t *testing.T) {
	var lat []time.Duration
	for i := 1; i <= 100; i++ {
		lat = append(lat, time.Duration(i)*time.Millisecond)
	}
	for _, tc := range []struct {
		q    float64
		want time.Duration
	}{{0.50, 50 * time.Millisecond}, {0.95, 95 * time.Millisecond}, {0.99, 99 * time.Millisecond}, {1, 100 * time.Millisecond}} {
		if got := NearestRank(lat, tc.q); got != tc.want {
			t.Errorf("nearest-rank p%.0f = %v, want %v", tc.q*100, got, tc.want)
		}
	}
	if NearestRank(nil, 0.95) != 0 {
		t.Error("empty input must give 0")
	}
	st := Summarize(lat, 0)
	if st.P95Ms != 95 || st.N != 100 {
		t.Errorf("Summarize = %+v", st)
	}
}

func TestEvaluateLatencyBoundaries(t *testing.T) {
	st := LatencyStats{N: 2000, P95Ms: 40}
	if v := EvaluateLatency("C1-L", "m", st, TargetC1LP95, true, 2000, true, ""); v.Pass {
		t.Error("p95 == 40 ms must FAIL a strict < 40 ms target")
	}
	if v := EvaluateLatency("C2-B", "m", LatencyStats{N: 2000, P95Ms: 80}, TargetC2BP95, false, 2000, true, ""); !v.Pass {
		t.Error("p95 == 80 ms must pass a <= 80 ms target")
	}
	if v := EvaluateLatency("C1-L", "m", LatencyStats{N: 1999, P95Ms: 1}, TargetC1LP95, true, 2000, true, ""); v.Pass {
		t.Error("fewer than the minimum measured requests must fail")
	}
	if v := EvaluateLatency("C1-L", "m", LatencyStats{N: 2000, P95Ms: 1, Errors: 1}, TargetC1LP95, true, 2000, true, ""); v.Pass {
		t.Error("request errors must fail the scenario")
	}
	if v := EvaluateLatency("C1-H", "m", LatencyStats{N: 2000, P95Ms: 1}, TargetC1HP95, true, 2000, false, "cache not hit"); v.Pass {
		t.Error("an invalid scenario must fail")
	}
	if v := EvaluateC2T(1); v.Pass {
		t.Error("C2-T with one cross-tenant row must fail")
	}
	if v := EvaluateC2T(0); !v.Pass {
		t.Error("C2-T with 0 rows must pass")
	}
}

func TestEstimateDiskBytes(t *testing.T) {
	full, err := BuildProfileSpec(ProfileFull, DefaultSeed, 0)
	if err != nil {
		t.Fatal(err)
	}
	est := EstimateDiskBytes(full)
	if est != 10*GB {
		t.Errorf("full estimate = %d, want 10 GB (plan 2.23)", est)
	}
	if got := DiskFloorBytes(est); got != 15*GB {
		t.Errorf("full floor = %d, want 15 GB (1.5 x estimate)", got)
	}
	smoke, err := BuildProfileSpec(ProfileSmoke, DefaultSeed, 0)
	if err != nil {
		t.Fatal(err)
	}
	se := EstimateDiskBytes(smoke)
	if se%GB != 0 || se < GB || se > 2*GB {
		t.Errorf("smoke estimate = %d, want a whole number of GB in [1, 2]", se)
	}
	if DiskFloorBytes(se) != se*3/2 {
		t.Errorf("smoke floor %d != 1.5 x %d", DiskFloorBytes(se), se)
	}
	t.Logf("disk estimate: full %d GB (floor %d GB), smoke %d GB (floor %.1f GB)",
		est/GB, DiskFloorBytes(est)/GB, se/GB, float64(DiskFloorBytes(se))/float64(GB))
}

func TestMixKindProportions(t *testing.T) {
	counts := map[QueryKind]int{}
	for i := range 1000 {
		counts[MixKind(i)]++
	}
	if counts[KindNearItem] != 700 || counts[KindNearTopic] != 200 || counts[KindRandom] != 100 {
		t.Fatalf("mix = %v, want 700/200/100", counts)
	}
}

func TestQuerySetsAreDeterministic(t *testing.T) {
	lex, err := LoadDefaultLexicon()
	if err != nil {
		t.Fatal(err)
	}
	g, err := NewGenerator(ProfileSmoke, DefaultSeed, 0, lex)
	if err != nil {
		t.Fatal(err)
	}
	a := BuildVectorQueries(g, generation.CorpusItem, ClassWhale, []int{0}, 60, nil)
	b := BuildVectorQueries(g, generation.CorpusItem, ClassWhale, []int{0}, 60, nil)
	if len(a) != 60 || len(b) != 60 {
		t.Fatalf("got %d/%d queries, want 60", len(a), len(b))
	}
	for i := range a {
		if a[i].Kind != b[i].Kind || !slices.Equal(a[i].Vec, b[i].Vec) {
			t.Fatalf("vector query %d differs between two builds", i)
		}
		if len(a[i].Vec) != VectorDims {
			t.Fatalf("query %d has %d dims", i, len(a[i].Vec))
		}
	}
	la := BuildLexicalQueries(g, []int{0}, 40, nil)
	lb := BuildLexicalQueries(g, []int{0}, 40, nil)
	for i := range la {
		if la[i].Text != lb[i].Text || la[i].QN == "" {
			t.Fatalf("lexical query %d is not deterministic or has no normalized form", i)
		}
	}
	// Cache-miss queries must never repeat after normalization.
	m := BuildHybridQueries(g, 0, 200, true, 5_000_000, 0)
	seen := map[string]struct{}{}
	for _, q := range m {
		if _, dup := seen[q.QN]; dup {
			t.Fatal("duplicate normalized query in the cache-miss set")
		}
		seen[q.QN] = struct{}{}
	}
	if len(m) != 200 {
		t.Fatalf("built %d unique hybrid queries, want 200", len(m))
	}
	if ReportFileBase(time.Date(2026, 11, 3, 1, 0, 0, 0, time.UTC), "0123456789abcdef", ProfileSmoke, "amd64") != "2026-11-03-0123456-smoke-amd64" {
		t.Fatal("report file base does not follow <date>-<sha7>-<profile>-<arch>")
	}
}

// ---- self-checks (database) -------------------------------------------------

func lexPlan() ScenarioPlan {
	return ScenarioPlan{Levels: []LoadLevel{{Concurrency: TargetConcurrency, Warmup: 20, Measured: 240}}}
}

func runLexicalCheck(t *testing.T, h *Harness, sr *SeedResult, limits map[int]int) ScenarioReport {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	qs := BuildLexicalQueries(sr.Gen, []int{0}, 300, limits)
	rep, err := h.RunC1L(ctx, qs, lexPlan())
	if err != nil {
		t.Fatalf("C1-L run: %v", err)
	}
	return rep
}

// TestHarnessCatchesSlowLexical: a 50 ms delay injected through the production
// suggest.TestHooks.BeforeBranch seam must turn the C1-L verdict into a FAIL
// (p95 < 40 ms), proving the harness measures the server and the aggregation
// would catch a regression. The control without the delay must pass.
func TestHarnessCatchesSlowLexical(t *testing.T) {
	env := dbEnvT(t)
	limits := map[int]int{0: 1500}
	dsn, sr := freshSeed(t, env, SeedOptions{
		Tenants: []int{0}, ItemLimit: limits, TagLimit: map[int]int{0: 300}, SkipVectors: true,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	h, err := NewHarness(ctx, dsn, sr, HarnessConfig{Semantic: false})
	if err != nil {
		t.Fatalf("harness: %v", err)
	}
	t.Cleanup(h.Close)
	const minN = 200 // self-check size; the real run uses MinMeasuredPerScenario

	// Control first (no delay): must pass. One retry absorbs a noisy CI neighbour.
	var control Verdict
	for attempt := 1; attempt <= 2; attempt++ {
		rep := runLexicalCheck(t, h, sr, limits)
		control = EvaluateScenario(rep, TargetC1LP95, minN)
		t.Logf("control attempt %d: %s - %s", attempt, control.Status(), control.Measured)
		if control.Pass {
			break
		}
	}
	if !control.Pass {
		t.Fatalf("control without delay must PASS C1-L on a tiny corpus: %+v", control)
	}

	// Injected 50 ms delay in every lexical branch.
	h.Service.SetTestHooks(&suggest.TestHooks{BeforeBranch: func(ctx context.Context, _ string) error {
		select {
		case <-time.After(50 * time.Millisecond):
		case <-ctx.Done():
		}
		return nil
	}})
	t.Cleanup(func() { h.Service.SetTestHooks(nil) })
	slow := runLexicalCheck(t, h, sr, limits)
	v := EvaluateScenario(slow, TargetC1LP95, minN)
	t.Logf("slow run: %s - %s", v.Status(), v.Measured)
	if !v.Applicable || v.Pass {
		t.Fatalf("harness failed to catch a 50 ms lexical delay: %+v", v)
	}
	if l, ok := slow.Level(TargetConcurrency); !ok || l.Stats.P95Ms < 45 {
		t.Fatalf("injected delay not visible in the measured p95: %+v", l.Stats)
	}
}

// TestHarnessCatchesLowRecall: with ExactMax=0, exact fallback disabled,
// iterative scan off and ef_search=1 the same aggregation code must report a
// C2-R FAIL on an ANN-family path; the control (default knobs, exact path) must
// have recall 1.0 and no C2-R failure.
//
// Note: the literal path "ann" is unreachable at ef_search=1 (fewer than 20
// candidates are returned, so the store reports "ann_short"); the assertion is
// therefore on the ANN family (ann / ann_short) and on "no exact path, no fallback".
func TestHarnessCatchesLowRecall(t *testing.T) {
	env := dbEnvT(t)
	limits := map[int]int{0: 4000}
	tagLimits := map[int]int{0: 800}
	dsn, sr := freshSeed(t, env, SeedOptions{Tenants: []int{0}, ItemLimit: limits, TagLimit: tagLimits})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	h, err := NewHarness(ctx, dsn, sr, HarnessConfig{Semantic: false})
	if err != nil {
		t.Fatalf("harness: %v", err)
	}
	t.Cleanup(h.Close)

	forced := KnobSet{
		Label: "forced_ann_ef1", EfSearch: 1, MaxScanTuples: 20000, ExactMax: 0,
		Iterative: "off", ForceNoFallbk: true,
	}
	sane := NewKnob(100, unlimitedScan, 0) // informational: forced ANN with sane knobs
	rep, err := h.RunC2(ctx, C2Config{
		QueriesPerCell: 100, Workers: 4, Knobs: []KnobSet{forced, DefaultKnob(), sane}, Default: forced,
		Corpora: []generation.Corpus{generation.CorpusItem},
		Classes: map[TenantClass][]int{ClassWhale: {0}}, ItemLimit: limits, TagLimit: tagLimits,
	})
	if err != nil {
		t.Fatalf("C2: %v", err)
	}
	cellOf := func(label string) CellAgg {
		for _, c := range rep.Cells {
			if c.Knob == label {
				return c
			}
		}
		t.Fatalf("no cell for knob %s", label)
		return CellAgg{}
	}

	bad := cellOf(forced.Label)
	t.Logf("forced cell: paths=%v recall=%.4f", bad.PathCounts, bad.RecallMean)
	for path, n := range bad.PathCounts {
		if n > 0 && !IsANNFamily(path) {
			t.Fatalf("forced run took non-ANN path %q (%d queries); the check would be void", path, n)
		}
	}
	if bad.ANNQueries != bad.Queries || bad.FallbackUsed != 0 {
		t.Fatalf("forced run: ann %d of %d queries, fallback used %d; want all ANN and no fallback", bad.ANNQueries, bad.Queries, bad.FallbackUsed)
	}
	if v := EvaluateC2R(rep.Cells, forced.Label); !v.Applicable || v.Pass {
		t.Fatalf("harness failed to catch ef_search=1 recall collapse: %+v", v)
	}

	ctl := cellOf(DefaultKnob().Label)
	t.Logf("control cell: paths=%v exact recall=%.4f", ctl.PathCounts, ctl.ExactRecallMean)
	if ctl.PathCounts["exact"] != ctl.Queries || ctl.ExactQueries == 0 {
		t.Fatalf("control (default knobs, 4000 items <= 5000) must take the exact path: %v", ctl.PathCounts)
	}
	if ctl.ExactRecallMean < 1-1e-9 {
		t.Fatalf("control exact-path recall = %v, want 1.0", ctl.ExactRecallMean)
	}
	if v := EvaluateC2R(rep.Cells, DefaultKnob().Label); v.Applicable && !v.Pass {
		t.Fatalf("control must not fail C2-R: %+v", v)
	}
	o := cellOf(sane.Label)
	t.Logf("informational forced-ANN control (ef=100): paths=%v recall=%.4f", o.PathCounts, o.RecallMean)
	if n := totalCrossTenant(rep.Cells); n != 0 {
		t.Fatalf("cross-tenant rows in self-check: %d", n)
	}
}

// ---- the benchmark ---------------------------------------------------------

// TestSearchBench seeds the profile, runs C1 and C2 and writes the report. A
// `smoke` run fails only on hard conditions (invalid harness, request errors,
// C2-T); a `full` run also fails when any target misses.
func TestSearchBench(t *testing.T) {
	env, err := LoadEnv()
	if err != nil {
		t.Fatal(err)
	}
	if env.DatabaseURL == "" {
		if env.Require {
			t.Fatal("SEARCH_BENCH_REQUIRE=1 but SEARCH_BENCH_DATABASE_URL is empty: the benchmark cannot be skipped")
		}
		t.Skip("SEARCH_BENCH_DATABASE_URL is empty: benchmark skipped")
	}
	cfg := ConfigFor(env.Profile)
	started := time.Now().UTC()

	rep := &Report{
		Schema: "engram.searchbench.v1",
		Label:  ReportLabel(env.Profile),
		Run: RunInfo{
			DateUTC: started.Format(time.RFC3339), HeadSHA: env.HeadSHA, RunURL: env.RunURL,
			Job: os.Getenv("GITHUB_JOB"), TargetsCommit: env.TargetsSHA,
			Profile: string(env.Profile), Seed: env.Seed, GOARCH: runtime.GOARCH,
		},
		Hardware: CollectHardware(env, PGInfo{}),
	}
	if full, err := BuildProfileSpec(ProfileFull, env.Seed, 0); err == nil {
		smoke, _ := BuildProfileSpec(ProfileSmoke, env.Seed, 0)
		fe, se := EstimateDiskBytes(full), EstimateDiskBytes(smoke)
		rep.Disk = DiskPrecheck{FullEstimateBytes: fe, FullFloorBytes: DiskFloorBytes(fe), SmokeEstimate: se, SmokeFloorBytes: DiskFloorBytes(se)}
	}
	base := ReportFileBase(started, env.HeadSHA, env.Profile, runtime.GOARCH)

	// The report is written even when the run fails half way (partial evidence).
	t.Cleanup(func() {
		FinalizeReport(rep, cfg.MinMeasured)
		md, err := WriteReport(env.OutDir, base, rep)
		if err != nil {
			t.Errorf("write report: %v", err)
			return
		}
		if err := AppendStepSummary(env.StepSummary, md); err != nil {
			t.Errorf("append step summary: %v", err)
		}
		t.Logf("report: %s/%s.{md,json}", env.OutDir, base)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Hour)
	defer cancel()
	dsn, drop, err := CreateFreshDatabase(ctx, env.DatabaseURL)
	if err != nil {
		t.Fatalf("fresh database: %v", err)
	}
	t.Cleanup(drop)

	sr, err := SeedDatabase(ctx, dsn, SeedOptions{
		Profile: env.Profile, Seed: env.Seed, MaintWorkMem: env.MaintWorkMem, Logf: t.Logf,
	})
	if sr != nil {
		rep.Run.DatasetHash = sr.DatasetHash
		rep.Seed = &SeedSummary{
			Users: sr.Users, Items: sr.Items, Tags: sr.Tags, ItemTags: sr.ItemTags,
			ItemVectors: sr.ItemVectors, TagVectors: sr.TagVectors,
			Timings: sr.Timings, HNSW: sr.HNSW, Sizes: sr.Sizes, Colocation: sr.Colocation,
		}
		rep.Sizing = BuildSizingTable(sr)
		fmt.Printf("search-bench: dataset_hash=%s profile=%s seed=%d\n", sr.DatasetHash, env.Profile, env.Seed)
	}
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	if !sr.Colocation.OK {
		t.Fatalf("colocation check failed: %+v", sr.Colocation)
	}

	if err := RunBenchmark(ctx, env, dsn, sr, rep, t.Logf); err != nil {
		t.Fatalf("benchmark: %v", err)
	}
	FinalizeReport(rep, cfg.MinMeasured)
	for _, v := range rep.Verdicts {
		t.Logf("%-5s %-4s %s", v.ID, v.Status(), v.Measured)
	}
	for _, h := range rep.Hard {
		t.Errorf("hard failure: %s", h)
	}
	if env.Profile == ProfileFull {
		for _, f := range TargetFailures(rep.Verdicts) {
			t.Errorf("target failed: %s", f)
		}
	} else if fails := TargetFailures(rep.Verdicts); len(fails) > 0 {
		t.Logf("smoke - not acceptance evidence; informational target misses: %v", fails)
	}
}
