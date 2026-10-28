package httpx_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

const testAppOrigin = "http://localhost:3000"

type idemTestEnv struct {
	t      *testing.T
	pool   *pgxpool.Pool
	clk    *clock.Fixed
	idem   *httpx.Idempotency
	grants *auth.Grants
	userA  authctx.Principal
	userB  authctx.Principal
}

type tokenAuth struct {
	users map[string]authctx.Principal
}

func (a tokenAuth) Authenticate(_ context.Context, tok string) (authctx.Principal, error) {
	if p, ok := a.users[tok]; ok {
		return p, nil
	}
	return authctx.Principal{}, &httpx.AuthError{Code: "unauthenticated"}
}

type strictCSRF struct{}

func (strictCSRF) VerifyCSRF(_ context.Context, p *authctx.Principal, cookie, header string) error {
	if p == nil || cookie == "" || header == "" || cookie != header {
		return &httpx.AuthError{Code: "csrf_invalid"}
	}
	return nil
}

type grantsReauthAdapter struct {
	g *auth.Grants
}

func (a grantsReauthAdapter) VerifyReauth(_ context.Context, p authctx.Principal, action, token string) error {
	if token == "" {
		return &httpx.AuthError{Code: "reauth_required"}
	}
	if err := a.g.Verify(p, action, token); err != nil {
		return &httpx.AuthError{Code: "reauth_invalid"}
	}
	return nil
}

func newIdemTestEnv(t *testing.T) *idemTestEnv {
	t.Helper()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	var userAID, userBID uuid.UUID
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email, locale) VALUES ('user-a@example.com', 'en') RETURNING id`).Scan(&userAID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email, locale) VALUES ('user-b@example.com', 'en') RETURNING id`).Scan(&userBID); err != nil {
		t.Fatal(err)
	}

	clk := clock.NewFixed(time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC))
	secret := bytes.Repeat([]byte{0x42}, 32)
	grants := auth.NewGrants(secret, clk)
	idem := httpx.NewIdempotency(pool, clk)

	return &idemTestEnv{
		t:      t,
		pool:   pool,
		clk:    clk,
		idem:   idem,
		grants: grants,
		userA:  authctx.Principal{UserID: userAID, SessionID: uuid.New()},
		userB:  authctx.Principal{UserID: userBID, SessionID: uuid.New()},
	}
}

func (e *idemTestEnv) authn() httpx.Authenticator {
	return tokenAuth{
		users: map[string]authctx.Principal{
			"sess-a": e.userA,
			"sess-b": e.userB,
		},
	}
}

func (e *idemTestEnv) newReq(method, path, body, sessionTok, idemKey string, withCSRF bool) *http.Request {
	e.t.Helper()
	var rdr *bytes.Reader
	if body != "" {
		rdr = bytes.NewReader([]byte(body))
	} else {
		rdr = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	if body == "" {
		req.Body = http.NoBody
		req.ContentLength = 0
	}
	req.Header.Set("Origin", testAppOrigin)
	if body != "" || method != http.MethodDelete {
		req.Header.Set("Content-Type", "application/json")
	}
	if sessionTok != "" {
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: sessionTok})
	}
	req.AddCookie(&http.Cookie{Name: "sabk_csrf", Value: "csrf-valid"})
	if withCSRF {
		req.Header.Set("X-CSRF-Token", "csrf-valid")
	}
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	return req
}

func TestIdempotencyReplaySameKeyAndBodyIncluding204AndConflicts(t *testing.T) {
	env := newIdemTestEnv(t)
	ctx := context.Background()

	var createRuns atomic.Int32
	var deleteRuns atomic.Int32

	r := chi.NewRouter()

	// Route 1: POST /api/v1/vault trả 201 JSON và tăng version trong bảng vault.
	createHandler := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:     testAppOrigin,
		Authenticator: env.authn(),
		CSRF:          strictCSRF{},
		Idempotency:   env.idem,
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		createRuns.Add(1)
		tx, err := httpx.BeginMutationTx(r.Context(), env.pool)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(r.Context()) }()

		if _, err := tx.Exec(r.Context(), `
			INSERT INTO vault (user_id, version, kdf, vault_key_id, vault_key_wrapped_by_kek, x25519_public, ed25519_public, private_keys_wrapped)
			VALUES ($1, 1, '{"alg":"argon2id13"}'::jsonb, $2, '\x01', '\x02', '\x03', '\x04')
		`, env.userA.UserID, validTestVaultKeyID); err != nil {
			t.Fatal(err)
		}
		respBytes := []byte(`{"vault_key_id":"` + validTestVaultKeyID + `","version":1}`)
		if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusCreated, respBytes); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(respBytes)
	}))
	r.Method(http.MethodPost, "/api/v1/vault", createHandler)
	r.Method(http.MethodPost, "/api/v1/vault/passkeys", createHandler)

	// Route 2: DELETE /api/v1/vault trả 204 No Content (không body) và xoá các idempotency key khác trên /api/v1/vault%.
	deleteHandler := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:        testAppOrigin,
		Authenticator:    env.authn(),
		CSRF:             strictCSRF{},
		Idempotency:      env.idem,
		AllowEmptyDelete: true,
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deleteRuns.Add(1)
		tx, err := httpx.BeginMutationTx(r.Context(), env.pool)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(r.Context()) }()

		if _, err := gen.New(tx).DeleteVaultByUser(r.Context(), env.userA.UserID); err != nil {
			t.Fatal(err)
		}
		if err := httpx.PurgeOtherVaultIdempotencyKeysTx(r.Context(), tx); err != nil {
			t.Fatal(err)
		}
		if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusNoContent, nil); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	r.Method(http.MethodDelete, "/api/v1/vault", deleteHandler)

	// 1. Gọi lần đầu POST /api/v1/vault -> 201 Created, mutation chạy 1 lần.
	keyCreate := "idem_create_key_0001"
	bodyCreate := `{"op":"create","n":1}`
	rec1 := httptest.NewRecorder()
	r.ServeHTTP(rec1, env.newReq(http.MethodPost, "/api/v1/vault", bodyCreate, "sess-a", keyCreate, true))
	if rec1.Code != http.StatusCreated {
		t.Fatalf("first create: status = %d, body = %s", rec1.Code, rec1.Body.String())
	}
	if createRuns.Load() != 1 {
		t.Fatalf("createRuns = %d, muốn 1", createRuns.Load())
	}

	// 2. Cùng key + cùng body -> trả đúng response gốc 201 và mutation vẫn chạy đúng 1 lần.
	rec2 := httptest.NewRecorder()
	r.ServeHTTP(rec2, env.newReq(http.MethodPost, "/api/v1/vault", bodyCreate, "sess-a", keyCreate, true))
	if rec2.Code != http.StatusCreated {
		t.Fatalf("replay create: status = %d, muốn 201", rec2.Code)
	}
	if !jsonEqual(t, rec2.Body.Bytes(), rec1.Body.Bytes()) {
		t.Fatalf("replay body = %q, muốn tương đương JSON %q", rec2.Body.String(), rec1.Body.String())
	}
	if createRuns.Load() != 1 {
		t.Fatalf("sau replay createRuns = %d, muốn 1", createRuns.Load())
	}

	// 3. Cùng key + body khác -> 409 idempotency_conflict, mutation không chạy thêm.
	recDiffBody := httptest.NewRecorder()
	r.ServeHTTP(recDiffBody, env.newReq(http.MethodPost, "/api/v1/vault", `{"op":"create","n":2}`, "sess-a", keyCreate, true))
	if recDiffBody.Code != http.StatusConflict {
		t.Fatalf("diff body: status = %d, muốn 409", recDiffBody.Code)
	}
	var probDiffBody httpx.Problem
	if err := json.Unmarshal(recDiffBody.Body.Bytes(), &probDiffBody); err != nil {
		t.Fatal(err)
	}
	if probDiffBody.Code != "idempotency_conflict" {
		t.Fatalf("diff body: code = %q, muốn idempotency_conflict", probDiffBody.Code)
	}
	if createRuns.Load() != 1 {
		t.Fatalf("sau diff body createRuns = %d, muốn 1", createRuns.Load())
	}

	// 4. Cùng key + cùng body nhưng gửi tới path khác -> 409 idempotency_conflict.
	recDiffPath := httptest.NewRecorder()
	r.ServeHTTP(recDiffPath, env.newReq(http.MethodPost, "/api/v1/vault/passkeys", bodyCreate, "sess-a", keyCreate, true))
	if recDiffPath.Code != http.StatusConflict {
		t.Fatalf("diff path: status = %d, muốn 409", recDiffPath.Code)
	}
	var probDiffPath httpx.Problem
	if err := json.Unmarshal(recDiffPath.Body.Bytes(), &probDiffPath); err != nil {
		t.Fatal(err)
	}
	if probDiffPath.Code != "idempotency_conflict" {
		t.Fatalf("diff path: code = %q, muốn idempotency_conflict", probDiffPath.Code)
	}

	// 5. DELETE /api/v1/vault (204 không body, không Content-Type): lần 1 chạy mutation và purge keyCreate;
	// lần 2 cùng keyDelete trả lại 204 không body và mutation chạy đúng 1 lần.
	keyDelete := "idem_delete_key_0001"
	recDel1 := httptest.NewRecorder()
	r.ServeHTTP(recDel1, env.newReq(http.MethodDelete, "/api/v1/vault", "", "sess-a", keyDelete, true))
	if recDel1.Code != http.StatusNoContent || recDel1.Body.Len() != 0 {
		t.Fatalf("first delete: status=%d len=%d", recDel1.Code, recDel1.Body.Len())
	}
	if deleteRuns.Load() != 1 {
		t.Fatalf("deleteRuns = %d, muốn 1", deleteRuns.Load())
	}

	recDel2 := httptest.NewRecorder()
	r.ServeHTTP(recDel2, env.newReq(http.MethodDelete, "/api/v1/vault", "", "sess-a", keyDelete, true))
	if recDel2.Code != http.StatusNoContent || recDel2.Body.Len() != 0 {
		t.Fatalf("replay delete: status=%d len=%d", recDel2.Code, recDel2.Body.Len())
	}
	if deleteRuns.Load() != 1 {
		t.Fatalf("sau replay deleteRuns = %d, muốn 1", deleteRuns.Load())
	}

	// Kiểm tra trong DB: keyCreate đã bị purge bởi reset vault, chỉ còn keyDelete với response IS NULL và status_code = 204.
	var remaining int
	var savedCode int32
	var respNull bool
	if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1`, env.userA.UserID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 1 {
		t.Fatalf("sau reset vault, số idempotency_key còn lại = %d, muốn 1 (chỉ giữ key của chính request reset)", remaining)
	}
	if err := env.pool.QueryRow(ctx, `SELECT status_code, response IS NULL FROM idempotency_key WHERE user_id = $1 AND key = $2`, env.userA.UserID, keyDelete).Scan(&savedCode, &respNull); err != nil {
		t.Fatal(err)
	}
	if savedCode != http.StatusNoContent || !respNull {
		t.Fatalf("204 row: status_code=%d responseIsNull=%v", savedCode, respNull)
	}
}

func TestIdempotencyParallelRequestsAndLostClaimRaceReclassified(t *testing.T) {
	env := newIdemTestEnv(t)

	// Phần A: Hai request song song cùng key + cùng fingerprint -> một request đang chạy trong handler,
	// request thứ hai bị chặn ngay ở Lookup với 409 idempotency_in_progress + Retry-After: 1.
	enteredHandler := make(chan struct{})
	releaseHandler := make(chan struct{})
	var runs atomic.Int32

	r := chi.NewRouter()
	h := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:     testAppOrigin,
		Authenticator: env.authn(),
		CSRF:          strictCSRF{},
		Idempotency:   env.idem,
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		runs.Add(1)
		close(enteredHandler)
		<-releaseHandler

		tx, err := httpx.BeginMutationTx(r.Context(), env.pool)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		resp := []byte(`{"version":2}`)
		if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusOK, resp); err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}))
	r.Method(http.MethodPut, "/api/v1/vault/kek", h)

	keyParallel := "idem_parallel_key_01"
	bodyParallel := `{"kdf":"same"}`

	rec1 := httptest.NewRecorder()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		r.ServeHTTP(rec1, env.newReq(http.MethodPut, "/api/v1/vault/kek", bodyParallel, "sess-a", keyParallel, true))
	}()

	<-enteredHandler

	// Request 2 đến khi Request 1 đang in_progress (< 60s).
	rec2 := httptest.NewRecorder()
	r.ServeHTTP(rec2, env.newReq(http.MethodPut, "/api/v1/vault/kek", bodyParallel, "sess-a", keyParallel, true))
	if rec2.Code != http.StatusConflict {
		t.Fatalf("parallel req2: status = %d, muốn 409", rec2.Code)
	}
	if gotRetry := rec2.Header().Get("Retry-After"); gotRetry != "1" {
		t.Fatalf("parallel req2 Retry-After = %q, muốn 1", gotRetry)
	}
	var prob2 httpx.Problem
	if err := json.Unmarshal(rec2.Body.Bytes(), &prob2); err != nil {
		t.Fatal(err)
	}
	if prob2.Code != "idempotency_in_progress" || prob2.RetryAfter == nil || *prob2.RetryAfter != 1 {
		t.Fatalf("parallel req2 problem: code=%q retry_after=%v", prob2.Code, prob2.RetryAfter)
	}

	close(releaseHandler)
	wg.Wait()

	if rec1.Code != http.StatusOK || runs.Load() != 1 {
		t.Fatalf("parallel req1: status=%d runs=%d", rec1.Code, runs.Load())
	}

	// Phần B: Thua race ở bước 6 (Claim): cả 2 request đều đã đi qua bước 2 (Lookup thấy chưa có hàng),
	// nhưng trước khi request thua chạy INSERT ... ON CONFLICT ở bước 6 thì đối thủ đã kịp Claim (hoặc hoàn tất).
	// Kiểm tra cả phân loại lại thành `idempotency_in_progress`, `idempotency_conflict` và `done` replay.
	t.Run("lost_claim_race_reclassified_to_in_progress", func(t *testing.T) {
		raceKey := "idem_claim_race_inprog"
		body := `{"race":1}`

		var hookOnce sync.Once
		env.idem.SetClaimRaceHookForTest(func() {
			hookOnce.Do(func() {
				// Đối thủ chen ngang claim cùng key + cùng fingerprint ngay trước khi request này chạy SQL Claim.
				ctx := context.Background()
				_, err := gen.New(env.pool).ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
					UserID:      env.userA.UserID,
					Key:         raceKey,
					Method:      http.MethodPut,
					Path:        "/api/v1/vault/kek",
					RequestHash: httpx.ComputeIdempotencyFingerprint(http.MethodPut, "/api/v1/vault/kek", []byte(body)),
					OwnerToken:  uuid.New(),
					Now:         pgxTimestamptz(env.clk.Now()),
				})
				if err != nil {
					t.Errorf("concurrent claim: %v", err)
				}
			})
		})
		defer env.idem.SetClaimRaceHookForTest(nil)

		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", raceKey, true))
		if rec.Code != http.StatusConflict {
			t.Fatalf("lost race in_progress: status = %d, muốn 409", rec.Code)
		}
		var prob httpx.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &prob); err != nil {
			t.Fatal(err)
		}
		if prob.Code != "idempotency_in_progress" || rec.Header().Get("Retry-After") != "1" {
			t.Fatalf("lost race in_progress: code=%q Retry-After=%q", prob.Code, rec.Header().Get("Retry-After"))
		}
	})

	t.Run("lost_claim_race_reclassified_to_conflict", func(t *testing.T) {
		raceKey := "idem_claim_race_conf"
		body := `{"race":1}`

		var hookOnce sync.Once
		env.idem.SetClaimRaceHookForTest(func() {
			hookOnce.Do(func() {
				// Đối thủ chen ngang claim cùng key nhưng fingerprint khác.
				ctx := context.Background()
				_, err := gen.New(env.pool).ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
					UserID:      env.userA.UserID,
					Key:         raceKey,
					Method:      http.MethodPut,
					Path:        "/api/v1/vault/kek",
					RequestHash: httpx.ComputeIdempotencyFingerprint(http.MethodPut, "/api/v1/vault/kek", []byte(`{"race":999}`)),
					OwnerToken:  uuid.New(),
					Now:         pgxTimestamptz(env.clk.Now()),
				})
				if err != nil {
					t.Errorf("concurrent claim: %v", err)
				}
			})
		})
		defer env.idem.SetClaimRaceHookForTest(nil)

		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", raceKey, true))
		if rec.Code != http.StatusConflict {
			t.Fatalf("lost race conflict: status = %d, muốn 409", rec.Code)
		}
		var prob httpx.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &prob); err != nil {
			t.Fatal(err)
		}
		if prob.Code != "idempotency_conflict" {
			t.Fatalf("lost race conflict: code=%q, muốn idempotency_conflict", prob.Code)
		}
	})

	t.Run("lost_claim_race_reclassified_to_done_replay", func(t *testing.T) {
		raceKey := "idem_claim_race_done"
		body := `{"race":2}`

		var hookOnce sync.Once
		env.idem.SetClaimRaceHookForTest(func() {
			hookOnce.Do(func() {
				ctx := context.Background()
				q := gen.New(env.pool)
				tok := uuid.New()
				_, err := q.ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
					UserID:      env.userA.UserID,
					Key:         raceKey,
					Method:      http.MethodPut,
					Path:        "/api/v1/vault/kek",
					RequestHash: httpx.ComputeIdempotencyFingerprint(http.MethodPut, "/api/v1/vault/kek", []byte(body)),
					OwnerToken:  tok,
					Now:         pgxTimestamptz(env.clk.Now()),
				})
				if err != nil {
					t.Errorf("concurrent claim: %v", err)
				}
				_, err = q.FinishIdempotencyKey(ctx, gen.FinishIdempotencyKeyParams{
					StatusCode: http.StatusOK,
					Response:   []byte(`{"version":77}`),
					UserID:     env.userA.UserID,
					Key:        raceKey,
					OwnerToken: tok,
				})
				if err != nil {
					t.Errorf("concurrent finish: %v", err)
				}
			})
		})
		defer env.idem.SetClaimRaceHookForTest(nil)

		beforeRuns := runs.Load()
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", raceKey, true))
		if rec.Code != http.StatusOK || !jsonEqual(t, rec.Body.Bytes(), []byte(`{"version":77}`)) {
			t.Fatalf("lost race done: status=%d body=%s", rec.Code, rec.Body.String())
		}
		if runs.Load() != beforeRuns {
			t.Fatalf("handler không được chạy khi phân loại lại là done")
		}
	})
}

func TestIdempotencyGrantExpiredReplayCSRFRejectionAndUserIsolation(t *testing.T) {
	env := newIdemTestEnv(t)

	var runs atomic.Int32
	var rateLimitHits atomic.Int32

	rateLimiter := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rateLimitHits.Add(1)
			next.ServeHTTP(w, r)
		})
	}

	r := chi.NewRouter()
	h := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:      testAppOrigin,
		Authenticator:  env.authn(),
		CSRF:           strictCSRF{},
		Idempotency:    env.idem,
		Reauth:         grantsReauthAdapter{g: env.grants},
		ReauthAction:   "vault.rewrap",
		RateLimit:      rateLimiter,
		RequireIfMatch: true,
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		runs.Add(1)
		tx, err := httpx.BeginMutationTx(r.Context(), env.pool)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		resp := []byte(`{"version":2}`)
		if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusOK, resp); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}))
	r.Method(http.MethodPut, "/api/v1/vault/kek", h)

	grantA, err := env.grants.Issue(env.userA, "vault.rewrap")
	if err != nil {
		t.Fatal(err)
	}

	key := "idem_grant_csrf_user_01"
	body := `{"kdf":"params"}`

	// 1. Lần đầu của user A với đầy đủ CSRF, grant còn hạn, If-Match hợp lệ -> 200 OK.
	req1 := env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", key, true)
	req1.Header.Set("X-Reauth-Token", grantA.Grant)
	req1.Header.Set("If-Match", `"`+validTestVaultKeyID+`:1"`)
	rec1 := httptest.NewRecorder()
	r.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first call: status=%d body=%s", rec1.Code, rec1.Body.String())
	}
	if runs.Load() != 1 || rateLimitHits.Load() != 1 {
		t.Fatalf("runs=%d rateLimitHits=%d, muốn 1 và 1", runs.Load(), rateLimitHits.Load())
	}

	// 2. Dịch đồng hồ qua 10 phút (> GrantTTL 5 phút, nhưng < 24h idempotency expiry):
	// Grant đã hết hạn và thậm chí If-Match không còn khớp, nhưng retry cùng key+body vẫn trả response gốc ở bước 2,
	// không tốn thêm rate limit và không chạy lại handler.
	env.clk.Advance(10 * time.Minute)
	reqReplayExpiredGrant := env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", key, true)
	reqReplayExpiredGrant.Header.Set("X-Reauth-Token", grantA.Grant) // đã hết hạn
	reqReplayExpiredGrant.Header.Set("If-Match", `"`+validTestVaultKeyID+`:1"`)
	recReplay := httptest.NewRecorder()
	r.ServeHTTP(recReplay, reqReplayExpiredGrant)
	if recReplay.Code != http.StatusOK || !jsonEqual(t, recReplay.Body.Bytes(), []byte(`{"version":2}`)) {
		t.Fatalf("replay after grant expiry: status=%d body=%s", recReplay.Code, recReplay.Body.String())
	}
	if runs.Load() != 1 || rateLimitHits.Load() != 1 {
		t.Fatalf("replay không được chạm rate limit hay handler: runs=%d rateLimitHits=%d", runs.Load(), rateLimitHits.Load())
	}

	// 3. Retry thiếu CSRF bị từ chối ở bước 1 (403 csrf_invalid), không trả replay.
	reqNoCSRF := env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", key, false)
	reqNoCSRF.Header.Set("X-Reauth-Token", grantA.Grant)
	recNoCSRF := httptest.NewRecorder()
	r.ServeHTTP(recNoCSRF, reqNoCSRF)
	if recNoCSRF.Code != http.StatusForbidden {
		t.Fatalf("retry missing CSRF: status=%d, muốn 403", recNoCSRF.Code)
	}
	var probCSRF httpx.Problem
	if err := json.Unmarshal(recNoCSRF.Body.Bytes(), &probCSRF); err != nil {
		t.Fatal(err)
	}
	if probCSRF.Code != "csrf_invalid" {
		t.Fatalf("retry missing CSRF: code=%q, muốn csrf_invalid", probCSRF.Code)
	}

	// 4. User B gửi đúng key + đúng body của User A: KHÔNG được replay kết quả của User A.
	// Vì User B không có grant hợp lệ ở bước 3 nên bị chặn ở bước 3 (401 reauth_required),
	// và khi User B có grant riêng của User B thì chạy handler riêng cho User B.
	reqUserBNoGrant := env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-b", key, true)
	recUserBNoGrant := httptest.NewRecorder()
	r.ServeHTTP(recUserBNoGrant, reqUserBNoGrant)
	if recUserBNoGrant.Code != http.StatusUnauthorized {
		t.Fatalf("user B without grant: status=%d, muốn 401 (chứng tỏ không replay của user A ở bước 2)", recUserBNoGrant.Code)
	}

	grantB, err := env.grants.Issue(env.userB, "vault.rewrap")
	if err != nil {
		t.Fatal(err)
	}
	reqUserBWithGrant := env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-b", key, true)
	reqUserBWithGrant.Header.Set("X-Reauth-Token", grantB.Grant)
	reqUserBWithGrant.Header.Set("If-Match", `"`+validTestVaultKeyID+`:1"`)
	recUserB := httptest.NewRecorder()
	r.ServeHTTP(recUserB, reqUserBWithGrant)
	if recUserB.Code != http.StatusOK || runs.Load() != 2 {
		t.Fatalf("user B with own grant: status=%d runs=%d, muốn 200 và runs=2", recUserB.Code, runs.Load())
	}
}

type failOnCommitTx struct {
	pgx.Tx
	commitErr error
}

func (f *failOnCommitTx) Commit(ctx context.Context) error {
	// Giả lập lỗi mạng/connection đứt ngay sau khi server nhận lệnh COMMIT
	// (hoặc ngay trong lúc COMMIT mà client không biết chắc đã commit hay chưa).
	// Ở đây ta thực sự Rollback kết nối bên dưới để giải phóng connection về pool,
	// nhưng trả lỗi từ Commit() để kiểm tra bước 8 giữ nguyên hàng idempotency_key.
	_ = f.Tx.Rollback(ctx)
	return f.commitErr
}

func TestIdempotencyPreCommitReleaseCommitFailureKeepAndPostCommitKeep(t *testing.T) {
	env := newIdemTestEnv(t)
	ctx := context.Background()

	// 1. Lỗi 4xx và 5xx trước COMMIT xoá hàng in_progress và retry chạy lại ngay.
	t.Run("pre_commit_4xx_and_5xx_delete_row_and_retry_runs_immediately", func(t *testing.T) {
		var attempt atomic.Int32
		r := chi.NewRouter()
		h := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
			AppOrigin:     testAppOrigin,
			Authenticator: env.authn(),
			CSRF:          strictCSRF{},
			Idempotency:   env.idem,
		}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cur := attempt.Add(1)
			tx, err := httpx.BeginMutationTx(r.Context(), env.pool)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(r.Context()) }()

			if cur == 1 {
				// Lần 1: lỗi 400 trước COMMIT.
				httpx.WriteProblem(w, r, http.StatusBadRequest, "vault_kdf_invalid", "Tham số KDF không hợp lệ.")
				return
			}
			if cur == 2 {
				// Lần 2: lỗi 500 trước COMMIT.
				httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi máy chủ.")
				return
			}
			// Lần 3: thành công.
			resp := []byte(`{"version":1}`)
			if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusCreated, resp); err != nil {
				t.Fatal(err)
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write(resp)
		}))
		r.Method(http.MethodPost, "/api/v1/vault", h)

		key := "idem_precommit_err_01"
		body := `{"try":"precommit"}`

		rec400 := httptest.NewRecorder()
		r.ServeHTTP(rec400, env.newReq(http.MethodPost, "/api/v1/vault", body, "sess-a", key, true))
		if rec400.Code != http.StatusBadRequest {
			t.Fatalf("attempt 1: status=%d, muốn 400", rec400.Code)
		}
		var countAfter400 int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id=$1 AND key=$2`, env.userA.UserID, key).Scan(&countAfter400); err != nil {
			t.Fatal(err)
		}
		if countAfter400 != 0 {
			t.Fatalf("sau lỗi 4xx trước COMMIT, hàng phải bị xóa, count=%d", countAfter400)
		}

		// Retry ngay lập tức (không cần chờ 60s) -> vào attempt 2 (500).
		rec500 := httptest.NewRecorder()
		r.ServeHTTP(rec500, env.newReq(http.MethodPost, "/api/v1/vault", body, "sess-a", key, true))
		if rec500.Code != http.StatusInternalServerError {
			t.Fatalf("attempt 2: status=%d, muốn 500", rec500.Code)
		}
		var countAfter500 int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id=$1 AND key=$2`, env.userA.UserID, key).Scan(&countAfter500); err != nil {
			t.Fatal(err)
		}
		if countAfter500 != 0 {
			t.Fatalf("sau lỗi 5xx trước COMMIT, hàng phải bị xóa, count=%d", countAfter500)
		}

		// Retry ngay lập tức lần 3 -> thành công 201.
		rec201 := httptest.NewRecorder()
		r.ServeHTTP(rec201, env.newReq(http.MethodPost, "/api/v1/vault", body, "sess-a", key, true))
		if rec201.Code != http.StatusCreated || attempt.Load() != 3 {
			t.Fatalf("attempt 3: status=%d attempts=%d", rec201.Code, attempt.Load())
		}
	})

	// 2. Lỗi giả lập ngay lúc COMMIT: giữ nguyên hàng và mutation không chạy hai lần.
	t.Run("simulated_commit_failure_keeps_row_and_prevents_double_mutation", func(t *testing.T) {
		var mutations atomic.Int32
		r := chi.NewRouter()
		h := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
			AppOrigin:     testAppOrigin,
			Authenticator: env.authn(),
			CSRF:          strictCSRF{},
			Idempotency:   env.idem,
		}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mutations.Add(1)
			rawTx, err := httpx.BeginMutationTx(r.Context(), env.pool)
			if err != nil {
				t.Fatal(err)
			}
			wrapped := &failOnCommitTx{Tx: rawTx, commitErr: errors.New("simulated network drop during COMMIT")}
			if err := httpx.CommitIdempotencyTx(r.Context(), wrapped, http.StatusOK, []byte(`{"version":2}`)); err != nil {
				httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi máy chủ khi commit.")
				return
			}
		}))
		r.Method(http.MethodPut, "/api/v1/vault/kek", h)

		key := "idem_commit_ambig_01"
		body := `{"try":"commit_ambig"}`

		rec1 := httptest.NewRecorder()
		r.ServeHTTP(rec1, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", key, true))
		if rec1.Code != http.StatusInternalServerError {
			t.Fatalf("commit fail call: status=%d, muốn 500", rec1.Code)
		}

		// Hàng idempotency_key PHẢI được giữ nguyên (status = 'in_progress' vì tx thực tế chưa commit).
		var status string
		if err := env.pool.QueryRow(ctx, `SELECT status FROM idempotency_key WHERE user_id=$1 AND key=$2`, env.userA.UserID, key).Scan(&status); err != nil {
			t.Fatalf("hàng phải được giữ nguyên khi lỗi lúc COMMIT: %v", err)
		}
		if status != "in_progress" {
			t.Fatalf("status = %q, muốn in_progress", status)
		}

		// Retry ngay lập tức (< 60s) bị từ chối với 409 idempotency_in_progress, mutation KHÔNG chạy lần 2.
		rec2 := httptest.NewRecorder()
		r.ServeHTTP(rec2, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", key, true))
		if rec2.Code != http.StatusConflict {
			t.Fatalf("immediate retry after ambiguous commit: status=%d, muốn 409", rec2.Code)
		}
		if mutations.Load() != 1 {
			t.Fatalf("mutations = %d, muốn 1 (không chạy hai lần)", mutations.Load())
		}
	})

	// 3. Lỗi sau COMMIT (ví dụ gửi notice/mail hoặc handler trả 500 sau khi tx đã commit) KHÔNG xóa hàng done.
	t.Run("post_commit_error_keeps_done_row_and_replays_saved_response", func(t *testing.T) {
		var mutations atomic.Int32
		r := chi.NewRouter()
		h := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
			AppOrigin:     testAppOrigin,
			Authenticator: env.authn(),
			CSRF:          strictCSRF{},
			Idempotency:   env.idem,
		}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mutations.Add(1)
			tx, err := httpx.BeginMutationTx(r.Context(), env.pool)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(r.Context()) }()

			resp := []byte(`{"version":9}`)
			if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusOK, resp); err != nil {
				t.Fatal(err)
			}
			// Giả lập lỗi xảy ra SAU khi COMMIT thành công (ví dụ bước phụ trợ báo lỗi 500).
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi sau commit.")
		}))
		r.Method(http.MethodPut, "/api/v1/vault/kek", h)

		key := "idem_post_commit_01"
		body := `{"try":"post_commit"}`

		rec1 := httptest.NewRecorder()
		r.ServeHTTP(rec1, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", key, true))
		if rec1.Code != http.StatusInternalServerError {
			t.Fatalf("post-commit error call: status=%d, muốn 500", rec1.Code)
		}

		// Hàng done vẫn còn nguyên trong DB; retry tiếp theo trả ngay 200 {"version":9} và không chạy lại mutation.
		rec2 := httptest.NewRecorder()
		r.ServeHTTP(rec2, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", key, true))
		if rec2.Code != http.StatusOK || !jsonEqual(t, rec2.Body.Bytes(), []byte(`{"version":9}`)) {
			t.Fatalf("retry after post-commit error: status=%d body=%s", rec2.Code, rec2.Body.String())
		}
		if mutations.Load() != 1 {
			t.Fatalf("mutations = %d, muốn 1", mutations.Load())
		}
	})
}

func TestIdempotencySlowRequestOver60sTakenOverAndRolledBack(t *testing.T) {
	env := newIdemTestEnv(t)
	ctx := context.Background()

	// Tạo sẵn một vault ở version 1 để kiểm chứng số lần commit thực tế lên bảng vault.
	if _, err := env.pool.Exec(ctx, `
		INSERT INTO vault (user_id, version, kdf, vault_key_id, vault_key_wrapped_by_kek, x25519_public, ed25519_public, private_keys_wrapped)
		VALUES ($1, 1, '{"alg":"argon2id13"}'::jsonb, $2, '\x01', '\x02', '\x03', '\x04')
	`, env.userA.UserID, validTestVaultKeyID); err != nil {
		t.Fatal(err)
	}

	req1Claimed := make(chan struct{})
	req2Done := make(chan struct{})
	var callNum atomic.Int32

	r := chi.NewRouter()
	h := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:     testAppOrigin,
		Authenticator: env.authn(),
		CSRF:          strictCSRF{},
		Idempotency:   env.idem,
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callNum.Add(1)
		if n == 1 {
			// Request 1 đã claim xong ở bước 6, nhưng bị trễ trước khi mở tx / chạm vào dòng vault.
			close(req1Claimed)
			<-req2Done
		}

		tx, err := httpx.BeginMutationTx(r.Context(), env.pool)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() { _ = tx.Rollback(r.Context()) }()

		var newVer int32
		if err := tx.QueryRow(r.Context(), `UPDATE vault SET version = version + 1 WHERE user_id = $1 RETURNING version`, env.userA.UserID).Scan(&newVer); err != nil {
			t.Error(err)
			return
		}
		resp := []byte(`{"version":` + strconv.Itoa(int(newVer)) + `}`)
		if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusOK, resp); err != nil {
			if errors.Is(err, httpx.ErrIdempotencyOwnerMismatch) {
				httpx.WriteProblem(w, r, http.StatusConflict, "idempotency_conflict", "Claim idempotency đã bị thay thế.")
				return
			}
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}))
	r.Method(http.MethodPut, "/api/v1/vault/kek", h)

	key := "idem_slow_takeover_01"
	body := `{"kdf":"takeover"}`

	rec1 := httptest.NewRecorder()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		r.ServeHTTP(rec1, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", key, true))
	}()

	<-req1Claimed

	// Dịch đồng hồ 61 giây (> 60 giây): Request 2 cùng key + cùng fingerprint giành lại claim,
	// chạy mutation và commit thành công (version tăng từ 1 lên 2).
	env.clk.Advance(61 * time.Second)
	rec2 := httptest.NewRecorder()
	r.ServeHTTP(rec2, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", key, true))
	if rec2.Code != http.StatusOK || rec2.Body.String() != `{"version":2}` {
		t.Fatalf("req2 takeover: status=%d body=%s", rec2.Code, rec2.Body.String())
	}

	// Cho phép Request 1 chạy tiếp tới bước FinishIdempotencyTx -> phát hiện owner_token không khớp,
	// rollback toàn bộ mutation của Request 1.
	close(req2Done)
	wg.Wait()

	if rec1.Code != http.StatusConflict {
		t.Fatalf("req1 after takeover: status=%d, muốn 409", rec1.Code)
	}

	// Kiểm tra vault.version trong DB chỉ tăng ĐÚNG MỘT LẦN (bằng 2, không phải 3) và hàng idempotency_key giữ kết quả của Request 2.
	var ver int32
	if err := env.pool.QueryRow(ctx, `SELECT version FROM vault WHERE user_id = $1`, env.userA.UserID).Scan(&ver); err != nil {
		t.Fatal(err)
	}
	if ver != 2 {
		t.Fatalf("vault.version = %d, muốn 2 (mutation chỉ commit đúng 1 lần)", ver)
	}
	var status string
	var respBytes []byte
	if err := env.pool.QueryRow(ctx, `SELECT status, response FROM idempotency_key WHERE user_id=$1 AND key=$2`, env.userA.UserID, key).Scan(&status, &respBytes); err != nil {
		t.Fatal(err)
	}
	if status != "done" || !jsonEqual(t, respBytes, []byte(`{"version":2}`)) {
		t.Fatalf("idempotency row: status=%q response=%s", status, string(respBytes))
	}
}

func TestIdempotencyExpiredUnprunedRowReclaimedWithNewFingerprintExpiresAtAndStatus(t *testing.T) {
	env := newIdemTestEnv(t)
	ctx := context.Background()

	var step atomic.Int32
	r := chi.NewRouter()
	h := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:     testAppOrigin,
		Authenticator: env.authn(),
		CSRF:          strictCSRF{},
		Idempotency:   env.idem,
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s := step.Add(1)
		tx, err := httpx.BeginMutationTx(r.Context(), env.pool)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(r.Context()) }()

		if s == 2 {
			// Ở bước 2 (khi vừa reclaim với fingerprint mới), kiểm tra ngay trạng thái in_progress,
			// fingerprint mới và expires_at mới trên DB trước khi kết thúc handler.
			var row gen.IdempotencyKey
			err := env.pool.QueryRow(r.Context(), `
				SELECT method, path, request_hash, status, expires_at, status_code, response
				FROM idempotency_key WHERE user_id = $1 AND key = $2
			`, env.userA.UserID, "idem_expired_reclaim_01").Scan(
				&row.Method, &row.Path, &row.RequestHash, &row.Status, &row.ExpiresAt, &row.StatusCode, &row.Response,
			)
			if err != nil {
				t.Errorf("scan in_progress reclaimed row: %v", err)
			}
			wantExp := env.clk.Now().UTC().Add(24 * time.Hour)
			if row.Status != "in_progress" || !row.ExpiresAt.Time.UTC().Equal(wantExp) || row.StatusCode != nil || row.Response != nil {
				t.Errorf("reclaimed in_progress row: status=%q expires_at=%v status_code=%v response=%v",
					row.Status, row.ExpiresAt.Time, row.StatusCode, row.Response)
			}
		}

		resp := []byte(`{"step":` + strconv.Itoa(int(s)) + `}`)
		if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusOK, resp); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}))
	r.Method(http.MethodPost, "/api/v1/vault", h)
	r.Method(http.MethodPut, "/api/v1/vault/kek", h)

	key := "idem_expired_reclaim_01"

	// 1. Tại T0: tạo bản ghi done với body1 trên POST /api/v1/vault (expires_at = T0 + 24h).
	t0 := env.clk.Now().UTC()
	rec1 := httptest.NewRecorder()
	r.ServeHTTP(rec1, env.newReq(http.MethodPost, "/api/v1/vault", `{"body":1}`, "sess-a", key, true))
	if rec1.Code != http.StatusOK || rec1.Body.String() != `{"step":1}` {
		t.Fatalf("step 1: status=%d body=%s", rec1.Code, rec1.Body.String())
	}

	var firstFP []byte
	var firstExp time.Time
	if err := env.pool.QueryRow(ctx, `SELECT request_hash, expires_at FROM idempotency_key WHERE user_id=$1 AND key=$2`, env.userA.UserID, key).Scan(&firstFP, &firstExp); err != nil {
		t.Fatal(err)
	}
	if !firstExp.UTC().Equal(t0.Add(24 * time.Hour)) {
		t.Fatalf("first expires_at = %v, muốn %v", firstExp.UTC(), t0.Add(24*time.Hour))
	}

	// 2. Dịch đồng hồ đúng 24 giờ + 1 giây (hàng đã quá expires_at nhưng worker chưa chạy prune):
	// Gửi cùng key nhưng tới path khác + body khác -> được reclaim thành công với fingerprint, expires_at và status mới.
	env.clk.Advance(24*time.Hour + time.Second)
	t1 := env.clk.Now().UTC()

	rec2 := httptest.NewRecorder()
	r.ServeHTTP(rec2, env.newReq(http.MethodPut, "/api/v1/vault/kek", `{"body":2}`, "sess-a", key, true))
	if rec2.Code != http.StatusOK || rec2.Body.String() != `{"step":2}` {
		t.Fatalf("step 2 reclaim: status=%d body=%s", rec2.Code, rec2.Body.String())
	}

	var secondFP []byte
	var secondExp time.Time
	var secondStatus, secondMethod, secondPath string
	if err := env.pool.QueryRow(ctx, `
		SELECT method, path, request_hash, status, expires_at
		FROM idempotency_key WHERE user_id=$1 AND key=$2
	`, env.userA.UserID, key).Scan(&secondMethod, &secondPath, &secondFP, &secondStatus, &secondExp); err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(firstFP, secondFP) {
		t.Fatal("fingerprint sau khi reclaim phải là fingerprint mới")
	}
	if !secondExp.UTC().Equal(t1.Add(24 * time.Hour)) {
		t.Fatalf("second expires_at = %v, muốn %v", secondExp.UTC(), t1.Add(24*time.Hour))
	}
	if secondStatus != "done" || secondMethod != http.MethodPut || secondPath != "/api/v1/vault/kek" {
		t.Fatalf("reclaimed row: method=%q path=%q status=%q", secondMethod, secondPath, secondStatus)
	}
}

func pgxTimestamptz(t time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: t.UTC(), Valid: true}
}

func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var va, vb any
	if err := json.Unmarshal(a, &va); err != nil {
		return false
	}
	if err := json.Unmarshal(b, &vb); err != nil {
		return false
	}
	ca, err := json.Marshal(va)
	if err != nil {
		return false
	}
	cb, err := json.Marshal(vb)
	if err != nil {
		return false
	}
	return bytes.Equal(ca, cb)
}
