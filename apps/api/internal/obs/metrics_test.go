package obs_test

import (
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
)

func TestMetricsLabelsContainNoUserData(t *testing.T) {
	reg, m := obs.NewRegistry()

	m.RequestDuration.WithLabelValues("/api/v1/healthz", "GET", "200").Observe(0.01)

	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}

	var found bool
	for _, f := range families {
		if f.GetName() != "engram_http_request_duration_seconds" {
			continue
		}
		found = true
		for _, metric := range f.GetMetric() {
			for _, label := range metric.GetLabel() {
				switch label.GetName() {
				case "route", "method", "status":
				default:
					t.Errorf("label lạ %q — metric không được mang dữ liệu người dùng", label.GetName())
				}
				if strings.Contains(label.GetValue(), "?") {
					t.Errorf("label %q chứa query string: %q", label.GetName(), label.GetValue())
				}
			}
		}
	}
	if !found {
		t.Fatal("thiếu metric engram_http_request_duration_seconds")
	}
}

func TestRegistryHasGoAndProcessCollectors(t *testing.T) {
	reg, _ := obs.NewRegistry()
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}
	var hasGo bool
	for _, f := range families {
		if strings.HasPrefix(f.GetName(), "go_") {
			hasGo = true
		}
	}
	if !hasGo {
		t.Error("registry thiếu Go collector")
	}
	var _ prometheus.Gatherer = reg
}
