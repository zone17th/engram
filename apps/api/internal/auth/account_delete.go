package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/jobs/exportcleanup"
	"github.com/zone17th/engram/apps/api/internal/secevent"
)

// ErrAccountDeleteConfirmInvalid: confirm_email does not match app_user.email
// after NormalizeEmail (400, plan P06 mục 2.9.2).
var ErrAccountDeleteConfirmInvalid = errCode("account_delete_confirm_invalid")

// userScopedJobKinds are the River job kinds whose args carry `user_id`
// (plan P06 mục 2.9.3d). Their not-yet-running and historical rows are deleted
// with the account; security_notice_mail carries only a notification_id that
// cascades away, so it is left for its worker to cancel.
var userScopedJobKinds = []string{"embed_item", "embed_tag", "reembed_user", "export_encrypted"}

// AccountDeleteResult is what a committed account deletion reports. It holds
// no email or other PII.
type AccountDeleteResult struct {
	UserID     uuid.UUID
	AuditID    int64
	CleanupIDs []uuid.UUID
}

type accountDeleteRequest struct {
	userID       uuid.UUID
	confirmEmail string // normalized
	principal    *authctx.Principal
	actor        string
	ip           string
	ua           string
}

// Pool exposes the service pool for HTTP middleware wiring (idempotency and
// per-user rate limits on DELETE /me).
func (s *Service) Pool() *pgxpool.Pool { return s.pool }

// DeleteAccount hard-deletes the principal's account (DELETE /api/v1/me, plan
// P06 mục 2.9). Re-auth, CSRF, rate limit and idempotency claim are enforced by
// the route middleware; the session is re-checked under the user row lock.
func (s *Service) DeleteAccount(ctx context.Context, p authctx.Principal, confirmEmail, ip, ua string) error {
	email, err := NormalizeEmail(confirmEmail)
	if err != nil {
		return ErrAccountDeleteConfirmInvalid
	}
	pc := p
	_, err = s.deleteAccount(ctx, accountDeleteRequest{
		userID: p.UserID, confirmEmail: email, principal: &pc, actor: "user", ip: ip, ua: ua,
	})
	return err
}

// DeleteAccountByEmail is the admin CLI path: same transaction as
// DeleteAccount without the HTTP re-auth/confirm_email step. Unknown email ->
// ErrNotFound.
func (s *Service) DeleteAccountByEmail(ctx context.Context, email string) (AccountDeleteResult, error) {
	norm, err := NormalizeEmail(email)
	if err != nil {
		return AccountDeleteResult{}, ErrInvalidRequest
	}
	u, err := s.q.GetUserByEmail(ctx, norm)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return AccountDeleteResult{}, ErrNotFound
		}
		return AccountDeleteResult{}, err
	}
	return s.deleteAccount(ctx, accountDeleteRequest{userID: u.ID, confirmEmail: norm, actor: "admin"})
}

// deleteAccount commits the delete transaction (one retry on deadlock or lock
// timeout), then enqueues one export_file_cleanup job per cleanup row. A crash
// between commit and enqueue loses nothing: the rows stay pending and the
// export_prune sweep picks them up.
func (s *Service) deleteAccount(ctx context.Context, req accountDeleteRequest) (AccountDeleteResult, error) {
	res, err := s.deleteAccountTx(ctx, req)
	if isLockRetryable(err) {
		res, err = s.deleteAccountTx(ctx, req)
	}
	if err != nil {
		return AccountDeleteResult{}, err
	}
	s.enqueueExportCleanup(ctx, res.CleanupIDs)
	if s.MailDeliveryAvailable() {
		_ = s.mail.Send(ctx, req.confirmEmail, "security", "")
	}
	return res, nil
}

func (s *Service) deleteAccountTx(ctx context.Context, req accountDeleteRequest) (AccountDeleteResult, error) {
	tx, err := httpx.BeginMutationTx(ctx, s.pool)
	if err != nil {
		return AccountDeleteResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)

	// (a) Lock order shared with vault reset and export Finalize CAS:
	// generation set (shared) -> app_user -> vault -> export_job -> content.
	if err := generation.LockGenerationSetShared(ctx, tx); err != nil {
		return AccountDeleteResult{}, err
	}
	u, err := q.GetUserByIDForUpdate(ctx, req.userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if req.principal != nil {
				return AccountDeleteResult{}, SessionInvalid("invalid")
			}
			return AccountDeleteResult{}, ErrNotFound
		}
		return AccountDeleteResult{}, err
	}
	if req.principal != nil {
		if err := s.sessions.EnsureLiveTx(ctx, q, *req.principal); err != nil {
			return AccountDeleteResult{}, err
		}
	}
	if !strings.EqualFold(strings.TrimSpace(u.Email), req.confirmEmail) {
		return AccountDeleteResult{}, ErrAccountDeleteConfirmInvalid
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM vault WHERE user_id = $1 FOR UPDATE`, u.ID); err != nil {
		return AccountDeleteResult{}, err
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM export_job WHERE user_id = $1 FOR UPDATE`, u.ID); err != nil {
		return AccountDeleteResult{}, err
	}
	if err := q.LockUserContent(ctx, u.ID); err != nil {
		return AccountDeleteResult{}, err
	}

	// (b) Vectors in every existing generation.
	if err := store.DeleteUserAllGenerations(ctx, tx, u.ID); err != nil {
		return AccountDeleteResult{}, err
	}

	// (c) Cancel live export jobs and record durable cleanup rows (no user_id).
	jobs, err := q.CancelUserExportJobs(ctx, u.ID)
	if err != nil {
		return AccountDeleteResult{}, err
	}
	var cleanupIDs []uuid.UUID
	for _, j := range jobs {
		name, ok := exportAttemptFileName(j)
		if !ok {
			continue
		}
		row, err := q.InsertExportFileCleanup(ctx, gen.InsertExportFileCleanupParams{
			FileName: name, JobID: j.ID, AttemptID: j.AttemptID, Reason: "account_delete",
		})
		if err != nil {
			return AccountDeleteResult{}, err
		}
		cleanupIDs = append(cleanupIDs, row.ID)
	}

	// (d) River jobs whose args carry this user_id: pending and historical.
	if _, err := tx.Exec(ctx, `
DELETE FROM river_job
WHERE kind = ANY($1::text[])
  AND args->>'user_id' = $2
  AND state IN ('available', 'scheduled', 'retryable', 'completed', 'discarded')`,
		userScopedJobKinds, u.ID.String()); err != nil {
		return AccountDeleteResult{}, err
	}

	// Mark this request's idempotency claim done before the cascade removes it,
	// so a concurrent owner of the same key cannot slip a second mutation in.
	claim, hasClaim := httpx.IdempotencyClaimFrom(ctx)
	if hasClaim {
		if err := claim.FinishTx(ctx, tx, 204, nil); err != nil {
			return AccountDeleteResult{}, err
		}
	}

	// (e) Remove login-mode oauth_transaction rows (where expected_user_id and
	// expected_session_id are NULL) that recorded this user's provider UID or
	// email before cascading the user and its auth_identity rows.
	if _, err := tx.Exec(ctx, `
DELETE FROM oauth_transaction ot
WHERE EXISTS (
	SELECT 1 FROM auth_identity ai
	WHERE ai.user_id = $1
	  AND ai.provider_uid IS NOT NULL
	  AND ot.identity_provider = ai.provider
	  AND ot.identity_provider_uid = ai.provider_uid
) OR ot.identity_email = $2`, u.ID, u.Email); err != nil {
		return AccountDeleteResult{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM app_user WHERE id = $1`, u.ID); err != nil {
		return AccountDeleteResult{}, err
	}

	// (f) Audit without user link and without PII in meta.
	rec := secevent.Record{
		Event: secevent.EventAccountDelete, Result: secevent.ResultSuccess, Actor: req.actor,
		UserAgent: req.ua, Meta: secevent.Meta{},
	}
	if req.principal != nil {
		sid := req.principal.SessionID
		rec.SessionID = &sid
	}
	if req.ip != "" {
		rec.IPHash = HashIP(s.ipPepper, req.ip)
	}
	if err := s.audit.Record(ctx, tx, rec); err != nil {
		return AccountDeleteResult{}, err
	}
	var auditID int64
	if err := tx.QueryRow(ctx, `SELECT currval(pg_get_serial_sequence('audit_log', 'id'))`).Scan(&auditID); err != nil {
		return AccountDeleteResult{}, err
	}

	if hasClaim {
		claim.MarkCommitAmbiguous()
	}
	if err := tx.Commit(ctx); err != nil {
		return AccountDeleteResult{}, err
	}
	if hasClaim {
		claim.MarkCommitted()
	}
	return AccountDeleteResult{UserID: u.ID, AuditID: auditID, CleanupIDs: cleanupIDs}, nil
}

// exportAttemptFileName returns the on-disk name of a cancelled job's current
// attempt: the stored file_name (ready) or the attempt's .tmp (running).
func exportAttemptFileName(j gen.ExportJob) (string, bool) {
	if j.FileName != nil && *j.FileName != "" {
		return *j.FileName, true
	}
	if j.AttemptID != nil {
		return fmt.Sprintf("%s.%s.tmp", j.ID, *j.AttemptID), true
	}
	return "", false
}

// enqueueExportCleanup inserts one export_file_cleanup job per row after
// commit. Failures are not returned: the rows are durable and export_prune
// sweeps every row without done_at.
func (s *Service) enqueueExportCleanup(ctx context.Context, ids []uuid.UUID) {
	if s.jobs == nil || len(ids) == 0 {
		return
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, id := range ids {
		if _, err := s.jobs.InsertTx(ctx, tx, exportcleanup.Args{CleanupID: id}, nil); err != nil {
			return
		}
	}
	_ = tx.Commit(ctx)
}

func isLockRetryable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "55P03")
}
