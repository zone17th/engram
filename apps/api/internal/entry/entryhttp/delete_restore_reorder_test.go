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
