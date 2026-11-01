package db_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/migrations"
)

func migrateToVersion(t *testing.T, dsn string, target uint) {
	t.Helper()
	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		t.Fatalf("iofs.New: %v", err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, dsn)
	if err != nil {
		t.Fatalf("migrate.NewWithSourceInstance: %v", err)
	}
	defer func() {
		srcErr, dbErr := m.Close()
		if err := errors.Join(srcErr, dbErr); err != nil {
			t.Errorf("close migrator: %v", err)
		}
	}()
	if err := m.Migrate(target); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		t.Fatalf("Migrate(%d): %v", target, err)
	}
}

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
	migrateToVersion(t, dsn, 4)
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
	if v != 4 {
		t.Fatalf("version = %d, muốn = 4", v)
	}
}

func TestAuthMigrationDownOnEphemeralDB(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	migrateToVersion(t, dsn, 4)
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

func TestVaultMigration0005TablesConstraintsAndDown(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)

	v, dirty, err := db.Version(dsn)
	if err != nil {
		t.Fatalf("Version: %v", err)
	}
	if dirty || v != 5 {
		t.Fatalf("version = %d dirty = %v, muốn version = 5 dirty = false", v, dirty)
	}

	pool := dbtest.Pool(t, dsn)
	q := gen.New(pool)

	vaultTables := []string{
		"vault", "vault_recovery_key", "vault_passkey",
		"webauthn_challenge", "idempotency_key", "rate_event",
	}
	for _, table := range vaultTables {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, table).Scan(&n); err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
		if n != 1 {
			t.Fatalf("thiếu bảng %s ở migration 0005", table)
		}
	}

	// Không có cột used_at trên vault_recovery_key (consume = DELETE).
	var usedAtCols int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_name = 'vault_recovery_key' AND column_name = 'used_at'`).Scan(&usedAtCols); err != nil {
		t.Fatal(err)
	}
	if usedAtCols != 0 {
		t.Fatalf("vault_recovery_key không được có cột used_at, count=%d", usedAtCols)
	}

	// Kiểm index (user_id, path) trên idempotency_key.
	var idxCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE tablename = 'idempotency_key' AND indexname = 'idempotency_key_user_path_idx'`).Scan(&idxCount); err != nil {
		t.Fatal(err)
	}
	if idxCount != 1 {
		t.Fatalf("thiếu index idempotency_key_user_path_idx, count=%d", idxCount)
	}

	u1, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "v1@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser u1: %v", err)
	}
	u2, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "v2@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser u2: %v", err)
	}

	kdfJSON := []byte(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"AAAAAAAAAAAAAAAAAAAAAA"}`)
	if _, err := q.InsertVault(ctx, gen.InsertVaultParams{
		UserID:               u1.ID,
		Kdf:                  kdfJSON,
		VaultKeyID:           "vk:AAAAAAAAAAAAAAAAAAAAAA",
		VaultKeyWrappedByKek: make([]byte, 73),
		X25519Public:         make([]byte, 32),
		Ed25519Public:        make([]byte, 32),
		PrivateKeysWrapped:   make([]byte, 105),
	}); err != nil {
		t.Fatalf("InsertVault u1: %v", err)
	}
	if _, err := q.InsertVault(ctx, gen.InsertVaultParams{
		UserID:               u2.ID,
		Kdf:                  kdfJSON,
		VaultKeyID:           "vk:BBBBBBBBBBBBBBBBBBBBBB",
		VaultKeyWrappedByKek: make([]byte, 73),
		X25519Public:         make([]byte, 32),
		Ed25519Public:        make([]byte, 32),
		PrivateKeysWrapped:   make([]byte, 105),
	}); err != nil {
		t.Fatalf("InsertVault u2: %v", err)
	}

	// RK slot CHECK (1..10), UNIQUE(vault_id, slot), và lookup_hash UNIQUE toàn cục.
	hash1 := []byte("rk-lookup-hash-00000000000000001")
	hash2 := []byte("rk-lookup-hash-00000000000000002")
	if _, err := q.InsertRecoveryKey(ctx, gen.InsertRecoveryKeyParams{
		UserID: u1.ID, Slot: 1, LookupHash: hash1, Wrap: make([]byte, 73),
	}); err != nil {
		t.Fatalf("InsertRecoveryKey: %v", err)
	}
	if _, err := q.InsertRecoveryKey(ctx, gen.InsertRecoveryKeyParams{
		UserID: u1.ID, Slot: 1, LookupHash: hash2, Wrap: make([]byte, 73),
	}); !isUniqueViolation(err) {
		t.Fatalf("UNIQUE(vault_id, slot) phải chặn trùng slot, err=%v", err)
	}
	if _, err := q.InsertRecoveryKey(ctx, gen.InsertRecoveryKeyParams{
		UserID: u2.ID, Slot: 1, LookupHash: hash1, Wrap: make([]byte, 73),
	}); !isUniqueViolation(err) {
		t.Fatalf("lookup_hash UNIQUE toàn cục phải chặn trùng giữa 2 vault, err=%v", err)
	}
	if _, err := q.InsertRecoveryKey(ctx, gen.InsertRecoveryKeyParams{
		UserID: u1.ID, Slot: 11, LookupHash: hash2, Wrap: make([]byte, 73),
	}); !isCheckViolation(err) {
		t.Fatalf("slot 11 phải bị CHECK (slot BETWEEN 1 AND 10), err=%v", err)
	}

	// cred_id UNIQUE toàn cục trên vault_passkey.
	credID := []byte("cred-id-global-unique-0001")
	if _, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID: u1.ID, CredID: credID, Pubkey: []byte{1}, PrfSalt: make([]byte, 32), VkWrap: make([]byte, 73), Name: "Key 1",
	}); err != nil {
		t.Fatalf("InsertPasskey u1: %v", err)
	}
	if _, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID: u2.ID, CredID: credID, Pubkey: []byte{1}, PrfSalt: make([]byte, 32), VkWrap: make([]byte, 73), Name: "Key 2",
	}); !isUniqueViolation(err) {
		t.Fatalf("cred_id UNIQUE toàn cục phải chặn trùng, err=%v", err)
	}
	if _, err := q.InsertRecoveryKey(ctx, gen.InsertRecoveryKeyParams{
		UserID: u2.ID, Slot: 1, LookupHash: hash2, Wrap: make([]byte, 73),
	}); err != nil {
		t.Fatalf("InsertRecoveryKey u2: %v", err)
	}
	if _, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID: u2.ID, CredID: []byte("cred-id-global-unique-0002"), Pubkey: []byte{1}, PrfSalt: make([]byte, 32), VkWrap: make([]byte, 73), Name: "Key 2",
	}); err != nil {
		t.Fatalf("InsertPasskey u2: %v", err)
	}

	// FK ON DELETE CASCADE: xoá vault u1 xoá cả RK và passkey của u1, giữ nguyên của u2.
	if _, err := q.DeleteVaultByUser(ctx, u1.ID); err != nil {
		t.Fatalf("DeleteVaultByUser: %v", err)
	}
	rkCount, err := q.CountRecoveryKeysByUser(ctx, u1.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rkCount != 0 {
		t.Fatalf("xoá vault phải cascade xoá RK, còn %d", rkCount)
	}
	pkU1, err := q.ListPasskeysByUser(ctx, u1.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(pkU1) != 0 {
		t.Fatalf("xoá vault phải cascade xoá passkey, còn %d", len(pkU1))
	}
	rkCountU2, err := q.CountRecoveryKeysByUser(ctx, u2.ID)
	if err != nil {
		t.Fatal(err)
	}
	if rkCountU2 != 1 {
		t.Fatalf("RK của u2 phải còn nguyên, còn %d", rkCountU2)
	}
	pkU2, err := q.ListPasskeysByUser(ctx, u2.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(pkU2) != 1 {
		t.Fatalf("passkey của u2 phải còn nguyên, còn %d", len(pkU2))
	}

	// Down 5 -> 4 xoá 6 bảng 0005 nhưng giữ bảng P02; up lại lên 5 thành công.
	if err := db.MigrateDown(dsn); err != nil {
		t.Fatalf("MigrateDown 5->4: %v", err)
	}
	for _, table := range vaultTables {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("down 0005 phải xoá bảng %s", table)
		}
	}
	var appUserTable int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = 'app_user'`).Scan(&appUserTable); err != nil {
		t.Fatal(err)
	}
	if appUserTable != 1 {
		t.Fatal("down 0005 không được xoá bảng app_user của P02")
	}
	dbtest.MigrateUp(t, dsn)
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

func TestVaultIdempotencyAndRateLimitQueries(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	q := gen.New(pool)

	u1, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "q1@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	u2, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "q2@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}

	// 1. Insert vault + 10 RK trong cùng một pgx.Tx.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qt := q.WithTx(tx)

	kdf1 := []byte(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"1111111111111111111111"}`)
	v, err := qt.InsertVault(ctx, gen.InsertVaultParams{
		UserID:               u1.ID,
		Kdf:                  kdf1,
		VaultKeyID:           "vk:1111111111111111111111",
		VaultKeyWrappedByKek: make([]byte, 73),
		X25519Public:         make([]byte, 32),
		Ed25519Public:        make([]byte, 32),
		PrivateKeysWrapped:   make([]byte, 105),
	})
	if err != nil {
		t.Fatalf("InsertVault: %v", err)
	}
	if v.Version != 1 {
		t.Fatalf("version = %d, muốn 1", v.Version)
	}
	for slot := int32(1); slot <= 10; slot++ {
		h := make([]byte, 32)
		h[0] = byte(slot)
		if _, err := qt.InsertRecoveryKey(ctx, gen.InsertRecoveryKeyParams{
			UserID: u1.ID, Slot: slot, LookupHash: h, Wrap: make([]byte, 73),
		}); err != nil {
			t.Fatalf("InsertRecoveryKey slot %d: %v", slot, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// 2. Lookup RK theo user + hash (không tìm thấy nếu khác user), consume = DELETE, rewrap có điều kiện version.
	h1 := make([]byte, 32)
	h1[0] = 1
	if _, err := q.GetRecoveryKeyByUserAndHash(ctx, gen.GetRecoveryKeyByUserAndHashParams{
		UserID: u2.ID, LookupHash: h1,
	}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("lookup RK với user khác phải trả ErrNoRows, err=%v", err)
	}
	rk1, err := q.GetRecoveryKeyByUserAndHash(ctx, gen.GetRecoveryKeyByUserAndHashParams{
		UserID: u1.ID, LookupHash: h1,
	})
	if err != nil {
		t.Fatalf("GetRecoveryKeyByUserAndHash: %v", err)
	}
	consumed, err := q.ConsumeRecoveryKeyByID(ctx, gen.ConsumeRecoveryKeyByIDParams{
		UserID: u1.ID, ID: rk1.ID,
	})
	if err != nil || consumed != 1 {
		t.Fatalf("ConsumeRecoveryKeyByID consumed=%d err=%v", consumed, err)
	}
	rem, err := q.CountRecoveryKeysByUser(ctx, u1.ID)
	if err != nil || rem != 9 {
		t.Fatalf("CountRecoveryKeysByUser rem=%d err=%v", rem, err)
	}

	// Rewrap với version sai phải trả ErrNoRows; version đúng tăng lên 2.
	kdf2 := []byte(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"2222222222222222222222"}`)
	if _, err := q.RewrapVaultKEK(ctx, gen.RewrapVaultKEKParams{
		UserID: u1.ID, ExpectedVersion: 99, Kdf: kdf2, VaultKeyWrappedByKek: make([]byte, 73),
	}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("RewrapVaultKEK version sai phải ErrNoRows, err=%v", err)
	}
	v2, err := q.RewrapVaultKEK(ctx, gen.RewrapVaultKEKParams{
		UserID: u1.ID, ExpectedVersion: 1, Kdf: kdf2, VaultKeyWrappedByKek: make([]byte, 73),
	})
	if err != nil || v2.Version != 2 {
		t.Fatalf("RewrapVaultKEK version=%d err=%v", v2.Version, err)
	}

	// 3. Idempotency claim, takeover sau 60s, reclaim khi hết hạn, finish và release.
	baseNow := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	t0 := pgtype.Timestamptz{Time: baseNow, Valid: true}
	tok1, err := q.ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
		UserID:      u1.ID,
		Key:         "idem-key-0000000001",
		Method:      "POST",
		Path:        "/api/v1/vault",
		RequestHash: []byte("fp-1"),
		OwnerToken:  u1.ID,
		Now:         t0,
	})
	if err != nil || tok1 != u1.ID {
		t.Fatalf("ClaimIdempotencyKey lần 1: tok=%v err=%v", tok1, err)
	}
	// Trong 60s không giành lại được.
	t30s := pgtype.Timestamptz{Time: baseNow.Add(30 * time.Second), Valid: true}
	if _, err := q.ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
		UserID:      u1.ID,
		Key:         "idem-key-0000000001",
		Method:      "POST",
		Path:        "/api/v1/vault",
		RequestHash: []byte("fp-1"),
		OwnerToken:  u2.ID,
		Now:         t30s,
	}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("ClaimIdempotencyKey trong 60s phải thua, err=%v", err)
	}
	// Sau >60s cùng fingerprint giành lại được claim.
	t61s := pgtype.Timestamptz{Time: baseNow.Add(61 * time.Second), Valid: true}
	tok2, err := q.ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
		UserID:      u1.ID,
		Key:         "idem-key-0000000001",
		Method:      "POST",
		Path:        "/api/v1/vault",
		RequestHash: []byte("fp-1"),
		OwnerToken:  u2.ID,
		Now:         t61s,
	})
	if err != nil || tok2 != u2.ID {
		t.Fatalf("ClaimIdempotencyKey sau 61s phải thắng: tok=%v err=%v", tok2, err)
	}
	// Finish với owner_token cũ (u1.ID) phải trả 0 rows; với owner_token mới (u2.ID) trả 1 row.
	rows, err := q.FinishIdempotencyKey(ctx, gen.FinishIdempotencyKeyParams{
		UserID: u1.ID, Key: "idem-key-0000000001", OwnerToken: u1.ID, StatusCode: 201, Response: []byte(`{"ok":true}`),
	})
	if err != nil || rows != 0 {
		t.Fatalf("Finish với owner_token cũ phải 0 rows, được rows=%d err=%v", rows, err)
	}
	rows, err = q.FinishIdempotencyKey(ctx, gen.FinishIdempotencyKeyParams{
		UserID: u1.ID, Key: "idem-key-0000000001", OwnerToken: u2.ID, StatusCode: 201, Response: []byte(`{"ok":true}`),
	})
	if err != nil || rows != 1 {
		t.Fatalf("Finish với owner_token mới phải 1 row, được rows=%d err=%v", rows, err)
	}

	// 4. Rate event count + insert.
	if _, err := q.InsertRateEvent(ctx, gen.InsertRateEventParams{
		Scope: "vault_recovery_lookup", UserID: u1.ID, At: t0,
	}); err != nil {
		t.Fatalf("InsertRateEvent: %v", err)
	}
	cnt, err := q.CountRateEventsSince(ctx, gen.CountRateEventsSinceParams{
		Scope:  "vault_recovery_lookup",
		UserID: u1.ID,
		Since:  pgtype.Timestamptz{Time: baseNow.Add(-15 * time.Minute), Valid: true},
	})
	if err != nil || cnt != 1 {
		t.Fatalf("CountRateEventsSince cnt=%d err=%v", cnt, err)
	}
}
