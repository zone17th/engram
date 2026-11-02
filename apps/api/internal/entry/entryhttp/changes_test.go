package entryhttp_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

func getChangesPage(t *testing.T, h *contenttest.Harness, jar contenttest.CookieJar, query string) (contenttest.TestResponse, entry.ChangesPage, string) {
	t.Helper()
	path := "/api/v1/entries/changes"
	if query != "" {
		path += "?" + query
	}
	resp, raw := h.DoReq(jar, http.MethodGet, path, "", contenttest.ReqOptions{})
	var page entry.ChangesPage
	if resp.StatusCode == http.StatusOK {
		if err := json.Unmarshal([]byte(raw), &page); err != nil {
			t.Fatalf("decode EntryChangesPage (%s): %v (raw=%s)", path, err, raw)
		}
	}
	return resp, page, raw
}

// TestEntriesChangesBootstrapAndAllMutationsAppearWithTombstoneAndNoCiphertext covers Task 7 bullet 1:
//   - No-since bootstrap returns `{changes: [], next_cursor: null, watermark}` with `Cache-Control: no-store`.
//   - Create / PUT (body update) / reorder / delete (tombstone with `deleted_at != null`) / restore each
//     appear in `GET /entries/changes` with a newly bumped `updated_at`.
//   - `EntryChange` never contains `envelope` or `ciphertext` (user-dec-016), and server logs contain no
//     ciphertext, nonce, vault_key_id, item name, or plaintext sentinel.
func TestEntriesChangesBootstrapAndAllMutationsAppearWithTombstoneAndNoCiphertext(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA := h.SignupUser("changes-mutations-a@example.com", "correct-horse-battery-staple-a")
	vf := createVaultForUser(t, h, jarA, 0x10)
	item := insertTestItem(t, h, meA.User.ID, "Changes Feed Lifecycle Item")

	// 1. Bootstrap call without `since` (and without `cursor`) returns empty `changes: []` (never null) and server watermark.
	respBoot, bootPage, rawBoot := getChangesPage(t, h, jarA, "")
	if respBoot.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap GET /entries/changes = %d %s, want 200", respBoot.StatusCode, rawBoot)
	}
	if cc := respBoot.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}
	if bootPage.Changes == nil || len(bootPage.Changes) != 0 || bootPage.NextCursor != nil {
		t.Fatalf("bootstrap page = %+v (raw=%s), want empty changes [] and next_cursor=nil", bootPage, rawBoot)
	}
	if !strings.Contains(rawBoot, `"changes":[]`) {
		t.Fatalf("bootstrap raw JSON %s must serialize empty changes as []", rawBoot)
	}
	wm0, err := time.Parse(time.RFC3339Nano, bootPage.Watermark)
	if err != nil {
		t.Fatalf("invalid bootstrap watermark %q: %v", bootPage.Watermark, err)
	}

	// 2. Create two entries (e1 and e2). Both must appear in the feed since wm0 with `deleted_at == nil`.
	id1 := uuid.NewString()
	plain1 := []byte("secret body one for changes feed")
	sealed1 := sealEntryFixture(t, id1, vf.VaultKeyID, vf.VK, plain1, seqBytes(vault.WrapNonceBytes, 0x21))
	respC1, rawC1 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
		makeCreateBody(id1, entry.TypeText, sealed1.EnvelopeRaw, sealed1.CiphertextB64, sealed1.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t7_changes_create_1"})
	if respC1.StatusCode != http.StatusCreated {
		t.Fatalf("create e1 = %d %s", respC1.StatusCode, rawC1)
	}

	id2 := uuid.NewString()
	plain2 := []byte(`{"secret":"two"}`)
	sealed2 := sealEntryFixture(t, id2, vf.VaultKeyID, vf.VK, plain2, seqBytes(vault.WrapNonceBytes, 0x22))
	respC2, rawC2 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
		makeCreateBody(id2, entry.TypeJSON, sealed2.EnvelopeRaw, sealed2.CiphertextB64, sealed2.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t7_changes_create_2"})
	if respC2.StatusCode != http.StatusCreated {
		t.Fatalf("create e2 = %d %s", respC2.StatusCode, rawC2)
	}

	_, pageAfterCreate, rawAfterCreate := getChangesPage(t, h, jarA, "since="+url.QueryEscape(wm0.Format(time.RFC3339Nano)))
	if len(pageAfterCreate.Changes) != 2 {
		t.Fatalf("changes after create = %d (%s), want 2", len(pageAfterCreate.Changes), rawAfterCreate)
	}
	if strings.Contains(rawAfterCreate, "envelope") || strings.Contains(rawAfterCreate, "ciphertext") ||
		strings.Contains(rawAfterCreate, sealed1.CiphertextB64) || strings.Contains(rawAfterCreate, string(plain1)) {
		t.Fatalf("feed response leaked envelope/ciphertext/plaintext: %s", rawAfterCreate)
	}

	byIDAfterCreate := make(map[string]entry.Change, 2)
	for _, ch := range pageAfterCreate.Changes {
		if ch.DeletedAt != nil {
			t.Fatalf("newly created entry %s has deleted_at=%v, want nil", ch.ID, *ch.DeletedAt)
		}
		byIDAfterCreate[ch.ID] = ch
	}
	c1Create, ok1 := byIDAfterCreate[id1]
	c2Create, ok2 := byIDAfterCreate[id2]
	if !ok1 || !ok2 {
		t.Fatalf("expected both %s and %s in feed after create, got %+v", id1, id2, byIDAfterCreate)
	}
	t1Create, _ := time.Parse(time.RFC3339Nano, c1Create.UpdatedAt)
	t2Create, _ := time.Parse(time.RFC3339Nano, c2Create.UpdatedAt)

	// 3. PUT (update body) on e1 -> version increments to 2, updated_at advances and appears in feed.
	wmBeforeUpdate := pageAfterCreate.Watermark
	sealed1V2 := sealEntryFixture(t, id1, vf.VaultKeyID, vf.VK, []byte("updated secret body one"), seqBytes(vault.WrapNonceBytes, 0x23))
	respUpd, rawUpd := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+id1,
		makeUpdateBody(sealed1V2.EnvelopeRaw, sealed1V2.CiphertextB64, sealed1V2.PlaintextLenBucket),
		contenttest.ReqOptions{
			IdemKey: "idem_t7_changes_update_1",
			IfMatch: `"1"`,
		})
	if respUpd.StatusCode != http.StatusOK {
		t.Fatalf("PUT e1 = %d %s", respUpd.StatusCode, rawUpd)
	}

	_, pageAfterUpdate, _ := getChangesPage(t, h, jarA, "since="+url.QueryEscape(wmBeforeUpdate))
	if len(pageAfterUpdate.Changes) != 1 || pageAfterUpdate.Changes[0].ID != id1 {
		t.Fatalf("changes after PUT = %+v, want [e1]", pageAfterUpdate.Changes)
	}
	c1Update := pageAfterUpdate.Changes[0]
	t1Update, _ := time.Parse(time.RFC3339Nano, c1Update.UpdatedAt)
	if !t1Update.After(t1Create) || c1Update.Version != 2 || c1Update.DeletedAt != nil {
		t.Fatalf("e1 after PUT = %+v (t1Create=%v), want updated_at > t1Create, version=2, deleted_at=nil", c1Update, t1Create)
	}

	// 4. Reorder [e2, e1] -> both entries appear in feed with new updated_at, new positions, and unchanged versions.
	wmBeforeReorder := pageAfterUpdate.Watermark
	reorderBody := fmt.Sprintf(`{"entry_ids":[%q,%q]}`, id2, id1)
	respReord, rawReord := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+item.ID.String()+"/entries/reorder", reorderBody,
		contenttest.ReqOptions{IdemKey: "idem_t7_changes_reorder_1"})
	if respReord.StatusCode != http.StatusOK {
		t.Fatalf("PATCH reorder = %d %s", respReord.StatusCode, rawReord)
	}

	_, pageAfterReorder, _ := getChangesPage(t, h, jarA, "since="+url.QueryEscape(wmBeforeReorder))
	if len(pageAfterReorder.Changes) != 2 {
		t.Fatalf("changes after reorder = %+v, want 2 entries", pageAfterReorder.Changes)
	}
	byIDAfterReorder := map[string]entry.Change{
		pageAfterReorder.Changes[0].ID: pageAfterReorder.Changes[0],
		pageAfterReorder.Changes[1].ID: pageAfterReorder.Changes[1],
	}
	c1Reord := byIDAfterReorder[id1]
	c2Reord := byIDAfterReorder[id2]
	t1Reord, _ := time.Parse(time.RFC3339Nano, c1Reord.UpdatedAt)
	t2Reord, _ := time.Parse(time.RFC3339Nano, c2Reord.UpdatedAt)
	if !t1Reord.After(t1Update) || !t2Reord.After(t2Create) {
		t.Fatalf("reorder did not advance updated_at: e1=%v (was %v), e2=%v (was %v)", t1Reord, t1Update, t2Reord, t2Create)
	}
	if c2Reord.Position != 0 || c1Reord.Position != 1 || c1Reord.Version != 2 || c2Reord.Version != 1 {
		t.Fatalf("reorder positions/versions = (e2 pos=%d v=%d, e1 pos=%d v=%d), want (0/1, 1/2)",
			c2Reord.Position, c2Reord.Version, c1Reord.Position, c1Reord.Version)
	}

	// 5. Delete e1 -> appears as tombstone (`deleted_at != nil`) with new updated_at and unchanged version.
	wmBeforeDelete := pageAfterReorder.Watermark
	respDel, rawDel := h.DoReq(jarA, http.MethodDelete, "/api/v1/entries/"+id1, "",
		contenttest.ReqOptions{IdemKey: "idem_t7_changes_delete_1"})
	if respDel.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE e1 = %d %s", respDel.StatusCode, rawDel)
	}

	_, pageAfterDelete, _ := getChangesPage(t, h, jarA, "since="+url.QueryEscape(wmBeforeDelete))
	if len(pageAfterDelete.Changes) != 1 || pageAfterDelete.Changes[0].ID != id1 {
		t.Fatalf("changes after DELETE = %+v, want [e1 tombstone]", pageAfterDelete.Changes)
	}
	c1Del := pageAfterDelete.Changes[0]
	t1Del, _ := time.Parse(time.RFC3339Nano, c1Del.UpdatedAt)
	if !t1Del.After(t1Reord) || c1Del.DeletedAt == nil || *c1Del.DeletedAt == "" || c1Del.Version != 2 {
		t.Fatalf("tombstone e1 = %+v (prev updated_at=%v), want updated_at advanced, non-nil deleted_at, version=2", c1Del, t1Reord)
	}
	if _, err := time.Parse(time.RFC3339Nano, *c1Del.DeletedAt); err != nil {
		t.Fatalf("tombstone deleted_at %q is not valid RFC3339Nano: %v", *c1Del.DeletedAt, err)
	}

	// 6. Restore e1 -> appears in feed with `deleted_at == nil` and new updated_at.
	wmBeforeRestore := pageAfterDelete.Watermark
	respRest, rawRest := h.DoReq(jarA, http.MethodPost, "/api/v1/entries/"+id1+"/restore", `{}`,
		contenttest.ReqOptions{IdemKey: "idem_t7_changes_restore_1"})
	if respRest.StatusCode != http.StatusOK {
		t.Fatalf("POST /entries/{id1}/restore = %d %s", respRest.StatusCode, rawRest)
	}

	_, pageAfterRestore, _ := getChangesPage(t, h, jarA, "since="+url.QueryEscape(wmBeforeRestore))
	if len(pageAfterRestore.Changes) != 1 || pageAfterRestore.Changes[0].ID != id1 {
		t.Fatalf("changes after restore = %+v, want [e1 live]", pageAfterRestore.Changes)
	}
	c1Rest := pageAfterRestore.Changes[0]
	t1Rest, _ := time.Parse(time.RFC3339Nano, c1Rest.UpdatedAt)
	if !t1Rest.After(t1Del) || c1Rest.DeletedAt != nil || c1Rest.Version != 2 {
		t.Fatalf("e1 after restore = %+v (prev=%v), want updated_at > t1Del, deleted_at=nil, version=2", c1Rest, t1Del)
	}

	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Log privacy check (user-dec-016).
	logs := h.Logs.String()
	for _, secret := range []string{
		sealed1.CiphertextB64,
		sealed2.CiphertextB64,
		sealed1V2.CiphertextB64,
		sealed1.Envelope.Nonce,
		vf.VaultKeyID,
		"secret body one",
		"Changes Feed Lifecycle Item",
	} {
		if strings.Contains(logs, secret) {
			t.Fatalf("server logs leaked sensitive value %q:\n%s", secret, logs)
		}
	}
}

// TestEntriesChangesSameUpdatedAt250PaginationNoLossNoDup covers Task 7 bullet 2:
//   - 250 changes with the exact SAME `updated_at` (forced via SQL) paginate across multiple pages
//     with no lost rows and no duplicates, and carry the first page's `watermark` unchanged across pages.
func TestEntriesChangesSameUpdatedAt250PaginationNoLossNoDup(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA := h.SignupUser("changes-250-same-ts@example.com", "correct-horse-battery-staple-a")
	vf := createVaultForUser(t, h, jarA, 0x30)
	item1 := insertTestItem(t, h, meA.User.ID, "Batch Item One")
	item2 := insertTestItem(t, h, meA.User.ID, "Batch Item Two")

	ctx := context.Background()
	q := gen.New(h.Pool)
	dbNowTS, err := q.ContentClockNow(ctx)
	if err != nil {
		t.Fatalf("ContentClockNow: %v", err)
	}
	sharedTS := dbNowTS.Time.UTC().Add(-10 * time.Minute).Truncate(time.Microsecond)
	sinceStr := sharedTS.Format(time.RFC3339Nano)

	sealed := sealEntryFixture(t, uuid.NewString(), vf.VaultKeyID, vf.VK, []byte("batch entry fixture"), seqBytes(vault.WrapNonceBytes, 0x41))

	const totalRows = 250
	expectedIDs := make(map[string]bool, totalRows)

	// Insert 150 live entries on item1, 50 live entries on item2, and 50 soft-deleted tombstones on item2
	// so live entries per item stay <= 200 while total changes for userA == 250.
	for i := range totalRows {
		id := uuid.New()
		expectedIDs[id.String()] = true
		targetItem := item1.ID
		pos := int32(i)
		var delAt pgtype.Timestamptz
		var delVia *string
		if i >= 150 {
			targetItem = item2.ID
			pos = int32(i - 150)
		}
		if i >= 200 {
			delAt = pgtype.Timestamptz{Time: sharedTS, Valid: true}
			v := entry.DeletedViaEntry
			delVia = &v
		}
		_, err := h.Pool.Exec(ctx, `
			INSERT INTO entry (
				id, user_id, item_id, type, position, envelope, ciphertext,
				plaintext_len_bucket, version, created_at, updated_at, deleted_at, deleted_via
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9, $10, $11)
		`, id, meA.User.ID, targetItem, entry.TypeText, pos, []byte(sealed.EnvelopeRaw), sealed.CiphertextBytes,
			sealed.PlaintextLenBucket, sharedTS, delAt, delVia)
		if err != nil {
			t.Fatalf("seed entry %d: %v", i, err)
		}
	}
	if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{Delta: 150, UserID: meA.User.ID, ID: item1.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{Delta: 50, UserID: meA.User.ID, ID: item2.ID}); err != nil {
		t.Fatal(err)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Paginate with default limit (100) -> expect 3 pages: 100 + 100 + 50 = 250.
	seen := make(map[string]bool, totalRows)
	var orderedIDs []string
	var cursor *string
	var firstWatermark string
	pageCount := 0
	tombstoneCount := 0

	for {
		pageCount++
		if pageCount > 10 {
			t.Fatal("pagination did not terminate within 10 pages")
		}
		qStr := "since=" + url.QueryEscape(sinceStr)
		if cursor != nil {
			qStr += "&cursor=" + url.QueryEscape(*cursor)
		}
		resp, page, raw := getChangesPage(t, h, jarA, qStr)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("page %d = %d %s, want 200", pageCount, resp.StatusCode, raw)
		}
		if pageCount == 1 {
			firstWatermark = page.Watermark
		} else if page.Watermark != firstWatermark {
			t.Fatalf("page %d watermark = %q, want first page watermark %q", pageCount, page.Watermark, firstWatermark)
		}

		for _, ch := range page.Changes {
			if seen[ch.ID] {
				t.Fatalf("duplicate entry ID %s on page %d", ch.ID, pageCount)
			}
			if !expectedIDs[ch.ID] {
				t.Fatalf("unexpected entry ID %s on page %d", ch.ID, pageCount)
			}
			gotTS, err := time.Parse(time.RFC3339Nano, ch.UpdatedAt)
			if err != nil || !gotTS.Equal(sharedTS) {
				t.Fatalf("entry %s updated_at = %q, want %v", ch.ID, ch.UpdatedAt, sharedTS)
			}
			if ch.DeletedAt != nil {
				tombstoneCount++
			}
			seen[ch.ID] = true
			orderedIDs = append(orderedIDs, ch.ID)
		}

		if page.NextCursor == nil {
			break
		}
		cursor = page.NextCursor
	}

	if pageCount != 3 {
		t.Fatalf("pageCount = %d, want 3 (100 + 100 + 50)", pageCount)
	}
	if len(seen) != totalRows {
		t.Fatalf("total unique rows across pages = %d, want %d", len(seen), totalRows)
	}
	if tombstoneCount != 50 {
		t.Fatalf("tombstoneCount = %d, want 50", tombstoneCount)
	}
	for i := 1; i < len(orderedIDs); i++ {
		if orderedIDs[i-1] >= orderedIDs[i] {
			t.Fatalf("IDs with identical updated_at not strictly ascending at %d: %s >= %s", i, orderedIDs[i-1], orderedIDs[i])
		}
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
}

// TestEntriesChangesLongHeldTxOlderThanWatermarkOverlapMissesFeedButListShowsIt covers Task 7 bullet 3 (P4BE1-7):
//   - A write transaction held open across two feed calls, then committed with an `updated_at` older than
//     `watermark - 120s` (forced via SQL inside that open tx):
//   - The second feed call (`since = watermark1 - 120s`) misses that row while `tx` is uncommitted, and a
//     subsequent feed call (`since = watermark2 - 120s`) also misses it after commit because its `updated_at`
//     is older than the 120s overlap window (documented known limit of best-effort timestamp delta feed).
//   - `GET /items/{id}/entries` (canonical metadata source) immediately returns the committed row afterwards
//     (basis for Task 20's mandatory refetch on focus/reconnect/visible).
func TestEntriesChangesLongHeldTxOlderThanWatermarkOverlapMissesFeedButListShowsIt(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA := h.SignupUser("changes-longtx@example.com", "correct-horse-battery-staple-a")
	vf := createVaultForUser(t, h, jarA, 0x50)
	item := insertTestItem(t, h, meA.User.ID, "Long Held Tx Item")

	ctx := context.Background()
	sealed := sealEntryFixture(t, uuid.NewString(), vf.VaultKeyID, vf.VK, []byte("long-running tx payload"), seqBytes(vault.WrapNonceBytes, 0x61))

	// Open a write transaction BEFORE the two feed polls.
	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Pool.Begin: %v", err)
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	// Poll 1: bootstrap watermark1 while `tx` is open.
	resp1, page1, raw1 := getChangesPage(t, h, jarA, "")
	if resp1.StatusCode != http.StatusOK {
		t.Fatalf("feed poll 1 = %d %s", resp1.StatusCode, raw1)
	}
	wm1, err := time.Parse(time.RFC3339Nano, page1.Watermark)
	if err != nil {
		t.Fatal(err)
	}

	// Inside `tx` (still uncommitted), stage an entry whose `updated_at` is older than `watermark1 - 120s`
	// (e.g. `watermark1 - 5 minutes`, simulating a transaction that computed its timestamp early and stayed open).
	lateEntryID := uuid.New()
	staleUpdatedAt := wm1.Add(-5 * time.Minute).Truncate(time.Microsecond)
	_, err = tx.Exec(ctx, `
		INSERT INTO entry (
			id, user_id, item_id, type, position, envelope, ciphertext,
			plaintext_len_bucket, version, created_at, updated_at
		) VALUES ($1, $2, $3, $4, 0, $5, $6, $7, 1, $8, $8)
	`, lateEntryID, meA.User.ID, item.ID, entry.TypeText, []byte(sealed.EnvelopeRaw),
		sealed.CiphertextBytes, sealed.PlaintextLenBucket, staleUpdatedAt)
	if err != nil {
		t.Fatalf("tx insert entry: %v", err)
	}
	_, err = tx.Exec(ctx, `UPDATE item SET entry_count = entry_count + 1 WHERE user_id = $1 AND id = $2`, meA.User.ID, item.ID)
	if err != nil {
		t.Fatalf("tx update item entry_count: %v", err)
	}

	// Poll 2 (while `tx` is STILL uncommitted): client queries `since = watermark1 - 120s`.
	// Because `tx` has not committed, MVCC hides the row; client advances watermark to `watermark2`.
	since2 := wm1.Add(-120 * time.Second).Format(time.RFC3339Nano)
	resp2, page2, raw2 := getChangesPage(t, h, jarA, "since="+url.QueryEscape(since2))
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("feed poll 2 = %d %s", resp2.StatusCode, raw2)
	}
	if len(page2.Changes) != 0 {
		t.Fatalf("feed poll 2 while tx uncommitted returned %+v, want empty", page2.Changes)
	}
	wm2, err := time.Parse(time.RFC3339Nano, page2.Watermark)
	if err != nil {
		t.Fatal(err)
	}

	// Now commit the long-held transaction.
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("tx.Commit: %v", err)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Poll 3 (after commit): client queries `since = watermark2 - 120s`.
	// Because the row committed with `updated_at = wm1 - 5m < wm2 - 120s`, the feed misses it (known limit P4BE1-7).
	since3 := wm2.Add(-120 * time.Second).Format(time.RFC3339Nano)
	resp3, page3, raw3 := getChangesPage(t, h, jarA, "since="+url.QueryEscape(since3))
	if resp3.StatusCode != http.StatusOK {
		t.Fatalf("feed poll 3 = %d %s", resp3.StatusCode, raw3)
	}
	if len(page3.Changes) != 0 {
		t.Fatalf("expected feed poll 3 with since=%s to miss row with updated_at=%v, got %+v",
			since3, staleUpdatedAt, page3.Changes)
	}

	// Canonical refetch (`GET /items/{id}/entries`) immediately sees the committed entry.
	respList, rawList := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+item.ID.String()+"/entries", "", contenttest.ReqOptions{})
	if respList.StatusCode != http.StatusOK {
		t.Fatalf("GET /items/{id}/entries = %d %s, want 200", respList.StatusCode, rawList)
	}
	var metaList entry.MetaList
	if err := json.Unmarshal([]byte(rawList), &metaList); err != nil {
		t.Fatalf("decode EntryMetaList: %v", err)
	}
	if len(metaList.Items) != 1 || metaList.Items[0].ID != lateEntryID.String() {
		t.Fatalf("GET /items/{id}/entries after long-held tx commit = %+v, want [%s]", metaList.Items, lateEntryID)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
}

// TestEntriesChangesWindowExpired410Validation400AndCrossUserIsolation covers Task 7 bullets 4 & 6 (P04-A1):
//   - `since` = 29 days + 1 second ago (relative to DB clock `ContentClockNow`) -> `410 changes_window_expired`;
//     `since` = 29 days - 1 minute ago -> `200 OK`.
//   - Malformed `since`, cursor without `since`, invalid `limit` (0, 201, non-int), foreign user's cursor,
//     or cursor with mismatched `since` -> `400 invalid_request`.
//   - User A's feed never contains User B's changes (live or tombstone).
func TestEntriesChangesWindowExpired410Validation400AndCrossUserIsolation(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA, jarB, meB := h.SignupTwoUsers()
	vfA := createVaultForUser(t, h, jarA, 0x70)
	vfB := createVaultForUser(t, h, jarB, 0x80)
	itemA := insertTestItem(t, h, meA.User.ID, "User A Private Item")
	itemB := insertTestItem(t, h, meB.User.ID, "User B Private Item")

	ctx := context.Background()
	q := gen.New(h.Pool)
	dbNowTS, err := q.ContentClockNow(ctx)
	if err != nil {
		t.Fatalf("ContentClockNow: %v", err)
	}
	dbNow := dbNowTS.Time.UTC()

	// 1. `since` = 29 days + 1 second ago -> 410 changes_window_expired.
	// Note: because `ContentClockNow()` advances slightly by the time the request runs,
	// `dbNow - (29d + 1s)` is strictly older than `requestDbNow - 29d`.
	expiredSince := dbNow.Add(-(entry.ChangesRetentionWindow + time.Second)).Format(time.RFC3339Nano)
	resp410, _, raw410 := getChangesPage(t, h, jarA, "since="+url.QueryEscape(expiredSince))
	if resp410.StatusCode != http.StatusGone {
		t.Fatalf("since=29d+1s status = %d %s, want 410", resp410.StatusCode, raw410)
	}
	if code := contenttest.DecodeProblem(t, raw410).Code; code != "changes_window_expired" {
		t.Fatalf("410 problem code = %q, want changes_window_expired", code)
	}

	// `since` inside the 29-day window (29 days - 1 minute ago) -> 200 OK.
	validBorderSince := dbNow.Add(-(entry.ChangesRetentionWindow - time.Minute)).Format(time.RFC3339Nano)
	respBorder, _, rawBorder := getChangesPage(t, h, jarA, "since="+url.QueryEscape(validBorderSince))
	if respBorder.StatusCode != http.StatusOK {
		t.Fatalf("since=29d-1m status = %d %s, want 200", respBorder.StatusCode, rawBorder)
	}

	// 2. Malformed `since`, missing `since` with `cursor`, invalid `limit`, mismatched cursor, and foreign cursor -> 400 invalid_request.
	validSinceTime := dbNow.Add(-time.Hour).Truncate(time.Microsecond)
	validSince := validSinceTime.Format(time.RFC3339Nano)
	cursorForA := entry.EncodeChangesCursor(meA.User.ID, validSinceTime, dbNow, validSinceTime, uuid.New())
	cursorForB := entry.EncodeChangesCursor(meB.User.ID, validSinceTime, dbNow, validSinceTime, uuid.New())

	badQueries := []struct {
		name  string
		query string
	}{
		{name: "empty_since", query: "since="},
		{name: "malformed_since_not_rfc3339", query: "since=2026-11-01"},
		{name: "malformed_since_garbage", query: "since=not-a-timestamp"},
		{name: "duplicate_since", query: "since=" + url.QueryEscape(validSince) + "&since=" + url.QueryEscape(validSince)},
		{name: "cursor_without_since", query: "cursor=" + url.QueryEscape(cursorForA)},
		{name: "empty_cursor", query: "since=" + url.QueryEscape(validSince) + "&cursor="},
		{name: "malformed_cursor", query: "since=" + url.QueryEscape(validSince) + "&cursor=not_valid_base64==="},
		{name: "cursor_mismatched_since", query: "since=" + url.QueryEscape(validSinceTime.Add(time.Second).Format(time.RFC3339Nano)) + "&cursor=" + url.QueryEscape(cursorForA)},
		{name: "foreign_user_cursor", query: "since=" + url.QueryEscape(validSince) + "&cursor=" + url.QueryEscape(cursorForB)},
		{name: "limit_zero", query: "since=" + url.QueryEscape(validSince) + "&limit=0"},
		{name: "limit_201", query: "since=" + url.QueryEscape(validSince) + "&limit=201"},
		{name: "limit_negative", query: "since=" + url.QueryEscape(validSince) + "&limit=-1"},
		{name: "limit_empty", query: "since=" + url.QueryEscape(validSince) + "&limit="},
		{name: "limit_alpha", query: "since=" + url.QueryEscape(validSince) + "&limit=abc"},
		{name: "malformed_escape_since", query: "since=%ZZ"},
		{name: "malformed_escape_cursor", query: "since=" + url.QueryEscape(validSince) + "&cursor=%ZZ"},
		{name: "malformed_escape_limit", query: "since=" + url.QueryEscape(validSince) + "&limit=%ZZ"},
		{name: "malformed_escape_duplicate_since", query: "since=" + url.QueryEscape(validSince) + "&since=%ZZ"},
	}

	for _, tc := range badQueries {
		respBad, _, rawBad := getChangesPage(t, h, jarA, tc.query)
		if respBad.StatusCode != http.StatusBadRequest {
			t.Fatalf("case %s (%s) = %d %s, want 400", tc.name, tc.query, respBad.StatusCode, rawBad)
		}
		if code := contenttest.DecodeProblem(t, rawBad).Code; code != "invalid_request" {
			t.Fatalf("case %s problem code = %q, want invalid_request", tc.name, code)
		}
	}

	// 3. Cross-user isolation (P04-A1): User A creates 1 live entry; User B creates 1 live entry and 1 tombstone.
	idA := uuid.NewString()
	sealedA := sealEntryFixture(t, idA, vfA.VaultKeyID, vfA.VK, []byte("user A entry"), seqBytes(vault.WrapNonceBytes, 0x91))
	respCA, rawCA := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries",
		makeCreateBody(idA, entry.TypeText, sealedA.EnvelopeRaw, sealedA.CiphertextB64, sealedA.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t7_iso_create_a"})
	if respCA.StatusCode != http.StatusCreated {
		t.Fatalf("create A = %d %s", respCA.StatusCode, rawCA)
	}

	idBLive := uuid.NewString()
	sealedB1 := sealEntryFixture(t, idBLive, vfB.VaultKeyID, vfB.VK, []byte("user B live entry"), seqBytes(vault.WrapNonceBytes, 0x92))
	respCB1, rawCB1 := h.DoReq(jarB, http.MethodPost, "/api/v1/items/"+itemB.ID.String()+"/entries",
		makeCreateBody(idBLive, entry.TypeText, sealedB1.EnvelopeRaw, sealedB1.CiphertextB64, sealedB1.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t7_iso_create_b1"})
	if respCB1.StatusCode != http.StatusCreated {
		t.Fatalf("create B1 = %d %s", respCB1.StatusCode, rawCB1)
	}

	idBDel := uuid.NewString()
	sealedB2 := sealEntryFixture(t, idBDel, vfB.VaultKeyID, vfB.VK, []byte("user B deleted entry"), seqBytes(vault.WrapNonceBytes, 0x93))
	respCB2, rawCB2 := h.DoReq(jarB, http.MethodPost, "/api/v1/items/"+itemB.ID.String()+"/entries",
		makeCreateBody(idBDel, entry.TypeText, sealedB2.EnvelopeRaw, sealedB2.CiphertextB64, sealedB2.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t7_iso_create_b2"})
	if respCB2.StatusCode != http.StatusCreated {
		t.Fatalf("create B2 = %d %s", respCB2.StatusCode, rawCB2)
	}
	respDelB2, rawDelB2 := h.DoReq(jarB, http.MethodDelete, "/api/v1/entries/"+idBDel, "",
		contenttest.ReqOptions{IdemKey: "idem_t7_iso_delete_b2"})
	if respDelB2.StatusCode != http.StatusNoContent {
		t.Fatalf("delete B2 = %d %s", respDelB2.StatusCode, rawDelB2)
	}

	_, pageA, rawPageA := getChangesPage(t, h, jarA, "since="+url.QueryEscape(validSince))
	if len(pageA.Changes) != 1 || pageA.Changes[0].ID != idA {
		t.Fatalf("User A feed = %+v (raw=%s), want only [%s]", pageA.Changes, rawPageA, idA)
	}
	if strings.Contains(rawPageA, idBLive) || strings.Contains(rawPageA, idBDel) || strings.Contains(rawPageA, itemB.ID.String()) {
		t.Fatalf("User A feed leaked User B IDs: %s", rawPageA)
	}

	_, pageB, rawPageB := getChangesPage(t, h, jarB, "since="+url.QueryEscape(validSince))
	if len(pageB.Changes) != 2 {
		t.Fatalf("User B feed = %+v (raw=%s), want 2 entries", pageB.Changes, rawPageB)
	}
	if strings.Contains(rawPageB, idA) || strings.Contains(rawPageB, itemA.ID.String()) {
		t.Fatalf("User B feed leaked User A IDs: %s", rawPageB)
	}

	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, meB.User.ID)
}
