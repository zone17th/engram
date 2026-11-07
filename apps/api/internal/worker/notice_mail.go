package worker

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/notification"
	"github.com/zone17th/engram/apps/api/internal/secevent"
)

type SecurityNoticeWorker struct {
	river.WorkerDefaults[notification.SecurityNoticeArgs]
	pool   *pgxpool.Pool
	mail   auth.Mailer
	logger *slog.Logger
}

func NewSecurityNoticeWorker(pool *pgxpool.Pool, mail auth.Mailer, logger *slog.Logger) *SecurityNoticeWorker {
	return &SecurityNoticeWorker{pool: pool, mail: mail, logger: logger}
}

func (w *SecurityNoticeWorker) Work(ctx context.Context, job *river.Job[notification.SecurityNoticeArgs]) error {
	q := gen.New(w.pool)
	row, err := q.GetNotificationForMail(ctx, job.Args.NotificationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return w.cancel(ctx, job, noticeOutcomeMissing, err)
	}
	if err != nil {
		return err
	}
	if !noticeMailAvailable(w.mail) {
		return w.cancel(ctx, job, noticeOutcomeNoMailer, auth.ErrMailDeliveryUnavailable)
	}
	ctxRow, err := q.GetNotificationMailContext(ctx, job.Args.NotificationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return w.cancel(ctx, job, noticeOutcomeMissing, err)
	}
	if err != nil {
		return err
	}
	purpose := "security"
	detail := ""
	if len(ctxRow.Meta) > 0 {
		var meta secevent.Meta
		if err := json.Unmarshal(ctxRow.Meta, &meta); err != nil {
			return err
		}
		meta = meta.Sanitize()
		if meta.Event == secevent.EventPasswordReset {
			purpose = auth.PurposePasswordResetNotice
			detail = auth.FormatPasswordResetNoticeDetail(ctxRow.Locale, meta.UnlinkedProviders)
		}
	}
	for _, to := range row.EmailTargets {
		if err := w.mail.Send(ctx, to, purpose, detail); err != nil {
			if auth.IsPermanentMailError(err) {
				return w.cancel(ctx, job, noticeOutcomePermanent, err)
			}
			NoticeMailOutcomes.WithLabelValues(noticeOutcomeRetry).Inc()
			if w.logger != nil {
				w.logger.ErrorContext(ctx, "gửi security notice thất bại", slog.Int64("notification_id", row.ID))
			}
			return err
		}
	}
	return nil
}

// Terminal/retry outcomes of security_notice_mail (plan P06 Task 5, C13).
const (
	noticeOutcomeMissing   = "notification_missing"
	noticeOutcomeNoMailer  = "mail_unavailable"
	noticeOutcomePermanent = "smtp_permanent"
	noticeOutcomeRetry     = "smtp_transient"
)

// NoticeMailOutcomes counts security_notice_mail jobs that were cancelled
// (missing notification, no mail adapter, permanent SMTP failure) or handed back
// to River for retry. Register it with RegisterNoticeMailMetrics.
var NoticeMailOutcomes = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "engram_notice_mail_outcomes_total",
	Help: "security_notice_mail jobs cancelled or retried, by outcome.",
}, []string{"outcome"})

// RegisterNoticeMailMetrics registers NoticeMailOutcomes on reg (idempotent).
func RegisterNoticeMailMetrics(reg prometheus.Registerer) error {
	if reg == nil {
		return nil
	}
	if err := reg.Register(NoticeMailOutcomes); err != nil {
		var already prometheus.AlreadyRegisteredError
		if errors.As(err, &already) {
			return nil
		}
		return err
	}
	return nil
}

// cancel ends the job for good: River will not retry it.
func (w *SecurityNoticeWorker) cancel(ctx context.Context, job *river.Job[notification.SecurityNoticeArgs], outcome string, cause error) error {
	NoticeMailOutcomes.WithLabelValues(outcome).Inc()
	if w.logger != nil {
		level := slog.LevelInfo
		if outcome == noticeOutcomePermanent {
			level = slog.LevelWarn
		}
		w.logger.LogAttrs(ctx, level, "security notice mail cancelled",
			slog.String("outcome", outcome), slog.Int64("notification_id", job.Args.NotificationID))
	}
	return river.JobCancel(cause)
}

// noticeMailAvailable unwraps worker.go's mailAdapter and reports whether the
// underlying mailer can deliver (NoopMailer/nil cannot).
func noticeMailAvailable(m auth.Mailer) bool {
	if m == nil {
		return false
	}
	if a, ok := m.(mailAdapter); ok {
		if a.fn == nil {
			return false
		}
		if c, ok := a.fn.(interface{ MailDeliveryAvailable() bool }); ok {
			return c.MailDeliveryAvailable()
		}
		return true
	}
	if c, ok := m.(interface{ MailDeliveryAvailable() bool }); ok {
		return c.MailDeliveryAvailable()
	}
	return true
}
