package worker

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
)

type AuthPruneArgs struct {
	RetentionDays int `json:"retention_days"`
}

func (AuthPruneArgs) Kind() string { return "auth_prune" }

type AuthPruneWorker struct {
	river.WorkerDefaults[AuthPruneArgs]
	pool *pgxpool.Pool
	clk  clock.Clock
}

func NewAuthPruneWorker(pool *pgxpool.Pool, clk clock.Clock) *AuthPruneWorker {
	if clk == nil {
		clk = clock.System{}
	}
	return &AuthPruneWorker{pool: pool, clk: clk}
}

func (w *AuthPruneWorker) Work(ctx context.Context, job *river.Job[AuthPruneArgs]) error {
	days := job.Args.RetentionDays
	if days < 1 {
		days = 90
	}
	now := w.clk.Now()
	q := gen.New(w.pool)
	auditCut := pgtype.Timestamptz{Time: now.AddDate(0, 0, -days).UTC(), Valid: true}
	expired := pgtype.Timestamptz{Time: now.Add(-24 * time.Hour).UTC(), Valid: true}
	if _, err := q.DeleteAuditOlderThan(ctx, auditCut); err != nil {
		return err
	}
	if _, err := q.DeleteNotificationsOlderThan(ctx, auditCut); err != nil {
		return err
	}
	if _, err := q.DeleteExpiredVerifications(ctx, expired); err != nil {
		return err
	}
	if _, err := q.DeleteExpiredOAuthTransactions(ctx, expired); err != nil {
		return err
	}
	if _, err := q.DeleteExpiredReceipts(ctx, expired); err != nil {
		return err
	}
	if _, err := q.DeleteInactiveThrottle(ctx, expired); err != nil {
		return err
	}
	if _, err := q.DeleteRefreshUsedForDeadSessions(ctx, pgtype.Timestamptz{Time: now.Add(-24 * time.Hour).UTC(), Valid: true}); err != nil {
		return err
	}
	return nil
}
