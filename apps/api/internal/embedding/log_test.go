package embedding_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

func TestProviderLogsAndErrorsContainNoSensitiveData(t *testing.T) {
	const (
		secretQuery    = "sensitive-query-phrase-do-not-leak-8812"
		secretDocA     = "sensitive-doc-item-name-do-not-leak-9921"
		secretDocB     = "sensitive-doc-hint-text-do-not-leak-7743"
		secretAPIKey   = "sk-live-super-secret-api-key-1122334455"
		secretRespBody = "upstream-confidential-error-body-detail-665544"
		secretPathSlug = "/secret-tenant-gateway-subpath/v1"
	)

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	_, metrics := obs.NewRegistry()

	embedSrv := embedtest.NewServer(embedtest.Options{
		Dims:     8,
		ModelID:  "BAAI/bge-m3",
		ModelSHA: "sha-log-test",
	})
	defer embedSrv.Close()

	// Custom server mux wrapping embedSrv under secretPathSlug and allowing a
	// custom error response body containing secretRespBody.
	var customStatus int
	var customBody string
	gatewaySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if customStatus != 0 {
			if customStatus == http.StatusTooManyRequests {
				w.Header().Set("Retry-After", "12")
			}
			w.Header().Set("X-Upstream-Secret-Header", "header-secret-value-4433")
			w.WriteHeader(customStatus)
			_, _ = w.Write([]byte(customBody))
			return
		}
		// Strip the secret prefix and forward to embedSrv.
		r2 := r.Clone(r.Context())
		r2.URL.Path = strings.TrimPrefix(r.URL.Path, secretPathSlug)
		if r2.URL.Path == "" {
			r2.URL.Path = "/"
		}
		embedSrv.ServeHTTP(w, r2)
	}))
	defer gatewaySrv.Close()

	fullBaseURL := gatewaySrv.URL + secretPathSlug

	openAIProv, err := embedding.NewOpenAICompat(
		embedding.ClientConfig{
			Provider:         embedding.ProviderOpenAICompat,
			BaseURL:          embedding.NewEndpoint(fullBaseURL),
			APIKey:           embedding.NewSecret(secretAPIKey),
			Model:            "openrouter/qwen/qwen3-embedding-8b",
			Dims:             8,
			QueryInstruction: "Given a short search query, retrieve matching item names or tags",
			QueryTimeout:     60 * time.Millisecond,
			DocumentTimeout:  120 * time.Millisecond,
		},
		embedding.WithOpenAILogger(logger),
		embedding.WithOpenAIMetrics(metrics.Embedding),
	)
	if err != nil {
		t.Fatalf("NewOpenAICompat: %v", err)
	}

	teiProv, err := embedding.NewTEI(
		context.Background(),
		embedding.ClientConfig{
			Provider:        embedding.ProviderTEI,
			BaseURL:         embedding.NewEndpoint(fullBaseURL),
			Dims:            8,
			QueryPrefix:     "query: ",
			DocPrefix:       "passage: ",
			QueryTimeout:    60 * time.Millisecond,
			DocumentTimeout: 120 * time.Millisecond,
		},
		embedding.WithTEILogger(logger),
		embedding.WithTEIMetrics(metrics.Embedding),
	)
	if err != nil {
		t.Fatalf("NewTEI: %v", err)
	}

	forbiddenSentinels := []struct {
		name  string
		value string
	}{
		{name: "query text", value: secretQuery},
		{name: "doc A text", value: secretDocA},
		{name: "doc B text", value: secretDocB},
		{name: "API key", value: secretAPIKey},
		{name: "upstream response body", value: secretRespBody},
		{name: "URL path slug", value: secretPathSlug},
		{name: "full base URL", value: fullBaseURL},
		{name: "upstream secret header", value: "header-secret-value-4433"},
		{name: "Bearer token prefix", value: "Bearer"},
	}

	assertNothingLeaked := func(t *testing.T, phase string, callErr error) {
		t.Helper()
		logs := logBuf.String()
		for _, sentinel := range forbiddenSentinels {
			if strings.Contains(logs, sentinel.value) {
				t.Fatalf("[%s] slog output leaked sentinel %s", phase, sentinel.name)
			}
			if callErr != nil && strings.Contains(callErr.Error(), sentinel.value) {
				t.Fatalf("[%s] returned error leaked sentinel %s", phase, sentinel.name)
			}
		}
	}

	// 1. Success (both query and documents on both providers).
	if _, err := openAIProv.EmbedQuery(context.Background(), secretQuery); err != nil {
		t.Fatalf("openAI EmbedQuery ok: %v", err)
	}
	if _, err := openAIProv.EmbedDocuments(context.Background(), []string{secretDocA, secretDocB}); err != nil {
		t.Fatalf("openAI EmbedDocuments ok: %v", err)
	}
	if _, err := teiProv.EmbedQuery(context.Background(), secretQuery); err != nil {
		t.Fatalf("tei EmbedQuery ok: %v", err)
	}
	if _, err := teiProv.EmbedDocuments(context.Background(), []string{secretDocA, secretDocB}); err != nil {
		t.Fatalf("tei EmbedDocuments ok: %v", err)
	}
	assertNothingLeaked(t, "success", nil)

	// 2. Error class: provider_timeout.
	embedSrv.SetSlow(250 * time.Millisecond)
	_, errTimeout := openAIProv.EmbedQuery(context.Background(), secretQuery)
	if errTimeout == nil {
		t.Fatal("expected timeout error")
	}
	assertNothingLeaked(t, "provider_timeout", errTimeout)
	embedSrv.SetMode(embedtest.ModeOK)

	// 3. Error class: provider_5xx with secret upstream body.
	customStatus = http.StatusInternalServerError
	customBody = `{"error":"` + secretRespBody + `"}`
	_, err5xx := openAIProv.EmbedDocuments(context.Background(), []string{secretDocA, secretDocB})
	if err5xx == nil {
		t.Fatal("expected 5xx error")
	}
	assertNothingLeaked(t, "provider_5xx", err5xx)

	// 4. Error class: provider_429 with secret upstream body.
	customStatus = http.StatusTooManyRequests
	customBody = `{"error":"` + secretRespBody + `"}`
	_, err429 := openAIProv.EmbedQuery(context.Background(), secretQuery)
	if err429 == nil {
		t.Fatal("expected 429 error")
	}
	assertNothingLeaked(t, "provider_429", err429)

	// 5. Error class: provider_bad_response (malformed JSON containing secretRespBody).
	customStatus = http.StatusOK
	customBody = "not-json:" + secretRespBody
	_, errBad := teiProv.EmbedQuery(context.Background(), secretQuery)
	if errBad == nil {
		t.Fatal("expected bad_response error")
	}
	assertNothingLeaked(t, "provider_bad_response", errBad)
	customStatus = 0
	customBody = ""

	// 6. Error class: provider_refused (401/403 and closed server connection refused).
	customStatus = http.StatusUnauthorized
	customBody = `{"error":"invalid key ` + secretAPIKey + ` ` + secretRespBody + `"}`
	_, errRefused401 := openAIProv.EmbedQuery(context.Background(), secretQuery)
	if errRefused401 == nil {
		t.Fatal("expected refused error on 401")
	}
	assertNothingLeaked(t, "provider_refused_401", errRefused401)
	customStatus = 0
	customBody = ""

	// Close gatewaySrv so dialing fails with connection refused.
	gatewaySrv.Close()
	_, errRefusedConn := openAIProv.EmbedQuery(context.Background(), secretQuery)
	if errRefusedConn == nil {
		t.Fatal("expected refused error on closed server")
	}
	assertNothingLeaked(t, "provider_refused_conn", errRefusedConn)

	// Verify expected structured fields ARE present in the captured JSON logs.
	allLogs := logBuf.String()
	for _, wantField := range []string{
		`"provider":"openai_compat"`,
		`"provider":"tei"`,
		`"op":"query"`,
		`"op":"document"`,
		`"input_count":1`,
		`"input_count":2`,
		`"latency_ms":`,
		`"error_class":"provider_timeout"`,
		`"error_class":"provider_5xx"`,
		`"error_class":"provider_429"`,
		`"error_class":"provider_bad_response"`,
		`"error_class":"provider_refused"`,
		`"http_status":500`,
		`"http_status":429`,
	} {
		if !strings.Contains(allLogs, wantField) {
			t.Fatalf("slog output missing expected structured field %s", wantField)
		}
	}
}

func TestProviderValueAndPointerRedactionInFmtJSONAndSlog(t *testing.T) {
	const (
		secretAPIKey       = "sk-live-value-format-sentinel-key-99887766"
		secretPathSlug     = "/secret-gateway-marker-776655/v1"
		sensitiveTEIModel  = "BAAI/bge-m3-sensitive-info-marker-445566"
		sensitiveTEISHA    = "sha-sensitive-revision-marker-778899"
		sensitiveOpenAIMod = "openrouter/qwen/qwen3-embedding-8b-marker-112233"
	)

	embedSrv := embedtest.NewServer(embedtest.Options{
		Dims:     8,
		ModelID:  sensitiveTEIModel,
		ModelSHA: sensitiveTEISHA,
	})
	defer embedSrv.Close()

	muxSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r2 := r.Clone(r.Context())
		r2.URL.Path = strings.TrimPrefix(r.URL.Path, secretPathSlug)
		if r2.URL.Path == "" {
			r2.URL.Path = "/"
		}
		embedSrv.ServeHTTP(w, r2)
	}))
	defer muxSrv.Close()

	fullBaseURL := muxSrv.URL + secretPathSlug

	openAICfg := embedding.ClientConfig{
		Provider:         embedding.ProviderOpenAICompat,
		BaseURL:          embedding.NewEndpoint(fullBaseURL),
		APIKey:           embedding.NewSecret(secretAPIKey),
		Model:            sensitiveOpenAIMod,
		Dims:             8,
		QueryInstruction: "Retrieve matching items",
	}
	openAIPtr, err := embedding.NewOpenAICompat(openAICfg)
	if err != nil {
		t.Fatalf("NewOpenAICompat: %v", err)
	}
	openAIVal := *openAIPtr

	teiCfg := embedding.ClientConfig{
		Provider:    embedding.ProviderTEI,
		BaseURL:     embedding.NewEndpoint(fullBaseURL),
		Dims:        8,
		QueryPrefix: "query: ",
		DocPrefix:   "passage: ",
	}
	teiPtr, err := embedding.NewTEI(context.Background(), teiCfg)
	if err != nil {
		t.Fatalf("NewTEI: %v", err)
	}
	teiVal := *teiPtr
	if teiPtr.Model() != "tei/"+sensitiveTEIModel || !strings.HasPrefix(teiPtr.ModelVersion(), sensitiveTEISHA+";") {
		t.Fatalf("TEI identity methods changed: Model()=%q ModelVersion()=%q", teiPtr.Model(), teiPtr.ModelVersion())
	}
	if openAIPtr.Model() != "openai_compat/"+sensitiveOpenAIMod {
		t.Fatalf("OpenAICompat.Model() = %q", openAIPtr.Model())
	}
	var textLogBuf, jsonLogBuf bytes.Buffer
	textLogger := slog.New(slog.NewTextHandler(&textLogBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	jsonLogger := slog.New(slog.NewJSONHandler(&jsonLogBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	textLogger.Info("providers",
		slog.Any("openai_ptr", openAIPtr),
		slog.Any("openai_val", openAIVal),
		slog.Any("tei_ptr", teiPtr),
		slog.Any("tei_val", teiVal),
		slog.Any("cfg", openAICfg),
		slog.Any("secret", openAICfg.APIKey),
	)
	jsonLogger.Info("providers",
		slog.Any("openai_ptr", openAIPtr),
		slog.Any("openai_val", openAIVal),
		slog.Any("tei_ptr", teiPtr),
		slog.Any("tei_val", teiVal),
		slog.Any("cfg", openAICfg),
		slog.Any("secret", openAICfg.APIKey),
	)

	jsonPtrBytes, err := json.Marshal(openAIPtr)
	if err != nil {
		t.Fatalf("json.Marshal(openAIPtr): %v", err)
	}
	jsonValBytes, err := json.Marshal(openAIVal)
	if err != nil {
		t.Fatalf("json.Marshal(openAIVal): %v", err)
	}
	jsonTEIPtrBytes, err := json.Marshal(teiPtr)
	if err != nil {
		t.Fatalf("json.Marshal(teiPtr): %v", err)
	}
	jsonTEIValBytes, err := json.Marshal(teiVal)
	if err != nil {
		t.Fatalf("json.Marshal(teiVal): %v", err)
	}
	jsonCfgBytes, err := json.Marshal(openAICfg)
	if err != nil {
		t.Fatalf("json.Marshal(openAICfg): %v", err)
	}
	textCfgBytes, err := openAICfg.MarshalText()
	if err != nil {
		t.Fatalf("openAICfg.MarshalText(): %v", err)
	}

	unexportedSecretHolder := struct{ key embedding.Secret }{key: openAICfg.APIKey}
	unexportedEndpointHolder := struct{ ep embedding.Endpoint }{ep: openAICfg.BaseURL}
	unexportedProviderHolder := struct{ prov embedding.OpenAICompat }{prov: openAIVal}
	unexportedTEIHolder := struct{ prov embedding.TEI }{prov: teiVal}
	unexportedCfgHolder := struct{ cfg embedding.ClientConfig }{cfg: openAICfg}
	representations := map[string]string{
		"openai_ptr_%v":            fmt.Sprintf("%v", openAIPtr),
		"openai_ptr_%+v":           fmt.Sprintf("%+v", openAIPtr),
		"openai_ptr_%#v":           fmt.Sprintf("%#v", openAIPtr),
		"openai_ptr_%s":            fmt.Sprintf("%s", openAIPtr),
		"openai_ptr_%q":            fmt.Sprintf("%q", openAIPtr),
		"openai_val_%v":            fmt.Sprintf("%v", openAIVal),
		"openai_val_%+v":           fmt.Sprintf("%+v", openAIVal),
		"openai_val_%#v":           fmt.Sprintf("%#v", openAIVal),
		"openai_val_%s":            fmt.Sprintf("%s", openAIVal),
		"openai_val_%q":            fmt.Sprintf("%q", openAIVal),
		"unexported_secret_%v":     fmt.Sprintf("%v", unexportedSecretHolder),
		"unexported_secret_%+v":    fmt.Sprintf("%+v", unexportedSecretHolder),
		"unexported_secret_%#v":    fmt.Sprintf("%#v", unexportedSecretHolder),
		"unexported_endpoint_%v":   fmt.Sprintf("%v", unexportedEndpointHolder),
		"unexported_endpoint_%+v":  fmt.Sprintf("%+v", unexportedEndpointHolder),
		"unexported_endpoint_%#v":  fmt.Sprintf("%#v", unexportedEndpointHolder),
		"unexported_prov_%v":       fmt.Sprintf("%v", unexportedProviderHolder),
		"unexported_prov_%+v":      fmt.Sprintf("%+v", unexportedProviderHolder),
		"unexported_prov_%#v":      fmt.Sprintf("%#v", unexportedProviderHolder),
		"unexported_tei_%v":        fmt.Sprintf("%v", unexportedTEIHolder),
		"unexported_tei_%+v":       fmt.Sprintf("%+v", unexportedTEIHolder),
		"unexported_tei_%#v":       fmt.Sprintf("%#v", unexportedTEIHolder),
		"unexported_clientcfg_%v":  fmt.Sprintf("%v", unexportedCfgHolder),
		"unexported_clientcfg_%+v": fmt.Sprintf("%+v", unexportedCfgHolder),
		"unexported_clientcfg_%#v": fmt.Sprintf("%#v", unexportedCfgHolder),
		"tei_ptr_%v":               fmt.Sprintf("%v", teiPtr),
		"tei_ptr_%+v":              fmt.Sprintf("%+v", teiPtr),
		"tei_ptr_%#v":              fmt.Sprintf("%#v", teiPtr),
		"tei_ptr_%s":               fmt.Sprintf("%s", teiPtr),
		"tei_ptr_%q":               fmt.Sprintf("%q", teiPtr),
		"tei_val_%v":               fmt.Sprintf("%v", teiVal),
		"tei_val_%+v":              fmt.Sprintf("%+v", teiVal),
		"tei_val_%#v":              fmt.Sprintf("%#v", teiVal),
		"tei_val_%s":               fmt.Sprintf("%s", teiVal),
		"tei_val_%q":               fmt.Sprintf("%q", teiVal),
		"cfg_%v":                   fmt.Sprintf("%v", openAICfg),
		"cfg_%+v":                  fmt.Sprintf("%+v", openAICfg),
		"cfg_%#v":                  fmt.Sprintf("%#v", openAICfg),
		"cfg_%s":                   fmt.Sprintf("%s", openAICfg),
		"cfg_%q":                   fmt.Sprintf("%q", openAICfg),
		"secret_%v":                fmt.Sprintf("%v", openAICfg.APIKey),
		"secret_%+v":               fmt.Sprintf("%+v", openAICfg.APIKey),
		"secret_%#v":               fmt.Sprintf("%#v", openAICfg.APIKey),
		"secret_%x":                fmt.Sprintf("%x", openAICfg.APIKey),
		"json_openai_ptr":          string(jsonPtrBytes),
		"json_openai_val":          string(jsonValBytes),
		"json_tei_ptr":             string(jsonTEIPtrBytes),
		"json_tei_val":             string(jsonTEIValBytes),
		"json_cfg":                 string(jsonCfgBytes),
		"text_cfg":                 string(textCfgBytes),
		"slog_text":                textLogBuf.String(),
		"slog_json":                jsonLogBuf.String(),
	}

	forbidden := []struct {
		name  string
		value string
	}{
		{name: "API key", value: secretAPIKey},
		{name: "URL path slug", value: secretPathSlug},
		{name: "full base URL", value: fullBaseURL},
		{name: "server base URL", value: muxSrv.URL},
	}
	for label, repr := range representations {
		for _, sentinel := range forbidden {
			if strings.Contains(repr, sentinel.value) {
				t.Fatalf("%s leaked sentinel %s", label, sentinel.name)
			}
		}
	}

	// RV52B-BE2-2: Direct fmt and slog of TEI and OpenAICompat providers (value and pointer)
	// must not publish /info response strings (model_id, model_sha) or raw model strings.
	providerDiagnosticSurfaces := map[string]string{
		"openai_ptr_%v":   representations["openai_ptr_%v"],
		"openai_ptr_%+v":  representations["openai_ptr_%+v"],
		"openai_ptr_%#v":  representations["openai_ptr_%#v"],
		"openai_ptr_%s":   representations["openai_ptr_%s"],
		"openai_ptr_%q":   representations["openai_ptr_%q"],
		"openai_val_%v":   representations["openai_val_%v"],
		"openai_val_%+v":  representations["openai_val_%+v"],
		"openai_val_%#v":  representations["openai_val_%#v"],
		"openai_val_%s":   representations["openai_val_%s"],
		"openai_val_%q":   representations["openai_val_%q"],
		"tei_ptr_%v":      representations["tei_ptr_%v"],
		"tei_ptr_%+v":     representations["tei_ptr_%+v"],
		"tei_ptr_%#v":     representations["tei_ptr_%#v"],
		"tei_ptr_%s":      representations["tei_ptr_%s"],
		"tei_ptr_%q":      representations["tei_ptr_%q"],
		"tei_val_%v":      representations["tei_val_%v"],
		"tei_val_%+v":     representations["tei_val_%+v"],
		"tei_val_%#v":     representations["tei_val_%#v"],
		"tei_val_%s":      representations["tei_val_%s"],
		"tei_val_%q":      representations["tei_val_%q"],
		"json_openai_ptr": representations["json_openai_ptr"],
		"json_openai_val": representations["json_openai_val"],
		"json_tei_ptr":    representations["json_tei_ptr"],
		"json_tei_val":    representations["json_tei_val"],
		"slog_text":       representations["slog_text"],
		"slog_json":       representations["slog_json"],
	}
	responseMarkers := []struct {
		name  string
		value string
	}{
		{name: "TEI /info model_id marker", value: sensitiveTEIModel},
		{name: "TEI /info model_sha marker", value: sensitiveTEISHA},
	}
	for label, repr := range providerDiagnosticSurfaces {
		for _, marker := range responseMarkers {
			if strings.Contains(repr, marker.value) {
				t.Fatalf("%s leaked %s", label, marker.name)
			}
		}
	}
}
