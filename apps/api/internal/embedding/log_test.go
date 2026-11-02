package embedding_test

import (
	"bytes"
	"context"
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
			BaseURL:          fullBaseURL,
			APIKey:           secretAPIKey,
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
			BaseURL:         fullBaseURL,
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

	forbiddenSubstrings := []string{
		secretQuery,
		secretDocA,
		secretDocB,
		secretAPIKey,
		secretRespBody,
		secretPathSlug,
		fullBaseURL,
		"header-secret-value-4433",
		"Bearer",
	}

	assertNothingLeaked := func(t *testing.T, phase string, callErr error) {
		t.Helper()
		logs := logBuf.String()
		for _, forbidden := range forbiddenSubstrings {
			if strings.Contains(logs, forbidden) {
				t.Fatalf("[%s] slog output leaked %q:\n%s", phase, forbidden, logs)
			}
			if callErr != nil && strings.Contains(callErr.Error(), forbidden) {
				t.Fatalf("[%s] returned error leaked %q: %v", phase, forbidden, callErr)
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
			t.Fatalf("slog output missing expected structured field %s:\n%s", wantField, allLogs)
		}
	}
}
