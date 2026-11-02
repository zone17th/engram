//go:build searchbench

package searchbench

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
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

func withLatency(o QueryOutcome, d time.Duration) QueryOutcome {
	o.Latency = d
	return o
}

// TestC2UnderfillIsOverEveryMeasuredQuery pins SBW3-1-2: C2-U is Rows < |E| over
// every measured query of the cell on every path (targets.md section 2), not over
// the |E| > 0 ANN subset that C2-R/C2-Q use.
func TestC2UnderfillIsOverEveryMeasuredQuery(t *testing.T) {
	e := ids(20)
	t.Run("zero_E_queries_are_non_underfilled_denominator", func(t *testing.T) {
		// 100 ANN queries: 10 with |E| = 0, 89 complete, 1 underfilled.
		// Frozen rate 1/100 = 1 % (pass); dividing by the 90 |E| > 0 queries would
		// give 1.11 % (fail).
		var outs []QueryOutcome
		for range 10 {
			outs = append(outs, annOutcome(nil, nil, "ann", false, false, 9000))
		}
		for range 89 {
			outs = append(outs, annOutcome(e, e, "ann", false, false, 9000))
		}
		outs = append(outs, annOutcome(e, e[:19], "ann_short", true, false, 40000))
		c := AggregateCell("item", "whale", "k", outs)
		if c.Queries != 100 || c.Eligible != 90 {
			t.Fatalf("queries %d eligible %d, want 100 and 90", c.Queries, c.Eligible)
		}
		if c.UnderfillAfterCount != 1 || c.UnderfillAfter < 0.01-1e-12 || c.UnderfillAfter > 0.01+1e-12 {
			t.Fatalf("underfill after = %d queries, %v, want 1 query, 1%%", c.UnderfillAfterCount, c.UnderfillAfter)
		}
		if v := EvaluateC2U([]CellAgg{c}, "k"); !v.Applicable || !v.Pass {
			t.Fatalf("C2-U at exactly 1/100 must pass: %+v", v)
		}
		// One more underfilled query: 2 % fails.
		outs[10] = annOutcome(e, e[:3], "ann_short", true, false, 40000)
		if v := EvaluateC2U([]CellAgg{AggregateCell("item", "whale", "k", outs)}, "k"); v.Pass {
			t.Fatalf("C2-U at 2 %% must fail: %+v", v)
		}
	})

	t.Run("exact_path_timeout_with_no_rows_is_underfill", func(t *testing.T) {
		// No ANN query at all: C2-R is n/a, but C2-U still judges the exact path.
		var outs []QueryOutcome
		for range 98 {
			outs = append(outs, annOutcome(e, e, "exact", false, false, 300))
		}
		for range 2 {
			o := annOutcome(e, nil, "exact", false, false, 300)
			o.TimedOut = true
			outs = append(outs, o)
		}
		c := AggregateCell("tag", "small", "k", outs)
		if c.ANNQueries != 0 || c.TimedOut != 2 || c.UnderfillAfterCount != 2 {
			t.Fatalf("ann %d timed out %d underfill %d, want 0, 2, 2", c.ANNQueries, c.TimedOut, c.UnderfillAfterCount)
		}
		if v := EvaluateC2R([]CellAgg{c}, "k"); v.Applicable {
			t.Fatalf("C2-R must stay n/a for an exact-only cell: %+v", v)
		}
		if v := EvaluateC2U([]CellAgg{c}, "k"); !v.Applicable || v.Pass {
			t.Fatalf("C2-U must fail at 2 %% exact-path underfill: %+v", v)
		}
		// One timeout in 100 queries is exactly 1 %: pass (<= 1 %).
		outs[98] = annOutcome(e, e, "exact", false, false, 300)
		if v := EvaluateC2U([]CellAgg{AggregateCell("tag", "small", "k", outs)}, "k"); !v.Pass {
			t.Fatalf("C2-U at 1 underfilled exact query of 100 must pass: %+v", v)
		}
	})

	t.Run("candidate_underfill_stays_separate", func(t *testing.T) {
		// Fallback recovered every query: C2-U 0 %, candidate underfill 100 %.
		var outs []QueryOutcome
		for range 10 {
			outs = append(outs, annOutcome(e, e, "ann_fallback_exact", true, true, 15000))
		}
		c := AggregateCell("item", "medium", "k", outs)
		if c.UnderfillAfter != 0 || c.UnderfillBeforeANN != 1 {
			t.Fatalf("after %v before %v, want 0 and 1", c.UnderfillAfter, c.UnderfillBeforeANN)
		}
		if v := EvaluateC2U([]CellAgg{c}, "k"); !v.Pass {
			t.Fatalf("a recovered underfill must not fail C2-U: %+v", v)
		}
	})

	t.Run("only_zero_E_queries_pass", func(t *testing.T) {
		c := AggregateCell("item", "whale", "k", []QueryOutcome{annOutcome(nil, nil, "ann", false, false, 9000)})
		if v := EvaluateC2U([]CellAgg{c}, "k"); !v.Applicable || !v.Pass {
			t.Fatalf("a cell of |E| = 0 queries is measured and non-underfilled: %+v", v)
		}
	})
}

// TestC2BranchLatencyCoversEveryRequest pins SBW3-1-3: C2-B is the p95 of the
// vector branch latency of every request of the cell (exact and ANN paths,
// |E| = 0 included), per targets.md.
func TestC2BranchLatencyCoversEveryRequest(t *testing.T) {
	e := ids(20)
	t.Run("exact_only_slow_cell_fails", func(t *testing.T) {
		var outs []QueryOutcome
		for range 100 {
			outs = append(outs, withLatency(annOutcome(e, e, "exact", false, false, 300), 120*time.Millisecond))
		}
		c := AggregateCell("item", "small", "k", outs)
		v := EvaluateC2B([]CellAgg{c}, "k")
		if !v.Applicable || v.Pass {
			t.Fatalf("an exact-only cell with p95 120 ms must FAIL C2-B (it was n/a before): %+v", v)
		}
		if c.ANNBranchLatency.N != 0 || c.BranchLatency.N != 100 {
			t.Fatalf("all-path n %d ann n %d, want 100 and 0", c.BranchLatency.N, c.ANNBranchLatency.N)
		}
	})
	t.Run("zero_E_requests_count", func(t *testing.T) {
		var outs []QueryOutcome
		for range 50 {
			outs = append(outs, withLatency(annOutcome(e, e, "ann", false, false, 9000), 10*time.Millisecond))
		}
		for range 50 {
			outs = append(outs, withLatency(annOutcome(nil, nil, "ann", false, false, 9000), 150*time.Millisecond))
		}
		c := AggregateCell("item", "whale", "k", outs)
		if v := EvaluateC2B([]CellAgg{c}, "k"); !v.Applicable || v.Pass {
			t.Fatalf("slow |E| = 0 requests must fail C2-B: %+v", v)
		}
	})
	t.Run("slow_exact_requests_fail_a_mixed_cell_that_ann_alone_would_pass", func(t *testing.T) {
		var outs []QueryOutcome
		for range 90 {
			outs = append(outs, withLatency(annOutcome(e, e, "ann", false, false, 9000), 20*time.Millisecond))
		}
		for range 10 {
			outs = append(outs, withLatency(annOutcome(e, e, "exact", false, false, 300), 200*time.Millisecond))
		}
		c := AggregateCell("item", "medium", "k", outs)
		if c.ANNBranchLatency.P95Ms > 80 {
			t.Fatalf("ANN-only p95 = %v, want <= 80", c.ANNBranchLatency.P95Ms)
		}
		if v := EvaluateC2B([]CellAgg{c}, "k"); v.Pass {
			t.Fatalf("all-path p95 %.0f ms must FAIL C2-B: %+v", c.BranchLatency.P95Ms, v)
		}
	})
	t.Run("fast_cell_passes_at_the_boundary", func(t *testing.T) {
		var outs []QueryOutcome
		for range 100 {
			outs = append(outs, withLatency(annOutcome(e, e, "exact", false, false, 300), 80*time.Millisecond))
		}
		if v := EvaluateC2B([]CellAgg{AggregateCell("item", "small", "k", outs)}, "k"); !v.Pass {
			t.Fatalf("p95 == 80 ms must pass C2-B (<=): %+v", v)
		}
	})
}

func hybridLevel(c, n, ran int, reasons map[string]int) LevelReport {
	return LevelReport{
		Concurrency: c, Stats: LatencyStats{N: n, P95Ms: 2}, SemanticRan: ran, SemanticOff: n - ran, SemanticOffReasons: reasons,
	}
}

// TestHybridScenarioRequiresEverySemanticSuccess pins SBW3-1-4: a hybrid level is
// valid target evidence only when every measured request ran semantic. One
// success among otherwise degraded (fast, lexical-only) responses is invalid and
// the verdict fails; the degradation reasons are reported.
func TestHybridScenarioRequiresEverySemanticSuccess(t *testing.T) {
	if p := HybridLevelProblem(hybridLevel(8, 2000, 2000, nil)); p != "" {
		t.Fatalf("all-semantic level must be valid, got %q", p)
	}
	oneSuccess := hybridLevel(8, 2000, 1, map[string]int{"degraded": 1999})
	p := HybridLevelProblem(oneSuccess)
	if p == "" {
		t.Fatal("one semantic success among 1999 degraded responses must be INVALID")
	}
	if !strings.Contains(p, "degraded=1999") || !strings.Contains(p, "c=8") {
		t.Fatalf("problem %q must name the level and the reason counts", p)
	}
	oneDegraded := hybridLevel(8, 2000, 1999, map[string]int{"degraded": 1})
	if p := HybridLevelProblem(oneDegraded); p == "" {
		t.Fatal("a single degraded request in the measured sample must invalidate the level")
	}
	if p := HybridLevelProblem(hybridLevel(8, 2000, 0, nil)); p == "" {
		t.Fatal("a level where semantic never ran must be invalid")
	}

	// Through the same verdict code as the run: fast degraded responses must not
	// pass C1-H / C1-M, and the scenario is a hard failure.
	s := ScenarioReport{ID: "C1-M", Valid: true, Levels: []LevelReport{hybridLevel(1, 600, 600, nil), oneSuccess}}
	for _, l := range s.Levels {
		if prob := HybridLevelProblem(l); prob != "" {
			s.Invalidate(prob)
		}
	}
	if s.Valid {
		t.Fatal("scenario must be invalid")
	}
	v := EvaluateScenario(s, TargetC1MP95, MinMeasuredPerScenario)
	if !v.Applicable || v.Pass {
		t.Fatalf("an invalid hybrid scenario must FAIL even at p95 2 ms: %+v", v)
	}
	if !strings.Contains(v.Note, "scenario invalid") {
		t.Fatalf("verdict note %q must say the scenario is invalid", v.Note)
	}
	hard := HardFailures(&Report{C1: []ScenarioReport{s}})
	if len(hard) != 1 || !strings.Contains(hard[0], "degraded=1999") {
		t.Fatalf("hard failures = %v, want one entry with the reason counts", hard)
	}
	s.Invalidate("second reason")
	if !strings.HasPrefix(s.InvalidReason, "c=8:") || !strings.HasSuffix(s.InvalidReason, "second reason") {
		t.Fatalf("Invalidate must keep the first reason and append later ones: %q", s.InvalidReason)
	}
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

// delayLexicalSuggest wraps the harness router with a test-only handler that
// sleeps d (context-aware) before serving a lexical (semantic != 1) /suggest
// request. The delay sits on the request path, in front of the router, so it adds
// latency without touching the production branch budget.
//
// It is deliberately NOT injected through suggest.TestHooks.BeforeBranch: that hook
// runs inside the lexical branch context whose budget is suggest.BranchTimeout
// (50 ms). A 50 ms delay there consumes the whole budget, so the request exercises
// the branch-timeout / partial-result path instead of "a slow but healthy
// lexical branch", and some requests error (cloud job 125456907642: errors=2 of
// 240).
func delayLexicalSuggest(next http.Handler, d time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/suggest" && r.URL.Query().Get("semantic") != "1" {
			select {
			case <-time.After(d):
			case <-r.Context().Done():
			}
		}
		next.ServeHTTP(w, r)
	})
}

// TestHarnessCatchesSlowLexical: a 50 ms delay on the lexical /suggest request
// path (delayLexicalSuggest, in front of the router and outside the 50 ms branch
// budget) must turn the C1-L verdict into a FAIL
// (p95 < 40 ms), proving the harness measures the server and the aggregation
// would catch a regression. Plan Task 10 BE-7a requires exactly that; it does
// NOT require the undelayed tiny control to meet the absolute 40 ms target on a
// shared CI runner (cloud runs: 35.95 ms, then 62/78 ms for the same code), so the
// control is measured and logged, never asserted against the target. The delay
// must be visible relative to that control, measured first on the same harness,
// the same query set and the same concurrency 8.
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
	const (
		minN         = 200 // self-check size; the real run uses MinMeasuredPerScenario
		injectedMs   = 50.0
		visibleDelta = injectedMs / 2 // injected p50 must exceed the control p50 by at least this much (25 ms)
	)

	// Control first (no delay): logged only. A shared runner may exceed the
	// absolute 40 ms target on this tiny corpus; that says nothing about the harness.
	control := runLexicalCheck(t, h, sr, limits)
	cv := EvaluateScenario(control, TargetC1LP95, minN)
	cl, ok := control.Level(TargetConcurrency)
	if !ok {
		t.Fatalf("control run has no concurrency %d level", TargetConcurrency)
	}
	t.Logf("control (no delay, logged not asserted): %s - %s; pool max conns %d; statuses %v", cv.Status(), cv.Measured, h.PoolMax, cl.Statuses)

	// Injected 50 ms delay on every lexical /suggest request, same harness, same
	// queries. Outside the branch budget (see delayLexicalSuggest).
	realRouter := h.Router
	h.Router = delayLexicalSuggest(realRouter, time.Duration(injectedMs)*time.Millisecond)
	t.Cleanup(func() { h.Router = realRouter })
	slow := runLexicalCheck(t, h, sr, limits)
	v := EvaluateScenario(slow, TargetC1LP95, minN)
	t.Logf("injected 50 ms run: %s - %s", v.Status(), v.Measured)

	// (i) the shared evaluator fails the injected run.
	if !v.Applicable || v.Pass {
		t.Fatalf("harness failed to catch a 50 ms lexical delay (control p95 %.2f ms): %+v", cl.Stats.P95Ms, v)
	}
	sl, ok := slow.Level(TargetConcurrency)
	if !ok {
		t.Fatalf("injected run has no concurrency %d level", TargetConcurrency)
	}
	// The FAIL must be a latency FAIL, not an invalid/errored/undersized run.
	if !slow.Valid || sl.Stats.Errors != 0 || sl.Stats.N < minN {
		t.Fatalf("injected run is not valid latency evidence (valid=%v %q, errors=%d, n=%d, http statuses %v, lexical_partial %d): %+v",
			slow.Valid, slow.InvalidReason, sl.Stats.Errors, sl.Stats.N, sl.Statuses, sl.LexicalPartial, v)
	}
	// (ii) the delay is in the measured p95 ...
	if sl.Stats.P95Ms < injectedMs {
		t.Fatalf("injected delay not visible in the measured p95: %.2f ms < %.0f ms (http statuses %v, %+v)", sl.Stats.P95Ms, injectedMs, sl.Statuses, sl.Stats)
	}
	// (iii) ... and stands out against the undelayed control of the same run.
	// Medians, not p95: a single noisy control tail (78 ms p95 seen in CI) must
	// not make the comparison flake. The visibility margin is half the injected
	// delay (advisor-dec-305): a closed-loop run cannot show the full delay at the
	// median, because the delay itself lowers the arrival rate and the contention
	// (CI 41496729972 observed a 36.6 ms median delta for a 50 ms hook). Half the
	// delay (25 ms) still separates a real injection from runner noise.
	t.Logf("control p50 %.2f ms p95 %.2f ms; injected p50 %.2f ms p95 %.2f ms", cl.Stats.P50Ms, cl.Stats.P95Ms, sl.Stats.P50Ms, sl.Stats.P95Ms)
	if sl.Stats.P50Ms < cl.Stats.P50Ms+visibleDelta {
		t.Fatalf("injected p50 %.2f ms is not at least %.0f ms above the control p50 %.2f ms (p95: injected %.2f ms, control %.2f ms; http statuses: injected %v, control %v)",
			sl.Stats.P50Ms, visibleDelta, cl.Stats.P50Ms, sl.Stats.P95Ms, cl.Stats.P95Ms, sl.Statuses, cl.Statuses)
	}
}

// lowRecallPlannerOverrides are applied ONLY to the connection pool of the
// low-recall self-check (HarnessConfig.SessionSQL). The 4,000-row single-tenant
// fixture is too small for the planner to choose the HNSW index by itself (a
// sequential scan + top-N sort is cheaper), which made the first version of this
// control "force ANN" on a plan that never touched HNSW (recall 1.0). Disabling
// the competing paths makes the HNSW ordered index scan the only plan without a
// disabled node. A disabled node adds a huge cost constant to the plan, which
// pushes the plan cost over jit_above_cost: the first cloud run saw the 80 ms
// statement budget expire (repeated 57014 timeouts, recall 0 from empty results,
// not from ef_search=1), most likely on JIT compilation of the forced plan, so JIT
// is off on this pool too. TEST-ONLY, same pattern as advisor-dec-289: never in
// production code, never in TestSearchBench (benchHarnessConfig has none), and the
// plan is proven by EXPLAIN of the actual ANN SQL under these settings before
// recall is judged.
var lowRecallPlannerOverrides = []string{
	"SET enable_seqscan = off",
	"SET enable_bitmapscan = off",
	"SET enable_sort = off",
	"SET jit = off",
}

// lowRecallBranchTimeout is the vector branch budget of this self-check only
// (C2Config.BranchTimeout). The benchmark keeps the production 80 ms; here the
// question is "does ef_search=1 collapse recall", which is only answerable when
// every query completes, so the budget is deliberately generous and any timeout
// voids the evidence instead of counting as a collapse.
const lowRecallBranchTimeout = 2 * time.Second

// errClass is the class of a failed query for logs: SQLSTATE or the context
// error, never the SQL text or the query vector.
func errClass(err error) string {
	var pgErr *pgconn.PgError
	switch {
	case err == nil:
		return "none"
	case errors.As(err, &pgErr):
		return "pg_sqlstate_" + pgErr.Code
	case errors.Is(err, context.DeadlineExceeded):
		return "context_deadline_exceeded"
	case errors.Is(err, context.Canceled):
		return "context_canceled"
	default:
		return fmt.Sprintf("%T", err)
	}
}

// cellEvidence renders the completion evidence of a cell for failure messages.
func cellEvidence(c CellAgg) string {
	return fmt.Sprintf("queries=%d timed_out=%d empty_path=%d paths=%v recall=%.4f branch_p95=%.1fms",
		c.Queries, c.TimedOut, c.PathCounts[""], c.PathCounts, c.RecallMean, c.BranchLatency.P95Ms)
}

// TestHarnessCatchesLowRecall: the ANN SQL is forced onto the HNSW index
// (ExactMax=0, exact fallback disabled, iterative scan off, ef_search=1) and the
// same aggregation code must report a C2-R FAIL. The test first proves from
// EXPLAIN of the actual ANN SQL, under the same session settings and hnsw.* knobs,
// that the plan is an HNSW scan of the tenant's pruned partition, and requires that
// no query took the exact or fallback path; the control (default knobs on the
// default planner, exact path) must have recall 1.0 and no C2-R failure.
//
// The forced run is evidence only when it completed: TimedOut == 0, no empty path
// and no error. A timed-out query returns an empty or partial result whose low
// recall says nothing about ef_search=1, so it fails the test with its evidence
// rather than counting as a collapse. The self-check has its own 2 s branch budget
// and jit off on the forced pool; the benchmark's budgets are unchanged.
//
// The assertion on the path is on the ANN family (ann / ann_short): at ef_search=1
// HNSW returns fewer than 20 candidates, so the store reports "ann_short" - the
// literal "ann" is not guaranteed and must not be forced by raising ef. What must
// hold is "no exact path, no fallback", a physical HNSW plan, and the recall collapse.
func TestHarnessCatchesLowRecall(t *testing.T) {
	env := dbEnvT(t)
	limits := map[int]int{0: 4000}
	tagLimits := map[int]int{0: 800}
	dsn, sr := freshSeed(t, env, SeedOptions{Tenants: []int{0}, ItemLimit: limits, TagLimit: tagLimits})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	// plain: default planner settings, like the benchmark. forcedH: planner
	// overrides on this pool only (see lowRecallPlannerOverrides).
	plain, err := NewHarness(ctx, dsn, sr, HarnessConfig{Semantic: false})
	if err != nil {
		t.Fatalf("plain harness: %v", err)
	}
	t.Cleanup(plain.Close)
	if len(plain.SessionSQL) != 0 {
		t.Fatalf("the control harness must run on default planner settings: %v", plain.SessionSQL)
	}
	forcedH, err := NewHarness(ctx, dsn, sr, HarnessConfig{Semantic: false, SessionSQL: lowRecallPlannerOverrides})
	if err != nil {
		t.Fatalf("forced harness: %v", err)
	}
	t.Cleanup(forcedH.Close)

	forced := KnobSet{
		Label: "forced_ann_ef1", EfSearch: 1, MaxScanTuples: 20000, ExactMax: 0,
		Iterative: "off", ForceNoFallbk: true,
	}
	sane := NewKnob(100, unlimitedScan, 0) // informational: forced ANN with sane knobs
	c2cfg := func(def KnobSet, knobs ...KnobSet) C2Config {
		return C2Config{
			QueriesPerCell: 100, Workers: 4, Knobs: knobs, Default: def, BranchTimeout: lowRecallBranchTimeout,
			Corpora: []generation.Corpus{generation.CorpusItem},
			Classes: map[TenantClass][]int{ClassWhale: {0}}, ItemLimit: limits, TagLimit: tagLimits,
		}
	}
	rep, err := forcedH.RunC2(ctx, c2cfg(forced, forced, sane))
	if err != nil {
		t.Fatalf("C2 (forced pool) failed, error class %s: %v", errClass(err), err)
	}
	ctlRep, err := plain.RunC2(ctx, c2cfg(DefaultKnob(), DefaultKnob()))
	if err != nil {
		t.Fatalf("C2 (control pool) failed, error class %s: %v", errClass(err), err)
	}
	cellOf := func(r *C2Report, label string) CellAgg {
		for _, c := range r.Cells {
			if c.Knob == label {
				return c
			}
		}
		t.Fatalf("no cell for knob %s", label)
		return CellAgg{}
	}

	// 1. The negative control physically runs on HNSW.
	bad := cellOf(rep, forced.Label)
	t.Logf("forced cell: %s", cellEvidence(bad))
	var jit string
	if err := forcedH.Pool.QueryRow(ctx, "SHOW jit").Scan(&jit); err != nil || jit != "off" {
		t.Fatalf("forced pool must run with jit off (SHOW jit = %q, error class %s)", jit, errClass(err))
	}
	if len(rep.PlannerOverrides) == 0 {
		t.Fatal("the forced run must record its planner overrides in the report")
	}
	user := sr.Spec.Tenants[0].UserID
	qs := BuildVectorQueries(sr.Gen, generation.CorpusItem, ClassWhale, []int{0}, 1, limits)
	if lines, err := forcedH.explainANNSQL(ctx, generation.CorpusItem, user, qs[0].Vec, forced, false); err == nil {
		t.Logf("EXPLAIN of the ANN SQL under the self-check settings:\n%s", strings.Join(lines, "\n"))
	}
	if nat := plain.ANNPlanEvidence(ctx, generation.CorpusItem, user, qs[0].Vec, forced); nat != nil {
		t.Logf("planner's own choice on the default pool (why the override exists): uses_hnsw=%v problem=%q", nat.UsesHNSW, nat.Problem)
	}
	if bad.Plan == nil || !bad.Plan.UsesHNSW {
		t.Fatalf("the ANN SQL must scan the pruned partition through its HNSW index under the self-check settings, got %+v", bad.Plan)
	}
	if bad.Plan.EmbeddingScans != 1 || bad.Plan.SeqScans != 0 || bad.Plan.IndexAM != "hnsw" {
		t.Fatalf("plan evidence = %+v, want one HNSW index scan and no sequential scan", bad.Plan)
	}

	// 2. The run completed: a timed-out query, an empty path or a short query set
	// is not evidence of a recall collapse (it would also "collapse" on a runner
	// that is merely slow), so recall is only judged after this.
	if bad.TimedOut != 0 || bad.PathCounts[""] != 0 || bad.Queries != 100 {
		t.Fatalf("forced run did not complete cleanly (statement_timeout 57014 / branch deadline, or an empty path): %s; want 100 queries, timed_out=0, empty_path=0", cellEvidence(bad))
	}

	// No query took an exact or fallback path.
	for path, n := range bad.PathCounts {
		if n > 0 && !IsANNFamily(path) {
			t.Fatalf("forced run took non-ANN path %q (%d queries); the check would be void", path, n)
		}
	}
	if bad.PathCounts["exact"] != 0 || bad.PathCounts["ann_fallback_exact"] != 0 {
		t.Fatalf("forced run paths %v: exact and fallback must be 0", bad.PathCounts)
	}
	if bad.ANNQueries != bad.Queries || bad.FallbackUsed != 0 {
		t.Fatalf("forced run: ann %d of %d queries, fallback used %d; want all ANN and no fallback", bad.ANNQueries, bad.Queries, bad.FallbackUsed)
	}

	// 3. The shared evaluator fails the recall collapse.
	if v := EvaluateC2R(rep.Cells, forced.Label); !v.Applicable || v.Pass {
		t.Fatalf("harness failed to catch ef_search=1 recall collapse (recall %.4f): %+v", bad.RecallMean, v)
	}

	// Control: default knobs on the default planner take the exact path.
	ctl := cellOf(ctlRep, DefaultKnob().Label)
	t.Logf("control cell: %s exact_recall=%.4f", cellEvidence(ctl), ctl.ExactRecallMean)
	if ctl.TimedOut != 0 || ctl.PathCounts[""] != 0 {
		t.Fatalf("control run did not complete cleanly: %s", cellEvidence(ctl))
	}
	if ctl.PathCounts["exact"] != ctl.Queries || ctl.ExactQueries == 0 {
		t.Fatalf("control (default knobs, 4000 items <= 5000) must take the exact path: %v", ctl.PathCounts)
	}
	if ctl.ExactRecallMean < 1-1e-9 {
		t.Fatalf("control exact-path recall = %v, want 1.0", ctl.ExactRecallMean)
	}
	if v := EvaluateC2R(ctlRep.Cells, DefaultKnob().Label); v.Applicable && !v.Pass {
		t.Fatalf("control must not fail C2-R: %+v", v)
	}
	o := cellOf(rep, sane.Label)
	t.Logf("informational forced-ANN control (ef=100): %s plan=%s", cellEvidence(o), o.PlanLabel())
	if n := totalCrossTenant(rep.Cells) + totalCrossTenant(ctlRep.Cells); n != 0 {
		t.Fatalf("cross-tenant rows in self-check: %d", n)
	}
}

// TestBenchHarnessUsesDefaultPlanner: the benchmark's harness has no session or
// planner overrides; they exist only for the low-recall self-check.
func TestBenchHarnessUsesDefaultPlanner(t *testing.T) {
	if cfg := benchHarnessConfig(); len(cfg.SessionSQL) != 0 || !cfg.Semantic || cfg.PoolMaxConns != 0 {
		t.Fatalf("benchmark harness config = %+v: want the production pool and no SessionSQL", cfg)
	}
	for _, s := range lowRecallPlannerOverrides {
		if !strings.HasPrefix(s, "SET enable_") && s != "SET jit = off" {
			t.Fatalf("unexpected self-check override %q", s)
		}
	}
}

// TestParseANNPlan pins how plan evidence is derived from EXPLAIN text: HNSW only
// when exactly one embedding partition is scanned by an HNSW index scan.
func TestParseANNPlan(t *testing.T) {
	const tail = `  ->  Nested Loop
        ->  CTE Scan on ann a
        ->  Index Scan using item_pkey on item i
              Index Cond: (id = a.target_id)`
	hnsw := []string{
		"Sort",
		"  CTE ann",
		"    ->  Limit",
		"          ->  Index Scan using item_embedding_g1_p2_hnsw on item_embedding_g1_p2 e",
		"                Order By: (embedding <=> '[0.1,0.2,0.3]'::vector)",
		tail,
	}
	am := func(idx string) string {
		return map[string]string{"item_embedding_g1_p2_hnsw": "hnsw", "item_embedding_g1_p2_pkey": "btree"}[idx]
	}
	if ev := ParseANNPlan(hnsw, "item_embedding_g1", am); !ev.UsesHNSW || ev.Relation != "item_embedding_g1_p2" ||
		ev.IndexAM != "hnsw" || ev.EmbeddingScans != 1 || ev.SeqScans != 0 || len(ev.Plan) != 0 {
		t.Fatalf("pruned HNSW scan: %+v", ev)
	}
	seq := []string{
		"CTE ann",
		"  ->  Limit",
		"        ->  Sort",
		"              Sort Key: ((e.embedding <=> '[0.1,0.2,0.3]'::vector))",
		"              ->  Seq Scan on item_embedding_g1_p2 e",
		tail,
	}
	ev := ParseANNPlan(seq, "item_embedding_g1", am)
	if ev.UsesHNSW || ev.SeqScans != 1 || !strings.Contains(ev.Problem, "not an index scan") {
		t.Fatalf("sequential scan must not count as HNSW: %+v", ev)
	}
	if strings.Contains(strings.Join(ev.Plan, "\n"), "0.1,0.2") || !strings.Contains(strings.Join(ev.Plan, "\n"), "'[vector]'") {
		t.Fatalf("plan text must have its vector literal scrubbed: %v", ev.Plan)
	}
	pk := []string{"CTE ann", "  ->  Sort", "        ->  Index Scan using item_embedding_g1_p2_pkey on item_embedding_g1_p2 e", tail}
	if ev := ParseANNPlan(pk, "item_embedding_g1", am); ev.UsesHNSW || !strings.Contains(ev.Problem, "not an HNSW index") {
		t.Fatalf("btree index scan must not count as HNSW: %+v", ev)
	}
	unpruned := []string{
		"CTE ann", "  ->  Append",
		"        ->  Index Scan using item_embedding_g1_p0_hnsw on item_embedding_g1_p0 e_1",
		"        ->  Index Scan using item_embedding_g1_p1_hnsw on item_embedding_g1_p1 e_2",
		tail,
	}
	if ev := ParseANNPlan(unpruned, "item_embedding_g1", func(string) string { return "hnsw" }); ev.UsesHNSW || ev.EmbeddingScans != 2 {
		t.Fatalf("an unpruned Append must not count as one HNSW partition scan: %+v", ev)
	}
	onParent := []string{"CTE ann", "  ->  Index Scan using item_embedding_g1_hnsw on item_embedding_g1 e", tail}
	if ev := ParseANNPlan(onParent, "item_embedding_g1", func(string) string { return "hnsw" }); ev.UsesHNSW {
		t.Fatalf("the parent table is not a pruned partition: %+v", ev)
	}
	if ev := ParseANNPlan([]string{"Result"}, "item_embedding_g1", am); ev.UsesHNSW || ev.Problem == "" {
		t.Fatalf("a plan without an embedding scan must not count as HNSW: %+v", ev)
	}

	// A cell with ANN queries and a non-HNSW plan is surfaced, not hidden.
	cell := AggregateCell("item", "whale", "k", []QueryOutcome{annOutcome(ids(20), ids(20), "ann", false, false, 9000)})
	cell.Plan = &ev
	if got := NonHNSWANNCells([]CellAgg{cell}); len(got) != 1 || !strings.Contains(got[0], "item/whale/k") {
		t.Fatalf("NonHNSWANNCells = %v", got)
	}
	if !strings.HasPrefix(cell.PlanLabel(), "NOT HNSW") {
		t.Fatalf("plan label = %q", cell.PlanLabel())
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
