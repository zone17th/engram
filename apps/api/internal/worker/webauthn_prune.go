package worker

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
)

const (
	// DefaultWebAuthnChallengePruneBatchSize là số hàng tối đa xoá trong mỗi câu lệnh DELETE theo lô
	// của job định kỳ dọn `webauthn_challenge` đã hết hạn (plan Task 13).
	DefaultWebAuthnChallengePruneBatchSize int32 = 500

	// DefaultWebAuthnChallengePruneMaxBatches là số lô tối đa trong một lần chạy worker
	// để tránh giữ tài nguyên vô hạn.
	DefaultWebAuthnChallengePruneMaxBatches = 100
)

const pruneExpiredWebAuthnChallengesBatchSQL = `
DELETE FROM webauthn_challenge
WHERE webauthn_challenge.expires_at < $1
  AND id IN (
    SELECT expired.id
    FROM webauthn_challenge AS expired
    WHERE expired.expires_at < $1
    ORDER BY expired.expires_at ASC
    LIMIT $2
  )`

// WebAuthnChallengePruneArgs là tham số của job định kỳ xoá các bản ghi `webauthn_challenge`
// đã hết hạn (`expires_at < now()`, plan Task 13).
type WebAuthnChallengePruneArgs struct {
	BatchSize  int32 `json:"batch_size,omitempty"`
	MaxBatches int   `json:"max_batches,omitempty"`
}

func (WebAuthnChallengePruneArgs) Kind() string { return "webauthn_challenge_prune" }

// WebAuthnPruneArgs là bí danh của WebAuthnChallengePruneArgs.
type WebAuthnPruneArgs = WebAuthnChallengePruneArgs

// WebAuthnChallengePruneWorker xoá các bản ghi `webauthn_challenge` đã hết hạn (`expires_at < now()`)
// theo lô giới hạn (`DefaultWebAuthnChallengePruneBatchSize` x `DefaultWebAuthnChallengePruneMaxBatches`), idempotent.
type WebAuthnChallengePruneWorker struct {
	river.WorkerDefaults[WebAuthnChallengePruneArgs]
	pool *pgxpool.Pool
	clk  clock.Clock
}

// WebAuthnPruneWorker là bí danh của WebAuthnChallengePruneWorker.
type WebAuthnPruneWorker = WebAuthnChallengePruneWorker

// NewWebAuthnChallengePruneWorker khởi tạo worker dọn `webauthn_challenge` hết hạn.
func NewWebAuthnChallengePruneWorker(pool *pgxpool.Pool, clk clock.Clock) *WebAuthnChallengePruneWorker {
	if clk == nil {
		clk = clock.System{}
	}
	return &WebAuthnChallengePruneWorker{pool: pool, clk: clk}
}

// NewWebAuthnPruneWorker là bí danh của NewWebAuthnChallengePruneWorker.
func NewWebAuthnPruneWorker(pool *pgxpool.Pool, clk clock.Clock) *WebAuthnChallengePruneWorker {
	return NewWebAuthnChallengePruneWorker(pool, clk)
}

// Work thực thi một lượt dọn các bản ghi `webauthn_challenge` có `expires_at < now()`.
func (w *WebAuthnChallengePruneWorker) Work(ctx context.Context, job *river.Job[WebAuthnChallengePruneArgs]) error {
	batchSize := DefaultWebAuthnChallengePruneBatchSize
	maxBatches := DefaultWebAuthnChallengePruneMaxBatches
	if job != nil {
		if job.Args.BatchSize > 0 {
			batchSize = job.Args.BatchSize
		}
		if job.Args.MaxBatches > 0 {
			maxBatches = job.Args.MaxBatches
		}
	}

	now := pgtype.Timestamptz{Time: w.clk.Now().UTC(), Valid: true}
	for range maxBatches {
		tag, err := w.pool.Exec(ctx, pruneExpiredWebAuthnChallengesBatchSQL, now, batchSize)
		if err != nil {
			return err
		}
		if tag.RowsAffected() < int64(batchSize) {
			break
		}
	}
	return nil
}
