package embedding

import (
	"math"
	"strings"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
)

func TestSelectThreshold(t *testing.T) {
	t.Parallel()

	// Helper to build a synthetic result slice with predetermined cosines.
	calBuildResults := func(relatedCos, unrelatedCos []float64) []EvalResult {
		out := make([]EvalResult, 0, len(relatedCos)+len(unrelatedCos))
		for i, c := range relatedCos {
			out = append(out, EvalResult{ID: "r", Label: "related", Cos: c + float64(i)*0})
		}
		for i, c := range unrelatedCos {
			out = append(out, EvalResult{ID: "u", Label: "unrelated", Cos: c + float64(i)*0})
		}
		return out
	}

	tests := []struct {
		name          string
		results       []EvalResult
		wantThreshold float64
		wantPrecision float64
		wantRecall    float64
		wantFPR       float64
		wantDecision  string
	}{
		{
			name: "known distribution picks smallest grid t with FPR <= 5% and recall >= 0.60",
			// 10 related: 8 at 0.75, 2 at 0.50 -> at t=0.62, TP=8, recall=0.80.
			// 20 unrelated: 18 at 0.35, 1 at 0.61, 1 at 0.70 -> at t=0.61 FP=2 (FPR=0.10 > 0.05),
			// at t=0.62 FP=1 (FPR=1/20=0.05 <= 0.05). Precision = 8 / (8+1) = 8/9.
			results: calBuildResults(
				[]float64{0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.50, 0.50},
				[]float64{
					0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35,
					0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35, 0.61, 0.70,
				},
			),
			wantThreshold: 0.62,
			wantPrecision: 8.0 / 9.0,
			wantRecall:    0.80,
			wantFPR:       0.05,
			wantDecision:  CalDecisionOK,
		},
		{
			name: "FPR exactly 5% boundary on grid minimum 0.30 is accepted",
			// 5 related all at 0.80 (recall = 1.0).
			// 20 unrelated: 19 at 0.10, 1 at 0.30 -> at t=0.30, FP=1, FPR=1/20=0.05.
			results: calBuildResults(
				[]float64{0.80, 0.80, 0.80, 0.80, 0.80},
				[]float64{
					0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10,
					0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.30,
				},
			),
			wantThreshold: 0.30,
			wantPrecision: 5.0 / 6.0,
			wantRecall:    1.00,
			wantFPR:       0.05,
			wantDecision:  CalDecisionOK,
		},
		{
			name: "recall exactly 0.60 boundary is ok",
			// 10 related: 6 at 0.70, 4 at 0.40 -> at t=0.55, recall = 6/10 = 0.60.
			// 20 unrelated: 20 at 0.20 -> at t=0.30 FP=0, wait: make 2 unrelated at 0.54 so t=0.55 is chosen.
			results: calBuildResults(
				[]float64{0.70, 0.70, 0.70, 0.70, 0.70, 0.70, 0.40, 0.40, 0.40, 0.40},
				[]float64{
					0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20,
					0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.54, 0.54,
				},
			),
			wantThreshold: 0.55,
			wantPrecision: 1.00,
			wantRecall:    0.60,
			wantFPR:       0.00,
			wantDecision:  CalDecisionOK,
		},
		{
			name: "recall below 0.60 at chosen t returns decision_required",
			// 10 related: 5 at 0.80, 5 at 0.40 -> at t=0.60, recall = 0.50 < 0.60.
			// 20 unrelated: 18 at 0.20, 2 at 0.59 -> smallest t with FPR <= 0.05 is 0.60 (FP=0).
			results: calBuildResults(
				[]float64{0.80, 0.80, 0.80, 0.80, 0.80, 0.40, 0.40, 0.40, 0.40, 0.40},
				[]float64{
					0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20,
					0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.59, 0.59,
				},
			),
			wantThreshold: 0.60,
			wantPrecision: 1.00,
			wantRecall:    0.50,
			wantFPR:       0.00,
			wantDecision:  CalDecisionRequired,
		},
		{
			name: "zero positives at chosen t sets precision to 0 and decision_required",
			// All related below 0.50, unrelated force t=0.60.
			results: calBuildResults(
				[]float64{0.40, 0.45, 0.49},
				[]float64{
					0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20,
					0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.20, 0.59, 0.59,
				},
			),
			wantThreshold: 0.60,
			wantPrecision: 0.00,
			wantRecall:    0.00,
			wantFPR:       0.00,
			wantDecision:  CalDecisionRequired,
		},
		{
			name: "no t on grid satisfies FPR <= 0.05 returns decision_required",
			// 2 out of 10 unrelated have cos 0.95 -> FPR >= 0.20 across entire 0.30..0.90 grid.
			results: calBuildResults(
				[]float64{0.95, 0.95, 0.95, 0.95, 0.95},
				[]float64{0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.95, 0.95},
			),
			wantThreshold: 0,
			wantPrecision: 0,
			wantRecall:    0,
			wantFPR:       0,
			wantDecision:  CalDecisionRequired,
		},
		{
			name:          "empty input returns decision_required",
			results:       nil,
			wantThreshold: 0,
			wantPrecision: 0,
			wantRecall:    0,
			wantFPR:       0,
			wantDecision:  CalDecisionRequired,
		},
		{
			name:          "only related rows returns decision_required",
			results:       calBuildResults([]float64{0.85, 0.90}, nil),
			wantThreshold: 0,
			wantPrecision: 0,
			wantRecall:    0,
			wantFPR:       0,
			wantDecision:  CalDecisionRequired,
		},
		{
			name:          "only unrelated rows returns decision_required",
			results:       calBuildResults(nil, []float64{0.15, 0.20}),
			wantThreshold: 0,
			wantPrecision: 0,
			wantRecall:    0,
			wantFPR:       0,
			wantDecision:  CalDecisionRequired,
		},
		{
			name:          "unrelated NaN fails closed with decision_required",
			results:       calBuildResults([]float64{0.80}, []float64{math.NaN()}),
			wantThreshold: 0,
			wantPrecision: 0,
			wantRecall:    0,
			wantFPR:       0,
			wantDecision:  CalDecisionRequired,
		},
		{
			name:          "related +Inf with unrelated -Inf fails closed with decision_required",
			results:       calBuildResults([]float64{math.Inf(1)}, []float64{math.Inf(-1)}),
			wantThreshold: 0,
			wantPrecision: 0,
			wantRecall:    0,
			wantFPR:       0,
			wantDecision:  CalDecisionRequired,
		},
		{
			name:          "cos outside [-1, 1] fails closed with decision_required",
			results:       calBuildResults([]float64{1.5}, []float64{0.10}),
			wantThreshold: 0,
			wantPrecision: 0,
			wantRecall:    0,
			wantFPR:       0,
			wantDecision:  CalDecisionRequired,
		},
		{
			name: "unknown label fails closed with decision_required",
			results: []EvalResult{
				{ID: "r1", Label: "related", Cos: 0.85},
				{ID: "u1", Label: "unrelated", Cos: 0.15},
				{ID: "x1", Label: "unknown", Cos: 0.20},
			},
			wantThreshold: 0,
			wantPrecision: 0,
			wantRecall:    0,
			wantFPR:       0,
			wantDecision:  CalDecisionRequired,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := SelectThreshold(tc.results)
			if got.Decision != tc.wantDecision {
				t.Fatalf("Decision = %q, want %q (got=%+v)", got.Decision, tc.wantDecision, got)
			}
			if math.Abs(got.Threshold-tc.wantThreshold) > 1e-9 {
				t.Errorf("Threshold = %.12f, want %.12f", got.Threshold, tc.wantThreshold)
			}
			if math.Abs(got.Precision-tc.wantPrecision) > 1e-9 {
				t.Errorf("Precision = %.12f, want %.12f", got.Precision, tc.wantPrecision)
			}
			if math.Abs(got.Recall-tc.wantRecall) > 1e-9 {
				t.Errorf("Recall = %.12f, want %.12f", got.Recall, tc.wantRecall)
			}
			if math.Abs(got.FPR-tc.wantFPR) > 1e-9 {
				t.Errorf("FPR = %.12f, want %.12f", got.FPR, tc.wantFPR)
			}
		})
	}
}

func TestCalibrationLookupFor(t *testing.T) {
	t.Parallel()

	entries := CalibrationEntries()
	if len(entries) == 0 {
		t.Fatal("CalibrationEntries() returned empty slice")
	}
	fakeEntry := entries[0]

	validFakeID := embedid.Identity{
		Provider:      FakeEmbedProvider,
		Model:         FakeEmbedModel,
		ModelVersion:  FakeEmbedModelSHA + ";qp=e3b0c442;dp=e3b0c442",
		Dims:          1024,
		QueryPrefix:   "",
		DocPrefix:     "",
		Preprocessing: "v1",
	}

	tests := []struct {
		name       string
		appEnv     string
		id         embedid.Identity
		wantOK     bool
		wantMinCos float64
		wantReport string
	}{
		{
			name:       "fake entry accepted in development",
			appEnv:     "development",
			id:         validFakeID,
			wantOK:     true,
			wantMinCos: fakeEntry.MinCos,
			wantReport: fakeEntry.ReportPath,
		},
		{
			name:       "fake entry accepted in staging",
			appEnv:     "staging",
			id:         validFakeID,
			wantOK:     true,
			wantMinCos: fakeEntry.MinCos,
			wantReport: fakeEntry.ReportPath,
		},
		{
			name:       "fake entry ignores dims and prefix fields on Identity when ModelVersion matches prefix",
			appEnv:     "development",
			id:         embedid.Identity{Provider: FakeEmbedProvider, Model: FakeEmbedModel, ModelVersion: "fakeembed-v1;qp=11111111;dp=22222222", Dims: 768, QueryPrefix: "query: ", DocPrefix: "passage: ", Preprocessing: "v2"},
			wantOK:     true,
			wantMinCos: fakeEntry.MinCos,
			wantReport: fakeEntry.ReportPath,
		},
		{
			name:   "fake entry rejected in production",
			appEnv: "production",
			id:     validFakeID,
			wantOK: false,
		},
		{
			name:   "fake entry rejected when appEnv is empty",
			appEnv: "",
			id:     validFakeID,
			wantOK: false,
		},
		{
			name:   "fake entry rejected when appEnv is prod",
			appEnv: "prod",
			id:     validFakeID,
			wantOK: false,
		},
		{
			name:   "fake entry rejected when appEnv has wrong case",
			appEnv: "Production",
			id:     validFakeID,
			wantOK: false,
		},
		{
			name:   "fake entry rejected when appEnv is Development with capital D",
			appEnv: "Development",
			id:     validFakeID,
			wantOK: false,
		},
		{
			name:   "wrong provider is not ok",
			appEnv: "development",
			id: embedid.Identity{
				Provider:     "openai_compat",
				Model:        FakeEmbedModel,
				ModelVersion: validFakeID.ModelVersion,
			},
			wantOK: false,
		},
		{
			name:   "wrong model is not ok",
			appEnv: "development",
			id: embedid.Identity{
				Provider:     FakeEmbedProvider,
				Model:        "tei/BAAI/bge-m3",
				ModelVersion: validFakeID.ModelVersion,
			},
			wantOK: false,
		},
		{
			name:   "wrong model sha prefix is not ok",
			appEnv: "development",
			id: embedid.Identity{
				Provider:     FakeEmbedProvider,
				Model:        FakeEmbedModel,
				ModelVersion: "fakeembed-v2;qp=e3b0c442;dp=e3b0c442",
			},
			wantOK: false,
		},
		{
			name:   "bare model sha without semicolon is not ok",
			appEnv: "development",
			id: embedid.Identity{
				Provider:     FakeEmbedProvider,
				Model:        FakeEmbedModel,
				ModelVersion: FakeEmbedModelSHA,
			},
			wantOK: false,
		},
		{
			name:   "model sha prefix with empty suffix after semicolon is not ok",
			appEnv: "development",
			id: embedid.Identity{
				Provider:     FakeEmbedProvider,
				Model:        FakeEmbedModel,
				ModelVersion: FakeEmbedModelVersionPrefix,
			},
			wantOK: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			lookup := CalibrationLookupFor(tc.appEnv)
			gotMinCos, gotReport, gotOK := lookup(tc.id)
			if gotOK != tc.wantOK {
				t.Fatalf("ok = %v, want %v (minCos=%v, report=%q)", gotOK, tc.wantOK, gotMinCos, gotReport)
			}
			if !tc.wantOK {
				if gotMinCos != 0 || gotReport != "" {
					t.Errorf("rejected lookup returned non-zero (%v, %q), want (0, \"\")", gotMinCos, gotReport)
				}
				return
			}
			if gotMinCos != tc.wantMinCos {
				t.Errorf("minCos = %v, want %v", gotMinCos, tc.wantMinCos)
			}
			if gotReport != tc.wantReport {
				t.Errorf("reportPath = %q, want %q", gotReport, tc.wantReport)
			}
		})
	}
}

// calTestRealEntry is a well-formed real production entry used only to prove the
// guard and the lookup accept a correctly filled slot. It is a test value, never
// registered in calEntries (the registered real entry is calProductionEntry).
func calTestRealEntry() CalibrationEntry {
	return CalibrationEntry{
		Provider:     ProviderOpenAICompat,
		Model:        "openai_compat/openrouter/qwen/qwen3-embedding-8b",
		ModelVersion: OpenAIModelVersion(1024, calTestInstruction),
		MinCos:       0.55,
		ReportPath:   "docs/benchmarks/semantic-eval/report-qwen3-embedding-8b-1024-20261110.json",
	}
}

const calTestInstruction = "Given a short search query, retrieve matching item names or tags"

func calTestRealIdentity(e CalibrationEntry) embedid.Identity {
	return embedid.Identity{
		Provider:      e.Provider,
		Model:         e.Model,
		ModelVersion:  e.ModelVersion,
		Dims:          1024,
		QueryPrefix:   OpenAIQueryPrefix(calTestInstruction),
		DocPrefix:     "",
		Preprocessing: "v1",
	}
}

// TestCalibrationProductionEntryServedAndPlaceholderFailsClosed pins stage
// 24-2: the registered real entry (calProductionEntry) passes the guard and is
// served in production for the identity the production worker builds from the
// documented defaults, while an unfilled placeholder or a malformed real entry
// is still never served.
func TestCalibrationProductionEntryServedAndPlaceholderFailsClosed(t *testing.T) {
	t.Parallel()

	placeholder := CalibrationEntry{}
	if err := calValidateProductionEntry(placeholder); err == nil {
		t.Fatal("unfilled placeholder passed calValidateProductionEntry; it must fail closed")
	}
	if err := calValidateProductionEntry(calProductionEntry); err != nil {
		t.Fatalf("calProductionEntry rejected by the production guard: %v", err)
	}
	var realCount int
	for _, e := range CalibrationEntries() {
		if e == placeholder {
			t.Fatal("a zero-value placeholder is registered in calEntries")
		}
		if !calIsFakeEntry(e) {
			realCount++
			if e != calProductionEntry {
				t.Errorf("calEntries holds an unexpected real entry %q", e.Model)
			}
		}
	}
	if realCount != 1 {
		t.Fatalf("calEntries holds %d real entries, want exactly calProductionEntry", realCount)
	}

	// The identity the production worker builds from the documented defaults.
	id := calTestRealIdentity(calProductionEntry)
	if id.ModelVersion != OpenAIModelVersion(1024, calTestInstruction) {
		t.Fatalf("calProductionEntry model_version %q != OpenAIModelVersion(1024, default instruction)", id.ModelVersion)
	}
	for _, env := range []string{"production", "staging", "development", ""} {
		gotMin, rp, ok := CalibrationLookupFor(env)(id)
		if !ok || gotMin != calProductionEntry.MinCos || rp != calProductionEntry.ReportPath {
			t.Errorf("env %q: production identity = (%v, %q, %v), want (%v, %q, true)", env, gotMin, rp, ok, calProductionEntry.MinCos, calProductionEntry.ReportPath)
		}
	}

	// Even if the placeholder (or any malformed real entry) were put in the
	// table, the lookup must still not serve it.
	bad := calTestRealEntry()
	bad.ReportPath = ""
	for _, env := range []string{"production", "staging", "development", ""} {
		lookup := calLookup([]CalibrationEntry{placeholder, bad}, env)
		if _, _, ok := lookup(calTestRealIdentity(bad)); ok {
			t.Errorf("env %q: lookup served an entry that fails the guard", env)
		}
		if _, _, ok := lookup(embedid.Identity{}); ok {
			t.Errorf("env %q: lookup served the zero identity from a placeholder", env)
		}
	}
}

func TestCalibrationLookupServesFilledRealEntryInEveryEnv(t *testing.T) {
	t.Parallel()

	realEntry := calTestRealEntry()
	if err := calValidateProductionEntry(realEntry); err != nil {
		t.Fatalf("well-formed real entry rejected: %v", err)
	}
	// Fake entries only + the test entry, so the registered production entry
	// (same identity, different MinCos) does not shadow it.
	var table []CalibrationEntry
	for _, e := range CalibrationEntries() {
		if calIsFakeEntry(e) {
			table = append(table, e)
		}
	}
	table = append(table, realEntry)
	for _, env := range []string{"production", "staging", "development", ""} {
		gotMin, rp, ok := calLookup(table, env)(calTestRealIdentity(realEntry))
		if !ok || gotMin != realEntry.MinCos || rp != realEntry.ReportPath {
			t.Errorf("env %q: filled real entry = (%v, %q, %v), want (%v, %q, true)", env, gotMin, rp, ok, realEntry.MinCos, realEntry.ReportPath)
		}
	}

	// The fake entry keeps its behaviour next to a real entry: dev/staging only.
	fakeID := embedid.Identity{Provider: FakeEmbedProvider, Model: FakeEmbedModel, ModelVersion: FakeEmbedModelSHA + ";qp=e3b0c442;dp=e3b0c442"}
	for env, want := range map[string]bool{"development": true, "staging": true, "production": false, "": false} {
		if _, _, ok := calLookup(table, env)(fakeID); ok != want {
			t.Errorf("env %q: fake identity ok=%v, want %v", env, ok, want)
		}
	}

	// A different instruction hash is a different model_version: not served.
	other := calTestRealIdentity(realEntry)
	other.ModelVersion = OpenAIModelVersion(1024, "another instruction")
	if _, _, ok := calLookup(table, "production")(other); ok {
		t.Error("identity with a different instr hash was served")
	}
}

func TestCalibrationValidateProductionEntryRejectsEachBadField(t *testing.T) {
	t.Parallel()

	mut := func(f func(e *CalibrationEntry)) CalibrationEntry {
		e := calTestRealEntry()
		f(&e)
		return e
	}
	teiOK := CalibrationEntry{
		Provider:     ProviderTEI,
		Model:        "tei/BAAI/bge-m3",
		ModelVersion: TEIModelVersion("a1b2c3d4e5f6", "query: ", "passage: "),
		MinCos:       0.62,
		ReportPath:   "docs/benchmarks/semantic-eval/report-bge-m3-1024-20261110.json",
	}
	if err := calValidateProductionEntry(teiOK); err != nil {
		t.Fatalf("well-formed tei entry rejected: %v", err)
	}
	teiSlashAtPlus := teiOK
	teiSlashAtPlus.ModelVersion = TEIModelVersion("org/rev@1.2+build:3_x", "query: ", "passage: ")
	if err := calValidateProductionEntry(teiSlashAtPlus); err != nil {
		t.Fatalf("tei entry with / @ + in model_sha rejected (isValidTEIInfoToken allows them): %v", err)
	}
	teiBadVersion := teiOK
	teiBadVersion.ModelVersion = "dims=1024;instr=0123abcd"

	tests := []struct {
		name string
		e    CalibrationEntry
	}{
		{"zero value (placeholder)", CalibrationEntry{}},
		{"NonProductionOnly true", mut(func(e *CalibrationEntry) { e.NonProductionOnly = true })},
		{"provider empty", mut(func(e *CalibrationEntry) { e.Provider = "" })},
		{"provider noop", mut(func(e *CalibrationEntry) { e.Provider = ProviderNoop })},
		{"model empty", mut(func(e *CalibrationEntry) { e.Model = "" })},
		{"model without provider prefix", mut(func(e *CalibrationEntry) { e.Model = "openrouter/qwen/qwen3-embedding-8b" })},
		{"model prefix only", mut(func(e *CalibrationEntry) { e.Model = "openai_compat/" })},
		{"model of another provider", mut(func(e *CalibrationEntry) { e.Model = "tei/BAAI/bge-m3" })},
		{"fake model", mut(func(e *CalibrationEntry) { e.Provider, e.Model = FakeEmbedProvider, FakeEmbedModel })},
		{"version empty", mut(func(e *CalibrationEntry) { e.ModelVersion = "" })},
		{"version without instr", mut(func(e *CalibrationEntry) { e.ModelVersion = "dims=1024" })},
		{"version instr too short", mut(func(e *CalibrationEntry) { e.ModelVersion = "dims=1024;instr=0123abc" })},
		{"version instr uppercase", mut(func(e *CalibrationEntry) { e.ModelVersion = "dims=1024;instr=0123ABCD" })},
		{"version dims zero", mut(func(e *CalibrationEntry) { e.ModelVersion = "dims=0;instr=0123abcd" })},
		{"version dims leading zero", mut(func(e *CalibrationEntry) { e.ModelVersion = "dims=01024;instr=0123abcd" })},
		{"version tei format under openai_compat", mut(func(e *CalibrationEntry) { e.ModelVersion = teiOK.ModelVersion })},
		{"version fake prefix", mut(func(e *CalibrationEntry) { e.ModelVersion = FakeEmbedModelVersionPrefix + "qp=e3b0c442;dp=e3b0c442" })},
		{"tei with openai version format", teiBadVersion},
		{"tei sha leading slash", func() CalibrationEntry {
			e := teiOK
			e.ModelVersion = TEIModelVersion("/abc", "query: ", "passage: ")
			return e
		}()},
		{"tei sha over 128 chars", func() CalibrationEntry {
			e := teiOK
			e.ModelVersion = TEIModelVersion(strings.Repeat("a", 129), "query: ", "passage: ")
			return e
		}()},
		{"MinCos zero", mut(func(e *CalibrationEntry) { e.MinCos = 0 })},
		{"MinCos below grid", mut(func(e *CalibrationEntry) { e.MinCos = 0.29 })},
		{"MinCos above grid", mut(func(e *CalibrationEntry) { e.MinCos = 0.91 })},
		{"MinCos one", mut(func(e *CalibrationEntry) { e.MinCos = 1 })},
		{"MinCos NaN", mut(func(e *CalibrationEntry) { e.MinCos = math.NaN() })},
		{"MinCos +Inf", mut(func(e *CalibrationEntry) { e.MinCos = math.Inf(1) })},
		{"MinCos off grid", mut(func(e *CalibrationEntry) { e.MinCos = 0.555 })},
		{"report empty", mut(func(e *CalibrationEntry) { e.ReportPath = "" })},
		{"report outside the report dir", mut(func(e *CalibrationEntry) { e.ReportPath = "docs/benchmarks/P05-search/report-x.json" })},
		{"report in a subdirectory", mut(func(e *CalibrationEntry) { e.ReportPath = "docs/benchmarks/semantic-eval/sub/report-x.json" })},
		{"report path traversal", mut(func(e *CalibrationEntry) { e.ReportPath = "docs/benchmarks/semantic-eval/report-../x.json" })},
		{"report not json", mut(func(e *CalibrationEntry) { e.ReportPath = "docs/benchmarks/semantic-eval/report-x.txt" })},
		{"report without slug", mut(func(e *CalibrationEntry) { e.ReportPath = "docs/benchmarks/semantic-eval/report-.json" })},
		{"report absolute", mut(func(e *CalibrationEntry) { e.ReportPath = "/docs/benchmarks/semantic-eval/report-x.json" })},
		{"report uppercase", mut(func(e *CalibrationEntry) { e.ReportPath = "docs/benchmarks/semantic-eval/report-X.json" })},
		{"report is the pairs file", mut(func(e *CalibrationEntry) { e.ReportPath = "docs/benchmarks/semantic-eval/pairs.v1.jsonl" })},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if err := calValidateProductionEntry(tc.e); err == nil {
				t.Fatalf("calValidateProductionEntry accepted %+v", tc.e)
			}
		})
	}

	// Both grid edges are accepted.
	for _, c := range []float64{0.30, 0.90} {
		e := calTestRealEntry()
		e.MinCos = c
		if err := calValidateProductionEntry(e); err != nil {
			t.Errorf("grid edge MinCos %v rejected: %v", c, err)
		}
	}
}
