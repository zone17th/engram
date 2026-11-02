package obs

import "github.com/prometheus/client_golang/prometheus"

// Buckets thời gian phản hồi `/suggest` (giây): giữ toàn bộ bucket HTTP hiện có
// và bổ sung 0.04 s (target lexical C1-L 40 ms) cùng 0.35 s (target hybrid miss
// C1-M 350 ms) theo SPEC §10.3 và plan P05 mục 2.21, 2.23.
var SuggestLatencyBuckets = []float64{
	0.005, 0.01, 0.025, 0.04, 0.05, 0.1, 0.25, 0.35, 0.5, 1, 2.5, 5,
}

// Tập giá trị nhãn hữu hạn cho search metrics (SPEC §10.3, plan P05 mục 2.21).
// Các biến slice dưới đây được export để các producer (suggest, semantic, store)
// dùng chung mà không lệch tên nhãn.
//
// Quyết định giá trị nhãn cho các trường SPEC để mở (lead-embedprov P05-T5):
//   - suggest_latency_seconds{semantic} ∈ {"true", "false"} (strconv.FormatBool
//     của trường response semantic).
//   - semantic_decisions_total{reason} ∈ 5 giá trị SemanticReason
//     ("disabled_server", "disabled_user", "degraded", "request_lexical",
//     "short_query") cộng thêm "ran" khi nhánh semantic thực sự chạy.
//   - semantic_query_cache_total{result} ∈ {"hit", "miss"}.
var (
	SuggestModes = []string{"recent", "prefix", "full"}

	SuggestScopes = []string{"all", "item", "tag"}

	SuggestSemanticValues = []string{"true", "false"}

	Corpora = []string{"item", "tag"}

	SemanticDecisionReasons = []string{
		"disabled_server",
		"disabled_user",
		"degraded",
		"request_lexical",
		"short_query",
		"ran",
	}

	SemanticCacheResults = []string{"hit", "miss"}

	VectorPaths = []string{
		"exact",
		"ann",
		"ann_fallback_exact",
		"ann_short",
	}
)

// SearchMetrics gom các collector Prometheus của đường tìm kiếm lexical và
// semantic (plan P05 mục 2.21). Không nhãn nào mang user_id, q hay tên mục/tag.
type SearchMetrics struct {
	SuggestLatency          *prometheus.HistogramVec
	LexicalPartialTotal     *prometheus.CounterVec
	SemanticDecisionsTotal  *prometheus.CounterVec
	SemanticQueryCacheTotal *prometheus.CounterVec
	VectorPathTotal         *prometheus.CounterVec
	VectorUnderfillTotal    *prometheus.CounterVec
}

func newSearchMetrics() *SearchMetrics {
	buckets := make([]float64, len(SuggestLatencyBuckets))
	copy(buckets, SuggestLatencyBuckets)

	m := &SearchMetrics{
		SuggestLatency: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "suggest_latency_seconds",
			Help:    "Thời gian xử lý gợi ý /suggest theo mode, scope và trạng thái semantic (không chứa user_id hay q).",
			Buckets: buckets,
		}, []string{"mode", "scope", "semantic"}),
		LexicalPartialTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "search_lexical_partial_total",
			Help: "Tổng số lần nhánh lexical bị cắt một phần do hết ngân sách thời gian theo corpus (item hoặc tag).",
		}, []string{"corpus"}),
		SemanticDecisionsTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "semantic_decisions_total",
			Help: "Tổng số quyết định chạy hoặc bỏ qua nhánh tìm gần nghĩa theo lý do (reason).",
		}, []string{"reason"}),
		SemanticQueryCacheTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "semantic_query_cache_total",
			Help: "Tổng số lần tra cache vector truy vấn semantic theo kết quả (hit hoặc miss).",
		}, []string{"result"}),
		VectorPathTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "search_vector_path_total",
			Help: "Tổng số truy vấn vector theo corpus và đường thực thi (exact, ann, ann_fallback_exact, ann_short).",
		}, []string{"corpus", "path"}),
		VectorUnderfillTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "search_vector_underfill_total",
			Help: "Tổng số lần truy vấn ANN trả ít ứng viên hơn kỳ vọng (underfill) theo corpus.",
		}, []string{"corpus"}),
	}

	// Khởi tạo trước toàn bộ tích Descartes của các tập nhãn hữu hạn để /metrics
	// xuất hiện đầy đủ tên metric ngay từ khi khởi động (FS-40/FS-41).
	for _, mode := range SuggestModes {
		for _, scope := range SuggestScopes {
			for _, sem := range SuggestSemanticValues {
				m.SuggestLatency.WithLabelValues(mode, scope, sem)
			}
		}
	}
	for _, corpus := range Corpora {
		m.LexicalPartialTotal.WithLabelValues(corpus)
		m.VectorUnderfillTotal.WithLabelValues(corpus)
		for _, path := range VectorPaths {
			m.VectorPathTotal.WithLabelValues(corpus, path)
		}
	}
	for _, reason := range SemanticDecisionReasons {
		m.SemanticDecisionsTotal.WithLabelValues(reason)
	}
	for _, res := range SemanticCacheResults {
		m.SemanticQueryCacheTotal.WithLabelValues(res)
	}

	return m
}

func (m *SearchMetrics) collectors() []prometheus.Collector {
	return []prometheus.Collector{
		m.SuggestLatency,
		m.LexicalPartialTotal,
		m.SemanticDecisionsTotal,
		m.SemanticQueryCacheTotal,
		m.VectorPathTotal,
		m.VectorUnderfillTotal,
	}
}
