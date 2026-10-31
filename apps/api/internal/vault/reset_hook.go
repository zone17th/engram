package vault

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ResetHook là điểm nối xoá dữ liệu phụ thuộc vault trong cùng transaction của `DELETE /vault`
// (plan mục 1, mục 7, Task 8, Task 12).
// Ở P03 chưa có bảng `entry` nên mặc định dùng `NoopResetHook`; P04 truyền implementation
// xoá mọi entry (kể cả soft-delete) của user trong cùng transaction `tx` (giữ nguyên `item` và `tag`).
// Nếu `ResetHook` trả về lỗi khác nil, toàn bộ transaction `DELETE /vault` được rollback.
type ResetHook func(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error

// NoopResetHook là implementation mặc định ở P03 (không làm gì, trả nil).
func NoopResetHook(_ context.Context, _ pgx.Tx, _ uuid.UUID) error {
	return nil
}
