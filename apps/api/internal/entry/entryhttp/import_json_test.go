package entryhttp_test

import (
	"bytes"
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
	"github.com/zone17th/engram/apps/api/internal/secevent"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

func makeImportJSONBody(id, entryType, envRaw, ctB64 string, bucket int32, source string) string {
	return fmt.Sprintf(
		`{"id":%q,"type":%q,"envelope":%s,"ciphertext":%q,"plaintext_len_bucket":%d,"source":%q}`,
		id, entryType, envRaw, ctB64, bucket, source,
	)
}

type auditImportRow struct {
	ID      int64
	UserID  uuid.UUID
	Event   string
	Result  string
	Actor   string
	MetaRaw []byte
}

func queryEntryImportAuditRows(t *testing.T, h *contenttest.Harness, userID uuid.UUID) []auditImportRow {
	t.Helper()
	rows, err := h.Pool.Query(
		context.Background(),
		`SELECT id, user_id, event, result, COALESCE(actor, ''), meta FROM audit_log WHERE user_id = $1 AND event = $2 ORDER BY id ASC`,
		userID,
		secevent.EventEntryImport,
	)
	if err != nil {
		t.Fatalf("query audit_log: %v", err)
	}
	defer rows.Close()

	var out []auditImportRow
	for rows.Next() {
		var r auditImportRow
		if err := rows.Scan(&r.ID, &r.UserID, &r.Event, &r.Result, &r.Actor, &r.MetaRaw); err != nil {
			t.Fatalf("scan audit_log row: %v", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err audit_log: %v", err)
	}
	return out
}

func countAllEntryImportAuditRows(t *testing.T, h *contenttest.Harness) int {
	t.Helper()
	var n int
	if err := h.Pool.QueryRow(
		context.Background(),
		`SELECT count(*) FROM audit_log WHERE event = $1`,
		secevent.EventEntryImport,
	).Scan(&n); err != nil {
		t.Fatalf("count audit_log entry.import: %v", err)
	}
	return n
}

func countEntriesForItem(t *testing.T, h *contenttest.Harness, itemID uuid.UUID) int {
	t.Helper()
	var n int
	if err := h.Pool.QueryRow(
		context.Background(),
		`SELECT count(*) FROM entry WHERE item_id = $1`,
		itemID,
	).Scan(&n); err != nil {
		t.Fatalf("count entry rows: %v", err)
	}
	return n
}

// TestEntryImportJSONHappyPathAuditIdempotencyAndDecrypt covers Task 6c bullets:
//   - Happy path for both `source: "paste"` and `source: "file"` through `POST /api/v1/items/{id}/entries/import-json`:
//     returns 201 `EntryMeta` (no envelope/ciphertext), `GET /entries/{id}` decrypts cleanly via `vault.OpenEntry` /
//     `vault.OpenEntryBase64URL`, and `GET /items/{id}/entries` lists both with `type="json"` (P04-A7).
//   - Audit `entry.import` is recorded through the real `audit.Store` inside the mutation transaction; reading
//     `audit_log.meta` back from Postgres shows ONLY `{"import_source": "paste"}` / `{"import_source": "file"}`
//     (exact 1 key, no filename, no ciphertext, no envelope fields, no item name; user-dec-016, advisor-dec-105).
//   - Retry with the same `Idempotency-Key` returns the original 201 response (JSON-equal per advisor-dec-135),
//     creates no second entry row, and records no second `entry.import` audit row (P04-A11).
//   - Metric `entries_created_total{type="json"}` increments once per committed import (not on replay).
//   - Maximum 262,144 B JSON plaintext (262,160 B ciphertext, bucket 262,144) is accepted on `import-json` (P04-A7).
//   - `contenttest.AssertInvariants` passes after every write case.
func TestEntryImportJSONHappyPathAuditIdempotencyAndDecrypt(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA := h.SignupUser("entry-import-happy@example.com", "correct-horse-battery-staple-a")
	vf := createVaultForUser(t, h, jarA, 0x90)
	secretItemName := "Import Target Item Sentinel 7711"
	item := insertTestItem(t, h, meA.User.ID, secretItemName)

	// 1. Import with source="paste".
	entryIDPaste := uuid.NewString()
	jsonPlainPaste := []byte("{\r\n  \"service\": \"postgres\",\r\n  \"port\": 5432,\r\n  \"secret\": \"paste-body-sentinel-001\"\r\n}")
	sealedPaste := sealEntryFixture(t, entryIDPaste, vf.VaultKeyID, vf.VK, jsonPlainPaste, seqBytes(vault.WrapNonceBytes, 0xC1))
	bodyPaste := makeImportJSONBody(entryIDPaste, entry.TypeJSON, sealedPaste.EnvelopeRaw, sealedPaste.CiphertextB64, sealedPaste.PlaintextLenBucket, entry.ImportSourcePaste)

	idemPaste := "idem_t6c_import_paste_01"
	respPaste, rawPaste := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries/import-json", bodyPaste, contenttest.ReqOptions{
		IdemKey: idemPaste,
	})
	if respPaste.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items/{id}/entries/import-json (paste) = %d %s", respPaste.StatusCode, rawPaste)
	}
	if cc := respPaste.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}

	var rawPasteMap map[string]any
	if err := json.Unmarshal([]byte(rawPaste), &rawPasteMap); err != nil {
		t.Fatal(err)
	}
	if _, hasEnv := rawPasteMap["envelope"]; hasEnv {
		t.Fatalf("entryImportJson response must not contain envelope: %s", rawPaste)
	}
	if _, hasCT := rawPasteMap["ciphertext"]; hasCT {
		t.Fatalf("entryImportJson response must not contain ciphertext: %s", rawPaste)
	}

	var metaPaste entry.Meta
	if err := json.Unmarshal([]byte(rawPaste), &metaPaste); err != nil {
		t.Fatal(err)
	}
	if metaPaste.ID != entryIDPaste || metaPaste.ItemID != item.ID.String() || metaPaste.Type != entry.TypeJSON ||
		metaPaste.Position != 0 || metaPaste.Version != 1 || metaPaste.PlaintextLenBucket != 256 {
		t.Fatalf("unexpected paste EntryMeta: %+v", metaPaste)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Verify idempotent replay with the same Idempotency-Key returns 201 + JSON-equal body,
	// no second entry row, and no second audit row (A11, advisor-dec-135).
	respPasteReplay, rawPasteReplay := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries/import-json", bodyPaste, contenttest.ReqOptions{
		IdemKey: idemPaste,
	})
	if respPasteReplay.StatusCode != http.StatusCreated {
		t.Fatalf("idempotent replay status = %d %s, want 201", respPasteReplay.StatusCode, rawPasteReplay)
	}
	contenttest.AssertJSONEqual(t, rawPaste, rawPasteReplay)
	if gotEntries := countEntriesForItem(t, h, item.ID); gotEntries != 1 {
		t.Fatalf("entry count after idempotent replay = %d, want 1", gotEntries)
	}
	auditAfterPaste := queryEntryImportAuditRows(t, h, meA.User.ID)
	if len(auditAfterPaste) != 1 {
		t.Fatalf("audit rows after paste + replay = %d, want 1", len(auditAfterPaste))
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// 2. Import with source="file".
	entryIDFile := uuid.NewString()
	jsonPlainFile := []byte("[\n  {\"id\": \"row-1\", \"secret\": \"file-body-sentinel-002\"}\n]")
	sealedFile := sealEntryFixture(t, entryIDFile, vf.VaultKeyID, vf.VK, jsonPlainFile, seqBytes(vault.WrapNonceBytes, 0xC2))
	bodyFile := makeImportJSONBody(entryIDFile, entry.TypeJSON, sealedFile.EnvelopeRaw, sealedFile.CiphertextB64, sealedFile.PlaintextLenBucket, entry.ImportSourceFile)

	idemFile := "idem_t6c_import_file_01"
	respFile, rawFile := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries/import-json", bodyFile, contenttest.ReqOptions{
		IdemKey: idemFile,
	})
	if respFile.StatusCode != http.StatusCreated {
		t.Fatalf("POST /items/{id}/entries/import-json (file) = %d %s", respFile.StatusCode, rawFile)
	}
	var metaFile entry.Meta
	if err := json.Unmarshal([]byte(rawFile), &metaFile); err != nil {
		t.Fatal(err)
	}
	if metaFile.ID != entryIDFile || metaFile.Type != entry.TypeJSON || metaFile.Position != 1 || metaFile.Version != 1 {
		t.Fatalf("unexpected file EntryMeta: %+v", metaFile)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Verify both audit rows in DB: exact meta {"import_source": "paste"} and {"import_source": "file"},
	// no filename, ciphertext, envelope fields, or item name.
	auditRows := queryEntryImportAuditRows(t, h, meA.User.ID)
	if len(auditRows) != 2 {
		t.Fatalf("audit rows count = %d, want 2", len(auditRows))
	}
	wantSources := []string{secevent.ImportSourcePaste, secevent.ImportSourceFile}
	for i, row := range auditRows {
		if row.Event != secevent.EventEntryImport || row.Result != secevent.ResultSuccess || row.Actor != "user" {
			t.Fatalf("audit row %d unexpected header: %+v", i, row)
		}
		var metaMap map[string]any
		if err := json.Unmarshal(row.MetaRaw, &metaMap); err != nil {
			t.Fatalf("unmarshal audit meta %d (%s): %v", i, row.MetaRaw, err)
		}
		if len(metaMap) != 1 || metaMap["import_source"] != wantSources[i] {
			t.Fatalf("audit row %d meta = %v (raw %s), want exact {\"import_source\": %q}", i, metaMap, row.MetaRaw, wantSources[i])
		}
		rawMetaStr := string(row.MetaRaw)
		for _, forbidden := range []string{
			"filename",
			sealedPaste.CiphertextB64,
			sealedFile.CiphertextB64,
			sealedPaste.Envelope.Nonce,
			sealedFile.Envelope.Nonce,
			vf.VaultKeyID,
			secretItemName,
			"paste-body-sentinel-001",
			"file-body-sentinel-002",
		} {
			if strings.Contains(rawMetaStr, forbidden) {
				t.Fatalf("audit meta %d leaked %q: %s", i, forbidden, rawMetaStr)
			}
		}
	}

	// Verify GET /entries/{id} decrypts with vault.OpenEntry (and OpenEntryBase64URL) to exact bytes.
	for _, tc := range []struct {
		id        string
		wantPlain []byte
		wantEnv   vault.EntryEnvelopeV1
	}{
		{id: entryIDPaste, wantPlain: jsonPlainPaste, wantEnv: sealedPaste.Envelope},
		{id: entryIDFile, wantPlain: jsonPlainFile, wantEnv: sealedFile.Envelope},
	} {
		respGet, rawGet := h.DoReq(jarA, http.MethodGet, "/api/v1/entries/"+tc.id, "", contenttest.ReqOptions{})
		if respGet.StatusCode != http.StatusOK {
			t.Fatalf("GET /entries/%s = %d %s", tc.id, respGet.StatusCode, rawGet)
		}
		var got struct {
			ID         string          `json:"id"`
			Type       string          `json:"type"`
			Envelope   json.RawMessage `json:"envelope"`
			Ciphertext string          `json:"ciphertext"`
		}
		if err := json.Unmarshal([]byte(rawGet), &got); err != nil {
			t.Fatal(err)
		}
		if got.ID != tc.id || got.Type != entry.TypeJSON {
			t.Fatalf("GET /entries/%s got id=%s type=%s", tc.id, got.ID, got.Type)
		}
		ctRaw, err := vault.DecodeBase64URLStrict(got.Ciphertext, 0)
		if err != nil {
			t.Fatalf("DecodeBase64URLStrict: %v", err)
		}
		openedEnv, openedPlain, err := vault.OpenEntry(got.Envelope, got.ID, ctRaw, vf.VK)
		if err != nil {
			t.Fatalf("vault.OpenEntry(%s): %v", tc.id, err)
		}
		if !bytes.Equal(openedPlain, tc.wantPlain) {
			t.Fatalf("decrypted plaintext for %s = %q, want %q", tc.id, openedPlain, tc.wantPlain)
		}
		if openedEnv != tc.wantEnv {
			t.Fatalf("opened envelope for %s = %+v, want %+v", tc.id, openedEnv, tc.wantEnv)
		}
	}

	// Verify GET /items/{id}/entries lists both entries in position order with type="json" and no envelope/ciphertext.
	respList, rawList := h.DoReq(jarA, http.MethodGet, "/api/v1/items/"+item.ID.String()+"/entries", "", contenttest.ReqOptions{})
	if respList.StatusCode != http.StatusOK {
		t.Fatalf("GET /items/{id}/entries = %d %s", respList.StatusCode, rawList)
	}
	var listDTO entry.MetaList
	if err := json.Unmarshal([]byte(rawList), &listDTO); err != nil {
		t.Fatal(err)
	}
	if len(listDTO.Items) != 2 ||
		listDTO.Items[0].ID != entryIDPaste || listDTO.Items[0].Type != entry.TypeJSON || listDTO.Items[0].Position != 0 ||
		listDTO.Items[1].ID != entryIDFile || listDTO.Items[1].Type != entry.TypeJSON || listDTO.Items[1].Position != 1 {
		t.Fatalf("unexpected itemEntriesList: %+v", listDTO)
	}

	// 3. Maximum 262,144 B JSON plaintext (ciphertext 262,160 B, bucket 262,144) accepted on import-json (P04-A7).
	idMax := uuid.NewString()
	maxPrefix := `{"data":"`
	maxSuffix := `"}`
	maxJSONPlain := []byte(maxPrefix + strings.Repeat("j", vault.EntryPlaintextMaxBytes-len(maxPrefix)-len(maxSuffix)) + maxSuffix)
	if len(maxJSONPlain) != vault.EntryPlaintextMaxBytes {
		t.Fatalf("maxJSONPlain len = %d, want %d", len(maxJSONPlain), vault.EntryPlaintextMaxBytes)
	}
	sealedMax := sealEntryFixture(t, idMax, vf.VaultKeyID, vf.VK, maxJSONPlain, seqBytes(vault.WrapNonceBytes, 0xC3))
	respMax, rawMax := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+item.ID.String()+"/entries/import-json",
		makeImportJSONBody(idMax, entry.TypeJSON, sealedMax.EnvelopeRaw, sealedMax.CiphertextB64, sealedMax.PlaintextLenBucket, entry.ImportSourceFile),
		contenttest.ReqOptions{IdemKey: "idem_t6c_import_max_262144"})
	if respMax.StatusCode != http.StatusCreated {
		t.Fatalf("import 262144B JSON = %d %s, want 201", respMax.StatusCode, rawMax)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Verify metric entries_created_total{type="json"} is 3 (paste + file + max; replay was not counted).
	families, err := h.Registry.Gather()
	if err != nil {
		t.Fatalf("Registry.Gather: %v", err)
	}
	var jsonCount float64
	for _, f := range families {
		if f.GetName() != "entries_created_total" {
			continue
		}
		for _, m := range f.GetMetric() {
			if len(m.GetLabel()) == 1 && m.GetLabel()[0].GetName() == "type" && m.GetLabel()[0].GetValue() == entry.TypeJSON {
				jsonCount = m.GetCounter().GetValue()
			}
		}
	}
	if jsonCount != 3 {
		t.Fatalf("entries_created_total{type=json} = %v, want 3", jsonCount)
	}
}

// TestEntryImportJSONRejectionsWriteNothingAndLogPrivacy covers Task 6c bullets:
//   - `type != "json"` (`"text"`, `""`, `"markdown"`) -> `400 entry_invalid`.
//   - `source` missing, empty, or unknown (`"url"`, `"clipboard"`, `"PASTE"`) -> `400 invalid_request`.
//   - Unknown field such as `filename` (advisor-dec-105), duplicate top-level key, or raw unsealed JSON body
//     -> `400 invalid_request`.
//   - Failed/rolled-back DB mutations (`vault_absent`, `entry_key_mismatch`, foreign/deleted item `not_found`,
//     `entry_id_conflict`, `item_entry_limit`) write NO entry row and NO `entry.import` audit row.
//   - Harness `Logs` buffer contains no `ciphertext`, no `filename`, no `envelope.nonce`, no `vault_key_id`,
//     and no item name or plaintext sentinel (user-dec-016).
//   - `contenttest.AssertInvariants` passes after every case.
func TestEntryImportJSONRejectionsWriteNothingAndLogPrivacy(t *testing.T) {
	h := contenttest.NewHarness(t, contenttest.HarnessOpts{})
	jarA, meA, jarB, meB := h.SignupTwoUsers()
	vfA := createVaultForUser(t, h, jarA, 0xA0)
	secretItemName := "Import Privacy Item Sentinel 8822"
	itemA := insertTestItem(t, h, meA.User.ID, secretItemName)

	validID := uuid.NewString()
	secretFilename := " leaked-secret-filename-credentials.json "
	sealedValid := sealEntryFixture(t, validID, vfA.VaultKeyID, vfA.VK, []byte(`{"secret":"import-sentinel-999"}`), seqBytes(vault.WrapNonceBytes, 0xD1))

	h.Logs.Reset()

	// Batch 1 (User A, 8 requests <= 10/s limit): type != json, missing/unknown source, filename field, duplicate key, raw JSON.
	rejectionCases := []struct {
		name     string
		body     string
		wantCode string
	}{
		{
			name:     "type_text_rejected",
			body:     makeImportJSONBody(uuid.NewString(), entry.TypeText, sealedValid.EnvelopeRaw, sealedValid.CiphertextB64, sealedValid.PlaintextLenBucket, entry.ImportSourcePaste),
			wantCode: "entry_invalid",
		},
		{
			name:     "type_empty_rejected",
			body:     makeImportJSONBody(uuid.NewString(), "", sealedValid.EnvelopeRaw, sealedValid.CiphertextB64, sealedValid.PlaintextLenBucket, entry.ImportSourceFile),
			wantCode: "entry_invalid",
		},
		{
			name:     "source_missing_rejected",
			body:     makeCreateBody(uuid.NewString(), entry.TypeJSON, sealedValid.EnvelopeRaw, sealedValid.CiphertextB64, sealedValid.PlaintextLenBucket),
			wantCode: "invalid_request",
		},
		{
			name:     "source_unknown_rejected",
			body:     makeImportJSONBody(uuid.NewString(), entry.TypeJSON, sealedValid.EnvelopeRaw, sealedValid.CiphertextB64, sealedValid.PlaintextLenBucket, "clipboard"),
			wantCode: "invalid_request",
		},
		{
			name:     "source_uppercase_rejected",
			body:     makeImportJSONBody(uuid.NewString(), entry.TypeJSON, sealedValid.EnvelopeRaw, sealedValid.CiphertextB64, sealedValid.PlaintextLenBucket, "PASTE"),
			wantCode: "invalid_request",
		},
		{
			name: "filename_field_rejected",
			body: fmt.Sprintf(
				`{"id":%q,"type":"json","envelope":%s,"ciphertext":%q,"plaintext_len_bucket":%d,"source":"file","filename":%q}`,
				uuid.NewString(), sealedValid.EnvelopeRaw, sealedValid.CiphertextB64, sealedValid.PlaintextLenBucket, secretFilename,
			),
			wantCode: "invalid_request",
		},
		{
			name: "duplicate_source_key_rejected",
			body: fmt.Sprintf(
				`{"id":%q,"type":"json","envelope":%s,"ciphertext":%q,"plaintext_len_bucket":%d,"source":"paste","source":"file"}`,
				uuid.NewString(), sealedValid.EnvelopeRaw, sealedValid.CiphertextB64, sealedValid.PlaintextLenBucket,
			),
			wantCode: "invalid_request",
		},
		{
			name:     "raw_unsealed_json_rejected",
			body:     `{"raw_json":{"hello":"world"}}`,
			wantCode: "invalid_request",
		},
	}

	for i, tc := range rejectionCases {
		resp, raw := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries/import-json?filename="+strings.TrimSpace(secretFilename), tc.body, contenttest.ReqOptions{
			IdemKey: fmt.Sprintf("idem_t6c_reject_batch1_%02d", i),
		})
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d %s, want 400", tc.name, resp.StatusCode, raw)
		}
		if got := contenttest.DecodeProblem(t, raw).Code; got != tc.wantCode {
			t.Fatalf("%s: code = %q, want %q (body: %s)", tc.name, got, tc.wantCode, raw)
		}
	}

	// Verify nothing was written to entry or audit_log.
	if got := countEntriesForItem(t, h, itemA.ID); got != 0 {
		t.Fatalf("entries written after validation rejections = %d, want 0", got)
	}
	if got := countAllEntryImportAuditRows(t, h); got != 0 {
		t.Fatalf("audit rows written after validation rejections = %d, want 0", got)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Advance fake clock past 1 s before Batch 2 so User A's content_write quota (10 req/1s) is fresh.
	h.Clock.Advance(2 * time.Second)

	// Batch 2: Transaction rollback / conflict cases must also write 0 entry rows and 0 audit rows.
	// 2a. User B has no vault yet -> 404 vault_absent.
	itemB := insertTestItem(t, h, meB.User.ID, "User B Item")
	idNoVault := uuid.NewString()
	sealedNoVault := sealEntryFixture(t, idNoVault, vfA.VaultKeyID, vfA.VK, []byte(`{"b":1}`), seqBytes(vault.WrapNonceBytes, 0xD2))
	respNoVault, rawNoVault := h.DoReq(jarB, http.MethodPost, "/api/v1/items/"+itemB.ID.String()+"/entries/import-json",
		makeImportJSONBody(idNoVault, entry.TypeJSON, sealedNoVault.EnvelopeRaw, sealedNoVault.CiphertextB64, sealedNoVault.PlaintextLenBucket, entry.ImportSourcePaste),
		contenttest.ReqOptions{IdemKey: "idem_t6c_b_no_vault"})
	if respNoVault.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawNoVault).Code != "vault_absent" {
		t.Fatalf("User B import without vault = %d %s, want 404 vault_absent", respNoVault.StatusCode, rawNoVault)
	}

	// Create vault for User B, then User B attempts import into User A's item -> 404 not_found.
	vfB := createVaultForUser(t, h, jarB, 0xA8)
	idCross := uuid.NewString()
	sealedCross := sealEntryFixture(t, idCross, vfB.VaultKeyID, vfB.VK, []byte(`{"b":2}`), seqBytes(vault.WrapNonceBytes, 0xD3))
	respCross, rawCross := h.DoReq(jarB, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries/import-json",
		makeImportJSONBody(idCross, entry.TypeJSON, sealedCross.EnvelopeRaw, sealedCross.CiphertextB64, sealedCross.PlaintextLenBucket, entry.ImportSourceFile),
		contenttest.ReqOptions{IdemKey: "idem_t6c_b_cross_item"})
	if respCross.StatusCode != http.StatusNotFound || contenttest.DecodeProblem(t, rawCross).Code != "not_found" {
		t.Fatalf("User B import on User A item = %d %s, want 404 not_found", respCross.StatusCode, rawCross)
	}

	// 2b. User A wrong key_id -> 409 entry_key_mismatch.
	idWrongKey := uuid.NewString()
	sealedWrongKey := sealEntryFixture(t, idWrongKey, vfB.VaultKeyID, vfB.VK, []byte(`{"a":1}`), seqBytes(vault.WrapNonceBytes, 0xD4))
	respWrongKey, rawWrongKey := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries/import-json",
		makeImportJSONBody(idWrongKey, entry.TypeJSON, sealedWrongKey.EnvelopeRaw, sealedWrongKey.CiphertextB64, sealedWrongKey.PlaintextLenBucket, entry.ImportSourcePaste),
		contenttest.ReqOptions{IdemKey: "idem_t6c_a_wrong_key"})
	if respWrongKey.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, rawWrongKey).Code != "entry_key_mismatch" {
		t.Fatalf("User A wrong key import = %d %s, want 409 entry_key_mismatch", respWrongKey.StatusCode, rawWrongKey)
	}

	// Verify still 0 entry rows and 0 audit rows across the entire DB.
	if got := countEntriesForItem(t, h, itemA.ID); got != 0 {
		t.Fatalf("itemA entries after tx rejections = %d, want 0", got)
	}
	if got := countEntriesForItem(t, h, itemB.ID); got != 0 {
		t.Fatalf("itemB entries after tx rejections = %d, want 0", got)
	}
	if got := countAllEntryImportAuditRows(t, h); got != 0 {
		t.Fatalf("audit rows after tx rejections = %d, want 0", got)
	}

	// 2c. Seed 1 valid entry for User A, then test entry_id_conflict (409) and item_entry_limit (409) rollback.
	respSeed, rawSeed := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries/import-json",
		makeImportJSONBody(validID, entry.TypeJSON, sealedValid.EnvelopeRaw, sealedValid.CiphertextB64, sealedValid.PlaintextLenBucket, entry.ImportSourcePaste),
		contenttest.ReqOptions{IdemKey: "idem_t6c_a_seed_valid"})
	if respSeed.StatusCode != http.StatusCreated {
		t.Fatalf("seed valid import = %d %s, want 201", respSeed.StatusCode, rawSeed)
	}
	if got := countAllEntryImportAuditRows(t, h); got != 1 {
		t.Fatalf("audit rows after 1 valid import = %d, want 1", got)
	}

	// Duplicate entry.id with a new Idempotency-Key -> 409 entry_id_conflict, no second audit row.
	sealedDupID := sealEntryFixture(t, validID, vfA.VaultKeyID, vfA.VK, []byte(`{"dup":true}`), seqBytes(vault.WrapNonceBytes, 0xD5))
	respDupID, rawDupID := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries/import-json",
		makeImportJSONBody(validID, entry.TypeJSON, sealedDupID.EnvelopeRaw, sealedDupID.CiphertextB64, sealedDupID.PlaintextLenBucket, entry.ImportSourceFile),
		contenttest.ReqOptions{IdemKey: "idem_t6c_a_dup_entry_id"})
	if respDupID.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, rawDupID).Code != "entry_id_conflict" {
		t.Fatalf("duplicate entry ID import = %d %s, want 409 entry_id_conflict", respDupID.StatusCode, rawDupID)
	}
	if got := countAllEntryImportAuditRows(t, h); got != 1 {
		t.Fatalf("audit rows after entry_id_conflict = %d, want still 1", got)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	// Seed 199 more entries via SQL on itemA (reaching 200 live entries), then verify 201st via import-json -> 409 item_entry_limit and no audit row added.
	ctx := context.Background()
	q := gen.New(h.Pool)
	for i := 1; i < int(entry.MaxLiveEntriesPerItem); i++ {
		eid := uuid.New()
		env, ct, err := vault.SealEntry(eid.String(), vfA.VaultKeyID, []byte(`{}`), vfA.VK, seqBytes(vault.WrapNonceBytes, byte(i)))
		if err != nil {
			t.Fatal(err)
		}
		envBytes, _ := json.Marshal(env)
		if _, err := q.InsertEntry(ctx, gen.InsertEntryParams{
			ID:                 eid,
			UserID:             meA.User.ID,
			ItemID:             itemA.ID,
			Type:               entry.TypeJSON,
			Envelope:           envBytes,
			Ciphertext:         ct,
			PlaintextLenBucket: 256,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{
		Delta:  entry.MaxLiveEntriesPerItem - 1,
		UserID: meA.User.ID,
		ID:     itemA.ID,
	}); err != nil {
		t.Fatal(err)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)

	id201 := uuid.NewString()
	sealed201 := sealEntryFixture(t, id201, vfA.VaultKeyID, vfA.VK, []byte(`{"over":200}`), seqBytes(vault.WrapNonceBytes, 0xD6))
	resp201, raw201 := h.DoReq(jarA, http.MethodPost, "/api/v1/items/"+itemA.ID.String()+"/entries/import-json",
		makeImportJSONBody(id201, entry.TypeJSON, sealed201.EnvelopeRaw, sealed201.CiphertextB64, sealed201.PlaintextLenBucket, entry.ImportSourceFile),
		contenttest.ReqOptions{IdemKey: "idem_t6c_a_201st_limit"})
	if resp201.StatusCode != http.StatusConflict || contenttest.DecodeProblem(t, raw201).Code != "item_entry_limit" {
		t.Fatalf("201st import-json = %d %s, want 409 item_entry_limit", resp201.StatusCode, raw201)
	}
	if got := countAllEntryImportAuditRows(t, h); got != 1 {
		t.Fatalf("audit rows after item_entry_limit = %d, want still 1", got)
	}
	contenttest.AssertInvariants(t, h.Pool, meA.User.ID)
	contenttest.AssertInvariants(t, h.Pool, meB.User.ID)

	// Inspect harness Logs buffer: must contain route pattern and NO ciphertext, NO filename, NO nonce, NO key_id, NO item name.
	logs := h.Logs.String()
	if logs == "" {
		t.Fatal("expected access logs to be written to h.Logs")
	}
	for _, forbidden := range []struct {
		label string
		val   string
	}{
		{label: "ciphertext", val: sealedValid.CiphertextB64},
		{label: "filename_value", val: strings.TrimSpace(secretFilename)},
		{label: "filename_key", val: "filename"},
		{label: "envelope_nonce", val: sealedValid.Envelope.Nonce},
		{label: "vault_key_id", val: vfA.VaultKeyID},
		{label: "item_name", val: secretItemName},
		{label: "plaintext_sentinel", val: "import-sentinel-999"},
	} {
		if strings.Contains(logs, forbidden.val) {
			t.Fatalf("logs leaked %s (%q):\n%s", forbidden.label, forbidden.val, logs)
		}
	}
	if !strings.Contains(logs, `"/api/v1/items/{id}/entries/import-json"`) {
		t.Fatalf("access log missing route pattern /api/v1/items/{id}/entries/import-json:\n%s", logs)
	}
}
