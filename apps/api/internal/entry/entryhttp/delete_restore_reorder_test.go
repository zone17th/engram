package entryhttp_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

// TestEntryDeleteRestoreLifecyclePositionOrderAndRepeatIdempotency covers Task 6b bullets:
//   - Delete the last entry -> create a new entry -> restore the old one -> the two have different position
//     (restored keeps old position, newly created has max(position)+1 over all rows incl. tombstone),
//     and order is right in GET /items/{id}/entries.
//   - Repeat delete (already deleted) -> 204, nothing changes (deleted_at, updated_at, entry_count unchanged).
//   - Repeat restore (already live) -> 200 with current state, nothing changes (updated_at, version, entry_count unchanged).
//   - Idempotent replay of DELETE and POST /restore with the same Idempotency-Key -> original status and JSON-equal body (advisor-dec-135).
//   - version is unchanged across delete and restore; updated_at bumps on state transitions.
//   - AssertInvariants after every case.
func TestEntryDeleteRestoreLifecyclePositionOrderAndRepeatIdempotency(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA := h.SignupUser("entry-del-restore@example.com", "correct-horse-battery-staple-a")
	vf := createVaultForUser(t, h, jarA, 0x80)
	item := insertTestItem(t, h, meA.User.ID, "Delete Restore Order Item")

	// Create entry 1 (pos 0) and entry 2 (pos 1 = last entry).
	id1 := uuid.NewString()
	sealed1 := sealEntryFixture(t, id1, vf.VaultKeyID, vf.VK, []byte("entry one"), seqBytes(vault.WrapNonceBytes, 0xB1))
	resp1, raw1 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
		makeCreateBody(id1, entry.TypeText, sealed1.EnvelopeRaw, sealed1.CiphertextB64, sealed1.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t6b_create_entry_01"})
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("create entry 1 = %d %s", resp1.StatusCode, raw1)
	}

	id2 := uuid.NewString()
	sealed2 := sealEntryFixture(t, id2, vf.VaultKeyID, vf.VK, []byte("entry two (last)"), seqBytes(vault.WrapNonceBytes, 0xB2))
	resp2, raw2 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
		makeCreateBody(id2, entry.TypeText, sealed2.EnvelopeRaw, sealed2.CiphertextB64, sealed2.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t6b_create_entry_02"})
	if resp2.StatusCode != http.StatusCreated {
		t.Fatalf("create entry 2 = %d %s", resp2.StatusCode, raw2)
	}
	var meta2Created entry.Meta
	if err := json.Unmarshal([]byte(raw2), &meta2Created); err != nil {
		t.Fatal(err)
	}
	if meta2Created.Position != 1 || meta2Created.Version != 1 {
		t.Fatalf("entry 2 initial meta = %+v, want pos=1 version=1", meta2Created)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// 1. Delete the last entry (entry 2, pos 1) via DELETE /api/v1/entries/{id2} -> 204 No Content.
	delKey := "idem_t6b_delete_entry_02_first"
	respDel, rawDel := h.DoReq(jarA, http.MethodDelete, "/api/v1/entries/"+id2, "", contenttest.ReqOptions{
		IdemKey: delKey,
	})
	if respDel.StatusCode != http.StatusNoContent || rawDel != "" {
		t.Fatalf("DELETE /entries/{id2} = %d %q, want 204 empty", respDel.StatusCode, rawDel)
	}
	if cc := respDel.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("DELETE Cache-Control = %q, want no-store", cc)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	ctx := context.Background()
	q := gen.New(h.Pool)
	rowAfterDel, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{
		UserID: meA.User.ID,
		ID:     uuid.MustParse(id2),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !rowAfterDel.DeletedAt.Valid || rowAfterDel.DeletedVia == nil || *rowAfterDel.DeletedVia != entry.DeletedViaEntry {
		t.Fatalf("entry 2 after DELETE: deleted_at=%v deleted_via=%v, want valid and 'entry'", rowAfterDel.DeletedAt, rowAfterDel.DeletedVia)
	}
	if rowAfterDel.Version != 1 || rowAfterDel.Position != 1 {
		t.Fatalf("entry 2 version/pos after DELETE = (%d, %d), want (1, 1)", rowAfterDel.Version, rowAfterDel.Position)
	}
	if !rowAfterDel.UpdatedAt.Time.After(rowAfterDel.CreatedAt.Time) {
		t.Fatalf("expected updated_at (%v) > created_at (%v) after DELETE", rowAfterDel.UpdatedAt.Time, rowAfterDel.CreatedAt.Time)
	}

	// Idempotent replay of DELETE with the same key -> 204, nothing changes.
	respDelReplay, rawDelReplay := h.DoReq(jarA, http.MethodDelete, "/api/v1/entries/"+id2, "", contenttest.ReqOptions{
		IdemKey: delKey,
	})
	if respDelReplay.StatusCode != http.StatusNoContent || rawDelReplay != "" {
		t.Fatalf("DELETE idempotent replay = %d %q, want 204 empty", respDelReplay.StatusCode, rawDelReplay)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Repeat DELETE with a NEW Idempotency-Key when already deleted -> 204, nothing changes.
	respDelRepeat, rawDelRepeat := h.DoReq(jarA, http.MethodDelete, "/api/v1/entries/"+id2, "", contenttest.ReqOptions{
		IdemKey: "idem_t6b_delete_entry_02_repeat",
	})
	if respDelRepeat.StatusCode != http.StatusNoContent || rawDelRepeat != "" {
		t.Fatalf("repeat DELETE on already deleted entry = %d %q, want 204 empty", respDelRepeat.StatusCode, rawDelRepeat)
	}
	rowAfterRepeatDel, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{
		UserID: meA.User.ID,
		ID:     uuid.MustParse(id2),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !rowAfterRepeatDel.DeletedAt.Time.Equal(rowAfterDel.DeletedAt.Time) || !rowAfterRepeatDel.UpdatedAt.Time.Equal(rowAfterDel.UpdatedAt.Time) {
		t.Fatalf("repeat DELETE mutated timestamps: deleted_at=%v (was %v), updated_at=%v (was %v)",
			rowAfterRepeatDel.DeletedAt.Time, rowAfterDel.DeletedAt.Time, rowAfterRepeatDel.UpdatedAt.Time, rowAfterDel.UpdatedAt.Time)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// 2. Create a new entry (entry 3) while entry 2 is soft-deleted -> entry 3 gets position 2 (max(0, 1) + 1 = 2).
	id3 := uuid.NewString()
	sealed3 := sealEntryFixture(t, id3, vf.VaultKeyID, vf.VK, []byte("entry three"), seqBytes(vault.WrapNonceBytes, 0xB3))
	resp3, raw3 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
		makeCreateBody(id3, entry.TypeText, sealed3.EnvelopeRaw, sealed3.CiphertextB64, sealed3.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t6b_create_entry_03"})
	if resp3.StatusCode != http.StatusCreated {
		t.Fatalf("create entry 3 = %d %s", resp3.StatusCode, raw3)
	}
	var meta3 entry.Meta
	if err := json.Unmarshal([]byte(raw3), &meta3); err != nil {
		t.Fatal(err)
	}
	if meta3.Position != 2 {
		t.Fatalf("entry 3 position = %d, want 2", meta3.Position)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Advance fake clock so rate-limit window is fresh (5 writes issued in window 1).
	h.Clock.Advance(2 * time.Second)

	// 3. Restore entry 2 via POST /api/v1/entries/{id2}/restore -> 200 EntryMeta, keeps position=1, version=1, bumps updated_at.
	restoreKey := "idem_t6b_restore_entry_02_first"
	respRestore, rawRestore := h.DoReq(jarA, http.MethodPost, "/api/v1/entries/"+id2+"/restore", `{}`, contenttest.ReqOptions{
		IdemKey: restoreKey,
	})
	if respRestore.StatusCode != http.StatusOK {
		t.Fatalf("POST /entries/{id2}/restore = %d %s, want 200", respRestore.StatusCode, rawRestore)
	}
	var meta2Restored entry.Meta
	if err := json.Unmarshal([]byte(rawRestore), &meta2Restored); err != nil {
		t.Fatal(err)
	}
	if meta2Restored.ID != id2 || meta2Restored.Position != 1 || meta2Restored.Version != 1 {
		t.Fatalf("restored EntryMeta = %+v, want id=%s pos=1 version=1", meta2Restored, id2)
	}
	if meta2Restored.Position == meta3.Position {
		t.Fatalf("restored entry 2 and newly created entry 3 have the same position %d", meta2Restored.Position)
	}
	if meta2Restored.UpdatedAt <= meta2Created.UpdatedAt {
		t.Fatalf("expected restored updated_at (%s) > created updated_at (%s)", meta2Restored.UpdatedAt, meta2Created.UpdatedAt)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Idempotent replay of POST /entries/{id2}/restore with the same key -> 200 + JSON-equal body (advisor-dec-135).
	respRestoreReplay, rawRestoreReplay := h.DoReq(jarA, http.MethodPost, "/api/v1/entries/"+id2+"/restore", `{}`, contenttest.ReqOptions{
		IdemKey: restoreKey,
	})
	if respRestoreReplay.StatusCode != http.StatusOK {
		t.Fatalf("restore idempotent replay = %d %s, want 200", respRestoreReplay.StatusCode, rawRestoreReplay)
	}
	contenttest.AssertJSONEqual(t, rawRestore, rawRestoreReplay)
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Repeat restore with a NEW Idempotency-Key when already live -> 200 with current state, nothing changes.
	respRestoreRepeat, rawRestoreRepeat := h.DoReq(jarA, http.MethodPost, "/api/v1/entries/"+id2+"/restore", `{}`, contenttest.ReqOptions{
		IdemKey: "idem_t6b_restore_entry_02_repeat",
	})
	if respRestoreRepeat.StatusCode != http.StatusOK {
		t.Fatalf("repeat restore on live entry = %d %s, want 200", respRestoreRepeat.StatusCode, rawRestoreRepeat)
	}
	contenttest.AssertJSONEqual(t, rawRestore, rawRestoreRepeat)
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Optional body check on DELETE and POST /restore: empty body and `{}` are accepted; unknown keys or malformed JSON -> 400 invalid_request.
	h.Clock.Advance(2 * time.Second)
	for i, badBody := range []string{`{"extra":1}`, `not-json`} {
		respBadDel, rawBadDel := h.DoReq(jarA, http.MethodDelete, "/api/v1/entries/"+id2, badBody, contenttest.ReqOptions{
			IdemKey: fmt.Sprintf("idem_t6b_bad_del_body_%d", i),
		})
		if respBadDel.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, rawBadDel).Code != "invalid_request" {
			t.Fatalf("DELETE with bad body %q = %d %s, want 400 invalid_request", badBody, respBadDel.StatusCode, rawBadDel)
		}
		respBadRest, rawBadRest := h.DoReq(jarA, http.MethodPost, "/api/v1/entries/"+id2+"/restore", badBody, contenttest.ReqOptions{
			IdemKey: fmt.Sprintf("idem_t6b_bad_rest_body_%d", i),
		})
		if respBadRest.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, rawBadRest).Code != "invalid_request" {
			t.Fatalf("POST /restore with bad body %q = %d %s, want 400 invalid_request", badBody, respBadRest.StatusCode, rawBadRest)
		}
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// 4. Verify GET /items/{id}/entries returns [entry 1 (pos 0), entry 2 (pos 1), entry 3 (pos 2)] in exact order.
	respList, rawList := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+item.ID.String()+"/entries", "", contenttest.ReqOptions{})
	if respList.StatusCode != http.StatusOK {
		t.Fatalf("GET /items/{id}/entries = %d %s", respList.StatusCode, rawList)
	}
	var listed entry.MetaList
	if err := json.Unmarshal([]byte(rawList), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 3 {
		t.Fatalf("listed items len = %d, want 3", len(listed.Items))
	}
	wantOrder := []struct {
		id  string
		pos int32
	}{
		{id: id1, pos: 0},
		{id: id2, pos: 1},
		{id: id3, pos: 2},
	}
	for i, w := range wantOrder {
		if listed.Items[i].ID != w.id || listed.Items[i].Position != w.pos {
			t.Fatalf("listed.Items[%d] = (id=%s, pos=%d), want (id=%s, pos=%d)",
				i, listed.Items[i].ID, listed.Items[i].Position, w.id, w.pos)
		}
	}
}

// TestEntryRestoreConflictsViaItemDeletedItemAndLimit200 covers Task 6b bullet 1 (P04-A2, P04-A8):
//   - Restore an entry deleted via item (deleted_via='item' + delete_batch) -> 409 entry_restore_via_item.
//   - Restore an entry deleted via entry when its item is soft-deleted -> 409 item_deleted.
//   - Restore an entry deleted via entry when the item already has 200 live entries -> 409 item_entry_limit.
//   - AssertInvariants after every case.
func TestEntryRestoreConflictsViaItemDeletedItemAndLimit200(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA := h.SignupUser("entry-restore-conflicts@example.com", "correct-horse-battery-staple-a")
	vf := createVaultForUser(t, h, jarA, 0x88)

	ctx := context.Background()
	q := gen.New(h.Pool)

	// Case 1 & 2: Item 1 has entryViaEntry (deleted individually before item delete) and entryViaItem (deleted with item batch).
	item1 := insertTestItem(t, h, meA.User.ID, "Item For Provenance And Deleted Checks")
	idViaEntry := uuid.NewString()
	sealedVE := sealEntryFixture(t, idViaEntry, vf.VaultKeyID, vf.VK, []byte("deleted via entry"), seqBytes(vault.WrapNonceBytes, 0xC1))
	respVE, rawVE := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item1.ID.String()+"/entries",
		makeCreateBody(idViaEntry, entry.TypeText, sealedVE.EnvelopeRaw, sealedVE.CiphertextB64, sealedVE.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t6b_conf_create_ve"})
	if respVE.StatusCode != http.StatusCreated {
		t.Fatalf("create entryViaEntry = %d %s", respVE.StatusCode, rawVE)
	}

	idViaItem := uuid.NewString()
	sealedVI := sealEntryFixture(t, idViaItem, vf.VaultKeyID, vf.VK, []byte("deleted via item"), seqBytes(vault.WrapNonceBytes, 0xC2))
	respVI, rawVI := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item1.ID.String()+"/entries",
		makeCreateBody(idViaItem, entry.TypeText, sealedVI.EnvelopeRaw, sealedVI.CiphertextB64, sealedVI.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t6b_conf_create_vi"})
	if respVI.StatusCode != http.StatusCreated {
		t.Fatalf("create entryViaItem = %d %s", respVI.StatusCode, rawVI)
	}

	// Delete entryViaEntry individually via DELETE /entries/{id}.
	respDelVE, _ := h.DoReq(jarA, http.MethodDelete, "/api/v1/entries/"+idViaEntry, "", contenttest.ReqOptions{
		IdemKey: "idem_t6b_conf_del_ve",
	})
	if respDelVE.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE entryViaEntry = %d", respDelVE.StatusCode)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Simulate item soft-delete via gen queries (SoftDeleteLiveEntriesByItem + SoftDeleteItem with delete_batch).
	batchID := uuid.New()
	if _, err := q.SoftDeleteLiveEntriesByItem(ctx, gen.SoftDeleteLiveEntriesByItemParams{
		DeleteBatch: &batchID,
		UserID:      meA.User.ID,
		ItemID:      item1.ID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.SoftDeleteItem(ctx, gen.SoftDeleteItemParams{
		DeleteBatch: &batchID,
		UserID:      meA.User.ID,
		ID:          item1.ID,
	}); err != nil {
		t.Fatal(err)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// 1a. Restore entryViaItem (deleted_via='item') -> 409 entry_restore_via_item.
	respRestVI, rawRestVI := h.DoReq(jarA, http.MethodPost, "/api/v1/entries/"+idViaItem+"/restore", `{}`, contenttest.ReqOptions{
		IdemKey: "idem_t6b_conf_restore_vi_1",
	})
	if respRestVI.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, rawRestVI).Code != "entry_restore_via_item" {
		t.Fatalf("restore entry deleted_via='item' = %d %s, want 409 entry_restore_via_item", respRestVI.StatusCode, rawRestVI)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// 1b. Even if the item itself is live while an entry has deleted_via='item' + delete_batch,
	// restoring that entry directly still returns 409 entry_restore_via_item.
	if _, err := q.RestoreItem(ctx, gen.RestoreItemParams{
		EntryCount: 0,
		UserID:     meA.User.ID,
		ID:         item1.ID,
	}); err != nil {
		t.Fatal(err)
	}
	respRestVILiveItem, rawRestVILiveItem := h.DoReq(jarA, http.MethodPost, "/api/v1/entries/"+idViaItem+"/restore", `{}`, contenttest.ReqOptions{
		IdemKey: "idem_t6b_conf_restore_vi_2",
	})
	if respRestVILiveItem.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, rawRestVILiveItem).Code != "entry_restore_via_item" {
		t.Fatalf("restore entry deleted_via='item' on live item = %d %s, want 409 entry_restore_via_item", respRestVILiveItem.StatusCode, rawRestVILiveItem)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// 2. Re-delete item1 and try restoring entryViaEntry (which has deleted_via='entry') while item1 is deleted -> 409 item_deleted.
	if _, err := q.SoftDeleteItem(ctx, gen.SoftDeleteItemParams{
		DeleteBatch: &batchID,
		UserID:      meA.User.ID,
		ID:          item1.ID,
	}); err != nil {
		t.Fatal(err)
	}
	respRestItemDel, rawRestItemDel := h.DoReq(jarA, http.MethodPost, "/api/v1/entries/"+idViaEntry+"/restore", `{}`, contenttest.ReqOptions{
		IdemKey: "idem_t6b_conf_restore_item_deleted",
	})
	if respRestItemDel.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, rawRestItemDel).Code != "item_deleted" {
		t.Fatalf("restore entry when item is deleted = %d %s, want 409 item_deleted", respRestItemDel.StatusCode, rawRestItemDel)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// 3. Restore when the item is full (200 live entries) -> 409 item_entry_limit.
	h.Clock.Advance(2 * time.Second)
	itemFull := insertTestItem(t, h, meA.User.ID, "Full Item For Restore Limit")
	idToRestoreOnFull := uuid.NewString()
	sealedFull := sealEntryFixture(t, idToRestoreOnFull, vf.VaultKeyID, vf.VK, []byte("to delete then fail restore"), seqBytes(vault.WrapNonceBytes, 0xC3))
	respCreateFull, rawCreateFull := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemFull.ID.String()+"/entries",
		makeCreateBody(idToRestoreOnFull, entry.TypeText, sealedFull.EnvelopeRaw, sealedFull.CiphertextB64, sealedFull.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t6b_full_create_01"})
	if respCreateFull.StatusCode != http.StatusCreated {
		t.Fatalf("create entry on itemFull = %d %s", respCreateFull.StatusCode, rawCreateFull)
	}

	respDelFull, _ := h.DoReq(jarA, http.MethodDelete, "/api/v1/entries/"+idToRestoreOnFull, "", contenttest.ReqOptions{
		IdemKey: "idem_t6b_full_del_01",
	})
	if respDelFull.StatusCode != http.StatusNoContent {
		t.Fatalf("delete entry on itemFull = %d", respDelFull.StatusCode)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Seed 200 live entries on itemFull via gen queries.
	for i := range 200 {
		if _, err := q.InsertEntry(ctx, gen.InsertEntryParams{
			ID:                 uuid.New(),
			UserID:             meA.User.ID,
			ItemID:             itemFull.ID,
			Type:               entry.TypeText,
			Envelope:           []byte(sealedFull.EnvelopeRaw),
			Ciphertext:         sealedFull.CiphertextBytes,
			PlaintextLenBucket: sealedFull.PlaintextLenBucket,
		}); err != nil {
			t.Fatalf("seed full entry %d: %v", i, err)
		}
	}
	if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{
		Delta:  200,
		UserID: meA.User.ID,
		ID:     itemFull.ID,
	}); err != nil {
		t.Fatal(err)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	respRestFull, rawRestFull := h.DoReq(jarA, http.MethodPost, "/api/v1/entries/"+idToRestoreOnFull+"/restore", `{}`, contenttest.ReqOptions{
		IdemKey: "idem_t6b_full_restore_over_limit",
	})
	if respRestFull.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, rawRestFull).Code != "item_entry_limit" {
		t.Fatalf("restore when item has 200 live entries = %d %s, want 409 item_entry_limit", respRestFull.StatusCode, rawRestFull)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
}

// TestItemEntriesReorderPermutationMismatchVersionAndCrossUserIsolation covers Task 6b bullets 3, 4 & 5 (P04-A1, P04-A2):
//   - Reorder with a valid permutation -> 200 {entries:[{id, position}]} with positions 0..n-1;
//     GET /items/{id}/entries reflects the new order; updated_at bumps on all live rows so feed sees it;
//     version is NOT incremented.
//   - Reorder with [] on an item with 0 live entries -> 200 {entries:[]}.
//   - Missing ID, extra ID, empty [] when item has live entries, soft-deleted entry ID, entry ID from another item of same user,
//     or entry ID belonging to User B -> 409 reorder_mismatch, nothing written.
//   - Duplicate ID or malformed UUID -> 400 invalid_request, nothing written.
//   - Idempotent replay with same Idempotency-Key -> 200 + JSON-equal response (advisor-dec-135).
//   - User B: 404 not_found on DELETE /entries/{A}, POST /entries/{A}/restore, and PATCH /items/{A}/entries/reorder; nothing written.
//   - AssertInvariants after every case.
func TestItemEntriesReorderPermutationMismatchVersionAndCrossUserIsolation(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA, jarB, meB := h.SignupTwoUsers()
	vfA := createVaultForUser(t, h, jarA, 0x90)
	vfB := createVaultForUser(t, h, jarB, 0x98)

	itemA := insertTestItem(t, h, meA.User.ID, "Reorder Target Item A")
	itemAEmpty := insertTestItem(t, h, meA.User.ID, "Empty Item A")
	itemAOther := insertTestItem(t, h, meA.User.ID, "Other Item A")
	itemB := insertTestItem(t, h, meB.User.ID, "Item B")

	// 0. Reorder [] on an item with 0 live entries -> 200 {"entries":[]}.
	respEmpty, rawEmpty := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+itemAEmpty.ID.String()+"/entries/reorder",
		`{"entry_ids":[]}`, contenttest.ReqOptions{IdemKey: "idem_t6b_reorder_empty_ok"})
	if respEmpty.StatusCode != http.StatusOK {
		t.Fatalf("reorder empty item = %d %s, want 200", respEmpty.StatusCode, rawEmpty)
	}
	contenttest.AssertJSONEqual(t, `{"entries":[]}`, rawEmpty)
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Create 3 entries on itemA: e0 (pos 0), e1 (pos 1), e2 (pos 2), plus eDel (pos 3, then soft-deleted).
	createOnItem := func(jar contenttest.CookieJar, vf vaultFixture, itemID uuid.UUID, seed byte, idem string) entry.Meta {
		id := uuid.NewString()
		sealed := sealEntryFixture(t, id, vf.VaultKeyID, vf.VK, []byte{seed, 0x01, 0x02}, seqBytes(vault.WrapNonceBytes, seed))
		resp, raw := h.DoReq(jar, http.MethodPost, "/api/v1/items/"+itemID.String()+"/entries",
			makeCreateBody(id, entry.TypeText, sealed.EnvelopeRaw, sealed.CiphertextB64, sealed.PlaintextLenBucket),
			contenttest.ReqOptions{IdemKey: idem})
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("createOnItem(%s) = %d %s", idem, resp.StatusCode, raw)
		}
		var m entry.Meta
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			t.Fatal(err)
		}
		return m
	}

	e0 := createOnItem(jarA, vfA, itemA.ID, 0xD1, "idem_t6b_reorder_seed_e0")
	e1 := createOnItem(jarA, vfA, itemA.ID, 0xD2, "idem_t6b_reorder_seed_e1")
	e2 := createOnItem(jarA, vfA, itemA.ID, 0xD3, "idem_t6b_reorder_seed_e2")
	eDel := createOnItem(jarA, vfA, itemA.ID, 0xD4, "idem_t6b_reorder_seed_edel")
	eOtherItemA := createOnItem(jarA, vfA, itemAOther.ID, 0xD5, "idem_t6b_reorder_seed_eother")
	eUserB := createOnItem(jarB, vfB, itemB.ID, 0xD6, "idem_t6b_reorder_seed_eb")

	// Bump e1's version to 2 via PUT so we can verify reorder preserves version=2 on e1 and version=1 on e0, e2.
	sealedE1V2 := sealEntryFixture(t, e1.ID, vfA.VaultKeyID, vfA.VK, []byte("e1 v2 body"), seqBytes(vault.WrapNonceBytes, 0xD7))
	respPutE1, rawPutE1 := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+e1.ID,
		makeUpdateBody(sealedE1V2.EnvelopeRaw, sealedE1V2.CiphertextB64, sealedE1V2.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t6b_reorder_put_e1_v2", IfMatch: `"1"`})
	if respPutE1.StatusCode != http.StatusOK {
		t.Fatalf("PUT e1 v2 = %d %s", respPutE1.StatusCode, rawPutE1)
	}
	if err := json.Unmarshal([]byte(rawPutE1), &e1); err != nil {
		t.Fatal(err)
	}

	// Soft-delete eDel via DELETE /entries/{id}.
	respDelEDel, _ := h.DoReq(jarA, http.MethodDelete, "/api/v1/entries/"+eDel.ID, "", contenttest.ReqOptions{
		IdemKey: "idem_t6b_reorder_del_edel",
	})
	if respDelEDel.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE eDel = %d", respDelEDel.StatusCode)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, meB.User.ID)

	// Advance fake clock before mismatch batch (8 writes issued for User A in window 1).
	h.Clock.Advance(2 * time.Second)

	// 1. Mismatch cases (7 writes) -> 409 reorder_mismatch, nothing written.
	mismatchCases := []struct {
		name string
		ids  []string
	}{
		{name: "empty_when_live_exist", ids: []string{}},
		{name: "missing_one_live", ids: []string{e2.ID, e0.ID}},
		{name: "extra_unknown_id", ids: []string{e2.ID, e0.ID, e1.ID, uuid.NewString()}},
		{name: "includes_deleted_entry_of_same_item", ids: []string{e2.ID, e0.ID, e1.ID, eDel.ID}},
		{name: "replaces_live_with_deleted_entry", ids: []string{e2.ID, e0.ID, eDel.ID}},
		{name: "includes_entry_from_other_item_of_user_a", ids: []string{e2.ID, e0.ID, eOtherItemA.ID}},
		{name: "includes_entry_of_user_b", ids: []string{e2.ID, e0.ID, eUserB.ID}},
	}
	for i, tc := range mismatchCases {
		t.Run(tc.name, func(t *testing.T) {
			bodyBytes, _ := json.Marshal(map[string]any{"entry_ids": tc.ids})
			resp, raw := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+itemA.ID.String()+"/entries/reorder",
				string(bodyBytes), contenttest.ReqOptions{
					IdemKey: fmt.Sprintf("idem_t6b_reorder_mismatch_%02d", i),
				})
			if resp.StatusCode != http.StatusConflict {
				t.Fatalf("%s: status = %d (%s), want 409", tc.name, resp.StatusCode, raw)
			}
			if code := contenttest.DecodeProblem(t, raw).Code; code != "reorder_mismatch" {
				t.Fatalf("%s: code = %q, want reorder_mismatch", tc.name, code)
			}
			contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
		})
	}

	// Advance fake clock before badReqBodies batch so User A's 10 req/1s window is fresh!
	h.Clock.Advance(2 * time.Second)

	// 2. Duplicate ID or invalid request shape (5 writes) -> 400 invalid_request.
	badReqBodies := []string{
		fmt.Sprintf(`{"entry_ids":[%q,%q,%q]}`, e0.ID, e0.ID, e1.ID),
		`{"entry_ids":["not-a-uuid"]}`,
		`{"entry_ids":null}`,
		`{}`,
		`{"entry_ids":[],"extra":1}`,
	}
	for i, badBody := range badReqBodies {
		resp, raw := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+itemA.ID.String()+"/entries/reorder",
			badBody, contenttest.ReqOptions{
				IdemKey: fmt.Sprintf("idem_t6b_reorder_badreq_%02d", i),
			})
		if resp.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, raw).Code != "invalid_request" {
			t.Fatalf("bad reorder body %s = %d %s, want 400 invalid_request", badBody, resp.StatusCode, raw)
		}
	}

	h.Clock.Advance(2 * time.Second)

	// 3. Valid permutation [e2, e0, e1] -> 200 {entries: [{e2, 0}, {e0, 1}, {e1, 2}]}.
	reorderKey := "idem_t6b_reorder_valid_perm_01"
	reorderBody := fmt.Sprintf(`{"entry_ids":[%q,%q,%q]}`, e2.ID, e0.ID, e1.ID)
	respReorder, rawReorder := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+itemA.ID.String()+"/entries/reorder",
		reorderBody, contenttest.ReqOptions{IdemKey: reorderKey})
	if respReorder.StatusCode != http.StatusOK {
		t.Fatalf("PATCH reorder = %d %s, want 200", respReorder.StatusCode, rawReorder)
	}
	var reorderResp entry.ReorderResponse
	if err := json.Unmarshal([]byte(rawReorder), &reorderResp); err != nil {
		t.Fatal(err)
	}
	wantPositions := []entry.Position{
		{ID: e2.ID, Position: 0},
		{ID: e0.ID, Position: 1},
		{ID: e1.ID, Position: 2},
	}
	if len(reorderResp.Entries) != 3 {
		t.Fatalf("reorder response entries = %+v, want 3 entries", reorderResp.Entries)
	}
	for i, wp := range wantPositions {
		if reorderResp.Entries[i] != wp {
			t.Fatalf("reorderResp.Entries[%d] = %+v, want %+v", i, reorderResp.Entries[i], wp)
		}
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Idempotent replay of PATCH reorder -> 200 + JSON-equal response (advisor-dec-135).
	respReorderReplay, rawReorderReplay := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+itemA.ID.String()+"/entries/reorder",
		reorderBody, contenttest.ReqOptions{IdemKey: reorderKey})
	if respReorderReplay.StatusCode != http.StatusOK {
		t.Fatalf("reorder idempotent replay = %d %s, want 200", respReorderReplay.StatusCode, rawReorderReplay)
	}
	contenttest.AssertJSONEqual(t, rawReorder, rawReorderReplay)

	// Verify GET /items/{itemA}/entries returns [e2 (pos 0, v1), e0 (pos 1, v1), e1 (pos 2, v2)]
	// and updated_at bumped on all three rows while version did NOT increment.
	respListAfter, rawListAfter := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+itemA.ID.String()+"/entries", "", contenttest.ReqOptions{})
	if respListAfter.StatusCode != http.StatusOK {
		t.Fatalf("GET /items/{itemA}/entries = %d %s", respListAfter.StatusCode, rawListAfter)
	}
	var listAfter entry.MetaList
	if err := json.Unmarshal([]byte(rawListAfter), &listAfter); err != nil {
		t.Fatal(err)
	}
	if len(listAfter.Items) != 3 {
		t.Fatalf("listAfter len = %d, want 3", len(listAfter.Items))
	}
	if listAfter.Items[0].ID != e2.ID || listAfter.Items[0].Position != 0 || listAfter.Items[0].Version != 1 || listAfter.Items[0].UpdatedAt <= e2.UpdatedAt {
		t.Fatalf("e2 after reorder = %+v (prev updated_at=%s), want pos=0 version=1 and bumped updated_at", listAfter.Items[0], e2.UpdatedAt)
	}
	if listAfter.Items[1].ID != e0.ID || listAfter.Items[1].Position != 1 || listAfter.Items[1].Version != 1 || listAfter.Items[1].UpdatedAt <= e0.UpdatedAt {
		t.Fatalf("e0 after reorder = %+v (prev updated_at=%s), want pos=1 version=1 and bumped updated_at", listAfter.Items[1], e0.UpdatedAt)
	}
	if listAfter.Items[2].ID != e1.ID || listAfter.Items[2].Position != 2 || listAfter.Items[2].Version != 2 || listAfter.Items[2].UpdatedAt <= e1.UpdatedAt {
		t.Fatalf("e1 after reorder = %+v (prev updated_at=%s), want pos=2 version=2 and bumped updated_at", listAfter.Items[2], e1.UpdatedAt)
	}

	// 4. Cross-user isolation (User B on User A's entry/item -> 404 not_found, nothing written).
	// User B tries DELETE on A's live entry e0 and soft-deleted entry eDel -> 404 not_found.
	for i, targetID := range []string{e0.ID, eDel.ID} {
		respBDel, rawBDel := h.DoReq(jarB, http.MethodDelete, "/api/v1/entries/"+targetID, "", contenttest.ReqOptions{
			IdemKey: fmt.Sprintf("idem_t6b_b_del_a_%02d", i),
		})
		if respBDel.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawBDel).Code != "not_found" {
			t.Fatalf("User B DELETE A's entry %s = %d %s, want 404 not_found", targetID, respBDel.StatusCode, rawBDel)
		}
	}

	// User B tries POST /entries/{id}/restore on A's soft-deleted entry eDel and live entry e0 -> 404 not_found.
	for i, targetID := range []string{eDel.ID, e0.ID} {
		respBRest, rawBRest := h.DoReq(jarB, http.MethodPost, "/api/v1/entries/"+targetID+"/restore", `{}`, contenttest.ReqOptions{
			IdemKey: fmt.Sprintf("idem_t6b_b_restore_a_%02d", i),
		})
		if respBRest.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawBRest).Code != "not_found" {
			t.Fatalf("User B restore A's entry %s = %d %s, want 404 not_found", targetID, respBRest.StatusCode, rawBRest)
		}
	}

	// User B tries PATCH /items/{itemA}/entries/reorder -> 404 not_found.
	respBReorder, rawBReorder := h.DoReq(jarB, http.MethodPatch, "/api/v1/items/"+itemA.ID.String()+"/entries/reorder",
		fmt.Sprintf(`{"entry_ids":[%q,%q,%q]}`, e0.ID, e1.ID, e2.ID),
		contenttest.ReqOptions{IdemKey: "idem_t6b_b_reorder_a_01"})
	if respBReorder.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawBReorder).Code != "not_found" {
		t.Fatalf("User B reorder A's item = %d %s, want 404 not_found", respBReorder.StatusCode, rawBReorder)
	}

	logs := h.Logs.String()
	if !strings.Contains(logs, `"/api/v1/entries/{id}/restore"`) || !strings.Contains(logs, `"/api/v1/items/{id}/entries/reorder"`) {
		t.Fatalf("access log missing Task 6b route patterns:\n%s", logs)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, meB.User.ID)
}

// TestItemEntriesReorderBodyLimit16KiBPreLookup covers EA6b-R1-1 (SPEC §9.2, OpenAPI itemEntriesReorder, plan §2.3):
//   - PATCH /items/{id}/entries/reorder is mounted through ChainItemTagWrite (16 KiB pre-Lookup limit -> 413 invalid_request).
//   - A valid reorder JSON body padded to exact 16 KiB (16,384 B) with Content-Length and with Transfer-Encoding: chunked
//     reaches the handler, returns 200 OK, updates positions, and persists the idempotency row.
//   - A reorder body of 16 KiB + 1 (16,385 B) with Content-Length and with Transfer-Encoding: chunked is rejected with
//     413 invalid_request BEFORE Idempotency.Lookup / rate-limit / Claim:
//     0 idempotency_key rows created, 0 rate_event rows added for content_write, and entry positions/timestamps untouched.
//   - A reorder body of 16 KiB + 1 sent with an existing committed Idempotency-Key still returns 413 invalid_request
//     before Idempotency.Lookup (does not replay 200 or return 409 idempotency_key_reused).
//   - AssertInvariants after every case.
func TestItemEntriesReorderBodyLimit16KiBPreLookup(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA := h.SignupUser("entry-reorder-16k@example.com", "correct-horse-battery-staple-a")
	vfA := createVaultForUser(t, h, jarA, 0xA0)
	itemA := insertTestItem(t, h, meA.User.ID, "Reorder 16KiB Limit Item")

	id0 := uuid.NewString()
	sealed0 := sealEntryFixture(t, id0, vfA.VaultKeyID, vfA.VK, []byte("reorder limit e0"), seqBytes(vault.WrapNonceBytes, 0xE1))
	resp0, raw0 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries",
		makeCreateBody(id0, entry.TypeText, sealed0.EnvelopeRaw, sealed0.CiphertextB64, sealed0.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t6b_16k_seed_e0"})
	if resp0.StatusCode != http.StatusCreated {
		t.Fatalf("seed e0 = %d %s", resp0.StatusCode, raw0)
	}

	id1 := uuid.NewString()
	sealed1 := sealEntryFixture(t, id1, vfA.VaultKeyID, vfA.VK, []byte("reorder limit e1"), seqBytes(vault.WrapNonceBytes, 0xE2))
	resp1, raw1 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries",
		makeCreateBody(id1, entry.TypeText, sealed1.EnvelopeRaw, sealed1.CiphertextB64, sealed1.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t6b_16k_seed_e1"})
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("seed e1 = %d %s", resp1.StatusCode, raw1)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	ctx := context.Background()
	countIdemKey := func(key string) int {
		t.Helper()
		var n int
		if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, meA.User.ID, key).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	countContentWriteEvents := func() int {
		t.Helper()
		var n int
		if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM rate_event WHERE scope = $1`, string(httpx.ScopeContentWrite)).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	makePaddedReorderBody := func(ids []string, targetLen int) string {
		t.Helper()
		base, err := json.Marshal(map[string]any{"entry_ids": ids})
		if err != nil {
			t.Fatal(err)
		}
		if len(base) > targetLen {
			t.Fatalf("base reorder JSON len %d > targetLen %d", len(base), targetLen)
		}
		padded := string(base) + strings.Repeat(" ", targetLen-len(base))
		if len(padded) != targetLen {
			t.Fatalf("padded len = %d, want %d", len(padded), targetLen)
		}
		return padded
	}

	reorderPath := "/api/v1/items/" + itemA.ID.String() + "/entries/reorder"
	limitBytes := int(httpx.ContentItemTagJSONLimit) // 16,384 B (16 KiB)
	overBytes := limitBytes + 1                      // 16,385 B (16 KiB + 1)

	// 1. Over-limit (16 KiB + 1) with Content-Length and with chunked encoding -> 413 invalid_request before Lookup/rate-limit/Claim.
	eventsBeforeOver := countContentWriteEvents()
	overBody := makePaddedReorderBody([]string{id1, id0}, overBytes)
	for _, chunked := range []bool{false, true} {
		mode := "cl"
		if chunked {
			mode = "chunked"
		}
		idemKey := "idem_t6b_reorder_16k_over_" + mode
		respOver, rawOver := h.DoReq(jarA, http.MethodPatch, reorderPath, overBody, contenttest.ReqOptions{
			IdemKey: idemKey,
			Chunked: chunked,
		})
		if respOver.StatusCode != http.StatusRequestEntityTooLarge {
			t.Fatalf("reorder 16 KiB+1 (%s): status = %d (%s), want 413", mode, respOver.StatusCode, rawOver)
		}
		if code := contenttest.DecodeProblem(t, rawOver).Code; code != "invalid_request" {
			t.Fatalf("reorder 16 KiB+1 (%s): code = %q, want invalid_request", mode, code)
		}
		if got := countIdemKey(idemKey); got != 0 {
			t.Fatalf("reorder 16 KiB+1 (%s): idempotency rows = %d, want 0 (must reject before Lookup/Claim)", mode, got)
		}
		if got := countContentWriteEvents(); got != eventsBeforeOver {
			t.Fatalf("reorder 16 KiB+1 (%s): rate_event count = %d, want %d (must reject before rate limit)", mode, got, eventsBeforeOver)
		}
		contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
	}

	// Verify entry positions [id0@0, id1@1] were not modified by the rejected 16 KiB + 1 requests.
	respListBefore, rawListBefore := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+itemA.ID.String()+"/entries", "", contenttest.ReqOptions{})
	if respListBefore.StatusCode != http.StatusOK {
		t.Fatalf("GET entries after 413 = %d %s", respListBefore.StatusCode, rawListBefore)
	}
	var listBefore entry.MetaList
	if err := json.Unmarshal([]byte(rawListBefore), &listBefore); err != nil {
		t.Fatal(err)
	}
	if len(listBefore.Items) != 2 || listBefore.Items[0].ID != id0 || listBefore.Items[0].Position != 0 || listBefore.Items[1].ID != id1 || listBefore.Items[1].Position != 1 {
		t.Fatalf("entries after 413 were modified: %+v", listBefore.Items)
	}

	// 2. Exact 16 KiB (16,384 B) with Content-Length and with chunked encoding -> reaches handler, returns 200 OK.
	exactBodyCL := makePaddedReorderBody([]string{id1, id0}, limitBytes)
	keyExactCL := "idem_t6b_reorder_16k_exact_cl"
	respExactCL, rawExactCL := h.DoReq(jarA, http.MethodPatch, reorderPath, exactBodyCL, contenttest.ReqOptions{
		IdemKey: keyExactCL,
		Chunked: false,
	})
	if respExactCL.StatusCode != http.StatusOK {
		t.Fatalf("reorder exact 16 KiB (cl): status = %d (%s), want 200", respExactCL.StatusCode, rawExactCL)
	}
	if got := countIdemKey(keyExactCL); got != 1 {
		t.Fatalf("reorder exact 16 KiB (cl): idempotency rows = %d, want 1", got)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	exactBodyChunked := makePaddedReorderBody([]string{id0, id1}, limitBytes)
	keyExactChunked := "idem_t6b_reorder_16k_exact_chunked"
	respExactChunked, rawExactChunked := h.DoReq(jarA, http.MethodPatch, reorderPath, exactBodyChunked, contenttest.ReqOptions{
		IdemKey: keyExactChunked,
		Chunked: true,
	})
	if respExactChunked.StatusCode != http.StatusOK {
		t.Fatalf("reorder exact 16 KiB (chunked): status = %d (%s), want 200", respExactChunked.StatusCode, rawExactChunked)
	}
	if got := countIdemKey(keyExactChunked); got != 1 {
		t.Fatalf("reorder exact 16 KiB (chunked): idempotency rows = %d, want 1", got)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// 3. Over-limit (16 KiB + 1) reusing an EXISTING committed Idempotency-Key (keyExactCL) ->
	// still rejected with 413 invalid_request BEFORE Idempotency.Lookup (neither replays 200 nor returns 409 conflict).
	for _, chunked := range []bool{false, true} {
		respOverExisting, rawOverExisting := h.DoReq(jarA, http.MethodPatch, reorderPath, overBody, contenttest.ReqOptions{
			IdemKey: keyExactCL,
			Chunked: chunked,
		})
		if respOverExisting.StatusCode != http.StatusRequestEntityTooLarge || contenttest.DecodeProblem(t, rawOverExisting).Code != "invalid_request" {
			t.Fatalf("reorder 16 KiB+1 with existing key (chunked=%v) = %d %s, want 413 invalid_request before Lookup",
				chunked, respOverExisting.StatusCode, rawOverExisting)
		}
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
}

// TestEntryRestoreAfterReorderShiftsCollidingLivePositions covers EA6b-R1-2 (advisor-dec-160):
//   - Exact 2-entry sequence: create A@0, B@1; DELETE A; reorder [B] -> B@0; restore A -> A@0, B@1 (no tie),
//     B.version unchanged, B.updated_at bumped (so Task 7 changes feed sees the shifted row).
//   - 3-entry cascading variant: create A@0, B@1, C@2; DELETE A@0; reorder [B, C] -> B@0, C@1;
//     restore A -> A@0, B@1, C@2 (shift cascades across B and C in one UPDATE, both updated_at bumped, versions unchanged).
//   - 3-entry middle-slot variant: from [A@0, B@1, C@2], DELETE B@1; reorder [A, C] -> A@0, C@1;
//     restore B -> A@0, B@1, C@2 (C@1 shifts to C@2 with updated_at bumped, while A@0 < 1 is untouched).
//   - AssertInvariants after each step.
func TestEntryRestoreAfterReorderShiftsCollidingLivePositions(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA := h.SignupUser("entry-restore-shift@example.com", "correct-horse-battery-staple-a")
	vfA := createVaultForUser(t, h, jarA, 0xB0)

	ctx := context.Background()
	q := gen.New(h.Pool)

	createEntry := func(itemID uuid.UUID, seed byte, idem string) entry.Meta {
		t.Helper()
		id := uuid.NewString()
		sealed := sealEntryFixture(t, id, vfA.VaultKeyID, vfA.VK, []byte{seed, 0x10, 0x20}, seqBytes(vault.WrapNonceBytes, seed))
		resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemID.String()+"/entries",
			makeCreateBody(id, entry.TypeText, sealed.EnvelopeRaw, sealed.CiphertextB64, sealed.PlaintextLenBucket),
			contenttest.ReqOptions{IdemKey: idem})
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("createEntry(%s) = %d %s", idem, resp.StatusCode, raw)
		}
		var m entry.Meta
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			t.Fatal(err)
		}
		contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
		return m
	}

	// =========================================================================
	// Part 1: Exact 2-entry sequence (create A@0, B@1; delete A; reorder [B] -> B@0; restore A -> A@0, B@1)
	// =========================================================================
	item2 := insertTestItem(t, h, meA.User.ID, "Two Entry Restore Shift Item")
	a := createEntry(item2.ID, 0x11, "idem_t6b_r12_2e_create_a")
	b := createEntry(item2.ID, 0x12, "idem_t6b_r12_2e_create_b")
	if a.Position != 0 || b.Position != 1 {
		t.Fatalf("initial positions = (%d, %d), want (0, 1)", a.Position, b.Position)
	}

	// Bump B to version=2 via PUT so we can verify B.version=2 is preserved across both reorder and restore shift.
	sealedBV2 := sealEntryFixture(t, b.ID, vfA.VaultKeyID, vfA.VK, []byte("b v2 body"), seqBytes(vault.WrapNonceBytes, 0x13))
	respPutB, rawPutB := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+b.ID,
		makeUpdateBody(sealedBV2.EnvelopeRaw, sealedBV2.CiphertextB64, sealedBV2.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t6b_r12_2e_put_b_v2", IfMatch: `"1"`})
	if respPutB.StatusCode != http.StatusOK {
		t.Fatalf("PUT B v2 = %d %s", respPutB.StatusCode, rawPutB)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Delete A (pos 0).
	respDelA, _ := h.DoReq(jarA, http.MethodDelete, "/api/v1/entries/"+a.ID, "", contenttest.ReqOptions{
		IdemKey: "idem_t6b_r12_2e_del_a",
	})
	if respDelA.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE A = %d", respDelA.StatusCode)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Reorder [B] -> B moves to position 0.
	respReordB, rawReordB := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+item2.ID.String()+"/entries/reorder",
		fmt.Sprintf(`{"entry_ids":[%q]}`, b.ID),
		contenttest.ReqOptions{IdemKey: "idem_t6b_r12_2e_reorder_b"})
	if respReordB.StatusCode != http.StatusOK {
		t.Fatalf("reorder [B] = %d %s", respReordB.StatusCode, rawReordB)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	rowBAfterReorder, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{
		UserID: meA.User.ID,
		ID:     uuid.MustParse(b.ID),
	})
	if err != nil {
		t.Fatal(err)
	}
	if rowBAfterReorder.Position != 0 || rowBAfterReorder.Version != 2 {
		t.Fatalf("B after reorder: pos=%d version=%d, want pos=0 version=2", rowBAfterReorder.Position, rowBAfterReorder.Version)
	}

	// Restore A -> A is restored at 0, B is shifted to 1 with updated_at bumped and version=2 unchanged.
	respRestA, rawRestA := h.DoReq(jarA, http.MethodPost, "/api/v1/entries/"+a.ID+"/restore", `{}`, contenttest.ReqOptions{
		IdemKey: "idem_t6b_r12_2e_restore_a",
	})
	if respRestA.StatusCode != http.StatusOK {
		t.Fatalf("restore A = %d %s", respRestA.StatusCode, rawRestA)
	}
	var metaARestored entry.Meta
	if err := json.Unmarshal([]byte(rawRestA), &metaARestored); err != nil {
		t.Fatal(err)
	}
	if metaARestored.ID != a.ID || metaARestored.Position != 0 || metaARestored.Version != 1 {
		t.Fatalf("restored A meta = %+v, want id=%s pos=0 version=1", metaARestored, a.ID)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	rowBAfterRestoreA, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{
		UserID: meA.User.ID,
		ID:     uuid.MustParse(b.ID),
	})
	if err != nil {
		t.Fatal(err)
	}
	if rowBAfterRestoreA.Position != 1 {
		t.Fatalf("B position after restore A = %d, want 1 (shifted +1)", rowBAfterRestoreA.Position)
	}
	if rowBAfterRestoreA.Version != 2 {
		t.Fatalf("B version after restore A = %d, want 2 (unchanged)", rowBAfterRestoreA.Version)
	}
	if !rowBAfterRestoreA.UpdatedAt.Time.After(rowBAfterReorder.UpdatedAt.Time) {
		t.Fatalf("expected B.updated_at (%v) to advance after restore shift (was %v)",
			rowBAfterRestoreA.UpdatedAt.Time, rowBAfterReorder.UpdatedAt.Time)
	}

	// Verify GET /items/{item2}/entries returns [A@0, B@1] with no tie.
	respList2, rawList2 := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+item2.ID.String()+"/entries", "", contenttest.ReqOptions{})
	if respList2.StatusCode != http.StatusOK {
		t.Fatalf("GET item2 entries = %d %s", respList2.StatusCode, rawList2)
	}
	var list2 entry.MetaList
	if err := json.Unmarshal([]byte(rawList2), &list2); err != nil {
		t.Fatal(err)
	}
	if len(list2.Items) != 2 ||
		list2.Items[0].ID != a.ID || list2.Items[0].Position != 0 || list2.Items[0].Version != 1 ||
		list2.Items[1].ID != b.ID || list2.Items[1].Position != 1 || list2.Items[1].Version != 2 {
		t.Fatalf("item2 entries after restore A = %+v, want [A@0 v1, B@1 v2]", list2.Items)
	}

	// =========================================================================
	// Part 2: 3-entry cascading shift variant (create A3@0, B3@1, C3@2; delete A3; reorder [B3, C3] -> B3@0, C3@1; restore A3 -> A3@0, B3@1, C3@2)
	// =========================================================================
	h.Clock.Advance(2 * time.Second)
	item3 := insertTestItem(t, h, meA.User.ID, "Three Entry Cascading Shift Item")
	a3 := createEntry(item3.ID, 0x21, "idem_t6b_r12_3e_create_a")
	b3 := createEntry(item3.ID, 0x22, "idem_t6b_r12_3e_create_b")
	c3 := createEntry(item3.ID, 0x23, "idem_t6b_r12_3e_create_c")

	// Bump C3 to version=2 via PUT.
	sealedC3V2 := sealEntryFixture(t, c3.ID, vfA.VaultKeyID, vfA.VK, []byte("c3 v2 body"), seqBytes(vault.WrapNonceBytes, 0x24))
	respPutC3, rawPutC3 := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+c3.ID,
		makeUpdateBody(sealedC3V2.EnvelopeRaw, sealedC3V2.CiphertextB64, sealedC3V2.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_t6b_r12_3e_put_c_v2", IfMatch: `"1"`})
	if respPutC3.StatusCode != http.StatusOK {
		t.Fatalf("PUT C3 v2 = %d %s", respPutC3.StatusCode, rawPutC3)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Delete A3 (pos 0).
	respDelA3, _ := h.DoReq(jarA, http.MethodDelete, "/api/v1/entries/"+a3.ID, "", contenttest.ReqOptions{
		IdemKey: "idem_t6b_r12_3e_del_a",
	})
	if respDelA3.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE A3 = %d", respDelA3.StatusCode)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Reorder [B3, C3] -> B3@0, C3@1.
	respReordBC, rawReordBC := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+item3.ID.String()+"/entries/reorder",
		fmt.Sprintf(`{"entry_ids":[%q,%q]}`, b3.ID, c3.ID),
		contenttest.ReqOptions{IdemKey: "idem_t6b_r12_3e_reorder_bc"})
	if respReordBC.StatusCode != http.StatusOK {
		t.Fatalf("reorder [B3, C3] = %d %s", respReordBC.StatusCode, rawReordBC)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	rowB3Before, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{UserID: meA.User.ID, ID: uuid.MustParse(b3.ID)})
	if err != nil {
		t.Fatal(err)
	}
	rowC3Before, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{UserID: meA.User.ID, ID: uuid.MustParse(c3.ID)})
	if err != nil {
		t.Fatal(err)
	}

	// Restore A3 -> cascades shift across both B3 (0->1) and C3 (1->2).
	respRestA3, rawRestA3 := h.DoReq(jarA, http.MethodPost, "/api/v1/entries/"+a3.ID+"/restore", `{}`, contenttest.ReqOptions{
		IdemKey: "idem_t6b_r12_3e_restore_a",
	})
	if respRestA3.StatusCode != http.StatusOK {
		t.Fatalf("restore A3 = %d %s", respRestA3.StatusCode, rawRestA3)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	rowB3After, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{UserID: meA.User.ID, ID: uuid.MustParse(b3.ID)})
	if err != nil {
		t.Fatal(err)
	}
	rowC3After, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{UserID: meA.User.ID, ID: uuid.MustParse(c3.ID)})
	if err != nil {
		t.Fatal(err)
	}
	if rowB3After.Position != 1 || rowB3After.Version != 1 || !rowB3After.UpdatedAt.Time.After(rowB3Before.UpdatedAt.Time) {
		t.Fatalf("B3 after cascading restore = (pos=%d, v=%d, updated=%v vs %v), want pos=1 v=1 and bumped updated_at",
			rowB3After.Position, rowB3After.Version, rowB3After.UpdatedAt.Time, rowB3Before.UpdatedAt.Time)
	}
	if rowC3After.Position != 2 || rowC3After.Version != 2 || !rowC3After.UpdatedAt.Time.After(rowC3Before.UpdatedAt.Time) {
		t.Fatalf("C3 after cascading restore = (pos=%d, v=%d, updated=%v vs %v), want pos=2 v=2 and bumped updated_at",
			rowC3After.Position, rowC3After.Version, rowC3After.UpdatedAt.Time, rowC3Before.UpdatedAt.Time)
	}

	// =========================================================================
	// Part 3: Middle-slot shift on item3 (delete B3@1; reorder [A3, C3] -> A3@0, C3@1; restore B3@1 -> A3@0 untouched, B3@1, C3@2 shifted)
	// =========================================================================
	h.Clock.Advance(2 * time.Second)
	respDelB3, _ := h.DoReq(jarA, http.MethodDelete, "/api/v1/entries/"+b3.ID, "", contenttest.ReqOptions{
		IdemKey: "idem_t6b_r12_3e_del_b_mid",
	})
	if respDelB3.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE B3 = %d", respDelB3.StatusCode)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	respReordAC, rawReordAC := h.DoReq(jarA, http.MethodPatch, "/api/v1/items/"+item3.ID.String()+"/entries/reorder",
		fmt.Sprintf(`{"entry_ids":[%q,%q]}`, a3.ID, c3.ID),
		contenttest.ReqOptions{IdemKey: "idem_t6b_r12_3e_reorder_ac"})
	if respReordAC.StatusCode != http.StatusOK {
		t.Fatalf("reorder [A3, C3] = %d %s", respReordAC.StatusCode, rawReordAC)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	rowA3BeforeMid, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{UserID: meA.User.ID, ID: uuid.MustParse(a3.ID)})
	if err != nil {
		t.Fatal(err)
	}
	rowC3BeforeMid, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{UserID: meA.User.ID, ID: uuid.MustParse(c3.ID)})
	if err != nil {
		t.Fatal(err)
	}

	respRestB3, rawRestB3 := h.DoReq(jarA, http.MethodPost, "/api/v1/entries/"+b3.ID+"/restore", `{}`, contenttest.ReqOptions{
		IdemKey: "idem_t6b_r12_3e_restore_b_mid",
	})
	if respRestB3.StatusCode != http.StatusOK {
		t.Fatalf("restore B3 = %d %s", respRestB3.StatusCode, rawRestB3)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	rowA3AfterMid, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{UserID: meA.User.ID, ID: uuid.MustParse(a3.ID)})
	if err != nil {
		t.Fatal(err)
	}
	rowC3AfterMid, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{UserID: meA.User.ID, ID: uuid.MustParse(c3.ID)})
	if err != nil {
		t.Fatal(err)
	}
	// A3 at pos 0 (< restored pos 1) must NOT be shifted or have updated_at bumped.
	if rowA3AfterMid.Position != 0 || !rowA3AfterMid.UpdatedAt.Time.Equal(rowA3BeforeMid.UpdatedAt.Time) {
		t.Fatalf("A3 (pos < 1) was unexpectedly modified: pos=%d updated_at=%v (was %v)",
			rowA3AfterMid.Position, rowA3AfterMid.UpdatedAt.Time, rowA3BeforeMid.UpdatedAt.Time)
	}
	// C3 at pos 1 (>= restored pos 1) must shift to 2 and have updated_at bumped, version=2 unchanged.
	if rowC3AfterMid.Position != 2 || rowC3AfterMid.Version != 2 || !rowC3AfterMid.UpdatedAt.Time.After(rowC3BeforeMid.UpdatedAt.Time) {
		t.Fatalf("C3 (pos >= 1) after mid restore = (pos=%d, v=%d, updated=%v vs %v), want pos=2 v=2 and bumped updated_at",
			rowC3AfterMid.Position, rowC3AfterMid.Version, rowC3AfterMid.UpdatedAt.Time, rowC3BeforeMid.UpdatedAt.Time)
	}

	respList3, rawList3 := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+item3.ID.String()+"/entries", "", contenttest.ReqOptions{})
	if respList3.StatusCode != http.StatusOK {
		t.Fatalf("GET item3 entries = %d %s", respList3.StatusCode, rawList3)
	}
	var list3 entry.MetaList
	if err := json.Unmarshal([]byte(rawList3), &list3); err != nil {
		t.Fatal(err)
	}
	if len(list3.Items) != 3 ||
		list3.Items[0].ID != a3.ID || list3.Items[0].Position != 0 || list3.Items[0].Version != 1 ||
		list3.Items[1].ID != b3.ID || list3.Items[1].Position != 1 || list3.Items[1].Version != 1 ||
		list3.Items[2].ID != c3.ID || list3.Items[2].Position != 2 || list3.Items[2].Version != 2 {
		t.Fatalf("item3 final entries = %+v, want [A3@0 v1, B3@1 v1, C3@2 v2]", list3.Items)
	}
}
