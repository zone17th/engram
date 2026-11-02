package obs_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/zone17th/engram/apps/api/internal/obs"
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

func TestRegistryRegistersVaultCountersWithoutUserLabels(t *testing.T) {
	reg, m := obs.NewRegistry()

	m.VaultRecoverTotal.Inc()
	m.VaultUnlockFailuresTotal.WithLabelValues("recovery").Inc()

	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}

	var hasRecover, hasUnlockFailures bool
	for _, f := range families {
		switch f.GetName() {
		case "vault_recover_total":
			hasRecover = true
			for _, metric := range f.GetMetric() {
				if len(metric.GetLabel()) != 0 {
					t.Errorf("vault_recover_total không được có label: %+v", metric.GetLabel())
				}
			}
		case "vault_unlock_failures_total":
			hasUnlockFailures = true
			for _, metric := range f.GetMetric() {
				for _, label := range metric.GetLabel() {
					if label.GetName() != "method" {
						t.Errorf("vault_unlock_failures_total có label lạ %q", label.GetName())
					}
				}
			}
		}
	}
	if !hasRecover {
		t.Fatal("thiếu metric vault_recover_total")
	}
	if !hasUnlockFailures {
		t.Fatal("thiếu metric vault_unlock_failures_total")
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

type fakeGaugeSource struct {
	lags []obs.JobLagSample
	dead float64
	covs []obs.GenerationCoverageSample
}

func (f *fakeGaugeSource) JobLag(_ context.Context) ([]obs.JobLagSample, error) {
	return f.lags, nil
}

func (f *fakeGaugeSource) DeadLetterJobs(_ context.Context) (float64, error) {
	return f.dead, nil
}

func (f *fakeGaugeSource) Coverage(_ context.Context) ([]obs.GenerationCoverageSample, error) {
	return f.covs, nil
}

func TestP05CollectorsRegisteredOnce(t *testing.T) {
	// Gọi NewRegistry() hai lần không được panic trùng collector.
	reg1, m1 := obs.NewRegistry()
	reg2, m2 := obs.NewRegistry()
	if m1.Search == nil || m1.Embedding == nil || m2.Search == nil || m2.Embedding == nil {
		t.Fatal("Search và Embedding metrics không được nil")
	}
	if _, err := reg2.Gather(); err != nil {
		t.Fatalf("Gather reg2: %v", err)
	}

	families, err := reg1.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}

	byName := make(map[string]int, len(families))
	for i, f := range families {
		byName[f.GetName()] = i
	}

	// Mọi collector P05 mục 2.21 có tập nhãn hữu hạn phải xuất hiện ngay từ đầu (FS-40/FS-41).
	wantBootNames := []string{
		"suggest_latency_seconds",
		"search_lexical_partial_total",
		"semantic_decisions_total",
		"semantic_query_cache_total",
		"search_vector_path_total",
		"search_vector_underfill_total",
		"embedding_provider_requests_total",
		"embedding_provider_latency_seconds",
		"embedding_breaker_open",
		"embedding_jobs_total",
		"embedding_generation_mismatch_total",
	}
	for _, name := range wantBootNames {
		if _, ok := byName[name]; !ok {
			t.Errorf("registry thiếu metric khởi tạo trước %q", name)
		}
	}

	// Ba gauge DB và hai series canary gắn nhãn generation chưa xuất hiện trước khi đăng ký / ghi mẫu.
	for _, absent := range []string{
		"embedding_job_lag_seconds",
		"embedding_dead_letter_jobs",
		"embedding_generation_coverage_ratio",
		"embedding_canary_min_cos",
		"embedding_canary_drift_total",
	} {
		if _, ok := byName[absent]; ok {
			t.Errorf("metric %q không nên xuất hiện trước khi đăng ký gauge / ghi mẫu generation", absent)
		}
	}

	// Spot-check các child đã khởi tạo trước:
	// 18 cặp kind × outcome của embedding_jobs_total (2 × 9).
	if idx, ok := byName["embedding_jobs_total"]; ok {
		got := len(families[idx].GetMetric())
		if got != 18 {
			t.Errorf("embedding_jobs_total có %d series, muốn 18 (2 kind × 9 outcome)", got)
		}
	}
	// 6 lý do của semantic_decisions_total (5 SemanticReason + "ran").
	if idx, ok := byName["semantic_decisions_total"]; ok {
		got := len(families[idx].GetMetric())
		if got != 6 {
			t.Errorf("semantic_decisions_total có %d series, muốn 6", got)
		}
	}
	// 8 cặp corpus × path của search_vector_path_total (2 × 4).
	if idx, ok := byName["search_vector_path_total"]; ok {
		got := len(families[idx].GetMetric())
		if got != 8 {
			t.Errorf("search_vector_path_total có %d series, muốn 8 (2 corpus × 4 path)", got)
		}
	}
	// suggest_latency_seconds có đủ 18 tổ hợp (3 mode × 3 scope × 2 semantic) và chứa bucket 0.04, 0.35.
	if idx, ok := byName["suggest_latency_seconds"]; ok {
		metrics := families[idx].GetMetric()
		if len(metrics) != 18 {
			t.Errorf("suggest_latency_seconds có %d series, muốn 18 (3×3×2)", len(metrics))
		}
		if len(metrics) > 0 {
			var bounds []float64
			for _, b := range metrics[0].GetHistogram().GetBucket() {
				bounds = append(bounds, b.GetUpperBound())
			}
			if !slices.Contains(bounds, 0.04) || !slices.Contains(bounds, 0.35) {
				t.Errorf("suggest_latency_seconds thiếu bucket 0.04 hoặc 0.35: %v", bounds)
			}
		}
	}

	// Khi ghi mẫu canary theo generation, hai series canary xuất hiện.
	m1.Embedding.CanaryMinCos.WithLabelValues("1").Set(0.995)
	m1.Embedding.CanaryDriftTotal.WithLabelValues("1").Inc()

	// RegisterGauges với GaugeSource giả: đăng ký đủ 3 gauge DB, gọi lần hai trả lỗi (không panic — FS-28).
	fakeSrc := &fakeGaugeSource{
		lags: []obs.JobLagSample{
			{Corpus: "item", Role: "active", Seconds: 1.5},
			{Corpus: "tag", Role: "pending", Seconds: 3.25},
		},
		dead: 2,
		covs: []obs.GenerationCoverageSample{
			{Generation: "1", Corpus: "item", Ratio: 0.99},
			{Generation: "1", Corpus: "tag", Ratio: 1.0},
		},
	}
	if err := obs.RegisterGauges(reg1, fakeSrc); err != nil {
		t.Fatalf("RegisterGauges lần đầu: %v", err)
	}
	if err := obs.RegisterGauges(reg1, fakeSrc); err == nil {
		t.Fatal("RegisterGauges lần hai trên cùng registry phải trả lỗi (FS-28)")
	}

	familiesAfter, err := reg1.Gather()
	if err != nil {
		t.Fatalf("Gather sau RegisterGauges: %v", err)
	}
	afterByName := make(map[string]int, len(familiesAfter))
	for i, f := range familiesAfter {
		afterByName[f.GetName()] = i
	}
	for _, name := range []string{
		"embedding_job_lag_seconds",
		"embedding_dead_letter_jobs",
		"embedding_generation_coverage_ratio",
		"embedding_canary_min_cos",
		"embedding_canary_drift_total",
	} {
		if _, ok := afterByName[name]; !ok {
			t.Errorf("sau RegisterGauges + canary thiếu metric %q", name)
		}
	}
	if idx, ok := afterByName["embedding_dead_letter_jobs"]; ok {
		got := familiesAfter[idx].GetMetric()[0].GetGauge().GetValue()
		if got != 2 {
			t.Errorf("embedding_dead_letter_jobs = %v, muốn 2", got)
		}
	}
}

func TestMetricsHaveNoUserOrQueryLabels(t *testing.T) {
	reg, m := obs.NewRegistry()
	m.Embedding.CanaryMinCos.WithLabelValues("1").Set(0.999)
	m.Embedding.CanaryDriftTotal.WithLabelValues("1").Add(0)
	err := obs.RegisterGauges(reg, &fakeGaugeSource{
		lags: []obs.JobLagSample{{Corpus: "item", Role: "active", Seconds: 0}},
		dead: 0,
		covs: []obs.GenerationCoverageSample{{Generation: "1", Corpus: "item", Ratio: 1}},
	})
	if err != nil {
		t.Fatalf("RegisterGauges: %v", err)
	}

	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}

	allowedLabels := map[string]bool{
		"mode":       true,
		"scope":      true,
		"semantic":   true,
		"corpus":     true,
		"reason":     true,
		"result":     true,
		"path":       true,
		"provider":   true,
		"op":         true,
		"outcome":    true,
		"process":    true,
		"kind":       true,
		"role":       true,
		"generation": true,
	}
	p05Families := map[string]bool{
		"suggest_latency_seconds":             true,
		"search_lexical_partial_total":        true,
		"semantic_decisions_total":            true,
		"semantic_query_cache_total":          true,
		"search_vector_path_total":            true,
		"search_vector_underfill_total":       true,
		"embedding_provider_requests_total":   true,
		"embedding_provider_latency_seconds":  true,
		"embedding_breaker_open":              true,
		"embedding_job_lag_seconds":           true,
		"embedding_jobs_total":                true,
		"embedding_dead_letter_jobs":          true,
		"embedding_generation_mismatch_total": true,
		"embedding_canary_min_cos":            true,
		"embedding_canary_drift_total":        true,
		"embedding_generation_coverage_ratio": true,
	}

	seen := 0
	for _, f := range families {
		if !p05Families[f.GetName()] {
			continue
		}
		seen++
		for _, metric := range f.GetMetric() {
			for _, lp := range metric.GetLabel() {
				if !allowedLabels[lp.GetName()] {
					t.Errorf("metric %s chứa nhãn ngoài allowlist: %q", f.GetName(), lp.GetName())
				}
			}
		}
	}
	if seen != len(p05Families) {
		t.Errorf("đã kiểm %d/%d family P05", seen, len(p05Families))
	}
}
