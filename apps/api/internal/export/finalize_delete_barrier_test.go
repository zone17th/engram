package export_test

import (
	"bytes"
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/export"
)

const deleteGateKey = 0x0e8b0de1

func newAccountDeleter(t *testing.T, pool *pgxpool.Pool) *auth.Service {
	t.Helper()
	k := func(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }
	sink, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc, _, _, err := compose.NewAuth(&config.Config{
		AppOrigin: "http://localhost:3000", AuthJWTSecret: k(1), AuthCSRFSecret: k(2), AuthReauthSecret: k(3),
		AuthIPPepper: k(4), AuthEmailPepper: k(5), MailCaptureAsDelivery: true,
	}, pool, nil, clock.System{}, sink, nil)
	if err != nil {
		t.Fatalf("compose.NewAuth: %v", err)
	}
	t.Cleanup(svc.Close)
	return svc
}

// gateAccountDelete makes the REAL account-deletion transaction pause at its
// final DELETE FROM app_user — after it already holds every lock in its
// documented order (generation set, app_user FOR UPDATE, vault, export_job,
// content) — until release is called. The pause is a BEFORE DELETE trigger
// waiting on an advisory lock held by a dedicated test connection.
func gateAccountDelete(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (gatePID int32, release func()) {
	t.Helper()
	if _, err := pool.Exec(ctx, `
		CREATE OR REPLACE FUNCTION r2_gate_delete() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN PERFORM pg_advisory_xact_lock(`+strconv.Itoa(deleteGateKey)+`); RETURN OLD; END $$;
		CREATE TRIGGER r2_gate_delete BEFORE DELETE ON app_user FOR EACH ROW EXECUTE FUNCTION r2_gate_delete();`); err != nil {
		t.Fatal(err)
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, deleteGateKey); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&gatePID); err != nil {
		t.Fatal(err)
	}
	released := false
	release = func() {
		if released {
			return
		}
		released = true
		_, _ = conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, deleteGateKey)
		conn.Release()
	}
	t.Cleanup(release)
	return gatePID, release
}

// blockedBy returns the pid of a backend currently blocked by holder (0 if none).
func blockedBy(t *testing.T, pool *pgxpool.Pool, holder int32) int32 {
	t.Helper()
	var pid int32
	if err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(min(pid), 0) FROM pg_stat_activity
		WHERE datname = current_database() AND pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`, holder).Scan(&pid); err != nil {
		t.Fatalf("pg_blocking_pids: %v", err)
	}
	return pid
}

func awaitBlockedBy(t *testing.T, pool *pgxpool.Pool, holder int32) int32 {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if pid := blockedBy(t, pool, holder); pid != 0 {
			return pid
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no backend became blocked by pid %d", holder)
	return 0
}

func deadlocks(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	var n int64
	if _, err := pool.Exec(context.Background(), `SELECT pg_stat_clear_snapshot()`); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// TestExportFinalizeVsAccountDeletion runs the REAL worker finalization
// against the REAL auth account deletion (DeleteAccountByEmail) in both
// acquisition orders. DeleteAccount retries once on 40P01/55P03, which would
// hide a deadlock, so the server-side pg_stat_database.deadlocks counter must
// not move. The second side is proven waiting on the first before release,
// and no ready export of the deleted owner remains downloadable.
func TestExportFinalizeVsAccountDeletion(t *testing.T) {
	type env struct {
		pool   *pgxpool.Pool
		svc    *export.Service
		w      *export.ExportWorker
		del    *auth.Service
		userID uuid.UUID
		email  string
		job    export.Job
	}
	setup := func(t *testing.T) env {
		pool, _, svc, w := export.SetupExportTestDB(t)
		userID, _, _, _, _ := export.SeedUserAndVault(t, pool)
		job, _, err := svc.Create(context.Background(), userID, "")
		if err != nil {
			t.Fatal(err)
		}
		return env{pool, svc, w, newAccountDeleter(t, pool), userID, "u-" + userID.String() + "@example.com", job}
	}
	assertGone := func(t *testing.T, e env, before int64) {
		t.Helper()
		if _, err := e.svc.OpenDownload(context.Background(), e.userID, e.job.ID); !errors.Is(err, export.ErrNotFound) {
			t.Fatalf("OpenDownload after committed deletion = %v, want ErrNotFound", err)
		}
		var rows int
		if err := e.pool.QueryRow(context.Background(), `SELECT count(*) FROM export_job WHERE user_id = $1`, e.userID).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		if rows != 0 {
			t.Fatalf("export_job rows after deletion = %d", rows)
		}
		if after := deadlocks(t, e.pool); after != before {
			t.Fatalf("server deadlocks %d -> %d (a 40P01 was hidden by the delete retry)", before, after)
		}
	}

	t.Run("DeleteFirstThenFinalize", func(t *testing.T) {
		e := setup(t)
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		before := deadlocks(t, e.pool)
		gatePID, release := gateAccountDelete(t, ctx, e.pool)
		delErr := make(chan error, 1)
		export.SetBeforeFinalize(e.w, func(context.Context, uuid.UUID, uuid.UUID) {
			go func() {
				_, err := e.del.DeleteAccountByEmail(ctx, e.email)
				delErr <- err
			}()
			deletePID := awaitBlockedBy(t, e.pool, gatePID) // delete holds its locks, paused at the gate
			go func() {
				awaitBlockedBy(t, e.pool, deletePID) // finalize is waiting on the delete
				release()
			}()
		})
		workErr := e.w.Work(ctx, export.MakeRiverJob(e.job.ID, e.userID, 1, 3))
		if err := <-delErr; err != nil {
			t.Fatalf("DeleteAccountByEmail: %v", err)
		}
		var cancelErr *river.JobCancelError
		if !errors.As(workErr, &cancelErr) {
			t.Fatalf("Work after committed deletion = %v, want JobCancel", workErr)
		}
		assertGone(t, e, before)
	})

	t.Run("FinalizeFirstThenDelete", func(t *testing.T) {
		e := setup(t)
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		before := deadlocks(t, e.pool)
		delErr := make(chan error, 1)
		export.SetFinalizeLocked(e.w, func(ctx context.Context, tx pgx.Tx) {
			var pid int32
			if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
				t.Error(err)
				return
			}
			go func() {
				_, err := e.del.DeleteAccountByEmail(context.Background(), e.email)
				delErr <- err
			}()
			awaitBlockedBy(t, e.pool, pid)
		})
		if err := e.w.Work(ctx, export.MakeRiverJob(e.job.ID, e.userID, 1, 3)); err != nil {
			t.Fatalf("Work (finalize first) = %v", err)
		}
		if err := <-delErr; err != nil {
			t.Fatalf("DeleteAccountByEmail after finalize: %v", err)
		}
		assertGone(t, e, before)
	})
}
