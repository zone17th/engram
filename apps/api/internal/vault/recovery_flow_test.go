package vault_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/audit"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/notification"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
)

type failingRecoverMailer struct {
	calls atomic.Int32
}

func (m *failingRecoverMailer) Send(_ context.Context, _, _, _ string) error {
	m.calls.Add(1)
	return errors.New("simulated smtp outage")
}

func gatherCounterValue(t *testing.T, reg *prometheus.Registry, name string, labelName, labelVal string) float64 {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("reg.Gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() != name {
			continue
		}
		for _, m := range f.GetMetric() {
			if labelName == "" {
				return m.GetCounter().GetValue()
			}
			for _, lbl := range m.GetLabel() {
				if lbl.GetName() == labelName && lbl.GetValue() == labelVal {
					return m.GetCounter().GetValue()
				}
			}
		}
	}
	return 0
}

// pollBlockedBackendPID polls Postgres `pg_stat_activity` + `pg_blocking_pids` until a second
// backend in `current_database()` is actively blocked on `holdPID` (the winner holding the vault
// FOR UPDATE row lock), returning immediately with the failing worker's diagnostic if any worker
// finishes early before blocking is observed.
func pollBlockedBackendPID(ctx context.Context, pool *pgxpool.Pool, holdPID int32, earlyDone <-chan int, formatEarly func(int) string) (int32, error) {
	if holdPID == 0 {
		return 0, errors.New("winner backend PID is 0")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiterPID int32
		if err := pool.QueryRow(ctx, `
			SELECT COALESCE((
				SELECT a.pid
				FROM pg_stat_activity AS a
				WHERE a.datname = current_database()
				  AND a.pid <> $1
				  AND $1 = ANY(pg_blocking_pids(a.pid))
				LIMIT 1
			), 0)
		`, holdPID).Scan(&waiterPID); err != nil {
			return 0, fmt.Errorf("query pg_blocking_pids for holdPID=%d: %w", holdPID, err)
		}
		if waiterPID != 0 {
			return waiterPID, nil
		}
		select {
		case idx := <-earlyDone:
			detail := ""
			if formatEarly != nil {
				detail = ": " + formatEarly(idx)
			}
			return 0, fmt.Errorf("worker %d finished early before second backend blocked on holdPID=%d%s", idx, holdPID, detail)
		default:
		}
		if time.Now().After(deadline) {
			return 0, fmt.Errorf("timed out waiting for second backend to block on vault row lock held by pid=%d", holdPID)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForBlockedBackendPID(t *testing.T, ctx context.Context, pool *pgxpool.Pool, holdPID int32, earlyDone <-chan int, formatEarly func(int) string) int32 {
	t.Helper()
	waiterPID, err := pollBlockedBackendPID(ctx, pool, holdPID, earlyDone, formatEarly)
	if err != nil {
		t.Fatal(err)
	}
	return waiterPID
}

func TestServiceRecoveryLookupAndComplete(t *testing.T) {
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
	reg := prometheus.NewRegistry()
	metrics := vault.NewMetrics(reg)
	mailer := &failingRecoverMailer{}

	svc, err := vault.NewService(cfg, pool, clk, aud, notes, mailer, metrics, nil, logger)
	if err != nil {
		t.Fatalf("vault.NewService: %v", err)
	}

	q := gen.New(pool)
	userA, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "recover-svc-a@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser A: %v", err)
	}
	userB, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "recover-svc-b@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser B: %v", err)
	}
	// Mark user A email verified so best-effort mail adapter is exercised (and fails without rolling back).
	if _, err := pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, userA.ID); err != nil {
		t.Fatalf("verify userA email: %v", err)
	}

	pA := authctx.Principal{UserID: userA.ID, SessionID: uuid.New()}
	pB := authctx.Principal{UserID: userB.ID, SessionID: uuid.New()}

	inA := makeValidCreateInput(t, 0x10)
	inA.KDFRaw = json.RawMessage(`{"alg":"argon2id13","ops":4,"mem":134217728,"parallelism":1,"salt":"` + vault.EncodeBase64URL(seqBytes(16, 0x10)) + `"}`)
	createdA, err := svc.Create(ctx, pA, inA)
	if err != nil {
		t.Fatalf("svc.Create(A): %v", err)
	}
	inB := makeValidCreateInput(t, 0x60)
	createdB, err := svc.Create(ctx, pB, inB)
	if err != nil {
		t.Fatalf("svc.Create(B): %v", err)
	}

	// 1. RecoveryLookup hit for User A slot 1 does NOT consume the RK and does not increment failure counter.
	hit1, err := svc.RecoveryLookup(ctx, pA, vault.RecoveryLookupInput{
		LookupHash: inA.RecoveryKeys[0].LookupHash,
	})
	if err != nil {
		t.Fatalf("RecoveryLookup hit1: %v", err)
	}
	if hit1.RecoveryKeyID == uuid.Nil || hit1.Wrap != inA.RecoveryKeys[0].Wrap {
		t.Fatalf("RecoveryLookup hit1 = %+v, want wrap %q", hit1, inA.RecoveryKeys[0].Wrap)
	}
	hit2, err := svc.RecoveryLookup(ctx, pA, vault.RecoveryLookupInput{
		LookupHash: inA.RecoveryKeys[0].LookupHash,
	})
	if err != nil || hit2.RecoveryKeyID != hit1.RecoveryKeyID || hit2.Wrap != hit1.Wrap {
		t.Fatalf("second RecoveryLookup must not consume RK: %+v, err=%v", hit2, err)
	}
	if gotFail := gatherCounterValue(t, reg, "vault_unlock_failures_total", "method", "recovery"); gotFail != 0 {
		t.Fatalf("vault_unlock_failures_total after hits = %v, want 0", gotFail)
	}

	// 2. RecoveryLookup miss (unknown hash and cross-user hash) -> ErrRecoveryKeyInvalid and increments failure counter.
	unknownHash := vault.EncodeBase64URL(seqBytes(32, 0xFE))
	if _, err := svc.RecoveryLookup(ctx, pA, vault.RecoveryLookupInput{LookupHash: unknownHash}); !errors.Is(err, vault.ErrRecoveryKeyInvalid) {
		t.Fatalf("RecoveryLookup unknown hash = %v, want ErrRecoveryKeyInvalid", err)
	}
	// User B tries to look up User A's RK -> ErrRecoveryKeyInvalid.
	if _, err := svc.RecoveryLookup(ctx, pB, vault.RecoveryLookupInput{LookupHash: inA.RecoveryKeys[0].LookupHash}); !errors.Is(err, vault.ErrRecoveryKeyInvalid) {
		t.Fatalf("RecoveryLookup cross-user hash = %v, want ErrRecoveryKeyInvalid", err)
	}
	if gotFail := gatherCounterValue(t, reg, "vault_unlock_failures_total", "method", "recovery"); gotFail != 2 {
		t.Fatalf("vault_unlock_failures_total after 2 misses = %v, want 2", gotFail)
	}

	// 3. RecoverComplete validation: wrong user's RK -> ErrRecoveryKeyInvalid (401); stale version -> 412;
	// reused salt / lowered ops only / lowered mem only -> ErrVaultKDFInvalid (BE1-14); invalid wrap -> ErrVaultWrapInvalid.
	freshSalt := vault.EncodeBase64URL(seqBytes(16, 0x99))
	validNewKDF := json.RawMessage(`{"alg":"argon2id13","ops":4,"mem":134217728,"parallelism":1,"salt":"` + freshSalt + `"}`)
	validNewWrap := makeValidWrapB64U(t, vault.WrapKindKEK, 0x99)
	// User B tries to complete recovery using User A's RecoveryKeyID.
	_, err = svc.RecoverComplete(ctx, pB, vault.RecoverCompleteInput{
		RecoveryKeyID:        hit1.RecoveryKeyID,
		KDFRaw:               validNewKDF,
		VaultKeyWrappedByKEK: validNewWrap,
		IfMatch:              httpx.VaultIfMatch{VaultKeyID: createdB.VaultKeyID, Version: 1},
	})
	if !errors.Is(err, vault.ErrRecoveryKeyInvalid) {
		t.Fatalf("RecoverComplete with another user's RK = %v, want ErrRecoveryKeyInvalid", err)
	}

	// Stale version -> version_mismatch with current_version=1.
	_, err = svc.RecoverComplete(ctx, pA, vault.RecoverCompleteInput{
		RecoveryKeyID:        hit1.RecoveryKeyID,
		KDFRaw:               validNewKDF,
		VaultKeyWrappedByKEK: validNewWrap,
		IfMatch:              httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 2},
	})
	if ve, ok := vault.AsError(err); !ok || ve.Code != "version_mismatch" || ve.CurrentVersion == nil || *ve.CurrentVersion != 1 {
		t.Fatalf("RecoverComplete stale version = %v (%+v), want version_mismatch(1)", err, ve)
	}

	// Reused salt -> ErrVaultKDFInvalid.
	_, err = svc.RecoverComplete(ctx, pA, vault.RecoverCompleteInput{
		RecoveryKeyID:        hit1.RecoveryKeyID,
		KDFRaw:               inA.KDFRaw,
		VaultKeyWrappedByKEK: validNewWrap,
		IfMatch:              httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
	})
	if !errors.Is(err, vault.ErrVaultKDFInvalid) {
		t.Fatalf("RecoverComplete reused salt = %v, want ErrVaultKDFInvalid", err)
	}

	// Against current {ops:4, mem:134217728}, independently reject fresh-salt {ops:3, mem:134217728}
	// and {ops:4, mem:67108864} (BE1-14).
	for _, tc := range []struct {
		name string
		kdf  json.RawMessage
	}{
		{
			name: "lower_ops_only",
			kdf:  json.RawMessage(`{"alg":"argon2id13","ops":3,"mem":134217728,"parallelism":1,"salt":"` + freshSalt + `"}`),
		},
		{
			name: "lower_mem_only",
			kdf:  json.RawMessage(`{"alg":"argon2id13","ops":4,"mem":67108864,"parallelism":1,"salt":"` + freshSalt + `"}`),
		},
	} {
		_, err = svc.RecoverComplete(ctx, pA, vault.RecoverCompleteInput{
			RecoveryKeyID:        hit1.RecoveryKeyID,
			KDFRaw:               tc.kdf,
			VaultKeyWrappedByKEK: validNewWrap,
			IfMatch:              httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
		})
		if !errors.Is(err, vault.ErrVaultKDFInvalid) {
			t.Fatalf("RecoverComplete(%s) = %v, want ErrVaultKDFInvalid", tc.name, err)
		}
	}

	// Invalid wrap -> ErrVaultWrapInvalid.
	_, err = svc.RecoverComplete(ctx, pA, vault.RecoverCompleteInput{
		RecoveryKeyID:        hit1.RecoveryKeyID,
		KDFRaw:               validNewKDF,
		VaultKeyWrappedByKEK: vault.EncodeBase64URL(seqBytes(40, 0x01)),
		IfMatch:              httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
	})
	if !errors.Is(err, vault.ErrVaultWrapInvalid) {
		t.Fatalf("RecoverComplete invalid wrap = %v, want ErrVaultWrapInvalid", err)
	}

	// 4. Successful RecoverComplete (even when mailer fails after commit):
	// updates KDF + wrapK, increments version to 2, deletes the RK row, records vault.recover + recovery_key.consume,
	// creates security notice, increments vault_recover_total.
	completeResp, err := svc.RecoverComplete(ctx, pA, vault.RecoverCompleteInput{
		RecoveryKeyID:        hit1.RecoveryKeyID,
		KDFRaw:               validNewKDF,
		VaultKeyWrappedByKEK: validNewWrap,
		IfMatch:              httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
		IP:                   "127.0.0.1",
		UA:                   "recover-service-test",
	})
	if err != nil {
		t.Fatalf("RecoverComplete: %v", err)
	}
	if completeResp.Version != 2 {
		t.Fatalf("completeResp.Version = %d, want 2", completeResp.Version)
	}
	if mailer.calls.Load() != 0 {
		t.Fatalf("direct mailer calls before worker run = %d, want 0", mailer.calls.Load())
	}
	ranJobs, workErr := runQueuedSecurityNoticeJobs(ctx, pool, mailer, logger)
	if ranJobs != 1 || workErr == nil {
		t.Fatalf("runQueuedSecurityNoticeJobs = (%d, %v), want (1, non-nil mailer error)", ranJobs, workErr)
	}
	if mailer.calls.Load() != 1 {
		t.Fatalf("expected mailer to be called once by worker after commit, got %d", mailer.calls.Load())
	}
	if gotRecoverTotal := gatherCounterValue(t, reg, "vault_recover_total", "", ""); gotRecoverTotal != 1 {
		t.Fatalf("vault_recover_total = %v, want 1", gotRecoverTotal)
	}

	// Consumed RK is deleted: lookup now returns ErrRecoveryKeyInvalid and remaining is 9 with slot 1 in empty_slots.
	if _, err := svc.RecoveryLookup(ctx, pA, vault.RecoveryLookupInput{LookupHash: inA.RecoveryKeys[0].LookupHash}); !errors.Is(err, vault.ErrRecoveryKeyInvalid) {
		t.Fatalf("RecoveryLookup consumed RK = %v, want ErrRecoveryKeyInvalid", err)
	}
	rkStatus, err := svc.GetRecoveryKeysStatus(ctx, userA.ID)
	if err != nil {
		t.Fatalf("GetRecoveryKeysStatus: %v", err)
	}
	if rkStatus.Remaining != 9 || len(rkStatus.EmptySlots) != 1 || rkStatus.EmptySlots[0] != 1 {
		t.Fatalf("rkStatus after consume = %+v, want remaining=9 empty=[1]", rkStatus)
	}

	// Logs and audit_log never contain lookup_hash or wraps.
	logs := logBuf.String()
	for _, secret := range []string{inA.RecoveryKeys[0].LookupHash, inA.RecoveryKeys[0].Wrap, validNewWrap, freshSalt} {
		if strings.Contains(logs, secret) {
			t.Fatalf("logs leaked secret %q: %s", secret, logs)
		}
	}
}

func TestServiceRecoverCompleteBarrierConcurrentSameRK(t *testing.T) {
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

	clk := clock.NewFixed(time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC))
	aud := audit.NewStore(pool)
	notes := notification.NewStore(pool, nil)
	reg := prometheus.NewRegistry()
	metrics := vault.NewMetrics(reg)

	svc, err := vault.NewService(cfg, pool, clk, aud, notes, nil, metrics, nil, nil)
	if err != nil {
		t.Fatalf("vault.NewService: %v", err)
	}

	q := gen.New(pool)
	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "barrier-svc@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	p := authctx.Principal{UserID: user.ID, SessionID: uuid.New()}

	inCreate := makeValidCreateInput(t, 0x30)
	created, err := svc.Create(ctx, p, inCreate)
	if err != nil {
		t.Fatalf("svc.Create: %v", err)
	}

	lookupRes, err := svc.RecoveryLookup(ctx, p, vault.RecoveryLookupInput{
		LookupHash: inCreate.RecoveryKeys[0].LookupHash,
	})
	if err != nil {
		t.Fatalf("RecoveryLookup: %v", err)
	}

	// Hold the winner right after LockVaultAndCheckIfMatch (while holding the vault FOR UPDATE lock)
	// and wait until Postgres pg_blocking_pids proves the loser is blocked on the winner's backend PID.
	var arrived atomic.Int32
	var winnerPID atomic.Int32
	winnerLocked := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	closeRelease := func() { releaseOnce.Do(func() { close(release) }) }

	type result struct {
		resp       vault.VaultVersionResponse
		err        error
		finishedAt time.Time
	}
	results := make([]result, 2)
	earlyDone := make(chan int, 2)
	var wg sync.WaitGroup
	barrierCtx, cancelBarrier := context.WithCancel(ctx)
	cleanupBarrier := func() {
		closeRelease()
		cancelBarrier()
		vault.SetRecoverCompleteTestHook(nil)
		wg.Wait()
	}
	t.Cleanup(cleanupBarrier)
	defer cleanupBarrier()
	vault.SetRecoverCompleteTestHook(func(hookCtx context.Context) {
		if arrived.Add(1) == 1 {
			winnerPID.Store(vault.TestHookBackendPIDFrom(hookCtx))
			close(winnerLocked)
			select {
			case <-release:
			case <-hookCtx.Done():
			}
		}
	})

	for i := range 2 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			salt := vault.EncodeBase64URL(seqBytes(16, byte(0x80+idx*7)))
			kdfRaw := json.RawMessage(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + salt + `"}`)
			wrap := makeValidWrapB64U(t, vault.WrapKindKEK, byte(0x80+idx*7))
			resp, err := svc.RecoverComplete(ctx, p, vault.RecoverCompleteInput{
				RecoveryKeyID:        lookupRes.RecoveryKeyID,
				KDFRaw:               kdfRaw,
				VaultKeyWrappedByKEK: wrap,
				IfMatch:              httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 1},
				IP:                   "127.0.0.1",
				UA:                   "barrier-test",
			})
			results[idx] = result{resp: resp, err: err, finishedAt: time.Now()}
			earlyDone <- idx
		}(i)
	}

	select {
	case <-winnerLocked:
	case idx := <-earlyDone:
		t.Fatalf("worker %d finished before winner reached vault lock hook: %+v", idx, results[idx])
	case <-barrierCtx.Done():
		t.Fatalf("barrier context cancelled before winner reached vault lock hook: %v", barrierCtx.Err())
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for winner to acquire vault row lock in RecoverComplete")
	}

	holdPID := winnerPID.Load()
	waiterPID := waitForBlockedBackendPID(t, ctx, pool, holdPID, earlyDone, func(idx int) string {
		return fmt.Sprintf("%+v", results[idx])
	})
	if waiterPID == 0 || waiterPID == holdPID {
		t.Fatalf("invalid waiterPID=%d for holdPID=%d", waiterPID, holdPID)
	}

	releasedAt := time.Now()
	closeRelease()
	wg.Wait()
	vault.SetRecoverCompleteTestHook(nil)

	successes := 0
	losers := 0
	for i, r := range results {
		if r.err == nil {
			if r.resp.Version != 2 {
				t.Fatalf("goroutine %d succeeded with version=%d, want 2", i, r.resp.Version)
			}
			successes++
			continue
		}
		if r.finishedAt.Before(releasedAt) {
			t.Fatalf("loser goroutine %d finished at %v before winner released lock at %v", i, r.finishedAt, releasedAt)
		}
		ve, ok := vault.AsError(r.err)
		if !ok || ve.Code != "version_mismatch" || ve.CurrentVersion == nil || *ve.CurrentVersion != 2 {
			t.Fatalf("goroutine %d unexpected loser error = %v (%+v), want 412 version_mismatch(current=2)", i, r.err, ve)
		}
		losers++
	}
	if successes != 1 || losers != 1 {
		t.Fatalf("barrier results: successes=%d losers=%d (%+v)", successes, losers, results)
	}

	// Verify exactly 1 RK was deleted (9 remaining) and version is 2.
	rkStatus, err := svc.GetRecoveryKeysStatus(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetRecoveryKeysStatus: %v", err)
	}
	if rkStatus.Remaining != 9 {
		t.Fatalf("Remaining after concurrent complete = %d, want 9", rkStatus.Remaining)
	}

	t.Run("EarlyFailureAndContextCancelUnblockBarrierPromptly", func(t *testing.T) {
		// Lookup a second valid recovery key (index 1) for the barrier cleanup subtest.
		lookup2, err := svc.RecoveryLookup(ctx, p, vault.RecoveryLookupInput{
			LookupHash: inCreate.RecoveryKeys[1].LookupHash,
		})
		if err != nil {
			t.Fatalf("RecoveryLookup[1]: %v", err)
		}

		// (a) Deliberately failing sibling request (invalid If-Match) while worker 0 holds the barrier:
		// pollBlockedBackendPID must surface worker 1's error immediately without hanging, and once-only
		// release cleanup must unblock and drain worker 0 promptly.
		var subArrived atomic.Int32
		var subWinnerPID atomic.Int32
		subLocked := make(chan struct{})
		subRelease := make(chan struct{})
		var subReleaseOnce sync.Once
		closeSubRelease := func() { subReleaseOnce.Do(func() { close(subRelease) }) }
		subResults := make([]result, 2)
		subEarly := make(chan int, 2)
		var subWG sync.WaitGroup
		subCtx, cancelSub := context.WithCancel(ctx)
		cleanupSub := func() {
			closeSubRelease()
			cancelSub()
			vault.SetRecoverCompleteTestHook(nil)
			subWG.Wait()
		}
		t.Cleanup(cleanupSub)
		defer cleanupSub()
		vault.SetRecoverCompleteTestHook(func(hookCtx context.Context) {
			if subArrived.Add(1) == 1 {
				subWinnerPID.Store(vault.TestHookBackendPIDFrom(hookCtx))
				close(subLocked)
				select {
				case <-subRelease:
				case <-hookCtx.Done():
				}
			}
		})

		start := time.Now()
		subWG.Add(1)
		go func() {
			defer subWG.Done()
			salt := vault.EncodeBase64URL(seqBytes(16, 0x91))
			kdfRaw := json.RawMessage(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + salt + `"}`)
			wrap := makeValidWrapB64U(t, vault.WrapKindKEK, 0x91)
			resp, err := svc.RecoverComplete(subCtx, p, vault.RecoverCompleteInput{
				RecoveryKeyID:        lookup2.RecoveryKeyID,
				KDFRaw:               kdfRaw,
				VaultKeyWrappedByKEK: wrap,
				IfMatch:              httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 2},
				IP:                   "127.0.0.1",
				UA:                   "barrier-subtest",
			})
			subResults[0] = result{resp: resp, err: err, finishedAt: time.Now()}
			subEarly <- 0
		}()
		subWG.Add(1)
		go func() {
			defer subWG.Done()
			select {
			case <-subLocked:
			case <-subRelease:
				return
			case <-subCtx.Done():
				return
			}
			// Deliberately invalid If-Match (Version: 0 -> precondition_required before DB lock).
			resp, err := svc.RecoverComplete(subCtx, p, vault.RecoverCompleteInput{
				RecoveryKeyID:        lookup2.RecoveryKeyID,
				KDFRaw:               json.RawMessage(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + vault.EncodeBase64URL(seqBytes(16, 0x92)) + `"}`),
				VaultKeyWrappedByKEK: makeValidWrapB64U(t, vault.WrapKindKEK, 0x92),
				IfMatch:              httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 0},
			})
			subResults[1] = result{resp: resp, err: err, finishedAt: time.Now()}
			subEarly <- 1
		}()

		select {
		case <-subLocked:
		case idx := <-subEarly:
			t.Fatalf("subtest worker %d finished before winner acquired lock: err=%v", idx, subResults[idx].err)
		case <-subCtx.Done():
			t.Fatalf("subtest context cancelled before winner acquired lock: %v", subCtx.Err())
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for subtest winner to acquire lock")
		}

		_, pollErr := pollBlockedBackendPID(ctx, pool, subWinnerPID.Load(), subEarly, func(idx int) string {
			return fmt.Sprintf("err=%v", subResults[idx].err)
		})
		if pollErr == nil || !strings.Contains(pollErr.Error(), "worker 1 finished early") || !strings.Contains(pollErr.Error(), "precondition_required") {
			t.Fatalf("pollBlockedBackendPID on early failing sibling = %v, want worker 1 precondition_required diagnostic", pollErr)
		}
		// Cancel context BEFORE closing subRelease to prove hookCtx.Done() unblocks the held winner promptly.
		cancelSub()
		subWG.Wait()
		closeSubRelease()
		vault.SetRecoverCompleteTestHook(nil)
		if elapsed := time.Since(start); elapsed > 2*time.Second {
			t.Fatalf("barrier early-failure + context-cancel cleanup took %v, want < 2s", elapsed)
		}

		// Also prove that if the designated winner fails BEFORE reaching the hook while the sibling
		// is waiting on pre-hook lock arrival, cancellation/release unblocks and drains the sibling promptly.
		winFailLocked := make(chan struct{})
		winFailRelease := make(chan struct{})
		var winFailOnce sync.Once
		closeWinFailRelease := func() { winFailOnce.Do(func() { close(winFailRelease) }) }
		winFailCtx, cancelWinFail := context.WithCancel(ctx)
		var winFailWG sync.WaitGroup
		cleanupWinFail := func() {
			closeWinFailRelease()
			cancelWinFail()
			vault.SetRecoverCompleteTestHook(nil)
			winFailWG.Wait()
		}
		t.Cleanup(cleanupWinFail)
		defer cleanupWinFail()

		winFailResults := make([]result, 2)
		winFailEarly := make(chan int, 2)
		siblingUnblocked := make(chan struct{})
		winFailStart := time.Now()
		winFailWG.Add(1)
		go func() {
			defer winFailWG.Done()
			resp, err := svc.RecoverComplete(winFailCtx, p, vault.RecoverCompleteInput{
				RecoveryKeyID:        lookup2.RecoveryKeyID,
				KDFRaw:               json.RawMessage(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + vault.EncodeBase64URL(seqBytes(16, 0x93)) + `"}`),
				VaultKeyWrappedByKEK: makeValidWrapB64U(t, vault.WrapKindKEK, 0x93),
				IfMatch:              httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 0},
			})
			winFailResults[0] = result{resp: resp, err: err, finishedAt: time.Now()}
			winFailEarly <- 0
		}()
		winFailWG.Add(1)
		go func() {
			defer winFailWG.Done()
			defer close(siblingUnblocked)
			select {
			case <-winFailLocked:
			case <-winFailRelease:
				return
			case <-winFailCtx.Done():
				return
			}
		}()

		select {
		case <-winFailLocked:
			t.Fatal("unexpected lock acquisition when designated winner had invalid If-Match")
		case idx := <-winFailEarly:
			if idx != 0 || winFailResults[0].err == nil || !strings.Contains(winFailResults[0].err.Error(), "precondition_required") {
				t.Fatalf("winner early failure = idx %d (%+v), want worker 0 precondition_required", idx, winFailResults[0])
			}
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for designated winner early failure")
		}
		cleanupWinFail()
		select {
		case <-siblingUnblocked:
		default:
			t.Fatal("sibling goroutine was not drained by cleanupWinFail")
		}
		if elapsed := time.Since(winFailStart); elapsed > 2*time.Second {
			t.Fatalf("winner-before-hook failure cleanup took %v, want < 2s", elapsed)
		}
	})
}
