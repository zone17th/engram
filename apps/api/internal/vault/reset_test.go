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
	"github.com/jackc/pgx/v5/pgconn"
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

// TestResetCancelsExportJobsAndRecordsCleanup verifies (plan P06 mục 2.4, 2.9,
// Task 2) that DELETE /vault cancels queued/running/ready export jobs of the
// user and records export_file_cleanup rows for their attempt files inside the
// same transaction.
func TestResetCancelsExportJobsAndRecordsCleanup(t *testing.T) {
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
	logger := slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil))
	clk := clock.NewFixed(time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC))
	aud := audit.NewStore(pool)
	notes := notification.NewStore(pool, nil)
	_, obsMetrics := obs.NewRegistry()
	svc, err := vault.NewService(cfg, pool, clk, aud, notes, nil, vault.MetricsFromObs(obsMetrics), nil, logger)
	if err != nil {
		t.Fatalf("vault.NewService: %v", err)
	}

	q := gen.New(pool)
	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "reset-export@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	p := authctx.Principal{UserID: user.ID, SessionID: uuid.New()}
	created, err := svc.Create(ctx, p, makeValidCreateInput(t, 0x41))
	if err != nil {
		t.Fatalf("Create vault: %v", err)
	}

	attID := uuid.New()
	readyJobID := uuid.New()
	readyFile := readyJobID.String() + "." + attID.String() + ".sabk.enc"
	if _, err := pool.Exec(ctx, `
		INSERT INTO export_job (id, user_id, kind, status, attempt_id, file_name, size_bytes, completed_at, expires_at)
		VALUES ($1, $2, 'encrypted', 'ready', $3, $4, 128, now(), now() + interval '24 hours')
	`, readyJobID, user.ID, attID, readyFile); err != nil {
		t.Fatalf("insert ready export_job: %v", err)
	}

	if err := svc.Reset(ctx, p, vault.ResetInput{
		IfMatch: httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 1},
		IP:      "127.0.0.1",
		UA:      "reset-export-test",
	}); err != nil {
		t.Fatalf("Reset: %v", err)
	}

	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM export_job WHERE id = $1`, readyJobID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" {
		t.Fatalf("export_job status after Reset = %q, want cancelled", status)
	}
	var cleanupCount int
	if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM export_file_cleanup WHERE job_id = $1 AND reason = 'reset'`, readyJobID).Scan(&cleanupCount); err != nil {
		t.Fatal(err)
	}
	if cleanupCount != 2 {
		t.Fatalf("cleanup rows after Reset = %d, want 2 (.tmp and .sabk.enc)", cleanupCount)
	}
}

// TestResetVsAccountDeletionBarrier is the dec-039 reset-vs-account-deletion
// proof in both acquisition orders. Reset takes app_user FOR NO KEY UPDATE ->
// vault FOR UPDATE; deletion (accountdelbe §2.9) takes app_user FOR UPDATE ->
// vault FOR UPDATE -> DELETE. The second transaction is proven blocked by the
// first via pg_blocking_pids before release; neither side sees 40P01/55P03;
// and no ready (downloadable) export survives.
func TestResetVsAccountDeletionBarrier(t *testing.T) {
	for _, resetFirst := range []bool{true, false} {
		name := "DeleteFirstThenReset"
		if resetFirst {
			name = "ResetFirstThenDelete"
		}
		t.Run(name, func(t *testing.T) {
			dsn := dbtest.StartPostgres(t)
			dbtest.MigrateUp(t, dsn)
			pool := dbtest.Pool(t, dsn)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			t.Setenv("DATABASE_URL", dsn)
			t.Setenv("APP_ORIGIN", "http://localhost:3000")
			t.Setenv("APP_ENV", "development")
			cfg, err := config.Load()
			if err != nil {
				t.Fatal(err)
			}
			_, obsMetrics := obs.NewRegistry()
			svc, err := vault.NewService(cfg, pool, clock.System{}, audit.NewStore(pool), notification.NewStore(pool, nil),
				nil, vault.MetricsFromObs(obsMetrics), nil, slog.New(slog.DiscardHandler))
			if err != nil {
				t.Fatal(err)
			}
			q := gen.New(pool)
			user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "reset-delete@example.com", Locale: "en"})
			if err != nil {
				t.Fatal(err)
			}
			p := authctx.Principal{UserID: user.ID, SessionID: uuid.New()}
			created, err := svc.Create(ctx, p, makeValidCreateInput(t, 0x52))
			if err != nil {
				t.Fatal(err)
			}
			att := uuid.New()
			if _, err := pool.Exec(ctx, `
				INSERT INTO export_job (user_id, kind, status, attempt_id, file_name, size_bytes, completed_at, expires_at)
				SELECT $1, 'encrypted', 'ready', $2::uuid, gen_random_uuid()::text || '.' || $2::uuid::text || '.sabk.enc', 1, now(), now() + interval '1 day'`,
				user.ID, att); err != nil {
				t.Fatal(err)
			}
			reset := func(ctx context.Context) error {
				return svc.Reset(ctx, p, vault.ResetInput{
					IfMatch: httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 1},
					IP:      "127.0.0.1", UA: "barrier",
				})
			}
			deleteTx := func(ctx context.Context, tx pgx.Tx) error {
				for _, sql := range []string{
					`SELECT 1 FROM app_user WHERE id = $1 FOR UPDATE`,
					`SELECT 1 FROM vault WHERE user_id = $1 FOR UPDATE`,
					`DELETE FROM app_user WHERE id = $1`,
				} {
					if _, err := tx.Exec(ctx, sql, user.ID); err != nil {
						return err
					}
				}
				return nil
			}

			var resetErr, delErr error
			if resetFirst {
				held, release := make(chan int32, 1), make(chan struct{})
				svc.SetResetHook(func(ctx context.Context, tx pgx.Tx, _ uuid.UUID) error {
					var pid int32
					if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
						return err
					}
					held <- pid
					<-release
					return nil
				})
				resetDone := make(chan error, 1)
				go func() { resetDone <- reset(ctx) }()
				pid := <-held
				delDone := make(chan error, 1)
				go func() {
					tx, err := pool.Begin(ctx)
					if err != nil {
						delDone <- err
						return
					}
					defer func() { _ = tx.Rollback(ctx) }()
					if err := deleteTx(ctx, tx); err != nil {
						delDone <- err
						return
					}
					delDone <- tx.Commit(ctx)
				}()
				awaitBlockedByPID(t, ctx, pool, pid)
				close(release)
				resetErr, delErr = <-resetDone, <-delDone
				if resetErr != nil {
					t.Fatalf("Reset (first): %v", resetErr)
				}
				if delErr != nil {
					t.Fatalf("delete after reset: %v", delErr)
				}
			} else {
				tx, err := pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = tx.Rollback(ctx) }()
				if err := deleteTx(ctx, tx); err != nil {
					t.Fatal(err)
				}
				var pid int32
				if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
					t.Fatal(err)
				}
				resetDone := make(chan error, 1)
				go func() { resetDone <- reset(ctx) }()
				awaitBlockedByPID(t, ctx, pool, pid)
				if err := tx.Commit(ctx); err != nil {
					t.Fatalf("delete (first): %v", err)
				}
				resetErr = <-resetDone
				if resetErr == nil {
					t.Fatal("Reset after committed account deletion succeeded")
				}
			}
			for side, err := range map[string]error{"reset": resetErr, "delete": delErr} {
				var pgErr *pgconn.PgError
				if errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "55P03") {
					t.Fatalf("%s: lock failure %s: %v", side, pgErr.Code, err)
				}
			}
			var exports int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM export_job WHERE user_id = $1 AND status = 'ready'`,
				user.ID).Scan(&exports); err != nil {
				t.Fatal(err)
			}
			if exports != 0 {
				t.Fatalf("ready exports after reset/delete = %d", exports)
			}
		})
	}
}

// awaitBlockedByPID waits until some backend lists holder in pg_blocking_pids.
func awaitBlockedByPID(t *testing.T, ctx context.Context, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, holder int32,
) {
	t.Helper()
	for {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`, holder).Scan(&n); err != nil {
			t.Fatalf("pg_blocking_pids: %v", err)
		}
		if n > 0 {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("no backend became blocked by pid %d", holder)
		case <-time.After(20 * time.Millisecond):
		}
	}
}
