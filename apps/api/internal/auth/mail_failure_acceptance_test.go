package auth_test

import (
	"bytes"
	"context"
	"errors"
	"net/url"
	"testing"
	"time"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/audit"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/notification"
)

type acceptanceRecordingMailer struct {
	fail  bool
	links []string
}

func (m *acceptanceRecordingMailer) Send(_ context.Context, _, _ string, link string) error {
	m.links = append(m.links, link)
	if m.fail {
		return errors.New("mail unavailable")
	}
	return nil
}

func mailFailureToken(t *testing.T, mailer *acceptanceRecordingMailer, index int) string {
	t.Helper()
	if index < 0 || index >= len(mailer.links) {
		t.Fatalf("mailer links = %d, want index %d", len(mailer.links), index)
	}
	u, err := url.Parse(mailer.links[index])
	if err != nil {
		t.Fatal("invalid mail link")
	}
	values, err := url.ParseQuery(u.Fragment)
	if err != nil || values.Get("token") == "" {
		t.Fatal("mail link missing token")
	}
	return values.Get("token")
}

func TestVerificationMailFailureRequiresResendAndInvalidatesOldToken(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	mailer := &acceptanceRecordingMailer{fail: true}
	cfg := &config.Config{
		AppOrigin:        "http://localhost:3000",
		AuthJWTSecret:    bytes.Repeat([]byte{1}, 32),
		AuthCSRFSecret:   bytes.Repeat([]byte{2}, 32),
		AuthReauthSecret: bytes.Repeat([]byte{3}, 32),
		AuthIPPepper:     bytes.Repeat([]byte{4}, 32),
		AuthEmailPepper:  bytes.Repeat([]byte{5}, 32),
	}
	tokens := auth.NewTokenIssuer(cfg.AuthJWTSecret, cfg.JWTIssuer(), cfg.JWTAudience(), clk)
	sessions := auth.NewSessionStore(pool, tokens, clk)
	csrf := auth.NewCSRF(cfg.AuthCSRFSecret, clk)
	grants := auth.NewGrants(cfg.AuthReauthSecret, clk)
	lockout := auth.NewLockout(pool, clk)
	aud := audit.NewStore(pool)
	sessions.SetAuditor(aud)
	notes := notification.NewStore(pool, nil)
	svc, err := auth.NewService(cfg, pool, sessions, csrf, tokens, grants, lockout, clk, aud, notes, nil, mailer, nil)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	_, issued, err := svc.Signup(ctx, auth.SignupInput{Email: "mail-fail@example.com", Password: "correcthorse"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SendVerifyCurrent(ctx, issued.Principal); err != auth.ErrMailDeliveryUnavailable {
		t.Fatalf("failed verification send = %v", err)
	}
	oldToken := mailFailureToken(t, mailer, 0)

	mailer.fail = false
	if err := svc.SendVerifyCurrent(ctx, issued.Principal); err != nil {
		t.Fatalf("resend verification = %v", err)
	}
	newToken := mailFailureToken(t, mailer, 1)
	if oldToken == newToken {
		t.Fatal("resend reused verification token")
	}
	if _, err := svc.ConfirmEmailToken(ctx, issued.Principal, oldToken); err != auth.ErrVerificationInvalid {
		t.Fatalf("old failed-delivery token = %v", err)
	}
	if _, err := svc.ConfirmEmailToken(ctx, issued.Principal, newToken); err != nil {
		t.Fatalf("new verification token = %v", err)
	}
}
