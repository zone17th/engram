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
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// FU-SB-1: a lexical branch whose 50 ms budget fired must degrade to `lexical_partial`
// whatever error shape pgx produced, a genuine error must log exactly one WARN with a
// bounded `error_class`, and a client disconnect must be neither partial nor a server error.
//
// RV-SB1-BE-2: these regressions run on a TxStarter / pgx.Tx FAKE with canned rows, never on
// the database, so no real query latency can expire the healthy sibling branch. The only
// wall-clock wait is the intended branch's own 50 ms budget in the partial tests (a hook blocks
// on its ctx.Done()). The real-DB 57014 path stays covered by TestSuggestBranchTimeoutPartial.
//
// RV-SB1-BE-4: every GENUINE-error assertion (exact class, one WARN, fields, privacy, static
// 500) installs liveBranchContext through TestHooks.BranchContext, so the branch context has no
// timer and the real 50 ms budget cannot fire between the injected error and classification.
// A request cancel still reaches the branch because the live context is a child of the request.

const (
	failSentinelQuery = "failsentinelqueryxyz"
	failSentinelErr   = "SecretErrSentinelOmega"
)

var (
	fakeItemID = uuid.MustParse("00000000-0001-4000-8000-000000000701")
	fakeTagID  = uuid.MustParse("00000000-0011-4000-8000-000000000701")
	fakeUserID = uuid.MustParse("77777777-7777-4000-8000-000000000007")
	fakeTS     = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
)

// fakeRows serves canned rows to the sqlc-generated scan loops.
type fakeRows struct {
	pgx.Rows
	data [][]any
	pos  int
	cur  []any
}

func (r *fakeRows) Next() bool {
	if r.pos >= len(r.data) {
		return false
	}
	r.cur = r.data[r.pos]
	r.pos++
	return true
}

func (r *fakeRows) Scan(dest ...any) error {
	if len(dest) != len(r.cur) {
		return fmt.Errorf("fakeRows: %d dest for %d canned columns", len(dest), len(r.cur))
	}
	for i := range dest {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(r.cur[i]))
	}
	return nil
}

func (r *fakeRows) Close()     {}
func (r *fakeRows) Err() error { return nil }

// fakeTx implements the part of pgx.Tx the lexical branches use. Any other method panics on
// the nil embedded interface, which flags an unexpected new call in the production code.
type fakeTx struct {
	pgx.Tx
	cfg *fakeDB
	// onRollback runs in THIS transaction's deferred Rollback only (RV-SB1-BE-5); a test sets
	// it from a branch hook through the pgx.Tx it receives.
	onRollback func()
}

// fakeDB is the shared configuration of every fake transaction.
type fakeDB struct {
	// queryErr fails the named sqlc query ("SearchItemsLexical", "ListTagRefsForItems", ...).
	queryErr map[string]error
	// beginErr, when set, is called by BeginTx and its error is returned.
	beginErr func(ctx context.Context) error
}

func (d *fakeDB) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	if d.beginErr != nil {
		if err := d.beginErr(ctx); err != nil {
			return nil, err
		}
	}
	return &fakeTx{cfg: d}, nil
}

func (t *fakeTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (t *fakeTx) Rollback(context.Context) error {
	if t.onRollback != nil {
		t.onRollback()
	}
	return nil
}

// liveBranchContext is the TestHooks.BranchContext of the genuine-error regressions: a branch
// context without a timer, canceled only by its own deferred cancel or by the request.
func liveBranchContext(parent context.Context, _ string) (context.Context, context.CancelFunc) {
	return context.WithCancel(parent)
}

func (t *fakeTx) Query(_ context.Context, sql string, _ ...any) (pgx.Rows, error) {
	// sqlc prefixes every statement with "-- name: <Query> :many".
	fields := strings.Fields(sql)
	if len(fields) < 3 || fields[0] != "--" || fields[1] != "name:" {
		return nil, fmt.Errorf("fakeTx: unexpected SQL %.40q", sql)
	}
	name := fields[2]
	if err := t.cfg.queryErr[name]; err != nil {
		return nil, err
	}
	ts := pgtype.Timestamptz{Time: fakeTS, Valid: true}
	var data [][]any
	switch name {
	case "SearchItemsLexical", "SearchItemsLexicalPage":
		data = [][]any{{fakeItemID, "wifi văn phòng", int32(4), ts, ts, int32(1), float64(0.9)}}
	case "SearchTagsLexical", "SearchTagsLexicalPage":
		data = [][]any{{fakeTagID, "wifi-tag", int32(2), ts, int32(1), float64(0.9)}}
	case "RecentItemsForSuggest":
		data = [][]any{{fakeItemID, "wifi văn phòng", int32(4), ts, ts}}
	case "RecentTagsForSuggest":
		data = [][]any{{fakeTagID, "wifi-tag", int32(2), ts}}
	case "ListTagRefsForItems":
		// no tag chips
	default:
		return nil, fmt.Errorf("fakeTx: unexpected query %q", name)
	}
	return &fakeRows{data: data}, nil
}

type branchFailEnv struct {
	*suggestTestEnv
	db     *fakeDB
	logBuf *bytes.Buffer
}

func newBranchFailEnv(t *testing.T) *branchFailEnv {
	t.Helper()
	logBuf := &bytes.Buffer{}
	logger := slog.New(slog.NewJSONHandler(logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	clk := clock.NewFixed(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	reg, metrics := obs.NewRegistry()
	cursorKey, err := suggest.DeriveCursorKey([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("DeriveCursorKey: %v", err)
	}
	bucket := httpx.NewTokenBucket(10_000, 10_000, clk)
	db := &fakeDB{}
	svc := suggest.NewService(nil, clk, suggest.NewNoopNearSource(), metrics, cursorKey)
	svc.SetTxStarter(db)
	handler := suggest.NewHandler(svc, bucket)
	auth := &suggestTestAuth{cookies: make(map[string]authctx.Principal)}
	auth.addToken("tok-u1", fakeUserID)
	router := httpx.NewRouter(httpx.Deps{
		Logger:           logger,
		Metrics:          promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
		MetricsCollector: metrics,
		Authenticator:    auth,
		MountAPI:         suggest.Mount(handler),
	})
	return &branchFailEnv{
		suggestTestEnv: &suggestTestEnv{
			t: t, clk: clk, reg: reg, metrics: metrics, bucket: bucket,
			svc: svc, handler: handler, router: router, auth: auth,
		},
		db:     db,
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
// neither wraps context.DeadlineExceeded nor is a *pgconn.PgError. It stands for the class of
// driver errors the old isBranchTimeout did not recognise; the exact shape seen in CI
// 41502888581 / 41504943810 was never captured, so this is an uncovered class, not a
// reproduction of that failure.
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

// TestSuggestBeginTxBudgetExpiredIsPartial simulates pgxpool.BeginTx losing the branch budget
// while waiting for a connection: a non-context, non-pg error after ctx is done.
func TestSuggestBeginTxBudgetExpiredIsPartial(t *testing.T) {
	env := newBranchFailEnv(t)
	beforeItem, beforeTag := env.partialCounters()
	env.db.beginErr = opaqueAfterBudget

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
	pgFail := &suggest.TestHooks{
		AfterBranchSetLocal: func(_ context.Context, _ pgx.Tx, c string) error {
			if c != suggest.CorpusItem {
				return nil
			}
			return fmt.Errorf("exec: %w", &pgconn.PgError{Code: "22012", Message: "division by zero " + failSentinelErr})
		},
	}
	queryFail := func(name string) func() {
		return func() {
			env.db.queryErr = map[string]error{name: errors.New(failSentinelErr + " " + failSentinelQuery)}
		}
	}
	cases := []tc{
		{name: "item-plain", hook: plain(suggest.CorpusItem), wantClass: "lexical_item_db", wantCorpus: "item", wantScope: "all", wantMode: "full"},
		{name: "tag-plain", hook: plain(suggest.CorpusTag), wantClass: "lexical_tag_db", wantCorpus: "tag", wantScope: "all", wantMode: "full"},
		{name: "item-pgcode", hook: pgFail, wantClass: "lexical_item_db", wantCorpus: "item", wantScope: "all", wantMode: "full", wantPGCode: "22012"},
		{name: "recent-mode-item", hook: plain(suggest.CorpusItem), query: url.Values{"q": {""}, "scope": {"item"}}, wantClass: "lexical_item_db", wantCorpus: "item", wantScope: "item", wantMode: "recent"},
		{name: "item-query", install: queryFail("SearchItemsLexical"), wantClass: "lexical_item_db", wantCorpus: "item", wantScope: "all", wantMode: "full"},
		{name: "tag-query", install: queryFail("SearchTagsLexical"), wantClass: "lexical_tag_db", wantCorpus: "tag", wantScope: "all", wantMode: "full"},
		{name: "item-tagrefs-query", install: queryFail("ListTagRefsForItems"), wantClass: "lexical_item_tagrefs", wantCorpus: "item", wantScope: "all", wantMode: "full"},
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
			env.logBuf.Reset()
			env.db.queryErr = nil
			beforeItem, beforeTag := env.partialCounters()
			// Genuine errors are asserted on a branch context that cannot expire (RV-SB1-BE-4).
			hooks := c.hook
			if hooks == nil {
				hooks = &suggest.TestHooks{}
			}
			hooks.BranchContext = liveBranchContext
			env.svc.SetTestHooks(hooks)
			env.svc.SetNearSource(nil)
			if c.install != nil {
				c.install()
			}
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
			assertOnlyBoundedLogFields(t, line)
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

// assertOnlyBoundedLogFields: the server-error line carries only error_class, route, corpus,
// mode, scope and a SQLSTATE; never q, qn, err text or names (dec-268).
func assertOnlyBoundedLogFields(t *testing.T, line map[string]any) {
	t.Helper()
	allowed := map[string]bool{
		"time": true, "level": true, "msg": true, "error_class": true, "route": true,
		"corpus": true, "mode": true, "scope": true, "pgcode": true,
	}
	for k := range line {
		if !allowed[k] {
			t.Fatalf("unexpected log field %q in %v", k, line)
		}
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

// cancelFromOwnRollback makes the transaction a branch hook received cancel the request from
// its OWN deferred Rollback (RV-SB1-BE-5). That Rollback runs in the failing branch goroutine
// right after its fail closure returned the classification (partial) and before wg.Done, so
// the cancel can only land after the target branch was classified partial, and a healthy
// sibling's rollback (a different fakeTx) never cancels. The returned recorder is true once
// the cancel fired with the request still alive and the branch budget expired, i.e. with the
// branch classified partial before the cancel.
func cancelFromOwnRollback(t *testing.T, tx pgx.Tx, parent, branch context.Context, cancel context.CancelFunc) *atomic.Bool {
	t.Helper()
	ft, ok := tx.(*fakeTx)
	if !ok {
		t.Fatalf("branch tx is %T, want *fakeTx", tx)
	}
	var partialBeforeCancel atomic.Bool
	ft.onRollback = func() {
		partialBeforeCancel.Store(parent.Err() == nil && errors.Is(branch.Err(), context.DeadlineExceeded))
		cancel()
	}
	return &partialBeforeCancel
}

// TestSuggestParentCancelAfterPartialClassifiedIsNotPartial (RV-SB1-BE-1, service level): the tag
// branch is classified partial while the request is alive; the request is canceled right after
// from that branch's own deferred Rollback. The aggregation must let the parent win: a cancel
// error, no counter bump, no partial 200.
//
// Why this fails without the post-Wait parent check in runLexicalBranches (RV-SB1-BE-5): the
// item sibling is healthy and its rollback cannot cancel. The tag branch returns
// partial=true (the parent is alive when classifyBranchErr reads it, asserted below through
// partialBeforeCancel), then its rollback cancels the request, then wg.Done. Without the check,
// runLexicalBranches sees tagOut.partial, bumps the tag counter and returns a nil error with
// lexical_partial=[tag], so both the err and the counter assertions below fail on every run;
// with the check the parent error wins.
func TestSuggestParentCancelAfterPartialClassifiedIsNotPartial(t *testing.T) {
	env := newBranchFailEnv(t)
	beforeItem, beforeTag := env.partialCounters()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var partialBeforeCancel *atomic.Bool
	env.svc.SetTestHooks(&suggest.TestHooks{
		AfterBranchSetLocal: func(bctx context.Context, tx pgx.Tx, c string) error {
			if c != suggest.CorpusTag {
				return nil
			}
			partialBeforeCancel = cancelFromOwnRollback(t, tx, ctx, bctx, cancel)
			return opaqueAfterBudget(bctx)
		},
	})

	resp, err := env.svc.Suggest(ctx, suggest.SuggestInput{
		UserID: fakeUserID, RawQ: "wifi", Scope: suggest.ScopeAll, Limit: 8, Semantic: true,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Suggest err = %v (resp %+v), want a context.Canceled error", err, resp)
	}
	if partialBeforeCancel == nil || !partialBeforeCancel.Load() {
		t.Fatalf("the tag branch must be classified partial (alive parent, expired budget) before the cancel")
	}
	afterItem, afterTag := env.partialCounters()
	if afterItem != beforeItem || afterTag != beforeTag {
		t.Fatalf("a canceled request must not bump the partial counter: (%v,%v) -> (%v,%v)", beforeItem, beforeTag, afterItem, afterTag)
	}
}

// /search keeps its dec-287 policy; the shared classification only changes which error
// shapes count as the branch budget firing.
func TestSearchBranchBudgetExpiredOpaqueErrorKeepsPolicy(t *testing.T) {
	env := newBranchFailEnv(t)

	t.Run("page1-tag-degrades", func(t *testing.T) {
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

	t.Run("primary-item-is-500-counted-and-logged-once", func(t *testing.T) {
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
		if len(lines) != 1 {
			t.Fatalf("want exactly one WARN for the primary timeout, got %v", lines)
		}
		for k, v := range map[string]string{
			"error_class": "search_primary_timeout", "route": "/api/v1/search", "corpus": "item", "scope": "item", "mode": "full",
		} {
			if got, _ := lines[0][k].(string); got != v {
				t.Fatalf("log field %s = %q, want %q (line %v)", k, got, v, lines[0])
			}
		}
		assertOnlyBoundedLogFields(t, lines[0])
	})

	t.Run("genuine-error-logged", func(t *testing.T) {
		env.logBuf.Reset()
		env.svc.SetTestHooks(&suggest.TestHooks{
			BranchContext: liveBranchContext, // RV-SB1-BE-4: no timer can expire the branch
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

	// The auxiliary page-1 tag branch degrades while the primary item branch is healthy; the
	// healthy side is a fake, so nothing but the intended branch can expire.
	t.Run("aux-tag-timeout-with-healthy-primary", func(t *testing.T) {
		env.logBuf.Reset()
		_, beforeTag := env.partialCounters()
		env.svc.SetTestHooks(&suggest.TestHooks{
			AfterBranchSetLocal: func(ctx context.Context, _ pgx.Tx, c string) error {
				if c == suggest.CorpusTag {
					return opaqueAfterBudget(ctx)
				}
				return nil
			},
		})
		rec := env.doSearch("tok-u1", url.Values{"q": {"wifi"}, "scope": {"all"}})
		resp := validateSearchResponseOpenAPIShape(t, rec)
		if len(resp.Items) != 1 || len(resp.Tags) != 0 {
			t.Fatalf("items=%d tags=%d, want 1 and 0", len(resp.Items), len(resp.Tags))
		}
		if _, afterTag := env.partialCounters(); afterTag != beforeTag+1 {
			t.Fatalf("tag partial counter = %v, want %v", afterTag, beforeTag+1)
		}
		if lines := env.serverErrorLines(); len(lines) != 0 {
			t.Fatalf("degraded 200 must not log WARN/ERROR, got %v", lines)
		}
	})
}

// TestSearchParentCancelAfterPrimaryPartialIsNotCounted (RV-SB1-BE-1): the primary branch is
// classified partial while the request is alive, then the request is canceled from that branch's
// own rollback (RV-SB1-BE-5, see cancelFromOwnRollback). /search must return the cancel error and
// count nothing; the handler logs nothing. Without the parentDoneErr checks after the aggregation
// the primary partial would become search_primary_timeout (500, counter+1) instead of the cancel.
func TestSearchParentCancelAfterPrimaryPartialIsNotCounted(t *testing.T) {
	for _, scope := range []string{suggest.ScopeItem, suggest.ScopeAll} {
		t.Run(scope, func(t *testing.T) {
			env := newBranchFailEnv(t)
			beforeItem, beforeTag := env.partialCounters()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var partialBeforeCancel *atomic.Bool
			env.svc.SetTestHooks(&suggest.TestHooks{
				AfterBranchSetLocal: func(bctx context.Context, tx pgx.Tx, c string) error {
					if c != suggest.CorpusItem {
						return nil
					}
					partialBeforeCancel = cancelFromOwnRollback(t, tx, ctx, bctx, cancel)
					return opaqueAfterBudget(bctx)
				},
			})
			_, err := env.svc.Search(ctx, suggest.SearchInput{UserID: fakeUserID, RawQ: "wifi", Scope: scope, Limit: 20, Semantic: true})
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("Search err = %v, want a context.Canceled error", err)
			}
			if partialBeforeCancel == nil || !partialBeforeCancel.Load() {
				t.Fatalf("the item branch must be classified partial (alive parent, expired budget) before the cancel")
			}
			afterItem, afterTag := env.partialCounters()
			if afterItem != beforeItem || afterTag != beforeTag {
				t.Fatalf("a canceled request must not bump the partial counter: (%v,%v) -> (%v,%v)", beforeItem, beforeTag, afterItem, afterTag)
			}
		})
	}
}

// loggingFailGen is a generation source faithful to the production semantic source: it logs
// its own WARN (fixed class, no text) before returning the lookup error (nearsource.go).
type loggingFailGen struct {
	logger *slog.Logger
}

func (g loggingFailGen) Near(context.Context, suggest.NearRequest) (suggest.NearResult, error) {
	return suggest.NearResult{}, nil
}

func (g loggingFailGen) ActiveGeneration(ctx context.Context, _ uuid.UUID) (*int, error) {
	g.logger.LogAttrs(ctx, slog.LevelWarn, "semantic active generation lookup failed",
		slog.String("error_class", "active_generation_lookup_failed"))
	return nil, errors.New(failSentinelErr + " " + failSentinelQuery)
}

// TestSearchGenerationLookupFailureLogsExactlyOnce (RV-SB1-BE-3): the semantic source owns the
// active_generation_lookup_failed WARN; the handler must not add a second one. The response is
// the same static 500 and nothing sensitive reaches the log or the body.
func TestSearchGenerationLookupFailureLogsExactlyOnce(t *testing.T) {
	env := newBranchFailEnv(t)
	logger := slog.New(slog.NewJSONHandler(env.logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	env.svc.SetNearSource(loggingFailGen{logger: logger})
	env.logBuf.Reset()
	beforeItem, beforeTag := env.partialCounters()

	rec := env.doSearch("tok-u1", url.Values{"q": {failSentinelQuery}, "scope": {"all"}})
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "internal_error") {
		t.Fatalf("status = %d body = %s, want 500 internal_error", rec.Code, rec.Body.String())
	}
	lines := env.serverErrorLines()
	if len(lines) != 1 {
		t.Fatalf("WARN/ERROR lines = %d, want exactly 1 (the source's own): %v", len(lines), lines)
	}
	if got, _ := lines[0]["error_class"].(string); got != "active_generation_lookup_failed" {
		t.Fatalf("the single WARN must be the source's: %v", lines[0])
	}
	for _, s := range []string{failSentinelQuery, failSentinelErr} {
		if strings.Contains(env.logBuf.String(), s) || strings.Contains(rec.Body.String(), s) {
			t.Fatalf("leaked %q: log=%s body=%s", s, env.logBuf.String(), rec.Body.String())
		}
	}
	afterItem, afterTag := env.partialCounters()
	if afterItem != beforeItem || afterTag != beforeTag {
		t.Fatalf("a generation lookup failure must not bump the partial counter")
	}
	// Same static 500 as before the split of causes.
	if _, err := env.svc.Search(context.Background(), suggest.SearchInput{UserID: fakeUserID, RawQ: "wifi", Scope: suggest.ScopeAll, Limit: 20}); !errors.Is(err, suggest.ErrSearchInternal) {
		t.Fatalf("Search err = %v, want errors.Is ErrSearchInternal", err)
	}
}
