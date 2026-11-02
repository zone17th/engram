// Command worker chạy job nền của engram.
package main

import (
	"context"
	"log/slog"
	"os"

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

func runWorker(ctx context.Context, env Env) error {
	if err := worker.Run(ctx, env.Cfg, env.Logger); err != nil {
		env.Logger.Error("worker dừng do lỗi", slog.String("err", err.Error()))
		return err
	}
	return nil
}
