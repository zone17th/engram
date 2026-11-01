package entry_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/textnorm"
	"github.com/zone17th/engram/apps/api/internal/vault"
	"github.com/zone17th/engram/apps/api/internal/worker"
)

func insertPurgeTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, email string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	_, err := pool.Exec(ctx, `
		INSERT INTO app_user (id, email, password_hash, email_verified_at)
		VALUES ($1, $2, 'test-hash', now())
	`, id, email)
	if err != nil {
		t.Fatalf("insert test user %s: %v", email, err)
	}
	return id
}

func insertPurgeTestItem(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, name string, entryCount int32, deletedAt *time.Time) uuid.UUID {
	t.Helper()
	id := uuid.New()
	norm, err := textnorm.Normalize(name)
	if err != nil {
		t.Fatalf("Normalize(%q): %v", name, err)
	}
	var delBatch *uuid.UUID
	if deletedAt != nil {
		b := uuid.New()
		delBatch = &b
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO item (id, user_id, name, name_normalized, entry_count, deleted_at, delete_batch)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, id, userID, name, norm, entryCount, deletedAt, delBatch)
	if err != nil {
		t.Fatalf("insert test item %q: %v", name, err)
	}
	return id
}

func insertPurgeTestTag(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, display string, itemCount int32, deletedAt *time.Time) uuid.UUID {
	t.Helper()
	id := uuid.New()
	norm, err := textnorm.Normalize(display)
	if err != nil {
		t.Fatalf("Normalize(%q): %v", display, err)
	}
	_, err = pool.Exec(ctx, `
		INSERT INTO tag (id, user_id, display, normalized, item_count, deleted_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, id, userID, display, norm, itemCount, deletedAt)
	if err != nil {
		t.Fatalf("insert test tag %q: %v", display, err)
	}
	return id
}

func linkPurgeItemTag(t *testing.T, ctx context.Context, pool *pgxpool.Pool, itemID, tagID uuid.UUID) {
	t.Helper()
	if _, err := pool.Exec(ctx, `INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)`, itemID, tagID); err != nil {
		t.Fatalf("insert item_tag (%s, %s): %v", itemID, tagID, err)
	}
}

func insertPurgeTestEntry(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID, itemID uuid.UUID, pos int32, deletedAt *time.Time, deletedVia string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	vk := bytes.Repeat([]byte{0x42}, vault.VKBytes)
	nonce := bytes.Repeat([]byte{0x24}, vault.WrapNonceBytes)
	env, ctBytes, err := vault.SealEntry(id.String(), "vk:7f3a1c9e02b4d6f89012ab", []byte("purge fixture payload"), vk, nonce)
	if err != nil {
		t.Fatalf("SealEntry: %v", err)
	}
	envRaw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	bucket, _ := entry.ExpectedPlaintextLenBucket(len(ctBytes))

	var viaPtr *string
	var batchPtr *uuid.UUID
	if deletedAt != nil {
		viaPtr = &deletedVia
		if deletedVia == entry.DeletedViaItem {
			b := uuid.New()
			batchPtr = &b
		}
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO entry (
			id, user_id, item_id, type, position, envelope, ciphertext,
			plaintext_len_bucket, version, deleted_at, deleted_via, delete_batch
		) VALUES ($1, $2, $3, 'text', $4, $5, $6, $7, 1, $8, $9, $10)
	`, id, userID, itemID, pos, envRaw, ctBytes, bucket, deletedAt, viaPtr, batchPtr)
	if err != nil {
		t.Fatalf("insert test entry: %v", err)
	}
	return id
}

func rowExists(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table string, id uuid.UUID) bool {
	t.Helper()
	var exists bool
	q := fmt.Sprintf(`SELECT EXISTS (SELECT 1 FROM %s WHERE id = $1)`, table)
	if err := pool.QueryRow(ctx, q, id).Scan(&exists); err != nil {
		t.Fatalf("rowExists(%s, %s): %v", table, id, err)
	}
	return exists
}

// TestPurgeExpiredContentExplicitCutoffCascadesIdempotencyAndInvariants covers Task 7 bullet 5 (P04-A8):
//   - Purge with an explicit `cutoff` deletes entry, item (cascading its entries and `item_tag` rows),
//     and tag (cascading its `item_tag` rows while keeping linked live items intact) whose `deleted_at < cutoff`
//     (e.g. 31 days ago and 30 days + 1 second ago).
//   - Keeps rows deleted 29 days ago, rows deleted at exact `cutoff` (`deleted_at == cutoff`), and all live rows.
//   - Preserves `item.entry_count` and `tag.item_count` invariants before and after purge (`contenttest.AssertInvariants`).
//   - Running purge a second time is idempotent: returns no error and deletes 0 additional rows.
func TestPurgeExpiredContentExplicitCutoffCascadesIdempotencyAndInvariants(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	userA := insertPurgeTestUser(t, ctx, pool, "purge-user-a@example.com")
	userB := insertPurgeTestUser(t, ctx, pool, "purge-user-b@example.com")

	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	cutoff := now.Add(-entry.ContentPurgeRetentionWindow) // now - 30 days

	del31d := now.Add(-31 * 24 * time.Hour)
	del30dPlus1s := cutoff.Add(-time.Second)
	delExactCutoff := cutoff
	del29d := now.Add(-29 * 24 * time.Hour)

	// 1. Live item for User A with:
	//    - 2 live entries (must survive)
	//    - 1 entry deleted 31d ago (must be purged)
	//    - 1 entry deleted 30d+1s ago (must be purged)
	//    - 1 entry deleted at exact cutoff (must survive: `deleted_at < cutoff` is strict)
	//    - 1 entry deleted 29d ago (must survive)
	liveItemA := insertPurgeTestItem(t, ctx, pool, userA, "Live Item A", 2, nil)
	liveEntryA1 := insertPurgeTestEntry(t, ctx, pool, userA, liveItemA, 0, nil, "")
	liveEntryA2 := insertPurgeTestEntry(t, ctx, pool, userA, liveItemA, 1, nil, "")
	expEntryA31d := insertPurgeTestEntry(t, ctx, pool, userA, liveItemA, 2, &del31d, entry.DeletedViaEntry)
	expEntryA30d1s := insertPurgeTestEntry(t, ctx, pool, userA, liveItemA, 3, &del30dPlus1s, entry.DeletedViaEntry)
	borderEntryExact := insertPurgeTestEntry(t, ctx, pool, userA, liveItemA, 4, &delExactCutoff, entry.DeletedViaEntry)
	recentEntryA29d := insertPurgeTestEntry(t, ctx, pool, userA, liveItemA, 5, &del29d, entry.DeletedViaEntry)

	// 2. Expired item for User A (`deleted_at = 31d ago`, `entry_count = 0`) with:
	//    - 1 cascaded entry (`deleted_via = 'item'`, `deleted_at = 31d ago`)
	//    - 1 individually deleted entry (`deleted_via = 'entry'`, `deleted_at = 29d ago` — still cascades when parent item is purged!)
	//    - linked to a live tag (`liveTagA`) and an expired tag (`expTagA31d`) via `item_tag`.
	//    Note: when an item was soft-deleted, `tag.item_count` was already decremented to count only LIVE items.
	expItemA31d := insertPurgeTestItem(t, ctx, pool, userA, "Expired Item A 31d", 0, &del31d)
	cascadedEntryOnExpItem := insertPurgeTestEntry(t, ctx, pool, userA, expItemA31d, 0, &del31d, entry.DeletedViaItem)
	recentEntryOnExpItem := insertPurgeTestEntry(t, ctx, pool, userA, expItemA31d, 1, &del29d, entry.DeletedViaEntry)

	// 3. Recent soft-deleted item (`deleted_at = 29d ago`, `entry_count = 0`) -> must survive along with its tombstone entry.
	recentItemA29d := insertPurgeTestItem(t, ctx, pool, userA, "Recent Deleted Item A 29d", 0, &del29d)
	entryOnRecentItem29d := insertPurgeTestEntry(t, ctx, pool, userA, recentItemA29d, 0, &del29d, entry.DeletedViaItem)

	// 4. Tags for User A:
	//    - `liveTagA`: linked to `liveItemA` (live), `expItemA31d` (expired), and `recentItemA29d` (deleted 29d) -> `item_count = 1`.
	//    - `expTagA31d` (`deleted_at = 31d ago`): linked to `liveItemA` (live) and `expItemA31d` (expired) -> `item_count = 1`.
	//      Purging `expTagA31d` must cascade `item_tag` without deleting `liveItemA`!
	//    - `recentTagA29d` (`deleted_at = 29d ago`): linked to `liveItemA` (live) -> `item_count = 1`. Must survive.
	liveTagA := insertPurgeTestTag(t, ctx, pool, userA, "live-tag-a", 1, nil)
	expTagA31d := insertPurgeTestTag(t, ctx, pool, userA, "expired-tag-a-31d", 1, &del31d)
	recentTagA29d := insertPurgeTestTag(t, ctx, pool, userA, "recent-tag-a-29d", 1, &del29d)

	linkPurgeItemTag(t, ctx, pool, liveItemA, liveTagA)
	linkPurgeItemTag(t, ctx, pool, expItemA31d, liveTagA)
	linkPurgeItemTag(t, ctx, pool, recentItemA29d, liveTagA)

	linkPurgeItemTag(t, ctx, pool, liveItemA, expTagA31d)
	linkPurgeItemTag(t, ctx, pool, expItemA31d, expTagA31d)

	linkPurgeItemTag(t, ctx, pool, liveItemA, recentTagA29d)

	// 5. User B has an expired entry (31d ago) and a live item/entry to verify multi-user purge.
	liveItemB := insertPurgeTestItem(t, ctx, pool, userB, "Live Item B", 1, nil)
	liveEntryB := insertPurgeTestEntry(t, ctx, pool, userB, liveItemB, 0, nil, "")
	expEntryB31d := insertPurgeTestEntry(t, ctx, pool, userB, liveItemB, 1, &del31d, entry.DeletedViaEntry)

	contenttest.AssertInvariants(t, pool, userA)
	contenttest.AssertInvariants(t, pool, userB)

	// Run 1: PurgeExpiredContent with explicit `cutoff`.
	var lockedUsers []uuid.UUID
	hookCtx := entry.WithPurgeLockHeldHook(ctx, func(_ context.Context, uid uuid.UUID) {
		lockedUsers = append(lockedUsers, uid)
	})
	res1, err := entry.PurgeExpiredContent(hookCtx, pool, cutoff)
	if err != nil {
		t.Fatalf("PurgeExpiredContent run 1: %v", err)
	}
	if res1.ItemsDeleted != 1 || res1.TagsDeleted != 1 || res1.EntriesDeleted < 3 {
		t.Fatalf("PurgeExpiredContent run 1 result = %+v, want ItemsDeleted=1, TagsDeleted=1, EntriesDeleted>=3", res1)
	}
	if len(lockedUsers) != 2 {
		t.Fatalf("expected LockUserContent hook to fire for both users (2), got %d (%v)", len(lockedUsers), lockedUsers)
	}

	// Verify expired rows (> 30d) are permanently deleted.
	for _, id := range []uuid.UUID{expEntryA31d, expEntryA30d1s, cascadedEntryOnExpItem, recentEntryOnExpItem, expEntryB31d} {
		if rowExists(t, ctx, pool, "entry", id) {
			t.Fatalf("expected expired/cascaded entry %s to be purged", id)
		}
	}
	if rowExists(t, ctx, pool, "item", expItemA31d) {
		t.Fatalf("expected expired item %s to be purged", expItemA31d)
	}
	if rowExists(t, ctx, pool, "tag", expTagA31d) {
		t.Fatalf("expected expired tag %s to be purged", expTagA31d)
	}

	// Verify 29-day tombstones, exact-cutoff tombstone, and all live rows survive.
	for _, id := range []uuid.UUID{liveEntryA1, liveEntryA2, borderEntryExact, recentEntryA29d, entryOnRecentItem29d, liveEntryB} {
		if !rowExists(t, ctx, pool, "entry", id) {
			t.Fatalf("expected entry %s (live / 29d / exact cutoff) to survive purge", id)
		}
	}
	for _, id := range []uuid.UUID{liveItemA, recentItemA29d, liveItemB} {
		if !rowExists(t, ctx, pool, "item", id) {
			t.Fatalf("expected item %s (live / 29d) to survive purge", id)
		}
	}
	for _, id := range []uuid.UUID{liveTagA, recentTagA29d} {
		if !rowExists(t, ctx, pool, "tag", id) {
			t.Fatalf("expected tag %s (live / 29d) to survive purge", id)
		}
	}

	// Verify invariants after run 1.
	contenttest.AssertInvariants(t, pool, userA)
	contenttest.AssertInvariants(t, pool, userB)

	// Run 2: Running PurgeExpiredContent a second time with the same cutoff is a clean no-op.
	res2, err := entry.PurgeExpiredContent(ctx, pool, cutoff)
	if err != nil {
		t.Fatalf("PurgeExpiredContent run 2: %v", err)
	}
	if res2.Total() != 0 {
		t.Fatalf("PurgeExpiredContent run 2 deleted %+v, want 0", res2)
	}
	contenttest.AssertInvariants(t, pool, userA)
	contenttest.AssertInvariants(t, pool, userB)
}

// TestPurgeExpiredContentMultiBatchOver500AndRiverWorkerRegistration verifies:
//   - A user with > 500 expired tombstones (e.g. 520 expired entries) is purged in batches of at most 500
//     per transaction under `LockUserContent(user_id)`.
//   - Passing a requested `batchSize > 500` (e.g. 750) is clamped at the single-batch boundary (`<= 500`),
//     removing at most 500 rows in one transaction and leaving the remaining 20 expired rows for the next transaction (EA7-R1-2).
//   - `worker.New` registers `content_purge` (`entry.ContentPurgeArgs`) so River executes the job end-to-end.
func TestPurgeExpiredContentMultiBatchOver500AndRiverWorkerRegistration(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	userA := insertPurgeTestUser(t, ctx, pool, "purge-batch520@example.com")
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	cutoff := now.Add(-entry.ContentPurgeRetentionWindow)
	del35d := now.Add(-35 * 24 * time.Hour)
	del20d := now.Add(-20 * 24 * time.Hour)

	liveItem := insertPurgeTestItem(t, ctx, pool, userA, "Bulk Tombstone Item", 1, nil)
	liveEntry := insertPurgeTestEntry(t, ctx, pool, userA, liveItem, 0, nil, "")
	recentTombstone := insertPurgeTestEntry(t, ctx, pool, userA, liveItem, 1, &del20d, entry.DeletedViaEntry)

	// Bulk-insert 520 expired entry tombstones (`deleted_at = 35d ago`) using generate_series.
	vk := bytes.Repeat([]byte{0x42}, vault.VKBytes)
	nonce := bytes.Repeat([]byte{0x24}, vault.WrapNonceBytes)
	env, ctBytes, err := vault.SealEntry(uuid.NewString(), "vk:7f3a1c9e02b4d6f89012ab", []byte("bulk tombstone"), vk, nonce)
	if err != nil {
		t.Fatal(err)
	}
	envRaw, _ := json.Marshal(env)
	bucket, _ := entry.ExpectedPlaintextLenBucket(len(ctBytes))

	_, err = pool.Exec(ctx, `
		INSERT INTO entry (
			id, user_id, item_id, type, position, envelope, ciphertext,
			plaintext_len_bucket, version, deleted_at, deleted_via
		)
		SELECT
			gen_random_uuid(), $1, $2, 'text', 10 + g, $3, $4,
			$5, 1, $6, 'entry'
		FROM generate_series(1, 520) AS g
	`, userA, liveItem, envRaw, ctBytes, bucket, del35d)
	if err != nil {
		t.Fatalf("bulk seed 520 expired entries: %v", err)
	}
	contenttest.AssertInvariants(t, pool, userA)

	// Single-batch call (`PurgeUserExpiredContentBatch` with an oversized `batchSize = 750 > 500`)
	// must clamp to `DefaultContentPurgeBatchSize = 500` and delete at most 500 rows in one transaction,
	// leaving 20 expired rows for the next transaction (EA7-R1-2).
	var batch1HookCalls int
	batch1Ctx := entry.WithPurgeLockHeldHook(ctx, func(_ context.Context, _ uuid.UUID) {
		batch1HookCalls++
	})
	batch1, err := entry.PurgeUserExpiredContentBatch(batch1Ctx, pool, userA, cutoff, 750)
	if err != nil {
		t.Fatalf("PurgeUserExpiredContentBatch 1 (requested 750): %v", err)
	}
	if batch1.EntriesDeleted != 500 {
		t.Fatalf("batch 1 EntriesDeleted = %d, want 500 (clamped from 750)", batch1.EntriesDeleted)
	}
	if batch1HookCalls != 1 {
		t.Fatalf("batch 1 hook calls = %d, want 1", batch1HookCalls)
	}
	var remainingAfterBatch1 int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM entry WHERE user_id = $1 AND deleted_at < $2`, userA, cutoff).Scan(&remainingAfterBatch1); err != nil {
		t.Fatal(err)
	}
	if remainingAfterBatch1 != 20 {
		t.Fatalf("remaining expired entries after single clamped batch = %d, want 20", remainingAfterBatch1)
	}
	// Execute the remaining purge via the River worker registered in `worker.New`.
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelError}))
	client, err := worker.New(pool, logger)
	if err != nil {
		t.Fatalf("worker.New: %v", err)
	}
	startCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := client.Start(startCtx); err != nil {
		t.Fatalf("client.Start: %v", err)
	}
	defer func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer stopCancel()
		_ = client.Stop(stopCtx)
	}()

	subscribeCh, subscribeCancel := client.Subscribe(river.EventKindJobCompleted)
	defer subscribeCancel()

	if _, err := client.Insert(ctx, entry.ContentPurgeArgs{Cutoff: &cutoff}, nil); err != nil {
		t.Fatalf("client.Insert ContentPurgeArgs: %v", err)
	}

	waitDone := time.After(15 * time.Second)
	for {
		select {
		case ev := <-subscribeCh:
			if ev != nil && ev.Job != nil && ev.Job.Kind == (entry.ContentPurgeArgs{}).Kind() {
				goto jobCompleted
			}
		case <-waitDone:
			t.Fatal("timed out waiting for content_purge job to complete in River")
		}
	}
jobCompleted:

	// All 520 expired tombstones are now gone; the live entry and 20d tombstone remain.
	var remainingTotal int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM entry WHERE user_id = $1`, userA).Scan(&remainingTotal); err != nil {
		t.Fatal(err)
	}
	if remainingTotal != 2 {
		t.Fatalf("remaining entries for userA = %d, want 2 (1 live + 1 20d tombstone)", remainingTotal)
	}
	if !rowExists(t, ctx, pool, "entry", liveEntry) || !rowExists(t, ctx, pool, "entry", recentTombstone) {
		t.Fatal("expected liveEntry and recentTombstone to survive content_purge job")
	}

	// Verify direct `ContentPurgeWorker.Work` with a fixed clock (`now - 30d`).
	fixedClk := clock.NewFixed(now)
	w := entry.NewContentPurgeWorker(pool, fixedClk)
	if err := w.Work(ctx, &river.Job[entry.ContentPurgeArgs]{Args: entry.ContentPurgeArgs{}}); err != nil {
		t.Fatalf("ContentPurgeWorker.Work: %v", err)
	}
	contenttest.AssertInvariants(t, pool, userA)
	_ = gen.New(pool)
}

// TestPurgeExpiredContentLockAcquisitionOrderItemTagBeforeEntry covers EA7-R1-1:
//   - Verifies that `PurgeUserExpiredContentBatch` acquires locks in the global order
//     (`LockUserContent` -> `item` rows in ascending `id` -> `tag` rows in ascending `id` -> `entry` deletes)
//     and never locks an `entry` row before all `item` and `tag` rows of the batch are locked.
//   - Stage 1 (item wait): a concurrent tx holds a `FOR UPDATE` lock on the higher-ID expired `item` row;
//     `pg_locks` / `pg_blocking_pids` proves the purge tx waits on `item` while holding zero row/tuple locks
//     on `entry` or `tag`.
//   - Stage 2 (tag wait): a concurrent tx holds a `FOR UPDATE` lock on the higher-ID expired `tag` row;
//     `pg_locks` / `pg_blocking_pids` proves the purge tx waits on `tag` while holding `item` locks and zero
//     row/tuple locks on `entry` (nor has the expired `item` been deleted/cascaded yet).
//   - Verifies counter invariants (`contenttest.AssertInvariants`) before and after purge.
func TestPurgeExpiredContentLockAcquisitionOrderItemTagBeforeEntry(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	userA := insertPurgeTestUser(t, ctx, pool, "purge-lock-order@example.com")
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	cutoff := now.Add(-entry.ContentPurgeRetentionWindow)
	del35d := now.Add(-35 * 24 * time.Hour)
	del34d := now.Add(-34 * 24 * time.Hour)

	// Live item with 1 live entry and 1 expired entry (must not be locked before item & tag!).
	liveItem := insertPurgeTestItem(t, ctx, pool, userA, "Lock Order Live Item", 1, nil)
	liveEntry := insertPurgeTestEntry(t, ctx, pool, userA, liveItem, 0, nil, "")
	expStandaloneEntry := insertPurgeTestEntry(t, ctx, pool, userA, liveItem, 1, &del35d, entry.DeletedViaEntry)

	// Two expired items: force itemLowID < itemHighID, but give itemHighID an OLDER deleted_at (del35d)
	// than itemLowID (del34d) so that without `ORDER BY i.id ASC` on the outer lock query, itemHighID
	// would be locked before itemLowID.
	itemA := insertPurgeTestItem(t, ctx, pool, userA, "Expired Item 1", 0, &del35d)
	itemB := insertPurgeTestItem(t, ctx, pool, userA, "Expired Item 2", 0, &del35d)
	itemLowID, itemHighID := itemA, itemB
	if bytes.Compare(itemLowID[:], itemHighID[:]) > 0 {
		itemLowID, itemHighID = itemHighID, itemLowID
	}
	if _, err := pool.Exec(ctx, `UPDATE item SET deleted_at = $1 WHERE id = $2`, del34d, itemLowID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE item SET deleted_at = $1 WHERE id = $2`, del35d, itemHighID); err != nil {
		t.Fatal(err)
	}
	cascadedEntryOnItemLow := insertPurgeTestEntry(t, ctx, pool, userA, itemLowID, 0, &del34d, entry.DeletedViaItem)

	// Two expired tags: similarly give tagHighID an older deleted_at (del35d) than tagLowID (del34d).
	liveTag := insertPurgeTestTag(t, ctx, pool, userA, "lock-order-live-tag", 1, nil)
	linkPurgeItemTag(t, ctx, pool, liveItem, liveTag)

	tagA := insertPurgeTestTag(t, ctx, pool, userA, "expired-tag-1", 0, &del35d)
	tagB := insertPurgeTestTag(t, ctx, pool, userA, "expired-tag-2", 0, &del35d)
	tagLowID, tagHighID := tagA, tagB
	if bytes.Compare(tagLowID[:], tagHighID[:]) > 0 {
		tagLowID, tagHighID = tagHighID, tagLowID
	}
	if _, err := pool.Exec(ctx, `UPDATE tag SET deleted_at = $1 WHERE id = $2`, del34d, tagLowID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tag SET deleted_at = $1 WHERE id = $2`, del35d, tagHighID); err != nil {
		t.Fatal(err)
	}

	contenttest.AssertInvariants(t, pool, userA)

	// --- Stage 1: Hold FOR UPDATE on `itemHighID` and verify purge blocks on `item` before touching `tag` or `entry`. ---
	blockerItemTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin blockerItemTx: %v", err)
	}
	defer func() { _ = blockerItemTx.Rollback(ctx) }()

	var blockerItemPID int32
	if err := blockerItemTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerItemPID); err != nil {
		t.Fatal(err)
	}
	var lockedItem uuid.UUID
	if err := blockerItemTx.QueryRow(ctx, `SELECT id FROM item WHERE id = $1 FOR UPDATE`, itemHighID).Scan(&lockedItem); err != nil {
		t.Fatalf("lock itemHighID: %v", err)
	}

	// Also hold a Second tx that will lock `tagHighID` so after Stage 1 releases `itemHighID`,
	// purge advances to Stage 2 and blocks on `tagHighID` before any `DELETE` or `entry` lock runs.
	blockerTagTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin blockerTagTx: %v", err)
	}
	defer func() { _ = blockerTagTx.Rollback(ctx) }()

	var blockerTagPID int32
	if err := blockerTagTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&blockerTagPID); err != nil {
		t.Fatal(err)
	}
	var lockedTag uuid.UUID
	if err := blockerTagTx.QueryRow(ctx, `SELECT id FROM tag WHERE id = $1 FOR UPDATE`, tagHighID).Scan(&lockedTag); err != nil {
		t.Fatalf("lock tagHighID: %v", err)
	}

	type purgeOutcome struct {
		res entry.PurgeResult
		err error
	}
	purgeCh := make(chan purgeOutcome, 1)
	go func() {
		res, err := entry.PurgeUserExpiredContentBatch(ctx, pool, userA, cutoff, entry.DefaultContentPurgeBatchSize)
		purgeCh <- purgeOutcome{res: res, err: err}
	}()

	// Poll pg_locks until the purge backend is blocked by blockerItemPID on relation `item`.
	var purgePID int32
	deadline := time.Now().Add(10 * time.Second)
	for {
		err := pool.QueryRow(ctx, `
			SELECT a.pid
			FROM pg_stat_activity AS a
			WHERE a.datname = current_database()
			  AND $1 = ANY(pg_blocking_pids(a.pid))
			  AND EXISTS (
				SELECT 1
				FROM pg_locks AS l
				WHERE l.pid = a.pid
				  AND l.relation = 'item'::regclass
			  )
			LIMIT 1
		`, blockerItemPID).Scan(&purgePID)
		if err == nil && purgePID != 0 {
			break
		}
		select {
		case out := <-purgeCh:
			t.Fatalf("purge finished early while blockerItemTx held item lock: %+v, err=%v", out.res, out.err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for purge tx to block on itemHighID held by PID %d", blockerItemPID)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// While blocked on `itemHighID`:
	//   1. Purge must NOT have acquired any lock on `entry` or `tag` relations.
	//   2. Because `itemLowID < itemHighID` is locked in ascending ID order, `itemLowID` must already be
	//      locked by `purgePID` (verify another connection with `FOR UPDATE NOWAIT` on `itemLowID` fails).
	var prematureEntryOrTagLocks int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM pg_locks
		WHERE pid = $1
		  AND relation IN ('entry'::regclass, 'tag'::regclass)
	`, purgePID).Scan(&prematureEntryOrTagLocks); err != nil {
		t.Fatalf("query premature entry/tag locks at stage 1: %v", err)
	}
	if prematureEntryOrTagLocks != 0 {
		t.Fatalf("stage 1: purgePID %d already holds %d locks on entry/tag while waiting on item lock", purgePID, prematureEntryOrTagLocks)
	}

	probeTx1, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var dummy uuid.UUID
	if err := probeTx1.QueryRow(ctx, `SELECT id FROM item WHERE id = $1 FOR UPDATE NOWAIT`, itemLowID).Scan(&dummy); err == nil {
		_ = probeTx1.Rollback(ctx)
		t.Fatalf("expected itemLowID (%s) to already be locked FOR UPDATE before itemHighID (%s) in ascending ID order", itemLowID, itemHighID)
	}
	_ = probeTx1.Rollback(ctx)

	// Release Stage 1 (`itemHighID` lock) -> purge must now advance to Stage 2 and block on `tagHighID`
	// BEFORE executing any DELETE on `item` (or cascading to `entry`) or locking `entry`.
	if err := blockerItemTx.Rollback(ctx); err != nil {
		t.Fatalf("rollback blockerItemTx: %v", err)
	}

	deadline = time.Now().Add(10 * time.Second)
	for {
		var blockedOnTag bool
		err := pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM pg_stat_activity AS a
				WHERE a.datname = current_database()
				  AND a.pid = $1
				  AND $2 = ANY(pg_blocking_pids(a.pid))
				  AND EXISTS (
					SELECT 1
					FROM pg_locks AS l
					WHERE l.pid = a.pid
					  AND l.relation = 'tag'::regclass
				  )
			)
		`, purgePID, blockerTagPID).Scan(&blockedOnTag)
		if err != nil {
			t.Fatalf("poll stage 2 tag wait: %v", err)
		}
		if blockedOnTag {
			break
		}
		select {
		case out := <-purgeCh:
			t.Fatalf("purge finished early while blockerTagTx held tag lock: %+v, err=%v", out.res, out.err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for purgePID %d to block on tagHighID held by PID %d", purgePID, blockerTagPID)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// While blocked on `tagHighID`:
	//   1. Purge must still hold ZERO locks on `entry` (item DELETE cascade has NOT run yet!).
	//   2. `tagLowID` (`< tagHighID`) must already be locked FOR UPDATE by `purgePID`.
	//   3. `cascadedEntryOnItemLow` and `expStandaloneEntry` must NOT be locked FOR UPDATE yet.
	var prematureEntryLocks int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM pg_locks
		WHERE pid = $1
		  AND relation = 'entry'::regclass
	`, purgePID).Scan(&prematureEntryLocks); err != nil {
		t.Fatalf("query premature entry locks at stage 2: %v", err)
	}
	if prematureEntryLocks != 0 {
		t.Fatalf("stage 2: purgePID %d already holds %d locks on entry while waiting on tag lock", purgePID, prematureEntryLocks)
	}

	probeTx2, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := probeTx2.QueryRow(ctx, `SELECT id FROM tag WHERE id = $1 FOR UPDATE NOWAIT`, tagLowID).Scan(&dummy); err == nil {
		_ = probeTx2.Rollback(ctx)
		t.Fatalf("expected tagLowID (%s) to already be locked FOR UPDATE before tagHighID (%s) in ascending ID order", tagLowID, tagHighID)
	}
	_ = probeTx2.Rollback(ctx)

	// Release Stage 2 (`tagHighID` lock) and verify the purge batch completes cleanly.
	if err := blockerTagTx.Rollback(ctx); err != nil {
		t.Fatalf("rollback blockerTagTx: %v", err)
	}

	select {
	case out := <-purgeCh:
		if out.err != nil {
			t.Fatalf("PurgeUserExpiredContentBatch: %v", out.err)
		}
		if out.res.ItemsDeleted != 2 || out.res.TagsDeleted != 2 || out.res.EntriesDeleted != 1 {
			t.Fatalf("PurgeUserExpiredContentBatch result = %+v, want ItemsDeleted=2, TagsDeleted=2, EntriesDeleted=1", out.res)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for PurgeUserExpiredContentBatch to complete after releasing tag lock")
	}

	for _, id := range []uuid.UUID{itemLowID, itemHighID} {
		if rowExists(t, ctx, pool, "item", id) {
			t.Fatalf("expected expired item %s to be deleted", id)
		}
	}
	for _, id := range []uuid.UUID{tagLowID, tagHighID} {
		if rowExists(t, ctx, pool, "tag", id) {
			t.Fatalf("expected expired tag %s to be deleted", id)
		}
	}
	for _, id := range []uuid.UUID{cascadedEntryOnItemLow, expStandaloneEntry} {
		if rowExists(t, ctx, pool, "entry", id) {
			t.Fatalf("expected expired/cascaded entry %s to be deleted", id)
		}
	}
	if !rowExists(t, ctx, pool, "item", liveItem) || !rowExists(t, ctx, pool, "entry", liveEntry) || !rowExists(t, ctx, pool, "tag", liveTag) {
		t.Fatal("expected live item, entry, and tag to survive purge")
	}

	contenttest.AssertInvariants(t, pool, userA)
}
