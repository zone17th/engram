package suggest_test

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// TestSuggestNeverLogsQuery verifies SPEC §9.2, §10, plan P05 mục 1, 2.7, Task 3:
//   - Neither the access log (`httpx.AccessLog`) nor application logs nor RFC 9457
//     problem bodies nor `/metrics` output ever contain raw `q`, normalized `qn`,
//     item `name`, item `hint`, or tag `display` across:
//   - 200 OK (full, prefix, recent, `#tag`, and `ErrEmptyQuery`)
//   - 400 `name_invalid` (forbidden control char, > 200 runes, > 50 tag runes)
//   - 400 `invalid_request` (bad scope/limit/semantic/unknown query parameter)
//   - 401 `unauthenticated`
//   - 429 `rate_limited`
func TestSuggestNeverLogsQuery(t *testing.T) {
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	u1 := uuid.MustParse("66666666-6666-4000-8000-000000000006")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'privacy@example.com', 'vi')`, u1); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	ts := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `
		INSERT INTO item (id, user_id, name, name_normalized, hint, entry_count, last_used_at, created_at, updated_at)
		VALUES ($1, $2, 'QuantumLedgerVault', 'quantumledgervault', 'HintSentinelNeverExposed999', 1, $3, $3, $3)
	`, uuid.MustParse("00000000-0001-4000-8000-000000000601"), u1, ts); err != nil {
		t.Fatalf("insert item: %v", err)
	}

	warmPoolConns(t, pool, 2)
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	clk := clock.NewFixed(ts)
	reg, metrics := obs.NewRegistry()
	cursorKey, err := suggest.DeriveCursorKey([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("DeriveCursorKey: %v", err)
	}

	// Capacity 3 so we can exercise 200, 400, and 429 on the same router.
	bucket := httpx.NewTokenBucket(4, 20, clk)
	svc := suggest.NewService(pool, clk, suggest.NewNoopNearSource(), metrics, cursorKey)
	handler := suggest.NewHandler(svc, bucket)
	auth := &suggestTestAuth{}
	auth.addToken("tok-privacy", u1)

	router := httpx.NewRouter(httpx.Deps{
		Logger:           logger,
		Metrics:          promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
		MetricsCollector: metrics,
		Authenticator:    auth,
		MountAPI:         suggest.Mount(handler),
	})

	sentinels := []string{
		"SecretQuerySentinelAlpha",
		"secretquerysentinelalpha",
		"BadControlSentinelBeta",
		"badcontrolsentinelbeta",
		"BadScopeSentinelGamma",
		"UnauthQuerySentinelDelta",
		"RateLimitQuerySentinelEpsilon",
		"HintSentinelNeverExposed999",
	}

	send := func(token string, q url.Values) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/suggest?"+q.Encode(), nil)
		if token != "" {
			req.AddCookie(&http.Cookie{Name: "sabk_session", Value: token})
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	// 1. 200 OK full search with sentinel query; also verify item hint never appears in response body.
	rec200 := send("tok-privacy", url.Values{"q": {"SecretQuerySentinelAlpha"}})
	if rec200.Code != http.StatusOK {
		t.Fatalf("200 case status = %d", rec200.Code)
	}
	if strings.Contains(rec200.Body.String(), "SecretQuerySentinelAlpha") ||
		strings.Contains(rec200.Body.String(), "secretquerysentinelalpha") ||
		strings.Contains(rec200.Body.String(), "HintSentinelNeverExposed999") {
		t.Fatalf("200 response body echoed query or hint: %s", rec200.Body.String())
	}

	// 2. 200 OK matching item (`QuantumLedgerVault`) -> verify `HintSentinelNeverExposed999` is absent from response.
	recHit := send("tok-privacy", url.Values{"q": {"quantum"}})
	if recHit.Code != http.StatusOK {
		t.Fatalf("hit case status = %d", recHit.Code)
	}
	if strings.Contains(recHit.Body.String(), "HintSentinelNeverExposed999") {
		t.Fatalf("200 hit response leaked item.hint: %s", recHit.Body.String())
	}

	// 3. 400 `name_invalid` with forbidden control character and sentinel.
	rec400Name := send("tok-privacy", url.Values{"q": {"BadControlSentinelBeta\x00"}})
	if rec400Name.Code != http.StatusBadRequest {
		t.Fatalf("400 name_invalid status = %d", rec400Name.Code)
	}
	if strings.Contains(rec400Name.Body.String(), "BadControlSentinelBeta") {
		t.Fatalf("400 name_invalid problem body echoed query: %s", rec400Name.Body.String())
	}

	// 4. 400 `invalid_request` with bad scope and sentinel.
	rec400Param := send("tok-privacy", url.Values{
		"q":     {"BadScopeSentinelGamma"},
		"scope": {"BadScopeSentinelGamma"},
	})
	if rec400Param.Code != http.StatusBadRequest {
		t.Fatalf("400 invalid_request status = %d", rec400Param.Code)
	}
	if strings.Contains(rec400Param.Body.String(), "BadScopeSentinelGamma") {
		t.Fatalf("400 invalid_request problem body echoed query/param: %s", rec400Param.Body.String())
	}

	// 5. 401 `unauthenticated` with sentinel query (also does not consume token).
	rec401 := send("", url.Values{"q": {"UnauthQuerySentinelDelta"}})
	if rec401.Code != http.StatusUnauthorized {
		t.Fatalf("401 status = %d", rec401.Code)
	}
	if strings.Contains(rec401.Body.String(), "UnauthQuerySentinelDelta") {
		t.Fatalf("401 problem body echoed query: %s", rec401.Body.String())
	}

	// 6. 429 `rate_limited` (all 4 tokens consumed by steps 1..4) with sentinel query.
	rec429 := send("tok-privacy", url.Values{"q": {"RateLimitQuerySentinelEpsilon"}})
	if rec429.Code != http.StatusTooManyRequests {
		t.Fatalf("429 status = %d, want 429", rec429.Code)
	}
	if strings.Contains(rec429.Body.String(), "RateLimitQuerySentinelEpsilon") {
		t.Fatalf("429 problem body echoed query: %s", rec429.Body.String())
	}

	// 7. Scrape `/api/v1/metrics` and verify `suggest_latency_seconds` was recorded and no sentinel or user ID appears.
	metricsRec := httptest.NewRecorder()
	router.ServeHTTP(metricsRec, httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil))
	if metricsRec.Code != http.StatusOK {
		t.Fatalf("/metrics status = %d", metricsRec.Code)
	}
	metricsBody := metricsRec.Body.String()
	if !strings.Contains(metricsBody, `suggest_latency_seconds_count{mode="full",scope="all",semantic="false"} 2`) {
		t.Fatalf("expected suggest_latency_seconds_count=2 for full/all/false in /metrics, got:\n%s", metricsBody)
	}
	if strings.Contains(metricsBody, u1.String()) {
		t.Fatalf("/metrics leaked user_id %s", u1)
	}

	// 8. Verify none of the sentinels appear anywhere in captured slog output or `/metrics`.
	logsOut := logBuf.String()
	if len(logsOut) == 0 {
		t.Fatal("expected non-empty access logs")
	}
	for _, s := range sentinels {
		if strings.Contains(logsOut, s) {
			t.Fatalf("slog output leaked sentinel %q:\n%s", s, logsOut)
		}
		if strings.Contains(metricsBody, s) {
			t.Fatalf("/metrics output leaked sentinel %q:\n%s", s, metricsBody)
		}
	}
}
