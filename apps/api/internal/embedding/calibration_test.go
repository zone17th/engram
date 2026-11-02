package embedding

import (
	"math"
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
