package worker_test

import (
	"context"
	"fmt"
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

	// Kiểm tra xóa theo lô giới hạn (batching):
	// Chèn 7 hàng đã hết hạn (< now), 1 hàng đúng tại biên (== now), và 1 hàng ở tương lai (> now).
	// Với BatchSize=3, MaxBatches=1: một lần chạy chỉ xóa đúng 3 hàng hết hạn, còn lại 4 hàng hết hạn + 2 hàng chưa hết hạn (tổng 6).
	// Sau đó chạy tiếp với BatchSize=3, MaxBatches=5: vòng lặp xóa hết 4 hàng hết hạn còn lại (lô 3 + lô 1 < 3 rồi dừng),
	// giữ nguyên hàng ở biên và hàng tương lai (tổng 2).
	if _, err := pool.Exec(ctx, `DELETE FROM idempotency_key WHERE user_id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	curNow := clk.Now().UTC()
	for i := 1; i <= 7; i++ {
		k := fmt.Sprintf("batch_expired_key_%02d", i)
		exp := curNow.Add(-time.Duration(i) * time.Second)
		if _, err := pool.Exec(ctx, `
			INSERT INTO idempotency_key (
				user_id, key, method, path, request_hash, status, owner_token,
				claimed_at, expires_at, status_code, response
			) VALUES ($1, $2, 'POST', '/api/v1/vault', '\x01', 'done', $3, $4, $5, 201, '{"version":1}'::jsonb)
		`, userID, k, uuid.New(), curNow.Add(-24*time.Hour), exp); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []struct {
		key       string
		expiresAt time.Time
	}{
		{key: "batch_boundary_at_now", expiresAt: curNow},
		{key: "batch_future_after_now", expiresAt: curNow.Add(10 * time.Second)},
	} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO idempotency_key (
				user_id, key, method, path, request_hash, status, owner_token,
				claimed_at, expires_at, status_code, response
			) VALUES ($1, $2, 'POST', '/api/v1/vault', '\x01', 'done', $3, $4, $5, 201, '{"version":1}'::jsonb)
		`, userID, row.key, uuid.New(), curNow.Add(-24*time.Hour), row.expiresAt); err != nil {
			t.Fatal(err)
		}
	}

	// Lần chạy giới hạn 1 lô (BatchSize=3, MaxBatches=1): chỉ xóa tối đa 3 hàng.
	oneBatchJob := &river.Job[worker.IdempotencyPruneArgs]{
		Args: worker.IdempotencyPruneArgs{BatchSize: 3, MaxBatches: 1},
	}
	if err := pruner.Work(ctx, oneBatchJob); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1`, userID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 6 {
		t.Fatalf("sau 1 lô BatchSize=3: còn %d hàng, muốn 6 (4 expired + 1 boundary + 1 future)", count)
	}

	// Lần chạy tiếp theo với BatchSize=3, MaxBatches=5: vét sạch 4 hàng hết hạn còn lại qua 2 lô (3 + 1),
	// giữ nguyên 2 hàng ở biên và tương lai.
	drainJob := &river.Job[worker.IdempotencyPruneArgs]{
		Args: worker.IdempotencyPruneArgs{BatchSize: 3, MaxBatches: 5},
	}
	if err := pruner.Work(ctx, drainJob); err != nil {
		t.Fatal(err)
	}
	r2, err := pool.Query(ctx, `SELECT key FROM idempotency_key WHERE user_id = $1 ORDER BY key ASC`, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer r2.Close()
	var survivors []string
	for r2.Next() {
		var k string
		if err := r2.Scan(&k); err != nil {
			t.Fatal(err)
		}
		survivors = append(survivors, k)
	}
	if len(survivors) != 2 || survivors[0] != "batch_boundary_at_now" || survivors[1] != "batch_future_after_now" {
		t.Fatalf("sau khi drain các lô: còn %v, muốn [batch_boundary_at_now batch_future_after_now]", survivors)
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
