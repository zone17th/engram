package worker

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/notification"
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
	row, err := gen.New(w.pool).GetNotificationForMail(ctx, job.Args.NotificationID)
	if err != nil {
		return err
	}
	if w.mail == nil {
		return nil
	}
	for _, to := range row.EmailTargets {
		if err := w.mail.Send(ctx, to, "security", ""); err != nil {
			if w.logger != nil {
				w.logger.ErrorContext(ctx, "gửi security notice thất bại", slog.Int64("notification_id", row.ID))
			}
			return err
		}
	}
	return nil
}
