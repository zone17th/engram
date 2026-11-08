package export

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"golang.org/x/crypto/argon2"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/jobs/exportcleanup"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

func newTestConfig(t *testing.T) *config.Config {
	t.Helper()
	return &config.Config{
		Env:                 "development",
		ExportStorageDir:    t.TempDir(),
		ExportMaxSpoolBytes: 4 << 30,
		ExportAtRestSecret:  config.NewSecretBytes([]byte(config.DevExportAtRestSecret)),
		AuthIPPepper:        bytes.Repeat([]byte{0x11}, 32),
		AuthEmailPepper:     bytes.Repeat([]byte{0x22}, 32),
	}
}

func setupExportTestDB(t *testing.T) (*pgxpool.Pool, *config.Config, *Service, *ExportWorker) {
	t.Helper()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	cfg := newTestConfig(t)
	svc, err := NewService(cfg, pool, nil, nil, clock.System{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	w := NewExportWorker(WorkerDeps{
		Pool:       pool,
		StorageDir: cfg.ExportStorageDir,
		Secret:     cfg.ExportAtRestSecret,
	})
	return pool, cfg, svc, w
}

func sha256Sum(b []byte) []byte {
	h := sha256.Sum256(b)
	return h[:]
}

// seedUserAndVault inserts an app_user, a vault (with the js-v1.json vector wraps
// and canonicalSampleVaultKeyID), 1 recovery key, 1 passkey, 1 active tag, 1
// soft-deleted tag, 1 active item, 1 item_tag, 1 active entry and 1 soft-deleted
// entry. Returns userID, itemID, activeEntryID, deletedEntryID, and vector VK.
func seedUserAndVault(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID, []byte) {
	t.Helper()
	return seedUserAndVaultK(t, pool, canonicalSampleVaultKeyID)
}

// seedUserAndVaultK seeds a tenant under the given vault_key_id. The key id is
// globally UNIQUE, and lookup_hash/cred_id are derived from it so a second
// tenant does not collide with the canonical seed.
func seedUserAndVaultK(t *testing.T, pool *pgxpool.Pool, keyID string) (uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID, []byte) {
	t.Helper()
	ctx := context.Background()
	vec := loadJSVectors(t)
	vk, err := vault.DecodeBase64URLStrict(vec.Inputs.VKB64U, 32)
	if err != nil {
		t.Fatal(err)
	}
	wrapK, err := vault.DecodeBase64URLStrict(vec.Derived.Wraps.KEK.WrapB64U, 73)
	if err != nil {
		t.Fatal(err)
	}
	wrapP, err := vault.DecodeBase64URLStrict(vec.Derived.Wraps.Priv.WrapB64U, 105)
	if err != nil {
		t.Fatal(err)
	}
	xPub, _ := vault.DecodeBase64URLStrict(vec.Inputs.X25519PublicB64, 32)
	edPub, _ := vault.DecodeBase64URLStrict(vec.Inputs.Ed25519PubB64, 32)
	kdfRaw, _ := json.Marshal(vec.Inputs.KDF)

	userID := uuid.New()
	email := "u-" + userID.String() + "@example.com"
	if _, err := pool.Exec(ctx, `
		INSERT INTO app_user (id, email, email_verified_at)
		VALUES ($1, $2, now())
	`, userID, email); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault (user_id, version, kdf, vault_key_id, vault_key_wrapped_by_kek, x25519_public, ed25519_public, private_keys_wrapped)
		VALUES ($1, 3, $2, $3, $4, $5, $6, $7)
	`, userID, kdfRaw, keyID, wrapK, xPub, edPub, wrapP); err != nil {
		t.Fatalf("insert vault: %v", err)
	}
	rkHash, _ := vault.DecodeBase64URLStrict(vec.Derived.RKLookupHashB64, 32)
	if keyID != canonicalSampleVaultKeyID {
		// lookup_hash is globally UNIQUE: fold keyID for extra tenants only so
		// the canonical seed keeps the real vector hash used by restore tests.
		rkHash = sha256Sum(append(append([]byte{}, rkHash...), keyID...))
	}
	rkWrap, _ := vault.DecodeBase64URLStrict(vec.Derived.Wraps.RK.WrapB64U, 73)
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_recovery_key (vault_id, slot, lookup_hash, wrap)
		VALUES ($1, $2, $3, $4)
	`, userID, vec.Inputs.RKSlot, rkHash, rkWrap); err != nil {
		t.Fatalf("insert rk: %v", err)
	}
	pkWrap, _ := vault.DecodeBase64URLStrict(vec.Derived.Wraps.PRF.WrapB64U, 73)
	credID := bytes.Repeat([]byte{0x42}, 32)
	if keyID != canonicalSampleVaultKeyID {
		credID = sha256Sum(append(credID, keyID...))
	}
	aaguid := uuid.MustParse("adce0002-35bc-c60a-648b-0b25f1f05503")
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_passkey (id, user_id, cred_id, pubkey, prf_salt, vk_wrap, aaguid, name)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'MacBook Touch ID')
	`, uuid.New(), userID, credID, bytes.Repeat([]byte{0x99}, 32),
		bytes.Repeat([]byte{0x24}, 32), pkWrap, aaguid[:]); err != nil {
		t.Fatalf("insert passkey: %v", err)
	}

	tagActive := uuid.New()
	tagDeleted := uuid.New()
	if _, err := pool.Exec(ctx, `
		INSERT INTO tag (id, user_id, display, normalized, item_count)
		VALUES ($1, $2, 'wifi-khách', 'wifi-khách', 1),
		       ($3, $2, 'old-tag', 'old-tag', 0)
	`, tagActive, userID, tagDeleted); err != nil {
		t.Fatalf("insert tag: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tag SET deleted_at = now() WHERE id = $1`, tagDeleted); err != nil {
		t.Fatal(err)
	}

	itemID := uuid.New()
	if _, err := pool.Exec(ctx, `
		INSERT INTO item (id, user_id, name, name_normalized, hint, entry_count, version)
		VALUES ($1, $2, 'wifi', 'wifi', 'Tầng 2', 1, 1)
	`, itemID, userID); err != nil {
		t.Fatalf("insert item: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO item_tag (item_id, tag_id) VALUES ($1, $2)
	`, itemID, tagActive); err != nil {
		t.Fatalf("insert item_tag: %v", err)
	}

	activeEntryID := uuid.MustParse(vec.Inputs.Entries.Text.EntryID)
	deletedEntryID := uuid.MustParse(vec.Inputs.Entries.JSON.EntryID)
	// Make entry IDs unique per seeded user when called multiple times.
	if err := pool.QueryRow(ctx, `SELECT id FROM entry WHERE id = $1`, activeEntryID).Scan(new(uuid.UUID)); err == nil {
		activeEntryID = uuid.New()
		deletedEntryID = uuid.New()
	}
	nonce := bytes.Repeat([]byte{0x07}, 24)
	envA, ctA, err := vault.SealEntry(activeEntryID.String(), keyID, []byte(vec.Inputs.Entries.Text.PlaintextUTF8), vk, nonce)
	if err != nil {
		t.Fatal(err)
	}
	envD, ctD, err := vault.SealEntry(deletedEntryID.String(), keyID, []byte(vec.Inputs.Entries.JSON.PlaintextUTF8), vk, nonce)
	if err != nil {
		t.Fatal(err)
	}
	envARaw, _ := json.Marshal(envA)
	envDRaw, _ := json.Marshal(envD)
	if _, err := pool.Exec(ctx, `
		INSERT INTO entry (id, user_id, item_id, type, position, envelope, ciphertext, plaintext_len_bucket, version)
		VALUES ($1, $2, $3, 'text', 0, $4, $5, 256, 1),
		       ($6, $2, $3, 'json', 1, $7, $8, 256, 1)
	`, activeEntryID, userID, itemID, envARaw, ctA, deletedEntryID, envDRaw, ctD); err != nil {
		t.Fatalf("insert entries: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE entry SET deleted_at = now(), deleted_via = 'entry' WHERE id = $1
	`, deletedEntryID); err != nil {
		t.Fatal(err)
	}
	return userID, itemID, activeEntryID, deletedEntryID, vk
}

func makeRiverJob(jobID, userID uuid.UUID, attempt, maxAttempts int) *river.Job[ExportEncryptedArgs] {
	return &river.Job[ExportEncryptedArgs]{
		JobRow: &rivertype.JobRow{
			ID:          1,
			Attempt:     attempt,
			MaxAttempts: maxAttempts,
			State:       rivertype.JobStateRunning,
		},
		Args: ExportEncryptedArgs{JobID: jobID, UserID: userID},
	}
}

// TestExportEncrypted covers end-to-end encrypted snapshot generation,
// OpenDownload decryption, schema invariants (kdf, wrapK 73B, vk:, wrapP 105B,
// RK, passkey, active + soft-deleted unpurged rows), audit + security notice,
// and offline restore after server-side rotate/consume/revoke/delete (P06-A2).
func TestExportEncrypted(t *testing.T) {
	pool, _, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, activeEntryID, deletedEntryID, _ := seedUserAndVault(t, pool)

	job, created, err := svc.Create(ctx, userID, "idem-1")
	if err != nil || !created || job.Status != StatusQueued {
		t.Fatalf("Create: created=%v status=%s err=%v", created, job.Status, err)
	}

	if err := w.Work(ctx, makeRiverJob(job.ID, userID, 1, 3)); err != nil {
		t.Fatalf("Work: %v", err)
	}

	got, err := svc.Get(ctx, userID, job.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Status != StatusReady || got.SizeBytes == nil || *got.SizeBytes <= AtRestHeaderLen {
		t.Fatalf("job after Work: %+v", got)
	}

	// OpenDownload streams decrypted .sabk.json; cross-user returns ErrNotFound.
	if _, err := svc.OpenDownload(ctx, uuid.New(), job.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-user OpenDownload: %v", err)
	}
	dl, err := svc.OpenDownload(ctx, userID, job.ID)
	if err != nil {
		t.Fatalf("OpenDownload: %v", err)
	}
	rawSabk, err := io.ReadAll(dl)
	_ = dl.Close()
	if err != nil {
		t.Fatalf("read download stream: %v", err)
	}
	if !strings.HasPrefix(dl.FileName, "engram-backup-") || !strings.HasSuffix(dl.FileName, ".sabk.json") {
		t.Fatalf("download filename = %q", dl.FileName)
	}

	// Now delete the user on the live server (simulating full account loss /
	// rotation / RK consume / passkey revoke) and prove offline restore from rawSabk alone.
	if _, err := pool.Exec(ctx, `DELETE FROM app_user WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}

	var doc struct {
		Format   string        `json:"format"`
		Version  int           `json:"version"`
		Snapshot SabkSnapshot  `json:"snapshot"`
		Vault    SabkVault     `json:"vault"`
		Tags     []SabkTag     `json:"tags"`
		Items    []SabkItem    `json:"items"`
		ItemTags []SabkItemTag `json:"item_tags"`
		Entries  []SabkEntry   `json:"entries"`
	}
	if err := json.Unmarshal(rawSabk, &doc); err != nil {
		t.Fatalf("unmarshal downloaded sabk: %v", err)
	}
	if doc.Format != SabkFormat || doc.Version != 1 {
		t.Fatalf("format=%s version=%d", doc.Format, doc.Version)
	}
	if !doc.Snapshot.IncludesActive || !doc.Snapshot.IncludesSoftDeletedUnpurged || !doc.Snapshot.ExcludesPurged {
		t.Fatalf("snapshot flags: %+v", doc.Snapshot)
	}
	if doc.Snapshot.Counts.Tags != 2 || doc.Snapshot.Counts.Items != 1 || doc.Snapshot.Counts.ItemTags != 1 || doc.Snapshot.Counts.Entries != 2 {
		t.Fatalf("snapshot counts: %+v", doc.Snapshot.Counts)
	}
	if !vault.ValidateVaultKeyID(doc.Vault.VaultKeyID) {
		t.Fatalf("invalid vault_key_id %q", doc.Vault.VaultKeyID)
	}
	if b, err := vault.ValidateWrapBase64URL(doc.Vault.PrivateKeysWrapped, vault.WrapKindPriv); err != nil || len(b) != 105 {
		t.Fatalf("wrapP: len=%d err=%v", len(b), err)
	}
	if len(doc.Vault.RecoveryKeys) != 1 || len(doc.Vault.Passkeys) != 1 {
		t.Fatalf("rk=%d passkeys=%d", len(doc.Vault.RecoveryKeys), len(doc.Vault.Passkeys))
	}

	// Offline decrypt using passphrase from js-v1.json.
	vec := loadJSVectors(t)
	var kdf vault.KDFParams
	_ = json.Unmarshal(doc.Vault.KDF, &kdf)
	salt, _ := vault.DecodeBase64URLStrict(kdf.Salt, 16)
	kek := argon2.IDKey([]byte(vec.Inputs.PassphraseUTF8), salt, uint32(kdf.Ops), uint32(kdf.Mem/1024), uint8(kdf.Parallelism), 32)
	recoveredVK, err := vault.OpenWrapBase64URL(vault.WrapKindKEK, doc.Vault.VaultKeyWrappedByKEK, kek)
	if err != nil {
		t.Fatalf("offline OpenWrap(KEK): %v", err)
	}
	foundActive, foundDeleted := false, false
	for _, e := range doc.Entries {
		if _, pt, err := vault.OpenEntryBase64URL(e.Envelope, e.ID.String(), e.Ciphertext, recoveredVK); err != nil {
			t.Fatalf("offline OpenEntry(%s): %v", e.ID, err)
		} else if e.ID == activeEntryID && string(pt) == vec.Inputs.Entries.Text.PlaintextUTF8 {
			foundActive = true
		} else if e.ID == deletedEntryID && e.DeletedAt != nil && string(pt) == vec.Inputs.Entries.JSON.PlaintextUTF8 {
			foundDeleted = true
		}
	}
	if !foundActive || !foundDeleted {
		t.Fatalf("foundActive=%v foundDeleted=%v", foundActive, foundDeleted)
	}
}

// TestExportFinalizeCASKeepsAtomic verifies (plan mục 2.4, P06-A2) that if a
// job is cancelled, the vault is reset (vault_key_id changed or vault deleted),
// or the account is deleted right before Finalize CAS runs, Finalize CAS
// publishes 0 ready rows and removes the attempt file on disk.
func TestExportFinalizeCASKeepsAtomic(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(t *testing.T, ctx context.Context, pool *pgxpool.Pool, svc *Service, userID, jobID uuid.UUID)
	}{
		{
			name: "CancelBeforeFinalize",
			mutate: func(t *testing.T, ctx context.Context, pool *pgxpool.Pool, svc *Service, userID, jobID uuid.UUID) {
				if _, err := svc.Cancel(ctx, userID, jobID); err != nil {
					t.Fatalf("Cancel: %v", err)
				}
			},
		},
		{
			name: "VaultResetKeyChangedBeforeFinalize",
			mutate: func(t *testing.T, ctx context.Context, pool *pgxpool.Pool, svc *Service, userID, jobID uuid.UUID) {
				newKeyID, err := vault.GenerateVaultKeyID()
				if err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(ctx, `UPDATE vault SET vault_key_id = $1, version = version + 1 WHERE user_id = $2`, newKeyID, userID); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "AccountDeleteBeforeFinalize",
			mutate: func(t *testing.T, ctx context.Context, pool *pgxpool.Pool, svc *Service, userID, jobID uuid.UUID) {
				q := gen.New(pool)
				if _, err := q.CancelUserExportJobs(ctx, userID); err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(ctx, `DELETE FROM app_user WHERE id = $1`, userID); err != nil {
					t.Fatal(err)
				}
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool, cfg, svc, _ := setupExportTestDB(t)
			ctx := context.Background()
			userID, _, _, _, _ := seedUserAndVault(t, pool)

			job, _, err := svc.Create(ctx, userID, "")
			if err != nil {
				t.Fatal(err)
			}
			w := NewExportWorker(WorkerDeps{
				Pool:       pool,
				StorageDir: cfg.ExportStorageDir,
				Secret:     cfg.ExportAtRestSecret,
				BeforeFinalizeHook: func(ctx context.Context, jID, _ uuid.UUID) {
					tc.mutate(t, ctx, pool, svc, userID, jID)
				},
			})
			_ = w.Work(ctx, makeRiverJob(job.ID, userID, 1, 3))

			var readyCount int
			if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM export_job WHERE id = $1 AND status = 'ready'`, job.ID).Scan(&readyCount); err != nil {
				t.Fatal(err)
			}
			if readyCount != 0 {
				t.Fatalf("expected 0 ready rows after %s, got %d", tc.name, readyCount)
			}
			entries, _ := os.ReadDir(cfg.ExportStorageDir)
			for _, e := range entries {
				t.Fatalf("leftover attempt file on disk after %s: %s", tc.name, e.Name())
			}
		})
	}
}

// TestExportPeakMemory verifies (plan mục 2.7.1, P06-A2) that streaming a
// synthetic vault of 2 000 entries × 256 KiB keeps the HeapInuse delta ≤ 16 MiB.
func TestExportPeakMemory(t *testing.T) {
	pool, cfg, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, itemID, activeID, deletedID, _ := seedUserAndVault(t, pool)

	const totalSynth = 2000
	const ctSize = 256 * 1024
	ct := bytes.Repeat([]byte{0xab}, ctSize)
	envRaw := []byte(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"vk:AAECAwQFBgcICQoLDA0ODw","nonce":"AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY","ct_enc":"utf8"}`)

	// Bulk-insert 2 000 synthetic 256 KiB entries using CopyFrom in batches so setup stays fast.
	const batch = 200
	synthIDs := make([]uuid.UUID, 0, totalSynth)
	for base := 0; base < totalSynth; base += batch {
		rows := make([][]any, 0, batch)
		for i := range batch {
			pos := int32(10 + base + i)
			id := uuid.New()
			synthIDs = append(synthIDs, id)
			rows = append(rows, []any{
				id, userID, itemID, "text", pos, envRaw, ct, int32(ctSize), int32(1),
			})
		}
		if _, err := pool.CopyFrom(
			ctx,
			pgx.Identifier{"entry"},
			[]string{"id", "user_id", "item_id", "type", "position", "envelope", "ciphertext", "plaintext_len_bucket", "version"},
			pgx.CopyFromRows(rows),
		); err != nil {
			t.Fatalf("CopyFrom entries: %v", err)
		}
	}

	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}

	runtime.GC()
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	// Sample HeapInuse continuously during the whole attempt WITHOUT forcing GC
	// so transient peaks inside query collection, base64 conversion and JSON
	// serialization are observed (review r1 R1-02).
	var peakDelta atomic.Int64

	sample := func() {
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		if ms.HeapInuse > before.HeapInuse {
			d := int64(ms.HeapInuse - before.HeapInuse)
			for {
				cur := peakDelta.Load()
				if d <= cur || peakDelta.CompareAndSwap(cur, d) {
					break
				}
			}
		}
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		tk := time.NewTicker(time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
				sample()
			}
		}
	}()

	if err := w.Work(ctx, makeRiverJob(job.ID, userID, 1, 3)); err != nil {
		close(stop)
		wg.Wait()
		t.Fatalf("Work(2000×256KiB): %v", err)
	}
	close(stop)
	wg.Wait()

	const maxDelta = 16 << 20 // 16 MiB
	gotDelta := peakDelta.Load()
	t.Logf("2000×256KiB export peak HeapInuse delta = %d B (%.2f MiB), limit = 16 MiB, storageDir=%s",
		gotDelta, float64(gotDelta)/(1<<20), cfg.ExportStorageDir)
	if gotDelta > maxDelta {
		t.Fatalf("HeapInuse delta %d B exceeds 16 MiB (%d B)", gotDelta, maxDelta)
	}

	// R1-06: multi-batch completeness — stream-decode the produced file and
	// assert the entries section is exactly the seeded IDs in the worker's
	// documented (item_id, position, id) order — active pos 0, soft-deleted
	// pos 1, then the 2 000 synthetic rows by position — and that the
	// manifest's snapshot.counts.entries equals the decoded count.
	var attemptID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT attempt_id FROM export_job WHERE id = $1`, job.ID).Scan(&attemptID); err != nil {
		t.Fatalf("fetch attempt_id: %v", err)
	}
	sec := svc.secretBytes()
	filePath := filepath.Join(cfg.ExportStorageDir, SafeFileName(job.ID, attemptID, "sabk.enc"))
	f, err := os.Open(filePath)
	if err != nil {
		t.Fatalf("open artifact: %v", err)
	}
	defer func() { _ = f.Close() }()
	fr, err := NewFrameReader(f, sec, job.ID, attemptID)
	if err != nil {
		t.Fatalf("NewFrameReader: %v", err)
	}
	got, manifestEntries := collectEntryIDs(t, json.NewDecoder(fr))
	want := append([]uuid.UUID{activeID, deletedID}, synthIDs...)
	if len(got) != len(want) {
		t.Fatalf("entries decoded = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("entry[%d] = %s, want %s (order/identity mismatch)", i, got[i], want[i])
		}
	}
	if manifestEntries != len(got) {
		t.Fatalf("manifest snapshot.counts.entries = %d, decoded %d", manifestEntries, len(got))
	}
	if _, err := io.Copy(io.Discard, fr); err != nil {
		t.Fatalf("final-frame verification: %v", err)
	}
}

// collectEntryIDs walks the decoded .sabk.json stream and returns the entry
// IDs in file order (memory-bounded: only the ID per row is kept) plus the
// manifest's snapshot.counts.entries.
func collectEntryIDs(t *testing.T, dec *json.Decoder) ([]uuid.UUID, int) {
	t.Helper()
	ctx := context.Background()
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		t.Fatalf("sabk root: %v tok=%v", err, tok)
	}
	var ids []uuid.UUID
	manifest := -1
	for dec.More() {
		kTok, err := dec.Token()
		if err != nil {
			t.Fatalf("key token: %v", err)
		}
		key, _ := kTok.(string)
		switch key {
		case "snapshot":
			var s SabkSnapshot
			if err := dec.Decode(&s); err != nil {
				t.Fatalf("snapshot decode: %v", err)
			}
			manifest = int(s.Counts.Entries)
			continue
		case SectionEntries:
		default:
			if err := skipJSONValue(ctx, dec); err != nil {
				t.Fatalf("skip %v: %v", key, err)
			}
			continue
		}
		open, err := dec.Token()
		if err != nil || open != json.Delim('[') {
			t.Fatalf("entries open: %v", err)
		}
		for dec.More() {
			var e struct {
				ID uuid.UUID `json:"id"`
			}
			if err := dec.Decode(&e); err != nil {
				t.Fatalf("entry decode: %v", err)
			}
			ids = append(ids, e.ID)
		}
		if _, err := dec.Token(); err != nil {
			t.Fatalf("entries close: %v", err)
		}
	}
	if manifest < 0 {
		t.Fatal("manifest snapshot section missing")
	}
	return ids, manifest
}

// Lease / retry / rescue tests (plan C04).

func TestExportClaimSnoozeWhileLeaseLive(t *testing.T) {
	pool, _, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)

	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	// Simulate an active worker holding a live lease.
	q := gen.New(pool)
	claim, err := q.ClaimExportJob(ctx, gen.ClaimExportJobParams{
		LeaseSeconds: 600,
		ID:           job.ID,
	})
	if err != nil || claim.AttemptID == nil {
		t.Fatalf("initial claim: %v", err)
	}
	// Early duplicate/rescue delivery while lease is live must snooze (NOT JobCancel).
	err = w.Work(ctx, makeRiverJob(job.ID, userID, 2, 3))
	var snoozeErr *river.JobSnoozeError
	if !errors.As(err, &snoozeErr) {
		t.Fatalf("expected JobSnoozeError while lease live, got %T (%v)", err, err)
	}
	// Once lease expires, retry claims and completes to ready.
	if _, err := pool.Exec(ctx, `UPDATE export_job SET lease_until = now() - interval '1 second' WHERE id = $1`, job.ID); err != nil {
		t.Fatal(err)
	}
	if err := w.Work(ctx, makeRiverJob(job.ID, userID, 2, 3)); err != nil {
		t.Fatalf("rescue Work after lease expiry: %v", err)
	}
	got, err := svc.Get(ctx, userID, job.ID)
	if err != nil || got.Status != StatusReady {
		t.Fatalf("after rescue: status=%s err=%v", got.Status, err)
	}
}

func TestExportAttemptErrorReleasesLease(t *testing.T) {
	pool, cfg, svc, _ := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)

	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	boom := errors.New("simulated mid-attempt failure")
	failing := NewExportWorker(WorkerDeps{
		Pool:       pool,
		StorageDir: cfg.ExportStorageDir,
		Secret:     cfg.ExportAtRestSecret,
		AfterBatchHook: func(ctx context.Context, _, _ uuid.UUID) {
			// Cancel context not used; trigger failure by corrupting storage dir after claim.
		},
	})
	// Force attempt 1 to fail by pointing StorageDir at a regular file.
	badFile := filepath.Join(cfg.ExportStorageDir, "not-a-dir")
	if err := os.WriteFile(badFile, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	failing.storageDir = filepath.Join(badFile, "sub")
	_ = boom
	if err := failing.Work(ctx, makeRiverJob(job.ID, userID, 1, 3)); err == nil {
		t.Fatalf("expected attempt 1 error")
	}

	// Lease must have been released so attempt 2 can claim immediately without waiting 10m.
	good := NewExportWorker(WorkerDeps{
		Pool:       pool,
		StorageDir: cfg.ExportStorageDir,
		Secret:     cfg.ExportAtRestSecret,
	})
	if err := good.Work(ctx, makeRiverJob(job.ID, userID, 2, 3)); err != nil {
		t.Fatalf("attempt 2 immediate claim failed: %v", err)
	}
	got, err := svc.Get(ctx, userID, job.ID)
	if err != nil || got.Status != StatusReady {
		t.Fatalf("after retry: status=%s err=%v", got.Status, err)
	}
}

func TestExportLateOldAttemptCannotOverwrite(t *testing.T) {
	pool, cfg, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)

	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	q := gen.New(pool)
	oldClaim, err := q.ClaimExportJob(ctx, gen.ClaimExportJobParams{
		LeaseSeconds: -1, // already expired so attempt 2 can rescue
		ID:           job.ID,
	})
	if err != nil || oldClaim.AttemptID == nil {
		t.Fatal(err)
	}
	oldAttempt := *oldClaim.AttemptID

	// Attempt 2 rescues and finishes to ready.
	if err := w.Work(ctx, makeRiverJob(job.ID, userID, 2, 3)); err != nil {
		t.Fatalf("attempt 2 Work: %v", err)
	}

	// Late old attempt tries to mark failed or release/renew lease: must affect 0 rows.
	lateErr := "late_fail"
	nFail, err := q.FailExportAttempt(ctx, gen.FailExportAttemptParams{
		ErrorCode: &lateErr,
		ID:        job.ID,
		AttemptID: &oldAttempt,
	})
	if err != nil || nFail != 0 {
		t.Fatalf("FailExportAttempt(oldAttempt): n=%d err=%v, want 0", nFail, err)
	}
	published, err := w.finalizeCAS(ctx, job.ID, userID, oldAttempt, SafeFileName(job.ID, oldAttempt, "sabk.enc"), 123, canonicalSampleVaultKeyID, 3)
	if err != nil || published {
		t.Fatalf("finalizeCAS(oldAttempt): published=%v err=%v, want false", published, err)
	}
	_ = cfg
	got, _ := svc.Get(ctx, userID, job.ID)
	if got.Status != StatusReady {
		t.Fatalf("status changed to %s", got.Status)
	}
}

func TestExportTerminalNeverRevived(t *testing.T) {
	pool, _, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)

	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Cancel(ctx, userID, job.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	err = w.Work(ctx, makeRiverJob(job.ID, userID, 1, 3))
	var cancelErr *river.JobCancelError
	if !errors.As(err, &cancelErr) {
		t.Fatalf("expected JobCancelError on cancelled job, got %v", err)
	}
	got, _ := svc.Get(ctx, userID, job.ID)
	if got.Status != StatusCancelled {
		t.Fatalf("terminal status revived to %s", got.Status)
	}
}

func TestExportReconcilerWorkerLost(t *testing.T) {
	pool, cfg, svc, _ := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)

	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	q := gen.New(pool)
	if _, err := q.ClaimExportJob(ctx, gen.ClaimExportJobParams{LeaseSeconds: 60, ID: job.ID}); err != nil {
		t.Fatal(err)
	}
	// Simulate an orphaned running job whose lease expired > 15m ago with no live river_job.
	if _, err := pool.Exec(ctx, `UPDATE export_job SET lease_until = now() - interval '20 minutes' WHERE id = $1`, job.ID); err != nil {
		t.Fatal(err)
	}
	pw := NewPruneWorker(pool, cfg.ExportStorageDir, clock.System{}, nil)
	if err := pw.Sweep(ctx); err != nil {
		t.Fatalf("PruneWorker.Sweep: %v", err)
	}
	got, err := svc.Get(ctx, userID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusFailed || got.ErrorCode == nil || *got.ErrorCode != "worker_lost" {
		t.Fatalf("expected failed/worker_lost, got status=%s code=%v", got.Status, got.ErrorCode)
	}
	// Unique active index is now free: user can create a new job.
	next, created, err := svc.Create(ctx, userID, "")
	if err != nil || !created || next.ID == job.ID {
		t.Fatalf("Create after worker_lost: created=%v id=%s err=%v", created, next.ID, err)
	}
}

// Quota + coalescing tests (plan P06-A11, R2-04).

func TestExportCreateRateLimit(t *testing.T) {
	pool, _, svc, _ := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)

	// 3 new jobs (cancel each so the unique active index allows the next new creation);
	// cancelled jobs still count toward the 3/60m quota.
	for i := range 3 {
		j, created, err := svc.Create(ctx, userID, "")
		if err != nil || !created {
			t.Fatalf("create #%d: created=%v err=%v", i+1, created, err)
		}
		if _, err := svc.Cancel(ctx, userID, j.ID); err != nil {
			t.Fatalf("cancel #%d: %v", i+1, err)
		}
	}
	// 4th creation within the hour must fail with RateLimitError.
	_, _, err := svc.Create(ctx, userID, "")
	var rlErr *RateLimitError
	if !errors.As(err, &rlErr) || rlErr.RetryAfter < 1 {
		t.Fatalf("4th create: got err=%v, want RateLimitError", err)
	}
}

func TestExportCreateCoalesceActiveOnly(t *testing.T) {
	pool, _, svc, _ := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)

	// Two parallel Create calls with different keys must serialize on the
	// advisory lock, create 1 job, and record 1 rate_event.
	var wg sync.WaitGroup
	var j1, j2 Job
	var e1, e2 error
	wg.Add(2)
	go func() {
		defer wg.Done()
		j1, _, e1 = svc.Create(ctx, userID, "k1")
	}()
	go func() {
		defer wg.Done()
		j2, _, e2 = svc.Create(ctx, userID, "k2")
	}()
	wg.Wait()
	if e1 != nil || e2 != nil || j1.ID != j2.ID {
		t.Fatalf("parallel Create: j1=%s err=%v, j2=%s err=%v", j1.ID, e1, j2.ID, e2)
	}
	var rateEvents int
	if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM rate_event WHERE user_id = $1 AND scope = $2`, userID, httpx.ScopeExportCreate).Scan(&rateEvents); err != nil {
		t.Fatal(err)
	}
	if rateEvents != 1 {
		t.Fatalf("rate_event count = %d, want 1", rateEvents)
	}

	// Even if the user already has 3 rate_events in the window, coalescing onto
	// an active queued/running job must return 202 (0 quota consumed).
	for range 2 {
		if _, err := pool.Exec(ctx, `INSERT INTO rate_event (user_id, scope) VALUES ($1, $2)`, userID, httpx.ScopeExportCreate); err != nil {
			t.Fatal(err)
		}
	}
	coal, created, err := svc.Create(ctx, userID, "k3")
	if err != nil || created || coal.ID != j1.ID {
		t.Fatalf("coalesce with 3 events: created=%v id=%s err=%v", created, coal.ID, err)
	}
}

func TestExportCreateReadyNotCoalesced(t *testing.T) {
	pool, _, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)

	j1, created, err := svc.Create(ctx, userID, "")
	if err != nil || !created {
		t.Fatal(err)
	}
	if err := w.Work(ctx, makeRiverJob(j1.ID, userID, 1, 3)); err != nil {
		t.Fatal(err)
	}

	// Mutate vault data after j1 is ready.
	if _, err := pool.Exec(ctx, `INSERT INTO tag (id, user_id, display, normalized, item_count) VALUES ($1, $2, 'added-after', 'added-after', 0)`, uuid.New(), userID); err != nil {
		t.Fatal(err)
	}

	// A ready job is NOT coalesced: Create makes a new queued job j2 (consuming 1 quota),
	// and j1 stays ready/downloadable until j2 finishes Finalize CAS.
	j2, created, err := svc.Create(ctx, userID, "")
	if err != nil || !created || j2.ID == j1.ID {
		t.Fatalf("Create after ready: created=%v j2=%s j1=%s err=%v", created, j2.ID, j1.ID, err)
	}
	j1WhileJ2Queued, err := svc.Get(ctx, userID, j1.ID)
	if err != nil || j1WhileJ2Queued.Status != StatusReady {
		t.Fatalf("j1 must remain ready while j2 is queued, got %s (%v)", j1WhileJ2Queued.Status, err)
	}

	if err := w.Work(ctx, makeRiverJob(j2.ID, userID, 1, 3)); err != nil {
		t.Fatal(err)
	}
	j1After, _ := svc.Get(ctx, userID, j1.ID)
	if j1After.Status != StatusExpired {
		t.Fatalf("j1 must become expired once j2 is ready, got %s", j1After.Status)
	}
	dl2, err := svc.OpenDownload(ctx, userID, j2.ID)
	if err != nil {
		t.Fatal(err)
	}
	raw2, _ := io.ReadAll(dl2)
	_ = dl2.Close()
	if !bytes.Contains(raw2, []byte("added-after")) {
		t.Fatalf("j2 snapshot missing tag added after j1")
	}
}

func TestExportCreatePaused(t *testing.T) {
	pool, _, svc, _ := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)

	svc.SetCreatePaused(true)
	if _, _, err := svc.Create(ctx, userID, ""); !errors.Is(err, ErrCreatePaused) {
		t.Fatalf("paused Create: got %v, want ErrCreatePaused", err)
	}
	var jobs, events int
	_ = pool.QueryRow(ctx, `SELECT count(*)::int FROM export_job WHERE user_id = $1`, userID).Scan(&jobs)
	_ = pool.QueryRow(ctx, `SELECT count(*)::int FROM rate_event WHERE user_id = $1`, userID).Scan(&events)
	if jobs != 0 || events != 0 {
		t.Fatalf("paused Create wrote rows: jobs=%d events=%d", jobs, events)
	}
}

func TestExportFileCleanupWorker(t *testing.T) {
	pool, cfg, _, _ := setupExportTestDB(t)
	ctx := context.Background()
	q := gen.New(pool)

	jobID := uuid.New()
	attID := uuid.New()
	fn := SafeFileName(jobID, attID, "sabk.enc")
	full := filepath.Join(cfg.ExportStorageDir, fn)
	if err := os.WriteFile(full, []byte("ciphertext"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Insert cleanup row with NO corresponding app_user or export_job row (post-DELETE /me).
	rec, err := q.InsertExportFileCleanup(ctx, gen.InsertExportFileCleanupParams{
		FileName:  fn,
		JobID:     jobID,
		AttemptID: &attID,
		Reason:    CleanupReasonAccountDelete,
	})
	if err != nil {
		t.Fatal(err)
	}
	cw := NewCleanupWorker(pool, cfg.ExportStorageDir, nil)
	rjob := &river.Job[exportcleanup.Args]{
		JobRow: &rivertype.JobRow{ID: 1, Attempt: 1, MaxAttempts: 25},
		Args:   exportcleanup.Args{CleanupID: rec.ID},
	}
	if err := cw.Work(ctx, rjob); err != nil {
		t.Fatalf("CleanupWorker.Work: %v", err)
	}
	if _, err := os.Stat(full); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("file still exists after cleanup: %v", err)
	}
	// Re-running when file is already absent (ENOENT) is idempotent.
	if err := cw.Work(ctx, rjob); err != nil {
		t.Fatalf("idempotent CleanupWorker.Work: %v", err)
	}
	updated, err := q.GetExportCleanup(ctx, rec.ID)
	if err != nil || !updated.DoneAt.Valid {
		t.Fatalf("done_at not set: %+v err=%v", updated, err)
	}
}

type queryCountTracer struct {
	mu      sync.Mutex
	queries []string
}

func (t *queryCountTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	sql := strings.TrimSpace(data.SQL)
	t.mu.Lock()
	t.queries = append(t.queries, sql)
	t.mu.Unlock()
	return ctx
}

func (t *queryCountTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (t *queryCountTracer) reset() {
	t.mu.Lock()
	t.queries = nil
	t.mu.Unlock()
}

func (t *queryCountTracer) snapshot() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.queries...)
}

// TestExportDecryptedPages verifies (plan mục 2.7.2, P06-A3, R2-02):
//   - pages come exclusively from the job's .sabk.enc file (pgx tracer sees
//     only the export_job lookup, never tag/item/item_tag/entry);
//   - soft-deleted rows are filtered out;
//   - mutating/deleting/reordering live DB rows between pages does not change
//     subsequent pages or the file on disk;
//   - tampered/cross-user cursor -> ErrInvalidCursor (400);
//   - expired job -> ErrExpired (410);
//   - queued/running/failed/cancelled job -> ErrNotReady (409).
func TestExportDecryptedPages(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)

	tracer := &queryCountTracer{}
	pcfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	pcfg.MaxConns = 4
	pcfg.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(context.Background(), pcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	cfg := newTestConfig(t)
	svc, err := NewService(cfg, pool, nil, nil, clock.System{})
	if err != nil {
		t.Fatal(err)
	}
	w := NewExportWorker(WorkerDeps{
		Pool:       pool,
		StorageDir: cfg.ExportStorageDir,
		Secret:     cfg.ExportAtRestSecret,
	})
	ctx := context.Background()
	userID, _, activeEntryID, deletedEntryID, _ := seedUserAndVault(t, pool)

	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	// Queued -> ErrNotReady (409).
	if _, err := svc.DecryptedPages(ctx, userID, job.ID, "", 512); !errors.Is(err, ErrNotReady) {
		t.Fatalf("queued DecryptedPages: got %v, want ErrNotReady", err)
	}
	if err := w.Work(ctx, makeRiverJob(job.ID, userID, 1, 3)); err != nil {
		t.Fatal(err)
	}

	tracer.reset()
	// First page (tiny budget so each section lands on its own page).
	p1, err := svc.DecryptedPages(ctx, userID, job.ID, "", 300)
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if p1.VaultKeyID != canonicalSampleVaultKeyID || p1.TotalEntries != 1 || p1.Section != SectionTags || len(p1.Items) != 1 || p1.NextCursor == nil {
		t.Fatalf("page 1 unexpected: %+v", p1)
	}

	// Between page 1 and page 2, wipe all content tables in Postgres to prove
	// subsequent pages read ONLY the immutable .sabk.enc file on disk.
	if _, err := pool.Exec(ctx, `DELETE FROM entry WHERE user_id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM item WHERE user_id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM tag WHERE user_id = $1`, userID); err != nil {
		t.Fatal(err)
	}

	tracer.reset()
	seenSections := []string{p1.Section}
	cur := *p1.NextCursor
	var entryItems []json.RawMessage
	for cur != "" {
		page, err := svc.DecryptedPages(ctx, userID, job.ID, cur, 300)
		if err != nil {
			t.Fatalf("page(cur): %v", err)
		}
		seenSections = append(seenSections, page.Section)
		if page.Section == SectionEntries {
			entryItems = append(entryItems, page.Items...)
		}
		if page.NextCursor == nil {
			break
		}
		cur = *page.NextCursor
	}
	if len(seenSections) < 4 {
		t.Fatalf("seenSections = %v, want at least 4 section pages", seenSections)
	}
	if len(entryItems) != 1 {
		t.Fatalf("expected 1 active entry (soft-deleted filtered), got %d", len(entryItems))
	}
	if !bytes.Contains(entryItems[0], []byte(activeEntryID.String())) || bytes.Contains(entryItems[0], []byte(deletedEntryID.String())) {
		t.Fatalf("entry page item = %s", entryItems[0])
	}

	// Verify pgx tracer saw ONLY export_job queries during DecryptedPages.
	for _, sql := range tracer.snapshot() {
		lower := strings.ToLower(sql)
		if strings.Contains(lower, "from tag") || strings.Contains(lower, "from item") || strings.Contains(lower, "from entry") || strings.Contains(lower, "from vault") {
			t.Fatalf("DecryptedPages queried content table: %s", sql)
		}
	}

	// Tampered cursor -> ErrInvalidCursor (400).
	badCur := (*p1.NextCursor)[:len(*p1.NextCursor)-2] + "AA"
	if _, err := svc.DecryptedPages(ctx, userID, job.ID, badCur, 300); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("tampered cursor: got %v, want ErrInvalidCursor", err)
	}

	// Expired job -> ErrExpired (410).
	if _, err := pool.Exec(ctx, `UPDATE export_job SET expires_at = now() - interval '1 second' WHERE id = $1`, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.DecryptedPages(ctx, userID, job.ID, "", 300); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired DecryptedPages: got %v, want ErrExpired", err)
	}

	// Cancelled job -> ErrNotReady (409).
	if _, err := pool.Exec(ctx, `UPDATE export_job SET status = 'cancelled', expires_at = now() + interval '1 hour' WHERE id = $1`, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.DecryptedPages(ctx, userID, job.ID, "", 300); !errors.Is(err, ErrNotReady) {
		t.Fatalf("cancelled DecryptedPages: got %v, want ErrNotReady", err)
	}

	// RecordDecryptedAudit writes export.decrypted audit + notification.
	p := authctx.Principal{UserID: userID, SessionID: uuid.New()}
	if err := svc.RecordDecryptedAudit(ctx, p, "203.0.113.7", "test-agent"); err != nil {
		t.Fatalf("RecordDecryptedAudit: %v", err)
	}
}
