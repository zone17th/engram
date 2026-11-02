package obs

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// ProviderLatencyBuckets bao phủ dải 5 ms .. 30 s cho thời gian gọi provider
// nhúng (từ TEI nội bộ ~300 ms tới batch document openai_compat tối đa 30 s,
// plan P05 mục 2.13, 2.21).
var ProviderLatencyBuckets = []float64{
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.3, 0.5, 1, 2.5, 4, 5, 10, 20, 30,
}

// Tập giá trị nhãn hữu hạn cho embedding metrics (SPEC §10.3, plan P05 mục 2.21).
//
// Quyết định giá trị nhãn cho các trường SPEC để mở (lead-embedprov P05-T5):
//   - embedding_provider_*{provider} ∈ {"openai_compat", "tei"}.
//   - embedding_provider_*{op} ∈ {"query", "document"}.
//   - embedding_breaker_open{process} ∈ {"api", "worker"}.
//   - embedding_jobs_total{kind} ∈ {"embed_item", "embed_tag"} (River job kinds,
//     SPEC §8/§10.3).
//   - Nhãn generation trên canary_* không khởi tạo trước vì tập giá trị không
//     bị chặn tĩnh (chỉ xuất hiện khi có generation).
var (
	EmbeddingProviders = []string{"openai_compat", "tei"}

	EmbeddingOps = []string{"query", "document"}

	ProviderOutcomes = []string{
		"ok",
		"timeout",
		"http_5xx",
		"http_429",
		"refused",
		"bad_response",
	}

	BreakerProcesses = []string{"api", "worker"}

	EmbeddingJobKinds = []string{"embed_item", "embed_tag"}

	JobOutcomes = []string{
		"upserted",
		"skipped_stale",
		"skipped_fresh",
		"skipped_deleted",
		"skipped_user_off",
		"discarded_generation",
		"snoozed",
		"retry",
		"dead",
	}

	MismatchReasons = []string{
		"dims",
		"model",
		"hash",
		"unconfigured",
	}

	GenerationRoles = []string{"active", "pending", "retired"}
)

// EmbeddingMetrics gom các collector Prometheus của tầng provider và worker
// nhúng (plan P05 mục 2.21). Ba gauge phụ thuộc truy vấn DB được đăng ký riêng
// qua RegisterGauges.
type EmbeddingMetrics struct {
	ProviderRequestsTotal   *prometheus.CounterVec
	ProviderLatency         *prometheus.HistogramVec
	BreakerOpen             *prometheus.GaugeVec
	JobsTotal               *prometheus.CounterVec
	GenerationMismatchTotal *prometheus.CounterVec
	CanaryMinCos            *prometheus.GaugeVec
	CanaryDriftTotal        *prometheus.CounterVec
}

func newEmbeddingMetrics() *EmbeddingMetrics {
	buckets := make([]float64, len(ProviderLatencyBuckets))
	copy(buckets, ProviderLatencyBuckets)

	m := &EmbeddingMetrics{
		ProviderRequestsTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "embedding_provider_requests_total",
			Help: "Tổng số lời gọi tới provider nhúng theo provider, thao tác (query/document) và kết quả.",
		}, []string{"provider", "op", "outcome"}),
		ProviderLatency: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "embedding_provider_latency_seconds",
			Help:    "Thời gian phản hồi của provider nhúng theo provider và thao tác (5 ms .. 30 s).",
			Buckets: buckets,
		}, []string{"provider", "op"}),
		BreakerOpen: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "embedding_breaker_open",
			Help: "Trạng thái mở của circuit breaker nhúng theo provider và tiến trình (0 = đóng, 1 = mở).",
		}, []string{"provider", "process"}),
		JobsTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "embedding_jobs_total",
			Help: "Tổng số job nhúng đã xử lý theo loại job (embed_item/embed_tag) và kết quả (outcome).",
		}, []string{"kind", "outcome"}),
		GenerationMismatchTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "embedding_generation_mismatch_total",
			Help: "Tổng số lần phát hiện lệch generation nhúng theo nguyên nhân (dims, model, hash, unconfigured).",
		}, []string{"reason"}),
		CanaryMinCos: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "embedding_canary_min_cos",
			Help: "Cosine similarity nhỏ nhất trên tập canary của từng generation.",
		}, []string{"generation"}),
		CanaryDriftTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "embedding_canary_drift_total",
			Help: "Tổng số lần kiểm tra canary phát hiện độ tương đồng thấp hơn ngưỡng theo generation.",
		}, []string{"generation"}),
	}

	// Khởi tạo trước toàn bộ tích Descartes của các tập nhãn hữu hạn (FS-40/FS-41).
	// CanaryMinCos và CanaryDriftTotal mang nhãn generation động nên không khởi tạo trước.
	for _, provider := range EmbeddingProviders {
		for _, op := range EmbeddingOps {
			m.ProviderLatency.WithLabelValues(provider, op)
			for _, outcome := range ProviderOutcomes {
				m.ProviderRequestsTotal.WithLabelValues(provider, op, outcome)
			}
		}
		for _, proc := range BreakerProcesses {
			m.BreakerOpen.WithLabelValues(provider, proc)
		}
	}
	for _, kind := range EmbeddingJobKinds {
		for _, outcome := range JobOutcomes {
			m.JobsTotal.WithLabelValues(kind, outcome)
		}
	}
	for _, reason := range MismatchReasons {
		m.GenerationMismatchTotal.WithLabelValues(reason)
	}

	return m
}

func (m *EmbeddingMetrics) collectors() []prometheus.Collector {
	return []prometheus.Collector{
		m.ProviderRequestsTotal,
		m.ProviderLatency,
		m.BreakerOpen,
		m.JobsTotal,
		m.GenerationMismatchTotal,
		m.CanaryMinCos,
		m.CanaryDriftTotal,
	}
}

// JobLagSample là một mẫu độ trễ hàng đợi job nhúng (giây) theo corpus và vai trò generation.
type JobLagSample struct {
	Corpus  string  // "item" | "tag"
	Role    string  // "active" | "pending" | "retired"
	Seconds float64 // >= 0
}

// GenerationCoverageSample là một mẫu tỉ lệ bao phủ vector (0..1) của một generation trên một corpus.
type GenerationCoverageSample struct {
	Generation string  // ví dụ "1" hoặc "g1"
	Corpus     string  // "item" | "tag"
	Ratio      float64 // 0..1
}

// GaugeSource cung cấp giá trị tại thời điểm scrape cho ba gauge DB của P05
// (`embedding_job_lag_seconds`, `embedding_dead_letter_jobs`,
// `embedding_generation_coverage_ratio`). Task 20a cài đặt nguồn dữ liệu DB có
// cache 15 s; package obs không import pgx hay db (plan P05 mục 2.21, FS-28).
type GaugeSource interface {
	JobLag(ctx context.Context) ([]JobLagSample, error)
	DeadLetterJobs(ctx context.Context) (float64, error)
	Coverage(ctx context.Context) ([]GenerationCoverageSample, error)
}

// GaugeCollectTimeout là thời gian tối đa cho một lần đọc GaugeSource trong
// Collect (do prometheus.Collector.Collect không nhận context).
const GaugeCollectTimeout = 5 * time.Second

var (
	jobLagDesc = prometheus.NewDesc(
		"embedding_job_lag_seconds",
		"Độ trễ lớn nhất của job nhúng đang chờ theo corpus và vai trò generation (giây).",
		[]string{"corpus", "role"},
		nil,
	)
	deadLetterJobsDesc = prometheus.NewDesc(
		"embedding_dead_letter_jobs",
		"Số lượng job nhúng ở trạng thái dead-letter (discarded).",
		nil,
		nil,
	)
	generationCoverageDesc = prometheus.NewDesc(
		"embedding_generation_coverage_ratio",
		"Tỉ lệ mục/tag sống đã có vector hợp lệ theo generation và corpus (0..1).",
		[]string{"generation", "corpus"},
		nil,
	)
)

// RegisterGauges đăng ký ba gauge DB (`embedding_job_lag_seconds`,
// `embedding_dead_letter_jobs`, `embedding_generation_coverage_ratio`) vào reg
// đúng một lần. Gọi lần thứ hai trên cùng registry trả về lỗi (không panic — FS-28).
//
// Khi scrape, collector gọi src với context.WithTimeout(context.Background(), GaugeCollectTimeout).
// Nếu một phương thức của src trả lỗi, series đó được bỏ qua để không làm hỏng
// toàn bộ lần scrape `/metrics`.
func RegisterGauges(reg prometheus.Registerer, src GaugeSource) error {
	if reg == nil {
		return errors.New("obs: nil prometheus registerer")
	}
	if src == nil {
		return errors.New("obs: nil embedding gauge source")
	}
	c := &embeddingGaugesCollector{src: src}
	if err := reg.Register(c); err != nil {
		return fmt.Errorf("obs: register embedding gauges: %w", err)
	}
	return nil
}

type embeddingGaugesCollector struct {
	src GaugeSource
}

func (c *embeddingGaugesCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- jobLagDesc
	ch <- deadLetterJobsDesc
	ch <- generationCoverageDesc
}

func (c *embeddingGaugesCollector) Collect(ch chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), GaugeCollectTimeout)
	defer cancel()

	if lags, err := c.src.JobLag(ctx); err == nil {
		for _, s := range lags {
			if m, err := prometheus.NewConstMetric(jobLagDesc, prometheus.GaugeValue, s.Seconds, s.Corpus, s.Role); err == nil {
				ch <- m
			}
		}
	}

	if dead, err := c.src.DeadLetterJobs(ctx); err == nil {
		if m, err := prometheus.NewConstMetric(deadLetterJobsDesc, prometheus.GaugeValue, dead); err == nil {
			ch <- m
		}
	}

	if covs, err := c.src.Coverage(ctx); err == nil {
		for _, s := range covs {
			if m, err := prometheus.NewConstMetric(generationCoverageDesc, prometheus.GaugeValue, s.Ratio, s.Generation, s.Corpus); err == nil {
				ch <- m
			}
		}
	}
}
