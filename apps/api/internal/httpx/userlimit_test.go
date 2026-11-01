package httpx_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
)

func seedRateLimitUser(t *testing.T, pool *pgxpool.Pool, email string) (uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	var userID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email, locale) VALUES ($1, 'en') RETURNING id`, email).Scan(&userID); err != nil {
		t.Fatalf("seed user %s: %v", email, err)
	}
	return userID, uuid.New()
}

func seedVaultAndRecoveryKeys(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID, vaultKeyID string, rkCount int) {
	t.Helper()
	ctx := context.Background()
	q := gen.New(pool)
	if _, err := q.InsertVault(ctx, gen.InsertVaultParams{
		UserID:               userID,
		Kdf:                  []byte(`{"alg":"argon2id","m_kib":65536,"t":3,"p":4,"salt":"AAAAAAAAAAAAAAAAAAAAAA=="}`),
		VaultKeyID:           vaultKeyID,
		VaultKeyWrappedByKek: bytes.Repeat([]byte{0x11}, 60),
		X25519Public:         bytes.Repeat([]byte{0x22}, 32),
		Ed25519Public:        bytes.Repeat([]byte{0x33}, 32),
		PrivateKeysWrapped:   bytes.Repeat([]byte{0x44}, 92),
	}); err != nil {
		t.Fatalf("InsertVault(%s): %v", userID, err)
	}
	for slot := 1; slot <= rkCount; slot++ {
		hash := make([]byte, 32)
		copy(hash, userID[:])
		hash[16] = byte(slot)
		if _, err := q.InsertRecoveryKey(ctx, gen.InsertRecoveryKeyParams{
			UserID:     userID,
			Slot:       int32(slot),
			LookupHash: hash,
			Wrap:       bytes.Repeat([]byte{byte(slot)}, 60),
		}); err != nil {
			t.Fatalf("InsertRecoveryKey(%s, slot=%d): %v", userID, slot, err)
		}
	}
}

func countRateEvents(t *testing.T, pool *pgxpool.Pool, scope string, userID uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM rate_event WHERE scope = $1 AND user_id = $2`, scope, userID).Scan(&n); err != nil {
		t.Fatalf("count rate_event: %v", err)
	}
	return n
}

func decodeProblem(t *testing.T, rec *httptest.ResponseRecorder) httpx.Problem {
	t.Helper()
	var p httpx.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode problem (%s): %v", rec.Body.String(), err)
	}
	return p
}

// Bullet 1: lần 6 trong 15 phút bị chặn kể cả đổi IP; Retry-After present và sane;
// message không lộ số RK còn lại.
func TestUserLimit_SixthIn15MinBlockedEvenWithChangedIP(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)

	userID, sessID := seedRateLimitUser(t, pool, "sixth-ip@example.com")
	principal := authctx.Principal{UserID: userID, SessionID: sessID}
	baseNow := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(baseNow)
	limiter := httpx.NewUserLimiter(pool, clk)

	r := chi.NewRouter()
	r.Use(httpx.RequireSession(stubAuth{p: principal}))
	r.With(limiter.Middleware(httpx.ScopeVaultRecoveryLookup)).Post("/vault/unlock/recovery", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"recovery_key_id":"11111111-1111-1111-1111-111111111111","wrap":"AA"}`))
	})

	ips := []string{
		"203.0.113.1:1001",
		"203.0.113.2:1002",
		"198.51.100.10:2001",
		"198.51.100.20:2002",
		"192.0.2.55:3001",
		"192.0.2.99:4001", // request thứ 6 từ IP hoàn toàn mới
	}

	for i := range 5 {
		req := httptest.NewRequest(http.MethodPost, "/vault/unlock/recovery", strings.NewReader(`{"lookup_hash":"AA"}`))
		req.RemoteAddr = ips[i]
		req.Header.Set("X-Forwarded-For", strings.Split(ips[i], ":")[0])
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d (IP %s) phải được phép, got status %d: %s", i+1, ips[i], rec.Code, rec.Body.String())
		}
	}

	// Dịch 30 giây nhưng vẫn trong cửa sổ 15 phút, đổi sang IP thứ 6.
	clk.Advance(30 * time.Second)
	req6 := httptest.NewRequest(http.MethodPost, "/vault/unlock/recovery", strings.NewReader(`{"lookup_hash":"AA"}`))
	req6.RemoteAddr = ips[5]
	req6.Header.Set("X-Forwarded-For", "192.0.2.99")
	req6.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
	rec6 := httptest.NewRecorder()
	r.ServeHTTP(rec6, req6)

	if rec6.Code != http.StatusTooManyRequests {
		t.Fatalf("request 6 với IP mới phải bị chặn 429, got %d: %s", rec6.Code, rec6.Body.String())
	}
	retryHeader := rec6.Header().Get("Retry-After")
	if retryHeader == "" {
		t.Fatal("429 phải có header Retry-After")
	}
	retrySec, err := strconv.Atoi(retryHeader)
	if err != nil || retrySec != 870 {
		t.Fatalf("Retry-After = %q (parsed %d, err %v), muốn 870s (15m - 30s)", retryHeader, retrySec, err)
	}
	prob := decodeProblem(t, rec6)
	if prob.Code != "rate_limited" {
		t.Fatalf("problem.code = %q, muốn rate_limited", prob.Code)
	}
	if prob.RetryAfter == nil || *prob.RetryAfter != retrySec {
		t.Fatalf("problem.retry_after = %v, muốn %d", prob.RetryAfter, retrySec)
	}
	if got := countRateEvents(t, pool, httpx.ScopeVaultRecoveryLookup, userID); got != 5 {
		t.Fatalf("số rate_event = %d, muốn 5 (request bị chặn không được ghi thêm)", got)
	}
}

// Bullet 2: 5 request ở phút 14 rồi 5 request ở phút 16 → cả 5 request sau bị chặn (cửa sổ trượt).
func TestUserLimit_SlidingWindowFiveAtMin14ThenFiveAtMin16AllBlocked(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)

	userID, sessID := seedRateLimitUser(t, pool, "sliding@example.com")
	principal := authctx.Principal{UserID: userID, SessionID: sessID}
	t0 := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(t0)
	limiter := httpx.NewUserLimiter(pool, clk)

	r := chi.NewRouter()
	r.Use(httpx.RequireSession(stubAuth{p: principal}))
	r.With(limiter.Middleware(httpx.ScopeVaultRecoveryLookup)).Post("/vault/unlock/recovery", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	send := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/vault/unlock/recovery", nil)
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	// Phút 14: gửi 5 request (tất cả qua). Nếu là fixed window 15 phút thì phút 15 sẽ reset,
	// nhưng với sliding window 15 phút thì ở phút 16 cả 5 sự kiện lúc phút 14 mới cách 2 phút (< 15 phút).
	clk.Set(t0.Add(14 * time.Minute))
	for i := range 5 {
		rec := send()
		if rec.Code != http.StatusOK {
			t.Fatalf("min 14 request %d phải 200, got %d", i+1, rec.Code)
		}
	}

	// Phút 16: gửi tiếp 5 request -> cả 5 đều phải bị chặn 429.
	clk.Set(t0.Add(16 * time.Minute))
	for i := range 5 {
		rec := send()
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("min 16 request %d phải bị chặn 429 (cửa sổ trượt), got %d", i+1, rec.Code)
		}
		p := decodeProblem(t, rec)
		if p.Code != "rate_limited" {
			t.Fatalf("min 16 request %d code = %q, muốn rate_limited", i+1, p.Code)
		}
		// Tại phút 16, sự kiện cũ nhất ở phút 14 còn 13 phút (780s) mới hết cửa sổ 15 phút.
		if p.RetryAfter == nil || *p.RetryAfter != 13*60 {
			t.Fatalf("min 16 request %d retry_after = %v, muốn 780", i+1, p.RetryAfter)
		}
	}

	// Chỉ 5 sự kiện ở phút 14 được lưu trong bảng.
	if got := countRateEvents(t, pool, httpx.ScopeVaultRecoveryLookup, userID); got != 5 {
		t.Fatalf("rate_event count = %d, muốn 5", got)
	}
}

// Bullet 3: request trúng (200 OK) cũng bị đếm, không chỉ request trượt (401), để không thành oracle.
func TestUserLimit_HitsCountedTowardQuota(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)

	userID, sessID := seedRateLimitUser(t, pool, "hits@example.com")
	principal := authctx.Principal{UserID: userID, SessionID: sessID}
	clk := clock.NewFixed(time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC))
	limiter := httpx.NewUserLimiter(pool, clk)

	r := chi.NewRouter()
	r.Use(httpx.RequireSession(stubAuth{p: principal}))
	r.With(limiter.Middleware(httpx.ScopeVaultRecoveryLookup)).Post("/vault/unlock/recovery", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test-Hit") == "1" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"recovery_key_id":"11111111-1111-1111-1111-111111111111","wrap":"AA"}`))
			return
		}
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "recovery_key_invalid", httpx.ProblemTitle("recovery_key_invalid")+".")
	})

	// Gửi 5 request đều TRÚNG (200 OK).
	for i := range 5 {
		req := httptest.NewRequest(http.MethodPost, "/vault/unlock/recovery", nil)
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
		req.Header.Set("X-Test-Hit", "1")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("hit request %d phải 200, got %d", i+1, rec.Code)
		}
	}

	if got := countRateEvents(t, pool, httpx.ScopeVaultRecoveryLookup, userID); got != 5 {
		t.Fatalf("5 lần trúng phải ghi đủ 5 rate_event, got %d", got)
	}

	// Lần thứ 6 (kể cả khi gửi RK trúng) phải bị chặn 429 trước khi vào handler.
	req6 := httptest.NewRequest(http.MethodPost, "/vault/unlock/recovery", nil)
	req6.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
	req6.Header.Set("X-Test-Hit", "1")
	rec6 := httptest.NewRecorder()
	r.ServeHTTP(rec6, req6)
	if rec6.Code != http.StatusTooManyRequests {
		t.Fatalf("lần 6 sau 5 lần trúng phải bị chặn 429, got %d", rec6.Code)
	}
}

// Bullet 4: request bị chặn không ghi thêm event và không kéo dài thời gian chặn.
func TestUserLimit_BlockedRequestsDoNotExtendBlockWindow(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)

	userID, sessID := seedRateLimitUser(t, pool, "no-extend@example.com")
	principal := authctx.Principal{UserID: userID, SessionID: sessID}
	t0 := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(t0)
	limiter := httpx.NewUserLimiter(pool, clk)

	r := chi.NewRouter()
	r.Use(httpx.RequireSession(stubAuth{p: principal}))
	r.With(limiter.Middleware(httpx.ScopeVaultRecoveryLookup)).Post("/vault/unlock/recovery", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	send := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/vault/unlock/recovery", nil)
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	// 5 request tại t0.
	for i := range 5 {
		if rec := send(); rec.Code != http.StatusOK {
			t.Fatalf("t0 req %d = %d, muốn 200", i+1, rec.Code)
		}
	}

	// Tại t0 + 10m và t0 + 14m, gửi nhiều request bị chặn 429.
	clk.Set(t0.Add(10 * time.Minute))
	for i := range 3 {
		rec := send()
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("t0+10m req %d = %d, muốn 429", i+1, rec.Code)
		}
	}
	clk.Set(t0.Add(14 * time.Minute))
	for i := range 3 {
		rec := send()
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("t0+14m req %d = %d, muốn 429", i+1, rec.Code)
		}
		if got := rec.Header().Get("Retry-After"); got != "60" {
			t.Fatalf("t0+14m Retry-After = %q, muốn 60 (không bị kéo dài bởi lần chặn ở phút 10)", got)
		}
	}

	if got := countRateEvents(t, pool, httpx.ScopeVaultRecoveryLookup, userID); got != 5 {
		t.Fatalf("blocked requests không được ghi thêm rate_event, got %d", got)
	}

	// Đúng tại t0 + 15m (vì điều kiện cửa sổ trượt là at > now - 15m, nên các sự kiện tại t0 đã trượt ra ngoài),
	// request mới phải được phép qua ngay mà không bị các request bị chặn ở phút 10/14 giữ chân.
	clk.Set(t0.Add(15 * time.Minute))
	recAfter := send()
	if recAfter.Code != http.StatusOK {
		t.Fatalf("t0+15m request phải qua (200) vì các lần bị chặn không kéo dài cửa sổ, got %d: %s", recAfter.Code, recAfter.Body.String())
	}
}

// Bullet 5: vault_recovery_lookup và vault_recovery_complete đếm ở hai bucket riêng biệt.
func TestUserLimit_LookupAndCompleteCountedSeparately(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)

	userID, sessID := seedRateLimitUser(t, pool, "separate-buckets@example.com")
	principal := authctx.Principal{UserID: userID, SessionID: sessID}
	clk := clock.NewFixed(time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC))
	limiter := httpx.NewUserLimiter(pool, clk)

	r := chi.NewRouter()
	r.Use(httpx.RequireSession(stubAuth{p: principal}))
	r.With(limiter.Middleware(httpx.ScopeVaultRecoveryLookup)).Post("/vault/unlock/recovery", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	r.With(limiter.Middleware(httpx.ScopeVaultRecoveryComplete)).Post("/vault/recover/complete", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	post := func(path string) int {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Code
	}

	// Dùng cạn cả 5 lượt của lookup (ví dụ 4 lần trượt + lần thứ 5 trúng).
	for i := range 5 {
		if code := post("/vault/unlock/recovery"); code != http.StatusOK {
			t.Fatalf("lookup %d = %d, muốn 200", i+1, code)
		}
	}
	if code := post("/vault/unlock/recovery"); code != http.StatusTooManyRequests {
		t.Fatalf("lookup 6 = %d, muốn 429", code)
	}

	// Ngay lúc lookup đã kịch trần, complete vẫn có đủ 5 lượt riêng để hoàn tất khôi phục.
	for i := range 5 {
		if code := post("/vault/recover/complete"); code != http.StatusOK {
			t.Fatalf("complete %d = %d, muốn 200 (bucket riêng khỏi lookup)", i+1, code)
		}
	}
	if code := post("/vault/recover/complete"); code != http.StatusTooManyRequests {
		t.Fatalf("complete 6 = %d, muốn 429", code)
	}
}

// Bullet 6 (BE1-15): trên chuỗi middleware PRODUCTION (ChainIdempotencyMiddleware với UserLimiter
// PostgreSQL thật, Idempotency lookup/claim thật, auth.Grants thật và clock giả):
// - replay idempotent ở bước 2 không đi qua rate limit và ghi 0 rate_event;
// - request thiếu grant hoặc grant sai/hết hạn với Idempotency-Key mới bị từ chối ở bước 3 và ghi 0 rate_event;
// - sau đó user vẫn còn nguyên đủ toàn bộ quota hợp lệ (5 lượt).
func TestUserLimit_IdempotentReplayAndMissingGrantNotCounted(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)

	userID, sessID := seedRateLimitUser(t, pool, "order-prod-chain@example.com")
	principal := authctx.Principal{UserID: userID, SessionID: sessID}
	t0 := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(t0)

	limiter := httpx.NewUserLimiter(pool, clk)
	idem := httpx.NewIdempotency(pool, clk)
	grants := auth.NewGrants(bytes.Repeat([]byte{0x5A}, 32), clk)

	var handlerCalls atomic.Int32
	r := chi.NewRouter()
	h := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:     testAppOrigin,
		Authenticator: stubAuth{p: principal},
		CSRF:          strictCSRF{},
		Idempotency:   idem,
		Reauth:        grantsReauthAdapter{g: grants},
		ReauthAction:  "vault.recover",
		RateLimit:     limiter.Middleware(httpx.ScopeVaultRecoveryComplete),
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := handlerCalls.Add(1)
		tx, err := httpx.BeginMutationTx(r.Context(), pool)
		if err != nil {
			t.Fatalf("BeginMutationTx: %v", err)
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		resp := []byte(fmt.Sprintf(`{"version":%d}`, n+1))
		if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusOK, resp); err != nil {
			t.Fatalf("CommitIdempotencyTx: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}))
	r.Method(http.MethodPost, "/api/v1/vault/recover/complete", h)

	sendProd := func(idemKey, reauthToken, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/vault/recover/complete", strings.NewReader(body))
		req.Header.Set("Origin", testAppOrigin)
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
		req.AddCookie(&http.Cookie{Name: "sabk_csrf", Value: "csrf-ok"})
		req.Header.Set("X-CSRF-Token", "csrf-ok")
		req.Header.Set("Idempotency-Key", idemKey)
		if reauthToken != "" {
			req.Header.Set("X-Reauth-Token", reauthToken)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	// 1) Gửi 10 request thiếu grant và 10 request grant không hợp lệ với Idempotency-Key hoàn toàn mới:
	// tất cả bị chặn 401 ở bước 3 (RequireReauth) và ghi 0 rate_event.
	for i := range 10 {
		recMissing := sendProd(fmt.Sprintf("idem-missing-grant-%04d", i), "", `{"slot":1}`)
		if recMissing.Code != http.StatusUnauthorized {
			t.Fatalf("missing grant %d = %d, muốn 401: %s", i+1, recMissing.Code, recMissing.Body.String())
		}
		if p := decodeProblem(t, recMissing); p.Code != "reauth_required" {
			t.Fatalf("missing grant %d code = %q, muốn reauth_required", i+1, p.Code)
		}

		recInvalid := sendProd(fmt.Sprintf("idem-invalid-grant-%04d", i), "invalid-or-expired-grant", `{"slot":1}`)
		if recInvalid.Code != http.StatusUnauthorized {
			t.Fatalf("invalid grant %d = %d, muốn 401: %s", i+1, recInvalid.Code, recInvalid.Body.String())
		}
		if p := decodeProblem(t, recInvalid); p.Code != "reauth_invalid" {
			t.Fatalf("invalid grant %d code = %q, muốn reauth_invalid", i+1, p.Code)
		}
	}
	if got := countRateEvents(t, pool, httpx.ScopeVaultRecoveryComplete, userID); got != 0 {
		t.Fatalf("request thiếu/sai grant trên production chain không được ghi rate_event, got %d", got)
	}

	// 2) Seed 1 bản ghi idempotency đã hoàn tất ('done') trong bảng idempotency_key của PostgreSQL
	// thông qua chính queries chuẩn (ClaimIdempotencyKey + FinishIdempotencyKey) để chưa tốn bất kỳ rate_event nào,
	// rồi bắn 10 request replay liên tiếp qua chuỗi production (cả khi thiếu grant hoặc gửi grant đã hết hạn):
	// bước 2 (Idempotency.Lookup) phải trả ngay kết quả gốc và ghi 0 rate_event.
	const replayKey = "idem-already-done-prod-0001"
	const replayPath = "/api/v1/vault/recover/complete"
	const replayBody = `{"slot":1,"wrap":"AA"}`
	ownerTok := uuid.New()
	q := gen.New(pool)
	if _, err := q.ClaimIdempotencyKey(context.Background(), gen.ClaimIdempotencyKeyParams{
		UserID:      userID,
		Key:         replayKey,
		Method:      http.MethodPost,
		Path:        replayPath,
		RequestHash: httpx.ComputeIdempotencyFingerprint(http.MethodPost, replayPath, []byte(replayBody)),
		OwnerToken:  ownerTok,
		Now:         pgtype.Timestamptz{Time: t0, Valid: true},
	}); err != nil {
		t.Fatalf("ClaimIdempotencyKey seed: %v", err)
	}
	if rows, err := q.FinishIdempotencyKey(context.Background(), gen.FinishIdempotencyKeyParams{
		UserID:     userID,
		Key:        replayKey,
		OwnerToken: ownerTok,
		StatusCode: 200,
		Response:   []byte(`{"version":2}`),
	}); err != nil || rows != 1 {
		t.Fatalf("FinishIdempotencyKey seed: rows=%d err=%v", rows, err)
	}

	for i := range 10 {
		tok := ""
		if i%2 == 1 {
			tok = "expired-or-invalid-grant"
		}
		recReplay := sendProd(replayKey, tok, replayBody)
		if recReplay.Code != http.StatusOK || !jsonEqual(t, recReplay.Body.Bytes(), []byte(`{"version":2}`)) {
			t.Fatalf("replay %d = %d body=%s, muốn 200 {\"version\":2}", i+1, recReplay.Code, recReplay.Body.String())
		}
	}
	if got := countRateEvents(t, pool, httpx.ScopeVaultRecoveryComplete, userID); got != 0 {
		t.Fatalf("idempotent replay trên production chain phải ghi 0 rate_event, got %d", got)
	}
	if handlerCalls.Load() != 0 {
		t.Fatalf("handlerCalls sau missing/invalid grants và replays = %d, muốn 0", handlerCalls.Load())
	}

	// 3) Sau toàn bộ 20 request thiếu/sai grant và 10 request replay (tổng 0 rate_event),
	// user vẫn còn nguyên vẹn đủ toàn bộ quota hợp lệ (5 lượt).
	validGrant, err := grants.Issue(principal, "vault.recover")
	if err != nil {
		t.Fatalf("Issue validGrant: %v", err)
	}
	for i := range 5 {
		recValid := sendProd(fmt.Sprintf("idem-fresh-valid-%04d", i), validGrant.Grant, fmt.Sprintf(`{"slot":%d}`, i+1))
		if recValid.Code != http.StatusOK {
			t.Fatalf("valid request %d = %d, muốn 200: %s", i+1, recValid.Code, recValid.Body.String())
		}
	}
	if got := countRateEvents(t, pool, httpx.ScopeVaultRecoveryComplete, userID); got != 5 {
		t.Fatalf("sau 5 request hợp lệ số rate_event = %d, muốn 5", got)
	}
	if handlerCalls.Load() != 5 {
		t.Fatalf("handlerCalls = %d, muốn 5", handlerCalls.Load())
	}

	// Request hợp lệ thứ 6 trong cùng cửa sổ bị chặn 429 ở bước 4 và không ghi thêm rate_event.
	rec6 := sendProd("idem-fresh-valid-0006", validGrant.Grant, `{"slot":6}`)
	if rec6.Code != http.StatusTooManyRequests {
		t.Fatalf("request thứ 6 phải bị chặn 429, got %d: %s", rec6.Code, rec6.Body.String())
	}
	if got := countRateEvents(t, pool, httpx.ScopeVaultRecoveryComplete, userID); got != 5 {
		t.Fatalf("số rate_event sau request thứ 6 bị chặn = %d, muốn 5", got)
	}
}

// Bullet 7: request thứ 21 trong 1 phút, chia giữa POST /vault/unlock/passkey/options
// và POST /vault/passkeys/register/options, bị chặn (chung bucket vault_passkey_options 20/phút).
func TestUserLimit_PasskeyOptionsSharedBucket21stBlocked(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)

	userID, sessID := seedRateLimitUser(t, pool, "passkey-options@example.com")
	principal := authctx.Principal{UserID: userID, SessionID: sessID}
	t0 := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(t0)
	limiter := httpx.NewUserLimiter(pool, clk)

	r := chi.NewRouter()
	r.Use(httpx.RequireSession(stubAuth{p: principal}))
	r.With(limiter.Middleware(httpx.ScopeVaultPasskeyOptions)).Post("/vault/unlock/passkey/options", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	r.With(limiter.Middleware(httpx.ScopeVaultPasskeyOptions)).Post("/vault/passkeys/register/options", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	post := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	// 12 request tới unlock/passkey/options + 8 request tới passkeys/register/options = 20 request trong 1 phút.
	for i := range 12 {
		if rec := post("/vault/unlock/passkey/options"); rec.Code != http.StatusOK {
			t.Fatalf("unlock options %d = %d, muốn 200", i+1, rec.Code)
		}
	}
	clk.Advance(15 * time.Second)
	for i := range 8 {
		if rec := post("/vault/passkeys/register/options"); rec.Code != http.StatusOK {
			t.Fatalf("register options %d = %d, muốn 200", i+1, rec.Code)
		}
	}

	// Request thứ 21 (trên bất kỳ route nào trong hai route) phải bị chặn 429.
	rec21Unlock := post("/vault/unlock/passkey/options")
	if rec21Unlock.Code != http.StatusTooManyRequests {
		t.Fatalf("request 21 (unlock options) phải 429, got %d", rec21Unlock.Code)
	}
	if got := rec21Unlock.Header().Get("Retry-After"); got != "45" {
		t.Fatalf("Retry-After = %q, muốn 45 (60s - 15s)", got)
	}

	rec21Reg := post("/vault/passkeys/register/options")
	if rec21Reg.Code != http.StatusTooManyRequests {
		t.Fatalf("request 21 (register options) phải 429, got %d", rec21Reg.Code)
	}
}

// Bullet 8: hai instance (hai UserLimiter trên hai pgxpool.Pool độc lập cùng trỏ một DB)
// chạy song song không bao giờ vượt ngưỡng nhờ pg_advisory_xact_lock.
func TestUserLimit_TwoInstancesParallelNeverExceedLimit(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	poolA := dbtest.Pool(t, dsn)
	poolB := dbtest.Pool(t, dsn)

	userID, sessID := seedRateLimitUser(t, poolA, "parallel-instances@example.com")
	principal := authctx.Principal{UserID: userID, SessionID: sessID}
	clk := clock.NewFixed(time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC))

	limiterA := httpx.NewUserLimiter(poolA, clk)
	limiterB := httpx.NewUserLimiter(poolB, clk)

	var handlerExecutions atomic.Int32
	buildServer := func(lim *httpx.UserLimiter) http.Handler {
		r := chi.NewRouter()
		r.Use(httpx.RequireSession(stubAuth{p: principal}))
		r.With(lim.Middleware(httpx.ScopeVaultRecoveryLookup)).Post("/vault/unlock/recovery", func(w http.ResponseWriter, r *http.Request) {
			handlerExecutions.Add(1)
			w.WriteHeader(http.StatusOK)
		})
		return r
	}
	srvA := buildServer(limiterA)
	srvB := buildServer(limiterB)

	const totalRequests = 24
	var (
		wg       sync.WaitGroup
		start    = make(chan struct{})
		okCount  atomic.Int32
		limCount atomic.Int32
		errCount atomic.Int32
	)

	wg.Add(totalRequests)
	for i := range totalRequests {
		go func() {
			defer wg.Done()
			<-start
			req := httptest.NewRequest(http.MethodPost, "/vault/unlock/recovery", nil)
			req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
			rec := httptest.NewRecorder()
			if i%2 == 0 {
				srvA.ServeHTTP(rec, req)
			} else {
				srvB.ServeHTTP(rec, req)
			}
			switch rec.Code {
			case http.StatusOK:
				okCount.Add(1)
			case http.StatusTooManyRequests:
				limCount.Add(1)
			default:
				errCount.Add(1)
			}
		}()
	}

	close(start)
	wg.Wait()

	if errCount.Load() != 0 {
		t.Fatalf("unexpected non-200/429 responses: %d", errCount.Load())
	}
	if okCount.Load() != 5 {
		t.Fatalf("hai instance song song chỉ được cho qua đúng 5 request, got %d (blocked=%d)", okCount.Load(), limCount.Load())
	}
	if limCount.Load() != totalRequests-5 {
		t.Fatalf("blocked count = %d, muốn %d", limCount.Load(), totalRequests-5)
	}
	if handlerExecutions.Load() != 5 {
		t.Fatalf("handler chạy %d lần, muốn đúng 5 lần", handlerExecutions.Load())
	}
	if got := countRateEvents(t, poolA, httpx.ScopeVaultRecoveryLookup, userID); got != 5 {
		t.Fatalf("số dòng rate_event trong DB = %d, muốn đúng 5", got)
	}
}

// Bullet 9: thông báo lỗi 429 không tiết lộ số RK còn lại hay trạng thái passphrase,
// và luôn có header Retry-After hợp lệ.
func TestUserLimit_MessageDoesNotLeakRemainingRKCount(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)

	// Tạo 2 user với trạng thái vault + RK thật khác nhau (user 1 còn 7 RK, user 2 còn 1 RK)
	// để chứng minh phản hồi 429 hoàn toàn giống nhau và không chứa bất kỳ thông tin RK/passphrase nào.
	user1, sess1 := seedRateLimitUser(t, pool, "rk-leak-1@example.com")
	user2, sess2 := seedRateLimitUser(t, pool, "rk-leak-2@example.com")
	seedVaultAndRecoveryKeys(t, pool, user1, "vk:1111111111111111", 7)
	seedVaultAndRecoveryKeys(t, pool, user2, "vk:2222222222222222", 1)

	q := gen.New(pool)
	cnt1, err := q.CountRecoveryKeysByUser(context.Background(), user1)
	if err != nil || cnt1 != 7 {
		t.Fatalf("CountRecoveryKeysByUser(user1) = %d, err = %v, muốn 7", cnt1, err)
	}
	cnt2, err := q.CountRecoveryKeysByUser(context.Background(), user2)
	if err != nil || cnt2 != 1 {
		t.Fatalf("CountRecoveryKeysByUser(user2) = %d, err = %v, muốn 1", cnt2, err)
	}

	clk := clock.NewFixed(time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC))
	limiter := httpx.NewUserLimiter(pool, clk)

	exhaustAndCapture429 := func(p authctx.Principal) (string, httpx.Problem, string) {
		r := chi.NewRouter()
		r.Use(httpx.RequireSession(stubAuth{p: p}))
		r.With(limiter.Middleware(httpx.ScopeVaultRecoveryLookup)).Post("/vault/unlock/recovery", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
		for i := range 6 {
			req := httptest.NewRequest(http.MethodPost, "/vault/unlock/recovery", nil)
			req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if i == 5 {
				if rec.Code != http.StatusTooManyRequests {
					t.Fatalf("request 6 phải 429, got %d", rec.Code)
				}
				return rec.Body.String(), decodeProblem(t, rec), rec.Header().Get("Retry-After")
			}
		}
		t.Fatal("unreachable")
		return "", httpx.Problem{}, ""
	}

	raw1, prob1, retry1 := exhaustAndCapture429(authctx.Principal{UserID: user1, SessionID: sess1})
	raw2, prob2, retry2 := exhaustAndCapture429(authctx.Principal{UserID: user2, SessionID: sess2})

	if raw1 != raw2 {
		t.Fatalf("body 429 giữa hai user khác nhau:\nuser1=%s\nuser2=%s", raw1, raw2)
	}
	if retry1 != "900" || retry2 != "900" {
		t.Fatalf("Retry-After = %q / %q, muốn 900", retry1, retry2)
	}
	if prob1.Detail != "Quá nhiều yêu cầu." || prob2.Detail != "Quá nhiều yêu cầu." {
		t.Fatalf("detail = %q, muốn 'Quá nhiều yêu cầu.'", prob1.Detail)
	}
	lower := strings.ToLower(raw1)
	for _, forbidden := range []string{"recovery", "rk", "remaining", "còn lại", "khoá khôi phục", "passphrase", "slot"} {
		if strings.Contains(lower, forbidden) {
			t.Fatalf("response 429 không được lộ %q trong body: %s", forbidden, raw1)
		}
	}
}

// Kiểm tra thêm scope vault_sensitive (10 / phút / user) và fail-closed khi thiếu principal.
func TestUserLimit_VaultSensitiveScopeAndFailClosed(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)

	userID, sessID := seedRateLimitUser(t, pool, "sensitive@example.com")
	principal := authctx.Principal{UserID: userID, SessionID: sessID}
	clk := clock.NewFixed(time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC))
	limiter := httpx.NewUserLimiter(pool, clk)

	r := chi.NewRouter()
	r.Use(httpx.RequireSession(stubAuth{p: principal}))
	r.With(limiter.Middleware(httpx.ScopeVaultSensitive)).Put("/vault/kek", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	for i := range 10 {
		req := httptest.NewRequest(http.MethodPut, "/vault/kek", nil)
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("sensitive request %d = %d, muốn 200", i+1, rec.Code)
		}
	}
	req11 := httptest.NewRequest(http.MethodPut, "/vault/kek", nil)
	req11.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
	rec11 := httptest.NewRecorder()
	r.ServeHTTP(rec11, req11)
	if rec11.Code != http.StatusTooManyRequests || rec11.Header().Get("Retry-After") != "60" {
		t.Fatalf("sensitive request 11 = %d (Retry-After=%q), muốn 429 (60)", rec11.Code, rec11.Header().Get("Retry-After"))
	}

	// Thiếu principal -> 401 unauthenticated.
	unauthRouter := chi.NewRouter()
	unauthRouter.With(limiter.Middleware(httpx.ScopeVaultSensitive)).Put("/vault/kek", func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("không được vào handler khi thiếu principal")
	})
	recUnauth := httptest.NewRecorder()
	unauthRouter.ServeHTTP(recUnauth, httptest.NewRequest(http.MethodPut, "/vault/kek", nil))
	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("thiếu principal = %d, muốn 401", recUnauth.Code)
	}

	// Limiter nil -> 500 internal_error (fail-closed).
	nilRouter := chi.NewRouter()
	nilRouter.With(httpx.LimitUser(nil, httpx.ScopeVaultSensitive)).Put("/vault/kek", func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("không được vào handler khi limiter nil")
	})
	recNil := httptest.NewRecorder()
	nilRouter.ServeHTTP(recNil, httptest.NewRequest(http.MethodPut, "/vault/kek", nil))
	if recNil.Code != http.StatusInternalServerError {
		t.Fatalf("limiter nil = %d, muốn 500", recNil.Code)
	}
}

// BE1-3 / BE2-5: Allow phải lấy đồng hồ SAU KHI đã giữ advisory lock (scope, user).
// Nếu một request phải chờ lock lâu hơn cả cửa sổ trượt rồi mới được cấp quyền,
// sự kiện vừa ghi phải mang mốc thời gian sau khi chờ và vẫn được tính vào cửa sổ của request kế tiếp.
// Đồng thời (BE2-5), khi có một phiên khác đang chờ một advisory lock không liên quan trên cùng DB/cluster,
// phép thử vẫn phải đợi đúng backend Allow của chính nó chặn trên đúng định danh khóa (database, classid, objid, PID).
func TestUserLimit_ClockSampledAfterAdvisoryLockWait(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	// Mở một pool riêng giới hạn đúng 1 kết nối cho UserLimiter để xác định chính xác PID backend của Allow.
	allowCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("ParseConfig allowPool: %v", err)
	}
	allowCfg.MaxConns = 1
	allowCfg.MinConns = 1
	allowPool, err := pgxpool.NewWithConfig(ctx, allowCfg)
	if err != nil {
		t.Fatalf("NewWithConfig allowPool: %v", err)
	}
	t.Cleanup(allowPool.Close)

	var allowPID int32
	if err := allowPool.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&allowPID); err != nil {
		t.Fatalf("query allowPID: %v", err)
	}

	userID, _ := seedRateLimitUser(t, pool, "post-lock-clock@example.com")
	t0 := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(t0)

	const scope = httpx.ScopeVaultRecoveryLookup
	limiter := httpx.NewUserLimiterWithRules(allowPool, clk, map[string]httpx.RateLimitRule{
		scope: {
			Limit:  1,
			Window: 15 * time.Minute,
		},
	})

	// Tạo một advisory lock waiter KHÔNG liên quan đang bị chặn sẵn trước khi chạy Allow
	// để chứng minh phép chờ không bị đánh lừa bởi waiter của khóa/lane khác (BE2-5).
	const unrelatedScope = "unrelated.advisory.scope"
	unrelatedUserID := uuid.New()
	unrelatedHoldTx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("BeginTx unrelatedHoldTx: %v", err)
	}
	defer func() { _ = unrelatedHoldTx.Rollback(ctx) }()
	if err := gen.New(unrelatedHoldTx).AcquireRateLimitLock(ctx, gen.AcquireRateLimitLockParams{
		Scope:  unrelatedScope,
		UserID: unrelatedUserID,
	}); err != nil {
		t.Fatalf("AcquireRateLimitLock unrelatedHoldTx: %v", err)
	}

	unrelatedWaitCtx, unrelatedWaitCancel := context.WithCancel(ctx)
	defer unrelatedWaitCancel()
	unrelatedWaitDone := make(chan error, 1)
	go func() {
		tx, txErr := pool.BeginTx(unrelatedWaitCtx, pgx.TxOptions{})
		if txErr != nil {
			unrelatedWaitDone <- txErr
			return
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		unrelatedWaitDone <- gen.New(tx).AcquireRateLimitLock(unrelatedWaitCtx, gen.AcquireRateLimitLockParams{
			Scope:  unrelatedScope,
			UserID: unrelatedUserID,
		})
	}()
	defer func() {
		unrelatedWaitCancel()
		_ = unrelatedHoldTx.Rollback(ctx)
		select {
		case <-unrelatedWaitDone:
		case <-time.After(5 * time.Second):
			t.Error("timeout dọn dẹp unrelatedWaitDone")
		}
	}()

	unrelatedDeadline := time.Now().Add(5 * time.Second)
	for {
		var unrelatedWaiting bool
		if err := pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM pg_locks AS l
				JOIN pg_database AS d ON d.oid = l.database AND d.datname = current_database()
				WHERE l.locktype = 'advisory'
				  AND NOT l.granted
				  AND l.objsubid = 2
				  AND l.classid::int4 = hashtext($1::text)
				  AND l.objid::int4 = hashtext(($2::uuid)::text)
			)
		`, unrelatedScope, unrelatedUserID).Scan(&unrelatedWaiting); err != nil {
			t.Fatalf("query pg_locks unrelated waiter: %v", err)
		}
		if unrelatedWaiting {
			break
		}
		if time.Now().After(unrelatedDeadline) {
			t.Fatal("timeout chờ unrelated advisory waiter vào trạng thái NOT granted")
		}
		time.Sleep(10 * time.Millisecond)
	}

	holdTx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("BeginTx holdTx: %v", err)
	}
	defer func() { _ = holdTx.Rollback(ctx) }()

	var holdPID int32
	if err := holdTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&holdPID); err != nil {
		t.Fatalf("query holdPID: %v", err)
	}

	if err := gen.New(holdTx).AcquireRateLimitLock(ctx, gen.AcquireRateLimitLockParams{
		Scope:  scope,
		UserID: userID,
	}); err != nil {
		t.Fatalf("AcquireRateLimitLock holdTx: %v", err)
	}

	type allowResult struct {
		ok    bool
		retry int
		err   error
	}
	resCh := make(chan allowResult, 1)
	go func() {
		ok, retry, err := limiter.Allow(ctx, scope, userID)
		resCh <- allowResult{ok: ok, retry: retry, err: err}
	}()

	// Đợi deterministically tới khi chính backend allowPID của goroutine Allow đang chờ đúng advisory lock
	// (database oid của current_database(), classid = hashtext(scope), objid = hashtext(user_id::text), bị chặn bởi holdPID).
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM pg_locks AS l
				JOIN pg_database AS d ON d.oid = l.database AND d.datname = current_database()
				WHERE l.locktype = 'advisory'
				  AND NOT l.granted
				  AND l.pid = $1
				  AND l.objsubid = 2
				  AND l.classid::int4 = hashtext($2::text)
				  AND l.objid::int4 = hashtext(($3::uuid)::text)
				  AND $4 = ANY(pg_blocking_pids(l.pid))
			)
		`, allowPID, scope, userID, holdPID).Scan(&waiting); err != nil {
			t.Fatalf("query pg_locks target waiter: %v", err)
		}
		if waiting {
			break
		}
		select {
		case early := <-resCh:
			t.Fatalf("Allow kết thúc sớm trước khi thấy trạng thái chờ advisory lock: %+v", early)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("timeout chờ allowPID=%d block trên pg_advisory_xact_lock (holdPID=%d)", allowPID, holdPID)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Trong lúc Allow đang bị chặn trên advisory lock, dịch đồng hồ giả vượt quá cửa sổ 15 phút (lên t0 + 20m),
	// sau đó nhả lock để Allow tiếp tục.
	postWaitTime := t0.Add(20 * time.Minute)
	clk.Set(postWaitTime)
	if err := holdTx.Rollback(ctx); err != nil {
		t.Fatalf("release holdTx: %v", err)
	}

	var res allowResult
	select {
	case res = <-resCh:
	case <-time.After(5 * time.Second):
		t.Fatal("timeout chờ Allow hoàn tất sau khi nhả advisory lock")
	}
	if res.err != nil || !res.ok {
		t.Fatalf("Allow thứ nhất sau khi chờ lock phải được phép: ok=%v retry=%d err=%v", res.ok, res.retry, res.err)
	}

	// Kiểm tra mốc thời gian đã ghi vào rate_event phải là mốc thời gian SAU KHI chờ lock (postWaitTime),
	// không phải mốc t0 trước khi lấy lock.
	var recordedAt time.Time
	if err := pool.QueryRow(ctx, `SELECT at FROM rate_event WHERE scope = $1 AND user_id = $2`, scope, userID).Scan(&recordedAt); err != nil {
		t.Fatalf("select recorded rate_event.at: %v", err)
	}
	if !recordedAt.UTC().Equal(postWaitTime) {
		t.Fatalf("rate_event.at = %s, muốn %s (mốc thời gian sau khi lấy advisory lock)", recordedAt.UTC().Format(time.RFC3339Nano), postWaitTime.Format(time.RFC3339Nano))
	}

	// Ngay tại postWaitTime + 1m, sự kiện vừa được phép ở postWaitTime vẫn nằm trong cửa sổ 15 phút,
	// nên request kế tiếp phải bị chặn (ok=false, retryAfter=840).
	clk.Set(postWaitTime.Add(time.Minute))
	ok2, retry2, err2 := limiter.Allow(ctx, scope, userID)
	if err2 != nil {
		t.Fatalf("Allow thứ hai trả lỗi: %v", err2)
	}
	if ok2 {
		t.Fatal("Allow thứ hai phải bị chặn vì sự kiện vừa cấp phát ở postWaitTime vẫn còn trong cửa sổ 15 phút")
	}
	if retry2 != 14*60 {
		t.Fatalf("Allow thứ hai retryAfter = %d, muốn 840 (14 phút)", retry2)
	}
}
