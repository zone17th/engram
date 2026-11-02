package embedding_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

func counterValue(t *testing.T, reg *prometheus.Registry, name string, wantLabels map[string]string) (float64, bool) {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("reg.Gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() != name {
			continue
		}
		for _, m := range f.GetMetric() {
			matched := 0
			for _, lp := range m.GetLabel() {
				if v, ok := wantLabels[lp.GetName()]; ok && v == lp.GetValue() {
					matched++
				}
			}
			if matched == len(wantLabels) && m.GetCounter() != nil {
				return m.GetCounter().GetValue(), true
			}
		}
	}
	return 0, false
}

func TestCanaryFirstRunIdenticalAndPerturbedDrift(t *testing.T) {
	strs := embedding.CanaryStrings()
	if len(strs) != embedding.CanaryCount {
		t.Fatalf("len(CanaryStrings()) = %d, want 8", len(strs))
	}

	srv := embedtest.NewServer(embedtest.Options{Dims: 16})
	defer srv.Close()

	client, err := embedding.NewClientFromConfig(
		context.Background(),
		embedding.ClientConfig{
			Provider:         embedding.ProviderOpenAICompat,
			BaseURL:          embedding.NewEndpoint(srv.URL() + "/v1"),
			APIKey:           embedding.NewSecret("sk-canary-test-key"),
			Model:            "openrouter/qwen/qwen3-embedding-8b",
			Dims:             16,
			QueryInstruction: "Retrieve matching items",
		},
		embedding.RolePrimary,
		embedding.ClientDeps{},
	)
	if err != nil {
		t.Fatalf("NewClientFromConfig: %v", err)
	}

	reg, m := obs.NewRegistry()
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	// 1. First run (no stored vectors) -> returns 8 vectors to persist, FirstRun=true, Drifted=false.
	res1, err := embedding.CheckCanary(context.Background(), client, 1, nil, m.Embedding, logger)
	if err != nil {
		t.Fatalf("CheckCanary (first run): %v", err)
	}
	if !res1.FirstRun || res1.Drifted {
		t.Fatalf("first run result: FirstRun=%v Drifted=%v, want true/false", res1.FirstRun, res1.Drifted)
	}
	if len(res1.Vectors) != 8 || len(res1.Vectors[0]) != 16 {
		t.Fatalf("first run vectors shape = %d x %d, want 8 x 16", len(res1.Vectors), len(res1.Vectors[0]))
	}

	// Verify canary strings were embedded as documents (no query instruction prefix).
	call, ok := srv.LastCall()
	if !ok || len(call.Inputs) != 8 {
		t.Fatalf("expected 8 inputs in canary call, got %+v", call)
	}
	for i, in := range call.Inputs {
		if strings.Contains(in, "Instruct:") {
			t.Fatalf("canary input[%d] unexpectedly contains query instruction: %q", i, in)
		}
	}

	// 2. Identical stored vectors -> no drift, MinCos ~ 1.0, CanaryDriftTotal not incremented.
	res2, err := embedding.CheckCanary(context.Background(), client, 1, res1.Vectors, m.Embedding, logger)
	if err != nil {
		t.Fatalf("CheckCanary (identical): %v", err)
	}
	if res2.FirstRun || res2.Drifted {
		t.Fatalf("identical run: FirstRun=%v Drifted=%v, want false/false", res2.FirstRun, res2.Drifted)
	}
	if diff := math.Abs(res2.MinCos - 1.0); diff > 1e-5 {
		t.Fatalf("identical run MinCos = %v, want 1.0 ± 1e-5", res2.MinCos)
	}
	if got := gaugeValue(t, reg, "embedding_canary_min_cos", map[string]string{"generation": "1"}); math.Abs(got-1.0) > 1e-5 {
		t.Fatalf("CanaryMinCos gauge = %v, want ~1.0", got)
	}
	if val, found := counterValue(t, reg, "embedding_canary_drift_total", map[string]string{"generation": "1"}); found && val != 0 {
		t.Fatalf("CanaryDriftTotal after identical run = %v, want 0", val)
	}

	// 3. Perturbed stored vector (invert vector #3 so cos = -1.0 < 0.99) -> Drifted=true + metric + warn log without inputs.
	perturbed := make([][]float32, len(res1.Vectors))
	for i := range res1.Vectors {
		cp := make([]float32, len(res1.Vectors[i]))
		copy(cp, res1.Vectors[i])
		if i == 3 {
			for j := range cp {
				cp[j] = -cp[j]
			}
		}
		perturbed[i] = cp
	}

	logBuf.Reset()
	res3, err := embedding.CheckCanary(context.Background(), client, 1, perturbed, m.Embedding, logger)
	if err != nil {
		t.Fatalf("CheckCanary (perturbed): %v", err)
	}
	if res3.FirstRun || !res3.Drifted {
		t.Fatalf("perturbed run: FirstRun=%v Drifted=%v, want false/true", res3.FirstRun, res3.Drifted)
	}
	if res3.MinCos >= embedding.CanaryThreshold {
		t.Fatalf("perturbed MinCos = %v, want < %v", res3.MinCos, embedding.CanaryThreshold)
	}
	driftCount, found := counterValue(t, reg, "embedding_canary_drift_total", map[string]string{"generation": "1"})
	if !found || driftCount != 1 {
		t.Fatalf("CanaryDriftTotal after perturbed run = %v (found=%v), want 1", driftCount, found)
	}
	if got := gaugeValue(t, reg, "embedding_canary_min_cos", map[string]string{"generation": "1"}); got >= embedding.CanaryThreshold {
		t.Fatalf("CanaryMinCos gauge after drift = %v, want < %v", got, embedding.CanaryThreshold)
	}

	logOutput := logBuf.String()
	if !strings.Contains(logOutput, "embedding canary drift detected") {
		t.Fatalf("expected drift warning in logs, got: %s", logOutput)
	}
	for _, s := range strs {
		if strings.Contains(logOutput, s) {
			t.Fatalf("drift log leaked canary input string %q: %s", s, logOutput)
		}
	}
}

func TestCanaryDriftWarningDoesNotLogProviderResponseStrings(t *testing.T) {
	const (
		sensitiveModelMarker = "confidential-model-id/internal.example.invalid:8080/secret-model"
		sensitiveSHAMarker   = "confidential-sha-marker-sk-secret-99887766"
	)

	srv := embedtest.NewServer(embedtest.Options{
		Dims:     16,
		ModelID:  sensitiveModelMarker,
		ModelSHA: sensitiveSHAMarker,
	})
	defer srv.Close()

	client, err := embedding.NewClientFromConfig(
		context.Background(),
		embedding.ClientConfig{
			Provider:    embedding.ProviderTEI,
			BaseURL:     embedding.NewEndpoint(srv.URL()),
			Dims:        16,
			QueryPrefix: "query: ",
			DocPrefix:   "passage: ",
		},
		embedding.RolePrimary,
		embedding.ClientDeps{},
	)
	if err != nil {
		t.Fatalf("NewClientFromConfig(TEI): %v", err)
	}

	first, err := embedding.CheckCanary(context.Background(), client, 7, nil, nil, nil)
	if err != nil {
		t.Fatalf("CheckCanary(first): %v", err)
	}

	perturbed := make([][]float32, len(first.Vectors))
	for i := range first.Vectors {
		cp := make([]float32, len(first.Vectors[i]))
		copy(cp, first.Vectors[i])
		if i == 0 {
			for j := range cp {
				cp[j] = -cp[j]
			}
		}
		perturbed[i] = cp
	}

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelWarn}))

	res, err := embedding.CheckCanary(context.Background(), client, 7, perturbed, nil, logger)
	if err != nil {
		t.Fatalf("CheckCanary(drifted): %v", err)
	}
	if !res.Drifted {
		t.Fatal("expected Drifted=true")
	}

	rawLog := strings.TrimSpace(logBuf.String())
	if rawLog == "" {
		t.Fatal("expected warning log entry on canary drift, got empty")
	}
	for _, forbidden := range []string{
		sensitiveModelMarker,
		sensitiveSHAMarker,
		"internal.example.invalid",
		"model_version",
		`"model"`,
	} {
		if strings.Contains(rawLog, forbidden) {
			t.Fatalf("canary drift warning leaked forbidden marker %q: %s", forbidden, rawLog)
		}
	}

	var entry map[string]any
	if err := json.Unmarshal([]byte(rawLog), &entry); err != nil {
		t.Fatalf("decode slog JSON: %v (%s)", err, rawLog)
	}
	if entry["level"] != "WARN" {
		t.Fatalf("log level = %v, want WARN", entry["level"])
	}
	if entry["generation"] != "7" {
		t.Fatalf("generation = %v, want \"7\"", entry["generation"])
	}
	if entry["provider"] != "tei" {
		t.Fatalf("provider = %v, want \"tei\"", entry["provider"])
	}
	if entry["count"] != float64(embedding.CanaryCount) {
		t.Fatalf("count = %v, want %d", entry["count"], embedding.CanaryCount)
	}
	if _, ok := entry["min_cos"].(float64); !ok {
		t.Fatalf("min_cos missing or not float64: %v", entry["min_cos"])
	}
	if entry["threshold"] != embedding.CanaryThreshold {
		t.Fatalf("threshold = %v, want %v", entry["threshold"], embedding.CanaryThreshold)
	}

	allowedKeys := map[string]bool{
		"time":       true,
		"level":      true,
		"msg":        true,
		"generation": true,
		"provider":   true,
		"count":      true,
		"min_cos":    true,
		"threshold":  true,
	}
	for k := range entry {
		if !allowedKeys[k] {
			t.Fatalf("unexpected attribute %q in canary drift warning: %s", k, rawLog)
		}
	}
}
