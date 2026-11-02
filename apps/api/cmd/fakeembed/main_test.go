package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/embedding"
)

func envFromMap(kv map[string]string) envLookup {
	return func(key string) string {
		if kv == nil {
			return ""
		}
		return kv[key]
	}
}

func startTestServer(t *testing.T, kv map[string]string) *httptest.Server {
	t.Helper()
	if kv == nil {
		kv = map[string]string{"APP_ENV": "development"}
	} else if _, ok := kv["APP_ENV"]; !ok {
		cp := make(map[string]string, len(kv)+1)
		for k, v := range kv {
			cp[k] = v
		}
		cp["APP_ENV"] = "development"
		kv = cp
	}
	handler, _, err := newHandler(envFromMap(kv))
	if err != nil {
		t.Fatalf("newHandler(%v) error = %v", kv, err)
	}
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	return ts
}

func doJSONRequest(t *testing.T, method, url string, body any) (int, []byte) {
	t.Helper()
	var reqReader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("json.Marshal(%T) error = %v", body, err)
		}
		reqReader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, url, reqReader)
	if err != nil {
		t.Fatalf("http.NewRequestWithContext(%s, %s) error = %v", method, url, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("http.Do(%s %s) error = %v", method, url, err)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			t.Errorf("resp.Body.Close() error = %v", closeErr)
		}
	}()
	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("io.ReadAll(%s %s) error = %v", method, url, err)
	}
	return resp.StatusCode, respBytes
}

func cosineSimilarity(a, b []float32) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, normA, normB float64
	for i := range a {
		fa, fb := float64(a[i]), float64(b[i])
		dot += fa * fb
		normA += fa * fa
		normB += fb * fb
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}

func TestControlModes(t *testing.T) {
	ts := startTestServer(t, map[string]string{
		"APP_ENV":        "development",
		"FAKEEMBED_DIMS": "32",
	})

	// 1. mode="down" -> /embed and /embeddings return 5xx.
	status, _ := doJSONRequest(t, http.MethodPost, ts.URL+"/__control", map[string]any{
		"mode": "down",
	})
	if status != http.StatusOK {
		t.Fatalf("POST /__control down status = %d, want 200", status)
	}

	teiStatus, _ := doJSONRequest(t, http.MethodPost, ts.URL+"/embed", map[string]any{
		"inputs":    []string{"doc-when-down"},
		"normalize": true,
		"truncate":  true,
	})
	if teiStatus < 500 || teiStatus >= 600 {
		t.Fatalf("POST /embed in down mode status = %d, want 5xx", teiStatus)
	}

	oaiStatus, _ := doJSONRequest(t, http.MethodPost, ts.URL+"/embeddings", map[string]any{
		"model":           "fake",
		"input":           []string{"doc-when-down"},
		"dimensions":      32,
		"encoding_format": "float",
	})
	if oaiStatus < 500 || oaiStatus >= 600 {
		t.Fatalf("POST /embeddings in down mode status = %d, want 5xx", oaiStatus)
	}

	// 2. mode="slow" with delay_ms=60 -> response delayed >= 50ms (lower bound only).
	const delayMs = 60
	status, _ = doJSONRequest(t, http.MethodPost, ts.URL+"/__control", map[string]any{
		"mode":     "slow",
		"delay_ms": delayMs,
	})
	if status != http.StatusOK {
		t.Fatalf("POST /__control slow status = %d, want 200", status)
	}

	start := time.Now()
	slowStatus, slowBody := doJSONRequest(t, http.MethodPost, ts.URL+"/embed", map[string]any{
		"inputs":    []string{"slow-doc"},
		"normalize": true,
		"truncate":  true,
	})
	elapsed := time.Since(start)
	if slowStatus != http.StatusOK {
		t.Fatalf("POST /embed in slow mode status = %d, want 200", slowStatus)
	}
	if elapsed < 50*time.Millisecond {
		t.Fatalf("POST /embed in slow mode elapsed = %v, want >= 50ms", elapsed)
	}
	var slowVecs [][]float32
	if err := json.Unmarshal(slowBody, &slowVecs); err != nil {
		t.Fatalf("decode slow /embed response: %v", err)
	}
	if len(slowVecs) != 1 || len(slowVecs[0]) != 32 {
		t.Fatalf("slow /embed vectors shape = %dx%d, want 1x32", len(slowVecs), len(slowVecs[0]))
	}

	// 3. mode="ok" -> 200 with dims-length vectors on both /embed and /embeddings.
	status, _ = doJSONRequest(t, http.MethodPost, ts.URL+"/__control", map[string]any{
		"mode": "ok",
	})
	if status != http.StatusOK {
		t.Fatalf("POST /__control ok status = %d, want 200", status)
	}

	okStatus, okBody := doJSONRequest(t, http.MethodPost, ts.URL+"/embed", map[string]any{
		"inputs":    []string{"ok-doc-1", "ok-doc-2"},
		"normalize": true,
		"truncate":  true,
	})
	if okStatus != http.StatusOK {
		t.Fatalf("POST /embed in ok mode status = %d, want 200", okStatus)
	}
	var okVecs [][]float32
	if err := json.Unmarshal(okBody, &okVecs); err != nil {
		t.Fatalf("decode ok /embed response: %v", err)
	}
	if len(okVecs) != 2 || len(okVecs[0]) != 32 || len(okVecs[1]) != 32 {
		t.Fatalf("ok /embed vectors shape = %d, want 2 vectors of len 32", len(okVecs))
	}

	oaiOKStatus, oaiOKBody := doJSONRequest(t, http.MethodPost, ts.URL+"/embeddings", map[string]any{
		"model":           "fake",
		"input":           []string{"ok-oai-doc"},
		"dimensions":      32,
		"encoding_format": "float",
	})
	if oaiOKStatus != http.StatusOK {
		t.Fatalf("POST /embeddings in ok mode status = %d, want 200", oaiOKStatus)
	}
	var oaiParsed struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(oaiOKBody, &oaiParsed); err != nil {
		t.Fatalf("decode /embeddings response: %v", err)
	}
	if len(oaiParsed.Data) != 1 || len(oaiParsed.Data[0].Embedding) != 32 {
		t.Fatalf("/embeddings data shape = %+v, want 1 embedding of len 32", oaiParsed.Data)
	}

	// 4. Unknown mode -> 400.
	badStatus, _ := doJSONRequest(t, http.MethodPost, ts.URL+"/__control", map[string]any{
		"mode": "unknown_invalid_mode",
	})
	if badStatus != http.StatusBadRequest {
		t.Fatalf("POST /__control unknown mode status = %d, want 400", badStatus)
	}
}

func TestControlAliasEmbedsLikeTarget(t *testing.T) {
	const queryPrefix = "query: "
	const docPrefix = "passage: "

	ts := startTestServer(t, map[string]string{
		"APP_ENV":                "development",
		"FAKEEMBED_QUERY_PREFIX": queryPrefix,
	})

	docText := docPrefix + embedding.ItemInput("Thẻ ngân hàng Vietcombank", "chi nhánh Hà Nội")
	status, _ := doJSONRequest(t, http.MethodPost, ts.URL+"/__control", map[string]any{
		"mode": "ok",
		"aliases": map[string]string{
			"zzprobe-1": docText,
		},
	})
	if status != http.StatusOK {
		t.Fatalf("POST /__control aliases status = %d, want 200", status)
	}

	embedSingle := func(input string) []float32 {
		t.Helper()
		code, raw := doJSONRequest(t, http.MethodPost, ts.URL+"/embed", map[string]any{
			"inputs":    []string{input},
			"normalize": true,
			"truncate":  true,
		})
		if code != http.StatusOK {
			t.Fatalf("POST /embed(%q) status = %d, want 200", input, code)
		}
		var vecs [][]float32
		if err := json.Unmarshal(raw, &vecs); err != nil || len(vecs) != 1 {
			t.Fatalf("decode /embed(%q) error = %v, len = %d", input, err, len(vecs))
		}
		return vecs[0]
	}

	probeVec := embedSingle(queryPrefix + "zzprobe-1")
	docVec := embedSingle(docText)
	nonAliasVec := embedSingle(queryPrefix + "completely-different-query")

	cosAlias := cosineSimilarity(probeVec, docVec)
	if math.Abs(cosAlias-1.0) > 1e-6 {
		t.Fatalf("cosine(probe, target doc) = %v, want 1.0 ± 1e-6", cosAlias)
	}

	cosOther := cosineSimilarity(nonAliasVec, docVec)
	if math.Abs(cosOther-1.0) < 1e-3 {
		t.Fatalf("expected non-alias query to differ from target document, got cosine = %v", cosOther)
	}
}

func TestControlStatsCountsOnly(t *testing.T) {
	const queryPrefix = "query: "
	ts := startTestServer(t, map[string]string{
		"APP_ENV":                "development",
		"FAKEEMBED_QUERY_PREFIX": queryPrefix,
	})

	const secretDocA = "sentinel-doc-alpha-918273"
	const secretDocB = "sentinel-doc-bravo-645342"
	const secretQuery1 = "sentinel-query-charlie-112233"
	const secretQuery2 = "sentinel-query-delta-445566"
	const secretDownDoc = "sentinel-doc-down-778899"

	// 1 document batch request (2 items -> still 1 document request).
	st, _ := doJSONRequest(t, http.MethodPost, ts.URL+"/embed", map[string]any{
		"inputs":    []string{secretDocA, secretDocB},
		"normalize": true,
		"truncate":  true,
	})
	if st != http.StatusOK {
		t.Fatalf("POST /embed doc status = %d, want 200", st)
	}

	// 1 TEI query request (matches configured queryPrefix).
	st, _ = doJSONRequest(t, http.MethodPost, ts.URL+"/embed", map[string]any{
		"inputs":    []string{queryPrefix + secretQuery1},
		"normalize": true,
		"truncate":  true,
	})
	if st != http.StatusOK {
		t.Fatalf("POST /embed query status = %d, want 200", st)
	}

	// Switch to mode="down" and verify counters still increment for both query and document requests.
	st, _ = doJSONRequest(t, http.MethodPost, ts.URL+"/__control", map[string]any{
		"mode": "down",
	})
	if st != http.StatusOK {
		t.Fatalf("POST /__control down status = %d, want 200", st)
	}

	downQueryStatus, _ := doJSONRequest(t, http.MethodPost, ts.URL+"/v1/embeddings", map[string]any{
		"model":           "fake",
		"input":           []string{"Instruct: search\nQuery:" + secretQuery2},
		"dimensions":      1024,
		"encoding_format": "float",
	})
	if downQueryStatus < 500 || downQueryStatus >= 600 {
		t.Fatalf("POST /v1/embeddings in down mode status = %d, want 5xx", downQueryStatus)
	}

	downDocStatus, _ := doJSONRequest(t, http.MethodPost, ts.URL+"/embed", map[string]any{
		"inputs":    []string{secretDownDoc},
		"normalize": true,
		"truncate":  true,
	})
	if downDocStatus < 500 || downDocStatus >= 600 {
		t.Fatalf("POST /embed in down mode status = %d, want 5xx", downDocStatus)
	}

	statsStatus, statsRaw := doJSONRequest(t, http.MethodGet, ts.URL+"/__control/stats", nil)
	if statsStatus != http.StatusOK {
		t.Fatalf("GET /__control/stats status = %d, want 200", statsStatus)
	}

	rawBody := string(statsRaw)
	for _, sentinel := range []string{secretDocA, secretDocB, secretQuery1, secretQuery2, secretDownDoc, "sentinel"} {
		if strings.Contains(rawBody, sentinel) {
			t.Fatalf("GET /__control/stats leaked input %q in body: %s", sentinel, rawBody)
		}
	}

	var rawFields map[string]any
	if err := json.Unmarshal(statsRaw, &rawFields); err != nil {
		t.Fatalf("json.Unmarshal stats map: %v", err)
	}
	if len(rawFields) != 3 {
		t.Fatalf("stats JSON field count = %d, want exactly 3: %v", len(rawFields), rawFields)
	}

	var parsed struct {
		QueryRequests    int64 `json:"query_requests"`
		DocumentRequests int64 `json:"document_requests"`
		TotalRequests    int64 `json:"total_requests"`
	}
	if err := json.Unmarshal(statsRaw, &parsed); err != nil {
		t.Fatalf("json.Unmarshal stats struct: %v", err)
	}
	if parsed.QueryRequests != 2 || parsed.DocumentRequests != 2 || parsed.TotalRequests != 4 {
		t.Fatalf("stats = %+v, want query=2 document=2 total=4", parsed)
	}
}

func TestIdentityMatchesCalibration(t *testing.T) {
	ts := startTestServer(t, map[string]string{
		"APP_ENV": "development",
	})

	primaryCfg := embedding.ClientConfig{
		Provider:    embedding.FakeEmbedProvider,
		BaseURL:     embedding.NewEndpoint(ts.URL),
		Dims:        defaultDims,
		QueryPrefix: "",
		DocPrefix:   "",
	}
	cs, err := embedding.NewClientSetFromConfigs(context.Background(), primaryCfg, nil, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("NewClientSetFromConfigs() error = %v", err)
	}

	id := cs.Primary().Identity
	if id.Provider != embedding.FakeEmbedProvider {
		t.Fatalf("Identity.Provider = %q, want %q", id.Provider, embedding.FakeEmbedProvider)
	}
	if id.Model != embedding.FakeEmbedModel {
		t.Fatalf("Identity.Model = %q, want %q", id.Model, embedding.FakeEmbedModel)
	}
	if !strings.HasPrefix(id.ModelVersion, embedding.FakeEmbedModelVersionPrefix) {
		t.Fatalf("Identity.ModelVersion = %q, want prefix %q", id.ModelVersion, embedding.FakeEmbedModelVersionPrefix)
	}
	if id.Dims != defaultDims {
		t.Fatalf("Identity.Dims = %d, want %d", id.Dims, defaultDims)
	}

	for _, env := range []string{"development", "staging"} {
		minCos, reportPath, ok := embedding.CalibrationLookupFor(env)(id)
		if !ok {
			t.Fatalf("CalibrationLookupFor(%q)(id) = not ok, want ok", env)
		}
		if minCos <= 0 {
			t.Fatalf("CalibrationLookupFor(%q) minCos = %v, want > 0", env, minCos)
		}
		if reportPath != embedding.FakeEmbedReportPath {
			t.Fatalf("CalibrationLookupFor(%q) reportPath = %q, want %q", env, reportPath, embedding.FakeEmbedReportPath)
		}
	}

	if _, _, ok := embedding.CalibrationLookupFor("production")(id); ok {
		t.Fatal("CalibrationLookupFor(\"production\")(id) = ok, want false (must fail closed in production)")
	}
}

func TestRefusesOutsideDevStaging(t *testing.T) {
	refused := []string{"production", "", "prod", "test", "local", "DEVELOPMENT"}
	for _, appEnv := range refused {
		_, _, err := newHandler(envFromMap(map[string]string{
			"APP_ENV": appEnv,
		}))
		if err == nil {
			t.Fatalf("newHandler(APP_ENV=%q) = nil, want error", appEnv)
		}
		if appEnv != "" && appEnv != "development" && appEnv != "staging" && strings.Contains(err.Error(), appEnv) {
			t.Fatalf("error message %q should not echo raw APP_ENV value %q", err.Error(), appEnv)
		}
	}

	allowed := []string{"development", "staging"}
	for _, appEnv := range allowed {
		h, cfg, err := newHandler(envFromMap(map[string]string{
			"APP_ENV": appEnv,
		}))
		if err != nil {
			t.Fatalf("newHandler(APP_ENV=%q) unexpected error = %v", appEnv, err)
		}
		if h == nil || cfg.appEnv != appEnv {
			t.Fatalf("newHandler(APP_ENV=%q) returned nil handler or mismatched appEnv %q", appEnv, cfg.appEnv)
		}
	}
}

func TestHealthcheckProbe(t *testing.T) {
	ts := startTestServer(t, map[string]string{
		"APP_ENV": "development",
	})

	// Put the handler in "down" mode so /health would return 503, and verify
	// probeHealthcheck still succeeds because it probes GET /__control/stats.
	status, _ := doJSONRequest(t, http.MethodPost, ts.URL+"/__control", map[string]any{
		"mode": "down",
	})
	if status != http.StatusOK {
		t.Fatalf("POST /__control down status = %d, want 200", status)
	}

	healthStatus, _ := doJSONRequest(t, http.MethodGet, ts.URL+"/health", nil)
	if healthStatus < 500 || healthStatus >= 600 {
		t.Fatalf("GET /health in down mode status = %d, want 5xx", healthStatus)
	}

	listenAddr := strings.TrimPrefix(ts.URL, "http://")
	err := probeHealthcheck(context.Background(), envFromMap(map[string]string{
		"FAKEEMBED_ADDR": listenAddr,
	}))
	if err != nil {
		t.Fatalf("probeHealthcheck() in down mode error = %v, want nil", err)
	}
}
