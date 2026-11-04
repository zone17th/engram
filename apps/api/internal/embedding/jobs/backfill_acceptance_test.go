package jobs_test

// P05 Task 21 (semaccept lane, evidence B2): deployment off -> edits -> on.
// Everything runs through the real API router (compose wiring as cmd/api/main.go
// builds it) while the deployment is off, then through the real worker.Run boot
// path (Bootstrap -> client.Start -> boot reembed_all {}) with the real T11a/T15
// workers. T15's TestReconcileOffEditOn models "off" with raw SQL and calls
// Reconcile directly; this test is the full-path counterpart.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
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
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/reconcile"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/entry/entryhttp"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/item/itemhttp"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/tag/taghttp"
	"github.com/zone17th/engram/apps/api/internal/vault/vaulthttp"
	"github.com/zone17th/engram/apps/api/internal/worker"
)

// baAPI is the real API process (router + compose) over a test database with the
// deployment-level semantic switch OFF and a fixed clock the test advances to
// stay under the content write rate limit.
type baAPI struct {
	t    *testing.T
	h    *contenttest.Harness
	clk  *clock.Fixed
	jar  contenttest.CookieJar
	user uuid.UUID
}

func baNewAPI(t *testing.T, pool *pgxpool.Pool) *baAPI {
	t.Helper()
	clk := clock.NewFixed(time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://" + ln.Addr().String()
	t.Setenv("DATABASE_URL", pool.Config().ConnString())
	t.Setenv("APP_ORIGIN", origin)
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "false")
	t.Setenv("VAULT_KEY_MUTATIONS_DISABLED", "false")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	// Deployment OFF with a provider still configured: the switch alone must stop
	// every enqueue (plan mục 2.18 row 1).
	cfg.SearchSemanticEnabled = false
	cfg.EmbeddingProvider = embedding.ProviderTEI

	reg, metrics := obs.NewRegistry()
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	insert, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		t.Fatal(err)
	}
	mail, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	svc, _, authAPI, err := compose.NewAuth(cfg, pool, insert, clk, mail, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Close)
	authn, csrfv, reauth := compose.Adapters(svc)
	_, vaultAPI, err := compose.NewVault(cfg, pool, insert, clk, mail, metrics, entry.ResetHook, logger)
	if err != nil {
		t.Fatal(err)
	}
	contentComp, err := compose.NewContent(cfg, pool, clk, metrics, logger, compose.WithEmbedRiver(insert))
	if err != nil {
		t.Fatal(err)
	}
	searchComp, err := compose.NewSearch(cfg, pool, clk, metrics, logger)
	if err != nil {
		t.Fatal(err)
	}
	router := httpx.NewRouter(httpx.Deps{
		Config:           cfg,
		Logger:           logger,
		Ready:            db.ReadyCheck(pool),
		Metrics:          promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
		MetricsCollector: metrics,
		Authenticator:    authn,
		CSRF:             csrfv,
		Reauth:           reauth,
		MountAPI:         compose.MountAll(authhttp.Mount(authAPI), vaulthttp.Mount(vaultAPI), itemhttp.Mount(contentComp), taghttp.Mount(contentComp), entryhttp.Mount(contentComp), searchComp.Mount),
	})
	srv := httptest.NewUnstartedServer(router)
	_ = srv.Listener.Close()
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)

	a := &baAPI{t: t, clk: clk, h: &contenttest.Harness{T: t, Server: srv, Origin: origin, Clock: clk, Pool: pool}}
	jar, me := a.h.SignupUser("backfill-"+uuid.NewString()+"@example.com", "correct-horse-battery-staple-a")
	a.jar = jar
	a.user = me.User.ID
	return a
}

// write sends one content mutation, advancing the fake clock past the per-user
// write window first. It returns the response body.
func (a *baAPI) write(method, path, body, ifMatch string, wantStatus int) string {
	a.t.Helper()
	a.clk.Advance(2 * time.Second)
	resp, raw := a.h.DoReq(a.jar, method, path, body, contenttest.ReqOptions{
		IdemKey: "idem-" + uuid.NewString(),
		IfMatch: ifMatch,
	})
	if resp.StatusCode != wantStatus {
		a.t.Fatalf("%s %s = %d %s, want %d", method, path, resp.StatusCode, raw, wantStatus)
	}
	return raw
}

type baCreated struct {
	ID      uuid.UUID `json:"id"`
	Version int32     `json:"version"`
}

func baDecode(t *testing.T, raw string) baCreated {
	t.Helper()
	var out baCreated
	if err := json.Unmarshal([]byte(raw), &out); err != nil || out.ID == uuid.Nil {
		t.Fatalf("decode create/update response: %v (%s)", err, raw)
	}
	return out
}

func (a *baAPI) createItem(name string) baCreated {
	a.t.Helper()
	return baDecode(a.t, a.write(http.MethodPost, "/api/v1/items", fmt.Sprintf(`{"name":%q}`, name), "", http.StatusCreated))
}

func (a *baAPI) createTag(display string) baCreated {
	a.t.Helper()
	return baDecode(a.t, a.write(http.MethodPost, "/api/v1/tags", fmt.Sprintf(`{"display":%q}`, display), "", http.StatusCreated))
}

// baStartWorker runs the real worker.Run in a goroutine. stop() cancels it and
// requires a clean return.
func baStartWorker(t *testing.T, cfg *config.Config) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- worker.Run(ctx, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	}()
	stopped := false
	stop = func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("worker.Run returned an error: %v", err)
			}
		case <-time.After(30 * time.Second):
			t.Errorf("worker.Run did not stop within 30s")
		}
	}
	t.Cleanup(stop)
	return stop
}

// baWaitLeader waits (deadline poll) until a River client has started and won
// leader election, i.e. worker.Run is past client.Start.
func baWaitLeader(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for {
		var n int
		if err := pool.QueryRow(context.Background(), `SELECT count(*)::int FROM river_leader`).Scan(&n); err != nil {
			t.Fatalf("count river_leader: %v", err)
		}
		if n > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the worker to start (no river leader)")
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// baCoverage is the per-generation coverage `worker reembed status` prints: live
// targets of eligible users and how many of them hold a vector (same SQL as
// cmd/worker/reembed.go coverage; that package is `main`, so it cannot be
// imported).
func baCoverage(t *testing.T, pool *pgxpool.Pool, g generation.Generation, kind generation.Corpus) (vectors, targets int) {
	t.Helper()
	ctx := context.Background()
	tbl, err := store.SanitizedTable(g, kind)
	if err != nil {
		t.Fatalf("SanitizedTable: %v", err)
	}
	target := "item"
	if kind == generation.CorpusTag {
		target = "tag"
	}
	external := g.Provider == generation.ProviderOpenAICompat
	const eligible = ` JOIN app_user u ON u.id = t.user_id AND u.deleted_at IS NULL
		WHERE t.deleted_at IS NULL
		  AND (NOT $1::boolean OR COALESCE((u.settings->>'semantic_suggest')::boolean, true) = true)`
	if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM `+target+` t`+eligible, external).Scan(&targets); err != nil {
		t.Fatalf("count %s targets: %v", target, err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*)::int FROM `+target+` t JOIN `+tbl+` e ON e.user_id = t.user_id AND e.target_id = t.id`+eligible,
		external).Scan(&vectors); err != nil {
		t.Fatalf("count %s vectors: %v", target, err)
	}
	return vectors, targets
}

func baCountJobs(t *testing.T, pool *pgxpool.Pool, where string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*)::int FROM river_job WHERE `+where, args...).Scan(&n); err != nil {
		t.Fatalf("count river_job where %s: %v", where, err)
	}
	return n
}

// TestDeploymentOffEditsThenOn (REQUIRED, plan Task 21): with the deployment off
// the user creates, renames and re-hints an item, creates and renames a tag,
// deletes an item and a tag, and restores a tag. Turning the deployment on means
// a worker restart: worker.Run bootstraps g1, starts the client and inserts the
// boot reembed_all {} exactly once; the real T11a workers then embed every live
// target with the correct input_hash, the deleted item has no vector, and the
// `reembed status` view (coverage + a Reconcile dry run) reports 0 missing and
// 0 stale.
func TestDeploymentOffEditsThenOn(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	dsn := pool.Config().ConnString()
	api := baNewAPI(t, pool)

	// A P04-style worker is running while the deployment is off.
	offCfg := &config.Config{
		Env:                   "development",
		DatabaseURL:           dsn,
		AppOrigin:             "http://localhost:3000",
		EmbeddingProvider:     embedding.ProviderTEI,
		SearchSemanticEnabled: false,
		AuditRetentionDays:    90,
		ShutdownTimeout:       5 * time.Second,
	}
	stopOff := baStartWorker(t, offCfg)
	baWaitLeader(t, pool)

	const (
		itemOrig   = "Backfill original-alpha"
		itemNew    = "Backfill alpha renamed"
		itemHint   = "backfill hint text"
		itemDead   = "Backfill beta deleted"
		itemKept   = "Backfill gamma untouched"
		tagOrig    = "bf-tag-original"
		tagNew     = "bf-tag-renamed"
		tagDead    = "bf-tag-deleted"
		tagRestore = "bf-tag-restored"
	)

	// Edits while OFF.
	a := api.createItem(itemOrig)
	renamed := baDecode(t, api.write(http.MethodPatch, "/api/v1/items/"+a.ID.String(), fmt.Sprintf(`{"name":%q}`, itemNew), fmt.Sprintf(`"%d"`, a.Version), http.StatusOK))
	baDecode(t, api.write(http.MethodPatch, "/api/v1/items/"+a.ID.String(), fmt.Sprintf(`{"hint":%q}`, itemHint), fmt.Sprintf(`"%d"`, renamed.Version), http.StatusOK))
	dead := api.createItem(itemDead)
	kept := api.createItem(itemKept)
	api.write(http.MethodDelete, "/api/v1/items/"+dead.ID.String(), "", "", http.StatusNoContent)

	t1 := api.createTag(tagOrig)
	api.write(http.MethodPatch, "/api/v1/tags/"+t1.ID.String(), fmt.Sprintf(`{"display":%q}`, tagNew), "", http.StatusOK)
	t2 := api.createTag(tagDead)
	api.write(http.MethodDelete, "/api/v1/tags/"+t2.ID.String(), "", "", http.StatusNoContent)
	t3 := api.createTag(tagRestore)
	api.write(http.MethodDelete, "/api/v1/tags/"+t3.ID.String(), "", "", http.StatusNoContent)
	api.write(http.MethodPost, "/api/v1/tags/"+t3.ID.String()+"/restore", `{}`, "", http.StatusOK)

	// The deployment being off, nothing was enqueued and nothing exists.
	if n := baCountJobs(t, pool, `kind IN ($1, $2, $3, $4)`, jobargs.KindEmbedItem, jobargs.KindEmbedTag, jobargs.KindReembedUser, jobargs.KindReembedAll); n != 0 {
		t.Fatalf("embedding jobs while the deployment was off = %d, want 0", n)
	}
	var gens int
	if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM embedding_generation`).Scan(&gens); err != nil || gens != 0 {
		t.Fatalf("embedding_generation rows while off = %d (err %v), want 0", gens, err)
	}
	stopOff()

	// Turn ON = restart the worker with the deployment switch on and a (fake) TEI.
	teiSrv := embedtest.NewServer(embedtest.Options{Dims: 8, ModelID: "engram-fakeembed", ModelSHA: embedding.FakeEmbedModelSHA})
	t.Cleanup(teiSrv.Close)
	onCfg := &config.Config{
		Env:                      "development",
		DatabaseURL:              dsn,
		AppOrigin:                "http://localhost:3000",
		EmbeddingProvider:        embedding.ProviderTEI,
		TEIURL:                   embedding.NewEndpoint(teiSrv.URL()),
		EmbeddingDimensions:      8,
		EmbeddingQueryTimeout:    300 * time.Millisecond,
		EmbeddingDocumentTimeout: 5 * time.Second,
		SearchSemanticEnabled:    true,
		AuditRetentionDays:       90,
		ShutdownTimeout:          5 * time.Second,
	}
	stopOn := baStartWorker(t, onCfg)

	// The boot path backfills g1 on its own: wait until every live target holds a
	// vector (deadline poll; the assertions below are exact).
	var g1 generation.Generation
	deadline := time.Now().Add(90 * time.Second)
	for {
		g, err := generation.GetByID(ctx, pool, generation.BootstrapGenerationID)
		if err == nil {
			g1 = g
			iv, it := baCoverage(t, pool, g1, generation.CorpusItem)
			tv, tt := baCoverage(t, pool, g1, generation.CorpusTag)
			if it == 2 && tt == 2 && iv == it && tv == tt &&
				baCountJobs(t, pool, `kind IN ($1, $2, $3) AND state NOT IN ('completed', 'discarded', 'cancelled')`,
					jobargs.KindEmbedItem, jobargs.KindEmbedTag, jobargs.KindReembedAll) == 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the boot reembed_all to backfill every live target")
		}
		time.Sleep(50 * time.Millisecond)
	}
	stopOn()

	// Exactly one boot reembed_all {} (ByArgs dedupe) and no dead letters.
	if n := baCountJobs(t, pool, `kind = $1 AND args = '{}'::jsonb`, jobargs.KindReembedAll); n != 1 {
		t.Fatalf("boot reembed_all {} rows = %d, want exactly 1", n)
	}
	if n := baCountJobs(t, pool, `state = 'discarded' AND kind IN ($1, $2)`, jobargs.KindEmbedItem, jobargs.KindEmbedTag); n != 0 {
		t.Fatalf("dead-letter embed jobs = %d, want 0", n)
	}

	// Every live target has the vector of ITS CURRENT input; the deleted ones none.
	for _, v := range []struct {
		corpus generation.Corpus
		id     uuid.UUID
		input  string
	}{
		{generation.CorpusItem, a.ID, embedding.ItemInput(itemNew, itemHint)},
		{generation.CorpusItem, kept.ID, embedding.ItemInput(itemKept, "")},
		{generation.CorpusTag, t1.ID, embedding.TagInput(tagNew)},
		{generation.CorpusTag, t3.ID, embedding.TagInput(tagRestore)},
	} {
		m, ok, err := store.GetTargetMeta(ctx, pool, g1, v.corpus, api.user, v.id)
		if err != nil || !ok {
			t.Fatalf("live %s target has no vector after the boot backfill (err %v)", v.corpus, err)
		}
		if want := embedding.InputHashFor(g1.Identity(), v.input); !bytes.Equal(m.InputHash, want[:]) {
			t.Fatalf("live %s target input_hash = %x, want %x (the current name/hint)", v.corpus, m.InputHash, want[:])
		}
		if m.Model != g1.Model || m.ModelVersion != g1.ModelVersion {
			t.Fatalf("live %s target model/version = %q/%q, want %q/%q", v.corpus, m.Model, m.ModelVersion, g1.Model, g1.ModelVersion)
		}
	}
	for _, v := range []struct {
		corpus generation.Corpus
		id     uuid.UUID
	}{{generation.CorpusItem, dead.ID}, {generation.CorpusTag, t2.ID}} {
		if _, ok, err := store.GetTargetMeta(ctx, pool, g1, v.corpus, api.user, v.id); err != nil || ok {
			t.Fatalf("deleted %s target has a vector (present=%t err=%v)", v.corpus, ok, err)
		}
	}

	// Only current inputs were ever sent: never an outdated name, never a deleted target.
	sent := teiSrv.ReceivedInputs()
	for _, forbidden := range []string{"original-alpha", "bf-tag-original", itemDead, tagDead} {
		for _, in := range sent {
			if strings.Contains(in, forbidden) {
				t.Fatalf("the provider received a stale or deleted input (%q)", forbidden)
			}
		}
	}

	// `worker reembed status`: coverage 100% and 0 missing / 0 stale (dry run).
	for _, kind := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		if v, tg := baCoverage(t, pool, g1, kind); v != tg || tg != 2 {
			t.Fatalf("status coverage for %s = %d/%d, want 2/2", kind, v, tg)
		}
	}
	res, err := reconcile.Reconcile(ctx, pool, g1, reconcile.All(), reconcile.ModeDryRun, nil)
	if err != nil {
		t.Fatalf("Reconcile dry run: %v", err)
	}
	if res.Missing != 0 || res.Stale != 0 || res.WouldEnqueue != 0 || res.WouldDeleteOrphan != 0 || res.WouldDeleteUserOff != 0 {
		t.Fatalf("status after the boot backfill = %+v, want 0 missing / 0 stale / nothing to do", res)
	}
}
