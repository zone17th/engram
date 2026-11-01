package entry

import (
	"context"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
)

const (
	// DefaultContentPurgeBatchSize là số hàng tối đa xoá trong mỗi transaction lô của một user
	// (tương tự `DefaultIdempotencyPruneBatchSize`, plan mục 2.8, Task 7).
	DefaultContentPurgeBatchSize int32 = 500

	// DefaultContentPurgeMaxBatches là số lượt lặp tối đa trong một lần chạy `content_purge`
	// để tránh giữ tài nguyên vô hạn.
	DefaultContentPurgeMaxBatches = 100

	// DefaultContentPurgeMaxUsersPerRound là số user tối đa được quét trong mỗi vòng lặp purge.
	DefaultContentPurgeMaxUsersPerRound int32 = 100

	// ContentPurgeRetentionWindow là thời hạn giữ tombstone (`30 days`) trước khi xoá vĩnh viễn
	// (`deleted_at < now - 30 days`, plan mục 2.8, Task 7).
	ContentPurgeRetentionWindow = 30 * 24 * time.Hour
)

type purgeLockHeldHookKey struct{}

// WithPurgeLockHeldHook gắn một callback kiểm thử vào `ctx`: ngay sau khi một transaction
// lô purge đã giữ `LockUserContent(user_id)` và trước khi chạy các câu lệnh `DELETE`, nó gọi
// `fn(ctx, userID)`. Dùng cho các bài test barrier (Task 8 và Task 21b); trong production
// không có key này trong context nên hoàn toàn là no-op.
func WithPurgeLockHeldHook(ctx context.Context, fn func(ctx context.Context, userID uuid.UUID)) context.Context {
	return context.WithValue(ctx, purgeLockHeldHookKey{}, fn)
}

// PurgeResult ghi nhận tổng số hàng đã xoá vĩnh viễn trong một lượt `PurgeExpiredContent`.
type PurgeResult struct {
	EntriesDeleted int64
	ItemsDeleted   int64
	TagsDeleted    int64
}

// Total trả tổng số hàng (`entry` + `item` + `tag`) đã xoá trực tiếp bởi các câu lệnh batch
// (chưa tính các hàng con xoá theo `ON DELETE CASCADE`).
func (r PurgeResult) Total() int64 {
	return r.EntriesDeleted + r.ItemsDeleted + r.TagsDeleted
}

// PurgeExpiredContent xoá vĩnh viễn các tombstone (`entry`, `item`, `tag`) có `deleted_at < cutoff`
// theo từng lô mỗi user dưới `LockUserContent(user_id)` (plan mục 2.5, 2.8, Task 7).
//
// Hàm nhận `cutoff` tường minh để truyền trực tiếp vào SQL (không phụ thuộc `now()` của DB,
// cho phép test Task 7 và barrier test Task 8 điều khiển chính xác mốc `cutoff`).
// Mỗi lô mở một transaction riêng cho một `user_id`, lấy `LockUserContent(user_id)` (tuân thủ
// thứ tự khoá mục 2.5), xoá tối đa 500 hàng (`DefaultContentPurgeBatchSize`), rồi commit giải phóng khoá.
func PurgeExpiredContent(ctx context.Context, pool *pgxpool.Pool, cutoff time.Time) (PurgeResult, error) {
	return PurgeExpiredContentWithLimits(
		ctx,
		pool,
		cutoff,
		DefaultContentPurgeBatchSize,
		DefaultContentPurgeMaxBatches,
	)
}

// PurgeExpiredContentWithLimits thực thi `PurgeExpiredContent` với `batchSize` và `maxBatches` tuỳ chỉnh.
func PurgeExpiredContentWithLimits(
	ctx context.Context,
	pool *pgxpool.Pool,
	cutoff time.Time,
	batchSize int32,
	maxBatches int,
) (PurgeResult, error) {
	if batchSize <= 0 {
		batchSize = DefaultContentPurgeBatchSize
	}
	if maxBatches <= 0 {
		maxBatches = DefaultContentPurgeMaxBatches
	}

	cutoffTS := pgtype.Timestamptz{
		Time:  cutoff.UTC(),
		Valid: true,
	}
	q := gen.New(pool)
	var total PurgeResult

	for range maxBatches {
		users, err := listUsersWithPurgeableContent(ctx, q, cutoffTS, DefaultContentPurgeMaxUsersPerRound)
		if err != nil {
			return total, err
		}
		if len(users) == 0 {
			break
		}

		var roundDeleted int64
		for _, userID := range users {
			res, err := PurgeUserExpiredContentBatch(ctx, pool, userID, cutoff, batchSize)
			if err != nil {
				return total, err
			}
			total.EntriesDeleted += res.EntriesDeleted
			total.ItemsDeleted += res.ItemsDeleted
			total.TagsDeleted += res.TagsDeleted
			roundDeleted += res.Total()
		}
		if roundDeleted == 0 {
			break
		}
	}

	return total, nil
}

// PurgeUserExpiredContentBatch thực thi đúng MỘT transaction lô cho `userID`:
//   - Mở transaction, lấy `LockUserContent(userID)` (bước 2 thứ tự khoá toàn cục mục 2.5).
//   - Gọi hook kiểm thử `WithPurgeLockHeldHook` (nếu có).
//   - Xoá tối đa `batchSize` hàng tổng cộng có `deleted_at < cutoff` theo thứ tự:
//     (1) `PurgeExpiredEntriesByUserBatch`, (2) `PurgeExpiredItemsByUserBatch` (cascade `entry` / `item_tag`),
//     (3) `PurgeExpiredTagsByUserBatch` (cascade `item_tag`, giữ nguyên `item` sống).
//   - Commit để giải phóng `LockUserContent(userID)`.
func PurgeUserExpiredContentBatch(
	ctx context.Context,
	pool *pgxpool.Pool,
	userID uuid.UUID,
	cutoff time.Time,
	batchSize int32,
) (PurgeResult, error) {
	if batchSize <= 0 {
		batchSize = DefaultContentPurgeBatchSize
	}
	cutoffTS := pgtype.Timestamptz{
		Time:  cutoff.UTC(),
		Valid: true,
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return PurgeResult{}, err
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	qtx := gen.New(tx)
	if err := qtx.LockUserContent(ctx, userID); err != nil {
		return PurgeResult{}, err
	}

	if hook, ok := ctx.Value(purgeLockHeldHookKey{}).(func(ctx context.Context, userID uuid.UUID)); ok && hook != nil {
		hook(ctx, userID)
	}

	var res PurgeResult
	remaining := batchSize

	entriesDel, err := qtx.PurgeExpiredEntriesByUserBatch(ctx, gen.PurgeExpiredEntriesByUserBatchParams{
		UserID:     userID,
		Cutoff:     cutoffTS,
		BatchLimit: remaining,
	})
	if err != nil {
		return PurgeResult{}, err
	}
	res.EntriesDeleted = entriesDel
	remaining -= int32(entriesDel)

	if remaining > 0 {
		itemsDel, err := qtx.PurgeExpiredItemsByUserBatch(ctx, gen.PurgeExpiredItemsByUserBatchParams{
			UserID:     userID,
			Cutoff:     cutoffTS,
			BatchLimit: remaining,
		})
		if err != nil {
			return PurgeResult{}, err
		}
		res.ItemsDeleted = itemsDel
		remaining -= int32(itemsDel)
	}

	if remaining > 0 {
		tagsDel, err := qtx.PurgeExpiredTagsByUserBatch(ctx, gen.PurgeExpiredTagsByUserBatchParams{
			UserID:     userID,
			Cutoff:     cutoffTS,
			BatchLimit: remaining,
		})
		if err != nil {
			return PurgeResult{}, err
		}
		res.TagsDeleted = tagsDel
	}

	if err := tx.Commit(ctx); err != nil {
		return PurgeResult{}, err
	}
	return res, nil
}

func listUsersWithPurgeableContent(
	ctx context.Context,
	q *gen.Queries,
	cutoff pgtype.Timestamptz,
	maxUsers int32,
) ([]uuid.UUID, error) {
	entryUsers, err := q.ListUsersWithPurgeableEntries(ctx, gen.ListUsersWithPurgeableEntriesParams{
		Cutoff:   cutoff,
		MaxUsers: maxUsers,
	})
	if err != nil {
		return nil, err
	}
	itemUsers, err := q.ListUsersWithPurgeableItems(ctx, gen.ListUsersWithPurgeableItemsParams{
		Cutoff:   cutoff,
		MaxUsers: maxUsers,
	})
	if err != nil {
		return nil, err
	}
	tagUsers, err := q.ListUsersWithPurgeableTags(ctx, gen.ListUsersWithPurgeableTagsParams{
		Cutoff:   cutoff,
		MaxUsers: maxUsers,
	})
	if err != nil {
		return nil, err
	}

	seen := make(map[uuid.UUID]struct{}, len(entryUsers)+len(itemUsers)+len(tagUsers))
	out := make([]uuid.UUID, 0, len(entryUsers)+len(itemUsers)+len(tagUsers))
	for _, list := range [][]uuid.UUID{entryUsers, itemUsers, tagUsers} {
		for _, u := range list {
			if _, ok := seen[u]; !ok {
				seen[u] = struct{}{}
				out = append(out, u)
			}
		}
	}
	slices.SortFunc(out, func(a, b uuid.UUID) int {
		for i := range len(a) {
			if a[i] < b[i] {
				return -1
			}
			if a[i] > b[i] {
				return 1
			}
		}
		return 0
	})
	return out, nil
}

// ContentPurgeArgs là tham số của River job định kỳ `content_purge` (mỗi giờ, xoá vĩnh viễn
// các tombstone `entry`/`item`/`tag` có `deleted_at < now - 30 days` — plan mục 2.8, Task 7).
type ContentPurgeArgs struct {
	BatchSize  int32      `json:"batch_size,omitempty"`
	MaxBatches int        `json:"max_batches,omitempty"`
	Cutoff     *time.Time `json:"cutoff,omitempty"`
}

// Kind trả tên định danh `"content_purge"` của River job.
func (ContentPurgeArgs) Kind() string { return "content_purge" }

// ContentPurgeWorker thực thi River job `content_purge` theo lô 500 dưới `LockUserContent`.
type ContentPurgeWorker struct {
	river.WorkerDefaults[ContentPurgeArgs]
	pool *pgxpool.Pool
	clk  clock.Clock
}

// NewContentPurgeWorker khởi tạo `ContentPurgeWorker` với `pool` và đồng hồ `clk`
// (`clk == nil` mặc định dùng `clock.System{}`).
func NewContentPurgeWorker(pool *pgxpool.Pool, clk clock.Clock) *ContentPurgeWorker {
	if clk == nil {
		clk = clock.System{}
	}
	return &ContentPurgeWorker{
		pool: pool,
		clk:  clk,
	}
}

// Work chạy một lượt `PurgeExpiredContentWithLimits` với `cutoff = now - 30 days`
// (hoặc `job.Args.Cutoff` nếu được truyền tường minh).
func (w *ContentPurgeWorker) Work(ctx context.Context, job *river.Job[ContentPurgeArgs]) error {
	batchSize := DefaultContentPurgeBatchSize
	maxBatches := DefaultContentPurgeMaxBatches
	cutoff := w.clk.Now().UTC().Add(-ContentPurgeRetentionWindow)
	if job != nil {
		if job.Args.BatchSize > 0 {
			batchSize = job.Args.BatchSize
		}
		if job.Args.MaxBatches > 0 {
			maxBatches = job.Args.MaxBatches
		}
		if job.Args.Cutoff != nil && !job.Args.Cutoff.IsZero() {
			cutoff = job.Args.Cutoff.UTC()
		}
	}

	_, err := PurgeExpiredContentWithLimits(ctx, w.pool, cutoff, batchSize, maxBatches)
	return err
}
