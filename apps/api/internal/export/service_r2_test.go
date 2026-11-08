package export

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/audit"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/notification"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/secevent"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

// ---- R2-01 / R2-02: durable prune fallback over export_file_cleanup ----

// insertCleanup records one pending obligation for a fresh safe file name and
// backdates created_at by age so keyset order is deterministic.
func insertCleanup(t *testing.T, pool *pgxpool.Pool, age time.Duration) (uuid.UUID, string) {
	t.Helper()
	ctx := context.Background()
	jobID, attemptID := uuid.New(), uuid.New()
	name := SafeFileName(jobID, attemptID, "sabk.enc")
	rec, err := gen.New(pool).InsertExportFileCleanup(ctx, gen.InsertExportFileCleanupParams{
		FileName: name, JobID: jobID, AttemptID: &attemptID, Reason: CleanupReasonReplaced,
	})
	if err != nil {
		t.Fatalf("insert cleanup: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE export_file_cleanup SET created_at = now() - $2::interval WHERE id = $1`,
		rec.ID, fmt.Sprintf("%d milliseconds", age.Milliseconds())); err != nil {
		t.Fatal(err)
	}
	return rec.ID, name
}

// obstruct makes unlink of name fail for real: a non-empty directory cannot be
// removed by os.Remove (ENOTEMPTY).
func obstruct(t *testing.T, dir, name string) {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(p, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p, "pin"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func cleanupDone(t *testing.T, pool *pgxpool.Pool, id uuid.UUID) bool {
	t.Helper()
	var done bool
	if err := pool.QueryRow(context.Background(),
		`SELECT done_at IS NOT NULL FROM export_file_cleanup WHERE id = $1`, id).Scan(&done); err != nil {
		t.Fatal(err)
	}
	return done
}

// TestPruneRetriesRepairedCleanupOnLaterSweep (R2-01): the same PruneWorker
// fails an obligation (unlink failure, then independently a CompleteCleanup
// DB failure), reports the error, keeps the row pending, and after repair a
// later sweep — with no River enqueue — removes the file and sets done_at.
func TestPruneRetriesRepairedCleanupOnLaterSweep(t *testing.T) {
	pool, cfg, _, _ := setupExportTestDB(t)
	ctx := context.Background()
	pw := NewPruneWorker(pool, cfg.ExportStorageDir, clock.System{}, slog.New(slog.DiscardHandler))

	t.Run("UnlinkFailure", func(t *testing.T) {
		id, name := insertCleanup(t, pool, time.Hour)
		obstruct(t, cfg.ExportStorageDir, name)
		if err := pw.runPendingCleanups(ctx); err == nil || !strings.Contains(err.Error(), id.String()) {
			t.Fatalf("sweep 1 = %v, want failure naming %s", err, id)
		}
		if cleanupDone(t, pool, id) {
			t.Fatal("failed obligation marked done")
		}
		if err := os.RemoveAll(filepath.Join(cfg.ExportStorageDir, name)); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(cfg.ExportStorageDir, name), []byte("artifact"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := pw.runPendingCleanups(ctx); err != nil {
			t.Fatalf("repaired sweep: %v", err)
		}
		if !cleanupDone(t, pool, id) {
			t.Fatal("repaired obligation not settled (done_at NULL) on later sweep")
		}
		if _, err := os.Stat(filepath.Join(cfg.ExportStorageDir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("file still present after repaired sweep: %v", err)
		}
	})

	t.Run("CompleteFailure", func(t *testing.T) {
		id, name := insertCleanup(t, pool, time.Hour)
		if err := os.WriteFile(filepath.Join(cfg.ExportStorageDir, name), []byte("artifact"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, fmt.Sprintf(`
			CREATE FUNCTION r2_block_complete() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.id = '%s' THEN RAISE EXCEPTION 'r2 injected completion failure'; END IF;
				RETURN NEW;
			END $$;
			CREATE TRIGGER r2_block_complete BEFORE UPDATE ON export_file_cleanup
				FOR EACH ROW EXECUTE FUNCTION r2_block_complete();`, id)); err != nil {
			t.Fatal(err)
		}
		if err := pw.runPendingCleanups(ctx); err == nil || !strings.Contains(err.Error(), "complete cleanup "+id.String()) {
			t.Fatalf("sweep 1 = %v, want completion failure for %s", err, id)
		}
		if cleanupDone(t, pool, id) {
			t.Fatal("row settled despite completion failure")
		}
		if _, err := pool.Exec(ctx, `DROP TRIGGER r2_block_complete ON export_file_cleanup; DROP FUNCTION r2_block_complete();`); err != nil {
			t.Fatal(err)
		}
		if err := pw.runPendingCleanups(ctx); err != nil {
			t.Fatalf("repaired sweep: %v", err)
		}
		if !cleanupDone(t, pool, id) {
			t.Fatal("completion-failed obligation not settled after repair")
		}
	})
}

// TestPruneSweepsPastFullyFailingOldestPage (R2-02): more than one page of
// permanently failing oldest obligations must not starve a healthy later one;
// a single sweep settles the later row, keeps the failures pending and returns
// them joined; after repair a later sweep settles everything.
func TestPruneSweepsPastFullyFailingOldestPage(t *testing.T) {
	pool, cfg, _, _ := setupExportTestDB(t)
	ctx := context.Background()
	pw := NewPruneWorker(pool, cfg.ExportStorageDir, clock.System{}, slog.New(slog.DiscardHandler))

	const failing = cleanupBatchSize + 5
	type ob struct {
		id   uuid.UUID
		name string
	}
	bad := make([]ob, 0, failing)
	for i := range failing {
		id, name := insertCleanup(t, pool, time.Duration(failing-i+10)*time.Minute)
		obstruct(t, cfg.ExportStorageDir, name)
		bad = append(bad, ob{id, name})
	}
	goodID, goodName := insertCleanup(t, pool, time.Minute)
	goodPath := filepath.Join(cfg.ExportStorageDir, goodName)
	if err := os.WriteFile(goodPath, []byte("artifact"), 0o600); err != nil {
		t.Fatal(err)
	}

	err := pw.runPendingCleanups(ctx)
	if err == nil {
		t.Fatal("sweep with failing obligations returned nil")
	}
	if n := strings.Count(err.Error(), "cleanup "); n < failing {
		t.Fatalf("aggregated failures = %d, want >= %d", n, failing)
	}
	if !cleanupDone(t, pool, goodID) {
		t.Fatal("healthy obligation behind a fully failing oldest page was starved")
	}
	if _, err := os.Stat(goodPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("healthy file not removed: %v", err)
	}
	for _, b := range bad {
		if cleanupDone(t, pool, b.id) {
			t.Fatalf("failing obligation %s marked done", b.id)
		}
	}

	for _, b := range bad {
		if err := os.RemoveAll(filepath.Join(cfg.ExportStorageDir, b.name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := pw.runPendingCleanups(ctx); err != nil {
		t.Fatalf("repaired sweep: %v", err)
	}
	var pending int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM export_file_cleanup WHERE done_at IS NULL`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("pending after repaired sweep = %d, want 0", pending)
	}
}

// ---- R1-05: directory durability barrier failure ----

// TestExportSyncDirFailureIsRetryableAndUnpublished: a failing post-rename
// directory fsync must not publish ready, must remove the attempt's files and
// must return a retryable (non-cancel) error; the next attempt succeeds.
func TestExportSyncDirFailureIsRetryableAndUnpublished(t *testing.T) {
	pool, cfg, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)
	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	injected := errors.New("r2 injected dir fsync failure")
	w.syncDirFn = func(string) error { return injected }
	err = w.Work(ctx, makeRiverJob(job.ID, userID, 1, 3))
	if !errors.Is(err, injected) {
		t.Fatalf("Work = %v, want the injected sync error", err)
	}
	var cancelErr *river.JobCancelError
	if errors.As(err, &cancelErr) {
		t.Fatalf("sync failure must be retryable, got JobCancel: %v", err)
	}
	got, err := svc.Get(ctx, userID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status == StatusReady {
		t.Fatal("job published ready after a failed directory durability barrier")
	}
	if files, _ := filepath.Glob(filepath.Join(cfg.ExportStorageDir, job.ID.String()+"*")); len(files) != 0 {
		t.Fatalf("attempt files left behind: %v", files)
	}

	w.syncDirFn = nil
	if err := w.Work(ctx, makeRiverJob(job.ID, userID, 2, 3)); err != nil {
		t.Fatalf("retry Work: %v", err)
	}
	if got, _ := svc.Get(ctx, userID, job.ID); got.Status != StatusReady {
		t.Fatalf("retry status = %s, want ready", got.Status)
	}
}

// ---- R1-13: ambiguous finalize COMMIT ----

func countExportSuccessAudits(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) (audits, notices int) {
	t.Helper()
	ctx := context.Background()
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2 AND result = $3`,
		userID, secevent.EventExportEncrypted, secevent.ResultSuccess).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_notification WHERE user_id = $1`, userID).Scan(&notices); err != nil {
		t.Fatal(err)
	}
	return audits, notices
}

func assertDownloadable(t *testing.T, svc *Service, userID, jobID uuid.UUID) {
	t.Helper()
	dl, err := svc.OpenDownload(context.Background(), userID, jobID)
	if err != nil {
		t.Fatalf("OpenDownload: %v", err)
	}
	defer func() { _ = dl.Close() }()
	buf := make([]byte, 10)
	if _, err := dl.Read(buf); err != nil || !bytes.HasPrefix(buf, []byte(`{"format"`)) {
		t.Fatalf("download not readable: err=%v head=%q", err, buf)
	}
}

// TestExportAmbiguousCommitThroughWork drives Work's ambiguous-COMMIT branch:
// the finalize transaction really commits server-side but the client sees an
// error (lost acknowledgement). Resolved lookup -> success; unresolved lookup
// -> snooze with the file preserved, and the retry settles without a second
// success audit or notice.
func TestExportAmbiguousCommitThroughWork(t *testing.T) {
	ackLost := func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return errors.New("r2 injected: connection reset before COMMIT ack")
	}

	t.Run("Resolved", func(t *testing.T) {
		pool, _, svc, w := setupExportTestDB(t)
		ctx := context.Background()
		userID, _, _, _, _ := seedUserAndVault(t, pool)
		job, _, err := svc.Create(ctx, userID, "")
		if err != nil {
			t.Fatal(err)
		}
		w.commitFinalize = ackLost
		if err := w.Work(ctx, makeRiverJob(job.ID, userID, 1, 3)); err != nil {
			t.Fatalf("Work with lost COMMIT ack (resolvable) = %v, want nil", err)
		}
		if got, _ := svc.Get(ctx, userID, job.ID); got.Status != StatusReady {
			t.Fatalf("status = %s, want ready", got.Status)
		}
		assertDownloadable(t, svc, userID, job.ID)
		if a, n := countExportSuccessAudits(t, pool, userID); a != 1 || n != 1 {
			t.Fatalf("audits=%d notices=%d, want 1/1", a, n)
		}
	})

	t.Run("UnresolvedThenRetry", func(t *testing.T) {
		pool, _, svc, w := setupExportTestDB(t)
		ctx := context.Background()
		userID, _, _, _, _ := seedUserAndVault(t, pool)
		job, _, err := svc.Create(ctx, userID, "")
		if err != nil {
			t.Fatal(err)
		}
		w.commitFinalize = ackLost
		w.resolveFault = func() error { return errors.New("r2 injected: lookup unavailable") }
		err = w.Work(ctx, makeRiverJob(job.ID, userID, 1, 3))
		var snooze *river.JobSnoozeError
		if !errors.As(err, &snooze) {
			t.Fatalf("Work with unresolved outcome = %v, want JobSnooze", err)
		}
		// The row committed ready: the matching file must still be present and readable.
		if got, _ := svc.Get(ctx, userID, job.ID); got.Status != StatusReady {
			t.Fatalf("status = %s, want ready", got.Status)
		}
		assertDownloadable(t, svc, userID, job.ID)

		w.commitFinalize, w.resolveFault = nil, nil
		err = w.Work(ctx, makeRiverJob(job.ID, userID, 2, 3))
		var cancelErr *river.JobCancelError
		if !errors.As(err, &cancelErr) {
			t.Fatalf("retry on already-ready job = %v, want terminal JobCancel", err)
		}
		assertDownloadable(t, svc, userID, job.ID)
		if a, n := countExportSuccessAudits(t, pool, userID); a != 1 || n != 1 {
			t.Fatalf("after retry audits=%d notices=%d, want 1/1 (no duplicate success)", a, n)
		}
	})
}

// ---- R1-15: failure bookkeeping errors surface ----

// TestFailOrRetrySurfacesBookkeepingErrors: when the terminal CAS update
// itself fails, failOrRetry returns that error joined with the cause instead
// of discarding it, and the attempt is left for the reconciler (not falsely
// failed or released).
func TestFailOrRetrySurfacesBookkeepingErrors(t *testing.T) {
	pool, _, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)
	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	claim, err := w.q.ClaimExportJob(ctx, gen.ClaimExportJobParams{LeaseSeconds: 600, ID: job.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION r2_block_job() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'r2 injected bookkeeping failure'; END $$;
		CREATE TRIGGER r2_block_job BEFORE UPDATE ON export_job FOR EACH ROW EXECUTE FUNCTION r2_block_job();`); err != nil {
		t.Fatal(err)
	}
	cause := errors.New("attempt failed")
	cctx, cancel := context.WithCancel(ctx)
	cancel() // bookkeeping must still run (detached) and report its own failure
	for _, attempt := range []int{1, 3} {
		err := w.failOrRetry(cctx, makeRiverJob(job.ID, userID, attempt, 3), job.ID, userID, *claim.AttemptID, "io_error", cause)
		if !errors.Is(err, cause) || !strings.Contains(err.Error(), "r2 injected bookkeeping failure") {
			t.Fatalf("attempt %d: failOrRetry = %v, want cause joined with the bookkeeping error", attempt, err)
		}
	}
	if _, err := pool.Exec(ctx, `DROP TRIGGER r2_block_job ON export_job; DROP FUNCTION r2_block_job();`); err != nil {
		t.Fatal(err)
	}
	if got, _ := svc.Get(ctx, userID, job.ID); got.Status != StatusRunning {
		t.Fatalf("status = %s, want still running (bookkeeping rolled back)", got.Status)
	}
}

// ---- R1-03 / R1-08: real finalization vs reset/account-deletion barriers ----

func newVaultService(t *testing.T, pool *pgxpool.Pool) *vault.Service {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://unused@localhost/unused")
	t.Setenv("APP_ORIGIN", "http://localhost:3000")
	t.Setenv("APP_ENV", "development")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	_, metrics := obs.NewRegistry()
	vs, err := vault.NewService(cfg, pool, clock.System{}, audit.NewStore(pool), notification.NewStore(pool, nil),
		nil, vault.MetricsFromObs(metrics), nil, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("vault.NewService: %v", err)
	}
	return vs
}

// awaitBlockedBy waits until some backend is blocked by holderPID: the
// contender is proven to be waiting on a lock the holder owns.
func awaitBlockedBy(t *testing.T, pool *pgxpool.Pool, holderPID int32) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		if err := pool.QueryRow(context.Background(), `
			SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`,
			holderPID).Scan(&n); err != nil {
			t.Fatalf("pg_blocking_pids: %v", err)
		}
		if n > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no backend became blocked by holder pid %d", holderPID)
}

func failOnLockError(t *testing.T, what string, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "55P03") {
		t.Fatalf("%s: lock failure %s: %v", what, pgErr.Code, err)
	}
}

// deleteAccountTx is account deletion per accountdelbe §2.9: app_user FOR
// UPDATE, then vault FOR UPDATE, then DELETE cascading to export_job.
func deleteAccountTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
	if _, err := tx.Exec(ctx, `SELECT 1 FROM app_user WHERE id = $1 FOR UPDATE`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM vault WHERE user_id = $1 FOR UPDATE`, userID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM app_user WHERE id = $1`, userID)
	return err
}

func backendPID(ctx context.Context, t *testing.T, tx pgx.Tx) int32 {
	t.Helper()
	var pid int32
	if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Errorf("pg_backend_pid: %v", err)
	}
	return pid
}

// TestExportFinalizeBarriers runs the REAL worker finalization (Work ->
// finalizeCAS) against the REAL vault.Reset and against account deletion, in
// both acquisition orders. The second transaction is proven to be waiting on
// the first via pg_blocking_pids before release; no 40P01/55P03 occurs; and no
// downloadable ready export survives a committed reset or deletion.
func TestExportFinalizeBarriers(t *testing.T) {
	type env struct {
		pool   *pgxpool.Pool
		svc    *Service
		w      *ExportWorker
		vs     *vault.Service
		userID uuid.UUID
		job    Job
	}
	setup := func(t *testing.T) env {
		pool, _, svc, w := setupExportTestDB(t)
		userID, _, _, _, _ := seedUserAndVault(t, pool)
		job, _, err := svc.Create(context.Background(), userID, "")
		if err != nil {
			t.Fatal(err)
		}
		return env{pool: pool, svc: svc, w: w, vs: newVaultService(t, pool), userID: userID, job: job}
	}
	reset := func(ctx context.Context, e env) error {
		return e.vs.Reset(ctx, authctx.Principal{UserID: e.userID, SessionID: uuid.New()}, vault.ResetInput{
			IfMatch: httpx.VaultIfMatch{VaultKeyID: canonicalSampleVaultKeyID, Version: 3},
			IP:      "127.0.0.1", UA: "r2-barrier",
		})
	}
	assertNotDownloadable := func(t *testing.T, e env) {
		t.Helper()
		if _, err := e.svc.OpenDownload(context.Background(), e.userID, e.job.ID); err == nil {
			t.Fatal("a ready export is still downloadable after the committed reset/delete")
		}
		var ready int
		if err := e.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM export_job WHERE user_id = $1 AND status = 'ready'`, e.userID).Scan(&ready); err != nil {
			t.Fatal(err)
		}
		if ready != 0 {
			t.Fatalf("ready export rows after reset/delete = %d", ready)
		}
	}

	// Mutator holds first (inside its tx, after taking its locks); Work's
	// finalizeCAS must wait, then observe the mutation and not publish.
	t.Run("ResetFirstThenFinalize", func(t *testing.T) {
		e := setup(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		held, release := make(chan int32, 1), make(chan struct{})
		e.vs.SetResetHook(func(ctx context.Context, tx pgx.Tx, _ uuid.UUID) error {
			held <- backendPID(ctx, t, tx)
			<-release
			return nil
		})
		resetErr := make(chan error, 1)
		e.w.beforeFin = func(context.Context, uuid.UUID, uuid.UUID) {
			go func() { resetErr <- reset(ctx, e) }()
			pid := <-held
			go func() { awaitBlockedBy(t, e.pool, pid); close(release) }()
		}
		workErr := e.w.Work(ctx, makeRiverJob(e.job.ID, e.userID, 1, 3))
		failOnLockError(t, "finalize", workErr)
		if err := <-resetErr; err != nil {
			failOnLockError(t, "reset", err)
			t.Fatalf("Reset: %v", err)
		}
		var cancelErr *river.JobCancelError
		if !errors.As(workErr, &cancelErr) || !errors.Is(workErr, errAttemptSuperseded) {
			t.Fatalf("Work after committed reset = %v, want superseded JobCancel", workErr)
		}
		assertNotDownloadable(t, e)
	})

	t.Run("FinalizeFirstThenReset", func(t *testing.T) {
		e := setup(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		resetErr := make(chan error, 1)
		e.w.finalizeLocked = func(ctx context.Context, tx pgx.Tx) {
			pid := backendPID(ctx, t, tx)
			go func() { resetErr <- reset(context.Background(), e) }()
			awaitBlockedBy(t, e.pool, pid)
		}
		if err := e.w.Work(ctx, makeRiverJob(e.job.ID, e.userID, 1, 3)); err != nil {
			failOnLockError(t, "finalize", err)
			t.Fatalf("Work (finalize first) = %v", err)
		}
		if err := <-resetErr; err != nil {
			failOnLockError(t, "reset", err)
			t.Fatalf("Reset after finalize: %v", err)
		}
		assertNotDownloadable(t, e)
		var cleanups int
		if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM export_file_cleanup WHERE job_id = $1 AND reason = 'reset'`,
			e.job.ID).Scan(&cleanups); err != nil {
			t.Fatal(err)
		}
		if cleanups == 0 {
			t.Fatal("reset after ready recorded no file cleanup obligation")
		}
	})

	t.Run("DeleteFirstThenFinalize", func(t *testing.T) {
		e := setup(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		delErr := make(chan error, 1)
		e.w.beforeFin = func(context.Context, uuid.UUID, uuid.UUID) {
			held := make(chan int32, 1)
			go func() {
				tx, err := e.pool.Begin(ctx)
				if err != nil {
					delErr <- err
					return
				}
				defer func() { _ = tx.Rollback(ctx) }()
				if err := deleteAccountTx(ctx, tx, e.userID); err != nil {
					delErr <- err
					return
				}
				pid := backendPID(ctx, t, tx)
				held <- pid
				awaitBlockedBy(t, e.pool, pid)
				delErr <- tx.Commit(ctx)
			}()
			<-held
		}
		workErr := e.w.Work(ctx, makeRiverJob(e.job.ID, e.userID, 1, 3))
		failOnLockError(t, "finalize", workErr)
		if err := <-delErr; err != nil {
			failOnLockError(t, "delete", err)
			t.Fatalf("delete: %v", err)
		}
		var cancelErr *river.JobCancelError
		if !errors.As(workErr, &cancelErr) {
			t.Fatalf("Work after committed delete = %v, want JobCancel", workErr)
		}
		assertNotDownloadable(t, e)
	})

	t.Run("FinalizeFirstThenDelete", func(t *testing.T) {
		e := setup(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		delErr := make(chan error, 1)
		e.w.finalizeLocked = func(ctx context.Context, tx pgx.Tx) {
			pid := backendPID(ctx, t, tx)
			go func() {
				dtx, err := e.pool.Begin(context.Background())
				if err != nil {
					delErr <- err
					return
				}
				defer func() { _ = dtx.Rollback(context.Background()) }()
				if err := deleteAccountTx(context.Background(), dtx, e.userID); err != nil {
					delErr <- err
					return
				}
				delErr <- dtx.Commit(context.Background())
			}()
			awaitBlockedBy(t, e.pool, pid)
		}
		if err := e.w.Work(ctx, makeRiverJob(e.job.ID, e.userID, 1, 3)); err != nil {
			failOnLockError(t, "finalize", err)
			t.Fatalf("Work (finalize first) = %v", err)
		}
		if err := <-delErr; err != nil {
			failOnLockError(t, "delete", err)
			t.Fatalf("delete after finalize: %v", err)
		}
		assertNotDownloadable(t, e)
	})
}

// ---- R1-07: live-mutation restore + serialized PRF salt ----

// TestSabkArtifactSurvivesLiveVaultOperations downloads the worker artifact,
// then runs the REAL vault operations — Rewrap (KEK rotation), RecoverComplete
// (RK consumption) and RevokePasskey — and proves the artifact still carries
// the original wraps and the exact serialized prf_salt/cred_id, so every
// recovery path keeps working offline.
func TestSabkArtifactSurvivesLiveVaultOperations(t *testing.T) {
	pool, _, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)
	vs := newVaultService(t, pool)
	p := authctx.Principal{UserID: userID, SessionID: uuid.New()}

	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Work(ctx, makeRiverJob(job.ID, userID, 1, 3)); err != nil {
		t.Fatal(err)
	}
	doc := downloadSabk(t, svc, userID, job.ID)
	vec := loadJSVectors(t)

	if len(doc.Vault.Passkeys) != 1 {
		t.Fatalf("passkeys = %d", len(doc.Vault.Passkeys))
	}
	pk := doc.Vault.Passkeys[0]
	if pk.PRFSalt != vault.EncodeBase64URL(bytes.Repeat([]byte{0x24}, 32)) {
		t.Fatalf("serialized prf_salt = %q, want the stored salt", pk.PRFSalt)
	}
	if pk.CredID != vault.EncodeBase64URL(bytes.Repeat([]byte{0x42}, 32)) {
		t.Fatalf("serialized cred_id = %q", pk.CredID)
	}

	// Live operations through the vault service. A KEK rotation must carry a
	// fresh salt (ValidateKDFParamsForRewrap), so each op gets its own.
	withSalt := func(fill byte) json.RawMessage {
		var kdf map[string]any
		dec := json.NewDecoder(bytes.NewReader(doc.Vault.KDF))
		dec.UseNumber()
		if err := dec.Decode(&kdf); err != nil {
			t.Fatal(err)
		}
		kdf["salt"] = vault.EncodeBase64URL(bytes.Repeat([]byte{fill}, vault.KDFSaltBytes))
		b, err := json.Marshal(kdf)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	rewrapped, err := vs.Rewrap(ctx, p, vault.RewrapInput{
		KDFRaw: withSalt(0x5a), VaultKeyWrappedByKEK: vec.Derived.Wraps.KEK.WrapB64U,
		IfMatch: httpx.VaultIfMatch{VaultKeyID: canonicalSampleVaultKeyID, Version: 3},
		IP:      "127.0.0.1", UA: "r2",
	})
	if err != nil {
		t.Fatalf("Rewrap (KEK rotation): %v", err)
	}
	var rkID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM vault_recovery_key WHERE vault_id = $1`, userID).Scan(&rkID); err != nil {
		t.Fatal(err)
	}
	if _, err := vs.RecoverComplete(ctx, p, vault.RecoverCompleteInput{
		RecoveryKeyID: rkID, KDFRaw: withSalt(0x6b), VaultKeyWrappedByKEK: vec.Derived.Wraps.KEK.WrapB64U,
		IfMatch: httpx.VaultIfMatch{VaultKeyID: canonicalSampleVaultKeyID, Version: rewrapped.Version},
		IP:      "127.0.0.1", UA: "r2",
	}); err != nil {
		t.Fatalf("RecoverComplete (RK consume): %v", err)
	}
	if err := vs.RevokePasskey(ctx, p, vault.RevokePasskeyInput{PasskeyID: pk.ID, IP: "127.0.0.1", UA: "r2"}); err != nil {
		t.Fatalf("RevokePasskey: %v", err)
	}
	var liveRK, livePK int
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM vault_recovery_key WHERE vault_id = $1),
		(SELECT count(*) FROM vault_passkey WHERE user_id = $1)`, userID).Scan(&liveRK, &livePK); err != nil {
		t.Fatal(err)
	}
	if liveRK != 0 || livePK != 0 {
		t.Fatalf("live ops did not take effect: rk=%d passkeys=%d", liveRK, livePK)
	}

	// The already-downloaded artifact is unchanged and still opens VK by RK and PRF.
	again := downloadSabk(t, svc, userID, job.ID)
	if again.Vault.Passkeys[0].PRFSalt != pk.PRFSalt || len(again.Vault.RecoveryKeys) != 1 {
		t.Fatal("artifact changed after live vault operations")
	}
	vk, _ := vault.DecodeBase64URLStrict(vec.Inputs.VKB64U, 32)
	pwk, _ := vault.DecodeBase64URLStrict(vec.Inputs.PWKB64U, 32)
	if got, err := vault.OpenWrapBase64URL(vault.WrapKindPRF, again.Vault.Passkeys[0].VKWrap, pwk); err != nil || !bytes.Equal(got, vk) {
		t.Fatalf("PRF path after revoke: %v", err)
	}
}

type sabkDoc struct {
	Snapshot SabkSnapshot  `json:"snapshot"`
	Vault    SabkVault     `json:"vault"`
	Tags     []SabkTag     `json:"tags"`
	Items    []SabkItem    `json:"items"`
	ItemTags []SabkItemTag `json:"item_tags"`
	Entries  []SabkEntry   `json:"entries"`
}

func downloadSabk(t *testing.T, svc *Service, userID, jobID uuid.UUID) sabkDoc {
	t.Helper()
	dl, err := svc.OpenDownload(context.Background(), userID, jobID)
	if err != nil {
		t.Fatalf("OpenDownload: %v", err)
	}
	defer func() { _ = dl.Close() }()
	var doc sabkDoc
	if err := json.NewDecoder(dl).Decode(&doc); err != nil {
		t.Fatalf("decode artifact: %v", err)
	}
	return doc
}

// ---- R1-09: two tenants, every owner-specific section ----

// ownerSets returns the owner's rows as the artifact must contain them, read
// with an explicit owner predicate independent of the snapshot queries.
func ownerSets(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) map[string][]string {
	t.Helper()
	ctx := context.Background()
	q := map[string]string{
		"tags":      `SELECT id::text || ':' || (deleted_at IS NOT NULL)::text FROM tag WHERE user_id = $1 ORDER BY 1`,
		"items":     `SELECT id::text FROM item WHERE user_id = $1 ORDER BY 1`,
		"item_tags": `SELECT it.item_id::text || '/' || it.tag_id::text FROM item_tag it JOIN item i ON i.id = it.item_id WHERE i.user_id = $1 ORDER BY 1`,
		"entries":   `SELECT id::text || ':' || (deleted_at IS NOT NULL)::text FROM entry WHERE user_id = $1 ORDER BY 1`,
		"rk":        `SELECT encode(lookup_hash, 'hex') FROM vault_recovery_key WHERE vault_id = $1 ORDER BY 1`,
		"passkeys":  `SELECT encode(prf_salt, 'hex') || '/' || encode(cred_id, 'hex') FROM vault_passkey WHERE user_id = $1 ORDER BY 1`,
	}
	out := map[string][]string{}
	for k, sql := range q {
		rows, err := pool.Query(ctx, sql, userID)
		if err != nil {
			t.Fatalf("%s: %v", k, err)
		}
		vals, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			t.Fatalf("%s: %v", k, err)
		}
		out[k] = vals
	}
	return out
}

func artifactSets(t *testing.T, d sabkDoc) map[string][]string {
	t.Helper()
	out := map[string][]string{}
	for _, x := range d.Tags {
		out["tags"] = append(out["tags"], fmt.Sprintf("%s:%t", x.ID, x.DeletedAt != nil))
	}
	for _, x := range d.Items {
		out["items"] = append(out["items"], x.ID.String())
	}
	for _, x := range d.ItemTags {
		out["item_tags"] = append(out["item_tags"], x.ItemID.String()+"/"+x.TagID.String())
	}
	for _, x := range d.Entries {
		out["entries"] = append(out["entries"], fmt.Sprintf("%s:%t", x.ID, x.DeletedAt != nil))
	}
	for _, x := range d.Vault.RecoveryKeys {
		b, err := vault.DecodeBase64URLStrict(x.LookupHash, 32)
		if err != nil {
			t.Fatal(err)
		}
		out["rk"] = append(out["rk"], fmt.Sprintf("%x", b))
	}
	for _, x := range d.Vault.Passkeys {
		salt, err1 := vault.DecodeBase64URLStrict(x.PRFSalt, 32)
		cred, err2 := vault.DecodeBase64URLStrict(x.CredID, 32)
		if err1 != nil || err2 != nil {
			t.Fatal(err1, err2)
		}
		out["passkeys"] = append(out["passkeys"], fmt.Sprintf("%x/%x", salt, cred))
	}
	for k := range out {
		sort.Strings(out[k])
	}
	return out
}

// TestExportTwoOwnerIsolation seeds two full tenants (tags incl. tombstone,
// item, item_tag, active + soft-deleted entries, RK, passkey), exports BOTH,
// and asserts each artifact's every owner-specific section equals exactly
// that owner's rows and counts — dropping any snapshot owner predicate fails.
func TestExportTwoOwnerIsolation(t *testing.T) {
	pool, _, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userA, _, _, _, _ := seedUserAndVault(t, pool)
	userB, _, _, _, _ := seedUserAndVaultK(t, pool, "vk:AAAAAQEBAQEBAQEBAQEBAQ")

	for _, owner := range []uuid.UUID{userA, userB} {
		job, _, err := svc.Create(ctx, owner, "")
		if err != nil {
			t.Fatal(err)
		}
		if err := w.Work(ctx, makeRiverJob(job.ID, owner, 1, 3)); err != nil {
			t.Fatalf("Work %s: %v", owner, err)
		}
		doc := downloadSabk(t, svc, owner, job.ID)
		want, got := ownerSets(t, pool, owner), artifactSets(t, doc)
		for _, sec := range []string{"tags", "items", "item_tags", "entries", "rk", "passkeys"} {
			if strings.Join(got[sec], ",") != strings.Join(want[sec], ",") {
				t.Fatalf("owner %s section %s:\n got  %v\n want %v", owner, sec, got[sec], want[sec])
			}
		}
		c := doc.Snapshot.Counts
		if int(c.Tags) != len(want["tags"]) || int(c.Items) != len(want["items"]) ||
			int(c.ItemTags) != len(want["item_tags"]) || int(c.Entries) != len(want["entries"]) {
			t.Fatalf("owner %s manifest counts %+v disagree with owner rows", owner, c)
		}
		other := userA
		if owner == userA {
			other = userB
		}
		if _, err := svc.OpenDownload(ctx, other, job.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cross-owner OpenDownload: %v", err)
		}
	}
}

// ---- R1-11: cursor identity binding, each component independently ----

func TestExportCursorIdentityBinding(t *testing.T) {
	pool, _, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)
	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Work(ctx, makeRiverJob(job.ID, userID, 1, 3)); err != nil {
		t.Fatal(err)
	}
	p1, err := svc.DecryptedPages(ctx, userID, job.ID, "", 256)
	if err != nil || p1.NextCursor == nil {
		t.Fatalf("page1: %v", err)
	}
	var attemptID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT attempt_id FROM export_job WHERE id = $1`, job.ID).Scan(&attemptID); err != nil {
		t.Fatal(err)
	}
	sec := svc.secretBytes()
	defer clear(sec)
	raw := *p1.NextCursor
	if _, err := decodeCursor(sec, userID, job.ID, attemptID, raw); err != nil {
		t.Fatalf("valid cursor rejected: %v", err)
	}
	for name, ids := range map[string][3]uuid.UUID{
		"user":    {uuid.New(), job.ID, attemptID},
		"job":     {userID, uuid.New(), attemptID},
		"attempt": {userID, job.ID, uuid.New()},
	} {
		if _, err := decodeCursor(sec, ids[0], ids[1], ids[2], raw); !errors.Is(err, ErrInvalidCursor) {
			t.Fatalf("cursor accepted with substituted %s: %v", name, err)
		}
	}
}
