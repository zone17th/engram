package worker

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
)

const (
	// DefaultIdempotencyPruneBatchSize là số hàng tối đa xóa trong mỗi câu lệnh DELETE theo lô (mục 2.3).
	DefaultIdempotencyPruneBatchSize int32 = 500

	// DefaultIdempotencyPruneMaxBatches là số lô tối đa trong một lần chạy worker để tránh giữ tài nguyên vô hạn.
	DefaultIdempotencyPruneMaxBatches = 100
)

// IdempotencyPruneArgs là tham số job định kỳ xoá bản ghi idempotency_key đã hết hạn (`expires_at < now()`).
type IdempotencyPruneArgs struct {
	BatchSize  int32 `json:"batch_size,omitempty"`
	MaxBatches int   `json:"max_batches,omitempty"`
}

func (IdempotencyPruneArgs) Kind() string { return "idempotency_prune" }

// IdempotencyPruneWorker chạy câu lệnh PruneExpiredIdempotencyKeysBatch theo lô giới hạn trên Postgres.
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

func (w *IdempotencyPruneWorker) Work(ctx context.Context, job *river.Job[IdempotencyPruneArgs]) error {
	batchSize := DefaultIdempotencyPruneBatchSize
	maxBatches := DefaultIdempotencyPruneMaxBatches
	if job != nil {
		if job.Args.BatchSize > 0 {
			batchSize = job.Args.BatchSize
		}
		if job.Args.MaxBatches > 0 {
			maxBatches = job.Args.MaxBatches
		}
	}

	now := pgtype.Timestamptz{Time: w.clk.Now().UTC(), Valid: true}
	q := gen.New(w.pool)
	for range maxBatches {
		deleted, err := q.PruneExpiredIdempotencyKeysBatch(ctx, gen.PruneExpiredIdempotencyKeysBatchParams{
			Now:        now,
			BatchLimit: batchSize,
		})
		if err != nil {
			return err
		}
		if deleted < int64(batchSize) {
			break
		}
	}
	return nil
}
