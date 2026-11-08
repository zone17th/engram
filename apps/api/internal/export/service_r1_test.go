package export

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/blake2b"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

// TestSabkWorkerArtifactRestore verifies (review r1 R1-07) that the artifact the
// REAL worker produces still restores the vault key through all three recovery
// paths — passphrase KEK, recovery-key wrap and passkey PRF — after the live
// server has rotated its KEK, consumed the RK and revoked the passkey, i.e.
// writeSabkPreamble wrote the correct wraps/salts, not just the checked-in
// fixture.
func TestSabkWorkerArtifactRestore(t *testing.T) {
	pool, _, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, activeEntryID, deletedEntryID, _ := seedUserAndVault(t, pool)

	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Work(ctx, makeRiverJob(job.ID, userID, 1, 3)); err != nil {
		t.Fatalf("Work: %v", err)
	}
	dl, err := svc.OpenDownload(ctx, userID, job.ID)
	if err != nil {
		t.Fatalf("OpenDownload: %v", err)
	}
	rawSabk, err := io.ReadAll(dl)
	_ = dl.Close()
	if err != nil {
		t.Fatalf("read: %v", err)
	}

	// Mutate the LIVE server state exactly like the operations named in the
	// plan: KEK rotation (new wrapK + version bump), RK slot consumed, passkey
	// revoked, then the whole account deleted. The downloaded artifact must be
	// unaffected.
	newKEKWrap := vault.EncodeBase64URL(bytes.Repeat([]byte{0x33}, 73))
	if _, err := pool.Exec(ctx, `UPDATE vault SET vault_key_wrapped_by_kek = $1, version = version + 1 WHERE user_id = $2`, newKEKWrap, userID); err != nil {
		t.Fatalf("rotate KEK: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM vault_recovery_key WHERE vault_id = $1`, userID); err != nil {
		t.Fatalf("consume RK: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM vault_passkey WHERE user_id = $1`, userID); err != nil {
		t.Fatalf("revoke passkey: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM app_user WHERE id = $1`, userID); err != nil {
		t.Fatalf("delete account: %v", err)
	}

	var doc struct {
		Vault   SabkVault   `json:"vault"`
		Entries []SabkEntry `json:"entries"`
	}
	if err := json.Unmarshal(rawSabk, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	vec := loadJSVectors(t)

	// Path 1: passphrase -> Argon2id KEK -> VK.
	var kdf vault.KDFParams
	if err := json.Unmarshal(doc.Vault.KDF, &kdf); err != nil {
		t.Fatal(err)
	}
	salt, err := vault.DecodeBase64URLStrict(kdf.Salt, vault.KDFSaltBytes)
	if err != nil {
		t.Fatal(err)
	}
	kek := argon2.IDKey([]byte(vec.Inputs.PassphraseUTF8), salt, uint32(kdf.Ops), uint32(kdf.Mem/1024), uint8(kdf.Parallelism), 32)
	vkPass, err := vault.OpenWrapBase64URL(vault.WrapKindKEK, doc.Vault.VaultKeyWrappedByKEK, kek)
	if err != nil {
		t.Fatalf("passphrase path on worker artifact: %v", err)
	}

	// Path 2: original recovery key -> lookup + wrap keys -> VK.
	rkLookup := blake2b.Sum256(append([]byte(vault.RKLookupDomain), []byte(vec.Inputs.RKNorm)...))
	var rkWrap string
	for _, rk := range doc.Vault.RecoveryKeys {
		if rk.LookupHash == vault.EncodeBase64URL(rkLookup[:]) {
			rkWrap = rk.Wrap
			break
		}
	}
	if rkWrap == "" {
		t.Fatal("worker artifact lacks the seeded RK slot")
	}
	rkWrapKey := blake2b.Sum256(append([]byte(vault.RKWrapDomain), []byte(vec.Inputs.RKNorm)...))
	vkRK, err := vault.OpenWrapBase64URL(vault.WrapKindRK, rkWrap, rkWrapKey[:])
	if err != nil || !bytes.Equal(vkRK, vkPass) {
		t.Fatalf("RK path on worker artifact: err=%v", err)
	}

	// Path 3: passkey PRF output -> VK.
	pwk, err := vault.DecodeBase64URLStrict(vec.Inputs.PWKB64U, 32)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Vault.Passkeys) != 1 {
		t.Fatalf("passkeys in artifact = %d", len(doc.Vault.Passkeys))
	}
	vkPRF, err := vault.OpenWrapBase64URL(vault.WrapKindPRF, doc.Vault.Passkeys[0].VKWrap, pwk)
	if err != nil || !bytes.Equal(vkPRF, vkPass) {
		t.Fatalf("PRF path on worker artifact: err=%v", err)
	}

	// Every entry opens with the recovered VK.
	wantPlain := map[string]string{
		activeEntryID.String():  vec.Inputs.Entries.Text.PlaintextUTF8,
		deletedEntryID.String(): vec.Inputs.Entries.JSON.PlaintextUTF8,
	}
	if len(doc.Entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(doc.Entries))
	}
	for _, e := range doc.Entries {
		_, pt, err := vault.OpenEntryBase64URL(e.Envelope, e.ID.String(), e.Ciphertext, vkPass)
		if err != nil {
			t.Fatalf("OpenEntry(%s): %v", e.ID, err)
		}
		if string(pt) != wantPlain[e.ID.String()] {
			t.Fatalf("entry %s plaintext mismatch", e.ID)
		}
	}
}

// TestExportDecryptedPagesContinuation exercises same-section continuation
// across multiple ENGX1 frames and page budgets (review r1 R1-10): seeded
// entries with large ciphertexts force >1 frame, a small budget forces
// mid-section splits; all active ids must appear once, in query order, with
// each marshaled page ≤ 1 MiB.
func TestExportDecryptedPagesContinuation(t *testing.T) {
	pool, _, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, itemID, actID, _, _ := seedUserAndVault(t, pool)

	// Seed extra entries: ~200 KiB ciphertext each so the entries section spans
	// multiple 64 KiB plaintext frames; interleave soft-deleted tombstones.
	var wantOrder []uuid.UUID
	wantOrder = append(wantOrder, actID) // seeded entry: position 0 sorts first
	ct := bytes.Repeat([]byte{0xcd}, 200*1024)
	envRaw := []byte(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"vk:AAECAwQFBgcICQoLDA0ODw","nonce":"AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY","ct_enc":"utf8"}`)
	for i := 0; i < 6; i++ {
		eid := uuid.New()
		if _, err := pool.Exec(ctx, `
			INSERT INTO entry (id, user_id, item_id, type, position, envelope, ciphertext, plaintext_len_bucket, version)
			VALUES ($1, $2, $3, 'text', $4, $5, $6, 204800, 1)
		`, eid, userID, itemID, 100+i, envRaw, ct); err != nil {
			t.Fatal(err)
		}
		wantOrder = append(wantOrder, eid)
		if i == 2 {
			// Tombstone at a later position; must never appear in pages.
			tomb := uuid.New()
			if _, err := pool.Exec(ctx, `
				INSERT INTO entry (id, user_id, item_id, type, position, envelope, ciphertext, plaintext_len_bucket, version, deleted_at, deleted_via)
				VALUES ($1, $2, $3, 'text', $4, $5, $6, 204800, 1, now(), 'entry')
			`, tomb, userID, itemID, 1000, envRaw, ct); err != nil {
				t.Fatal(err)
			}
		}
	}

	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Work(ctx, makeRiverJob(job.ID, userID, 1, 3)); err != nil {
		t.Fatalf("Work: %v", err)
	}

	// Walk pages with a budget smaller than one projected entry row.
	var gotIDs []uuid.UUID
	cur := ""
	for i := 0; i < 64; i++ {
		page, err := svc.DecryptedPages(ctx, userID, job.ID, cur, 4096)
		if err != nil {
			t.Fatalf("page %d: %v", i, err)
		}
		raw, _ := json.Marshal(page)
		if len(raw) > DecryptedPageMaxBytes {
			t.Fatalf("page %d marshaled %d B > 1 MiB", i, len(raw))
		}
		if page.Section == SectionEntries {
			for _, it := range page.Items {
				var e struct {
					ID uuid.UUID `json:"id"`
				}
				if err := json.Unmarshal(it, &e); err != nil {
					t.Fatal(err)
				}
				gotIDs = append(gotIDs, e.ID)
			}
		}
		if page.NextCursor == nil {
			break
		}
		cur = *page.NextCursor
	}
	if len(gotIDs) != len(wantOrder) {
		t.Fatalf("got %d entry items, want %d", len(gotIDs), len(wantOrder))
	}
	for i, id := range wantOrder {
		if gotIDs[i] != id {
			t.Fatalf("entry[%d] = %s, want %s", i, gotIDs[i], id)
		}
	}
}

// TestExportCleanupENOENTPending covers the crash-recovery branch (review r1
// R1-12): a still-pending cleanup row whose file is already absent completes
// with done_at via ENOENT; a permanently failing row surfaces an error and
// stays pending, then succeeds after the obstruction is removed.
func TestExportCleanupENOENTPending(t *testing.T) {
	pool, cfg, _, _ := setupExportTestDB(t)
	ctx := context.Background()
	q := gen.New(pool)

	// Case 1: pending row + missing file -> ENOENT branch completes it.
	jobID, attID := uuid.New(), uuid.New()
	rec, err := q.InsertExportFileCleanup(ctx, gen.InsertExportFileCleanupParams{
		FileName:  SafeFileName(jobID, attID, "sabk.enc"),
		JobID:     jobID,
		AttemptID: &attID,
		Reason:    CleanupReasonAccountDelete,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := runOneCleanup(ctx, q, cfg.ExportStorageDir, rec.ID); err != nil {
		t.Fatalf("ENOENT cleanup: %v", err)
	}
	row, err := q.GetExportCleanup(ctx, rec.ID)
	if err != nil || !row.DoneAt.Valid {
		t.Fatalf("ENOENT row not completed: %+v", row)
	}

	// Case 2: pending row pointing at a directory (unlink fails with a
	// non-ENOENT error) -> error returned, row stays pending, succeeds after
	// the obstruction is removed (R1-04 semantics at the single-row level).
	badID, badAtt := uuid.New(), uuid.New()
	badName := SafeFileName(badID, badAtt, "tmp")
	badDir := filepath.Join(cfg.ExportStorageDir, badName)
	if err := os.Mkdir(badDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(badDir, "keep"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec2, err := q.InsertExportFileCleanup(ctx, gen.InsertExportFileCleanupParams{
		FileName:  badName,
		JobID:     badID,
		AttemptID: &badAtt,
		Reason:    CleanupReasonAccountDelete,
	})
	if err != nil {
		t.Fatal(err)
	}
	err = runOneCleanup(ctx, q, cfg.ExportStorageDir, rec2.ID)
	if err == nil {
		t.Fatal("expected unlink failure on directory target")
	}
	row2, _ := q.GetExportCleanup(ctx, rec2.ID)
	if row2.DoneAt.Valid {
		t.Fatal("failed cleanup was marked done")
	}
	if err := os.RemoveAll(badDir); err != nil {
		t.Fatal(err)
	}
	if err := runOneCleanup(ctx, q, cfg.ExportStorageDir, rec2.ID); err != nil {
		t.Fatalf("retry after repair: %v", err)
	}
	row2, _ = q.GetExportCleanup(ctx, rec2.ID)
	if !row2.DoneAt.Valid {
		t.Fatal("cleanup still pending after repair")
	}
}

// insertStaleRunningExport creates one user + one running export_job whose
// lease expired 20 min ago. If liveRiver is true it also inserts a live
// river_job row referencing the export's job_id.
func insertStaleRunningExport(t *testing.T, pool *pgxpool.Pool, liveRiver bool) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email, email_verified_at) VALUES ($1, now()) RETURNING id`,
		"stale-"+uuid.NewString()+"@example.com").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	var jobID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO export_job (user_id, kind, status, attempt_id, lease_until)
		VALUES ($1, 'encrypted', 'running', $2, now() - interval '20 minutes')
		RETURNING id`, userID, uuid.New()).Scan(&jobID); err != nil {
		t.Fatal(err)
	}
	if liveRiver {
		if _, err := pool.Exec(ctx, `
			INSERT INTO river_job (state, max_attempts, kind, args, queue)
			VALUES ('available', 3, 'export_encrypted',
			        jsonb_build_object('job_id', $1::text, 'user_id', $2::text), 'default')`,
			jobID.String(), userID.String()); err != nil {
			t.Fatal(err)
		}
	}
	return jobID
}

// TestExportStaleRunningKeysetCoverage is the r1 R1-18 regression: 100 older
// stale-but-live rows must not hide a later stale orphan from one sweep.
func TestExportStaleRunningKeysetCoverage(t *testing.T) {
	pool, cfg, _, _ := setupExportTestDB(t)
	ctx := context.Background()
	for i := 0; i < staleExportBatchLimit; i++ {
		insertStaleRunningExport(t, pool, true)
	}
	orphan := insertStaleRunningExport(t, pool, false)
	pw := NewPruneWorker(pool, cfg.ExportStorageDir, clock.System{}, nil)
	if err := pw.reconcileStaleRunning(ctx, pw.clk.Now()); err != nil {
		t.Fatalf("reconcileStaleRunning: %v", err)
	}
	var status, code string
	if err := pool.QueryRow(ctx, `SELECT status, coalesce(error_code,'') FROM export_job WHERE id = $1`, orphan).
		Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	if status != StatusFailed || code != "worker_lost" {
		t.Fatalf("orphan not reconciled: status=%s code=%s", status, code)
	}
	var live int
	if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM export_job WHERE status = 'running'`).Scan(&live); err != nil {
		t.Fatal(err)
	}
	if live != staleExportBatchLimit {
		t.Fatalf("live rows mutated: %d", live)
	}
}

// TestExportStaleQueuedNoDeliveryFails is the r1 R1-16 regression: a queued
// job older than the worker-lost window with no live river_job is failed so
// future Creates are not stranded; one with a live delivery is preserved.
func TestExportStaleQueuedNoDeliveryFails(t *testing.T) {
	pool, cfg, _, _ := setupExportTestDB(t)
	ctx := context.Background()
	mk := func(liveRiver bool, fresh bool) uuid.UUID {
		var userID uuid.UUID
		if err := pool.QueryRow(ctx, `INSERT INTO app_user (email, email_verified_at) VALUES ($1, now()) RETURNING id`,
			"q-"+uuid.NewString()+"@example.com").Scan(&userID); err != nil {
			t.Fatal(err)
		}
		var jobID uuid.UUID
		age := "20 minutes"
		if fresh {
			age = "1 minute"
		}
		if err := pool.QueryRow(ctx, `
			INSERT INTO export_job (user_id, kind, status, created_at)
			VALUES ($1, 'encrypted', 'queued', now() - $2::interval)
			RETURNING id`, userID, age).Scan(&jobID); err != nil {
			t.Fatal(err)
		}
		if liveRiver {
			if _, err := pool.Exec(ctx, `
				INSERT INTO river_job (state, max_attempts, kind, args, queue)
				VALUES ('retryable', 3, 'export_encrypted',
				        jsonb_build_object('job_id', $1::text, 'user_id', $2::text), 'default')`,
				jobID.String(), userID.String()); err != nil {
				t.Fatal(err)
			}
		}
		return jobID
	}
	dead := mk(false, false)
	live := mk(true, false)
	fresh := mk(false, true)
	pw := NewPruneWorker(pool, cfg.ExportStorageDir, clock.System{}, nil)
	if err := pw.reconcileStaleQueued(ctx, pw.clk.Now()); err != nil {
		t.Fatalf("reconcileStaleQueued: %v", err)
	}
	statusOf := func(id uuid.UUID) string {
		var s string
		if err := pool.QueryRow(ctx, `SELECT status FROM export_job WHERE id = $1`, id).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	if got := statusOf(dead); got != StatusFailed {
		t.Fatalf("dead queued not failed: %s", got)
	}
	if got := statusOf(live); got != StatusQueued {
		t.Fatalf("live queued mutated: %s", got)
	}
	if got := statusOf(fresh); got != StatusQueued {
		t.Fatalf("fresh queued mutated: %s", got)
	}
}

// TestExportWorkerTimeoutOverride asserts the executor timeout override for
// export attempts (r1 R1-17): the default would be River's 60 s.
func TestExportWorkerTimeoutOverride(t *testing.T) {
	w := &ExportWorker{}
	if got := w.Timeout(nil); got != ExportJobTimeout {
		t.Fatalf("Timeout() = %v, want %v", got, ExportJobTimeout)
	}
	if ExportJobTimeout <= time.Minute {
		t.Fatalf("ExportJobTimeout %v must exceed River's 60s default", ExportJobTimeout)
	}
}

// TestResolvePublication covers r1 R1-13's post-ambiguous-commit resolution:
// ready-for-this-attempt returns true, other states return false without
// error so the artifact is preserved for state-aware cleanup.
func TestResolvePublication(t *testing.T) {
	pool, _, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)
	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	ok, err := w.resolvePublication(job.ID, userID, uuid.New())
	if err != nil || ok {
		t.Fatalf("queued resolve: ok=%v err=%v", ok, err)
	}
	if _, err := w.resolvePublication(uuid.New(), userID, uuid.New()); err == nil {
		t.Fatal("missing row should be unresolved")
	}
}

// TestFailOrRetrySurvivesCancelledCtx is r1 R1-15: releasing the lease and
// marking the attempt failed must complete even when the Work context is
// already cancelled.
func TestFailOrRetrySurvivesCancelledCtx(t *testing.T) {
	pool, _, svc, w := setupExportTestDB(t)
	ctx := context.Background()
	userID, _, _, _, _ := seedUserAndVault(t, pool)
	job, _, err := svc.Create(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	q := gen.New(pool)
	claim, err := q.ClaimExportJob(ctx, gen.ClaimExportJobParams{LeaseSeconds: 600, ID: job.ID})
	if err != nil || claim.AttemptID == nil {
		t.Fatalf("claim: %v", err)
	}
	dead, cancel := context.WithCancel(ctx)
	cancel()
	cause := errors.New("ctx lost mid-attempt")
	_ = w.failOrRetry(dead, makeRiverJob(job.ID, userID, 1, 3), job.ID, userID, *claim.AttemptID, "io_error", cause)
	// ReleaseExportLease sets lease_until = now(), not NULL.
	var remaining float64
	if err := pool.QueryRow(ctx, `SELECT EXTRACT(EPOCH FROM (lease_until - now()))::float8 FROM export_job WHERE id = $1`, job.ID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining > 1 {
		t.Fatalf("lease not released under cancelled ctx: remaining=%.2fs", remaining)
	}
	_ = w.failOrRetry(dead, makeRiverJob(job.ID, userID, 3, 3), job.ID, userID, *claim.AttemptID, "io_error", cause)
	var status, code string
	if err := pool.QueryRow(ctx, `SELECT status, coalesce(error_code,'') FROM export_job WHERE id = $1`, job.ID).
		Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	if status != StatusFailed || code != "io_error" {
		t.Fatalf("final attempt not failed under cancelled ctx: %s/%s", status, code)
	}
}
