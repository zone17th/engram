package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/textnorm"
)

const (
	semevalDefaultPairsPath = "docs/benchmarks/semantic-eval/pairs.v1.jsonl"
	semevalReportNote       = "worker semeval"
)

var (
	errSemevalNoopProvider     = errors.New("semantic provider not configured (EMBEDDING_PROVIDER=noop)")
	errSemevalDecisionRequired = errors.New("decision_required (do not enable semantic)")

	semevalValidCategories = map[string]bool{
		"abbrev":        true,
		"diacritics":    true,
		"no_diacritics": true,
		"short_name":    true,
		"cross_lang":    true,
		"tag":           true,
		"noise":         true,
	}
	semevalValidLangs = map[string]bool{
		"vi":    true,
		"en":    true,
		"mixed": true,
	}
)

func init() {
	Register(Command{
		Name:    "semeval",
		Summary: "evaluate semantic_min_cos threshold on evaluation pairs",
		Run:     semevalRun,
	})
}

type semevalPairRow struct {
	ID         *string `json:"id"`
	Query      *string `json:"query"`
	Target     *string `json:"target"`
	TargetKind *string `json:"target_kind"`
	Hint       *string `json:"hint"`
	Label      *string `json:"label"`
	Lang       *string `json:"lang"`
	Category   *string `json:"category"`
}

type semevalPair struct {
	id         string
	query      string
	target     string
	targetKind string
	hint       string
	label      string
	docInput   string
	queryInput string
}

type semevalGridReport struct {
	Min  float64 `json:"min"`
	Max  float64 `json:"max"`
	Step float64 `json:"step"`
}

type semevalReport struct {
	Schema       string                 `json:"schema"`
	Provider     string                 `json:"provider"`
	Model        string                 `json:"model"`
	ModelVersion string                 `json:"model_version"`
	Dims         int                    `json:"dims"`
	PairsFile    string                 `json:"pairs_file"`
	PairsSHA256  string                 `json:"pairs_sha256"`
	Grid         semevalGridReport      `json:"grid"`
	MaxFPR       float64                `json:"max_fpr"`
	MinRecall    float64                `json:"min_recall"`
	Threshold    float64                `json:"threshold"`
	Precision    float64                `json:"precision"`
	Recall       float64                `json:"recall"`
	FPR          float64                `json:"fpr"`
	Decision     string                 `json:"decision"`
	GeneratedAt  string                 `json:"generated_at"`
	Synthetic    bool                   `json:"synthetic"`
	Note         string                 `json:"note"`
	Results      []embedding.EvalResult `json:"results"`
}

func semevalRun(ctx context.Context, env Env, args []string) error {
	fs := flag.NewFlagSet("semeval", flag.ContinueOnError)
	fs.SetOutput(env.Stderr)
	pairsPath := fs.String("pairs", semevalDefaultPairsPath, "evaluation pairs JSONL path")
	outPath := fs.String("out", "", "output report JSON path (required)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return errors.New("unexpected positional arguments")
	}
	if strings.TrimSpace(*outPath) == "" {
		return errors.New("--out is required")
	}
	if strings.TrimSpace(*pairsPath) == "" {
		return errors.New("--pairs must not be empty")
	}

	var primaryCfg embedding.ClientConfig
	if env.Cfg != nil {
		primaryCfg = env.Cfg.EmbeddingPrimary()
	}
	primaryProvider := strings.TrimSpace(primaryCfg.Provider)
	if primaryProvider == "" || primaryProvider == embedding.ProviderNoop {
		return errSemevalNoopProvider
	}

	client, err := embedding.NewClientFromConfig(
		ctx,
		primaryCfg,
		embedding.RolePrimary,
		embedding.ClientDeps{Logger: env.Logger},
	)
	if err != nil {
		return fmt.Errorf("init provider client: %s", embedding.OutcomeForError(err))
	}

	return semevalExecute(ctx, client, env.Stdout, *pairsPath, *outPath, time.Now)
}

func semevalExecute(
	ctx context.Context,
	client embedding.Client,
	stdout io.Writer,
	pairsPath string,
	outPath string,
	now func() time.Time,
) error {
	if client.Provider == nil || client.Provider.Name() == "" || client.Provider.Name() == embedding.ProviderNoop {
		return errSemevalNoopProvider
	}
	if strings.TrimSpace(outPath) == "" {
		return errors.New("--out is required")
	}
	if strings.TrimSpace(pairsPath) == "" {
		return errors.New("--pairs must not be empty")
	}
	if err := semevalCheckOutputNotExists(outPath); err != nil {
		return err
	}

	pairs, pairsSHA256, relatedCount, unrelatedCount, err := semevalLoadPairs(pairsPath)
	if err != nil {
		return err
	}

	docVecs, err := semevalEmbedDocuments(ctx, client.Provider, pairs)
	if err != nil {
		return err
	}

	results := make([]embedding.EvalResult, len(pairs))
	for i, p := range pairs {
		qVec, qErr := client.Provider.EmbedQuery(ctx, p.queryInput)
		if qErr != nil {
			return fmt.Errorf("embed query for pair %s: %s", p.id, embedding.OutcomeForError(qErr))
		}
		cos, cosErr := semevalCosine(qVec, docVecs[i], p.id)
		if cosErr != nil {
			return cosErr
		}
		results[i] = embedding.EvalResult{
			ID:    p.id,
			Label: p.label,
			Cos:   cos,
		}
	}

	d := embedding.SelectThreshold(results)

	if now == nil {
		now = time.Now
	}
	id := client.Identity
	if id.Provider == "" {
		id.Provider = client.Provider.Name()
	}
	if id.Model == "" {
		id.Model = client.Provider.Model()
	}
	if id.ModelVersion == "" {
		id.ModelVersion = client.Provider.ModelVersion()
	}
	if id.Dims == 0 {
		id.Dims = client.Provider.Dims()
	}

	report := semevalReport{
		Schema:       embedding.CalReportSchema,
		Provider:     id.Provider,
		Model:        id.Model,
		ModelVersion: id.ModelVersion,
		Dims:         id.Dims,
		PairsFile:    filepath.ToSlash(pairsPath),
		PairsSHA256:  pairsSHA256,
		Grid: semevalGridReport{
			Min:  embedding.CalGridMin,
			Max:  embedding.CalGridMax,
			Step: embedding.CalGridStep,
		},
		MaxFPR:      embedding.CalMaxFPR,
		MinRecall:   embedding.CalMinRecall,
		Threshold:   d.Threshold,
		Precision:   d.Precision,
		Recall:      d.Recall,
		FPR:         d.FPR,
		Decision:    d.Decision,
		GeneratedAt: now().UTC().Format(time.RFC3339),
		Synthetic:   false,
		Note:        semevalReportNote,
		Results:     results,
	}

	if err := semevalWriteReportAtomic(outPath, report); err != nil {
		return err
	}

	if stdout != nil {
		decisionLabel := d.Decision
		if d.Decision == embedding.CalDecisionRequired {
			decisionLabel = "decision_required (do not enable semantic)"
		}
		_, _ = fmt.Fprintf(
			stdout,
			"provider=%s model=%s dims=%d pairs=%d related=%d unrelated=%d threshold=%.2f precision=%.4f recall=%.4f fpr=%.4f decision=%s out=%s\n",
			report.Provider,
			report.Model,
			report.Dims,
			len(pairs),
			relatedCount,
			unrelatedCount,
			d.Threshold,
			d.Precision,
			d.Recall,
			d.FPR,
			decisionLabel,
			filepath.ToSlash(outPath),
		)
	}

	if d.Decision == embedding.CalDecisionRequired {
		return errSemevalDecisionRequired
	}
	return nil
}

func semevalCheckOutputNotExists(outPath string) error {
	_, err := os.Lstat(outPath)
	if err == nil {
		return errors.New("output file already exists (refusing to overwrite)")
	}
	if !errors.Is(err, os.ErrNotExist) {
		return errors.New("cannot stat output path")
	}
	return nil
}

func semevalLoadPairs(pairsPath string) ([]semevalPair, string, int, int, error) {
	raw, err := os.ReadFile(pairsPath)
	if err != nil {
		return nil, "", 0, 0, errors.New("cannot read pairs file")
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, "", 0, 0, errors.New("pairs file is empty")
	}

	sum := sha256.Sum256(raw)
	pairsSHA256 := hex.EncodeToString(sum[:])

	rawLines := bytes.Split(raw, []byte{'\n'})
	pairs := make([]semevalPair, 0, len(rawLines))
	seenIDs := make(map[string]int, len(rawLines))
	var relatedCount, unrelatedCount int

	for idx, rawLine := range rawLines {
		lineNo := idx + 1
		line := bytes.TrimRight(rawLine, "\r")
		if len(bytes.TrimSpace(line)) == 0 {
			if idx == len(rawLines)-1 && len(rawLine) == 0 {
				continue
			}
			return nil, "", 0, 0, fmt.Errorf("pairs line %d: empty line", lineNo)
		}

		var row semevalPairRow
		if err := semevalDecodeLineStrict(line, &row); err != nil {
			return nil, "", 0, 0, fmt.Errorf("pairs line %d: invalid JSON row", lineNo)
		}

		if row.ID == nil || row.Query == nil || row.Target == nil ||
			row.TargetKind == nil || row.Hint == nil || row.Label == nil ||
			row.Lang == nil || row.Category == nil {
			return nil, "", 0, 0, fmt.Errorf("pairs line %d: missing required key", lineNo)
		}

		id := strings.TrimSpace(*row.ID)
		if id == "" || id != *row.ID || !semevalIsSafeID(id) {
			return nil, "", 0, 0, fmt.Errorf("pairs line %d: invalid id", lineNo)
		}
		if prevLine, dup := seenIDs[id]; dup {
			return nil, "", 0, 0, fmt.Errorf("pairs line %d (pair %s): duplicate id (first seen on line %d)", lineNo, id, prevLine)
		}
		seenIDs[id] = lineNo

		targetKind := *row.TargetKind
		if targetKind != "item" && targetKind != "tag" {
			return nil, "", 0, 0, fmt.Errorf("pairs line %d (pair %s): invalid target_kind", lineNo, id)
		}
		if targetKind == "tag" && *row.Hint != "" {
			return nil, "", 0, 0, fmt.Errorf("pairs line %d (pair %s): tag target_kind must have empty hint", lineNo, id)
		}

		label := *row.Label
		switch label {
		case "related":
			relatedCount++
		case "unrelated":
			unrelatedCount++
		default:
			return nil, "", 0, 0, fmt.Errorf("pairs line %d (pair %s): invalid label", lineNo, id)
		}

		if !semevalValidLangs[*row.Lang] {
			return nil, "", 0, 0, fmt.Errorf("pairs line %d (pair %s): invalid lang", lineNo, id)
		}
		if !semevalValidCategories[*row.Category] {
			return nil, "", 0, 0, fmt.Errorf("pairs line %d (pair %s): invalid category", lineNo, id)
		}

		rawQuery := *row.Query
		if strings.TrimSpace(rawQuery) == "" ||
			strings.ContainsRune(rawQuery, ':') ||
			strings.ContainsRune(rawQuery, '：') ||
			utf8.RuneCountInString(rawQuery) < 3 {
			return nil, "", 0, 0, fmt.Errorf("pairs line %d (pair %s): invalid query", lineNo, id)
		}
		qn, err := textnorm.NormalizeQuery(rawQuery)
		if err != nil || qn == "" {
			return nil, "", 0, 0, fmt.Errorf("pairs line %d (pair %s): invalid query", lineNo, id)
		}

		rawTarget := *row.Target
		if strings.TrimSpace(rawTarget) == "" {
			return nil, "", 0, 0, fmt.Errorf("pairs line %d (pair %s): empty target", lineNo, id)
		}
		var docInput string
		if targetKind == "item" {
			docInput = embedding.ItemInput(rawTarget, *row.Hint)
		} else {
			docInput = embedding.TagInput(rawTarget)
		}

		pairs = append(pairs, semevalPair{
			id:         id,
			query:      rawQuery,
			target:     rawTarget,
			targetKind: targetKind,
			hint:       *row.Hint,
			label:      label,
			docInput:   docInput,
			queryInput: qn,
		})
	}

	if len(pairs) == 0 {
		return nil, "", 0, 0, errors.New("pairs file has no rows")
	}
	return pairs, pairsSHA256, relatedCount, unrelatedCount, nil
}

func semevalDecodeLineStrict(line []byte, dst *semevalPairRow) error {
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("trailing data after JSON object")
	}
	return nil
}

func semevalIsSafeID(id string) bool {
	if len(id) == 0 || len(id) > 64 {
		return false
	}
	for i := range len(id) {
		ch := id[i]
		isAlpha := (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
		isDigit := ch >= '0' && ch <= '9'
		if !isAlpha && !isDigit && ch != '_' && ch != '-' && ch != '.' {
			return false
		}
	}
	return true
}

func semevalEmbedDocuments(ctx context.Context, p embedding.Provider, pairs []semevalPair) ([][]float32, error) {
	maxBatch := p.MaxBatch()
	if maxBatch <= 0 {
		maxBatch = embedding.MaxBatch
	}

	out := make([][]float32, len(pairs))
	for start := 0; start < len(pairs); start += maxBatch {
		end := start + maxBatch
		if end > len(pairs) {
			end = len(pairs)
		}
		batchInputs := make([]string, end-start)
		for i := start; i < end; i++ {
			batchInputs[i-start] = pairs[i].docInput
		}
		firstID := pairs[start].id
		lastID := pairs[end-1].id

		vecs, err := p.EmbedDocuments(ctx, batchInputs)
		if err != nil {
			if firstID == lastID {
				return nil, fmt.Errorf("embed document for pair %s: %s", firstID, embedding.OutcomeForError(err))
			}
			return nil, fmt.Errorf("embed documents for pairs %s..%s: %s", firstID, lastID, embedding.OutcomeForError(err))
		}
		if len(vecs) != len(batchInputs) {
			return nil, fmt.Errorf("embed documents for pairs %s..%s: vector count mismatch", firstID, lastID)
		}
		for i := range vecs {
			out[start+i] = vecs[i]
		}
	}
	return out, nil
}

func semevalCosine(a, b []float32, pairID string) (float64, error) {
	if len(a) == 0 || len(a) != len(b) {
		return 0, fmt.Errorf("cosine for pair %s: vector length mismatch (%d vs %d)", pairID, len(a), len(b))
	}
	var dot, normASq, normBSq float64
	for i := range a {
		af := float64(a[i])
		bf := float64(b[i])
		if math.IsNaN(af) || math.IsInf(af, 0) || math.IsNaN(bf) || math.IsInf(bf, 0) {
			return 0, fmt.Errorf("cosine for pair %s: non-finite vector coordinate", pairID)
		}
		dot += af * bf
		normASq += af * af
		normBSq += bf * bf
	}
	normA := math.Sqrt(normASq)
	normB := math.Sqrt(normBSq)
	denom := normA * normB
	if normA == 0 || normB == 0 || denom == 0 || math.IsNaN(denom) || math.IsInf(denom, 0) {
		return 0, fmt.Errorf("cosine for pair %s: zero or non-finite vector norm", pairID)
	}
	cos := dot / denom
	if math.IsNaN(cos) || math.IsInf(cos, 0) {
		return 0, fmt.Errorf("cosine for pair %s: non-finite cosine similarity", pairID)
	}
	if cos > 1.0 && cos <= 1.0+1e-9 {
		cos = 1.0
	} else if cos < -1.0 && cos >= -1.0-1e-9 {
		cos = -1.0
	}
	if cos < -1.0 || cos > 1.0 {
		return 0, fmt.Errorf("cosine for pair %s: cosine out of range [-1, 1]", pairID)
	}
	return cos, nil
}

func semevalWriteReportAtomic(outPath string, report semevalReport) error {
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return errors.New("encode report JSON failed")
	}
	encoded = append(encoded, '\n')

	dir := filepath.Dir(outPath)
	tmpFile, err := os.CreateTemp(dir, ".semeval-report-*.tmp")
	if err != nil {
		return errors.New("cannot create temporary report file")
	}
	tmpName := tmpFile.Name()
	defer func() {
		_ = os.Remove(tmpName)
	}()

	if _, err := tmpFile.Write(encoded); err != nil {
		_ = tmpFile.Close()
		return errors.New("cannot write temporary report file")
	}
	if err := tmpFile.Chmod(0o644); err != nil {
		_ = tmpFile.Close()
		return errors.New("cannot chmod temporary report file")
	}
	if err := tmpFile.Close(); err != nil {
		return errors.New("cannot close temporary report file")
	}

	if err := os.Link(tmpName, outPath); err != nil {
		if errors.Is(err, os.ErrExist) {
			return errors.New("output file already exists (refusing to overwrite)")
		}
		return errors.New("cannot publish report file into place")
	}
	return nil
}
