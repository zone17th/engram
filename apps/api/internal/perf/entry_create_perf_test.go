//go:build perf

// Package perf_test implements P04 Task 21b (A10) entry-create performance benchmarks
// and measurement self-checks against a real Postgres 16 database and HTTP router.
//
// Security (user-dec-016):
//   - Seeded and created entry payloads use synthetic random/deterministic bytes only.
//   - No secrets, plaintext bodies, ciphertexts, or envelope nonces/key_ids are logged.
package perf_test

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/entry/entryhttp"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/item/itemhttp"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/tag/taghttp"
	"github.com/zone17th/engram/apps/api/internal/vault"
	"github.com/zone17th/engram/apps/api/internal/vault/vaulthttp"
)

const (
	// Seed dataset dimensions required by Task 21b (plan line 598).
	seedTotalItems      = 5000
	seedTotalTags       = 1000
	seedTotalEntries    = 20000
	seedEntries64KiB    = 200
	seedNearFullEntries = 199

	// Seed ciphertext upper bound required by Task 21b (<= 150 MB).
	seedMaxCiphertextBytes = 150 * 1024 * 1024

	// Target latency ceiling per population (p95 < 150 ms, nearest-rank).
	p95Ceiling = 150 * time.Millisecond

	// Population sample targets.
	pop1TargetSamples = 300
	pop2Bursts        = 30
	pop2BurstSize     = 10
	pop2TargetSamples = pop2Bursts * pop2BurstSize // 300
	pop3BurstSize     = 10
	pop3TargetRounds  = 10
	pop3TargetSamples = pop3TargetRounds * pop3BurstSize // 100
	pop3SeedTombstone = 500

	// Observation-lag and polling bounds for Population 3 (plan line 600).
	pop3PollInterval      = 1 * time.Millisecond
	pop3MaxWaitForBlocked = 1 * time.Second
	pop3MaxObservationLag = 5 * time.Millisecond
)

// requestTraceCtxKey is attached to each HTTP request's Context before calling router.ServeHTTP
// so the pgx.QueryTracer can attribute LockUserContent timing and backend PID to that exact request,
// and distinguish HTTP create requests from background purge transactions.
type requestTraceCtxKey struct{}

// requestLockTrace records the request-side LockUserContent advisory lock timing and backend PID
// captured by perfQueryTracer (zero production code edits).
type requestLockTrace struct {
	mu          sync.Mutex
	recorded    bool
	backendPID  uint32
	startWaitAt time.Time
	grantedAt   time.Time
	err         error
	onStartWait func()
}

func (rt *requestLockTrace) snapshot() (recorded bool, pid uint32, startWait, granted time.Time, err error) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.recorded, rt.backendPID, rt.startWaitAt, rt.grantedAt, rt.err
}

type activeTraceSpanKey struct{}

type activeLockSpan struct {
	reqTrace  *requestLockTrace
	pid       uint32
	startedAt time.Time
}

type activeCommitSpanKey struct{}

type activeCommitSpan struct {
	startedAt time.Time
}

// perfQueryTracer implements pgx.QueryTracer on the test pool to:
//  1. Record exact start-wait, granted-at, and backend PID when a create HTTP request executes
//     LockUserContent (`-- name: LockUserContent`).
//  2. Optionally inject a synthetic sleep inside the create request's lock-held region right after
//     LockUserContent is granted (Self-Check A).
//  3. Record the exact timestamp when the purge transaction finishes COMMIT on the DB connection.
type perfQueryTracer struct {
	createLockHeldDelayNanos atomic.Int64

	commitMu       sync.Mutex
	trackPurgePID  uint32
	purgeCommitAt  time.Time
	purgeCommitted bool
}

func (tr *perfQueryTracer) setCreateLockHeldDelay(d time.Duration) {
	tr.createLockHeldDelayNanos.Store(int64(d))
}

func (tr *perfQueryTracer) armPurgeCommitTracker(purgePID uint32) {
	tr.commitMu.Lock()
	defer tr.commitMu.Unlock()
	tr.trackPurgePID = purgePID
	tr.purgeCommitAt = time.Time{}
	tr.purgeCommitted = false
}

func (tr *perfQueryTracer) readPurgeCommitTime() (time.Time, bool) {
	tr.commitMu.Lock()
	defer tr.commitMu.Unlock()
	return tr.purgeCommitAt, tr.purgeCommitted
}

func isLockUserContentSQL(sql string) bool {
	return strings.Contains(sql, "-- name: LockUserContent") ||
		(strings.Contains(sql, "pg_advisory_xact_lock") && strings.Contains(sql, "engram.content"))
}

func (tr *perfQueryTracer) TraceQueryStart(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if isLockUserContentSQL(data.SQL) {
		if reqTrace, ok := ctx.Value(requestTraceCtxKey{}).(*requestLockTrace); ok && reqTrace != nil {
			var pid uint32
			if conn != nil && conn.PgConn() != nil {
				pid = conn.PgConn().PID()
			}
			now := time.Now()
			reqTrace.mu.Lock()
			reqTrace.backendPID = pid
			reqTrace.startWaitAt = now
			onStart := reqTrace.onStartWait
			reqTrace.mu.Unlock()
			if onStart != nil {
				onStart()
			}
			return context.WithValue(ctx, activeTraceSpanKey{}, &activeLockSpan{
				reqTrace:  reqTrace,
				pid:       pid,
				startedAt: now,
			})
		}
	}
	if strings.EqualFold(strings.TrimSpace(data.SQL), "commit") {
		return context.WithValue(ctx, activeCommitSpanKey{}, &activeCommitSpan{
			startedAt: time.Now(),
		})
	}
	return ctx
}

func (tr *perfQueryTracer) TraceQueryEnd(ctx context.Context, conn *pgx.Conn, data pgx.TraceQueryEndData) {
	if span, ok := ctx.Value(activeTraceSpanKey{}).(*activeLockSpan); ok && span != nil {
		grantedAt := time.Now()
		span.reqTrace.mu.Lock()
		span.reqTrace.recorded = true
		span.reqTrace.grantedAt = grantedAt
		span.reqTrace.err = data.Err
		span.reqTrace.mu.Unlock()

		if data.Err == nil {
			if delayNanos := tr.createLockHeldDelayNanos.Load(); delayNanos > 0 {
				time.Sleep(time.Duration(delayNanos))
			}
		}
		return
	}
	if commitSpan, ok := ctx.Value(activeCommitSpanKey{}).(*activeCommitSpan); ok && commitSpan != nil && data.Err == nil {
		if conn != nil && conn.PgConn() != nil {
			pid := conn.PgConn().PID()
			tr.commitMu.Lock()
			if tr.trackPurgePID != 0 && pid == tr.trackPurgePID {
				tr.purgeCommitAt = commitSpan.startedAt
				tr.purgeCommitted = true
			}
			tr.commitMu.Unlock()
		}
	}
}

// perfHarness wires the real HTTP router (httpx.NewRouter + authhttp + vaulthttp + itemhttp +
// taghttp + entryhttp) against a real Postgres 16 pool configured with perfQueryTracer.
type perfHarness struct {
	T       *testing.T
	DSN     string
	Pool    *pgxpool.Pool
	ObsPool *pgxpool.Pool // dedicated pool for pg_locks polling so observation never contends for app pool conns
	Tracer  *perfQueryTracer
	Clock   *clock.Fixed
	Origin  string
	Router  http.Handler
	Logs    *contenttest.SafeBuffer
}

func newPerfHarness(t *testing.T) *perfHarness {
	t.Helper()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)

	tracer := &perfQueryTracer{}
	pool := newTracedPool(t, dsn, 32, tracer)
	obsPool := newTracedPool(t, dsn, 8, nil)

	clk := clock.NewFixed(time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	origin := "http://127.0.0.1:18080"

	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", origin)
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "false")
	t.Setenv("VAULT_KEY_MUTATIONS_DISABLED", "false")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	mail, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatalf("NewSinkMailer: %v", err)
	}
	reg, metrics := obs.NewRegistry()

	logBuf := &contenttest.SafeBuffer{}
	// Warn level avoids building giant debug log buffers over ~1000 requests while keeping real router middleware active.
	logger := slog.New(slog.NewJSONHandler(logBuf, &slog.HandlerOptions{Level: slog.LevelWarn}))

	riverInsert, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		t.Fatalf("river.NewClient: %v", err)
	}
	authSvc, _, authAPI, err := compose.NewAuth(cfg, pool, riverInsert, clk, mail, nil)
	if err != nil {
		t.Fatalf("compose.NewAuth: %v", err)
	}
	_, vaultAPI, err := compose.NewVault(cfg, pool, riverInsert, clk, mail, metrics, entry.ResetHook, logger)
	if err != nil {
		t.Fatalf("compose.NewVault: %v", err)
	}
	contentComp, err := compose.NewContent(cfg, pool, clk, metrics, logger)
	if err != nil {
		t.Fatalf("compose.NewContent: %v", err)
	}
	authn, csrfv, reauth := compose.Adapters(authSvc)

	mounts := []func(v1 chi.Router, d httpx.Deps){
		authhttp.Mount(authAPI),
		vaulthttp.Mount(vaultAPI),
		itemhttp.Mount(contentComp),
		taghttp.Mount(contentComp),
		entryhttp.Mount(contentComp),
	}

	router := httpx.NewRouter(httpx.Deps{
		Config:           cfg,
		Logger:           logger,
		Ready:            func(context.Context) error { return nil },
		Metrics:          promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
		MetricsCollector: metrics,
		Authenticator:    authn,
		CSRF:             csrfv,
		Reauth:           reauth,
		MountAPI:         compose.MountAll(mounts...),
	})

	return &perfHarness{
		T:       t,
		DSN:     dsn,
		Pool:    pool,
		ObsPool: obsPool,
		Tracer:  tracer,
		Clock:   clk,
		Origin:  origin,
		Router:  router,
		Logs:    logBuf,
	}
}

func newTracedPool(t *testing.T, dsn string, maxConns int32, tracer pgx.QueryTracer) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}
	cfg.MaxConns = maxConns
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "30000"
	if tracer != nil {
		cfg.ConnConfig.Tracer = tracer
	}

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pgxpool.NewWithConfig: %v", err)
	}
	t.Cleanup(func() {
		done := make(chan struct{})
		go func() {
			pool.Close()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("pgxpool.Close timed out")
		}
	})
	return pool
}

// doServeHTTP executes an HTTP request directly through h.Router.ServeHTTP using httptest.NewRecorder.
func (h *perfHarness) doServeHTTP(
	ctx context.Context,
	jar contenttest.CookieJar,
	method, path, body, idemKey string,
) (int, string, time.Duration) {
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, h.Origin+path, rdr)
	if ctx != nil {
		req = req.WithContext(ctx)
	}
	req.RequestURI = path
	if method != http.MethodGet && method != http.MethodHead {
		if body != "" || method != http.MethodDelete {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("Origin", h.Origin)
	}
	if jar != nil {
		jar.Apply(req)
		if c := jar[authhttp.CookieCSRF]; c != nil {
			req.Header.Set(authhttp.HeaderCSRF, c.Value)
		}
	}
	if idemKey != "" {
		req.Header.Set(httpx.HeaderIdempotencyKey, idemKey)
	}

	rec := httptest.NewRecorder()
	start := time.Now()
	h.Router.ServeHTTP(rec, req)
	elapsed := time.Since(start)

	resp := rec.Result()
	defer func() { _ = resp.Body.Close() }()
	if jar != nil {
		jar.Capture(resp)
	}
	rawBytes, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(rawBytes), elapsed
}

func (h *perfHarness) advanceRateLimitWindow() {
	h.Clock.Advance(1100 * time.Millisecond)
}

func (h *perfHarness) refreshSession(jar contenttest.CookieJar) {
	h.T.Helper()
	code, raw, _ := h.doServeHTTP(context.Background(), jar, http.MethodPost, "/api/v1/auth/refresh", `{}`, "")
	if code != http.StatusNoContent {
		h.T.Fatalf("POST /api/v1/auth/refresh = %d %s", code, raw)
	}
	h.advanceRateLimitWindow()
}

type perfUser struct {
	UserID     uuid.UUID
	Jar        contenttest.CookieJar
	VaultKeyID string
	VK         []byte
}

func (h *perfHarness) signupAndCreateVault(email string, seed byte) perfUser {
	h.T.Helper()
	jar := contenttest.CookieJar{}
	code, raw, _ := h.doServeHTTP(context.Background(), jar, http.MethodGet, "/api/v1/auth/csrf", "", "")
	if code != http.StatusNoContent {
		h.T.Fatalf("GET /api/v1/auth/csrf = %d %s", code, raw)
	}
	signupBody := fmt.Sprintf(`{"email":%q,"password":"CorrectHorseBatteryStaple!99","locale":"en"}`, email)
	code, raw, _ = h.doServeHTTP(context.Background(), jar, http.MethodPost, "/api/v1/auth/signup", signupBody, "")
	if code != http.StatusCreated {
		h.T.Fatalf("POST /api/v1/auth/signup = %d %s", code, raw)
	}
	var me auth.Me
	if err := json.Unmarshal([]byte(raw), &me); err != nil {
		h.T.Fatalf("decode auth.Me: %v", err)
	}

	rks := make([]vault.RecoveryKeyUploadItem, 10)
	for i := range 10 {
		hashBytes := seqBytes(32, seed+byte(i*5+1))
		hashBytes[0] = byte(i + 1)
		hashBytes[1] = seed
		rks[i] = vault.RecoveryKeyUploadItem{
			Slot:       i + 1,
			LookupHash: vault.EncodeBase64URL(hashBytes),
			Wrap:       makeWrapB64U(h.T, vault.WrapKindRK, seed+byte(i+1)),
		}
	}
	vaultPayload := struct {
		KDF                  vault.KDFParams               `json:"kdf"`
		VaultKeyWrappedByKEK string                        `json:"vault_key_wrapped_by_kek"`
		X25519Public         string                        `json:"x25519_public"`
		Ed25519Public        string                        `json:"ed25519_public"`
		PrivateKeysWrapped   string                        `json:"private_keys_wrapped"`
		RecoveryKeys         []vault.RecoveryKeyUploadItem `json:"recovery_keys"`
	}{
		KDF: vault.KDFParams{
			Alg:         "argon2id13",
			Ops:         3,
			Mem:         67108864,
			Parallelism: 1,
			Salt:        vault.EncodeBase64URL(seqBytes(16, seed+0x05)),
		},
		VaultKeyWrappedByKEK: makeWrapB64U(h.T, vault.WrapKindKEK, seed),
		X25519Public:         vault.EncodeBase64URL(seqBytes(32, seed+0x30)),
		Ed25519Public:        vault.EncodeBase64URL(seqBytes(32, seed+0x50)),
		PrivateKeysWrapped:   makeWrapB64U(h.T, vault.WrapKindPriv, seed+0x70),
		RecoveryKeys:         rks,
	}
	vb, err := json.Marshal(vaultPayload)
	if err != nil {
		h.T.Fatal(err)
	}
	idem := "idem_perf_vault_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	code, raw, _ = h.doServeHTTP(context.Background(), jar, http.MethodPost, "/api/v1/vault", string(vb), idem)
	if code != http.StatusCreated {
		h.T.Fatalf("POST /api/v1/vault = %d %s", code, raw)
	}
	var created vault.VaultCreatedResponse
	if err := json.Unmarshal([]byte(raw), &created); err != nil {
		h.T.Fatalf("decode VaultCreatedResponse: %v", err)
	}

	// Advance past signup/vault rate events so measurement starts with a clean window.
	h.advanceRateLimitWindow()

	return perfUser{
		UserID:     me.User.ID,
		Jar:        jar,
		VaultKeyID: created.VaultKeyID,
		VK:         seqBytes(vault.VKBytes, seed+0x42),
	}
}

func seqBytes(n int, start byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = start + byte(i)
	}
	return out
}

func makeWrapB64U(t *testing.T, kind vault.WrapKind, seed byte) string {
	t.Helper()
	ptLen, _ := kind.ExpectedPlaintextLen()
	pt := seqBytes(ptLen, seed)
	key := seqBytes(vault.VKBytes, seed+0x11)
	nonce := seqBytes(vault.WrapNonceBytes, seed+0x22)
	s, err := vault.SealWrapBase64URL(kind, pt, key, nonce)
	if err != nil {
		t.Fatalf("SealWrapBase64URL: %v", err)
	}
	return s
}

// seededDataset holds the deterministic item IDs created during the SQL seed step.
type seededDataset struct {
	Item199ID          uuid.UUID
	NonFullItemIDs     []uuid.UUID // >= 40 non-full items with entry_count <= 4
	TotalCiphertextMiB float64
}

// seedPerfDataset populates the database via SQL generate_series + gen_random_bytes (never via API)
// per Task 21b (plan line 598):
//   - 5000 items:
//   - Item 1: entry_count = 199 (199 entries of 1–4 KiB)
//   - Items 2..51 (50 items): entry_count = 4 (200 entries of 64 KiB, 4 per item)
//   - Items 52..4961 (4910 items): entry_count = 4 (19600 entries of 1–4 KiB on 4900 items + 1 entry on item 4952 => wait: exact distribution below)
//   - Exact entry distribution across 5000 items = 20000 live entries:
//   - Item 1: 199 entries (1–4 KiB) -> entry_count = 199
//   - Items 2..201 (200 items): 1 entry of 64 KiB + 3 entries of 1–4 KiB each -> entry_count = 4 (200 × 64 KiB + 600 × 1–4 KiB = 800 entries)
//   - Items 202..4951 (4750 items): 4 entries of 1–4 KiB each -> entry_count = 4 (19000 entries)
//   - Item 4952: 1 entry of 1–4 KiB -> entry_count = 1
//   - Items 4953..5000 (48 items): 0 entries -> entry_count = 0
//     Total live entries = 199 + 800 + 19000 + 1 + 0 = 20000!
//     Total 64 KiB entries = 200!
//     Total 1–4 KiB entries = 19800 (99% of entries, mostly 1–4 KiB)!
//     One item with 199 entries (Item 1)!
//   - 1000 tags with consistent item_tag links and tag.item_count (5 items per tag -> item_count = 5, 1 tag per item <= 20).
//   - Total ciphertext <= 150 MB, verified via SQL SUM(octet_length(ciphertext)) and contenttest.AssertInvariants.
func seedPerfDataset(t *testing.T, pool *pgxpool.Pool, user perfUser) seededDataset {
	t.Helper()
	ctx := context.Background()

	// Build a valid JSON envelope matching user.VaultKeyID for seeded rows.
	seedEnv := vault.EntryEnvelopeV1{
		V:     vault.EnvelopeVersion,
		Alg:   vault.EnvelopeAlg,
		KeyID: user.VaultKeyID,
		Nonce: vault.EncodeBase64URL(seqBytes(vault.WrapNonceBytes, 0x33)),
		CtEnc: vault.EnvelopeCtEnc,
	}
	seedEnvJSON, err := json.Marshal(seedEnv)
	if err != nil {
		t.Fatalf("marshal seed envelope: %v", err)
	}

	// Deterministic UUID prefix for user so generate_series can synthesize UUIDs cleanly in SQL.
	// We use md5(...) -> uuid in SQL combined with user.UserID.
	_, err = pool.Exec(ctx, `
		WITH seeded_items AS (
			INSERT INTO item (
				id, user_id, name, name_normalized, hint, entry_count, version, created_at, updated_at, last_used_at
			)
			SELECT
				(
					substr(h, 1, 8) || '-' ||
					substr(h, 9, 4) || '-4' ||
					substr(h, 14, 3) || '-a' ||
					substr(h, 18, 3) || '-' ||
					substr(h, 21, 12)
				)::uuid AS id,
				$1::uuid AS user_id,
				'Perf Item ' || g::text AS name,
				'perf item ' || g::text AS name_normalized,
				'seed hint ' || g::text AS hint,
				CASE
					WHEN g = 1 THEN 199
					WHEN g BETWEEN 2 AND 4951 THEN 4
					WHEN g = 4952 THEN 1
					ELSE 0
				END AS entry_count,
				1 AS version,
				now() - (g || ' seconds')::interval,
				now() - (g || ' seconds')::interval,
				now() - (g || ' seconds')::interval
			FROM (
				SELECT g, md5($1::text || ':item:' || g::text) AS h
				FROM generate_series(1, 5000) AS g
			) AS s
			RETURNING id
		),
		seeded_tags AS (
			INSERT INTO tag (
				id, user_id, display, normalized, item_count, created_at, updated_at, last_used_at
			)
			SELECT
				(
					substr(h, 1, 8) || '-' ||
					substr(h, 9, 4) || '-4' ||
					substr(h, 14, 3) || '-a' ||
					substr(h, 18, 3) || '-' ||
					substr(h, 21, 12)
				)::uuid AS id,
				$1::uuid AS user_id,
				'tag-' || g::text AS display,
				'tag-' || g::text AS normalized,
				5 AS item_count,
				now() - (g || ' seconds')::interval,
				now() - (g || ' seconds')::interval,
				now() - (g || ' seconds')::interval
			FROM (
				SELECT g, md5($1::text || ':tag:' || g::text) AS h
				FROM generate_series(1, 1000) AS g
			) AS s
			RETURNING id
		)
		INSERT INTO item_tag (item_id, tag_id)
		SELECT
			(
				substr(ih, 1, 8) || '-' ||
				substr(ih, 9, 4) || '-4' ||
				substr(ih, 14, 3) || '-a' ||
				substr(ih, 18, 3) || '-' ||
				substr(ih, 21, 12)
			)::uuid AS item_id,
			(
				substr(th, 1, 8) || '-' ||
				substr(th, 9, 4) || '-4' ||
				substr(th, 14, 3) || '-a' ||
				substr(th, 18, 3) || '-' ||
				substr(th, 21, 12)
			)::uuid AS tag_id
		FROM (
			SELECT
				g,
				md5($1::text || ':item:' || g::text) AS ih,
				md5($1::text || ':tag:' || (((g - 1) % 1000) + 1)::text) AS th
			FROM generate_series(1, 5000) AS g
		) AS m
	`, user.UserID)
	if err != nil {
		t.Fatalf("seed items, tags, and item_tag via generate_series: %v", err)
	}

	// Seed 20,000 entries via generate_series + gen_random_bytes:
	//   - e = 1..199: Item 1, position 0..198, body 1..4 KiB (1024, 2048, 3072, 4096 B + 16 B tag)
	//   - e = 200..399 (200 entries): Items 2..201 (item = e - 198), position 0, body 64 KiB (65536 B + 16 B tag = 65552 B, bucket 65536)
	//   - e = 400..999 (600 entries): Items 2..201 (item = 2 + ((e - 400) / 3)), position 1 + ((e - 400) % 3), body 1..4 KiB
	//   - e = 1000..19999 (19000 entries): Items 202..4951 (item = 202 + ((e - 1000) / 4)), position (e - 1000) % 4, body 1..4 KiB
	//   - e = 20000 (1 entry): Item 4952, position 0, body 1..4 KiB
	_, err = pool.Exec(ctx, `
		INSERT INTO entry (
			id, user_id, item_id, type, position, envelope, ciphertext,
			plaintext_len_bucket, version, created_at, updated_at
		)
		SELECT
			(
				substr(eh, 1, 8) || '-' ||
				substr(eh, 9, 4) || '-4' ||
				substr(eh, 14, 3) || '-a' ||
				substr(eh, 18, 3) || '-' ||
				substr(eh, 21, 12)
			)::uuid AS id,
			$1::uuid AS user_id,
			(
				substr(ih, 1, 8) || '-' ||
				substr(ih, 9, 4) || '-4' ||
				substr(ih, 14, 3) || '-a' ||
				substr(ih, 18, 3) || '-' ||
				substr(ih, 21, 12)
			)::uuid AS item_id,
			'text' AS type,
			pos AS position,
			$2::jsonb AS envelope,
			(
				SELECT string_agg(
					gen_random_bytes(LEAST(1024, (pt_len + 16) - (c - 1) * 1024 + (e * 0))),
					''::bytea
				)
				FROM generate_series(1, ((pt_len + 16) + 1023) / 1024) AS c
			) AS ciphertext,
			pt_len AS plaintext_len_bucket,
			1 AS version,
			now() - (e || ' milliseconds')::interval,
			now() - (e || ' milliseconds')::interval
		FROM (
			SELECT
				e,
				pos,
				pt_len,
				md5($1::text || ':entry:' || e::text) AS eh,
				md5($1::text || ':item:' || item_idx::text) AS ih
			FROM (
				SELECT
					e,
					CASE
						WHEN e <= 199 THEN 1
						WHEN e <= 399 THEN e - 198
						WHEN e <= 999 THEN 2 + ((e - 400) / 3)
						WHEN e <= 19999 THEN 202 + ((e - 1000) / 4)
						ELSE 4952
					END AS item_idx,
					CASE
						WHEN e <= 199 THEN e - 1
						WHEN e <= 399 THEN 0
						WHEN e <= 999 THEN 1 + ((e - 400) % 3)
						WHEN e <= 19999 THEN (e - 1000) % 4
						ELSE 0
					END AS pos,
					CASE
						WHEN e BETWEEN 200 AND 399 THEN 65536
						ELSE (1 + (e % 4)) * 1024
					END AS pt_len
				FROM generate_series(1, 20000) AS e
			) AS mapped
		) AS hashes
	`, user.UserID, string(seedEnvJSON))
	if err != nil {
		t.Fatalf("seed 20000 entries via generate_series + gen_random_bytes: %v", err)
	}

	if _, err := pool.Exec(ctx, `ANALYZE item, tag, item_tag, entry`); err != nil {
		t.Fatalf("ANALYZE seeded content tables: %v", err)
	}

	// Verify exact counts, distinct random ciphertexts, and total ciphertext size <= 150 MB.
	var (
		gotItems, gotTags, gotEntries, got64K, got199Items, gotDistinctSample int
		totalCiphertextBytes                                                  int64
	)
	if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM item WHERE user_id = $1`, user.UserID).Scan(&gotItems); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM tag WHERE user_id = $1`, user.UserID).Scan(&gotTags); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT
			count(*)::int,
			count(*) FILTER (WHERE plaintext_len_bucket = 65536 AND octet_length(ciphertext) = 65552)::int,
			COALESCE(SUM(octet_length(ciphertext)), 0)::bigint
		FROM entry
		WHERE user_id = $1
	`, user.UserID).Scan(&gotEntries, &got64K, &totalCiphertextBytes); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM item WHERE user_id = $1 AND entry_count = 199`, user.UserID).Scan(&got199Items); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(DISTINCT md5(ciphertext))::int
		FROM (
			SELECT ciphertext FROM entry WHERE user_id = $1 LIMIT 16
		) AS sample
	`, user.UserID).Scan(&gotDistinctSample); err != nil {
		t.Fatal(err)
	}
	if gotDistinctSample < 2 {
		t.Fatalf("seeded entries ciphertext sample distinct count = %d, want >= 2 (rows must not all be identical)", gotDistinctSample)
	}

	if gotItems != seedTotalItems {
		t.Fatalf("seeded items = %d, want %d", gotItems, seedTotalItems)
	}
	if gotTags != seedTotalTags {
		t.Fatalf("seeded tags = %d, want %d", gotTags, seedTotalTags)
	}
	if gotEntries != seedTotalEntries {
		t.Fatalf("seeded entries = %d, want %d", gotEntries, seedTotalEntries)
	}
	if got64K != seedEntries64KiB {
		t.Fatalf("seeded 64 KiB entries = %d, want %d", got64K, seedEntries64KiB)
	}
	if got199Items != 1 {
		t.Fatalf("seeded items with 199 entries = %d, want 1", got199Items)
	}
	if totalCiphertextBytes <= 0 || totalCiphertextBytes > seedMaxCiphertextBytes {
		t.Fatalf("seeded total ciphertext bytes = %d, want 1..%d (<= 150 MB)", totalCiphertextBytes, seedMaxCiphertextBytes)
	}

	contenttest.AssertInvariants(t, pool, user.UserID)

	var item199ID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM item WHERE user_id = $1 AND entry_count = 199`, user.UserID).Scan(&item199ID); err != nil {
		t.Fatalf("select 199-entry item: %v", err)
	}

	rows, err := pool.Query(ctx, `
		SELECT id
		FROM item
		WHERE user_id = $1
		  AND deleted_at IS NULL
		  AND entry_count <= 4
		ORDER BY id ASC
		LIMIT 120
	`, user.UserID)
	if err != nil {
		t.Fatalf("select non-full items: %v", err)
	}
	defer rows.Close()

	var nonFullIDs []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		nonFullIDs = append(nonFullIDs, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(nonFullIDs) < 112 {
		t.Fatalf("non-full items found = %d, want >= 112", len(nonFullIDs))
	}

	totalMiB := float64(totalCiphertextBytes) / (1024.0 * 1024.0)
	t.Logf(
		"SEED SUMMARY: items=%d tags=%d entries=%d entries_64KiB=%d item_199_entries=1 total_ciphertext_bytes=%d (%.2f MiB <= 150 MiB)",
		gotItems, gotTags, gotEntries, got64K, totalCiphertextBytes, totalMiB,
	)

	return seededDataset{
		Item199ID:          item199ID,
		NonFullItemIDs:     nonFullIDs,
		TotalCiphertextMiB: totalMiB,
	}
}

// preparedCreateReq holds a pre-sealed POST /api/v1/items/{id}/entries request payload so client-side
// encryption/encoding overhead is never included in the router.ServeHTTP measurement.
type preparedCreateReq struct {
	EntryID  string
	SizeKiB  int
	BodyJSON string
	IdemKey  string
}

// prepareCreateReqs pre-builds n valid sealed entry create payloads with a deterministic body mix
// of 1 KiB / 16 KiB / 64 KiB (70% 1 KiB, 20% 16 KiB, 10% 64 KiB: for every 10 requests, 7×1 KiB, 2×16 KiB, 1×64 KiB).
func prepareCreateReqs(t *testing.T, user perfUser, n int, prefix string) ([]preparedCreateReq, map[int]int) {
	t.Helper()

	plain1K := make([]byte, 1024)
	plain16K := make([]byte, 16*1024)
	plain64K := make([]byte, 64*1024)
	_, _ = rand.Read(plain1K)
	_, _ = rand.Read(plain16K)
	_, _ = rand.Read(plain64K)

	reqs := make([]preparedCreateReq, n)
	sizeCounts := map[int]int{1: 0, 16: 0, 64: 0}

	for i := range n {
		var (
			pt      []byte
			sizeKiB int
		)
		switch i % 10 {
		case 9:
			pt = plain64K
			sizeKiB = 64
		case 7, 8:
			pt = plain16K
			sizeKiB = 16
		default:
			pt = plain1K
			sizeKiB = 1
		}
		sizeCounts[sizeKiB]++

		entryID := uuid.NewString()
		var nonce [vault.WrapNonceBytes]byte
		_, _ = rand.Read(nonce[:])

		env, ctBytes, err := vault.SealEntry(entryID, user.VaultKeyID, pt, user.VK, nonce[:])
		if err != nil {
			t.Fatalf("SealEntry[%d]: %v", i, err)
		}
		envRaw, err := json.Marshal(env)
		if err != nil {
			t.Fatalf("Marshal envelope[%d]: %v", i, err)
		}
		bucket, ok := entry.ExpectedPlaintextLenBucket(len(ctBytes))
		if !ok {
			t.Fatalf("ExpectedPlaintextLenBucket(%d) = false", len(ctBytes))
		}
		ctB64 := vault.EncodeBase64URL(ctBytes)
		bodyJSON := fmt.Sprintf(
			`{"id":%q,"type":"text","envelope":%s,"ciphertext":%q,"plaintext_len_bucket":%d}`,
			entryID, string(envRaw), ctB64, bucket,
		)
		idemKey := fmt.Sprintf("idem_%s_%04d_%s", prefix, i, strings.ReplaceAll(entryID[:18], "-", ""))
		reqs[i] = preparedCreateReq{
			EntryID:  entryID,
			SizeKiB:  sizeKiB,
			BodyJSON: bodyJSON,
			IdemKey:  idemKey,
		}
	}
	return reqs, sizeCounts
}

// nearestRankPercentile computes the nearest-rank percentile p (e.g. 50, 95, 99) on a non-empty slice
// of durations. For N=100 and p=95, ceil(0.95*100) = 95th 1-based element (index 94).
func nearestRankPercentile(samples []time.Duration, p int) time.Duration {
	if len(samples) == 0 {
		return 0
	}
	sorted := slices.Clone(samples)
	slices.Sort(sorted)
	// ceil(p/100 * N) using integer arithmetic: (p*N + 99) / 100
	rank := (p*len(sorted) + 99) / 100
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

// populationStats summarizes the empirical latency distribution and verification counts of a population.
type populationStats struct {
	Name               string
	Samples            int
	Status201Count     int
	NewRowsCount       int
	SizeCountsKiB      map[int]int
	P50                time.Duration
	P95                time.Duration
	P99                time.Duration
	DiscardedRounds    int
	ObservationLagP95  time.Duration
	HasObservationInfo bool
}

func (s populationStats) passesCeiling(ceiling time.Duration) bool {
	return s.Samples > 0 &&
		s.Status201Count == s.Samples &&
		s.NewRowsCount == s.Samples &&
		s.P95 < ceiling
}

func formatSizeRatio(counts map[int]int, total int) string {
	if total <= 0 {
		return "1KiB=0 16KiB=0 64KiB=0"
	}
	c1 := counts[1]
	c16 := counts[16]
	c64 := counts[64]
	return fmt.Sprintf(
		"1KiB=%d(%.0f%%)/16KiB=%d(%.0f%%)/64KiB=%d(%.0f%%)",
		c1, float64(c1)*100/float64(total),
		c16, float64(c16)*100/float64(total),
		c64, float64(c64)*100/float64(total),
	)
}

func logPopulationStats(t *testing.T, s populationStats) {
	t.Helper()
	ratioStr := formatSizeRatio(s.SizeCountsKiB, s.Samples)
	if s.HasObservationInfo {
		t.Logf(
			"POPULATION %s: samples=%d status_201=%d new_rows=%d body_mix=%s p50=%s p95=%s p99=%s ceiling=%s discarded_rounds=%d observation_lag_p95=%s",
			s.Name, s.Samples, s.Status201Count, s.NewRowsCount, ratioStr,
			s.P50, s.P95, s.P99, p95Ceiling,
			s.DiscardedRounds, s.ObservationLagP95,
		)
		return
	}
	t.Logf(
		"POPULATION %s: samples=%d status_201=%d new_rows=%d body_mix=%s p50=%s p95=%s p99=%s ceiling=%s",
		s.Name, s.Samples, s.Status201Count, s.NewRowsCount, ratioStr,
		s.P50, s.P95, s.P99, p95Ceiling,
	)
}

func countUserLiveEntries(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*)::int FROM entry WHERE user_id = $1 AND deleted_at IS NULL
	`, userID).Scan(&n); err != nil {
		t.Fatalf("countUserLiveEntries: %v", err)
	}
	return n
}

// runPopulation1Sequential executes Population 1 (Task 21b bullet 2):
//   - 300 sequential successful POST /api/v1/items/{id}/entries through the real router,
//     spread evenly across >= 30 non-full items + 1 request into the 199-entry item (bringing it to 200).
//   - The next request into the 199-entry item (now at 200) must return 409 item_entry_limit and is
//     excluded from the 300-sample latency population.
//   - Paced at <= 9 req/s/user by advancing the rate-limit clock window every 9 requests (wait/advance time
//     is outside the per-request router.ServeHTTP measurement).
func runPopulation1Sequential(
	t *testing.T,
	h *perfHarness,
	user perfUser,
	item199ID uuid.UUID,
	nonFullItemIDs []uuid.UUID,
	prefix string,
) populationStats {
	t.Helper()
	if len(nonFullItemIDs) < 30 {
		t.Fatalf("Population 1 requires >= 30 non-full items, got %d", len(nonFullItemIDs))
	}
	targetItems := nonFullItemIDs[:30]

	// Prepare 300 requests for the 201 sample + 1 extra request for the 409 item_entry_limit check.
	reqs, sizeCounts := prepareCreateReqs(t, user, pop1TargetSamples, prefix)
	overflowReqs, _ := prepareCreateReqs(t, user, 1, prefix+"_overflow")

	beforeRows := countUserLiveEntries(t, h.Pool, user.UserID)
	h.advanceRateLimitWindow()

	latencies := make([]time.Duration, 0, pop1TargetSamples)
	status201 := 0
	paceCount := 0

	advanceIfNeeded := func() {
		paceCount++
		if paceCount >= 9 {
			h.advanceRateLimitWindow()
			paceCount = 0
		}
	}

	// Request 0 goes into the 199-entry item (must succeed with 201 and reach 200 live entries).
	path199 := "/api/v1/items/" + item199ID.String() + "/entries"
	code0, raw0, dur0 := h.doServeHTTP(context.Background(), user.Jar, http.MethodPost, path199, reqs[0].BodyJSON, reqs[0].IdemKey)
	if code0 != http.StatusCreated {
		t.Fatalf("Population 1 req[0] into 199-entry item = %d %s, want 201", code0, raw0)
	}
	status201++
	latencies = append(latencies, dur0)
	advanceIfNeeded()

	// Next request into the same item (now at 200 live entries) must return 409 item_entry_limit and is excluded from the sample.
	code409, raw409, _ := h.doServeHTTP(context.Background(), user.Jar, http.MethodPost, path199, overflowReqs[0].BodyJSON, overflowReqs[0].IdemKey)
	if code409 != http.StatusConflict {
		t.Fatalf("Population 1 overflow req into 200-entry item = %d %s, want 409 item_entry_limit", code409, raw409)
	}
	if prob := contenttest.DecodeProblem(t, raw409); prob.Code != "item_entry_limit" {
		t.Fatalf("Population 1 overflow problem code = %q, want item_entry_limit", prob.Code)
	}
	advanceIfNeeded()

	// Remaining 299 requests spread across the 30 non-full items.
	for i := 1; i < pop1TargetSamples; i++ {
		targetItem := targetItems[(i-1)%len(targetItems)]
		path := "/api/v1/items/" + targetItem.String() + "/entries"
		code, raw, dur := h.doServeHTTP(context.Background(), user.Jar, http.MethodPost, path, reqs[i].BodyJSON, reqs[i].IdemKey)
		if code != http.StatusCreated {
			t.Fatalf("Population 1 req[%d] = %d %s, want 201", i, code, raw)
		}
		status201++
		latencies = append(latencies, dur)
		advanceIfNeeded()
	}

	afterRows := countUserLiveEntries(t, h.Pool, user.UserID)
	newRows := afterRows - beforeRows

	stats := populationStats{
		Name:           prefix,
		Samples:        len(latencies),
		Status201Count: status201,
		NewRowsCount:   newRows,
		SizeCountsKiB:  sizeCounts,
		P50:            nearestRankPercentile(latencies, 50),
		P95:            nearestRankPercentile(latencies, 95),
		P99:            nearestRankPercentile(latencies, 99),
	}
	logPopulationStats(t, stats)

	if stats.Status201Count != pop1TargetSamples {
		t.Fatalf("Population 1 status_201 = %d, want %d", stats.Status201Count, pop1TargetSamples)
	}
	if stats.NewRowsCount != pop1TargetSamples {
		t.Fatalf("Population 1 new_rows = %d, want %d", stats.NewRowsCount, pop1TargetSamples)
	}
	return stats
}

// runPopulation2BurstNoPurge executes Population 2 (Task 21b bullet 3):
//   - 30 bursts × 10 concurrent POST /api/v1/items/{id}/entries of the SAME user into 10 different
//     non-full items.
//   - Bursts are separated by > 1 s on the rate-limit clock (`advanceRateLimitWindow`) so none hit 429.
//   - Produces 300 × 201 responses and 300 new rows.
func runPopulation2BurstNoPurge(
	t *testing.T,
	h *perfHarness,
	user perfUser,
	nonFullItemIDs []uuid.UUID,
	prefix string,
) populationStats {
	t.Helper()
	if len(nonFullItemIDs) < pop2BurstSize {
		t.Fatalf("Population 2 requires >= %d non-full items, got %d", pop2BurstSize, len(nonFullItemIDs))
	}
	burstItems := nonFullItemIDs[:pop2BurstSize]

	reqs, sizeCounts := prepareCreateReqs(t, user, pop2TargetSamples, prefix)
	beforeRows := countUserLiveEntries(t, h.Pool, user.UserID)

	latencies := make([]time.Duration, 0, pop2TargetSamples)
	status201 := 0

	type burstResult struct {
		code int
		raw  string
		dur  time.Duration
	}

	for b := range pop2Bursts {
		// Advance rate-limit clock by > 1 s between bursts (plan: "đợt sau cách đợt trước > 1 giây nên không 429").
		h.advanceRateLimitWindow()

		results := make([]burstResult, pop2BurstSize)
		startGate := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(pop2BurstSize)

		for j := range pop2BurstSize {
			reqIdx := b*pop2BurstSize + j
			creq := reqs[reqIdx]
			itemID := burstItems[j]
			path := "/api/v1/items/" + itemID.String() + "/entries"

			go func(slot int, path string, creq preparedCreateReq) {
				defer wg.Done()
				<-startGate
				code, raw, dur := h.doServeHTTP(context.Background(), user.Jar, http.MethodPost, path, creq.BodyJSON, creq.IdemKey)
				results[slot] = burstResult{code: code, raw: raw, dur: dur}
			}(j, path, creq)
		}

		close(startGate)
		wg.Wait()

		for j, res := range results {
			if res.code != http.StatusCreated {
				t.Fatalf("Population 2 burst %d req %d = %d %s, want 201", b, j, res.code, res.raw)
			}
			status201++
			latencies = append(latencies, res.dur)
		}
	}

	afterRows := countUserLiveEntries(t, h.Pool, user.UserID)
	newRows := afterRows - beforeRows

	stats := populationStats{
		Name:           prefix,
		Samples:        len(latencies),
		Status201Count: status201,
		NewRowsCount:   newRows,
		SizeCountsKiB:  sizeCounts,
		P50:            nearestRankPercentile(latencies, 50),
		P95:            nearestRankPercentile(latencies, 95),
		P99:            nearestRankPercentile(latencies, 99),
	}
	logPopulationStats(t, stats)

	if stats.Status201Count != pop2TargetSamples {
		t.Fatalf("Population 2 status_201 = %d, want %d", stats.Status201Count, pop2TargetSamples)
	}
	if stats.NewRowsCount != pop2TargetSamples {
		t.Fatalf("Population 2 new_rows = %d, want %d", stats.NewRowsCount, pop2TargetSamples)
	}
	return stats
}

// seedExpiredTombstonesForRound bulk-inserts `count` (>= 500) expired entry tombstones (`deleted_at < cutoff`)
// for `userID` on `itemID` via SQL generate_series + gen_random_bytes so a real purge batch has >= 500
// purgeable rows to delete.
func seedExpiredTombstonesForRound(
	t *testing.T,
	pool *pgxpool.Pool,
	user perfUser,
	itemID uuid.UUID,
	deletedAt time.Time,
	roundSeq int,
	count int,
) {
	t.Helper()
	ctx := context.Background()

	seedEnv := vault.EntryEnvelopeV1{
		V:     vault.EnvelopeVersion,
		Alg:   vault.EnvelopeAlg,
		KeyID: user.VaultKeyID,
		Nonce: vault.EncodeBase64URL(seqBytes(vault.WrapNonceBytes, 0x55+byte(roundSeq))),
		CtEnc: vault.EnvelopeCtEnc,
	}
	envRaw, err := json.Marshal(seedEnv)
	if err != nil {
		t.Fatal(err)
	}

	basePos := 100000 + roundSeq*1000
	_, err = pool.Exec(ctx, `
		INSERT INTO entry (
			id, user_id, item_id, type, position, envelope, ciphertext,
			plaintext_len_bucket, version, deleted_at, deleted_via
		)
		SELECT
			gen_random_uuid(),
			$1::uuid,
			$2::uuid,
			'text',
			$3::int + g,
			$4::jsonb,
			(
				SELECT string_agg(
					gen_random_bytes(LEAST(1024, (1024 + 16) - (c - 1) * 1024 + (g * 0))),
					''::bytea
				)
				FROM generate_series(1, ((1024 + 16) + 1023) / 1024) AS c
			),
			1024,
			1,
			$5::timestamptz,
			'entry'
		FROM generate_series(1, $6::int) AS g
	`, user.UserID, itemID, basePos, string(envRaw), deletedAt, count)
	if err != nil {
		t.Fatalf("seed %d expired tombstones for round %d: %v", count, roundSeq, err)
	}
}

// queryContentAdvisoryLockSnapshot queries pg_locks on the dedicated observation pool for the user's
// content advisory lock (`pg_advisory_xact_lock(hashtext('engram.content'), hashtext(user_id::text))`).
// Returns the PID holding the lock (`granted = true`) and the list of PIDs waiting on it (`granted = false`).
func queryContentAdvisoryLockSnapshot(
	ctx context.Context,
	obsConn *pgxpool.Conn,
	userID uuid.UUID,
) (holderPID uint32, waiterPIDs []uint32, err error) {
	rows, err := obsConn.Query(ctx, `
		SELECT l.pid, l.granted
		FROM pg_locks AS l
		JOIN pg_database AS d ON d.oid = l.database AND d.datname = current_database()
		WHERE l.locktype = 'advisory'
		  AND l.objsubid = 2
		  AND l.classid::int4 = hashtext('engram.content')
		  AND l.objid::int4 = hashtext(($1::uuid)::text)
	`, userID)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var pid int32
		var granted bool
		if err := rows.Scan(&pid, &granted); err != nil {
			return 0, nil, err
		}
		if granted {
			holderPID = uint32(pid)
		} else {
			waiterPIDs = append(waiterPIDs, uint32(pid))
		}
	}
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	return holderPID, waiterPIDs, nil
}

// runPopulation3ConfirmedPurgeOverlap executes Population 3 (Task 21b bullet 3, P4BE3-1, P4BE4-1):
//   - Runs rounds until 10 confirmed rounds (100 confirmed samples) are collected.
//   - Each round seeds >= 500 expired tombstones for the user, starts a real `entry.PurgeUserExpiredContentBatch`
//     with `entry.WithPurgeLockHeldHook`.
//   - Inside the hook (right after the purge batch holds `LockUserContent`), releases the burst of 10
//     concurrent create requests and polls `pg_locks` every 1 ms (max 1 s) until all 10 create backends
//     are waiting (`granted=false`) on the user's content advisory lock while the purge backend holds it
//     (`granted=true`).
//   - Releases the hook (optionally sleeping `extraPurgeHoldDelay` for Self-Check B); the purge batch
//     runs its real DELETE of 500 tombstones and commits.
//   - Every sample in a confirmed round must have full evidence:
//     1. Request-side `startWaitAt` and `grantedAt` recorded by `perfQueryTracer` on `LockUserContent`.
//     2. `startWaitAt < purgeCommitAt < grantedAt`.
//     3. Request's backend PID present in the `pg_locks` waiter snapshot while `holderPID` held the lock.
//   - Discards the entire round (and re-runs) if < 10 requests blocked within 1 s, or if observation lag
//     (from the 10th request's `startWaitAt` to hook release) > 5 ms, or if any request lacked full evidence.
func runPopulation3ConfirmedPurgeOverlap(
	t *testing.T,
	h *perfHarness,
	user perfUser,
	tombstoneItemID uuid.UUID,
	nonFullItemIDs []uuid.UUID,
	extraPurgeHoldDelay time.Duration,
	prefix string,
) populationStats {
	t.Helper()
	if len(nonFullItemIDs) < pop3BurstSize {
		t.Fatalf("Population 3 requires >= %d non-full items, got %d", pop3BurstSize, len(nonFullItemIDs))
	}
	burstItems := nonFullItemIDs[:pop3BurstSize]

	ctx := context.Background()
	obsConn, err := h.ObsPool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire observation conn: %v", err)
	}
	defer obsConn.Release()

	// Warm up prepared statement cache on the dedicated observation connection before timed rounds.
	_, _, _ = queryContentAdvisoryLockSnapshot(ctx, obsConn, user.UserID)

	now := h.Clock.Now().UTC()
	cutoff := now.Add(-entry.ContentPurgeRetentionWindow)
	del35d := now.Add(-35 * 24 * time.Hour)

	confirmedLatencies := make([]time.Duration, 0, pop3TargetSamples)
	confirmedSizeCounts := map[int]int{1: 0, 16: 0, 64: 0}
	observationLags := make([]time.Duration, 0, pop3TargetRounds)
	confirmedRounds := 0
	discardedRounds := 0
	totalStatus201 := 0
	totalExpectedNewRows := 0

	beforeLiveRows := countUserLiveEntries(t, h.Pool, user.UserID)

	type roundReqOutcome struct {
		code    int
		raw     string
		dur     time.Duration
		sizeKiB int
		trace   *requestLockTrace
	}

	const maxAttempts = 40
	for attempt := 1; confirmedRounds < pop3TargetRounds; attempt++ {
		if attempt > maxAttempts {
			t.Fatalf(
				"Population 3 (%s) exceeded %d attempts (confirmed_rounds=%d, discarded_rounds=%d)",
				prefix, maxAttempts, confirmedRounds, discardedRounds,
			)
		}

		// Clean any leftover expired tombstones from a previous discarded attempt before seeding 500 fresh ones.
		if _, err := h.Pool.Exec(ctx, `DELETE FROM entry WHERE user_id = $1 AND deleted_at IS NOT NULL`, user.UserID); err != nil {
			t.Fatalf("clean leftover tombstones: %v", err)
		}
		seedExpiredTombstonesForRound(t, h.Pool, user, tombstoneItemID, del35d, attempt, pop3SeedTombstone)

		roundReqs, _ := prepareCreateReqs(t, user, pop3BurstSize, fmt.Sprintf("%s_r%02d", prefix, attempt))
		h.advanceRateLimitWindow()

		var (
			snapshotHolderPID  uint32
			snapshotWaiterPIDs []uint32
			purgeReleasedAt    time.Time
			all10Blocked       bool
		)

		burstGate := make(chan struct{})
		all10EnteredLockCh := make(chan struct{})
		var startedWaitCount atomic.Int32
		outcomes := make([]roundReqOutcome, pop3BurstSize)
		var reqWG sync.WaitGroup
		reqWG.Add(pop3BurstSize)

		for j := range pop3BurstSize {
			creq := roundReqs[j]
			itemID := burstItems[j]
			path := "/api/v1/items/" + itemID.String() + "/entries"
			rTrace := &requestLockTrace{
				onStartWait: func() {
					if startedWaitCount.Add(1) == pop3BurstSize {
						close(all10EnteredLockCh)
					}
				},
			}

			go func(slot int, path string, creq preparedCreateReq, rt *requestLockTrace) {
				defer reqWG.Done()
				<-burstGate
				reqCtx := context.WithValue(context.Background(), requestTraceCtxKey{}, rt)
				code, raw, dur := h.doServeHTTP(reqCtx, user.Jar, http.MethodPost, path, creq.BodyJSON, creq.IdemKey)
				outcomes[slot] = roundReqOutcome{
					code:    code,
					raw:     raw,
					dur:     dur,
					sizeKiB: creq.SizeKiB,
					trace:   rt,
				}
			}(j, path, creq, rTrace)
		}

		hookCtx := entry.WithPurgeLockHeldHook(ctx, func(hCtx context.Context, _ uuid.UUID) {
			// Purge batch now holds LockUserContent(user.UserID). Release the 10 concurrent create requests.
			close(burstGate)

			deadline := time.Now().Add(pop3MaxWaitForBlocked)
			allEnteredNotified := false
			for {
				holder, waiters, qErr := queryContentAdvisoryLockSnapshot(hCtx, obsConn, user.UserID)
				if qErr == nil && holder != 0 && len(waiters) >= pop3BurstSize {
					purgeReleasedAt = time.Now()
					snapshotHolderPID = holder
					snapshotWaiterPIDs = waiters
					all10Blocked = true
					h.Tracer.armPurgeCommitTracker(holder)
					break
				}
				if time.Now().After(deadline) {
					purgeReleasedAt = time.Now()
					break
				}
				if !allEnteredNotified {
					select {
					case <-all10EnteredLockCh:
						allEnteredNotified = true
						time.Sleep(150 * time.Microsecond)
					case <-time.After(pop3PollInterval):
					}
				} else {
					time.Sleep(pop3PollInterval)
				}
			}
			if extraPurgeHoldDelay > 0 {
				time.Sleep(extraPurgeHoldDelay)
			}
		})

		purgeRes, purgeErr := entry.PurgeUserExpiredContentBatch(
			hookCtx,
			h.Pool,
			user.UserID,
			cutoff,
			entry.DefaultContentPurgeBatchSize,
		)
		if purgeErr != nil {
			t.Fatalf("Population 3 attempt %d PurgeUserExpiredContentBatch: %v", attempt, purgeErr)
		}
		if purgeRes.EntriesDeleted != pop3SeedTombstone {
			t.Fatalf("Population 3 attempt %d EntriesDeleted = %d, want %d", attempt, purgeRes.EntriesDeleted, pop3SeedTombstone)
		}

		reqWG.Wait()

		// Verify every HTTP request in the burst succeeded with 201 (even if the round is later discarded for timing lag).
		for j, out := range outcomes {
			if out.code != http.StatusCreated {
				t.Fatalf("Population 3 attempt %d req %d = %d %s, want 201", attempt, j, out.code, out.raw)
			}
			totalStatus201++
			totalExpectedNewRows++
		}

		if !all10Blocked || snapshotHolderPID == 0 || len(snapshotWaiterPIDs) < pop3BurstSize {
			discardedRounds++
			continue
		}

		purgeCommitAt, commitRecorded := h.Tracer.readPurgeCommitTime()
		if !commitRecorded {
			discardedRounds++
			continue
		}

		waiterSet := make(map[uint32]struct{}, len(snapshotWaiterPIDs))
		for _, pid := range snapshotWaiterPIDs {
			waiterSet[pid] = struct{}{}
		}

		// Find the 10th request's startWaitAt (latest startWaitAt among the 10 requests) and verify
		// every single request satisfies:
		//   - recorded == true, err == nil
		//   - backendPID in waiterSet
		//   - startWaitAt < purgeCommitAt < grantedAt
		var latestStartWait time.Time
		evidenceValid := true
		for _, out := range outcomes {
			rec, pid, startWait, granted, lErr := out.trace.snapshot()
			if !rec || lErr != nil || pid == 0 {
				evidenceValid = false
				break
			}
			if _, ok := waiterSet[pid]; !ok {
				evidenceValid = false
				break
			}
			if !startWait.Before(purgeCommitAt) || !purgeCommitAt.Before(granted) {
				evidenceValid = false
				break
			}
			if latestStartWait.IsZero() || startWait.After(latestStartWait) {
				latestStartWait = startWait
			}
		}
		if !evidenceValid || latestStartWait.IsZero() {
			discardedRounds++
			continue
		}

		obsLag := purgeReleasedAt.Sub(latestStartWait)
		if obsLag < 0 {
			obsLag = 0
		}
		if obsLag > pop3MaxObservationLag {
			discardedRounds++
			continue
		}

		// Round is confirmed! Record all 10 samples and the round's observation lag.
		confirmedRounds++
		observationLags = append(observationLags, obsLag)
		for _, out := range outcomes {
			confirmedLatencies = append(confirmedLatencies, out.dur)
			confirmedSizeCounts[out.sizeKiB]++
		}
	}

	afterLiveRows := countUserLiveEntries(t, h.Pool, user.UserID)
	actualNewLiveRows := afterLiveRows - beforeLiveRows
	if actualNewLiveRows != totalExpectedNewRows {
		t.Fatalf(
			"Population 3 live rows delta = %d, want %d (across %d confirmed + %d discarded rounds)",
			actualNewLiveRows, totalExpectedNewRows, confirmedRounds, discardedRounds,
		)
	}
	if totalStatus201 != totalExpectedNewRows {
		t.Fatalf("Population 3 total 201 count = %d, want %d", totalStatus201, totalExpectedNewRows)
	}

	// For the 100 confirmed samples (10 confirmed rounds × 10 requests), report exact confirmed counts.
	confirmedSamples := len(confirmedLatencies)
	stats := populationStats{
		Name:               prefix,
		Samples:            confirmedSamples,
		Status201Count:     confirmedSamples,
		NewRowsCount:       confirmedSamples,
		SizeCountsKiB:      confirmedSizeCounts,
		P50:                nearestRankPercentile(confirmedLatencies, 50),
		P95:                nearestRankPercentile(confirmedLatencies, 95),
		P99:                nearestRankPercentile(confirmedLatencies, 99),
		DiscardedRounds:    discardedRounds,
		ObservationLagP95:  nearestRankPercentile(observationLags, 95),
		HasObservationInfo: true,
	}
	logPopulationStats(t, stats)

	if stats.Samples != pop3TargetSamples {
		t.Fatalf("Population 3 confirmed samples = %d, want %d", stats.Samples, pop3TargetSamples)
	}
	return stats
}

// TestEntryCreatePerformanceA10 runs the complete Task 21b (P04-A10) benchmark and both measurement
// self-checks against a real Postgres 16 database and router:
//  1. Seeds 5,000 items, 1,000 tags, 20,000 entries (mostly 1–4 KiB, 200 × 64 KiB, one item with 199 entries,
//     total ciphertext <= 150 MB) via SQL generate_series + gen_random_bytes and verifies invariants.
//  2. Measures Population 1 (300 sequential creates + 1 overflow 409 excluded), Population 2 (30 × 10
//     same-user concurrent bursts without purge), and Population 3 (10 confirmed rounds = 100 samples of
//     same-user 10-request bursts verified blocked behind a real 500-row content_purge batch via pg_locks
//     and tracer timestamps). Asserts separate p95 < 150 ms ceiling for each population.
//  3. Measurement Self-Check A: injects 20 ms inside the create request's lock-held region -> verifies
//     Population 2 FAILS the 150 ms p95 ceiling while Population 1 PASSES.
//  4. Measurement Self-Check B: injects 200 ms inside the purge batch's lock-held region -> verifies
//     Population 3 FAILS the 150 ms p95 ceiling while Population 2 PASSES.
func TestEntryCreatePerformanceA10(t *testing.T) {
	h := newPerfHarness(t)
	user := h.signupAndCreateVault("perf-a10-user@example.com", 0x10)
	seeded := seedPerfDataset(t, h.Pool, user)

	// Partition non-full items into disjoint slices per population and self-check so no item ever
	// accumulates more than ~40 entries (staying well below the 200-entry limit throughout the entire run):
	//   - nonFull[0..29]   (30 items): Real Population 1 (+10 entries/item -> max 14)
	//   - nonFull[30..39]  (10 items): Real Population 2 (+30 entries/item -> max 34)
	//   - nonFull[40..49]  (10 items): Real Population 3 (+10..40 entries/item -> max 44)
	//   - nonFull[50..79]  (30 items): Self-Check A Population 1 (+10 entries/item -> max 14)
	//   - nonFull[80..89]  (10 items): Self-Check A Population 2 (+30 entries/item -> max 34)
	//   - nonFull[90..99]  (10 items): Self-Check B Population 2 (+30 entries/item -> max 34)
	//   - nonFull[100..109](10 items): Self-Check B Population 3 (+10..40 entries/item -> max 44)
	//   - nonFull[110]: dedicated parent item for Population 3's 500 expired tombstones
	//   - nonFull[111]: dedicated item topped up to 199 live entries for Self-Check A's Population 1
	pop1Items := seeded.NonFullItemIDs[0:30]
	pop2Items := seeded.NonFullItemIDs[30:40]
	pop3Items := seeded.NonFullItemIDs[40:50]
	checkAPop1Items := seeded.NonFullItemIDs[50:80]
	checkAPop2Items := seeded.NonFullItemIDs[80:90]
	checkBPop2Items := seeded.NonFullItemIDs[90:100]
	checkBPop3Items := seeded.NonFullItemIDs[100:110]
	tombstoneItemID := seeded.NonFullItemIDs[110]
	checkAItem199BaseID := seeded.NonFullItemIDs[111]

	t.Run("RealPopulations_1_2_3", func(t *testing.T) {
		h.refreshSession(user.Jar)
		h.Tracer.setCreateLockHeldDelay(0)

		pop1 := runPopulation1Sequential(t, h, user, seeded.Item199ID, pop1Items, "pop1_sequential")
		if !pop1.passesCeiling(p95Ceiling) {
			t.Fatalf("Population 1 p95 = %s >= ceiling %s", pop1.P95, p95Ceiling)
		}

		pop2 := runPopulation2BurstNoPurge(t, h, user, pop2Items, "pop2_burst_no_purge")
		if !pop2.passesCeiling(p95Ceiling) {
			t.Fatalf("Population 2 p95 = %s >= ceiling %s", pop2.P95, p95Ceiling)
		}

		pop3 := runPopulation3ConfirmedPurgeOverlap(t, h, user, tombstoneItemID, pop3Items, 0, "pop3_burst_purge_overlap")
		if !pop3.passesCeiling(p95Ceiling) {
			t.Fatalf("Population 3 p95 = %s >= ceiling %s (decision_required per plan)", pop3.P95, p95Ceiling)
		}

		contenttest.AssertInvariants(t, h.Pool, user.UserID)
	})

	t.Run("SelfCheckA_Inject20msInCreateLock_Pop2FailsWhilePop1Passes", func(t *testing.T) {
		h.refreshSession(user.Jar)
		item199CheckA := prepareItemAt199Entries(t, h.Pool, user, checkAItem199BaseID, 1)

		h.Tracer.setCreateLockHeldDelay(20 * time.Millisecond)
		defer h.Tracer.setCreateLockHeldDelay(0)

		pop1CheckA := runPopulation1Sequential(t, h, user, item199CheckA, checkAPop1Items, "selfcheck_a_pop1_20ms")
		if !pop1CheckA.passesCeiling(p95Ceiling) {
			t.Fatalf("Self-Check A: expected Population 1 to PASS with 20 ms lock hold, got p95=%s (ceiling=%s)", pop1CheckA.P95, p95Ceiling)
		}

		pop2CheckA := runPopulation2BurstNoPurge(t, h, user, checkAPop2Items, "selfcheck_a_pop2_20ms")
		if pop2CheckA.passesCeiling(p95Ceiling) {
			t.Fatalf("Self-Check A: expected Population 2 to FAIL ceiling %s when 20 ms is injected in create lock (10 serialized * 20 ms >= 180 ms), but got p95=%s", p95Ceiling, pop2CheckA.P95)
		}
		t.Logf("SELF-CHECK A VERIFIED: 20 ms injected in create lock -> Pop1 PASS (p95=%s < %s) and Pop2 FAIL (p95=%s >= %s)",
			pop1CheckA.P95, p95Ceiling, pop2CheckA.P95, p95Ceiling)

		contenttest.AssertInvariants(t, h.Pool, user.UserID)
	})

	t.Run("SelfCheckB_Inject200msInPurgeLock_Pop3FailsWhilePop2Passes", func(t *testing.T) {
		h.refreshSession(user.Jar)
		h.Tracer.setCreateLockHeldDelay(0)

		pop2CheckB := runPopulation2BurstNoPurge(t, h, user, checkBPop2Items, "selfcheck_b_pop2_200ms_purge")
		if !pop2CheckB.passesCeiling(p95Ceiling) {
			t.Fatalf("Self-Check B: expected Population 2 to PASS when 200 ms is only in purge lock, got p95=%s (ceiling=%s)", pop2CheckB.P95, p95Ceiling)
		}

		pop3CheckB := runPopulation3ConfirmedPurgeOverlap(t, h, user, tombstoneItemID, checkBPop3Items, 200*time.Millisecond, "selfcheck_b_pop3_200ms_purge")
		if pop3CheckB.passesCeiling(p95Ceiling) {
			t.Fatalf("Self-Check B: expected Population 3 to FAIL ceiling %s when 200 ms is injected in purge lock, but got p95=%s", p95Ceiling, pop3CheckB.P95)
		}
		t.Logf("SELF-CHECK B VERIFIED: 200 ms injected in purge lock -> Pop2 PASS (p95=%s < %s) and Pop3 FAIL (p95=%s >= %s)",
			pop2CheckB.P95, p95Ceiling, pop3CheckB.P95, p95Ceiling)

		contenttest.AssertInvariants(t, h.Pool, user.UserID)
	})

	// Security check (user-dec-016): ensure server logs remained free of any envelope nonces or vault_key_id.
	if strings.Contains(h.Logs.String(), user.VaultKeyID) {
		t.Fatalf("server logs leaked vault_key_id %q", user.VaultKeyID)
	}
}

// prepareItemAt199Entries tops up `itemID` to 199 live entries via SQL generate_series + gen_random_bytes
// for Self-Check A's Population 1 run, keeping item.entry_count = 199 consistent with AssertInvariants.
func prepareItemAt199Entries(t *testing.T, pool *pgxpool.Pool, user perfUser, itemID uuid.UUID, seq int) uuid.UUID {
	t.Helper()
	ctx := context.Background()

	var currentCount int
	if err := pool.QueryRow(ctx, `SELECT entry_count FROM item WHERE id = $1 AND user_id = $2`, itemID, user.UserID).Scan(&currentCount); err != nil {
		t.Fatalf("read item entry_count: %v", err)
	}
	needed := seedNearFullEntries - currentCount
	if needed <= 0 {
		return itemID
	}

	seedEnv := vault.EntryEnvelopeV1{
		V:     vault.EnvelopeVersion,
		Alg:   vault.EnvelopeAlg,
		KeyID: user.VaultKeyID,
		Nonce: vault.EncodeBase64URL(seqBytes(vault.WrapNonceBytes, 0x77+byte(seq))),
		CtEnc: vault.EnvelopeCtEnc,
	}
	envRaw, err := json.Marshal(seedEnv)
	if err != nil {
		t.Fatal(err)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO entry (
			id, user_id, item_id, type, position, envelope, ciphertext,
			plaintext_len_bucket, version
		)
		SELECT
			gen_random_uuid(),
			$1::uuid,
			$2::uuid,
			'text',
			$3::int + g,
			$4::jsonb,
			(
				SELECT string_agg(
					gen_random_bytes(LEAST(1024, (1024 + 16) - (c - 1) * 1024 + (g * 0))),
					''::bytea
				)
				FROM generate_series(1, ((1024 + 16) + 1023) / 1024) AS c
			),
			1024,
			1
		FROM generate_series(1, $5::int) AS g
	`, user.UserID, itemID, currentCount+10, string(envRaw), needed)
	if err != nil {
		t.Fatalf("top up item to 199 entries: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE item SET entry_count = 199 WHERE id = $1 AND user_id = $2`, itemID, user.UserID); err != nil {
		t.Fatalf("update item entry_count = 199: %v", err)
	}
	contenttest.AssertInvariants(t, pool, user.UserID)
	return itemID
}
