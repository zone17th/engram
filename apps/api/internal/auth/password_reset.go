package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/secevent"
)

const (
	ForgotQueueSize    = 128
	ForgotJobTimeout   = 15 * time.Second
	PasswordResetTTL   = 30 * time.Minute
	resetRetryDelay    = 15 * time.Millisecond
	pgDeadlockDetected = "40P01"
	pgLockNotAvailable = "55P03"
)

type ForgotJob struct {
	Email  string
	Locale string
}

type ForgotHooks struct {
	OnJobStart  func(job ForgotJob)
	OnJobLocked func(userID uuid.UUID)
	OnJobDone   func(job ForgotJob, err error)
}

func (s *Service) SetForgotHooks(hooks ForgotHooks) {
	s.forgotHooks = hooks
}

func (s *Service) SetOnLoginVerified(fn func()) {
	s.onLoginVerified = fn
}

func (s *Service) SetOnResetLocked(fn func()) {
	s.onResetLocked = fn
}

func (s *Service) Close() {
	if s != nil && s.forgotCancel != nil {
		s.forgotCancel()
	}
}

func (s *Service) EmailSubjectHash(email string) []byte {
	return HashEmailSubject(s.emPepper, email)
}

func (s *Service) EnqueueForgotPassword(email, locale string) {
	if s == nil || s.forgotQueue == nil {
		return
	}
	if locale == "" {
		locale = "en"
	}
	select {
	case s.forgotQueue <- ForgotJob{Email: email, Locale: locale}:
	default:
		slog.Warn("password forgot queue full, dropping request")
	}
}

func (s *Service) runForgotWorker() {
	for {
		select {
		case <-s.forgotWorkerCtx.Done():
			return
		case job, ok := <-s.forgotQueue:
			if !ok {
				return
			}
			s.processForgotJobWithTimeout(job)
		}
	}
}

func (s *Service) processForgotJobWithTimeout(job ForgotJob) {
	if s.forgotHooks.OnJobStart != nil {
		s.forgotHooks.OnJobStart(job)
	}
	ctx, cancel := context.WithTimeout(s.forgotWorkerCtx, ForgotJobTimeout)
	defer cancel()
	err := s.ProcessForgotJob(ctx, job)
	if err != nil {
		slog.Error("password forgot worker job failed", slog.String("reason", scrubForgotErr(err)))
	}
	if s.forgotHooks.OnJobDone != nil {
		s.forgotHooks.OnJobDone(job, err)
	}
}

func scrubForgotErr(err error) string {
	if err == nil {
		return ""
	}
	var de *Error
	if errors.As(err, &de) {
		return de.Code
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return "db_" + pgErr.Code
	}
	return "worker_error"
}

func (s *Service) ProcessForgotJob(ctx context.Context, job ForgotJob) error {
	if !s.MailDeliveryAvailable() {
		return ErrMailDeliveryUnavailable
	}
	locale := job.Locale
	if locale != "vi" {
		locale = "en"
	}
	u, err := s.q.GetUserByEmail(ctx, job.Email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if u.DeletedAt.Valid {
		return nil
	}

	raw, enc, err := NewOpaqueToken()
	if err != nil {
		return err
	}
	defer func() {
		for i := range raw {
			raw[i] = 0
		}
		enc = ""
	}()

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)

	uLocked, err := q.GetUserByIDForUpdate(ctx, u.ID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if s.forgotHooks.OnJobLocked != nil {
		s.forgotHooks.OnJobLocked(uLocked.ID)
	}
	if !equalFoldEmail(uLocked.Email, job.Email) {
		return nil
	}

	ident, err := q.GetIdentityByUserProvider(ctx, gen.GetIdentityByUserProviderParams{
		UserID:   uLocked.ID,
		Provider: "password",
	})
	origin := strings.TrimRight(s.cfg.AppOrigin, "/")
	if err != nil || ident.PasswordHash == nil {
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		_ = tx.Rollback(ctx)
		loginLink := origin + "/app/auth/login?locale=" + locale
		return s.mail.Send(ctx, uLocked.Email, PurposePasswordResetOAuthOnly, loginLink)
	}

	now := s.clk.Now()
	_, _ = q.ExpirePendingPasswordResetTokensByUser(ctx, gen.ExpirePendingPasswordResetTokensByUserParams{
		UserID:     uLocked.ID,
		ConsumedAt: pgts(now),
	})
	if _, err := q.InsertPasswordResetToken(ctx, gen.InsertPasswordResetTokenParams{
		UserID:             uLocked.ID,
		TargetEmail:        uLocked.Email,
		TokenHash:          SHA256Bytes(raw),
		PasswordHashSha256: SHA256Bytes([]byte(*ident.PasswordHash)),
		WasEmailUnverified: !uLocked.EmailVerifiedAt.Valid,
		ExpiresAt:          pgts(now.Add(PasswordResetTTL)),
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	resetLink := origin + "/app/auth/reset-password?locale=" + locale + "#token=" + enc
	return s.mail.Send(ctx, uLocked.Email, PurposePasswordReset, resetLink)
}

func ParseResetToken(encoded string) ([]byte, error) {
	if len(encoded) != 43 {
		return nil, ErrResetTokenInvalid
	}
	for i := range len(encoded) {
		ch := encoded[i]
		ok := (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_'
		if !ok {
			return nil, ErrResetTokenInvalid
		}
	}
	raw, err := ParseOpaqueToken(encoded)
	if err != nil || len(raw) != OpaqueTokenBytes {
		return nil, ErrResetTokenInvalid
	}
	return raw, nil
}

type ResetPasswordInput struct {
	Token       string
	NewPassword string
	IP          string
	UA          string
}

func (s *Service) ResetPassword(ctx context.Context, in ResetPasswordInput) error {
	raw, err := ParseResetToken(in.Token)
	if err != nil {
		return ErrResetTokenInvalid
	}
	if err := ValidatePassword(in.NewPassword); err != nil {
		return err
	}
	newHash, err := HashPassword(in.NewPassword)
	if err != nil {
		return err
	}
	tokenHash := SHA256Bytes(raw)

	row, err := s.q.GetPasswordResetTokenByHash(ctx, tokenHash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrResetTokenInvalid
		}
		if isRetryableResetTxErr(err) {
			return ErrDependencyUnavailable
		}
		return err
	}

	for attempt := range 2 {
		err = s.resetPasswordTx(ctx, row.UserID, tokenHash, newHash, in.IP, in.UA)
		if err == nil {
			return nil
		}
		if !isRetryableResetTxErr(err) {
			return err
		}
		if attempt == 0 {
			time.Sleep(resetRetryDelay)
			continue
		}
		return ErrDependencyUnavailable
	}
	return ErrDependencyUnavailable
}

func (s *Service) resetPasswordTx(ctx context.Context, userID uuid.UUID, tokenHash []byte, newHash, ip, ua string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)

	u, err := q.GetUserByIDForUpdate(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrResetTokenInvalid
		}
		return err
	}
	if s.onResetLocked != nil {
		s.onResetLocked()
	}

	now := s.clk.Now()
	if _, err := q.RevokeAllUserSessions(ctx, gen.RevokeAllUserSessionsParams{
		UserID:    u.ID,
		RevokedAt: pgts(now),
	}); err != nil {
		return err
	}

	tok, err := q.GetPasswordResetTokenByHashForUpdate(ctx, tokenHash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrResetTokenInvalid
		}
		return err
	}
	if tok.UserID != u.ID || tok.ConsumedAt.Valid || !tok.ExpiresAt.Valid || !tok.ExpiresAt.Time.After(now) {
		return ErrResetTokenInvalid
	}
	if !equalFoldEmail(tok.TargetEmail, u.Email) {
		return ErrResetTokenInvalid
	}

	ident, err := q.GetIdentityByUserProvider(ctx, gen.GetIdentityByUserProviderParams{
		UserID:   u.ID,
		Provider: "password",
	})
	if err != nil || ident.PasswordHash == nil {
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		return ErrResetTokenInvalid
	}
	if subtle.ConstantTimeCompare(tok.PasswordHashSha256, SHA256Bytes([]byte(*ident.PasswordHash))) != 1 {
		return ErrResetTokenInvalid
	}

	if _, err := q.UpdatePasswordHash(ctx, gen.UpdatePasswordHashParams{
		UserID:       u.ID,
		PasswordHash: &newHash,
	}); err != nil {
		return err
	}
	if _, err := q.ConsumePasswordResetToken(ctx, gen.ConsumePasswordResetTokenParams{
		ID:         tok.ID,
		ConsumedAt: pgts(now),
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrResetTokenInvalid
		}
		return err
	}
	if _, err := q.CancelPendingEmailProofs(ctx, gen.CancelPendingEmailProofsParams{
		UserID:     u.ID,
		ConsumedAt: pgts(now),
	}); err != nil {
		return err
	}
	if _, err := q.ExpirePendingPasswordResetTokensByUser(ctx, gen.ExpirePendingPasswordResetTokensByUserParams{
		UserID:     u.ID,
		ConsumedAt: pgts(now),
	}); err != nil {
		return err
	}

	var unlinkedProviders []string
	if tok.WasEmailUnverified || !u.EmailVerifiedAt.Valid {
		u, err = q.UpdateUserEmailVerified(ctx, gen.UpdateUserEmailVerifiedParams{
			ID:              u.ID,
			EmailVerifiedAt: pgts(now),
		})
		if err != nil {
			return err
		}
		if _, err := q.CancelReadyOAuthLoginByUserIdentities(ctx, gen.CancelReadyOAuthLoginByUserIdentitiesParams{
			UserID:     u.ID,
			ConsumedAt: pgts(now),
		}); err != nil {
			return err
		}
		if _, err := q.CancelPendingOAuthByUser(ctx, gen.CancelPendingOAuthByUserParams{
			ExpectedUserID: &u.ID,
			ConsumedAt:     pgts(now),
		}); err != nil {
			return err
		}
		if _, err := q.CancelReceiptsByUser(ctx, gen.CancelReceiptsByUserParams{
			UserID:     u.ID,
			ConsumedAt: pgts(now),
		}); err != nil {
			return err
		}
		deletedIdents, err := q.DeleteOAuthIdentitiesByUser(ctx, u.ID)
		if err != nil {
			return err
		}
		uid := u.ID
		for _, di := range deletedIdents {
			unlinkedProviders = append(unlinkedProviders, di.Provider)
			if err := s.audit.Record(ctx, tx, secevent.Record{
				UserID:    &uid,
				SessionID: nil,
				Event:     secevent.EventIdentityUnlink,
				Result:    secevent.ResultSuccess,
				Actor:     "user",
				IPHash:    HashIP(s.ipPepper, ip),
				UserAgent: ua,
				Meta: secevent.Meta{
					Provider: di.Provider,
					Reason:   secevent.ReasonUnverified,
				},
			}); err != nil {
				return err
			}
		}
	}

	if err := q.ResetThrottle(ctx, HashEmailSubject(s.emPepper, u.Email)); err != nil {
		return err
	}

	uid := u.ID
	if err := s.audit.Record(ctx, tx, secevent.Record{
		UserID:    &uid,
		SessionID: nil,
		Event:     secevent.EventPasswordReset,
		Result:    secevent.ResultSuccess,
		Actor:     "user",
		IPHash:    HashIP(s.ipPepper, ip),
		UserAgent: ua,
		Meta:      secevent.Meta{Provider: secevent.ProviderPassword},
	}); err != nil {
		return err
	}

	if err := s.notify.NotifySecurity(ctx, tx, secevent.Notice{
		UserID: u.ID,
		Kind:   secevent.NoticeSecurity,
		Meta: secevent.Meta{
			Event:             secevent.EventPasswordReset,
			UnlinkedProviders: unlinkedProviders,
		},
		EmailTargets: []string{u.Email},
	}); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

func isRetryableResetTxErr(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	return pgErr.Code == pgDeadlockDetected || pgErr.Code == pgLockNotAvailable
}
