package httpx_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
)

func TestMetricsEndpointExposesRequestDuration(t *testing.T) {
	var buf bytes.Buffer
	reg, metrics := obs.NewRegistry()

	r := httpx.NewRouter(httpx.Deps{
		Config:           &config.Config{Env: "test", EmbeddingProvider: "noop"},
		Logger:           testDeps(&buf).Logger,
		Ready:            func(context.Context) error { return nil },
		Metrics:          promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
		MetricsCollector: metrics,
	})

	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/healthz", nil))

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, muốn 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "engram_http_request_duration_seconds") {
		t.Errorf("metrics thiếu histogram: %s", body)
	}
	if !strings.Contains(body, `route="/api/v1/healthz"`) {
		t.Errorf("metrics thiếu label route: %s", body)
	}
}
