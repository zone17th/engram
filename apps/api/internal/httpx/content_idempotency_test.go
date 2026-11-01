package httpx_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/zone17th/engram/apps/api/internal/httpx"
)

type failingMidwayReader struct {
	prefix []byte
	read   int
}

func (r *failingMidwayReader) Read(p []byte) (int, error) {
	if r.read < len(r.prefix) {
		n := copy(p, r.prefix[r.read:])
		r.read += n
		return n, nil
	}
	return 0, errors.New("simulated connection reset mid-body")
}

func TestContentRateLimitDefaultRule10PerSecondAndMaxWindowUnchanged(t *testing.T) {
	rules := httpx.DefaultUserLimitRules()
	rule, ok := rules[httpx.ScopeContentWrite]
	if !ok {
		t.Fatalf("DefaultUserLimitRules missing %q", httpx.ScopeContentWrite)
	}
	if rule.Limit != 10 || rule.Window != time.Second {
		t.Fatalf("ScopeContentWrite rule = %+v, want Limit=10 Window=1s", rule)
	}
	if httpx.MaxRateLimitWindow != 15*time.Minute {
		t.Fatalf("MaxRateLimitWindow = %v, want 15m", httpx.MaxRateLimitWindow)
	}
}

func TestIdempotencyBodyLimitBeforeLookupAndTxErrorMapping(t *testing.T) {
	env := newIdemTestEnv(t)
	ctx := context.Background()

	var entryCalls atomic.Int32
	var itemCalls atomic.Int32
	var vaultCalls atomic.Int32
	var lastReceivedBody []byte

	r := chi.NewRouter()

	entryHandler := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:        testAppOrigin,
		Authenticator:    env.authn(),
		CSRF:             strictCSRF{},
		Idempotency:      env.idem,
		AllowEmptyDelete: true,
		BodyLimit:        httpx.ContentEntryBodyLimit,
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entryCalls.Add(1)
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("handler ReadAll: %v", err)
		}
		lastReceivedBody = b
		tx, err := httpx.BeginMutationTx(r.Context(), env.pool)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		resp := []byte(`{"ok":true}`)
		if err := httpx.CommitIdempotencyTx(r.Context(), tx, http.StatusCreated, resp); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(resp)
	}))

	itemHandler := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:        testAppOrigin,
		Authenticator:    env.authn(),
		CSRF:             strictCSRF{},
		Idempotency:      env.idem,
		AllowEmptyDelete: true,
		BodyLimit:        httpx.ContentItemTagBodyLimit,
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		itemCalls.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))

	// P03 route (zero BodyLimit) keeps 512 KiB limit -> 413 invalid_request.
	vaultHandler := httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
		AppOrigin:     testAppOrigin,
		Authenticator: env.authn(),
		CSRF:          strictCSRF{},
		Idempotency:   env.idem,
	}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		vaultCalls.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))

	r.Method(http.MethodPost, "/api/v1/items/{id}/entries", entryHandler)
	r.Method(http.MethodPost, "/api/v1/items", itemHandler)
	r.Method(http.MethodPost, "/api/v1/vault", vaultHandler)

	countIdemRows := func(key string) int {
		var n int
		if err := env.pool.QueryRow(ctx, `SELECT count(*) FROM idempotency_key WHERE user_id = $1 AND key = $2`, env.userA.UserID, key).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	makeReqWithReader := func(path, idemKey string, rdr io.Reader, contentLen int64) *http.Request {
		req := httptest.NewRequest(http.MethodPost, path, rdr)
		req.ContentLength = contentLen
		req.Header.Set("Origin", testAppOrigin)
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "sess-a"})
		req.AddCookie(&http.Cookie{Name: "sabk_csrf", Value: "csrf-valid"})
		req.Header.Set("X-CSRF-Token", "csrf-valid")
		req.Header.Set("Idempotency-Key", idemKey)
		return req
	}

	// 1. Entry route: 400 KiB + 1 and 512 KiB + 1 with Content-Length and chunked (-1) -> 413 entry_too_large before Lookup/Claim.
	for _, size := range []int{int(httpx.ContentEntryJSONLimit) + 1, httpx.IdempotencyMaxBodyBytes + 1} {
		payload := strings.Repeat("x", size)
		for _, chunked := range []bool{false, true} {
			key := "idem_entry_over_" + strings.Repeat("a", 8)
			var req *http.Request
			if chunked {
				req = makeReqWithReader("/api/v1/items/11111111-1111-1111-1111-111111111111/entries", key, struct{ io.Reader }{Reader: strings.NewReader(payload)}, -1)
			} else {
				req = makeReqWithReader("/api/v1/items/11111111-1111-1111-1111-111111111111/entries", key, strings.NewReader(payload), int64(len(payload)))
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("size=%d chunked=%v: status=%d, want 413", size, chunked, rec.Code)
			}
			if prob := decodeProblem(t, rec); prob.Code != "entry_too_large" {
				t.Fatalf("size=%d chunked=%v: code=%q, want entry_too_large", size, chunked, prob.Code)
			}
			if countIdemRows(key) != 0 {
				t.Fatalf("size=%d chunked=%v: idempotency row must not be created", size, chunked)
			}
		}
	}

	// 2. Entry route: body at exact 400 KiB limit reaches handler intact and fingerprint matches for replay.
	exactBody := make([]byte, int(httpx.ContentEntryJSONLimit))
	exactBody[0] = '{'
	exactBody[1] = '"'
	exactBody[2] = 'a'
	exactBody[3] = '"'
	exactBody[4] = ':'
	exactBody[5] = '"'
	for i := 6; i < len(exactBody)-2; i++ {
		exactBody[i] = 'b'
	}
	exactBody[len(exactBody)-2] = '"'
	exactBody[len(exactBody)-1] = '}'
	keyExact := "idem_entry_exact_400kib_01"
	recExact := httptest.NewRecorder()
	r.ServeHTTP(recExact, makeReqWithReader("/api/v1/items/11111111-1111-1111-1111-111111111111/entries", keyExact, bytes.NewReader(exactBody), -1))
	if recExact.Code != http.StatusCreated {
		t.Fatalf("exact 400 KiB: status=%d body=%s", recExact.Code, recExact.Body.String())
	}
	if !bytes.Equal(lastReceivedBody, exactBody) {
		t.Fatalf("exact 400 KiB: handler received %d bytes, want exact %d bytes", len(lastReceivedBody), len(exactBody))
	}

	// Replay exact 400 KiB body -> returns 201 from Lookup without calling handler a second time.
	beforeCalls := entryCalls.Load()
	recReplay := httptest.NewRecorder()
	r.ServeHTTP(recReplay, makeReqWithReader("/api/v1/items/11111111-1111-1111-1111-111111111111/entries", keyExact, bytes.NewReader(exactBody), int64(len(exactBody))))
	if recReplay.Code != http.StatusCreated || entryCalls.Load() != beforeCalls {
		t.Fatalf("exact 400 KiB replay: status=%d calls=%d (before=%d)", recReplay.Code, entryCalls.Load(), beforeCalls)
	}

	// 3. Read error midway -> 400 invalid_request, no claim.
	keyReadErr := "idem_entry_read_err_0001"
	recReadErr := httptest.NewRecorder()
	r.ServeHTTP(recReadErr, makeReqWithReader("/api/v1/items/11111111-1111-1111-1111-111111111111/entries", keyReadErr, &failingMidwayReader{prefix: []byte(`{"partial":`)}, -1))
	if recReadErr.Code != http.StatusBadRequest || decodeProblem(t, recReadErr).Code != "invalid_request" {
		t.Fatalf("midway read error: status=%d body=%s, want 400 invalid_request", recReadErr.Code, recReadErr.Body.String())
	}
	if countIdemRows(keyReadErr) != 0 {
		t.Fatal("midway read error must not claim idempotency key")
	}

	// 4. Item route: 16 KiB + 1 -> 413 invalid_request.
	itemOver := strings.Repeat("y", int(httpx.ContentItemTagJSONLimit)+1)
	keyItemOver := "idem_item_over_16kib_01"
	recItemOver := httptest.NewRecorder()
	r.ServeHTTP(recItemOver, makeReqWithReader("/api/v1/items", keyItemOver, strings.NewReader(itemOver), int64(len(itemOver))))
	if recItemOver.Code != http.StatusRequestEntityTooLarge || decodeProblem(t, recItemOver).Code != "invalid_request" {
		t.Fatalf("item 16 KiB+1: status=%d body=%s, want 413 invalid_request", recItemOver.Code, recItemOver.Body.String())
	}
	if countIdemRows(keyItemOver) != 0 || itemCalls.Load() != 0 {
		t.Fatal("item 16 KiB+1 must not create idempotency row or invoke handler")
	}

	// 5. P03 vault route (zero BodyLimit): 512 KiB + 1 -> 413 invalid_request as before.
	vaultOver := strings.Repeat("z", httpx.IdempotencyMaxBodyBytes+1)
	keyVaultOver := "idem_vault_over_512kib_1"
	recVaultOver := httptest.NewRecorder()
	r.ServeHTTP(recVaultOver, makeReqWithReader("/api/v1/vault", keyVaultOver, strings.NewReader(vaultOver), int64(len(vaultOver))))
	if recVaultOver.Code != http.StatusRequestEntityTooLarge || decodeProblem(t, recVaultOver).Code != "invalid_request" {
		t.Fatalf("vault 512 KiB+1: status=%d body=%s, want 413 invalid_request", recVaultOver.Code, recVaultOver.Body.String())
	}
	if countIdemRows(keyVaultOver) != 0 || vaultCalls.Load() != 0 {
		t.Fatal("vault 512 KiB+1 must not create idempotency row or invoke handler")
	}

	// 6. WriteContentTxError maps 40P01, 55P03, and 23505 to 503 dependency_unavailable + Retry-After: 1.
	for _, sqlState := range []string{httpx.PGCodeDeadlockDetected, httpx.PGCodeLockNotAvailable, httpx.PGCodeUniqueViolation} {
		pgErr := &pgconn.PgError{Code: sqlState}
		if !httpx.IsContentRetryableTxError(pgErr) {
			t.Fatalf("IsContentRetryableTxError(%s) = false, want true", sqlState)
		}
		recTx := httptest.NewRecorder()
		reqTx := httptest.NewRequest(http.MethodPost, "/api/v1/items", nil)
		if !httpx.WriteContentTxError(ctx, recTx, reqTx, env.pool, nil, pgErr) {
			t.Fatalf("WriteContentTxError(%s) = false, want true", sqlState)
		}
		if recTx.Code != http.StatusServiceUnavailable || recTx.Header().Get("Retry-After") != "1" {
			t.Fatalf("WriteContentTxError(%s): status=%d Retry-After=%q, want 503 and \"1\"", sqlState, recTx.Code, recTx.Header().Get("Retry-After"))
		}
		prob := decodeProblem(t, recTx)
		if prob.Code != "dependency_unavailable" || prob.RetryAfter == nil || *prob.RetryAfter != 1 {
			t.Fatalf("WriteContentTxError(%s) problem = %+v", sqlState, prob)
		}
	}
}
