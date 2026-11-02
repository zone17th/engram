package embedding_test

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
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

func TestTEIRejectsMissingNullOrWhitespaceRevisionInBootInfo(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"omitted_model_sha", `{"model_id":"BAAI/bge-m3","model_type":"embedding"}`},
		{"null_model_sha", `{"model_id":"BAAI/bge-m3","model_sha":null,"model_type":"embedding"}`},
		{"empty_model_sha", `{"model_id":"BAAI/bge-m3","model_sha":"","model_type":"embedding"}`},
		{"whitespace_model_sha", `{"model_id":"BAAI/bge-m3","model_sha":"   \t\n  ","model_type":"embedding"}`},
		{"unrelated_sha_without_model_sha", `{"model_id":"BAAI/bge-m3","sha":"server-build-sha","model_type":"embedding"}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			infoSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/info" {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(tc.body))
					return
				}
				http.NotFound(w, r)
			}))
			defer infoSrv.Close()

			_, err := embedding.NewTEI(context.Background(), embedding.ClientConfig{
				Provider: embedding.ProviderTEI,
				BaseURL:  infoSrv.URL,
				Dims:     16,
			})
			if err == nil {
				t.Fatalf("%s: expected error for missing/empty model_sha, got nil", tc.name)
			}
			if !errors.Is(err, embedding.ErrBadResponse) {
				t.Fatalf("%s: err = %v, want errors.Is(ErrBadResponse)", tc.name, err)
			}
			var pe *embedding.ProviderError
			if !errors.As(err, &pe) || pe.Class != embedding.ClassBadResponse {
				t.Fatalf("%s: ProviderError = %+v, want ClassBadResponse", tc.name, pe)
			}
		})
	}
}

func TestTEIDefensiveL2NormalizationAndNullCoordinateRejection(t *testing.T) {
	var responseBody string
	var gotNormalizeFlag atomic.Bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/info":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"model_id":"BAAI/bge-m3","model_sha":"sha-norm-test"}`))
		case "/embed":
			gotNormalizeFlag.Store(true)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(responseBody))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	prov, err := embedding.NewTEI(context.Background(), embedding.ClientConfig{
		Provider: embedding.ProviderTEI,
		BaseURL:  srv.URL,
		Dims:     2,
	})
	if err != nil {
		t.Fatalf("NewTEI: %v", err)
	}

	// 1. RV52B-BE1-10: Server returns non-unit vector [3, 4] (norm 5) despite normalize:true;
	// Go provider must normalize it to [0.6, 0.8] (norm 1.0).
	responseBody = `[[3.0, 4.0]]`
	vec, err := prov.EmbedQuery(context.Background(), "wifi")
	if err != nil {
		t.Fatalf("EmbedQuery([3, 4]): %v", err)
	}
	if !gotNormalizeFlag.Load() {
		t.Fatal("expected /embed handler to be invoked")
	}
	if len(vec) != 2 {
		t.Fatalf("len(vec) = %d, want 2", len(vec))
	}
	if math.Abs(float64(vec[0])-0.6) > 1e-6 || math.Abs(float64(vec[1])-0.8) > 1e-6 {
		t.Fatalf("normalized vec = %v, want [0.6, 0.8]", vec)
	}
	if diff := math.Abs(l2NormFloat64(vec) - 1.0); diff > 1e-6 {
		t.Fatalf("normalized norm = %v, want 1.0 ± 1e-6", l2NormFloat64(vec))
	}

	// 2. RV52B-BE1-7: JSON null coordinate in an otherwise non-zero vector is rejected.
	for _, badBody := range []string{
		`[[1.0, null]]`,
		`[[null, 1.0]]`,
		`[[1.0, "0.5"]]`,
	} {
		responseBody = badBody
		_, err := prov.EmbedQuery(context.Background(), "wifi")
		if !errors.Is(err, embedding.ErrBadResponse) {
			t.Fatalf("body %s: err = %v, want ErrBadResponse", badBody, err)
		}
		var pe *embedding.ProviderError
		if !errors.As(err, &pe) || pe.Class != embedding.ClassBadResponse {
			t.Fatalf("body %s: ProviderError = %+v, want ClassBadResponse", badBody, pe)
		}
	}
}

func TestTEIRedirectNotFollowedAndStalledNon2xxBody(t *testing.T) {
	// 1. RV52B-BE1-3: Redirects are never followed by TEI.
	var targetHits atomic.Int32
	targetSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer targetSrv.Close()

	srv := embedtest.NewServer(embedtest.Options{
		Dims:     8,
		ModelID:  "BAAI/bge-m3",
		ModelSHA: "sha-redir",
	})
	defer srv.Close()

	prov, err := embedding.NewTEI(context.Background(), embedding.ClientConfig{
		Provider: embedding.ProviderTEI,
		BaseURL:  srv.URL(),
		Dims:     8,
	})
	if err != nil {
		t.Fatalf("NewTEI: %v", err)
	}

	srv.SetRedirect(targetSrv.URL + "/embed")
	_, err = prov.EmbedQuery(context.Background(), "wifi")
	if !errors.Is(err, embedding.ErrBadResponse) {
		t.Fatalf("TEI redirect err = %v, want ErrBadResponse", err)
	}
	if targetHits.Load() != 0 {
		t.Fatalf("TEI followed redirect %d times, want 0", targetHits.Load())
	}

	// 2. RV52B-BE1-8: Flushed non-2xx header followed by stalled body on /info and /embed.
	unblock := make(chan struct{})
	var failInfo atomic.Bool
	failInfo.Store(true)
	stalledSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/info" && !failInfo.Load() {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"model_id":"BAAI/bge-m3","model_sha":"sha-stalled"}`))
			return
		}
		w.Header().Set("Retry-After", "25")
		w.WriteHeader(http.StatusServiceUnavailable)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		select {
		case <-unblock:
		case <-r.Context().Done():
		}
	}))
	defer func() {
		close(unblock)
		stalledSrv.Close()
	}()

	// Boot /info returns 503 immediately without waiting on stalled body.
	_, err = embedding.NewTEI(context.Background(), embedding.ClientConfig{
		Provider:        embedding.ProviderTEI,
		BaseURL:         stalledSrv.URL,
		Dims:            8,
		DocumentTimeout: 50 * time.Millisecond,
	})
	var pe *embedding.ProviderError
	if !errors.As(err, &pe) || pe.Class != embedding.Class5xx || pe.HTTPStatus != http.StatusServiceUnavailable {
		t.Fatalf("stalled /info 503 err = %v (%+v), want Class5xx 503", err, pe)
	}

	// /embed returns 503 immediately when /info succeeds.
	failInfo.Store(false)
	provStalled, err := embedding.NewTEI(context.Background(), embedding.ClientConfig{
		Provider:        embedding.ProviderTEI,
		BaseURL:         stalledSrv.URL,
		Dims:            8,
		QueryTimeout:    50 * time.Millisecond,
		DocumentTimeout: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewTEI: %v", err)
	}
	_, err = provStalled.EmbedQuery(context.Background(), "wifi")
	if !errors.As(err, &pe) || pe.Class != embedding.Class5xx || pe.HTTPStatus != http.StatusServiceUnavailable {
		t.Fatalf("stalled /embed 503 err = %v (%+v), want Class5xx 503", err, pe)
	}
}
