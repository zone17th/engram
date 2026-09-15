package worker_test

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/worker"
)

func silentLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

// Worker phải Start/Stop gọn: P01 chỉ cần lifecycle, chưa cần job thật.
func TestClientStartsAndStops(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgresForWorker(t)
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}

	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	client, err := worker.New(pool, silentLogger())
	if err != nil {
		t.Fatalf("worker.New: %v", err)
	}

	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := client.Start(startCtx); err != nil {
		t.Fatalf("Start: %v", err)
	}

	stopCtx, stopCancel := context.WithTimeout(ctx, 30*time.Second)
	defer stopCancel()
	if err := client.Stop(stopCtx); err != nil {
		t.Fatalf("Stop: %v", err)
	}
}

func TestNoopJobRunsToCompletion(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgresForWorker(t)
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	client, err := worker.New(pool, silentLogger())
	if err != nil {
		t.Fatalf("worker.New: %v", err)
	}
	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := client.Start(startCtx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer stopCancel()
		_ = client.Stop(stopCtx)
	}()

	subscribeCh, subscribeCancel := client.Subscribe(river.EventKindJobCompleted)
	defer subscribeCancel()

	if _, err := client.Insert(ctx, worker.NoopArgs{}, nil); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	select {
	case ev := <-subscribeCh:
		if ev.Job.Kind != "noop" {
			t.Errorf("kind = %q, muốn noop", ev.Job.Kind)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("job noop không hoàn thành trong 20s")
	}
}
