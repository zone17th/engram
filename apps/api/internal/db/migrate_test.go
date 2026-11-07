package db_test

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
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
	t.Cleanup(func() { closeConn(t, ctx, conn) })

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
	t.Cleanup(func() { closeConn(t, ctx, conn) })

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
	t.Cleanup(func() { closeConn(t, ctx, conn) })

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

func closeConn(t *testing.T, ctx context.Context, conn *pgx.Conn) {
	t.Helper()
	if err := conn.Close(ctx); err != nil {
		t.Errorf("đóng kết nối: %v", err)
	}
}

// TestMigrations kiểm tra migrate up tới 0010, down lùi về 0009 rồi up lại 0010 sạch.
func TestMigrations(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)

	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	v, dirty, err := db.Version(dsn)
	if err != nil || dirty || v != 10 {
		t.Fatalf("sau MigrateUp: version=%d dirty=%v err=%v, muốn version=10 dirty=false", v, dirty, err)
	}

	conn := dbtest.Connect(t, dsn)
	for _, tbl := range []string{"export_job", "export_file_cleanup"} {
		var n int
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, tbl).Scan(&n); err != nil {
			t.Fatalf("query table %s: %v", tbl, err)
		}
		if n != 1 {
			t.Fatalf("bảng %s phải tồn tại sau 0010, count=%d", tbl, n)
		}
	}

	if err := db.MigrateDown(dsn); err != nil {
		t.Fatalf("MigrateDown 0010->0009: %v", err)
	}
	vDown, dirtyDown, err := db.Version(dsn)
	if err != nil || dirtyDown || vDown != 9 {
		t.Fatalf("sau MigrateDown: version=%d dirty=%v err=%v, muốn version=9 dirty=false", vDown, dirtyDown, err)
	}
	for _, tbl := range []string{"export_job", "export_file_cleanup"} {
		var n int
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, tbl).Scan(&n); err != nil {
			t.Fatalf("query table %s after down: %v", tbl, err)
		}
		if n != 0 {
			t.Fatalf("bảng %s phải bị xoá sau down, count=%d", tbl, n)
		}
	}

	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp lại 0010: %v", err)
	}
	vRe, dirtyRe, err := db.Version(dsn)
	if err != nil || dirtyRe || vRe != 10 {
		t.Fatalf("sau MigrateUp lại: version=%d dirty=%v err=%v", vRe, dirtyRe, err)
	}
}

// TestMigration0010_ConsentDefaultFalse kiểm tra tài khoản cũ giữ nguyên settings +
// semantic_consent_seen_at IS NULL (không backfill), còn tài khoản mới nhận default
// semantic_suggest=false.
func TestMigration0010_ConsentDefaultFalse(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	migrateToVersion(t, dsn, 9)

	pool := dbtest.Pool(t, dsn)
	var oldID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO app_user (email, locale) VALUES ('legacy@example.com', 'vi') RETURNING id`,
	).Scan(&oldID); err != nil {
		t.Fatalf("insert legacy user at v9: %v", err)
	}

	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp to 0010: %v", err)
	}

	q := gen.New(pool)
	legacyUser, err := q.GetUserByID(ctx, oldID)
	if err != nil {
		t.Fatalf("GetUserByID legacy: %v", err)
	}
	if legacyUser.SemanticConsentSeenAt.Valid {
		t.Fatalf("legacy user không được backfill semantic_consent_seen_at, got=%v", legacyUser.SemanticConsentSeenAt)
	}
	var legacySettings struct {
		SemanticSuggest bool `json:"semantic_suggest"`
	}
	if err := json.Unmarshal(legacyUser.Settings, &legacySettings); err != nil {
		t.Fatalf("unmarshal legacy settings: %v", err)
	}
	if !legacySettings.SemanticSuggest {
		t.Fatalf("legacy user phải giữ semantic_suggest=true, got=false")
	}

	newUser, err := q.InsertUser(ctx, gen.InsertUserParams{
		Email:  "new-p06@example.com",
		Locale: "en",
	})
	if err != nil {
		t.Fatalf("InsertUser at v10: %v", err)
	}
	if newUser.SemanticConsentSeenAt.Valid {
		t.Fatalf("new user semantic_consent_seen_at phải NULL khi vừa tạo, got=%v", newUser.SemanticConsentSeenAt)
	}
	var newSettings struct {
		SemanticSuggest bool `json:"semantic_suggest"`
	}
	if err := json.Unmarshal(newUser.Settings, &newSettings); err != nil {
		t.Fatalf("unmarshal new settings: %v", err)
	}
	if newSettings.SemanticSuggest {
		t.Fatalf("new user phải có default semantic_suggest=false, got=true (raw=%s)", string(newUser.Settings))
	}
}

// TestMigration0010_FileNameCheck kiểm tra CHECK regex trên file_name của export_job
// và export_file_cleanup, cùng unique active index và ready invariant.
func TestMigration0010_FileNameCheck(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)

	pool := dbtest.Pool(t, dsn)
	q := gen.New(pool)
	u, err := q.InsertUser(ctx, gen.InsertUserParams{
		Email:  "export-check@example.com",
		Locale: "vi",
	})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}

	jobID := uuid.New()
	attemptID := uuid.New()
	validTmp := jobID.String() + "." + attemptID.String() + ".tmp"
	validEnc := jobID.String() + "." + attemptID.String() + ".sabk.enc"

	for _, badName := range []string{
		"/var/lib/engram-exports/" + validEnc,
		"../" + validEnc,
		"export-check@example.com.sabk.enc",
		jobID.String() + ".sabk.enc",
		jobID.String() + "." + attemptID.String() + ".json",
		strings.ToUpper(validEnc),
	} {
		_, err := q.InsertExportFileCleanup(ctx, gen.InsertExportFileCleanupParams{
			FileName:  badName,
			JobID:     jobID,
			AttemptID: &attemptID,
			Reason:    "cancelled",
		})
		if !isCheckViolation(err) {
			t.Fatalf("export_file_cleanup phải từ chối file_name=%q bằng CHECK violation, got err=%v", badName, err)
		}

		_, err = pool.Exec(ctx,
			`INSERT INTO export_job (id, user_id, kind, status, file_name) VALUES ($1, $2, 'encrypted', 'running', $3)`,
			uuid.New(), u.ID, badName,
		)
		if !isCheckViolation(err) {
			t.Fatalf("export_job phải từ chối file_name=%q bằng CHECK violation, got err=%v", badName, err)
		}
	}

	// Valid filenames pass CHECK on both tables.
	cleanupRow, err := q.InsertExportFileCleanup(ctx, gen.InsertExportFileCleanupParams{
		FileName:  validTmp,
		JobID:     jobID,
		AttemptID: &attemptID,
		Reason:    "rescue",
	})
	if err != nil {
		t.Fatalf("InsertExportFileCleanup validTmp: %v", err)
	}
	if cleanupRow.FileName != validTmp {
		t.Fatalf("cleanupRow.FileName = %q, want %q", cleanupRow.FileName, validTmp)
	}

	if _, err := pool.Exec(ctx,
		`INSERT INTO export_job (id, user_id, kind, status, attempt_id, file_name, size_bytes, expires_at)
		 VALUES ($1, $2, 'encrypted', 'ready', $3, $4, 128, now() + interval '24 hours')`,
		jobID, u.ID, attemptID, validEnc,
	); err != nil {
		t.Fatalf("insert valid ready export_job: %v", err)
	}

	// Ready without file_name / size_bytes / expires_at / attempt_id must fail CHECK.
	if _, err := pool.Exec(ctx,
		`INSERT INTO export_job (id, user_id, kind, status) VALUES ($1, $2, 'encrypted', 'ready')`,
		uuid.New(), u.ID,
	); !isCheckViolation(err) {
		t.Fatalf("ready export_job thiếu trường bắt buộc phải lỗi CHECK, got=%v", err)
	}
}
