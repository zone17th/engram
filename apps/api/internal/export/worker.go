package export

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/audit"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/jobs/exportcleanup"
	"github.com/zone17th/engram/apps/api/internal/notification"
	"github.com/zone17th/engram/apps/api/internal/secevent"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

// Batch sizes for streaming snapshot serialization (plan mục 2.7.1).
const (
	SabkFormat               = "engram.sabk"
	SabkVersion              = 1
	SabkConsistency          = "repeatable_read"
	SabkRetentionDays        = 30
	metaBatchLimit     int32 = 500
	entryBatchLimit    int32 = 16
	snoozeSlackSeconds       = 5
)

// SabkJSON structs match plan mục 2.1. Each array element is written on its own
// line so decrypted-pages can seek to any element boundary in O(1) frames.
type SabkSnapshot struct {
	Consistency                 string     `json:"consistency"`
	IncludesActive              bool       `json:"includes_active"`
	IncludesSoftDeletedUnpurged bool       `json:"includes_soft_deleted_unpurged"`
	ExcludesPurged              bool       `json:"excludes_purged"`
	SoftDeleteRetentionDays     int        `json:"soft_delete_retention_days"`
	Counts                      SabkCounts `json:"counts"`
}

type SabkCounts struct {
	Tags     int32 `json:"tags"`
	Items    int32 `json:"items"`
	ItemTags int32 `json:"item_tags"`
	Entries  int32 `json:"entries"`
}

type SabkVault struct {
	VaultKeyID           string            `json:"vault_key_id"`
	Version              int32             `json:"version"`
	KDF                  json.RawMessage   `json:"kdf"`
	VaultKeyWrappedByKEK string            `json:"vault_key_wrapped_by_kek"`
	X25519Public         string            `json:"x25519_public"`
	Ed25519Public        string            `json:"ed25519_public"`
	PrivateKeysWrapped   string            `json:"private_keys_wrapped"`
	RecoveryKeys         []SabkRecoveryKey `json:"recovery_keys"`
	Passkeys             []SabkPasskey     `json:"passkeys"`
}

type SabkRecoveryKey struct {
	Slot       int32  `json:"slot"`
	LookupHash string `json:"lookup_hash"`
	Wrap       string `json:"wrap"`
}

type SabkPasskey struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	CredID    string    `json:"cred_id"`
	PRFSalt   string    `json:"prf_salt"`
	VKWrap    string    `json:"vk_wrap"`
	Pubkey    string    `json:"pubkey"`
	AAGUID    string    `json:"aaguid"`
	CreatedAt string    `json:"created_at"`
}

type SabkTag struct {
	ID         uuid.UUID `json:"id"`
	Display    string    `json:"display"`
	Normalized string    `json:"normalized"`
	ItemCount  int32     `json:"item_count"`
	LastUsedAt string    `json:"last_used_at"`
	CreatedAt  string    `json:"created_at"`
	DeletedAt  *string   `json:"deleted_at"`
}

type SabkItem struct {
	ID             uuid.UUID  `json:"id"`
	Name           string     `json:"name"`
	NameNormalized string     `json:"name_normalized"`
	Hint           *string    `json:"hint"`
	EntryCount     int32      `json:"entry_count"`
	Version        int32      `json:"version"`
	LastUsedAt     string     `json:"last_used_at"`
	CreatedAt      string     `json:"created_at"`
	UpdatedAt      string     `json:"updated_at"`
	DeletedAt      *string    `json:"deleted_at"`
	DeleteBatch    *uuid.UUID `json:"delete_batch"`
}

type SabkItemTag struct {
	ItemID    uuid.UUID `json:"item_id"`
	TagID     uuid.UUID `json:"tag_id"`
	CreatedAt string    `json:"created_at"`
}

type SabkEntry struct {
	ID                 uuid.UUID       `json:"id"`
	ItemID             uuid.UUID       `json:"item_id"`
	Type               string          `json:"type"`
	Position           int32           `json:"position"`
	Version            int32           `json:"version"`
	PlaintextLenBucket int32           `json:"plaintext_len_bucket"`
	Envelope           json.RawMessage `json:"envelope"`
	Ciphertext         string          `json:"ciphertext"`
	CreatedAt          string          `json:"created_at"`
	UpdatedAt          string          `json:"updated_at"`
	DeletedAt          *string         `json:"deleted_at"`
	DeletedVia         *string         `json:"deleted_via"`
	DeleteBatch        *uuid.UUID      `json:"delete_batch"`
}

var errAttemptSuperseded = errors.New("export: attempt superseded or cancelled")

// errAmbiguousCommit marks a finalization COMMIT whose server-side outcome is
// unknown; the renamed artifact must be preserved until resolution (r1 R1-13).
var errAmbiguousCommit = errors.New("export: ambiguous finalize commit")

// errSpoolLimit aborts an artifact that exceeds EXPORT_MAX_SPOOL_BYTES; it is
// terminal for the attempt because a retry cannot shrink the vault (r1 R1-19).
var errSpoolLimit = errors.New("export: artifact exceeds EXPORT_MAX_SPOOL_BYTES")

// WorkerDeps configures the export_encrypted River worker.
type WorkerDeps struct {
	Pool       *pgxpool.Pool
	Audit      *audit.Store
	Notify     *notification.Store
	StorageDir string
	Secret     config.Secret
	// MaxSpoolBytes bounds one artifact's ciphertext bytes (r1 R1-19); <=0 uncapped.
	MaxSpoolBytes int64
	Clock         clock.Clock
	Logger        *slog.Logger
	LeaseDur      time.Duration
	ReadyTTL      time.Duration
	// BeforeFinalizeHook is called in tests after the file is sealed/renamed and
	// before Finalize CAS opens its transaction (TestExportFinalizeCASKeepsAtomic).
	BeforeFinalizeHook func(ctx context.Context, jobID, attemptID uuid.UUID)
	// AfterBatchHook is called in tests between batches.
	AfterBatchHook func(ctx context.Context, jobID, attemptID uuid.UUID)
}

// ExportWorker implements river.Worker[ExportEncryptedArgs] (plan mục 2.3, 2.4, 2.7).
type ExportWorker struct {
	river.WorkerDefaults[ExportEncryptedArgs]
	pool          *pgxpool.Pool
	q             *gen.Queries
	audit         *audit.Store
	notify        *notification.Store
	storageDir    string
	secret        config.Secret
	maxSpoolBytes int64
	clk           clock.Clock
	logger        *slog.Logger
	leaseDur      time.Duration
	readyTTL      time.Duration
	beforeFin     func(ctx context.Context, jobID, attemptID uuid.UUID)
	afterBatch    func(ctx context.Context, jobID, attemptID uuid.UUID)
}

// NewExportWorker constructs an ExportWorker.
func NewExportWorker(d WorkerDeps) *ExportWorker {
	clk := d.Clock
	if clk == nil {
		clk = clock.System{}
	}
	lease := d.LeaseDur
	if lease <= 0 {
		lease = ExportLeaseDuration
	}
	ttl := d.ReadyTTL
	if ttl <= 0 {
		ttl = ExportReadyTTL
	}
	aud := d.Audit
	if aud == nil && d.Pool != nil {
		aud = audit.NewStore(d.Pool)
	}
	return &ExportWorker{
		pool:          d.Pool,
		q:             gen.New(d.Pool),
		audit:         aud,
		notify:        d.Notify,
		storageDir:    d.StorageDir,
		secret:        d.Secret,
		maxSpoolBytes: d.MaxSpoolBytes,
		clk:           clk,
		logger:        d.Logger,
		leaseDur:      lease,
		readyTTL:      ttl,
		beforeFin:     d.BeforeFinalizeHook,
		afterBatch:    d.AfterBatchHook,
	}
}

// Timeout overrides River's 60 s executor default (river.JobTimeoutDefault):
// full-vault streaming legitimately runs for minutes while the 10-minute lease
// is renewed between batches, so a healthy export must not be killed early
// (review r1 R1-17). Cancellation/shutdown still propagate through ctx.
func (w *ExportWorker) Timeout(*river.Job[ExportEncryptedArgs]) time.Duration {
	return ExportJobTimeout
}

func (w *ExportWorker) secretBytes() []byte {
	b := w.secret.Reveal()
	out := make([]byte, len(b))
	copy(out, b)
	return out
}

// Work executes one attempt of export_encrypted.
func (w *ExportWorker) Work(ctx context.Context, rjob *river.Job[ExportEncryptedArgs]) error {
	jobID := rjob.Args.JobID
	claim, err := w.q.ClaimExportJob(ctx, gen.ClaimExportJobParams{
		LeaseSeconds: w.leaseDur.Seconds(),
		ID:           jobID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return w.handleUnclaimed(ctx, jobID)
	}
	if err != nil {
		return err
	}
	if claim.AttemptID == nil {
		return river.JobCancel(errors.New("export: claim returned nil attempt_id"))
	}
	attemptID := *claim.AttemptID
	userID := claim.UserID

	if claim.PrevAttemptID != nil && *claim.PrevAttemptID != attemptID {
		w.unlinkAttemptFiles(jobID, *claim.PrevAttemptID)
	}

	if err := os.MkdirAll(w.storageDir, 0o700); err != nil {
		return w.failOrRetry(ctx, rjob, jobID, userID, attemptID, "io_error", err)
	}

	tmpName := SafeFileName(jobID, attemptID, "tmp")
	finalName := SafeFileName(jobID, attemptID, "sabk.enc")
	tmpPath, err := joinSafePath(w.storageDir, tmpName)
	if err != nil {
		return w.failOrRetry(ctx, rjob, jobID, userID, attemptID, "io_error", err)
	}
	finalPath, err := joinSafePath(w.storageDir, finalName)
	if err != nil {
		return w.failOrRetry(ctx, rjob, jobID, userID, attemptID, "io_error", err)
	}

	vaultRow, sizeBytes, runErr := w.writeSnapshotFile(ctx, jobID, userID, attemptID, tmpPath, finalPath)
	if runErr != nil {
		_ = os.Remove(tmpPath)
		_ = os.Remove(finalPath)
		if errors.Is(runErr, errAttemptSuperseded) {
			return river.JobCancel(runErr)
		}
		if errors.Is(runErr, ErrVaultAbsent) {
			w.markAttemptFailed(ctx, jobID, userID, attemptID, "vault_absent")
			return river.JobCancel(runErr)
		}
		if errors.Is(runErr, errSpoolLimit) {
			// The artifact can only grow on retry; fail terminally (r1 R1-19).
			w.markAttemptFailed(ctx, jobID, userID, attemptID, "spool_limit")
			return river.JobCancel(runErr)
		}
		return w.failOrRetry(ctx, rjob, jobID, userID, attemptID, "internal_error", runErr)
	}

	if w.beforeFin != nil {
		w.beforeFin(ctx, jobID, attemptID)
	}

	published, finErr := w.finalizeCAS(ctx, jobID, userID, attemptID, finalName, sizeBytes, vaultRow.VaultKeyID, vaultRow.Version)
	if finErr != nil {
		if errors.Is(finErr, errAmbiguousCommit) {
			// Do NOT unlink finalPath: the ready row may have committed (r1
			// R1-13). Resolve under a bounded fresh context and, if still
			// unresolved, keep the file so the reconciler's state-aware
			// cleanup can settle it; snooze for another look.
			st, err := w.resolvePublication(jobID, userID, attemptID)
			if err == nil && st {
				return nil
			}
			return river.JobSnooze(time.Minute)
		}
		_ = os.Remove(finalPath)
		return w.failOrRetry(ctx, rjob, jobID, userID, attemptID, "internal_error", finErr)
	}
	if !published {
		_ = os.Remove(finalPath)
		return river.JobCancel(errAttemptSuperseded)
	}
	return nil
}

// resolvePublication re-reads the export row under a bounded, non-cancelled
// context after an ambiguous finalize COMMIT (r1 R1-13). It reports whether
// the row committed ready for this attempt (file must be kept) or is
// definitively not published for this attempt. An error means "still
// unresolved" — the caller keeps the file and snoozes.
func (w *ExportWorker) resolvePublication(jobID, userID, attemptID uuid.UUID) (bool, error) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), 15*time.Second)
	defer cancel()
	row, err := w.q.GetExportJobForOwner(ctx, gen.GetExportJobForOwnerParams{
		ID:     jobID,
		UserID: userID,
	})
	if err != nil {
		return false, err
	}
	if row.Status == StatusReady && row.AttemptID != nil && *row.AttemptID == attemptID {
		return true, nil
	}
	// Definitively not this attempt's publication: the row is terminal for a
	// different outcome (expired/cancelled/failed) or points at a newer
	// attempt; the artifact file is safe to keep for state-aware cleanup to
	// unlink via export_file_cleanup records.
	return false, nil
}

func (w *ExportWorker) handleUnclaimed(ctx context.Context, jobID uuid.UUID) error {
	st, err := w.q.GetExportJobClaimState(ctx, jobID)
	if errors.Is(err, pgx.ErrNoRows) {
		return river.JobCancel(errors.New("export: job row absent"))
	}
	if err != nil {
		return err
	}
	switch st.Status {
	case StatusReady, StatusFailed, StatusCancelled, StatusExpired:
		return river.JobCancel(fmt.Errorf("export: job already terminal (%s)", st.Status))
	case StatusRunning:
		wait := time.Duration(st.LeaseRemainingSeconds*float64(time.Second)) + snoozeSlackSeconds*time.Second
		if wait < time.Second {
			wait = time.Second
		}
		return river.JobSnooze(wait)
	default:
		return river.JobSnooze(time.Second)
	}
}

func (w *ExportWorker) failOrRetry(ctx context.Context, rjob *river.Job[ExportEncryptedArgs], jobID, userID, attemptID uuid.UUID, code string, cause error) error {
	w.unlinkAttemptFiles(jobID, attemptID)
	maxAttempts := ExportMaxAttempts
	if rjob.MaxAttempts > 0 {
		maxAttempts = rjob.MaxAttempts
	}
	// Bookkeeping must survive a cancelled/timed-out Work ctx (r1 R1-15):
	// release the lease / mark failed under a bounded detached context so a
	// retryable attempt frees its lease immediately and a final attempt ends
	// terminal now rather than waiting for the worker-lost sweep.
	bkCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if rjob.Attempt >= maxAttempts {
		w.markAttemptFailed(bkCtx, jobID, userID, attemptID, code)
		return cause
	}
	_, _ = w.q.ReleaseExportLease(bkCtx, gen.ReleaseExportLeaseParams{
		ID:        jobID,
		AttemptID: &attemptID,
	})
	return cause
}

func (w *ExportWorker) markAttemptFailed(ctx context.Context, jobID, userID, attemptID uuid.UUID, code string) {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := w.q.WithTx(tx)
	n, err := q.FailExportAttempt(ctx, gen.FailExportAttemptParams{
		ErrorCode: &code,
		ID:        jobID,
		AttemptID: &attemptID,
	})
	if err != nil || n == 0 {
		return
	}
	if w.audit != nil {
		uid := userID
		_ = w.audit.Record(ctx, tx, secevent.Record{
			UserID: &uid,
			Event:  secevent.EventExportEncrypted,
			Result: secevent.ResultFailure,
			Actor:  "system",
			Meta:   secevent.Meta{},
		})
	}
	_ = tx.Commit(ctx)
}

func (w *ExportWorker) unlinkAttemptFiles(jobID, attemptID uuid.UUID) {
	for _, ext := range []string{"tmp", "sabk.enc"} {
		if p, err := joinSafePath(w.storageDir, SafeFileName(jobID, attemptID, ext)); err == nil {
			_ = os.Remove(p)
		}
	}
}

func (w *ExportWorker) writeSnapshotFile(ctx context.Context, jobID, userID, attemptID uuid.UUID, tmpPath, finalPath string) (gen.Vault, int64, error) {
	rrTx, err := w.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return gen.Vault{}, 0, err
	}
	defer func() { _ = rrTx.Rollback(ctx) }()
	rq := w.q.WithTx(rrTx)

	vaultRow, err := rq.GetVaultByUser(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return gen.Vault{}, 0, ErrVaultAbsent
	}
	if err != nil {
		return gen.Vault{}, 0, err
	}
	counts, err := rq.ExportSnapshotCounts(ctx, userID)
	if err != nil {
		return gen.Vault{}, 0, err
	}
	rks, err := rq.ExportRecoveryKeys(ctx, userID)
	if err != nil {
		return gen.Vault{}, 0, err
	}
	pks, err := rq.ExportPasskeys(ctx, userID)
	if err != nil {
		return gen.Vault{}, 0, err
	}

	totalWork := counts.Tags + counts.Items + counts.ItemTags + counts.Entries
	var processed int32
	if err := w.checkAndProgress(ctx, jobID, attemptID, totalWork, processed); err != nil {
		return gen.Vault{}, 0, err
	}

	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return gen.Vault{}, 0, err
	}
	closed := false
	defer func() {
		if !closed {
			_ = f.Close()
		}
	}()

	sec := w.secretBytes()
	fw, err := NewFrameWriter(f, sec, jobID, attemptID)
	clear(sec)
	if err != nil {
		return gen.Vault{}, 0, err
	}

	exportedAt := w.clk.Now().UTC().Format(time.RFC3339)
	if err := writeSabkPreamble(fw, exportedAt, counts, vaultRow, rks, pks); err != nil {
		return gen.Vault{}, 0, err
	}

	if _, err := fw.WriteString(",\n\"tags\": [\n"); err != nil {
		return gen.Vault{}, 0, err
	}
	if err := w.streamTags(ctx, rq, fw, jobID, attemptID, userID, totalWork, &processed); err != nil {
		return gen.Vault{}, 0, err
	}
	if _, err := fw.WriteString("],\n\"items\": [\n"); err != nil {
		return gen.Vault{}, 0, err
	}
	if err := w.streamItems(ctx, rq, fw, jobID, attemptID, userID, totalWork, &processed); err != nil {
		return gen.Vault{}, 0, err
	}
	if _, err := fw.WriteString("],\n\"item_tags\": [\n"); err != nil {
		return gen.Vault{}, 0, err
	}
	if err := w.streamItemTags(ctx, rq, fw, jobID, attemptID, userID, totalWork, &processed); err != nil {
		return gen.Vault{}, 0, err
	}
	if _, err := fw.WriteString("],\n\"entries\": [\n"); err != nil {
		return gen.Vault{}, 0, err
	}
	if err := w.streamEntries(ctx, rrTx, fw, jobID, attemptID, userID, totalWork, &processed); err != nil {
		return gen.Vault{}, 0, err
	}
	if _, err := fw.WriteString("]\n}\n"); err != nil {
		return gen.Vault{}, 0, err
	}
	if err := fw.Close(); err != nil {
		return gen.Vault{}, 0, err
	}
	if w.maxSpoolBytes > 0 && fw.Written() > w.maxSpoolBytes {
		return gen.Vault{}, 0, errSpoolLimit
	}
	if err := f.Sync(); err != nil {
		return gen.Vault{}, 0, err
	}
	closed = true
	if err := f.Close(); err != nil {
		return gen.Vault{}, 0, err
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return gen.Vault{}, 0, err
	}
	if err := syncDir(w.storageDir); err != nil {
		return gen.Vault{}, 0, fmt.Errorf("export: sync dir after rename: %w", err)
	}
	return vaultRow, fw.Written(), nil
}

func writeSabkPreamble(w io.Writer, exportedAt string, counts gen.ExportSnapshotCountsRow, v gen.Vault, rks []gen.ExportRecoveryKeysRow, pks []gen.ExportPasskeysRow) error {
	snap := SabkSnapshot{
		Consistency:                 SabkConsistency,
		IncludesActive:              true,
		IncludesSoftDeletedUnpurged: true,
		ExcludesPurged:              true,
		SoftDeleteRetentionDays:     SabkRetentionDays,
		Counts: SabkCounts{
			Tags:     counts.Tags,
			Items:    counts.Items,
			ItemTags: counts.ItemTags,
			Entries:  counts.Entries,
		},
	}
	rkOut := make([]SabkRecoveryKey, len(rks))
	for i, r := range rks {
		rkOut[i] = SabkRecoveryKey{
			Slot:       r.Slot,
			LookupHash: vault.EncodeBase64URL(r.LookupHash),
			Wrap:       vault.EncodeBase64URL(r.Wrap),
		}
	}
	pkOut := make([]SabkPasskey, len(pks))
	for i, p := range pks {
		var aaguidStr string
		if u, err := uuid.FromBytes(p.Aaguid); err == nil {
			aaguidStr = u.String()
		}
		pkOut[i] = SabkPasskey{
			ID:        p.ID,
			Name:      p.Name,
			CredID:    vault.EncodeBase64URL(p.CredID),
			PRFSalt:   vault.EncodeBase64URL(p.PrfSalt),
			VKWrap:    vault.EncodeBase64URL(p.VkWrap),
			Pubkey:    vault.EncodeBase64URL(p.Pubkey),
			AAGUID:    aaguidStr,
			CreatedAt: p.CreatedAt.Time.UTC().Format(time.RFC3339),
		}
	}
	vOut := SabkVault{
		VaultKeyID:           v.VaultKeyID,
		Version:              v.Version,
		KDF:                  json.RawMessage(v.Kdf),
		VaultKeyWrappedByKEK: vault.EncodeBase64URL(v.VaultKeyWrappedByKek),
		X25519Public:         vault.EncodeBase64URL(v.X25519Public),
		Ed25519Public:        vault.EncodeBase64URL(v.Ed25519Public),
		PrivateKeysWrapped:   vault.EncodeBase64URL(v.PrivateKeysWrapped),
		RecoveryKeys:         rkOut,
		Passkeys:             pkOut,
	}
	snapRaw, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	vRaw, err := json.Marshal(vOut)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "{\"format\":%q,\"version\":%d,\"exported_at\":%q,\n\"snapshot\":%s,\n\"vault\":%s",
		SabkFormat, SabkVersion, exportedAt, snapRaw, vRaw)
	return err
}

func (w *ExportWorker) checkAndProgress(ctx context.Context, jobID, attemptID uuid.UUID, total, processed int32) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if w.afterBatch != nil {
		w.afterBatch(ctx, jobID, attemptID)
	}
	st, err := w.q.GetExportJobAttemptState(ctx, jobID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errAttemptSuperseded
	}
	if err != nil {
		return err
	}
	if st.Status != StatusRunning || st.AttemptID == nil || *st.AttemptID != attemptID {
		return errAttemptSuperseded
	}
	n, err := w.q.RenewExportLease(ctx, gen.RenewExportLeaseParams{
		LeaseSeconds: w.leaseDur.Seconds(),
		ID:           jobID,
		AttemptID:    &attemptID,
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return errAttemptSuperseded
	}
	_, err = w.q.UpdateExportProgress(ctx, gen.UpdateExportProgressParams{
		ItemsTotal:     &total,
		ItemsProcessed: &processed,
		ID:             jobID,
		AttemptID:      &attemptID,
	})
	return err
}

func writeJSONLine(fw *FrameWriter, first *bool, v any) error {
	if !*first {
		if _, err := fw.WriteString(",\n"); err != nil {
			return err
		}
	}
	*first = false
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = fw.Write(raw)
	return err
}

func (w *ExportWorker) streamTags(ctx context.Context, rq *gen.Queries, fw *FrameWriter, jobID, attemptID, userID uuid.UUID, total int32, processed *int32) error {
	afterTS := pgtype.Timestamptz{InfinityModifier: pgtype.NegativeInfinity, Valid: true}
	var afterID uuid.UUID
	first := true
	for {
		rows, err := rq.ExportTagsBatch(ctx, gen.ExportTagsBatchParams{
			UserID:         userID,
			AfterCreatedAt: afterTS,
			AfterID:        afterID,
			BatchLimit:     metaBatchLimit,
		})
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			break
		}
		for _, r := range rows {
			if err := writeJSONLine(fw, &first, SabkTag{
				ID:         r.ID,
				Display:    r.Display,
				Normalized: r.Normalized,
				ItemCount:  r.ItemCount,
				LastUsedAt: r.LastUsedAt.Time.UTC().Format(time.RFC3339),
				CreatedAt:  r.CreatedAt.Time.UTC().Format(time.RFC3339),
				DeletedAt:  fmtTimePtr(r.DeletedAt),
			}); err != nil {
				return err
			}
			afterTS = r.CreatedAt
			afterID = r.ID
			*processed++
		}
		if err := w.checkAndProgress(ctx, jobID, attemptID, total, *processed); err != nil {
			return err
		}
		if int32(len(rows)) < metaBatchLimit {
			break
		}
	}
	if !first {
		_, err := fw.WriteString("\n")
		return err
	}
	return nil
}

func (w *ExportWorker) streamItems(ctx context.Context, rq *gen.Queries, fw *FrameWriter, jobID, attemptID, userID uuid.UUID, total int32, processed *int32) error {
	afterTS := pgtype.Timestamptz{InfinityModifier: pgtype.NegativeInfinity, Valid: true}
	var afterID uuid.UUID
	first := true
	for {
		rows, err := rq.ExportItemsBatch(ctx, gen.ExportItemsBatchParams{
			UserID:         userID,
			AfterCreatedAt: afterTS,
			AfterID:        afterID,
			BatchLimit:     metaBatchLimit,
		})
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			break
		}
		for _, r := range rows {
			if err := writeJSONLine(fw, &first, SabkItem{
				ID:             r.ID,
				Name:           r.Name,
				NameNormalized: r.NameNormalized,
				Hint:           r.Hint,
				EntryCount:     r.EntryCount,
				Version:        r.Version,
				LastUsedAt:     r.LastUsedAt.Time.UTC().Format(time.RFC3339),
				CreatedAt:      r.CreatedAt.Time.UTC().Format(time.RFC3339),
				UpdatedAt:      r.UpdatedAt.Time.UTC().Format(time.RFC3339),
				DeletedAt:      fmtTimePtr(r.DeletedAt),
				DeleteBatch:    r.DeleteBatch,
			}); err != nil {
				return err
			}
			afterTS = r.CreatedAt
			afterID = r.ID
			*processed++
		}
		if err := w.checkAndProgress(ctx, jobID, attemptID, total, *processed); err != nil {
			return err
		}
		if int32(len(rows)) < metaBatchLimit {
			break
		}
	}
	if !first {
		_, err := fw.WriteString("\n")
		return err
	}
	return nil
}

func (w *ExportWorker) streamItemTags(ctx context.Context, rq *gen.Queries, fw *FrameWriter, jobID, attemptID, userID uuid.UUID, total int32, processed *int32) error {
	var afterItem, afterTag uuid.UUID
	first := true
	for {
		rows, err := rq.ExportItemTagsBatch(ctx, gen.ExportItemTagsBatchParams{
			UserID:      userID,
			AfterItemID: afterItem,
			AfterTagID:  afterTag,
			BatchLimit:  metaBatchLimit,
		})
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			break
		}
		for _, r := range rows {
			if err := writeJSONLine(fw, &first, SabkItemTag{
				ItemID:    r.ItemID,
				TagID:     r.TagID,
				CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339),
			}); err != nil {
				return err
			}
			afterItem = r.ItemID
			afterTag = r.TagID
			*processed++
		}
		if err := w.checkAndProgress(ctx, jobID, attemptID, total, *processed); err != nil {
			return err
		}
		if int32(len(rows)) < metaBatchLimit {
			break
		}
	}
	if !first {
		_, err := fw.WriteString("\n")
		return err
	}
	return nil
}

// exportEntriesStreamSQL mirrors ExportEntriesBatch (apps/api/internal/db/queries/
// export.sql) 1:1; it is issued through pgx.Tx.Query so rows stream through the
// portal instead of materializing a whole 16-row batch of ciphertexts at once
// (review r1 R1-02). Keep in sync with the generated query.
const exportEntriesStreamSQL = `SELECT id, item_id, type, position, version, plaintext_len_bucket, envelope,
  ciphertext, created_at, updated_at, deleted_at, deleted_via, delete_batch
FROM entry
WHERE user_id = $1
  AND (item_id, position, id) > ($2::uuid, $3::int, $4::uuid)
ORDER BY item_id ASC, position ASC, id ASC
LIMIT $5`

func (w *ExportWorker) streamEntries(ctx context.Context, rrTx pgx.Tx, fw *FrameWriter, jobID, attemptID, userID uuid.UUID, total int32, processed *int32) error {
	var afterItem, afterID uuid.UUID
	afterPos := int32(-1)
	first := true
	for {
		rows, err := rrTx.Query(ctx, exportEntriesStreamSQL, userID, afterItem, afterPos, afterID, entryBatchLimit)
		if err != nil {
			return err
		}
		n := int32(0)
		for rows.Next() {
			var r gen.ExportEntriesBatchRow
			if err := rows.Scan(
				&r.ID,
				&r.ItemID,
				&r.Type,
				&r.Position,
				&r.Version,
				&r.PlaintextLenBucket,
				&r.Envelope,
				&r.Ciphertext,
				&r.CreatedAt,
				&r.UpdatedAt,
				&r.DeletedAt,
				&r.DeletedVia,
				&r.DeleteBatch,
			); err != nil {
				rows.Close()
				return err
			}
			if err := writeJSONLine(fw, &first, SabkEntry{
				ID:                 r.ID,
				ItemID:             r.ItemID,
				Type:               r.Type,
				Position:           r.Position,
				Version:            r.Version,
				PlaintextLenBucket: r.PlaintextLenBucket,
				Envelope:           json.RawMessage(r.Envelope),
				Ciphertext:         vault.EncodeBase64URL(r.Ciphertext),
				CreatedAt:          r.CreatedAt.Time.UTC().Format(time.RFC3339),
				UpdatedAt:          r.UpdatedAt.Time.UTC().Format(time.RFC3339),
				DeletedAt:          fmtTimePtr(r.DeletedAt),
				DeletedVia:         r.DeletedVia,
				DeleteBatch:        r.DeleteBatch,
			}); err != nil {
				rows.Close()
				return err
			}
			afterItem = r.ItemID
			afterPos = r.Position
			afterID = r.ID
			*processed++
			n++
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		if n == 0 {
			break
		}
		if w.maxSpoolBytes > 0 && fw.Written() > w.maxSpoolBytes {
			return errSpoolLimit
		}
		if err := w.checkAndProgress(ctx, jobID, attemptID, total, *processed); err != nil {
			return err
		}
		if n < entryBatchLimit {
			break
		}
	}
	if !first {
		_, err := fw.WriteString("\n")
		return err
	}
	return nil
}

// finalizeCAS implements plan mục 2.4 Finalize CAS: locks app_user FOR SHARE ->
// vault FOR SHARE -> export_job FOR UPDATE, checks live vault_key_id matches
// the snapshot's, marks the job ready, and expires any older ready jobs of the
// user in the same transaction.
func (w *ExportWorker) finalizeCAS(ctx context.Context, jobID, userID, attemptID uuid.UUID, fileName string, sizeBytes int64, snapKeyID string, snapVer int32) (bool, error) {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := w.q.WithTx(tx)

	if _, err := q.LockExportOwnerForShare(ctx, userID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	liveVault, err := q.GetVaultKeyForShare(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if liveVault.VaultKeyID != snapKeyID {
		return false, nil
	}
	cur, err := q.GetExportJobForUpdate(ctx, jobID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if cur.Status != StatusRunning || cur.AttemptID == nil || *cur.AttemptID != attemptID {
		return false, nil
	}

	if _, err := q.FinalizeExportReady(ctx, gen.FinalizeExportReadyParams{
		FileName:           &fileName,
		SizeBytes:          &sizeBytes,
		SnapshotVaultKeyID: &snapKeyID,
		SnapshotVaultVer:   &snapVer,
		TtlSeconds:         w.readyTTL.Seconds(),
		ID:                 jobID,
		AttemptID:          &attemptID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}

	replaced, err := q.ExpireReplacedExports(ctx, gen.ExpireReplacedExportsParams{
		UserID: userID,
		KeepID: jobID,
	})
	if err != nil {
		return false, err
	}
	var cleanupIDs []uuid.UUID
	for _, old := range replaced {
		if old.FileName == nil || !ValidateSafeFileName(*old.FileName) {
			continue
		}
		rec, err := q.InsertExportFileCleanup(ctx, gen.InsertExportFileCleanupParams{
			FileName:  *old.FileName,
			JobID:     old.ID,
			AttemptID: old.AttemptID,
			Reason:    CleanupReasonReplaced,
		})
		if err != nil {
			return false, err
		}
		cleanupIDs = append(cleanupIDs, rec.ID)
	}

	if w.audit != nil {
		uid := userID
		if err := w.audit.Record(ctx, tx, secevent.Record{
			UserID: &uid,
			Event:  secevent.EventExportEncrypted,
			Result: secevent.ResultSuccess,
			Actor:  "system",
			Meta:   secevent.Meta{},
		}); err != nil {
			return false, err
		}
	}
	rc := riverClientFromCtx(ctx)
	notify := w.notify
	if notify == nil && w.pool != nil {
		notify = notification.NewStore(w.pool, rc)
	}
	if notify != nil {
		u, err := q.GetUserByID(ctx, userID)
		if err != nil {
			return false, err
		}
		var targets []string
		if u.EmailVerifiedAt.Valid && u.Email != "" {
			targets = []string{u.Email}
		}
		if err := notify.NotifySecurity(ctx, tx, secevent.Notice{
			UserID:       userID,
			Kind:         secevent.NoticeSecurity,
			Meta:         secevent.Meta{},
			EmailTargets: targets,
		}); err != nil {
			return false, err
		}
	}
	if rc != nil {
		for _, cid := range cleanupIDs {
			if _, err := rc.InsertTx(ctx, tx, exportcleanup.Args{CleanupID: cid}, nil); err != nil {
				return false, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		// A commit transport/context error leaves the outcome ambiguous:
		// PostgreSQL may have committed 'ready'. The caller must NOT unlink
		// finalPath; it resolves the row state under a fresh context (r1 R1-13).
		return false, fmt.Errorf("%w: %v", errAmbiguousCommit, err)
	}
	return true, nil
}

func riverClientFromCtx(ctx context.Context) (rc *river.Client[pgx.Tx]) {
	defer func() {
		if recover() != nil {
			rc = nil
		}
	}()
	return river.ClientFromContext[pgx.Tx](ctx)
}

func syncDir(dir string) error {
	d, err := os.Open(filepath.Clean(dir))
	if err != nil {
		return err
	}
	if err := d.Sync(); err != nil {
		_ = d.Close()
		return err
	}
	return d.Close()
}
