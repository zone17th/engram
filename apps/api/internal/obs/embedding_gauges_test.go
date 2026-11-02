package obs_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

// Gate 10: một container Postgres dùng chung cho cả package; mỗi test tạo một
// database riêng trên container đó.
var (
	sharedGaugeDSNOnce   sync.Once
	sharedGaugeDSN       string
	sharedGaugeErr       error
	sharedGaugeContainer testcontainers.Container
)

func TestMain(m *testing.M) {
	code := m.Run()
	if sharedGaugeContainer != nil {
		_ = testcontainers.TerminateContainer(sharedGaugeContainer)
	}
	os.Exit(code)
}

func newGaugeTestDSN(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("bỏ qua test cần Docker ở chế độ -short")
	}
	if envDSN := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL")); envDSN != "" {
		sharedGaugeDSN = envDSN
	} else {
		sharedGaugeDSNOnce.Do(func() {
			ctx := context.Background()
			c, err := tcpostgres.Run(ctx, "pgvector/pgvector:pg16",
				tcpostgres.WithDatabase("engram"),
				tcpostgres.WithUsername("engram"),
				tcpostgres.WithPassword("engram"),
				testcontainers.WithWaitStrategy(
					wait.ForLog("database system is ready to accept connections").
						WithOccurrence(2).WithStartupTimeout(90*time.Second)),
			)
			if err != nil {
				sharedGaugeErr = err
				return
			}
			sharedGaugeContainer = c
			sharedGaugeDSN, sharedGaugeErr = c.ConnectionString(ctx, "sslmode=disable")
		})
		if sharedGaugeErr != nil {
			t.Fatalf("start shared Postgres container: %v", sharedGaugeErr)
		}
	}
	u, err := url.Parse(sharedGaugeDSN)
	if err != nil {
		t.Fatalf("parse shared DSN: %v", err)
	}
	var nonce [6]byte
	_, _ = rand.Read(nonce[:])
	dbName := "engram_obs_" + hex.EncodeToString(nonce[:])

	admin := *u
	admin.Path = "/postgres"
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin.String())
	if err != nil {
		t.Fatalf("connect admin DB: %v", err)
	}
	if _, err := conn.Exec(ctx, `CREATE DATABASE "`+dbName+`"`); err != nil {
		_ = conn.Close(ctx)
		t.Fatalf("CREATE DATABASE %s: %v", dbName, err)
	}
	if err := conn.Close(ctx); err != nil {
		t.Fatalf("close admin connection: %v", err)
	}

	u.Path = "/" + dbName
	dsn := u.String()
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), admin.String())
		if err != nil {
			return
		}
		defer func() { _ = c.Close(context.Background()) }()
		_, _ = c.Exec(context.Background(), `DROP DATABASE IF EXISTS "`+dbName+`" WITH (FORCE)`)
	})

	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	return dsn
}

// countingQuerier đếm số truy vấn gửi xuống DB để chứng minh cache.
type countingQuerier struct {
	inner obs.DBQuerier
	n     atomic.Int64
}

func (c *countingQuerier) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	c.n.Add(1)
	return c.inner.Query(ctx, sql, args...)
}

func (c *countingQuerier) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	c.n.Add(1)
	return c.inner.QueryRow(ctx, sql, args...)
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (f *fakeClock) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t
}

func (f *fakeClock) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = f.t.Add(d)
}

// seedGaugeFixture dựng: generation 1 (active, dims 3), hai item sống + một item
// đã xoá, vector cho một item sống, một job embed_item completed với lag đúng 4 s,
// và hai job embed_* discarded cùng một job kind khác discarded (không được đếm).
func seedGaugeFixture(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed %q: %v", sql, err)
		}
	}
	var userID, itemID string
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email) VALUES ('gauge@example.test') RETURNING id::text`).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO item (user_id, name, name_normalized) VALUES ($1::uuid, 'alpha', 'alpha') RETURNING id::text`, userID,
	).Scan(&itemID); err != nil {
		t.Fatalf("seed item: %v", err)
	}
	exec(`INSERT INTO item (user_id, name, name_normalized) VALUES ($1::uuid, 'beta', 'beta')`, userID)
	exec(`INSERT INTO item (user_id, name, name_normalized, deleted_at) VALUES ($1::uuid, 'gamma', 'gamma', now())`, userID)

	exec(`INSERT INTO embedding_generation
	        (id, provider, model, model_version, preprocessing, query_prefix, doc_prefix, dims,
	         partitions, semantic_min_cos, calibration_ref, item_table, tag_table, state, bootstrap)
	      VALUES (1, 'tei', 'm', 'v1', 'v1', '', '', 3, 2, 0.5, 'ref', 'item_embedding_g1', 'tag_embedding_g1', 'active', false)`)
	exec(`SELECT embedding_generation_create_tables(1, 3, 2, false, 16, 128)`)

	hashHex := strings.Repeat("ab", 32)
	exec(`INSERT INTO item_embedding_g1 (user_id, target_id, embedding, model, model_version, input_hash)
	      VALUES ($1::uuid, $2::uuid, '[0.1,0.2,0.3]'::vector, 'm', 'v1', decode($3, 'hex'))`, userID, itemID, hashHex)

	exec(`INSERT INTO river_job (state, max_attempts, created_at, finalized_at, kind, args, queue)
	      SELECT 'completed'::river_job_state, 30, e.embedded_at - interval '4 seconds', now(), 'embed_item',
	             jsonb_build_object('generation_id', 1, 'user_id', $1::text, 'target_id', $2::text, 'input_hash', $3::text),
	             'embedding'
	        FROM item_embedding_g1 e WHERE e.target_id::text = $2::text`, userID, itemID, hashHex)
	exec(`INSERT INTO river_job (state, max_attempts, finalized_at, kind, args, queue) VALUES
	        ('discarded', 30, now(), 'embed_item', '{}'::jsonb, 'embedding'),
	        ('discarded', 30, now(), 'embed_tag',  '{}'::jsonb, 'embedding'),
	        ('discarded', 30, now(), 'noop',       '{}'::jsonb, 'default')`)
}

func TestDBGaugeSourceValues(t *testing.T) {
	dsn := newGaugeTestDSN(t)
	pool := dbtest.Pool(t, dsn)
	seedGaugeFixture(t, pool)

	src := obs.NewDBGaugeSource(pool)
	ctx := context.Background()

	lags, err := src.JobLag(ctx)
	if err != nil {
		t.Fatalf("JobLag: %v", err)
	}
	if len(lags) != 6 {
		t.Fatalf("JobLag samples = %d, want 6 (corpus x role): %+v", len(lags), lags)
	}
	for _, s := range lags {
		want := 0.0
		if s.Corpus == "item" && s.Role == "active" {
			want = 4
		}
		if math.Abs(s.Seconds-want) > 1e-6 {
			t.Errorf("lag{%s,%s} = %v, want %v", s.Corpus, s.Role, s.Seconds, want)
		}
	}

	dead, err := src.DeadLetterJobs(ctx)
	if err != nil {
		t.Fatalf("DeadLetterJobs: %v", err)
	}
	if dead != 2 {
		t.Errorf("dead-letter = %v, want 2 (embed_item + embed_tag discarded; noop excluded)", dead)
	}

	covs, err := src.Coverage(ctx)
	if err != nil {
		t.Fatalf("Coverage: %v", err)
	}
	got := map[string]float64{}
	for _, c := range covs {
		got[c.Generation+"/"+c.Corpus] = c.Ratio
	}
	if len(got) != 2 || math.Abs(got["1/item"]-0.5) > 1e-9 || got["1/tag"] != 1 {
		t.Errorf("coverage = %v, want map[1/item:0.5 1/tag:1] (1 of 2 live items embedded; 0 live tags = 1)", got)
	}
}

// TestDBGaugeLagIgnoresLaterRewrite (RV-T20a-BE-2): A→B→A. Job 1 (hash A) tạo ở
// t0, ghi vector lúc t1 và xong lúc t1; đổi tên rồi đổi lại tạo job 2 (cũng hash
// A) tạo ở t100, ghi lúc t101. Hàng vector hiện tại giữ embedded_at = t101 nên cả
// hai job cùng nối với nó: không có cận trên thì mẫu là 101 s và 1 s (p95 ≈ 96 s)
// dù mỗi job chỉ mất 1 s. Có `embedded_at <= finalized_at`, job 1 bị loại và lag
// đúng 1 s.
func TestDBGaugeLagIgnoresLaterRewrite(t *testing.T) {
	dsn := newGaugeTestDSN(t)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed %q: %v", sql, err)
		}
	}
	var userID, itemID string
	if err := pool.QueryRow(ctx, `INSERT INTO app_user (email) VALUES ('aba@example.test') RETURNING id::text`).Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO item (user_id, name, name_normalized) VALUES ($1::uuid, 'alpha', 'alpha') RETURNING id::text`, userID,
	).Scan(&itemID); err != nil {
		t.Fatalf("seed item: %v", err)
	}
	exec(`INSERT INTO embedding_generation
	        (id, provider, model, model_version, preprocessing, query_prefix, doc_prefix, dims,
	         partitions, semantic_min_cos, calibration_ref, item_table, tag_table, state, bootstrap)
	      VALUES (1, 'tei', 'm', 'v1', 'v1', '', '', 3, 2, 0.5, 'ref', 'item_embedding_g1', 'tag_embedding_g1', 'active', false)`)
	exec(`SELECT embedding_generation_create_tables(1, 3, 2, false, 16, 128)`)

	hashHex := strings.Repeat("ab", 32)
	// base = 10 phút trước (trong cửa sổ 15 phút); vector hiện tại ghi lúc base+101 s.
	exec(`INSERT INTO item_embedding_g1 (user_id, target_id, embedding, model, model_version, input_hash, embedded_at)
	      VALUES ($1::uuid, $2::uuid, '[0.1,0.2,0.3]'::vector, 'm', 'v1', decode($3, 'hex'),
	              now() - interval '10 minutes' + interval '101 seconds')`, userID, itemID, hashHex)
	exec(`INSERT INTO river_job (state, max_attempts, created_at, finalized_at, kind, args, queue)
	      SELECT 'completed'::river_job_state, 30,
	             now() - interval '10 minutes' + c.created_off, now() - interval '10 minutes' + c.finalized_off,
	             'embed_item',
	             jsonb_build_object('generation_id', 1, 'user_id', $1::text, 'target_id', $2::text, 'input_hash', $3::text),
	             'embedding'
	        FROM (VALUES (interval '0 seconds', interval '1 second'),
	                     (interval '100 seconds', interval '101 seconds')) AS c(created_off, finalized_off)`,
		userID, itemID, hashHex)

	lags, err := obs.NewDBGaugeSource(pool).JobLag(ctx)
	if err != nil {
		t.Fatalf("JobLag: %v", err)
	}
	var found bool
	for _, s := range lags {
		if s.Corpus == "item" && s.Role == "active" {
			found = true
			if math.Abs(s.Seconds-1) > 1e-6 {
				t.Errorf("lag{item,active} = %v, want 1 (job 1 must not take the later rewrite)", s.Seconds)
			}
		}
	}
	if !found {
		t.Fatalf("no lag sample for item/active: %+v", lags)
	}
}

// TestDBGaugesCached15s: hai scrape trong 15 s chỉ đọc DB một lần, sau 15 s đọc
// lại; nhiều scrape đồng thời cũng chỉ một lần nạp; và router dựng như `main`
// (NewRegistry + RegisterGauges(NewDBGaugeSource) + promhttp.HandlerFor) trả
// `/metrics` có đủ ba tên gauge (N2/FS-31).
func TestDBGaugesCached15s(t *testing.T) {
	dsn := newGaugeTestDSN(t)
	pool := dbtest.Pool(t, dsn)
	seedGaugeFixture(t, pool)

	clock := &fakeClock{t: time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC)}
	counter := &countingQuerier{inner: pool}
	src := obs.NewDBGaugeSourceWithClock(counter, clock.Now)

	reg, _ := obs.NewRegistry()
	if err := obs.RegisterGauges(reg, src); err != nil {
		t.Fatalf("RegisterGauges: %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))

	scrape := func() string {
		t.Helper()
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("/metrics status = %d", rec.Code)
		}
		return rec.Body.String()
	}

	body := scrape()
	for _, name := range []string{
		"embedding_job_lag_seconds",
		"embedding_dead_letter_jobs",
		"embedding_generation_coverage_ratio",
	} {
		if !strings.Contains(body, name) {
			t.Errorf("/metrics missing %s", name)
		}
	}
	for _, line := range []string{
		`embedding_job_lag_seconds{corpus="item",role="active"} 4`,
		`embedding_dead_letter_jobs 2`,
		`embedding_generation_coverage_ratio{corpus="item",generation="1"} 0.5`,
	} {
		if !strings.Contains(body, line) {
			t.Errorf("/metrics missing line %q", line)
		}
	}
	perLoad := counter.n.Load()
	if perLoad == 0 {
		t.Fatal("first scrape issued no DB queries")
	}

	clock.Advance(14 * time.Second)
	scrape()
	if got := counter.n.Load(); got != perLoad {
		t.Fatalf("scrape within 15s: DB queries = %d, want %d (cache hit)", got, perLoad)
	}

	clock.Advance(1 * time.Second) // đúng 15 s kể từ lần nạp đầu: hết hạn
	scrape()
	if got := counter.n.Load(); got != 2*perLoad {
		t.Fatalf("scrape after 15s: DB queries = %d, want %d (one reload)", got, 2*perLoad)
	}

	// Stampede: hết hạn rồi 16 scrape đồng thời → đúng một lần nạp.
	clock.Advance(15 * time.Second)
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
		}()
	}
	wg.Wait()
	if got := counter.n.Load(); got != 3*perLoad {
		t.Fatalf("16 concurrent scrapes: DB queries = %d, want %d (single load)", got, 3*perLoad)
	}
}
