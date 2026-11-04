package lifecycle_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/embedding/lifecycle"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/item"
)

// One Postgres container per package (plan gate 10); every test gets its own
// database inside it.
var (
	sharedBaseDSNOnce sync.Once
	sharedBaseDSN     string
	sharedBaseErr     error
	sharedContainer   testcontainers.Container
)

func TestMain(m *testing.M) {
	code := m.Run()
	if sharedContainer != nil {
		_ = testcontainers.TerminateContainer(sharedContainer)
	}
	os.Exit(code)
}

func basePostgresDSN(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping Postgres integration test in -short mode")
	}
	if envDSN := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL")); envDSN != "" {
		return envDSN
	}
	sharedBaseDSNOnce.Do(func() {
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
			sharedBaseErr = err
			return
		}
		sharedContainer = c
		sharedBaseDSN, sharedBaseErr = c.ConnectionString(ctx, "sslmode=disable")
	})
	if sharedBaseErr != nil {
		t.Fatalf("start shared Postgres container: %v", sharedBaseErr)
	}
	return sharedBaseDSN
}

func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	base := basePostgresDSN(t)
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse base DSN: %v", err)
	}
	var nonce [6]byte
	_, _ = rand.Read(nonce[:])
	dbName := "engram_lifecycle_" + hex.EncodeToString(nonce[:])

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
	_ = conn.Close(ctx)

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
	return dbtest.Pool(t, dsn)
}

// calib is a calibration lookup that knows every identity (the real lookup is
// covered by the embedding package tests).
func calib(embedid.Identity) (float64, string, bool) {
	return 0.55, "docs/benchmarks/semantic-eval/report.json", true
}

func noCalib(embedid.Identity) (float64, string, bool) { return 0, "", false }

// model is one deterministic fake embedding "model": a fake TEI server plus the
// client built against it. Two models with the same dims and different sha are
// two embedding spaces (different Identity.Key); different dims are two shapes.
type model struct {
	srv    *embedtest.Server
	client embedding.Client
}

func (m model) ident() embedid.Identity { return m.client.Identity }

type env struct {
	t      *testing.T
	ctx    context.Context
	pool   *pgxpool.Pool
	q      *gen.Queries
	insert *river.Client[pgx.Tx]
	enq    *jobs.Enqueuer
}

func newEnv(t *testing.T) *env {
	t.Helper()
	pool := newTestPool(t)
	insert, err := river.NewClient(riverpgxv5.New(pool), &river.Config{SkipUnknownJobCheck: true})
	if err != nil {
		t.Fatalf("river.NewClient: %v", err)
	}
	return &env{
		t:      t,
		ctx:    context.Background(),
		pool:   pool,
		q:      gen.New(pool),
		insert: insert,
		enq:    jobs.NewEnqueuer(insert, true, embedding.ProviderTEI, nil),
	}
}

func (e *env) model(dims int, sha string) model {
	e.t.Helper()
	srv := embedtest.NewServer(embedtest.Options{Dims: dims, ModelID: "BAAI/bge-m3", ModelSHA: sha})
	e.t.Cleanup(srv.Close)
	c, err := embedding.NewClientFromConfig(e.ctx, embedding.ClientConfig{
		Provider:    embedding.ProviderTEI,
		BaseURL:     embedding.NewEndpoint(srv.URL()),
		Dims:        dims,
		QueryPrefix: "query: ",
		DocPrefix:   "passage: ",
	}, embedding.RolePrimary, embedding.ClientDeps{})
	if err != nil {
		e.t.Fatalf("tei client: %v", err)
	}
	return model{srv: srv, client: c}
}

func (e *env) clientSet(primary model, shadow *model) *embedding.ClientSet {
	if shadow == nil {
		return embedding.NewClientSet(primary.client, nil)
	}
	sc := shadow.client
	return embedding.NewClientSet(primary.client, &sc)
}

func (e *env) deps(cs *embedding.ClientSet) jobs.Dependencies {
	return jobs.Dependencies{
		Pool:      e.pool,
		ClientSet: cs,
		Inserter:  jobs.RiverClientInserter{Client: e.insert},
	}
}

// bootstrap creates g1 pending (HNSW built, tables empty) through the same
// function worker boot uses.
func (e *env) bootstrap(m model) generation.Generation {
	e.t.Helper()
	res, err := generation.Bootstrap(e.ctx, e.pool, m.ident(), calib)
	if err != nil {
		e.t.Fatalf("Bootstrap: %v", err)
	}
	if !res.Created || res.Generation.State != generation.StatePending || !res.Generation.Bootstrap {
		e.t.Fatalf("Bootstrap result = %+v, want a pending bootstrap generation", res)
	}
	return res.Generation
}

// bootstrapActive bootstraps g1 on an empty deployment and lets the real
// AutoFlipBootstrap activate it.
func (e *env) bootstrapActive(m model) generation.Generation {
	e.t.Helper()
	g := e.bootstrap(m)
	out, err := lifecycle.AutoFlipBootstrap(e.ctx, e.pool, lifecycle.AutoFlipOpts{})
	if err != nil {
		e.t.Fatalf("AutoFlipBootstrap on empty deployment: %v", err)
	}
	if out.Action != lifecycle.ActionFlipped {
		e.t.Fatalf("AutoFlipBootstrap on empty deployment = %+v, want flipped", out)
	}
	return e.gen(g.ID)
}

func (e *env) gen(id int) generation.Generation {
	e.t.Helper()
	g, err := generation.GetByID(e.ctx, e.pool, id)
	if err != nil {
		e.t.Fatalf("GetByID(%d): %v", id, err)
	}
	return g
}

func (e *env) create(m model) generation.Generation {
	e.t.Helper()
	g, err := lifecycle.Create(e.ctx, e.pool, m.ident(), calib, lifecycle.CreateOpts{Partitions: 2, M: 8, EfConstruction: 32})
	if err != nil {
		e.t.Fatalf("lifecycle.Create: %v", err)
	}
	if g.State != generation.StatePending || g.Bootstrap {
		e.t.Fatalf("Create returned %+v, want a pending non-bootstrap generation", g)
	}
	return g
}

func (e *env) user(email string) uuid.UUID {
	e.t.Helper()
	u, err := e.q.InsertUser(e.ctx, gen.InsertUserParams{Email: email, Locale: "vi"})
	if err != nil {
		e.t.Fatalf("InsertUser: %v", err)
	}
	return u.ID
}

// mutate runs fn in one transaction, the way an API mutation does.
func (e *env) mutate(fn func(tx pgx.Tx) error) {
	e.t.Helper()
	tx, err := e.pool.Begin(e.ctx)
	if err != nil {
		e.t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := fn(tx); err != nil {
		e.t.Fatalf("mutation: %v", err)
	}
	if err := tx.Commit(e.ctx); err != nil {
		e.t.Fatalf("commit: %v", err)
	}
}

func (e *env) newItem(user uuid.UUID, name, hint string) uuid.UUID {
	e.t.Helper()
	var id uuid.UUID
	e.mutate(func(tx pgx.Tx) error {
		var h *string
		if hint != "" {
			h = &hint
		}
		row, err := gen.New(tx).InsertItem(e.ctx, gen.InsertItemParams{
			UserID: user, Name: name, NameNormalized: strings.ToLower(name), Hint: h,
		})
		if err != nil {
			return err
		}
		id = row.ID
		return e.enq.OnUpsert(e.ctx, tx, user, item.EmbedKindItem, id, embedding.ItemInput(name, hint))
	})
	return id
}

func (e *env) newTag(user uuid.UUID, display string) uuid.UUID {
	e.t.Helper()
	var id uuid.UUID
	e.mutate(func(tx pgx.Tx) error {
		row, err := gen.New(tx).InsertTag(e.ctx, gen.InsertTagParams{
			UserID: user, Display: display, Normalized: strings.ToLower(display),
		})
		if err != nil {
			return err
		}
		id = row.ID
		return e.enq.OnUpsert(e.ctx, tx, user, item.EmbedKindTag, id, embedding.TagInput(display))
	})
	return id
}

func (e *env) renameItem(user, id uuid.UUID, name, hint string) {
	e.t.Helper()
	e.mutate(func(tx pgx.Tx) error {
		if _, err := tx.Exec(e.ctx, `UPDATE item SET name = $2, name_normalized = $3 WHERE id = $1`,
			id, name, strings.ToLower(name)); err != nil {
			return err
		}
		return e.enq.OnUpsert(e.ctx, tx, user, item.EmbedKindItem, id, embedding.ItemInput(name, hint))
	})
}

func (e *env) deleteItem(user, id uuid.UUID) {
	e.t.Helper()
	e.mutate(func(tx pgx.Tx) error {
		if _, err := tx.Exec(e.ctx, `UPDATE item SET deleted_at = now() WHERE id = $1`, id); err != nil {
			return err
		}
		return e.enq.OnDelete(e.ctx, tx, user, item.EmbedKindItem, id)
	})
}

func (e *env) restoreItem(user, id uuid.UUID, name, hint string) {
	e.t.Helper()
	e.mutate(func(tx pgx.Tx) error {
		if _, err := tx.Exec(e.ctx, `UPDATE item SET deleted_at = NULL WHERE id = $1`, id); err != nil {
			return err
		}
		return e.enq.OnUpsert(e.ctx, tx, user, item.EmbedKindItem, id, embedding.ItemInput(name, hint))
	})
}

// runJob executes one embed job through the real T11a worker.
func (e *env) runJob(deps jobs.Dependencies, id int64, kind string, raw []byte) error {
	e.t.Helper()
	row := &rivertype.JobRow{ID: id, Attempt: 1}
	switch kind {
	case jobargs.KindEmbedItem:
		var a jobargs.EmbedItemArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			e.t.Fatalf("decode embed_item args: %v", err)
		}
		return jobs.NewEmbedItemWorker(deps).Work(e.ctx, &river.Job[jobargs.EmbedItemArgs]{JobRow: row, Args: a})
	case jobargs.KindEmbedTag:
		var a jobargs.EmbedTagArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			e.t.Fatalf("decode embed_tag args: %v", err)
		}
		return jobs.NewEmbedTagWorker(deps).Work(e.ctx, &river.Job[jobargs.EmbedTagArgs]{JobRow: row, Args: a})
	}
	e.t.Fatalf("unexpected job kind %q", kind)
	return nil
}

type queuedJob struct {
	id   int64
	kind string
	raw  []byte
	gen  int
}

// availableJobs lists available embed jobs, optionally only of generation genID
// (0 = every generation).
func (e *env) availableJobs(genID int) []queuedJob {
	e.t.Helper()
	rows, err := e.pool.Query(e.ctx, `
SELECT id, kind, args, (args->>'generation_id')::int FROM river_job
WHERE kind IN ($1, $2) AND state = 'available'
  AND ($3 = 0 OR (args->>'generation_id')::int = $3)
ORDER BY id`, jobargs.KindEmbedItem, jobargs.KindEmbedTag, genID)
	if err != nil {
		e.t.Fatalf("list jobs: %v", err)
	}
	defer rows.Close()
	var out []queuedJob
	for rows.Next() {
		var j queuedJob
		if err := rows.Scan(&j.id, &j.kind, &j.raw, &j.gen); err != nil {
			e.t.Fatalf("scan job: %v", err)
		}
		out = append(out, j)
	}
	if err := rows.Err(); err != nil {
		e.t.Fatalf("jobs rows: %v", err)
	}
	return out
}

func (e *env) complete(id int64) {
	e.t.Helper()
	if _, err := e.pool.Exec(e.ctx,
		`UPDATE river_job SET state = 'completed', finalized_at = now() WHERE id = $1`, id); err != nil {
		e.t.Fatalf("complete job: %v", err)
	}
}

// drain runs every available embed job (of genID, or all when 0) through the
// real workers and marks it completed, repeating until none is left (a worker
// may insert a replacement job). It returns how many jobs ran.
func (e *env) drain(deps jobs.Dependencies, genID int) int {
	e.t.Helper()
	total := 0
	for round := 0; round < 20; round++ {
		queued := e.availableJobs(genID)
		if len(queued) == 0 {
			return total
		}
		for _, j := range queued {
			if err := e.runJob(deps, j.id, j.kind, j.raw); err != nil {
				e.t.Fatalf("worker for job %d (%s, generation %d): %v", j.id, j.kind, j.gen, err)
			}
			e.complete(j.id)
			total++
		}
	}
	e.t.Fatalf("drain did not converge")
	return total
}

func (e *env) meta(g generation.Generation, kind generation.Corpus, user, target uuid.UUID) (store.StoredVector, bool) {
	e.t.Helper()
	m, ok, err := store.GetTargetMeta(e.ctx, e.pool, g, kind, user, target)
	if err != nil {
		e.t.Fatalf("GetTargetMeta: %v", err)
	}
	return m, ok
}

func (e *env) wantVector(g generation.Generation, kind generation.Corpus, user, target uuid.UUID, input string) {
	e.t.Helper()
	m, ok := e.meta(g, kind, user, target)
	if !ok {
		e.t.Fatalf("generation %d: no %s vector for the target", g.ID, kind)
	}
	want := embedding.InputHashFor(g.Identity(), input)
	if !bytes.Equal(m.InputHash, want[:]) {
		e.t.Fatalf("generation %d: %s vector has a stale input_hash", g.ID, kind)
	}
	if m.Model != g.Model || m.ModelVersion != g.ModelVersion {
		e.t.Fatalf("generation %d: %s vector model/version = %q/%q, want %q/%q", g.ID, kind, m.Model, m.ModelVersion, g.Model, g.ModelVersion)
	}
}

func (e *env) wantNoVector(g generation.Generation, kind generation.Corpus, user, target uuid.UUID) {
	e.t.Helper()
	if _, ok := e.meta(g, kind, user, target); ok {
		e.t.Fatalf("generation %d: unexpected %s vector", g.ID, kind)
	}
}

func (e *env) rows(g generation.Generation, kind generation.Corpus) int {
	e.t.Helper()
	tbl, err := store.SanitizedTable(g, kind)
	if err != nil {
		e.t.Fatalf("SanitizedTable: %v", err)
	}
	var n int
	if err := e.pool.QueryRow(e.ctx, `SELECT count(*)::int FROM `+tbl).Scan(&n); err != nil {
		e.t.Fatalf("count rows: %v", err)
	}
	return n
}

func (e *env) vectorDims(g generation.Generation, kind generation.Corpus) []int {
	e.t.Helper()
	tbl, err := store.SanitizedTable(g, kind)
	if err != nil {
		e.t.Fatalf("SanitizedTable: %v", err)
	}
	rows, err := e.pool.Query(e.ctx, `SELECT DISTINCT vector_dims(embedding) FROM `+tbl+` ORDER BY 1`)
	if err != nil {
		e.t.Fatalf("vector dims: %v", err)
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var d int
		if err := rows.Scan(&d); err != nil {
			e.t.Fatalf("scan dims: %v", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		e.t.Fatalf("dims rows: %v", err)
	}
	return out
}

func (e *env) backfill(g generation.Generation) {
	e.t.Helper()
	if _, err := lifecycle.Backfill(e.ctx, e.pool, g.ID, jobs.ReembedEnqueueFunc(jobs.RiverClientInserter{Client: e.insert})); err != nil {
		e.t.Fatalf("Backfill: %v", err)
	}
}

// ready backfills, runs every job, indexes and verifies pending generation g
// and requires the verification to pass.
func (e *env) ready(g generation.Generation, cs *embedding.ClientSet) lifecycle.VerifyReport {
	e.t.Helper()
	e.backfill(g)
	e.drain(e.deps(cs), 0)
	if _, err := lifecycle.Index(e.ctx, e.pool, g.ID); err != nil {
		e.t.Fatalf("Index: %v", err)
	}
	rep, err := lifecycle.Verify(e.ctx, e.pool, g.ID, lifecycle.VerifyOpts{})
	if err != nil {
		e.t.Fatalf("Verify: %v", err)
	}
	if !rep.Passed {
		e.t.Fatalf("Verify did not pass: %+v", rep)
	}
	return rep
}

func (e *env) activeID() int {
	e.t.Helper()
	row, err := e.q.GetEmbeddingActiveRow(e.ctx)
	if err != nil {
		e.t.Fatalf("GetEmbeddingActiveRow: %v", err)
	}
	return int(row.GenerationID)
}

func (e *env) hasActive() bool {
	e.t.Helper()
	_, err := e.q.GetEmbeddingActiveRow(e.ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return false
	}
	if err != nil {
		e.t.Fatalf("GetEmbeddingActiveRow: %v", err)
	}
	return true
}

func (e *env) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(e.ctx, sql, args...); err != nil {
		e.t.Fatalf("exec %q: %v", sql, err)
	}
}

func hashHex(g generation.Generation, input string) string {
	h := embedding.InputHashFor(g.Identity(), input)
	return hex.EncodeToString(h[:])
}

func parseVector(t *testing.T, s string) []float32 {
	t.Helper()
	s = strings.TrimSpace(s)
	if len(s) < 2 || s[0] != '[' || s[len(s)-1] != ']' {
		t.Fatalf("unexpected vector text")
	}
	parts := strings.Split(s[1:len(s)-1], ",")
	out := make([]float32, len(parts))
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 32)
		if err != nil {
			t.Fatalf("parse vector: %v", err)
		}
		out[i] = float32(f)
	}
	return out
}

// storedVector reads one stored vector back (used as a query vector).
func (e *env) storedVector(g generation.Generation, kind generation.Corpus, user, target uuid.UUID) []float32 {
	e.t.Helper()
	tbl, err := store.SanitizedTable(g, kind)
	if err != nil {
		e.t.Fatalf("SanitizedTable: %v", err)
	}
	var txt string
	if err := e.pool.QueryRow(e.ctx,
		`SELECT embedding::text FROM `+tbl+` WHERE user_id = $1 AND target_id = $2`, user, target).Scan(&txt); err != nil {
		e.t.Fatalf("read stored vector: %v", err)
	}
	return parseVector(e.t, txt)
}

func mustErrorIs(t *testing.T, what string, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("%s: err = %v, want %v", what, err, want)
	}
}
