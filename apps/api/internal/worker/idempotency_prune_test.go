package worker_test

import (
	"bytes"
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
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

// BE2-2 / BE2-3: Khi một bản ghi hết hạn đang được ClaimIdempotencyKey tái chiếm (renew expires_at = now + 24h)
// nhưng transaction chưa commit, câu lệnh PruneExpiredIdempotencyKeysBatch chạy song song có thể nhìn thấy bản ghi cũ
// qua snapshot của subquery rồi chờ khóa hàng. Sau khi transaction tái chiếm commit, DELETE ngoài cùng phải kiểm tra lại
// expires_at < now để KHÔNG xóa mất bản ghi vừa được gia hạn.
func TestIdempotencyPruneBatchConcurrentReclaimSurvives(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	// Mở một pool riêng giới hạn đúng 1 kết nối cho worker prune để xác định chính xác PID backend của lệnh prune.
	pruneCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("ParseConfig prunePool: %v", err)
	}
	pruneCfg.MaxConns = 1
	pruneCfg.MinConns = 1
	prunePool, err := pgxpool.NewWithConfig(ctx, pruneCfg)
	if err != nil {
		t.Fatalf("NewWithConfig prunePool: %v", err)
	}
	t.Cleanup(prunePool.Close)

	var prunePID int32
	if err := prunePool.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&prunePID); err != nil {
		t.Fatalf("query prunePID: %v", err)
	}

	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(now)

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email, locale) VALUES ('idem-prune-race@example.com', 'en') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}

	const (
		reclaimedKey    = "idem_reclaimed_during_prune_01"
		otherExpiredKey = "idem_other_expired_during_prune_02"
	)
	oldOwner := uuid.New()
	oldHash := []byte{0x01, 0x02, 0x03}

	// Chèn 2 bản ghi đã hết hạn (< now):
	// - reclaimedKey: sẽ được ClaimIdempotencyKey gia hạn trong một transaction đang mở trước khi prune chạy.
	// - otherExpiredKey: không được gia hạn, phải bị xóa bởi cùng lô prune.
	for i, k := range []string{reclaimedKey, otherExpiredKey} {
		exp := now.Add(-time.Duration(10-i) * time.Second)
		if _, err := pool.Exec(ctx, `
			INSERT INTO idempotency_key (
				user_id, key, method, path, request_hash, status, owner_token,
				claimed_at, expires_at, status_code, response
			) VALUES ($1, $2, 'POST', '/api/v1/vault', $3, 'done', $4, $5, $6, 201, '{"version":1}'::jsonb)
		`, userID, k, oldHash, oldOwner, exp.Add(-24*time.Hour), exp); err != nil {
			t.Fatalf("seed expired key %q: %v", k, err)
		}
	}

	// Mở transaction trên kết nối thứ nhất để tái chiếm (renew) reclaimedKey nhưng chưa commit.
	renewTx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("BeginTx renewTx: %v", err)
	}
	defer func() { _ = renewTx.Rollback(ctx) }()

	var renewPID int32
	if err := renewTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&renewPID); err != nil {
		t.Fatalf("query renewPID: %v", err)
	}

	newOwner := uuid.New()
	newHash := []byte{0xaa, 0xbb, 0xcc, 0xdd}
	newPath := "/api/v1/vault/kek"
	nowTS := pgtype.Timestamptz{Time: now, Valid: true}
	claimedOwner, err := gen.New(renewTx).ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
		UserID:      userID,
		Key:         reclaimedKey,
		Method:      "PUT",
		Path:        newPath,
		RequestHash: newHash,
		OwnerToken:  newOwner,
		Now:         nowTS,
	})
	if err != nil {
		t.Fatalf("ClaimIdempotencyKey reclaim: %v", err)
	}
	if claimedOwner != newOwner {
		t.Fatalf("claimedOwner = %v, muốn %v", claimedOwner, newOwner)
	}

	// Khởi chạy worker prune trên kết nối thứ hai (prunePool, PID = prunePID).
	pruner := worker.NewIdempotencyPruneWorker(prunePool, clk)
	pruneJob := &river.Job[worker.IdempotencyPruneArgs]{
		Args: worker.IdempotencyPruneArgs{BatchSize: 10, MaxBatches: 1},
	}
	pruneErrCh := make(chan error, 1)
	go func() {
		pruneErrCh <- pruner.Work(ctx, pruneJob)
	}()

	// Chờ có giới hạn (bounded polling, không sleep mù) tới khi pg_stat_activity / pg_locks chứng minh
	// chính backend prunePID đang bị chặn bởi renewPID trên khóa của bảng idempotency_key.
	deadline := time.Now().Add(5 * time.Second)
	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM pg_stat_activity AS a
				JOIN pg_locks AS w ON w.pid = a.pid AND NOT w.granted
				WHERE a.datname = current_database()
				  AND a.pid = $1
				  AND $2 = ANY(pg_blocking_pids(a.pid))
				  AND EXISTS (
					SELECT 1
					FROM pg_locks AS rel
					WHERE rel.pid = a.pid
					  AND rel.relation = 'idempotency_key'::regclass
				  )
			)
		`, prunePID, renewPID).Scan(&blocked); err != nil {
			t.Fatalf("poll pg_stat_activity / pg_locks: %v", err)
		}
		if blocked {
			break
		}
		select {
		case err := <-pruneErrCh:
			t.Fatalf("prune kết thúc sớm trước khi thấy trạng thái chờ khóa hàng (err=%v)", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("timeout chờ prunePID=%d bị chặn bởi renewPID=%d trên khóa hàng idempotency_key", prunePID, renewPID)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Commit transaction gia hạn để giải phóng khóa hàng cho lệnh DELETE của prune.
	if err := renewTx.Commit(ctx); err != nil {
		t.Fatalf("Commit renewTx: %v", err)
	}

	select {
	case err := <-pruneErrCh:
		if err != nil {
			t.Fatalf("pruner.Work trả lỗi: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout chờ pruner.Work hoàn tất sau khi commit renewTx")
	}

	// Bản ghi hết hạn không được gia hạn (otherExpiredKey) phải đã bị xóa.
	var otherCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, userID, otherExpiredKey).Scan(&otherCount); err != nil {
		t.Fatalf("count otherExpiredKey: %v", err)
	}
	if otherCount != 0 {
		t.Fatalf("otherExpiredKey count = %d, muốn 0 (phải bị xóa bởi lô prune)", otherCount)
	}

	// Bản ghi vừa được gia hạn (reclaimedKey) PHẢI còn sống với đúng owner_token, request_hash, expires_at mới.
	var (
		gotMethod    string
		gotPath      string
		gotHash      []byte
		gotStatus    string
		gotOwner     uuid.UUID
		gotClaimedAt time.Time
		gotExpiresAt time.Time
	)
	if err := pool.QueryRow(ctx, `
		SELECT method, path, request_hash, status, owner_token, claimed_at, expires_at
		FROM idempotency_key
		WHERE user_id = $1 AND key = $2
	`, userID, reclaimedKey).Scan(
		&gotMethod,
		&gotPath,
		&gotHash,
		&gotStatus,
		&gotOwner,
		&gotClaimedAt,
		&gotExpiresAt,
	); err != nil {
		t.Fatalf("bản ghi đã được gia hạn bị xóa mất bởi batch prune (hoặc lỗi truy vấn): %v", err)
	}

	wantExpiresAt := now.Add(24 * time.Hour)
	if gotOwner != newOwner {
		t.Fatalf("owner_token = %v, muốn %v", gotOwner, newOwner)
	}
	if !bytes.Equal(gotHash, newHash) {
		t.Fatalf("request_hash = %x, muốn %x", gotHash, newHash)
	}
	if !gotClaimedAt.UTC().Equal(now) {
		t.Fatalf("claimed_at = %v, muốn %v", gotClaimedAt.UTC(), now)
	}
	if !gotExpiresAt.UTC().Equal(wantExpiresAt) {
		t.Fatalf("expires_at = %v, muốn %v", gotExpiresAt.UTC(), wantExpiresAt)
	}
	if gotMethod != "PUT" || gotPath != newPath || gotStatus != "in_progress" {
		t.Fatalf("method=%q path=%q status=%q, muốn PUT %q in_progress", gotMethod, gotPath, gotStatus, newPath)
	}

	// Xác nhận FinishIdempotencyKey với owner_token mới vẫn cập nhật thành công 1 hàng sang 'done'.
	updated, err := gen.New(pool).FinishIdempotencyKey(ctx, gen.FinishIdempotencyKeyParams{
		StatusCode: 200,
		Response:   []byte(`{"ok":true}`),
		UserID:     userID,
		Key:        reclaimedKey,
		OwnerToken: newOwner,
	})
	if err != nil {
		t.Fatalf("FinishIdempotencyKey sau khi prune: %v", err)
	}
	if updated != 1 {
		t.Fatalf("FinishIdempotencyKey updated = %d, muốn 1", updated)
	}
}
