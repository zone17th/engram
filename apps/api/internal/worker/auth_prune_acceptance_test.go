package worker_test

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/worker"
)

func pruneHash(seed byte) []byte {
	return bytes.Repeat([]byte{seed}, 32)
}

func TestAuthPruneHonorsBoundariesAndIsIdempotent(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(now)
	auditCut := now.AddDate(0, 0, -90)
	expiredCut := now.Add(-24 * time.Hour)

	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email, locale) VALUES ($1, 'en') RETURNING id`, "prune@example.com").Scan(&userID); err != nil {
		t.Fatal(err)
	}

	auditTimes := []time.Time{auditCut.Add(-time.Second), auditCut, auditCut.Add(time.Second)}
	for _, createdAt := range auditTimes {
		if _, err := pool.Exec(ctx, `INSERT INTO audit_log (event, result, created_at) VALUES ('auth.login.failure', 'failure', $1)`, createdAt); err != nil {
			t.Fatal(err)
		}
	}
	noticeTimes := []time.Time{auditCut.Add(-time.Second), auditCut, auditCut.Add(time.Second)}
	for _, createdAt := range noticeTimes {
		if _, err := pool.Exec(ctx, `INSERT INTO user_notification (user_id, kind, meta, created_at) VALUES ($1, 'security', '{}'::jsonb, $2)`, userID, createdAt); err != nil {
			t.Fatal(err)
		}
	}

	verificationTimes := []time.Time{expiredCut.Add(-time.Second), expiredCut, expiredCut.Add(time.Second)}
	for i, expiresAt := range verificationTimes {
		if _, err := pool.Exec(ctx, `INSERT INTO email_verification (user_id, purpose, target_email, token_hash, expires_at, created_at) VALUES ($1, 'signup', 'prune@example.com', $2, $3, $4)`, userID, pruneHash(byte(10+i)), expiresAt, now); err != nil {
			t.Fatal(err)
		}
	}

	oauthTimes := []time.Time{expiredCut.Add(-time.Second), expiredCut, expiredCut.Add(time.Second)}
	for i, expiresAt := range oauthTimes {
		if _, err := pool.Exec(ctx, `INSERT INTO oauth_transaction (provider, mode, status, state_hash, cookie_binding_hash, started_at, expires_at) VALUES ('google', 'login', 'pending', $1, $2, $3, $4)`, pruneHash(byte(20+i)), pruneHash(byte(30+i)), now, expiresAt); err != nil {
			t.Fatal(err)
		}
	}

	insertSession := func(seed byte, revokedAt any) uuid.UUID {
		t.Helper()
		var sessionID uuid.UUID
		if err := pool.QueryRow(ctx, `INSERT INTO session (user_id, refresh_token_hash, created_at, last_seen_at, expires_at, revoked_at) VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`, userID, pruneHash(seed), now, now.Add(30*24*time.Hour), revokedAt).Scan(&sessionID); err != nil {
			t.Fatal(err)
		}
		return sessionID
	}
	liveSession := insertSession(40, nil)
	for i, expiresAt := range verificationTimes {
		if _, err := pool.Exec(ctx, `INSERT INTO oauth_reauth_receipt (user_id, session_id, provider, action, token_hash, expires_at, created_at) VALUES ($1, $2, 'google', 'account.password_change', $3, $4, $5)`, userID, liveSession, pruneHash(byte(40+i+1)), expiresAt, now); err != nil {
			t.Fatal(err)
		}
	}

	throttleTimes := []any{nil, expiredCut.Add(-time.Second), expiredCut, expiredCut.Add(time.Second)}
	for i, lastFailedAt := range throttleTimes {
		if _, err := pool.Exec(ctx, `INSERT INTO auth_throttle (subject_hash, failed_count, last_failed_at) VALUES ($1, 1, $2)`, pruneHash(byte(50+i)), lastFailedAt); err != nil {
			t.Fatal(err)
		}
	}

	deadSession := insertSession(60, expiredCut.Add(-time.Second))
	exactSession := insertSession(61, expiredCut)
	currentSession := insertSession(62, nil)
	for i, sessionID := range []uuid.UUID{deadSession, exactSession, currentSession} {
		if _, err := pool.Exec(ctx, `INSERT INTO session_refresh_used (token_hash, session_id, used_at) VALUES ($1, $2, $3)`, pruneHash(byte(70+i)), sessionID, now); err != nil {
			t.Fatal(err)
		}
	}

	pruner := worker.NewAuthPruneWorker(pool, clk)
	job := &river.Job[worker.AuthPruneArgs]{Args: worker.AuthPruneArgs{RetentionDays: 90}}
	if err := pruner.Work(ctx, job); err != nil {
		t.Fatal(err)
	}

	tables := []struct {
		name string
		want int
	}{
		{name: "audit_log", want: 2},
		{name: "user_notification", want: 2},
		{name: "email_verification", want: 2},
		{name: "oauth_transaction", want: 2},
		{name: "oauth_reauth_receipt", want: 2},
		{name: "auth_throttle", want: 2},
		{name: "session_refresh_used", want: 2},
	}
	for _, table := range tables {
		var got int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table.name).Scan(&got); err != nil {
			t.Fatalf("count %s: %v", table.name, err)
		}
		if got != table.want {
			t.Fatalf("after first prune %s = %d, want %d", table.name, got, table.want)
		}
	}

	if err := pruner.Work(ctx, job); err != nil {
		t.Fatal(err)
	}
	for _, table := range tables {
		var got int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+table.name).Scan(&got); err != nil {
			t.Fatalf("count %s after repeat: %v", table.name, err)
		}
		if got != table.want {
			t.Fatalf("after repeat prune %s = %d, want %d", table.name, got, table.want)
		}
	}
}
