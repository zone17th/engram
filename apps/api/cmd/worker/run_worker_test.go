package main

import (
	"context"
	"net"
	"strings"
	"testing"
)

// TestRunWorkerMetricsBindFailureExits: WORKER_METRICS_ADDR đã bị chiếm → nhánh
// chạy worker trả lỗi bind ngay, trước khi mở DB (Cfg không có DatabaseURL nên
// nếu worker.Run được gọi thì lỗi sẽ khác).
func TestRunWorkerMetricsBindFailureExits(t *testing.T) {
	var lc net.ListenConfig
	busy, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() {
		if err := busy.Close(); err != nil {
			t.Errorf("close listener: %v", err)
		}
	}()

	env, _, _ := newTestEnv()
	env.Cfg.WorkerMetricsAddr = busy.Addr().String()

	err = runWorker(context.Background(), env)
	if err == nil {
		t.Fatal("runWorker returned nil, want bind error")
	}
	if !strings.Contains(err.Error(), "bind failed") {
		t.Fatalf("runWorker error = %v, want a bind failure", err)
	}
}
