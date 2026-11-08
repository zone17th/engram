package obs

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Tập nhãn hữu hạn cho metric export / xoá tài khoản (plan P06 Task 4). Không
// metric nào mang user_id, job_id, email hay đường dẫn file.
var (
	// ExportKinds khớp CHECK `export_job.kind` của migration 0010.
	ExportKinds = []string{"encrypted"}

	// ExportJobOutcomes là trạng thái kết thúc của một export_job
	// (`status` cuối của 0010, trừ `queued`/`running`).
	ExportJobOutcomes = []string{"ready", "failed", "cancelled", "expired"}

	// ExportDecryptedAuditOutcomes: `recorded` = audit `export.decrypted` đã ghi;
	// `rejected` = bị từ chối (re-auth/CSRF/vault); `error` = lỗi server.
	ExportDecryptedAuditOutcomes = []string{"recorded", "rejected", "error"}

	// AccountDeletionOutcomes: `deleted` = xoá cứng xong; `rejected` = re-auth
	// hoặc xác nhận sai; `error` = lỗi server (transaction thất bại).
	AccountDeletionOutcomes = []string{"deleted", "rejected", "error"}
)

// ExportJobDurationBuckets (giây): từ job nhỏ vài giây tới snapshot lớn ~30 phút.
var ExportJobDurationBuckets = []float64{1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800}

// ExportMetrics là collector P06 cho export và xoá tài khoản.
type ExportMetrics struct {
	JobsTotal             *prometheus.CounterVec
	JobDuration           *prometheus.HistogramVec
	DecryptedAuditTotal   *prometheus.CounterVec
	AccountDeletionsTotal *prometheus.CounterVec
}

func newExportMetrics() *ExportMetrics {
	m := &ExportMetrics{
		JobsTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "export_jobs_total",
			Help: "Số export_job đã kết thúc theo kind và outcome (không chứa user_id/job_id).",
		}, []string{"kind", "outcome"}),
		JobDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "export_job_duration_seconds",
			Help:    "Thời gian từ lúc bắt đầu tới lúc kết thúc export_job theo kind và outcome.",
			Buckets: ExportJobDurationBuckets,
		}, []string{"kind", "outcome"}),
		DecryptedAuditTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "export_decrypted_audit_total",
			Help: "Số lần ghi audit xuất bản đọc được (export.decrypted) theo outcome.",
		}, []string{"outcome"}),
		AccountDeletionsTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "account_deletions_total",
			Help: "Số yêu cầu xoá tài khoản theo outcome.",
		}, []string{"outcome"}),
	}
	// Khởi tạo trước toàn bộ tích nhãn để series có mặt ngay từ boot (alert không
	// phải đoán "vắng" hay "0").
	for _, k := range ExportKinds {
		for _, o := range ExportJobOutcomes {
			m.JobsTotal.WithLabelValues(k, o)
			m.JobDuration.WithLabelValues(k, o)
		}
	}
	for _, o := range ExportDecryptedAuditOutcomes {
		m.DecryptedAuditTotal.WithLabelValues(o)
	}
	for _, o := range AccountDeletionOutcomes {
		m.AccountDeletionsTotal.WithLabelValues(o)
	}
	return m
}

func (m *ExportMetrics) collectors() []prometheus.Collector {
	return []prometheus.Collector{m.JobsTotal, m.JobDuration, m.DecryptedAuditTotal, m.AccountDeletionsTotal}
}

// ObserveJob ghi một export_job đã kết thúc. kind/outcome ngoài tập hữu hạn bị
// bỏ qua để producer lỗi không thể nổ cardinality.
func (m *ExportMetrics) ObserveJob(kind, outcome string, d time.Duration) {
	if !slices.Contains(ExportKinds, kind) || !slices.Contains(ExportJobOutcomes, outcome) {
		return
	}
	m.JobsTotal.WithLabelValues(kind, outcome).Inc()
	m.JobDuration.WithLabelValues(kind, outcome).Observe(d.Seconds())
}

// IncDecryptedAudit đếm một lần audit export.decrypted; outcome lạ bị bỏ qua.
func (m *ExportMetrics) IncDecryptedAudit(outcome string) {
	if slices.Contains(ExportDecryptedAuditOutcomes, outcome) {
		m.DecryptedAuditTotal.WithLabelValues(outcome).Inc()
	}
}

// IncAccountDeletion đếm một yêu cầu xoá tài khoản; outcome lạ bị bỏ qua.
func (m *ExportMetrics) IncAccountDeletion(outcome string) {
	if slices.Contains(AccountDeletionOutcomes, outcome) {
		m.AccountDeletionsTotal.WithLabelValues(outcome).Inc()
	}
}

// CleanupPendingAgeQuery: tuổi (giây) của hàng export_file_cleanup chưa xong cũ
// nhất; 0 khi không còn hàng nào. Chỉ đọc created_at, không đọc file_name.
const CleanupPendingAgeQuery = `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))), 0)::float8
FROM export_file_cleanup WHERE done_at IS NULL`

var cleanupPendingAgeDesc = prometheus.NewDesc(
	"export_cleanup_pending_age_seconds",
	"Tuổi (giây) của mục dọn file export chưa xong cũ nhất; alert > 3600.",
	nil, nil,
)

// RegisterExportCleanupGauge đăng ký gauge `export_cleanup_pending_age_seconds`
// đọc DB khi scrape (timeout GaugeCollectTimeout). Lỗi DB → bỏ series trong lần
// scrape đó (monitor coi "vắng" là cảnh báo, không coi là 0). Gọi lần hai trên
// cùng registry trả lỗi.
func RegisterExportCleanupGauge(reg prometheus.Registerer, db DBQuerier) error {
	if reg == nil {
		return errors.New("obs: nil prometheus registerer")
	}
	if db == nil {
		return errors.New("obs: nil export cleanup querier")
	}
	if err := reg.Register(&exportCleanupCollector{db: db}); err != nil {
		return fmt.Errorf("obs: register export cleanup gauge: %w", err)
	}
	return nil
}

type exportCleanupCollector struct {
	db DBQuerier
}

func (c *exportCleanupCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- cleanupPendingAgeDesc
}

func (c *exportCleanupCollector) Collect(ch chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), GaugeCollectTimeout)
	defer cancel()
	var age float64
	if err := c.db.QueryRow(ctx, CleanupPendingAgeQuery).Scan(&age); err != nil {
		return
	}
	if m, err := prometheus.NewConstMetric(cleanupPendingAgeDesc, prometheus.GaugeValue, age); err == nil {
		ch <- m
	}
}
