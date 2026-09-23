package auth

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/secevent"
)

func (s *Service) ChangePassword(ctx context.Context, p authctx.Principal, newPassword, enrollmentToken, grant string, ip, ua string) (Me, IssueResult, error) {
	if err := ValidatePassword(newPassword); err != nil {
		return Me{}, IssueResult{}, err
	}
	if enrollmentToken != "" && grant != "" {
		return Me{}, IssueResult{}, ErrInvalidRequest
	}
	hash, err := HashPassword(newPassword)
	if err != nil {
		return Me{}, IssueResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Me{}, IssueResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if _, err := q.GetUserByIDForUpdate(ctx, p.UserID); err != nil {
		return Me{}, IssueResult{}, err
	}
	if err := s.sessions.EnsureLiveTx(ctx, q, p); err != nil {
		return Me{}, IssueResult{}, err
	}
	existing, identErr := q.GetIdentityByUserProvider(ctx, gen.GetIdentityByUserProviderParams{UserID: p.UserID, Provider: "password"})
	hasPassword := identErr == nil && existing.PasswordHash != nil
	if hasPassword {
		if grant == "" || s.grants.Verify(p, "account.password_change", grant) != nil {
			return Me{}, IssueResult{}, ErrReauthRequired
		}
		if _, err := q.UpdatePasswordHash(ctx, gen.UpdatePasswordHashParams{UserID: p.UserID, PasswordHash: &hash}); err != nil {
			return Me{}, IssueResult{}, err
		}
	} else {
		if enrollmentToken != "" {
			if err := s.consumeEnrollment(ctx, q, p, enrollmentToken); err != nil {
				return Me{}, IssueResult{}, err
			}
		} else if grant == "" || s.grants.Verify(p, "account.password_change", grant) != nil {
			return Me{}, IssueResult{}, ErrReauthRequired
		}
		if _, err := q.InsertPasswordIdentity(ctx, gen.InsertPasswordIdentityParams{UserID: p.UserID, PasswordHash: &hash}); err != nil {
			if isUnique(err) {
				return Me{}, IssueResult{}, ErrInvalidRequest
			}
			return Me{}, IssueResult{}, err
		}
	}
	now := s.clk.Now()
	_, _ = q.RevokeOtherSessions(ctx, gen.RevokeOtherSessionsParams{UserID: p.UserID, ID: p.SessionID, RevokedAt: pgts(now)})
	_, _ = q.RevokeSession(ctx, gen.RevokeSessionParams{ID: p.SessionID, RevokedAt: pgts(now)})
	issued, err := s.sessions.Issue(ctx, tx, IssueParams{UserID: p.UserID, IPHash: HashIP(s.ipPepper, ip), UserAgent: ua})
	if err != nil {
		return Me{}, IssueResult{}, err
	}
	uid, sid := p.UserID, issued.Principal.SessionID
	ev := secevent.EventPasswordChange
	if !hasPassword {
		ev = secevent.EventPasswordEnroll
	}
	if err := s.audit.Record(ctx, tx, secevent.Record{
		UserID: &uid, SessionID: &sid, Event: ev, Result: secevent.ResultSuccess, Actor: "user",
	}); err != nil {
		return Me{}, IssueResult{}, err
	}
	u, _ := q.GetUserByID(ctx, p.UserID)
	var targets []string
	if u.EmailVerifiedAt.Valid {
		targets = []string{u.Email}
	}
	if err := s.notify.NotifySecurity(ctx, tx, secevent.Notice{UserID: p.UserID, Kind: secevent.NoticeSecurity, EmailTargets: targets}); err != nil {
		return Me{}, IssueResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Me{}, IssueResult{}, err
	}
	me, err := s.BuildMe(ctx, p.UserID)
	return me, issued, err
}

func (s *Service) consumeEnrollment(ctx context.Context, q *gen.Queries, p authctx.Principal, token string) error {
	raw, err := ParseOpaqueToken(token)
	if err != nil {
		return ErrVerificationInvalid
	}
	row, err := q.GetEmailVerificationByHashForUpdate(ctx, SHA256Bytes(raw))
	if err != nil {
		return ErrVerificationInvalid
	}
	now := s.clk.Now()
	if row.Purpose != "password_enroll" || row.UserID != p.UserID || row.ConsumedAt.Valid || !row.ExpiresAt.Time.After(now) {
		return ErrVerificationInvalid
	}
	if row.SessionID == nil || *row.SessionID != p.SessionID {
		return ErrVerificationInvalid
	}
	u, err := q.GetUserByID(ctx, p.UserID)
	if err != nil {
		return err
	}
	if row.ExpectedCurrentEmail != nil && !equalFoldEmail(*row.ExpectedCurrentEmail, u.Email) {
		return ErrVerificationInvalid
	}
	if _, err := q.ConsumeEmailVerification(ctx, gen.ConsumeEmailVerificationParams{ID: row.ID, ConsumedAt: pgts(now)}); err != nil {
		return err
	}
	return nil
}

func equalFoldEmail(a, b string) bool {
	return EmailSubject(a) == EmailSubject(b)
}

func (s *Service) RequestEmailChange(ctx context.Context, p authctx.Principal, newEmail, grant string) error {
	email, err := NormalizeEmail(newEmail)
	if err != nil {
		return err
	}
	return s.issueEmailTokenWithGrant(ctx, p, "email_change", email, "account.email_change", grant)
}

func (s *Service) SendVerifyCurrent(ctx context.Context, p authctx.Principal) error {
	u, err := s.q.GetUserByID(ctx, p.UserID)
	if err != nil {
		return err
	}
	return s.issueEmailToken(ctx, p, "signup", u.Email)
}

func (s *Service) SendEnroll(ctx context.Context, p authctx.Principal) error {
	u, err := s.q.GetUserByID(ctx, p.UserID)
	if err != nil {
		return err
	}
	if !u.EmailVerifiedAt.Valid {
		return ErrEmailNotVerified
	}
	if _, err := s.q.GetIdentityByUserProvider(ctx, gen.GetIdentityByUserProviderParams{UserID: p.UserID, Provider: "password"}); err == nil {
		return ErrInvalidRequest
	}
	return s.issueEmailToken(ctx, p, "password_enroll", u.Email)
}

func (s *Service) issueEmailToken(ctx context.Context, p authctx.Principal, purpose, target string) error {
	return s.issueEmailTokenWithGrant(ctx, p, purpose, target, "", "")
}

func (s *Service) issueEmailTokenWithGrant(ctx context.Context, p authctx.Principal, purpose, target, action, grant string) error {
	if s.mail == nil {
		return ErrMailDeliveryUnavailable
	}
	raw, enc, err := NewOpaqueToken()
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	u, err := q.GetUserByIDForUpdate(ctx, p.UserID)
	if err != nil {
		return err
	}
	if err := s.sessions.EnsureLiveTx(ctx, q, p); err != nil {
		return err
	}
	if action != "" && (grant == "" || s.grants.Verify(p, action, grant) != nil) {
		return ErrReauthRequired
	}
	if purpose == "email_change" {
		if _, err := q.GetUserByEmail(ctx, target); err == nil {
			return ErrEmailTaken
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	ttl := 24 * time.Hour
	if purpose == "email_change" {
		ttl = 30 * time.Minute
	}
	if purpose == "password_enroll" {
		ttl = 10 * time.Minute
	}
	now := s.clk.Now()
	_, _ = q.ExpirePendingByUserPurpose(ctx, gen.ExpirePendingByUserPurposeParams{UserID: p.UserID, Purpose: purpose, ConsumedAt: pgts(now)})
	var sess *uuid.UUID
	id := p.SessionID
	sess = &id
	expected := u.Email
	if _, err := q.InsertEmailVerification(ctx, gen.InsertEmailVerificationParams{
		UserID: p.UserID, SessionID: sess, Purpose: purpose, TargetEmail: target,
		ExpectedCurrentEmail: &expected, TokenHash: SHA256Bytes(raw), ExpiresAt: pgts(now.Add(ttl)),
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	link := s.cfg.AppOrigin + "/app/auth/verify-email#token=" + enc
	if purpose == "password_enroll" {
		link = s.cfg.AppOrigin + "/app/auth/password-enroll#token=" + enc
	}
	if err := s.mail.Send(ctx, target, purpose, link); err != nil {
		return ErrMailDeliveryUnavailable
	}
	return nil
}

func (s *Service) ConfirmEmailToken(ctx context.Context, p authctx.Principal, token string) (Me, error) {
	raw, err := ParseOpaqueToken(token)
	if err != nil {
		return Me{}, ErrVerificationInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Me{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if _, err := q.GetUserByIDForUpdate(ctx, p.UserID); err != nil {
		return Me{}, err
	}
	if err := s.sessions.EnsureLiveTx(ctx, q, p); err != nil {
		return Me{}, err
	}
	row, err := q.GetEmailVerificationByHashForUpdate(ctx, SHA256Bytes(raw))
	if err != nil {
		return Me{}, ErrVerificationInvalid
	}
	now := s.clk.Now()
	if row.UserID != p.UserID || row.ConsumedAt.Valid || !row.ExpiresAt.Time.After(now) {
		return Me{}, ErrVerificationInvalid
	}
	if row.Purpose == "password_enroll" {
		return Me{}, ErrVerificationInvalid
	}
	if row.Purpose == "email_change" && (row.SessionID == nil || *row.SessionID != p.SessionID) {
		return Me{}, ErrVerificationInvalid
	}
	u, err := q.GetUserByIDForUpdate(ctx, p.UserID)
	if err != nil {
		return Me{}, err
	}
	if row.ExpectedCurrentEmail != nil && !equalFoldEmail(*row.ExpectedCurrentEmail, u.Email) {
		return Me{}, ErrVerificationInvalid
	}
	if _, err := q.ConsumeEmailVerification(ctx, gen.ConsumeEmailVerificationParams{ID: row.ID, ConsumedAt: pgts(now)}); err != nil {
		return Me{}, err
	}
	if row.Purpose == "email_change" {
		if _, err := q.UpdateUserEmail(ctx, gen.UpdateUserEmailParams{ID: p.UserID, Email: row.TargetEmail, EmailVerifiedAt: pgts(now)}); err != nil {
			if isUnique(err) {
				return Me{}, ErrEmailTaken
			}
			return Me{}, err
		}
		_, _ = q.CancelPendingEmailProofs(ctx, gen.CancelPendingEmailProofsParams{UserID: p.UserID, ConsumedAt: pgts(now)})
		_, _ = q.RevokeOtherSessions(ctx, gen.RevokeOtherSessionsParams{UserID: p.UserID, ID: p.SessionID, RevokedAt: pgts(now)})
	} else {
		if _, err := q.UpdateUserEmailVerified(ctx, gen.UpdateUserEmailVerifiedParams{ID: p.UserID, EmailVerifiedAt: pgts(now)}); err != nil {
			return Me{}, err
		}
	}
	uid, sid := p.UserID, p.SessionID
	ev := secevent.EventEmailVerify
	if row.Purpose == "email_change" {
		ev = secevent.EventEmailChangeConfirm
	}
	if err := s.audit.Record(ctx, tx, secevent.Record{UserID: &uid, SessionID: &sid, Event: ev, Result: secevent.ResultSuccess, Actor: "user"}); err != nil {
		return Me{}, err
	}
	var targets []string
	if u.EmailVerifiedAt.Valid {
		targets = []string{u.Email}
	}
	if err := s.notify.NotifySecurity(ctx, tx, secevent.Notice{UserID: p.UserID, EmailTargets: targets}); err != nil {
		return Me{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Me{}, err
	}
	return s.BuildMe(ctx, p.UserID)
}

func (s *Service) UnlinkIdentity(ctx context.Context, p authctx.Principal, provider, grant string) error {
	if provider != "password" && provider != "google" && provider != "github" {
		return ErrInvalidRequest
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if _, err := q.GetUserByIDForUpdate(ctx, p.UserID); err != nil {
		return err
	}
	if err := s.sessions.EnsureLiveTx(ctx, q, p); err != nil {
		return err
	}
	if grant == "" || s.grants.Verify(p, "account.identity_unlink", grant) != nil {
		return ErrReauthRequired
	}
	n, err := q.CountIdentitiesByUser(ctx, p.UserID)
	if err != nil {
		return err
	}
	if n <= 1 {
		return ErrIdentityLastMethod
	}
	rows, err := q.DeleteIdentity(ctx, gen.DeleteIdentityParams{UserID: p.UserID, Provider: provider})
	if err != nil {
		return err
	}
	if rows == 0 {
		return ErrNotFound
	}
	now := s.clk.Now()
	_, _ = q.RevokeOtherSessions(ctx, gen.RevokeOtherSessionsParams{UserID: p.UserID, ID: p.SessionID, RevokedAt: pgts(now)})
	uid, sid := p.UserID, p.SessionID
	if err := s.audit.Record(ctx, tx, secevent.Record{
		UserID: &uid, SessionID: &sid, Event: secevent.EventIdentityUnlink, Result: secevent.ResultSuccess,
		Meta: secevent.Meta{Provider: provider},
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) RevokeSession(ctx context.Context, p authctx.Principal, id uuid.UUID) (current bool, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if _, err := q.GetUserByIDForUpdate(ctx, p.UserID); err != nil {
		return false, err
	}
	if err := s.sessions.EnsureLiveTx(ctx, q, p); err != nil {
		return false, err
	}
	sess, err := q.GetSessionByIDForUpdate(ctx, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, ErrNotFound
		}
		return false, err
	}
	if sess.UserID != p.UserID {
		return false, ErrNotFound
	}
	now := s.clk.Now()
	if !sess.RevokedAt.Valid {
		if _, err := q.RevokeSession(ctx, gen.RevokeSessionParams{ID: id, RevokedAt: pgts(now)}); err != nil {
			return false, err
		}
	}
	sid := id
	_, _ = q.CancelPendingBySession(ctx, gen.CancelPendingBySessionParams{SessionID: &sid, ConsumedAt: pgts(now)})
	_, _ = q.CancelPendingOAuthBySession(ctx, gen.CancelPendingOAuthBySessionParams{ExpectedSessionID: &sid, ConsumedAt: pgts(now)})
	_, _ = q.CancelReceiptsBySession(ctx, gen.CancelReceiptsBySessionParams{SessionID: id, ConsumedAt: pgts(now)})
	uid := p.UserID
	if err := s.audit.Record(ctx, tx, secevent.Record{
		UserID: &uid, SessionID: &sid, Event: secevent.EventSessionRevoke, Result: secevent.ResultSuccess, Actor: "user",
	}); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return id == p.SessionID, nil
}

func (s *Service) RevokeOthers(ctx context.Context, p authctx.Principal, grant string) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if _, err := q.GetUserByIDForUpdate(ctx, p.UserID); err != nil {
		return 0, err
	}
	if err := s.sessions.EnsureLiveTx(ctx, q, p); err != nil {
		return 0, err
	}
	if grant == "" || s.grants.Verify(p, "session.revoke_others", grant) != nil {
		return 0, ErrReauthRequired
	}
	now := s.clk.Now()
	n, err := q.RevokeOtherSessions(ctx, gen.RevokeOtherSessionsParams{
		UserID: p.UserID, ID: p.SessionID, RevokedAt: pgts(now),
	})
	if err != nil {
		return 0, err
	}
	currentID := p.SessionID
	_, _ = q.CancelPendingByUserExceptSession(ctx, gen.CancelPendingByUserExceptSessionParams{
		UserID: p.UserID, SessionID: &currentID, ConsumedAt: pgts(now),
	})
	_, _ = q.CancelPendingOAuthByUserExceptSession(ctx, gen.CancelPendingOAuthByUserExceptSessionParams{
		ExpectedUserID: &p.UserID, ExpectedSessionID: &p.SessionID, ConsumedAt: pgts(now),
	})
	_, _ = q.CancelReceiptsByUserExceptSession(ctx, gen.CancelReceiptsByUserExceptSessionParams{
		UserID: p.UserID, SessionID: p.SessionID, ConsumedAt: pgts(now),
	})
	uid, sid := p.UserID, p.SessionID
	if err := s.audit.Record(ctx, tx, secevent.Record{
		UserID: &uid, SessionID: &sid, Event: secevent.EventSessionRevokeOthers, Result: secevent.ResultSuccess,
		Actor: "user", Meta: secevent.Meta{Count: int(n)},
	}); err != nil {
		return 0, err
	}
	u, err := q.GetUserByID(ctx, p.UserID)
	if err != nil {
		return 0, err
	}
	var targets []string
	if u.EmailVerifiedAt.Valid {
		targets = []string{u.Email}
	}
	if err := s.notify.NotifySecurity(ctx, tx, secevent.Notice{UserID: p.UserID, Kind: secevent.NoticeSecurity, EmailTargets: targets}); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

func (s *Service) ListAudit(ctx context.Context, p authctx.Principal, limit int, cursor string) (CursorPage[AuditItem], error) {
	if limit < 1 || limit > 100 {
		limit = 50
	}
	var cCreated pgtype.Timestamptz
	var cID *int64
	if cursor != "" {
		ts, id, err := parseBigCursor(cursor)
		if err != nil {
			return CursorPage[AuditItem]{}, ErrInvalidRequest
		}
		cCreated = pgts(ts)
		cID = &id
	}
	uid := p.UserID
	rows, err := s.q.ListAuditByUser(ctx, gen.ListAuditByUserParams{UserID: &uid, Limit: int32(limit + 1), CursorCreated: cCreated, CursorID: cID})
	if err != nil {
		return CursorPage[AuditItem]{}, err
	}
	items := make([]AuditItem, 0, len(rows))
	for i, row := range rows {
		if i == limit {
			next := encodeBigCursor(row.CreatedAt.Time, row.ID)
			return CursorPage[AuditItem]{Items: items, NextCursor: &next}, nil
		}
		var meta map[string]any
		_ = json.Unmarshal(row.Meta, &meta)
		items = append(items, AuditItem{
			ID: strconv.FormatInt(row.ID, 10), Event: row.Event, Result: row.Result,
			Actor: row.Actor, CreatedAt: row.CreatedAt.Time, Meta: meta,
		})
	}
	return CursorPage[AuditItem]{Items: items}, nil
}

func (s *Service) ListNotifications(ctx context.Context, p authctx.Principal, limit int, cursor string) (CursorPage[NotificationItem], error) {
	if limit < 1 || limit > 100 {
		limit = 50
	}
	var cCreated pgtype.Timestamptz
	var cID *int64
	if cursor != "" {
		ts, id, err := parseBigCursor(cursor)
		if err != nil {
			return CursorPage[NotificationItem]{}, ErrInvalidRequest
		}
		cCreated = pgts(ts)
		cID = &id
	}
	rows, err := s.q.ListNotificationsByUser(ctx, gen.ListNotificationsByUserParams{UserID: p.UserID, Limit: int32(limit + 1), CursorCreated: cCreated, CursorID: cID})
	if err != nil {
		return CursorPage[NotificationItem]{}, err
	}
	items := make([]NotificationItem, 0, len(rows))
	for i, row := range rows {
		if i == limit {
			next := encodeBigCursor(row.CreatedAt.Time, row.ID)
			return CursorPage[NotificationItem]{Items: items, NextCursor: &next}, nil
		}
		var meta map[string]any
		_ = json.Unmarshal(row.Meta, &meta)
		var readAt *time.Time
		if row.ReadAt.Valid {
			t := row.ReadAt.Time
			readAt = &t
		}
		items = append(items, NotificationItem{
			ID: strconv.FormatInt(row.ID, 10), Kind: row.Kind, Meta: meta, ReadAt: readAt, CreatedAt: row.CreatedAt.Time,
		})
	}
	return CursorPage[NotificationItem]{Items: items}, nil
}

func (s *Service) MarkNotificationRead(ctx context.Context, p authctx.Principal, id int64) error {
	n, err := s.q.MarkNotificationRead(ctx, gen.MarkNotificationReadParams{
		ID: id, UserID: p.UserID, ReadAt: pgts(s.clk.Now()),
	})
	if err != nil {
		return err
	}
	if n == 0 {
		got, err := s.q.GetNotificationByID(ctx, id)
		if err != nil || got.UserID != p.UserID {
			return ErrNotFound
		}
	}
	return nil
}

func (s *Service) CSRF() *CSRF             { return s.csrf }
func (s *Service) Sessions() *SessionStore { return s.sessions }
func (s *Service) Grants() *Grants         { return s.grants }
func (s *Service) Clock() interface{ Now() time.Time } {
	return s.clk
}
