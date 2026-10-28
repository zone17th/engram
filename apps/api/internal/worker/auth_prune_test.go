package worker_test

import (
	"context"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/secevent"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/worker"
)

func TestAuthPruneDeletesOldAudit(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	if _, err := pool.Exec(ctx, `INSERT INTO audit_log (event, result, created_at) VALUES ($1, $2, $3)`,
		secevent.EventLoginFailure, secevent.ResultFailure, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	w := worker.NewAuthPruneWorker(pool, clk)
	if err := w.Work(ctx, &river.Job[worker.AuthPruneArgs]{Args: worker.AuthPruneArgs{RetentionDays: 90}}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_log`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("prune phải xoá audit cũ, n=%d", n)
	}
	_ = gen.New(pool)
}
