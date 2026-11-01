package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/secevent"
)

type Auditor interface {
	Record(ctx context.Context, tx pgx.Tx, rec secevent.Record) error
}

type Notifier interface {
	NotifySecurity(ctx context.Context, tx pgx.Tx, n secevent.Notice) error
}

type SemanticProbe interface {
	Available(ctx context.Context) bool
}

type Mailer interface {
	Send(ctx context.Context, recipient, purpose, link string) error
}

type VaultStatus func(ctx context.Context, userID uuid.UUID) (string, error)

type Service struct {
	cfg      *config.Config
	pool     *pgxpool.Pool
	q        *gen.Queries
	sessions *SessionStore
	csrf     *CSRF
	tokens   *TokenIssuer
	grants   *Grants
	lockout  *Lockout
	clk      clock.Clock
	audit    Auditor
	notify   Notifier
	probe    SemanticProbe
	mail     Mailer
	vault    VaultStatus
	ipPepper []byte
	emPepper []byte
}

func NewService(cfg *config.Config, pool *pgxpool.Pool, sessions *SessionStore, csrf *CSRF, tokens *TokenIssuer, grants *Grants, lockout *Lockout, clk clock.Clock, audit Auditor, notify Notifier, probe SemanticProbe, mail Mailer, vault VaultStatus) (*Service, error) {
	if cfg == nil || pool == nil || sessions == nil || csrf == nil || tokens == nil || grants == nil || lockout == nil || audit == nil || notify == nil {
		return nil, errors.New("auth service thiếu dependency bắt buộc")
	}
	if clk == nil {
		clk = clock.System{}
	}
	if vault == nil {
		vault = func(context.Context, uuid.UUID) (string, error) { return "absent", nil }
	}
	if probe == nil {
		probe = staticProbe(false)
	}
	return &Service{
		cfg: cfg, pool: pool, q: gen.New(pool), sessions: sessions, csrf: csrf,
		tokens: tokens, grants: grants, lockout: lockout, clk: clk,
		audit: audit, notify: notify, probe: probe, mail: mail, vault: vault,
		ipPepper: cfg.AuthIPPepper, emPepper: cfg.AuthEmailPepper,
	}, nil
}

type staticProbe bool

func (s staticProbe) Available(context.Context) bool { return bool(s) }

const semanticProbeTimeout = 300 * time.Millisecond

type runtimeSemanticProbe struct {
	endpoint string
	client   *http.Client
}

func (p *runtimeSemanticProbe) Available(ctx context.Context) bool {
	if p == nil || p.endpoint == "" {
		return false
	}
	if ctx == nil {
		ctx = context.Background()
	}
	probeCtx, cancel := context.WithTimeout(ctx, semanticProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, p.endpoint, nil)
	if err != nil {
		return false
	}
	client := p.client
	if client == nil {
		client = &http.Client{
			Timeout: semanticProbeTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode == http.StatusOK
}

func ConfigProbe(cfg *config.Config) SemanticProbe {
	if cfg == nil || !cfg.SemanticAvailable() {
		return staticProbe(false)
	}
	return &runtimeSemanticProbe{
		endpoint: strings.TrimRight(cfg.TEIURL, "/") + "/health",
		client: &http.Client{
			Timeout: semanticProbeTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (s *Service) PublicConfig() AuthConfig {
	return AuthConfig{
		OAuthProviders:            s.cfg.OAuthProviders(),
		EmailVerificationRequired: s.cfg.RequireEmailVerification,
		CaptchaSiteKey:            s.cfg.CaptchaSiteKey(),
	}
}

func (s *Service) AppOrigin() string { return s.cfg.AppOrigin }

func (s *Service) BuildMe(ctx context.Context, userID uuid.UUID) (Me, error) {
	u, err := s.q.GetUserByID(ctx, userID)
	if err != nil {
		return Me{}, err
	}
	ids, err := s.q.GetIdentitiesByUser(ctx, userID)
	if err != nil {
		return Me{}, err
	}
	st := "absent"
	if s.vault != nil {
		if v, err := s.vault(ctx, userID); err == nil && v != "" {
			st = v
		}
	}
	hasPassword := false
	identities := make([]MeIdentity, 0, len(ids))
	for _, id := range ids {
		if id.Provider == "password" {
			hasPassword = true
		}
		identities = append(identities, MeIdentity{Provider: id.Provider, LinkedAt: id.CreatedAt.Time})
	}
	semantic := false
	if u.Settings != nil {
		var m map[string]any
		if json.Unmarshal(u.Settings, &m) == nil {
			if v, ok := m["semantic_suggest"].(bool); ok {
				semantic = v
			}
		}
	}
	verified := u.EmailVerifiedAt.Valid
	return Me{
		User: MeUser{ID: u.ID, Email: u.Email, EmailVerified: verified, CreatedAt: u.CreatedAt.Time},
		Settings: MeSettings{
			Locale: u.Locale, Theme: u.Theme, AutoLockMinutes: int(u.AutoLockMinutes), SemanticSuggest: semantic,
		},
		Identities: identities,
		Features: MeFeatures{
			SemanticAvailable:           s.probe.Available(ctx),
			EmailVerificationRequired:   s.cfg.RequireEmailVerification,
			OAuthProviders:              s.cfg.OAuthProviders(),
			OAuthReauthProviders:        s.cfg.OAuthReauthProviders(),
			PasswordEnrollmentAvailable: !hasPassword && verified,
			CaptchaSiteKey:              s.cfg.CaptchaSiteKey(),
		},
		Vault: MeVault{Status: st},
	}, nil
}

type SignupInput struct {
	Email    string
	Password string
	Locale   string
	IP       string
	UA       string
}

func (s *Service) Signup(ctx context.Context, in SignupInput) (Me, IssueResult, error) {
	email, err := NormalizeEmail(in.Email)
	if err != nil {
		return Me{}, IssueResult{}, err
	}
	if err := ValidatePassword(in.Password); err != nil {
		return Me{}, IssueResult{}, err
	}
	locale := in.Locale
	if locale == "" {
		locale = "en"
	}
	if locale != "en" && locale != "vi" {
		return Me{}, IssueResult{}, ErrInvalidRequest
	}
	hash, err := HashPassword(in.Password)
	if err != nil {
		return Me{}, IssueResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Me{}, IssueResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: email, Locale: locale})
	if err != nil {
		if isUnique(err) {
			return Me{}, IssueResult{}, ErrEmailTaken
		}
		return Me{}, IssueResult{}, err
	}
	if _, err := q.InsertPasswordIdentity(ctx, gen.InsertPasswordIdentityParams{UserID: u.ID, PasswordHash: &hash}); err != nil {
		return Me{}, IssueResult{}, err
	}
	issued, err := s.sessions.Issue(ctx, tx, IssueParams{UserID: u.ID, IPHash: HashIP(s.ipPepper, in.IP), UserAgent: in.UA})
	if err != nil {
		return Me{}, IssueResult{}, err
	}
	uid, sid := u.ID, issued.Principal.SessionID
	if err := s.audit.Record(ctx, tx, secevent.Record{
		UserID: &uid, SessionID: &sid, Event: secevent.EventSignup, Result: secevent.ResultSuccess,
		Actor: "user", IPHash: HashIP(s.ipPepper, in.IP), UserAgent: in.UA,
		Meta: secevent.Meta{Provider: secevent.ProviderPassword},
	}); err != nil {
		return Me{}, IssueResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Me{}, IssueResult{}, err
	}
	me, err := s.BuildMe(ctx, u.ID)
	return me, issued, err
}

type LoginInput struct {
	Email        string
	Password     string
	CaptchaToken string
	IP           string
	UA           string
	CaptchaOK    bool
	CaptchaOn    bool
}

func (s *Service) Login(ctx context.Context, in LoginInput) (Me, IssueResult, error) {
	email, err := NormalizeEmail(in.Email)
	if err != nil {
		email = strings.TrimSpace(in.Email)
	}
	subject := HashEmailSubject(s.emPepper, email)
	st, err := s.lockout.State(ctx, subject)
	if err != nil {
		return Me{}, IssueResult{}, err
	}
	if !st.LockedUntil.IsZero() {
		return Me{}, IssueResult{}, &RateLimitedError{RetryAfter: st.RetryAfter, Captcha: true}
	}
	if st.Captcha && in.CaptchaOn && !in.CaptchaOK {
		return Me{}, IssueResult{}, ErrCaptchaRequired
	}

	u, userErr := s.q.GetUserByEmail(ctx, email)
	hash := DummyHash
	if userErr == nil {
		if id, err := s.q.GetIdentityByUserProvider(ctx, gen.GetIdentityByUserProviderParams{UserID: u.ID, Provider: "password"}); err == nil && id.PasswordHash != nil {
			hash = *id.PasswordHash
		}
	}
	ok, verr := VerifyPassword(hash, in.Password)
	if verr != nil {
		ok = false
	}
	if userErr != nil || !ok {
		st, _ = s.lockout.RecordFailure(ctx, subject)
		_ = s.audit.Record(ctx, nil, secevent.Record{
			Event: secevent.EventLoginFailure, Result: secevent.ResultFailure,
			IPHash: HashIP(s.ipPepper, in.IP), UserAgent: in.UA,
			Meta: secevent.Meta{Provider: secevent.ProviderPassword, Reason: secevent.ReasonInvalid},
		})
		if !st.LockedUntil.IsZero() {
			return Me{}, IssueResult{}, &RateLimitedError{RetryAfter: st.RetryAfter, Captcha: true}
		}
		return Me{}, IssueResult{}, ErrInvalidCredentials
	}
	_ = s.lockout.Reset(ctx, subject)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Me{}, IssueResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	issued, err := s.sessions.Issue(ctx, tx, IssueParams{UserID: u.ID, IPHash: HashIP(s.ipPepper, in.IP), UserAgent: in.UA})
	if err != nil {
		return Me{}, IssueResult{}, err
	}
	uid, sid := u.ID, issued.Principal.SessionID
	if err := s.audit.Record(ctx, tx, secevent.Record{
		UserID: &uid, SessionID: &sid, Event: secevent.EventLoginSuccess, Result: secevent.ResultSuccess,
		Actor: "user", IPHash: HashIP(s.ipPepper, in.IP), UserAgent: in.UA,
		Meta: secevent.Meta{Provider: secevent.ProviderPassword},
	}); err != nil {
		return Me{}, IssueResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Me{}, IssueResult{}, err
	}
	me, err := s.BuildMe(ctx, u.ID)
	return me, issued, err
}

func (s *Service) Logout(ctx context.Context, p *authctx.Principal, refresh string) error {
	var sessID uuid.UUID
	var userID uuid.UUID
	if p != nil {
		sessID, userID = p.SessionID, p.UserID
	} else if refresh != "" {
		sess, _, err := s.sessions.LookupByRefresh(ctx, refresh)
		if err != nil {
			return nil
		}
		sessID, userID = sess.ID, sess.UserID
	} else {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	now := pgts(s.clk.Now())
	_, _ = q.RevokeSession(ctx, gen.RevokeSessionParams{ID: sessID, RevokedAt: now})
	_, _ = q.CancelPendingBySession(ctx, gen.CancelPendingBySessionParams{SessionID: &sessID, ConsumedAt: now})
	_, _ = q.CancelPendingOAuthBySession(ctx, gen.CancelPendingOAuthBySessionParams{ExpectedSessionID: &sessID, ConsumedAt: now})
	_, _ = q.CancelReceiptsBySession(ctx, gen.CancelReceiptsBySessionParams{SessionID: sessID, ConsumedAt: now})
	if err := s.audit.Record(ctx, tx, secevent.Record{
		UserID: &userID, SessionID: &sessID, Event: secevent.EventLogout, Result: secevent.ResultSuccess, Actor: "user",
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) Refresh(ctx context.Context, refresh string, csrfCookie, csrfHeader string) (IssueResult, error) {
	return s.sessions.Refresh(ctx, refresh, func(p authctx.Principal) error {
		return s.csrf.Verify(csrfCookie, csrfHeader, CSRFKindSession, p.SessionID.String())
	})
}

type SettingsPatch struct {
	Locale          *string
	Theme           *string
	AutoLockMinutes *int
	SemanticSuggest *bool
}

func (s *Service) PatchSettings(ctx context.Context, p authctx.Principal, patch SettingsPatch) (Me, error) {
	if patch.Locale == nil && patch.Theme == nil && patch.AutoLockMinutes == nil && patch.SemanticSuggest == nil {
		return Me{}, ErrInvalidRequest
	}
	if patch.Locale != nil && *patch.Locale != "en" && *patch.Locale != "vi" {
		return Me{}, ErrInvalidRequest
	}
	if patch.Theme != nil && *patch.Theme != "system" && *patch.Theme != "light" && *patch.Theme != "dark" {
		return Me{}, ErrInvalidRequest
	}
	if patch.AutoLockMinutes != nil {
		switch *patch.AutoLockMinutes {
		case 0, 5, 15, 60:
		default:
			return Me{}, ErrInvalidRequest
		}
	}
	if patch.SemanticSuggest != nil && *patch.SemanticSuggest && !s.probe.Available(ctx) {
		return Me{}, ErrSemanticUnavailable
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
	var locale, theme *string
	var lock *int32
	if patch.Locale != nil {
		locale = patch.Locale
	}
	if patch.Theme != nil {
		theme = patch.Theme
	}
	if patch.AutoLockMinutes != nil {
		v := int32(*patch.AutoLockMinutes)
		lock = &v
	}
	if _, err := q.UpdateUserLocaleThemeAutoLock(ctx, gen.UpdateUserLocaleThemeAutoLockParams{
		ID: p.UserID, Locale: locale, Theme: theme, AutoLockMinutes: lock,
	}); err != nil {
		return Me{}, err
	}
	if patch.SemanticSuggest != nil {
		if _, err := q.UpdateUserSemanticSuggest(ctx, gen.UpdateUserSemanticSuggestParams{
			ID: p.UserID, SemanticSuggest: *patch.SemanticSuggest,
		}); err != nil {
			return Me{}, err
		}
	}
	var fields []string
	if patch.Locale != nil {
		fields = append(fields, secevent.FieldLocale)
	}
	if patch.Theme != nil {
		fields = append(fields, secevent.FieldTheme)
	}
	if patch.AutoLockMinutes != nil {
		fields = append(fields, secevent.FieldAutoLock)
	}
	if patch.SemanticSuggest != nil {
		fields = append(fields, secevent.FieldSemanticSuggest)
	}
	uid, sid := p.UserID, p.SessionID
	if err := s.audit.Record(ctx, tx, secevent.Record{
		UserID: &uid, SessionID: &sid, Event: secevent.EventSettingsChange, Result: secevent.ResultSuccess,
		Actor: "user", Meta: secevent.Meta{Fields: fields},
	}); err != nil {
		return Me{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Me{}, err
	}
	return s.BuildMe(ctx, p.UserID)
}

func (s *Service) ListSessions(ctx context.Context, p authctx.Principal, limit int, cursor string) (CursorPage[SessionItem], error) {
	if limit < 1 || limit > 100 {
		limit = 50
	}
	var cCreated pgtype.Timestamptz
	var cID *uuid.UUID
	if cursor != "" {
		ts, id, err := parseTimeUUIDCursor(cursor)
		if err != nil {
			return CursorPage[SessionItem]{}, ErrInvalidRequest
		}
		cCreated = pgts(ts)
		cID = &id
	}
	rows, err := s.q.ListAliveSessionsByUser(ctx, gen.ListAliveSessionsByUserParams{
		UserID:        p.UserID,
		ExpiresAt:     pgts(s.clk.Now()),
		CursorCreated: cCreated,
		CursorID:      cID,
		Limit:         int32(limit + 1),
	})
	if err != nil {
		return CursorPage[SessionItem]{}, err
	}
	items := make([]SessionItem, 0, len(rows))
	for i, row := range rows {
		if i == limit {
			next := encodeTimeUUIDCursor(row.CreatedAt.Time, row.ID)
			return CursorPage[SessionItem]{Items: items, NextCursor: &next}, nil
		}
		items = append(items, SessionItem{
			ID: row.ID, Current: row.ID == p.SessionID, DeviceLabel: row.DeviceLabel,
			UserAgent: row.UserAgent, CreatedAt: row.CreatedAt.Time,
			LastSeenAt: row.LastSeenAt.Time, ExpiresAt: row.ExpiresAt.Time,
		})
	}
	return CursorPage[SessionItem]{Items: items}, nil
}

func (s *Service) ReauthWithPassword(ctx context.Context, p authctx.Principal, action, password string) (ReauthGrant, error) {
	if !ValidReauthAction(action) {
		return ReauthGrant{}, ErrInvalidRequest
	}
	id, err := s.q.GetIdentityByUserProvider(ctx, gen.GetIdentityByUserProviderParams{UserID: p.UserID, Provider: "password"})
	if err != nil || id.PasswordHash == nil {
		return ReauthGrant{}, ErrReauthInvalid
	}
	subject := HashEmailSubject(s.emPepper, "user:"+p.UserID.String())
	st, err := s.lockout.State(ctx, subject)
	if err != nil {
		return ReauthGrant{}, err
	}
	if !st.LockedUntil.IsZero() {
		return ReauthGrant{}, &RateLimitedError{RetryAfter: st.RetryAfter, Captcha: true}
	}
	ok, _ := VerifyPassword(*id.PasswordHash, password)
	if !ok {
		_, _ = s.lockout.RecordFailure(ctx, subject)
		return ReauthGrant{}, ErrInvalidCredentials
	}
	_ = s.lockout.Reset(ctx, subject)
	return s.grants.Issue(p, action)
}

func isUnique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func parseTimeUUIDCursor(s string) (time.Time, uuid.UUID, error) {
	parts := strings.Split(s, ",")
	if len(parts) != 2 {
		return time.Time{}, uuid.Nil, ErrInvalidRequest
	}
	ts, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, uuid.Nil, err
	}
	id, err := uuid.Parse(parts[1])
	return ts, id, err
}

func encodeTimeUUIDCursor(ts time.Time, id uuid.UUID) string {
	return ts.UTC().Format(time.RFC3339Nano) + "," + id.String()
}

func encodeBigCursor(ts time.Time, id int64) string {
	return ts.UTC().Format(time.RFC3339Nano) + "," + strconv.FormatInt(id, 10)
}

func parseBigCursor(s string) (time.Time, int64, error) {
	parts := strings.Split(s, ",")
	if len(parts) != 2 {
		return time.Time{}, 0, ErrInvalidRequest
	}
	ts, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return time.Time{}, 0, err
	}
	id, err := strconv.ParseInt(parts[1], 10, 64)
	return ts, id, err
}
