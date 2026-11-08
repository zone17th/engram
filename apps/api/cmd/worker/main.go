// Command worker chạy job nền của engram.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/worker"
)

// metricsListenerComponent nhận diện log của listener /metrics (không phải
// `error_class`, xem runWorker).
const metricsListenerComponent = "worker_metrics_listener"

// healthcheckTimeout là ngân sách của `worker -healthcheck` (kết nối + SELECT 1).
const healthcheckTimeout = 2 * time.Second

func main() {
	// -healthcheck: image distroless không có shell/psql, nên healthcheck của
	// Compose gọi lại chính binary. Nhánh nằm TRƯỚC config.Load và registry để
	// không khởi động worker thứ hai và không phụ thuộc secret ngoài DATABASE_URL.
	if len(os.Args) == 2 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheck(context.Background(), os.Getenv("DATABASE_URL"), healthcheckTimeout, os.Stderr))
	}

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

// healthcheck mở một kết nối riêng tới DATABASE_URL, chạy `SELECT 1` trong
// timeout rồi trả 0 (khoẻ) hoặc 1. Lỗi in ra stderr KHÔNG kèm DSN (có mật khẩu).
func healthcheck(ctx context.Context, dsn string, timeout time.Duration, stderr io.Writer) int {
	if err := pingDB(ctx, dsn, timeout); err != nil {
		_, _ = fmt.Fprintln(stderr, "worker healthcheck:", err)
		return 1
	}
	return 0
}

func pingDB(ctx context.Context, dsn string, timeout time.Duration) error {
	if dsn == "" {
		return errors.New("DATABASE_URL trống")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return errors.New("DATABASE_URL không hợp lệ")
	}
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("kết nối DB thất bại: %w", sanitizeConnErr(ctx, err))
	}
	defer func() { _ = conn.Close(context.Background()) }()
	var one int
	if err := conn.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil || one != 1 {
		return fmt.Errorf("SELECT 1 thất bại: %w", sanitizeConnErr(ctx, err))
	}
	return nil
}

// sanitizeConnErr bỏ chi tiết pgconn (có thể chứa host/user) và chỉ giữ loại lỗi.
func sanitizeConnErr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err == nil {
		return errors.New("kết quả sai")
	}
	return errors.New("lỗi kết nối hoặc truy vấn")
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
		// Không dùng `error_class`: trường đó dành riêng cho chín mã lý do embedding
		// của plan mục 2.21; lỗi listener được nhận diện bằng `component`.
		env.Logger.Error("worker metrics listener không bind được",
			slog.String("component", metricsListenerComponent),
			slog.String("err", err.Error()))
		return err
	}

	runErr := worker.Run(runCtx, env.Cfg, env.Logger, worker.RunOptions{
		OnRegistry: func(reg *prometheus.Registry) { listener.SetGatherer(reg) },
	})
	cancel()
	if lerr := listener.Wait(); lerr != nil {
		env.Logger.Error("worker metrics listener dừng không gọn",
			slog.String("component", metricsListenerComponent),
			slog.String("err", lerr.Error()))
	}
	if runErr != nil {
		env.Logger.Error("worker dừng do lỗi", slog.String("err", runErr.Error()))
		return runErr
	}
	return nil
}
