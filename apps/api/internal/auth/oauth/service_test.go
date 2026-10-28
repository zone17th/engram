package oauth

import (
	"bytes"
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
)

type advancingProvider struct {
	fake    *Fake
	clk     *clock.Fixed
	advance bool
}

func (p *advancingProvider) Name() string         { return p.fake.Name() }
func (p *advancingProvider) SupportsReauth() bool { return p.fake.SupportsReauth() }
func (p *advancingProvider) AuthorizationURL(in AuthRequest) (string, error) {
	return p.fake.AuthorizationURL(in)
}

func (p *advancingProvider) Exchange(ctx context.Context, in ExchangeRequest) (Identity, error) {
	id, err := p.fake.Exchange(ctx, in)
	if p.advance {
		p.clk.Advance(9 * time.Minute)
	}
	return id, err
}

func TestCallbackReauthBindsSubjectAndClampsReceipt(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	cfg := &config.Config{AppOrigin: "http://localhost:3000"}
	tokens := auth.NewTokenIssuer(bytes.Repeat([]byte{1}, 32), cfg.AppOrigin, cfg.AppOrigin, clk)
	sessions := auth.NewSessionStore(pool, tokens, clk)
	fake := NewFake("google", true, Identity{
		Provider: "google", UID: "g-unlinked", Email: "victim@example.com", EmailVerified: true,
	})
	fake.Now = clk.Now
	provider := &advancingProvider{fake: fake, clk: clk}
	svc := NewService(cfg, pool, sessions, nil, clk, []Provider{provider})
	q := gen.New(pool)
	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "victim@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	issued, err := sessions.Issue(ctx, nil, auth.IssueParams{UserID: user.ID})
	if err != nil {
		t.Fatal(err)
	}
	principal := issued.Principal
	foreignUser, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "foreign@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertOAuthIdentity(ctx, gen.InsertOAuthIdentityParams{
		UserID: foreignUser.ID, Provider: "google", ProviderUid: stringPtr("g-foreign"),
	}); err != nil {
		t.Fatal(err)
	}

	status, receipt, _, err := callbackReauth(t, svc, principal, "g-unlinked", "victim@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if status != "reauth_unavailable" || receipt != "" {
		t.Fatalf("unlinked subject: status=%s receipt=%q", status, receipt)
	}

	status, receipt, _, err = callbackReauth(t, svc, principal, "g-foreign", "victim@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if status != "reauth_unavailable" || receipt != "" {
		t.Fatalf("foreign subject: status=%s receipt=%q", status, receipt)
	}

	if _, err := q.InsertOAuthIdentity(ctx, gen.InsertOAuthIdentityParams{
		UserID: user.ID, Provider: "google", ProviderUid: stringPtr("g-valid"),
	}); err != nil {
		t.Fatal(err)
	}
	provider.advance = true
	status, receipt, exp, err := callbackReauth(t, svc, principal, "g-valid", "victim@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if status != "reauth_ready" || receipt == "" {
		t.Fatalf("valid subject: status=%s receipt=%q", status, receipt)
	}
	wantExp := time.Date(2026, 9, 15, 12, 10, 0, 0, time.UTC)
	if !exp.Equal(wantExp) {
		t.Fatalf("receipt expiry = %s, want flow expiry %s", exp, wantExp)
	}
	if err := svc.ConsumeReceipt(ctx, principal, "google", "account.password_change", receipt); err != nil {
		t.Fatalf("consume receipt = %v", err)
	}
	if err := svc.ConsumeReceipt(ctx, principal, "google", "account.password_change", receipt); err != auth.ErrReauthInvalid {
		t.Fatalf("receipt replay = %v", err)
	}
}

func callbackReauth(t *testing.T, svc *Service, principal authctx.Principal, uid, email string) (string, string, time.Time, error) {
	t.Helper()
	fake, ok := svc.providers["google"].(*advancingProvider)
	if !ok {
		t.Fatal("google test provider missing")
	}
	fake.fake.Identity = Identity{Provider: "google", UID: uid, Email: email, EmailVerified: true}
	start, err := svc.StartReauth(context.Background(), principal, "google", "account.password_change", "")
	if err != nil {
		return "", "", time.Time{}, err
	}
	u, err := url.Parse(start.AuthorizationURL)
	if err != nil {
		return "", "", time.Time{}, err
	}
	state := u.Query().Get("state")
	if state == "" {
		t.Fatal("authorization URL missing state")
	}
	return svc.Callback(context.Background(), "google", "fake-"+state, state, start.Binding, "")
}

func stringPtr(v string) *string { return &v }
