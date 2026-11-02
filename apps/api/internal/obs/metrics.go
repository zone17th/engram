// Package obs gom logger và metric của API.
package obs

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Metrics là tập metric ứng dụng. Label chỉ được là giá trị có cardinality thấp
// và KHÔNG mang dữ liệu người dùng: route là pattern của chi, không phải raw path.
type Metrics struct {
	RequestDuration          *prometheus.HistogramVec
	VaultRecoverTotal        prometheus.Counter
	VaultUnlockFailuresTotal *prometheus.CounterVec
	EntriesCreatedTotal      *prometheus.CounterVec
}

// NewRegistry tạo registry riêng (không dùng DefaultRegisterer) để test cô lập được.
func NewRegistry() (*prometheus.Registry, *Metrics) {
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)

	m := &Metrics{
		RequestDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "engram_http_request_duration_seconds",
			Help:    "Thời gian xử lý request HTTP theo route pattern.",
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5},
		}, []string{"route", "method", "status"}),
		VaultRecoverTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "vault_recover_total",
			Help: "Tổng số lần hoàn tất khôi phục vault bằng recovery key thành công.",
		}),
		VaultUnlockFailuresTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "vault_unlock_failures_total",
			Help: "Tổng số lần mở khoá vault thất bại mà server quan sát được theo phương thức (không chứa user_id).",
		}, []string{"method"}),
		EntriesCreatedTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "entries_created_total",
			Help: "Tổng số entry đã tạo thành công theo kiểu nội dung (text hoặc json; không chứa dữ liệu người dùng).",
		}, []string{"type"}),
	}
	reg.MustRegister(m.RequestDuration, m.VaultRecoverTotal, m.VaultUnlockFailuresTotal, m.EntriesCreatedTotal)
	// Khởi tạo trước nhãn method="recovery" để counter xuất hiện trên /metrics ngay từ lúc boot.
	m.VaultUnlockFailuresTotal.WithLabelValues("recovery")
	// Khởi tạo trước nhãn type="text" và type="json" (plan mục 4, Task 6a, advisor-dec-149).
	m.EntriesCreatedTotal.WithLabelValues("text")
	m.EntriesCreatedTotal.WithLabelValues("json")
	return reg, m
}
