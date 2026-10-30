package worker_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/worker"
)

// TestWebAuthnChallengePruneHonorsBoundaryBatchesAndIsIdempotent verifies Task 13:
//   - expired rows (`expires_at < now`) are deleted;
//   - boundary row (`expires_at == now`) and future rows (`expires_at > now`) survive;
//   - rerunning at the same clock instant is idempotent (0 additional rows deleted);
//   - batched mode (`BatchSize`, `MaxBatches`) deletes only up to `BatchSize * MaxBatches` oldest expired rows per run.
func TestWebAuthnChallengePruneHonorsBoundaryBatchesAndIsIdempotent(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(now)

	var userID, sessionID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO app_user (email, locale) VALUES ($1, 'en') RETURNING id`,
		"webauthn-prune@example.com",
	).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO session (user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id`,
		userID,
		[]byte("0123456789abcdef0123456789abcdef"),
		now.Add(24*time.Hour),
	).Scan(&sessionID); err != nil {
		t.Fatalf("seed session: %v", err)
	}

	q := gen.New(pool)
	seedSeq := byte(1)
	insertChallenge := func(expiresAt time.Time, consumed bool) uuid.UUID {
		t.Helper()
		hash := make([]byte, 32)
		salt := make([]byte, 32)
		for i := range 32 {
			hash[i] = seedSeq + byte(i)
			salt[i] = seedSeq + 0x40 + byte(i)
		}
		seedSeq++
		row, err := q.InsertWebAuthnChallenge(ctx, gen.InsertWebAuthnChallengeParams{
			UserID:        userID,
			SessionID:     sessionID,
			VaultKeyID:    "vk:AAECAwQFBgcICQoLDA0ODw",
			ChallengeHash: hash,
			PrfSalt:       salt,
			ExpiresAt:     pgtype.Timestamptz{Time: expiresAt.UTC(), Valid: true},
		})
		if err != nil {
			t.Fatalf("InsertWebAuthnChallenge: %v", err)
		}
		if consumed {
			if _, err := pool.Exec(ctx, `UPDATE webauthn_challenge SET consumed_at = $1 WHERE id = $2`, now.Add(-2*time.Minute), row.ID); err != nil {
				t.Fatalf("mark consumed: %v", err)
			}
		}
		return row.ID
	}

	// 3 expired rows (expires_at < now), 1 exact boundary (expires_at == now), 2 future rows (expires_at > now).
	expOldest := insertChallenge(now.Add(-10*time.Minute), false)
	expConsumed := insertChallenge(now.Add(-5*time.Minute), true)
	expJustBefore := insertChallenge(now.Add(-time.Microsecond), false)
	exactBoundary := insertChallenge(now, false)
	futureUnconsumed := insertChallenge(now.Add(5*time.Minute), false)
	futureConsumed := insertChallenge(now.Add(2*time.Minute), true)

	pruner := worker.NewWebAuthnChallengePruneWorker(pool, clk)

	// 1. Batched run with BatchSize=2, MaxBatches=1 deletes the 2 oldest expired rows first.
	if err := pruner.Work(ctx, &river.Job[worker.WebAuthnChallengePruneArgs]{
		Args: worker.WebAuthnChallengePruneArgs{BatchSize: 2, MaxBatches: 1},
	}); err != nil {
		t.Fatalf("batched prune Work: %v", err)
	}

	existsByID := func(id uuid.UUID) bool {
		t.Helper()
		var ok bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM webauthn_challenge WHERE id = $1)`, id).Scan(&ok); err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if existsByID(expOldest) || existsByID(expConsumed) {
		t.Fatal("expected 2 oldest expired challenges to be deleted in first batch")
	}
	if !existsByID(expJustBefore) {
		t.Fatal("expected 3rd expired challenge to remain after 1 batch of size 2")
	}

	// 2. Default run with empty args deletes the remaining expired row while preserving boundary and future rows.
	if err := pruner.Work(ctx, &river.Job[worker.WebAuthnChallengePruneArgs]{
		Args: worker.WebAuthnChallengePruneArgs{},
	}); err != nil {
		t.Fatalf("default prune Work: %v", err)
	}
	if existsByID(expJustBefore) {
		t.Fatal("expected remaining expired challenge to be deleted")
	}
	if !existsByID(exactBoundary) || !existsByID(futureUnconsumed) || !existsByID(futureConsumed) {
		t.Fatal("expected boundary and future challenges to survive")
	}

	// 3. Re-running at the same instant is idempotent.
	if err := pruner.Work(ctx, &river.Job[worker.WebAuthnChallengePruneArgs]{
		Args: worker.WebAuthnChallengePruneArgs{},
	}); err != nil {
		t.Fatalf("repeat prune Work: %v", err)
	}
	if !existsByID(exactBoundary) || !existsByID(futureUnconsumed) || !existsByID(futureConsumed) {
		t.Fatal("expected boundary and future challenges to survive repeat run")
	}

	// 4. Advancing clock by 1 microsecond makes exactBoundary expired (`expires_at < now`) -> deleted.
	clk.Advance(time.Microsecond)
	if err := pruner.Work(ctx, &river.Job[worker.WebAuthnChallengePruneArgs]{
		Args: worker.WebAuthnChallengePruneArgs{},
	}); err != nil {
		t.Fatalf("prune after +1us: %v", err)
	}
	if existsByID(exactBoundary) {
		t.Fatal("expected exactBoundary to be pruned after +1us clock advance")
	}
	if !existsByID(futureUnconsumed) || !existsByID(futureConsumed) {
		t.Fatal("expected future challenges to remain")
	}

	// 5. Default scheduled run (empty WebAuthnChallengePruneArgs{}) is bounded by
	//    DefaultWebAuthnChallengePruneBatchSize * DefaultWebAuthnChallengePruneMaxBatches (500 * 100 = 50,000):
	//    a backlog of 50,002 expired rows deletes only the 50,000 oldest expired rows on the first run,
	//    leaving the 2 newest expired rows for the next run while preserving exact-boundary and future rows.
	curNow := clk.Now().UTC()
	boundaryAtCurNow := insertChallenge(curNow, false)
	defaultCapacity := int(worker.DefaultWebAuthnChallengePruneBatchSize) * worker.DefaultWebAuthnChallengePruneMaxBatches
	backlogCount := defaultCapacity + 2
	if _, err := pool.Exec(ctx, `
		INSERT INTO webauthn_challenge (user_id, session_id, vault_key_id, challenge_hash, prf_salt, expires_at)
		SELECT $1,
		       $2,
		       'vk:AAECAwQFBgcICQoLDA0ODw',
		       decode(lpad(to_hex(g), 64, '0'), 'hex'),
		       decode(lpad(to_hex(g), 64, '0'), 'hex'),
		       $3::timestamptz - (g * interval '1 microsecond')
		FROM generate_series(1, $4::int) AS g
	`, userID, sessionID, curNow, backlogCount); err != nil {
		t.Fatalf("seed expired backlog (%d rows): %v", backlogCount, err)
	}

	// First empty-args run deletes exactly defaultCapacity (50,000) oldest expired rows and leaves 2 expired rows.
	if err := pruner.Work(ctx, &river.Job[worker.WebAuthnChallengePruneArgs]{
		Args: worker.WebAuthnChallengePruneArgs{},
	}); err != nil {
		t.Fatalf("empty-args bounded prune run 1: %v", err)
	}

	var remainingExpired int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM webauthn_challenge WHERE expires_at < $1`,
		pgtype.Timestamptz{Time: curNow, Valid: true},
	).Scan(&remainingExpired); err != nil {
		t.Fatalf("count remaining expired after run 1: %v", err)
	}
	if remainingExpired != 2 {
		t.Fatalf("remaining expired rows after 1st empty-args run = %d, want 2 (default capacity %d)", remainingExpired, defaultCapacity)
	}
	if !existsByID(boundaryAtCurNow) || !existsByID(futureUnconsumed) || !existsByID(futureConsumed) {
		t.Fatal("expected exact-boundary and future challenges to survive 1st empty-args backlog run")
	}

	// Second empty-args run deletes the remaining 2 expired rows and preserves boundary + future rows.
	if err := pruner.Work(ctx, &river.Job[worker.WebAuthnChallengePruneArgs]{
		Args: worker.WebAuthnChallengePruneArgs{},
	}); err != nil {
		t.Fatalf("empty-args bounded prune run 2: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM webauthn_challenge WHERE expires_at < $1`,
		pgtype.Timestamptz{Time: curNow, Valid: true},
	).Scan(&remainingExpired); err != nil {
		t.Fatalf("count remaining expired after run 2: %v", err)
	}
	if remainingExpired != 0 {
		t.Fatalf("remaining expired rows after 2nd empty-args run = %d, want 0", remainingExpired)
	}
	if !existsByID(boundaryAtCurNow) || !existsByID(futureUnconsumed) || !existsByID(futureConsumed) {
		t.Fatal("expected exact-boundary and future challenges to survive 2nd empty-args backlog run")
	}
}

func TestWebAuthnChallengePruneJobRegisteredInRiverClient(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	client, err := worker.New(pool, silentLogger())
	if err != nil {
		t.Fatalf("worker.New: %v", err)
	}
	startCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := client.Start(startCtx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer stopCancel()
		_ = client.Stop(stopCtx)
	}()

	subscribeCh, subscribeCancel := client.Subscribe(river.EventKindJobCompleted)
	defer subscribeCancel()

	if _, err := client.Insert(ctx, worker.WebAuthnChallengePruneArgs{}, nil); err != nil {
		t.Fatalf("Insert WebAuthnChallengePruneArgs: %v", err)
	}

	timeout := time.After(10 * time.Second)
	for {
		select {
		case ev := <-subscribeCh:
			if ev != nil && ev.Job != nil && ev.Job.Kind == (worker.WebAuthnChallengePruneArgs{}).Kind() {
				return
			}
		case <-timeout:
			t.Fatal("timeout waiting for webauthn_challenge_prune job completion")
		}
	}
}
