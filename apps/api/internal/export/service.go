package export

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/audit"
	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/jobs/exportcleanup"
	"github.com/zone17th/engram/apps/api/internal/notification"
	"github.com/zone17th/engram/apps/api/internal/secevent"
)

// Export job statuses and kinds (plan mục 2.4).
const (
	KindEncrypted = "encrypted"

	StatusQueued    = "queued"
	StatusRunning   = "running"
	StatusReady     = "ready"
	StatusFailed    = "failed"
	StatusCancelled = "cancelled"
	StatusExpired   = "expired"

	CleanupReasonExpired       = "expired"
	CleanupReasonReplaced      = "replaced"
	CleanupReasonCancelled     = "cancelled"
	CleanupReasonReset         = "reset"
	CleanupReasonAccountDelete = "account_delete"
	CleanupReasonRescue        = "rescue"
	CleanupReasonDrain         = "drain"
	CleanupReasonWorkerLost    = "worker_lost"

	ExportJobKind       = "export_encrypted"
	ExportPruneKind     = "export_prune"
	ExportLeaseDuration = 10 * time.Minute
	ExportReadyTTL      = 24 * time.Hour
	// ExportJobTimeout bounds one River attempt (r1 R1-17): long enough for
	// large-vault streaming, unrelated to lease renewal cadence.
	ExportJobTimeout      = 30 * time.Minute
	ExportWorkerLostAfter = 15 * time.Minute
	ExportPruneInterval   = 15 * time.Minute
	ExportMaxAttempts     = 3
)

// Domain errors mapped by HTTP handlers to ProblemCodes (plan mục 3).
var (
	ErrCreatePaused  = errors.New("dependency_unavailable")
	ErrVaultAbsent   = errors.New("vault_absent")
	ErrNotFound      = errors.New("not_found")
	ErrNotReady      = errors.New("export_not_ready")
	ErrExpired       = errors.New("export_expired")
	ErrInvalidCursor = errors.New("invalid_request")
)

// RateLimitError carries the Retry-After seconds for 429 rate_limited.
type RateLimitError struct {
	RetryAfter int
}

func (e *RateLimitError) Error() string { return "rate_limited" }

// ExportEncryptedArgs is the River job payload for creating an encrypted backup.
// It carries user_id so DELETE /me can scrub pending/completed payloads (mục 2.9d).
type ExportEncryptedArgs struct {
	JobID  uuid.UUID `json:"job_id"`
	UserID uuid.UUID `json:"user_id"`
}

func (ExportEncryptedArgs) Kind() string { return ExportJobKind }

func (ExportEncryptedArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{MaxAttempts: ExportMaxAttempts}
}

// Job is the API representation of an export_job row (OpenAPI ExportJob, mục 3).
type Job struct {
	ID             uuid.UUID `json:"id"`
	Kind           string    `json:"kind"`
	Status         string    `json:"status"`
	CreatedAt      string    `json:"created_at"`
	StartedAt      *string   `json:"started_at"`
	CompletedAt    *string   `json:"completed_at"`
	ExpiresAt      *string   `json:"expires_at"`
	SizeBytes      *int64    `json:"size_bytes"`
	ItemsTotal     *int32    `json:"items_total"`
	ItemsProcessed *int32    `json:"items_processed"`
	ErrorCode      *string   `json:"error_code"`
}

func formatRow(row gen.ExportJob, now time.Time) Job {
	status := row.Status
	if status == StatusReady && row.ExpiresAt.Valid && !row.ExpiresAt.Time.After(now) {
		status = StatusExpired
	}
	return Job{
		ID:             row.ID,
		Kind:           row.Kind,
		Status:         status,
		CreatedAt:      row.CreatedAt.Time.UTC().Format(time.RFC3339),
		StartedAt:      fmtTimePtr(row.StartedAt),
		CompletedAt:    fmtTimePtr(row.CompletedAt),
		ExpiresAt:      fmtTimePtr(row.ExpiresAt),
		SizeBytes:      row.SizeBytes,
		ItemsTotal:     row.ItemsTotal,
		ItemsProcessed: row.ItemsProcessed,
		ErrorCode:      row.ErrorCode,
	}
}

func fmtTimePtr(ts pgtype.Timestamptz) *string {
	if !ts.Valid {
		return nil
	}
	s := ts.Time.UTC().Format(time.RFC3339)
	return &s
}

var safeFileNameRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(tmp|sabk\.enc)$`)

// SafeFileName builds the canonical storage filename for (job, attempt, ext).
func SafeFileName(jobID, attemptID uuid.UUID, ext string) string {
	return jobID.String() + "." + attemptID.String() + "." + ext
}

// ValidateSafeFileName checks the 0010 CHECK regex before joining under storageDir.
func ValidateSafeFileName(name string) bool {
	return safeFileNameRe.MatchString(name)
}

func joinSafePath(dir, fileName string) (string, error) {
	if !ValidateSafeFileName(fileName) {
		return "", errors.New("export: unsafe file name")
	}
	cleanDir := filepath.Clean(dir)
	full := filepath.Join(cleanDir, fileName)
	if filepath.Dir(full) != cleanDir {
		return "", errors.New("export: path traversal rejected")
	}
	return full, nil
}

// RecordJobAttemptCleanupTx writes export_file_cleanup rows for the .tmp and
// .sabk.enc filenames of a cancelled/replaced/reset job attempt inside tx.
func RecordJobAttemptCleanupTx(ctx context.Context, q *gen.Queries, row gen.ExportJob, reason string) ([]uuid.UUID, error) {
	if row.AttemptID == nil {
		return nil, nil
	}
	names := []string{
		SafeFileName(row.ID, *row.AttemptID, "tmp"),
		SafeFileName(row.ID, *row.AttemptID, "sabk.enc"),
	}
	if row.FileName != nil && ValidateSafeFileName(*row.FileName) && *row.FileName != names[0] && *row.FileName != names[1] {
		names = append(names, *row.FileName)
	}
	ids := make([]uuid.UUID, 0, len(names))
	for _, fn := range names {
		rec, err := q.InsertExportFileCleanup(ctx, gen.InsertExportFileCleanupParams{
			FileName:  fn,
			JobID:     row.ID,
			AttemptID: row.AttemptID,
			Reason:    reason,
		})
		if err != nil {
			return nil, err
		}
		ids = append(ids, rec.ID)
	}
	return ids, nil
}

// Service manages export_job creation, cancellation, status queries, download
// streaming and decrypted-pages pagination (plan mục 2.4–2.7).
type Service struct {
	pool       *pgxpool.Pool
	q          *gen.Queries
	river      *river.Client[pgx.Tx]
	limiter    *httpx.UserLimiter
	audit      *audit.Store
	notify     *notification.Store
	ipPepper   []byte
	clk        clock.Clock
	storageDir string
	secret     config.Secret
	paused     atomic.Bool
}

// NewService constructs an export Service from cfg, pool, river and limiter.
func NewService(cfg *config.Config, pool *pgxpool.Pool, riverc *river.Client[pgx.Tx], limiter *httpx.UserLimiter, clk clock.Clock) (*Service, error) {
	if cfg == nil || pool == nil {
		return nil, errors.New("export: missing config or pool")
	}
	if clk == nil {
		clk = clock.System{}
	}
	if limiter == nil {
		limiter = httpx.NewUserLimiter(pool, clk)
	}
	s := &Service{
		pool:       pool,
		q:          gen.New(pool),
		river:      riverc,
		limiter:    limiter,
		audit:      audit.NewStore(pool),
		notify:     notification.NewStore(pool, riverc),
		ipPepper:   append([]byte(nil), cfg.AuthIPPepper...),
		clk:        clk,
		storageDir: cfg.ExportStorageDir,
		secret:     cfg.ExportAtRestSecret,
	}
	s.paused.Store(cfg.ExportCreatePaused)
	return s, nil
}

// SetCreatePaused toggles EXPORT_CREATE_PAUSED at runtime (tests / drain).
func (s *Service) SetCreatePaused(v bool) { s.paused.Store(v) }

func (s *Service) secretBytes() []byte {
	b := s.secret.Reveal()
	out := make([]byte, len(b))
	copy(out, b)
	return out
}

// Create implements POST /api/v1/exports in exact order of plan mục 2.4:
// (0) EXPORT_CREATE_PAUSED -> ErrCreatePaused before any write;
// (1) idempotency replay handled by httpx.Idempotency middleware when present;
// (2) pg_advisory_xact_lock(hashtext('export_create:'||user_id));
// (3) active queued/running job -> coalesce (202, created=false, 0 quota);
//
//	ready job is NOT coalesced (new job created while old ready stays live);
//
// (4) ConsumeTx(ScopeExportCreate) -> INSERT export_job -> River InsertTx in
//
//	the same transaction.
func (s *Service) Create(ctx context.Context, userID uuid.UUID, _ string) (Job, bool, error) {
	if s.paused.Load() {
		return Job{}, false, ErrCreatePaused
	}
	tx, err := httpx.BeginMutationTx(ctx, s.pool)
	if err != nil {
		return Job{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('export_create:' || $1::text))`, userID.String()); err != nil {
		return Job{}, false, err
	}
	q := s.q.WithTx(tx)

	hasVault, err := q.VaultExistsByUser(ctx, userID)
	if err != nil {
		return Job{}, false, err
	}
	if !hasVault {
		return Job{}, false, ErrVaultAbsent
	}

	active, err := q.GetActiveExportJobForUpdate(ctx, gen.GetActiveExportJobForUpdateParams{
		UserID: userID,
		Kind:   KindEncrypted,
	})
	if err == nil {
		dto := formatRow(active, s.clk.Now())
		if err := commitWithIdempotency(ctx, tx, http.StatusAccepted, dto); err != nil {
			return Job{}, false, err
		}
		return dto, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Job{}, false, err
	}

	ok, retryAfter, err := s.limiter.ConsumeTx(ctx, tx, httpx.ScopeExportCreate, userID)
	if err != nil {
		return Job{}, false, err
	}
	if !ok {
		return Job{}, false, &RateLimitError{RetryAfter: retryAfter}
	}

	created, err := q.CreateExportJob(ctx, gen.CreateExportJobParams{
		UserID: userID,
		Kind:   KindEncrypted,
	})
	if err != nil {
		return Job{}, false, err
	}
	if s.river != nil {
		if _, err := s.river.InsertTx(ctx, tx, ExportEncryptedArgs{
			JobID:  created.ID,
			UserID: userID,
		}, nil); err != nil {
			return Job{}, false, err
		}
	}

	dto := formatRow(created, s.clk.Now())
	if err := commitWithIdempotency(ctx, tx, http.StatusAccepted, dto); err != nil {
		return Job{}, false, err
	}
	return dto, true, nil
}

// Latest returns the user's newest export job (or nil). A ready job with
// expires_at <= now is returned with status="expired" immediately (mục 2.4).
func (s *Service) Latest(ctx context.Context, userID uuid.UUID) (*Job, error) {
	row, err := s.q.GetLatestExportJob(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	dto := formatRow(row, s.clk.Now())
	return &dto, nil
}

// Get returns a single export job owned by userID, or ErrNotFound.
func (s *Service) Get(ctx context.Context, userID, jobID uuid.UUID) (Job, error) {
	row, err := s.q.GetExportJobForOwner(ctx, gen.GetExportJobForOwnerParams{
		ID:     jobID,
		UserID: userID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, ErrNotFound
	}
	if err != nil {
		return Job{}, err
	}
	return formatRow(row, s.clk.Now()), nil
}

// Cancel marks a queued/running/ready job cancelled and schedules cleanup.
// Already-cancelled is idempotent 200; failed -> ErrNotReady; expired -> ErrExpired.
func (s *Service) Cancel(ctx context.Context, userID, jobID uuid.UUID) (Job, error) {
	tx, err := httpx.BeginMutationTx(ctx, s.pool)
	if err != nil {
		return Job{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)

	now := s.clk.Now()
	row, err := q.GetExportJobForOwnerForUpdate(ctx, gen.GetExportJobForOwnerForUpdateParams{
		ID:     jobID,
		UserID: userID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, ErrNotFound
	}
	if err != nil {
		return Job{}, err
	}
	if row.Status == StatusExpired || (row.Status == StatusReady && row.ExpiresAt.Valid && !row.ExpiresAt.Time.After(now)) {
		return Job{}, ErrExpired
	}
	if row.Status == StatusFailed {
		return Job{}, ErrNotReady
	}
	if row.Status == StatusCancelled {
		dto := formatRow(row, now)
		if err := commitWithIdempotency(ctx, tx, http.StatusOK, dto); err != nil {
			return Job{}, err
		}
		return dto, nil
	}

	updated, err := q.CancelExportJob(ctx, gen.CancelExportJobParams{
		ID:     jobID,
		UserID: userID,
	})
	if err != nil {
		return Job{}, err
	}
	cleanupIDs, err := RecordJobAttemptCleanupTx(ctx, q, row, CleanupReasonCancelled)
	if err != nil {
		return Job{}, err
	}
	if s.river != nil {
		for _, cid := range cleanupIDs {
			if _, err := s.river.InsertTx(ctx, tx, exportcleanup.Args{CleanupID: cid}, nil); err != nil {
				return Job{}, err
			}
		}
	}
	dto := formatRow(updated, now)
	if err := commitWithIdempotency(ctx, tx, http.StatusOK, dto); err != nil {
		return Job{}, err
	}
	return dto, nil
}

// DownloadStream wraps the decrypted .sabk.json reader and its underlying file.
type DownloadStream struct {
	Reader   io.Reader
	FileName string
	closer   io.Closer
}

func (d *DownloadStream) Read(p []byte) (int, error) { return d.Reader.Read(p) }
func (d *DownloadStream) Close() error               { return d.closer.Close() }

// OpenDownload validates owner/status/expiry and returns a streaming ENGX1
// reader for GET /api/v1/exports/{id}/download (mục 2.5, 3).
func (s *Service) OpenDownload(ctx context.Context, userID, jobID uuid.UUID) (*DownloadStream, error) {
	row, err := s.q.GetExportJobForOwner(ctx, gen.GetExportJobForOwnerParams{
		ID:     jobID,
		UserID: userID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	now := s.clk.Now()
	if row.Status == StatusExpired || (row.Status == StatusReady && row.ExpiresAt.Valid && !row.ExpiresAt.Time.After(now)) {
		return nil, ErrExpired
	}
	if row.Status != StatusReady || row.AttemptID == nil || row.FileName == nil {
		return nil, ErrNotReady
	}
	path, err := joinSafePath(s.storageDir, *row.FileName)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	sec := s.secretBytes()
	fr, err := NewFrameReader(f, sec, row.ID, *row.AttemptID)
	clear(sec)
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	dateAt := row.CreatedAt.Time
	if row.CompletedAt.Valid {
		dateAt = row.CompletedAt.Time
	}
	dlName := fmt.Sprintf("engram-backup-%s.sabk.json", dateAt.UTC().Format("2006-01-02"))
	return &DownloadStream{Reader: fr, FileName: dlName, closer: f}, nil
}

// RecordDecryptedAudit implements POST /api/v1/audit/export-decrypted (plan mục 2.8, 3):
// records audit event export.decrypted (meta={}), user_notification and River
// security_notice_mail inside one transaction.
func (s *Service) RecordDecryptedAudit(ctx context.Context, p authctx.Principal, ip, ua string) error {
	tx, err := httpx.BeginMutationTx(ctx, s.pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)

	uid := p.UserID
	sid := p.SessionID
	var ipHash []byte
	if ip != "" && len(s.ipPepper) > 0 {
		ipHash = auth.HashIP(s.ipPepper, ip)
	}
	if s.audit != nil {
		if err := s.audit.Record(ctx, tx, secevent.Record{
			UserID:    &uid,
			SessionID: &sid,
			Event:     secevent.EventExportDecrypted,
			Result:    secevent.ResultSuccess,
			Actor:     "user",
			IPHash:    ipHash,
			UserAgent: ua,
			Meta:      secevent.Meta{},
		}); err != nil {
			return err
		}
	}
	if s.notify != nil {
		u, err := q.GetUserByID(ctx, uid)
		if err != nil {
			return err
		}
		var targets []string
		if u.EmailVerifiedAt.Valid && u.Email != "" {
			targets = []string{u.Email}
		}
		if err := s.notify.NotifySecurity(ctx, tx, secevent.Notice{
			UserID:       uid,
			Kind:         secevent.NoticeSecurity,
			Meta:         secevent.Meta{},
			EmailTargets: targets,
		}); err != nil {
			return err
		}
	}
	return commitWithIdempotency(ctx, tx, http.StatusNoContent, nil)
}

func commitWithIdempotency(ctx context.Context, tx pgx.Tx, statusCode int, payload any) error {
	if _, hasClaim := httpx.IdempotencyClaimFrom(ctx); hasClaim {
		var raw []byte
		if payload != nil && statusCode != http.StatusNoContent {
			var err error
			raw, err = json.Marshal(payload)
			if err != nil {
				return err
			}
		}
		return httpx.CommitIdempotencyTx(ctx, tx, statusCode, raw)
	}
	return tx.Commit(ctx)
}
