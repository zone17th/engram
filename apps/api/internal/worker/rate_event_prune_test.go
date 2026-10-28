package worker_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/worker"
)

// TestRateEventPruneHonorsBoundaryAndIsIdempotent kiểm tra biên xoá rate_event
// cũ hơn cửa sổ dài nhất (15 phút):
//   - at < now - 15m -> bị xoá
//   - at == now - 15m -> giữ nguyên (PruneRateEventsOlderThan dùng at < before)
//   - at > now - 15m -> giữ nguyên
//
// Chạy lặp lại là idempotent.
func TestRateEventPruneHonorsBoundaryAndIsIdempotent(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(now)
	cutoff := now.Add(-httpx.MaxRateLimitWindow) // now - 15m

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email, locale) VALUES ($1, 'en') RETURNING id`, "rate-prune@example.com").Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	q := gen.New(pool)
	insertAt := func(scope string, at time.Time) int64 {
		t.Helper()
		ev, err := q.InsertRateEvent(ctx, gen.InsertRateEventParams{
			Scope:  scope,
			UserID: userID,
			At:     pgtype.Timestamptz{Time: at, Valid: true},
		})
		if err != nil {
			t.Fatalf("insert rate_event at %v: %v", at, err)
		}
		return ev.ID
	}

	// 2 bản ghi cũ hơn cửa sổ dài nhất (at < cutoff) -> phải bị xoá.
	old1 := insertAt(httpx.ScopeVaultRecoveryLookup, cutoff.Add(-10*time.Minute))
	old2 := insertAt(httpx.ScopeVaultPasskeyOptions, cutoff.Add(-time.Microsecond))

	// 1 bản ghi ngay tại biên (at == cutoff) và 2 bản ghi mới hơn (at > cutoff) -> phải giữ lại.
	exactBoundary := insertAt(httpx.ScopeVaultRecoveryLookup, cutoff)
	newer1 := insertAt(httpx.ScopeVaultRecoveryComplete, cutoff.Add(time.Second))
	newer2 := insertAt(httpx.ScopeVaultSensitive, now)

	pruner := worker.NewRateEventPruneWorker(pool, clk)
	job := &river.Job[worker.RateEventPruneArgs]{Args: worker.RateEventPruneArgs{}}
	if err := pruner.Work(ctx, job); err != nil {
		t.Fatalf("first prune Work: %v", err)
	}

	assertRemaining := func(step string) {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT id FROM rate_event ORDER BY id ASC`)
		if err != nil {
			t.Fatalf("%s query remaining: %v", step, err)
		}
		defer rows.Close()
		var got []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				t.Fatalf("%s scan id: %v", step, err)
			}
			got = append(got, id)
		}
		if err := rows.Err(); err != nil {
			t.Fatalf("%s rows err: %v", step, err)
		}
		want := []int64{exactBoundary, newer1, newer2}
		if len(got) != len(want) {
			t.Fatalf("%s remaining ids = %v (old1=%d, old2=%d), want %v", step, got, old1, old2, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("%s remaining[%d] = %d, want %d (all=%v)", step, i, got[i], want[i], got)
			}
		}
	}

	assertRemaining("after first prune")

	// Chạy lại cùng thời điểm: idempotent, không xoá thêm.
	if err := pruner.Work(ctx, job); err != nil {
		t.Fatalf("second prune Work: %v", err)
	}
	assertRemaining("after repeat prune")
	// Dịch đồng hồ thêm 1 microsecond (độ phân giải timestamptz của Postgres) -> bản ghi exactBoundary trở thành cũ hơn 15m và bị xoá.
	clk.Advance(time.Microsecond)
	if err := pruner.Work(ctx, job); err != nil {
		t.Fatalf("third prune Work after +1us: %v", err)
	}
	var countAfterAdvance int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM rate_event`).Scan(&countAfterAdvance); err != nil {
		t.Fatal(err)
	}
	if countAfterAdvance != 2 {
		t.Fatalf("count after +1us advance = %d, want 2 (newer1, newer2)", countAfterAdvance)
	}
}

func TestRateEventPruneJobRegisteredInRiverClient(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email, locale) VALUES ($1, 'en') RETURNING id`, "river-rate-prune@example.com").Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO rate_event (scope, user_id, at) VALUES ($1, $2, $3)`,
		httpx.ScopeVaultRecoveryLookup, userID, time.Now().UTC().Add(-time.Hour)); err != nil {
		t.Fatalf("insert old rate_event: %v", err)
	}

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

	if _, err := client.Insert(ctx, worker.RateEventPruneArgs{}, nil); err != nil {
		t.Fatalf("Insert RateEventPruneArgs: %v", err)
	}

	deadline := time.After(20 * time.Second)
	for {
		select {
		case ev := <-subscribeCh:
			if ev.Job.Kind == "rate_event_prune" {
				var n int
				if err := pool.QueryRow(ctx, `SELECT count(*) FROM rate_event WHERE user_id = $1`, userID).Scan(&n); err != nil {
					t.Fatal(err)
				}
				if n != 0 {
					t.Fatalf("rate_event cũ phải bị xoá sau khi River chạy job, got %d", n)
				}
				return
			}
		case <-deadline:
			t.Fatal("job rate_event_prune không hoàn thành trong 20s")
		}
	}
}
