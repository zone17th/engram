// Command worker chạy job nền của engram.
package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/worker"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("cấu hình không hợp lệ", slog.String("err", err.Error()))
		os.Exit(1)
	}
	logger := obs.NewLogger(cfg.LogLevel, cfg.Env)

	if err := worker.Run(context.Background(), cfg, logger); err != nil {
		logger.Error("worker dừng do lỗi", slog.String("err", err.Error()))
		os.Exit(1)
	}
}
