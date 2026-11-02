package httpx_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/httpx"
)

func TestTokenBucketBurst40Rate20(t *testing.T) {
	t0 := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(t0)
	bucket := httpx.NewSearchReadBucket(clk)

	u1 := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	u2 := uuid.MustParse("22222222-2222-4000-8000-000000000002")

	// 1. Burst 40 requests for u1 all succeed immediately.
	for i := 1; i <= 40; i++ {
		ok, retry := bucket.AllowUser(u1)
		if !ok || retry != 0 {
			t.Fatalf("u1 request %d: got ok=%v retry=%d, want ok=true retry=0", i, ok, retry)
		}
	}

	// 2. 41st request at the same instant is rejected with Retry-After = 1s
	// (deficit = 1.0 token at 20/s -> 50ms -> ceil(0.05) = 1s).
	if ok, retry := bucket.AllowUser(u1); ok || retry != 1 {
		t.Fatalf("u1 request 41 at +0ms: got ok=%v retry=%d, want ok=false retry=1", ok, retry)
	}

	// 3. Another user u2 has an independent bucket and is unaffected.
	if ok, retry := bucket.AllowUser(u2); !ok || retry != 0 {
		t.Fatalf("u2 request 1: got ok=%v retry=%d, want ok=true retry=0", ok, retry)
	}

	// 4. Advance 49ms (< 50ms needed for 1 token at 20/s): still denied, Retry-After = 1.
	clk.Advance(49 * time.Millisecond)
	if ok, retry := bucket.AllowUser(u1); ok || retry != 1 {
		t.Fatalf("u1 at +49ms: got ok=%v retry=%d, want ok=false retry=1", ok, retry)
	}

	// 5. Advance +1ms (total 50ms = 1.0 token refilled): 1 request allowed, next denied.
	clk.Advance(1 * time.Millisecond)
	if ok, retry := bucket.AllowUser(u1); !ok || retry != 0 {
		t.Fatalf("u1 at +50ms: got ok=%v retry=%d, want ok=true retry=0", ok, retry)
	}
	if ok, retry := bucket.AllowUser(u1); ok || retry != 1 {
		t.Fatalf("u1 second request at +50ms: got ok=%v retry=%d, want ok=false retry=1", ok, retry)
	}

	// 6. Advance 500ms (= 10 tokens refilled at 20/s): exactly 10 requests succeed.
	clk.Advance(500 * time.Millisecond)
	for i := 1; i <= 10; i++ {
		if ok, retry := bucket.AllowUser(u1); !ok || retry != 0 {
			t.Fatalf("u1 after +500ms req %d: got ok=%v retry=%d, want ok=true retry=0", i, ok, retry)
		}
	}
	if ok, retry := bucket.AllowUser(u1); ok || retry != 1 {
		t.Fatalf("u1 after +500ms req 11: got ok=%v retry=%d, want ok=false retry=1", ok, retry)
	}

	// 7. Advance 10s: tokens cap at capacity 40 (never accumulate beyond 40).
	clk.Advance(10 * time.Second)
	for i := 1; i <= 40; i++ {
		if ok, _ := bucket.AllowUser(u1); !ok {
			t.Fatalf("u1 after full refill req %d failed", i)
		}
	}
	if ok, retry := bucket.AllowUser(u1); ok || retry != 1 {
		t.Fatalf("u1 req 41 after full refill: got ok=%v retry=%d, want ok=false retry=1", ok, retry)
	}

	// 8. Retry-After rounding for slower refill rates (ceil to integer seconds, >= 1).
	slowBucket := httpx.NewTokenBucket(1, 0.4, clk) // 1 token per 2.5s
	if ok, _ := slowBucket.Allow("k"); !ok {
		t.Fatal("slowBucket first request must succeed")
	}
	if ok, retry := slowBucket.Allow("k"); ok || retry != 3 {
		t.Fatalf("slowBucket immediate retry: got ok=%v retry=%d, want ok=false retry=3 (ceil(2.5))", ok, retry)
	}
	clk.Advance(600 * time.Millisecond) // 0.24 tokens refilled, deficit 0.76 -> 1.9s -> ceil = 2
	if ok, retry := slowBucket.Allow("k"); ok || retry != 2 {
		t.Fatalf("slowBucket after 600ms: got ok=%v retry=%d, want ok=false retry=2", ok, retry)
	}

	// 9. Eviction cap: never exceeds maxKeys.
	const capKeys = 64
	capped := httpx.NewTokenBucketWithCap(40, 20, capKeys, clk)
	for i := range capKeys {
		if ok, _ := capped.Allow(fmt.Sprintf("u-%d", i)); !ok {
			t.Fatalf("seed key %d failed", i)
		}
	}
	if got := capped.Len(); got != capKeys {
		t.Fatalf("Len() = %d, want %d", got, capKeys)
	}
	// Advance 3s so all existing entries have refilled to capacity and get evicted on overflow.
	clk.Advance(3 * time.Second)
	if ok, _ := capped.Allow("u-overflow-after-refill"); !ok {
		t.Fatal("overflow request after refill failed")
	}
	if got := capped.Len(); got != 1 {
		t.Fatalf("Len() after full-bucket eviction = %d, want 1", got)
	}
	// Fill again without advancing clock and overflow: oldest entries are evicted so Len() <= capKeys.
	for i := range capKeys * 2 {
		clk.Advance(time.Microsecond)
		if ok, _ := capped.Allow(fmt.Sprintf("active-%d", i)); !ok {
			t.Fatalf("active key %d failed", i)
		}
		if got := capped.Len(); got > capKeys {
			t.Fatalf("Len() = %d exceeded cap %d", got, capKeys)
		}
	}

	// 10. HTTP middleware contract: blocked-at-auth costs no token; 429 writes Retry-After header and retry_after body.
	mwBucket := httpx.NewTokenBucket(1, 20, clk)
	authStub := &tokenBucketTestAuth{
		validToken: "valid-cookie",
		principal:  authctx.Principal{UserID: u1, SessionID: uuid.New()},
	}
	chain := httpx.RequireSession(authStub)(mwBucket.Middleware()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})))

	// Unauthenticated request fails at RequireSession with 401 and does NOT consume u1's token.
	unauthRec := httptest.NewRecorder()
	chain.ServeHTTP(unauthRec, httptest.NewRequest(http.MethodGet, "/api/v1/suggest", nil))
	if unauthRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", unauthRec.Code)
	}

	// First authenticated request consumes the single token and succeeds (200).
	authedReq1 := httptest.NewRequest(http.MethodGet, "/api/v1/suggest", nil)
	authedReq1.AddCookie(&http.Cookie{Name: "sabk_session", Value: "valid-cookie"})
	okRec := httptest.NewRecorder()
	chain.ServeHTTP(okRec, authedReq1)
	if okRec.Code != http.StatusOK {
		t.Fatalf("first authenticated status = %d, want 200", okRec.Code)
	}

	// Second authenticated request at the same instant hits 429 rate_limited with Retry-After: 1 and retry_after: 1.
	authedReq2 := httptest.NewRequest(http.MethodGet, "/api/v1/suggest", nil)
	authedReq2.AddCookie(&http.Cookie{Name: "sabk_session", Value: "valid-cookie"})
	rlRec := httptest.NewRecorder()
	chain.ServeHTTP(rlRec, authedReq2)
	if rlRec.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited status = %d, want 429", rlRec.Code)
	}
	if got := rlRec.Header().Get("Retry-After"); got != "1" {
		t.Fatalf("Retry-After header = %q, want \"1\"", got)
	}
	if got := rlRec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control header = %q, want \"no-store\"", got)
	}
	var prob httpx.Problem
	if err := json.Unmarshal(rlRec.Body.Bytes(), &prob); err != nil {
		t.Fatalf("unmarshal 429 problem: %v", err)
	}
	if prob.Code != "rate_limited" || prob.Status != http.StatusTooManyRequests {
		t.Fatalf("problem = %+v, want code=rate_limited status=429", prob)
	}
	if prob.RetryAfter == nil || *prob.RetryAfter != 1 {
		t.Fatalf("problem.RetryAfter = %v, want 1", prob.RetryAfter)
	}
}

type tokenBucketTestAuth struct {
	validToken string
	principal  authctx.Principal
}

func (a *tokenBucketTestAuth) Authenticate(_ context.Context, access string) (authctx.Principal, error) {
	if access == a.validToken {
		return a.principal, nil
	}
	return authctx.Principal{}, &httpx.AuthError{Code: "unauthenticated"}
}
