package auth_test

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
)

func TestGrantIssueVerifyAndExpiry(t *testing.T) {
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	g := auth.NewGrants(bytes32(3), clk)
	p := authctx.Principal{UserID: uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), SessionID: uuid.MustParse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")}
	got, err := g.Issue(p, "account.password_change")
	if err != nil {
		t.Fatal(err)
	}
	if err := g.Verify(p, "account.password_change", got.Grant); err != nil {
		t.Fatal(err)
	}
	if err := g.Verify(p, "account.email_change", got.Grant); err != auth.ErrReauthInvalid {
		t.Fatalf("sai action: %v", err)
	}
	q := p
	q.SessionID = uuid.MustParse("cccccccc-cccc-cccc-cccc-cccccccccccc")
	if err := g.Verify(q, "account.password_change", got.Grant); err != auth.ErrReauthInvalid {
		t.Fatalf("sai session: %v", err)
	}
	clk.Advance(5 * time.Minute)
	if err := g.Verify(p, "account.password_change", got.Grant); err != auth.ErrReauthInvalid {
		t.Fatalf("now=exp phải hết hạn: %v", err)
	}
}

func TestGrantRejectsUnknownAction(t *testing.T) {
	g := auth.NewGrants(bytes32(3), nil)
	p := authctx.Principal{UserID: uuid.New(), SessionID: uuid.New()}
	if _, err := g.Issue(p, "not.an.action"); err != auth.ErrInvalidRequest {
		t.Fatalf("err=%v", err)
	}
}
