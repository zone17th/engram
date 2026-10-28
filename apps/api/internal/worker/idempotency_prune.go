package worker

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
)

// IdempotencyPruneArgs là tham số job định kỳ xoá bản ghi idempotency_key đã hết hạn (`expires_at < now()`).
type IdempotencyPruneArgs struct{}

func (IdempotencyPruneArgs) Kind() string { return "idempotency_prune" }

// IdempotencyPruneWorker chạy câu lệnh PruneExpiredIdempotencyKeys trên Postgres.
type IdempotencyPruneWorker struct {
	river.WorkerDefaults[IdempotencyPruneArgs]
	pool *pgxpool.Pool
	clk  clock.Clock
}

func NewIdempotencyPruneWorker(pool *pgxpool.Pool, clk clock.Clock) *IdempotencyPruneWorker {
	if clk == nil {
		clk = clock.System{}
	}
	return &IdempotencyPruneWorker{pool: pool, clk: clk}
}

func (w *IdempotencyPruneWorker) Work(ctx context.Context, _ *river.Job[IdempotencyPruneArgs]) error {
	now := pgtype.Timestamptz{Time: w.clk.Now().UTC(), Valid: true}
	_, err := gen.New(w.pool).PruneExpiredIdempotencyKeys(ctx, now)
	return err
}
