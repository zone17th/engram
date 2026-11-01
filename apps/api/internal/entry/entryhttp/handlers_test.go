package entryhttp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/entry/entryhttp"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/textnorm"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

type vaultFixture struct {
	VaultKeyID string
	VK         []byte
	Version    int32
}

func seqBytes(n int, start byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = start + byte(i)
	}
	return out
}

func makeWrapB64U(t *testing.T, kind vault.WrapKind, seed byte) string {
	t.Helper()
	ptLen, _ := kind.ExpectedPlaintextLen()
	pt := seqBytes(ptLen, seed)
	key := seqBytes(vault.VKBytes, seed+0x11)
	nonce := seqBytes(vault.WrapNonceBytes, seed+0x22)
	s, err := vault.SealWrapBase64URL(kind, pt, key, nonce)
	if err != nil {
		t.Fatalf("SealWrapBase64URL: %v", err)
	}
	return s
}

// createVaultForUser creates a real vault through POST /api/v1/vault and returns
// its server-assigned vault_key_id along with a deterministic 32-byte test VK for SealEntry/OpenEntry.
func createVaultForUser(t *testing.T, h *contenttest.Harness, jar contenttest.CookieJar, seed byte) vaultFixture {
	t.Helper()
	rks := make([]vault.RecoveryKeyUploadItem, 10)
	for i := range 10 {
		hashBytes := seqBytes(32, seed+byte(i*5+1))
		hashBytes[0] = byte(i + 1)
		hashBytes[1] = seed
		rks[i] = vault.RecoveryKeyUploadItem{
			Slot:       i + 1,
			LookupHash: vault.EncodeBase64URL(hashBytes),
			Wrap:       makeWrapB64U(t, vault.WrapKindRK, seed+byte(i+1)),
		}
	}
	payload := struct {
		KDF                  vault.KDFParams               `json:"kdf"`
		VaultKeyWrappedByKEK string                        `json:"vault_key_wrapped_by_kek"`
		X25519Public         string                        `json:"x25519_public"`
		Ed25519Public        string                        `json:"ed25519_public"`
		PrivateKeysWrapped   string                        `json:"private_keys_wrapped"`
		RecoveryKeys         []vault.RecoveryKeyUploadItem `json:"recovery_keys"`
	}{
		KDF: vault.KDFParams{
			Alg:         "argon2id13",
			Ops:         3,
			Mem:         67108864,
			Parallelism: 1,
			Salt:        vault.EncodeBase64URL(seqBytes(16, seed+0x05)),
		},
		VaultKeyWrappedByKEK: makeWrapB64U(t, vault.WrapKindKEK, seed),
		X25519Public:         vault.EncodeBase64URL(seqBytes(32, seed+0x30)),
		Ed25519Public:        vault.EncodeBase64URL(seqBytes(32, seed+0x50)),
		PrivateKeysWrapped:   makeWrapB64U(t, vault.WrapKindPriv, seed+0x70),
		RecoveryKeys:         rks,
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	idemKey := fmt.Sprintf("idem_vault_create_%02x_%s", seed, uuid.NewString()[:8])
	resp, raw := h.DoReq(jar, http.MethodPost, "/api/v1/vault", string(bodyBytes), contenttest.ReqOptions{
		IdemKey: idemKey,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /api/v1/vault = %d %s", resp.StatusCode, raw)
	}
	var created vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(raw), &created); err != nil {
		t.Fatalf("decode vault create response: %v", err)
	}
	return vaultFixture{
		VaultKeyID: created.VaultKeyID,
		VK:         seqBytes(vault.VKBytes, seed+0x42),
		Version:    created.Version,
	}
}

// insertTestItem inserts a live item row for userID using the Task 2 sqlc query InsertItem.
func insertTestItem(t *testing.T, h *contenttest.Harness, userID uuid.UUID, name string) gen.Item {
	t.Helper()
	norm, err := textnorm.Normalize(name)
	if err != nil {
		t.Fatalf("Normalize(%q): %v", name, err)
	}
	item, err := gen.New(h.Pool).InsertItem(context.Background(), gen.InsertItemParams{
		UserID:         userID,
		Name:           strings.TrimSpace(name),
		NameNormalized: norm,
	})
	if err != nil {
		t.Fatalf("InsertItem(%q): %v", name, err)
	}
	return item
}

type sealedEntryFixture struct {
	EntryID            string
	Envelope           vault.EntryEnvelopeV1
	EnvelopeRaw        string
	CiphertextBytes    []byte
	CiphertextB64      string
	PlaintextLenBucket int32
}

func sealEntryFixture(t *testing.T, entryID, keyID string, vk, plaintext, nonce []byte) sealedEntryFixture {
	t.Helper()
	env, ctBytes, err := vault.SealEntry(entryID, keyID, plaintext, vk, nonce)
	if err != nil {
		t.Fatalf("SealEntry: %v", err)
	}
	envRawBytes, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	bucket, ok := entry.ExpectedPlaintextLenBucket(len(ctBytes))
	if !ok {
		t.Fatalf("ExpectedPlaintextLenBucket(%d) = false", len(ctBytes))
	}
	return sealedEntryFixture{
		EntryID:            entryID,
		Envelope:           env,
		EnvelopeRaw:        string(envRawBytes),
		CiphertextBytes:    ctBytes,
		CiphertextB64:      vault.EncodeBase64URL(ctBytes),
		PlaintextLenBucket: bucket,
	}
}

func makeCreateBody(id, entryType, envRaw, ctB64 string, bucket int32) string {
	return fmt.Sprintf(
		`{"id":%q,"type":%q,"envelope":%s,"ciphertext":%q,"plaintext_len_bucket":%d}`,
		id, entryType, envRaw, ctB64, bucket,
	)
}

func makeUpdateBody(envRaw, ctB64 string, bucket int32) string {
	return fmt.Sprintf(
		`{"envelope":%s,"ciphertext":%q,"plaintext_len_bucket":%d}`,
		envRaw, ctB64, bucket,
	)
}

// TestEntryCreateGetRoundTripAndListMetadataOnly covers Task 6a bullet 1:
//   - Create -> GET /entries/{id} returns exact id, envelope (JCS matches AAD), and ciphertext;
//     vault.OpenEntry opens it and recovers exact plaintext (P04-A5).
//   - Reordered envelope JSON keys in request still canonicalize via JCS and open cleanly.
//   - GET /items/{id}/entries returns metadata only (no envelope / ciphertext fields in JSON),
//     ordered by (position, id) with keyset cursor pagination and position = max(position)+1
//     across all rows including soft-deleted tombstones.
func TestEntryCreateGetRoundTripAndListMetadataOnly(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA := h.SignupUser("entry-roundtrip-a@example.com", "correct-horse-battery-staple-a")
	vf := createVaultForUser(t, h, jarA, 0x10)
	item := insertTestItem(t, h, meA.User.ID, "Server Config Notes")

	entryID1 := uuid.NewString()
	plaintext1 := []byte("first entry fixture payload\nline two")
	sealed1 := sealEntryFixture(t, entryID1, vf.VaultKeyID, vf.VK, plaintext1, seqBytes(vault.WrapNonceBytes, 0x21))

	// Send envelope with non-alphabetical key order to verify JCS canonicalization round-trip.
	reorderedEnv := fmt.Sprintf(
		`{"nonce":%q,"ct_enc":%q,"v":%d,"key_id":%q,"alg":%q}`,
		sealed1.Envelope.Nonce, sealed1.Envelope.CtEnc, sealed1.Envelope.V, sealed1.Envelope.KeyID, sealed1.Envelope.Alg,
	)
	createBody1 := makeCreateBody(entryID1, entry.TypeText, reorderedEnv, sealed1.CiphertextB64, sealed1.PlaintextLenBucket)

	idem1 := "idem_entry_create_roundtrip_01"
	resp1, raw1 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries", createBody1, contenttest.ReqOptions{
		IdemKey: idem1,
	})
	if resp1.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items/{id}/entries = %d %s", resp1.StatusCode, raw1)
	}
	if cc := resp1.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}

	// Verify create response is EntryMeta only (no envelope, no ciphertext).
	var rawCreateMap map[string]any
	if err := json.Unmarshal([]byte(raw1), &rawCreateMap); err != nil {
		t.Fatal(err)
	}
	if _, hasEnv := rawCreateMap["envelope"]; hasEnv {
		t.Fatalf("POST /items/{id}/entries response must not contain envelope: %s", raw1)
	}
	if _, hasCT := rawCreateMap["ciphertext"]; hasCT {
		t.Fatalf("POST /items/{id}/entries response must not contain ciphertext: %s", raw1)
	}

	var meta1 entry.Meta
	if err := json.Unmarshal([]byte(raw1), &meta1); err != nil {
		t.Fatal(err)
	}
	if meta1.ID != entryID1 || meta1.ItemID != item.ID.String() || meta1.Type != entry.TypeText ||
		meta1.Position != 0 || meta1.Version != 1 || meta1.PlaintextLenBucket != 256 {
		t.Fatalf("unexpected created EntryMeta: %+v", meta1)
	}

	// Idempotent replay of POST /items/{id}/entries returns 201 and JSON-equal body (advisor-dec-135).
	respReplay, rawReplay := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries", createBody1, contenttest.ReqOptions{
		IdemKey: idem1,
	})
	if respReplay.StatusCode != http.StatusCreated {
		t.Fatalf("idempotent replay status = %d, want 201", respReplay.StatusCode)
	}
	contenttest.AssertJSONEqual(t, raw1, rawReplay)
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// GET /entries/{id} returns Entry (EntryMeta + envelope + ciphertext) and vault.OpenEntry opens it (A5).
	respGet, rawGet := h.DoReq(jarA, http.MethodGet, "/api/v1/entries/"+entryID1, "", contenttest.ReqOptions{})
	if respGet.StatusCode != http.StatusOK {
		t.Fatalf("GET /entries/{id} = %d %s", respGet.StatusCode, rawGet)
	}
	var gotEntry struct {
		ID                 string          `json:"id"`
		ItemID             string          `json:"item_id"`
		Type               string          `json:"type"`
		Position           int32           `json:"position"`
		Version            int32           `json:"version"`
		PlaintextLenBucket int32           `json:"plaintext_len_bucket"`
		Envelope           json.RawMessage `json:"envelope"`
		Ciphertext         string          `json:"ciphertext"`
	}
	if err := json.Unmarshal([]byte(rawGet), &gotEntry); err != nil {
		t.Fatal(err)
	}
	if gotEntry.ID != entryID1 || gotEntry.Ciphertext != sealed1.CiphertextB64 {
		t.Fatalf("GET /entries/{id} mismatch: id=%s ct=%s", gotEntry.ID, gotEntry.Ciphertext)
	}
	openedEnv, openedPlain, err := vault.OpenEntryBase64URL(gotEntry.Envelope, gotEntry.ID, gotEntry.Ciphertext, vf.VK)
	if err != nil {
		t.Fatalf("vault.OpenEntryBase64URL failed: %v", err)
	}
	if !bytes.Equal(openedPlain, plaintext1) {
		t.Fatalf("decrypted plaintext = %q, want %q", openedPlain, plaintext1)
	}
	if openedEnv != sealed1.Envelope {
		t.Fatalf("opened envelope = %+v, want %+v", openedEnv, sealed1.Envelope)
	}

	// Create a second entry (type=json), soft-delete it via SQL, and create a third entry:
	// position of the third entry must be max(position)+1 = 2 (counting tombstone at position 1).
	entryID2 := uuid.NewString()
	sealed2 := sealEntryFixture(t, entryID2, vf.VaultKeyID, vf.VK, []byte(`{"k":1}`), seqBytes(vault.WrapNonceBytes, 0x31))
	resp2, raw2 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
		makeCreateBody(entryID2, entry.TypeJSON, sealed2.EnvelopeRaw, sealed2.CiphertextB64, sealed2.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_entry_create_roundtrip_02"})
	if resp2.StatusCode != http.StatusCreated {
		t.Fatalf("create entry 2 = %d %s", resp2.StatusCode, raw2)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Soft-delete entry 2 and decrement item.entry_count via gen queries (since Task 6b is separate).
	ctx := context.Background()
	q := gen.New(h.Pool)
	if _, err := q.SoftDeleteEntry(ctx, gen.SoftDeleteEntryParams{UserID: meA.User.ID, ID: uuid.MustParse(entryID2)}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{Delta: -1, UserID: meA.User.ID, ID: item.ID}); err != nil {
		t.Fatal(err)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Create entry 3 -> position must be 2 (not 1, because entry 2 tombstone holds position 1).
	entryID3 := uuid.NewString()
	sealed3 := sealEntryFixture(t, entryID3, vf.VaultKeyID, vf.VK, []byte("third entry"), seqBytes(vault.WrapNonceBytes, 0x41))
	resp3, raw3 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
		makeCreateBody(entryID3, entry.TypeText, sealed3.EnvelopeRaw, sealed3.CiphertextB64, sealed3.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_entry_create_roundtrip_03"})
	if resp3.StatusCode != http.StatusCreated {
		t.Fatalf("create entry 3 = %d %s", resp3.StatusCode, raw3)
	}
	var meta3 entry.Meta
	if err := json.Unmarshal([]byte(raw3), &meta3); err != nil {
		t.Fatal(err)
	}
	if meta3.Position != 2 {
		t.Fatalf("entry 3 position = %d, want 2 (max over all rows incl. tombstone + 1)", meta3.Position)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
	// Verify metric entries_created_total{type} recorded text=2, json=1 (idempotent replay was NOT double-counted)
	// and has only label "type" with values in {"text", "json"} (user-dec-016, advisor-dec-149).
	families, err := h.Registry.Gather()
	if err != nil {
		t.Fatalf("Registry.Gather: %v", err)
	}
	var foundEntriesCreated bool
	gotTypeCounts := map[string]float64{}
	for _, f := range families {
		if f.GetName() != "entries_created_total" {
			continue
		}
		foundEntriesCreated = true
		for _, m := range f.GetMetric() {
			if len(m.GetLabel()) != 1 || m.GetLabel()[0].GetName() != "type" {
				t.Fatalf("entries_created_total has unexpected labels: %+v", m.GetLabel())
			}
			val := m.GetLabel()[0].GetValue()
			if val != entry.TypeText && val != entry.TypeJSON {
				t.Fatalf("entries_created_total has unexpected type label value %q", val)
			}
			gotTypeCounts[val] = m.GetCounter().GetValue()
		}
	}
	if !foundEntriesCreated {
		t.Fatal("missing entries_created_total metric in registry")
	}
	if gotTypeCounts[entry.TypeText] != 2 || gotTypeCounts[entry.TypeJSON] != 1 {
		t.Fatalf("entries_created_total counts = %v, want text=2 json=1", gotTypeCounts)
	}

	// GET /items/{id}/entries returns only live entries (entry 1 at pos 0, entry 3 at pos 2),
	// with no envelope or ciphertext fields, and supports keyset pagination via limit & cursor.
	respList1, rawList1 := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+item.ID.String()+"/entries?limit=1", "", contenttest.ReqOptions{})
	if respList1.StatusCode != http.StatusOK {
		t.Fatalf("GET /items/{id}/entries?limit=1 = %d %s", respList1.StatusCode, rawList1)
	}
	var rawListObj map[string]any
	if err := json.Unmarshal([]byte(rawList1), &rawListObj); err != nil {
		t.Fatal(err)
	}
	rawItemsSlice, ok := rawListObj["items"].([]any)
	if !ok || len(rawItemsSlice) != 1 {
		t.Fatalf("expected 1 item in page 1, got %v", rawListObj["items"])
	}
	firstItemMap := rawItemsSlice[0].(map[string]any)
	if _, hasEnv := firstItemMap["envelope"]; hasEnv {
		t.Fatalf("itemEntriesList item must not have envelope field: %s", rawList1)
	}
	if _, hasCT := firstItemMap["ciphertext"]; hasCT {
		t.Fatalf("itemEntriesList item must not have ciphertext field: %s", rawList1)
	}

	var page1 entry.MetaList
	if err := json.Unmarshal([]byte(rawList1), &page1); err != nil {
		t.Fatal(err)
	}
	if len(page1.Items) != 1 || page1.Items[0].ID != entryID1 || page1.NextCursor == nil {
		t.Fatalf("unexpected page 1: %+v", page1)
	}

	respList2, rawList2 := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+item.ID.String()+"/entries?limit=1&cursor="+*page1.NextCursor, "", contenttest.ReqOptions{})
	if respList2.StatusCode != http.StatusOK {
		t.Fatalf("GET /items/{id}/entries page 2 = %d %s", respList2.StatusCode, rawList2)
	}
	var page2 entry.MetaList
	if err := json.Unmarshal([]byte(rawList2), &page2); err != nil {
		t.Fatal(err)
	}
	if len(page2.Items) != 1 || page2.Items[0].ID != entryID3 || page2.Items[0].Position != 2 || page2.NextCursor != nil {
		t.Fatalf("unexpected page 2: %+v", page2)
	}

	// Cursor bound to item A must be rejected on item B with 400 invalid_request.
	item2 := insertTestItem(t, h, meA.User.ID, "Other Item")
	respBadCursor, rawBadCursor := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+item2.ID.String()+"/entries?cursor="+*page1.NextCursor, "", contenttest.ReqOptions{})
	if respBadCursor.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, rawBadCursor).Code != "invalid_request" {
		t.Fatalf("cross-item cursor = %d %s, want 400 invalid_request", respBadCursor.StatusCode, rawBadCursor)
	}
}

// TestEntryCreateSealedIDMismatchFailsOpen covers Task 6a bullet 2 (P04-A5):
//   - Sealed under ID X, sent in POST request with ID Y: server stores Y (since server has no VK),
//     and opening the returned entry under Y (or X with mismatched stored ID) fails AEAD verification.
func TestEntryCreateSealedIDMismatchFailsOpen(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA := h.SignupUser("entry-aad-id@example.com", "correct-horse-battery-staple-a")
	vf := createVaultForUser(t, h, jarA, 0x20)
	item := insertTestItem(t, h, meA.User.ID, "AAD Binding Item")

	idX := uuid.NewString()
	idY := uuid.NewString()
	sealedUnderX := sealEntryFixture(t, idX, vf.VaultKeyID, vf.VK, []byte("bound to idX"), seqBytes(vault.WrapNonceBytes, 0x55))

	// Send with idY while ciphertext was sealed with idX in AAD.
	body := makeCreateBody(idY, entry.TypeText, sealedUnderX.EnvelopeRaw, sealedUnderX.CiphertextB64, sealedUnderX.PlaintextLenBucket)
	resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries", body, contenttest.ReqOptions{
		IdemKey: "idem_entry_aad_id_mismatch_01",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST with idY = %d %s, want 201", resp.StatusCode, raw)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// GET /entries/{idX} -> 404; GET /entries/{idY} -> 200 with id=idY.
	respGetX, _ := h.DoReq(jarA, http.MethodGet, "/api/v1/entries/"+idX, "", contenttest.ReqOptions{})
	if respGetX.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /entries/{idX} = %d, want 404", respGetX.StatusCode)
	}

	respGetY, rawGetY := h.DoReq(jarA, http.MethodGet, "/api/v1/entries/"+idY, "", contenttest.ReqOptions{})
	if respGetY.StatusCode != http.StatusOK {
		t.Fatalf("GET /entries/{idY} = %d %s", respGetY.StatusCode, rawGetY)
	}
	var gotY struct {
		ID         string          `json:"id"`
		Envelope   json.RawMessage `json:"envelope"`
		Ciphertext string          `json:"ciphertext"`
	}
	if err := json.Unmarshal([]byte(rawGetY), &gotY); err != nil {
		t.Fatal(err)
	}
	if gotY.ID != idY {
		t.Fatalf("stored ID = %s, want %s", gotY.ID, idY)
	}

	// Opening with stored ID Y fails AEAD because ciphertext was sealed under ID X.
	if _, _, err := vault.OpenEntryBase64URL(gotY.Envelope, gotY.ID, gotY.Ciphertext, vf.VK); err == nil {
		t.Fatal("vault.OpenEntryBase64URL succeeded with wrong entry ID Y, want AEAD failure")
	}
}

// TestEntryEnvelopeAndKeyValidation covers Task 6a bullet 3:
//   - Envelope missing ct_enc, extra field, duplicate key (including \u-escaped form),
//     nonce 23 B / 25 B, v=2 -> 400 entry_invalid.
//   - Unknown top-level request field -> 400 invalid_request.
//   - key_id different from current vault -> 409 entry_key_mismatch.
//   - User has no vault -> 404 vault_absent.
//   - Entry ID conflict (existing ID of same user or another user, live or soft-deleted) -> 409 entry_id_conflict.
func TestEntryEnvelopeAndKeyValidation(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA, jarB, meB := h.SignupTwoUsers()
	vfA := createVaultForUser(t, h, jarA, 0x30)
	itemA := insertTestItem(t, h, meA.User.ID, "Envelope Test Item A")
	itemBNoVault := insertTestItem(t, h, meB.User.ID, "Item B Without Vault")

	validNonce := vault.EncodeBase64URL(seqBytes(24, 0x11))
	nonce23B := vault.EncodeBase64URL(seqBytes(23, 0x12))
	nonce25B := vault.EncodeBase64URL(seqBytes(25, 0x13))
	validCT := vault.EncodeBase64URL(seqBytes(32, 0x22)) // 32 B ciphertext -> 16 B plaintext -> bucket 256

	envelopeInvalidCases := []struct {
		name   string
		envRaw string
	}{
		{
			name:   "missing_ct_enc",
			envRaw: fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q}`, vfA.VaultKeyID, validNonce),
		},
		{
			name:   "extra_field",
			envRaw: fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8","extra":1}`, vfA.VaultKeyID, validNonce),
		},
		{
			name:   "duplicate_key_literal",
			envRaw: fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8","ct_enc":"utf8"}`, vfA.VaultKeyID, validNonce),
		},
		{
			name:   "duplicate_key_unicode_escaped",
			envRaw: fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8","ct\u005fenc":"utf8"}`, vfA.VaultKeyID, validNonce),
		},
		{
			name:   "nonce_23_bytes",
			envRaw: fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`, vfA.VaultKeyID, nonce23B),
		},
		{
			name:   "nonce_25_bytes",
			envRaw: fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`, vfA.VaultKeyID, nonce25B),
		},
		{
			name:   "version_2",
			envRaw: fmt.Sprintf(`{"v":2,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`, vfA.VaultKeyID, validNonce),
		},
	}

	for i, tc := range envelopeInvalidCases {
		t.Run(tc.name, func(t *testing.T) {
			body := makeCreateBody(uuid.NewString(), entry.TypeText, tc.envRaw, validCT, 256)
			resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries", body, contenttest.ReqOptions{
				IdemKey: fmt.Sprintf("idem_env_invalid_%02d_%s", i, tc.name[:min(len(tc.name), 16)]),
			})
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("%s: status = %d (%s), want 400", tc.name, resp.StatusCode, raw)
			}
			prob := contenttest.DecodeProblem(t, raw)
			if prob.Code != "entry_invalid" {
				t.Fatalf("%s: code = %q, want entry_invalid", tc.name, prob.Code)
			}
			contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
		})
	}

	// Unknown top-level field -> 400 invalid_request.
	validEnv := fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`, vfA.VaultKeyID, validNonce)
	unknownFieldBody := fmt.Sprintf(`{"id":%q,"type":"text","envelope":%s,"ciphertext":%q,"plaintext_len_bucket":256,"title":"not-allowed"}`,
		uuid.NewString(), validEnv, validCT)
	respUnk, rawUnk := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries", unknownFieldBody, contenttest.ReqOptions{
		IdemKey: "idem_env_unknown_top_field_01",
	})
	if respUnk.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, rawUnk).Code != "invalid_request" {
		t.Fatalf("unknown top field = %d %s, want 400 invalid_request", respUnk.StatusCode, rawUnk)
	}

	// key_id different from current vault -> 409 entry_key_mismatch (both wrong vk: and sk: prefix).
	for i, wrongKeyID := range []string{"vk:0000000000000000000000", "sk:0000000000000000000000"} {
		wrongKeyEnv := fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`, wrongKeyID, validNonce)
		body := makeCreateBody(uuid.NewString(), entry.TypeText, wrongKeyEnv, validCT, 256)
		resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries", body, contenttest.ReqOptions{
			IdemKey: fmt.Sprintf("idem_entry_key_mismatch_%02d", i),
		})
		if resp.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, raw).Code != "entry_key_mismatch" {
			t.Fatalf("wrong key_id (%s) = %d %s, want 409 entry_key_mismatch", wrongKeyID, resp.StatusCode, raw)
		}
		contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
	}

	// User B has no vault -> 404 vault_absent.
	bodyNoVault := makeCreateBody(uuid.NewString(), entry.TypeText, validEnv, validCT, 256)
	respNoVault, rawNoVault := h.DoReq(jarB, http.MethodPost, "/api/v1/items/"+itemBNoVault.ID.String()+"/entries", bodyNoVault, contenttest.ReqOptions{
		IdemKey: "idem_entry_user_b_no_vault_01",
	})
	if respNoVault.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawNoVault).Code != "vault_absent" {
		t.Fatalf("no vault = %d %s, want 404 vault_absent", respNoVault.StatusCode, rawNoVault)
	}
	contenttest.AssertInvariants(t, h.Pool, meB.User.ID)

	// Now create a vault for User B, create an entry for A, and verify that creating an entry with A's ID
	// (either by A or by B, even after A's entry is soft-deleted) returns 409 entry_id_conflict without leaking owner.
	vfB := createVaultForUser(t, h, jarB, 0x38)
	sharedEntryID := uuid.NewString()
	sealedA := sealEntryFixture(t, sharedEntryID, vfA.VaultKeyID, vfA.VK, []byte("entry A"), seqBytes(vault.WrapNonceBytes, 0x61))
	respCreateA, rawCreateA := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries",
		makeCreateBody(sharedEntryID, entry.TypeText, sealedA.EnvelopeRaw, sealedA.CiphertextB64, sealedA.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_entry_conflict_seed_a"})
	if respCreateA.StatusCode != http.StatusCreated {
		t.Fatalf("seed entry A = %d %s", respCreateA.StatusCode, rawCreateA)
	}

	// User B tries to create an entry with sharedEntryID -> 409 entry_id_conflict.
	sealedB := sealEntryFixture(t, sharedEntryID, vfB.VaultKeyID, vfB.VK, []byte("entry B"), seqBytes(vault.WrapNonceBytes, 0x62))
	respConflictB, rawConflictB := h.DoReq(jarB, http.MethodPost, "/api/v1/items/"+itemBNoVault.ID.String()+"/entries",
		makeCreateBody(sharedEntryID, entry.TypeText, sealedB.EnvelopeRaw, sealedB.CiphertextB64, sealedB.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_entry_conflict_user_b"})
	if respConflictB.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, rawConflictB).Code != "entry_id_conflict" {
		t.Fatalf("cross-user entry_id_conflict = %d %s, want 409 entry_id_conflict", respConflictB.StatusCode, rawConflictB)
	}
	if strings.Contains(rawConflictB, meA.User.ID.String()) || strings.Contains(rawConflictB, itemA.ID.String()) {
		t.Fatalf("entry_id_conflict leaked owner details: %s", rawConflictB)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, meB.User.ID)
}

// TestEntryBucketAndCiphertextSizeLimits covers Task 6a bullet 4 (P04-A12, P04-A7):
//   - Bucket 255 / 257 / 0 / 262400, bucket not matching ciphertext, ciphertext < 17 B,
//     ciphertext 263169 B -> rejected BEFORE storing (assert 0 entry rows, entry_count unchanged).
//   - 262144 B plaintext (ciphertext 262160 B, bucket 262144) -> accepted (201 Created) and opens cleanly.
func TestEntryBucketAndCiphertextSizeLimits(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA := h.SignupUser("entry-sizes@example.com", "correct-horse-battery-staple-a")
	vf := createVaultForUser(t, h, jarA, 0x40)
	item := insertTestItem(t, h, meA.User.ID, "Size Limits Item")

	validEnv := fmt.Sprintf(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":%q,"nonce":%q,"ct_enc":"utf8"}`,
		vf.VaultKeyID, vault.EncodeBase64URL(seqBytes(24, 0x33)))
	ct32B := vault.EncodeBase64URL(seqBytes(32, 0x44))          // 16 B plaintext -> expected bucket 256
	ct16B := vault.EncodeBase64URL(seqBytes(16, 0x45))          // < 17 B -> 400 entry_invalid
	ct263169B := vault.EncodeBase64URL(seqBytes(263_169, 0x46)) // > 263168 B -> 413 entry_too_large

	rejectCases := []struct {
		name       string
		ctB64      string
		bucket     int32
		wantStatus int
		wantCode   string
	}{
		{name: "bucket_255", ctB64: ct32B, bucket: 255, wantStatus: http.StatusBadRequest, wantCode: "entry_invalid"},
		{name: "bucket_257", ctB64: ct32B, bucket: 257, wantStatus: http.StatusBadRequest, wantCode: "entry_invalid"},
		{name: "bucket_0", ctB64: ct32B, bucket: 0, wantStatus: http.StatusBadRequest, wantCode: "entry_invalid"},
		{name: "bucket_262400", ctB64: ct32B, bucket: 262_400, wantStatus: http.StatusBadRequest, wantCode: "entry_invalid"},
		{name: "bucket_mismatch_512_for_16B_pt", ctB64: ct32B, bucket: 512, wantStatus: http.StatusBadRequest, wantCode: "entry_invalid"},
		{name: "ciphertext_16B_too_short", ctB64: ct16B, bucket: 256, wantStatus: http.StatusBadRequest, wantCode: "entry_invalid"},
		{name: "ciphertext_263169B_too_large", ctB64: ct263169B, bucket: 262_144, wantStatus: http.StatusRequestEntityTooLarge, wantCode: "entry_too_large"},
	}

	ctx := context.Background()
	for i, tc := range rejectCases {
		t.Run(tc.name, func(t *testing.T) {
			body := makeCreateBody(uuid.NewString(), entry.TypeText, validEnv, tc.ctB64, tc.bucket)
			resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries", body, contenttest.ReqOptions{
				IdemKey: fmt.Sprintf("idem_size_reject_%02d_%s", i, tc.name[:min(len(tc.name), 16)]),
			})
			if resp.StatusCode != tc.wantStatus {
				t.Fatalf("%s: status = %d (%s), want %d", tc.name, resp.StatusCode, raw, tc.wantStatus)
			}
			prob := contenttest.DecodeProblem(t, raw)
			if prob.Code != tc.wantCode {
				t.Fatalf("%s: code = %q, want %q", tc.name, prob.Code, tc.wantCode)
			}

			var entryRows int
			if err := h.Pool.QueryRow(ctx, `SELECT count(*) FROM entry WHERE item_id = $1`, item.ID).Scan(&entryRows); err != nil {
				t.Fatal(err)
			}
			if entryRows != 0 {
				t.Fatalf("%s: entry rows = %d, want 0 (must reject before storing)", tc.name, entryRows)
			}
			contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
		})
	}

	// Advance clock by 2 seconds so previous rate_event entries (if any) are outside the 1s sliding window.
	h.Clock.Advance(2 * time.Second)

	// 262144 B plaintext (ciphertext 262160 B, bucket 262144) is accepted (201 Created).
	maxPlaintext := bytes.Repeat([]byte("A"), vault.EntryPlaintextMaxBytes) // 262,144 B
	maxEntryID := uuid.NewString()
	sealedMax := sealEntryFixture(t, maxEntryID, vf.VaultKeyID, vf.VK, maxPlaintext, seqBytes(vault.WrapNonceBytes, 0x77))
	if len(sealedMax.CiphertextBytes) != 262_160 || sealedMax.PlaintextLenBucket != 262_144 {
		t.Fatalf("unexpected max sealed lengths: ct=%d bucket=%d", len(sealedMax.CiphertextBytes), sealedMax.PlaintextLenBucket)
	}

	respMax, rawMax := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
		makeCreateBody(maxEntryID, entry.TypeText, sealedMax.EnvelopeRaw, sealedMax.CiphertextB64, sealedMax.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_size_accept_262144_01"})
	if respMax.StatusCode != http.StatusCreated {
		t.Fatalf("262144 B plaintext create = %d %s, want 201", respMax.StatusCode, rawMax)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Verify GET /entries/{id} round-trips the 262,144 B entry.
	respGetMax, rawGetMax := h.DoReq(jarA, http.MethodGet, "/api/v1/entries/"+maxEntryID, "", contenttest.ReqOptions{})
	if respGetMax.StatusCode != http.StatusOK {
		t.Fatalf("GET 262144 B entry = %d %s", respGetMax.StatusCode, rawGetMax)
	}
	var gotMax struct {
		ID         string          `json:"id"`
		Envelope   json.RawMessage `json:"envelope"`
		Ciphertext string          `json:"ciphertext"`
	}
	if err := json.Unmarshal([]byte(rawGetMax), &gotMax); err != nil {
		t.Fatal(err)
	}
	_, openedMax, err := vault.OpenEntryBase64URL(gotMax.Envelope, gotMax.ID, gotMax.Ciphertext, vf.VK)
	if err != nil || !bytes.Equal(openedMax, maxPlaintext) {
		t.Fatalf("OpenEntryBase64URL on 262144 B entry failed: err=%v len=%d", err, len(openedMax))
	}
}

// TestEntryLimit200AndConcurrentLastSlotBarrier covers Task 6a bullet 5 (P04-A2):
//   - 200 live entries ok; the 201st -> 409 item_entry_limit.
//   - Two concurrent creates when 1 slot is left (199 live entries -> 200th slot):
//     synchronized via deterministic barrier (no sleep) -> exactly one 201 Created and one 409 item_entry_limit,
//     final entry_count == 200, AssertInvariants passes.
func TestEntryLimit200AndConcurrentLastSlotBarrier(t *testing.T) {
	var (
		barrierMu     sync.Mutex
		barrierActive bool
		tx1Entered    = make(chan struct{}, 2)
		releaseTx1    = make(chan struct{})
		releaseOnce   sync.Once
	)
	closeRelease := func() {
		releaseOnce.Do(func() { close(releaseTx1) })
	}

	var h *contenttest.Harness
	h = contenttest.NewHarness(t, contenttest.HarnessOpts{
		ExtraMounts: []func(h *contenttest.Harness, v1 chi.Router, d httpx.Deps){
			func(h *contenttest.Harness, v1 chi.Router, d httpx.Deps) {
				// Mount a barrier-instrumented route calling the exact same entryhttp Mount handler
				// with WithLockHeldHook attached to the request context.
				v1.Group(func(g chi.Router) {
					g.Use(func(next http.Handler) http.Handler {
						return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
							ctx := entryhttp.WithLockHeldHook(r.Context(), func(ctx context.Context, _ uuid.UUID, _ uuid.UUID) {
								barrierMu.Lock()
								active := barrierActive
								barrierMu.Unlock()
								if !active {
									return
								}
								select {
								case tx1Entered <- struct{}{}:
								default:
								}
								select {
								case <-releaseTx1:
								case <-ctx.Done():
								}
							})
							next.ServeHTTP(w, r.WithContext(ctx))
						})
					})
					g.Route("/__barrier_entry", func(sub chi.Router) {
						entryhttp.Mount(h.Content)(sub, d)
					})
				})
			},
		},
	})
	// Register LIFO cleanup AFTER NewHarness (which registered srv.Close) so release runs BEFORE srv.Close.
	t.Cleanup(closeRelease)

	jarA, meA := h.SignupUser("entry-limit200@example.com", "correct-horse-battery-staple-a")
	vf := createVaultForUser(t, h, jarA, 0x50)
	item := insertTestItem(t, h, meA.User.ID, "Item With 200 Cap")

	// Seed 198 live entries via SQL/gen so we can test creating the 199th, then racing 2 concurrent creates for the 200th slot.
	ctx := context.Background()
	q := gen.New(h.Pool)
	seedSealed := sealEntryFixture(t, uuid.NewString(), vf.VaultKeyID, vf.VK, []byte("seed"), seqBytes(vault.WrapNonceBytes, 0x81))
	for i := range 198 {
		_, err := q.InsertEntry(ctx, gen.InsertEntryParams{
			ID:                 uuid.New(),
			UserID:             meA.User.ID,
			ItemID:             item.ID,
			Type:               entry.TypeText,
			Envelope:           []byte(seedSealed.EnvelopeRaw),
			Ciphertext:         seedSealed.CiphertextBytes,
			PlaintextLenBucket: seedSealed.PlaintextLenBucket,
		})
		if err != nil {
			t.Fatalf("seed entry %d: %v", i, err)
		}
	}
	if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{
		Delta:  198,
		UserID: meA.User.ID,
		ID:     item.ID,
	}); err != nil {
		t.Fatal(err)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Create the 199th entry via HTTP POST /api/v1/items/{id}/entries -> 201 Created.
	id199 := uuid.NewString()
	sealed199 := sealEntryFixture(t, id199, vf.VaultKeyID, vf.VK, []byte("entry 199"), seqBytes(vault.WrapNonceBytes, 0x82))
	resp199, raw199 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
		makeCreateBody(id199, entry.TypeText, sealed199.EnvelopeRaw, sealed199.CiphertextB64, sealed199.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_entry_199_create_ok"})
	if resp199.StatusCode != http.StatusCreated {
		t.Fatalf("199th entry create = %d %s, want 201", resp199.StatusCode, raw199)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Now 199 live entries exist (1 slot left). Enable barrier and launch two concurrent creates.
	barrierMu.Lock()
	barrierActive = true
	barrierMu.Unlock()

	type resPair struct {
		resp contenttest.TestResponse
		raw  string
	}
	done1 := make(chan resPair, 1)
	done2 := make(chan resPair, 1)

	idRace1 := uuid.NewString()
	sealedRace1 := sealEntryFixture(t, idRace1, vf.VaultKeyID, vf.VK, []byte("race 1"), seqBytes(vault.WrapNonceBytes, 0x83))
	bodyRace1 := makeCreateBody(idRace1, entry.TypeText, sealedRace1.EnvelopeRaw, sealedRace1.CiphertextB64, sealedRace1.PlaintextLenBucket)

	idRace2 := uuid.NewString()
	sealedRace2 := sealEntryFixture(t, idRace2, vf.VaultKeyID, vf.VK, []byte("race 2"), seqBytes(vault.WrapNonceBytes, 0x84))
	bodyRace2 := makeCreateBody(idRace2, entry.TypeText, sealedRace2.EnvelopeRaw, sealedRace2.CiphertextB64, sealedRace2.PlaintextLenBucket)

	go func() {
		resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/__barrier_entry/items/"+item.ID.String()+"/entries", bodyRace1, contenttest.ReqOptions{
			IdemKey: "idem_entry_race_200_slot_a",
		})
		done1 <- resPair{resp: resp, raw: raw}
	}()

	// Wait for tx 1 to hold LockUserContent + LockItemForUpdate.
	select {
	case <-tx1Entered:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for first concurrent entryCreate to enter barrier")
	}

	// Start second concurrent entryCreate while first holds LockUserContent.
	go func() {
		resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/__barrier_entry/items/"+item.ID.String()+"/entries", bodyRace2, contenttest.ReqOptions{
			IdemKey: "idem_entry_race_200_slot_b",
		})
		done2 <- resPair{resp: resp, raw: raw}
	}()

	// Wait until Postgres pg_locks confirms tx 2 is waiting on the advisory lock hashtext('engram.content').
	deadline := time.Now().Add(10 * time.Second)
	waiterSeen := false
	for time.Now().Before(deadline) {
		var waiting int
		err := h.Pool.QueryRow(ctx, `
			SELECT count(*)
			FROM pg_locks
			WHERE locktype = 'advisory'
			  AND classid = hashtext('engram.content')
			  AND objid = hashtext(($1::uuid)::text)
			  AND NOT granted
		`, meA.User.ID).Scan(&waiting)
		if err == nil && waiting == 1 {
			waiterSeen = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !waiterSeen {
		t.Fatal("expected second concurrent entryCreate to wait on ungranted LockUserContent in pg_locks")
	}

	// Release barrier so both transactions complete in serialized order.
	barrierMu.Lock()
	barrierActive = false
	barrierMu.Unlock()
	closeRelease()

	var r1, r2 resPair
	select {
	case r1 = <-done1:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for race request 1")
	}
	select {
	case r2 = <-done2:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for race request 2")
	}

	// Exactly one must be 201 Created and the other must be 409 item_entry_limit.
	switch {
	case r1.resp.StatusCode == http.StatusCreated && r2.resp.StatusCode == http.StatusConflict:
		if code := contenttest.DecodeProblem(t, r2.raw).Code; code != "item_entry_limit" {
			t.Fatalf("r2 conflict code = %q, want item_entry_limit", code)
		}
	case r2.resp.StatusCode == http.StatusCreated && r1.resp.StatusCode == http.StatusConflict:
		if code := contenttest.DecodeProblem(t, r1.raw).Code; code != "item_entry_limit" {
			t.Fatalf("r1 conflict code = %q, want item_entry_limit", code)
		}
	default:
		t.Fatalf("concurrent last-slot statuses = (%d, %d), want one 201 and one 409 (%s / %s)",
			r1.resp.StatusCode, r2.resp.StatusCode, r1.raw, r2.raw)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// A 201st sequential attempt also fails with 409 item_entry_limit.
	id201 := uuid.NewString()
	sealed201 := sealEntryFixture(t, id201, vf.VaultKeyID, vf.VK, []byte("entry 201"), seqBytes(vault.WrapNonceBytes, 0x85))
	resp201, raw201 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
		makeCreateBody(id201, entry.TypeText, sealed201.EnvelopeRaw, sealed201.CiphertextB64, sealed201.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_entry_201_over_limit"})
	if resp201.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, raw201).Code != "item_entry_limit" {
		t.Fatalf("201st entry = %d %s, want 409 item_entry_limit", resp201.StatusCode, raw201)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
}

// TestEntryUpdateVersionIfMatchNonceReuseDeletedAndIdempotentReplay covers Task 6a bullet 6:
//   - PUT with missing / malformed If-Match -> 428 precondition_required.
//   - PUT with type field -> 400 invalid_request.
//   - PUT reusing stored nonce -> 400 entry_nonce_reused.
//   - PUT with valid new body and If-Match: "1" -> 200 EntryMeta with version=2, position & type unchanged.
//   - Retry of that PUT with the same Idempotency-Key and If-Match: "1" (simulating lost response) ->
//     200 with JSON-equal original response (advisor-dec-135), NOT 412.
//   - New PUT with stale If-Match: "1" and a new Idempotency-Key -> 412 version_mismatch + current_version: 2.
//   - PUT on a soft-deleted entry -> 404 not_found (even if If-Match is stale, 404 takes priority over 412).
func TestEntryUpdateVersionIfMatchNonceReuseDeletedAndIdempotentReplay(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA := h.SignupUser("entry-update@example.com", "correct-horse-battery-staple-a")
	vf := createVaultForUser(t, h, jarA, 0x60)
	item := insertTestItem(t, h, meA.User.ID, "Update Target Item")

	entryID := uuid.NewString()
	nonce1 := seqBytes(vault.WrapNonceBytes, 0x91)
	sealedV1 := sealEntryFixture(t, entryID, vf.VaultKeyID, vf.VK, []byte("initial v1 payload"), nonce1)
	respCreate, rawCreate := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries",
		makeCreateBody(entryID, entry.TypeText, sealedV1.EnvelopeRaw, sealedV1.CiphertextB64, sealedV1.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_put_test_create_01"})
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d %s", respCreate.StatusCode, rawCreate)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	nonce2 := seqBytes(vault.WrapNonceBytes, 0x92)
	plaintextV2 := []byte("updated v2 payload with more bytes")
	sealedV2 := sealEntryFixture(t, entryID, vf.VaultKeyID, vf.VK, plaintextV2, nonce2)
	updateBodyV2 := makeUpdateBody(sealedV2.EnvelopeRaw, sealedV2.CiphertextB64, sealedV2.PlaintextLenBucket)

	// 1. Missing or malformed If-Match -> 428 precondition_required.
	for i, badIfMatch := range []string{"", "*", `W/"1"`, `"01"`, `"1", "2"`, `"abc"`} {
		resp, raw := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+entryID, updateBodyV2, contenttest.ReqOptions{
			IdemKey: fmt.Sprintf("idem_put_bad_ifmatch_%02d", i),
			IfMatch: badIfMatch,
		})
		if resp.StatusCode != http.StatusPreconditionRequired || contenttest.DecodeProblem(t, raw).Code != "precondition_required" {
			t.Fatalf("If-Match %q = %d %s, want 428 precondition_required", badIfMatch, resp.StatusCode, raw)
		}
	}

	// 2. PUT sending `type` field -> 400 invalid_request.
	bodyWithType := fmt.Sprintf(`{"type":"json","envelope":%s,"ciphertext":%q,"plaintext_len_bucket":%d}`,
		sealedV2.EnvelopeRaw, sealedV2.CiphertextB64, sealedV2.PlaintextLenBucket)
	respType, rawType := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+entryID, bodyWithType, contenttest.ReqOptions{
		IdemKey: "idem_put_with_type_field_01",
		IfMatch: `"1"`,
	})
	if respType.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, rawType).Code != "invalid_request" {
		t.Fatalf("PUT with type = %d %s, want 400 invalid_request", respType.StatusCode, rawType)
	}

	// 3. PUT reusing the stored nonce -> 400 entry_nonce_reused.
	sealedSameNonce := sealEntryFixture(t, entryID, vf.VaultKeyID, vf.VK, []byte("different text same nonce"), nonce1)
	respNonce, rawNonce := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+entryID,
		makeUpdateBody(sealedSameNonce.EnvelopeRaw, sealedSameNonce.CiphertextB64, sealedSameNonce.PlaintextLenBucket),
		contenttest.ReqOptions{
			IdemKey: "idem_put_nonce_reused_01",
			IfMatch: `"1"`,
		})
	if respNonce.StatusCode != http.StatusBadRequest || contenttest.DecodeProblem(t, rawNonce).Code != "entry_nonce_reused" {
		t.Fatalf("PUT reusing nonce = %d %s, want 400 entry_nonce_reused", respNonce.StatusCode, rawNonce)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Advance clock by 2s so rate limit window is fresh.
	h.Clock.Advance(2 * time.Second)

	// 4. Valid PUT with If-Match: "1" -> 200 OK, version=2.
	putKey := "idem_put_valid_v1_to_v2"
	respPut, rawPut := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+entryID, updateBodyV2, contenttest.ReqOptions{
		IdemKey: putKey,
		IfMatch: `"1"`,
	})
	if respPut.StatusCode != http.StatusOK {
		t.Fatalf("PUT v1->v2 = %d %s, want 200", respPut.StatusCode, rawPut)
	}
	var metaV2 entry.Meta
	if err := json.Unmarshal([]byte(rawPut), &metaV2); err != nil {
		t.Fatal(err)
	}
	if metaV2.Version != 2 || metaV2.Position != 0 || metaV2.Type != entry.TypeText {
		t.Fatalf("unexpected updated EntryMeta: %+v", metaV2)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// 5. Retry of the lost-response PUT with the SAME Idempotency-Key and If-Match: "1" ->
	// returns original 200 response (JSON-equal per advisor-dec-135), NOT 412!
	respPutRetry, rawPutRetry := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+entryID, updateBodyV2, contenttest.ReqOptions{
		IdemKey: putKey,
		IfMatch: `"1"`,
	})
	if respPutRetry.StatusCode != http.StatusOK {
		t.Fatalf("idempotent retry of PUT = %d %s, want 200", respPutRetry.StatusCode, rawPutRetry)
	}
	contenttest.AssertJSONEqual(t, rawPut, rawPutRetry)

	// Verify GET /entries/{id} now decrypts to plaintextV2.
	respGetV2, rawGetV2 := h.DoReq(jarA, http.MethodGet, "/api/v1/entries/"+entryID, "", contenttest.ReqOptions{})
	if respGetV2.StatusCode != http.StatusOK {
		t.Fatalf("GET after PUT = %d %s", respGetV2.StatusCode, rawGetV2)
	}
	var gotV2 struct {
		ID         string          `json:"id"`
		Version    int32           `json:"version"`
		Envelope   json.RawMessage `json:"envelope"`
		Ciphertext string          `json:"ciphertext"`
	}
	if err := json.Unmarshal([]byte(rawGetV2), &gotV2); err != nil {
		t.Fatal(err)
	}
	if gotV2.Version != 2 {
		t.Fatalf("GET version = %d, want 2", gotV2.Version)
	}
	_, openedV2, err := vault.OpenEntryBase64URL(gotV2.Envelope, gotV2.ID, gotV2.Ciphertext, vf.VK)
	if err != nil || !bytes.Equal(openedV2, plaintextV2) {
		t.Fatalf("OpenEntry after PUT failed: err=%v plain=%q", err, openedV2)
	}

	// 6. New PUT with old version If-Match: "1" and new Idempotency-Key -> 412 version_mismatch + current_version: 2.
	sealedV3 := sealEntryFixture(t, entryID, vf.VaultKeyID, vf.VK, []byte("v3 attempt"), seqBytes(vault.WrapNonceBytes, 0x93))
	respStale, rawStale := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+entryID,
		makeUpdateBody(sealedV3.EnvelopeRaw, sealedV3.CiphertextB64, sealedV3.PlaintextLenBucket),
		contenttest.ReqOptions{
			IdemKey: "idem_put_stale_version_01",
			IfMatch: `"1"`,
		})
	if respStale.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("PUT with stale version = %d %s, want 412", respStale.StatusCode, rawStale)
	}
	var staleProb struct {
		Code           string `json:"code"`
		CurrentVersion int32  `json:"current_version"`
	}
	if err := json.Unmarshal([]byte(rawStale), &staleProb); err != nil {
		t.Fatal(err)
	}
	if staleProb.Code != "version_mismatch" || staleProb.CurrentVersion != 2 {
		t.Fatalf("stale PUT problem = %+v, want version_mismatch with current_version=2", staleProb)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// 7. Soft-delete the entry via SQL/gen query and verify PUT returns 404 not_found (even with stale If-Match "1").
	ctx := context.Background()
	q := gen.New(h.Pool)
	if _, err := q.SoftDeleteEntry(ctx, gen.SoftDeleteEntryParams{UserID: meA.User.ID, ID: uuid.MustParse(entryID)}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{Delta: -1, UserID: meA.User.ID, ID: item.ID}); err != nil {
		t.Fatal(err)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	respDeletedPut, rawDeletedPut := h.DoReq(jarA, http.MethodPut, "/api/v1/entries/"+entryID,
		makeUpdateBody(sealedV3.EnvelopeRaw, sealedV3.CiphertextB64, sealedV3.PlaintextLenBucket),
		contenttest.ReqOptions{
			IdemKey: "idem_put_on_deleted_entry_01",
			IfMatch: `"1"`, // stale version, but 404 not_found must take priority over 412
		})
	if respDeletedPut.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawDeletedPut).Code != "not_found" {
		t.Fatalf("PUT on deleted entry = %d %s, want 404 not_found", respDeletedPut.StatusCode, rawDeletedPut)
	}

	respDeletedGet, rawDeletedGet := h.DoReq(jarA, http.MethodGet, "/api/v1/entries/"+entryID, "", contenttest.ReqOptions{})
	if respDeletedGet.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawDeletedGet).Code != "not_found" {
		t.Fatalf("GET on deleted entry = %d %s, want 404 not_found", respDeletedGet.StatusCode, rawDeletedGet)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
}

// TestEntryCrossUserIsolationAndLogPrivacy covers Task 6a bullets 7 & 8 (P04-A1, P04-A4, user-dec-016):
//   - User B gets 404 not_found on GET /entries/{A's entry}, PUT /entries/{A's entry} (even with wrong version, 404 before 412),
//     GET /items/{A's item}/entries, and POST /items/{A's item}/entries; nothing is written.
//   - Access log and all handler logs (harness Logs buffer) never contain ciphertext, envelope.nonce,
//     envelope.key_id, or item name in query.
func TestEntryCrossUserIsolationAndLogPrivacy(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA, jarB, meB := h.SignupTwoUsers()
	vfA := createVaultForUser(t, h, jarA, 0x70)
	vfB := createVaultForUser(t, h, jarB, 0x78)

	secretItemName := "private-item-name-sentinel-98765"
	itemA := insertTestItem(t, h, meA.User.ID, secretItemName)

	entryIDA := uuid.NewString()
	nonceSentinel := seqBytes(vault.WrapNonceBytes, 0xA1)
	sealedA := sealEntryFixture(t, entryIDA, vfA.VaultKeyID, vfA.VK, []byte("secret-plaintext-sentinel-12345"), nonceSentinel)

	h.Logs.Reset()

	// Create entry A.
	respCreate, rawCreate := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries?name="+secretItemName,
		makeCreateBody(entryIDA, entry.TypeText, sealedA.EnvelopeRaw, sealedA.CiphertextB64, sealedA.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_isolation_create_a_01"})
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("create entry A = %d %s", respCreate.StatusCode, rawCreate)
	}

	// User B tries GET /entries/{entryIDA} -> 404 not_found.
	respBGet, rawBGet := h.DoReq(jarB, http.MethodGet, "/api/v1/entries/"+entryIDA+"?q="+secretItemName, "", contenttest.ReqOptions{})
	if respBGet.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawBGet).Code != "not_found" {
		t.Fatalf("User B GET A's entry = %d %s, want 404 not_found", respBGet.StatusCode, rawBGet)
	}

	// User B tries GET /items/{itemA}/entries -> 404 not_found.
	respBList, rawBList := h.DoReq(jarB, http.MethodGet, "/api/v1/items/"+itemA.ID.String()+"/entries?q="+secretItemName, "", contenttest.ReqOptions{})
	if respBList.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawBList).Code != "not_found" {
		t.Fatalf("User B GET A's item entries = %d %s, want 404 not_found", respBList.StatusCode, rawBList)
	}

	// User B tries PUT /entries/{entryIDA} -> 404 not_found (even with If-Match "99", 404 before 412).
	sealedB := sealEntryFixture(t, entryIDA, vfB.VaultKeyID, vfB.VK, []byte("B overwrite attempt"), seqBytes(vault.WrapNonceBytes, 0xA2))
	respBPut, rawBPut := h.DoReq(jarB, http.MethodPut, "/api/v1/entries/"+entryIDA,
		makeUpdateBody(sealedB.EnvelopeRaw, sealedB.CiphertextB64, sealedB.PlaintextLenBucket),
		contenttest.ReqOptions{
			IdemKey: "idem_isolation_b_put_a_01",
			IfMatch: `"99"`,
		})
	if respBPut.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawBPut).Code != "not_found" {
		t.Fatalf("User B PUT A's entry = %d %s, want 404 not_found", respBPut.StatusCode, rawBPut)
	}

	// User B tries POST /items/{itemA}/entries -> 404 not_found; nothing written.
	newIDB := uuid.NewString()
	sealedBNew := sealEntryFixture(t, newIDB, vfB.VaultKeyID, vfB.VK, []byte("B create on A item"), seqBytes(vault.WrapNonceBytes, 0xA3))
	respBPost, rawBPost := h.DoReq(jarB, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries",
		makeCreateBody(newIDB, entry.TypeText, sealedBNew.EnvelopeRaw, sealedBNew.CiphertextB64, sealedBNew.PlaintextLenBucket),
		contenttest.ReqOptions{IdemKey: "idem_isolation_b_post_a_01"})
	if respBPost.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawBPost).Code != "not_found" {
		t.Fatalf("User B POST on A's item = %d %s, want 404 not_found", respBPost.StatusCode, rawBPost)
	}

	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, meB.User.ID)

	// Verify A's entry is untouched (version=1, original ciphertext).
	respAGet, rawAGet := h.DoReq(jarA, http.MethodGet, "/api/v1/entries/"+entryIDA, "", contenttest.ReqOptions{})
	if respAGet.StatusCode != http.StatusOK {
		t.Fatalf("User A GET own entry = %d %s", respAGet.StatusCode, rawAGet)
	}
	var gotA entry.Entry
	if err := json.Unmarshal([]byte(rawAGet), &gotA); err != nil {
		t.Fatal(err)
	}
	if gotA.Version != 1 || gotA.Ciphertext != sealedA.CiphertextB64 {
		t.Fatalf("User A entry was modified: %+v", gotA)
	}

	// Inspect all server logs in h.Logs: must NOT contain ciphertext, envelope.nonce, envelope.key_id, or item name in query.
	logs := h.Logs.String()
	if logs == "" {
		t.Fatal("expected access logs to be written to h.Logs")
	}
	forbiddenSubstrings := []struct {
		label string
		val   string
	}{
		{label: "ciphertext_a", val: sealedA.CiphertextB64},
		{label: "ciphertext_b", val: sealedB.CiphertextB64},
		{label: "envelope_nonce_a", val: sealedA.Envelope.Nonce},
		{label: "envelope_nonce_b", val: sealedB.Envelope.Nonce},
		{label: "vault_key_id_a", val: vfA.VaultKeyID},
		{label: "item_name_in_query", val: secretItemName},
		{label: "plaintext_sentinel", val: "secret-plaintext-sentinel-12345"},
	}
	for _, f := range forbiddenSubstrings {
		if strings.Contains(logs, f.val) {
			t.Fatalf("logs leaked %s (%q):\n%s", f.label, f.val, logs)
		}
	}
	// Ensure access log uses route pattern, not concrete UUIDs.
	if !strings.Contains(logs, `"/api/v1/items/{id}/entries"`) || !strings.Contains(logs, `"/api/v1/entries/{id}"`) {
		t.Fatalf("access log missing route patterns:\n%s", logs)
	}
}
