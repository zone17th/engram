package httpx_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	"github.com/jackc/pgx/v5/pgconn"
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
	var entryRuns atomic.Int32

	r := chi.NewRouter()

	// Route non-vault (ví dụ P04 POST /api/v1/entries) dùng để chứng minh reset vault chỉ xóa
	// các key trên `/api/v1/vault%` và giữ nguyên bản ghi hoàn tất của route khác cho cùng user.
	entryHandler := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:     testAppOrigin,
		Authenticator: env.authn(),
		CSRF:          strictCSRF{},
		Idempotency:   env.idem,
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entryRuns.Add(1)
		tx, err := httpx.BeginMutationTx(r.Context(), env.pool)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		respBytes := []byte(`{"entry_id":"e-1","status":"saved"}`)
		if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusCreated, respBytes); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(respBytes)
	}))
	r.Method(http.MethodPost, "/api/v1/entries", entryHandler)
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

	// 4b. Tạo thêm một bản ghi done trên route vault khác (`/api/v1/vault/passkeys`) và một bản ghi done,
	// chưa hết hạn trên route KHÔNG phải vault (`/api/v1/entries`) cho cùng userA trước khi reset vault.
	keyOtherVault := "idem_passkey_key_0001"
	if _, err := env.pool.Exec(ctx, `
		INSERT INTO idempotency_key (
			user_id, key, method, path, request_hash, status, owner_token,
			claimed_at, expires_at, status_code, response
		) VALUES ($1, $2, 'POST', '/api/v1/vault/passkeys', '\xaa', 'done', $3, $4, $5, 201, '{"id":"pk-1"}'::jsonb)
	`, env.userA.UserID, keyOtherVault, uuid.New(), env.clk.Now().UTC(), env.clk.Now().UTC().Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}

	keyNonVault := "idem_nonvault_key_01"
	bodyNonVault := `{"title":"note-1"}`
	recEntry1 := httptest.NewRecorder()
	r.ServeHTTP(recEntry1, env.newReq(http.MethodPost, "/api/v1/entries", bodyNonVault, "sess-a", keyNonVault, true))
	if recEntry1.Code != http.StatusCreated || entryRuns.Load() != 1 {
		t.Fatalf("first non-vault entry: status=%d runs=%d", recEntry1.Code, entryRuns.Load())
	}

	// 5. DELETE /api/v1/vault (204 không body, không Content-Type): lần 1 chạy mutation và purge các key
	// trên `/api/v1/vault%` (keyCreate, keyOtherVault) nhưng giữ nguyên keyNonVault (`/api/v1/entries`)
	// và giữ chính keyDelete để lần 2 trả lại 204 không body.
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

	// Kiểm tra trong DB: keyCreate và keyOtherVault đã bị purge bởi reset vault;
	// chỉ còn đúng 2 bản ghi: keyDelete (204, response IS NULL) và keyNonVault (201, response còn nguyên).
	var remaining int
	if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1`, env.userA.UserID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 2 {
		t.Fatalf("sau reset vault, số idempotency_key còn lại = %d, muốn 2 (keyDelete và keyNonVault)", remaining)
	}
	var savedCode int32
	var respNull bool
	if err := env.pool.QueryRow(ctx, `SELECT status_code, response IS NULL FROM idempotency_key WHERE user_id = $1 AND key = $2`, env.userA.UserID, keyDelete).Scan(&savedCode, &respNull); err != nil {
		t.Fatal(err)
	}
	if savedCode != http.StatusNoContent || !respNull {
		t.Fatalf("204 row: status_code=%d responseIsNull=%v", savedCode, respNull)
	}

	var nonVaultStatus string
	var nonVaultCode int32
	var nonVaultResp []byte
	if err := env.pool.QueryRow(ctx, `SELECT status, status_code, response FROM idempotency_key WHERE user_id = $1 AND key = $2`, env.userA.UserID, keyNonVault).Scan(&nonVaultStatus, &nonVaultCode, &nonVaultResp); err != nil {
		t.Fatalf("keyNonVault phải sống sót sau reset vault: %v", err)
	}
	if nonVaultStatus != "done" || nonVaultCode != http.StatusCreated || !jsonEqual(t, nonVaultResp, []byte(`{"entry_id":"e-1","status":"saved"}`)) {
		t.Fatalf("non-vault row sau reset: status=%q code=%d resp=%s", nonVaultStatus, nonVaultCode, string(nonVaultResp))
	}

	// Retry keyNonVault sau khi reset vault vẫn replay đúng response đã lưu, không chạy lại handler.
	recEntryReplay := httptest.NewRecorder()
	r.ServeHTTP(recEntryReplay, env.newReq(http.MethodPost, "/api/v1/entries", bodyNonVault, "sess-a", keyNonVault, true))
	if recEntryReplay.Code != http.StatusCreated || !jsonEqual(t, recEntryReplay.Body.Bytes(), []byte(`{"entry_id":"e-1","status":"saved"}`)) || entryRuns.Load() != 1 {
		t.Fatalf("non-vault replay after reset: status=%d body=%s runs=%d", recEntryReplay.Code, recEntryReplay.Body.String(), entryRuns.Load())
	}
}

func TestIdempotencyParallelRequestsAndLostClaimRaceReclassified(t *testing.T) {
	env := newIdemTestEnv(t)

	// Phần A: Hai request song song cùng key + cùng fingerprint -> một request đang chạy trong handler,
	// request thứ hai bị chặn ngay ở Lookup với 409 idempotency_in_progress + Retry-After: 1.
	enteredHandler := make(chan struct{})
	releaseHandler := make(chan struct{})
	var releaseOnce sync.Once
	releaseReq1 := func() { releaseOnce.Do(func() { close(releaseHandler) }) }
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
	req1Done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer close(req1Done)
		r.ServeHTTP(rec1, env.newReq(http.MethodPut, "/api/v1/vault/kek", bodyParallel, "sess-a", keyParallel, true))
	}()
	defer func() {
		releaseReq1()
		wg.Wait()
	}()

	select {
	case <-enteredHandler:
	case <-req1Done:
		t.Fatalf("parallel req1 kết thúc sớm trước khi vào handler: status=%d body=%s", rec1.Code, rec1.Body.String())
	case <-time.After(10 * time.Second):
		t.Fatal("timeout chờ parallel req1 vào handler")
	}
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

	releaseReq1()
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

	t.Run("lost_claim_race_winner_releases_before_reread_returns_409_not_500", func(t *testing.T) {
		raceKey := "idem_claim_race_rel_01"
		body := `{"race":"winner_released"}`

		winnerEntered := make(chan struct{})
		releaseWinner := make(chan struct{})
		var releaseWinnerOnce sync.Once
		closeReleaseWinner := func() { releaseWinnerOnce.Do(func() { close(releaseWinner) }) }
		winnerReleased := make(chan struct{})

		var winnerShouldFail atomic.Bool
		winnerShouldFail.Store(true)
		var subRuns atomic.Int32

		subIdem := httpx.NewIdempotency(env.pool, env.clk)
		subRouter := chi.NewRouter()
		subHandler := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
			AppOrigin:     testAppOrigin,
			Authenticator: env.authn(),
			CSRF:          strictCSRF{},
			Idempotency:   subIdem,
		}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if winnerShouldFail.Load() {
				close(winnerEntered)
				<-releaseWinner
				// Winner thất bại trước COMMIT -> defer của Claim sẽ release (DELETE) hàng in_progress.
				httpx.WriteProblem(w, r, http.StatusBadRequest, "vault_kdf_invalid", "KDF lỗi trước commit.")
				return
			}
			subRuns.Add(1)
			tx, err := httpx.BeginMutationTx(r.Context(), env.pool)
			if err != nil {
				t.Error(err)
				return
			}
			defer func() { _ = tx.Rollback(r.Context()) }()
			resp := []byte(`{"version":10}`)
			if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusOK, resp); err != nil {
				t.Error(err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(resp)
		}))
		subRouter.Method(http.MethodPut, "/api/v1/vault/kek", subHandler)

		// Đồng bộ:
		// 1. Loser chạy qua Lookup (chưa có hàng), đến ngay trước SQL Claim thì tạm dừng ở onClaimRace.
		// 2. Trong lúc đó, Winner chạy thật từ đầu qua Lookup + Claim, vào handler và giữ hàng in_progress.
		// 3. Loser chạy SQL Claim -> thua race (!won). Ngay trước khi Loser chạy GetIdempotencyKey (onClaimReread),
		//    cho phép Winner trả 400 và hoàn tất defer ReleaseIdempotencyKey (xóa hàng khỏi Postgres thật).
		// 4. Loser chạy GetIdempotencyKey -> nhận pgx.ErrNoRows -> phải trả 409 idempotency_in_progress + Retry-After: 1 (không được 500).
		var raceHookEntered atomic.Bool
		var winnerRec *httptest.ResponseRecorder
		subIdem.SetClaimRaceHookForTest(func() {
			if !raceHookEntered.CompareAndSwap(false, true) {
				return
			}
			winnerRec = httptest.NewRecorder()
			go func() {
				defer close(winnerReleased)
				subRouter.ServeHTTP(winnerRec, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", raceKey, true))
			}()
			select {
			case <-winnerEntered:
			case <-winnerReleased:
				t.Errorf("winner kết thúc sớm trước khi vào handler: status=%d", winnerRec.Code)
			case <-time.After(10 * time.Second):
				t.Error("timeout chờ winner vào handler")
			}
		})
		defer subIdem.SetClaimRaceHookForTest(nil)

		var rereadHookOnce sync.Once
		subIdem.SetClaimRereadHookForTest(func() {
			rereadHookOnce.Do(func() {
				closeReleaseWinner()
				select {
				case <-winnerReleased:
				case <-time.After(10 * time.Second):
					t.Error("timeout chờ winner release hàng")
				}
			})
		})
		defer subIdem.SetClaimRereadHookForTest(nil)
		defer func() {
			closeReleaseWinner()
		}()

		loserRec := httptest.NewRecorder()
		subRouter.ServeHTTP(loserRec, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", raceKey, true))
		if loserRec.Code != http.StatusConflict {
			t.Fatalf("loser reread after winner pre-commit release: status=%d body=%s, muốn 409 (không được 500)", loserRec.Code, loserRec.Body.String())
		}
		if gotRetry := loserRec.Header().Get("Retry-After"); gotRetry != "1" {
			t.Fatalf("loser Retry-After=%q, muốn 1", gotRetry)
		}
		var loserProb httpx.Problem
		if err := json.Unmarshal(loserRec.Body.Bytes(), &loserProb); err != nil {
			t.Fatal(err)
		}
		if loserProb.Code != "idempotency_in_progress" || loserProb.RetryAfter == nil || *loserProb.RetryAfter != 1 {
			t.Fatalf("loser problem: code=%q retry_after=%v", loserProb.Code, loserProb.RetryAfter)
		}
		if winnerRec == nil || winnerRec.Code != http.StatusBadRequest {
			t.Fatalf("winner status=%v, muốn 400", winnerRec)
		}

		// Sau khi cả hai kết thúc, client retry cùng key -> chạy thành công và commit đúng 1 mutation.
		winnerShouldFail.Store(false)
		retryRec := httptest.NewRecorder()
		subRouter.ServeHTTP(retryRec, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", raceKey, true))
		if retryRec.Code != http.StatusOK || !jsonEqual(t, retryRec.Body.Bytes(), []byte(`{"version":10}`)) || subRuns.Load() != 1 {
			t.Fatalf("retry after release: status=%d body=%s subRuns=%d", retryRec.Code, retryRec.Body.String(), subRuns.Load())
		}

		// Lỗi DB thực sự ở bước đọc lại sau thua race vẫn phải fail-closed (500 internal_error).
		errDB := &rereadFailIdempotencyDB{IdempotencyDB: env.pool, rereadErr: errors.New("simulated db failure on reread")}
		errIdem := httpx.NewIdempotency(errDB, env.clk)
		errRouter := chi.NewRouter()
		errHandler := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
			AppOrigin:     testAppOrigin,
			Authenticator: env.authn(),
			CSRF:          strictCSRF{},
			Idempotency:   errIdem,
		}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Fatal("handler không được chạy khi lỗi DB")
		}))
		errRouter.Method(http.MethodPut, "/api/v1/vault/kek", errHandler)

		errKey := "idem_claim_race_dberr1"
		errIdem.SetClaimRaceHookForTest(func() {
			_, err := gen.New(env.pool).ClaimIdempotencyKey(context.Background(), gen.ClaimIdempotencyKeyParams{
				UserID:      env.userA.UserID,
				Key:         errKey,
				Method:      http.MethodPut,
				Path:        "/api/v1/vault/kek",
				RequestHash: httpx.ComputeIdempotencyFingerprint(http.MethodPut, "/api/v1/vault/kek", []byte(body)),
				OwnerToken:  uuid.New(),
				Now:         pgxTimestamptz(env.clk.Now()),
			})
			if err != nil {
				t.Errorf("concurrent claim for errDB: %v", err)
			}
			errDB.failNextQuery.Store(true)
		})
		defer errIdem.SetClaimRaceHookForTest(nil)

		errRec := httptest.NewRecorder()
		errRouter.ServeHTTP(errRec, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", errKey, true))
		if errRec.Code != http.StatusInternalServerError {
			t.Fatalf("DB error on reread: status=%d, muốn 500", errRec.Code)
		}
	})
}

type rereadFailIdempotencyDB struct {
	httpx.IdempotencyDB
	failNextQuery atomic.Bool
	rereadErr     error
}

func (d *rereadFailIdempotencyDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if d.failNextQuery.CompareAndSwap(true, false) {
		return errRow{err: d.rereadErr}
	}
	return d.IdempotencyDB.QueryRow(ctx, sql, args...)
}

func (d *rereadFailIdempotencyDB) Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	return d.IdempotencyDB.Exec(ctx, sql, arguments...)
}

type errRow struct {
	err error
}

func (r errRow) Scan(_ ...any) error {
	return r.err
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
	_ = f.Rollback(ctx)
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
	var releaseOnce sync.Once
	releaseReq1 := func() { releaseOnce.Do(func() { close(req2Done) }) }
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
	req1Finished := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer close(req1Finished)
		r.ServeHTTP(rec1, env.newReq(http.MethodPut, "/api/v1/vault/kek", body, "sess-a", key, true))
	}()
	defer func() {
		releaseReq1()
		wg.Wait()
	}()

	select {
	case <-req1Claimed:
	case <-req1Finished:
		t.Fatalf("req1 kết thúc sớm trước khi vào handler: status=%d body=%s", rec1.Code, rec1.Body.String())
	case <-time.After(10 * time.Second):
		t.Fatal("timeout chờ req1 claim và vào handler")
	}
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
	releaseReq1()
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

func TestIdempotencyRawReceivedPathFingerprintingAndWireRequests(t *testing.T) {
	env := newIdemTestEnv(t)
	ctx := context.Background()

	var runs atomic.Int32
	mux := http.NewServeMux()
	h := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:     testAppOrigin,
		Authenticator: env.authn(),
		CSRF:          strictCSRF{},
		Idempotency:   env.idem,
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := runs.Add(1)
		tx, err := httpx.BeginMutationTx(r.Context(), env.pool)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		resp := []byte(fmt.Sprintf(`{"run":%d}`, n))
		if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusOK, resp); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}))
	mux.Handle("/", h)

	readWireReq := func(target, body, idemKey string) *http.Request {
		t.Helper()
		raw := fmt.Sprintf(
			"POST %s HTTP/1.1\r\n"+
				"Host: localhost:3000\r\n"+
				"Origin: %s\r\n"+
				"Content-Type: application/json\r\n"+
				"Cookie: sabk_session=sess-a; sabk_csrf=csrf-valid\r\n"+
				"X-CSRF-Token: csrf-valid\r\n"+
				"Idempotency-Key: %s\r\n"+
				"Content-Length: %d\r\n"+
				"\r\n"+
				"%s",
			target, testAppOrigin, idemKey, len(body), body,
		)
		req, err := http.ReadRequest(bufio.NewReader(strings.NewReader(raw)))
		if err != nil {
			t.Fatalf("ReadRequest(%q): %v", target, err)
		}
		return req
	}

	body := `{"v":1}`

	// 1. Canonical percent-encoded UTF-8 (`%C3%A9`) vs literal UTF-8 (`é`):
	// Phải lưu đúng chuỗi path thô đã nhận `/api/v1/items/caf%C3%A9/entries`,
	// và khi gửi cùng key tới `/api/v1/items/café/entries` phải bị 409 idempotency_conflict.
	keyUTF8 := "idem_rawpath_utf8_0001"
	targetEncoded := "/api/v1/items/caf%C3%A9/entries"
	targetLiteral := "/api/v1/items/café/entries"

	recEnc := httptest.NewRecorder()
	mux.ServeHTTP(recEnc, readWireReq(targetEncoded, body, keyUTF8))
	if recEnc.Code != http.StatusOK {
		t.Fatalf("encoded target: status=%d body=%s", recEnc.Code, recEnc.Body.String())
	}

	var savedPath string
	var savedHash []byte
	if err := env.pool.QueryRow(ctx, `SELECT path, request_hash FROM idempotency_key WHERE user_id=$1 AND key=$2`, env.userA.UserID, keyUTF8).Scan(&savedPath, &savedHash); err != nil {
		t.Fatal(err)
	}
	if savedPath != targetEncoded {
		t.Fatalf("saved path = %q, muốn %q", savedPath, targetEncoded)
	}
	wantHash := httpx.ComputeIdempotencyFingerprint(http.MethodPost, targetEncoded, []byte(body))
	if !bytes.Equal(savedHash, wantHash) {
		t.Fatalf("saved hash = %x, muốn %x", savedHash, wantHash)
	}

	// Gửi cùng key nhưng request-target là literal UTF-8 -> 409 idempotency_conflict.
	recLit := httptest.NewRecorder()
	mux.ServeHTTP(recLit, readWireReq(targetLiteral, body, keyUTF8))
	if recLit.Code != http.StatusConflict {
		t.Fatalf("literal UTF-8 with same key: status=%d, muốn 409", recLit.Code)
	}

	// Gửi cùng key với cách viết hex khác (`%c3%a9` chữ thường) -> 409 idempotency_conflict.
	recLowerHex := httptest.NewRecorder()
	mux.ServeHTTP(recLowerHex, readWireReq("/api/v1/items/caf%c3%a9/entries", body, keyUTF8))
	if recLowerHex.Code != http.StatusConflict {
		t.Fatalf("alternate hex case with same key: status=%d, muốn 409", recLowerHex.Code)
	}

	// 2. `%20` và query string: query string phải bị loại bỏ khỏi path lưu và fingerprint,
	// nhưng `%20` phải được giữ nguyên không decode thành dấu cách.
	keySpace := "idem_rawpath_space_001"
	recSpace := httptest.NewRecorder()
	mux.ServeHTTP(recSpace, readWireReq("/api/v1/items/a%20b/entries?foo=1&bar=2", body, keySpace))
	if recSpace.Code != http.StatusOK {
		t.Fatalf("space target: status=%d body=%s", recSpace.Code, recSpace.Body.String())
	}
	if err := env.pool.QueryRow(ctx, `SELECT path, request_hash FROM idempotency_key WHERE user_id=$1 AND key=$2`, env.userA.UserID, keySpace).Scan(&savedPath, &savedHash); err != nil {
		t.Fatal(err)
	}
	wantSpacePath := "/api/v1/items/a%20b/entries"
	if savedPath != wantSpacePath {
		t.Fatalf("space saved path = %q, muốn %q", savedPath, wantSpacePath)
	}
	if !bytes.Equal(savedHash, httpx.ComputeIdempotencyFingerprint(http.MethodPost, wantSpacePath, []byte(body))) {
		t.Fatal("space saved hash không khớp fingerprint của raw path không kèm query")
	}
	// Replay với query string khác nhưng cùng raw path -> trả 200 replay, không tăng runs.
	beforeRuns := runs.Load()
	recSpaceReplay := httptest.NewRecorder()
	mux.ServeHTTP(recSpaceReplay, readWireReq("/api/v1/items/a%20b/entries?other=9", body, keySpace))
	if recSpaceReplay.Code != http.StatusOK || runs.Load() != beforeRuns {
		t.Fatalf("replay with different query: status=%d runs=%d (before=%d)", recSpaceReplay.Code, runs.Load(), beforeRuns)
	}

	// 3. `%3F` (encoded `?` trong segment path) và alternate escape spelling (`%7E` vs `~`):
	keyQMark := "idem_rawpath_qmark_001"
	wantQMarkPath := "/api/v1/items/a%3Fb/entries"
	recQMark := httptest.NewRecorder()
	mux.ServeHTTP(recQMark, readWireReq(wantQMarkPath+"?real_query=1", body, keyQMark))
	if recQMark.Code != http.StatusOK {
		t.Fatalf("qmark target: status=%d body=%s", recQMark.Code, recQMark.Body.String())
	}
	if err := env.pool.QueryRow(ctx, `SELECT path, request_hash FROM idempotency_key WHERE user_id=$1 AND key=$2`, env.userA.UserID, keyQMark).Scan(&savedPath, &savedHash); err != nil {
		t.Fatal(err)
	}
	if savedPath != wantQMarkPath {
		t.Fatalf("qmark saved path = %q, muốn %q", savedPath, wantQMarkPath)
	}
	if !bytes.Equal(savedHash, httpx.ComputeIdempotencyFingerprint(http.MethodPost, wantQMarkPath, []byte(body))) {
		t.Fatal("qmark saved hash không khớp")
	}
	// Nếu gửi `/api/v1/items/a?b/entries` (trong đó `?` là query delimiter thực sự, path chỉ là `/api/v1/items/a`) -> 409 conflict.
	recUnescapedQMark := httptest.NewRecorder()
	mux.ServeHTTP(recUnescapedQMark, readWireReq("/api/v1/items/a?b/entries", body, keyQMark))
	if recUnescapedQMark.Code != http.StatusConflict {
		t.Fatalf("unescaped ? with same key: status=%d, muốn 409", recUnescapedQMark.Code)
	}

	// Alternate escape spelling cho unreserved char (`%7E` vs `~`):
	keyTilde := "idem_rawpath_tilde_001"
	recTildeEnc := httptest.NewRecorder()
	mux.ServeHTTP(recTildeEnc, readWireReq("/api/v1/items/%7Euser/entries", body, keyTilde))
	if recTildeEnc.Code != http.StatusOK {
		t.Fatalf("tilde encoded: status=%d", recTildeEnc.Code)
	}
	if err := env.pool.QueryRow(ctx, `SELECT path FROM idempotency_key WHERE user_id=$1 AND key=$2`, env.userA.UserID, keyTilde).Scan(&savedPath); err != nil {
		t.Fatal(err)
	}
	if savedPath != "/api/v1/items/%7Euser/entries" {
		t.Fatalf("tilde saved path = %q, muốn /api/v1/items/%%7Euser/entries", savedPath)
	}
	recTildeRaw := httptest.NewRecorder()
	mux.ServeHTTP(recTildeRaw, readWireReq("/api/v1/items/~user/entries", body, keyTilde))
	if recTildeRaw.Code != http.StatusConflict {
		t.Fatalf("tilde unencoded with same key: status=%d, muốn 409", recTildeRaw.Code)
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
