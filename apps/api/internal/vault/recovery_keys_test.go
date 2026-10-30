package vault_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
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

func TestServiceRegenerateAndRotateRecoveryKeys(t *testing.T) {
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
	mailer := &failingRecoverMailer{}

	svc, err := vault.NewService(cfg, pool, clk, aud, notes, mailer, nil, nil, logger)
	if err != nil {
		t.Fatalf("vault.NewService: %v", err)
	}

	q := gen.New(pool)
	userA, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "rk-svc-a@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser A: %v", err)
	}
	userB, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "rk-svc-b@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser B: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE app_user SET email_verified_at = now() WHERE id = $1`, userA.ID); err != nil {
		t.Fatalf("verify userA email: %v", err)
	}

	pA := authctx.Principal{UserID: userA.ID, SessionID: uuid.New()}
	pB := authctx.Principal{UserID: userB.ID, SessionID: uuid.New()}

	inA := makeValidCreateInput(t, 0x10)
	createdA, err := svc.Create(ctx, pA, inA)
	if err != nil {
		t.Fatalf("svc.Create(A): %v", err)
	}
	inB := makeValidCreateInput(t, 0x70)
	_, err = svc.Create(ctx, pB, inB)
	if err != nil {
		t.Fatalf("svc.Create(B): %v", err)
	}

	// 1. Regenerate when already at 10 remaining -> ErrRecoveryKeysCount (400).
	_, err = svc.RegenerateRecoveryKeys(ctx, pA, vault.RecoveryKeysRegenerateInput{
		RecoveryKeys: []vault.RecoveryKeyUploadItem{
			{
				Slot:       1,
				LookupHash: vault.EncodeBase64URL(seqBytes(32, 0x91)),
				Wrap:       makeValidWrapB64U(t, vault.WrapKindRK, 0x91),
			},
		},
		IfMatch: httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
	})
	if !errors.Is(err, vault.ErrRecoveryKeysCount) {
		t.Fatalf("Regenerate at 10 remaining = %v, want ErrRecoveryKeysCount", err)
	}

	// Delete slots 2 and 5 from User A's vault (8 remaining, empty_slots = [2, 5]).
	if _, err := pool.Exec(ctx, `DELETE FROM vault_recovery_key WHERE vault_id = $1 AND slot IN (2, 5)`, userA.ID); err != nil {
		t.Fatalf("delete slots 2, 5: %v", err)
	}

	// 2. Regenerate into an OCCUPIED slot (slot 1) -> ErrRecoveryKeySlotTaken (409).
	_, err = svc.RegenerateRecoveryKeys(ctx, pA, vault.RecoveryKeysRegenerateInput{
		RecoveryKeys: []vault.RecoveryKeyUploadItem{
			{
				Slot:       1,
				LookupHash: vault.EncodeBase64URL(seqBytes(32, 0x92)),
				Wrap:       makeValidWrapB64U(t, vault.WrapKindRK, 0x92),
			},
		},
		IfMatch: httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
	})
	if !errors.Is(err, vault.ErrRecoveryKeySlotTaken) {
		t.Fatalf("Regenerate occupied slot = %v, want ErrRecoveryKeySlotTaken", err)
	}

	// 3. Regenerate with cross-user duplicate lookup_hash (User B's slot 1 hash) -> ErrRecoveryKeyConflict (409, no owner leak).
	_, err = svc.RegenerateRecoveryKeys(ctx, pA, vault.RecoveryKeysRegenerateInput{
		RecoveryKeys: []vault.RecoveryKeyUploadItem{
			{
				Slot:       2,
				LookupHash: inB.RecoveryKeys[0].LookupHash,
				Wrap:       makeValidWrapB64U(t, vault.WrapKindRK, 0x93),
			},
		},
		IfMatch: httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
	})
	if !errors.Is(err, vault.ErrRecoveryKeyConflict) {
		t.Fatalf("Regenerate cross-user lookup_hash = %v, want ErrRecoveryKeyConflict", err)
	}

	// 4. Regenerate with wrong-length wrap -> ErrVaultWrapInvalid (400).
	_, err = svc.RegenerateRecoveryKeys(ctx, pA, vault.RecoveryKeysRegenerateInput{
		RecoveryKeys: []vault.RecoveryKeyUploadItem{
			{
				Slot:       2,
				LookupHash: vault.EncodeBase64URL(seqBytes(32, 0x94)),
				Wrap:       vault.EncodeBase64URL(seqBytes(40, 0x01)),
			},
		},
		IfMatch: httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
	})
	if !errors.Is(err, vault.ErrVaultWrapInvalid) {
		t.Fatalf("Regenerate wrong-length wrap = %v, want ErrVaultWrapInvalid", err)
	}

	// 5. Valid regenerate of slot 2 (1 of 2 empty slots) -> Remaining=9, Version=2, audit recovery_key.regenerate.
	newSlot2Hash := vault.EncodeBase64URL(seqBytes(32, 0xA2))
	newSlot2Wrap := makeValidWrapB64U(t, vault.WrapKindRK, 0xA2)
	regenResp, err := svc.RegenerateRecoveryKeys(ctx, pA, vault.RecoveryKeysRegenerateInput{
		RecoveryKeys: []vault.RecoveryKeyUploadItem{
			{
				Slot:       2,
				LookupHash: newSlot2Hash,
				Wrap:       newSlot2Wrap,
			},
		},
		IfMatch: httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 1},
		IP:      "127.0.0.1",
		UA:      "rk-service-test",
	})
	if err != nil {
		t.Fatalf("Regenerate slot 2: %v", err)
	}
	if regenResp.Remaining != 9 || regenResp.Version != 2 {
		t.Fatalf("regenResp = %+v, want {Remaining:9, Version:2}", regenResp)
	}

	// 6. Rotate validation: duplicate slot in 10 items -> ErrRecoveryKeySlotTaken (409);
	// cross-user duplicate lookup_hash -> ErrRecoveryKeyConflict (409); wrong-length wrap -> ErrVaultWrapInvalid (400).
	rotInput := makeValidCreateInput(t, 0xB0).RecoveryKeys
	rotDupSlot := append([]vault.RecoveryKeyUploadItem(nil), rotInput...)
	rotDupSlot[9].Slot = 1
	_, err = svc.RotateRecoveryKeys(ctx, pA, vault.RecoveryKeysRotateInput{
		RecoveryKeys: rotDupSlot,
		IfMatch:      httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 2},
	})
	if !errors.Is(err, vault.ErrRecoveryKeySlotTaken) {
		t.Fatalf("Rotate duplicate slot = %v, want ErrRecoveryKeySlotTaken", err)
	}

	rotCrossHash := append([]vault.RecoveryKeyUploadItem(nil), rotInput...)
	rotCrossHash[4].LookupHash = inB.RecoveryKeys[0].LookupHash
	_, err = svc.RotateRecoveryKeys(ctx, pA, vault.RecoveryKeysRotateInput{
		RecoveryKeys: rotCrossHash,
		IfMatch:      httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 2},
	})
	if !errors.Is(err, vault.ErrRecoveryKeyConflict) {
		t.Fatalf("Rotate cross-user lookup_hash = %v, want ErrRecoveryKeyConflict", err)
	}

	// Verify rollback kept old RKs intact (slot 2 regenerated hash still works).
	if _, err := svc.RecoveryLookup(ctx, pA, vault.RecoveryLookupInput{LookupHash: newSlot2Hash}); err != nil {
		t.Fatalf("RecoveryLookup after rolled-back rotate: %v", err)
	}

	// 7. Valid Rotate replaces all RKs with 10 new RKs (slots 1..10), bumps version to 3, records audit + notice + mail.
	rotResp, err := svc.RotateRecoveryKeys(ctx, pA, vault.RecoveryKeysRotateInput{
		RecoveryKeys: rotInput,
		IfMatch:      httpx.VaultIfMatch{VaultKeyID: createdA.VaultKeyID, Version: 2},
		IP:           "127.0.0.1",
		UA:           "rk-service-test",
	})
	if err != nil {
		t.Fatalf("RotateRecoveryKeys: %v", err)
	}
	if rotResp.Remaining != 10 || rotResp.Version != 3 {
		t.Fatalf("rotResp = %+v, want {Remaining:10, Version:3}", rotResp)
	}
	if mailer.calls.Load() != 0 {
		t.Fatalf("direct mailer calls before worker run = %d, want 0", mailer.calls.Load())
	}
	ranJobs, workErr := runQueuedSecurityNoticeJobs(ctx, pool, mailer, logger)
	if ranJobs != 1 || workErr == nil {
		t.Fatalf("runQueuedSecurityNoticeJobs = (%d, %v), want (1, non-nil mailer error)", ranJobs, workErr)
	}
	if mailer.calls.Load() != 1 {
		t.Fatalf("expected mailer call on rotate via worker, got %d", mailer.calls.Load())
	}

	// Old RKs (both original slot 1 and regenerated slot 2) now fail lookup with ErrRecoveryKeyInvalid (401),
	// while all 10 new RKs succeed!
	if _, err := svc.RecoveryLookup(ctx, pA, vault.RecoveryLookupInput{LookupHash: inA.RecoveryKeys[0].LookupHash}); !errors.Is(err, vault.ErrRecoveryKeyInvalid) {
		t.Fatalf("lookup old slot 1 after rotate = %v, want ErrRecoveryKeyInvalid", err)
	}
	if _, err := svc.RecoveryLookup(ctx, pA, vault.RecoveryLookupInput{LookupHash: newSlot2Hash}); !errors.Is(err, vault.ErrRecoveryKeyInvalid) {
		t.Fatalf("lookup old regenerated slot 2 after rotate = %v, want ErrRecoveryKeyInvalid", err)
	}
	for i := range 10 {
		res, err := svc.RecoveryLookup(ctx, pA, vault.RecoveryLookupInput{LookupHash: rotInput[i].LookupHash})
		if err != nil || res.Wrap != rotInput[i].Wrap {
			t.Fatalf("lookup rotated slot %d = %+v, err=%v", i+1, res, err)
		}
	}

	// Logs never contain lookup_hash or wraps.
	logs := logBuf.String()
	for _, item := range rotInput {
		if strings.Contains(logs, item.LookupHash) || strings.Contains(logs, item.Wrap) {
			t.Fatalf("logs leaked rotated RK secret: %s", logs)
		}
	}
}

func TestServiceRegenerateConcurrentNeverExceedsTen(t *testing.T) {
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
	svc, err := vault.NewService(cfg, pool, clk, aud, notes, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("vault.NewService: %v", err)
	}

	q := gen.New(pool)
	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "regen-concurrent@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	p := authctx.Principal{UserID: user.ID, SessionID: uuid.New()}

	inCreate := makeValidCreateInput(t, 0x20)
	created, err := svc.Create(ctx, p, inCreate)
	if err != nil {
		t.Fatalf("svc.Create: %v", err)
	}

	// Delete 2 RKs (slots 1 and 2) so 8 remain and slots 1 and 2 are both empty.
	// Each concurrent request targets a DIFFERENT empty slot (worker 0 -> slot 1, worker 1 -> slot 2)
	// so UNIQUE(vault_id, slot) cannot reject either request; only the vault FOR UPDATE row lock
	// + version/count check serializes them.
	if _, err := pool.Exec(ctx, `DELETE FROM vault_recovery_key WHERE vault_id = $1 AND slot IN (1, 2)`, user.ID); err != nil {
		t.Fatalf("delete slots 1 and 2: %v", err)
	}

	var arrived atomic.Int32
	var winnerPID atomic.Int32
	winnerLocked := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	closeRelease := func() { releaseOnce.Do(func() { close(release) }) }

	type result struct {
		resp       vault.RecoveryKeysMutationResponse
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
		vault.SetRegenerateTestHook(nil)
		wg.Wait()
	}
	t.Cleanup(cleanupBarrier)
	defer cleanupBarrier()
	vault.SetRegenerateTestHook(func(hookCtx context.Context) {
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
			targetSlot := idx + 1 // idx 0 -> slot 1, idx 1 -> slot 2 (distinct empty slots)
			h := seqBytes(32, byte(0xD0+idx*11))
			resp, err := svc.RegenerateRecoveryKeys(ctx, p, vault.RecoveryKeysRegenerateInput{
				RecoveryKeys: []vault.RecoveryKeyUploadItem{
					{
						Slot:       targetSlot,
						LookupHash: vault.EncodeBase64URL(h),
						Wrap:       makeValidWrapB64U(t, vault.WrapKindRK, byte(0xD0+idx*11)),
					},
				},
				IfMatch: httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 1},
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
		t.Fatal("timed out waiting for winner to acquire vault row lock in Regenerate")
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
	vault.SetRegenerateTestHook(nil)

	successes := 0
	losers := 0
	for i, r := range results {
		if r.err == nil {
			successes++
			if r.resp.Remaining != 9 || r.resp.Version != 2 {
				t.Fatalf("unexpected winner [%d] resp: %+v, want {Remaining:9, Version:2}", i, r.resp)
			}
			continue
		}
		if r.finishedAt.Before(releasedAt) {
			t.Fatalf("loser goroutine %d finished at %v before winner released lock at %v", i, r.finishedAt, releasedAt)
		}
		ve, ok := vault.AsError(r.err)
		if !ok || ve.Code != "version_mismatch" || ve.CurrentVersion == nil || *ve.CurrentVersion != 2 {
			t.Fatalf("loser [%d] err = %v (%+v), want 412 version_mismatch(current=2) from vault lock", i, r.err, ve)
		}
		losers++
	}
	if successes != 1 || losers != 1 {
		t.Fatalf("expected 1 winner and 1 version_mismatch loser in concurrent regenerate, got successes=%d losers=%d (%+v)", successes, losers, results)
	}

	status, err := svc.GetRecoveryKeysStatus(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetRecoveryKeysStatus: %v", err)
	}
	if status.Remaining != 9 || len(status.EmptySlots) != 1 {
		t.Fatalf("status after concurrent regenerate = %+v, want Remaining=9 and 1 empty slot", status)
	}

	t.Run("EarlyFailureAndContextCancelUnblockBarrierPromptly", func(t *testing.T) {
		var subArrived atomic.Int32
		var subWinnerPID atomic.Int32
		subLocked := make(chan struct{})
		subRelease := make(chan struct{})
		var subReleaseOnce sync.Once
		closeSubRelease := func() { subReleaseOnce.Do(func() { close(subRelease) }) }
		subResults := make([]result, 2)
		subEarly := make(chan int, 2)
		subWinnerEarly := make(chan int, 1)
		var subWG sync.WaitGroup
		subCtx, cancelSub := context.WithCancel(ctx)
		cleanupSub := func() {
			closeSubRelease()
			cancelSub()
			vault.SetRegenerateTestHook(nil)
			subWG.Wait()
		}
		t.Cleanup(cleanupSub)
		defer cleanupSub()
		vault.SetRegenerateTestHook(func(hookCtx context.Context) {
			if subArrived.Add(1) == 1 {
				subWinnerPID.Store(vault.TestHookBackendPIDFrom(hookCtx))
				close(subLocked)
				select {
				case <-subRelease:
				case <-hookCtx.Done():
				}
			}
		})

		remainingSlot := status.EmptySlots[0]
		start := time.Now()
		subWG.Add(1)
		go func() {
			defer subWG.Done()
			h := seqBytes(32, 0xE1)
			resp, err := svc.RegenerateRecoveryKeys(subCtx, p, vault.RecoveryKeysRegenerateInput{
				RecoveryKeys: []vault.RecoveryKeyUploadItem{
					{
						Slot:       remainingSlot,
						LookupHash: vault.EncodeBase64URL(h),
						Wrap:       makeValidWrapB64U(t, vault.WrapKindRK, 0xE1),
					},
				},
				IfMatch: httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 2},
			})
			subResults[0] = result{resp: resp, err: err, finishedAt: time.Now()}
			subWinnerEarly <- 0
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
			resp, err := svc.RegenerateRecoveryKeys(subCtx, p, vault.RecoveryKeysRegenerateInput{
				RecoveryKeys: []vault.RecoveryKeyUploadItem{
					{
						Slot:       remainingSlot,
						LookupHash: vault.EncodeBase64URL(seqBytes(32, 0xE2)),
						Wrap:       makeValidWrapB64U(t, vault.WrapKindRK, 0xE2),
					},
				},
				IfMatch: httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 0},
			})
			subResults[1] = result{resp: resp, err: err, finishedAt: time.Now()}
			subEarly <- 1
		}()

		select {
		case <-subLocked:
		case idx := <-subWinnerEarly:
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
		cancelSub()
		subWG.Wait()
		closeSubRelease()
		vault.SetRegenerateTestHook(nil)
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
			vault.SetRegenerateTestHook(nil)
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
			resp, err := svc.RegenerateRecoveryKeys(winFailCtx, p, vault.RecoveryKeysRegenerateInput{
				RecoveryKeys: []vault.RecoveryKeyUploadItem{
					{
						Slot:       remainingSlot,
						LookupHash: vault.EncodeBase64URL(seqBytes(32, 0xE3)),
						Wrap:       makeValidWrapB64U(t, vault.WrapKindRK, 0xE3),
					},
				},
				IfMatch: httpx.VaultIfMatch{VaultKeyID: created.VaultKeyID, Version: 0},
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
