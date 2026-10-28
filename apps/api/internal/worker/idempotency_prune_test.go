package worker_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/worker"
)

func TestIdempotencyPruneBoundaryAtExpiresAtAndIdempotent(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(now)

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email, locale) VALUES ('idem-prune@example.com', 'en') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}

	// Chèn 3 bản ghi ở biên expires_at:
	// - key_expired_before_now: expires_at = now - 1s (< now -> PHẢI bị xoá)
	// - key_exact_at_now:       expires_at = now      (= now -> KHÔNG bị xoá vì điều kiện là expires_at < now)
	// - key_future_after_now:   expires_at = now + 1s (> now -> KHÔNG bị xoá)
	rows := []struct {
		key       string
		expiresAt time.Time
	}{
		{key: "key_expired_before_now", expiresAt: now.Add(-time.Second)},
		{key: "key_exact_at_now", expiresAt: now},
		{key: "key_future_after_now", expiresAt: now.Add(time.Second)},
	}
	for _, row := range rows {
		if _, err := pool.Exec(ctx, `
			INSERT INTO idempotency_key (
				user_id, key, method, path, request_hash, status, owner_token,
				claimed_at, expires_at, status_code, response
			) VALUES ($1, $2, 'POST', '/api/v1/vault', '\x01', 'done', $3, $4, $5, 201, '{"version":1}'::jsonb)
		`, userID, row.key, uuid.New(), now.Add(-24*time.Hour), row.expiresAt); err != nil {
			t.Fatal(err)
		}
	}

	pruner := worker.NewIdempotencyPruneWorker(pool, clk)
	job := &river.Job[worker.IdempotencyPruneArgs]{Args: worker.IdempotencyPruneArgs{}}
	if err := pruner.Work(ctx, job); err != nil {
		t.Fatal(err)
	}

	assertKeys := func() {
		t.Helper()
		r, err := pool.Query(ctx, `SELECT key FROM idempotency_key WHERE user_id = $1 ORDER BY key ASC`, userID)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Close()
		var got []string
		for r.Next() {
			var k string
			if err := r.Scan(&k); err != nil {
				t.Fatal(err)
			}
			got = append(got, k)
		}
		if len(got) != 2 || got[0] != "key_exact_at_now" || got[1] != "key_future_after_now" {
			t.Fatalf("còn lại %v, muốn [key_exact_at_now key_future_after_now]", got)
		}
	}

	assertKeys()

	// Chạy lại job lần 2 tại cùng thời điểm -> idempotent, không xoá nhầm hàng ở biên now.
	if err := pruner.Work(ctx, job); err != nil {
		t.Fatal(err)
	}
	assertKeys()

	// Dịch đồng hồ thêm 1 giây (lúc này key_exact_at_now có expires_at < now, còn key_future_after_now có expires_at == now):
	// chạy lại -> xoá key_exact_at_now, chỉ còn key_future_after_now.
	clk.Advance(time.Second)
	if err := pruner.Work(ctx, job); err != nil {
		t.Fatal(err)
	}
	var remainingKey string
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*), min(key) FROM idempotency_key WHERE user_id = $1`, userID).Scan(&count, &remainingKey); err != nil {
		t.Fatal(err)
	}
	if count != 1 || remainingKey != "key_future_after_now" {
		t.Fatalf("sau khi dịch 1s: count=%d key=%q, muốn 1 và key_future_after_now", count, remainingKey)
	}
}

func TestIdempotencyPruneJobRegisteredInRiverClient(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	client, err := worker.New(pool, silentLogger())
	if err != nil {
		t.Fatalf("worker.New: %v", err)
	}
	startCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := client.Start(startCtx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer stopCancel()
		_ = client.Stop(stopCtx)
	}()

	subscribeCh, subscribeCancel := client.Subscribe(river.EventKindJobCompleted)
	defer subscribeCancel()

	if _, err := client.Insert(ctx, worker.IdempotencyPruneArgs{}, nil); err != nil {
		t.Fatalf("Insert IdempotencyPruneArgs: %v", err)
	}

	for {
		select {
		case ev := <-subscribeCh:
			if ev.Job.Kind == "idempotency_prune" {
				return
			}
		case <-time.After(15 * time.Second):
			t.Fatal("job idempotency_prune không hoàn thành trong 15s")
		}
	}
}
