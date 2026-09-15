// Package worker chạy job nền bằng River.
package worker

import (
	"context"
	"log/slog"

	"github.com/riverqueue/river"
)

// NoopArgs là job không làm gì. Tồn tại vì River từ chối Start khi Workers rỗng,
// và vì P01 cần chứng minh vòng đời insert → chạy → completed hoạt động.
// P05 thay bằng job embedding thật.
type NoopArgs struct{}

func (NoopArgs) Kind() string { return "noop" }

type NoopWorker struct {
	river.WorkerDefaults[NoopArgs]
	logger *slog.Logger
}

func (w *NoopWorker) Work(ctx context.Context, job *river.Job[NoopArgs]) error {
	w.logger.InfoContext(ctx, "job noop chạy", slog.Int64("job_id", job.ID))
	return nil
}
