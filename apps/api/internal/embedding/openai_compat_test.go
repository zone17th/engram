package embedding_test

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
)

func l2NormFloat64(v []float32) float64 {
	var sum float64
	for _, x := range v {
		f := float64(x)
		sum += f * f
	}
	return math.Sqrt(sum)
}

func TestOpenAICompatRequestShapeAndNormalization(t *testing.T) {
	srv := embedtest.NewServer(embedtest.Options{
		Dims:        16,
		ScaleFactor: 3.75, // unnormalized vectors from server
	})
	defer srv.Close()

	const (
		apiKey      = "sk-test-fake-key-do-not-log-99999999"
		modelName   = "openrouter/qwen/qwen3-embedding-8b"
		instruction = "Given a short search query, retrieve matching item names or tags"
	)

	cfg := embedding.ClientConfig{
		Provider:         embedding.ProviderOpenAICompat,
		BaseURL:          srv.URL() + "/v1",
		APIKey:           apiKey,
		Model:            modelName,
		Dims:             16,
		QueryInstruction: instruction,
		QueryTimeout:     2 * time.Second,
		DocumentTimeout:  5 * time.Second,
	}

	prov, err := embedding.NewOpenAICompat(cfg)
	if err != nil {
		t.Fatalf("NewOpenAICompat: %v", err)
	}

	if prov.Name() != "openai_compat" {
		t.Fatalf("Name() = %q, want %q", prov.Name(), "openai_compat")
	}
	if prov.Model() != "openai_compat/"+modelName {
		t.Fatalf("Model() = %q, want %q", prov.Model(), "openai_compat/"+modelName)
	}
	wantVer := embedding.OpenAIModelVersion(16, instruction)
	if prov.ModelVersion() != wantVer {
		t.Fatalf("ModelVersion() = %q, want %q", prov.ModelVersion(), wantVer)
	}
	if prov.MaxBatch() != 64 {
		t.Fatalf("MaxBatch() = %d, want 64", prov.MaxBatch())
	}

	// 1. EmbedQuery: sends instruction prefix ONLY on query, Bearer header present.
	qVec, err := prov.EmbedQuery(context.Background(), "mật khẩu wifi")
	if err != nil {
		t.Fatalf("EmbedQuery: %v", err)
	}
	if len(qVec) != 16 {
		t.Fatalf("len(qVec) = %d, want 16", len(qVec))
	}
	if diff := math.Abs(l2NormFloat64(qVec) - 1.0); diff > 1e-6 {
		t.Fatalf("qVec L2 norm = %v, want 1.0 ± 1e-6", l2NormFloat64(qVec))
	}

	call, ok := srv.LastCall()
	if !ok {
		t.Fatal("expected recorded call for EmbedQuery")
	}
	if call.Path != "/v1/embeddings" {
		t.Fatalf("Path = %q, want /v1/embeddings", call.Path)
	}
	if call.Model != modelName {
		t.Fatalf("Model = %q, want %q", call.Model, modelName)
	}
	if call.Dims != 16 {
		t.Fatalf("Dims = %d, want 16", call.Dims)
	}
	if call.EncodingFormat != "float" {
		t.Fatalf("EncodingFormat = %q, want \"float\"", call.EncodingFormat)
	}
	if call.AuthHeader != "Bearer "+apiKey {
		t.Fatalf("AuthHeader = %q, want Bearer header", call.AuthHeader)
	}
	wantQueryInput := "Instruct: " + instruction + "\nQuery:mật khẩu wifi"
	if len(call.Inputs) != 1 || call.Inputs[0] != wantQueryInput {
		t.Fatalf("query Inputs = %v, want [%q]", call.Inputs, wantQueryInput)
	}

	// 2. EmbedDocuments: documents are unprefixed, sorted by data[].index, and L2-normalized.
	docs := []string{"wifi-nhà — tầng 2", "mạng-văn-phòng", "tag-công-việc"}
	docVecs, err := prov.EmbedDocuments(context.Background(), docs)
	if err != nil {
		t.Fatalf("EmbedDocuments: %v", err)
	}
	if len(docVecs) != len(docs) {
		t.Fatalf("len(docVecs) = %d, want %d", len(docVecs), len(docs))
	}

	docCall, ok := srv.LastCall()
	if !ok {
		t.Fatal("expected recorded call for EmbedDocuments")
	}
	for i, gotIn := range docCall.Inputs {
		if gotIn != docs[i] {
			t.Fatalf("doc input[%d] = %q, want unprefixed %q", i, gotIn, docs[i])
		}
		if strings.Contains(gotIn, "Instruct:") {
			t.Fatalf("doc input[%d] unexpectedly contains query instruction: %q", i, gotIn)
		}
	}

	// Verify index sorting: embedtest reverses multi-item responses in ModeOK,
	// so docVecs[i] must match a single-item embedding of docs[i].
	for i, doc := range docs {
		if diff := math.Abs(l2NormFloat64(docVecs[i]) - 1.0); diff > 1e-6 {
			t.Fatalf("docVecs[%d] L2 norm = %v, want 1.0 ± 1e-6", i, l2NormFloat64(docVecs[i]))
		}
		expected := embedtest.DeterministicVector(doc, 16, true, 1.0)
		for j := range expected {
			if math.Abs(float64(docVecs[i][j]-expected[j])) > 1e-5 {
				t.Fatalf("docVecs[%d][%d] = %v, want %v (index sort mismatch)", i, j, docVecs[i][j], expected[j])
			}
		}
	}
}

func TestOpenAICompatBatchLimit(t *testing.T) {
	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()

	prov, err := embedding.NewOpenAICompat(embedding.ClientConfig{
		Provider: embedding.ProviderOpenAICompat,
		BaseURL:  srv.URL(),
		APIKey:   "sk-test-batch-limit",
		Model:    "qwen",
		Dims:     8,
	})
	if err != nil {
		t.Fatalf("NewOpenAICompat: %v", err)
	}

	over := make([]string, embedding.MaxBatch+1)
	for i := range over {
		over[i] = "item"
	}
	if _, err := prov.EmbedDocuments(context.Background(), over); !errors.Is(err, embedding.ErrBatchTooLarge) {
		t.Fatalf("EmbedDocuments(65) err = %v, want ErrBatchTooLarge", err)
	}
	if len(srv.Calls()) != 0 {
		t.Fatalf("expected 0 network calls when batch > 64, got %d", len(srv.Calls()))
	}
}

func TestOpenAICompatBadResponseAndFaultModes(t *testing.T) {
	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()

	prov, err := embedding.NewOpenAICompat(embedding.ClientConfig{
		Provider:        embedding.ProviderOpenAICompat,
		BaseURL:         srv.URL() + "/v1",
		APIKey:          "sk-test-faults",
		Model:           "qwen",
		Dims:            8,
		QueryTimeout:    80 * time.Millisecond,
		DocumentTimeout: 200 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewOpenAICompat: %v", err)
	}

	badModes := []struct {
		name string
		mode embedtest.Mode
	}{
		{"wrong_dims", embedtest.ModeWrongDims},
		{"nan_in_vector", embedtest.ModeNaN},
		{"missing_index", embedtest.ModeMissingIndex},
		{"duplicate_index", embedtest.ModeDuplicateIndex},
		{"oversize_body", embedtest.ModeOversizeBody},
	}

	for _, tc := range badModes {
		t.Run(tc.name, func(t *testing.T) {
			srv.SetMode(tc.mode)
			defer srv.SetMode(embedtest.ModeOK)

			_, err := prov.EmbedDocuments(context.Background(), []string{"doc-1", "doc-2"})
			if err == nil {
				t.Fatalf("mode %s: expected error, got nil", tc.name)
			}
			if !errors.Is(err, embedding.ErrBadResponse) {
				t.Fatalf("mode %s: error %v does not wrap ErrBadResponse", tc.name, err)
			}
			var pe *embedding.ProviderError
			if !errors.As(err, &pe) || pe.Class != embedding.ClassBadResponse {
				t.Fatalf("mode %s: ProviderError = %+v, want ClassBadResponse", tc.name, pe)
			}
		})
	}

	// Wrong vector count test via custom handler returning 1 item for 2 inputs.
	t.Run("wrong_count", func(t *testing.T) {
		wrongCountSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"object":"list","data":[{"object":"embedding","index":0,"embedding":[1,0,0,0,0,0,0,0]}]}`))
		}))
		defer wrongCountSrv.Close()

		p2, err := embedding.NewOpenAICompat(embedding.ClientConfig{
			Provider: embedding.ProviderOpenAICompat,
			BaseURL:  wrongCountSrv.URL,
			APIKey:   "sk-test",
			Model:    "qwen",
			Dims:     8,
		})
		if err != nil {
			t.Fatalf("NewOpenAICompat: %v", err)
		}
		_, err = p2.EmbedDocuments(context.Background(), []string{"a", "b"})
		if !errors.Is(err, embedding.ErrBadResponse) {
			t.Fatalf("wrong count err = %v, want ErrBadResponse", err)
		}
	})

	// 5xx classification.
	t.Run("http_5xx", func(t *testing.T) {
		srv.Set5xx(http.StatusBadGateway)
		defer srv.SetMode(embedtest.ModeOK)

		_, err := prov.EmbedQuery(context.Background(), "wifi")
		var pe *embedding.ProviderError
		if !errors.As(err, &pe) || pe.Class != embedding.Class5xx || pe.HTTPStatus != http.StatusBadGateway {
			t.Fatalf("5xx err = %+v, want Class5xx status 502", pe)
		}
	})

	// 429 + Retry-After parsing.
	t.Run("http_429_retry_after", func(t *testing.T) {
		srv.Set429("42")
		defer srv.SetMode(embedtest.ModeOK)

		_, err := prov.EmbedQuery(context.Background(), "wifi")
		var pe *embedding.ProviderError
		if !errors.As(err, &pe) || pe.Class != embedding.Class429 || pe.RetryAfter != 42*time.Second {
			t.Fatalf("429 err = %+v, want Class429 RetryAfter=42s", pe)
		}
	})

	// Timeout classification.
	t.Run("timeout", func(t *testing.T) {
		srv.SetSlow(300 * time.Millisecond)
		defer srv.SetMode(embedtest.ModeOK)

		_, err := prov.EmbedQuery(context.Background(), "wifi")
		var pe *embedding.ProviderError
		if !errors.As(err, &pe) || pe.Class != embedding.ClassTimeout {
			t.Fatalf("timeout err = %v (%+v), want ClassTimeout", err, pe)
		}
	})
}

func TestOpenAICompatRedirectNotFollowed(t *testing.T) {
	var targetHits atomic.Int32
	targetSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer targetSrv.Close()

	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()
	srv.SetRedirect(targetSrv.URL + "/v1/embeddings")

	prov, err := embedding.NewOpenAICompat(embedding.ClientConfig{
		Provider: embedding.ProviderOpenAICompat,
		BaseURL:  srv.URL() + "/v1",
		APIKey:   "sk-redirect-secret",
		Model:    "qwen",
		Dims:     8,
	})
	if err != nil {
		t.Fatalf("NewOpenAICompat: %v", err)
	}

	_, err = prov.EmbedQuery(context.Background(), "wifi")
	if err == nil {
		t.Fatal("expected error on 302 redirect, got nil")
	}
	if !errors.Is(err, embedding.ErrBadResponse) {
		t.Fatalf("redirect error = %v, want ErrBadResponse", err)
	}
	if got := targetHits.Load(); got != 0 {
		t.Fatalf("redirect target was hit %d times, want 0", got)
	}
}

func TestNewClientFromConfigComputesFullIdentity(t *testing.T) {
	srv := embedtest.NewServer(embedtest.Options{
		Dims:     16,
		ModelID:  "BAAI/bge-m3",
		ModelSHA: "sha-998877",
	})
	defer srv.Close()

	primaryCfg := embedding.ClientConfig{
		Provider:         embedding.ProviderOpenAICompat,
		BaseURL:          srv.URL() + "/v1",
		APIKey:           "sk-primary-key",
		Model:            "openrouter/qwen/qwen3-embedding-8b",
		Dims:             16,
		QueryInstruction: "Retrieve matching items",
	}
	shadowCfg := embedding.ClientConfig{
		Provider:    embedding.ProviderTEI,
		BaseURL:     srv.URL(),
		Dims:        16,
		QueryPrefix: "query: ",
		DocPrefix:   "passage: ",
	}

	cs, err := embedding.NewClientSetFromConfigs(context.Background(), primaryCfg, &shadowCfg, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("NewClientSetFromConfigs: %v", err)
	}
	srv.ResetCalls()

	wantPrimaryID := embedid.Identity{
		Provider:      "openai_compat",
		Model:         "openai_compat/openrouter/qwen/qwen3-embedding-8b",
		ModelVersion:  embedding.OpenAIModelVersion(16, "Retrieve matching items"),
		Dims:          16,
		QueryPrefix:   embedding.OpenAIQueryPrefix("Retrieve matching items"),
		DocPrefix:     "",
		Preprocessing: embedding.Preprocessing,
	}
	if _, ok := cs.Match(wantPrimaryID); !ok {
		t.Fatalf("primary identity did not match: got %+v, want %+v", cs.Primary().Identity, wantPrimaryID)
	}

	wantShadowID := embedid.Identity{
		Provider:      "tei",
		Model:         "tei/BAAI/bge-m3",
		ModelVersion:  embedding.TEIModelVersion("sha-998877", "query: ", "passage: "),
		Dims:          16,
		QueryPrefix:   "query: ",
		DocPrefix:     "passage: ",
		Preprocessing: embedding.Preprocessing,
	}
	if matched, ok := cs.Match(wantShadowID); !ok || matched.Role != embedding.RoleShadow {
		t.Fatalf("shadow identity did not match: ok=%v role=%v", ok, matched.Role)
	}

	// Changing instruction changes both ModelVersion and QueryPrefix -> Match must be false with 0 network calls.
	mismatched := wantPrimaryID
	mismatched.ModelVersion = embedding.OpenAIModelVersion(16, "Different instruction")
	if _, ok := cs.Match(mismatched); ok {
		t.Fatal("expected mismatch when ModelVersion differs")
	}
	if len(srv.Calls()) != 0 {
		t.Fatalf("Match made %d network calls, want 0", len(srv.Calls()))
	}
}
