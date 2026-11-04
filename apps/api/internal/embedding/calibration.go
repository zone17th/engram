// Package embedding provides embedding provider clients, document/query input
// formatting, and semantic_min_cos threshold calibration (plan P05 mục 2.12,
// 2.14, 2.20; SPEC §6.6, §6.7; ADR 0007 §10).
package embedding

import (
	"errors"
	"fmt"
	"math"
	"regexp"
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
// The CI fake model entry lets E2E profile semantic-fake bootstrap g1 in
// development/staging while failing closed in production. Real production
// model entries are added by lane rollout (FS-16) after running worker semeval
// on the deploy host; calProductionEntry (below) is the stage 24-2 entry. Any
// real identity without a valid entry is never served, so generation
// create/bootstrap fail closed for it.
var calEntries = []CalibrationEntry{
	{
		Provider:          FakeEmbedProvider,
		Model:             FakeEmbedModel,
		ModelVersion:      FakeEmbedModelVersionPrefix,
		MinCos:            0.62,
		ReportPath:        FakeEmbedReportPath,
		NonProductionOnly: true,
	},
	calProductionEntry,
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
	return calLookup(calEntries, appEnv)
}

// calLookup is CalibrationLookupFor over an explicit table (the tests pass
// their own so they never mutate calEntries).
func calLookup(entries []CalibrationEntry, appEnv string) embedid.CalibrationLookup {
	allowNonProd := calAllowsNonProduction(appEnv)
	return func(id embedid.Identity) (minCos float64, reportPath string, ok bool) {
		for _, entry := range entries {
			if !calEntryMatchesIdentity(entry, id) {
				continue
			}
			// Fail closed: a non-fake entry is served only if it passes the same
			// guard the CI validator applies, so an unfilled or malformed
			// production entry is never served in any environment.
			if !calIsFakeEntry(entry) && calValidateProductionEntry(entry) != nil {
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

// Production calibration entry: guard and placeholder (plan P05 mục 2.20, Task
// 24 stage 24-1; gate 5; SPEC §6.7; ADR 0007 §10; FS-16).
//
// The real entry for the production model is produced once on the deploy host by
// `worker semeval` and committed by lane rollout in stage 24-2 together with its
// report. Until then calEntries holds only the CI fake entry, so the lookup
// serves nothing for a real model and generation create/bootstrap refuse
// (fail closed). The checks below are the one contract a filled entry must meet;
// the lookup applies them at serve time and TestCalibrationEntriesHaveReports
// applies them (plus the report checks) in CI to every non-fake entry.

const (
	// calReportDirPrefix is the only directory real reports may live in.
	calReportDirPrefix = "docs/benchmarks/semantic-eval/report-"
	calReportSuffix    = ".json"
)

var (
	// "dims=<d>;instr=<sha8>" exactly as OpenAIModelVersion formats it.
	calOpenAIModelVersionRE = regexp.MustCompile(`^dims=[1-9][0-9]{0,3};instr=[0-9a-f]{8}$`)
	// "<model_sha>;qp=<sha8>;dp=<sha8>" exactly as TEIModelVersion formats it. The
	// model_sha part follows isValidTEIInfoToken (tei.go): first char alnum, then
	// [A-Za-z0-9._/:@+-], at most 128 chars in all.
	calTEIModelVersionRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,127};qp=[0-9a-f]{8};dp=[0-9a-f]{8}$`)
	// report-<slug>-<dims>-<yyyymmdd>.json, flat in the report directory.
	calReportPathRE = regexp.MustCompile(`^docs/benchmarks/semantic-eval/report-[a-z0-9][a-z0-9._-]*\.json$`)
)

// calProductionEntry is the production model entry, filled in stage 24-2
// (lane rollout, FS-16; advisor-dec-362) from `worker semeval` on the deploy
// host bro through the 9router openai_compat endpoint (ADR 0004): report
// synthetic=false, decision "ok", threshold 0.48 (precision 0.9608, recall
// 0.6622, FPR 0.0400 over 124 pairs). It passes calValidateProductionEntry and
// is registered in calEntries; TestCalibrationEntriesHaveReports checks it
// against its report in CI. A new model or instruction needs a new semeval
// run, report and entry (never edit MinCos by hand).
var calProductionEntry = CalibrationEntry{
	Provider:          ProviderOpenAICompat,
	Model:             "openai_compat/openrouter/qwen/qwen3-embedding-8b",
	ModelVersion:      "dims=1024;instr=97581580",
	MinCos:            0.48,
	ReportPath:        "docs/benchmarks/semantic-eval/report-qwen3-embedding-8b-1024-20261104.json",
	NonProductionOnly: false,
}

// calValidateProductionEntry reports why e is not an acceptable real
// (non-fake) calibration entry, or nil when it is. The CI fake entry is out of
// scope: callers check calIsFakeEntry first.
func calValidateProductionEntry(e CalibrationEntry) error {
	if e.NonProductionOnly {
		return errors.New("real entry must have NonProductionOnly=false")
	}
	switch e.Provider {
	case ProviderOpenAICompat, ProviderTEI:
	default:
		return fmt.Errorf("provider %q is not openai_compat or tei (pending placeholder?)", e.Provider)
	}
	prefix := e.Provider + "/"
	if !strings.HasPrefix(e.Model, prefix) || len(e.Model) == len(prefix) {
		return fmt.Errorf("model %q must be %s<model>", e.Model, prefix)
	}
	if e.Model == FakeEmbedModel {
		return errors.New("real entry must not use the fakeembed model")
	}
	re := calOpenAIModelVersionRE
	if e.Provider == ProviderTEI {
		re = calTEIModelVersionRE
	}
	if !re.MatchString(e.ModelVersion) {
		return fmt.Errorf("model_version %q does not match %s", e.ModelVersion, re)
	}
	if strings.HasPrefix(e.ModelVersion, FakeEmbedModelVersionPrefix) {
		return errors.New("real entry must not use the fakeembed model_version")
	}
	if math.IsNaN(e.MinCos) || math.IsInf(e.MinCos, 0) ||
		e.MinCos < CalGridMin-calFloatEps || e.MinCos > CalGridMax+calFloatEps {
		return fmt.Errorf("MinCos %v is outside the calibration grid [%.2f, %.2f]", e.MinCos, CalGridMin, CalGridMax)
	}
	if math.Abs(e.MinCos*100-math.Round(e.MinCos*100)) > 1e-6 {
		return fmt.Errorf("MinCos %v is not a 0.01 grid step", e.MinCos)
	}
	if !calReportPathRE.MatchString(e.ReportPath) {
		return fmt.Errorf("ReportPath %q must be %s<slug>%s directly in that directory", e.ReportPath, calReportDirPrefix, calReportSuffix)
	}
	return nil
}
