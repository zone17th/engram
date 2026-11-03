//go:build searchbench

package searchbench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/reconcile"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
)

// Pure self-checks of the Task 23 harness additions (advisor-dec-337): partial
// aggregation, the sanitized server-logs artifact, the lexical plan parser, the
// representative query derivation, the coverage-gap classifier and the report
// sections. None needs a database.

const planJSONMixed = `[{"Plan":{"Node Type":"Limit","Shared Hit Blocks":120,"Shared Read Blocks":7,"Plans":[
 {"Node Type":"Sort","Plans":[
  {"Node Type":"Nested Loop","Plans":[
   {"Node Type":"CTE Scan","CTE Name":"q"},
   {"Node Type":"Bitmap Heap Scan","Relation Name":"item","Plans":[
     {"Node Type":"BitmapOr","Plans":[
       {"Node Type":"Bitmap Index Scan","Index Name":"item_user_unaccent_prefix"},
       {"Node Type":"Bitmap Index Scan","Index Name":"item_name_trgm"},
       {"Node Type":"Bitmap Index Scan","Index Name":"item_user_name_trgm"}]}]}]}]}]},
 "Planning Time":0.41,"Execution Time":12.75}]`

// TestLexicalPlanParser (FU-SL-1): index names, classes, seq scans (only of item/tag),
// buffers and times are read from the EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) text.
func TestLexicalPlanParser(t *testing.T) {
	p, err := ParseLexicalPlan([]byte(planJSONMixed))
	if err != nil {
		t.Fatal(err)
	}
	wantIdx := []string{"item_name_trgm", "item_user_name_trgm", "item_user_unaccent_prefix"}
	if strings.Join(p.Indexes, ",") != strings.Join(wantIdx, ",") {
		t.Errorf("indexes = %v, want %v", p.Indexes, wantIdx)
	}
	if !p.UsesGlobal || !p.UsesUser || p.SeqScan {
		t.Errorf("flags global=%v per-user=%v seq=%v, want true true false", p.UsesGlobal, p.UsesUser, p.SeqScan)
	}
	if p.ExecMs != 12.75 || p.PlanningMs != 0.41 || p.SharedHit != 120 || p.SharedRead != 7 || p.TopNode != "Limit" {
		t.Errorf("times/buffers = %+v", p)
	}
	if got := p.Label(); got != "item_name_trgm (global-trgm), item_user_name_trgm (per-user), item_user_unaccent_prefix (per-user)" {
		t.Errorf("label = %q", got)
	}

	seq := `[{"Plan":{"Node Type":"Gather","Plans":[{"Node Type":"Seq Scan","Relation Name":"item","Parallel Aware":true}]},"Execution Time":80.1}]`
	if p, err := ParseLexicalPlan([]byte(seq)); err != nil || !p.SeqScan || len(p.Indexes) != 0 || p.Label() != "-" {
		t.Errorf("parallel seq scan on item must be flagged: %+v err=%v", p, err)
	}
	notTable := `[{"Plan":{"Node Type":"Seq Scan","Relation Name":"some_function_or_cte"},"Execution Time":1}]`
	if p, _ := ParseLexicalPlan([]byte(notTable)); p.SeqScan {
		t.Errorf("a seq scan of a non item/tag relation is not a table seq scan")
	}
	for _, bad := range []string{``, `not json`, `[]`, `[{"Execution Time":1}]`} {
		if _, err := ParseLexicalPlan([]byte(bad)); err == nil {
			t.Errorf("ParseLexicalPlan(%q) must fail", bad)
		}
	}
	for name, want := range map[string]string{
		"item_user_unaccent_prefix": IndexPerUser, "item_user_name_trgm": IndexPerUser, "tag_user_unaccent_prefix": IndexPerUser, "tag_user_tag_trgm": IndexPerUser,
		"item_name_trgm": IndexGlobalTrgm, "tag_norm_trgm": IndexGlobalTrgm, "item_pkey": IndexOther, "item_user_recent": IndexOther,
	} {
		if got := IndexClassOf(name); got != want {
			t.Errorf("IndexClassOf(%s) = %s, want %s", name, got, want)
		}
	}
}

// TestLexicalPlanQueriesAreDeterministic: the representative queries of the plan
// evidence and the connect probe are deterministic, distinct, three per (corpus,
// shape), 1 rune for the prefix shape and >= 3 runes for the fuzzy shape, and the
// tenant choice follows the profile (smoke: whale only; full: whale + median medium).
func TestLexicalPlanQueriesAreDeterministic(t *testing.T) {
	lex, err := LoadDefaultLexicon()
	if err != nil {
		t.Fatal(err)
	}
	g, err := NewGenerator(ProfileSmoke, DefaultSeed, DefaultPartitions, lex)
	if err != nil {
		t.Fatal(err)
	}
	spec := g.Profile()
	classes := ClassifyTenants(spec)
	pts := planTenantsOf(spec, classes, true)
	if len(pts) != 1 || pts[0].Class != string(ClassWhale) {
		t.Fatalf("smoke tenants = %+v, want the whale only (no medium class in smoke)", pts)
	}
	a := planCases(g, pts, 3)
	b := planCases(g, pts, 3)
	if len(a) != 12 {
		t.Fatalf("smoke cases = %d, want 12 (item/tag x prefix/fuzzy x 3)", len(a))
	}
	ids := map[string]bool{}
	for i, c := range a {
		if c != b[i] {
			t.Fatalf("case %d differs between runs: %+v vs %+v", i, c, b[i])
		}
		if ids[c.ID] {
			t.Errorf("duplicate case id %s", c.ID)
		}
		ids[c.ID] = true
		n := len([]rune(c.QN))
		switch c.Shape {
		case shapePrefix:
			if n != 1 || c.Fuzzy {
				t.Errorf("%s: prefix shape must be one rune and fuzzy=false, got %d runes fuzzy=%v", c.ID, n, c.Fuzzy)
			}
		case shapeFuzzy:
			if n < 3 || !c.Fuzzy {
				t.Errorf("%s: fuzzy shape must be >= 3 runes and fuzzy=true, got %d runes fuzzy=%v", c.ID, n, c.Fuzzy)
			}
		}
		if !strings.HasPrefix(c.ID, "whale/") {
			t.Errorf("case id %q must start with the tenant class", c.ID)
		}
	}
	for _, corpus := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		for _, shape := range []string{shapePrefix, shapeFuzzy} {
			qs := lexicalPlanQueries(g, pts[0].Index, corpus, shape, 3)
			uniq := map[string]bool{}
			for _, q := range qs {
				uniq[q] = true
			}
			if len(qs) != 3 || len(uniq) != 3 {
				t.Errorf("%s/%s queries = %d, distinct %d, want 3 distinct", corpus, shape, len(qs), len(uniq))
			}
		}
	}

	full, err := BuildProfileSpec(ProfileFull, DefaultSeed, 0)
	if err != nil {
		t.Fatal(err)
	}
	fc := ClassifyTenants(full)
	fp := planTenantsOf(full, fc, true)
	if len(fp) != 2 || fp[0].Class != "whale" || fp[1].Class != "medium" {
		t.Fatalf("full tenants = %+v, want whale + medium", fp)
	}
	m := medianByItems(full, fc[ClassMedium])
	if m != fp[1].Index || m < 0 {
		t.Fatalf("median medium = %d, want %d", m, fp[1].Index)
	}
	smaller, larger := 0, 0
	for _, ti := range fc[ClassMedium] {
		switch c := full.Tenants[ti].ItemCount; {
		case c < full.Tenants[m].ItemCount:
			smaller++
		case c > full.Tenants[m].ItemCount:
			larger++
		}
	}
	if smaller < 1 || larger < 1 {
		t.Errorf("median medium tenant has %d smaller and %d larger siblings, want both >= 1", smaller, larger)
	}
	if medianByItems(full, nil) != -1 {
		t.Errorf("medianByItems of nothing must be -1")
	}
}

// TestLexicalSQLCapture: the plan evidence EXPLAINs the statement and parameter shapes
// the sqlc queries send, not a hand-copied one.
func TestLexicalSQLCapture(t *testing.T) {
	user := uuid.New()
	for _, tc := range []struct {
		corpus generation.Corpus
		fuzzy  bool
		want   string
	}{
		{generation.CorpusItem, true, "name_unaccent"},
		{generation.CorpusItem, false, "name_unaccent"},
		{generation.CorpusTag, true, "tag_unaccent"},
	} {
		c := LexPlanCase{Corpus: tc.corpus, Fuzzy: tc.fuzzy, QN: "wi_fi%"}
		sql, args, err := captureLexicalSQL(context.Background(), c, user, 7)
		if err != nil {
			t.Fatalf("%s: %v", tc.corpus, err)
		}
		if !strings.Contains(sql, tc.want) || !strings.Contains(sql, "$1") {
			t.Errorf("%s: captured SQL is not the lexical statement: %.80s", tc.corpus, sql)
		}
		var sawUser, sawFuzzy, sawLimit bool
		for _, a := range args {
			switch v := a.(type) {
			case uuid.UUID:
				sawUser = v == user
			case bool:
				sawFuzzy = v == tc.fuzzy
			case int32:
				sawLimit = v == 7
			}
		}
		if !sawUser || !sawFuzzy || !sawLimit {
			t.Errorf("%s: args = %v, want the user, fuzzy=%v and limit 7", tc.corpus, args, tc.fuzzy)
		}
	}
	if l := lexicalLimit(); l < 2 || l > 20 {
		t.Errorf("lexical fetch limit = %d, want the corpus cap + 1 of the default request", l)
	}
}

// TestCoverageGapClassification (FU-T19-FLIPCOST): the per-row coverage test matches
// lifecycle.coverageInTx (missing vector / hash / model / model_version) but names the
// gap instead of returning at the first one.
func TestCoverageGapClassification(t *testing.T) {
	g := generation.Generation{ID: 1, Provider: "tei", Model: "bench-model", ModelVersion: "v1", Dims: 1024}
	ident := g.Identity()
	hint := "a hint"
	hash := func(input string) []byte { h := embedding.InputHashFor(ident, input); return h[:] }

	item := store.ScanTargetRow{Name: "Wifi", Hint: &hint, InputHash: hash(embedding.ItemInput("Wifi", hint)), Model: g.Model, ModelVersion: g.ModelVersion}
	if got := classifyCoverage(item, generation.CorpusItem, ident, g); got != gapNone {
		t.Errorf("covered item = %v, want none", got)
	}
	noHint := store.ScanTargetRow{Name: "Wifi", InputHash: hash(embedding.ItemInput("Wifi", "")), Model: g.Model, ModelVersion: g.ModelVersion}
	if got := classifyCoverage(noHint, generation.CorpusItem, ident, g); got != gapNone {
		t.Errorf("covered item without hint = %v, want none", got)
	}
	tag := store.ScanTargetRow{Display: "Travel", InputHash: hash(embedding.TagInput("Travel")), Model: g.Model, ModelVersion: g.ModelVersion}
	if got := classifyCoverage(tag, generation.CorpusTag, ident, g); got != gapNone {
		t.Errorf("covered tag = %v, want none", got)
	}
	cases := map[string]struct {
		row  store.ScanTargetRow
		want coverageGap
	}{
		"missing vector": {store.ScanTargetRow{Name: "Wifi"}, gapMissingVector},
		"stale hash":     {store.ScanTargetRow{Name: "Wifi Renamed", InputHash: item.InputHash, Model: g.Model, ModelVersion: g.ModelVersion}, gapHashMismatch},
		"synthetic hash": {store.ScanTargetRow{Name: "Wifi", InputHash: []byte("not the production hash"), Model: g.Model, ModelVersion: g.ModelVersion}, gapHashMismatch},
		"wrong model":    {store.ScanTargetRow{Name: "Wifi", Hint: &hint, InputHash: item.InputHash, Model: "other", ModelVersion: g.ModelVersion}, gapModelMismatch},
		"wrong version":  {store.ScanTargetRow{Name: "Wifi", Hint: &hint, InputHash: item.InputHash, Model: g.Model, ModelVersion: "v0"}, gapModelMismatch},
	}
	for name, c := range cases {
		if got := classifyCoverage(c.row, generation.CorpusItem, ident, g); got != c.want {
			t.Errorf("%s: gap = %v, want %v", name, got, c.want)
		}
	}
}

func TestErrTagHidesText(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{nil, ""},
		{context.DeadlineExceeded, "deadline_exceeded"},
		{fmt.Errorf("wrapped: %w", context.Canceled), "canceled"},
		{fmt.Errorf("x: %w", &pgconn.PgError{Code: "57014", Message: "canceling statement for user secret-name"}), "pgcode_57014"},
		{errors.New("connect postgres://u:" + "fake@h/db failed"), "error"},
	} {
		if got := errTag(tc.err); got != tc.want {
			t.Errorf("errTag(%v) = %q, want %q", tc.err, got, tc.want)
		}
	}
}

func planInfoOf(idx string, seq bool, ms float64) LexPlanInfo {
	p := LexPlanInfo{ExecMs: ms, SharedHit: 90, SharedRead: 3, SeqScan: seq}
	if idx != "" {
		p.Indexes = []string{idx}
		p.UsesGlobal = IndexClassOf(idx) == IndexGlobalTrgm
		p.UsesUser = IndexClassOf(idx) == IndexPerUser
	}
	return p
}

func genericInfo(idx string, seq bool, ms float64) *LexPlanInfo {
	p := planInfoOf(idx, seq, ms)
	return &p
}

// TestGenericPlanSQLAndEligibility (RV-W4-1-1): the generic-plan EXPLAIN is a PREPARE of
// the captured statement plus an EXPLAIN EXECUTE with one placeholder per argument; the
// arguments are made simple-protocol safe; a generic plan parses like a custom one; and
// the 0010 verdict is "eligible" only when neither plan of any case uses a global
// trigram index.
func TestGenericPlanSQLAndEligibility(t *testing.T) {
	if got := prepareLexicalSQL(genericStmtName(3), "SELECT 1"); got != "PREPARE lexplan_3 AS SELECT 1" {
		t.Errorf("prepare = %q", got)
	}
	if got := explainExecuteSQL(genericStmtName(2), 5); got != "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE lexplan_2($1, $2, $3, $4, $5)" {
		t.Errorf("execute = %q", got)
	}
	if got := explainExecuteSQL("x", 0); got != "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE x()" {
		t.Errorf("execute without args = %q", got)
	}
	u := uuid.New()
	args := simpleProtocolArgs([]any{"q_%", u, true, int32(8)})
	if args[0] != "q_%" || args[1] != u.String() || args[2] != true || args[3] != int32(8) {
		t.Errorf("simple protocol args = %#v", args)
	}
	// The real captured statement is prepared with all its parameters.
	sql, capArgs, err := captureLexicalSQL(context.Background(), LexPlanCase{Corpus: generation.CorpusItem, Fuzzy: true, QN: "wifi"}, u, 7)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(prepareLexicalSQL("lexplan_1", sql), "PREPARE lexplan_1 AS ") || len(capArgs) != 5 {
		t.Errorf("captured statement has %d args, want the 5 placeholders of the lexical query", len(capArgs))
	}
	for i := 1; i <= len(capArgs); i++ {
		if !strings.Contains(sql, "$"+fmt.Sprint(i)) {
			t.Errorf("captured SQL does not use $%d", i)
		}
	}

	// A generic plan (parameters unknown at plan time) parses like a custom one.
	genericJSON := `[{"Plan":{"Node Type":"Limit","Shared Hit Blocks":9,"Plans":[{"Node Type":"Bitmap Heap Scan","Relation Name":"item","Plans":[
	  {"Node Type":"Bitmap Index Scan","Index Name":"item_name_trgm"}]}]},"Planning Time":0.02,"Execution Time":33.5}]`
	gp, err := ParseLexicalPlan([]byte(genericJSON))
	if err != nil || !gp.UsesGlobal || gp.UsesUser || gp.ExecMs != 33.5 {
		t.Errorf("generic plan = %+v err=%v", gp, err)
	}

	clean := func() LexPlanRow {
		return LexPlanRow{Default: planInfoOf("item_user_name_trgm", false, 1), DefaultGeneric: genericInfo("item_user_unaccent_prefix", false, 2)}
	}
	row := func(mod func(*LexPlanRow)) LexPlanRow { r := clean(); mod(&r); return r }
	for name, tc := range map[string]struct {
		rows []LexPlanRow
		want string
	}{
		"no rows":             {nil, NotEstablished0010},
		"all clean":           {[]LexPlanRow{clean(), clean()}, Eligible0010},
		"custom uses global":  {[]LexPlanRow{clean(), row(func(r *LexPlanRow) { r.Default = planInfoOf("tag_norm_trgm", false, 1) })}, NotEligible0010},
		"generic uses global": {[]LexPlanRow{clean(), row(func(r *LexPlanRow) { r.DefaultGeneric = genericInfo("item_name_trgm", false, 1) })}, NotEligible0010},
		"generic missing":     {[]LexPlanRow{clean(), row(func(r *LexPlanRow) { r.DefaultGeneric = nil })}, NotEstablished0010},
		"missing and used":    {[]LexPlanRow{row(func(r *LexPlanRow) { r.DefaultGeneric = nil }), row(func(r *LexPlanRow) { r.Default = planInfoOf("item_name_trgm", false, 1) })}, NotEligible0010},
	} {
		if got := EligibilityOf(tc.rows).Verdict; got != tc.want {
			t.Errorf("%s: verdict = %q, want %q", name, got, tc.want)
		}
	}

	var sb strings.Builder
	w := func(f string, a ...any) { fmt.Fprintf(&sb, f, a...) }
	renderLexicalPlan(w, &LexPlanReport{FetchLimit: 7, IndexesRestored: true, GenericErrors: []string{"after_0010_simulated: pgcode_42P05"},
		Tenants: []LexPlanTenant{{Class: "whale", Items: 10, Tags: 2}},
		Rows:    []LexPlanRow{{ID: "whale/item/prefix/q1", Default: planInfoOf("item_user_name_trgm", false, 1), DefaultGeneric: genericInfo("item_name_trgm", true, 9)}}})
	md := sb.String()
	for _, want := range []string{
		"**Generic plans**", "| whale/item/prefix/q1 | item_name_trgm (global-trgm) | **yes** | 9.00 | 90 / 3 | - | - | - | - |",
		"0010 eligibility: not eligible.", "Generic-plan EXPLAIN failed (after_0010_simulated: pgcode_42P05)",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("generic-plan Markdown must contain %q:\n%s", want, md)
		}
	}
}

func extrasFixture() *Report {
	info := planInfoOf
	after := info("item_user_name_trgm", false, 6.5)
	return &Report{
		Run:  RunInfo{Profile: string(ProfileFull)},
		Seed: &SeedSummary{Timings: SeedTimings{HNSWItem: 410, HNSWTag: 60}, HNSW: []HNSWBuild{{Corpus: "item", Part: "item_embedding_g1_p3", Rows: 30000, Seconds: 52.5}, {Corpus: "tag", Part: "tag_embedding_g1_p1", Rows: 6000, Seconds: 8.25}}},
		Extras: &Task23Extras{
			Reconcile: &ReconcileTiming{Ms: 41234, Mode: "dry_run", Scope: "all", Result: reconcile.Result{Scanned: 500000, WouldEnqueue: 500000}, Note: "dry run note"},
			FlipCost: &FlipCostReport{TotalMs: 20500, PageSize: 5000, Pages: 104, Rows: 500000, Gaps: 500000, Note: "flip note", Corpora: []FlipCorpusScan{
				{Corpus: "item", Pages: 86, Rows: 426000, Gaps: 426000, ScanMs: 17000}, {Corpus: "tag", Pages: 18, Rows: 85000, Gaps: 85000, ScanMs: 3300}}},
			LexicalPlan: &LexPlanReport{FetchLimit: 7, IndexesRestored: true, Notes: []string{"a | b note"},
				Tenants: []LexPlanTenant{{Class: "whale", Items: 100000, Tags: 20000}},
				Rows: []LexPlanRow{
					{ID: "whale/item/fuzzy/q1", Class: "whale", Corpus: "item", Shape: "fuzzy", Default: info("item_name_trgm", false, 31.2), After0010: &after,
						DefaultGeneric: genericInfo("item_name_trgm", false, 44.5), After0010Generic: genericInfo("", true, 120)},
					{ID: "whale/tag/prefix/q2", Class: "whale", Corpus: "tag", Shape: "prefix", Default: info("", true, 55), After0010: &after},
				}},
			ConnectProbe: &ConnectProbeReport{N: 20, Notes: []string{"probe note"}, Shapes: []ConnectProbeShape{{Shape: "whale_fuzzy", N: 20, Connect: MsStats{P50Ms: 4, P95Ms: 9, MaxMs: 12}, First: MsStats{P50Ms: 14, P95Ms: 48, MaxMs: 50}, Second: MsStats{P50Ms: 3, P95Ms: 5, MaxMs: 6}, FirstTimeouts: 1}}},
			Errors:       []string{"flip_cost_scan: deadline_exceeded"},
		},
	}
}

// TestTask23SummaryAndMarkdown: the full-volume summary lists the per-partition HNSW
// build next to the in-lock coverage scan and the Reconcile time; the lexical plan and
// connect probe sections render with well-formed tables, case ids only; a failed
// extra becomes a warning, never a hard failure.
func TestTask23SummaryAndMarkdown(t *testing.T) {
	rep := extrasFixture()
	rows := Task23SummaryRows(rep)
	if len(rows) != 4 {
		t.Fatalf("summary rows = %d, want HNSW, flip scan, Reconcile, failed extra: %+v", len(rows), rows)
	}
	if !strings.HasPrefix(rows[0].Metric, "HNSW build per partition") || !strings.Contains(rows[0].Value, "slowest item/item_embedding_g1_p3 52.50 s over 30000 rows") || !strings.Contains(rows[0].Value, "sum 60.8 s") {
		t.Errorf("HNSW row = %+v", rows[0])
	}
	if !strings.Contains(rows[1].Metric, "FU-T19-FLIPCOST") || !strings.Contains(rows[1].Value, "20500 ms total, 104 pages of 5000, 500000 rows, 500000 gaps") {
		t.Errorf("flip row = %+v", rows[1])
	}
	if !strings.Contains(rows[2].Metric, "Reconcile full time") || !strings.Contains(rows[2].Value, "41234 ms, scanned 500000, would_enqueue 500000") {
		t.Errorf("reconcile row = %+v", rows[2])
	}
	FinalizeReport(rep, MinMeasuredPerScenario)
	if len(rep.Hard) != 0 {
		t.Errorf("an extras failure must not be a hard failure: %v", rep.Hard)
	}
	var warned bool
	for _, w := range rep.Warnings {
		if strings.Contains(w, "flip_cost_scan: deadline_exceeded") {
			warned = true
		}
	}
	if !warned {
		t.Errorf("a failed extra must become a warning: %v", rep.Warnings)
	}

	md := RenderMarkdown(rep)
	for _, want := range []string{
		"## Lexical plan (FU-SL-1)", "After 0010 (simulated)", "| whale/item/fuzzy/q1 | item_name_trgm (global-trgm) | no | 31.20 | 90 / 3 | item_user_name_trgm (per-user) | no | 6.50 | 90 / 3 |",
		"| whale/tag/prefix/q2 | - | **yes** | 55.00 |", "global trigram index is used in **1 of 2** cases",
		"## Connect-cost probe (FU-SB-2b)", "| whale_fuzzy | 20 | 4 / 9 / 12 | 0 / 0 / 0 | 14 / 48 / 50 | 3 / 5 / 6 | 1 | 0 |",
		"**Generic plans**", "0010 eligibility: not eligible.", "## Task 23 summary - full-volume timings", "HNSW build per partition", "Reconcile full time", "flip note", "dry run note",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("Markdown must contain %q", want)
		}
	}
	if errs := mdTableShapeErrors(md); len(errs) > 0 {
		t.Errorf("Markdown table shape: %v", errs)
	}
	hnsw, flip, rec := strings.Index(md, "| HNSW build per partition"), strings.Index(md, "| Flip/rollback"), strings.Index(md, "| Reconcile full time")
	if hnsw < 0 || !(hnsw < flip && flip < rec) {
		t.Errorf("summary order must be HNSW, flip scan, Reconcile (got %d, %d, %d)", hnsw, flip, rec)
	}
	b, err := json.Marshal(rep)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"task23_extras"`, `"flip_cost_scan"`, `"reconcile_full"`, `"lexical_plan"`, `"connect_probe"`, `"after_0010_simulated"`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("JSON must contain %s", want)
		}
	}
	if cfg := ExtrasConfigFor(ProfileSmoke); cfg.ProbeN != 5 || cfg.PlanMedium || cfg.ProbeMedium {
		t.Errorf("smoke extras = %+v, want N=5, whale only", cfg)
	}
	if cfg := ExtrasConfigFor(ProfileFull); cfg.ProbeN != 20 || !cfg.PlanMedium || !cfg.ProbeMedium || cfg.PlanQueries != 3 {
		t.Errorf("full extras = %+v, want N=20, whale + medium, 3 queries", cfg)
	}
}

// TestExtrasBudgetAndTestDeadline (RV-W4-1-2): the benchmark context ends before the
// `go test -timeout` (so t.Cleanup can still write the report), the extras carry a
// per-profile total budget, a section that never started is recorded as
// "<section>: skipped_budget", and a failing section does not stop the next one.
func TestExtrasBudgetAndTestDeadline(t *testing.T) {
	now := time.Now()
	ctx, cancel := BenchContext(context.Background(), 5*time.Hour, now.Add(140*time.Minute), true, testDeadlineReserve)
	dl, _ := ctx.Deadline()
	cancel()
	if want := now.Add(135 * time.Minute); dl.Before(want.Add(-time.Second)) || dl.After(want.Add(time.Second)) {
		t.Errorf("deadline = %v, want test deadline - 5m (%v)", dl, want)
	}
	ctx, cancel = BenchContext(context.Background(), time.Minute, now.Add(140*time.Minute), true, testDeadlineReserve)
	dl, _ = ctx.Deadline()
	cancel()
	if dl.After(now.Add(time.Minute + time.Second)) {
		t.Errorf("the own limit must win when it is earlier: %v", dl)
	}
	ctx, cancel = BenchContext(context.Background(), time.Hour, time.Time{}, false, testDeadlineReserve)
	dl, _ = ctx.Deadline()
	cancel()
	if dl.After(now.Add(time.Hour + time.Second)) {
		t.Errorf("without a test deadline the own limit applies: %v", dl)
	}

	if full, smoke := ExtrasConfigFor(ProfileFull).TotalBudget, ExtrasConfigFor(ProfileSmoke).TotalBudget; full != 25*time.Minute || smoke != 4*time.Minute {
		t.Errorf("extras budgets = full %v smoke %v, want 25m and 4m", full, smoke)
	}

	var ran []string
	logf := func(string, ...any) {}
	section := func(name string, fn func(context.Context) error) extraSection {
		return extraSection{name, time.Hour, func(ctx context.Context) error {
			ran = append(ran, name)
			return fn(ctx)
		}}
	}
	// Budget of 50 ms: the first section waits for it, the next two never start.
	bctx, bcancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer bcancel()
	errs := runExtraSections(bctx, []extraSection{
		section("reconcile_full", func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }),
		section("flip_cost_scan", func(context.Context) error { return nil }),
		section("lexical_plan", func(context.Context) error { return nil }),
	}, logf)
	want := []string{"reconcile_full: deadline_exceeded", "flip_cost_scan: skipped_budget", "lexical_plan: skipped_budget"}
	if strings.Join(errs, "|") != strings.Join(want, "|") || len(ran) != 1 {
		t.Errorf("errors = %v (ran %v), want %v and only the first section started", errs, ran, want)
	}

	// A failing section does not stop the next one; a clean run records nothing.
	ran = nil
	errs = runExtraSections(context.Background(), []extraSection{
		section("a", func(context.Context) error { return errors.New("boom") }),
		section("b", func(context.Context) error { return nil }),
	}, logf)
	if len(errs) != 1 || errs[0] != "a: error" || len(ran) != 2 {
		t.Errorf("errors = %v ran = %v, want a: error and both sections run", errs, ran)
	}
	if got := skippedBudget("connect_probe"); got != "connect_probe: skipped_budget" {
		t.Errorf("tag = %q", got)
	}
}
