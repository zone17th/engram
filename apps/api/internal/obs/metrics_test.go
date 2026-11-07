package obs_test

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

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
	lags    []obs.JobLagSample
	dead    float64
	covs    []obs.GenerationCoverageSample
	lagErr  error
	deadErr error
	covErr  error

	lagCalls  int
	deadCalls int
	covCalls  int

	lagHasDeadline  bool
	deadHasDeadline bool
	covHasDeadline  bool

	lagCtxErr  error
	deadCtxErr error
	covCtxErr  error
}

func (f *fakeGaugeSource) JobLag(ctx context.Context) ([]obs.JobLagSample, error) {
	f.lagCalls++
	_, f.lagHasDeadline = ctx.Deadline()
	f.lagCtxErr = ctx.Err()
	if f.lagErr != nil {
		return nil, f.lagErr
	}
	return f.lags, nil
}

func (f *fakeGaugeSource) DeadLetterJobs(ctx context.Context) (float64, error) {
	f.deadCalls++
	_, f.deadHasDeadline = ctx.Deadline()
	f.deadCtxErr = ctx.Err()
	if f.deadErr != nil {
		return 0, f.deadErr
	}
	return f.dead, nil
}

func (f *fakeGaugeSource) Coverage(ctx context.Context) ([]obs.GenerationCoverageSample, error) {
	f.covCalls++
	_, f.covHasDeadline = ctx.Deadline()
	f.covCtxErr = ctx.Err()
	if f.covErr != nil {
		return nil, f.covErr
	}
	return f.covs, nil
}

// cartesianTuples xây dựng toàn bộ tích Descartes của các chiều nhãn literal,
// trả về tập chuỗi tuple theo thứ tự khoá đã khai báo (ngăn cách bằng "|").
func cartesianTuples(dims ...[]string) map[string]bool {
	if len(dims) == 0 {
		return map[string]bool{"": true}
	}
	cur := []string{""}
	for i, dim := range dims {
		next := make([]string, 0, len(cur)*len(dim))
		for _, prefix := range cur {
			for _, val := range dim {
				if i == 0 {
					next = append(next, val)
				} else {
					next = append(next, prefix+"|"+val)
				}
			}
		}
		cur = next
	}
	out := make(map[string]bool, len(cur))
	for _, t := range cur {
		out[t] = true
	}
	return out
}

// assertFamilyExactLabelSet kiểm tra tập khoá nhãn chính xác trên mọi series
// của family và tập bộ giá trị nhãn (tuple) khớp 1-1 với wantTuples.
func assertFamilyExactLabelSet(t *testing.T, f *dto.MetricFamily, wantKeys []string, wantTuples map[string]bool) {
	t.Helper()
	if f == nil {
		t.Fatalf("metric family nil (wantKeys=%v)", wantKeys)
	}
	name := f.GetName()
	metrics := f.GetMetric()
	if len(metrics) != len(wantTuples) {
		t.Errorf("%s có %d series, muốn %d", name, len(metrics), len(wantTuples))
	}
	gotTuples := make(map[string]bool, len(metrics))
	for _, m := range metrics {
		labels := m.GetLabel()
		if len(labels) != len(wantKeys) {
			t.Errorf("%s series có %d nhãn %v, muốn %d nhãn %v", name, len(labels), labels, len(wantKeys), wantKeys)
			continue
		}
		byKey := make(map[string]string, len(labels))
		for _, lp := range labels {
			byKey[lp.GetName()] = lp.GetValue()
		}
		parts := make([]string, len(wantKeys))
		keysOK := true
		for i, k := range wantKeys {
			v, ok := byKey[k]
			if !ok {
				t.Errorf("%s thiếu khoá nhãn %q trong series %v", name, k, labels)
				keysOK = false
				break
			}
			parts[i] = v
		}
		if !keysOK {
			continue
		}
		tuple := strings.Join(parts, "|")
		if gotTuples[tuple] {
			t.Errorf("%s trùng bộ nhãn %q", name, tuple)
		}
		gotTuples[tuple] = true
		if !wantTuples[tuple] {
			t.Errorf("%s chứa bộ nhãn ngoài hợp đồng %q", name, tuple)
		}
	}
	for want := range wantTuples {
		if !gotTuples[want] {
			t.Errorf("%s thiếu bộ nhãn bắt buộc %q", name, want)
		}
	}
}

func assertGaugeSeriesValues(t *testing.T, f *dto.MetricFamily, wantKeys []string, want map[string]float64) {
	t.Helper()
	wantTuples := make(map[string]bool, len(want))
	for k := range want {
		wantTuples[k] = true
	}
	assertFamilyExactLabelSet(t, f, wantKeys, wantTuples)
	got := make(map[string]float64, len(f.GetMetric()))
	for _, m := range f.GetMetric() {
		byKey := make(map[string]string, len(m.GetLabel()))
		for _, lp := range m.GetLabel() {
			byKey[lp.GetName()] = lp.GetValue()
		}
		parts := make([]string, len(wantKeys))
		for i, k := range wantKeys {
			parts[i] = byKey[k]
		}
		got[strings.Join(parts, "|")] = m.GetGauge().GetValue()
	}
	if !maps.Equal(got, want) {
		t.Errorf("%s gauge values = %v, muốn %v", f.GetName(), got, want)
	}
}

func assertCounterSeriesValues(t *testing.T, f *dto.MetricFamily, wantKeys []string, want map[string]float64) {
	t.Helper()
	wantTuples := make(map[string]bool, len(want))
	for k := range want {
		wantTuples[k] = true
	}
	assertFamilyExactLabelSet(t, f, wantKeys, wantTuples)
	got := make(map[string]float64, len(f.GetMetric()))
	for _, m := range f.GetMetric() {
		byKey := make(map[string]string, len(m.GetLabel()))
		for _, lp := range m.GetLabel() {
			byKey[lp.GetName()] = lp.GetValue()
		}
		parts := make([]string, len(wantKeys))
		for i, k := range wantKeys {
			parts[i] = byKey[k]
		}
		got[strings.Join(parts, "|")] = m.GetCounter().GetValue()
	}
	if !maps.Equal(got, want) {
		t.Errorf("%s counter values = %v, muốn %v", f.GetName(), got, want)
	}
}

// p05FiniteFamilySchemas trả về schema nhãn kỳ vọng dưới dạng literal độc lập
// với các slice export trong package obs (RV51-BE1-1).
func p05FiniteFamilySchemas() map[string]struct {
	keys   []string
	tuples map[string]bool
} {
	return map[string]struct {
		keys   []string
		tuples map[string]bool
	}{
		"suggest_latency_seconds": {
			keys: []string{"mode", "scope", "semantic"},
			tuples: cartesianTuples(
				[]string{"recent", "prefix", "full"},
				[]string{"all", "item", "tag"},
				[]string{"true", "false"},
			),
		},
		"search_lexical_partial_total": {
			keys:   []string{"corpus"},
			tuples: cartesianTuples([]string{"item", "tag"}),
		},
		"semantic_decisions_total": {
			keys: []string{"reason"},
			tuples: cartesianTuples([]string{
				"disabled_server",
				"disabled_user",
				"degraded",
				"request_lexical",
				"short_query",
				"ran",
			}),
		},
		"semantic_query_cache_total": {
			keys:   []string{"result"},
			tuples: cartesianTuples([]string{"hit", "miss"}),
		},
		"search_vector_path_total": {
			keys: []string{"corpus", "path"},
			tuples: cartesianTuples(
				[]string{"item", "tag"},
				[]string{"exact", "ann", "ann_fallback_exact", "ann_short"},
			),
		},
		"search_vector_underfill_total": {
			keys:   []string{"corpus"},
			tuples: cartesianTuples([]string{"item", "tag"}),
		},
		"embedding_provider_requests_total": {
			keys: []string{"provider", "op", "outcome"},
			tuples: cartesianTuples(
				[]string{"openai_compat", "tei"},
				[]string{"query", "document"},
				[]string{"ok", "timeout", "http_5xx", "http_429", "refused", "bad_response"},
			),
		},
		"embedding_provider_latency_seconds": {
			keys: []string{"provider", "op"},
			tuples: cartesianTuples(
				[]string{"openai_compat", "tei"},
				[]string{"query", "document"},
			),
		},
		"embedding_breaker_open": {
			keys: []string{"provider", "process"},
			tuples: cartesianTuples(
				[]string{"openai_compat", "tei"},
				[]string{"api", "worker"},
			),
		},
		"embedding_jobs_total": {
			keys: []string{"kind", "outcome"},
			tuples: cartesianTuples(
				[]string{"embed_item", "embed_tag"},
				[]string{
					"upserted",
					"skipped_stale",
					"skipped_fresh",
					"skipped_deleted",
					"skipped_user_off",
					"discarded_generation",
					"snoozed",
					"retry",
					"dead",
				},
			),
		},
		"embedding_generation_mismatch_total": {
			keys: []string{"reason"},
			tuples: cartesianTuples([]string{
				"dims",
				"model",
				"hash",
				"unconfigured",
			}),
		},
	}
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

	byName := make(map[string]*dto.MetricFamily, len(families))
	for _, f := range families {
		byName[f.GetName()] = f
	}

	// Mọi collector P05 mục 2.21 có tập nhãn hữu hạn phải xuất hiện ngay từ đầu
	// với đúng tập khoá nhãn và toàn bộ tích Descartes literal (FS-40/FS-41, RV51-BE1-1).
	finiteSchemas := p05FiniteFamilySchemas()
	for name, schema := range finiteSchemas {
		f, ok := byName[name]
		if !ok {
			t.Errorf("registry thiếu metric khởi tạo trước %q", name)
			continue
		}
		assertFamilyExactLabelSet(t, f, schema.keys, schema.tuples)
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

	// suggest_latency_seconds chứa đầy đủ 12 bucket chuẩn gồm 0.04 và 0.35.
	if f, ok := byName["suggest_latency_seconds"]; ok && len(f.GetMetric()) > 0 {
		var bounds []float64
		for _, b := range f.GetMetric()[0].GetHistogram().GetBucket() {
			bounds = append(bounds, b.GetUpperBound())
		}
		wantBounds := []float64{0.005, 0.01, 0.025, 0.04, 0.05, 0.1, 0.25, 0.35, 0.5, 1, 2.5, 5}
		if !slices.Equal(bounds, wantBounds) {
			t.Errorf("suggest_latency_seconds buckets = %v, muốn %v", bounds, wantBounds)
		}
	}

	// embedding_provider_latency_seconds chứa đầy đủ 15 bucket 5 ms .. 30 s.
	if f, ok := byName["embedding_provider_latency_seconds"]; ok && len(f.GetMetric()) > 0 {
		var bounds []float64
		for _, b := range f.GetMetric()[0].GetHistogram().GetBucket() {
			bounds = append(bounds, b.GetUpperBound())
		}
		wantBounds := []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.3, 0.5, 1, 2.5, 4, 5, 10, 20, 30}
		if !slices.Equal(bounds, wantBounds) {
			t.Errorf("embedding_provider_latency_seconds buckets = %v, muốn %v", bounds, wantBounds)
		}
	}

	// Khi ghi mẫu canary theo generation, hai series canary xuất hiện với đúng nhãn và giá trị.
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
	afterByName := make(map[string]*dto.MetricFamily, len(familiesAfter))
	for _, f := range familiesAfter {
		afterByName[f.GetName()] = f
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

	// Kiểm chính xác bộ nhãn, số lượng series và giá trị số cho cả 3 gauge DB và 2 canary (RV51-BE1-2).
	if f, ok := afterByName["embedding_job_lag_seconds"]; ok {
		assertGaugeSeriesValues(t, f, []string{"corpus", "role"}, map[string]float64{
			"item|active": 1.5,
			"tag|pending": 3.25,
		})
	}
	if f, ok := afterByName["embedding_dead_letter_jobs"]; ok {
		assertGaugeSeriesValues(t, f, nil, map[string]float64{
			"": 2,
		})
	}
	if f, ok := afterByName["embedding_generation_coverage_ratio"]; ok {
		assertGaugeSeriesValues(t, f, []string{"generation", "corpus"}, map[string]float64{
			"1|item": 0.99,
			"1|tag":  1.0,
		})
	}
	if f, ok := afterByName["embedding_canary_min_cos"]; ok {
		assertGaugeSeriesValues(t, f, []string{"generation"}, map[string]float64{
			"1": 0.995,
		})
	}
	if f, ok := afterByName["embedding_canary_drift_total"]; ok {
		assertCounterSeriesValues(t, f, []string{"generation"}, map[string]float64{
			"1": 1,
		})
	}
}

func TestRegisterGaugesSkipsErroredFamilyAndPassesBoundedContext(t *testing.T) {
	cases := []struct {
		name     string
		lagErr   error
		deadErr  error
		covErr   error
		wantLag  bool
		wantDead bool
		wantCov  bool
	}{
		{
			name:     "job_lag_error_only",
			lagErr:   errors.New("db job lag failed"),
			wantLag:  false,
			wantDead: true,
			wantCov:  true,
		},
		{
			name:     "dead_letter_error_only",
			deadErr:  errors.New("db dead letter failed"),
			wantLag:  true,
			wantDead: false,
			wantCov:  true,
		},
		{
			name:     "coverage_error_only",
			covErr:   errors.New("db coverage failed"),
			wantLag:  true,
			wantDead: true,
			wantCov:  false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reg, _ := obs.NewRegistry()
			src := &fakeGaugeSource{
				lags: []obs.JobLagSample{
					{Corpus: "item", Role: "active", Seconds: 2.0},
					{Corpus: "tag", Role: "retired", Seconds: 4.5},
				},
				dead: 5,
				covs: []obs.GenerationCoverageSample{
					{Generation: "1", Corpus: "item", Ratio: 0.95},
				},
				lagErr:  tc.lagErr,
				deadErr: tc.deadErr,
				covErr:  tc.covErr,
			}
			if err := obs.RegisterGauges(reg, src); err != nil {
				t.Fatalf("RegisterGauges: %v", err)
			}

			families, err := reg.Gather()
			if err != nil {
				t.Fatalf("Gather không được trả lỗi khi một phương thức GaugeSource lỗi: %v", err)
			}

			if src.lagCalls != 1 || src.deadCalls != 1 || src.covCalls != 1 {
				t.Errorf("số lần gọi GaugeSource = (%d, %d, %d), muốn (1, 1, 1)", src.lagCalls, src.deadCalls, src.covCalls)
			}
			if !src.lagHasDeadline || !src.deadHasDeadline || !src.covHasDeadline {
				t.Errorf("context truyền vào GaugeSource thiếu deadline: lag=%v dead=%v cov=%v", src.lagHasDeadline, src.deadHasDeadline, src.covHasDeadline)
			}
			if src.lagCtxErr != nil || src.deadCtxErr != nil || src.covCtxErr != nil {
				t.Errorf("context truyền vào GaugeSource đã hết hạn sớm: lag=%v dead=%v cov=%v", src.lagCtxErr, src.deadCtxErr, src.covCtxErr)
			}

			byName := make(map[string]*dto.MetricFamily, len(families))
			for _, f := range families {
				byName[f.GetName()] = f
			}

			if f, ok := byName["embedding_job_lag_seconds"]; ok != tc.wantLag {
				t.Errorf("embedding_job_lag_seconds present = %v, muốn %v", ok, tc.wantLag)
			} else if ok {
				assertGaugeSeriesValues(t, f, []string{"corpus", "role"}, map[string]float64{
					"item|active": 2.0,
					"tag|retired": 4.5,
				})
			}

			if f, ok := byName["embedding_dead_letter_jobs"]; ok != tc.wantDead {
				t.Errorf("embedding_dead_letter_jobs present = %v, muốn %v", ok, tc.wantDead)
			} else if ok {
				assertGaugeSeriesValues(t, f, nil, map[string]float64{
					"": 5,
				})
			}

			if f, ok := byName["embedding_generation_coverage_ratio"]; ok != tc.wantCov {
				t.Errorf("embedding_generation_coverage_ratio present = %v, muốn %v", ok, tc.wantCov)
			} else if ok {
				assertGaugeSeriesValues(t, f, []string{"generation", "corpus"}, map[string]float64{
					"1|item": 0.95,
				})
			}
		})
	}
}

func TestMetricsHaveNoUserOrQueryLabels(t *testing.T) {
	reg, m := obs.NewRegistry()
	m.Embedding.CanaryMinCos.WithLabelValues("1").Set(0.999)
	m.Embedding.CanaryDriftTotal.WithLabelValues("1").Add(0)
	err := obs.RegisterGauges(reg, &fakeGaugeSource{
		lags: []obs.JobLagSample{
			{Corpus: "item", Role: "active", Seconds: 0},
			{Corpus: "item", Role: "pending", Seconds: 0},
			{Corpus: "item", Role: "retired", Seconds: 0},
			{Corpus: "tag", Role: "active", Seconds: 0},
			{Corpus: "tag", Role: "pending", Seconds: 0},
			{Corpus: "tag", Role: "retired", Seconds: 0},
		},
		dead: 0,
		covs: []obs.GenerationCoverageSample{
			{Generation: "1", Corpus: "item", Ratio: 1},
			{Generation: "1", Corpus: "tag", Ratio: 1},
		},
	})
	if err != nil {
		t.Fatalf("RegisterGauges: %v", err)
	}
	if err := obs.RegisterExportCleanupGauge(reg, &fakeAgeQuerier{row: fakeAgeRow{age: 0}}); err != nil {
		t.Fatalf("RegisterExportCleanupGauge: %v", err)
	}
	// Producer gọi nhầm với dữ liệu người dùng không được sinh series mới.
	m.Export.ObserveJob("user@example.com", "ready", 0)
	m.Export.ObserveJob("encrypted", "0b7a4c1e-0000-4000-8000-000000000000", 0)
	m.Export.IncDecryptedAudit("/var/lib/engram-exports/x.sabk.enc")
	m.Export.IncAccountDeletion("user@example.com")

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

	expectedSchemas := p05FiniteFamilySchemas()
	expectedSchemas["embedding_job_lag_seconds"] = struct {
		keys   []string
		tuples map[string]bool
	}{
		keys: []string{"corpus", "role"},
		tuples: cartesianTuples(
			[]string{"item", "tag"},
			[]string{"active", "pending", "retired"},
		),
	}
	expectedSchemas["embedding_dead_letter_jobs"] = struct {
		keys   []string
		tuples map[string]bool
	}{
		keys:   nil,
		tuples: cartesianTuples(),
	}
	expectedSchemas["embedding_generation_coverage_ratio"] = struct {
		keys   []string
		tuples map[string]bool
	}{
		keys: []string{"generation", "corpus"},
		tuples: cartesianTuples(
			[]string{"1"},
			[]string{"item", "tag"},
		),
	}
	expectedSchemas["embedding_canary_min_cos"] = struct {
		keys   []string
		tuples map[string]bool
	}{
		keys:   []string{"generation"},
		tuples: cartesianTuples([]string{"1"}),
	}
	expectedSchemas["embedding_canary_drift_total"] = struct {
		keys   []string
		tuples map[string]bool
	}{
		keys:   []string{"generation"},
		tuples: cartesianTuples([]string{"1"}),
	}
	expectedSchemas["export_jobs_total"] = struct {
		keys   []string
		tuples map[string]bool
	}{
		keys:   []string{"kind", "outcome"},
		tuples: cartesianTuples(obs.ExportKinds, obs.ExportJobOutcomes),
	}
	expectedSchemas["export_job_duration_seconds"] = struct {
		keys   []string
		tuples map[string]bool
	}{
		keys:   []string{"kind", "outcome"},
		tuples: cartesianTuples(obs.ExportKinds, obs.ExportJobOutcomes),
	}
	expectedSchemas["export_decrypted_audit_total"] = struct {
		keys   []string
		tuples map[string]bool
	}{
		keys:   []string{"outcome"},
		tuples: cartesianTuples(obs.ExportDecryptedAuditOutcomes),
	}
	expectedSchemas["account_deletions_total"] = struct {
		keys   []string
		tuples map[string]bool
	}{
		keys:   []string{"outcome"},
		tuples: cartesianTuples(obs.AccountDeletionOutcomes),
	}
	expectedSchemas["export_cleanup_pending_age_seconds"] = struct {
		keys   []string
		tuples map[string]bool
	}{
		keys:   nil,
		tuples: cartesianTuples(),
	}

	seen := 0
	for _, f := range families {
		schema, isP05 := expectedSchemas[f.GetName()]
		if !isP05 {
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
		assertFamilyExactLabelSet(t, f, schema.keys, schema.tuples)
	}
	if seen != len(expectedSchemas) {
		t.Errorf("đã kiểm %d/%d family P05", seen, len(expectedSchemas))
	}
}
