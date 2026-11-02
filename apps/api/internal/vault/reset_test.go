package vault_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/engram/apps/api/internal/audit"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/notification"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

func TestServiceResetHookRollbackOtherUserIsolationAndNewVaultKeyID(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", "http://localhost:3000")
	t.Setenv("APP_ENV", "development")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	clk := clock.NewFixed(time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC))
	aud := audit.NewStore(pool)
	riverInsert, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		t.Fatalf("river.NewClient: %v", err)
	}
	notes := notification.NewStore(pool, riverInsert)
	_, obsMetrics := obs.NewRegistry()
	mailer := &spyMailer{}

	svc, err := vault.NewService(cfg, pool, clk, aud, notes, mailer, vault.MetricsFromObs(obsMetrics), nil, logger)
	if err != nil {
		t.Fatalf("vault.NewService: %v", err)
	}

	q := gen.New(pool)
	userA, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "reset-svc-a@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser A: %v", err)
	}
	userB, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "reset-svc-b@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser B: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id IN ($1, $2)`, userA.ID, userB.ID); err != nil {
		t.Fatal(err)
	}

	var sessA, sessB uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO session (user_id, refresh_token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
		userA.ID, seqBytes(32, 0x01),
	).Scan(&sessA); err != nil {
		t.Fatalf("insert session A: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO session (user_id, refresh_token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
		userB.ID, seqBytes(32, 0x02),
	).Scan(&sessB); err != nil {
		t.Fatalf("insert session B: %v", err)
	}

	pA := authctx.Principal{UserID: userA.ID, SessionID: sessA}
	pB := authctx.Principal{UserID: userB.ID, SessionID: sessB}

	// Create vaults for both User A and User B.
	createdA, err := svc.Create(ctx, pA, makeValidCreateInput(t, 0x10))
	if err != nil {
		t.Fatalf("Create A: %v", err)
	}
	createdB, err := svc.Create(ctx, pB, makeValidCreateInput(t, 0x60))
	if err != nil {
		t.Fatalf("Create B: %v", err)
	}

	// Insert passkey and WebAuthn challenge rows for both User A and User B.
	if _, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID:  userA.ID,
		CredID:  seqBytes(32, 0xA1),
		Pubkey:  seqBytes(32, 0xA2),
		PrfSalt: seqBytes(32, 0xA3),
		VkWrap:  seqBytes(vault.VKWrapBytes, 0x01),
		Name:    "User A Passkey",
	}); err != nil {
		t.Fatalf("InsertPasskey A: %v", err)
	}
	if _, err := q.InsertPasskey(ctx, gen.InsertPasskeyParams{
		UserID:  userB.ID,
		CredID:  seqBytes(32, 0xB1),
		Pubkey:  seqBytes(32, 0xB2),
		PrfSalt: seqBytes(32, 0xB3),
		VkWrap:  seqBytes(vault.VKWrapBytes, 0x01),
		Name:    "User B Passkey",
	}); err != nil {
		t.Fatalf("InsertPasskey B: %v", err)
	}
	if _, err := q.InsertWebAuthnChallenge(ctx, gen.InsertWebAuthnChallengeParams{
		UserID:        userA.ID,
		SessionID:     sessA,
		VaultKeyID:    createdA.VaultKeyID,
		ChallengeHash: seqBytes(32, 0xC1),
		PrfSalt:       seqBytes(32, 0xC2),
		ExpiresAt:     pgtype.Timestamptz{Time: clk.Now().Add(5 * time.Minute), Valid: true},
	}); err != nil {
		t.Fatalf("InsertWebAuthnChallenge A: %v", err)
	}
	if _, err := q.InsertWebAuthnChallenge(ctx, gen.InsertWebAuthnChallengeParams{
		UserID:        userB.ID,
		SessionID:     sessB,
		VaultKeyID:    createdB.VaultKeyID,
		ChallengeHash: seqBytes(32, 0xD1),
		PrfSalt:       seqBytes(32, 0xD2),
		ExpiresAt:     pgtype.Timestamptz{Time: clk.Now().Add(5 * time.Minute), Valid: true},
	}); err != nil {
		t.Fatalf("InsertWebAuthnChallenge B: %v", err)
	}

	// Create a temporary scratch table to prove ResetHook executes inside the exact same pgx.Tx
	// and that a failing hook rolls back both the hook's side-effect and the vault reset.
	if _, err := pool.Exec(ctx, `CREATE TEMP TABLE reset_hook_probe (user_id uuid NOT NULL)`); err != nil {
		t.Fatalf("create temp table: %v", err)
	}

	// 1. Failing ResetHook -> full rollback: vault, RKs, passkeys, challenges still present, no audit/notice/mail.
	hookErr := errors.New("simulated P04 entry deletion failure")
	svc.SetResetHook(func(ctx context.Context, tx pgx.Tx, uid uuid.UUID) error {
		if _, err := tx.Exec(ctx, `INSERT INTO reset_hook_probe (user_id) VALUES ($1)`, uid); err != nil {
			return err
		}
		return hookErr
	})

	err = svc.Reset(ctx, pA, vault.ResetInput{
		IfMatch: httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
		IP:      "127.0.0.1",
		UA:      "reset-service-test",
	})
	if !errors.Is(err, hookErr) {
		t.Fatalf("Reset with failing hook = %v, want %v", err, hookErr)
	}

	var probeRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reset_hook_probe`).Scan(&probeRows); err != nil {
		t.Fatal(err)
	}
	if probeRows != 0 {
		t.Fatalf("probeRows after rollback = %d, want 0", probeRows)
	}
	if st, err := svc.VaultStatus(ctx, userA.ID); err != nil || st != vault.StatusPresent {
		t.Fatalf("VaultStatus after failed hook = %q, %v, want present", st, err)
	}
	var failedJobs, failedNotices int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`).Scan(&failedJobs)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1`, userA.ID).Scan(&failedNotices)
	if failedJobs != 0 || failedNotices != 0 || mailer.count() != 0 {
		t.Fatalf("after failed hook: jobs=%d notices=%d mailer=%d, want 0/0/0", failedJobs, failedNotices, mailer.count())
	}

	// 2. Succeeding ResetHook -> commits inside the same tx: deletes User A's vault, RKs, passkeys, challenges,
	// records audit `vault.reset` + security notice + sends security email; User B is completely unaffected.
	var hookCalledWith uuid.UUID
	svc.SetResetHook(func(ctx context.Context, tx pgx.Tx, uid uuid.UUID) error {
		hookCalledWith = uid
		_, err := tx.Exec(ctx, `INSERT INTO reset_hook_probe (user_id) VALUES ($1)`, uid)
		return err
	})

	if err := svc.Reset(ctx, pA, vault.ResetInput{
		IfMatch: httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
		IP:      "127.0.0.1",
		UA:      "reset-service-test",
	}); err != nil {
		t.Fatalf("Reset A: %v", err)
	}
	if hookCalledWith != userA.ID {
		t.Fatalf("hookCalledWith = %v, want %v", hookCalledWith, userA.ID)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM reset_hook_probe WHERE user_id = $1`, userA.ID).Scan(&probeRows); err != nil {
		t.Fatal(err)
	}
	if probeRows != 1 {
		t.Fatalf("probeRows after committed reset = %d, want 1", probeRows)
	}

	// User A's vault, RKs, passkeys, and challenges are deleted; VaultStatus is absent.
	if st, err := svc.VaultStatus(ctx, userA.ID); err != nil || st != vault.StatusAbsent {
		t.Fatalf("User A VaultStatus after reset = %q, %v, want absent", st, err)
	}
	var rkA, pkA, chA, auditResetA, noticeA int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM vault_recovery_key WHERE vault_id = $1`, userA.ID).Scan(&rkA)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM vault_passkey WHERE user_id = $1`, userA.ID).Scan(&pkA)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM webauthn_challenge WHERE user_id = $1`, userA.ID).Scan(&chA)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`, userA.ID, vault.EventVaultReset).Scan(&auditResetA)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1 AND kind = 'security'`, userA.ID).Scan(&noticeA)
	if rkA != 0 || pkA != 0 || chA != 0 || auditResetA != 1 || noticeA != 1 {
		t.Fatalf("User A after reset: rk=%d pk=%d ch=%d audit=%d notice=%d", rkA, pkA, chA, auditResetA, noticeA)
	}
	if mailer.count() != 0 {
		t.Fatalf("direct mailer count before worker after reset = %d, want 0", mailer.count())
	}
	ranJobs, workErr := runQueuedSecurityNoticeJobs(ctx, pool, mailer, logger)
	if ranJobs != 1 || workErr != nil {
		t.Fatalf("runQueuedSecurityNoticeJobs = (%d, %v), want (1, nil)", ranJobs, workErr)
	}
	if mailer.count() != 1 {
		t.Fatalf("mailer count after reset worker = %d, want 1", mailer.count())
	}

	// User B is unaffected: vault present, 10 RKs, 1 passkey, 1 challenge.
	stateB, err := svc.Get(ctx, userB.ID)
	if err != nil {
		t.Fatalf("Get User B after User A reset: %v", err)
	}
	var chB int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM webauthn_challenge WHERE user_id = $1`, userB.ID).Scan(&chB)
	if stateB.VaultKeyID != createdB.VaultKeyID || stateB.RecoveryKeysRemaining != 10 || len(stateB.Passkeys) != 1 || chB != 1 {
		t.Fatalf("User B affected by User A reset: stateB=%+v chB=%d", stateB, chB)
	}

	// 3. Before recreate, If-Match mutation on User A -> 404 vault_absent.
	if err := svc.Reset(ctx, pA, vault.ResetInput{
		IfMatch: httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
	}); !errors.Is(err, vault.ErrVaultAbsent) {
		t.Fatalf("Reset on absent vault = %v, want ErrVaultAbsent", err)
	}

	// 4. Recreating vault for User A issues a brand-new vault_key_id; If-Match with old vault_key_id -> 412 version_mismatch.
	recreatedA, err := svc.Create(ctx, pA, makeValidCreateInput(t, 0x30))
	if err != nil {
		t.Fatalf("Recreate A: %v", err)
	}
	if recreatedA.VaultKeyID == createdA.VaultKeyID || recreatedA.Version != 1 {
		t.Fatalf("recreatedA = %+v, old = %+v", recreatedA, createdA)
	}
	err = svc.Reset(ctx, pA, vault.ResetInput{
		IfMatch: httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
	})
	ve, ok := vault.AsError(err)
	if !ok || ve.Code != "version_mismatch" || ve.CurrentVersion == nil || *ve.CurrentVersion != 1 {
		t.Fatalf("Reset with old vault_key_id after recreate = %v (%+v), want 412 version_mismatch(current=1)", err, ve)
	}
}
