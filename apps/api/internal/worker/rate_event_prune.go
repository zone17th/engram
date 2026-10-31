package worker

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

// RateEventPruneArgs là tham số của job xoá các bản ghi rate_event cũ hơn cửa sổ dài nhất.
// Window = 0 mặc định dùng httpx.MaxRateLimitWindow (15 phút).
type RateEventPruneArgs struct {
	Window time.Duration `json:"window,omitempty"`
}

func (RateEventPruneArgs) Kind() string { return "rate_event_prune" }

// RateEventPruneWorker xoá các bản ghi rate_event có at < now() - max_window.
type RateEventPruneWorker struct {
	river.WorkerDefaults[RateEventPruneArgs]
	pool *pgxpool.Pool
	clk  clock.Clock
}

func NewRateEventPruneWorker(pool *pgxpool.Pool, clk clock.Clock) *RateEventPruneWorker {
	if clk == nil {
		clk = clock.System{}
	}
	return &RateEventPruneWorker{pool: pool, clk: clk}
}

func (w *RateEventPruneWorker) Work(ctx context.Context, job *river.Job[RateEventPruneArgs]) error {
	window := httpx.MaxRateLimitWindow
	if job != nil && job.Args.Window > 0 {
		window = job.Args.Window
	}
	before := pgtype.Timestamptz{
		Time:  w.clk.Now().Add(-window).UTC(),
		Valid: true,
	}
	_, err := gen.New(w.pool).PruneRateEventsOlderThan(ctx, before)
	return err
}
