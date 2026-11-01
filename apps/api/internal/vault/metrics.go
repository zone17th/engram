package vault

import (
	"github.com/prometheus/client_golang/prometheus"

	"github.com/zone17th/engram/apps/api/internal/obs"
)

// UnlockMethodRecovery là nhãn `method="recovery"` duy nhất mà server đo được cho
// counter `vault_unlock_failures_total{method}` (SPEC §10.3, ADR 0002 §9, plan Task 8).
// Mở khoá bằng passphrase và passkey diễn ra cục bộ (offline) trong Web Worker nên
// server không bao giờ nhận passphrase/PWK và không đo được số lần mở khoá sai của hai phương thức đó.
const UnlockMethodRecovery = "recovery"

// Metrics chứa các bộ đếm Prometheus của vault theo SPEC §10.3.
// Được đăng ký sẵn từ `obs.NewRegistry()` (hoặc `NewMetrics(reg)`) và export để Task 10 gọi.
type Metrics struct {
	RecoverTotal        prometheus.Counter
	UnlockFailuresTotal *prometheus.CounterVec
}

// MetricsFromObs trích xuất bộ counter vault từ `*obs.Metrics` dùng chung của ứng dụng.
func MetricsFromObs(m *obs.Metrics) *Metrics {
	if m == nil {
		return NewMetrics(nil)
	}
	return &Metrics{
		RecoverTotal:        m.VaultRecoverTotal,
		UnlockFailuresTotal: m.VaultUnlockFailuresTotal,
	}
}

// NewMetrics tạo và đăng ký `vault_recover_total` cùng `vault_unlock_failures_total{method}`
// vào `reg` (nếu `reg != nil`). Hàm an toàn khi `reg == nil` (dùng trong unit test đơn lẻ).
func NewMetrics(reg prometheus.Registerer) *Metrics {
	recoverTotal := prometheus.NewCounter(prometheus.CounterOpts{
		Name: "vault_recover_total",
		Help: "Tổng số lần hoàn tất khôi phục vault bằng recovery key thành công.",
	})
	unlockFailures := prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "vault_unlock_failures_total",
		Help: "Tổng số lần mở khoá vault thất bại mà server quan sát được theo phương thức (không chứa user_id).",
	}, []string{"method"})
	unlockFailures.WithLabelValues(UnlockMethodRecovery)

	if reg != nil {
		reg.MustRegister(recoverTotal, unlockFailures)
	}
	return &Metrics{
		RecoverTotal:        recoverTotal,
		UnlockFailuresTotal: unlockFailures,
	}
}

// IncRecoverTotal tăng bộ đếm `vault_recover_total` thêm 1 (dành cho Task 10 `POST /vault/recover/complete`).
func (m *Metrics) IncRecoverTotal() {
	if m == nil || m.RecoverTotal == nil {
		return
	}
	m.RecoverTotal.Inc()
}

// IncRecoveryUnlockFailure tăng bộ đếm `vault_unlock_failures_total{method="recovery"}` thêm 1
// (dành cho Task 10 khi tra cứu/hoàn tất recovery thất bại).
func (m *Metrics) IncRecoveryUnlockFailure() {
	if m == nil || m.UnlockFailuresTotal == nil {
		return
	}
	m.UnlockFailuresTotal.WithLabelValues(UnlockMethodRecovery).Inc()
}

// IncRecoverTotal tăng `vault_recover_total` thông qua Service (nếu có).
func (s *Service) IncRecoverTotal() {
	if s == nil || s.metrics == nil {
		return
	}
	s.metrics.IncRecoverTotal()
}

// IncRecoveryUnlockFailure tăng `vault_unlock_failures_total{method="recovery"}` thông qua Service (nếu có).
func (s *Service) IncRecoveryUnlockFailure() {
	if s == nil || s.metrics == nil {
		return
	}
	s.metrics.IncRecoveryUnlockFailure()
}
