package worker

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
)

// New dựng River client với queue mặc định. P01 Noop + P02 prune/notice.
func New(pool *pgxpool.Pool, logger *slog.Logger) (*river.Client[pgx.Tx], error) {
	return NewWithMail(pool, logger, 90, nil)
}

func NewWithMail(pool *pgxpool.Pool, logger *slog.Logger, retentionDays int, mail interface {
	Send(ctx context.Context, recipient, purpose, link string) error
},
) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	if err := river.AddWorkerSafely(workers, &NoopWorker{logger: logger}); err != nil {
		return nil, fmt.Errorf("đăng ký worker: %w", err)
	}
	if err := river.AddWorkerSafely(workers, NewAuthPruneWorker(pool, nil)); err != nil {
		return nil, fmt.Errorf("đăng ký prune: %w", err)
	}
	if err := river.AddWorkerSafely(workers, NewIdempotencyPruneWorker(pool, nil)); err != nil {
		return nil, fmt.Errorf("đăng ký idempotency prune: %w", err)
	}
	if mail != nil {
		if err := river.AddWorkerSafely(workers, NewSecurityNoticeWorker(pool, mailAdapter{mail}, logger)); err != nil {
			return nil, fmt.Errorf("đăng ký notice: %w", err)
		}
	}

	periodic := []*river.PeriodicJob{
		river.NewPeriodicJob(
			river.PeriodicInterval(time.Hour),
			func() (river.JobArgs, *river.InsertOpts) {
				return AuthPruneArgs{RetentionDays: retentionDays}, nil
			},
			nil,
		),
		river.NewPeriodicJob(
			river.PeriodicInterval(time.Hour),
			func() (river.JobArgs, *river.InsertOpts) {
				return IdempotencyPruneArgs{}, nil
			},
			nil,
		),
	}

	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:       logger,
		PeriodicJobs: periodic,
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: 4},
		},
		Workers: workers,
	})
	if err != nil {
		return nil, fmt.Errorf("tạo river client: %w", err)
	}
	return client, nil
}

type mailAdapter struct {
	fn interface {
		Send(ctx context.Context, recipient, purpose, link string) error
	}
}

func (m mailAdapter) Send(ctx context.Context, recipient, purpose, link string) error {
	return m.fn.Send(ctx, recipient, purpose, link)
}

// Run chạy worker cho tới khi nhận SIGINT/SIGTERM rồi dừng gọn.
func Run(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := db.Preflight(ctx, pool); err != nil {
		return fmt.Errorf("preflight database thất bại: %w", err)
	}

	var mail auth.Mailer
	if cfg.MailSinkDir != "" {
		m, err := auth.NewSinkMailer(cfg.MailSinkDir)
		if err != nil {
			return err
		}
		mail = m
	}
	client, err := NewWithMail(pool, logger, cfg.AuditRetentionDays, mail)
	if err != nil {
		return err
	}
	if err := client.Start(ctx); err != nil {
		return fmt.Errorf("start worker: %w", err)
	}
	logger.Info("worker đang chạy", slog.Bool("semantic_available", cfg.SemanticAvailable()))

	<-ctx.Done()

	stopCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := client.Stop(stopCtx); err != nil {
		return fmt.Errorf("stop worker: %w", err)
	}
	logger.Info("worker đã dừng gọn")
	return nil
}
