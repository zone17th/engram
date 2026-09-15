package db_test

import (
	"context"
	"strings"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
)

func TestPreflightPassesAfterMigration(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}

	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	if err := db.Preflight(ctx, pool); err != nil {
		t.Fatalf("Preflight: %v", err)
	}
}

// Database chưa migrate phải làm process chết ngay với thông báo rõ ràng,
// thay vì chạy tiếp rồi lỗi khó hiểu ở query đầu tiên.
func TestPreflightFailsBeforeMigration(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)

	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	err = db.Preflight(ctx, pool)
	if err == nil {
		t.Fatal("Preflight muốn lỗi khi chưa migrate, nhận nil")
	}
	if !strings.Contains(err.Error(), "vector") {
		t.Errorf("thông báo lỗi nên nêu tên extension thiếu, nhận: %v", err)
	}
}
