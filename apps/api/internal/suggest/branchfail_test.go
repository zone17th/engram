package suggest_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// FU-SB-1: a lexical branch whose 50 ms budget fired must degrade to `lexical_partial`
// whatever error shape pgx produced, a genuine error must log exactly one WARN with a
// bounded `error_class`, and a client disconnect must be neither partial nor a server error.

const (
	failSentinelQuery = "failsentinelqueryxyz"
	failSentinelErr   = "SecretErrSentinelOmega"
)

type branchFailEnv struct {
	*suggestTestEnv
	logBuf *bytes.Buffer
}

func newBranchFailEnv(t *testing.T) *branchFailEnv {
	t.Helper()
	dsn := startTestDB(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	u1 := uuid.MustParse("77777777-7777-4000-8000-000000000007")
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, locale) VALUES ($1, 'branchfail@example.com', 'vi')`, u1); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	ts := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `
		INSERT INTO item (id, user_id, name, name_normalized, entry_count, last_used_at, created_at, updated_at)
		VALUES ($1, $2, 'wifi văn phòng', 'wifi văn phòng', 4, $3, $3, $3)
	`, uuid.MustParse("00000000-0001-4000-8000-000000000701"), u1, ts); err != nil {
		t.Fatalf("insert item: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO tag (id, user_id, display, normalized, item_count, last_used_at, created_at, updated_at)
		VALUES ($1, $2, 'wifi-tag', 'wifi-tag', 2, $3, $3, $3)
	`, uuid.MustParse("00000000-0011-4000-8000-000000000701"), u1, ts); err != nil {
		t.Fatalf("insert tag: %v", err)
	}

	warmPoolConns(t, pool, 2)
	logBuf := &bytes.Buffer{}
	logger := slog.New(slog.NewJSONHandler(logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	clk := clock.NewFixed(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	reg, metrics := obs.NewRegistry()
	cursorKey, err := suggest.DeriveCursorKey([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("DeriveCursorKey: %v", err)
	}
	bucket := httpx.NewTokenBucket(10_000, 10_000, clk)
	svc := suggest.NewService(pool, clk, suggest.NewNoopNearSource(), metrics, cursorKey)
	handler := suggest.NewHandler(svc, bucket)
	auth := &suggestTestAuth{cookies: make(map[string]authctx.Principal)}
	auth.addToken("tok-u1", u1)
	router := httpx.NewRouter(httpx.Deps{
		Logger:           logger,
		Metrics:          promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
		MetricsCollector: metrics,
		Authenticator:    auth,
		MountAPI:         suggest.Mount(handler),
	})
	t.Cleanup(func() {
		svc.SetTestHooks(nil)
		svc.SetTxStarter(nil)
		svc.SetNearSource(nil)
	})
	return &branchFailEnv{
		suggestTestEnv: &suggestTestEnv{
			t: t, pool: pool, clk: clk, reg: reg, metrics: metrics, bucket: bucket,
			svc: svc, handler: handler, router: router, auth: auth,
		},
		logBuf: logBuf,
	}
}

// serverErrorLines returns the decoded WARN/ERROR JSON log lines written so far.
func (e *branchFailEnv) serverErrorLines() []map[string]any {
	e.t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(e.logBuf.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			e.t.Fatalf("log line is not JSON: %q: %v", line, err)
		}
		if lvl, _ := m["level"].(string); lvl == "WARN" || lvl == "ERROR" {
			out = append(out, m)
		}
	}
	return out
}

func (e *branchFailEnv) partialCounters() (item, tag float64) {
	e.t.Helper()
	return counterValueByCorpus(e.t, e.reg, "search_lexical_partial_total", suggest.CorpusItem),
		counterValueByCorpus(e.t, e.reg, "search_lexical_partial_total", suggest.CorpusTag)
}

// opaqueAfterBudget blocks until the branch budget fires, then returns an error that
// neither wraps context.DeadlineExceeded nor is a *pgconn.PgError (the shape escaped in
// CI 41502888581 / 41504943810).
func opaqueAfterBudget(ctx context.Context) error {
	<-ctx.Done()
	return fmt.Errorf("conn busy: %v", errors.New("opaque driver state after cancel"))
}

func TestSuggestBranchBudgetExpiredOpaqueErrorIsPartial(t *testing.T) {
	env := newBranchFailEnv(t)
	q := url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}}

	type tc struct {
		name        string
		install     func(corpus string)
		corpus      string // the corpus that fails
		wantPartial []string
	}
	hookAfterSetLocal := func(corpus string) {
		env.svc.SetTestHooks(&suggest.TestHooks{
			AfterBranchSetLocal: func(ctx context.Context, _ pgx.Tx, c string) error {
				if c == corpus {
					return opaqueAfterBudget(ctx)
				}
				return nil
			},
		})
	}
	hookBefore := func(corpus string) {
		env.svc.SetTestHooks(&suggest.TestHooks{
			BeforeBranch: func(ctx context.Context, c string) error {
				if c == corpus {
					return opaqueAfterBudget(ctx)
				}
				return nil
			},
		})
	}
	cases := []tc{
		{"item-after-set-local", hookAfterSetLocal, suggest.CorpusItem, []string{"item"}},
		{"tag-after-set-local", hookAfterSetLocal, suggest.CorpusTag, []string{"tag"}},
		{"item-before-branch", hookBefore, suggest.CorpusItem, []string{"item"}},
		{"tag-before-branch", hookBefore, suggest.CorpusTag, []string{"tag"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			warmPoolConns(t, env.pool, 2)
			beforeItem, beforeTag := env.partialCounters()
			c.install(c.corpus)
			rec := env.doSuggest("tok-u1", q)
			resp := validateSuggestResponseOpenAPIShape(t, rec)
			if !slices.Equal(resp.LexicalPartial, c.wantPartial) {
				t.Fatalf("lexical_partial = %v, want %v", resp.LexicalPartial, c.wantPartial)
			}
			if c.corpus == suggest.CorpusItem && (len(resp.Items) != 0 || len(resp.Tags) != 1) {
				t.Fatalf("item failed: items=%d tags=%d, want 0 and 1", len(resp.Items), len(resp.Tags))
			}
			if c.corpus == suggest.CorpusTag && (len(resp.Tags) != 0 || len(resp.Items) != 1) {
				t.Fatalf("tag failed: items=%d tags=%d, want 1 and 0", len(resp.Items), len(resp.Tags))
			}
			afterItem, afterTag := env.partialCounters()
			wantItem, wantTag := beforeItem, beforeTag
			if c.corpus == suggest.CorpusItem {
				wantItem++
			} else {
				wantTag++
			}
			if afterItem != wantItem || afterTag != wantTag {
				t.Fatalf("counters = (item=%v, tag=%v), want (%v, %v)", afterItem, afterTag, wantItem, wantTag)
			}
			if lines := env.serverErrorLines(); len(lines) != 0 {
				t.Fatalf("a partial response must not log WARN/ERROR, got %v", lines)
			}
		})
	}
}

// failingBeginTx simulates pgxpool.BeginTx losing the branch budget while waiting for a
// connection: it returns a non-context, non-pg error after ctx is done.
type failingBeginTx struct{}

func (failingBeginTx) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return nil, opaqueAfterBudget(ctx)
}

func TestSuggestBeginTxBudgetExpiredIsPartial(t *testing.T) {
	env := newBranchFailEnv(t)
	beforeItem, beforeTag := env.partialCounters()
	env.svc.SetTxStarter(failingBeginTx{})

	rec := env.doSuggest("tok-u1", url.Values{"q": {"wifi"}, "scope": {"all"}, "limit": {"8"}})
	resp := validateSuggestResponseOpenAPIShape(t, rec)
	got := slices.Clone(resp.LexicalPartial)
	slices.Sort(got)
	if !slices.Equal(got, []string{"item", "tag"}) {
		t.Fatalf("both branches expired: lexical_partial = %v, want [item tag] (SPEC §6.8: each branch degrades independently)", resp.LexicalPartial)
	}
	if len(resp.Items) != 0 || len(resp.Tags) != 0 {
		t.Fatalf("both branches expired must return no rows, got items=%d tags=%d", len(resp.Items), len(resp.Tags))
	}
	afterItem, afterTag := env.partialCounters()
	if afterItem != beforeItem+1 || afterTag != beforeTag+1 {
		t.Fatalf("counters = (item=%v, tag=%v), want (%v, %v)", afterItem, afterTag, beforeItem+1, beforeTag+1)
	}
	if lines := env.serverErrorLines(); len(lines) != 0 {
		t.Fatalf("both-partial 200 must not log WARN/ERROR, got %v", lines)
	}
}

func TestSuggestGenuineErrorLogsErrorClass(t *testing.T) {
	env := newBranchFailEnv(t)

	type tc struct {
		name       string
		hook       *suggest.TestHooks
		install    func()
		query      url.Values
		wantClass  string
		wantCorpus string
		wantScope  string
		wantMode   string
		wantPGCode string
	}
	plain := func(corpus string) *suggest.TestHooks {
		return &suggest.TestHooks{
			AfterBranchSetLocal: func(_ context.Context, _ pgx.Tx, c string) error {
				if c == corpus {
					return errors.New(failSentinelErr + " " + failSentinelQuery)
				}
				return nil
			},
		}
	}
	divByZero := &suggest.TestHooks{
		AfterBranchSetLocal: func(ctx context.Context, tx pgx.Tx, c string) error {
			if c != suggest.CorpusItem {
				return nil
			}
			_, err := tx.Exec(ctx, `SELECT 1/0`)
			return err
		},
	}
	cases := []tc{
		{name: "item-plain", hook: plain(suggest.CorpusItem), wantClass: "lexical_item_db", wantCorpus: "item", wantScope: "all", wantMode: "full"},
		{name: "tag-plain", hook: plain(suggest.CorpusTag), wantClass: "lexical_tag_db", wantCorpus: "tag", wantScope: "all", wantMode: "full"},
		{name: "item-pgcode", hook: divByZero, wantClass: "lexical_item_db", wantCorpus: "item", wantScope: "all", wantMode: "full", wantPGCode: "22012"},
		{name: "recent-mode-item", hook: plain(suggest.CorpusItem), query: url.Values{"q": {""}, "scope": {"item"}}, wantClass: "lexical_item_db", wantCorpus: "item", wantScope: "item", wantMode: "recent"},
		{
			name: "near-source",
			install: func() {
				env.svc.SetNearSource(failingNear{})
			},
			wantClass: "near_source", wantScope: "all", wantMode: "full",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			warmPoolConns(t, env.pool, 2)
			env.logBuf.Reset()
			beforeItem, beforeTag := env.partialCounters()
			env.svc.SetTestHooks(c.hook)
			if c.install != nil {
				c.install()
			}
			t.Cleanup(func() { env.svc.SetNearSource(nil) })
			q := c.query
			if q == nil {
				q = url.Values{"q": {failSentinelQuery}, "scope": {"all"}, "limit": {"8"}}
			}
			rec := env.doSuggest("tok-u1", q)
			if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "internal_error") {
				t.Fatalf("status = %d body = %s, want 500 internal_error", rec.Code, rec.Body.String())
			}

			lines := env.serverErrorLines()
			if len(lines) != 1 {
				t.Fatalf("WARN/ERROR lines = %d, want exactly 1: %v", len(lines), lines)
			}
			line := lines[0]
			want := map[string]string{
				"error_class": c.wantClass,
				"route":       "/api/v1/suggest",
				"scope":       c.wantScope,
				"mode":        c.wantMode,
			}
			if c.wantCorpus != "" {
				want["corpus"] = c.wantCorpus
			}
			if c.wantPGCode != "" {
				want["pgcode"] = c.wantPGCode
			}
			for k, v := range want {
				if got, _ := line[k].(string); got != v {
					t.Fatalf("log field %s = %q, want %q (line %v)", k, got, v, line)
				}
			}
			if c.wantPGCode == "" {
				if _, has := line["pgcode"]; has {
					t.Fatalf("pgcode must be absent for a non-pg error: %v", line)
				}
			}
			// Only bounded fields: no q, qn, err text, names.
			allowed := map[string]bool{
				"time": true, "level": true, "msg": true, "error_class": true, "route": true,
				"corpus": true, "mode": true, "scope": true, "pgcode": true,
			}
			for k := range line {
				if !allowed[k] {
					t.Fatalf("unexpected log field %q in %v", k, line)
				}
			}
			logs := env.logBuf.String()
			for _, s := range []string{failSentinelQuery, failSentinelErr, "wifi văn phòng", "wifi-tag", "division by zero"} {
				if strings.Contains(logs, s) {
					t.Fatalf("log leaked %q: %s", s, logs)
				}
			}
			afterItem, afterTag := env.partialCounters()
			if afterItem != beforeItem || afterTag != beforeTag {
				t.Fatalf("a genuine error must not bump the partial counter: (%v,%v) -> (%v,%v)", beforeItem, beforeTag, afterItem, afterTag)
			}
		})
	}
}

type failingNear struct{}

func (failingNear) Near(context.Context, suggest.NearRequest) (suggest.NearResult, error) {
	return suggest.NearResult{}, errors.New(failSentinelErr)
}

func (failingNear) ActiveGeneration(context.Context, uuid.UUID) (*int, error) { return nil, nil }

func TestSuggestClientDisconnectNotServerError(t *testing.T) {
	env := newBranchFailEnv(t)
	beforeItem, beforeTag := env.partialCounters()
	env.logBuf.Reset()

	reqCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	env.svc.SetTestHooks(&suggest.TestHooks{
		AfterBranchSetLocal: func(ctx context.Context, _ pgx.Tx, c string) error {
			if c != suggest.CorpusItem {
				return nil
			}
			cancel() // the client goes away mid-branch
			return opaqueAfterBudget(ctx)
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/suggest?"+url.Values{"q": {"wifi"}, "scope": {"all"}}.Encode(), nil).WithContext(reqCtx)
	req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok-u1"})
	rec := httptest.NewRecorder()
	env.router.ServeHTTP(rec, req)

	if lines := env.serverErrorLines(); len(lines) != 0 {
		t.Fatalf("client disconnect must not log WARN/ERROR, got %v", lines)
	}
	afterItem, afterTag := env.partialCounters()
	if afterItem != beforeItem || afterTag != beforeTag {
		t.Fatalf("client disconnect must not bump the partial counter: (%v,%v) -> (%v,%v)", beforeItem, beforeTag, afterItem, afterTag)
	}
	if strings.Contains(rec.Body.String(), "lexical_partial") && rec.Code == http.StatusOK {
		t.Fatalf("client disconnect must not be reported as a partial 200: %s", rec.Body.String())
	}
}

// /search keeps its dec-287 policy; the shared classification only changes which error
// shapes count as the branch budget firing.
func TestSearchBranchBudgetExpiredOpaqueErrorKeepsPolicy(t *testing.T) {
	env := newBranchFailEnv(t)

	t.Run("page1-tag-degrades", func(t *testing.T) {
		warmPoolConns(t, env.pool, 2)
		env.logBuf.Reset()
		_, beforeTag := env.partialCounters()
		env.svc.SetTestHooks(&suggest.TestHooks{
			BeforeBranch: func(ctx context.Context, c string) error {
				if c == suggest.CorpusTag {
					return opaqueAfterBudget(ctx)
				}
				return nil
			},
		})
		rec := env.doSearch("tok-u1", url.Values{"q": {"wifi"}, "scope": {"all"}})
		resp := validateSearchResponseOpenAPIShape(t, rec)
		if len(resp.Tags) != 0 || len(resp.Items) != 1 {
			t.Fatalf("tags=%d items=%d, want 0 and 1", len(resp.Tags), len(resp.Items))
		}
		_, afterTag := env.partialCounters()
		if afterTag != beforeTag+1 {
			t.Fatalf("tag partial counter = %v, want %v", afterTag, beforeTag+1)
		}
		if lines := env.serverErrorLines(); len(lines) != 0 {
			t.Fatalf("degraded 200 must not log WARN/ERROR, got %v", lines)
		}
	})

	t.Run("primary-item-is-500-and-counted", func(t *testing.T) {
		warmPoolConns(t, env.pool, 2)
		env.logBuf.Reset()
		beforeItem, _ := env.partialCounters()
		env.svc.SetTestHooks(&suggest.TestHooks{
			BeforeBranch: func(ctx context.Context, c string) error {
				if c == suggest.CorpusItem {
					return opaqueAfterBudget(ctx)
				}
				return nil
			},
		})
		rec := env.doSearch("tok-u1", url.Values{"q": {"wifi"}, "scope": {"item"}})
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		afterItem, _ := env.partialCounters()
		if afterItem != beforeItem+1 {
			t.Fatalf("item partial counter = %v, want %v", afterItem, beforeItem+1)
		}
		lines := env.serverErrorLines()
		if len(lines) != 1 || lines[0]["error_class"] != "search_internal" || lines[0]["route"] != "/api/v1/search" {
			t.Fatalf("want one search_internal WARN, got %v", lines)
		}
	})

	t.Run("genuine-error-logged", func(t *testing.T) {
		warmPoolConns(t, env.pool, 2)
		env.logBuf.Reset()
		env.svc.SetTestHooks(&suggest.TestHooks{
			AfterBranchSetLocal: func(_ context.Context, _ pgx.Tx, c string) error {
				if c == suggest.CorpusItem {
					return errors.New(failSentinelErr)
				}
				return nil
			},
		})
		rec := env.doSearch("tok-u1", url.Values{"q": {failSentinelQuery}, "scope": {"item"}})
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		lines := env.serverErrorLines()
		if len(lines) != 1 || lines[0]["error_class"] != "lexical_item_db" || lines[0]["route"] != "/api/v1/search" {
			t.Fatalf("want one lexical_item_db WARN, got %v", lines)
		}
		if logs := env.logBuf.String(); strings.Contains(logs, failSentinelQuery) || strings.Contains(logs, failSentinelErr) {
			t.Fatalf("log leaked a sentinel: %s", logs)
		}
	})
}
