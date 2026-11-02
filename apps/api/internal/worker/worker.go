package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

// EmbeddingDeps gom các phụ thuộc runtime của hàng đợi và worker embedding
// (plan P05 mục 2.17, Task 11a). Khi nil hoặc ClientSet == nil, NewWithMail giữ
// nguyên hành vi P04 (không đăng ký queue "embedding", không đăng ký embed/canary
// worker hay periodic job).
type EmbeddingDeps struct {
	ClientSet  *embedding.ClientSet
	Breakers   map[string]*embedding.Breaker
	Now        func() time.Time
	Jitter     func() float64
	RandSource embedding.Int63nSource
}

// Deps gom các phụ thuộc mở rộng của NewWithMail (metrics và embedding). Giá trị
// zero tương đương hành vi P04.
type Deps struct {
	Metrics   *obs.Metrics
	Embedding *EmbeddingDeps
}

// RunOptions cấu hình tuỳ chọn cho Run (plan P05 Task 11a, FS-35).
type RunOptions struct {
	// OnRegistry được gọi đồng bộ ngay sau obs.NewRegistry() và trước khi
	// river.Client.Start chạy. Task 20a dùng hook này để đăng ký DB gauges và mở
	// listener /metrics.
	OnRegistry func(*prometheus.Registry)

	// calibrationLookup, beforeClientStart, và afterClientStart là các seam nội
	// bộ phục vụ test thứ tự bootstrap trước client.Start và dừng worker gọn sau
	// khi client.Start đã thành công (TestWorkerBootCallsBootstrap, EJ2-3).
	calibrationLookup embedid.CalibrationLookup
	beforeClientStart func(ctx context.Context, pool *pgxpool.Pool)
	afterClientStart  func(ctx context.Context, pool *pgxpool.Pool)
}

// New dựng River client với queue mặc định. P01 Noop + P02 prune/notice.
func New(pool *pgxpool.Pool, logger *slog.Logger) (*river.Client[pgx.Tx], error) {
	return NewWithMail(pool, logger, 90, nil)
}

func NewWithMail(
	pool *pgxpool.Pool,
	logger *slog.Logger,
	retentionDays int,
	mail interface {
		Send(ctx context.Context, recipient, purpose, link string) error
	},
	extra ...Deps,
) (*river.Client[pgx.Tx], error) {
	var deps Deps
	if len(extra) > 0 {
		deps = extra[0]
	}

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
	if err := river.AddWorkerSafely(workers, NewRateEventPruneWorker(pool, nil)); err != nil {
		return nil, fmt.Errorf("đăng ký rate_event prune: %w", err)
	}
	if err := river.AddWorkerSafely(workers, NewWebAuthnChallengePruneWorker(pool, nil)); err != nil {
		return nil, fmt.Errorf("đăng ký webauthn_challenge prune: %w", err)
	}
	if err := river.AddWorkerSafely(workers, entry.NewContentPurgeWorker(pool, nil)); err != nil {
		return nil, fmt.Errorf("đăng ký content purge: %w", err)
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
		river.NewPeriodicJob(
			river.PeriodicInterval(15*time.Minute),
			func() (river.JobArgs, *river.InsertOpts) {
				return RateEventPruneArgs{}, nil
			},
			nil,
		),
		river.NewPeriodicJob(
			river.PeriodicInterval(15*time.Minute),
			func() (river.JobArgs, *river.InsertOpts) {
				return WebAuthnChallengePruneArgs{}, nil
			},
			nil,
		),
		river.NewPeriodicJob(
			river.PeriodicInterval(time.Hour),
			func() (river.JobArgs, *river.InsertOpts) {
				return entry.ContentPurgeArgs{}, nil
			},
			nil,
		),
	}

	queues := map[string]river.QueueConfig{
		river.QueueDefault: {MaxWorkers: 4},
	}

	if deps.Embedding != nil && deps.Embedding.ClientSet != nil {
		var embMetrics *obs.EmbeddingMetrics
		if deps.Metrics != nil {
			embMetrics = deps.Metrics.Embedding
		}
		nowFn := deps.Embedding.Now
		if nowFn == nil {
			nowFn = time.Now
		}
		breakers := deps.Embedding.Breakers
		if breakers == nil {
			breakers = jobs.NewWorkerBreakers(nowFn, embMetrics)
		}
		jobDeps := jobs.Dependencies{
			Pool:       pool,
			ClientSet:  deps.Embedding.ClientSet,
			Breakers:   breakers,
			Metrics:    embMetrics,
			Logger:     logger,
			Now:        nowFn,
			Jitter:     deps.Embedding.Jitter,
			RandSource: deps.Embedding.RandSource,
		}
		if err := river.AddWorkerSafely(workers, jobs.NewEmbedItemWorker(jobDeps)); err != nil {
			return nil, fmt.Errorf("đăng ký embed_item worker: %w", err)
		}
		if err := river.AddWorkerSafely(workers, jobs.NewEmbedTagWorker(jobDeps)); err != nil {
			return nil, fmt.Errorf("đăng ký embed_tag worker: %w", err)
		}
		if err := river.AddWorkerSafely(workers, jobs.NewCanaryWorker(jobDeps)); err != nil {
			return nil, fmt.Errorf("đăng ký embedding_canary worker: %w", err)
		}
		if err := river.AddWorkerSafely(workers, jobs.NewReembedUserWorker(jobDeps)); err != nil {
			return nil, fmt.Errorf("đăng ký reembed_user worker: %w", err)
		}
		if err := river.AddWorkerSafely(workers, jobs.NewReembedAllWorker(jobDeps)); err != nil {
			return nil, fmt.Errorf("đăng ký reembed_all worker: %w", err)
		}
		periodic = append(periodic, jobs.ReembedAllPeriodicJob())
		queues[jobs.QueueEmbedding] = river.QueueConfig{MaxWorkers: jobs.MaxEmbedWorkers}
		periodic = append(periodic, river.NewPeriodicJob(
			river.PeriodicInterval(jobs.CanaryInterval),
			func() (river.JobArgs, *river.InsertOpts) {
				return jobargs.CanaryArgs{}, jobs.CanaryInsertOpts()
			},
			&river.PeriodicJobOpts{RunOnStart: true},
		))
	}

	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Logger:       logger,
		PeriodicJobs: periodic,
		Queues:       queues,
		Workers:      workers,
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
func Run(ctx context.Context, cfg *config.Config, logger *slog.Logger, opts ...RunOptions) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	reg, metrics := obs.NewRegistry()
	var calibOverride embedid.CalibrationLookup
	var beforeStartHooks []func(ctx context.Context, pool *pgxpool.Pool)
	var afterStartHooks []func(ctx context.Context, pool *pgxpool.Pool)
	for _, opt := range opts {
		if opt.OnRegistry != nil {
			opt.OnRegistry(reg)
		}
		if opt.calibrationLookup != nil {
			calibOverride = opt.calibrationLookup
		}
		if opt.beforeClientStart != nil {
			beforeStartHooks = append(beforeStartHooks, opt.beforeClientStart)
		}
		if opt.afterClientStart != nil {
			afterStartHooks = append(afterStartHooks, opt.afterClientStart)
		}
	}

	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := db.Preflight(ctx, pool); err != nil {
		return fmt.Errorf("preflight database thất bại: %w", err)
	}

	var mail auth.Mailer
	if dir := cfg.EffectiveMailSinkDir(); dir != "" {
		m, err := auth.NewSinkMailer(dir)
		if err != nil {
			return err
		}
		mail = m
	}

	workerDeps := Deps{Metrics: metrics}
	if cfg.SearchSemanticEnabled && cfg.EmbeddingProvider != "" && cfg.EmbeddingProvider != embedding.ProviderNoop {
		var shadowPtr *embedding.ClientConfig
		if shadowCfg, ok := cfg.EmbeddingShadow(); ok {
			shadowPtr = &shadowCfg
		}
		cs, csErr := embedding.NewClientSetFromConfigs(
			ctx,
			cfg.EmbeddingPrimary(),
			shadowPtr,
			embedding.ClientDeps{
				Metrics: metrics.Embedding,
				Logger:  logger,
				Now:     time.Now,
			},
		)
		if csErr != nil {
			if logger != nil {
				logger.LogAttrs(
					ctx,
					slog.LevelWarn,
					"khởi tạo embedding client set thất bại lúc boot; chạy worker không có embedding",
					slog.String("provider", cfg.EmbeddingProvider),
					slog.String("error_class", classifyBootProviderError(csErr)),
				)
			}
		} else {
			calib := calibOverride
			if calib == nil {
				calib = embedding.CalibrationLookupFor(cfg.Env)
			}
			if _, bootErr := generation.Bootstrap(ctx, pool, cs.Primary().Identity, calib); bootErr != nil {
				if errors.Is(bootErr, generation.ErrCalibrationMissing) {
					if metrics != nil && metrics.Embedding != nil && metrics.Embedding.GenerationMismatchTotal != nil {
						metrics.Embedding.GenerationMismatchTotal.WithLabelValues(jobs.MismatchReasonUnconfigured).Inc()
					}
					if logger != nil {
						logger.LogAttrs(
							ctx,
							slog.LevelWarn,
							"chưa có calibration cho embedding identity lúc boot; bỏ qua bootstrap g1",
							slog.String("provider", cs.Primary().Identity.Provider),
						)
					}
				} else {
					return fmt.Errorf("bootstrap embedding generation: %w", bootErr)
				}
			}
			workerDeps.Embedding = &EmbeddingDeps{
				ClientSet: cs,
				Breakers:  jobs.NewWorkerBreakers(time.Now, metrics.Embedding),
				Now:       time.Now,
			}
		}
	}

	client, err := NewWithMail(pool, logger, cfg.AuditRetentionDays, mail, workerDeps)
	if err != nil {
		return err
	}
	for _, fn := range beforeStartHooks {
		fn(ctx, pool)
	}
	if err := client.Start(ctx); err != nil {
		return fmt.Errorf("start worker: %w", err)
	}
	logger.Info("worker đang chạy", slog.Bool("semantic_enabled", cfg.SearchSemanticEnabled))
	if workerDeps.Embedding != nil {
		// L8/BE-4: một reembed_all boot (sau Bootstrap, sau Start) backfill g1
		// pending; ByArgs dedupe nên restart không chất đống job.
		if _, err := jobs.InsertReembedAll(ctx, jobs.RiverClientInserter{Client: client}, 0); err != nil {
			logger.Warn("không chèn được reembed_all lúc boot; chu kỳ 24h sẽ bù")
		}
	}
	for _, fn := range afterStartHooks {
		fn(ctx, pool)
	}

	<-ctx.Done()

	stopCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := client.Stop(stopCtx); err != nil {
		return fmt.Errorf("stop worker: %w", err)
	}
	logger.Info("worker đã dừng gọn")
	return nil
}

func classifyBootProviderError(err error) string {
	if err == nil {
		return ""
	}
	var pe *embedding.ProviderError
	if errors.As(err, &pe) && pe != nil {
		return string(pe.Class)
	}
	if errors.Is(err, embedding.ErrBadResponse) {
		return string(embedding.ClassBadResponse)
	}
	if embedding.IsTimeoutError(err) {
		return string(embedding.ClassTimeout)
	}
	return string(embedding.ClassRefused)
}
