package reconcile_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"go/parser"
	"go/token"
	"net/url"
	"os"
	"path/filepath"
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
	"github.com/zone17th/engram/apps/api/internal/embedding/reconcile"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

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
	dbName := "engram_reconcile_" + hex.EncodeToString(nonce[:])

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

func seedGeneration(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	id int,
	ident embedid.Identity,
	state string,
) generation.Generation {
	t.Helper()
	q := gen.New(pool)
	row, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 int32(id),
		Provider:           ident.Provider,
		Model:              ident.Model,
		ModelVersion:       ident.ModelVersion,
		Preprocessing:      ident.Preprocessing,
		QueryPrefix:        ident.QueryPrefix,
		DocPrefix:          ident.DocPrefix,
		Dims:               int32(ident.Dims),
		Partitions:         4,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.55,
		CalibrationRef:     "docs/benchmarks/semantic-eval/report.json",
		Bootstrap:          id == 1,
	})
	if err != nil {
		t.Fatalf("InsertPendingEmbeddingGeneration g%d: %v", id, err)
	}
	if err := q.CreateEmbeddingGenerationTables(ctx, gen.CreateEmbeddingGenerationTablesParams{
		ID:                 int32(id),
		Dims:               int32(ident.Dims),
		Partitions:         4,
		WithHnsw:           false,
		HnswM:              16,
		HnswEfConstruction: 64,
	}); err != nil {
		t.Fatalf("CreateEmbeddingGenerationTables g%d: %v", id, err)
	}
	switch state {
	case generation.StateActive:
		row, err = q.ActivateEmbeddingGeneration(ctx, int32(id))
		if err != nil {
			t.Fatalf("ActivateEmbeddingGeneration g%d: %v", id, err)
		}
		reason := "test"
		if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
			GenerationID:  int32(id),
			FlippedReason: &reason,
		}); err != nil {
			t.Fatalf("UpsertEmbeddingActive g%d: %v", id, err)
		}
	case generation.StateRetired:
		row, err = q.RetireEmbeddingGeneration(ctx, gen.RetireEmbeddingGenerationParams{ID: int32(id)})
		if err != nil {
			t.Fatalf("RetireEmbeddingGeneration g%d: %v", id, err)
		}
	}
	g, err := generation.FromDBRow(row)
	if err != nil {
		t.Fatalf("FromDBRow g%d: %v", id, err)
	}
	return g
}

func teiIdentity(t *testing.T, srv *embedtest.Server) embedid.Identity {
	t.Helper()
	c, err := embedding.NewClientFromConfig(context.Background(), embedding.ClientConfig{
		Provider:    embedding.ProviderTEI,
		BaseURL:     embedding.NewEndpoint(srv.URL()),
		Dims:        8,
		QueryPrefix: "query: ",
		DocPrefix:   "passage: ",
	}, embedding.RolePrimary, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("tei client: %v", err)
	}
	return c.Identity
}

func teiClient(t *testing.T, srv *embedtest.Server) embedding.Client {
	t.Helper()
	c, err := embedding.NewClientFromConfig(context.Background(), embedding.ClientConfig{
		Provider:    embedding.ProviderTEI,
		BaseURL:     embedding.NewEndpoint(srv.URL()),
		Dims:        8,
		QueryPrefix: "query: ",
		DocPrefix:   "passage: ",
	}, embedding.RolePrimary, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("tei client: %v", err)
	}
	return c
}

func openAIIdentity(t *testing.T, srv *embedtest.Server) embedid.Identity {
	t.Helper()
	c, err := embedding.NewClientFromConfig(context.Background(), embedding.ClientConfig{
		Provider:         embedding.ProviderOpenAICompat,
		BaseURL:          embedding.NewEndpoint(srv.URL() + "/v1"),
		APIKey:           embedding.NewSecret("sk-test-reconcile-key"),
		Model:            "openrouter/qwen/qwen3-embedding-8b",
		Dims:             8,
		QueryInstruction: "Retrieve items",
	}, embedding.RoleShadow, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("openai client: %v", err)
	}
	return c.Identity
}

func newInsertClient(t *testing.T, pool *pgxpool.Pool) *river.Client[pgx.Tx] {
	t.Helper()
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{SkipUnknownJobCheck: true})
	if err != nil {
		t.Fatalf("river.NewClient: %v", err)
	}
	return client
}

type fixture struct {
	ctx    context.Context
	pool   *pgxpool.Pool
	q      *gen.Queries
	client *river.Client[pgx.Tx]
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	pool := newTestPool(t)
	return &fixture{ctx: context.Background(), pool: pool, q: gen.New(pool), client: newInsertClient(t, pool)}
}

func (f *fixture) enq() reconcile.EnqueueFunc {
	return jobs.ReembedEnqueueFunc(jobs.RiverClientInserter{Client: f.client})
}

func (f *fixture) reconcile(t *testing.T, g generation.Generation, scope reconcile.Scope, mode reconcile.Mode) reconcile.Result {
	t.Helper()
	res, err := reconcile.Reconcile(f.ctx, f.pool, g, scope, mode, f.enq())
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	return res
}

func (f *fixture) user(t *testing.T, email string, suggestOn bool) uuid.UUID {
	t.Helper()
	u, err := f.q.InsertUser(f.ctx, gen.InsertUserParams{Email: email, Locale: "vi"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	if !suggestOn {
		if _, err := f.pool.Exec(f.ctx,
			`UPDATE app_user SET settings = jsonb_set(settings, '{semantic_suggest}', 'false'::jsonb) WHERE id = $1`, u.ID); err != nil {
			t.Fatalf("set semantic_suggest=false: %v", err)
		}
	}
	return u.ID
}

func (f *fixture) item(t *testing.T, user uuid.UUID, name, hint string) uuid.UUID {
	t.Helper()
	var h *string
	if hint != "" {
		h = &hint
	}
	row, err := f.q.InsertItem(f.ctx, gen.InsertItemParams{
		UserID: user, Name: name, NameNormalized: strings.ToLower(name), Hint: h,
	})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}
	return row.ID
}

func (f *fixture) tag(t *testing.T, user uuid.UUID, display string) uuid.UUID {
	t.Helper()
	row, err := f.q.InsertTag(f.ctx, gen.InsertTagParams{
		UserID: user, Display: display, Normalized: strings.ToLower(display),
	})
	if err != nil {
		t.Fatalf("InsertTag: %v", err)
	}
	return row.ID
}

// put stores a vector whose input_hash matches input under g's identity.
func (f *fixture) put(t *testing.T, g generation.Generation, kind generation.Corpus, user, target uuid.UUID, input string) {
	t.Helper()
	h := embedding.InputHashFor(g.Identity(), input)
	vec := make([]float32, g.Dims)
	vec[0] = 1
	if err := store.Upsert(f.ctx, f.pool, g, kind, user, target, vec, h[:]); err != nil {
		t.Fatalf("store.Upsert: %v", err)
	}
}

func (f *fixture) vectors(t *testing.T, g generation.Generation, kind generation.Corpus, user uuid.UUID) int {
	t.Helper()
	tbl, err := store.SanitizedTable(g, kind)
	if err != nil {
		t.Fatalf("SanitizedTable: %v", err)
	}
	var n int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*)::int FROM `+tbl+` WHERE user_id = $1`, user).Scan(&n); err != nil {
		t.Fatalf("count vectors: %v", err)
	}
	return n
}

func (f *fixture) hasVector(t *testing.T, g generation.Generation, kind generation.Corpus, user, target uuid.UUID) bool {
	t.Helper()
	_, ok, err := store.GetTargetMeta(f.ctx, f.pool, g, kind, user, target)
	if err != nil {
		t.Fatalf("GetTargetMeta: %v", err)
	}
	return ok
}

// jobHashes returns target_id -> input_hash for queued jobs of kind in generation genID.
func (f *fixture) jobHashes(t *testing.T, kind string, genID int) map[string]string {
	t.Helper()
	rows, err := f.pool.Query(f.ctx,
		`SELECT args->>'target_id', args->>'input_hash' FROM river_job
		 WHERE kind = $1 AND (args->>'generation_id')::int = $2`, kind, genID)
	if err != nil {
		t.Fatalf("query river_job: %v", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var target, hash string
		if err := rows.Scan(&target, &hash); err != nil {
			t.Fatalf("scan river_job: %v", err)
		}
		out[target] = hash
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("river_job rows: %v", err)
	}
	return out
}

func (f *fixture) jobCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*)::int FROM river_job`).Scan(&n); err != nil {
		t.Fatalf("count river_job: %v", err)
	}
	return n
}

func hexHash(g generation.Generation, input string) string {
	h := embedding.InputHashFor(g.Identity(), input)
	return hex.EncodeToString(h[:])
}

func wantInt(t *testing.T, what string, got, want int) {
	t.Helper()
	if got != want {
		t.Fatalf("%s = %d, want %d", what, got, want)
	}
}

// TestReconcileOffEditOn: while the deployment is off nothing enqueues, so edits
// leave vectors stale; Reconcile later enqueues exactly the changed set.
func TestReconcileOffEditOn(t *testing.T) {
	f := newFixture(t)
	srv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "rev-r1"})
	defer srv.Close()
	g := seedGeneration(t, f.ctx, f.pool, 1, teiIdentity(t, srv), generation.StateActive)

	u := f.user(t, "off-edit-on@example.com", true)
	a := f.item(t, u, "Alpha item", "hint a")
	b := f.item(t, u, "Bravo item", "hint b")
	c := f.item(t, u, "Charlie item", "")
	t1 := f.tag(t, u, "Tag-one")
	t2 := f.tag(t, u, "Tag-two")
	f.put(t, g, generation.CorpusItem, u, a, embedding.ItemInput("Alpha item", "hint a"))
	f.put(t, g, generation.CorpusItem, u, b, embedding.ItemInput("Bravo item", "hint b"))
	f.put(t, g, generation.CorpusItem, u, c, embedding.ItemInput("Charlie item", ""))
	f.put(t, g, generation.CorpusTag, u, t1, embedding.TagInput("Tag-one"))
	f.put(t, g, generation.CorpusTag, u, t2, embedding.TagInput("Tag-two"))

	// Deployment off: edits write rows with no enqueue.
	if _, err := f.pool.Exec(f.ctx, `UPDATE item SET name = 'Alpha renamed', name_normalized = 'alpha renamed' WHERE id = $1`, a); err != nil {
		t.Fatalf("edit name: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE item SET hint = 'hint b2' WHERE id = $1`, b); err != nil {
		t.Fatalf("edit hint: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE tag SET display = 'Tag-uno', normalized = 'tag-uno' WHERE id = $1`, t1); err != nil {
		t.Fatalf("edit tag: %v", err)
	}
	wantInt(t, "jobs before reconcile", f.jobCount(t), 0)

	res := f.reconcile(t, g, reconcile.All(), reconcile.ModeEnqueue)
	wantInt(t, "Scanned", res.Scanned, 5)
	wantInt(t, "Stale", res.Stale, 3)
	wantInt(t, "Missing", res.Missing, 0)
	wantInt(t, "Enqueued", res.Enqueued, 3)
	wantInt(t, "WouldEnqueue", res.WouldEnqueue, 0)

	items := f.jobHashes(t, jobargs.KindEmbedItem, g.ID)
	if len(items) != 2 {
		t.Fatalf("embed_item jobs = %d, want 2", len(items))
	}
	if got, want := items[a.String()], hexHash(g, embedding.ItemInput("Alpha renamed", "hint a")); got != want {
		t.Fatalf("item a job input_hash = %q, want %q", got, want)
	}
	if got, want := items[b.String()], hexHash(g, embedding.ItemInput("Bravo item", "hint b2")); got != want {
		t.Fatalf("item b job input_hash = %q, want %q", got, want)
	}
	tags := f.jobHashes(t, jobargs.KindEmbedTag, g.ID)
	if len(tags) != 1 || tags[t1.String()] != hexHash(g, embedding.TagInput("Tag-uno")) {
		t.Fatalf("embed_tag jobs = %d, want exactly the renamed tag with its new hash", len(tags))
	}

	// A second run deduplicates by args: still three queued jobs.
	f.reconcile(t, g, reconcile.All(), reconcile.ModeEnqueue)
	wantInt(t, "jobs after second reconcile", f.jobCount(t), 3)
}

// TestReconcileOpenAICompatSkipsAndDeletesUserOff: an openai_compat generation
// never enqueues for a user with semantic_suggest=false and holds none of their
// vectors afterwards.
func TestReconcileOpenAICompatSkipsAndDeletesUserOff(t *testing.T) {
	f := newFixture(t)
	srv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer srv.Close()
	g := seedGeneration(t, f.ctx, f.pool, 1, openAIIdentity(t, srv), generation.StateActive)

	off := f.user(t, "oa-off@example.com", false)
	on := f.user(t, "oa-on@example.com", true)
	o1 := f.item(t, off, "Off one", "")
	o2 := f.item(t, off, "Off two", "")
	ot := f.tag(t, off, "off-tag")
	n1 := f.item(t, on, "On one", "")
	f.put(t, g, generation.CorpusItem, off, o1, embedding.ItemInput("Off one", ""))
	f.put(t, g, generation.CorpusItem, off, o2, embedding.ItemInput("Off two", ""))
	f.put(t, g, generation.CorpusTag, off, ot, embedding.TagInput("off-tag"))

	res := f.reconcile(t, g, reconcile.All(), reconcile.ModeEnqueue)
	wantInt(t, "Enqueued", res.Enqueued, 1)
	wantInt(t, "SkippedUserOff", res.SkippedUserOff, 3)
	wantInt(t, "UserOffDeleted", res.UserOffDeleted, 3)

	if got := f.jobHashes(t, jobargs.KindEmbedItem, g.ID); len(got) != 1 || got[n1.String()] == "" {
		t.Fatalf("embed_item jobs = %v, want only the user-on item", got)
	}
	wantInt(t, "tag jobs", len(f.jobHashes(t, jobargs.KindEmbedTag, g.ID)), 0)
	wantInt(t, "off-user item vectors", f.vectors(t, g, generation.CorpusItem, off), 0)
	wantInt(t, "off-user tag vectors", f.vectors(t, g, generation.CorpusTag, off), 0)
}

// TestReconcileTEIIncludesUserOff: a tei generation embeds user-off users too and
// keeps their vectors.
func TestReconcileTEIIncludesUserOff(t *testing.T) {
	f := newFixture(t)
	srv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "rev-r1"})
	defer srv.Close()
	g := seedGeneration(t, f.ctx, f.pool, 1, teiIdentity(t, srv), generation.StateActive)

	off := f.user(t, "tei-off@example.com", false)
	missing := f.item(t, off, "Tei missing", "")
	kept := f.item(t, off, "Tei kept", "")
	f.put(t, g, generation.CorpusItem, off, kept, embedding.ItemInput("Tei kept", ""))

	res := f.reconcile(t, g, reconcile.All(), reconcile.ModeEnqueue)
	wantInt(t, "Enqueued", res.Enqueued, 1)
	wantInt(t, "SkippedUserOff", res.SkippedUserOff, 0)
	wantInt(t, "UserOffDeleted", res.UserOffDeleted, 0)
	if got := f.jobHashes(t, jobargs.KindEmbedItem, g.ID); len(got) != 1 || got[missing.String()] == "" {
		t.Fatalf("embed_item jobs = %v, want the missing user-off item", got)
	}
	if !f.hasVector(t, g, generation.CorpusItem, off, kept) {
		t.Fatal("tei generation lost a user-off vector")
	}
}

// TestReconcileMixedProviderGenerations: tei active + openai_compat pending:
// user-off is enqueued in tei, skipped and deleted in openai_compat.
func TestReconcileMixedProviderGenerations(t *testing.T) {
	f := newFixture(t)
	teiSrv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "rev-r1"})
	defer teiSrv.Close()
	oaSrv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer oaSrv.Close()
	gTEI := seedGeneration(t, f.ctx, f.pool, 1, teiIdentity(t, teiSrv), generation.StateActive)
	gOA := seedGeneration(t, f.ctx, f.pool, 2, openAIIdentity(t, oaSrv), generation.StatePending)

	off := f.user(t, "mixed-off@example.com", false)
	on := f.user(t, "mixed-on@example.com", true)
	offItem := f.item(t, off, "Mixed off", "")
	onItem := f.item(t, on, "Mixed on", "")
	f.put(t, gOA, generation.CorpusItem, off, offItem, embedding.ItemInput("Mixed off", ""))

	resTEI := f.reconcile(t, gTEI, reconcile.All(), reconcile.ModeEnqueue)
	wantInt(t, "tei Enqueued", resTEI.Enqueued, 2)
	wantInt(t, "tei SkippedUserOff", resTEI.SkippedUserOff, 0)

	resOA := f.reconcile(t, gOA, reconcile.All(), reconcile.ModeEnqueue)
	wantInt(t, "openai Enqueued", resOA.Enqueued, 1)
	wantInt(t, "openai SkippedUserOff", resOA.SkippedUserOff, 1)
	wantInt(t, "openai UserOffDeleted", resOA.UserOffDeleted, 1)

	teiJobs := f.jobHashes(t, jobargs.KindEmbedItem, gTEI.ID)
	if len(teiJobs) != 2 || teiJobs[offItem.String()] == "" || teiJobs[onItem.String()] == "" {
		t.Fatalf("tei jobs = %v, want both users", teiJobs)
	}
	oaJobs := f.jobHashes(t, jobargs.KindEmbedItem, gOA.ID)
	if len(oaJobs) != 1 || oaJobs[onItem.String()] == "" {
		t.Fatalf("openai jobs = %v, want only the user-on item", oaJobs)
	}
	if f.hasVector(t, gOA, generation.CorpusItem, off, offItem) {
		t.Fatal("openai_compat generation still holds a user-off vector")
	}
}

// TestBootReembedAllBackfillsBootstrapPending: the reembed_all worker (the boot
// job) reconciles g1 while it is still pending and enqueues every live target.
func TestBootReembedAllBackfillsBootstrapPending(t *testing.T) {
	f := newFixture(t)
	srv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "rev-r1"})
	defer srv.Close()
	g := seedGeneration(t, f.ctx, f.pool, 1, teiIdentity(t, srv), generation.StatePending)
	if !g.Bootstrap || g.State != generation.StatePending {
		t.Fatalf("g1 = bootstrap %v state %q, want bootstrap pending", g.Bootstrap, g.State)
	}

	u := f.user(t, "boot-backfill@example.com", true)
	i1 := f.item(t, u, "Boot one", "")
	i2 := f.item(t, u, "Boot two", "hint")
	t1 := f.tag(t, u, "boot-tag")

	w := jobs.NewReembedAllWorker(jobs.Dependencies{
		Pool:     f.pool,
		Inserter: jobs.RiverClientInserter{Client: f.client},
	})
	if err := w.Work(f.ctx, &river.Job[jobargs.ReembedAllArgs]{JobRow: &rivertype.JobRow{Attempt: 1}}); err != nil {
		t.Fatalf("ReembedAllWorker.Work: %v", err)
	}
	items := f.jobHashes(t, jobargs.KindEmbedItem, g.ID)
	if len(items) != 2 || items[i1.String()] == "" || items[i2.String()] == "" {
		t.Fatalf("embed_item jobs = %v, want both items of the pending bootstrap generation", items)
	}
	if tags := f.jobHashes(t, jobargs.KindEmbedTag, g.ID); len(tags) != 1 || tags[t1.String()] == "" {
		t.Fatalf("embed_tag jobs = %v, want the tag", tags)
	}
}

// TestModelVersionChangeMarksAllStale: a changed generation model_version (the
// hash covers it) marks every vector stale; a tampered stored model alone marks
// just that row stale.
func TestModelVersionChangeMarksAllStale(t *testing.T) {
	f := newFixture(t)
	srv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "rev-r1"})
	defer srv.Close()
	g := seedGeneration(t, f.ctx, f.pool, 1, teiIdentity(t, srv), generation.StateActive)

	u := f.user(t, "model-version@example.com", true)
	a := f.item(t, u, "Version a", "")
	b := f.item(t, u, "Version b", "")
	tg := f.tag(t, u, "version-tag")
	f.put(t, g, generation.CorpusItem, u, a, embedding.ItemInput("Version a", ""))
	f.put(t, g, generation.CorpusItem, u, b, embedding.ItemInput("Version b", ""))
	f.put(t, g, generation.CorpusTag, u, tg, embedding.TagInput("version-tag"))

	// Fresh: nothing to do.
	res := f.reconcile(t, g, reconcile.All(), reconcile.ModeEnqueue)
	wantInt(t, "fresh Enqueued", res.Enqueued, 0)
	wantInt(t, "fresh Scanned", res.Scanned, 3)

	// Stored model differs from the generation's, hash identical -> only that row.
	tbl, err := store.SanitizedTable(g, generation.CorpusItem)
	if err != nil {
		t.Fatalf("SanitizedTable: %v", err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE `+tbl+` SET model = 'older-model' WHERE target_id = $1`, a); err != nil {
		t.Fatalf("tamper model: %v", err)
	}
	res = f.reconcile(t, g, reconcile.All(), reconcile.ModeEnqueue)
	wantInt(t, "model-differs Stale", res.Stale, 1)
	wantInt(t, "model-differs Enqueued", res.Enqueued, 1)

	// The generation's model_version changes: every vector is stale.
	if _, err := f.pool.Exec(f.ctx, `UPDATE embedding_generation SET model_version = model_version || '-next' WHERE id = $1`, g.ID); err != nil {
		t.Fatalf("bump model_version: %v", err)
	}
	g2, err := generation.GetByID(f.ctx, f.pool, g.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	res = f.reconcile(t, g2, reconcile.All(), reconcile.ModeEnqueue)
	wantInt(t, "version-bump Stale", res.Stale, 3)
	wantInt(t, "version-bump Enqueued", res.Enqueued, 3)
}

// TestReembedAllOnlyCallsProviderForMissingOrStale: fresh vectors enqueue
// nothing; the queued jobs then run through the embed worker and the provider is
// called once per missing/stale target in batches of at most 64 inputs.
func TestReembedAllOnlyCallsProviderForMissingOrStale(t *testing.T) {
	f := newFixture(t)
	srv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "rev-r1"})
	defer srv.Close()
	client := teiClient(t, srv)
	g := seedGeneration(t, f.ctx, f.pool, 1, client.Identity, generation.StateActive)

	u := f.user(t, "provider-calls@example.com", true)
	for _, name := range []string{"Fresh one", "Fresh two", "Fresh three"} {
		id := f.item(t, u, name, "")
		f.put(t, g, generation.CorpusItem, u, id, embedding.ItemInput(name, ""))
	}
	missing := f.item(t, u, "Missing item", "")
	stale := f.item(t, u, "Stale item", "")
	f.put(t, g, generation.CorpusItem, u, stale, embedding.ItemInput("Stale item before edit", ""))

	srv.ResetCalls()
	res := f.reconcile(t, g, reconcile.All(), reconcile.ModeEnqueue)
	wantInt(t, "Enqueued", res.Enqueued, 2)
	wantInt(t, "Missing", res.Missing, 1)
	wantInt(t, "Stale", res.Stale, 1)
	if got := srv.Stats().TotalRequests; got != 0 {
		t.Fatalf("provider requests during Reconcile = %d, want 0", got)
	}

	queued := f.jobHashes(t, jobargs.KindEmbedItem, g.ID)
	if len(queued) != 2 || queued[missing.String()] == "" || queued[stale.String()] == "" {
		t.Fatalf("queued item jobs = %v, want exactly the missing and the stale item", queued)
	}

	_, m := obs.NewRegistry()
	worker := jobs.NewEmbedItemWorker(jobs.Dependencies{
		Pool:      f.pool,
		ClientSet: embedding.NewClientSet(client, nil),
		Breakers:  jobs.NewWorkerBreakers(time.Now, m.Embedding),
		Metrics:   m.Embedding,
		Inserter:  jobs.RiverClientInserter{Client: f.client},
	})
	for target, hash := range queued {
		err := worker.Work(f.ctx, &river.Job[jobargs.EmbedItemArgs]{
			JobRow: &rivertype.JobRow{Attempt: 1},
			Args: jobargs.EmbedItemArgs{
				GenerationID: g.ID,
				UserID:       u.String(),
				TargetID:     target,
				InputHash:    hash,
			},
		})
		if err != nil {
			t.Fatalf("EmbedItemWorker.Work: %v", err)
		}
	}
	wantInt(t, "document requests", int(srv.Stats().DocumentRequests), 2)
	for _, call := range srv.Calls() {
		if len(call.Inputs) > 64 {
			t.Fatalf("provider batch = %d inputs, want <= 64", len(call.Inputs))
		}
	}

	again := f.reconcile(t, g, reconcile.All(), reconcile.ModeEnqueue)
	wantInt(t, "Enqueued after jobs ran", again.Enqueued, 0)
	wantInt(t, "Stale after jobs ran", again.Stale+again.Missing, 0)
}

// TestReconcileDeletesOrphanVectors: vectors of soft-deleted targets are removed
// from the generation; DryRun only counts them and changes nothing.
func TestReconcileDeletesOrphanVectors(t *testing.T) {
	f := newFixture(t)
	srv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "rev-r1"})
	defer srv.Close()
	g := seedGeneration(t, f.ctx, f.pool, 1, teiIdentity(t, srv), generation.StateActive)

	u := f.user(t, "orphans@example.com", true)
	live := f.item(t, u, "Live item", "")
	gone := f.item(t, u, "Gone item", "")
	goneTag := f.tag(t, u, "gone-tag")
	f.put(t, g, generation.CorpusItem, u, live, embedding.ItemInput("Live item", ""))
	f.put(t, g, generation.CorpusItem, u, gone, embedding.ItemInput("Gone item", ""))
	f.put(t, g, generation.CorpusTag, u, goneTag, embedding.TagInput("gone-tag"))
	if _, err := f.q.SoftDeleteItem(f.ctx, gen.SoftDeleteItemParams{UserID: u, ID: gone}); err != nil {
		t.Fatalf("SoftDeleteItem: %v", err)
	}
	if _, err := f.q.SoftDeleteTag(f.ctx, gen.SoftDeleteTagParams{UserID: u, ID: goneTag}); err != nil {
		t.Fatalf("SoftDeleteTag: %v", err)
	}

	dry := f.reconcile(t, g, reconcile.All(), reconcile.ModeDryRun)
	wantInt(t, "dry WouldDeleteOrphan", dry.WouldDeleteOrphan, 2)
	wantInt(t, "dry OrphanDeleted", dry.OrphanDeleted, 0)
	wantInt(t, "dry item vectors", f.vectors(t, g, generation.CorpusItem, u), 2)
	wantInt(t, "dry tag vectors", f.vectors(t, g, generation.CorpusTag, u), 1)
	wantInt(t, "dry jobs", f.jobCount(t), 0)

	res := f.reconcile(t, g, reconcile.All(), reconcile.ModeEnqueue)
	wantInt(t, "OrphanDeleted", res.OrphanDeleted, 2)
	wantInt(t, "item vectors", f.vectors(t, g, generation.CorpusItem, u), 1)
	wantInt(t, "tag vectors", f.vectors(t, g, generation.CorpusTag, u), 0)
	if !f.hasVector(t, g, generation.CorpusItem, u, live) {
		t.Fatal("live item vector was deleted")
	}
}

// TestReconcileStopsWhenGenerationLeavesR: a generation outside R stops the run
// with a counted reason, no error and no job.
func TestReconcileStopsWhenGenerationLeavesR(t *testing.T) {
	f := newFixture(t)
	srv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "rev-r1"})
	defer srv.Close()
	g := seedGeneration(t, f.ctx, f.pool, 1, teiIdentity(t, srv), generation.StateRetired)

	u := f.user(t, "left-r@example.com", true)
	f.item(t, u, "Left R", "")

	res := f.reconcile(t, g, reconcile.All(), reconcile.ModeEnqueue)
	if res.StopReason != reconcile.StopReasonGenerationNotReceiving || res.StoppedNotReceiving != 1 {
		t.Fatalf("StopReason = %q StoppedNotReceiving = %d, want %q / 1",
			res.StopReason, res.StoppedNotReceiving, reconcile.StopReasonGenerationNotReceiving)
	}
	wantInt(t, "Enqueued", res.Enqueued, 0)
	wantInt(t, "jobs", f.jobCount(t), 0)
}

// TestReconcileImportDirection: reconcile (non-test code) must never import
// internal/embedding/jobs or internal/embedding/lifecycle (M2/FS-24).
func TestReconcileImportDirection(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("glob package files: %v (n=%d)", err, len(files))
	}
	fset := token.NewFileSet()
	checked := 0
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		checked++
		file, err := parser.ParseFile(fset, name, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		for _, imp := range file.Imports {
			path := strings.Trim(imp.Path.Value, `"`)
			if strings.HasSuffix(path, "/internal/embedding/jobs") || strings.HasSuffix(path, "/internal/embedding/lifecycle") {
				t.Fatalf("%s imports forbidden package %s", name, path)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no non-test files checked")
	}
}
