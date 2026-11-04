//go:build searchbench

package searchbench

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/reconcile"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/item"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// Task 23 harness additions for the full run (advisor-dec-337): FU-SB-2b connect
// cost probe, FU-SL-1 lexical planner choice at real volume with the simulated
// 0010, FU-T19-FLIPCOST in-lock coverage scan at full volume and the full
// Reconcile time. They run AFTER every measured C1/C2 cell, in a quiet phase on
// their own connections: no measured pool is in use, no planner setting is ever
// pinned (the only DDL is a DROP INDEX inside a transaction that is rolled back),
// and nothing here is part of a target. Report sections carry case ids, class
// names, index names, timings and counts only; query strings are never printed.

// ExtrasConfig sizes the extras of a profile.
type ExtrasConfig struct {
	ProbeN        int  // connect probe iterations per shape (1d)
	PlanMedium    bool // also EXPLAIN a medium tenant (2)
	ProbeMedium   bool // also probe a medium tenant (1d)
	PlanQueries   int  // representative queries per (corpus, shape)
	ScanTimeout   time.Duration
	ShortTimeout  time.Duration
	PlanStatement string // statement_timeout of the EXPLAIN tx (harness bound, not production's 50 ms)
	// TotalBudget caps ALL extras together; a section that has not started when it
	// is spent is recorded as "<section>: skipped_budget". 0 = no extra cap.
	TotalBudget time.Duration
}

// Budgets of the extras per profile (RV-W4-1-2): the extras run after the measured
// cells, so they must never eat the time the report needs.
const (
	extrasBudgetFull  = 25 * time.Minute
	extrasBudgetSmoke = 4 * time.Minute
	// testDeadlineReserve is left between the benchmark context and the `go test
	// -timeout` for the t.Cleanup writes (report, server logs, database drop): on a
	// test timeout go test panics and cleanups do not run.
	testDeadlineReserve = 5 * time.Minute
	// skippedBudgetTag is the report tag of a section that never started.
	skippedBudgetTag = "skipped_budget"
)

// BenchContext bounds the benchmark: limit, and, when the test has a deadline,
// deadline - reserve, whichever is earlier, so the measured results are written
// by t.Cleanup before `go test -timeout` kills the process.
func BenchContext(parent context.Context, limit time.Duration, testDeadline time.Time, hasDeadline bool, reserve time.Duration) (context.Context, context.CancelFunc) {
	end := time.Now().Add(limit)
	if hasDeadline {
		if d := testDeadline.Add(-reserve); d.Before(end) {
			end = d
		}
	}
	return context.WithDeadline(parent, end)
}

// ExtrasConfigFor returns the extras of a profile: smoke (< 20 min job) probes
// N=5 and explains the 10k tenant only; full probes N=20 and explains the whale
// and a medium tenant.
func ExtrasConfigFor(p ProfileName) ExtrasConfig {
	c := ExtrasConfig{ProbeN: 5, PlanQueries: 3, ScanTimeout: 30 * time.Minute, ShortTimeout: 10 * time.Minute, PlanStatement: "10s"}
	c.TotalBudget = extrasBudgetSmoke
	if p == ProfileFull {
		c.TotalBudget = extrasBudgetFull
		c.ProbeN = 20
		c.PlanMedium = true
		c.ProbeMedium = true
	}
	return c
}

// Task23Extras is the report block of the four additions.
type Task23Extras struct {
	Reconcile    *ReconcileTiming    `json:"reconcile_full,omitempty"`
	FlipCost     *FlipCostReport     `json:"flip_cost_scan,omitempty"`
	LexicalPlan  *LexPlanReport      `json:"lexical_plan,omitempty"`
	ConnectProbe *ConnectProbeReport `json:"connect_probe,omitempty"`
	// Errors lists the sections that failed, as class tags only (the full error
	// text goes to the job log).
	Errors []string `json:"errors,omitempty"`
}

// errTag reduces an error to a fixed class tag so neither the report nor the job
// log carries driver or SQL text (a pgx connect error names user, database and host,
// a PgError message can quote a parameter value). A PgError keeps its SQLSTATE
// ("pgcode_57014"), which is what the diagnosis needs.
func errTag(err error) string {
	var pe *pgconn.PgError
	switch {
	case err == nil:
		return ""
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.As(err, &pe):
		return "pgcode_" + pe.Code
	default:
		return "error"
	}
}

// RunExtras runs the four additions in a fixed order (read-only first, the
// ACCESS EXCLUSIVE simulation last of the DB work, the connect probe at the end)
// and never aborts the benchmark: a failed section is recorded and the rest run.
func RunExtras(ctx context.Context, dsn string, sr *SeedResult, classes map[TenantClass][]int, cfg ExtrasConfig, logf func(string, ...any)) *Task23Extras {
	ex := &Task23Extras{}
	fail := func(section string, err error) {
		logf("task23 extra %s failed: %s", section, errTag(err))
		ex.Errors = append(ex.Errors, section+": "+errTag(err))
	}
	if cfg.TotalBudget > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, cfg.TotalBudget)
		defer cancel()
	}
	if ctx.Err() != nil {
		// No time left at all (the benchmark used its whole context): record every
		// section as skipped so the report says so.
		for _, name := range extraSectionNames {
			ex.Errors = append(ex.Errors, skippedBudget(name))
		}
		logf("task23 extras skipped: no budget left")
		return ex
	}
	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		fail("pool", err)
		return ex
	}
	defer pool.Close()
	g, err := generation.GetByID(ctx, pool, BenchGenerationID)
	if err != nil {
		fail("generation", err)
		return ex
	}

	ex.Errors = append(ex.Errors, runExtraSections(ctx, []extraSection{
		{"reconcile_full", cfg.ScanTimeout, func(ctx context.Context) (err error) {
			ex.Reconcile, err = RunReconcileFull(ctx, pool, g)
			return err
		}},
		{"flip_cost_scan", cfg.ScanTimeout, func(ctx context.Context) (err error) {
			ex.FlipCost, err = RunFlipCostScan(ctx, pool, g)
			return err
		}},
		{"lexical_plan", cfg.ShortTimeout, func(ctx context.Context) (err error) {
			ex.LexicalPlan, err = RunLexicalPlan(ctx, dsn, sr, classes, cfg)
			return err
		}},
		{"connect_probe", cfg.ShortTimeout, func(ctx context.Context) (err error) {
			ex.ConnectProbe, err = RunConnectProbe(ctx, dsn, sr, classes, cfg)
			return err
		}},
	}, logf)...)
	return ex
}

// extraSectionNames are the sections of RunExtras, in run order.
var extraSectionNames = []string{"reconcile_full", "flip_cost_scan", "lexical_plan", "connect_probe"}

func skippedBudget(section string) string { return section + ": " + skippedBudgetTag }

// extraSection is one timed extra.
type extraSection struct {
	name    string
	timeout time.Duration
	fn      func(ctx context.Context) error
}

// runExtraSections runs the sections in order, each under its own timeout and the
// shared ctx (which carries the total budget). A section that fails is recorded by
// class tag and the rest still run; a section that has not started when ctx is done
// is recorded as "<section>: skipped_budget" and not run. It returns the tags.
func runExtraSections(ctx context.Context, secs []extraSection, logf func(string, ...any)) []string {
	var errs []string
	for _, s := range secs {
		if ctx.Err() != nil {
			logf("task23 extra %s skipped: no budget left", s.name)
			errs = append(errs, skippedBudget(s.name))
			continue
		}
		sctx, cancel := context.WithTimeout(ctx, s.timeout)
		t0 := time.Now()
		err := s.fn(sctx)
		cancel()
		if err != nil {
			logf("task23 extra %s failed: %s", s.name, errTag(err))
			errs = append(errs, s.name+": "+errTag(err))
			continue
		}
		logf("task23 extra %s done in %.1fs", s.name, time.Since(t0).Seconds())
	}
	return errs
}

// ---- 4. Reconcile full time --------------------------------------------------

// ReconcileTiming is one timed dry-run Reconcile of g1.
type ReconcileTiming struct {
	Ms     float64          `json:"ms"`
	Mode   string           `json:"mode"`
	Scope  string           `json:"scope"`
	Result reconcile.Result `json:"result"`
	Note   string           `json:"note"`
}

// RunReconcileFull times reconcile.Reconcile(g1, scope all, ModeDryRun, nil) once:
// zero writes (the dry run never enqueues). The seed's input hashes are not the
// production InputHashFor values, so every row counts as stale in the result; the
// scan work (keyset pages, hashing, comparison) is the same as for a real run.
func RunReconcileFull(ctx context.Context, pool *pgxpool.Pool, g generation.Generation) (*ReconcileTiming, error) {
	t0 := time.Now()
	res, err := reconcile.Reconcile(ctx, pool, g, reconcile.All(), reconcile.ModeDryRun, nil)
	elapsed := time.Since(t0)
	if err != nil {
		return nil, err
	}
	if res.StopReason != "" {
		// A reconcile that stopped early did not scan the full keyset: not a full time.
		return nil, fmt.Errorf("searchbench: reconcile stopped early (%s)", res.StopReason)
	}
	return &ReconcileTiming{
		Ms: ms(elapsed), Mode: reconcile.ModeDryRun.String(), Scope: "all", Result: res,
		Note: "Dry run, zero writes. The seeded input_hash values are synthetic (not embedding.InputHashFor), so the result counts every row as stale/would_enqueue; the timing is the full keyset pass.",
	}, nil
}

// ---- 3. FU-T19-FLIPCOST ----------------------------------------------------------

// coverageGap is the kind of coverage gap coverageInTx would stop at.
type coverageGap int

const (
	gapNone coverageGap = iota
	gapMissingVector
	gapHashMismatch
	gapModelMismatch
)

// classifyCoverage replicates the per-row test of lifecycle.coverageInTx (the same
// input helpers and the same hash/model/model_version comparison) but names the
// kind of gap instead of returning at the first one.
func classifyCoverage(row store.ScanTargetRow, corpus generation.Corpus, ident embedid.Identity, g generation.Generation) coverageGap {
	var input string
	if corpus == generation.CorpusItem {
		var hint string
		if row.Hint != nil {
			hint = *row.Hint
		}
		input = embedding.ItemInput(row.Name, hint)
	} else {
		input = embedding.TagInput(row.Display)
	}
	want := embedding.InputHashFor(ident, input)
	switch {
	case !row.HasVector():
		return gapMissingVector
	case !bytes.Equal(row.InputHash, want[:]):
		return gapHashMismatch
	case row.Model != g.Model || row.ModelVersion != g.ModelVersion:
		return gapModelMismatch
	}
	return gapNone
}

// FlipCorpusScan is the scan of one corpus.
type FlipCorpusScan struct {
	Corpus            string  `json:"corpus"`
	Pages             int     `json:"pages"`
	Rows              int     `json:"rows"`
	Gaps              int     `json:"gaps"`
	GapsMissingVector int     `json:"gaps_missing_vector"`
	GapsHashMismatch  int     `json:"gaps_hash_mismatch"`
	GapsModelMismatch int     `json:"gaps_model_mismatch"`
	ScanMs            float64 `json:"scan_ms"`
	OrphanProbeMs     float64 `json:"orphan_probe_ms"`
	OrphansFound      int     `json:"orphans_found"`
}

// FlipCostReport is the full in-lock coverage pass of flip/rollback.
type FlipCostReport struct {
	TotalMs   float64          `json:"total_ms"`
	PageSize  int              `json:"page_size"`
	Pages     int              `json:"pages"`
	Rows      int              `json:"rows"`
	Gaps      int              `json:"gaps"`
	Corpora   []FlipCorpusScan `json:"corpora"`
	Isolation string           `json:"isolation"`
	Note      string           `json:"note"`
}

// RunFlipCostScan replicates lifecycle.coverageInTx's read pattern, read-only, in
// one REPEATABLE READ read-only transaction on g: per corpus the ScanStale keyset
// pages with store.MaxScanLimit and one ScanOrphans(limit 1). Unlike coverageInTx
// it does NOT stop at the first gap: it scans the whole keyset and counts gaps, so
// the time is the worst case a flip/rollback holds the EXCLUSIVE generation lock
// for. It takes no advisory lock and never calls lifecycle.Flip.
func RunFlipCostScan(ctx context.Context, pool *pgxpool.Pool, g generation.Generation) (*FlipCostReport, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	ident := g.Identity()
	rep := &FlipCostReport{PageSize: store.MaxScanLimit, Isolation: "REPEATABLE READ, READ ONLY"}
	t0 := time.Now()
	for _, corpus := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		sc := FlipCorpusScan{Corpus: string(corpus)}
		tc := time.Now()
		var cursor *store.ScanCursor
		for {
			page, err := store.ScanStale(ctx, tx, g, corpus, cursor, nil, store.MaxScanLimit)
			if err != nil {
				return nil, err
			}
			sc.Pages++
			sc.Rows += len(page)
			for _, row := range page {
				switch classifyCoverage(row, corpus, ident, g) {
				case gapMissingVector:
					sc.GapsMissingVector++
				case gapHashMismatch:
					sc.GapsHashMismatch++
				case gapModelMismatch:
					sc.GapsModelMismatch++
				}
			}
			if len(page) < store.MaxScanLimit {
				break
			}
			last := page[len(page)-1]
			cursor = &store.ScanCursor{UserID: last.UserID, TargetID: last.TargetID}
		}
		sc.Gaps = sc.GapsMissingVector + sc.GapsHashMismatch + sc.GapsModelMismatch
		sc.ScanMs = ms(time.Since(tc))
		to := time.Now()
		orphans, err := store.ScanOrphans(ctx, tx, g, corpus, nil, nil, 1)
		if err != nil {
			return nil, err
		}
		sc.OrphanProbeMs = ms(time.Since(to))
		sc.OrphansFound = len(orphans)
		rep.Corpora = append(rep.Corpora, sc)
		rep.Pages += sc.Pages
		rep.Rows += sc.Rows
		rep.Gaps += sc.Gaps
	}
	rep.TotalMs = ms(time.Since(t0))
	rep.Note = "Worst case of the exclusive section: every page of both corpora plus the orphan probe, no early return at the first gap. " +
		"Seeded input_hash values are synthetic (sha256 of the id), not embedding.InputHashFor, so gaps > 0 is expected here; the timing is what matters. " +
		"The openai_compat user-off EXISTS scan is not run (g1 is a tei generation). No advisory lock taken, lifecycle.Flip never called."
	return rep, nil
}

// ---- 2. FU-SL-1 lexical plan at real volume ----------------------------------------

// planQueryShapes are the two lexical SQL shapes the server runs: `prefix` is
// suggest mode "prefix" (a 1-rune query, fuzzy=false, no trigram arm) and `fuzzy`
// is mode "full" (>= 2 runes, fuzzy=true, the production shape of nearly every
// query: both prefix arms plus the trigram % / <% arms).
const (
	shapePrefix = "prefix"
	shapeFuzzy  = "fuzzy"
)

// LexPlanCase is one representative query. QN is never written to a report.
type LexPlanCase struct {
	ID     string // class/corpus/shape/qN
	Class  string
	Tenant int
	Corpus generation.Corpus
	Shape  string
	Fuzzy  bool
	QN     string
}

// lexicalNameAt returns the normalized name of item/tag idx of a tenant.
func lexicalNameAt(g *Generator, tenant int, corpus generation.Corpus, idx int) string {
	if corpus == generation.CorpusTag {
		return g.TagAt(tenant, idx).Normalized
	}
	return g.ItemAt(tenant, idx).NameNormalized
}

func lexicalCount(spec ProfileSpec, tenant int, corpus generation.Corpus) int {
	if corpus == generation.CorpusTag {
		return spec.Tenants[tenant].TagCount
	}
	return spec.Tenants[tenant].ItemCount
}

// lexicalPlanQueries derives n deterministic synthetic normalized queries for one
// (tenant, corpus, shape) from the dataset's own names. prefix: n distinct
// single-rune queries (first letters of sampled names). fuzzy: queries of >= 3
// runes cycling the dataset's three variants (name prefix, folded word, typo),
// all distinct.
func lexicalPlanQueries(g *Generator, tenant int, corpus generation.Corpus, shape string, n int) []string {
	spec := g.Profile()
	count := lexicalCount(spec, tenant, corpus)
	if count <= 0 || n <= 0 {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	add := func(qn string) {
		if qn != "" && !seen[qn] {
			seen[qn] = true
			out = append(out, qn)
		}
	}
	const maxDraws = 2000
	for i := 0; i < maxDraws && len(out) < n; i++ {
		name := lexicalNameAt(g, tenant, corpus, pickIdx(g.Seed(), 21, tenant, i, count))
		if shape == shapePrefix {
			if r := []rune(name); len(r) > 0 {
				if qn := qnOf(string(r[0])); len([]rune(qn)) == 1 {
					add(qn)
				}
			}
			continue
		}
		variant := []string{"prefix", "folded", "typo"}[len(out)%3]
		qn := qnOf(lexicalText(variant, name, i, g.Seed(), tenant))
		if len([]rune(qn)) >= 3 {
			add(qn)
		}
	}
	return out
}

// planCases builds the cases of the given (class, tenant) pairs.
func planCases(g *Generator, tenants []planTenant, perShape int) []LexPlanCase {
	var out []LexPlanCase
	for _, t := range tenants {
		for _, corpus := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
			for _, shape := range []string{shapePrefix, shapeFuzzy} {
				for k, qn := range lexicalPlanQueries(g, t.Index, corpus, shape, perShape) {
					out = append(out, LexPlanCase{
						ID:    fmt.Sprintf("%s/%s/%s/q%d", t.Class, corpus, shape, k+1),
						Class: t.Class, Tenant: t.Index, Corpus: corpus, Shape: shape, Fuzzy: shape == shapeFuzzy, QN: qn,
					})
				}
			}
		}
	}
	return out
}

// planTenant is a tenant chosen for the plan evidence.
type planTenant struct {
	Class string
	Index int
}

// planTenantsOf picks the whale tenant and, when wanted, the median-size medium
// tenant (by item count, ties by index) of the classes that were seeded.
func planTenantsOf(spec ProfileSpec, classes map[TenantClass][]int, withMedium bool) []planTenant {
	var out []planTenant
	if w := classes[ClassWhale]; len(w) > 0 {
		out = append(out, planTenant{Class: string(ClassWhale), Index: w[0]})
	}
	if withMedium {
		if m := medianByItems(spec, classes[ClassMedium]); m >= 0 {
			out = append(out, planTenant{Class: string(ClassMedium), Index: m})
		}
	}
	return out
}

// medianByItems returns the tenant at the median of ts ordered by (items, index),
// or -1 when ts is empty.
func medianByItems(spec ProfileSpec, ts []int) int {
	if len(ts) == 0 {
		return -1
	}
	s := append([]int(nil), ts...)
	sort.Slice(s, func(i, j int) bool {
		a, b := spec.Tenants[s[i]], spec.Tenants[s[j]]
		if a.ItemCount != b.ItemCount {
			return a.ItemCount < b.ItemCount
		}
		return s[i] < s[j]
	})
	return s[len(s)/2]
}

// sqlCapture is a gen.DBTX that records the statement and arguments of the one
// sqlc query it is given and refuses to run it, so the harness EXPLAINs exactly the
// SQL and parameter shapes the server sends (gen.Queries.SearchItemsLexical /
// SearchTagsLexical), never a hand-copied statement.
type sqlCapture struct {
	sql  string
	args []any
}

var errCaptured = errors.New("searchbench: statement captured, not executed")

func (c *sqlCapture) Exec(_ context.Context, sql string, args ...interface{}) (pgconn.CommandTag, error) {
	c.sql, c.args = sql, args
	return pgconn.CommandTag{}, errCaptured
}

func (c *sqlCapture) Query(_ context.Context, sql string, args ...interface{}) (pgx.Rows, error) {
	c.sql, c.args = sql, args
	return nil, errCaptured
}

func (c *sqlCapture) QueryRow(_ context.Context, sql string, args ...interface{}) pgx.Row {
	c.sql, c.args = sql, args
	return capturedRow{}
}

type capturedRow struct{}

func (capturedRow) Scan(...any) error { return errCaptured }

// lexicalLimit is the fetch limit of the default `/suggest` scope=all, limit=8 request:
// the corpus cap + 1 (plan 2.3).
func lexicalLimit() int32 {
	tagCap, itemCap := suggest.CorpusQueryCaps(suggest.ScopeAll, suggest.DefaultSuggestLimit, suggest.ModeFull)
	return int32(max(tagCap, itemCap) + 1)
}

// captureLexicalSQL returns the exact SQL and arguments the server runs for c.
func captureLexicalSQL(ctx context.Context, c LexPlanCase, userID uuid.UUID, limit int32) (string, []any, error) {
	cap := &sqlCapture{}
	q := gen.New(cap)
	var err error
	if c.Corpus == generation.CorpusTag {
		_, err = q.SearchTagsLexical(ctx, gen.SearchTagsLexicalParams{
			UserID: userID, Qn: c.QN, QPrefix: item.EscapeLikePrefix(c.QN), Fuzzy: c.Fuzzy, PageLimit: limit,
		})
	} else {
		_, err = q.SearchItemsLexical(ctx, gen.SearchItemsLexicalParams{
			UserID: userID, Qn: c.QN, QPrefix: item.EscapeLikePrefix(c.QN), Fuzzy: c.Fuzzy, PageLimit: limit,
		})
	}
	if !errors.Is(err, errCaptured) || cap.sql == "" {
		return "", nil, errors.New("searchbench: could not capture the lexical SQL")
	}
	return cap.sql, cap.args, nil
}

// lexicalThresholdSQL are the transaction-local settings of the server's lexical
// branch (suggest.configureLexicalTx) except the statement timeout, which the
// plan evidence replaces with a harness bound so a slow plan still completes and
// is measured instead of being cancelled at 50 ms.
var lexicalThresholdSQL = []string{
	`SET LOCAL pg_trgm.similarity_threshold = 0.35`,
	`SET LOCAL pg_trgm.word_similarity_threshold = 0.5`,
	`SET LOCAL plan_cache_mode = force_custom_plan`,
}

// LexPlanRow is the plan evidence of one case.
type LexPlanRow struct {
	ID        string       `json:"case"`
	Class     string       `json:"tenant_class"`
	Corpus    string       `json:"corpus"`
	Shape     string       `json:"shape"`
	Default   LexPlanInfo  `json:"default_planner"`
	After0010 *LexPlanInfo `json:"after_0010_simulated,omitempty"`
	// DefaultGeneric / After0010Generic are the same statement planned as a GENERIC
	// plan (PREPARE + plan_cache_mode=force_generic_plan, EXPLAIN EXECUTE): the plan a
	// pgx-prepared server statement can switch to after 5 executions. Nil when that
	// EXPLAIN failed (see LexPlanReport.GenericErrors).
	DefaultGeneric   *LexPlanInfo `json:"default_generic_plan,omitempty"`
	After0010Generic *LexPlanInfo `json:"after_0010_generic_plan,omitempty"`
}

// LexPlanTenant describes a tenant the plan evidence ran on.
type LexPlanTenant struct {
	Class string `json:"class"`
	Items int    `json:"items"`
	Tags  int    `json:"tags"`
}

// LexPlanReport is the FU-SL-1 section.
type LexPlanReport struct {
	Tenants             []LexPlanTenant `json:"tenants"`
	FetchLimit          int32           `json:"fetch_limit"`
	ServerPlanCacheMode string          `json:"server_plan_cache_mode,omitempty"`
	Rows                []LexPlanRow    `json:"rows"`
	IndexesRestored     bool            `json:"global_trgm_indexes_restored_after_rollback"`
	// GenericErrors lists the generic-plan EXPLAINs that failed, as class tags only.
	GenericErrors []string `json:"generic_plan_errors,omitempty"`
	Notes         []string `json:"notes"`
}

const explainPrefix = "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "

// explainLexical runs EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) of sql twice inside
// tx: a discarded warm-up and the measured run, so the figures are warm like the
// load cells. The parameter values are bound, so the planner sees them as
// constants (a custom plan).
func explainLexical(ctx context.Context, tx pgx.Tx, sql string, args []any) (LexPlanInfo, error) {
	stmt := explainPrefix + sql
	var raw string
	for range 2 {
		raw = ""
		if err := tx.QueryRow(ctx, stmt, args...).Scan(&raw); err != nil {
			return LexPlanInfo{}, err
		}
	}
	return ParseLexicalPlan([]byte(raw))
}

// genericStmtName is the name of the i-th prepared statement of the generic-plan
// EXPLAINs (a fixed pattern, never derived from data).
func genericStmtName(i int) string { return "lexplan_" + strconv.Itoa(i) }

// prepareLexicalSQL is the PREPARE of a captured sqlc statement under name.
func prepareLexicalSQL(name, sql string) string { return "PREPARE " + name + " AS " + sql }

// explainExecuteSQL is the EXPLAIN of EXECUTE name with nargs placeholders ($1..$n).
func explainExecuteSQL(name string, nargs int) string {
	ph := make([]string, nargs)
	for i := range ph {
		ph[i] = "$" + strconv.Itoa(i+1)
	}
	return explainPrefix + "EXECUTE " + name + "(" + strings.Join(ph, ", ") + ")"
}

// simpleProtocolArgs makes the captured arguments safe for pgx's client-side
// (simple protocol) interpolation: a uuid becomes its text form; the string, bool
// and int32 arguments of the lexical statements are interpolated as they are.
func simpleProtocolArgs(args []any) []any {
	out := make([]any, len(args))
	for i, a := range args {
		if u, ok := a.(uuid.UUID); ok {
			out[i] = u.String()
			continue
		}
		out[i] = a
	}
	return out
}

// explainLexicalGeneric plans sql as a GENERIC plan: PREPARE, then EXPLAIN (ANALYZE,
// BUFFERS, FORMAT JSON) EXECUTE under plan_cache_mode=force_generic_plan (set by the
// caller with SET LOCAL), twice (warm-up + measured). The statement is deallocated
// before returning. The EXECUTE arguments go through the simple protocol so the
// EXPLAIN is an ordinary text statement; the values are the synthetic ones of the case.
func explainLexicalGeneric(ctx context.Context, tx pgx.Tx, name, sql string, args []any) (LexPlanInfo, error) {
	if _, err := tx.Exec(ctx, prepareLexicalSQL(name, sql)); err != nil {
		return LexPlanInfo{}, err
	}
	stmt := explainExecuteSQL(name, len(args))
	qargs := append([]any{pgx.QueryExecModeSimpleProtocol}, simpleProtocolArgs(args)...)
	var raw string
	for range 2 {
		raw = ""
		if err := tx.QueryRow(ctx, stmt, qargs...).Scan(&raw); err != nil {
			return LexPlanInfo{}, err
		}
	}
	if _, err := tx.Exec(ctx, "DEALLOCATE "+name); err != nil {
		return LexPlanInfo{}, err
	}
	return ParseLexicalPlan([]byte(raw))
}

// lexExplained is the plan evidence of all cases inside one transaction.
type lexExplained struct {
	custom  []LexPlanInfo
	generic []LexPlanInfo // nil when the generic EXPLAIN failed
	// genericErr is why generic is nil; it never discards the custom evidence.
	genericErr error
}

// explainAllCases runs the custom-plan EXPLAIN of every case, then (in the same
// EXPLAIN-only transaction, after SET LOCAL plan_cache_mode = force_generic_plan,
// which never touches a measured pool) the generic-plan EXPLAIN of every case. A
// failure of the custom part is an error; a failure of the generic part is kept in
// genericErr (the transaction may be aborted by then, so nothing else runs in it).
func explainAllCases(ctx context.Context, tx pgx.Tx, cases []LexPlanCase, userOf func(int) uuid.UUID, limit int32) (lexExplained, error) {
	res := lexExplained{custom: make([]LexPlanInfo, 0, len(cases))}
	sqls := make([]string, len(cases))
	argv := make([][]any, len(cases))
	for i, c := range cases {
		sql, args, err := captureLexicalSQL(ctx, c, userOf(c.Tenant), limit)
		if err != nil {
			return lexExplained{}, err
		}
		sqls[i], argv[i] = sql, args
		info, err := explainLexical(ctx, tx, sql, args)
		if err != nil {
			return lexExplained{}, err
		}
		res.custom = append(res.custom, info)
	}
	if _, err := tx.Exec(ctx, `SET LOCAL plan_cache_mode = force_generic_plan`); err != nil {
		res.genericErr = err
		return res, nil
	}
	generic := make([]LexPlanInfo, 0, len(cases))
	for i := range cases {
		info, err := explainLexicalGeneric(ctx, tx, genericStmtName(i+1), sqls[i], argv[i])
		if err != nil {
			res.genericErr = err
			return res, nil
		}
		generic = append(generic, info)
	}
	res.generic = generic
	return res, nil
}

// dropGenericStatements deallocates the generic-plan statements after a failed
// transaction (PREPARE is not rolled back with it). Best effort: a statement that
// does not exist is ignored. Only the fixed lexplan_<i> names are touched, never
// pgx's own statement cache.
func dropGenericStatements(conn *pgx.Conn, n int) {
	for i := 1; i <= n; i++ {
		_, _ = conn.Exec(context.Background(), "DEALLOCATE "+genericStmtName(i))
	}
}

// RunLexicalPlan records, per case, the plan of the exact lexical SQL on the
// DEFAULT planner (no enable_* setting), then the same cases with the two global
// trigram indexes dropped inside a transaction that is rolled back ("after 0010,
// simulated", as TestLexicalIndexesUsed does). The DROP INDEX takes ACCESS
// EXCLUSIVE on item/tag until the rollback: this runs in the quiet phase on its
// own connection, never with load.
func RunLexicalPlan(ctx context.Context, dsn string, sr *SeedResult, classes map[TenantClass][]int, cfg ExtrasConfig) (*LexPlanReport, error) {
	spec := sr.Spec
	tenants := planTenantsOf(spec, classes, cfg.PlanMedium)
	if len(tenants) == 0 {
		return nil, errors.New("searchbench: no tenant for the lexical plan evidence")
	}
	cases := planCases(sr.Gen, tenants, cfg.PlanQueries)
	if len(cases) == 0 {
		return nil, errors.New("searchbench: no lexical plan case")
	}
	limit := lexicalLimit()
	userOf := func(t int) uuid.UUID { return spec.Tenants[t].UserID }

	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close(context.Background()) }()

	rep := &LexPlanReport{FetchLimit: limit, ServerPlanCacheMode: "force_custom_plan"}
	for _, t := range tenants {
		rep.Tenants = append(rep.Tenants, LexPlanTenant{Class: t.Class, Items: spec.Tenants[t.Index].ItemCount, Tags: spec.Tenants[t.Index].TagCount})
	}
	setup := func(ctx context.Context, tx pgx.Tx) error {
		for _, s := range append([]string{`SET LOCAL statement_timeout = '` + cfg.PlanStatement + `'`}, lexicalThresholdSQL...) {
			if _, err := tx.Exec(ctx, s); err != nil {
				return err
			}
		}
		return nil
	}

	// Default planner.
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	var def lexExplained
	err = setup(ctx, tx)
	if err == nil {
		def, err = explainAllCases(ctx, tx, cases, userOf, limit)
	}
	_ = tx.Rollback(context.Background())
	if err != nil || def.genericErr != nil {
		dropGenericStatements(conn, len(cases))
	}
	if err != nil {
		return nil, err
	}

	// Simulated 0010: DROP INDEX in a transaction that is rolled back.
	sim, err := conn.Begin(ctx)
	if err != nil {
		return nil, err
	}
	var after lexExplained
	err = func() error {
		if _, err := sim.Exec(ctx, `SET LOCAL lock_timeout = '30s'`); err != nil {
			return err
		}
		if _, err := sim.Exec(ctx, `DROP INDEX item_name_trgm, tag_norm_trgm`); err != nil {
			return err
		}
		if err := setup(ctx, sim); err != nil {
			return err
		}
		var err error
		after, err = explainAllCases(ctx, sim, cases, userOf, limit)
		return err
	}()
	rbErr := sim.Rollback(context.Background())
	if err != nil || after.genericErr != nil {
		dropGenericStatements(conn, len(cases))
	}
	if err != nil {
		return nil, err
	}
	if rbErr != nil {
		return nil, rbErr
	}
	var present int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE indexname IN ('item_name_trgm', 'tag_norm_trgm')`).Scan(&present); err != nil {
		return nil, err
	}
	rep.IndexesRestored = present == 2
	if !rep.IndexesRestored {
		return nil, errors.New("searchbench: the global trigram indexes are missing after the simulation rollback")
	}

	if def.genericErr != nil {
		rep.GenericErrors = append(rep.GenericErrors, "default: "+errTag(def.genericErr))
	}
	if after.genericErr != nil {
		rep.GenericErrors = append(rep.GenericErrors, "after_0010_simulated: "+errTag(after.genericErr))
	}
	for i, c := range cases {
		a := after.custom[i]
		row := LexPlanRow{ID: c.ID, Class: c.Class, Corpus: string(c.Corpus), Shape: c.Shape, Default: def.custom[i], After0010: &a}
		if def.generic != nil {
			g := def.generic[i]
			row.DefaultGeneric = &g
		}
		if after.generic != nil {
			g := after.generic[i]
			row.After0010Generic = &g
		}
		rep.Rows = append(rep.Rows, row)
	}
	rep.Notes = []string{
		"The SQL is the exact statement of gen.Queries.SearchItemsLexical / SearchTagsLexical captured from sqlc, with the server's parameter shapes (qn, escaped prefix, fuzzy flag, LIMIT = corpus cap + 1 of /suggest scope=all limit=8), the server's pg_trgm thresholds, and server setting: force_custom_plan (SET LOCAL plan_cache_mode = force_custom_plan inside the lexical read tx).",
		"Planner: Postgres defaults, no enable_* setting. The first table is a custom plan (EXPLAIN binds the parameter values; server setting: force_custom_plan, which is the plan the server actually executes). Under plan_cache_mode=auto a pgx-prepared statement can switch to a generic plan after 5 executions, so each case is also planned as a generic plan (second table): PREPARE, SET LOCAL plan_cache_mode = force_generic_plan inside the EXPLAIN-only transaction, EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE, DEALLOCATE. The setting is never applied to a measured pool.",
		"Each case runs EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) twice and keeps the second (warm) run; statement_timeout is " + cfg.PlanStatement + " (harness bound), not the server's 50 ms, so a slow plan still completes.",
		"prefix = suggest mode prefix (1-rune query, fuzzy=false). fuzzy = mode full (>= 3-rune synthetic query: name prefix, folded word, typo; fuzzy=true), the shape of nearly every production query.",
		"after 0010 (simulated): item_name_trgm and tag_norm_trgm dropped inside a transaction that was rolled back (verified restored); nothing persisted.",
		"Case ids only: query strings are never printed. Tenant classes are described in the table above; the medium tenant is the median-size tenant of the medium class.",
	}
	return rep, nil
}

// ---- 1d. connect-cost probe ---------------------------------------------------------

// ConnectProbeShape is the connect-cost probe of one query shape.
type ConnectProbeShape struct {
	Shape          string  `json:"shape"`
	N              int     `json:"n"`
	Connect        MsStats `json:"connect_ms"`
	Setup          MsStats `json:"begin_set_local_ms"`
	First          MsStats `json:"first_query_ms"`
	Second         MsStats `json:"second_query_ms"`
	FirstTimeouts  int     `json:"first_query_timeouts_50ms"`
	SecondTimeouts int     `json:"second_query_timeouts_50ms"`
}

// ConnectProbeReport is the FU-SB-2b warm-up evidence (not part of any target).
type ConnectProbeReport struct {
	N      int                 `json:"n_per_shape"`
	Shapes []ConnectProbeShape `json:"shapes"`
	Notes  []string            `json:"notes"`
}

func durMsStats(d []time.Duration) MsStats {
	st := Summarize(d, 0)
	return MsStats{P50Ms: st.P50Ms, P95Ms: st.P95Ms, MaxMs: st.MaxMs}
}

func isStatementTimeout(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "57014"
}

// probeLexicalQuery runs one lexical item query on conn the way a branch does:
// BEGIN READ ONLY, the three SET LOCALs of the server (50 ms statement timeout,
// both trigram thresholds), then the sqlc query. It returns the BEGIN+SET LOCAL
// time and the query time; a statement timeout is reported, not an error.
func probeLexicalQuery(ctx context.Context, conn *pgxpool.Conn, c LexPlanCase, userID uuid.UUID, limit int32) (setup, query time.Duration, timedOut bool, err error) {
	t0 := time.Now()
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return 0, 0, false, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	for _, s := range append([]string{`SET LOCAL statement_timeout = '50ms'`}, lexicalThresholdSQL...) {
		if _, err := tx.Exec(ctx, s); err != nil {
			return 0, 0, false, err
		}
	}
	setup = time.Since(t0)
	t1 := time.Now()
	_, qerr := gen.New(tx).SearchItemsLexical(ctx, gen.SearchItemsLexicalParams{
		UserID: userID, Qn: c.QN, QPrefix: item.EscapeLikePrefix(c.QN), Fuzzy: c.Fuzzy, PageLimit: limit,
	})
	query = time.Since(t1)
	if qerr != nil {
		if isStatementTimeout(qerr) {
			return setup, query, true, nil
		}
		return setup, query, false, qerr
	}
	return setup, query, false, nil
}

// probeShapes lists the (name, tenant, shape) probed: whale prefix, whale fuzzy
// and, in full, a medium tenant's fuzzy shape.
func probeShapes(spec ProfileSpec, classes map[TenantClass][]int, withMedium bool) []planTenantShape {
	var out []planTenantShape
	if w := classes[ClassWhale]; len(w) > 0 {
		out = append(out, planTenantShape{"whale_prefix", string(ClassWhale), w[0], shapePrefix}, planTenantShape{"whale_fuzzy", string(ClassWhale), w[0], shapeFuzzy})
	}
	if withMedium {
		if m := medianByItems(spec, classes[ClassMedium]); m >= 0 {
			out = append(out, planTenantShape{"medium_fuzzy", string(ClassMedium), m, shapeFuzzy})
		}
	}
	return out
}

type planTenantShape struct {
	Name, Class string
	Tenant      int
	Shape       string
}

// RunConnectProbe measures, on a FRESH pool per iteration (never the measured
// pool), the cost of a new backend: pgxpool connect (Acquire dials), then the first
// lexical item query on that backend and the second identical one on the same
// backend. N iterations per shape; each iteration closes its pool, so the next
// connect is a new backend with cold caches. Not part of any target; it feeds the
// warm-up decision of FU-SB-2b.
func RunConnectProbe(ctx context.Context, dsn string, sr *SeedResult, classes map[TenantClass][]int, cfg ExtrasConfig) (*ConnectProbeReport, error) {
	spec := sr.Spec
	shapes := probeShapes(spec, classes, cfg.ProbeMedium)
	if len(shapes) == 0 {
		return nil, errors.New("searchbench: no tenant for the connect probe")
	}
	limit := lexicalLimit()
	rep := &ConnectProbeReport{N: cfg.ProbeN}
	for _, sh := range shapes {
		qs := lexicalPlanQueries(sr.Gen, sh.Tenant, generation.CorpusItem, sh.Shape, max(3, cfg.PlanQueries))
		if len(qs) == 0 {
			return nil, fmt.Errorf("searchbench: no probe query for shape %s", sh.Name)
		}
		var connect, setup, first, second []time.Duration
		out := ConnectProbeShape{Shape: sh.Name, N: cfg.ProbeN}
		for i := range cfg.ProbeN {
			c := LexPlanCase{Tenant: sh.Tenant, Corpus: generation.CorpusItem, Shape: sh.Shape, Fuzzy: sh.Shape == shapeFuzzy, QN: qs[i%len(qs)]}
			pc, err := pgxpool.ParseConfig(dsn)
			if err != nil {
				return nil, err
			}
			pc.MaxConns, pc.MinConns = 1, 0
			pool, err := pgxpool.NewWithConfig(ctx, pc)
			if err != nil {
				return nil, err
			}
			err = func() error {
				defer pool.Close()
				t0 := time.Now()
				conn, err := pool.Acquire(ctx)
				if err != nil {
					return err
				}
				connect = append(connect, time.Since(t0))
				defer conn.Release()
				s1, q1, to1, err := probeLexicalQuery(ctx, conn, c, spec.Tenants[sh.Tenant].UserID, limit)
				if err != nil {
					return err
				}
				s2, q2, to2, err := probeLexicalQuery(ctx, conn, c, spec.Tenants[sh.Tenant].UserID, limit)
				if err != nil {
					return err
				}
				setup = append(setup, s1)
				first = append(first, q1)
				second = append(second, q2)
				_ = s2
				if to1 {
					out.FirstTimeouts++
				}
				if to2 {
					out.SecondTimeouts++
				}
				return nil
			}()
			if err != nil {
				return nil, err
			}
		}
		out.Connect, out.Setup, out.First, out.Second = durMsStats(connect), durMsStats(setup), durMsStats(first), durMsStats(second)
		rep.Shapes = append(rep.Shapes, out)
	}
	rep.Notes = []string{
		"Each iteration opens a fresh single-connection pool (not the measured pool), so every connect is a NEW backend with cold relation/plan caches; the first and second queries run on that same backend.",
		"connect = pgxpool Acquire of the new backend (dial + handshake); begin_set_local = BEGIN READ ONLY + the server's four SET LOCALs of the first query (50 ms statement_timeout, both pg_trgm thresholds, plan_cache_mode = force_custom_plan); first/second query = the sqlc item query with the server's 50 ms statement_timeout (a timeout is counted, its elapsed time is kept).",
		"Shapes: whale_prefix = mode prefix (1-rune, fuzzy=false) on the whale tenant, whale_fuzzy = mode full (fuzzy=true) on the whale tenant, medium_fuzzy = mode full on the median medium tenant (full profile only). Queries cycle the 3 representative synthetic queries of the shape; the same query is used for the first and second run of an iteration.",
		"Not part of any target. Input to the FU-SB-2b warm-up decision: a first-query p95 far above the second-query p95 is the cold-backend planning cost.",
	}
	return rep, nil
}

// ---- Task 23 summary -------------------------------------------------------------------

// SummaryRow is one line of the Task 23 full-volume timing summary.
type SummaryRow struct{ Metric, Value string }

// Task23SummaryRows lists the full-volume timings the plan's Task 23 asks for in one
// place: the per-partition HNSW build (already measured at seed time) next to the
// Reconcile full time and the in-lock coverage scan.
func Task23SummaryRows(r *Report) []SummaryRow {
	var rows []SummaryRow
	if r.Seed != nil && len(r.Seed.HNSW) > 0 {
		var slow HNSWBuild
		var total float64
		for _, b := range r.Seed.HNSW {
			total += b.Seconds
			if b.Seconds > slow.Seconds {
				slow = b
			}
		}
		rows = append(rows, SummaryRow{
			"HNSW build per partition",
			fmt.Sprintf("%d partition builds, sum %.1f s (item %.1f s, tag %.1f s), slowest %s/%s %.2f s over %d rows; per-partition table under \"Dataset, sizes and build times\"",
				len(r.Seed.HNSW), total, r.Seed.Timings.HNSWItem, r.Seed.Timings.HNSWTag, slow.Corpus, slow.Part, slow.Seconds, slow.Rows),
		})
	}
	if ex := r.Extras; ex != nil {
		if f := ex.FlipCost; f != nil {
			parts := make([]string, 0, len(f.Corpora))
			for _, c := range f.Corpora {
				parts = append(parts, fmt.Sprintf("%s %d rows / %d pages / %.0f ms / %d gaps", c.Corpus, c.Rows, c.Pages, c.ScanMs, c.Gaps))
			}
			rows = append(rows, SummaryRow{
				"Flip/rollback in-lock coverage scan (FU-T19-FLIPCOST), full pass",
				fmt.Sprintf("%.0f ms total, %d pages of %d, %d rows, %d gaps (%s)", f.TotalMs, f.Pages, f.PageSize, f.Rows, f.Gaps, strings.Join(parts, "; ")),
			})
		}
		if rc := ex.Reconcile; rc != nil {
			rows = append(rows, SummaryRow{
				"Reconcile full time (g1, scope all, dry run)",
				fmt.Sprintf("%.0f ms, scanned %d, would_enqueue %d, would_delete_orphan %d, would_delete_user_off %d", rc.Ms, rc.Result.Scanned, rc.Result.WouldEnqueue, rc.Result.WouldDeleteOrphan, rc.Result.WouldDeleteUserOff),
			})
		}
		for _, e := range ex.Errors {
			rows = append(rows, SummaryRow{"FAILED extra", e})
		}
	}
	return rows
}
