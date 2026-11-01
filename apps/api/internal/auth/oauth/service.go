package oauth

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/secevent"
)

const (
	flowTTL       = 10 * time.Minute
	completeTTL   = 2 * time.Minute
	receiptTTL    = 2 * time.Minute
	authTimeSkew  = 120 * time.Second
	authTimeAhead = 30 * time.Second
)

type Service struct {
	cfg               *config.Config
	pool              *pgxpool.Pool
	q                 *gen.Queries
	sessions          *auth.SessionStore
	audit             auth.Auditor
	clk               clock.Clock
	providers         map[string]Provider
	hooksMu           sync.RWMutex
	onOwnerDiscovered func()
}

func NewService(cfg *config.Config, pool *pgxpool.Pool, sessions *auth.SessionStore, audit auth.Auditor, clk clock.Clock, providers []Provider) *Service {
	if clk == nil {
		clk = clock.System{}
	}
	m := make(map[string]Provider, len(providers))
	for _, p := range providers {
		if p != nil {
			m[p.Name()] = p
		}
	}
	return &Service{cfg: cfg, pool: pool, q: gen.New(pool), sessions: sessions, audit: audit, clk: clk, providers: m}
}

func (s *Service) SetOnOwnerDiscovered(fn func()) {
	s.hooksMu.Lock()
	s.onOwnerDiscovered = fn
	s.hooksMu.Unlock()
}

func (s *Service) getOnOwnerDiscovered() func() {
	s.hooksMu.RLock()
	defer s.hooksMu.RUnlock()
	return s.onOwnerDiscovered
}

func (s *Service) Provider(name string) (Provider, bool) {
	p, ok := s.providers[name]
	return p, ok
}

func (s *Service) Fake(name string) *Fake {
	p, ok := s.providers[name]
	if !ok {
		return nil
	}
	f, _ := p.(*Fake)
	return f
}

func (s *Service) HasFake() bool {
	for _, p := range s.providers {
		if _, ok := p.(*Fake); ok {
			return true
		}
	}
	return false
}

type StartResult struct {
	AuthorizationURL string
	Binding          string
	BindingExp       time.Time
}

func (s *Service) StartLogin(ctx context.Context, provider, existingBinding string) (StartResult, error) {
	return s.start(ctx, provider, "login", existingBinding, nil, "", false, time.Time{})
}

func (s *Service) StartLink(ctx context.Context, p authctx.Principal, provider, existingBinding string, grantDeadline time.Time) (StartResult, error) {
	u, err := s.q.GetUserByID(ctx, p.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return StartResult{}, auth.SessionInvalid("invalid")
		}
		return StartResult{}, err
	}
	if !u.EmailVerifiedAt.Valid {
		return StartResult{}, auth.ErrEmailNotVerified
	}
	return s.start(ctx, provider, "link", existingBinding, &p, "account.identity_link", false, grantDeadline)
}

func (s *Service) StartReauth(ctx context.Context, p authctx.Principal, provider, action, existingBinding string) (StartResult, error) {
	if !auth.ValidReauthAction(action) {
		return StartResult{}, auth.ErrInvalidRequest
	}
	pr, ok := s.providers[provider]
	if !ok {
		return StartResult{}, auth.ErrOAuthStateInvalid
	}
	if !pr.SupportsReauth() {
		return StartResult{}, auth.ErrReauthUnsupportedProvider
	}
	return s.start(ctx, provider, "reauth", existingBinding, &p, action, true, time.Time{})
}

func (s *Service) start(ctx context.Context, provider, mode, existingBinding string, p *authctx.Principal, action string, promptLogin bool, grantDeadline time.Time) (StartResult, error) {
	pr, ok := s.providers[provider]
	if !ok || (provider != "google" && provider != "github") {
		return StartResult{}, auth.ErrOAuthStateInvalid
	}
	now := s.clk.Now()
	expAt := now.Add(flowTTL)
	if mode == "link" {
		if grantDeadline.IsZero() || !grantDeadline.After(now) {
			return StartResult{}, auth.ErrReauthInvalid
		}
		if grantDeadline.Before(expAt) {
			expAt = grantDeadline
		}
	}
	rawBind, bindEnc, err := auth.NewOpaqueToken()
	if err != nil {
		return StartResult{}, err
	}
	stateRaw, stateEnc, err := auth.NewOpaqueToken()
	if err != nil {
		return StartResult{}, err
	}
	verifier, err := NewPKCEVerifier()
	if err != nil {
		return StartResult{}, err
	}
	_, nonceEnc, err := auth.NewOpaqueToken()
	if err != nil {
		return StartResult{}, err
	}
	if existingBinding != "" {
		if old, err := auth.ParseOpaqueToken(existingBinding); err == nil {
			_, _ = s.q.CancelPendingOAuthByBinding(ctx, gen.CancelPendingOAuthByBindingParams{
				CookieBindingHash: auth.SHA256Bytes(old),
				ConsumedAt:        timestamptz(now),
			})
		}
	}
	var userID *uuid.UUID
	var sessID *uuid.UUID
	var act *string
	if p != nil {
		userID = &p.UserID
		sessID = &p.SessionID
	}
	if action != "" {
		act = &action
	}
	if _, err := s.q.InsertOAuthTransaction(ctx, gen.InsertOAuthTransactionParams{
		Provider:          provider,
		Mode:              mode,
		StateHash:         auth.SHA256Bytes(stateRaw),
		CookieBindingHash: auth.SHA256Bytes(rawBind),
		PkceVerifier:      &verifier,
		Nonce:             &nonceEnc,
		ExpectedUserID:    userID,
		ExpectedSessionID: sessID,
		Action:            act,
		StartedAt:         timestamptz(now),
		ExpiresAt:         timestamptz(expAt),
	}); err != nil {
		return StartResult{}, err
	}
	authURL, err := pr.AuthorizationURL(AuthRequest{
		State:         stateEnc,
		RedirectURI:   s.cfg.OAuthCallbackURL(provider),
		CodeChallenge: PKCEChallenge(verifier),
		Nonce:         nonceEnc,
		PromptLogin:   promptLogin,
	})
	if err != nil {
		return StartResult{}, err
	}
	return StartResult{AuthorizationURL: authURL, Binding: bindEnc, BindingExp: expAt}, nil
}

func (s *Service) Callback(ctx context.Context, provider, code, state, binding, errCode string) (status string, receipt string, receiptExp time.Time, err error) {
	if provider != "google" && provider != "github" {
		return "invalid_flow", "", time.Time{}, nil
	}
	stateRaw, err := auth.ParseOpaqueToken(state)
	if err != nil {
		return "invalid_flow", "", time.Time{}, nil
	}
	bindRaw, err := auth.ParseOpaqueToken(binding)
	if err != nil {
		return "invalid_flow", "", time.Time{}, nil
	}
	row, err := s.q.GetOAuthTxByStateHash(ctx, auth.SHA256Bytes(stateRaw))
	if err != nil {
		return "invalid_flow", "", time.Time{}, nil
	}
	now := s.clk.Now()
	if row.Provider != provider || row.Status != "pending" || row.ClaimedAt.Valid || row.ConsumedAt.Valid || !row.ExpiresAt.Time.After(now) {
		return "invalid_flow", "", time.Time{}, nil
	}
	if subtleBytes(row.CookieBindingHash, auth.SHA256Bytes(bindRaw)) != 1 {
		return "invalid_flow", "", time.Time{}, nil
	}

	var expected authctx.Principal
	linked := row.Mode == "link" || row.Mode == "reauth"
	if linked {
		if row.ExpectedUserID == nil || row.ExpectedSessionID == nil {
			return "invalid_flow", "", time.Time{}, nil
		}
		expected = authctx.Principal{UserID: *row.ExpectedUserID, SessionID: *row.ExpectedSessionID}
	}

	pr, providerOK := s.providers[provider]
	if errCode == "" && !providerOK {
		return "provider_error", "", time.Time{}, nil
	}

	// Claim first so provider exchange happens without holding database locks.
	claimTx, err := s.pool.Begin(ctx)
	if err != nil {
		return "provider_error", "", time.Time{}, err
	}
	defer func() { _ = claimTx.Rollback(ctx) }()
	q := s.q.WithTx(claimTx)
	if linked {
		if _, err := q.GetUserByIDForUpdate(ctx, expected.UserID); err != nil {
			return "invalid_flow", "", time.Time{}, nil
		}
		sess, err := q.GetSessionByIDForUpdate(ctx, expected.SessionID)
		if err != nil || sess.UserID != expected.UserID {
			return "invalid_flow", "", time.Time{}, nil
		}
	}
	verifier := ""
	if row.PkceVerifier != nil {
		verifier = *row.PkceVerifier
	}
	nonce := ""
	if row.Nonce != nil {
		nonce = *row.Nonce
	}
	claimed, err := q.ClaimOAuthTransaction(ctx, gen.ClaimOAuthTransactionParams{ID: row.ID, ClaimedAt: timestamptz(s.clk.Now())})
	if err != nil {
		return "invalid_flow", "", time.Time{}, nil
	}
	claimNow := s.clk.Now()
	if !claimed.ExpiresAt.Time.After(claimNow) {
		return "invalid_flow", "", time.Time{}, nil
	}
	if errCode != "" {
		status = "provider_error"
		if errCode == "access_denied" {
			status = "cancelled"
		}
		if _, err := q.CompleteOAuthTransaction(ctx, gen.CompleteOAuthTransactionParams{ID: claimed.ID, ConsumedAt: timestamptz(claimNow)}); err != nil {
			return "invalid_flow", "", time.Time{}, nil
		}
		if err := claimTx.Commit(ctx); err != nil {
			return "provider_error", "", time.Time{}, err
		}
		return status, "", time.Time{}, nil
	}
	if err := claimTx.Commit(ctx); err != nil {
		return "provider_error", "", time.Time{}, err
	}

	id, err := pr.Exchange(ctx, ExchangeRequest{
		Code: code, CodeVerifier: verifier, RedirectURI: s.cfg.OAuthCallbackURL(provider), Nonce: nonce,
	})
	exchangeNow := s.clk.Now()
	if err != nil {
		if errors.Is(err, auth.ErrReauthUnsupportedProvider) {
			return "reauth_unavailable", "", time.Time{}, nil
		}
		return "provider_error", "", time.Time{}, nil
	}
	if !id.EmailVerified || id.Email == "" || id.UID == "" {
		return "provider_error", "", time.Time{}, nil
	}
	if id.Provider != provider {
		return "provider_error", "", time.Time{}, nil
	}
	if !claimed.ExpiresAt.Time.After(exchangeNow) {
		return "invalid_flow", "", time.Time{}, nil
	}

	// Account-linked callbacks use the same user -> session -> flow order as mutations.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "provider_error", "", time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q = s.q.WithTx(tx)
	var linkedUser gen.AppUser
	if linked {
		var err error
		linkedUser, err = q.GetUserByIDForUpdate(ctx, expected.UserID)
		if err != nil {
			return "invalid_flow", "", time.Time{}, nil
		}
		if err := s.sessions.EnsureLiveTx(ctx, q, expected); err != nil {
			return "invalid_flow", "", time.Time{}, nil
		}
	}
	claimed, err = q.GetOAuthTxByIDForUpdate(ctx, claimed.ID)
	if err != nil || claimed.Status != "claimed" || claimed.ConsumedAt.Valid {
		return "invalid_flow", "", time.Time{}, nil
	}
	now = s.clk.Now()
	if !claimed.ExpiresAt.Time.After(now) {
		return "invalid_flow", "", time.Time{}, nil
	}

	switch claimed.Mode {
	case "login":
		deadline := now.Add(completeTTL)
		if claimed.ExpiresAt.Time.Before(deadline) {
			deadline = claimed.ExpiresAt.Time
		}
		if _, err := q.MarkOAuthReady(ctx, gen.MarkOAuthReadyParams{
			ID:                    claimed.ID,
			IdentityProvider:      &id.Provider,
			IdentityProviderUid:   &id.UID,
			IdentityEmail:         &id.Email,
			IdentityEmailVerified: boolPtr(true),
			CompletionDeadline:    timestamptz(deadline),
		}); err != nil {
			return "provider_error", "", time.Time{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return "provider_error", "", time.Time{}, err
		}
		return "login_ready", "", time.Time{}, nil
	case "link":
		if claimed.ExpectedUserID == nil || claimed.ExpectedSessionID == nil {
			return "invalid_flow", "", time.Time{}, nil
		}
		if !linkedUser.EmailVerifiedAt.Valid {
			return "invalid_flow", "", time.Time{}, nil
		}
		if existing, err := q.GetIdentityByProviderUID(ctx, gen.GetIdentityByProviderUIDParams{Provider: id.Provider, ProviderUid: &id.UID}); err == nil {
			if existing.UserID != *claimed.ExpectedUserID {
				return "identity_conflict", "", time.Time{}, nil
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return "provider_error", "", time.Time{}, err
		}
		if _, err := q.InsertOAuthIdentity(ctx, gen.InsertOAuthIdentityParams{
			UserID: *claimed.ExpectedUserID, Provider: id.Provider, ProviderUid: &id.UID,
		}); err != nil {
			if authUnique(err) {
				return "identity_conflict", "", time.Time{}, nil
			}
			return "provider_error", "", time.Time{}, err
		}
		if _, err := q.CompleteOAuthTransaction(ctx, gen.CompleteOAuthTransactionParams{ID: claimed.ID, ConsumedAt: timestamptz(now)}); err != nil {
			return "provider_error", "", time.Time{}, err
		}
		uid, sid := *claimed.ExpectedUserID, *claimed.ExpectedSessionID
		if s.audit != nil {
			if err := s.audit.Record(ctx, tx, secevent.Record{
				UserID: &uid, SessionID: &sid, Event: secevent.EventIdentityLink, Result: secevent.ResultSuccess,
				Meta: secevent.Meta{Provider: id.Provider},
			}); err != nil {
				return "provider_error", "", time.Time{}, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return "provider_error", "", time.Time{}, err
		}
		return "linked", "", time.Time{}, nil
	case "reauth":
		if !pr.SupportsReauth() {
			return "reauth_unavailable", "", time.Time{}, nil
		}
		if claimed.ExpectedUserID == nil || claimed.ExpectedSessionID == nil || claimed.Action == nil {
			return "invalid_flow", "", time.Time{}, nil
		}
		if id.AuthTime == nil {
			return "reauth_unavailable", "", time.Time{}, nil
		}
		started := claimed.StartedAt.Time
		if id.AuthTime.Before(started.Add(-authTimeSkew)) || id.AuthTime.After(exchangeNow.Add(authTimeAhead)) {
			return "reauth_unavailable", "", time.Time{}, nil
		}
		identity, err := q.GetIdentityByProviderUID(ctx, gen.GetIdentityByProviderUIDParams{Provider: provider, ProviderUid: &id.UID})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return "reauth_unavailable", "", time.Time{}, nil
			}
			return "provider_error", "", time.Time{}, err
		}
		if identity.UserID != *claimed.ExpectedUserID {
			return "reauth_unavailable", "", time.Time{}, nil
		}
		raw, enc, err := auth.NewOpaqueToken()
		if err != nil {
			return "provider_error", "", time.Time{}, err
		}
		receiptDeadline := now.Add(receiptTTL)
		if claimed.ExpiresAt.Time.Before(receiptDeadline) {
			receiptDeadline = claimed.ExpiresAt.Time
		}
		if !receiptDeadline.After(now) {
			return "invalid_flow", "", time.Time{}, nil
		}
		if _, err := q.InsertReauthReceipt(ctx, gen.InsertReauthReceiptParams{
			UserID: *claimed.ExpectedUserID, SessionID: *claimed.ExpectedSessionID,
			Provider: provider, Action: *claimed.Action,
			TokenHash: auth.SHA256Bytes(raw), ExpiresAt: timestamptz(receiptDeadline),
		}); err != nil {
			return "provider_error", "", time.Time{}, err
		}
		if _, err := q.CompleteOAuthTransaction(ctx, gen.CompleteOAuthTransactionParams{ID: claimed.ID, ConsumedAt: timestamptz(now)}); err != nil {
			return "provider_error", "", time.Time{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return "provider_error", "", time.Time{}, err
		}
		return "reauth_ready", enc, receiptDeadline, nil
	default:
		return "invalid_flow", "", time.Time{}, nil
	}
}

func (s *Service) Complete(ctx context.Context, binding, ip, ua string) (auth.Me, auth.IssueResult, error) {
	bindRaw, err := auth.ParseOpaqueToken(binding)
	if err != nil {
		return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
	}
	row, err := s.q.GetLatestOAuthTxByBinding(ctx, auth.SHA256Bytes(bindRaw))
	if err != nil {
		return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
	}
	now := s.clk.Now()
	if row.Mode != "login" || row.Status != "ready" || row.ConsumedAt.Valid {
		return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
	}
	if !row.CompletionDeadline.Valid || !row.CompletionDeadline.Time.After(now) || !row.ExpiresAt.Time.After(now) {
		return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
	}
	if row.IdentityProvider == nil || row.IdentityProviderUid == nil || row.IdentityEmail == nil {
		return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
	}
	provider, uid := *row.IdentityProvider, *row.IdentityProviderUid

	ident, identErr := s.q.GetIdentityByProviderUID(ctx, gen.GetIdentityByProviderUIDParams{Provider: provider, ProviderUid: &uid})
	if identErr != nil && !errors.Is(identErr, pgx.ErrNoRows) {
		return auth.Me{}, auth.IssueResult{}, identErr
	}
	if fn := s.getOnOwnerDiscovered(); fn != nil {
		fn()
	}

	if identErr == nil {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return auth.Me{}, auth.IssueResult{}, err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		q := s.q.WithTx(tx)
		uLocked, err := q.GetUserByIDForUpdate(ctx, ident.UserID)
		if err != nil {
			return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
		}
		identNow, err := q.GetIdentityByProviderUID(ctx, gen.GetIdentityByProviderUIDParams{Provider: provider, ProviderUid: &uid})
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
			}
			return auth.Me{}, auth.IssueResult{}, err
		}
		if identNow.UserID != uLocked.ID {
			return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
		}
		locked, err := q.GetOAuthTxByIDForUpdate(ctx, row.ID)
		if err != nil {
			return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
		}
		now = s.clk.Now()
		if locked.Mode != "login" || locked.Status != "ready" || locked.ConsumedAt.Valid {
			return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
		}
		if !locked.CompletionDeadline.Valid || !locked.CompletionDeadline.Time.After(now) || !locked.ExpiresAt.Time.After(now) {
			return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
		}
		if locked.IdentityProvider == nil || locked.IdentityProviderUid == nil || *locked.IdentityProvider != provider || *locked.IdentityProviderUid != uid {
			return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
		}
		issued, err := s.sessions.Issue(ctx, tx, auth.IssueParams{UserID: uLocked.ID, IPHash: auth.HashIP(s.cfg.AuthIPPepper, ip), UserAgent: ua})
		if err != nil {
			return auth.Me{}, auth.IssueResult{}, err
		}
		if _, err := q.CompleteOAuthTransaction(ctx, gen.CompleteOAuthTransactionParams{ID: locked.ID, ConsumedAt: timestamptz(now)}); err != nil {
			return auth.Me{}, auth.IssueResult{}, err
		}
		uidu, sid := uLocked.ID, issued.Principal.SessionID
		if s.audit != nil {
			if err := s.audit.Record(ctx, tx, secevent.Record{
				UserID: &uidu, SessionID: &sid, Event: secevent.EventOAuthLogin, Result: secevent.ResultSuccess,
				Actor: "user", Meta: secevent.Meta{Provider: provider},
			}); err != nil {
				return auth.Me{}, auth.IssueResult{}, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return auth.Me{}, auth.IssueResult{}, err
		}
		return auth.Me{}, issued, nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return auth.Me{}, auth.IssueResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	locked, err := q.GetOAuthTxByIDForUpdate(ctx, row.ID)
	if err != nil || locked.Status != "ready" || locked.ConsumedAt.Valid {
		return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
	}
	now = s.clk.Now()
	if !locked.CompletionDeadline.Valid || !locked.CompletionDeadline.Time.After(now) || !locked.ExpiresAt.Time.After(now) {
		return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
	}
	if locked.IdentityProvider == nil || locked.IdentityProviderUid == nil || locked.IdentityEmail == nil {
		return auth.Me{}, auth.IssueResult{}, auth.ErrOAuthStateInvalid
	}
	provider, uid, email := *locked.IdentityProvider, *locked.IdentityProviderUid, *locked.IdentityEmail
	if _, err := q.GetIdentityByProviderUID(ctx, gen.GetIdentityByProviderUIDParams{Provider: provider, ProviderUid: &uid}); err == nil {
		return auth.Me{}, auth.IssueResult{}, auth.ErrIdentityConflict
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return auth.Me{}, auth.IssueResult{}, err
	}
	if _, err := q.GetUserByEmail(ctx, email); err == nil {
		return auth.Me{}, auth.IssueResult{}, auth.ErrEmailTaken
	}
	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: email, Locale: "en"})
	if err != nil {
		if authUnique(err) {
			return auth.Me{}, auth.IssueResult{}, auth.ErrEmailTaken
		}
		return auth.Me{}, auth.IssueResult{}, err
	}
	if _, err := q.UpdateUserEmailVerified(ctx, gen.UpdateUserEmailVerifiedParams{ID: u.ID, EmailVerifiedAt: timestamptz(now)}); err != nil {
		return auth.Me{}, auth.IssueResult{}, err
	}
	if _, err := q.InsertOAuthIdentity(ctx, gen.InsertOAuthIdentityParams{UserID: u.ID, Provider: provider, ProviderUid: &uid}); err != nil {
		if authUnique(err) {
			return auth.Me{}, auth.IssueResult{}, auth.ErrIdentityConflict
		}
		return auth.Me{}, auth.IssueResult{}, err
	}
	userID := u.ID
	issued, err := s.sessions.Issue(ctx, tx, auth.IssueParams{UserID: userID, IPHash: auth.HashIP(s.cfg.AuthIPPepper, ip), UserAgent: ua})
	if err != nil {
		return auth.Me{}, auth.IssueResult{}, err
	}
	if _, err := q.CompleteOAuthTransaction(ctx, gen.CompleteOAuthTransactionParams{ID: locked.ID, ConsumedAt: timestamptz(now)}); err != nil {
		return auth.Me{}, auth.IssueResult{}, err
	}
	uidu, sid := userID, issued.Principal.SessionID
	if s.audit != nil {
		if err := s.audit.Record(ctx, tx, secevent.Record{
			UserID: &uidu, SessionID: &sid, Event: secevent.EventOAuthLogin, Result: secevent.ResultSuccess,
			Actor: "user", Meta: secevent.Meta{Provider: provider},
		}); err != nil {
			return auth.Me{}, auth.IssueResult{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return auth.Me{}, auth.IssueResult{}, err
	}
	return auth.Me{}, issued, nil
}

func (s *Service) ConsumeReceipt(ctx context.Context, p authctx.Principal, provider, action, receipt string) error {
	raw, err := auth.ParseOpaqueToken(receipt)
	if err != nil {
		return auth.ErrReauthInvalid
	}
	// The generated query only has a locking lookup. Read once to discover the
	// owning keys, then acquire user -> session -> receipt locks in the write tx.
	if _, err := s.q.GetReceiptByHashForUpdate(ctx, auth.SHA256Bytes(raw)); err != nil {
		return auth.ErrReauthInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	if _, err := q.GetUserByIDForUpdate(ctx, p.UserID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return auth.ErrReauthInvalid
		}
		return err
	}
	if err := s.sessions.EnsureLiveTx(ctx, q, p); err != nil {
		return err
	}
	row, err := q.GetReceiptByHashForUpdate(ctx, auth.SHA256Bytes(raw))
	if err != nil {
		return auth.ErrReauthInvalid
	}
	now := s.clk.Now()
	if row.UserID != p.UserID || row.SessionID != p.SessionID || row.Provider != provider || row.Action != action || row.ConsumedAt.Valid || !row.ExpiresAt.Time.After(now) {
		return auth.ErrReauthInvalid
	}
	if _, err := q.ConsumeReceipt(ctx, gen.ConsumeReceiptParams{ID: row.ID, ConsumedAt: timestamptz(now)}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func timestamptz(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t.UTC(), Valid: true}
}

func boolPtr(v bool) *bool { return &v }

func subtleBytes(a, b []byte) int {
	if len(a) != len(b) {
		return 0
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	if v == 0 {
		return 1
	}
	return 0
}

func authUnique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
