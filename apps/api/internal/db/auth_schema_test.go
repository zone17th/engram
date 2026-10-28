package db_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
)

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func isCheckViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23514"
}

func TestAuthMigrationCreatesTablesNotVault(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	conn := dbtest.Connect(t, dsn)

	for _, table := range []string{
		"app_user", "auth_identity", "session", "session_refresh_used",
		"auth_throttle", "email_verification", "oauth_transaction",
		"oauth_reauth_receipt", "audit_log", "user_notification",
	} {
		var n int
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, table).Scan(&n); err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
		if n != 1 {
			t.Errorf("thiếu bảng %s", table)
		}
	}
	for _, table := range []string{"vault", "vault_recovery_key", "vault_passkey"} {
		var n int
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, table).Scan(&n); err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
		if n != 0 {
			t.Errorf("không được tạo bảng vault %s ở P02", table)
		}
	}

	v, dirty, err := db.Version(dsn)
	if err != nil {
		t.Fatalf("Version: %v", err)
	}
	if dirty {
		t.Fatal("migration dirty")
	}
	if v < 4 {
		t.Fatalf("version = %d, muốn >= 4", v)
	}
}

func TestAuthMigrationDownOnEphemeralDB(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	if err := db.MigrateDown(dsn); err != nil {
		t.Fatalf("MigrateDown: %v", err)
	}
	conn := dbtest.Connect(t, dsn)
	var n int
	if err := conn.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.tables WHERE table_name = 'app_user'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("down phải xoá app_user trên DB test")
	}
}

func TestEmailUniqueAndIdentityChecks(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	q := gen.New(pool)

	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "A@Example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	if u.Email != "A@Example.com" && !strings.EqualFold(u.Email, "a@example.com") {
		t.Fatalf("email = %q", u.Email)
	}
	if _, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "a@example.com", Locale: "vi"}); !isUniqueViolation(err) {
		t.Fatalf("email citext phải unique, err=%v", err)
	}

	hash := "argon2id-placeholder"
	if _, err := q.InsertPasswordIdentity(ctx, gen.InsertPasswordIdentityParams{UserID: u.ID, PasswordHash: &hash}); err != nil {
		t.Fatalf("InsertPasswordIdentity: %v", err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO auth_identity (user_id, provider, provider_uid) VALUES ($1, 'password', 'x')`, u.ID)
	if !isCheckViolation(err) && !isUniqueViolation(err) {
		t.Fatalf("password + provider_uid phải bị CHECK/UNIQUE, err=%v", err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO auth_identity (user_id, provider, password_hash) VALUES ($1, 'google', 'hash')`, u.ID)
	if !isCheckViolation(err) {
		t.Fatalf("oauth + password_hash phải bị CHECK, err=%v", err)
	}
}

func TestConcurrentEmailInsertOneWins(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := gen.New(pool).InsertUser(ctx, gen.InsertUserParams{Email: "race@example.com", Locale: "en"})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	var ok, conflict int
	for err := range errs {
		if err == nil {
			ok++
			continue
		}
		if isUniqueViolation(err) {
			conflict++
			continue
		}
		t.Fatalf("lỗi không mong đợi: %v", err)
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("muốn 1 thành công + 1 unique, được ok=%d conflict=%d", ok, conflict)
	}
}

func TestSettingsJsonbSetKeepsOtherKeys(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	q := gen.New(pool)

	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "set@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE app_user SET settings = '{"semantic_suggest": true, "extra": 1}'::jsonb WHERE id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	got, err := q.UpdateUserSemanticSuggest(ctx, gen.UpdateUserSemanticSuggestParams{ID: u.ID, SemanticSuggest: false})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got.Settings), `"extra": 1`) && !strings.Contains(string(got.Settings), `"extra":1`) {
		t.Fatalf("jsonb_set làm mất key khác: %s", got.Settings)
	}
	if !strings.Contains(string(got.Settings), `"semantic_suggest": false`) && !strings.Contains(string(got.Settings), `"semantic_suggest":false`) {
		t.Fatalf("semantic_suggest không đổi: %s", got.Settings)
	}
}

func TestRefreshUsedUniqueAndTxRollback(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	q := gen.New(pool)

	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "sess@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	s, err := q.InsertSession(ctx, gen.InsertSessionParams{
		UserID:           u.ID,
		RefreshTokenHash: []byte("hash-current-aaaaaaaaaaaaaaaaaaaaaa"),
		ExpiresAt:        pgtype.Timestamptz{Time: time.Now().Add(30 * 24 * time.Hour), Valid: true},
	})
	if err != nil {
		t.Fatal(err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	qt := q.WithTx(tx)
	if err := qt.InsertRefreshUsed(ctx, gen.InsertRefreshUsedParams{
		TokenHash: []byte("old-hash-bbbbbbbbbbbbbbbbbbbbbbbbbb"),
		SessionID: s.ID,
		UsedAt:    pgtype.Timestamptz{Time: time.Now(), Valid: true},
	}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM session_refresh_used`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("rollback phải huỷ refresh used, n=%d", n)
	}

	if err := q.InsertRefreshUsed(ctx, gen.InsertRefreshUsedParams{
		TokenHash: []byte("old-hash-bbbbbbbbbbbbbbbbbbbbbbbbbb"),
		SessionID: s.ID,
		UsedAt:    pgtype.Timestamptz{Time: time.Now(), Valid: true},
	}); err != nil {
		t.Fatal(err)
	}
	if err := q.InsertRefreshUsed(ctx, gen.InsertRefreshUsedParams{
		TokenHash: []byte("old-hash-bbbbbbbbbbbbbbbbbbbbbbbbbb"),
		SessionID: s.ID,
		UsedAt:    pgtype.Timestamptz{Time: time.Now(), Valid: true},
	}); !isUniqueViolation(err) {
		t.Fatalf("hash used phải unique, err=%v", err)
	}
}

func TestConsumeVerificationOnceUnderLock(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	q := gen.New(pool)

	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "ver@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	tok, err := q.InsertEmailVerification(ctx, gen.InsertEmailVerificationParams{
		UserID:      u.ID,
		Purpose:     "signup",
		TargetEmail: "ver@example.com",
		TokenHash:   []byte("token-hash-cccccccccccccccccccccccc"),
		ExpiresAt:   pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true},
	})
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
			if err != nil {
				results <- err
				return
			}
			defer func() { _ = tx.Rollback(ctx) }()
			qt := q.WithTx(tx)
			if _, err := qt.GetEmailVerificationByHashForUpdate(ctx, tok.TokenHash); err != nil {
				results <- err
				return
			}
			_, err = qt.ConsumeEmailVerification(ctx, gen.ConsumeEmailVerificationParams{
				ID:         tok.ID,
				ConsumedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true},
			})
			if err != nil {
				results <- err
				_ = tx.Rollback(ctx)
				return
			}
			results <- tx.Commit(ctx)
		}()
	}
	wg.Wait()
	close(results)
	var commits, fails int
	for err := range results {
		if err == nil {
			commits++
			continue
		}
		fails++
	}
	if commits != 1 {
		t.Fatalf("chỉ một consume được commit, commits=%d fails=%d", commits, fails)
	}
	got, err := q.GetEmailVerificationByHash(ctx, tok.TokenHash)
	if err != nil {
		t.Fatal(err)
	}
	if !got.ConsumedAt.Valid {
		t.Fatal("token phải consumed")
	}
}
