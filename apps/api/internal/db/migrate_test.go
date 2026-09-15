package db_test

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
)

// startPostgres dựng Postgres có pgvector. Image phải là bản pgvector, không phải
// postgres:16 thuần — extension vector không có sẵn trong image chính thức.
func startPostgres(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("bỏ qua test cần Docker ở chế độ -short")
	}
	ctx := context.Background()
	c, err := tcpostgres.Run(ctx, "pgvector/pgvector:pg16",
		tcpostgres.WithDatabase("engram"),
		tcpostgres.WithUsername("engram"),
		tcpostgres.WithPassword("engram"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(90*time.Second)),
	)
	if err != nil {
		t.Fatalf("khởi động Postgres: %v", err)
	}
	t.Cleanup(func() { _ = testcontainers.TerminateContainer(c) })

	dsn, err := c.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("lấy DSN: %v", err)
	}
	return dsn
}

func TestMigrateUpInstallsExtensions(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)

	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)

	for _, ext := range []string{"vector", "pg_trgm", "unaccent", "citext", "pgcrypto"} {
		var n int
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM pg_extension WHERE extname = $1`, ext).Scan(&n); err != nil {
			t.Fatalf("query pg_extension: %v", err)
		}
		if n != 1 {
			t.Errorf("extension %q chưa được cài", ext)
		}
	}
}

func TestPgvectorMeetsVersionFloor(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)

	var version string
	if err := conn.QueryRow(ctx, `SELECT extversion FROM pg_extension WHERE extname = 'vector'`).Scan(&version); err != nil {
		t.Fatalf("đọc extversion: %v", err)
	}
	major, minor := parseVersion(t, version)
	// Sàn spec là 0.8 → major 0 phải có minor >= 8; major >= 1 luôn đạt.
	if major == 0 && minor < 8 {
		t.Fatalf("pgvector = %s, spec yêu cầu >= 0.8", version)
	}
}

// parseVersion tách "0.8.1" thành (0, 8). PHẢI so sánh bằng số: so chuỗi thì
// "0.10" < "0.8" (lexical), tức bản mới hơn lại bị coi là không đạt sàn.
// Cùng logic với checkPgvectorFloor ở Task 7 — bản đó là runtime preflight,
// bản này là test, cố ý không chia sẻ code vì Task 4 chạy trước Task 7.
func parseVersion(t *testing.T, version string) (int, int) {
	t.Helper()
	parts := strings.SplitN(version, ".", 3)
	if len(parts) < 2 {
		t.Fatalf("không đọc được version pgvector: %q", version)
	}
	major, err1 := strconv.Atoi(parts[0])
	minor, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		t.Fatalf("version pgvector không hợp lệ: %q", version)
	}
	return major, minor
}

// immutable_unaccent phải IMMUTABLE thì mới dùng được trong index biểu thức.
func TestImmutableUnaccentIsImmutable(t *testing.T) {
	ctx := context.Background()
	dsn := startPostgres(t)
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)

	var volatile string
	if err := conn.QueryRow(ctx,
		`SELECT provolatile::text FROM pg_proc WHERE proname = 'immutable_unaccent'`).Scan(&volatile); err != nil {
		t.Fatalf("đọc pg_proc: %v", err)
	}
	if volatile != "i" {
		t.Fatalf("provolatile = %q, muốn \"i\" (immutable)", volatile)
	}

	var got string
	if err := conn.QueryRow(ctx, `SELECT immutable_unaccent('Tiếng Việt')`).Scan(&got); err != nil {
		t.Fatalf("gọi immutable_unaccent: %v", err)
	}
	if got != "Tieng Viet" {
		t.Errorf("immutable_unaccent('Tiếng Việt') = %q, muốn \"Tieng Viet\"", got)
	}
}
