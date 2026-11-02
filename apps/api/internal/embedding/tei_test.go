package embedding_test

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
)

func TestTEIBootInfoPrefixesAndNormalization(t *testing.T) {
	srv := embedtest.NewServer(embedtest.Options{
		Dims:        16,
		ModelID:     "intfloat/multilingual-e5-base",
		ModelSHA:    "835193815a3936a24a0ef6ef67d0f",
		ScaleFactor: 4.0,
	})
	defer srv.Close()

	cfg := embedding.ClientConfig{
		Provider:        embedding.ProviderTEI,
		BaseURL:         srv.URL(),
		Dims:            16,
		QueryPrefix:     "query: ",
		DocPrefix:       "passage: ",
		QueryTimeout:    500 * time.Millisecond,
		DocumentTimeout: 2 * time.Second,
	}

	prov, err := embedding.NewTEI(context.Background(), cfg)
	if err != nil {
		t.Fatalf("NewTEI: %v", err)
	}

	if prov.Name() != "tei" {
		t.Fatalf("Name() = %q, want \"tei\"", prov.Name())
	}
	if prov.Model() != "tei/intfloat/multilingual-e5-base" {
		t.Fatalf("Model() = %q, want \"tei/intfloat/multilingual-e5-base\"", prov.Model())
	}
	wantVersion := embedding.TEIModelVersion("835193815a3936a24a0ef6ef67d0f", "query: ", "passage: ")
	if prov.ModelVersion() != wantVersion {
		t.Fatalf("ModelVersion() = %q, want %q", prov.ModelVersion(), wantVersion)
	}
	if prov.Dims() != 16 {
		t.Fatalf("Dims() = %d, want 16", prov.Dims())
	}

	// 1. EmbedQuery prepends TEI_INPUT_PREFIX_QUERY and normalizes vector.
	qVec, err := prov.EmbedQuery(context.Background(), "mật khẩu wifi")
	if err != nil {
		t.Fatalf("EmbedQuery: %v", err)
	}
	if len(qVec) != 16 {
		t.Fatalf("len(qVec) = %d, want 16", len(qVec))
	}
	if diff := math.Abs(l2NormFloat64(qVec) - 1.0); diff > 1e-6 {
		t.Fatalf("qVec norm = %v, want 1.0 ± 1e-6", l2NormFloat64(qVec))
	}

	qCall, ok := srv.LastCall()
	if !ok {
		t.Fatal("expected recorded TEI query call")
	}
	if !qCall.Normalize || !qCall.Truncate {
		t.Fatalf("TEI request flags: normalize=%v truncate=%v, want both true", qCall.Normalize, qCall.Truncate)
	}
	if len(qCall.Inputs) != 1 || qCall.Inputs[0] != "query: mật khẩu wifi" {
		t.Fatalf("TEI query inputs = %v, want [\"query: mật khẩu wifi\"]", qCall.Inputs)
	}

	// 2. EmbedDocuments prepends TEI_INPUT_PREFIX_DOCUMENT to every input.
	docs := []string{"wifi nhà", "họp tuần"}
	docVecs, err := prov.EmbedDocuments(context.Background(), docs)
	if err != nil {
		t.Fatalf("EmbedDocuments: %v", err)
	}
	if len(docVecs) != 2 {
		t.Fatalf("len(docVecs) = %d, want 2", len(docVecs))
	}
	for i, v := range docVecs {
		if diff := math.Abs(l2NormFloat64(v) - 1.0); diff > 1e-6 {
			t.Fatalf("docVecs[%d] norm = %v, want 1.0 ± 1e-6", i, l2NormFloat64(v))
		}
	}

	docCall, ok := srv.LastCall()
	if !ok {
		t.Fatal("expected recorded TEI document call")
	}
	wantDocInputs := []string{"passage: wifi nhà", "passage: họp tuần"}
	if len(docCall.Inputs) != 2 || docCall.Inputs[0] != wantDocInputs[0] || docCall.Inputs[1] != wantDocInputs[1] {
		t.Fatalf("TEI doc inputs = %v, want %v", docCall.Inputs, wantDocInputs)
	}
}

func TestTEIDimsMismatchAndBootFailure(t *testing.T) {
	srv := embedtest.NewServer(embedtest.Options{
		Dims:     16,
		ModelID:  "BAAI/bge-m3",
		ModelSHA: "sha-bge",
	})
	defer srv.Close()

	// Configured dims = 32, server returns 16 -> dims mismatch error.
	prov, err := embedding.NewTEI(context.Background(), embedding.ClientConfig{
		Provider: embedding.ProviderTEI,
		BaseURL:  srv.URL(),
		Dims:     32,
	})
	if err != nil {
		t.Fatalf("NewTEI: %v", err)
	}

	_, err = prov.EmbedQuery(context.Background(), "wifi")
	if !errors.Is(err, embedding.ErrBadResponse) {
		t.Fatalf("dims mismatch err = %v, want ErrBadResponse", err)
	}
	var pe *embedding.ProviderError
	if !errors.As(err, &pe) || pe.Class != embedding.ClassBadResponse {
		t.Fatalf("dims mismatch ProviderError = %+v, want ClassBadResponse", pe)
	}

	// Boot failure when /info returns 503.
	srv.Set5xx(503)
	_, err = embedding.NewTEI(context.Background(), embedding.ClientConfig{
		Provider: embedding.ProviderTEI,
		BaseURL:  srv.URL(),
		Dims:     16,
	})
	if err == nil {
		t.Fatal("expected NewTEI error when /info returns 503, got nil")
	}
	if !errors.As(err, &pe) || pe.Class != embedding.Class5xx {
		t.Fatalf("boot 503 ProviderError = %+v, want Class5xx", pe)
	}
}
