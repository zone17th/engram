package auth

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
)

const (
	LockoutFailThreshold = 5
	LockoutInitial       = time.Minute
	LockoutMax           = time.Hour
	LockoutResetIdle     = 24 * time.Hour
)

type Lockout struct {
	pool *pgxpool.Pool
	q    *gen.Queries
	clk  clock.Clock
}

func NewLockout(pool *pgxpool.Pool, clk clock.Clock) *Lockout {
	if clk == nil {
		clk = clock.System{}
	}
	return &Lockout{pool: pool, q: gen.New(pool), clk: clk}
}

type LockoutState struct {
	FailedCount int32
	LockedUntil time.Time
	Captcha     bool
	RetryAfter  int
}

func (l *Lockout) State(ctx context.Context, subject []byte) (LockoutState, error) {
	row, err := l.q.GetThrottleForUpdate(ctx, subject)
	if err != nil {
		return LockoutState{}, err
	}
	return l.fromRow(row), nil
}

func (l *Lockout) RecordFailure(ctx context.Context, subject []byte) (LockoutState, error) {
	tx, err := l.pool.Begin(ctx)
	if err != nil {
		return LockoutState{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := l.q.WithTx(tx)
	row, err := q.GetThrottleForUpdate(ctx, subject)
	if err != nil {
		return LockoutState{}, err
	}
	now := l.clk.Now()
	count := row.FailedCount
	if row.LastFailedAt.Valid && now.Sub(row.LastFailedAt.Time) >= LockoutResetIdle {
		count = 0
	}
	count++
	var locked pgtype.Timestamptz
	if count >= LockoutFailThreshold {
		dur := LockoutInitial
		extra := count - LockoutFailThreshold
		for i := int32(0); i < extra; i++ {
			dur *= 2
			if dur > LockoutMax {
				dur = LockoutMax
				break
			}
		}
		locked = pgts(now.Add(dur))
	}
	row, err = q.UpdateThrottle(ctx, gen.UpdateThrottleParams{
		SubjectHash:  subject,
		FailedCount:  count,
		LockedUntil:  locked,
		LastFailedAt: pgts(now),
	})
	if err != nil {
		return LockoutState{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return LockoutState{}, err
	}
	return l.fromRow(row), nil
}

func (l *Lockout) Reset(ctx context.Context, subject []byte) error {
	return l.q.ResetThrottle(ctx, subject)
}

func (l *Lockout) fromRow(row gen.AuthThrottle) LockoutState {
	now := l.clk.Now()
	st := LockoutState{FailedCount: row.FailedCount, Captcha: row.FailedCount >= LockoutFailThreshold}
	if row.LockedUntil.Valid && row.LockedUntil.Time.After(now) {
		st.LockedUntil = row.LockedUntil.Time
		st.RetryAfter = int(row.LockedUntil.Time.Sub(now).Seconds())
		if st.RetryAfter < 1 {
			st.RetryAfter = 1
		}
	}
	return st
}
