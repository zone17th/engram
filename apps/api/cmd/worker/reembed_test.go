package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
)

var (
	reembedDSNOnce  sync.Once
	reembedBaseDSN  string
	reembedBaseErr  error
	reembedTestCont testcontainers.Container
)

func TestMain(m *testing.M) {
	code := m.Run()
	if reembedTestCont != nil {
		_ = testcontainers.TerminateContainer(reembedTestCont)
	}
	os.Exit(code)
}

// reembedTestDSN creates an isolated migrated database on the shared container.
func reembedTestDSN(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping Postgres integration test in -short mode")
	}
	base := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if base == "" {
		reembedDSNOnce.Do(func() {
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
				reembedBaseErr = err
				return
			}
			reembedTestCont = c
			reembedBaseDSN, reembedBaseErr = c.ConnectionString(ctx, "sslmode=disable")
		})
		if reembedBaseErr != nil {
			t.Fatalf("start shared Postgres container: %v", reembedBaseErr)
		}
		base = reembedBaseDSN
	}
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse base DSN: %v", err)
	}
	var nonce [6]byte
	_, _ = rand.Read(nonce[:])
	dbName := "engram_reembed_" + hex.EncodeToString(nonce[:])

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
	return dsn
}

func reembedSeedGeneration(t *testing.T, pool *pgxpool.Pool, id int, ident embedid.Identity, state string) generation.Generation {
	t.Helper()
	ctx := context.Background()
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
	if state == generation.StateActive {
		row, err = q.ActivateEmbeddingGeneration(ctx, int32(id))
		if err != nil {
			t.Fatalf("ActivateEmbeddingGeneration g%d: %v", id, err)
		}
		reason := "test"
		if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{GenerationID: int32(id), FlippedReason: &reason}); err != nil {
			t.Fatalf("UpsertEmbeddingActive g%d: %v", id, err)
		}
	}
	g, err := generation.FromDBRow(row)
	if err != nil {
		t.Fatalf("FromDBRow g%d: %v", id, err)
	}
	return g
}

func reembedIdentities(t *testing.T) (tei, openai embedid.Identity) {
	t.Helper()
	ctx := context.Background()
	teiSrv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "rev-cli1"})
	defer teiSrv.Close()
	oaSrv := embedtest.NewServer(embedtest.Options{Dims: 8})
	defer oaSrv.Close()
	teiC, err := embedding.NewClientFromConfig(ctx, embedding.ClientConfig{
		Provider: embedding.ProviderTEI, BaseURL: embedding.NewEndpoint(teiSrv.URL()), Dims: 8,
	}, embedding.RolePrimary, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("tei client: %v", err)
	}
	oaC, err := embedding.NewClientFromConfig(ctx, embedding.ClientConfig{
		Provider:         embedding.ProviderOpenAICompat,
		BaseURL:          embedding.NewEndpoint(oaSrv.URL() + "/v1"),
		APIKey:           embedding.NewSecret("sk-test-cli-key"),
		Model:            "openrouter/qwen/qwen3-embedding-8b",
		Dims:             8,
		QueryInstruction: "Retrieve items",
	}, embedding.RoleShadow, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("openai client: %v", err)
	}
	return teiC.Identity, oaC.Identity
}

// Distinctive plaintext that must never reach CLI output.
const (
	cliSecretName  = "Zq-Secret-Item-Name-4417"
	cliSecretHint  = "Zq-Secret-Hint-8821"
	cliSecretTag   = "zq-secret-tag-9903"
	cliSecretEmail = "zq-secret-owner@example.com"
	cliOffEmail    = "zq-secret-off@example.com"
)

type cliFixture struct {
	dsn  string
	pool *pgxpool.Pool
	q    *gen.Queries
	gTEI generation.Generation
	gOA  generation.Generation

	userOn, userOff                uuid.UUID
	itemFresh, itemStale, itemGone uuid.UUID
	itemOff                        uuid.UUID
	tagLive                        uuid.UUID
}

// newCLIFixture seeds g1 (tei, active) and g2 (openai_compat, pending) with:
// a fresh vector, a stale vector, a soft-deleted orphan vector (user on), a
// missing target for a user-off user and that user's stale openai vector.
func newCLIFixture(t *testing.T) *cliFixture {
	t.Helper()
	ctx := context.Background()
	dsn := reembedTestDSN(t)
	pool := dbtest.Pool(t, dsn)
	teiIdent, oaIdent := reembedIdentities(t)
	f := &cliFixture{
		dsn:  dsn,
		pool: pool,
		q:    gen.New(pool),
		gTEI: reembedSeedGeneration(t, pool, 1, teiIdent, generation.StateActive),
		gOA:  reembedSeedGeneration(t, pool, 2, oaIdent, generation.StatePending),
	}

	mkUser := func(email string, on bool) uuid.UUID {
		u, err := f.q.InsertUser(ctx, gen.InsertUserParams{Email: email, Locale: "vi"})
		if err != nil {
			t.Fatalf("InsertUser: %v", err)
		}
		if !on {
			if _, err := pool.Exec(ctx, `UPDATE app_user SET settings = jsonb_set(settings, '{semantic_suggest}', 'false'::jsonb) WHERE id = $1`, u.ID); err != nil {
				t.Fatalf("user off: %v", err)
			}
		}
		return u.ID
	}
	mkItem := func(user uuid.UUID, name, hint string) uuid.UUID {
		var h *string
		if hint != "" {
			h = &hint
		}
		row, err := f.q.InsertItem(ctx, gen.InsertItemParams{UserID: user, Name: name, NameNormalized: strings.ToLower(name), Hint: h})
		if err != nil {
			t.Fatalf("InsertItem: %v", err)
		}
		return row.ID
	}
	f.userOn = mkUser(cliSecretEmail, true)
	f.userOff = mkUser(cliOffEmail, false)

	f.itemFresh = mkItem(f.userOn, cliSecretName+"-fresh", cliSecretHint)
	f.itemStale = mkItem(f.userOn, cliSecretName+"-stale", "")
	f.itemGone = mkItem(f.userOn, cliSecretName+"-gone", "")
	f.itemOff = mkItem(f.userOff, cliSecretName+"-off", "")
	tag, err := f.q.InsertTag(ctx, gen.InsertTagParams{UserID: f.userOn, Display: cliSecretTag, Normalized: cliSecretTag})
	if err != nil {
		t.Fatalf("InsertTag: %v", err)
	}
	f.tagLive = tag.ID

	f.put(t, f.gTEI, generation.CorpusItem, f.userOn, f.itemFresh, embedding.ItemInput(cliSecretName+"-fresh", cliSecretHint))
	f.put(t, f.gTEI, generation.CorpusItem, f.userOn, f.itemStale, "stale input before edit")
	f.put(t, f.gTEI, generation.CorpusItem, f.userOn, f.itemGone, embedding.ItemInput(cliSecretName+"-gone", ""))
	f.put(t, f.gTEI, generation.CorpusTag, f.userOn, f.tagLive, embedding.TagInput(cliSecretTag))
	f.put(t, f.gOA, generation.CorpusItem, f.userOff, f.itemOff, "off-user vector")
	if _, err := f.q.SoftDeleteItem(ctx, gen.SoftDeleteItemParams{UserID: f.userOn, ID: f.itemGone}); err != nil {
		t.Fatalf("SoftDeleteItem: %v", err)
	}
	return f
}

func (f *cliFixture) put(t *testing.T, g generation.Generation, kind generation.Corpus, user, target uuid.UUID, input string) {
	t.Helper()
	h := embedding.InputHashFor(g.Identity(), input)
	vec := make([]float32, g.Dims)
	vec[0] = 1
	if err := store.Upsert(context.Background(), f.pool, g, kind, user, target, vec, h[:]); err != nil {
		t.Fatalf("store.Upsert: %v", err)
	}
}

func (f *cliFixture) hasVector(t *testing.T, g generation.Generation, kind generation.Corpus, user, target uuid.UUID) bool {
	t.Helper()
	_, ok, err := store.GetTargetMeta(context.Background(), f.pool, g, kind, user, target)
	if err != nil {
		t.Fatalf("GetTargetMeta: %v", err)
	}
	return ok
}

func (f *cliFixture) jobCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(context.Background(), `SELECT count(*)::int FROM river_job`).Scan(&n); err != nil {
		t.Fatalf("count river_job: %v", err)
	}
	return n
}

// snapshot fingerprints every vector table, the generation registry and the job table.
func (f *cliFixture) snapshot(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	var sb strings.Builder
	for _, tbl := range []string{"item_embedding_g1", "tag_embedding_g1", "item_embedding_g2", "tag_embedding_g2"} {
		var n int
		var sum string
		err := f.pool.QueryRow(ctx, `SELECT count(*)::int,
			COALESCE(md5(string_agg(user_id::text || target_id::text || encode(input_hash, 'hex') || model || model_version, ',' ORDER BY user_id, target_id)), '')
			FROM `+tbl).Scan(&n, &sum)
		if err != nil {
			t.Fatalf("snapshot %s: %v", tbl, err)
		}
		fmt.Fprintf(&sb, "%s=%d/%s;", tbl, n, sum)
	}
	var gens string
	if err := f.pool.QueryRow(ctx, `SELECT COALESCE(md5(string_agg(eg::text, ',' ORDER BY id)), '') FROM embedding_generation eg`).Scan(&gens); err != nil {
		t.Fatalf("snapshot generations: %v", err)
	}
	fmt.Fprintf(&sb, "generations=%s;jobs=%d", gens, f.jobCount(t))
	return sb.String()
}

// run dispatches `worker reembed <args...>` through the real registry.
func (f *cliFixture) run(t *testing.T, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errb bytes.Buffer
	env := Env{
		Cfg:    &config.Config{DatabaseURL: f.dsn},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Stdout: &out,
		Stderr: &errb,
	}
	code = defaultRegistry.dispatch(context.Background(), env, append([]string{"reembed"}, args...),
		func(context.Context, Env) error { return nil })
	return code, out.String(), errb.String()
}

func sumField(t *testing.T, out, field string) int {
	t.Helper()
	total := 0
	for _, m := range regexp.MustCompile(`\b`+field+`=(\d+)`).FindAllStringSubmatch(out, -1) {
		n, err := strconv.Atoi(m[1])
		if err != nil {
			t.Fatalf("parse %s: %v", field, err)
		}
		total += n
	}
	return total
}

func TestReembedUserOnlyThatUser(t *testing.T) {
	f := newCLIFixture(t)
	// The user-off user and the user-on user each own a missing target in g1 (tei).
	code, out, errb := f.run(t, "user", "--user", f.userOff.String())
	if code != 0 {
		t.Fatalf("reembed user exit = %d, stderr=%q", code, errb)
	}
	rows, err := f.pool.Query(context.Background(), `SELECT DISTINCT args->>'user_id' FROM river_job WHERE kind IN ($1, $2)`,
		jobargs.KindEmbedItem, jobargs.KindEmbedTag)
	if err != nil {
		t.Fatalf("query jobs: %v", err)
	}
	defer rows.Close()
	var users []string
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			t.Fatalf("scan: %v", err)
		}
		users = append(users, u)
	}
	if len(users) != 1 || users[0] != f.userOff.String() {
		t.Fatalf("job users = %v, want only the targeted user (output %q)", users, out)
	}
	if got := sumField(t, out, "enqueued"); got != 1 {
		t.Fatalf("enqueued = %d, want 1 (tei missing target; openai skips user-off); output %q", got, out)
	}
	// The other user's stale vector and orphan are untouched by a scoped run.
	if !f.hasVector(t, f.gTEI, generation.CorpusItem, f.userOn, f.itemGone) {
		t.Fatal("scoped run touched another user's orphan vector")
	}

	code, _, errb = f.run(t, "user", "--user", cliOffEmail)
	if code == 0 || strings.Contains(errb, cliOffEmail) {
		t.Fatalf("non-UUID --user: exit=%d stderr=%q, want failure without echoing the value", code, errb)
	}
}

func TestDryRunWritesNothing(t *testing.T) {
	f := newCLIFixture(t)
	before := f.snapshot(t)

	for _, args := range [][]string{
		{"all", "--dry-run"},
		{"all", "--dry-run", "--generation", "1"},
		{"all", "--dry-run", "--generation", "2"},
		{"user", "--user", f.userOn.String(), "--dry-run"},
	} {
		code, out, errb := f.run(t, args...)
		if code != 0 {
			t.Fatalf("reembed %v exit = %d, stderr=%q", args, code, errb)
		}
		if !strings.Contains(out, "mode=dry_run") {
			t.Fatalf("reembed %v output lacks mode=dry_run: %q", args, out)
		}
		if got := sumField(t, out, "enqueued") + sumField(t, out, "orphan_deleted") + sumField(t, out, "user_off_deleted"); got != 0 {
			t.Fatalf("reembed %v applied %d changes in dry-run: %q", args, got, out)
		}
	}
	if after := f.snapshot(t); after != before {
		t.Fatalf("dry-run changed state:\n before %s\n after  %s", before, after)
	}

	_, out, _ := f.run(t, "all", "--dry-run")
	for _, field := range []string{"would_enqueue", "would_delete_orphan", "would_delete_user_off"} {
		if sumField(t, out, field) <= 0 {
			t.Fatalf("%s = 0 in dry-run output %q, want > 0", field, out)
		}
	}

	// Sanity: the same fixture changes when applied for real.
	code, out, errb := f.run(t, "all")
	if code != 0 {
		t.Fatalf("reembed all exit = %d, stderr=%q", code, errb)
	}
	if f.jobCount(t) == 0 || sumField(t, out, "orphan_deleted") != 1 || sumField(t, out, "user_off_deleted") != 1 {
		t.Fatalf("real run applied nothing useful: jobs=%d output %q", f.jobCount(t), out)
	}
	if f.hasVector(t, f.gTEI, generation.CorpusItem, f.userOn, f.itemGone) {
		t.Fatal("orphan vector survived the real run")
	}
	if f.hasVector(t, f.gOA, generation.CorpusItem, f.userOff, f.itemOff) {
		t.Fatal("user-off vector survived the real run in the openai_compat generation")
	}
}

func TestReembedStatusAndDeadletter(t *testing.T) {
	f := newCLIFixture(t)
	ctx := context.Background()

	code, out, errb := f.run(t, "status")
	if code != 0 {
		t.Fatalf("status exit = %d, stderr=%q", code, errb)
	}
	// g1 (tei): live eligible items = fresh, stale, off (3), vectors among them = fresh, stale (2).
	for _, want := range []string{
		"generation=1 state=active provider=tei item_vectors=2 item_targets=3",
		"generation=2 state=pending provider=openai_compat item_vectors=0 item_targets=2",
		"queue=embedding state=available count=0",
		"oldest_available_age_seconds=0",
		"dead_letter_count=0",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("status output lacks %q:\n%s", want, out)
		}
	}

	// Enqueue real jobs, then discard one to create a dead letter.
	if code, _, errb := f.run(t, "all"); code != 0 {
		t.Fatalf("reembed all exit = %d, stderr=%q", code, errb)
	}
	var deadID int64
	var deadGen int
	if err := f.pool.QueryRow(ctx,
		`UPDATE river_job SET state = 'discarded', finalized_at = now()
		 WHERE id = (SELECT min(id) FROM river_job WHERE kind = $1)
		 RETURNING id, (args->>'generation_id')::int`, jobargs.KindEmbedItem).Scan(&deadID, &deadGen); err != nil {
		t.Fatalf("discard a job: %v", err)
	}

	code, out, errb = f.run(t, "deadletter", "list")
	if code != 0 || !strings.Contains(out, "dead_letter_count=1 listed=1") || !strings.Contains(out, fmt.Sprintf("job_id=%d", deadID)) {
		t.Fatalf("deadletter list exit=%d out=%q err=%q", code, out, errb)
	}
	otherGen := 1
	if deadGen == 1 {
		otherGen = 2
	}
	code, out, _ = f.run(t, "deadletter", "list", "--generation", strconv.Itoa(otherGen))
	if code != 0 || !strings.Contains(out, "dead_letter_count=0 listed=0") {
		t.Fatalf("deadletter list --generation %d: exit=%d out=%q, want an empty list", otherGen, code, out)
	}

	code, out, errb = f.run(t, "deadletter", "retry", "--generation", strconv.Itoa(deadGen))
	if code != 0 || !strings.Contains(out, "dead_letter_found=1 retried=1 failed=0") {
		t.Fatalf("deadletter retry exit=%d out=%q err=%q", code, out, errb)
	}
	var state string
	if err := f.pool.QueryRow(ctx, `SELECT state::text FROM river_job WHERE id = $1`, deadID).Scan(&state); err != nil {
		t.Fatalf("read retried job: %v", err)
	}
	if state != "available" {
		t.Fatalf("retried job state = %q, want available", state)
	}
}

func TestCLIOutputHasNoNames(t *testing.T) {
	f := newCLIFixture(t)

	// One discarded job so `deadletter list/retry` print real ids.
	if code, _, errb := f.run(t, "all"); code != 0 {
		t.Fatalf("seed run exit = %d, stderr=%q", code, errb)
	}
	if _, err := f.pool.Exec(context.Background(),
		`UPDATE river_job SET state = 'discarded', finalized_at = now()
		 WHERE id = (SELECT min(id) FROM river_job WHERE kind = $1)`, jobargs.KindEmbedItem); err != nil {
		t.Fatalf("discard a job: %v", err)
	}

	secrets := []string{cliSecretName, cliSecretHint, cliSecretTag, cliSecretEmail, cliOffEmail, "engram:engram@", "sk-test-cli-key"}
	invocations := [][]string{
		{},
		{"help"},
		{"bogus"},
		{"all"},
		{"all", "--dry-run"},
		{"all", "--generation", "1"},
		{"all", "--generation", "99"},
		{"all", "--generation", "-1"},
		{"all", "extra"},
		{"user", "--user", f.userOn.String()},
		{"user", "--user", f.userOn.String(), "--dry-run"},
		{"user", "--user", cliSecretEmail},
		{"user"},
		{"status"},
		{"deadletter"},
		{"deadletter", "list"},
		{"deadletter", "list", "--generation", "1"},
		{"deadletter", "retry"},
	}
	for _, args := range invocations {
		_, out, errb := f.run(t, args...)
		combined := out + "\n" + errb
		for _, secret := range secrets {
			if strings.Contains(combined, secret) {
				t.Fatalf("reembed %v leaked %q:\n%s", args, secret, combined)
			}
		}
	}
}

func TestReembedSubcommandRegistryHook(t *testing.T) {
	if _, ok := defaultRegistry.m["reembed"]; !ok {
		t.Fatal(`"reembed" is not registered in the default registry`)
	}
	for _, name := range []string{"all", "user", "status", "deadletter"} {
		if _, ok := reembedSubcommands[name]; !ok {
			t.Fatalf("reembed subcommand %q is not registered", name)
		}
	}

	called := false
	registerReembedSub("zz-hook-test", func(context.Context, Env, []string) error {
		called = true
		return nil
	})
	defer delete(reembedSubcommands, "zz-hook-test")

	var out, errb bytes.Buffer
	env := Env{Cfg: &config.Config{}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Stdout: &out, Stderr: &errb}
	if code := defaultRegistry.dispatch(context.Background(), env, []string{"reembed", "zz-hook-test"},
		func(context.Context, Env) error { return nil }); code != 0 || !called {
		t.Fatalf("hook subcommand: exit=%d called=%v stderr=%q", code, called, errb.String())
	}

	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("duplicate registerReembedSub did not panic")
			}
		}()
		registerReembedSub("zz-hook-test", func(context.Context, Env, []string) error { return nil })
	}()
}
