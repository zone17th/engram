package embedding_test

import (
	"context"
	"errors"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
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
		BaseURL:          embedding.NewEndpoint(srv.URL() + "/v1"),
		APIKey:           embedding.NewSecret(apiKey),
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
		BaseURL:  embedding.NewEndpoint(srv.URL()),
		APIKey:   embedding.NewSecret("sk-test-batch-limit"),
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
		BaseURL:         embedding.NewEndpoint(srv.URL() + "/v1"),
		APIKey:          embedding.NewSecret("sk-test-faults"),
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
			BaseURL:  embedding.NewEndpoint(wrongCountSrv.URL),
			APIKey:   embedding.NewSecret("sk-test"),
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

	// RV52B-BE1-7: JSON null vector elements must be rejected as ClassBadResponse / ErrBadResponse.
	t.Run("null_coordinate_rejected", func(t *testing.T) {
		for _, body := range []string{
			`{"object":"list","data":[{"object":"embedding","index":0,"embedding":[1,null,0,0,0,0,0,0]}]}`,
			`{"object":"list","data":[{"object":"embedding","index":0,"embedding":[null,1,0,0,0,0,0,0]}]}`,
			`{"object":"list","data":[{"object":"embedding","index":0,"embedding":[1,"0",0,0,0,0,0,0]}]}`,
		} {
			nullSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(body))
			}))
			pNull, err := embedding.NewOpenAICompat(embedding.ClientConfig{
				Provider: embedding.ProviderOpenAICompat,
				BaseURL:  embedding.NewEndpoint(nullSrv.URL),
				APIKey:   embedding.NewSecret("sk-test-null"),
				Model:    "qwen",
				Dims:     8,
			})
			if err != nil {
				nullSrv.Close()
				t.Fatalf("NewOpenAICompat: %v", err)
			}
			_, err = pNull.EmbedQuery(context.Background(), "wifi")
			nullSrv.Close()
			if !errors.Is(err, embedding.ErrBadResponse) {
				t.Fatalf("body %s: err = %v, want ErrBadResponse", body, err)
			}
			var pe *embedding.ProviderError
			if !errors.As(err, &pe) || pe.Class != embedding.ClassBadResponse {
				t.Fatalf("body %s: ProviderError = %+v, want ClassBadResponse", body, pe)
			}
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
		BaseURL:  embedding.NewEndpoint(srv.URL() + "/v1"),
		APIKey:   embedding.NewSecret("sk-redirect-secret"),
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
		BaseURL:          embedding.NewEndpoint(srv.URL() + "/v1"),
		APIKey:           embedding.NewSecret("sk-primary-key"),
		Model:            "openrouter/qwen/qwen3-embedding-8b",
		Dims:             16,
		QueryInstruction: "Retrieve matching items",
	}
	shadowCfg := embedding.ClientConfig{
		Provider:    embedding.ProviderTEI,
		BaseURL:     embedding.NewEndpoint(srv.URL()),
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

func TestOpenAICompatNon2xxDoesNotBlockOnStalledBody(t *testing.T) {
	unblock := make(chan struct{})
	stalledSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "18")
		w.WriteHeader(http.StatusTooManyRequests)
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

	const provTimeout = 5 * time.Second
	prov, err := embedding.NewOpenAICompat(embedding.ClientConfig{
		Provider:     embedding.ProviderOpenAICompat,
		BaseURL:      embedding.NewEndpoint(stalledSrv.URL),
		APIKey:       embedding.NewSecret("sk-stalled-429"),
		Model:        "qwen",
		Dims:         8,
		QueryTimeout: provTimeout,
	})
	if err != nil {
		t.Fatalf("NewOpenAICompat: %v", err)
	}

	done := make(chan error, 1)
	start := time.Now()
	go func() {
		_, callErr := prov.EmbedQuery(context.Background(), "wifi")
		done <- callErr
	}()
	select {
	case err = <-done:
	case <-time.After(provTimeout / 2):
		t.Fatal("EmbedQuery blocked waiting on stalled 429 body instead of returning on status headers")
	}
	if elapsed := time.Since(start); elapsed >= provTimeout/2 {
		t.Fatalf("stalled 429 took %v (>= %v), expected early return before provider timeout", elapsed, provTimeout/2)
	}
	var pe *embedding.ProviderError
	if !errors.As(err, &pe) || pe.Class != embedding.Class429 || pe.HTTPStatus != http.StatusTooManyRequests || pe.RetryAfter != 18*time.Second {
		t.Fatalf("stalled 429 err = %v (%+v), want Class429 status 429 RetryAfter=18s", err, pe)
	}
}

func TestOpenAICompatCallerCancelPreservesCanceledSentinel(t *testing.T) {
	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()
	srv.SetSlow(500 * time.Millisecond)

	prov, err := embedding.NewOpenAICompat(embedding.ClientConfig{
		Provider:     embedding.ProviderOpenAICompat,
		BaseURL:      embedding.NewEndpoint(srv.URL() + "/v1"),
		APIKey:       embedding.NewSecret("sk-cancel-secret-key"),
		Model:        "qwen",
		Dims:         8,
		QueryTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("NewOpenAICompat: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = prov.EmbedQuery(ctx, "wifi")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled EmbedQuery err = %v, want errors.Is(context.Canceled)", err)
	}
	if embedding.IsTimeoutError(err) {
		t.Fatalf("canceled EmbedQuery must not be classified as timeout: %v", err)
	}
	if strings.Contains(err.Error(), srv.URL()) || strings.Contains(err.Error(), "sk-cancel-secret-key") {
		t.Fatalf("canceled error leaked URL or key: %v", err)
	}
}

func TestFactoryEnforcesTransportPolicyAndTrimmedProviderPrefixes(t *testing.T) {
	// 1. Public plaintext DNS resolution is rejected across direct and factory construction paths.
	var dials atomic.Int32
	pubResolver := fakeResolver{
		lookup: func(_ context.Context, _, _ string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("198.51.100.42")}, nil
		},
	}
	httpOpts := []embedding.HTTPClientOption{
		embedding.WithResolver(pubResolver),
		embedding.WithDialFunc(func(ctx context.Context, network, address string) (net.Conn, error) {
			dials.Add(1)
			var d net.Dialer
			return d.DialContext(ctx, network, address)
		}),
	}

	client, err := embedding.NewClientFromConfig(
		context.Background(),
		embedding.ClientConfig{
			Provider:         "  openai_compat  ",
			BaseURL:          embedding.NewEndpoint("http://rebind-factory.example.invalid:8080/v1"),
			APIKey:           embedding.NewSecret("sk-factory-policy"),
			Model:            "qwen",
			Dims:             8,
			QueryInstruction: "Retrieve matching items",
		},
		embedding.RolePrimary,
		embedding.ClientDeps{HTTPOptions: httpOpts},
	)
	if err != nil {
		t.Fatalf("NewClientFromConfig(openai_compat): %v", err)
	}

	// RV52B-BE1-9: Trimmed provider name must still populate Identity.QueryPrefix.
	wantQueryPrefix := embedding.OpenAIQueryPrefix("Retrieve matching items")
	if client.Identity.Provider != "openai_compat" || client.Identity.QueryPrefix != wantQueryPrefix {
		t.Fatalf("Identity = %+v, want Provider=openai_compat and QueryPrefix=%q", client.Identity, wantQueryPrefix)
	}

	_, err = client.Provider.EmbedQuery(context.Background(), "wifi")
	if !errors.Is(err, embedding.ErrDisallowedIP) {
		t.Fatalf("factory client EmbedQuery to public HTTP IP err = %v, want ErrDisallowedIP", err)
	}
	if dials.Load() != 0 {
		t.Fatalf("dials = %d, want 0 when public IP rejected", dials.Load())
	}

	// TEI factory construction with public HTTP DNS must also fail at boot /info.
	_, err = embedding.NewClientFromConfig(
		context.Background(),
		embedding.ClientConfig{
			Provider: " tei ",
			BaseURL:  embedding.NewEndpoint("http://tei-public.example.invalid:8080"),
			Dims:     8,
		},
		embedding.RolePrimary,
		embedding.ClientDeps{HTTPOptions: httpOpts},
	)
	if !errors.Is(err, embedding.ErrDisallowedIP) {
		t.Fatalf("NewClientFromConfig(tei public IP) err = %v, want ErrDisallowedIP", err)
	}

	// 2. RV52B-BE1-9: Trimmed TEI provider name records QueryPrefix and DocPrefix in Identity matching sent inputs.
	srv := embedtest.NewServer(embedtest.Options{
		Dims:     8,
		ModelID:  "BAAI/bge-m3",
		ModelSHA: "sha-trimmed-tei",
	})
	defer srv.Close()

	teiClient, err := embedding.NewClientFromConfig(
		context.Background(),
		embedding.ClientConfig{
			Provider:    "  tei\t",
			BaseURL:     embedding.NewEndpoint(srv.URL()),
			Dims:        8,
			QueryPrefix: "query: ",
			DocPrefix:   "passage: ",
		},
		embedding.RolePrimary,
		embedding.ClientDeps{},
	)
	if err != nil {
		t.Fatalf("NewClientFromConfig(trimmed tei): %v", err)
	}
	if teiClient.Identity.Provider != "tei" || teiClient.Identity.QueryPrefix != "query: " || teiClient.Identity.DocPrefix != "passage: " {
		t.Fatalf("trimmed TEI Identity = %+v, want prefixes recorded", teiClient.Identity)
	}
	if _, err := teiClient.Provider.EmbedQuery(context.Background(), "wifi"); err != nil {
		t.Fatalf("teiClient EmbedQuery: %v", err)
	}
	qCall, ok := srv.LastCall()
	if !ok || len(qCall.Inputs) != 1 || qCall.Inputs[0] != teiClient.Identity.QueryPrefix+"wifi" {
		t.Fatalf("TEI query call = %+v, want input %q", qCall, teiClient.Identity.QueryPrefix+"wifi")
	}
	if _, err := teiClient.Provider.EmbedDocuments(context.Background(), []string{"doc1"}); err != nil {
		t.Fatalf("teiClient EmbedDocuments: %v", err)
	}
	dCall, ok := srv.LastCall()
	if !ok || len(dCall.Inputs) != 1 || dCall.Inputs[0] != teiClient.Identity.DocPrefix+"doc1" {
		t.Fatalf("TEI doc call = %+v, want input %q", dCall, teiClient.Identity.DocPrefix+"doc1")
	}
}
