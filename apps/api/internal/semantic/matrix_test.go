package semantic_test

// P05 Task 21 (semaccept lane, evidence B2): cross-cutting acceptance over the
// REAL router (httpx router + compose wiring as cmd/api/main.go builds it, a
// real session + CSRF) and the REAL T11a embed workers, with a fake provider
// (embedtest httptest server). internal/auth/settings_semantic_test.go is the
// T13 unit matrix and is deliberately not duplicated here.
//
//   - TestToggleMatrix: the 12 rows of plan mục 2.18 (3b has three variants) x
//     {item, tag}.
//   - TestUserOffTEIStillIndexes, TestUserOffOpenAICompatSendsNothing,
//     TestUserOffOpenAICompatReembedUserOnEnable, TestUserOffMixedGenerations:
//     router-driven, so they live here (the job-driven backfill acceptance is
//     internal/embedding/jobs/backfill_acceptance_test.go).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/content/contenttest"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/entry/entryhttp"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/item/itemhttp"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/semantic"
	"github.com/zone17th/engram/apps/api/internal/semantic/semantictest"
	"github.com/zone17th/engram/apps/api/internal/tag/taghttp"
	"github.com/zone17th/engram/apps/api/internal/vault/vaulthttp"
)

const (
	mxItem = "item"
	mxTag  = "tag"

	mxProbeQuery = "zzprobe"
)

// mxGen describes one embedding_generation row to seed.
type mxGen struct {
	id            int
	ident         embedid.Identity
	state         string
	bootstrap     bool
	rollbackUntil *time.Time
}

// mxDeployment describes the deployment tier of one matrix row (plan mục 2.18).
type mxDeployment struct {
	enabled    bool
	provider   string // EMBEDDING_PROVIDER as the API/worker config sees it
	clients    string // "" | "tei" | "openai" | "both" (primary tei + shadow openai)
	calibrated bool
	gens       func(e *mxEnv) []mxGen
}

// mxEnv is one real API process (router + compose) over its own database, with a
// fake TEI server and a fake openai_compat server.
type mxEnv struct {
	t         *testing.T
	pool      *pgxpool.Pool
	h         *contenttest.Harness
	jar       contenttest.CookieJar
	userID    uuid.UUID
	rt        *semantic.Runtime
	searcher  *semantictest.SpyVectorSearcher
	insert    *river.Client[pgx.Tx]
	teiSrv    *embedtest.Server
	oaSrv     *embedtest.Server
	teiClient embedding.Client
	oaClient  embedding.Client
	clientSet *embedding.ClientSet
	gens      map[int]generation.Generation
}

func mxTEIClient(t *testing.T, srv *embedtest.Server) embedding.Client {
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

func mxOpenAIClient(t *testing.T, srv *embedtest.Server, role embedding.ClientRole) embedding.Client {
	t.Helper()
	c, err := embedding.NewClientFromConfig(context.Background(), embedding.ClientConfig{
		Provider:         embedding.ProviderOpenAICompat,
		BaseURL:          embedding.NewEndpoint(srv.URL() + "/v1"),
		APIKey:           embedding.NewSecret("sk-test-matrix-key"),
		Model:            "openrouter/qwen/qwen3-embedding-8b",
		Dims:             8,
		QueryInstruction: "Retrieve items",
	}, role, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("openai_compat client: %v", err)
	}
	return c
}

// mxSeedGeneration inserts a generation row plus its tables in the given state.
func mxSeedGeneration(t *testing.T, ctx context.Context, pool *pgxpool.Pool, g mxGen) generation.Generation {
	t.Helper()
	q := gen.New(pool)
	row, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 int32(g.id),
		Provider:           g.ident.Provider,
		Model:              g.ident.Model,
		ModelVersion:       g.ident.ModelVersion,
		Preprocessing:      g.ident.Preprocessing,
		QueryPrefix:        g.ident.QueryPrefix,
		DocPrefix:          g.ident.DocPrefix,
		Dims:               int32(g.ident.Dims),
		Partitions:         4,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.55,
		CalibrationRef:     "docs/benchmarks/semantic-eval/report.json",
		Bootstrap:          g.bootstrap,
	})
	if err != nil {
		t.Fatalf("InsertPendingEmbeddingGeneration g%d: %v", g.id, err)
	}
	if err := q.CreateEmbeddingGenerationTables(ctx, gen.CreateEmbeddingGenerationTablesParams{
		ID:                 int32(g.id),
		Dims:               int32(g.ident.Dims),
		Partitions:         4,
		WithHnsw:           false,
		HnswM:              16,
		HnswEfConstruction: 64,
	}); err != nil {
		t.Fatalf("CreateEmbeddingGenerationTables g%d: %v", g.id, err)
	}
	switch g.state {
	case generation.StateActive:
		row, err = q.ActivateEmbeddingGeneration(ctx, int32(g.id))
		if err != nil {
			t.Fatalf("ActivateEmbeddingGeneration g%d: %v", g.id, err)
		}
		reason := "test"
		if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
			GenerationID: int32(g.id), FlippedReason: &reason,
		}); err != nil {
			t.Fatalf("UpsertEmbeddingActive g%d: %v", g.id, err)
		}
	case generation.StateRetired:
		var ts pgtype.Timestamptz
		if g.rollbackUntil != nil {
			ts = pgtype.Timestamptz{Time: *g.rollbackUntil, Valid: true}
		}
		row, err = q.RetireEmbeddingGeneration(ctx, gen.RetireEmbeddingGenerationParams{ID: int32(g.id), RollbackUntil: ts})
		if err != nil {
			t.Fatalf("RetireEmbeddingGeneration g%d: %v", g.id, err)
		}
	}
	out, err := generation.FromDBRow(row)
	if err != nil {
		t.Fatalf("FromDBRow g%d: %v", g.id, err)
	}
	return out
}

// mxNewEnv builds one deployment: fake providers, seeded generations, the
// semantic.Runtime exactly like cmd/api/main.go (pinner only when enabled and not
// noop), and the real router over a real httptest server.
func mxNewEnv(t *testing.T, dep mxDeployment) *mxEnv {
	t.Helper()
	ctx := context.Background()
	e := &mxEnv{t: t, pool: newTestPool(t), gens: map[int]generation.Generation{}}

	e.teiSrv = embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "BAAI/bge-m3", ModelSHA: "rev-mx", QueryPrefix: "query: "})
	t.Cleanup(e.teiSrv.Close)
	e.oaSrv = embedtest.NewServer(embedtest.Options{Dims: 8})
	t.Cleanup(e.oaSrv.Close)
	e.teiClient = mxTEIClient(t, e.teiSrv)
	oaRole := embedding.RolePrimary
	if dep.clients == "both" {
		oaRole = embedding.RoleShadow
	}
	e.oaClient = mxOpenAIClient(t, e.oaSrv, oaRole)
	switch dep.clients {
	case "tei":
		e.clientSet = embedding.NewClientSet(e.teiClient, nil)
	case "openai":
		e.clientSet = embedding.NewClientSet(e.oaClient, nil)
	case "both":
		oa := e.oaClient
		e.clientSet = embedding.NewClientSet(e.teiClient, &oa)
	}

	keys := map[string]bool{}
	if dep.gens != nil {
		for _, g := range dep.gens(e) {
			seeded := mxSeedGeneration(t, ctx, e.pool, g)
			e.gens[g.id] = seeded
			keys[seeded.Identity().Key()] = true
		}
	}
	cal := func(id embedid.Identity) (float64, string, bool) {
		if dep.calibrated && keys[id.Key()] {
			return 0.62, "docs/benchmarks/semantic-eval/report.json", true
		}
		return 0, "", false
	}

	reg, metrics := obs.NewRegistry()
	var pinReader semantic.ActivePinReader
	if dep.enabled && dep.provider != embedding.ProviderNoop {
		p := generation.NewPinner(e.pool)
		t.Cleanup(p.Close)
		pinReader = p
	}
	e.searcher = &semantictest.SpyVectorSearcher{SearchFn: semantic.NewStoreVectorSearcher(e.pool).VectorSearch}
	knobs := semantic.DefaultVectorSearchKnobs()
	knobs.BranchTimeout = 3 * time.Second // CI headroom: this acceptance is not a latency test
	e.rt = semantic.NewRuntime(semantic.RuntimeConfig{
		Enabled:        dep.enabled,
		Provider:       dep.provider,
		ClientSet:      e.clientSet,
		Pinner:         pinReader,
		Calibration:    cal,
		Knobs:          knobs,
		VectorSearcher: e.searcher,
		SettingsReader: semantic.NewDBUserSettingsReader(e.pool),
		ItemTagLoader:  semantic.NewDBItemTagRefLoader(e.pool),
		Metrics:        metrics,
	})

	// Same wiring as cmd/api/main.go.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://" + ln.Addr().String()
	t.Setenv("DATABASE_URL", e.pool.Config().ConnString())
	t.Setenv("APP_ORIGIN", origin)
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "false")
	t.Setenv("VAULT_KEY_MUTATIONS_DISABLED", "false")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.SearchSemanticEnabled = dep.enabled
	cfg.EmbeddingProvider = dep.provider

	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	e.insert, err = river.NewClient(riverpgxv5.New(e.pool), &river.Config{})
	if err != nil {
		t.Fatal(err)
	}
	mail, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc, _, authAPI, err := compose.NewAuth(cfg, e.pool, e.insert, nil, mail, nil, compose.WithSemantic(e.rt))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Close)
	authn, csrfv, reauth := compose.Adapters(svc)
	_, vaultAPI, err := compose.NewVault(cfg, e.pool, e.insert, nil, mail, metrics, entry.ResetHook, logger)
	if err != nil {
		t.Fatal(err)
	}
	contentComp, err := compose.NewContent(cfg, e.pool, nil, metrics, logger, compose.WithEmbedRiver(e.insert))
	if err != nil {
		t.Fatal(err)
	}
	searchComp, err := compose.NewSearch(cfg, e.pool, nil, metrics, logger, e.rt.NearSource())
	if err != nil {
		t.Fatal(err)
	}
	router := httpx.NewRouter(httpx.Deps{
		Config:               cfg,
		Logger:               logger,
		Ready:                db.ReadyCheck(e.pool),
		Metrics:              promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
		MetricsCollector:     metrics,
		Authenticator:        authn,
		CSRF:                 csrfv,
		Reauth:               reauth,
		MountAPI:             compose.MountAll(authhttp.Mount(authAPI), vaulthttp.Mount(vaultAPI), itemhttp.Mount(contentComp), taghttp.Mount(contentComp), entryhttp.Mount(contentComp), searchComp.Mount),
		SemanticAvailability: e.rt.Availability,
	})
	srv := httptest.NewUnstartedServer(router)
	_ = srv.Listener.Close()
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)

	e.h = &contenttest.Harness{T: t, Server: srv, Origin: origin, Pool: e.pool}
	jar, me := e.h.SignupUser("mx-"+uuid.NewString()+"@example.com", "correct-horse-battery-staple-a")
	if _, err := e.pool.Exec(context.Background(),
		`UPDATE app_user SET settings = jsonb_set(settings, '{semantic_suggest}', 'true'::jsonb, true) WHERE id = $1`, me.User.ID); err != nil {
		t.Fatalf("set semantic_suggest=true: %v", err)
	}
	e.jar = jar
	e.userID = me.User.ID
	return e
}

// do sends one request as user A (content writes get an Idempotency-Key).
func (e *mxEnv) do(method, path, body string) (int, string) {
	e.t.Helper()
	return e.doAs(e.jar, method, path, body, "")
}

// doAs sends one request with the given session; ifMatch is optional.
func (e *mxEnv) doAs(jar contenttest.CookieJar, method, path, body, ifMatch string) (int, string) {
	e.t.Helper()
	opt := contenttest.ReqOptions{IfMatch: ifMatch}
	if method != http.MethodGet && (strings.HasPrefix(path, "/api/v1/items") || strings.HasPrefix(path, "/api/v1/tags")) {
		opt.IdemKey = "idem-" + uuid.NewString()
	}
	resp, raw := e.h.DoReq(jar, method, path, body, opt)
	return resp.StatusCode, raw
}

// signup creates one more user (own session) in this deployment.
func (e *mxEnv) signup(label string) (contenttest.CookieJar, uuid.UUID) {
	e.t.Helper()
	jar, me := e.h.SignupUser(label+"-"+uuid.NewString()+"@example.com", "correct-horse-battery-staple-b")
	if _, err := e.pool.Exec(context.Background(),
		`UPDATE app_user SET settings = jsonb_set(settings, '{semantic_suggest}', 'true'::jsonb, true) WHERE id = $1`, me.User.ID); err != nil {
		e.t.Fatalf("set semantic_suggest=true: %v", err)
	}
	return jar, me.User.ID
}

func (e *mxEnv) patchSemantic(on bool) (int, string) {
	e.t.Helper()
	return e.do(http.MethodPatch, "/api/v1/me/settings", fmt.Sprintf(`{"semantic_suggest":%t}`, on))
}

// create makes one item or tag through the router and returns its id.
func (e *mxEnv) create(corpus, name string) uuid.UUID {
	e.t.Helper()
	return e.createAs(e.jar, corpus, name)
}

func (e *mxEnv) createAs(jar contenttest.CookieJar, corpus, name string) uuid.UUID {
	e.t.Helper()
	path, body := "/api/v1/items", fmt.Sprintf(`{"name":%q}`, name)
	if corpus == mxTag {
		path, body = "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, name)
	}
	code, raw := e.doAs(jar, http.MethodPost, path, body, "")
	if code != http.StatusCreated && code != http.StatusOK {
		e.t.Fatalf("POST %s = %d %s", path, code, raw)
	}
	var out struct {
		ID uuid.UUID `json:"id"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil || out.ID == uuid.Nil {
		e.t.Fatalf("decode created %s id: %v (%s)", corpus, err, raw)
	}
	return out.ID
}

func mxJobKind(corpus string) string {
	if corpus == mxTag {
		return jobargs.KindEmbedTag
	}
	return jobargs.KindEmbedItem
}

func mxInput(corpus, name string) string {
	if corpus == mxTag {
		return embedding.TagInput(name)
	}
	return embedding.ItemInput(name, "")
}

func mxCorpus(corpus string) generation.Corpus {
	if corpus == mxTag {
		return generation.CorpusTag
	}
	return generation.CorpusItem
}

// jobsByGeneration counts river_job rows of kind per generation_id (any state).
func (e *mxEnv) jobsByGeneration(kind string) map[int]int {
	e.t.Helper()
	return mxJobsByGeneration(e.t, e.pool, kind)
}

func mxJobsByGeneration(t *testing.T, pool *pgxpool.Pool, kind string) map[int]int {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT (args->>'generation_id')::int, count(*)::int FROM river_job WHERE kind = $1 GROUP BY 1`, kind)
	if err != nil {
		t.Fatalf("query river_job: %v", err)
	}
	defer rows.Close()
	out := map[int]int{}
	for rows.Next() {
		var g, n int
		if err := rows.Scan(&g, &n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[g] = n
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return out
}

func (e *mxEnv) countJobs(kind string) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), `SELECT count(*)::int FROM river_job WHERE kind = $1`, kind).Scan(&n); err != nil {
		e.t.Fatalf("count %s jobs: %v", kind, err)
	}
	return n
}

// mxCounters sums the requests both fake provider servers observed.
type mxCounters struct {
	query, doc, info, health int64
}

func (e *mxEnv) counters() mxCounters {
	var c mxCounters
	for _, s := range []*embedtest.Server{e.teiSrv, e.oaSrv} {
		st := s.Stats()
		c.query += st.QueryRequests
		c.doc += st.DocumentRequests
		c.info += s.InfoCount()
		c.health += s.HealthCount()
	}
	return c
}

// mxPoll waits (with a deadline, no fixed sleeps) until cond reports true.
func mxPoll(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func mxUnfinishedEmbedJobs(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*)::int FROM river_job WHERE kind IN ($1, $2, $3, $4) AND state NOT IN ('completed', 'discarded', 'cancelled')`,
		jobargs.KindEmbedItem, jobargs.KindEmbedTag, jobargs.KindReembedUser, jobargs.KindReembedAll).Scan(&n); err != nil {
		t.Fatalf("count unfinished embed jobs: %v", err)
	}
	return n
}

// mxRunEmbedWorkers starts an in-process River client on the `embedding` queue
// with the REAL T11a/T15 workers (embed_item, embed_tag, reembed_user,
// reembed_all), waits until every such job is final, and stops it. A reembed job
// finishes only after it inserted its embed jobs, so "nothing unfinished" is a
// real quiescence point.
func mxRunEmbedWorkers(t *testing.T, pool *pgxpool.Pool, cs *embedding.ClientSet, beforeStep5 func(ctx context.Context, kind string, generationID int, targetID uuid.UUID)) {
	t.Helper()
	deps := jobs.Dependencies{
		Pool:          pool,
		ClientSet:     cs,
		Inserter:      jobs.RiverClientInserter{Client: mxInsertClient(t, pool)},
		BeforeStep5Tx: beforeStep5,
	}
	workers := river.NewWorkers()
	river.AddWorker(workers, jobs.NewEmbedItemWorker(deps))
	river.AddWorker(workers, jobs.NewEmbedTagWorker(deps))
	river.AddWorker(workers, jobs.NewReembedUserWorker(deps))
	river.AddWorker(workers, jobs.NewReembedAllWorker(deps))
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		FetchPollInterval: 100 * time.Millisecond,
		Queues:            map[string]river.QueueConfig{jobs.QueueEmbedding: {MaxWorkers: jobs.MaxEmbedWorkers}},
		Workers:           workers,
	})
	if err != nil {
		t.Fatalf("river.NewClient: %v", err)
	}
	ctx := context.Background()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("river Start: %v", err)
	}
	mxPoll(t, "embed jobs to finish", 60*time.Second, func() bool { return mxUnfinishedEmbedJobs(t, pool) == 0 })
	stopCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := client.Stop(stopCtx); err != nil {
		t.Fatalf("river Stop: %v", err)
	}
}

func mxInsertClient(t *testing.T, pool *pgxpool.Pool) *river.Client[pgx.Tx] {
	t.Helper()
	c, err := river.NewClient(riverpgxv5.New(pool), &river.Config{SkipUnknownJobCheck: true})
	if err != nil {
		t.Fatalf("river insert client: %v", err)
	}
	return c
}

func (e *mxEnv) runEmbedWorkers() {
	e.t.Helper()
	mxRunEmbedWorkers(e.t, e.pool, e.clientSet, nil)
}

// vector reports whether generation id holds a vector for the target and, when
// it does, returns its stored input hash.
func (e *mxEnv) vector(genID int, corpus string, user, target uuid.UUID) (store.StoredVector, bool) {
	e.t.Helper()
	return mxVector(e.t, e.pool, e.gens[genID], corpus, user, target)
}

func mxVector(t *testing.T, pool *pgxpool.Pool, g generation.Generation, corpus string, user, target uuid.UUID) (store.StoredVector, bool) {
	t.Helper()
	m, ok, err := store.GetTargetMeta(context.Background(), pool, g, mxCorpus(corpus), user, target)
	if err != nil {
		t.Fatalf("GetTargetMeta(generation %d, %s): %v", g.ID, corpus, err)
	}
	return m, ok
}

// mxResponse is the subset of /suggest and /search the matrix asserts on.
type mxResponse struct {
	Semantic       bool    `json:"semantic"`
	SemanticReason *string `json:"semantic_reason"`
	Near           []struct {
		ID uuid.UUID `json:"id"`
	} `json:"near"`
}

func (r mxResponse) reason() string {
	if r.SemanticReason == nil {
		return ""
	}
	return *r.SemanticReason
}

func (e *mxEnv) query(route, q, scope, semantic string) mxResponse {
	e.t.Helper()
	v := url.Values{}
	v.Set("q", q)
	v.Set("scope", scope)
	if semantic != "" {
		v.Set("semantic", semantic)
	}
	code, raw := e.do(http.MethodGet, "/api/v1/"+route+"?"+v.Encode(), "")
	if code != http.StatusOK {
		e.t.Fatalf("GET %s = %d %s", route, code, raw)
	}
	var out mxResponse
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		e.t.Fatalf("decode %s response: %v", route, err)
	}
	return out
}

type mxMe struct {
	Features struct {
		SemanticAvailable bool `json:"semantic_available"`
		SemanticExternal  bool `json:"semantic_external"`
	} `json:"features"`
	Settings struct {
		SemanticSuggest bool `json:"semantic_suggest"`
	} `json:"settings"`
}

func (e *mxEnv) me() mxMe {
	e.t.Helper()
	code, raw := e.do(http.MethodGet, "/api/v1/auth/me", "")
	if code != http.StatusOK {
		e.t.Fatalf("GET /auth/me = %d %s", code, raw)
	}
	var out mxMe
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		e.t.Fatalf("decode /auth/me: %v", err)
	}
	return out
}

func (e *mxEnv) readyzSemantic() bool {
	e.t.Helper()
	code, raw := e.do(http.MethodGet, "/api/v1/readyz", "")
	if code != http.StatusOK {
		e.t.Fatalf("GET /readyz = %d %s", code, raw)
	}
	var out struct {
		SemanticAvailable bool `json:"semantic_available"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		e.t.Fatalf("decode /readyz: %v", err)
	}
	return out.SemanticAvailable
}

// mxRow is one row of plan mục 2.18 with its expectations.
type mxRow struct {
	name string
	dep  mxDeployment

	userOff      bool        // PATCH semantic_suggest=false (through the router) before mutating
	failProvider bool        // provider answers 503 to the first query (row 8)
	embed        bool        // run the real embed workers and assert the vectors
	semParam     string      // "" or "0"
	q            string      // default mxProbeQuery
	jobs         map[int]int // embed jobs per generation id for the created target
	wantAvail    bool        // features.semantic_available and /readyz
	wantExternal bool        // features.semantic_external
	wantSemantic bool        // semantic on every probe
	wantReason   string      // semantic_reason ("" = null)
	wantQueries  int64       // provider query requests across the three probes
	wantLookups  int         // vector lookups (probed corpus) across the three probes
	wantNear     bool        // the created target comes back as a near row
	patchTrue    int         // status of PATCH semantic_suggest=true from the final state
	reembedUser  int         // reembed_user rows after PATCH true
	extra        func(t *testing.T, e *mxEnv, corpus string, target uuid.UUID)
}

func mxTEIActive(e *mxEnv) []mxGen {
	return []mxGen{{id: 1, ident: e.teiClient.Identity, state: generation.StateActive}}
}

func mxOpenAIActive(e *mxEnv) []mxGen {
	return []mxGen{{id: 1, ident: e.oaClient.Identity, state: generation.StateActive}}
}

func mxMatrixRows() []mxRow {
	g1 := map[int]int{1: 1}
	return []mxRow{
		{
			name: "row1_deployment_disabled",
			dep:  mxDeployment{enabled: false, provider: embedding.ProviderTEI, clients: "tei", calibrated: true, gens: mxTEIActive},
			jobs: map[int]int{}, wantReason: "disabled_server", patchTrue: http.StatusConflict,
		},
		{
			name: "row2_noop_provider",
			dep:  mxDeployment{enabled: true, provider: embedding.ProviderNoop, calibrated: true, gens: mxTEIActive},
			jobs: map[int]int{}, wantReason: "disabled_server", patchTrue: http.StatusConflict,
		},
		{
			name: "row3a_bootstrap_pending",
			dep: mxDeployment{enabled: true, provider: embedding.ProviderTEI, clients: "tei", calibrated: true, gens: func(e *mxEnv) []mxGen {
				return []mxGen{{id: 1, ident: e.teiClient.Identity, state: generation.StatePending, bootstrap: true}}
			}},
			jobs: g1, wantReason: "disabled_server", patchTrue: http.StatusConflict,
		},
		{
			name: "row3b_empty_R",
			dep:  mxDeployment{enabled: true, provider: embedding.ProviderTEI, clients: "tei", calibrated: true},
			jobs: map[int]int{}, wantReason: "disabled_server", patchTrue: http.StatusConflict,
		},
		{
			// plan 2.12/2.15 + Decide: an active generation that matches no configured
			// client is `degraded` (generation_unconfigured), while static availability
			// is false. Plan row 3b prints disabled_server for the other two variants.
			name: "row3b_active_not_a_client",
			dep: mxDeployment{enabled: true, provider: embedding.ProviderTEI, clients: "tei", calibrated: true, gens: func(e *mxEnv) []mxGen {
				id := e.teiClient.Identity
				id.ModelVersion += ";other-revision"
				return []mxGen{{id: 1, ident: id, state: generation.StateActive}}
			}},
			jobs: g1, wantReason: "degraded", patchTrue: http.StatusConflict,
		},
		{
			name: "row3b_missing_calibration",
			dep:  mxDeployment{enabled: true, provider: embedding.ProviderTEI, clients: "tei", calibrated: false, gens: mxTEIActive},
			jobs: g1, wantReason: "disabled_server", patchTrue: http.StatusConflict,
		},
		{
			name: "row4_tei_user_on",
			dep:  mxDeployment{enabled: true, provider: embedding.ProviderTEI, clients: "tei", calibrated: true, gens: mxTEIActive},
			jobs: g1, embed: true, wantAvail: true, wantSemantic: true, wantQueries: 1, wantLookups: 3, wantNear: true,
			patchTrue: http.StatusOK,
		},
		{
			name:    "row5_tei_user_off",
			dep:     mxDeployment{enabled: true, provider: embedding.ProviderTEI, clients: "tei", calibrated: true, gens: mxTEIActive},
			userOff: true,
			jobs:    g1, wantAvail: true, wantReason: "disabled_user", patchTrue: http.StatusOK,
		},
		{
			name: "row6_openai_user_on",
			dep:  mxDeployment{enabled: true, provider: embedding.ProviderOpenAICompat, clients: "openai", calibrated: true, gens: mxOpenAIActive},
			jobs: g1, embed: true, wantAvail: true, wantExternal: true, wantSemantic: true, wantQueries: 1, wantLookups: 3, wantNear: true,
			patchTrue: http.StatusOK,
		},
		{
			name:    "row7_openai_user_off",
			dep:     mxDeployment{enabled: true, provider: embedding.ProviderOpenAICompat, clients: "openai", calibrated: true, gens: mxOpenAIActive},
			userOff: true,
			jobs:    map[int]int{}, wantAvail: true, wantExternal: true, wantReason: "disabled_user", patchTrue: http.StatusOK, reembedUser: 1,
		},
		{
			name:         "row8_breaker_open",
			dep:          mxDeployment{enabled: true, provider: embedding.ProviderTEI, clients: "tei", calibrated: true, gens: mxTEIActive},
			failProvider: true,
			jobs:         g1, wantAvail: true, wantReason: "degraded", wantQueries: 1, patchTrue: http.StatusConflict,
		},
		{
			name:     "row9_semantic_param_off",
			dep:      mxDeployment{enabled: true, provider: embedding.ProviderTEI, clients: "tei", calibrated: true, gens: mxTEIActive},
			semParam: "0",
			jobs:     g1, wantAvail: true, wantReason: "request_lexical", patchTrue: http.StatusOK,
		},
		{
			name: "row10_short_query",
			dep:  mxDeployment{enabled: true, provider: embedding.ProviderTEI, clients: "tei", calibrated: true, gens: mxTEIActive},
			q:    "ab",
			jobs: g1, wantAvail: true, wantReason: "short_query", patchTrue: http.StatusOK,
		},
		{
			name: "row11_patch_false_tei_keeps_vectors",
			dep:  mxDeployment{enabled: true, provider: embedding.ProviderTEI, clients: "tei", calibrated: true, gens: mxTEIActive},
			jobs: g1, embed: true, wantAvail: true, wantSemantic: true, wantQueries: 1, wantLookups: 3, wantNear: true,
			patchTrue: http.StatusOK,
			extra: func(t *testing.T, e *mxEnv, corpus string, target uuid.UUID) {
				mxPatchFalseCheck(t, e, corpus, target, true)
			},
		},
		{
			name: "row11_patch_false_openai_deletes_vectors",
			dep:  mxDeployment{enabled: true, provider: embedding.ProviderOpenAICompat, clients: "openai", calibrated: true, gens: mxOpenAIActive},
			jobs: g1, embed: true, wantAvail: true, wantExternal: true, wantSemantic: true, wantQueries: 1, wantLookups: 3, wantNear: true,
			patchTrue: http.StatusOK, reembedUser: 1,
			extra: func(t *testing.T, e *mxEnv, corpus string, target uuid.UUID) {
				mxPatchFalseCheck(t, e, corpus, target, false)
			},
		},
	}
}

// mxPatchFalseCheck is row 11: PATCH false is always 200; vectors in generation
// 1 are kept for tei and deleted for openai_compat; the response flips to
// disabled_user either way.
func mxPatchFalseCheck(t *testing.T, e *mxEnv, corpus string, target uuid.UUID, wantKept bool) {
	t.Helper()
	if _, ok := e.vector(1, corpus, e.userID, target); !ok {
		t.Fatal("precondition: the vector must exist before PATCH false")
	}
	if code, raw := e.patchSemantic(false); code != http.StatusOK {
		t.Fatalf("PATCH semantic_suggest=false = %d %s, want 200", code, raw)
	}
	if _, ok := e.vector(1, corpus, e.userID, target); ok != wantKept {
		t.Fatalf("vector kept after PATCH false = %t, want %t", ok, wantKept)
	}
	if got := e.query("suggest", mxProbeQuery, corpus, ""); got.Semantic || got.reason() != "disabled_user" {
		t.Fatalf("/suggest after PATCH false = semantic %t reason %q, want false/disabled_user", got.Semantic, got.reason())
	}
}

// TestToggleMatrix is P05 Task 21 / evidence B2: plan mục 2.18 rows 1, 2, 3a, 3b,
// 4-11 x {item, tag} through the real router. Row 3b has three variants (empty R,
// active generation that is not a configured client, missing calibration).
func TestToggleMatrix(t *testing.T) {
	for _, row := range mxMatrixRows() {
		for _, corpus := range []string{mxItem, mxTag} {
			t.Run(row.name+"/"+corpus, func(t *testing.T) {
				mxRunRow(t, row, corpus)
			})
		}
	}
}

func mxRunRow(t *testing.T, row mxRow, corpus string) {
	e := mxNewEnv(t, row.dep)
	q := row.q
	if q == "" {
		q = mxProbeQuery
	}

	if row.userOff {
		if code, raw := e.patchSemantic(false); code != http.StatusOK {
			t.Fatalf("setup PATCH semantic_suggest=false = %d %s", code, raw)
		}
	}

	// Enqueue: one embed job per target generation.
	const name = "Quiet harbor lantern"
	target := e.create(corpus, name)
	if got := e.jobsByGeneration(mxJobKind(corpus)); !maps.Equal(got, row.jobs) {
		t.Fatalf("embed jobs per generation = %v, want %v", got, row.jobs)
	}
	other := mxJobKind(mxItem)
	if corpus == mxItem {
		other = mxJobKind(mxTag)
	}
	if got := e.jobsByGeneration(other); len(got) != 0 {
		t.Fatalf("creating a %s enqueued %s jobs %v", corpus, other, got)
	}

	// Vectors through the REAL workers: every enqueued job produces the vector with
	// the hash of its generation's identity.
	if row.embed {
		e.runEmbedWorkers()
		for genID := range row.jobs {
			m, ok := e.vector(genID, corpus, e.userID, target)
			if !ok {
				t.Fatalf("generation %d has no vector after the embed worker ran", genID)
			}
			want := embedding.InputHashFor(e.gens[genID].Identity(), mxInput(corpus, name))
			if !bytes.Equal(m.InputHash, want[:]) {
				t.Fatalf("generation %d input_hash = %x, want %x", genID, m.InputHash, want[:])
			}
		}
		if row.wantNear {
			srv := e.teiSrv
			if row.dep.provider == embedding.ProviderOpenAICompat {
				srv = e.oaSrv
			}
			var doc string
			for _, in := range srv.ReceivedInputs() {
				if strings.Contains(in, name) {
					doc = in
				}
			}
			if doc == "" {
				t.Fatal("fake provider never received the document input")
			}
			srv.SetAliases(map[string]string{q: doc}) // cos(query, target) = 1
		}
	}
	if row.failProvider {
		e.teiSrv.Set5xx(http.StatusServiceUnavailable)
	}

	// Probes: /suggest, /suggest again (query-vector cache hit), /search.
	before := e.counters()
	e.searcher.ResetCalls()
	for i, route := range []string{"suggest", "suggest", "search"} {
		got := e.query(route, q, corpus, row.semParam)
		if got.Semantic != row.wantSemantic || got.reason() != row.wantReason {
			t.Fatalf("probe %d (/%s) = semantic %t reason %q, want %t / %q", i, route, got.Semantic, got.reason(), row.wantSemantic, row.wantReason)
		}
		if row.wantNear && route == "suggest" {
			found := false
			for _, n := range got.Near {
				found = found || n.ID == target
			}
			if !found {
				t.Fatalf("probe %d (/%s) near rows %v do not contain the target", i, route, got.Near)
			}
		}
	}
	after := e.counters()
	if got := after.query - before.query; got != row.wantQueries {
		t.Fatalf("provider query requests = %d, want %d", got, row.wantQueries)
	}
	if got := after.doc - before.doc; got != 0 {
		t.Fatalf("a query probe sent %d document requests", got)
	}
	wantItem, wantTag := row.wantLookups, 0
	if corpus == mxTag {
		wantItem, wantTag = 0, row.wantLookups
	}
	if got := int(e.searcher.ItemCalls()); got != wantItem {
		t.Fatalf("item vector lookups = %d, want %d", got, wantItem)
	}
	if got := int(e.searcher.TagCalls()); got != wantTag {
		t.Fatalf("tag vector lookups = %d, want %d", got, wantTag)
	}

	if row.extra != nil {
		row.extra(t, e, corpus, target)
	}

	// /auth/me, /readyz and PATCH never touch the network (plan mục 2.18).
	base := e.counters()
	me := e.me()
	if me.Features.SemanticAvailable != row.wantAvail || me.Features.SemanticExternal != row.wantExternal {
		t.Fatalf("/auth/me features = available %t external %t, want %t / %t",
			me.Features.SemanticAvailable, me.Features.SemanticExternal, row.wantAvail, row.wantExternal)
	}
	if got := e.readyzSemantic(); got != row.wantAvail {
		t.Fatalf("/readyz semantic_available = %t, want %t", got, row.wantAvail)
	}
	code, raw := e.patchSemantic(true)
	if code != row.patchTrue {
		t.Fatalf("PATCH semantic_suggest=true = %d %s, want %d", code, raw, row.patchTrue)
	}
	if code == http.StatusConflict && !strings.Contains(raw, "semantic_unavailable") {
		t.Fatalf("409 body lacks the semantic_unavailable code: %s", raw)
	}
	if now := e.counters(); now != base {
		t.Fatalf("provider requests changed across /auth/me + /readyz + PATCH: %+v -> %+v", base, now)
	}
	if got := e.countJobs(jobargs.KindReembedUser); got != row.reembedUser {
		t.Fatalf("reembed_user rows after PATCH true = %d, want %d", got, row.reembedUser)
	}
}

// mxOpenAIDeployment is an enabled openai_compat deployment with g1 active.
func mxOpenAIDeployment() mxDeployment {
	return mxDeployment{enabled: true, provider: embedding.ProviderOpenAICompat, clients: "openai", calibrated: true, gens: mxOpenAIActive}
}

// mxAnyInputContains reports whether any recorded request carried marker.
func mxAnyInputContains(inputs []string, marker string) bool {
	for _, in := range inputs {
		if strings.Contains(in, marker) {
			return true
		}
	}
	return false
}

// TestUserOffTEIStillIndexes is plan mục 2.18 row 5 / SPEC §6.10: with the active
// provider `tei`, turning semantic_suggest off hides near results but the index
// keeps being maintained (mutations still enqueue and the real workers embed
// into `tei`), so turning it back on needs no rebuild.
func TestUserOffTEIStillIndexes(t *testing.T) {
	e := mxNewEnv(t, mxDeployment{enabled: true, provider: embedding.ProviderTEI, clients: "tei", calibrated: true, gens: mxTEIActive})
	if code, raw := e.patchSemantic(false); code != http.StatusOK {
		t.Fatalf("PATCH false = %d %s", code, raw)
	}

	const itemName, tagName, renamed = "Offline tei ledger", "offline-tei-tag", "offline-tei-tag-renamed"
	itemID := e.create(mxItem, itemName)
	tagID := e.create(mxTag, tagName)
	for _, c := range []string{mxItem, mxTag} {
		if got := e.jobsByGeneration(mxJobKind(c)); !maps.Equal(got, map[int]int{1: 1}) {
			t.Fatalf("user off + tei: %s jobs = %v, want one job for generation 1", c, got)
		}
	}
	e.runEmbedWorkers()
	g1 := e.gens[1]
	for _, tc := range []struct {
		corpus string
		id     uuid.UUID
		input  string
	}{{mxItem, itemID, mxInput(mxItem, itemName)}, {mxTag, tagID, mxInput(mxTag, tagName)}} {
		m, ok := e.vector(1, tc.corpus, e.userID, tc.id)
		if !ok {
			t.Fatalf("user off + tei: %s has no vector in the tei generation", tc.corpus)
		}
		if want := embedding.InputHashFor(g1.Identity(), tc.input); !bytes.Equal(m.InputHash, want[:]) {
			t.Fatalf("%s input_hash = %x, want %x", tc.corpus, m.InputHash, want[:])
		}
	}
	if !mxAnyInputContains(e.teiSrv.ReceivedInputs(), itemName) {
		t.Fatal("the tei provider never received the off-user's item name")
	}

	// A later rename is re-embedded as well.
	if code, raw := e.do(http.MethodPatch, "/api/v1/tags/"+tagID.String(), fmt.Sprintf(`{"display":%q}`, renamed)); code != http.StatusOK {
		t.Fatalf("rename tag = %d %s", code, raw)
	}
	e.runEmbedWorkers()
	m, ok := e.vector(1, mxTag, e.userID, tagID)
	if want := embedding.InputHashFor(g1.Identity(), mxInput(mxTag, renamed)); !ok || !bytes.Equal(m.InputHash, want[:]) {
		t.Fatalf("renamed tag vector (present=%t) input_hash = %x, want %x", ok, m.InputHash, want[:])
	}

	// Queries stay lexical for the off user: nothing is sent.
	before := e.counters()
	if got := e.query("suggest", mxProbeQuery, mxItem, ""); got.Semantic || got.reason() != "disabled_user" {
		t.Fatalf("/suggest = semantic %t reason %q, want false/disabled_user", got.Semantic, got.reason())
	}
	if after := e.counters(); after.query != before.query {
		t.Fatalf("an off user's query reached the provider (%d -> %d)", before.query, after.query)
	}
}

// TestUserOffOpenAICompatSendsNothing is plan mục 2.18 row 7 / SPEC §6.10 over the
// real router and workers: after the user turns semantic_suggest off at time T,
// no request to the external provider carries any string of that user (documents
// nor queries), even through edits, new items and a full reconcile; another user
// is unaffected.
func TestUserOffOpenAICompatSendsNothing(t *testing.T) {
	e := mxNewEnv(t, mxOpenAIDeployment())
	const markerA, markerB = "mxalphauser", "mxbravouser"

	// Before T: user A's documents and queries do reach the provider (so the fake's
	// recorder demonstrably sees this user's strings).
	itemA := e.create(mxItem, "Alpha ledger "+markerA)
	e.create(mxTag, "alpha-tag-"+markerA)
	e.runEmbedWorkers()
	if !mxAnyInputContains(e.oaSrv.ReceivedInputs(), markerA) {
		t.Fatal("precondition: user A's documents never reached the provider while on")
	}
	if got := e.query("suggest", "zzalpha"+markerA, mxItem, ""); !got.Semantic {
		t.Fatalf("precondition: /suggest while on = semantic %t reason %q", got.Semantic, got.reason())
	}
	if !mxAnyInputContains(e.oaSrv.ReceivedInputs(), "zzalpha"+markerA) {
		t.Fatal("precondition: user A's query never reached the provider while on")
	}

	// T: user A turns off. Everything the fake records from here on is "after T".
	if code, raw := e.patchSemantic(false); code != http.StatusOK {
		t.Fatalf("PATCH false = %d %s", code, raw)
	}
	e.oaSrv.ResetCalls()

	// After T, user A edits, creates, queries and the whole corpus is reconciled.
	if code, raw := e.doAs(e.jar, http.MethodPatch, "/api/v1/items/"+itemA.String(), fmt.Sprintf(`{"name":%q}`, "Alpha ledger renamed "+markerA), `"1"`); code != http.StatusOK {
		t.Fatalf("rename item = %d %s", code, raw)
	}
	e.create(mxItem, "Alpha second ledger "+markerA)
	e.create(mxTag, "alpha-second-tag-"+markerA)
	// Control: the pre-T query text. Its vector is in the runtime's query cache
	// (the key ignores route and scope), so these probes are cache HITS.
	if got := e.query("suggest", "zzalpha"+markerA, mxItem, ""); got.Semantic || got.reason() != "disabled_user" {
		t.Fatalf("/suggest after off = semantic %t reason %q, want false/disabled_user", got.Semantic, got.reason())
	}
	if got := e.query("search", "zzalpha"+markerA, mxTag, ""); got.Semantic || got.reason() != "disabled_user" {
		t.Fatalf("/search after off = semantic %t reason %q, want false/disabled_user", got.Semantic, got.reason())
	}
	// RV-T21-BE-1: distinct, never-before-used queries after T are cache MISSES, so
	// they would reach the provider if the setting were checked after the query
	// vector is obtained. Every route x scope gets its own text.
	n := 0
	for _, route := range []string{"suggest", "search"} {
		for _, scope := range []string{mxItem, mxTag} {
			n++
			fresh := fmt.Sprintf("zzfresh%d%s%s%s", n, route, scope, markerA)
			if got := e.query(route, fresh, scope, ""); got.Semantic || got.reason() != "disabled_user" {
				t.Fatalf("fresh /%s scope=%s after off = semantic %t reason %q, want false/disabled_user", route, scope, got.Semantic, got.reason())
			}
		}
	}
	if q := e.oaSrv.Stats().QueryRequests; q != 0 {
		t.Fatalf("%d query requests reached the provider after user A turned off, want 0", q)
	}
	if mxAnyInputContains(e.oaSrv.ReceivedInputs(), markerA) {
		t.Fatal("a fresh query after off reached the provider with user A's text")
	}
	if _, err := jobs.InsertReembedAll(context.Background(), jobs.RiverClientInserter{Client: e.insert}, 0); err != nil {
		t.Fatalf("InsertReembedAll: %v", err)
	}
	e.runEmbedWorkers() // processes every queued embed job and the boot-style reembed_all

	// Control: another user is still embedded, so the recorder is live after T.
	jarB, _ := e.signup("bravo")
	e.createAs(jarB, mxItem, "Bravo ledger "+markerB)
	e.runEmbedWorkers()

	after := e.oaSrv.ReceivedInputs()
	if mxAnyInputContains(after, markerA) {
		t.Fatalf("a request after T carried user A's strings: %d inputs recorded", len(after))
	}
	if !mxAnyInputContains(after, markerB) {
		t.Fatal("control failed: user B's document never reached the provider after T")
	}
}

// TestUserOffOpenAICompatReembedUserOnEnable: turning back on enqueues exactly
// one reembed_user (plan mục 2.18 row 7), the real worker re-embeds that user's
// targets, and another user's targets are NOT sent to the provider again.
func TestUserOffOpenAICompatReembedUserOnEnable(t *testing.T) {
	e := mxNewEnv(t, mxOpenAIDeployment())
	const markerA, markerB = "mxalphauser", "mxbravouser"
	g1 := e.gens[1]

	itemA := e.create(mxItem, "Alpha ledger "+markerA)
	tagA := e.create(mxTag, "alpha-tag-"+markerA)
	jarB, userB := e.signup("bravo")
	itemB := e.createAs(jarB, mxItem, "Bravo ledger "+markerB)
	tagB := e.createAs(jarB, mxTag, "bravo-tag-"+markerB)
	e.runEmbedWorkers()
	bBefore, ok := e.vector(1, mxItem, userB, itemB)
	if !ok {
		t.Fatal("precondition: user B has no vector")
	}
	if _, ok := e.vector(1, mxTag, userB, tagB); !ok {
		t.Fatal("precondition: user B's tag has no vector")
	}

	// RV-T21-BE-2: make B genuinely need work WITHOUT leaving a runnable job of B's
	// own (test-only SQL, no router/enqueue path): B's item gets a new name while its
	// current vector is kept (stale), B's tag vector is removed (missing). A reconcile
	// that is broader than "user A" would now re-send B; the per-user backfill must not.
	const bDrifted = "Bravo ledger drifted " + markerB
	if _, err := e.pool.Exec(context.Background(),
		`UPDATE item SET name = $1, name_normalized = lower($1) WHERE user_id = $2 AND id = $3`, bDrifted, userB, itemB); err != nil {
		t.Fatalf("make B's item stale: %v", err)
	}
	if _, err := e.pool.Exec(context.Background(),
		`DELETE FROM tag_embedding_g1 WHERE user_id = $1 AND target_id = $2`, userB, tagB); err != nil {
		t.Fatalf("make B's tag vector missing: %v", err)
	}
	if want := embedding.InputHashFor(g1.Identity(), mxInput(mxItem, bDrifted)); bytes.Equal(bBefore.InputHash, want[:]) {
		t.Fatal("precondition: B's item vector is not stale")
	}
	if _, ok := e.vector(1, mxTag, userB, tagB); ok {
		t.Fatal("precondition: B's tag vector is not missing")
	}
	bJobs := func() int {
		var n int
		if err := e.pool.QueryRow(context.Background(),
			`SELECT count(*)::int FROM river_job WHERE kind IN ($1, $2) AND args->>'user_id' = $3`,
			jobargs.KindEmbedItem, jobargs.KindEmbedTag, userB.String()).Scan(&n); err != nil {
			t.Fatalf("count B's embed jobs: %v", err)
		}
		return n
	}
	if got := mxUnfinishedEmbedJobs(t, e.pool); got != 0 {
		t.Fatalf("precondition: %d unfinished embed jobs before toggling A, want 0", got)
	}
	bJobsBefore := bJobs()

	if code, raw := e.patchSemantic(false); code != http.StatusOK {
		t.Fatalf("PATCH false = %d %s", code, raw)
	}
	for _, v := range []struct {
		corpus string
		id     uuid.UUID
	}{{mxItem, itemA}, {mxTag, tagA}} {
		if _, ok := e.vector(1, v.corpus, e.userID, v.id); ok {
			t.Fatalf("user A's %s vector survived PATCH false", v.corpus)
		}
	}
	const renamed = "Alpha ledger renamed " + markerA
	if code, raw := e.doAs(e.jar, http.MethodPatch, "/api/v1/items/"+itemA.String(), fmt.Sprintf(`{"name":%q}`, renamed), `"1"`); code != http.StatusOK {
		t.Fatalf("rename item while off = %d %s", code, raw)
	}
	if got := e.countJobs(jobargs.KindReembedUser); got != 0 {
		t.Fatalf("reembed_user rows before enabling = %d, want 0", got)
	}

	e.oaSrv.ResetCalls()
	if code, raw := e.patchSemantic(true); code != http.StatusOK {
		t.Fatalf("PATCH true = %d %s", code, raw)
	}
	if got := e.countJobs(jobargs.KindReembedUser); got != 1 {
		t.Fatalf("reembed_user rows after off->on = %d, want exactly 1", got)
	}
	var queuedUser string
	if err := e.pool.QueryRow(context.Background(),
		`SELECT args->>'user_id' FROM river_job WHERE kind = $1`, jobargs.KindReembedUser).Scan(&queuedUser); err != nil {
		t.Fatalf("read reembed_user args: %v", err)
	}
	if queuedUser != e.userID.String() {
		t.Fatalf("reembed_user targets %s, want the toggling user", queuedUser)
	}
	e.runEmbedWorkers() // the real reembed_user worker, then the embed jobs it enqueued

	for _, v := range []struct {
		corpus string
		id     uuid.UUID
		input  string
	}{
		{mxItem, itemA, mxInput(mxItem, renamed)},
		{mxTag, tagA, mxInput(mxTag, "alpha-tag-"+markerA)},
	} {
		m, ok := e.vector(1, v.corpus, e.userID, v.id)
		if !ok {
			t.Fatalf("user A's %s was not re-embedded after enabling", v.corpus)
		}
		if want := embedding.InputHashFor(g1.Identity(), v.input); !bytes.Equal(m.InputHash, want[:]) {
			t.Fatalf("user A's %s input_hash = %x, want %x (the current name)", v.corpus, m.InputHash, want[:])
		}
	}
	sent := e.oaSrv.ReceivedInputs()
	if !mxAnyInputContains(sent, markerA) {
		t.Fatal("user A's targets were never re-sent after enabling")
	}
	if mxAnyInputContains(sent, markerB) {
		t.Fatal("user B's targets were re-sent although B never toggled")
	}
	bAfter, ok := e.vector(1, mxItem, userB, itemB)
	if !ok || !bAfter.EmbeddedAt.Equal(bBefore.EmbeddedAt) || !bytes.Equal(bAfter.InputHash, bBefore.InputHash) {
		t.Fatalf("user B's stale item vector changed across A's off->on (present=%t)", ok)
	}
	if _, ok := e.vector(1, mxTag, userB, tagB); ok {
		t.Fatal("user B's missing tag vector was backfilled by A's off->on")
	}
	if got := bJobs(); got != bJobsBefore {
		t.Fatalf("user B's embed jobs = %d, want %d (A's off->on must not enqueue for B)", got, bJobsBefore)
	}
}

// mxTargetJob loads the args of the queued embed job of (kind, generation, target).
func mxTargetJob(t *testing.T, pool *pgxpool.Pool, kind string, genID int, target uuid.UUID) (user, hash string) {
	t.Helper()
	if err := pool.QueryRow(context.Background(),
		`SELECT args->>'user_id', args->>'input_hash' FROM river_job
		 WHERE kind = $1 AND (args->>'generation_id')::int = $2 AND args->>'target_id' = $3`,
		kind, genID, target.String()).Scan(&user, &hash); err != nil {
		t.Fatalf("queued %s job for generation %d: %v", kind, genID, err)
	}
	return user, hash
}

const (
	// mxBarrierTimeout bounds one race scenario (the paused worker, the PATCH and the
	// wait for the worker); mxHTTPTimeout bounds each HTTP exchange inside it;
	// mxJoinTimeout bounds the cleanup join of the worker goroutine.
	mxBarrierTimeout = 45 * time.Second
	mxHTTPTimeout    = 20 * time.Second
	mxJoinTimeout    = 15 * time.Second
)

// patchSemanticBounded is patchSemantic for the race barrier: the request carries
// ctx and an HTTP client timeout (not http.DefaultClient) and failures are returned
// instead of calling t.Fatal, so the caller always reaches its release path.
func (e *mxEnv) patchSemanticBounded(ctx context.Context, on bool) (int, string, error) {
	body := fmt.Sprintf(`{"semantic_suggest":%t}`, on)
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, e.h.Server.URL+"/api/v1/me/settings", strings.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", e.h.Origin)
	e.jar.Apply(req)
	if c := e.jar[authhttp.CookieCSRF]; c != nil {
		req.Header.Set(authhttp.HeaderCSRF, c.Value)
	}
	resp, err := (&http.Client{Timeout: mxHTTPTimeout}).Do(req)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	e.jar.Capture(resp)
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, "", err
	}
	return resp.StatusCode, string(raw), nil
}

// mxOffBetweenProviderAndStep5 runs a real embed_tag worker for the openai_compat
// generation (g2) of barrierID, pauses it between its provider answer (steps 1-4)
// and step 5, commits the user's PATCH semantic_suggest=false, then lets step 5 run.
// Every wait is bounded by one per-scenario context; the hook is context-aware; the
// release is safe to call more than once; the worker is cancelled and joined on every
// exit path (t.Cleanup), so a lock-order regression fails this test fast instead of
// hanging the package until the global timeout.
func mxOffBetweenProviderAndStep5(t *testing.T, e *mxEnv, barrierID uuid.UUID) {
	t.Helper()
	user, hash := mxTargetJob(t, e.pool, jobargs.KindEmbedTag, 2, barrierID)

	ctx, cancel := context.WithTimeout(context.Background(), mxBarrierTimeout)
	defer cancel()
	reached := make(chan struct{})
	release := make(chan struct{})
	var reachedOnce, releaseOnce sync.Once
	releaseWorker := func() { releaseOnce.Do(func() { close(release) }) }

	deps := jobs.Dependencies{
		Pool:      e.pool,
		ClientSet: e.clientSet,
		Inserter:  jobs.RiverClientInserter{Client: e.insert},
		BeforeStep5Tx: func(hctx context.Context, _ string, genID int, target uuid.UUID) {
			if genID != 2 || target != barrierID {
				return
			}
			reachedOnce.Do(func() { close(reached) })
			select {
			case <-release:
			case <-hctx.Done():
			case <-ctx.Done():
			}
		},
	}
	finished := make(chan struct{})
	var workerErr error // written before close(finished), read only after <-finished
	go func() {
		defer close(finished)
		workerErr = jobs.NewEmbedTagWorker(deps).Work(ctx, &river.Job[jobargs.EmbedTagArgs]{
			JobRow: &rivertype.JobRow{Attempt: 1},
			Args:   jobargs.EmbedTagArgs{GenerationID: 2, UserID: user, TargetID: barrierID.String(), InputHash: hash},
		})
	}()
	t.Cleanup(func() {
		releaseWorker()
		cancel()
		timer := time.NewTimer(mxJoinTimeout)
		defer timer.Stop()
		select {
		case <-finished:
		case <-timer.C:
			t.Error("the in-flight embed_tag worker did not stop after cancel")
		}
	})

	select {
	case <-reached:
	case <-finished:
		t.Fatalf("in-flight embed_tag worker returned before step 5 (err=%v)", workerErr)
	case <-ctx.Done():
		t.Fatal("timed out waiting for the embed_tag worker to reach step 5")
	}
	code, raw, err := e.patchSemanticBounded(ctx, false)
	if err != nil {
		t.Fatalf("PATCH false while an upsert is in flight: %v (PATCH must not wait for the paused worker)", err)
	}
	if code != http.StatusOK {
		t.Fatalf("PATCH false while an upsert is in flight = %d %s", code, raw)
	}
	releaseWorker()
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("timed out waiting for the embed_tag worker to finish step 5")
	}
	if workerErr != nil {
		t.Fatalf("in-flight embed_tag worker: %v", workerErr)
	}
}

// TestUserOffMixedGenerations is BE-3: the policy follows the provider of the
// TARGET generation, not the deployment's active provider. R = tei active +
// openai_compat {pending | retired past its rollback window}: user off leaves
// 0 vectors of that user in every openai_compat generation, keeps the tei ones
// and keeps updating them on a later rename. In (a) an upsert that already got
// its provider answer is blocked at step 5 when the off commits in between.
func TestUserOffMixedGenerations(t *testing.T) {
	for _, variant := range []string{"openai_pending", "openai_retired_past_window"} {
		t.Run(variant, func(t *testing.T) {
			retired := variant == "openai_retired_past_window"
			e := mxNewEnv(t, mxDeployment{
				enabled: true, provider: embedding.ProviderTEI, clients: "both", calibrated: true,
				gens: func(e *mxEnv) []mxGen {
					return []mxGen{
						{id: 1, ident: e.teiClient.Identity, state: generation.StateActive},
						{id: 2, ident: e.oaClient.Identity, state: generation.StatePending},
					}
				},
			})
			ctx := context.Background()
			g1, g2 := e.gens[1], e.gens[2]
			if g1.Provider != generation.ProviderTEI || g2.Provider != generation.ProviderOpenAICompat {
				t.Fatalf("providers = %s/%s, want tei/openai_compat", g1.Provider, g2.Provider)
			}

			// User on: item + tag vectors in both generations through the real workers.
			itemID := e.create(mxItem, "Mixed ledger")
			tagID := e.create(mxTag, "mixed-tag")
			for _, c := range []string{mxItem, mxTag} {
				if got := e.jobsByGeneration(mxJobKind(c)); !maps.Equal(got, map[int]int{1: 1, 2: 1}) {
					t.Fatalf("%s jobs = %v, want one per generation", c, got)
				}
			}
			e.runEmbedWorkers()
			for _, g := range []int{1, 2} {
				for _, v := range []struct {
					corpus string
					id     uuid.UUID
				}{{mxItem, itemID}, {mxTag, tagID}} {
					if _, ok := e.vector(g, v.corpus, e.userID, v.id); !ok {
						t.Fatalf("precondition: generation %d has no %s vector", g, v.corpus)
					}
				}
			}

			if !retired {
				// (a) In-flight upsert blocked at step 5: the openai_compat job passes
				// steps 1-4 (its document reached the provider), then the user turns off
				// and commits, and only then does step 5 run.
				barrierID := e.create(mxTag, "mixed-barrier-tag")
				mxOffBetweenProviderAndStep5(t, e, barrierID)
				if _, ok := e.vector(2, mxTag, e.userID, barrierID); ok {
					t.Fatal("an upsert into the openai_compat generation committed after the user turned off (step 5 did not block it)")
				}
			} else {
				past := time.Now().Add(-time.Hour)
				if _, err := gen.New(e.pool).RetireEmbeddingGeneration(ctx, gen.RetireEmbeddingGenerationParams{
					ID: 2, RollbackUntil: pgtype.Timestamptz{Time: past, Valid: true},
				}); err != nil {
					t.Fatalf("retire g2 past its window: %v", err)
				}
				if code, raw := e.patchSemantic(false); code != http.StatusOK {
					t.Fatalf("PATCH false = %d %s", code, raw)
				}
			}

			// 0 vectors of the user in every openai_compat generation, tei kept.
			for _, v := range []struct {
				corpus string
				id     uuid.UUID
			}{{mxItem, itemID}, {mxTag, tagID}} {
				if _, ok := e.vector(2, v.corpus, e.userID, v.id); ok {
					t.Fatalf("%s vector survived in the openai_compat generation after PATCH false", v.corpus)
				}
				if _, ok := e.vector(1, v.corpus, e.userID, v.id); !ok {
					t.Fatalf("%s vector was deleted from the tei generation by PATCH false", v.corpus)
				}
			}

			// Later rename: tei is still updated, the openai_compat generation is not.
			const renamed = "mixed-tag-renamed"
			e.oaSrv.ResetCalls()
			if code, raw := e.do(http.MethodPatch, "/api/v1/tags/"+tagID.String(), fmt.Sprintf(`{"display":%q}`, renamed)); code != http.StatusOK {
				t.Fatalf("rename tag = %d %s", code, raw)
			}
			e.runEmbedWorkers()
			m, ok := e.vector(1, mxTag, e.userID, tagID)
			if want := embedding.InputHashFor(g1.Identity(), mxInput(mxTag, renamed)); !ok || !bytes.Equal(m.InputHash, want[:]) {
				t.Fatalf("tei vector (present=%t) input_hash = %x, want %x after the rename", ok, m.InputHash, want[:])
			}
			if _, ok := e.vector(2, mxTag, e.userID, tagID); ok {
				t.Fatal("the rename re-created a vector in the openai_compat generation for an off user")
			}
			if n := e.oaSrv.Stats().TotalRequests; n != 0 {
				t.Fatalf("the openai_compat provider received %d requests after the user turned off", n)
			}
		})
	}
}
