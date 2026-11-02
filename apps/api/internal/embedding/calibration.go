// Package embedding provides embedding provider clients, document/query input
// formatting, and semantic_min_cos threshold calibration (plan P05 mục 2.12,
// 2.14, 2.20; SPEC §6.6, §6.7; ADR 0007 §10).
package embedding

import (
	"math"
	"strings"

	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
)

// Pre-registered threshold selection grid and acceptance bounds for
// semantic_min_cos calibration (plan P05 mục 2.20; SPEC §6.7; ADR 0007 §10).
const (
	CalGridMin   = 0.30
	CalGridMax   = 0.90
	CalGridStep  = 0.01
	CalMaxFPR    = 0.05
	CalMinRecall = 0.60

	// CalReportSchema is the JSON schema identifier required on committed
	// semantic-eval reports under docs/benchmarks/semantic-eval/.
	CalReportSchema = "engram.semeval.report.v1"

	// CalDecisionOK indicates the selected threshold satisfied both the FPR
	// bound (<= 5%) and the minimum recall gate (>= 0.60).
	CalDecisionOK = "ok"
	// CalDecisionRequired indicates no threshold on the grid satisfied FPR <= 5%
	// or recall at the selected threshold fell below 0.60; semantic search must
	// not be enabled for users without an explicit owner/Advisor decision.
	CalDecisionRequired = "decision_required"
)

// Fake embedding provider identity constants shared with cmd/fakeembed and the
// semantic-fake CI profile (plan P05 mục 2.20, 2.22, Task 7, Task 16; N3/FS-32).
//
// TEI formats ModelVersion as "<model_sha>;qp=<sha8>;dp=<sha8>"; the fake entry
// matches any qp/dp suffix whose model_sha equals FakeEmbedModelSHA.
const (
	FakeEmbedProvider           = "tei"
	FakeEmbedModel              = "tei/engram-fakeembed"
	FakeEmbedModelSHA           = "fakeembed-v1"
	FakeEmbedModelVersionPrefix = FakeEmbedModelSHA + ";"
	FakeEmbedReportPath         = "docs/benchmarks/semantic-eval/report-fakeembed-1024-20261102.json"
)

const (
	calGridMinHundredths = 30
	calGridMaxHundredths = 90
	calFloatEps          = 1e-12
)

// CalibrationEntry maps a provider/model/model_version triple to its calibrated
// cosine similarity threshold and committed evaluation report path (plan P05
// mục 2.20; SPEC §6.7; ADR 0007 §10).
type CalibrationEntry struct {
	Provider          string
	Model             string
	ModelVersion      string
	MinCos            float64
	ReportPath        string
	NonProductionOnly bool
}

// calEntries is the compiled calibration table (plan P05 mục 2.20, Task 7;
// SPEC §6.7; ADR 0007 §10).
//
// In W1 only the CI fake model entry is registered here so that E2E profile
// semantic-fake can bootstrap g1 in development/staging while failing closed in
// production. Real production model entries are added by lane rollout in Task 24
// (FS-16) after running worker semeval on the deploy host.
var calEntries = []CalibrationEntry{
	{
		Provider:          FakeEmbedProvider,
		Model:             FakeEmbedModel,
		ModelVersion:      FakeEmbedModelVersionPrefix,
		MinCos:            0.62,
		ReportPath:        FakeEmbedReportPath,
		NonProductionOnly: true,
	},
}

// CalibrationEntries returns a shallow copy of the registered calibration
// entries for inspection and CI report validation.
func CalibrationEntries() []CalibrationEntry {
	out := make([]CalibrationEntry, len(calEntries))
	copy(out, calEntries)
	return out
}

// CalibrationLookupFor returns an embedid.CalibrationLookup bound to appEnv
// (plan P05 mục 2.12, 2.15, 2.20; SPEC §6.7; ADR 0007 §10; N3/FS-32).
//
// Lookup matches (Provider, Model, ModelVersion) and ignores Dims, QueryPrefix,
// DocPrefix, and Preprocessing because those parameters are already encoded in
// ModelVersion per SPEC §6.7 and plan mục 2.12.
//
// Entries marked NonProductionOnly (such as the CI fakeembed model) are
// accepted only when appEnv is explicitly "development" or "staging";
// "production", empty strings, and any unknown environment fail closed.
func CalibrationLookupFor(appEnv string) embedid.CalibrationLookup {
	allowNonProd := calAllowsNonProduction(appEnv)
	return func(id embedid.Identity) (minCos float64, reportPath string, ok bool) {
		for _, entry := range calEntries {
			if !calEntryMatchesIdentity(entry, id) {
				continue
			}
			if entry.NonProductionOnly && !allowNonProd {
				return 0, "", false
			}
			return entry.MinCos, entry.ReportPath, true
		}
		return 0, "", false
	}
}

func calAllowsNonProduction(appEnv string) bool {
	return appEnv == "development" || appEnv == "staging"
}

func calEntryMatchesIdentity(entry CalibrationEntry, id embedid.Identity) bool {
	if entry.Provider != id.Provider || entry.Model != id.Model {
		return false
	}
	if calIsFakeEntry(entry) {
		return strings.HasPrefix(id.ModelVersion, FakeEmbedModelVersionPrefix) &&
			len(id.ModelVersion) > len(FakeEmbedModelVersionPrefix)
	}
	return entry.ModelVersion == id.ModelVersion
}

func calIsFakeEntry(entry CalibrationEntry) bool {
	return entry.NonProductionOnly &&
		entry.Provider == FakeEmbedProvider &&
		entry.Model == FakeEmbedModel &&
		entry.ModelVersion == FakeEmbedModelVersionPrefix
}

// EvalResult holds the cosine similarity score for a single evaluation pair in
// pairs.v1.jsonl (plan P05 mục 2.20; SPEC §6.7). It intentionally excludes
// query and target text so reports and logs never echo raw inputs.
type EvalResult struct {
	ID    string  `json:"id"`
	Label string  `json:"label"`
	Cos   float64 `json:"cos"`
}

// ThresholdDecision records the outcome of applying the pre-registered
// calibration rule across the 0.30..0.90 grid (plan P05 mục 2.20; SPEC §6.7).
type ThresholdDecision struct {
	Threshold float64 `json:"threshold"`
	Precision float64 `json:"precision"`
	Recall    float64 `json:"recall"`
	FPR       float64 `json:"fpr"`
	Decision  string  `json:"decision"`
}

// SelectThreshold applies the pre-registered threshold selection rule from
// SPEC §6.7 and plan P05 mục 2.20:
//
//   - Fail closed (Decision = "decision_required") before the grid scan if any
//     row has a non-finite cosine similarity (NaN, ±Inf), a cosine outside
//     [-1, 1], or a label other than "related" or "unrelated".
//   - Iterate t on the grid 0.30..0.90 in steps of 0.01 using integer hundredths
//     (30..90) so threshold values have no floating-point accumulation drift.
//   - Pick the smallest t where FPR (unrelated pairs with cos >= t divided by
//     total unrelated pairs) is <= 0.05 (CalMaxFPR).
//   - If results lack related or unrelated rows, or no grid point satisfies
//     FPR <= 0.05, return Decision = "decision_required".
//   - If recall at the chosen t (related pairs with cos >= t divided by total
//     related pairs) is < 0.60 (CalMinRecall), return Decision = "decision_required";
//     otherwise return Decision = "ok".
func SelectThreshold(results []EvalResult) ThresholdDecision {
	var totalRelated, totalUnrelated int
	for _, r := range results {
		if math.IsNaN(r.Cos) || math.IsInf(r.Cos, 0) || r.Cos < -1.0 || r.Cos > 1.0 {
			return ThresholdDecision{Decision: CalDecisionRequired}
		}
		switch r.Label {
		case "related":
			totalRelated++
		case "unrelated":
			totalUnrelated++
		default:
			return ThresholdDecision{Decision: CalDecisionRequired}
		}
	}
	if totalRelated == 0 || totalUnrelated == 0 {
		return ThresholdDecision{Decision: CalDecisionRequired}
	}

	for step := calGridMinHundredths; step <= calGridMaxHundredths; step++ {
		t := float64(step) / 100.0
		var tp, fp int
		for _, r := range results {
			if r.Cos < t {
				continue
			}
			switch r.Label {
			case "related":
				tp++
			case "unrelated":
				fp++
			}
		}

		fpr := float64(fp) / float64(totalUnrelated)
		if fpr <= CalMaxFPR+calFloatEps {
			recall := float64(tp) / float64(totalRelated)
			var precision float64
			if tp+fp > 0 {
				precision = float64(tp) / float64(tp+fp)
			}
			decision := CalDecisionOK
			if recall+calFloatEps < CalMinRecall {
				decision = CalDecisionRequired
			}
			return ThresholdDecision{
				Threshold: t,
				Precision: precision,
				Recall:    recall,
				FPR:       fpr,
				Decision:  decision,
			}
		}
	}

	return ThresholdDecision{Decision: CalDecisionRequired}
}
