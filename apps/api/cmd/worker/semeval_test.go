package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
)

type semevalFakeProvider struct {
	name         string
	model        string
	modelVersion string
	dims         int
	maxBatch     int
	docVecs      map[string][]float32
	queryVecs    map[string][]float32
	docErr       error
	queryErr     error
	docBatches   [][]string
	queries      []string
}

func (f *semevalFakeProvider) Name() string         { return f.name }
func (f *semevalFakeProvider) Model() string        { return f.model }
func (f *semevalFakeProvider) ModelVersion() string { return f.modelVersion }
func (f *semevalFakeProvider) Dims() int            { return f.dims }
func (f *semevalFakeProvider) MaxBatch() int {
	if f.maxBatch > 0 {
		return f.maxBatch
	}
	return embedding.MaxBatch
}

func (f *semevalFakeProvider) EmbedDocuments(ctx context.Context, inputs []string) ([][]float32, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.docErr != nil {
		return nil, f.docErr
	}
	f.docBatches = append(f.docBatches, append([]string(nil), inputs...))
	out := make([][]float32, len(inputs))
	for i, in := range inputs {
		v, ok := f.docVecs[in]
		if !ok {
			return nil, fmt.Errorf("missing doc vector for %d", i)
		}
		out[i] = append([]float32(nil), v...)
	}
	return out, nil
}

func (f *semevalFakeProvider) EmbedQuery(ctx context.Context, q string) ([]float32, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	f.queries = append(f.queries, q)
	v, ok := f.queryVecs[q]
	if !ok {
		return nil, errors.New("missing query vector")
	}
	return append([]float32(nil), v...), nil
}

type semevalTestPairSpec struct {
	id         string
	query      string
	target     string
	targetKind string
	hint       string
	label      string
	lang       string
	category   string
	cos        float64
}

func semevalUnitVec2DForCos(cos float64) []float32 {
	if cos > 1 {
		cos = 1
	} else if cos < -1 {
		cos = -1
	}
	sin := math.Sqrt(math.Max(0, 1.0-cos*cos))
	return []float32{float32(cos), float32(sin)}
}

func semevalWriteTempPairsFile(t *testing.T, dir string, specs []semevalTestPairSpec) (string, []byte) {
	t.Helper()
	var buf bytes.Buffer
	for i, s := range specs {
		lang := s.lang
		if lang == "" {
			lang = "vi"
		}
		cat := s.category
		if cat == "" {
			cat = "abbrev"
		}
		kind := s.targetKind
		if kind == "" {
			kind = "item"
		}
		row := map[string]string{
			"id":          s.id,
			"query":       s.query,
			"target":      s.target,
			"target_kind": kind,
			"hint":        s.hint,
			"label":       s.label,
			"lang":        lang,
			"category":    cat,
		}
		line, err := json.Marshal(row)
		if err != nil {
			t.Fatalf("marshal row %d: %v", i, err)
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	raw := buf.Bytes()
	path := filepath.Join(dir, "pairs.jsonl")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write pairs file: %v", err)
	}
	return path, raw
}

func semevalDecodeStrictReport(t *testing.T, data []byte) semevalReport {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var rep semevalReport
	if err := dec.Decode(&rep); err != nil {
		t.Fatalf("strict decode report failed: %v", err)
	}
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		t.Fatalf("unexpected trailing data in report: %v", err)
	}
	return rep
}

func TestSemevalThresholdRule(t *testing.T) {
	t.Parallel()

	fixedNow := func() time.Time {
		return time.Date(2026, 11, 2, 12, 30, 0, 0, time.FixedZone("ICT", 7*3600))
	}

	buildSpecs := func(relatedCos []float64, unrelatedCos []float64) ([]semevalTestPairSpec, *semevalFakeProvider) {
		var specs []semevalTestPairSpec
		docVecs := make(map[string][]float32)
		queryVecs := make(map[string][]float32)

		idx := 1
		for _, c := range relatedCos {
			id := fmt.Sprintf("p%03d", idx)
			q := fmt.Sprintf("queryrel%03d", idx)
			target := fmt.Sprintf("Target Related %03d", idx)
			hint := fmt.Sprintf("Hint %03d", idx)
			specs = append(specs, semevalTestPairSpec{
				id:         id,
				query:      q,
				target:     target,
				targetKind: "item",
				hint:       hint,
				label:      "related",
				lang:       "en",
				category:   "abbrev",
				cos:        c,
			})
			docInput := embedding.ItemInput(target, hint)
			docVecs[docInput] = []float32{1, 0}
			queryVecs[q] = semevalUnitVec2DForCos(c)
			idx++
		}
		for _, c := range unrelatedCos {
			id := fmt.Sprintf("p%03d", idx)
			q := fmt.Sprintf("queryunrel%03d", idx)
			target := fmt.Sprintf("tag-unrelated-%03d", idx)
			specs = append(specs, semevalTestPairSpec{
				id:         id,
				query:      q,
				target:     target,
				targetKind: "tag",
				hint:       "",
				label:      "unrelated",
				lang:       "en",
				category:   "tag",
				cos:        c,
			})
			docInput := embedding.TagInput(target)
			docVecs[docInput] = []float32{1, 0}
			queryVecs[q] = semevalUnitVec2DForCos(c)
			idx++
		}

		fp := &semevalFakeProvider{
			name:         embedding.ProviderTEI,
			model:        "tei/BAAI/bge-m3",
			modelVersion: "sha123;qp=e3b0c442;dp=e3b0c442",
			dims:         2,
			maxBatch:     3,
			docVecs:      docVecs,
			queryVecs:    queryVecs,
		}
		return specs, fp
	}

	// All fixture cosines are placed strictly inside 0.01 grid cells (e.g. 0.455
	// in (0.45, 0.46), never on a grid point 0.30..0.90) so float32 unit-vector
	// quantization cannot shift any pair across a grid boundary.
	//
	// Case (a): 10 related (8 at cos 0.805, 2 at cos 0.505), 20 unrelated (18 at
	// cos 0.205, 1 at cos 0.455, 1 at cos 0.545).
	// At t <= 0.45: 2 unrelated (0.455, 0.545) >= t -> FPR = 2/20 = 0.10 > 0.05.
	// At t = 0.46: only 1 unrelated (0.545) >= 0.46 -> FPR = 1/20 = 0.05 <= 0.05.
	// Smallest t with FPR <= 5% is t = 0.46.
	// At t = 0.46: all 10 related (8 at 0.805, 2 at 0.505) have cos >= 0.46 ->
	// TP = 10, recall = 1.0, precision = 10/11.
	relA := []float64{0.805, 0.805, 0.805, 0.805, 0.805, 0.805, 0.805, 0.805, 0.505, 0.505}
	unrelA := make([]float64, 20)
	for i := range 18 {
		unrelA[i] = 0.205
	}
	unrelA[18] = 0.455
	unrelA[19] = 0.545

	// Case (b): recall at selected t < 0.60 -> decision_required.
	// 10 related: 5 at cos 0.805, 5 at cos 0.405.
	// 20 unrelated: 18 at cos 0.205, 2 at cos 0.555.
	// At t <= 0.55: 2 unrelated (0.555) >= t -> FPR = 2/20 = 0.10 > 0.05.
	// Smallest t with FPR <= 5% is t = 0.56 (0 unrelated >= 0.56 -> FPR = 0.00).
	// At t = 0.56, only 5/10 related (0.805) have cos >= 0.56 -> recall = 0.50 < 0.60 -> decision_required.
	relB := []float64{0.805, 0.805, 0.805, 0.805, 0.805, 0.405, 0.405, 0.405, 0.405, 0.405}
	unrelB := make([]float64, 20)
	for i := range 18 {
		unrelB[i] = 0.205
	}
	unrelB[18] = 0.555
	unrelB[19] = 0.555

	// Case (c): no grid t in 0.30..0.90 satisfies FPR <= 5% -> decision_required.
	// 10 related at 0.955; 20 unrelated where 18 are at 0.105 and 2 have cos 0.955
	// (FPR = 2/20 = 0.10 > 0.05 across entire grid).
	relC := []float64{0.955, 0.955, 0.955, 0.955, 0.955, 0.955, 0.955, 0.955, 0.955, 0.955}
	unrelC := make([]float64, 20)
	for i := range 18 {
		unrelC[i] = 0.105
	}
	unrelC[18] = 0.955
	unrelC[19] = 0.955
	cases := []struct {
		name          string
		relatedCos    []float64
		unrelatedCos  []float64
		wantDecision  string
		wantThreshold float64
		wantPrecision float64
		wantRecall    float64
		wantFPR       float64
		wantErr       error
	}{
		{
			name:          "ok_exact_grid_threshold_and_stats",
			relatedCos:    relA,
			unrelatedCos:  unrelA,
			wantDecision:  embedding.CalDecisionOK,
			wantThreshold: 0.46,
			wantPrecision: 10.0 / 11.0,
			wantRecall:    1.0,
			wantFPR:       1.0 / 20.0,
			wantErr:       nil,
		},
		{
			name:         "recall_below_min_returns_decision_required_and_writes_report",
			relatedCos:   relB,
			unrelatedCos: unrelB,
			wantDecision: embedding.CalDecisionRequired,
			wantErr:      errSemevalDecisionRequired,
		},
		{
			name:         "no_grid_point_with_fpr_le_5pct_returns_decision_required",
			relatedCos:   relC,
			unrelatedCos: unrelC,
			wantDecision: embedding.CalDecisionRequired,
			wantErr:      errSemevalDecisionRequired,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			dir := t.TempDir()
			specs, fp := buildSpecs(tc.relatedCos, tc.unrelatedCos)
			pairsPath, pairsRaw := semevalWriteTempPairsFile(t, dir, specs)
			outPath := filepath.Join(dir, "report.json")

			client := embedding.NewClient(fp, "", "")
			var stdout bytes.Buffer
			err := semevalExecute(context.Background(), client, &stdout, pairsPath, outPath, fixedNow)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("semevalExecute error = %v, want %v", err, tc.wantErr)
			}

			// Report file must be written in all cases (including decision_required as evidence).
			reportRaw, readErr := os.ReadFile(outPath)
			if readErr != nil {
				t.Fatalf("expected report file written at %s: %v", outPath, readErr)
			}
			if len(reportRaw) == 0 || reportRaw[len(reportRaw)-1] != '\n' {
				t.Fatalf("expected report file to end with trailing newline")
			}

			rep := semevalDecodeStrictReport(t, reportRaw)
			if rep.Schema != embedding.CalReportSchema {
				t.Errorf("schema = %q, want %q", rep.Schema, embedding.CalReportSchema)
			}
			if rep.Decision != tc.wantDecision {
				t.Errorf("decision = %q, want %q", rep.Decision, tc.wantDecision)
			}
			if rep.GeneratedAt != "2026-11-02T05:30:00Z" {
				t.Errorf("generated_at = %q, want 2026-11-02T05:30:00Z", rep.GeneratedAt)
			}
			if rep.Synthetic {
				t.Errorf("synthetic = true, want false")
			}
			if rep.Note != semevalReportNote {
				t.Errorf("note = %q, want %q", rep.Note, semevalReportNote)
			}
			wantSHA := sha256.Sum256(pairsRaw)
			if rep.PairsSHA256 != hex.EncodeToString(wantSHA[:]) {
				t.Errorf("pairs_sha256 = %q, want %x", rep.PairsSHA256, wantSHA)
			}
			if rep.PairsFile != filepath.ToSlash(pairsPath) {
				t.Errorf("pairs_file = %q, want %q", rep.PairsFile, filepath.ToSlash(pairsPath))
			}

			recomputed := embedding.SelectThreshold(rep.Results)
			if recomputed.Decision != rep.Decision ||
				math.Abs(recomputed.Threshold-rep.Threshold) > 1e-12 ||
				math.Abs(recomputed.Precision-rep.Precision) > 1e-12 ||
				math.Abs(recomputed.Recall-rep.Recall) > 1e-12 ||
				math.Abs(recomputed.FPR-rep.FPR) > 1e-12 {
				t.Errorf("report stats %+v do not match SelectThreshold(rep.Results) %+v", rep, recomputed)
			}

			if tc.wantDecision == embedding.CalDecisionOK {
				if math.Abs(rep.Threshold-tc.wantThreshold) > 1e-9 {
					t.Errorf("threshold = %v, want %v", rep.Threshold, tc.wantThreshold)
				}
				if math.Abs(rep.Precision-tc.wantPrecision) > 1e-6 {
					t.Errorf("precision = %v, want %v", rep.Precision, tc.wantPrecision)
				}
				if math.Abs(rep.Recall-tc.wantRecall) > 1e-6 {
					t.Errorf("recall = %v, want %v", rep.Recall, tc.wantRecall)
				}
				if math.Abs(rep.FPR-tc.wantFPR) > 1e-6 {
					t.Errorf("fpr = %v, want %v", rep.FPR, tc.wantFPR)
				}
				if !strings.Contains(stdout.String(), "decision=ok") {
					t.Errorf("stdout %q missing decision=ok", stdout.String())
				}
			} else {
				if !strings.Contains(stdout.String(), "decision=decision_required (do not enable semantic)") {
					t.Errorf("stdout %q missing decision_required diagnostic", stdout.String())
				}
			}

			// Verify batching respected MaxBatch=3 for 30 pairs -> 10 batches of 3.
			if len(fp.docBatches) != 10 {
				t.Errorf("expected 10 document batches of size <= 3, got %d", len(fp.docBatches))
			}
		})
	}
}

func TestSemevalEndToEndTEIAndPrivacy(t *testing.T) {
	t.Parallel()

	const (
		queryPrefix = "query: "
		docPrefix   = "passage: "
		dims        = 16
	)

	srv := embedtest.NewServer(embedtest.Options{
		Dims:        dims,
		ModelID:     "BAAI/bge-m3",
		ModelSHA:    "teisha999",
		QueryPrefix: queryPrefix,
	})
	defer srv.Close()

	specs := []semevalTestPairSpec{
		{
			id:         "p001",
			query:      "  VCB Ngân Hàng  ",
			target:     "  Ngân hàng Vietcombank ",
			targetKind: "item",
			hint:       " Tài khoản thanh toán chính ",
			label:      "related",
			lang:       "vi",
			category:   "abbrev",
		},
		{
			id:         "p002",
			query:      "thẻ tín dụng quốc tế",
			target:     "tai-chinh-ca-nhan",
			targetKind: "tag",
			hint:       "",
			label:      "related",
			lang:       "vi",
			category:   "tag",
		},
		{
			id:         "p003",
			query:      "mật khẩu wifi khách",
			target:     "Router Phòng Khách",
			targetKind: "item",
			hint:       "",
			label:      "related",
			lang:       "vi",
			category:   "diacritics",
		},
		{
			id:         "p004",
			query:      "công thức nấu phở bò",
			target:     "Hoá đơn tiền điện EVN",
			targetKind: "item",
			hint:       "Thanh toán hàng tháng",
			label:      "unrelated",
			lang:       "vi",
			category:   "noise",
		},
	}

	// Set aliases on embedtest server so related queries (after queryPrefix strip
	// or with queryPrefix) map to the exact prefixed document input (cos = 1.0).
	srv.SetAliases(map[string]string{
		"vcb ngân hàng":        docPrefix + "Ngân hàng Vietcombank — Tài khoản thanh toán chính",
		"thẻ tín dụng quốc tế": docPrefix + "tai-chinh-ca-nhan",
		"mật khẩu wifi khách":  docPrefix + "Router Phòng Khách",
	})

	dir := t.TempDir()
	pairsPath, pairsRaw := semevalWriteTempPairsFile(t, dir, specs)
	outPath1 := filepath.Join(dir, "report-1.json")
	outPath2 := filepath.Join(dir, "report-2.json")

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	cfg := &config.Config{
		Env:                    "development",
		EmbeddingProvider:      embedding.ProviderTEI,
		TEIURL:                 embedding.NewEndpoint(srv.URL()),
		TEIInputPrefixQuery:    queryPrefix,
		TEIInputPrefixDocument: docPrefix,
		EmbeddingDimensions:    dims,
	}

	client, err := embedding.NewClientFromConfig(
		context.Background(),
		cfg.EmbeddingPrimary(),
		embedding.RolePrimary,
		embedding.ClientDeps{Logger: logger},
	)
	if err != nil {
		t.Fatalf("NewClientFromConfig: %v", err)
	}

	fixedClock := func() time.Time {
		return time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	}

	var stdout1, stdout2 bytes.Buffer
	if err := semevalExecute(context.Background(), client, &stdout1, pairsPath, outPath1, fixedClock); err != nil {
		t.Fatalf("first semevalExecute failed: %v", err)
	}
	// Inspect recorded server calls to verify plan 2.14 input formatting and prefixes.
	calls := srv.Calls()
	if len(calls) != 1+len(specs) {
		t.Fatalf("expected 1 document batch call + %d query calls, got %d calls", len(specs), len(calls))
	}
	wantDocInputs := []string{
		docPrefix + "Ngân hàng Vietcombank — Tài khoản thanh toán chính",
		docPrefix + "tai-chinh-ca-nhan",
		docPrefix + "Router Phòng Khách",
		docPrefix + "Hoá đơn tiền điện EVN — Thanh toán hàng tháng",
	}
	if len(calls[0].Inputs) != len(wantDocInputs) {
		t.Fatalf("doc batch inputs = %v, want %v", calls[0].Inputs, wantDocInputs)
	}
	for i, want := range wantDocInputs {
		if calls[0].Inputs[i] != want {
			t.Errorf("doc input[%d] = %q, want %q", i, calls[0].Inputs[i], want)
		}
	}
	wantQueryInputs := []string{
		queryPrefix + "vcb ngân hàng",
		queryPrefix + "thẻ tín dụng quốc tế",
		queryPrefix + "mật khẩu wifi khách",
		queryPrefix + "công thức nấu phở bò",
	}
	for i, want := range wantQueryInputs {
		got := calls[1+i].Inputs
		if len(got) != 1 || got[0] != want {
			t.Errorf("query call %d inputs = %v, want [%q]", i, got, want)
		}
	}

	// Second helper run with the same fixed clock to verify deterministic report bytes.
	if err := semevalExecute(context.Background(), client, &stdout2, pairsPath, outPath2, fixedClock); err != nil {
		t.Fatalf("second semevalExecute failed: %v", err)
	}

	raw1, err := os.ReadFile(outPath1)
	if err != nil {
		t.Fatalf("read outPath1: %v", err)
	}
	raw2, err := os.ReadFile(outPath2)
	if err != nil {
		t.Fatalf("read outPath2: %v", err)
	}
	if !bytes.Equal(raw1, raw2) {
		t.Fatalf("expected identical report bytes across two runs with fixed clock")
	}

	// Verify JSON key order matches the README / committed fake report layout.
	wantKeysInOrder := []string{
		`"schema":`,
		`"provider":`,
		`"model":`,
		`"model_version":`,
		`"dims":`,
		`"pairs_file":`,
		`"pairs_sha256":`,
		`"grid":`,
		`"max_fpr":`,
		`"min_recall":`,
		`"threshold":`,
		`"precision":`,
		`"recall":`,
		`"fpr":`,
		`"decision":`,
		`"generated_at":`,
		`"synthetic":`,
		`"note":`,
		`"results":`,
	}
	reportStr := string(raw1)
	lastIdx := -1
	for _, k := range wantKeysInOrder {
		idx := strings.Index(reportStr, k)
		if idx < 0 {
			t.Fatalf("report JSON missing key %s", k)
		}
		if idx <= lastIdx {
			t.Fatalf("report JSON key %s appeared out of order at %d (prev %d)", k, idx, lastIdx)
		}
		lastIdx = idx
	}
	rep := semevalDecodeStrictReport(t, raw1)
	if rep.Provider != client.Identity.Provider ||
		rep.Model != client.Identity.Model ||
		rep.ModelVersion != client.Identity.ModelVersion ||
		rep.Dims != client.Identity.Dims {
		t.Errorf("report identity (%s, %s, %s, %d) != client identity (%s, %s, %s, %d)",
			rep.Provider, rep.Model, rep.ModelVersion, rep.Dims,
			client.Identity.Provider, client.Identity.Model, client.Identity.ModelVersion, client.Identity.Dims)
	}
	wantSHA := sha256.Sum256(pairsRaw)
	if rep.PairsSHA256 != hex.EncodeToString(wantSHA[:]) {
		t.Errorf("pairs_sha256 = %q, want %x", rep.PairsSHA256, wantSHA)
	}
	for i := range 3 {
		if math.Abs(rep.Results[i].Cos-1.0) > 1e-6 {
			t.Errorf("related pair %s cos = %v, want 1.0", rep.Results[i].ID, rep.Results[i].Cos)
		}
	}

	// Privacy assertion: stdout from both runs, slog buffer, and report must never
	// contain any query, target, hint, or the server URL.
	combinedOutput := stdout1.String() + "\n" + stdout2.String() + "\n" + logBuf.String() + "\n" + string(raw1) + "\n" + string(raw2)
	sensitiveStrings := []string{
		"VCB Ngân Hàng",
		"vcb ngân hàng",
		"Ngân hàng Vietcombank",
		"Tài khoản thanh toán chính",
		"thẻ tín dụng quốc tế",
		"tai-chinh-ca-nhan",
		"mật khẩu wifi khách",
		"Router Phòng Khách",
		"công thức nấu phở bò",
		"Hoá đơn tiền điện EVN",
		"Thanh toán hàng tháng",
		srv.URL(),
	}
	for _, secret := range sensitiveStrings {
		if secret != "" && strings.Contains(combinedOutput, secret) {
			t.Errorf("privacy violation: output/log/report leaked sensitive token %q", secret)
		}
	}
}

func TestSemevalDispatchConfiguredTEIAndPrivacy(t *testing.T) {
	t.Parallel()

	const (
		queryPrefix = "query: "
		docPrefix   = "passage: "
		dims        = 16
	)

	specs := []semevalTestPairSpec{
		{
			id:         "p001",
			query:      "  VCB Ngân Hàng Dispatch  ",
			target:     "  Ngân hàng Vietcombank Dispatch ",
			targetKind: "item",
			hint:       " Tài khoản thanh toán chính Dispatch ",
			label:      "related",
			lang:       "vi",
			category:   "abbrev",
		},
		{
			id:         "p002",
			query:      "thẻ tín dụng quốc tế dispatch",
			target:     "tai-chinh-ca-nhan-dispatch",
			targetKind: "tag",
			hint:       "",
			label:      "related",
			lang:       "vi",
			category:   "tag",
		},
		{
			id:         "p003",
			query:      "mật khẩu wifi khách dispatch",
			target:     "Router Phòng Khách Dispatch",
			targetKind: "item",
			hint:       "",
			label:      "related",
			lang:       "vi",
			category:   "diacritics",
		},
		{
			id:         "p004",
			query:      "công thức nấu phở bò dispatch",
			target:     "Hoá đơn tiền điện EVN Dispatch",
			targetKind: "item",
			hint:       "Thanh toán hàng tháng Dispatch",
			label:      "unrelated",
			lang:       "vi",
			category:   "noise",
		},
	}

	sensitiveTokens := []string{
		"VCB Ngân Hàng Dispatch",
		"vcb ngân hàng dispatch",
		"Ngân hàng Vietcombank Dispatch",
		"Tài khoản thanh toán chính Dispatch",
		"thẻ tín dụng quốc tế dispatch",
		"tai-chinh-ca-nhan-dispatch",
		"mật khẩu wifi khách dispatch",
		"Router Phòng Khách Dispatch",
		"công thức nấu phở bò dispatch",
		"Hoá đơn tiền điện EVN Dispatch",
		"Thanh toán hàng tháng Dispatch",
	}

	t.Run("success_writes_report_with_tei_identity_and_preserves_privacy", func(t *testing.T) {
		t.Parallel()
		srv := embedtest.NewServer(embedtest.Options{
			Dims:        dims,
			ModelID:     "BAAI/bge-m3",
			ModelSHA:    "teisha-dispatch-ok",
			QueryPrefix: queryPrefix,
		})
		defer srv.Close()

		srv.SetAliases(map[string]string{
			"vcb ngân hàng dispatch":        docPrefix + "Ngân hàng Vietcombank Dispatch — Tài khoản thanh toán chính Dispatch",
			"thẻ tín dụng quốc tế dispatch": docPrefix + "tai-chinh-ca-nhan-dispatch",
			"mật khẩu wifi khách dispatch":  docPrefix + "Router Phòng Khách Dispatch",
		})

		dir := t.TempDir()
		pairsPath, pairsRaw := semevalWriteTempPairsFile(t, dir, specs)
		outPath := filepath.Join(dir, "dispatch-report.json")

		var stdout, stderr, logBuf bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
		cfg := &config.Config{
			Env:                    "development",
			EmbeddingProvider:      embedding.ProviderTEI,
			TEIURL:                 embedding.NewEndpoint(srv.URL()),
			TEIInputPrefixQuery:    queryPrefix,
			TEIInputPrefixDocument: docPrefix,
			EmbeddingDimensions:    dims,
		}
		env := Env{
			Cfg:    cfg,
			Logger: logger,
			Stdout: &stdout,
			Stderr: &stderr,
		}

		wantClient, err := embedding.NewClientFromConfig(
			context.Background(),
			cfg.EmbeddingPrimary(),
			embedding.RolePrimary,
			embedding.ClientDeps{},
		)
		if err != nil {
			t.Fatalf("NewClientFromConfig reference: %v", err)
		}

		code := defaultRegistry.dispatch(
			context.Background(),
			env,
			[]string{"semeval", "--pairs", pairsPath, "--out", outPath},
			func(ctx context.Context, env Env) error {
				t.Fatal("runWorker must not be called")
				return nil
			},
		)
		if code != 0 {
			t.Fatalf("dispatch exit code = %d, want 0 (stderr=%q)", code, stderr.String())
		}
		if stderr.Len() != 0 {
			t.Errorf("expected empty stderr on success, got %q", stderr.String())
		}
		if !strings.Contains(stdout.String(), "decision=ok") {
			t.Errorf("expected stdout to contain decision=ok, got %q", stdout.String())
		}

		reportRaw, err := os.ReadFile(outPath)
		if err != nil {
			t.Fatalf("read dispatched report: %v", err)
		}
		rep := semevalDecodeStrictReport(t, reportRaw)
		if rep.Provider != wantClient.Identity.Provider ||
			rep.Model != wantClient.Identity.Model ||
			rep.ModelVersion != wantClient.Identity.ModelVersion ||
			rep.Dims != wantClient.Identity.Dims {
			t.Errorf("report identity (%s, %s, %s, %d) != tei client identity (%s, %s, %s, %d)",
				rep.Provider, rep.Model, rep.ModelVersion, rep.Dims,
				wantClient.Identity.Provider, wantClient.Identity.Model, wantClient.Identity.ModelVersion, wantClient.Identity.Dims)
		}
		wantSHA := sha256.Sum256(pairsRaw)
		if rep.PairsSHA256 != hex.EncodeToString(wantSHA[:]) {
			t.Errorf("pairs_sha256 = %q, want %x", rep.PairsSHA256, wantSHA)
		}

		combined := stdout.String() + "\n" + stderr.String() + "\n" + logBuf.String() + "\n" + string(reportRaw)
		for _, secret := range append(append([]string(nil), sensitiveTokens...), srv.URL()) {
			if secret != "" && strings.Contains(combined, secret) {
				t.Errorf("privacy violation: dispatch success leaked %q", secret)
			}
		}
	})

	t.Run("provider_5xx_via_dispatch_exits_1_without_report_or_leak", func(t *testing.T) {
		t.Parallel()
		srv := embedtest.NewServer(embedtest.Options{
			Dims:        dims,
			ModelID:     "BAAI/bge-m3",
			ModelSHA:    "teisha-dispatch-5xx",
			QueryPrefix: queryPrefix,
		})
		defer srv.Close()
		srv.Set5xx(503)

		dir := t.TempDir()
		pairsPath, _ := semevalWriteTempPairsFile(t, dir, specs)
		outPath := filepath.Join(dir, "dispatch-5xx-report.json")

		var stdout, stderr, logBuf bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
		cfg := &config.Config{
			Env:                    "development",
			EmbeddingProvider:      embedding.ProviderTEI,
			TEIURL:                 embedding.NewEndpoint(srv.URL()),
			TEIInputPrefixQuery:    queryPrefix,
			TEIInputPrefixDocument: docPrefix,
			EmbeddingDimensions:    dims,
		}
		env := Env{
			Cfg:    cfg,
			Logger: logger,
			Stdout: &stdout,
			Stderr: &stderr,
		}

		code := defaultRegistry.dispatch(
			context.Background(),
			env,
			[]string{"semeval", "--pairs", pairsPath, "--out", outPath},
			func(ctx context.Context, env Env) error {
				t.Fatal("runWorker must not be called")
				return nil
			},
		)
		if code != 1 {
			t.Fatalf("dispatch exit code = %d, want 1 on provider 5xx", code)
		}
		if stdout.Len() != 0 {
			t.Errorf("expected empty stdout on provider 5xx, got %q", stdout.String())
		}
		if !strings.HasPrefix(stderr.String(), "semeval: ") || !strings.Contains(stderr.String(), "http_5xx") {
			t.Errorf("expected stderr to have 'semeval: ...' with http_5xx class, got %q", stderr.String())
		}
		if _, statErr := os.Stat(outPath); !errors.Is(statErr, os.ErrNotExist) {
			t.Errorf("expected no report file written on provider 5xx, stat err = %v", statErr)
		}

		combined := stdout.String() + "\n" + stderr.String() + "\n" + logBuf.String()
		for _, secret := range append(append([]string(nil), sensitiveTokens...), srv.URL()) {
			if secret != "" && strings.Contains(combined, secret) {
				t.Errorf("privacy violation: dispatch 5xx leaked %q", secret)
			}
		}
	})
}

func TestSemevalErrorsAndPrivacy(t *testing.T) {
	t.Parallel()

	t.Run("noop_provider_fails_before_file_io", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		outPath := filepath.Join(dir, "out.json")
		env, stdout, stderr := newTestEnv()
		env.Cfg.EmbeddingProvider = embedding.ProviderNoop

		code := defaultRegistry.dispatch(
			context.Background(),
			env,
			[]string{"semeval", "--pairs", filepath.Join(dir, "nonexistent.jsonl"), "--out", outPath},
			func(ctx context.Context, env Env) error { return nil },
		)
		if code != 1 {
			t.Fatalf("expected exit code 1 for noop provider, got %d", code)
		}
		if stdout.Len() != 0 {
			t.Errorf("expected empty stdout, got %q", stdout.String())
		}
		if !strings.Contains(stderr.String(), "semantic provider not configured (EMBEDDING_PROVIDER=noop)") {
			t.Errorf("unexpected stderr: %q", stderr.String())
		}
		if _, err := os.Stat(outPath); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("expected no output file created")
		}
	})

	t.Run("refuses_to_overwrite_existing_out_file", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		outPath := filepath.Join(dir, "existing.json")
		original := []byte("{\"keep\":\"me\"}\n")
		if err := os.WriteFile(outPath, original, 0o644); err != nil {
			t.Fatalf("write existing file: %v", err)
		}
		fp := &semevalFakeProvider{
			name:         embedding.ProviderTEI,
			model:        "tei/test",
			modelVersion: "v1;qp=00000000;dp=00000000",
			dims:         2,
		}
		client := embedding.NewClient(fp, "", "")
		err := semevalExecute(context.Background(), client, io.Discard, filepath.Join(dir, "missing.jsonl"), outPath, time.Now)
		if err == nil || !strings.Contains(err.Error(), "already exists") {
			t.Fatalf("expected overwrite error, got %v", err)
		}
		got, readErr := os.ReadFile(outPath)
		if readErr != nil || !bytes.Equal(got, original) {
			t.Fatalf("existing file was modified: %q", string(got))
		}
	})

	t.Run("concurrent_publication_allows_exactly_one_winner_and_leaves_no_tmp", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		outPath := filepath.Join(dir, "concurrent-report.json")

		const workers = 8
		start := make(chan struct{})

		type publishResult struct {
			idx     int
			err     error
			encoded []byte
		}
		resultsCh := make(chan publishResult, workers)

		var wg sync.WaitGroup
		wg.Add(workers)
		for i := range workers {
			go func(idx int) {
				defer wg.Done()
				rep := semevalReport{
					Schema:       embedding.CalReportSchema,
					Provider:     embedding.ProviderTEI,
					Model:        fmt.Sprintf("tei/worker-%d", idx),
					ModelVersion: fmt.Sprintf("sha-%d;qp=00000000;dp=00000000", idx),
					Dims:         2,
					PairsFile:    "docs/benchmarks/semantic-eval/pairs.v1.jsonl",
					PairsSHA256:  strings.Repeat(fmt.Sprintf("%x", idx), 64),
					Grid: semevalGridReport{
						Min:  embedding.CalGridMin,
						Max:  embedding.CalGridMax,
						Step: embedding.CalGridStep,
					},
					MaxFPR:      embedding.CalMaxFPR,
					MinRecall:   embedding.CalMinRecall,
					Threshold:   0.46,
					Precision:   0.95,
					Recall:      0.90,
					FPR:         0.02,
					Decision:    embedding.CalDecisionOK,
					GeneratedAt: "2026-11-02T00:00:00Z",
					Synthetic:   false,
					Note:        semevalReportNote,
					Results: []embedding.EvalResult{
						{ID: "p001", Label: "related", Cos: 0.855},
					},
				}
				enc, mErr := json.MarshalIndent(rep, "", "  ")
				if mErr != nil {
					resultsCh <- publishResult{idx: idx, err: mErr}
					return
				}
				enc = append(enc, '\n')

				<-start
				err := semevalWriteReportAtomic(outPath, rep)
				resultsCh <- publishResult{idx: idx, err: err, encoded: enc}
			}(i)
		}

		close(start)
		wg.Wait()
		close(resultsCh)

		var winners []publishResult
		var refusals int
		for res := range resultsCh {
			if res.err == nil {
				winners = append(winners, res)
				continue
			}
			if res.err.Error() == "output file already exists (refusing to overwrite)" {
				refusals++
				continue
			}
			t.Errorf("worker %d returned unexpected error: %v", res.idx, res.err)
		}

		if len(winners) != 1 {
			t.Fatalf("expected exactly 1 winner among %d concurrent publishers, got %d", workers, len(winners))
		}
		if refusals != workers-1 {
			t.Fatalf("expected %d overwrite refusals, got %d", workers-1, refusals)
		}

		gotBytes, err := os.ReadFile(outPath)
		if err != nil {
			t.Fatalf("read published report: %v", err)
		}
		if !bytes.Equal(gotBytes, winners[0].encoded) {
			t.Fatalf("published file bytes do not match winner %d report", winners[0].idx)
		}

		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("readdir %s: %v", dir, err)
		}
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".semeval-report-") || strings.HasSuffix(e.Name(), ".tmp") {
				t.Errorf("leftover temporary file in output directory: %s", e.Name())
			}
		}
	})

	t.Run("malformed_lines_and_schema_errors_never_echo_input_text", func(t *testing.T) {
		t.Parallel()
		secretText := "SECRET-QUERY-SENTINEL-98765"
		cases := []struct {
			name       string
			content    string
			wantSubstr string
		}{
			{
				name:       "malformed_json",
				content:    `{"id":"p001","query":"` + secretText + `"` + "\n",
				wantSubstr: "line 1",
			},
			{
				name:       "unknown_key",
				content:    `{"id":"p001","query":"` + secretText + `","target":"Target","target_kind":"item","hint":"","label":"related","lang":"vi","category":"abbrev","extra":"` + secretText + `"}` + "\n",
				wantSubstr: "line 1",
			},
			{
				name: "duplicate_id",
				content: `{"id":"p001","query":"` + secretText + `","target":"Target 1","target_kind":"item","hint":"","label":"related","lang":"vi","category":"abbrev"}` + "\n" +
					`{"id":"p001","query":"` + secretText + `","target":"Target 2","target_kind":"item","hint":"","label":"unrelated","lang":"vi","category":"abbrev"}` + "\n",
				wantSubstr: "p001",
			},
			{
				name:       "bad_label",
				content:    `{"id":"p009","query":"` + secretText + `","target":"Target","target_kind":"item","hint":"","label":"maybe","lang":"vi","category":"abbrev"}` + "\n",
				wantSubstr: "p009",
			},
			{
				name:       "bad_target_kind",
				content:    `{"id":"p010","query":"` + secretText + `","target":"Target","target_kind":"entry","hint":"","label":"related","lang":"vi","category":"abbrev"}` + "\n",
				wantSubstr: "p010",
			},
		}

		fp := &semevalFakeProvider{
			name:         embedding.ProviderTEI,
			model:        "tei/test",
			modelVersion: "v1;qp=00000000;dp=00000000",
			dims:         2,
		}
		client := embedding.NewClient(fp, "", "")

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				t.Parallel()
				dir := t.TempDir()
				pairsPath := filepath.Join(dir, "pairs.jsonl")
				outPath := filepath.Join(dir, "out.json")
				if err := os.WriteFile(pairsPath, []byte(tc.content), 0o600); err != nil {
					t.Fatalf("write pairs: %v", err)
				}
				err := semevalExecute(context.Background(), client, io.Discard, pairsPath, outPath, time.Now)
				if err == nil {
					t.Fatalf("expected error for %s, got nil", tc.name)
				}
				if !strings.Contains(err.Error(), tc.wantSubstr) {
					t.Errorf("error %q does not mention %q", err.Error(), tc.wantSubstr)
				}
				if strings.Contains(err.Error(), secretText) {
					t.Errorf("privacy violation: error %q leaked secret text", err.Error())
				}
				if _, statErr := os.Stat(outPath); !errors.Is(statErr, os.ErrNotExist) {
					t.Errorf("expected no output file on error")
				}
			})
		}
	})

	t.Run("provider_5xx_fails_without_output_or_leaking_text", func(t *testing.T) {
		t.Parallel()
		srv := embedtest.NewServer(embedtest.Options{Dims: 8})
		defer srv.Close()

		var logBuf bytes.Buffer
		logger := slog.New(slog.NewTextHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

		cfg := &config.Config{
			Env:                 "development",
			EmbeddingProvider:   embedding.ProviderTEI,
			TEIURL:              embedding.NewEndpoint(srv.URL()),
			EmbeddingDimensions: 8,
		}
		client, err := embedding.NewClientFromConfig(
			context.Background(),
			cfg.EmbeddingPrimary(),
			embedding.RolePrimary,
			embedding.ClientDeps{Logger: logger},
		)
		if err != nil {
			t.Fatalf("NewClientFromConfig: %v", err)
		}

		// Switch server to 5xx after /info succeeds during client init.
		srv.Set5xx(503)

		dir := t.TempDir()
		secretQuery := "secret-query-5xx-sentinel"
		secretTarget := "Secret Target 5xx Sentinel"
		specs := []semevalTestPairSpec{
			{
				id:         "p001",
				query:      secretQuery,
				target:     secretTarget,
				targetKind: "item",
				hint:       "Secret Hint Sentinel",
				label:      "related",
			},
		}
		pairsPath, _ := semevalWriteTempPairsFile(t, dir, specs)
		outPath := filepath.Join(dir, "out.json")

		var stdout bytes.Buffer
		runErr := semevalExecute(context.Background(), client, &stdout, pairsPath, outPath, time.Now)
		if runErr == nil {
			t.Fatalf("expected error on 5xx provider response")
		}
		if !strings.Contains(runErr.Error(), "p001") || !strings.Contains(runErr.Error(), "http_5xx") {
			t.Errorf("expected error to mention pair id and http_5xx outcome, got %q", runErr.Error())
		}
		combined := runErr.Error() + "\n" + stdout.String() + "\n" + logBuf.String()
		for _, tok := range []string{secretQuery, secretTarget, "Secret Hint Sentinel", srv.URL()} {
			if strings.Contains(combined, tok) {
				t.Errorf("privacy violation: 5xx failure leaked %q", tok)
			}
		}
		if _, statErr := os.Stat(outPath); !errors.Is(statErr, os.ErrNotExist) {
			t.Errorf("expected no output file created on 5xx failure")
		}
	})

	t.Run("flag_and_positional_arg_validation", func(t *testing.T) {
		t.Parallel()
		dir := t.TempDir()
		outPath := filepath.Join(dir, "out.json")

		for _, args := range [][]string{
			{"semeval"},
			{"semeval", "--out", outPath, "extra-arg"},
			{"semeval", "--pairs", "", "--out", outPath},
			{"semeval", "--unknown-flag"},
		} {
			env, _, _ := newTestEnv()
			code := defaultRegistry.dispatch(context.Background(), env, args, func(ctx context.Context, env Env) error {
				return nil
			})
			if code != 1 {
				t.Errorf("args %v: expected exit code 1, got %d", args, code)
			}
		}
	})

	t.Run("cosine_edge_cases_name_pair_id", func(t *testing.T) {
		t.Parallel()
		if _, err := semevalCosine([]float32{1, 0}, []float32{1}, "p042"); err == nil || !strings.Contains(err.Error(), "p042") {
			t.Errorf("expected length mismatch error naming p042, got %v", err)
		}
		if _, err := semevalCosine([]float32{0, 0}, []float32{1, 0}, "p043"); err == nil || !strings.Contains(err.Error(), "p043") {
			t.Errorf("expected zero norm error naming p043, got %v", err)
		}
		if _, err := semevalCosine([]float32{float32(math.NaN()), 1}, []float32{1, 0}, "p044"); err == nil || !strings.Contains(err.Error(), "p044") {
			t.Errorf("expected NaN error naming p044, got %v", err)
		}
	})
}

func TestSemevalRegisteredAndHelp(t *testing.T) {
	t.Parallel()

	env, stdout, stderr := newTestEnv()
	code := defaultRegistry.dispatch(context.Background(), env, []string{"help"}, func(ctx context.Context, env Env) error {
		t.Fatal("runWorker must not be called")
		return nil
	})
	if code != 0 {
		t.Fatalf("help exit code = %d, want 0", code)
	}
	if !strings.Contains(stdout.String(), "semeval") {
		t.Fatalf("expected defaultRegistry help to list semeval, got %q", stdout.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("expected empty stderr on help, got %q", stderr.String())
	}

	envH, stdoutH, _ := newTestEnv()
	codeH := defaultRegistry.dispatch(context.Background(), envH, []string{"semeval", "-h"}, func(ctx context.Context, env Env) error {
		t.Fatal("runWorker must not be called")
		return nil
	})
	if codeH != 0 {
		t.Fatalf("semeval -h exit code = %d, want 0", codeH)
	}
	if stdoutH.Len() != 0 {
		t.Fatalf("expected empty stdout on semeval -h, got %q", stdoutH.String())
	}
}

func TestSemevalCommittedPairsFileDecodes(t *testing.T) {
	t.Parallel()

	committedPath := filepath.Join("..", "..", "..", "..", filepath.FromSlash(semevalDefaultPairsPath))
	if _, err := os.Stat(committedPath); err != nil {
		t.Skipf("committed pairs file not found at %s: %v", committedPath, err)
	}
	pairs, shaHex, rel, unrel, err := semevalLoadPairs(committedPath)
	if err != nil {
		t.Fatalf("semevalLoadPairs(%s) failed: %v", committedPath, err)
	}
	if len(pairs) < 80 || rel < 40 || unrel < 30 || len(shaHex) != 64 {
		t.Fatalf("unexpected counts: total=%d related=%d unrelated=%d sha=%s", len(pairs), rel, unrel, shaHex)
	}
}
