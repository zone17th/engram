package worker

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
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
	if err != nil {
		return err
	}
	if w.mail == nil {
		return nil
	}
	ctxRow, err := q.GetNotificationMailContext(ctx, job.Args.NotificationID)
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
			if w.logger != nil {
				w.logger.ErrorContext(ctx, "gửi security notice thất bại", slog.Int64("notification_id", row.ID))
			}
			return err
		}
	}
	return nil
}
