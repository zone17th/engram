package export

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/jobs/exportcleanup"
)

const (
	cleanupDoneRetention  = 7 * 24 * time.Hour
	exportTerminalRetain  = 90 * 24 * time.Hour
	cleanupBatchSize      = 200
	staleExportBatchLimit = 100
)

// queuedDeliveryLostCode is the error_code recorded when a stale queued
// export has no live River delivery left (r1 R1-16).
var queuedDeliveryLostCode = "queued_delivery_lost"

// CleanupWorker implements river.Worker[exportcleanup.Args] (plan mục 2.5.4,
// 2.9g): unlinks the file idempotently (ENOENT counts as done) and sets done_at.
// The export_file_cleanup table has no FK to app_user or export_job so a row
// survives account deletion.
type CleanupWorker struct {
	river.WorkerDefaults[exportcleanup.Args]
	pool       *pgxpool.Pool
	q          *gen.Queries
	storageDir string
	logger     *slog.Logger
}

// NewCleanupWorker constructs an export_file_cleanup worker.
func NewCleanupWorker(pool *pgxpool.Pool, storageDir string, logger *slog.Logger) *CleanupWorker {
	return &CleanupWorker{
		pool:       pool,
		q:          gen.New(pool),
		storageDir: storageDir,
		logger:     logger,
	}
}

// Work unlinks the cleanup row's file and marks done_at.
func (w *CleanupWorker) Work(ctx context.Context, rjob *river.Job[exportcleanup.Args]) error {
	return runOneCleanup(ctx, w.q, w.storageDir, rjob.Args.CleanupID)
}

func runOneCleanup(ctx context.Context, q *gen.Queries, storageDir string, cleanupID uuid.UUID) error {
	row, err := q.GetExportCleanup(ctx, cleanupID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if row.DoneAt.Valid {
		return nil
	}
	if err := unlinkSafeFile(storageDir, row.FileName); err != nil {
		return err
	}
	_, err = q.CompleteCleanup(ctx, cleanupID)
	return err
}

func unlinkSafeFile(storageDir, fileName string) error {
	path, err := joinSafePath(storageDir, fileName)
	if err != nil {
		return nil // invalid filename can never exist; mark done so it stops retrying
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// ExportPruneArgs is the River periodic job payload for export_prune (15m).
type ExportPruneArgs struct{}

func (ExportPruneArgs) Kind() string { return ExportPruneKind }

// PruneWorker implements river.Worker[ExportPruneArgs] (plan mục 2.4, 2.5.4):
//  1. expires ready jobs with expires_at <= now() and records cleanup;
//  2. reconciles running jobs with lease_until < now()-15m that have no live
//     river_job -> failed worker_lost + cleanup;
//  3. sweeps pending export_file_cleanup rows (unlinks + marks done_at);
//  4. unlinks orphan .tmp/.sabk.enc files in storageDir not matching a live
//     (job_id, attempt_id);
//  5. prunes completed cleanup rows older than 7d and terminal export_job rows
//     older than 90d.
type PruneWorker struct {
	river.WorkerDefaults[ExportPruneArgs]
	pool       *pgxpool.Pool
	q          *gen.Queries
	storageDir string
	clk        clock.Clock
	logger     *slog.Logger
}

// NewPruneWorker constructs an export_prune worker.
func NewPruneWorker(pool *pgxpool.Pool, storageDir string, clk clock.Clock, logger *slog.Logger) *PruneWorker {
	if clk == nil {
		clk = clock.System{}
	}
	return &PruneWorker{
		pool:       pool,
		q:          gen.New(pool),
		storageDir: storageDir,
		clk:        clk,
		logger:     logger,
	}
}

// Work runs one sweep of export_prune.
func (w *PruneWorker) Work(ctx context.Context, _ *river.Job[ExportPruneArgs]) error {
	return w.Sweep(ctx)
}

// Sweep executes all export_prune maintenance steps and may be called directly
// from tests.
func (w *PruneWorker) Sweep(ctx context.Context) error {
	now := w.clk.Now()
	if err := w.expireDue(ctx); err != nil {
		return err
	}
	if err := w.reconcileStaleRunning(ctx, now); err != nil {
		return err
	}
	if err := w.reconcileStaleQueued(ctx, now); err != nil {
		return err
	}
	cleanupErr := w.runPendingCleanups(ctx)
	sweepErr := w.sweepOrphanFiles(ctx)
	if _, err := w.q.PruneDoneCleanup(ctx, pgtype.Timestamptz{
		Time:  now.Add(-cleanupDoneRetention),
		Valid: true,
	}); err != nil {
		return errors.Join(cleanupErr, sweepErr, err)
	}
	if _, err := w.q.DeleteOldTerminalExports(ctx, pgtype.Timestamptz{
		Time:  now.Add(-exportTerminalRetain),
		Valid: true,
	}); err != nil {
		return errors.Join(cleanupErr, sweepErr, err)
	}
	return errors.Join(cleanupErr, sweepErr)
}

func (w *PruneWorker) expireDue(ctx context.Context) error {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := w.q.WithTx(tx)

	rows, err := q.ExpireDueExports(ctx)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if r.FileName == nil || !ValidateSafeFileName(*r.FileName) {
			continue
		}
		if _, err := q.InsertExportFileCleanup(ctx, gen.InsertExportFileCleanupParams{
			FileName:  *r.FileName,
			JobID:     r.ID,
			AttemptID: r.AttemptID,
			Reason:    CleanupReasonExpired,
		}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (w *PruneWorker) reconcileStaleRunning(ctx context.Context, now time.Time) error {
	cutoff := pgtype.Timestamptz{Time: now.Add(-ExportWorkerLostAfter), Valid: true}
	// Keyset page so live rows skipped below cannot starve later stale rows
	// (r1 R1-18).
	afterLease := pgtype.Timestamptz{Valid: true} // valid zero-time: NULL would hide rows
	var afterID uuid.UUID
	for {
		stale, err := w.q.ListStaleRunningExports(ctx, gen.ListStaleRunningExportsParams{
			Before:     cutoff,
			AfterLease: afterLease,
			AfterID:    afterID,
			BatchLimit: staleExportBatchLimit,
		})
		if err != nil {
			return err
		}
		if len(stale) == 0 {
			return nil
		}
		for _, s := range stale {
			afterLease, afterID = s.LeaseUntil, s.ID
			live, err := w.hasLiveRiverJob(ctx, s.ID)
			if err != nil {
				return err
			}
			if live {
				continue
			}
			if err := w.markOneWorkerLost(ctx, s, cutoff); err != nil {
				return err
			}
		}
		if len(stale) < staleExportBatchLimit {
			return nil
		}
	}
}

// reconcileStaleQueued fails queued exports whose River row no longer exists:
// if every delivery attempt dies before ClaimExportJob succeeds, the export row
// would otherwise sit queued forever and block future Creates (r1 R1-16). A
// queued job that still has a live/scheduled river_job is preserved.
func (w *PruneWorker) reconcileStaleQueued(ctx context.Context, now time.Time) error {
	cutoff := pgtype.Timestamptz{Time: now.Add(-ExportWorkerLostAfter), Valid: true}
	afterCreated := pgtype.Timestamptz{Valid: true} // valid zero-time: NULL would hide rows
	var afterID uuid.UUID
	for {
		queued, err := w.q.ListStaleQueuedExports(ctx, gen.ListStaleQueuedExportsParams{
			Before:       cutoff,
			AfterCreated: afterCreated,
			AfterID:      afterID,
			BatchLimit:   staleExportBatchLimit,
		})
		if err != nil {
			return err
		}
		if len(queued) == 0 {
			return nil
		}
		for _, s := range queued {
			afterCreated, afterID = s.CreatedAt, s.ID
			live, err := w.hasLiveRiverJob(ctx, s.ID)
			if err != nil {
				return err
			}
			if live {
				continue
			}
			if _, err := w.q.FailQueuedExport(ctx, gen.FailQueuedExportParams{
				ErrorCode: &queuedDeliveryLostCode,
				ID:        s.ID,
			}); err != nil {
				return err
			}
		}
		if len(queued) < staleExportBatchLimit {
			return nil
		}
	}
}

func (w *PruneWorker) hasLiveRiverJob(ctx context.Context, jobID uuid.UUID) (bool, error) {
	var n int
	err := w.pool.QueryRow(ctx, `
		SELECT count(*)::int FROM river_job
		WHERE kind = $1
		  AND state IN ('available', 'running', 'retryable', 'scheduled')
		  AND args ->> 'job_id' = $2
	`, ExportJobKind, jobID.String()).Scan(&n)
	return n > 0, err
}

func (w *PruneWorker) markOneWorkerLost(ctx context.Context, s gen.ListStaleRunningExportsRow, cutoff pgtype.Timestamptz) error {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := w.q.WithTx(tx)

	n, err := q.MarkExportWorkerLost(ctx, gen.MarkExportWorkerLostParams{
		ID:        s.ID,
		AttemptID: s.AttemptID,
		Before:    cutoff,
	})
	if err != nil || n == 0 {
		return err
	}
	if s.AttemptID != nil {
		for _, ext := range []string{"tmp", "sabk.enc"} {
			if _, err := q.InsertExportFileCleanup(ctx, gen.InsertExportFileCleanupParams{
				FileName:  SafeFileName(s.ID, *s.AttemptID, ext),
				JobID:     s.ID,
				AttemptID: s.AttemptID,
				Reason:    CleanupReasonWorkerLost,
			}); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

// runPendingCleanups visits every pending export_file_cleanup row once per
// sweep by keyset-paging (created_at, id). A failing row stays pending (no
// done_at) and is retried on the next sweep; nothing is remembered across
// sweeps, so a repaired obligation settles on the following run (r2 R2-01),
// and a fully failing oldest page cannot hide later rows (r2 R2-02). All
// failures of this sweep are returned joined.
func (w *PruneWorker) runPendingCleanups(ctx context.Context) error {
	var (
		errs    []error
		afterAt = pgtype.Timestamptz{InfinityModifier: pgtype.NegativeInfinity, Valid: true}
		afterID uuid.UUID
	)
	for {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(errs, err)...)
		}
		rows, err := w.q.ListPendingCleanupAfter(ctx, gen.ListPendingCleanupAfterParams{
			AfterCreatedAt: afterAt,
			AfterID:        afterID,
			BatchLimit:     cleanupBatchSize,
		})
		if err != nil {
			return errors.Join(append(errs, err)...)
		}
		for _, r := range rows {
			if err := unlinkSafeFile(w.storageDir, r.FileName); err != nil {
				errs = append(errs, fmt.Errorf("cleanup %s: %w", r.ID, err))
				continue
			}
			if _, err := w.q.CompleteCleanup(ctx, r.ID); err != nil {
				errs = append(errs, fmt.Errorf("complete cleanup %s: %w", r.ID, err))
			}
		}
		if len(rows) < cleanupBatchSize {
			return errors.Join(errs...)
		}
		last := rows[len(rows)-1]
		afterAt, afterID = last.CreatedAt, last.ID
	}
}

func (w *PruneWorker) sweepOrphanFiles(ctx context.Context) error {
	if w.storageDir == "" {
		return nil
	}
	entries, err := os.ReadDir(w.storageDir)
	if err != nil {
		return fmt.Errorf("read export dir: %w", err)
	}
	liveRows, err := w.q.ListLiveExportAttempts(ctx)
	if err != nil {
		return fmt.Errorf("list live attempts: %w", err)
	}
	type pair struct{ job, attempt string }
	live := make(map[pair]struct{}, len(liveRows))
	for _, r := range liveRows {
		if r.AttemptID != nil {
			live[pair{r.ID.String(), r.AttemptID.String()}] = struct{}{}
		}
	}
	var errs []error
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !ValidateSafeFileName(name) {
			continue
		}
		parts := strings.SplitN(name, ".", 3)
		if len(parts) < 3 {
			continue
		}
		if _, ok := live[pair{parts[0], parts[1]}]; ok {
			continue
		}
		if err := unlinkSafeFile(w.storageDir, name); err != nil {
			errs = append(errs, fmt.Errorf("orphan %s: %w", name, err))
		}
	}
	return errors.Join(errs...)
}
