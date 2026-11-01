package entryhttp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/textnorm"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

func issueReauthGrant(t *testing.T, h *contenttest.Harness, jar contenttest.CookieJar, action, password string) string {
	t.Helper()
	payload := fmt.Sprintf(`{"action":%q,"password":%q}`, action, password)
	resp, raw := h.DoReq(jar, http.MethodPost, "/api/v1/auth/reauth", payload, contenttest.ReqOptions{})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/v1/auth/reauth (%s) = %d %s", action, resp.StatusCode, raw)
	}
	var g auth.ReauthGrant
	if err := json.Unmarshal([]byte(raw), &g); err != nil {
		t.Fatalf("decode reauth grant: %v", err)
	}
	return g.Grant
}

func formatVaultIfMatch(vaultKeyID string, version int32) string {
	return fmt.Sprintf(`"%s:%d"`, vaultKeyID, version)
}

func doDeleteVaultCtx(
	ctx context.Context,
	h *contenttest.Harness,
	jar contenttest.CookieJar,
	idemKey, ifMatch, grant string,
) (contenttest.TestResponse, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, h.Server.URL+"/api/v1/vault", nil)
	if err != nil {
		return contenttest.TestResponse{}, "", err
	}
	req.Header.Set("Origin", h.Origin)
	if jar != nil {
		jar.Apply(req)
		if c := jar[authhttp.CookieCSRF]; c != nil {
			req.Header.Set(authhttp.HeaderCSRF, c.Value)
		}
	}
	if idemKey != "" {
		req.Header.Set(httpx.HeaderIdempotencyKey, idemKey)
	}
	if ifMatch != "" {
		req.Header.Set(httpx.HeaderIfMatch, ifMatch)
	}
	if grant != "" {
		req.Header.Set(authhttp.HeaderReauth, grant)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return contenttest.TestResponse{}, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return contenttest.TestResponse{}, "", err
	}
	return contenttest.TestResponse{
		StatusCode: resp.StatusCode,
		Header:     resp.Header,
	}, string(b), nil
}

func insertTestTagForReset(t *testing.T, ctx context.Context, q *gen.Queries, userID uuid.UUID, display string) gen.Tag {
	t.Helper()
	norm, err := textnorm.Normalize(display)
	if err != nil {
		t.Fatalf("Normalize(%q): %v", display, err)
	}
	tag, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     userID,
		Display:    display,
		Normalized: norm,
	})
	if err != nil {
		t.Fatalf("InsertTag(%q): %v", display, err)
	}
	return tag
}

func assignTestTagToLiveItem(t *testing.T, ctx context.Context, q *gen.Queries, now time.Time, userID, itemID, tagID uuid.UUID) {
	t.Helper()
	if _, err := q.AssignItemTag(ctx, gen.AssignItemTagParams{
		UserID: userID,
		ItemID: itemID,
		TagID:  tagID,
	}); err != nil {
		t.Fatalf("AssignItemTag: %v", err)
	}
	if _, err := q.IncrementTagsItemCountAndTouch(ctx, gen.IncrementTagsItemCountAndTouchParams{
		Now:    pgtype.Timestamptz{Time: now.UTC(), Valid: true},
		UserID: userID,
		TagIds: []uuid.UUID{tagID},
	}); err != nil {
		t.Fatalf("IncrementTagsItemCountAndTouch: %v", err)
	}
}

func countEntriesForUser(t *testing.T, ctx context.Context, h *contenttest.Harness, userID uuid.UUID) (total, live, tombstones int) {
	t.Helper()
	err := h.Pool.QueryRow(ctx, `
		SELECT
			count(*)::int,
			count(*) FILTER (WHERE deleted_at IS NULL)::int,
			count(*) FILTER (WHERE deleted_at IS NOT NULL)::int
		FROM entry
		WHERE user_id = $1
	`, userID).Scan(&total, &live, &tombstones)
	if err != nil {
		t.Fatalf("countEntriesForUser(%s): %v", userID, err)
	}
	return total, live, tombstones
}

func waitForPgLocksCondition(t *testing.T, timeout time.Duration, desc string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for pg_locks condition: %s", desc)
}

func waitForPostEntriesVaultRowLockWaiter(
	t *testing.T,
	ctx context.Context,
	h *contenttest.Harness,
	resetHoldPID int32,
	earlyPostDone <-chan struct{},
	formatEarlyPost func() string,
) int32 {
	t.Helper()
	if resetHoldPID == 0 {
		t.Fatal("reset transaction backend PID is 0")
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		var waiterPID int32
		if err := h.Pool.QueryRow(ctx, `
			SELECT COALESCE((
				SELECT a.pid
				FROM pg_stat_activity AS a
				WHERE a.datname = current_database()
				  AND a.pid <> $1
				  AND $1 = ANY(pg_blocking_pids(a.pid))
				  AND EXISTS (
					SELECT 1
					FROM pg_locks AS l
					WHERE l.pid = a.pid
					  AND l.locktype = 'transactionid'
					  AND NOT l.granted
				  )
				  AND EXISTS (
					SELECT 1
					FROM pg_locks AS vr
					WHERE vr.pid = a.pid
					  AND vr.relation = 'vault'::regclass
					  AND vr.mode = 'RowShareLock'
					  AND vr.granted
				  )
				LIMIT 1
			), 0)
		`, resetHoldPID).Scan(&waiterPID); err != nil {
			t.Fatalf("query pg_blocking_pids / pg_locks for resetHoldPID=%d: %v", resetHoldPID, err)
		}
		if waiterPID != 0 {
			return waiterPID
		}
		select {
		case <-earlyPostDone:
			detail := ""
			if formatEarlyPost != nil {
				detail = ": " + formatEarlyPost()
			}
			t.Fatalf("POST entries finished early before blocking on vault row lock held by resetPID=%d%s", resetHoldPID, detail)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for POST entries backend to block on vault row lock held by resetPID=%d", resetHoldPID)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func hasAdvisoryContentLockWaiter(ctx context.Context, h *contenttest.Harness, userID uuid.UUID) bool {
	var waiting int
	err := h.Pool.QueryRow(ctx, `
		SELECT count(*)::int
		FROM pg_locks
		WHERE locktype = 'advisory'
		  AND classid = hashtext('engram.content')
		  AND objid = hashtext(($1::uuid)::text)
		  AND NOT granted
	`, userID).Scan(&waiting)
	return err == nil && waiting >= 1
}

func waitForResetBlockedByPurgeTx(
	t *testing.T,
	ctx context.Context,
	h *contenttest.Harness,
	userID uuid.UUID,
	pauseStep entry.PurgeBatchStep,
	earlyResetDone <-chan struct{},
) (purgePID, resetPID int32) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		err := h.Pool.QueryRow(ctx, `
			SELECT COALESCE(holder.pid, 0), COALESCE(waiter.pid, 0)
			FROM pg_locks AS waiter
			JOIN pg_database AS d ON d.oid = waiter.database AND d.datname = current_database()
			JOIN pg_locks AS holder
			  ON holder.database = waiter.database
			 AND holder.locktype = 'advisory'
			 AND holder.objsubid = 2
			 AND holder.classid = waiter.classid
			 AND holder.objid = waiter.objid
			 AND holder.granted
			WHERE waiter.locktype = 'advisory'
			  AND NOT waiter.granted
			  AND waiter.objsubid = 2
			  AND waiter.classid::int4 = hashtext('engram.content')
			  AND waiter.objid::int4 = hashtext(($1::uuid)::text)
			  AND holder.pid = ANY(pg_blocking_pids(waiter.pid))
			LIMIT 1
		`, userID).Scan(&purgePID, &resetPID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("query pg_locks / pg_blocking_pids for purge->reset (%s): %v", pauseStep, err)
		}
		if purgePID != 0 && resetPID != 0 {
			return purgePID, resetPID
		}
		select {
		case <-earlyResetDone:
			t.Fatalf("reset finished early before blocking behind purge tx at step %s", pauseStep)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for reset tx to block behind purge tx on LockUserContent at step %s", pauseStep)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func assertRowLockedByPurgeAtStep(t *testing.T, ctx context.Context, h *contenttest.Harness, table string, rowID uuid.UUID, step entry.PurgeBatchStep) {
	t.Helper()
	probeTx, err := h.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin probeTx (%s at %s): %v", table, step, err)
	}
	defer func() { _ = probeTx.Rollback(ctx) }()

	var dummy uuid.UUID
	query := fmt.Sprintf(`SELECT id FROM %s WHERE id = $1 FOR UPDATE NOWAIT`, table)
	if err := probeTx.QueryRow(ctx, query, rowID).Scan(&dummy); err == nil {
		t.Fatalf("expected %s row %s to be locked FOR UPDATE by purge tx at step %s", table, rowID, step)
	}
}

// softDeleteItemInTx executes the exact item soft-delete transaction following plan §2.5 & §2.8 lock order:
//  1. LockUserContent(userID)
//  2. LockItemForUpdate(userID, itemID)
//  3. LockTagsOfItemForUpdate(userID, itemID) (ORDER BY t.id ASC)
//  4. LockLiveEntriesOfItemForUpdate(userID, itemID) (ORDER BY id ASC)
//  5. SoftDeleteLiveEntriesByItem + SoftDeleteItem + AdjustAllLinkedTagsItemCountForItem(-1)
func softDeleteItemInTx(
	ctx context.Context,
	h *contenttest.Harness,
	userID, itemID uuid.UUID,
	onStep func(ctx context.Context, step string) error,
) error {
	tx, err := httpx.BeginMutationTx(ctx, h.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := gen.New(tx)
	if err := q.LockUserContent(ctx, userID); err != nil {
		return err
	}
	if onStep != nil {
		if err := onStep(ctx, "after_user_content_lock"); err != nil {
			return err
		}
	}

	lockedItem, err := q.LockItemForUpdate(ctx, gen.LockItemForUpdateParams{
		UserID: userID,
		ID:     itemID,
	})
	if err != nil {
		return err
	}
	if onStep != nil {
		if err := onStep(ctx, "after_item_lock"); err != nil {
			return err
		}
	}

	if lockedItem.DeletedAt.Valid {
		return tx.Commit(ctx)
	}

	if _, err := q.LockTagsOfItemForUpdate(ctx, gen.LockTagsOfItemForUpdateParams{
		UserID: userID,
		ItemID: itemID,
	}); err != nil {
		return err
	}
	if onStep != nil {
		if err := onStep(ctx, "after_tags_lock"); err != nil {
			return err
		}
	}

	if _, err := q.LockLiveEntriesOfItemForUpdate(ctx, gen.LockLiveEntriesOfItemForUpdateParams{
		UserID: userID,
		ItemID: itemID,
	}); err != nil {
		return err
	}
	if onStep != nil {
		if err := onStep(ctx, "after_entries_lock"); err != nil {
			return err
		}
	}
	batch := uuid.New()
	if _, err := q.SoftDeleteLiveEntriesByItem(ctx, gen.SoftDeleteLiveEntriesByItemParams{
		DeleteBatch: &batch,
		UserID:      userID,
		ItemID:      itemID,
	}); err != nil {
		return err
	}
	if _, err := q.SoftDeleteItem(ctx, gen.SoftDeleteItemParams{
		DeleteBatch: &batch,
		UserID:      userID,
		ID:          itemID,
	}); err != nil {
		return err
	}
	if _, err := q.AdjustAllLinkedTagsItemCountForItem(ctx, gen.AdjustAllLinkedTagsItemCountForItemParams{
		Delta:  -1,
		UserID: userID,
		ItemID: itemID,
	}); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// restoreItemInTx executes the exact item restore transaction following plan §2.5 & §2.8 lock order:
//  1. LockUserContent(userID)
//  2. LockItemForUpdate(userID, itemID)
//  3. LockTagsOfItemForUpdate(userID, itemID) (ORDER BY t.id ASC)
//  4. CountLiveTagsByItem (<= 20) + CountEntriesByItemBatch (<= 200)
//  5. RestoreEntriesByItemBatch + RestoreItem(entry_count = restoredRows) + AdjustAllLinkedTagsItemCountForItem(+1)
func restoreItemInTx(
	ctx context.Context,
	h *contenttest.Harness,
	userID, itemID uuid.UUID,
	onStep func(ctx context.Context, step string) error,
) error {
	tx, err := httpx.BeginMutationTx(ctx, h.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := gen.New(tx)
	if err := q.LockUserContent(ctx, userID); err != nil {
		return err
	}
	if onStep != nil {
		if err := onStep(ctx, "after_user_content_lock"); err != nil {
			return err
		}
	}

	lockedItem, err := q.LockItemForUpdate(ctx, gen.LockItemForUpdateParams{
		UserID: userID,
		ID:     itemID,
	})
	if err != nil {
		return err
	}
	if onStep != nil {
		if err := onStep(ctx, "after_item_lock"); err != nil {
			return err
		}
	}

	if !lockedItem.DeletedAt.Valid {
		return tx.Commit(ctx)
	}

	if _, err := q.LockTagsOfItemForUpdate(ctx, gen.LockTagsOfItemForUpdateParams{
		UserID: userID,
		ItemID: itemID,
	}); err != nil {
		return err
	}
	if onStep != nil {
		if err := onStep(ctx, "after_tags_lock"); err != nil {
			return err
		}
	}
	liveTags, err := q.CountLiveTagsByItem(ctx, gen.CountLiveTagsByItemParams{
		UserID: userID,
		ItemID: itemID,
	})
	if err != nil {
		return err
	}
	if liveTags > contenttest.MaxLiveTagsPerItem {
		return errors.New("item_tag_limit")
	}

	batchEntries, err := q.CountEntriesByItemBatch(ctx, gen.CountEntriesByItemBatchParams{
		UserID:      userID,
		ItemID:      itemID,
		DeleteBatch: lockedItem.DeleteBatch,
	})
	if err != nil {
		return err
	}
	if batchEntries > contenttest.MaxLiveEntriesPerItem {
		return errors.New("item_entry_limit")
	}

	restoredRows, err := q.RestoreEntriesByItemBatch(ctx, gen.RestoreEntriesByItemBatchParams{
		UserID:      userID,
		ItemID:      itemID,
		DeleteBatch: lockedItem.DeleteBatch,
	})
	if err != nil {
		return err
	}
	if _, err := q.RestoreItem(ctx, gen.RestoreItemParams{
		EntryCount: int32(restoredRows),
		UserID:     userID,
		ID:         itemID,
	}); err != nil {
		return err
	}
	if _, err := q.AdjustAllLinkedTagsItemCountForItem(ctx, gen.AdjustAllLinkedTagsItemCountForItemParams{
		Delta:  1,
		UserID: userID,
		ItemID: itemID,
	}); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// TestVaultResetHookDeletesEntriesKeepsItemsTagsReplayRollbackNewKeyAndCrossUserIsolation covers Task 8 bullets 1, 2, 5, 6
// and section 6 rows P04-A2 & P04-A9 (closing carry-forward T12-P04 on the server side):
//   - Reset keeps item, tag, item_tag, and tag.item_count intact, hard-deletes every entry of the user
//     (including soft-deleted tombstones via both 'entry' and 'item'), and zeroes item.entry_count = 0.
//   - Content idempotency_key rows are preserved across reset: replaying a historical POST /items/{id}/entries
//     or PUT /entries/{id} request with the same Idempotency-Key + body after reset returns the stored historical
//     response (advisor-dec-135) without re-executing the handler or recreating any entry row.
//   - Failing ResetHook (wrapping entry.ResetHook and returning an error after entry.ResetHook has already deleted
//     the entries and zeroed item.entry_count inside the transaction) rolls back the entire reset transaction:
//     the vault row, all live and tombstone entries, and item.entry_count remain intact.
//   - Before creating a new vault, any new entry write fails with 404 vault_absent.
//   - After creating a new vault (which receives a new vault_key_id), any new entry write carrying the old
//     key_id fails with 409 entry_key_mismatch (both POST create and POST import-json), while a new entry
//     sealed under the new vault_key_id succeeds with 201 Created.
//   - Another user's (User B's) vault, items, tags, item_tag links, and live/tombstone entries are completely
//     untouched by User A's reset (P04-A9 server side).
func TestVaultResetHookDeletesEntriesKeepsItemsTagsReplayRollbackNewKeyAndCrossUserIsolation(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{
		ResetHook: entry.ResetHook,
	})
	passwordA := "correct-horse-battery-staple-a"
	passwordB := "correct-horse-battery-staple-b"
	jarA, meA := h.SignupUser("reset-hook-alice@example.com", passwordA)
	jarB, meB := h.SignupUser("reset-hook-bob@example.com", passwordB)

	vfA1 := createVaultForUser(t, h, jarA, 0x10)
	vfB := createVaultForUser(t, h, jarB, 0x60)

	ctx := context.Background()
	q := gen.New(h.Pool)

	// Seed Alice:
	// - itemA1 (live): 2 live entries (text + json import) + 1 soft-deleted tombstone ('entry')
	// - itemA2 (live): 1 live entry
	// - itemA3 (soft-deleted via item delete): 1 soft-deleted tombstone ('item')
	// - tagA1 (live, linked to itemA1 and itemA2 -> item_count = 2)
	// - tagA2 (live, linked to itemA1 and soft-deleted itemA3 -> item_count = 1)
	// - tagA3 (soft-deleted, linked to live itemA1 -> item_count = 1 per P4BE1-4)
	itemA1 := insertTestItem(t, h, meA.User.ID, "Alice Live Item One")
	itemA2 := insertTestItem(t, h, meA.User.ID, "Alice Live Item Two")
	itemA3 := insertTestItem(t, h, meA.User.ID, "Alice Deleted Item Three")

	tagA1 := insertTestTagForReset(t, ctx, q, meA.User.ID, "infra")
	tagA2 := insertTestTagForReset(t, ctx, q, meA.User.ID, "prod")
	tagA3 := insertTestTagForReset(t, ctx, q, meA.User.ID, "archived-tag")

	now := h.Clock.Now()
	assignTestTagToLiveItem(t, ctx, q, now, meA.User.ID, itemA1.ID, tagA1.ID)
	assignTestTagToLiveItem(t, ctx, q, now, meA.User.ID, itemA2.ID, tagA1.ID)
	assignTestTagToLiveItem(t, ctx, q, now, meA.User.ID, itemA1.ID, tagA2.ID)
	assignTestTagToLiveItem(t, ctx, q, now, meA.User.ID, itemA3.ID, tagA2.ID)
	assignTestTagToLiveItem(t, ctx, q, now, meA.User.ID, itemA1.ID, tagA3.ID)
	if _, err := q.SoftDeleteTag(ctx, gen.SoftDeleteTagParams{
		UserID: meA.User.ID,
		ID:     tagA3.ID,
	}); err != nil {
		t.Fatalf("SoftDeleteTag(tagA3): %v", err)
	}

	// Create entries on Alice's items via real HTTP handlers so content idempotency_key rows are populated.
	entryA1LiveID := uuid.NewString()
	sealedA1Live := sealEntryFixture(t, entryA1LiveID, vfA1.VaultKeyID, vfA1.VK, []byte("alice live text entry 1"), seqBytes(vault.WrapNonceBytes, 0x11))
	createBodyA1Live := makeCreateBody(entryA1LiveID, entry.TypeText, sealedA1Live.EnvelopeRaw, sealedA1Live.CiphertextB64, sealedA1Live.PlaintextLenBucket)
	idemCreateA1Live := "idem_t8_alice_create_live_01"
	respCreateA1, rawCreateA1 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA1.ID.String()+"/entries", createBodyA1Live, contenttest.ReqOptions{
		IdemKey: idemCreateA1Live,
	})
	if respCreateA1.StatusCode != http.StatusCreated {
		t.Fatalf("create entryA1Live = %d %s", respCreateA1.StatusCode, rawCreateA1)
	}

	// Also update entryA1Live via PUT so we have a historical PUT idempotency key to replay after reset.
	sealedA1LiveV2 := sealEntryFixture(t, entryA1LiveID, vfA1.VaultKeyID, vfA1.VK, []byte("alice live text entry 1 updated v2"), seqBytes(vault.WrapNonceBytes, 0x12))
	updateBodyA1LiveV2 := makeUpdateBody(sealedA1LiveV2.EnvelopeRaw, sealedA1LiveV2.CiphertextB64, sealedA1LiveV2.PlaintextLenBucket)
	idemPutA1Live := "idem_t8_alice_put_live_01_v2"
	respPutA1, rawPutA1 := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+entryA1LiveID, updateBodyA1LiveV2, contenttest.ReqOptions{
		IdemKey: idemPutA1Live,
		IfMatch: `"1"`,
	})
	if respPutA1.StatusCode != http.StatusOK {
		t.Fatalf("PUT entryA1Live = %d %s", respPutA1.StatusCode, rawPutA1)
	}

	// Import JSON entry on itemA1.
	entryA1JSONID := uuid.NewString()
	sealedA1JSON := sealEntryFixture(t, entryA1JSONID, vfA1.VaultKeyID, vfA1.VK, []byte(`{"env":"prod","port":5432}`), seqBytes(vault.WrapNonceBytes, 0x13))
	importBodyA1 := fmt.Sprintf(
		`{"id":%q,"type":"json","source":"paste","envelope":%s,"ciphertext":%q,"plaintext_len_bucket":%d}`,
		entryA1JSONID, sealedA1JSON.EnvelopeRaw, sealedA1JSON.CiphertextB64, sealedA1JSON.PlaintextLenBucket,
	)
	respImportA1, rawImportA1 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA1.ID.String()+"/entries/import-json", importBodyA1, contenttest.ReqOptions{
		IdemKey: "idem_t8_alice_import_json_01",
	})
	if respImportA1.StatusCode != http.StatusCreated {
		t.Fatalf("import entryA1JSON = %d %s", respImportA1.StatusCode, rawImportA1)
	}

	// Create and soft-delete an entry on itemA1 ('entry' tombstone).
	entryA1TombID := uuid.NewString()
	sealedA1Tomb := sealEntryFixture(t, entryA1TombID, vfA1.VaultKeyID, vfA1.VK, []byte("alice tombstone entry"), seqBytes(vault.WrapNonceBytes, 0x14))
	respCreateTomb, rawCreateTomb := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA1.ID.String()+"/entries",
		makeCreateBody(entryA1TombID, entry.TypeText, sealedA1Tomb.EnvelopeRaw, sealedA1Tomb.CiphertextB64, sealedA1Tomb.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t8_alice_create_tomb_01"})
	if respCreateTomb.StatusCode != http.StatusCreated {
		t.Fatalf("create entryA1Tomb = %d %s", respCreateTomb.StatusCode, rawCreateTomb)
	}
	respDelTomb, rawDelTomb := h.DoReq(jarA, http.MethodDelete, "/api/v1/entries/"+entryA1TombID, "", contenttest.ReqOptions{
		IdemKey: "idem_t8_alice_delete_tomb_01",
	})
	if respDelTomb.StatusCode != http.StatusNoContent {
		t.Fatalf("delete entryA1Tomb = %d %s", respDelTomb.StatusCode, rawDelTomb)
	}

	// Create a live entry on itemA2.
	entryA2LiveID := uuid.NewString()
	sealedA2Live := sealEntryFixture(t, entryA2LiveID, vfA1.VaultKeyID, vfA1.VK, []byte("alice item 2 live entry"), seqBytes(vault.WrapNonceBytes, 0x15))
	respCreateA2, rawCreateA2 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA2.ID.String()+"/entries",
		makeCreateBody(entryA2LiveID, entry.TypeText, sealedA2Live.EnvelopeRaw, sealedA2Live.CiphertextB64, sealedA2Live.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t8_alice_create_item2_01"})
	if respCreateA2.StatusCode != http.StatusCreated {
		t.Fatalf("create entryA2Live = %d %s", respCreateA2.StatusCode, rawCreateA2)
	}

	// Create an entry on itemA3, then soft-delete itemA3 (producing a 'deleted_via = item' tombstone and decrementing tagA2.item_count to 1).
	entryA3ItemTombID := uuid.NewString()
	sealedA3ItemTomb := sealEntryFixture(t, entryA3ItemTombID, vfA1.VaultKeyID, vfA1.VK, []byte("alice item 3 entry before item delete"), seqBytes(vault.WrapNonceBytes, 0x16))
	respCreateA3, rawCreateA3 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA3.ID.String()+"/entries",
		makeCreateBody(entryA3ItemTombID, entry.TypeText, sealedA3ItemTomb.EnvelopeRaw, sealedA3ItemTomb.CiphertextB64, sealedA3ItemTomb.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t8_alice_create_item3_01"})
	if respCreateA3.StatusCode != http.StatusCreated {
		t.Fatalf("create entryA3 = %d %s", respCreateA3.StatusCode, rawCreateA3)
	}
	if err := softDeleteItemInTx(ctx, h, meA.User.ID, itemA3.ID, nil); err != nil {
		t.Fatalf("softDeleteItemInTx(itemA3): %v", err)
	}

	// Seed Bob: 1 live item, 1 live tag linked to it, 1 live entry + 1 tombstone entry.
	itemB1 := insertTestItem(t, h, meB.User.ID, "Bob Untouched Item")
	tagB1 := insertTestTagForReset(t, ctx, q, meB.User.ID, "bob-tag")
	assignTestTagToLiveItem(t, ctx, q, now, meB.User.ID, itemB1.ID, tagB1.ID)

	entryB1LiveID := uuid.NewString()
	plaintextBLive := []byte("bob secret live entry payload")
	sealedB1Live := sealEntryFixture(t, entryB1LiveID, vfB.VaultKeyID, vfB.VK, plaintextBLive, seqBytes(vault.WrapNonceBytes, 0x61))
	respCreateB1, rawCreateB1 := h.DoReq(jarB, http.MethodPost, "/api/v1/items/"+itemB1.ID.String()+"/entries",
		makeCreateBody(entryB1LiveID, entry.TypeText, sealedB1Live.EnvelopeRaw, sealedB1Live.CiphertextB64, sealedB1Live.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t8_bob_create_live_01"})
	if respCreateB1.StatusCode != http.StatusCreated {
		t.Fatalf("create entryB1Live = %d %s", respCreateB1.StatusCode, rawCreateB1)
	}

	entryB1TombID := uuid.NewString()
	sealedB1Tomb := sealEntryFixture(t, entryB1TombID, vfB.VaultKeyID, vfB.VK, []byte("bob tombstone entry"), seqBytes(vault.WrapNonceBytes, 0x62))
	respCreateBTomb, rawCreateBTomb := h.DoReq(jarB, http.MethodPost, "/api/v1/items/"+itemB1.ID.String()+"/entries",
		makeCreateBody(entryB1TombID, entry.TypeText, sealedB1Tomb.EnvelopeRaw, sealedB1Tomb.CiphertextB64, sealedB1Tomb.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t8_bob_create_tomb_01"})
	if respCreateBTomb.StatusCode != http.StatusCreated {
		t.Fatalf("create entryB1Tomb = %d %s", respCreateBTomb.StatusCode, rawCreateBTomb)
	}
	respDelBTomb, rawDelBTomb := h.DoReq(jarB, http.MethodDelete, "/api/v1/entries/"+entryB1TombID, "", contenttest.ReqOptions{
		IdemKey: "idem_t8_bob_delete_tomb_01",
	})
	if respDelBTomb.StatusCode != http.StatusNoContent {
		t.Fatalf("delete entryB1Tomb = %d %s", respDelBTomb.StatusCode, rawDelBTomb)
	}

	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, meB.User.ID)

	totalA, liveA, tombA := countEntriesForUser(t, ctx, h, meA.User.ID)
	if totalA != 5 || liveA != 3 || tombA != 2 {
		t.Fatalf("Alice entries before reset = (total=%d, live=%d, tomb=%d), want (5, 3, 2)", totalA, liveA, tombA)
	}

	// Advance clock by 2s so rate-limit windows are clean.
	h.Clock.Advance(2 * time.Second)

	// -------------------------------------------------------------------------
	// 1. Failing ResetHook wrapping entry.ResetHook -> full transaction rollback.
	//    Verify entry.ResetHook actually deleted all 5 entries and zeroed item.entry_count inside tx,
	//    and that returning an error rolls back both the entry deletion and the vault reset.
	// -------------------------------------------------------------------------
	var innerDeletedCount, innerNonZeroItems int
	simulatedHookErr := errors.New("simulated post-entry-delete hook failure")
	h.VaultSvc.SetResetHook(func(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
		if err := entry.ResetHook(ctx, tx, userID); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT count(*)::int FROM entry WHERE user_id = $1`, userID).Scan(&innerDeletedCount); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT count(*)::int FROM item WHERE user_id = $1 AND entry_count <> 0`, userID).Scan(&innerNonZeroItems); err != nil {
			return err
		}
		return simulatedHookErr
	})

	grantResetFail := issueReauthGrant(t, h, jarA, "vault.reset", passwordA)
	ifMatchA1 := formatVaultIfMatch(vfA1.VaultKeyID, vfA1.Version)
	respFailReset, rawFailReset := h.DoReq(jarA, http.MethodDelete, "/api/v1/vault", "", contenttest.ReqOptions{
		IdemKey: "idem_t8_alice_reset_fail_01",
		IfMatch: ifMatchA1,
		Grant:   grantResetFail,
	})
	if respFailReset.StatusCode != http.StatusInternalServerError {
		t.Fatalf("DELETE /vault with failing hook = %d %s, want 500", respFailReset.StatusCode, rawFailReset)
	}
	if innerDeletedCount != 0 || innerNonZeroItems != 0 {
		t.Fatalf("inside tx after entry.ResetHook: entries=%d nonZeroItems=%d, want 0 and 0", innerDeletedCount, innerNonZeroItems)
	}

	// Verify rollback: Alice's vault still exists with vfA1.VaultKeyID, all 5 entries (3 live + 2 tombstones) still exist,
	// and item.entry_count is still 2 on itemA1 and 1 on itemA2.
	vaultRowAfterFail, err := q.GetVaultByUser(ctx, meA.User.ID)
	if err != nil || vaultRowAfterFail.VaultKeyID != vfA1.VaultKeyID {
		t.Fatalf("GetVaultByUser after failed reset = (%+v, %v), want key_id %s", vaultRowAfterFail, err, vfA1.VaultKeyID)
	}
	totalAfterFail, liveAfterFail, tombAfterFail := countEntriesForUser(t, ctx, h, meA.User.ID)
	if totalAfterFail != 5 || liveAfterFail != 3 || tombAfterFail != 2 {
		t.Fatalf("Alice entries after failed reset = (%d, %d, %d), want (5, 3, 2)", totalAfterFail, liveAfterFail, tombAfterFail)
	}
	itemA1AfterFail, err := q.GetItemByUserAndID(ctx, gen.GetItemByUserAndIDParams{UserID: meA.User.ID, ID: itemA1.ID})
	if err != nil || itemA1AfterFail.EntryCount != 2 {
		t.Fatalf("itemA1 after failed reset: count=%d err=%v, want 2", itemA1AfterFail.EntryCount, err)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// -------------------------------------------------------------------------
	// 2. Restore real entry.ResetHook and execute DELETE /api/v1/vault -> 204 No Content.
	//    Verify:
	//    - every entry of Alice (live and tombstone) is hard-deleted (0 rows in entry);
	//    - every item of Alice (live and soft-deleted) is preserved with entry_count = 0;
	//    - every tag (live and soft-deleted), item_tag, and tag.item_count of Alice is preserved;
	//    - content idempotency_key rows of Alice are preserved and replay returns historical responses.
	// -------------------------------------------------------------------------
	h.VaultSvc.SetResetHook(entry.ResetHook)
	h.Clock.Advance(61 * time.Second) // advance past vault_sensitive (10/min) 1-minute sliding window

	grantResetOK := issueReauthGrant(t, h, jarA, "vault.reset", passwordA)
	respReset, rawReset := h.DoReq(jarA, http.MethodDelete, "/api/v1/vault", "", contenttest.ReqOptions{
		IdemKey: "idem_t8_alice_reset_ok_01",
		IfMatch: ifMatchA1,
		Grant:   grantResetOK,
	})
	if respReset.StatusCode != http.StatusNoContent || rawReset != "" {
		t.Fatalf("DELETE /api/v1/vault = %d %q, want 204 empty", respReset.StatusCode, rawReset)
	}

	// All entries of Alice (live + tombstones) are hard-deleted.
	totalAfterReset, liveAfterReset, tombAfterReset := countEntriesForUser(t, ctx, h, meA.User.ID)
	if totalAfterReset != 0 || liveAfterReset != 0 || tombAfterReset != 0 {
		t.Fatalf("Alice entries after reset = (%d, %d, %d), want (0, 0, 0)", totalAfterReset, liveAfterReset, tombAfterReset)
	}

	// GET on previously live entry returns 404 not_found; list on itemA1 returns empty items: [].
	respGetDeletedEntry, rawGetDeletedEntry := h.DoReq(jarA, http.MethodGet, "/api/v1/entries/"+entryA1LiveID, "", contenttest.ReqOptions{})
	if respGetDeletedEntry.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawGetDeletedEntry).Code != "not_found" {
		t.Fatalf("GET entry after reset = %d %s, want 404 not_found", respGetDeletedEntry.StatusCode, rawGetDeletedEntry)
	}
	respListA1, rawListA1 := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+itemA1.ID.String()+"/entries", "", contenttest.ReqOptions{})
	if respListA1.StatusCode != http.StatusOK {
		t.Fatalf("GET /items/{itemA1}/entries after reset = %d %s, want 200", respListA1.StatusCode, rawListA1)
	}
	var listMetaA1 entry.MetaList
	if err := json.Unmarshal([]byte(rawListA1), &listMetaA1); err != nil {
		t.Fatal(err)
	}
	if len(listMetaA1.Items) != 0 || listMetaA1.NextCursor != nil {
		t.Fatalf("itemA1 entry list after reset = %+v, want empty", listMetaA1)
	}

	// Items, tags, item_tag, and tag.item_count of Alice are preserved; item.entry_count is 0.
	for _, wantItem := range []struct {
		id      uuid.UUID
		name    string
		deleted bool
	}{
		{id: itemA1.ID, name: "Alice Live Item One", deleted: false},
		{id: itemA2.ID, name: "Alice Live Item Two", deleted: false},
		{id: itemA3.ID, name: "Alice Deleted Item Three", deleted: true},
	} {
		gotItem, err := q.GetItemByUserAndID(ctx, gen.GetItemByUserAndIDParams{UserID: meA.User.ID, ID: wantItem.id})
		if err != nil {
			t.Fatalf("GetItemByUserAndID(%s) after reset: %v", wantItem.name, err)
		}
		if gotItem.Name != wantItem.name || gotItem.EntryCount != 0 || gotItem.DeletedAt.Valid != wantItem.deleted {
			t.Fatalf("item %s after reset = (name=%q, entry_count=%d, deleted=%v), want (%q, 0, %v)",
				wantItem.id, gotItem.Name, gotItem.EntryCount, gotItem.DeletedAt.Valid, wantItem.name, wantItem.deleted)
		}
	}

	for _, wantTag := range []struct {
		id        uuid.UUID
		display   string
		itemCount int32
		deleted   bool
	}{
		{id: tagA1.ID, display: "infra", itemCount: 2, deleted: false},
		{id: tagA2.ID, display: "prod", itemCount: 1, deleted: false},
		{id: tagA3.ID, display: "archived-tag", itemCount: 1, deleted: true},
	} {
		gotTag, err := q.GetTagByUserAndID(ctx, gen.GetTagByUserAndIDParams{UserID: meA.User.ID, ID: wantTag.id})
		if err != nil {
			t.Fatalf("GetTagByUserAndID(%s) after reset: %v", wantTag.display, err)
		}
		if gotTag.Display != wantTag.display || gotTag.ItemCount != wantTag.itemCount || gotTag.DeletedAt.Valid != wantTag.deleted {
			t.Fatalf("tag %s after reset = (display=%q, item_count=%d, deleted=%v), want (%q, %d, %v)",
				wantTag.id, gotTag.Display, gotTag.ItemCount, gotTag.DeletedAt.Valid, wantTag.display, wantTag.itemCount, wantTag.deleted)
		}
	}

	var itemTagLinksA int
	if err := h.Pool.QueryRow(ctx, `
		SELECT count(*)::int
		FROM item_tag AS it
		JOIN item AS i ON i.id = it.item_id
		WHERE i.user_id = $1
	`, meA.User.ID).Scan(&itemTagLinksA); err != nil {
		t.Fatal(err)
	}
	if itemTagLinksA != 5 {
		t.Fatalf("Alice item_tag count after reset = %d, want 5", itemTagLinksA)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Content idempotency_key rows are preserved across vault reset:
	// Replaying the historical POST /items/{id}/entries and PUT /entries/{id} with the same Idempotency-Key
	// returns the historical 201 / 200 responses (JSON-equal per advisor-dec-135) without recreating any entry.
	respReplayCreate, rawReplayCreate := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA1.ID.String()+"/entries", createBodyA1Live, contenttest.ReqOptions{
		IdemKey: idemCreateA1Live,
	})
	if respReplayCreate.StatusCode != http.StatusCreated {
		t.Fatalf("replay historical POST entry after reset = %d %s, want 201", respReplayCreate.StatusCode, rawReplayCreate)
	}
	contenttest.AssertJSONEqual(t, rawCreateA1, rawReplayCreate)

	respReplayPut, rawReplayPut := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+entryA1LiveID, updateBodyA1LiveV2, contenttest.ReqOptions{
		IdemKey: idemPutA1Live,
		IfMatch: `"1"`,
	})
	if respReplayPut.StatusCode != http.StatusOK {
		t.Fatalf("replay historical PUT entry after reset = %d %s, want 200", respReplayPut.StatusCode, rawReplayPut)
	}
	contenttest.AssertJSONEqual(t, rawPutA1, rawReplayPut)

	totalAfterReplay, _, _ := countEntriesForUser(t, ctx, h, meA.User.ID)
	if totalAfterReplay != 0 {
		t.Fatalf("Alice entries after idempotent replay = %d, want 0", totalAfterReplay)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// -------------------------------------------------------------------------
	// 3. Before creating a new vault, a new entry write fails with 404 vault_absent.
	//    After creating a new vault (vfA2 with a new vault_key_id), an entry carrying
	//    the old key_id (vfA1.VaultKeyID) fails with 409 entry_key_mismatch.
	// -------------------------------------------------------------------------
	staleEntryID1 := uuid.NewString()
	sealedStale1 := sealEntryFixture(t, staleEntryID1, vfA1.VaultKeyID, vfA1.VK, []byte("write while vault absent"), seqBytes(vault.WrapNonceBytes, 0x31))
	respAbsentCreate, rawAbsentCreate := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA1.ID.String()+"/entries",
		makeCreateBody(staleEntryID1, entry.TypeText, sealedStale1.EnvelopeRaw, sealedStale1.CiphertextB64, sealedStale1.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t8_alice_create_while_vault_absent"})
	if respAbsentCreate.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawAbsentCreate).Code != "vault_absent" {
		t.Fatalf("POST entry while vault absent = %d %s, want 404 vault_absent", respAbsentCreate.StatusCode, rawAbsentCreate)
	}

	// Create a new vault for Alice -> receives a brand-new vault_key_id.
	vfA2 := createVaultForUser(t, h, jarA, 0x40)
	if vfA2.VaultKeyID == vfA1.VaultKeyID {
		t.Fatalf("new vault received same vault_key_id %q as deleted vault", vfA2.VaultKeyID)
	}

	// POST /items/{id}/entries carrying the old key_id -> 409 entry_key_mismatch.
	staleEntryID2 := uuid.NewString()
	sealedStale2 := sealEntryFixture(t, staleEntryID2, vfA1.VaultKeyID, vfA1.VK, []byte("stale key_id after vault recreate"), seqBytes(vault.WrapNonceBytes, 0x32))
	respStaleKeyCreate, rawStaleKeyCreate := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA1.ID.String()+"/entries",
		makeCreateBody(staleEntryID2, entry.TypeText, sealedStale2.EnvelopeRaw, sealedStale2.CiphertextB64, sealedStale2.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t8_alice_create_with_old_key_id"})
	if respStaleKeyCreate.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, rawStaleKeyCreate).Code != "entry_key_mismatch" {
		t.Fatalf("POST entry with old key_id after new vault = %d %s, want 409 entry_key_mismatch", respStaleKeyCreate.StatusCode, rawStaleKeyCreate)
	}

	// POST /items/{id}/entries/import-json carrying the old key_id -> 409 entry_key_mismatch.
	staleImportID := uuid.NewString()
	sealedStaleImport := sealEntryFixture(t, staleImportID, vfA1.VaultKeyID, vfA1.VK, []byte(`{"stale":true}`), seqBytes(vault.WrapNonceBytes, 0x33))
	staleImportBody := fmt.Sprintf(
		`{"id":%q,"type":"json","source":"file","envelope":%s,"ciphertext":%q,"plaintext_len_bucket":%d}`,
		staleImportID, sealedStaleImport.EnvelopeRaw, sealedStaleImport.CiphertextB64, sealedStaleImport.PlaintextLenBucket,
	)
	respStaleImport, rawStaleImport := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA1.ID.String()+"/entries/import-json",
		staleImportBody, contenttest.ReqOptions{IdemKey: "idem_t8_alice_import_with_old_key_id"})
	if respStaleImport.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, rawStaleImport).Code != "entry_key_mismatch" {
		t.Fatalf("POST import-json with old key_id after new vault = %d %s, want 409 entry_key_mismatch", respStaleImport.StatusCode, rawStaleImport)
	}

	totalAfterStale, _, _ := countEntriesForUser(t, ctx, h, meA.User.ID)
	if totalAfterStale != 0 {
		t.Fatalf("Alice entries after stale key_id rejections = %d, want 0", totalAfterStale)
	}

	// Creating a new entry on existing itemA1 with the NEW vault_key_id succeeds with 201 Created and position 0.
	freshEntryID := uuid.NewString()
	sealedFresh := sealEntryFixture(t, freshEntryID, vfA2.VaultKeyID, vfA2.VK, []byte("fresh entry under new vault key"), seqBytes(vault.WrapNonceBytes, 0x34))
	respFresh, rawFresh := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA1.ID.String()+"/entries",
		makeCreateBody(freshEntryID, entry.TypeText, sealedFresh.EnvelopeRaw, sealedFresh.CiphertextB64, sealedFresh.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t8_alice_create_with_new_key_id"})
	if respFresh.StatusCode != http.StatusCreated {
		t.Fatalf("POST entry with new key_id = %d %s, want 201", respFresh.StatusCode, rawFresh)
	}
	var freshMeta entry.Meta
	if err := json.Unmarshal([]byte(rawFresh), &freshMeta); err != nil {
		t.Fatal(err)
	}
	if freshMeta.Position != 0 || freshMeta.Version != 1 {
		t.Fatalf("fresh entry after reset meta = %+v, want pos=0 version=1", freshMeta)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// -------------------------------------------------------------------------
	// 4. Verify User B's vault, items, tags, item_tag links, and entries (live + tombstone)
	//    are completely untouched by User A's reset (P04-A9 server side).
	// -------------------------------------------------------------------------
	vaultRowB, err := q.GetVaultByUser(ctx, meB.User.ID)
	if err != nil || vaultRowB.VaultKeyID != vfB.VaultKeyID {
		t.Fatalf("Bob vault after Alice reset = (%+v, %v), want key_id %s", vaultRowB, err, vfB.VaultKeyID)
	}
	totalB, liveB, tombB := countEntriesForUser(t, ctx, h, meB.User.ID)
	if totalB != 2 || liveB != 1 || tombB != 1 {
		t.Fatalf("Bob entries after Alice reset = (%d, %d, %d), want (2, 1, 1)", totalB, liveB, tombB)
	}
	gotItemB1, err := q.GetItemByUserAndID(ctx, gen.GetItemByUserAndIDParams{UserID: meB.User.ID, ID: itemB1.ID})
	if err != nil || gotItemB1.EntryCount != 1 || gotItemB1.DeletedAt.Valid {
		t.Fatalf("Bob itemB1 after Alice reset = (%+v, %v), want live with entry_count=1", gotItemB1, err)
	}
	gotTagB1, err := q.GetTagByUserAndID(ctx, gen.GetTagByUserAndIDParams{UserID: meB.User.ID, ID: tagB1.ID})
	if err != nil || gotTagB1.ItemCount != 1 || gotTagB1.DeletedAt.Valid {
		t.Fatalf("Bob tagB1 after Alice reset = (%+v, %v), want live with item_count=1", gotTagB1, err)
	}

	respGetB, rawGetB := h.DoReq(jarB, http.MethodGet, "/api/v1/entries/"+entryB1LiveID, "", contenttest.ReqOptions{})
	if respGetB.StatusCode != http.StatusOK {
		t.Fatalf("Bob GET live entry = %d %s, want 200", respGetB.StatusCode, rawGetB)
	}
	var gotEntryB struct {
		ID         string          `json:"id"`
		Envelope   json.RawMessage `json:"envelope"`
		Ciphertext string          `json:"ciphertext"`
	}
	if err := json.Unmarshal([]byte(rawGetB), &gotEntryB); err != nil {
		t.Fatal(err)
	}
	_, openedB, err := vault.OpenEntryBase64URL(gotEntryB.Envelope, gotEntryB.ID, gotEntryB.Ciphertext, vfB.VK)
	if err != nil || !bytes.Equal(openedB, plaintextBLive) {
		t.Fatalf("Bob OpenEntry after Alice reset failed: err=%v plain=%q", err, openedB)
	}
	contenttest.AssertInvariants(t, h.Pool, meB.User.ID)
}

// TestVaultResetRacingPostEntriesBarrier covers Task 8 bullet 3 (and P04-A9):
//   - POST /api/v1/items/{id}/entries racing DELETE /api/v1/vault with a deterministic barrier:
//     the reset transaction locks the vault row FOR UPDATE, captures its backend PID via pg_backend_pid(),
//     and pauses inside ResetHook; while reset holds FOR UPDATE, the concurrent POST entries transaction
//     attempts SELECT vault_key_id FROM vault FOR SHARE and blocks on the vault row lock (observed via
//     pg_stat_activity + pg_blocking_pids + ungranted transactionid lock in pg_locks with a granted
//     RowShareLock on vault::regclass, scoped to current_database() and the reset holder PID — no sleep races).
//   - Once reset is released and commits, the unblocked POST entries returns 404 vault_absent (or 409
//     entry_key_mismatch), and never creates an entry row; 0 entries exist and AssertInvariants passes.
func TestVaultResetRacingPostEntriesBarrier(t *testing.T) {
	var (
		mu             sync.Mutex
		barrierActive  bool
		resetEntered   = make(chan int32, 1)
		releaseReset   = make(chan struct{})
		closeResetOnce sync.Once
	)
	closeRelease := func() {
		closeResetOnce.Do(func() { close(releaseReset) })
	}

	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	t.Cleanup(closeRelease)

	h.VaultSvc.SetResetHook(func(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
		mu.Lock()
		active := barrierActive
		mu.Unlock()
		if active {
			var holdPID int32
			if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&holdPID); err != nil {
				return fmt.Errorf("query reset backend pid: %w", err)
			}
			select {
			case resetEntered <- holdPID:
			default:
			}
			select {
			case <-releaseReset:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return entry.ResetHook(ctx, tx, userID)
	})

	password := "correct-horse-battery-staple-a"
	jarA, meA := h.SignupUser("reset-race-post@example.com", password)
	vf1 := createVaultForUser(t, h, jarA, 0x20)
	item := insertTestItem(t, h, meA.User.ID, "Race Target Item")

	ctx := context.Background()

	// Seed 1 existing entry before the race so we verify reset deletes existing entries while blocking the new one.
	seedEntryID := uuid.NewString()
	sealedSeed := sealEntryFixture(t, seedEntryID, vf1.VaultKeyID, vf1.VK, []byte("pre-existing entry"), seqBytes(vault.WrapNonceBytes, 0x21))
	respSeed, rawSeed := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
		makeCreateBody(seedEntryID, entry.TypeText, sealedSeed.EnvelopeRaw, sealedSeed.CiphertextB64, sealedSeed.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t8_race_post_seed_01"})
	if respSeed.StatusCode != http.StatusCreated {
		t.Fatalf("seed entry = %d %s", respSeed.StatusCode, rawSeed)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	grantReset := issueReauthGrant(t, h, jarA, "vault.reset", password)
	ifMatch1 := formatVaultIfMatch(vf1.VaultKeyID, vf1.Version)

	mu.Lock()
	barrierActive = true
	mu.Unlock()

	type httpRes struct {
		resp contenttest.TestResponse
		raw  string
	}
	resetDone := make(chan httpRes, 1)
	postDone := make(chan httpRes, 1)
	earlyPostDone := make(chan struct{}, 1)
	var earlyPostRes httpRes

	// Start DELETE /api/v1/vault -> acquires vault FOR UPDATE and pauses at the start of ResetHook.
	go func() {
		resp, raw := h.DoReq(jarA, http.MethodDelete, "/api/v1/vault", "", contenttest.ReqOptions{
			IdemKey: "idem_t8_race_post_reset_01",
			IfMatch: ifMatch1,
			Grant:   grantReset,
		})
		resetDone <- httpRes{resp: resp, raw: raw}
	}()

	var resetHoldPID int32
	select {
	case resetHoldPID = <-resetEntered:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for DELETE /vault to enter ResetHook while holding vault FOR UPDATE")
	}

	// Start concurrent POST /api/v1/items/{id}/entries sealed with vf1.VaultKeyID.
	raceEntryID := uuid.NewString()
	sealedRace := sealEntryFixture(t, raceEntryID, vf1.VaultKeyID, vf1.VK, []byte("in-flight stale entry"), seqBytes(vault.WrapNonceBytes, 0x22))
	raceBody := makeCreateBody(raceEntryID, entry.TypeText, sealedRace.EnvelopeRaw, sealedRace.CiphertextB64, sealedRace.PlaintextLenBucket)

	go func() {
		resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries", raceBody, contenttest.ReqOptions{
			IdemKey: "idem_t8_race_post_create_01",
		})
		res := httpRes{resp: resp, raw: raw}
		earlyPostRes = res
		postDone <- res
		close(earlyPostDone)
	}()

	// Observe via pg_stat_activity + pg_blocking_pids + pg_locks that the POST entries backend
	// is blocked by resetHoldPID on an ungranted transactionid lock while holding RowShareLock on vault.
	waitForPostEntriesVaultRowLockWaiter(t, ctx, h, resetHoldPID, earlyPostDone, func() string {
		return fmt.Sprintf("status=%d body=%s", earlyPostRes.resp.StatusCode, earlyPostRes.raw)
	})

	// Release the reset barrier so ResetHook runs and DELETE /vault commits.
	mu.Lock()
	barrierActive = false
	mu.Unlock()
	closeRelease()

	var rReset, rPost httpRes
	select {
	case rReset = <-resetDone:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for DELETE /vault to finish")
	}
	select {
	case rPost = <-postDone:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for racing POST entries to finish")
	}

	if rReset.resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /vault = %d %s, want 204", rReset.resp.StatusCode, rReset.raw)
	}

	// The racing POST entries must return 404 vault_absent or 409 entry_key_mismatch, NEVER 201 Created.
	switch rPost.resp.StatusCode {
	case http.StatusNotFound:
		if code := contenttest.DecodeProblem(t, rPost.raw).Code; code != "vault_absent" {
			t.Fatalf("racing POST entries 404 code = %q, want vault_absent (%s)", code, rPost.raw)
		}
	case http.StatusConflict:
		if code := contenttest.DecodeProblem(t, rPost.raw).Code; code != "entry_key_mismatch" {
			t.Fatalf("racing POST entries 409 code = %q, want entry_key_mismatch (%s)", code, rPost.raw)
		}
	default:
		t.Fatalf("racing POST entries = %d %s, want 404 vault_absent or 409 entry_key_mismatch", rPost.resp.StatusCode, rPost.raw)
	}

	// Verify 0 entries remain in DB and item invariants hold.
	totalEntries, _, _ := countEntriesForUser(t, ctx, h, meA.User.ID)
	if totalEntries != 0 {
		t.Fatalf("total entries after reset racing POST entries = %d, want 0", totalEntries)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
}

// TestVaultResetRacingItemDeleteRestoreAndPurgeBarriers covers Task 8 bullet 4 (and P04-A2, P04-A9):
//   - Reset racing item delete, item restore, and content purge (`PurgeExpiredContent` with an explicit cutoff),
//     exercising deterministic barriers at each lock step of both sides:
//   - Order 1 (Reset holds LockUserContent first — paused at each ResetHookStep:
//     after_user_content_lock, after_items_locked, after_entries_deleted, after_counts_zeroed —
//     while item delete, item restore, or purge waits on LockUserContent in pg_locks).
//   - Order 2 (Item delete, item restore, or purge holds LockUserContent first — paused at each lock step:
//     after_user_content_lock, after_item_lock, after_tags_lock, after_entries_lock for item ops;
//     WithPurgeLockHeldHook for purge — while reset holds vault FOR UPDATE and waits on LockUserContent in pg_locks).
//   - Verifies: no deadlock (both operations succeed without 40P01/55P03), the resulting database state
//     equals the exact state of the corresponding serial execution order, and contenttest.AssertInvariants passes.
func TestVaultResetRacingItemDeleteRestoreAndPurgeBarriers(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{
		ResetHook: entry.ResetHook,
	})
	password := "correct-horse-battery-staple-a"
	jarA, meA := h.SignupUser("reset-race-matrix@example.com", password)
	ctx := context.Background()
	q := gen.New(h.Pool)
	sessionIssuedAt := h.Clock.Now()
	sessionCookie := jarA[authhttp.CookieSession]
	if sessionCookie == nil || sessionCookie.Value == "" {
		t.Fatal("missing initial sabk_session cookie")
	}
	principalA, err := h.AuthSvc.Sessions().Authenticate(ctx, sessionCookie.Value)
	if err != nil {
		t.Fatalf("Authenticate initial session: %v", err)
	}

	// prepareReset advances the harness clock by 61s (clearing the 1-minute vault_sensitive 10/min sliding window),
	// refreshes the session before crossing auth.AccessTTL (10m) using a 2m safety margin (refreshing at >= 8m:
	// scenarios 8, 16, and 24 -> 3 refreshes + 1 initial signup = 4 calls total against authhttp.credLimit's
	// 5/min wall-clock IP limiter across all 24 sub-scenarios), sets the ResetHook, and issues a signed reauth grant.
	const refreshSafetyMargin = 2 * time.Minute
	const refreshAfter = auth.AccessTTL - refreshSafetyMargin // 8m (< 10m auth.AccessTTL; 30d auth.SessionTTL)
	prepareReset := func(t *testing.T, hook vault.ResetHook) string {
		t.Helper()
		h.Clock.Advance(61 * time.Second) // clear 1-minute vault_sensitive (10/min) sliding window
		if h.Clock.Now().Sub(sessionIssuedAt) >= refreshAfter {
			h.RefreshSession(jarA)
			sessionIssuedAt = h.Clock.Now()
		}
		h.VaultSvc.SetResetHook(hook)
		t.Cleanup(func() {
			h.VaultSvc.SetResetHook(entry.ResetHook)
		})
		grant, err := h.AuthSvc.Grants().Issue(principalA, "vault.reset")
		if err != nil {
			t.Fatalf("Grants.Issue(vault.reset): %v", err)
		}
		return grant.Grant
	}

	// runReset executes DELETE /api/v1/vault using a cancellable worker context and returns a result/error
	// to the owning test rather than calling fatal assertions from inside its worker goroutine.
	runReset := func(wCtx context.Context, vf vaultFixture, idemKey, grant string) error {
		resp, raw, err := doDeleteVaultCtx(
			wCtx,
			h,
			jarA,
			idemKey,
			formatVaultIfMatch(vf.VaultKeyID, vf.Version),
			grant,
		)
		if err != nil {
			return fmt.Errorf("DELETE /vault (%s): %w", idemKey, err)
		}
		if resp.StatusCode != http.StatusNoContent || raw != "" {
			return fmt.Errorf("DELETE /vault (%s) = %d %q, want 204 empty", idemKey, resp.StatusCode, raw)
		}
		return nil
	}

	type barrierWorker struct {
		errCh    chan error
		doneCh   chan struct{}
		mu       sync.Mutex
		launched bool
		joined   bool
	}
	startBarrierWorker := func(w *barrierWorker, fn func() error) {
		w.mu.Lock()
		w.launched = true
		w.mu.Unlock()
		go func() {
			w.errCh <- fn()
		}()
	}

	// setupBarrierScenario registers an idempotent barrier release, worker-context cancellation, and bounded
	// worker-channel joins on subtest t.Cleanup immediately after creation (before launching workers), so that
	// any error/timeout path releases and joins launched workers before the parent harness closes httptest.Server.
	// Unlaunched workers are skipped, bounded-join timeouts fail the test via t.Errorf, and completed joins
	// close w.doneCh and set w.joined = true for positive completion verification.
	setupBarrierScenario := func(t *testing.T) (
		wCtx context.Context,
		stepReached chan struct{},
		releaseStep chan struct{},
		closeRel func(),
		op1 *barrierWorker,
		op2 *barrierWorker,
		awaitWorker func(desc string, w *barrierWorker),
	) {
		t.Helper()
		wCtx, cancelWorkers := context.WithCancel(ctx)
		stepReached = make(chan struct{}, 1)
		releaseStep = make(chan struct{})
		var closeOnce sync.Once
		closeRel = func() { closeOnce.Do(func() { close(releaseStep) }) }
		op1 = &barrierWorker{errCh: make(chan error, 1), doneCh: make(chan struct{})}
		op2 = &barrierWorker{errCh: make(chan error, 1), doneCh: make(chan struct{})}

		joinDuringCleanup := func(label string, w *barrierWorker) {
			w.mu.Lock()
			needJoin := w.launched && !w.joined
			w.mu.Unlock()
			if !needJoin {
				return
			}
			select {
			case <-w.errCh:
				w.mu.Lock()
				if !w.joined {
					w.joined = true
					close(w.doneCh)
				}
				w.mu.Unlock()
			case <-time.After(5 * time.Second):
				t.Errorf("cleanup timed out waiting 5s to join launched worker %s", label)
			}
		}

		t.Cleanup(func() {
			closeRel()
			cancelWorkers()
			joinDuringCleanup("op1", op1)
			joinDuringCleanup("op2", op2)
		})

		awaitWorker = func(desc string, w *barrierWorker) {
			t.Helper()
			w.mu.Lock()
			launched := w.launched
			w.mu.Unlock()
			if !launched {
				t.Fatalf("awaitWorker(%s) called before worker was launched", desc)
			}
			select {
			case err := <-w.errCh:
				w.mu.Lock()
				if !w.joined {
					w.joined = true
					close(w.doneCh)
				}
				w.mu.Unlock()
				if err != nil {
					t.Fatalf("%s: %v", desc, err)
				}
			case <-time.After(10 * time.Second):
				t.Fatalf("timed out waiting for %s", desc)
			}
		}
		return wCtx, stepReached, releaseStep, closeRel, op1, op2, awaitWorker
	}
	resetSteps := []entry.ResetHookStep{
		entry.ResetHookStepAfterUserContentLock,
		entry.ResetHookStepAfterItemsLocked,
		entry.ResetHookStepAfterEntriesDeleted,
		entry.ResetHookStepAfterCountsZeroed,
	}

	// =========================================================================
	// Group 1: Reset racing Item Soft-Delete
	// =========================================================================
	// 1A. Reset acquires LockUserContent first (testing barrier at every ResetHookStep) -> Item Delete waits on LockUserContent.
	// Serial equivalence: Reset then Item Delete -> item is soft-deleted (entry_count=0), tag.item_count=0, 0 entries in DB.
	for idx, pauseStep := range resetSteps {
		t.Run("ResetFirst_ItemDelete/"+string(pauseStep), func(t *testing.T) {
			vf := createVaultForUser(t, h, jarA, byte(0x10+idx))
			item := insertTestItem(t, h, meA.User.ID, fmt.Sprintf("ResetFirst-DelItem-%d", idx))
			tag := insertTestTagForReset(t, ctx, q, meA.User.ID, fmt.Sprintf("rf-del-tag-%d", idx))
			assignTestTagToLiveItem(t, ctx, q, h.Clock.Now(), meA.User.ID, item.ID, tag.ID)

			entryID := uuid.NewString()
			sealed := sealEntryFixture(t, entryID, vf.VaultKeyID, vf.VK, []byte("entry before reset+delete"), seqBytes(vault.WrapNonceBytes, byte(0x20+idx)))
			respC, rawC := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
				makeCreateBody(entryID, entry.TypeText, sealed.EnvelopeRaw, sealed.CiphertextB64, sealed.PlaintextLenBucket),
				contenttest.ReqOptions{IdemKey: fmt.Sprintf("idem_t8_rf_del_seed_%d", idx)})
			if respC.StatusCode != http.StatusCreated {
				t.Fatalf("seed entry = %d %s", respC.StatusCode, rawC)
			}

			wCtx, stepReached, releaseStep, closeRel, resetW, delW, awaitWorker := setupBarrierScenario(t)

			hook := func(hCtx context.Context, tx pgx.Tx, uid uuid.UUID) error {
				cbCtx := entry.WithResetHookStepCallback(hCtx, func(cbCtx context.Context, _ uuid.UUID, step entry.ResetHookStep) error {
					if step == pauseStep {
						select {
						case stepReached <- struct{}{}:
						default:
						}
						select {
						case <-releaseStep:
						case <-cbCtx.Done():
							return cbCtx.Err()
						}
						select {
						case <-wCtx.Done():
							return wCtx.Err()
						default:
						}
					}
					return nil
				})
				return entry.ResetHook(cbCtx, tx, uid)
			}
			grant := prepareReset(t, hook)

			startBarrierWorker(resetW, func() error {
				return runReset(wCtx, vf, fmt.Sprintf("idem_t8_rf_del_reset_%d", idx), grant)
			})

			select {
			case <-stepReached:
			case <-time.After(10 * time.Second):
				t.Fatalf("timed out waiting for ResetHook step %s", pauseStep)
			}

			startBarrierWorker(delW, func() error {
				return softDeleteItemInTx(wCtx, h, meA.User.ID, item.ID, nil)
			})

			waitForPgLocksCondition(t, 10*time.Second, fmt.Sprintf("item delete waiting on LockUserContent at reset step %s", pauseStep), func() bool {
				return hasAdvisoryContentLockWaiter(ctx, h, meA.User.ID)
			})

			closeRel()

			awaitWorker(fmt.Sprintf("reset (%s)", pauseStep), resetW)
			awaitWorker(fmt.Sprintf("softDeleteItemInTx after reset (%s)", pauseStep), delW)

			// Serial result (Reset -> Item Delete): 0 entries, item is soft-deleted with entry_count=0, tag.item_count=0.
			totalE, _, _ := countEntriesForUser(t, ctx, h, meA.User.ID)
			if totalE != 0 {
				t.Fatalf("entries after Reset->ItemDelete (step %s) = %d, want 0", pauseStep, totalE)
			}
			gotItem, err := q.GetItemByUserAndID(ctx, gen.GetItemByUserAndIDParams{UserID: meA.User.ID, ID: item.ID})
			if err != nil || !gotItem.DeletedAt.Valid || gotItem.EntryCount != 0 {
				t.Fatalf("item after Reset->ItemDelete (step %s) = (%+v, %v), want deleted with entry_count=0", pauseStep, gotItem, err)
			}
			gotTag, err := q.GetTagByUserAndID(ctx, gen.GetTagByUserAndIDParams{UserID: meA.User.ID, ID: tag.ID})
			if err != nil || gotTag.ItemCount != 0 {
				t.Fatalf("tag after Reset->ItemDelete (step %s) = (%+v, %v), want item_count=0", pauseStep, gotTag, err)
			}
			contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

			// Clean up soft-deleted item & tag so next iteration starts clean.
			if _, err := h.Pool.Exec(ctx, `DELETE FROM item WHERE id = $1`, item.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := h.Pool.Exec(ctx, `DELETE FROM tag WHERE id = $1`, tag.ID); err != nil {
				t.Fatal(err)
			}
		})
	}

	// 1B. Item Delete acquires LockUserContent first (testing barrier at every item-delete lock step) -> Reset waits on LockUserContent.
	// Serial equivalence: Item Delete then Reset -> item is soft-deleted (entry_count=0), tag.item_count=0,
	// and Reset hard-deletes the item-deleted tombstone entry so 0 entries remain in DB.
	itemDeleteSteps := []string{
		"after_user_content_lock",
		"after_item_lock",
		"after_tags_lock",
		"after_entries_lock",
	}
	for idx, pauseStep := range itemDeleteSteps {
		t.Run("ItemDeleteFirst/"+pauseStep, func(t *testing.T) {
			vf := createVaultForUser(t, h, jarA, byte(0x30+idx))
			item := insertTestItem(t, h, meA.User.ID, fmt.Sprintf("DelFirst-Item-%d", idx))
			tag := insertTestTagForReset(t, ctx, q, meA.User.ID, fmt.Sprintf("df-del-tag-%d", idx))
			assignTestTagToLiveItem(t, ctx, q, h.Clock.Now(), meA.User.ID, item.ID, tag.ID)

			entryID := uuid.NewString()
			sealed := sealEntryFixture(t, entryID, vf.VaultKeyID, vf.VK, []byte("entry before delete+reset"), seqBytes(vault.WrapNonceBytes, byte(0x40+idx)))
			respC, rawC := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
				makeCreateBody(entryID, entry.TypeText, sealed.EnvelopeRaw, sealed.CiphertextB64, sealed.PlaintextLenBucket),
				contenttest.ReqOptions{IdemKey: fmt.Sprintf("idem_t8_df_del_seed_%d", idx)})
			if respC.StatusCode != http.StatusCreated {
				t.Fatalf("seed entry = %d %s", respC.StatusCode, rawC)
			}

			wCtx, stepReached, releaseStep, closeRel, delW, resetW, awaitWorker := setupBarrierScenario(t)
			grant := prepareReset(t, entry.ResetHook)

			startBarrierWorker(delW, func() error {
				return softDeleteItemInTx(wCtx, h, meA.User.ID, item.ID, func(sCtx context.Context, step string) error {
					if step == pauseStep {
						select {
						case stepReached <- struct{}{}:
						default:
						}
						select {
						case <-releaseStep:
						case <-sCtx.Done():
							return sCtx.Err()
						}
					}
					return nil
				})
			})

			select {
			case <-stepReached:
			case <-time.After(10 * time.Second):
				t.Fatalf("timed out waiting for item delete step %s", pauseStep)
			}

			startBarrierWorker(resetW, func() error {
				return runReset(wCtx, vf, fmt.Sprintf("idem_t8_df_del_reset_%d", idx), grant)
			})

			waitForPgLocksCondition(t, 10*time.Second, fmt.Sprintf("reset waiting on LockUserContent while item delete paused at %s", pauseStep), func() bool {
				return hasAdvisoryContentLockWaiter(ctx, h, meA.User.ID)
			})

			closeRel()

			awaitWorker(fmt.Sprintf("softDeleteItemInTx (%s)", pauseStep), delW)
			awaitWorker(fmt.Sprintf("reset after item delete (%s)", pauseStep), resetW)

			// Serial result (Item Delete -> Reset): item is soft-deleted (entry_count=0), tag.item_count=0, 0 entries in DB.
			totalE, _, _ := countEntriesForUser(t, ctx, h, meA.User.ID)
			if totalE != 0 {
				t.Fatalf("entries after ItemDelete->Reset (step %s) = %d, want 0", pauseStep, totalE)
			}
			gotItem, err := q.GetItemByUserAndID(ctx, gen.GetItemByUserAndIDParams{UserID: meA.User.ID, ID: item.ID})
			if err != nil || !gotItem.DeletedAt.Valid || gotItem.EntryCount != 0 {
				t.Fatalf("item after ItemDelete->Reset (step %s) = (%+v, %v), want deleted with entry_count=0", pauseStep, gotItem, err)
			}
			gotTag, err := q.GetTagByUserAndID(ctx, gen.GetTagByUserAndIDParams{UserID: meA.User.ID, ID: tag.ID})
			if err != nil || gotTag.ItemCount != 0 {
				t.Fatalf("tag after ItemDelete->Reset (step %s) = (%+v, %v), want item_count=0", pauseStep, gotTag, err)
			}
			contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

			if _, err := h.Pool.Exec(ctx, `DELETE FROM item WHERE id = $1`, item.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := h.Pool.Exec(ctx, `DELETE FROM tag WHERE id = $1`, tag.ID); err != nil {
				t.Fatal(err)
			}
		})
	}

	// =========================================================================
	// Group 2: Reset racing Item Restore
	// =========================================================================
	// Both serial orders (Reset -> Item Restore, and Item Restore -> Reset) must produce the exact same state:
	// - In Reset -> Item Restore: Reset hard-deletes the item-deleted tombstone entries first; then Item Restore
	//   restores the item with restoredRows = 0 (entry_count = 0) and increments tag.item_count = 1.
	// - In Item Restore -> Reset: Item Restore restores the item and its batch entries (entry_count = 1, tag.item_count = 1);
	//   then Reset hard-deletes all entries and zeroes item.entry_count = 0 while keeping the restored item live and tag.item_count = 1.
	// 2A. Reset acquires LockUserContent first (testing barrier at every ResetHookStep) -> Item Restore waits on LockUserContent.
	for idx, pauseStep := range resetSteps {
		t.Run("ResetFirst_ItemRestore/"+string(pauseStep), func(t *testing.T) {
			vf := createVaultForUser(t, h, jarA, byte(0x50+idx))
			item := insertTestItem(t, h, meA.User.ID, fmt.Sprintf("ResetFirst-RestoreItem-%d", idx))
			tag := insertTestTagForReset(t, ctx, q, meA.User.ID, fmt.Sprintf("rf-restore-tag-%d", idx))
			assignTestTagToLiveItem(t, ctx, q, h.Clock.Now(), meA.User.ID, item.ID, tag.ID)

			entryID := uuid.NewString()
			sealed := sealEntryFixture(t, entryID, vf.VaultKeyID, vf.VK, []byte("entry in deleted item"), seqBytes(vault.WrapNonceBytes, byte(0x60+idx)))
			respC, rawC := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
				makeCreateBody(entryID, entry.TypeText, sealed.EnvelopeRaw, sealed.CiphertextB64, sealed.PlaintextLenBucket),
				contenttest.ReqOptions{IdemKey: fmt.Sprintf("idem_t8_rf_rest_seed_%d", idx)})
			if respC.StatusCode != http.StatusCreated {
				t.Fatalf("seed entry = %d %s", respC.StatusCode, rawC)
			}
			if err := softDeleteItemInTx(ctx, h, meA.User.ID, item.ID, nil); err != nil {
				t.Fatal(err)
			}

			wCtx, stepReached, releaseStep, closeRel, resetW, restW, awaitWorker := setupBarrierScenario(t)

			hook := func(hCtx context.Context, tx pgx.Tx, uid uuid.UUID) error {
				cbCtx := entry.WithResetHookStepCallback(hCtx, func(cbCtx context.Context, _ uuid.UUID, step entry.ResetHookStep) error {
					if step == pauseStep {
						select {
						case stepReached <- struct{}{}:
						default:
						}
						select {
						case <-releaseStep:
						case <-cbCtx.Done():
							return cbCtx.Err()
						}
						select {
						case <-wCtx.Done():
							return wCtx.Err()
						default:
						}
					}
					return nil
				})
				return entry.ResetHook(cbCtx, tx, uid)
			}
			grant := prepareReset(t, hook)

			startBarrierWorker(resetW, func() error {
				return runReset(wCtx, vf, fmt.Sprintf("idem_t8_rf_rest_reset_%d", idx), grant)
			})

			select {
			case <-stepReached:
			case <-time.After(10 * time.Second):
				t.Fatalf("timed out waiting for ResetHook step %s", pauseStep)
			}

			startBarrierWorker(restW, func() error {
				return restoreItemInTx(wCtx, h, meA.User.ID, item.ID, nil)
			})

			waitForPgLocksCondition(t, 10*time.Second, fmt.Sprintf("item restore waiting on LockUserContent at reset step %s", pauseStep), func() bool {
				return hasAdvisoryContentLockWaiter(ctx, h, meA.User.ID)
			})

			closeRel()

			awaitWorker(fmt.Sprintf("reset (%s)", pauseStep), resetW)
			awaitWorker(fmt.Sprintf("restoreItemInTx after reset (%s)", pauseStep), restW)

			totalE, _, _ := countEntriesForUser(t, ctx, h, meA.User.ID)
			if totalE != 0 {
				t.Fatalf("entries after Reset->ItemRestore (step %s) = %d, want 0", pauseStep, totalE)
			}
			gotItem, err := q.GetItemByUserAndID(ctx, gen.GetItemByUserAndIDParams{UserID: meA.User.ID, ID: item.ID})
			if err != nil || gotItem.DeletedAt.Valid || gotItem.EntryCount != 0 {
				t.Fatalf("item after Reset->ItemRestore (step %s) = (%+v, %v), want live with entry_count=0", pauseStep, gotItem, err)
			}
			gotTag, err := q.GetTagByUserAndID(ctx, gen.GetTagByUserAndIDParams{UserID: meA.User.ID, ID: tag.ID})
			if err != nil || gotTag.ItemCount != 1 {
				t.Fatalf("tag after Reset->ItemRestore (step %s) = (%+v, %v), want item_count=1", pauseStep, gotTag, err)
			}
			contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

			if _, err := h.Pool.Exec(ctx, `DELETE FROM item WHERE id = $1`, item.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := h.Pool.Exec(ctx, `DELETE FROM tag WHERE id = $1`, tag.ID); err != nil {
				t.Fatal(err)
			}
		})
	}

	// 2B. Item Restore acquires LockUserContent first (testing barrier at every item-restore lock step) -> Reset waits on LockUserContent.
	itemRestoreSteps := []string{
		"after_user_content_lock",
		"after_item_lock",
		"after_tags_lock",
	}
	for idx, pauseStep := range itemRestoreSteps {
		t.Run("ItemRestoreFirst/"+pauseStep, func(t *testing.T) {
			vf := createVaultForUser(t, h, jarA, byte(0x70+idx))
			item := insertTestItem(t, h, meA.User.ID, fmt.Sprintf("RestoreFirst-Item-%d", idx))
			tag := insertTestTagForReset(t, ctx, q, meA.User.ID, fmt.Sprintf("rf2-restore-tag-%d", idx))
			assignTestTagToLiveItem(t, ctx, q, h.Clock.Now(), meA.User.ID, item.ID, tag.ID)

			entryID := uuid.NewString()
			sealed := sealEntryFixture(t, entryID, vf.VaultKeyID, vf.VK, []byte("entry in deleted item 2"), seqBytes(vault.WrapNonceBytes, byte(0x80+idx)))
			respC, rawC := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
				makeCreateBody(entryID, entry.TypeText, sealed.EnvelopeRaw, sealed.CiphertextB64, sealed.PlaintextLenBucket),
				contenttest.ReqOptions{IdemKey: fmt.Sprintf("idem_t8_restf_seed_%d", idx)})
			if respC.StatusCode != http.StatusCreated {
				t.Fatalf("seed entry = %d %s", respC.StatusCode, rawC)
			}
			if err := softDeleteItemInTx(ctx, h, meA.User.ID, item.ID, nil); err != nil {
				t.Fatal(err)
			}

			wCtx, stepReached, releaseStep, closeRel, restW, resetW, awaitWorker := setupBarrierScenario(t)
			grant := prepareReset(t, entry.ResetHook)

			startBarrierWorker(restW, func() error {
				return restoreItemInTx(wCtx, h, meA.User.ID, item.ID, func(sCtx context.Context, step string) error {
					if step == pauseStep {
						select {
						case stepReached <- struct{}{}:
						default:
						}
						select {
						case <-releaseStep:
						case <-sCtx.Done():
							return sCtx.Err()
						}
					}
					return nil
				})
			})

			select {
			case <-stepReached:
			case <-time.After(10 * time.Second):
				t.Fatalf("timed out waiting for item restore step %s", pauseStep)
			}

			startBarrierWorker(resetW, func() error {
				return runReset(wCtx, vf, fmt.Sprintf("idem_t8_restf_reset_%d", idx), grant)
			})

			waitForPgLocksCondition(t, 10*time.Second, fmt.Sprintf("reset waiting on LockUserContent while item restore paused at %s", pauseStep), func() bool {
				return hasAdvisoryContentLockWaiter(ctx, h, meA.User.ID)
			})

			closeRel()

			awaitWorker(fmt.Sprintf("restoreItemInTx (%s)", pauseStep), restW)
			awaitWorker(fmt.Sprintf("reset after item restore (%s)", pauseStep), resetW)

			totalE, _, _ := countEntriesForUser(t, ctx, h, meA.User.ID)
			if totalE != 0 {
				t.Fatalf("entries after ItemRestore->Reset (step %s) = %d, want 0", pauseStep, totalE)
			}
			gotItem, err := q.GetItemByUserAndID(ctx, gen.GetItemByUserAndIDParams{UserID: meA.User.ID, ID: item.ID})
			if err != nil || gotItem.DeletedAt.Valid || gotItem.EntryCount != 0 {
				t.Fatalf("item after ItemRestore->Reset (step %s) = (%+v, %v), want live with entry_count=0", pauseStep, gotItem, err)
			}
			gotTag, err := q.GetTagByUserAndID(ctx, gen.GetTagByUserAndIDParams{UserID: meA.User.ID, ID: tag.ID})
			if err != nil || gotTag.ItemCount != 1 {
				t.Fatalf("tag after ItemRestore->Reset (step %s) = (%+v, %v), want item_count=1", pauseStep, gotTag, err)
			}
			contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

			if _, err := h.Pool.Exec(ctx, `DELETE FROM item WHERE id = $1`, item.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := h.Pool.Exec(ctx, `DELETE FROM tag WHERE id = $1`, tag.ID); err != nil {
				t.Fatal(err)
			}
		})
	}

	// =========================================================================
	// Group 3: Reset racing Purge (`entry.PurgeExpiredContent` with explicit cutoff)
	// =========================================================================
	// In each scenario we seed:
	// - liveItem with 1 live entry + 1 expired entry tombstone (deleted 35d ago) + 1 recent entry tombstone (deleted 10d ago)
	// - expiredItem (deleted 35d ago) with 1 expired item-deleted entry (deleted 35d ago)
	// - expiredTag (deleted 35d ago, linked to liveItem) + liveTag (linked to liveItem)
	// Regardless of whether Reset or Purge runs first:
	// - All entries of the user (live, recent 10d tombstone, expired 35d tombstones) are gone (0 entries remain);
	// - expiredItem and expiredTag (35d > 30d cutoff) are purged;
	// - liveItem (with entry_count=0) and liveTag (with item_count=1) remain intact;
	// - AssertInvariants passes.
	seedPurgeRaceFixture := func(seed byte, vf vaultFixture) (liveItemID, expItemLowID, expItemHighID, liveTagID, expTagLowID, expTagHighID uuid.UUID, cutoff time.Time) {
		t.Helper()
		baseNow := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
		cutoff = baseNow.Add(-entry.ContentPurgeRetentionWindow) // now - 30d
		del35d := baseNow.Add(-35 * 24 * time.Hour)
		del34d := baseNow.Add(-34 * 24 * time.Hour)
		del10d := baseNow.Add(-10 * 24 * time.Hour)

		liveItem := insertTestItem(t, h, meA.User.ID, fmt.Sprintf("PurgeRace-LiveItem-%02x", seed))
		expItem1 := insertTestItem(t, h, meA.User.ID, fmt.Sprintf("PurgeRace-ExpItem1-%02x", seed))
		expItem2 := insertTestItem(t, h, meA.User.ID, fmt.Sprintf("PurgeRace-ExpItem2-%02x", seed))
		expItemLowID, expItemHighID = expItem1.ID, expItem2.ID
		if bytes.Compare(expItemLowID[:], expItemHighID[:]) > 0 {
			expItemLowID, expItemHighID = expItemHighID, expItemLowID
		}

		liveTag := insertTestTagForReset(t, ctx, q, meA.User.ID, fmt.Sprintf("pr-live-tag-%02x", seed))
		expTag1 := insertTestTagForReset(t, ctx, q, meA.User.ID, fmt.Sprintf("pr-exp-tag1-%02x", seed))
		expTag2 := insertTestTagForReset(t, ctx, q, meA.User.ID, fmt.Sprintf("pr-exp-tag2-%02x", seed))
		expTagLowID, expTagHighID = expTag1.ID, expTag2.ID
		if bytes.Compare(expTagLowID[:], expTagHighID[:]) > 0 {
			expTagLowID, expTagHighID = expTagHighID, expTagLowID
		}

		assignTestTagToLiveItem(t, ctx, q, baseNow, meA.User.ID, liveItem.ID, liveTag.ID)
		assignTestTagToLiveItem(t, ctx, q, baseNow, meA.User.ID, liveItem.ID, expTagLowID)
		assignTestTagToLiveItem(t, ctx, q, baseNow, meA.User.ID, liveItem.ID, expTagHighID)

		// Give the higher-ID expired tag an older deleted_at (del35d) than the lower-ID expired tag (del34d).
		if _, err := h.Pool.Exec(ctx, `UPDATE tag SET deleted_at = $1 WHERE id = $2`, del34d, expTagLowID); err != nil {
			t.Fatal(err)
		}
		if _, err := h.Pool.Exec(ctx, `UPDATE tag SET deleted_at = $1 WHERE id = $2`, del35d, expTagHighID); err != nil {
			t.Fatal(err)
		}

		// Create 1 live entry, 1 recent tombstone (10d), and 1 expired tombstone (35d) on liveItem, plus 1 expired entry on expItemLowID.
		viaEntry := entry.DeletedViaEntry
		viaItem := entry.DeletedViaItem
		for i, spec := range []struct {
			itemID    uuid.UUID
			deletedAt *time.Time
			via       *string
		}{
			{itemID: liveItem.ID, deletedAt: nil, via: nil},
			{itemID: liveItem.ID, deletedAt: &del10d, via: &viaEntry},
			{itemID: liveItem.ID, deletedAt: &del35d, via: &viaEntry},
			{itemID: expItemLowID, deletedAt: &del34d, via: &viaItem},
		} {
			eid := uuid.New()
			sealed := sealEntryFixture(t, eid.String(), vf.VaultKeyID, vf.VK, []byte(fmt.Sprintf("purge-race-%02x-%d", seed, i)), seqBytes(vault.WrapNonceBytes, seed+byte(i+1)))
			var batch *uuid.UUID
			if spec.via != nil && *spec.via == entry.DeletedViaItem {
				b := uuid.New()
				batch = &b
			}
			if _, err := h.Pool.Exec(ctx, `
				INSERT INTO entry (
					id, user_id, item_id, type, position, envelope, ciphertext,
					plaintext_len_bucket, version, deleted_at, deleted_via, delete_batch
				) VALUES ($1, $2, $3, 'text', $4, $5, $6, $7, 1, $8, $9, $10)
			`, eid, meA.User.ID, spec.itemID, int32(i), []byte(sealed.EnvelopeRaw), sealed.CiphertextBytes, sealed.PlaintextLenBucket, spec.deletedAt, spec.via, batch); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := h.Pool.Exec(ctx, `UPDATE item SET entry_count = 1 WHERE id = $1`, liveItem.ID); err != nil {
			t.Fatal(err)
		}
		expBatchLow := uuid.New()
		if _, err := h.Pool.Exec(ctx, `UPDATE item SET deleted_at = $1, delete_batch = $2, entry_count = 0 WHERE id = $3`, del34d, expBatchLow, expItemLowID); err != nil {
			t.Fatal(err)
		}
		expBatchHigh := uuid.New()
		if _, err := h.Pool.Exec(ctx, `UPDATE item SET deleted_at = $1, delete_batch = $2, entry_count = 0 WHERE id = $3`, del35d, expBatchHigh, expItemHighID); err != nil {
			t.Fatal(err)
		}
		contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
		return liveItem.ID, expItemLowID, expItemHighID, liveTag.ID, expTagLowID, expTagHighID, cutoff
	}

	assertPostResetAndPurgeState := func(label string, liveItemID, expItemLowID, expItemHighID, liveTagID, expTagLowID, expTagHighID uuid.UUID) {
		t.Helper()
		totalE, _, _ := countEntriesForUser(t, ctx, h, meA.User.ID)
		if totalE != 0 {
			t.Fatalf("%s: total entries = %d, want 0", label, totalE)
		}
		for _, expItemID := range []uuid.UUID{expItemLowID, expItemHighID} {
			if _, err := q.GetItemByUserAndID(ctx, gen.GetItemByUserAndIDParams{UserID: meA.User.ID, ID: expItemID}); !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("%s: expected expired item %s to be purged, got err=%v", label, expItemID, err)
			}
		}
		for _, expTagID := range []uuid.UUID{expTagLowID, expTagHighID} {
			if _, err := q.GetTagByUserAndID(ctx, gen.GetTagByUserAndIDParams{UserID: meA.User.ID, ID: expTagID}); !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("%s: expected expired tag %s to be purged, got err=%v", label, expTagID, err)
			}
		}
		gotLiveItem, err := q.GetItemByUserAndID(ctx, gen.GetItemByUserAndIDParams{UserID: meA.User.ID, ID: liveItemID})
		if err != nil || gotLiveItem.DeletedAt.Valid || gotLiveItem.EntryCount != 0 {
			t.Fatalf("%s: liveItem = (%+v, %v), want live with entry_count=0", label, gotLiveItem, err)
		}
		gotLiveTag, err := q.GetTagByUserAndID(ctx, gen.GetTagByUserAndIDParams{UserID: meA.User.ID, ID: liveTagID})
		if err != nil || gotLiveTag.DeletedAt.Valid || gotLiveTag.ItemCount != 1 {
			t.Fatalf("%s: liveTag = (%+v, %v), want live with item_count=1", label, gotLiveTag, err)
		}
		contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

		if _, err := h.Pool.Exec(ctx, `DELETE FROM item WHERE id = $1`, liveItemID); err != nil {
			t.Fatal(err)
		}
		if _, err := h.Pool.Exec(ctx, `DELETE FROM tag WHERE id = $1`, liveTagID); err != nil {
			t.Fatal(err)
		}
	}

	// 3A. Reset acquires LockUserContent first (at each ResetHookStep) -> PurgeExpiredContent waits on LockUserContent.
	for idx, pauseStep := range resetSteps {
		t.Run("ResetFirst_Purge/"+string(pauseStep), func(t *testing.T) {
			vf := createVaultForUser(t, h, jarA, byte(0x90+idx*8))
			liveItemID, expItemLowID, expItemHighID, liveTagID, expTagLowID, expTagHighID, cutoff := seedPurgeRaceFixture(byte(0x90+idx*8), vf)

			wCtx, stepReached, releaseStep, closeRel, resetW, purgeW, awaitWorker := setupBarrierScenario(t)

			hook := func(hCtx context.Context, tx pgx.Tx, uid uuid.UUID) error {
				cbCtx := entry.WithResetHookStepCallback(hCtx, func(cbCtx context.Context, _ uuid.UUID, step entry.ResetHookStep) error {
					if step == pauseStep {
						select {
						case stepReached <- struct{}{}:
						default:
						}
						select {
						case <-releaseStep:
						case <-cbCtx.Done():
							return cbCtx.Err()
						}
						select {
						case <-wCtx.Done():
							return wCtx.Err()
						default:
						}
					}
					return nil
				})
				return entry.ResetHook(cbCtx, tx, uid)
			}
			grant := prepareReset(t, hook)

			startBarrierWorker(resetW, func() error {
				return runReset(wCtx, vf, fmt.Sprintf("idem_t8_rf_purge_reset_%d", idx), grant)
			})

			select {
			case <-stepReached:
			case <-time.After(10 * time.Second):
				t.Fatalf("timed out waiting for ResetHook step %s", pauseStep)
			}

			startBarrierWorker(purgeW, func() error {
				_, err := entry.PurgeExpiredContent(wCtx, h.Pool, cutoff)
				return err
			})

			waitForPgLocksCondition(t, 10*time.Second, fmt.Sprintf("PurgeExpiredContent waiting on LockUserContent at reset step %s", pauseStep), func() bool {
				return hasAdvisoryContentLockWaiter(ctx, h, meA.User.ID)
			})

			closeRel()

			awaitWorker(fmt.Sprintf("reset (%s)", pauseStep), resetW)
			awaitWorker(fmt.Sprintf("PurgeExpiredContent after reset (%s)", pauseStep), purgeW)

			assertPostResetAndPurgeState(fmt.Sprintf("Reset->Purge(%s)", pauseStep), liveItemID, expItemLowID, expItemHighID, liveTagID, expTagLowID, expTagHighID)
		})
	}

	// 3B. PurgeExpiredContent acquires LockUserContent first (at each purge lock step:
	//     after_user_content_lock -> after_items_locked -> after_tags_locked -> before_deletes) ->
	//     Reset waits behind the purge tx on LockUserContent.
	purgeSteps := []entry.PurgeBatchStep{
		entry.PurgeBatchStepAfterUserContentLock,
		entry.PurgeBatchStepAfterItemsLocked,
		entry.PurgeBatchStepAfterTagsLocked,
		entry.PurgeBatchStepBeforeDeletes,
	}
	for idx, pauseStep := range purgeSteps {
		t.Run("PurgeFirst/"+string(pauseStep), func(t *testing.T) {
			seed := byte(0xD0 + idx*8)
			vf := createVaultForUser(t, h, jarA, seed)
			liveItemID, expItemLowID, expItemHighID, liveTagID, expTagLowID, expTagHighID, cutoff := seedPurgeRaceFixture(seed, vf)
			var observedPurgeSteps []entry.PurgeBatchStep
			var stepMu sync.Mutex

			wCtx, purgeEntered, releasePurge, closeRel, purgeW, resetW, awaitWorker := setupBarrierScenario(t)
			grant := prepareReset(t, entry.ResetHook)

			var purgeCtx context.Context
			if pauseStep == entry.PurgeBatchStepAfterUserContentLock {
				// Preserve explicit WithPurgeLockHeldHook coverage at the content-lock boundary while also recording PurgeBatchSteps.
				baseCtx := entry.WithPurgeLockHeldHook(wCtx, func(pCtx context.Context, uid uuid.UUID) {
					if uid != meA.User.ID {
						return
					}
					select {
					case purgeEntered <- struct{}{}:
					default:
					}
					select {
					case <-releasePurge:
					case <-pCtx.Done():
					}
				})
				purgeCtx = entry.WithPurgeBatchStepCallback(baseCtx, func(pCtx context.Context, uid uuid.UUID, step entry.PurgeBatchStep) error {
					if uid == meA.User.ID {
						if err := pCtx.Err(); err != nil {
							return err
						}
						stepMu.Lock()
						observedPurgeSteps = append(observedPurgeSteps, step)
						stepMu.Unlock()
					}
					return nil
				})
			} else {
				purgeCtx = entry.WithPurgeBatchStepCallback(wCtx, func(pCtx context.Context, uid uuid.UUID, step entry.PurgeBatchStep) error {
					if uid != meA.User.ID {
						return nil
					}
					stepMu.Lock()
					observedPurgeSteps = append(observedPurgeSteps, step)
					stepMu.Unlock()
					if step == pauseStep {
						select {
						case purgeEntered <- struct{}{}:
						default:
						}
						select {
						case <-releasePurge:
						case <-pCtx.Done():
							return pCtx.Err()
						}
					}
					return nil
				})
			}

			resetDoneCh := make(chan struct{})

			startBarrierWorker(purgeW, func() error {
				_, err := entry.PurgeExpiredContent(purgeCtx, h.Pool, cutoff)
				return err
			})

			select {
			case <-purgeEntered:
			case <-time.After(10 * time.Second):
				t.Fatalf("timed out waiting for PurgeExpiredContent to reach step %s", pauseStep)
			}

			startBarrierWorker(resetW, func() error {
				defer close(resetDoneCh)
				return runReset(wCtx, vf, fmt.Sprintf("idem_t8_purgef_reset_%d", idx), grant)
			})

			purgePID, _ := waitForResetBlockedByPurgeTx(t, ctx, h, meA.User.ID, pauseStep, resetDoneCh)

			// Verify exact lock/row state at each purge boundary before releasing the barrier.
			switch pauseStep {
			case entry.PurgeBatchStepAfterUserContentLock:
				var itemOrTagOrEntryLocks int
				if err := h.Pool.QueryRow(ctx, `
					SELECT count(*)::int
					FROM pg_locks
					WHERE pid = $1
					  AND relation IN ('item'::regclass, 'tag'::regclass, 'entry'::regclass)
				`, purgePID).Scan(&itemOrTagOrEntryLocks); err != nil {
					t.Fatalf("query purgePID locks at %s: %v", pauseStep, err)
				}
				if itemOrTagOrEntryLocks != 0 {
					t.Fatalf("at %s purgePID=%d already holds %d item/tag/entry locks, want 0", pauseStep, purgePID, itemOrTagOrEntryLocks)
				}
			case entry.PurgeBatchStepAfterItemsLocked:
				assertRowLockedByPurgeAtStep(t, ctx, h, "item", expItemLowID, pauseStep)
				assertRowLockedByPurgeAtStep(t, ctx, h, "item", expItemHighID, pauseStep)
				var tagOrEntryLocks int
				if err := h.Pool.QueryRow(ctx, `
					SELECT count(*)::int
					FROM pg_locks
					WHERE pid = $1
					  AND relation IN ('tag'::regclass, 'entry'::regclass)
				`, purgePID).Scan(&tagOrEntryLocks); err != nil {
					t.Fatalf("query purgePID tag/entry locks at %s: %v", pauseStep, err)
				}
				if tagOrEntryLocks != 0 {
					t.Fatalf("at %s purgePID=%d already holds %d tag/entry locks, want 0", pauseStep, purgePID, tagOrEntryLocks)
				}
			case entry.PurgeBatchStepAfterTagsLocked, entry.PurgeBatchStepBeforeDeletes:
				assertRowLockedByPurgeAtStep(t, ctx, h, "item", expItemLowID, pauseStep)
				assertRowLockedByPurgeAtStep(t, ctx, h, "item", expItemHighID, pauseStep)
				assertRowLockedByPurgeAtStep(t, ctx, h, "tag", expTagLowID, pauseStep)
				assertRowLockedByPurgeAtStep(t, ctx, h, "tag", expTagHighID, pauseStep)
				var entryLocks int
				if err := h.Pool.QueryRow(ctx, `
					SELECT count(*)::int
					FROM pg_locks
					WHERE pid = $1
					  AND relation = 'entry'::regclass
				`, purgePID).Scan(&entryLocks); err != nil {
					t.Fatalf("query purgePID entry locks at %s: %v", pauseStep, err)
				}
				if entryLocks != 0 {
					t.Fatalf("at %s purgePID=%d already holds %d entry locks before deletes, want 0", pauseStep, purgePID, entryLocks)
				}
			}

			closeRel()

			awaitWorker(fmt.Sprintf("PurgeExpiredContent (%s)", pauseStep), purgeW)
			awaitWorker(fmt.Sprintf("reset after purge (%s)", pauseStep), resetW)

			stepMu.Lock()
			gotSteps := slices.Clone(observedPurgeSteps)
			stepMu.Unlock()
			if !slices.Equal(gotSteps, purgeSteps) {
				t.Fatalf("PurgeExpiredContent observed steps = %v, want %v", gotSteps, purgeSteps)
			}

			assertPostResetAndPurgeState(fmt.Sprintf("Purge(%s)->Reset", pauseStep), liveItemID, expItemLowID, expItemHighID, liveTagID, expTagLowID, expTagHighID)
		})
	}

	// 4. Verify EA8-R1-3 / EA8-R2-2 cleanup invariant: when an error occurs while workers are parked on a
	//    barrier (after stepReached, before manual closeRel), the subtest t.Cleanup registered by
	//    setupBarrierScenario releases the barrier channel, cancels worker contexts, and joins all launched
	//    worker goroutines (closing their doneCh and setting joined=true) before httptest.Server.Close runs,
	//    without blocking on unlaunched workers.
	var cleanupVerifyResetW, cleanupVerifyDelW *barrierWorker
	t.Run("BarrierErrorCleanupReleasesAndJoinsWorkers", func(t *testing.T) {
		vf := createVaultForUser(t, h, jarA, 0xF8)
		item := insertTestItem(t, h, meA.User.ID, "CleanupVerify-Item")
		t.Cleanup(func() {
			_, _ = h.Pool.Exec(ctx, `DELETE FROM item WHERE id = $1`, item.ID)
		})

		wCtx, stepReached, releaseStep, _, resetW, delW, _ := setupBarrierScenario(t)
		cleanupVerifyResetW = resetW
		cleanupVerifyDelW = delW

		hook := func(hCtx context.Context, tx pgx.Tx, uid uuid.UUID) error {
			cbCtx := entry.WithResetHookStepCallback(hCtx, func(cbCtx context.Context, _ uuid.UUID, step entry.ResetHookStep) error {
				if step == entry.ResetHookStepAfterUserContentLock {
					select {
					case stepReached <- struct{}{}:
					default:
					}
					select {
					case <-releaseStep:
					case <-cbCtx.Done():
						return cbCtx.Err()
					}
					select {
					case <-wCtx.Done():
						return wCtx.Err()
					default:
					}
				}
				return nil
			})
			return entry.ResetHook(cbCtx, tx, uid)
		}
		grant := prepareReset(t, hook)

		startBarrierWorker(resetW, func() error {
			return runReset(wCtx, vf, "idem_t8_cleanup_verify_reset", grant)
		})

		select {
		case <-stepReached:
		case <-time.After(10 * time.Second):
			t.Fatal("timed out waiting for ResetHook step in BarrierErrorCleanupReleasesAndJoinsWorkers")
		}

		startBarrierWorker(delW, func() error {
			return softDeleteItemInTx(wCtx, h, meA.User.ID, item.ID, nil)
		})

		waitForPgLocksCondition(t, 10*time.Second, "item delete waiting on LockUserContent in cleanup verification", func() bool {
			return hasAdvisoryContentLockWaiter(ctx, h, meA.User.ID)
		})

		// Return from the subtest WITHOUT calling closeRel() or awaitWorker():
		// setupBarrierScenario's registered t.Cleanup must release releaseStep, cancel wCtx,
		// join both launched workers, and record positive completion via doneCh and joined=true.
	})
	for _, check := range []struct {
		name string
		w    *barrierWorker
	}{
		{name: "resetW", w: cleanupVerifyResetW},
		{name: "delW", w: cleanupVerifyDelW},
	} {
		if check.w == nil {
			t.Fatalf("missing %s barrierWorker after cleanup verification subtest", check.name)
		}
		check.w.mu.Lock()
		launched, joined := check.w.launched, check.w.joined
		check.w.mu.Unlock()
		if !launched || !joined {
			t.Fatalf("%s state after subtest cleanup = (launched=%v, joined=%v), want (true, true)", check.name, launched, joined)
		}
		select {
		case <-check.w.doneCh:
		default:
			t.Fatalf("expected %s.doneCh to be closed after subtest cleanup joined the worker", check.name)
		}
	}
}

// TestResetHookStepOrderUnit verifies that entry.ResetHook invokes the four steps in the exact
// plan §2.5 order (after_user_content_lock -> after_items_locked -> after_entries_deleted -> after_counts_zeroed)
// and propagates a step callback error immediately without executing subsequent steps.
func TestResetHookStepOrderUnit(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{
		ResetHook: entry.ResetHook,
	})
	_, meA := h.SignupUser("reset-step-order@example.com", "correct-horse-battery-staple-a")
	ctx := context.Background()

	var observed []entry.ResetHookStep
	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cbCtx := entry.WithResetHookStepCallback(ctx, func(_ context.Context, uid uuid.UUID, step entry.ResetHookStep) error {
		if uid != meA.User.ID {
			t.Fatalf("unexpected userID %s, want %s", uid, meA.User.ID)
		}
		observed = append(observed, step)
		return nil
	})
	if err := entry.ResetHook(cbCtx, tx, meA.User.ID); err != nil {
		t.Fatalf("ResetHook: %v", err)
	}

	want := []entry.ResetHookStep{
		entry.ResetHookStepAfterUserContentLock,
		entry.ResetHookStepAfterItemsLocked,
		entry.ResetHookStepAfterEntriesDeleted,
		entry.ResetHookStepAfterCountsZeroed,
	}
	if !slices.Equal(observed, want) {
		t.Fatalf("observed steps = %v, want %v", observed, want)
	}

	// Verify an error returned at an intermediate step aborts immediately without running later steps.
	var observedShort []entry.ResetHookStep
	stopErr := errors.New("abort after items locked")
	cbErrCtx := entry.WithResetHookStepCallback(ctx, func(_ context.Context, _ uuid.UUID, step entry.ResetHookStep) error {
		observedShort = append(observedShort, step)
		if step == entry.ResetHookStepAfterItemsLocked {
			return stopErr
		}
		return nil
	})
	if err := entry.ResetHook(cbErrCtx, tx, meA.User.ID); !errors.Is(err, stopErr) {
		t.Fatalf("ResetHook with step error = %v, want %v", err, stopErr)
	}
	wantShort := []entry.ResetHookStep{
		entry.ResetHookStepAfterUserContentLock,
		entry.ResetHookStepAfterItemsLocked,
	}
	if !slices.Equal(observedShort, wantShort) {
		t.Fatalf("observedShort steps = %v, want %v", observedShort, wantShort)
	}
}
