// Package dbtest dựng Postgres 16 + pgvector cho integration test.
package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
)

// StartPostgres chạy container pgvector/pg16. Bỏ qua khi -short.
// TEST_DATABASE_URL: tạo database tạm trên cluster có sẵn (không cần Docker).
func StartPostgres(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("bỏ qua test cần Docker ở chế độ -short")
	}
	if dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL")); dsn != "" {
		return startEphemeralDB(t, dsn)
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

// MigrateUp chạy toàn bộ migration trên DSN test.
func MigrateUp(t *testing.T, dsn string) {
	t.Helper()
	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
}

// Connect mở một kết nối pgx.
func Connect(t *testing.T, dsn string) *pgx.Conn {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() {
		if err := conn.Close(ctx); err != nil {
			t.Errorf("đóng kết nối: %v", err)
		}
	})
	return conn
}

// Pool mở pgxpool cho test: MinConns=0 và statement_timeout để Close không treo 15 phút.
func Pool(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}
	cfg.MaxConns = 8
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "15000"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("NewPool: %v", err)
	}
	t.Cleanup(func() {
		done := make(chan struct{})
		go func() {
			pool.Close()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(8 * time.Second):
			t.Error("pgxpool.Close treo — còn connection chưa trả")
		}
	})
	return pool
}

func startEphemeralDB(t *testing.T, baseDSN string) string {
	t.Helper()
	u, err := url.Parse(baseDSN)
	if err != nil {
		t.Fatalf("TEST_DATABASE_URL: %v", err)
	}
	var nonce [6]byte
	_, _ = rand.Read(nonce[:])
	name := "engram_t_" + hex.EncodeToString(nonce[:])
	admin := *u
	if admin.Path == "" || admin.Path == "/" {
		admin.Path = "/postgres"
	} else {
		admin.Path = "/postgres"
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin.String())
	if err != nil {
		t.Fatalf("nối TEST_DATABASE_URL: %v", err)
	}
	if _, err := conn.Exec(ctx, `CREATE DATABASE `+pgQuoteIdent(name)); err != nil {
		_ = conn.Close(ctx)
		t.Fatalf("CREATE DATABASE: %v", err)
	}
	_ = conn.Close(ctx)
	u.Path = "/" + name
	dsn := u.String()
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), admin.String())
		if err != nil {
			return
		}
		defer func() {
			if err := c.Close(context.Background()); err != nil {
				t.Errorf("đóng kết nối cleanup: %v", err)
			}
		}()
		_, _ = c.Exec(context.Background(), `DROP DATABASE IF EXISTS `+pgQuoteIdent(name)+` WITH (FORCE)`)
	})
	return dsn
}

func pgQuoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}
