package httpx_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	dto "github.com/prometheus/client_model/go"

	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/obs"
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

func TestRequestDurationMethodLabelHasBoundedCardinality(t *testing.T) {
	var buf bytes.Buffer
	reg, metrics := obs.NewRegistry()
	r := httpx.NewRouter(httpx.Deps{
		Config:           &config.Config{Env: "test", EmbeddingProvider: "noop"},
		Logger:           testDeps(&buf).Logger,
		Ready:            func(context.Context) error { return nil },
		Metrics:          http.NotFoundHandler(),
		MetricsCollector: metrics,
	})

	for _, method := range []string{"GET", "X-Method-1", "X-Method-2", "X-Method-3"} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(method, "/api/v1/healthz", nil))
	}

	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}
	var family *dto.MetricFamily
	for _, candidate := range families {
		if candidate.GetName() == "engram_http_request_duration_seconds" {
			family = candidate
			break
		}
	}
	if family == nil {
		t.Fatal("thiếu metric engram_http_request_duration_seconds")
	}

	if got, want := len(family.GetMetric()), 2; got != want {
		t.Fatalf("metric series = %d, muốn %d", got, want)
	}
	methods := make(map[string]bool)
	for _, metric := range family.GetMetric() {
		labels := make(map[string]string)
		for _, label := range metric.GetLabel() {
			labels[label.GetName()] = label.GetValue()
		}
		methods[labels["method"]] = true
	}
	if !methods["GET"] || !methods["OTHER"] {
		t.Errorf("method labels = %v, muốn GET và OTHER", methods)
	}
}

func TestRequestDurationRecordsFirstFinalStatusAndImplicitWrite(t *testing.T) {
	tests := []struct {
		name string
		h    http.Handler
		want string
	}{
		{
			name: "first final status",
			h: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusEarlyHints)
				w.WriteHeader(http.StatusAccepted)
				w.WriteHeader(http.StatusTeapot)
			}),
			want: "202",
		},
		{
			name: "implicit write",
			h: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte("ok"))
			}),
			want: "200",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, metrics := obs.NewRegistry()
			httpx.Observe(metrics)(tt.h).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/status", nil))

			families, err := reg.Gather()
			if err != nil {
				t.Fatalf("Gather: %v", err)
			}
			for _, family := range families {
				if family.GetName() != "engram_http_request_duration_seconds" {
					continue
				}
				if got := len(family.GetMetric()); got != 1 {
					t.Fatalf("metric series = %d, muốn 1", got)
				}
				for _, label := range family.GetMetric()[0].GetLabel() {
					if label.GetName() == "status" && label.GetValue() != tt.want {
						t.Errorf("status label = %q, muốn %q", label.GetValue(), tt.want)
					}
				}
				return
			}
			t.Fatal("thiếu metric engram_http_request_duration_seconds")
		})
	}
}
