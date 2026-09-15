// Command api chạy HTTP server của engram.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
)

func main() {
	// -healthcheck: image distroless không có shell/wget/curl, nên healthcheck
	// của Compose gọi lại chính binary này. Nhánh phải nằm TRƯỚC run() — nếu
	// không, container healthcheck sẽ khởi động một API thứ hai và đụng port.
	healthcheck := flag.Bool("healthcheck", false, "probe /api/v1/healthz rồi thoát theo status")
	flag.Parse()
	if *healthcheck {
		if err := probeHealth(); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		return
	}

	if err := run(); err != nil {
		slog.Error("api dừng do lỗi", slog.String("err", err.Error()))
		os.Exit(1)
	}
}

// probeHealth gọi healthz trên chính container này. Dùng HTTP_ADDR để lấy port,
// nhưng luôn nối tới 127.0.0.1 — 0.0.0.0 là địa chỉ nghe, không phải địa chỉ gọi.
func probeHealth() error {
	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = "0.0.0.0:8080"
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("HTTP_ADDR không hợp lệ: %w", err)
	}

	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/api/v1/healthz")
	if err != nil {
		return fmt.Errorf("healthz không gọi được: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz trả %d", resp.StatusCode)
	}
	return nil
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger := obs.NewLogger(cfg.LogLevel, cfg.Env)
	logger.Info("khởi động api", slog.Any("config", cfg.Redacted()))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := db.Preflight(ctx, pool); err != nil {
		return fmt.Errorf("preflight database thất bại: %w", err)
	}
	logger.Info("preflight database ok")

	reg, metrics := obs.NewRegistry()

	srv := &http.Server{
		Addr: cfg.HTTPAddr,
		Handler: httpx.NewRouter(httpx.Deps{
			Config:           cfg,
			Logger:           logger,
			Ready:            db.ReadyCheck(pool),
			Metrics:          promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
			MetricsCollector: metrics,
		}),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("nghe HTTP", slog.String("addr", cfg.HTTPAddr))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		logger.Info("nhận tín hiệu dừng, đang đóng kết nối")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	logger.Info("api đã dừng gọn")
	return nil
}
