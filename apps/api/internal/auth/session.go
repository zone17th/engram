package auth

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/secevent"
)

const lastSeenThrottle = time.Minute

// IssueResult là cookie/session sau khi cấp mới.
type IssueResult struct {
	Principal   authctx.Principal
	Access      string
	AccessExp   time.Time
	Refresh     string
	SessionExp  time.Time
	DeviceLabel *string
}

type SessionStore struct {
	pool   *pgxpool.Pool
	q      *gen.Queries
	tokens *TokenIssuer
	clk    clock.Clock
	audit  Auditor
}

func NewSessionStore(pool *pgxpool.Pool, tokens *TokenIssuer, clk clock.Clock) *SessionStore {
	if clk == nil {
		clk = clock.System{}
	}
	return &SessionStore{pool: pool, q: gen.New(pool), tokens: tokens, clk: clk}
}

func (s *SessionStore) SetAuditor(a Auditor) { s.audit = a }

func (s *SessionStore) Q(tx pgx.Tx) *gen.Queries {
	if tx != nil {
		return s.q.WithTx(tx)
	}
	return s.q
}

type IssueParams struct {
	UserID      uuid.UUID
	IPHash      []byte
	UserAgent   string
	DeviceLabel string
}

func (s *SessionStore) Issue(ctx context.Context, tx pgx.Tx, p IssueParams) (IssueResult, error) {
	now := s.clk.Now()
	raw, enc, err := NewOpaqueToken()
	if err != nil {
		return IssueResult{}, err
	}
	ua := sanitizeUA(p.UserAgent)
	var label *string
	if p.DeviceLabel != "" {
		label = &p.DeviceLabel
	}
	sess, err := s.Q(tx).InsertSession(ctx, gen.InsertSessionParams{
		UserID:           p.UserID,
		RefreshTokenHash: RefreshHash(raw),
		DeviceLabel:      label,
		IpHash:           p.IPHash,
		UserAgent:        ua,
		ExpiresAt:        pgts(now.Add(SessionTTL)),
	})
	if err != nil {
		return IssueResult{}, err
	}
	access, accessExp, err := s.tokens.IssueAccess(p.UserID, sess.ID, sess.ExpiresAt.Time)
	if err != nil {
		return IssueResult{}, err
	}
	return IssueResult{
		Principal:   authctx.Principal{UserID: p.UserID, SessionID: sess.ID},
		Access:      access,
		AccessExp:   accessExp,
		Refresh:     enc,
		SessionExp:  sess.ExpiresAt.Time,
		DeviceLabel: label,
	}, nil
}

func (s *SessionStore) Authenticate(ctx context.Context, access string) (authctx.Principal, error) {
	if strings.TrimSpace(access) == "" {
		return authctx.Principal{}, ErrUnauthenticated
	}
	userID, sessionID, _, err := s.tokens.ParseAccess(access)
	if err != nil {
		return authctx.Principal{}, err
	}
	sess, err := s.q.GetSessionByID(ctx, sessionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return authctx.Principal{}, SessionInvalid("invalid")
		}
		return authctx.Principal{}, err
	}
	if sess.UserID != userID {
		return authctx.Principal{}, SessionInvalid("invalid")
	}
	now := s.clk.Now()
	if sess.RevokedAt.Valid {
		return authctx.Principal{}, SessionInvalid("revoked")
	}
	if !sess.ExpiresAt.Valid || !sess.ExpiresAt.Time.After(now) {
		return authctx.Principal{}, SessionInvalid("expired")
	}
	user, err := s.q.GetUserByID(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return authctx.Principal{}, SessionInvalid("invalid")
		}
		return authctx.Principal{}, err
	}
	if user.DeletedAt.Valid {
		return authctx.Principal{}, SessionInvalid("invalid")
	}
	if !sess.LastSeenAt.Valid || now.Sub(sess.LastSeenAt.Time) >= lastSeenThrottle {
		_ = s.q.TouchSessionLastSeen(ctx, gen.TouchSessionLastSeenParams{
			ID:           sess.ID,
			LastSeenAt:   pgts(now),
			LastSeenAt_2: pgts(now.Add(-lastSeenThrottle)),
		})
	}
	return authctx.Principal{UserID: userID, SessionID: sessionID}, nil
}

// LookupByRefresh tìm session từ hash hiện tại hoặc lịch sử, không rotate.
func (s *SessionStore) LookupByRefresh(ctx context.Context, encoded string) (gen.Session, bool, error) {
	raw, err := ParseOpaqueToken(encoded)
	if err != nil {
		return gen.Session{}, false, SessionInvalid("invalid")
	}
	h := RefreshHash(raw)
	sess, err := s.q.GetSessionByRefreshHash(ctx, h)
	if err == nil {
		return sess, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return gen.Session{}, false, err
	}
	sess, err = s.q.GetSessionByUsedRefreshHash(ctx, h)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.Session{}, false, SessionInvalid("invalid")
		}
		return gen.Session{}, false, err
	}
	return sess, false, nil
}

// Refresh thực hiện thuật toán mục 2.2. verifyCSRF chạy sau khi biết session, trước rotate/revoke.
func (s *SessionStore) Refresh(ctx context.Context, encoded string, verifyCSRF func(authctx.Principal) error) (IssueResult, error) {
	raw, err := ParseOpaqueToken(encoded)
	if err != nil {
		return IssueResult{}, SessionInvalid("invalid")
	}
	h := RefreshHash(raw)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return IssueResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.Q(tx)

	sess, current, err := s.lockSessionByRefresh(ctx, q, h)
	if err != nil {
		return IssueResult{}, err
	}

	principal := authctx.Principal{UserID: sess.UserID, SessionID: sess.ID}
	if err := verifyCSRF(principal); err != nil {
		return IssueResult{}, err
	}

	now := s.clk.Now()
	if sess.RevokedAt.Valid {
		return IssueResult{}, SessionInvalid("revoked")
	}
	if !sess.ExpiresAt.Valid || !sess.ExpiresAt.Time.After(now) {
		return IssueResult{}, SessionInvalid("expired")
	}
	user, err := q.GetUserByID(ctx, sess.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return IssueResult{}, SessionInvalid("invalid")
		}
		return IssueResult{}, err
	}
	if user.DeletedAt.Valid {
		return IssueResult{}, SessionInvalid("invalid")
	}

	if !current {
		if _, err := q.RevokeSession(ctx, gen.RevokeSessionParams{ID: sess.ID, RevokedAt: pgts(now)}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return IssueResult{}, err
		}
		if s.audit != nil {
			uid, sid := sess.UserID, sess.ID
			if err := s.audit.Record(ctx, tx, secevent.Record{
				UserID: &uid, SessionID: &sid, Event: secevent.EventRefreshReuse, Result: secevent.ResultFailure,
				Actor: "user", Meta: secevent.Meta{Reason: secevent.ReasonReuse},
			}); err != nil {
				return IssueResult{}, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return IssueResult{}, err
		}
		return IssueResult{}, SessionInvalid("revoked")
	}

	newRaw, newEnc, err := NewOpaqueToken()
	if err != nil {
		return IssueResult{}, err
	}
	access, accessExp, err := s.tokens.IssueAccess(sess.UserID, sess.ID, sess.ExpiresAt.Time)
	if err != nil {
		return IssueResult{}, err
	}
	if err := q.InsertRefreshUsed(ctx, gen.InsertRefreshUsedParams{
		TokenHash: h,
		SessionID: sess.ID,
		UsedAt:    pgts(now),
	}); err != nil {
		return IssueResult{}, err
	}
	if _, err := q.RotateSessionRefresh(ctx, gen.RotateSessionRefreshParams{
		ID:               sess.ID,
		RefreshTokenHash: RefreshHash(newRaw),
	}); err != nil {
		return IssueResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return IssueResult{}, err
	}
	return IssueResult{
		Principal:  principal,
		Access:     access,
		AccessExp:  accessExp,
		Refresh:    newEnc,
		SessionExp: sess.ExpiresAt.Time,
	}, nil
}

func (s *SessionStore) lockSessionByRefresh(ctx context.Context, q *gen.Queries, h []byte) (gen.Session, bool, error) {
	sess, err := q.GetSessionByRefreshHashForUpdate(ctx, h)
	if err == nil {
		return sess, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return gen.Session{}, false, err
	}
	sess, err = q.GetSessionByUsedRefreshHashForUpdate(ctx, h)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.Session{}, false, SessionInvalid("invalid")
		}
		return gen.Session{}, false, err
	}
	return sess, false, nil
}

func sessionUsable(sess gen.Session, p authctx.Principal, now time.Time) error {
	if sess.UserID != p.UserID {
		return SessionInvalid("invalid")
	}
	if sess.RevokedAt.Valid {
		return SessionInvalid("revoked")
	}
	if !sess.ExpiresAt.Valid || !sess.ExpiresAt.Time.After(now) {
		return SessionInvalid("expired")
	}
	return nil
}

// EnsureLive kiểm tra session DB còn hiệu lực cho grant/re-auth.
func (s *SessionStore) EnsureLive(ctx context.Context, p authctx.Principal) error {
	sess, err := s.q.GetSessionByID(ctx, p.SessionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SessionInvalid("invalid")
		}
		return err
	}
	return sessionUsable(sess, p, s.clk.Now())
}

// EnsureLiveTx khoá session trong transaction đang mở (cùng thứ tự với revoke).
func (s *SessionStore) EnsureLiveTx(ctx context.Context, q *gen.Queries, p authctx.Principal) error {
	if q == nil {
		q = s.q
	}
	sess, err := q.GetSessionByIDForUpdate(ctx, p.SessionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SessionInvalid("invalid")
		}
		return err
	}
	return sessionUsable(sess, p, s.clk.Now())
}

func (s *SessionStore) Revoke(ctx context.Context, principal authctx.Principal, sessionID uuid.UUID) (wasCurrent bool, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.Q(tx)
	if _, err := q.GetUserByIDForUpdate(ctx, principal.UserID); err != nil {
		return false, err
	}
	if err := s.EnsureLiveTx(ctx, q, principal); err != nil {
		return false, err
	}
	sess, err := q.GetSessionByIDForUpdate(ctx, sessionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, ErrNotFound
		}
		return false, err
	}
	if sess.UserID != principal.UserID {
		return false, ErrNotFound
	}
	now := s.clk.Now()
	if !sess.RevokedAt.Valid {
		if _, err := q.RevokeSession(ctx, gen.RevokeSessionParams{ID: sessionID, RevokedAt: pgts(now)}); err != nil {
			return false, err
		}
	}
	sid := sessionID
	_, _ = q.CancelPendingBySession(ctx, gen.CancelPendingBySessionParams{SessionID: &sid, ConsumedAt: pgts(now)})
	_, _ = q.CancelPendingOAuthBySession(ctx, gen.CancelPendingOAuthBySessionParams{ExpectedSessionID: &sid, ConsumedAt: pgts(now)})
	_, _ = q.CancelReceiptsBySession(ctx, gen.CancelReceiptsBySessionParams{SessionID: sessionID, ConsumedAt: pgts(now)})
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return sessionID == principal.SessionID, nil
}

func (s *SessionStore) RevokeOthers(ctx context.Context, principal authctx.Principal) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.Q(tx)
	if _, err := q.GetUserByIDForUpdate(ctx, principal.UserID); err != nil {
		return 0, err
	}
	if err := s.EnsureLiveTx(ctx, q, principal); err != nil {
		return 0, err
	}
	n, err := q.RevokeOtherSessions(ctx, gen.RevokeOtherSessionsParams{
		UserID:    principal.UserID,
		ID:        principal.SessionID,
		RevokedAt: pgts(s.clk.Now()),
	})
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

func sanitizeUA(ua string) *string {
	ua = strings.TrimSpace(ua)
	if ua == "" {
		return nil
	}
	if len(ua) > 256 {
		ua = ua[:256]
	}
	return &ua
}

func pgts(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t.UTC(), Valid: true}
}
