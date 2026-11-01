package auth_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
)

func TestSessionRefreshReuseRevokes(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	tokens := auth.NewTokenIssuer(bytes32(1), "http://localhost:3000", "http://localhost:3000", clk)
	store := auth.NewSessionStore(pool, tokens, clk)
	ctx := context.Background()
	u, err := gen.New(pool).InsertUser(ctx, gen.InsertUserParams{Email: "s@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	issued, err := store.Issue(ctx, nil, auth.IssueParams{UserID: u.ID})
	if err != nil {
		t.Fatal(err)
	}
	csrfOK := func(authctx.Principal) error { return nil }
	first, err := store.Refresh(ctx, issued.Refresh, csrfOK)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Refresh(ctx, issued.Refresh, csrfOK)
	de, ok := auth.AsError(err)
	if !ok || de.Code != "session_invalid" || de.Reason != "revoked" {
		t.Fatalf("reuse phải revoke, err=%v", err)
	}
	if _, err := store.Authenticate(ctx, first.Access); err == nil {
		t.Fatal("access sau reuse không được còn sống")
	}
}

func TestSessionConcurrentRefreshOneWins(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	tokens := auth.NewTokenIssuer(bytes32(1), "http://localhost:3000", "http://localhost:3000", clk)
	store := auth.NewSessionStore(pool, tokens, clk)
	ctx := context.Background()
	u, err := gen.New(pool).InsertUser(ctx, gen.InsertUserParams{Email: "c@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	issued, err := store.Issue(ctx, nil, auth.IssueParams{UserID: u.ID})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	type res struct {
		err error
	}
	ch := make(chan res, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := store.Refresh(ctx, issued.Refresh, func(authctx.Principal) error { return nil })
			ch <- res{err: err}
		}()
	}
	wg.Wait()
	close(ch)
	var ok, fail int
	for r := range ch {
		if r.err == nil {
			ok++
			continue
		}
		fail++
	}
	if ok != 1 || fail != 1 {
		t.Fatalf("muốn 1 rotate + 1 fail, ok=%d fail=%d", ok, fail)
	}
}

func TestRefreshWrongCSRFDoesNotRevoke(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	tokens := auth.NewTokenIssuer(bytes32(1), "http://localhost:3000", "http://localhost:3000", clk)
	store := auth.NewSessionStore(pool, tokens, clk)
	ctx := context.Background()
	u, err := gen.New(pool).InsertUser(ctx, gen.InsertUserParams{Email: "csrf@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	issued, err := store.Issue(ctx, nil, auth.IssueParams{UserID: u.ID})
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.Refresh(ctx, issued.Refresh, func(authctx.Principal) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Refresh(ctx, issued.Refresh, func(authctx.Principal) error { return auth.ErrCSRFInvalid })
	if err != auth.ErrCSRFInvalid {
		t.Fatalf("muốn csrf_invalid, được %v", err)
	}
	if _, err := store.Authenticate(ctx, first.Access); err != nil {
		t.Fatal("CSRF sai không được revoke session")
	}
}

func TestAuthenticateRejectsRevoked(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	tokens := auth.NewTokenIssuer(bytes32(1), "http://localhost:3000", "http://localhost:3000", clk)
	store := auth.NewSessionStore(pool, tokens, clk)
	ctx := context.Background()
	u, err := gen.New(pool).InsertUser(ctx, gen.InsertUserParams{Email: "r@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	issued, err := store.Issue(ctx, nil, auth.IssueParams{UserID: u.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Authenticate(ctx, issued.Access); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Revoke(ctx, issued.Principal, issued.Principal.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Authenticate(ctx, issued.Access); err == nil {
		t.Fatal("JWT còn hạn không được vượt revoke")
	}
}
