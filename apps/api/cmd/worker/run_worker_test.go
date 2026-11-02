package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"slices"
	"strings"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/worker"
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
	var logs bytes.Buffer
	env.Logger = slog.New(slog.NewJSONHandler(&logs, nil))

	err = runWorker(context.Background(), env)
	if err == nil {
		t.Fatal("runWorker returned nil, want bind error")
	}
	if !strings.Contains(err.Error(), "bind failed") {
		t.Fatalf("runWorker error = %v, want a bind failure", err)
	}

	// Log lỗi bind: có `component`, và nếu có `error_class` thì phải thuộc chín mã
	// lý do của plan mục 2.21 (RV-T20a-BE-5: không tạo mã thứ mười).
	nine := []string{
		worker.ErrorClassProviderTimeout, worker.ErrorClassProvider5xx, worker.ErrorClassProvider429,
		worker.ErrorClassProviderRefused, worker.ErrorClassProviderBadResponse, worker.ErrorClassDimsMismatch,
		worker.ErrorClassHashStale, worker.ErrorClassGenerationNotReceiving, worker.ErrorClassGenerationUnconfigured,
	}
	var sawBind bool
	sc := bufio.NewScanner(&logs)
	for sc.Scan() {
		var rec map[string]any
		if err := json.Unmarshal(sc.Bytes(), &rec); err != nil {
			t.Fatalf("log line is not JSON: %q: %v", sc.Text(), err)
		}
		if v, ok := rec["error_class"]; ok {
			if s, _ := v.(string); !slices.Contains(nine, s) {
				t.Errorf("log %q has error_class=%v outside the nine-code vocabulary", rec["msg"], v)
			}
		}
		if rec["component"] == metricsListenerComponent {
			sawBind = true
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan logs: %v", err)
	}
	if !sawBind {
		t.Fatalf("no bind-failure log with component=%q; logs: %s", metricsListenerComponent, logs.String())
	}
}
