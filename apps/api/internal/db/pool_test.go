package db_test

import (
	"context"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
)

func TestReadyCheckPassesOnLivePool(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)

	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	defer pool.Close()

	if err := db.ReadyCheck(pool)(ctx); err != nil {
		t.Fatalf("ReadyCheck: %v", err)
	}
}

func TestReadyCheckFailsOnClosedPool(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)

	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	pool.Close()

	if err := db.ReadyCheck(pool)(ctx); err == nil {
		t.Fatal("ReadyCheck muốn lỗi khi pool đã đóng, nhận nil")
	}
}
