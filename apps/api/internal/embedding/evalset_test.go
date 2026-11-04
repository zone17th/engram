package embedding

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

const (
	evalsetPairsRelPath  = "docs/benchmarks/semantic-eval/pairs.v1.jsonl"
	evalsetReportDirPref = "docs/benchmarks/semantic-eval/"
)

var (
	evalsetCategories = []string{
		"abbrev",
		"diacritics",
		"no_diacritics",
		"short_name",
		"cross_lang",
		"tag",
		"noise",
	}
	evalsetTargetKinds = map[string]bool{
		"item": true,
		"tag":  true,
	}
	evalsetLabels = map[string]bool{
		"related":   true,
		"unrelated": true,
	}
	evalsetLangs = map[string]bool{
		"vi":    true,
		"en":    true,
		"mixed": true,
	}
)

type evalsetPairRow struct {
	ID         *string `json:"id"`
	Query      *string `json:"query"`
	Target     *string `json:"target"`
	TargetKind *string `json:"target_kind"`
	Hint       *string `json:"hint"`
	Label      *string `json:"label"`
	Lang       *string `json:"lang"`
	Category   *string `json:"category"`
}

type evalsetGridSpec struct {
	Min  *float64 `json:"min"`
	Max  *float64 `json:"max"`
	Step *float64 `json:"step"`
}

type evalsetResultRow struct {
	ID    *string  `json:"id"`
	Label *string  `json:"label"`
	Cos   *float64 `json:"cos"`
}

type evalsetReportDoc struct {
	Schema       *string             `json:"schema"`
	Provider     *string             `json:"provider"`
	Model        *string             `json:"model"`
	ModelVersion *string             `json:"model_version"`
	Dims         *int                `json:"dims"`
	PairsFile    *string             `json:"pairs_file"`
	PairsSHA256  *string             `json:"pairs_sha256"`
	Grid         *evalsetGridSpec    `json:"grid"`
	MaxFPR       *float64            `json:"max_fpr"`
	MinRecall    *float64            `json:"min_recall"`
	Threshold    *float64            `json:"threshold"`
	Precision    *float64            `json:"precision"`
	Recall       *float64            `json:"recall"`
	FPR          *float64            `json:"fpr"`
	Decision     *string             `json:"decision"`
	GeneratedAt  *string             `json:"generated_at"`
	Synthetic    *bool               `json:"synthetic"`
	Note         *string             `json:"note"`
	Results      *[]evalsetResultRow `json:"results"`
}

func evalsetFindRepoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	dir := wd
	for range 10 {
		candidate := filepath.Join(dir, "docs", "benchmarks")
		if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	// Fallback matching packages/content-fixtures convention from apps/api/internal/<pkg>.
	fallback := filepath.Join("..", "..", "..", "..")
	if info, statErr := os.Stat(filepath.Join(fallback, "docs", "benchmarks")); statErr == nil && info.IsDir() {
		return fallback
	}
	t.Fatalf("could not locate repo root containing docs/benchmarks starting from %s", wd)
	return ""
}

func evalsetDecodeStrict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("unexpected trailing JSON value: %s", string(trailing))
		}
		return fmt.Errorf("trailing bytes after JSON value: %w", err)
	}
	return nil
}

func evalsetLoadPairs(t *testing.T, repoRoot string) ([]evalsetPairRow, []byte) {
	t.Helper()
	fullPath := filepath.Join(repoRoot, filepath.FromSlash(evalsetPairsRelPath))
	raw, err := os.ReadFile(fullPath)
	if err != nil {
		t.Fatalf("read %s: %v", fullPath, err)
	}
	if len(raw) == 0 {
		t.Fatalf("%s is empty", fullPath)
	}
	if bytes.Contains(raw, []byte{'\r'}) {
		t.Fatalf("%s contains CR (\\r) bytes; must be LF-only so pairs_sha256 is deterministic across platforms", evalsetPairsRelPath)
	}

	trimmed := bytes.TrimRight(raw, "\n")
	rawLines := bytes.Split(trimmed, []byte{'\n'})
	rows := make([]evalsetPairRow, 0, len(rawLines))

	for idx, line := range rawLines {
		lineNo := idx + 1
		if len(bytes.TrimSpace(line)) == 0 {
			t.Fatalf("%s:%d: empty line is not allowed", evalsetPairsRelPath, lineNo)
		}
		var row evalsetPairRow
		if err := evalsetDecodeStrict(line, &row); err != nil {
			t.Fatalf("%s:%d: strict JSON decode failed: %v", evalsetPairsRelPath, lineNo, err)
		}
		rows = append(rows, row)
	}
	return rows, raw
}

func TestEvalSetSchema(t *testing.T) {
	t.Parallel()
	repoRoot := evalsetFindRepoRoot(t)
	rows, _ := evalsetLoadPairs(t, repoRoot)

	if len(rows) < 80 {
		t.Errorf("total pairs = %d, want >= 80", len(rows))
	}

	validCategory := make(map[string]bool, len(evalsetCategories))
	categoryCounts := make(map[string]int, len(evalsetCategories))
	for _, cat := range evalsetCategories {
		validCategory[cat] = true
	}

	seenIDs := make(map[string]int, len(rows))
	var relatedCount, unrelatedCount, tagKindCount int

	for idx, row := range rows {
		lineNo := idx + 1
		if row.ID == nil || row.Query == nil || row.Target == nil ||
			row.TargetKind == nil || row.Hint == nil || row.Label == nil ||
			row.Lang == nil || row.Category == nil {
			t.Fatalf("%s:%d: missing required key (every row must have id, query, target, target_kind, hint, label, lang, category)", evalsetPairsRelPath, lineNo)
		}

		id := strings.TrimSpace(*row.ID)
		if id == "" || id != *row.ID {
			t.Errorf("%s:%d: invalid id %q", evalsetPairsRelPath, lineNo, *row.ID)
		}
		if prevLine, dup := seenIDs[id]; dup {
			t.Errorf("%s:%d: duplicate id %q (first seen on line %d)", evalsetPairsRelPath, lineNo, id, prevLine)
		}
		seenIDs[id] = lineNo

		query := *row.Query
		if strings.TrimSpace(query) == "" {
			t.Errorf("%s:%d (%s): query must be non-empty", evalsetPairsRelPath, lineNo, id)
		}
		if strings.ContainsRune(query, ':') || strings.ContainsRune(query, '：') {
			t.Errorf("%s:%d (%s): query %q contains colon ':' or '：' (blocked by send-gate)", evalsetPairsRelPath, lineNo, id, query)
		}
		if rc := utf8.RuneCountInString(query); rc < 3 {
			t.Errorf("%s:%d (%s): query %q has %d runes, want >= 3", evalsetPairsRelPath, lineNo, id, query, rc)
		}

		target := *row.Target
		if strings.TrimSpace(target) == "" {
			t.Errorf("%s:%d (%s): target must be non-empty", evalsetPairsRelPath, lineNo, id)
		}

		targetKind := *row.TargetKind
		if !evalsetTargetKinds[targetKind] {
			t.Errorf("%s:%d (%s): invalid target_kind %q", evalsetPairsRelPath, lineNo, id, targetKind)
		}
		if targetKind == "tag" {
			tagKindCount++
			if *row.Hint != "" {
				t.Errorf("%s:%d (%s): tag target_kind must have empty hint, got %q", evalsetPairsRelPath, lineNo, id, *row.Hint)
			}
		}

		label := *row.Label
		if !evalsetLabels[label] {
			t.Errorf("%s:%d (%s): invalid label %q", evalsetPairsRelPath, lineNo, id, label)
		}
		switch label {
		case "related":
			relatedCount++
		case "unrelated":
			unrelatedCount++
		}

		lang := *row.Lang
		if !evalsetLangs[lang] {
			t.Errorf("%s:%d (%s): invalid lang %q", evalsetPairsRelPath, lineNo, id, lang)
		}

		cat := *row.Category
		if !validCategory[cat] {
			t.Errorf("%s:%d (%s): invalid category %q", evalsetPairsRelPath, lineNo, id, cat)
		} else {
			categoryCounts[cat]++
		}
	}

	if relatedCount < 40 {
		t.Errorf("related count = %d, want >= 40", relatedCount)
	}
	if unrelatedCount < 30 {
		t.Errorf("unrelated count = %d, want >= 30", unrelatedCount)
	}
	if tagKindCount < 15 {
		t.Errorf("target_kind=tag count = %d, want >= 15", tagKindCount)
	}
	for _, cat := range evalsetCategories {
		if categoryCounts[cat] < 8 {
			t.Errorf("category %q count = %d, want >= 8", cat, categoryCounts[cat])
		}
	}
}

func TestCalibrationEntriesHaveReports(t *testing.T) {
	t.Parallel()
	repoRoot := evalsetFindRepoRoot(t)
	pairRows, pairsRaw := evalsetLoadPairs(t, repoRoot)

	pairsSum := sha256.Sum256(pairsRaw)
	wantPairsSHA := hex.EncodeToString(pairsSum[:])

	pairLabels := make(map[string]string, len(pairRows))
	for _, row := range pairRows {
		if row.ID != nil && row.Label != nil {
			pairLabels[*row.ID] = *row.Label
		}
	}

	entries := CalibrationEntries()
	if len(entries) == 0 {
		t.Fatal("CalibrationEntries() must not be empty")
	}

	for _, entry := range entries {
		entry := entry
		t.Run(entry.Model+"_"+entry.ModelVersion, func(t *testing.T) {
			t.Parallel()

			if !(entry.MinCos > 0 && entry.MinCos < 1) {
				t.Fatalf("entry MinCos = %v, want 0 < MinCos < 1", entry.MinCos)
			}
			if !strings.HasPrefix(entry.ReportPath, evalsetReportDirPref) || !strings.HasSuffix(entry.ReportPath, ".json") {
				t.Fatalf("entry ReportPath = %q, want under %s*.json", entry.ReportPath, evalsetReportDirPref)
			}

			// Real (non-fake) entries must pass the production guard: not
			// NonProductionOnly, MinCos on the 0.30..0.90 grid, canonical
			// provider/model/model_version shape, flat report path. The report
			// itself must be a real run (synthetic=false, decision=ok; below).
			if !calIsFakeEntry(entry) {
				if err := calValidateProductionEntry(entry); err != nil {
					t.Fatalf("entry %q failed the production calibration guard: %v", entry.Model, err)
				}
			}

			reportFullPath := filepath.Join(repoRoot, filepath.FromSlash(entry.ReportPath))
			reportRaw, err := os.ReadFile(reportFullPath)
			if err != nil {
				t.Fatalf("read report %s: %v", reportFullPath, err)
			}

			var doc evalsetReportDoc
			if err := evalsetDecodeStrict(reportRaw, &doc); err != nil {
				t.Fatalf("strict decode %s: %v", entry.ReportPath, err)
			}

			if doc.Schema == nil || *doc.Schema != CalReportSchema {
				t.Fatalf("%s: schema = %v, want %q", entry.ReportPath, doc.Schema, CalReportSchema)
			}
			if doc.Provider == nil || *doc.Provider != entry.Provider {
				t.Errorf("%s: provider = %v, want %q", entry.ReportPath, doc.Provider, entry.Provider)
			}
			if doc.Model == nil || *doc.Model != entry.Model {
				t.Errorf("%s: model = %v, want %q", entry.ReportPath, doc.Model, entry.Model)
			}
			if doc.ModelVersion == nil {
				t.Fatalf("%s: missing model_version", entry.ReportPath)
			}
			if calIsFakeEntry(entry) {
				if !strings.HasPrefix(*doc.ModelVersion, FakeEmbedModelVersionPrefix) ||
					len(*doc.ModelVersion) <= len(FakeEmbedModelVersionPrefix) {
					t.Errorf("%s: fake model_version = %q, want prefix %q with non-empty suffix",
						entry.ReportPath, *doc.ModelVersion, FakeEmbedModelVersionPrefix)
				}
			} else if *doc.ModelVersion != entry.ModelVersion {
				t.Errorf("%s: model_version = %q, want %q", entry.ReportPath, *doc.ModelVersion, entry.ModelVersion)
			}

			if doc.Dims == nil || *doc.Dims < 1 || *doc.Dims > 2000 {
				t.Errorf("%s: dims = %v, want in 1..2000", entry.ReportPath, doc.Dims)
			}
			if entry.Provider == ProviderOpenAICompat && doc.Dims != nil &&
				!strings.HasPrefix(entry.ModelVersion, fmt.Sprintf("dims=%d;", *doc.Dims)) {
				t.Errorf("%s: dims = %d does not match entry model_version %q", entry.ReportPath, *doc.Dims, entry.ModelVersion)
			}
			if doc.PairsFile == nil || *doc.PairsFile != evalsetPairsRelPath {
				t.Errorf("%s: pairs_file = %v, want %q", entry.ReportPath, doc.PairsFile, evalsetPairsRelPath)
			}
			if doc.PairsSHA256 == nil || *doc.PairsSHA256 != wantPairsSHA {
				t.Errorf("%s: pairs_sha256 = %v, want %s", entry.ReportPath, doc.PairsSHA256, wantPairsSHA)
			}

			if doc.Grid == nil || doc.Grid.Min == nil || doc.Grid.Max == nil || doc.Grid.Step == nil {
				t.Fatalf("%s: missing grid specification", entry.ReportPath)
			}
			if math.Abs(*doc.Grid.Min-CalGridMin) > 1e-9 ||
				math.Abs(*doc.Grid.Max-CalGridMax) > 1e-9 ||
				math.Abs(*doc.Grid.Step-CalGridStep) > 1e-9 {
				t.Errorf("%s: grid = (%v, %v, %v), want (%v, %v, %v)",
					entry.ReportPath, *doc.Grid.Min, *doc.Grid.Max, *doc.Grid.Step, CalGridMin, CalGridMax, CalGridStep)
			}
			if doc.MaxFPR == nil || math.Abs(*doc.MaxFPR-CalMaxFPR) > 1e-9 {
				t.Errorf("%s: max_fpr = %v, want %v", entry.ReportPath, doc.MaxFPR, CalMaxFPR)
			}
			if doc.MinRecall == nil || math.Abs(*doc.MinRecall-CalMinRecall) > 1e-9 {
				t.Errorf("%s: min_recall = %v, want %v", entry.ReportPath, doc.MinRecall, CalMinRecall)
			}

			if doc.GeneratedAt == nil {
				t.Errorf("%s: missing generated_at", entry.ReportPath)
			} else if _, err := time.Parse(time.RFC3339, *doc.GeneratedAt); err != nil {
				t.Errorf("%s: generated_at %q is not valid RFC3339: %v", entry.ReportPath, *doc.GeneratedAt, err)
			}
			if doc.Synthetic == nil {
				t.Errorf("%s: missing synthetic boolean", entry.ReportPath)
			} else if calIsFakeEntry(entry) && !*doc.Synthetic {
				t.Errorf("%s: fake model report must have synthetic=true", entry.ReportPath)
			} else if !calIsFakeEntry(entry) && *doc.Synthetic {
				t.Errorf("%s: report of a real model must have synthetic=false", entry.ReportPath)
			}
			if doc.Note == nil || strings.TrimSpace(*doc.Note) == "" {
				t.Errorf("%s: note must be non-empty", entry.ReportPath)
			}

			if doc.Threshold == nil || doc.Precision == nil || doc.Recall == nil || doc.FPR == nil || doc.Decision == nil {
				t.Fatalf("%s: missing threshold/precision/recall/fpr/decision fields", entry.ReportPath)
			}

			roundedReportT := math.Round(*doc.Threshold*100) / 100
			roundedEntryT := math.Round(entry.MinCos*100) / 100
			if math.Abs(roundedReportT-roundedEntryT) > 1e-9 {
				t.Errorf("%s: threshold %.2f does not match entry MinCos %.2f", entry.ReportPath, roundedReportT, roundedEntryT)
			}

			if doc.Results == nil {
				t.Fatalf("%s: missing results array", entry.ReportPath)
			}
			rawResults := *doc.Results
			if len(rawResults) != len(pairRows) {
				t.Fatalf("%s: results len = %d, want %d (matching pairs.v1.jsonl)", entry.ReportPath, len(rawResults), len(pairRows))
			}

			seenResultIDs := make(map[string]bool, len(rawResults))
			evalResults := make([]EvalResult, 0, len(rawResults))
			for idx, rr := range rawResults {
				if rr.ID == nil || rr.Label == nil || rr.Cos == nil {
					t.Fatalf("%s: results[%d] missing id, label, or cos", entry.ReportPath, idx)
				}
				id := *rr.ID
				if seenResultIDs[id] {
					t.Fatalf("%s: duplicate result id %q", entry.ReportPath, id)
				}
				seenResultIDs[id] = true

				wantLabel, exists := pairLabels[id]
				if !exists {
					t.Fatalf("%s: result id %q does not exist in %s", entry.ReportPath, id, evalsetPairsRelPath)
				}
				if *rr.Label != wantLabel {
					t.Fatalf("%s: result id %q has label %q, want %q from %s",
						entry.ReportPath, id, *rr.Label, wantLabel, evalsetPairsRelPath)
				}
				if math.IsNaN(*rr.Cos) || math.IsInf(*rr.Cos, 0) || *rr.Cos < -1.0 || *rr.Cos > 1.0 {
					t.Fatalf("%s: result id %q has invalid cos %v", entry.ReportPath, id, *rr.Cos)
				}
				evalResults = append(evalResults, EvalResult{
					ID:    id,
					Label: *rr.Label,
					Cos:   *rr.Cos,
				})
			}

			recomputed := SelectThreshold(evalResults)
			if recomputed.Decision != *doc.Decision {
				t.Errorf("%s: recomputed decision = %q, report has %q", entry.ReportPath, recomputed.Decision, *doc.Decision)
			}
			if *doc.Decision != CalDecisionOK {
				t.Errorf("%s: decision = %q, want %q for registered calibration entry", entry.ReportPath, *doc.Decision, CalDecisionOK)
			}
			if math.Abs(recomputed.Threshold-*doc.Threshold) > 1e-9 {
				t.Errorf("%s: recomputed threshold = %.12f, report has %.12f", entry.ReportPath, recomputed.Threshold, *doc.Threshold)
			}
			if math.Abs(recomputed.Precision-*doc.Precision) > 1e-9 {
				t.Errorf("%s: recomputed precision = %.12f, report has %.12f", entry.ReportPath, recomputed.Precision, *doc.Precision)
			}
			if math.Abs(recomputed.Recall-*doc.Recall) > 1e-9 {
				t.Errorf("%s: recomputed recall = %.12f, report has %.12f", entry.ReportPath, recomputed.Recall, *doc.Recall)
			}
			if math.Abs(recomputed.FPR-*doc.FPR) > 1e-9 {
				t.Errorf("%s: recomputed fpr = %.12f, report has %.12f", entry.ReportPath, recomputed.FPR, *doc.FPR)
			}
		})
	}
}

func TestEvalsetDecodeStrictRejectsTrailing(t *testing.T) {
	t.Parallel()

	type sample struct {
		A int `json:"a"`
	}

	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{
			name:    "plain object with trailing whitespace and newline is accepted",
			input:   "{\"a\":1} \t\n",
			wantErr: false,
		},
		{
			name:    "extra closing brace is rejected",
			input:   "{\"a\":1}}",
			wantErr: true,
		},
		{
			name:    "extra closing bracket is rejected",
			input:   "{\"a\":1}]",
			wantErr: true,
		},
		{
			name:    "second JSON value is rejected",
			input:   "{\"a\":1}{\"a\":2}",
			wantErr: true,
		},
		{
			name:    "trailing garbage is rejected",
			input:   "{\"a\":1} trailing",
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var dst sample
			err := evalsetDecodeStrict([]byte(tc.input), &dst)
			if tc.wantErr && err == nil {
				t.Fatalf("evalsetDecodeStrict(%q) = nil, want error", tc.input)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("evalsetDecodeStrict(%q) = %v, want nil", tc.input, err)
			}
		})
	}
}
