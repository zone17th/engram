// Command worker chạy job nền của engram.
package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/worker"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("cấu hình không hợp lệ", slog.String("err", err.Error()))
		os.Exit(1)
	}
	logger := obs.NewLogger(cfg.LogLevel, cfg.Env)

	env := Env{
		Cfg:    cfg,
		Logger: logger,
		Stdout: os.Stdout,
		Stderr: os.Stderr,
	}
	os.Exit(defaultRegistry.dispatch(context.Background(), env, os.Args[1:], runWorker))
}

// runWorker là nhánh chạy worker không args (subcommand của registry không bao
// giờ mở listener). Listener /metrics của WORKER_METRICS_ADDR bind trước khi mở
// DB để lỗi bind làm worker thoát ngay; registry là registry duy nhất do
// worker.Run tạo, gắn vào listener qua RunOptions.OnRegistry (không tạo registry
// thứ hai).
func runWorker(ctx context.Context, env Env) error {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	listener, err := worker.StartMetricsListener(runCtx, env.Cfg.WorkerMetricsAddr, nil, env.Logger)
	if err != nil {
		env.Logger.Error("worker metrics listener không bind được",
			slog.String("error_class", "metrics_listener_bind_failed"),
			slog.String("err", err.Error()))
		return err
	}

	runErr := worker.Run(runCtx, env.Cfg, env.Logger, worker.RunOptions{
		OnRegistry: func(reg *prometheus.Registry) { listener.SetGatherer(reg) },
	})
	cancel()
	if lerr := listener.Wait(); lerr != nil {
		env.Logger.Error("worker metrics listener dừng không gọn", slog.String("err", lerr.Error()))
	}
	if runErr != nil {
		env.Logger.Error("worker dừng do lỗi", slog.String("err", runErr.Error()))
		return runErr
	}
	return nil
}
