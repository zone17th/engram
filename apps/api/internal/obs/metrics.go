// Package obs gom logger và metric của API.
package obs

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Metrics là tập metric ứng dụng. Label chỉ được là giá trị có cardinality thấp
// và KHÔNG mang dữ liệu người dùng: route là pattern của chi, không phải raw path.
type Metrics struct {
	RequestDuration *prometheus.HistogramVec
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
	}
	reg.MustRegister(m.RequestDuration)
	return reg, m
}
