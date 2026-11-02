package main

import (
	"bytes"
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedtest"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

// Secret-looking values that must never be echoed by `reembed generation`.
const (
	genSecretKey = "sk-live-Zq9f3AbCdEf1234567890"
	genSecretURL = "https://admin:Zq-pw-5521@provider.internal.example/v1"
)

// genTestConfig builds a deployment config whose primary and shadow clients are
// two fake TEI servers with different model revisions (so their identities
// differ). Semantic search is on, calibration is NOT overridden here.
func genTestConfig(t *testing.T, dsn string) *config.Config {
	t.Helper()
	primary := embedtest.NewServer(embedtest.Options{Dims: 8, ModelSHA: "rev-gen-primary"})
	t.Cleanup(primary.Close)
	shadow := embedtest.NewServer(embedtest.Options{Dims: 8, ModelSHA: "rev-gen-shadow"})
	t.Cleanup(shadow.Close)
	return &config.Config{
		Env:                       "development",
		DatabaseURL:               dsn,
		SearchSemanticEnabled:     true,
		EmbeddingProvider:         embedding.ProviderTEI,
		TEIURL:                    embedding.NewEndpoint(primary.URL()),
		EmbeddingDimensions:       8,
		EmbeddingShadowProvider:   embedding.ProviderTEI,
		EmbeddingShadowBaseURL:    embedding.NewEndpoint(shadow.URL()),
		EmbeddingShadowDimensions: 8,
	}
}

// useGenCalibration replaces the calibration lookup of `create` with a
// deterministic one for the fake identities and restores it afterwards.
func useGenCalibration(t *testing.T) {
	t.Helper()
	prev := reembedCalibration
	reembedCalibration = func(*config.Config) embedid.CalibrationLookup {
		return func(embedid.Identity) (float64, string, bool) {
			return 0.55, "docs/benchmarks/semantic-eval/report.json", true
		}
	}
	t.Cleanup(func() { reembedCalibration = prev })
}

// runGen dispatches `worker reembed generation <args...>` through the real registry.
func runGen(t *testing.T, cfg *config.Config, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errb bytes.Buffer
	env := Env{Cfg: cfg, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Stdout: &out, Stderr: &errb}
	code = defaultRegistry.dispatch(context.Background(), env, append([]string{"reembed", "generation"}, args...),
		func(context.Context, Env) error { return nil })
	return code, out.String(), errb.String()
}

// genSnapshot is the CLI fixture snapshot plus the active-generation singleton.
func genSnapshot(t *testing.T, f *cliFixture) string {
	t.Helper()
	var active string
	if err := f.pool.QueryRow(context.Background(),
		`SELECT COALESCE(string_agg(generation_id::text || ':' || COALESCE(flipped_reason, ''), ','), '') FROM embedding_active`).Scan(&active); err != nil {
		t.Fatalf("snapshot embedding_active: %v", err)
	}
	return f.snapshot(t) + ";active=" + active
}

func genEvidenceFile(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "evidence.txt")
	if err := os.WriteFile(p, []byte("accepted"), 0o600); err != nil {
		t.Fatalf("write evidence: %v", err)
	}
	return p
}

// wantReembedErr is the exact stderr of a dispatch that failed with err and
// printed nothing else.
func wantReembedErr(err error) string { return "reembed: " + err.Error() + "\n" }

// selectorCalls lists the "pkg.Func" selector calls under n.
func selectorCalls(n ast.Node) []string {
	var out []string
	ast.Inspect(n, func(x ast.Node) bool {
		if c, ok := x.(*ast.CallExpr); ok {
			if s, ok := c.Fun.(*ast.SelectorExpr); ok {
				if id, ok := s.X.(*ast.Ident); ok {
					out = append(out, id.Name+"."+s.Sel.Name)
				}
			}
		}
		return true
	})
	return out
}

func countOf(list []string, want string) int {
	n := 0
	for _, s := range list {
		if s == want {
			n++
		}
	}
	return n
}

func parseFuncDecl(t *testing.T, path, name string) *ast.FuncDecl {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	for _, d := range file.Decls {
		if fd, ok := d.(*ast.FuncDecl); ok && fd.Name.Name == name && fd.Recv == nil {
			return fd
		}
	}
	t.Fatalf("%s: func %s not found", path, name)
	return nil
}

// genRowsJSON is every embedding_generation row except its creation time.
func genRowsJSON(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(context.Background(),
		`SELECT COALESCE(string_agg((to_jsonb(eg) - 'created_at')::text, ',' ORDER BY id), '') FROM embedding_generation eg`).Scan(&s); err != nil {
		t.Fatalf("read generation rows: %v", err)
	}
	return s
}

// genShape is the physical shape of generation 1: partitions per corpus and
// HNSW indexes per corpus.
func genShape(t *testing.T, pool *pgxpool.Pool) (itemParts, tagParts, itemHnsw, tagHnsw int) {
	t.Helper()
	ctx := context.Background()
	count := func(q string) int {
		var n int
		if err := pool.QueryRow(ctx, q).Scan(&n); err != nil {
			t.Fatalf("shape query: %v", err)
		}
		return n
	}
	itemParts = count(`SELECT count(*)::int FROM pg_inherits WHERE inhparent = 'item_embedding_g1'::regclass`)
	tagParts = count(`SELECT count(*)::int FROM pg_inherits WHERE inhparent = 'tag_embedding_g1'::regclass`)
	itemHnsw = count(`SELECT count(*)::int FROM pg_indexes WHERE tablename LIKE 'item\_embedding\_g1\_p%' AND indexdef LIKE '%USING hnsw%'`)
	tagHnsw = count(`SELECT count(*)::int FROM pg_indexes WHERE tablename LIKE 'tag\_embedding\_g1\_p%' AND indexdef LIKE '%USING hnsw%'`)
	return
}

// TestCLIBootstrapSameFunctionAsBoot (plan evidence for L8/FS-8): `create
// --bootstrap` and worker boot both end in generation.Bootstrap. A static check
// pins the call sites; the behavioural check runs the CLI on an empty database
// and the boot call (same arguments as internal/worker Run) on another and
// demands identical generation rows and physical shape.
func TestCLIBootstrapSameFunctionAsBoot(t *testing.T) {
	// Static: the --bootstrap branch of the CLI and worker.Run both call
	// generation.Bootstrap; the CLI's non-bootstrap path calls lifecycle.Create
	// and never Bootstrap.
	cli := parseFuncDecl(t, "reembed_generation.go", "reembedGenerationCreate")
	// The function has two `if *bootstrap` statements (argument validation and the
	// create branch): Bootstrap must live in exactly one of them, Create in none.
	var inBranch []string
	branches := 0
	ast.Inspect(cli.Body, func(n ast.Node) bool {
		if is, ok := n.(*ast.IfStmt); ok {
			if star, ok := is.Cond.(*ast.StarExpr); ok {
				if id, ok := star.X.(*ast.Ident); ok && id.Name == "bootstrap" {
					branches++
					inBranch = append(inBranch, selectorCalls(is.Body)...)
				}
			}
		}
		return true
	})
	if branches == 0 {
		t.Fatal("reembedGenerationCreate has no `if *bootstrap` branch")
	}
	all := selectorCalls(cli.Body)
	if countOf(inBranch, "generation.Bootstrap") != 1 || countOf(all, "generation.Bootstrap") != 1 {
		t.Fatalf("generation.Bootstrap must be called exactly once, inside an --bootstrap branch (branches=%v)", inBranch)
	}
	if countOf(inBranch, "lifecycle.Create") != 0 || countOf(all, "lifecycle.Create") != 1 {
		t.Fatalf("lifecycle.Create must be called once, only outside the --bootstrap branches (branches=%v)", inBranch)
	}
	boot := parseFuncDecl(t, filepath.Join("..", "..", "internal", "worker", "worker.go"), "Run")
	if countOf(selectorCalls(boot.Body), "generation.Bootstrap") != 1 {
		t.Fatal("worker.Run does not call generation.Bootstrap exactly once")
	}

	// The default calibration of `create` is the lookup worker boot uses.
	prod, dev := &config.Config{Env: "production"}, &config.Config{Env: "development"}
	fake := embedid.Identity{
		Provider: embedding.FakeEmbedProvider, Model: embedding.FakeEmbedModel,
		ModelVersion: embedding.FakeEmbedModelVersionPrefix + "qp;dp", Dims: 8,
	}
	for _, c := range []*config.Config{prod, dev} {
		gotMin, gotRef, gotOK := reembedCalibration(c)(fake)
		wantMin, wantRef, wantOK := embedding.CalibrationLookupFor(c.Env)(fake)
		if gotMin != wantMin || gotRef != wantRef || gotOK != wantOK {
			t.Fatalf("env %s: reembedCalibration differs from embedding.CalibrationLookupFor", c.Env)
		}
	}
	if _, _, ok := reembedCalibration(dev)(fake); !ok {
		t.Fatal("development calibration for the fake identity must exist")
	}
	if _, _, ok := reembedCalibration(prod)(fake); ok {
		t.Fatal("production must not calibrate the non-production fake identity")
	}

	useGenCalibration(t)
	ctx := context.Background()
	dsnCLI := reembedTestDSN(t)
	poolCLI := dbtest.Pool(t, dsnCLI)
	cfg := genTestConfig(t, dsnCLI)

	// Refusals write nothing: bootstrap only with --client primary, no shape flags.
	for _, args := range [][]string{
		{"create", "--bootstrap", "--client", "shadow"},
		{"create", "--bootstrap", "--client", "primary", "--partitions", "4"},
	} {
		code, out, errb := runGen(t, cfg, args...)
		if code != 1 || out != "" || !strings.HasPrefix(errb, "reembed: ") {
			t.Fatalf("%v: exit=%d stdout=%q stderr=%q, want a refusal", args, code, out, errb)
		}
		if rows := genRowsJSON(t, poolCLI); rows != "" {
			t.Fatalf("%v wrote a generation: %s", args, rows)
		}
	}

	code, out, errb := runGen(t, cfg, "create", "--bootstrap", "--client", "primary")
	if code != 0 || errb != "" {
		t.Fatalf("create --bootstrap: exit=%d stderr=%q", code, errb)
	}
	const wantLine = "created=true generation=1 state=pending bootstrap=true provider=tei dims=8 partitions=16 hnsw_m=16 hnsw_ef_construction=128 index_ready=false\n"
	if out != wantLine {
		t.Fatalf("create --bootstrap stdout = %q, want %q", out, wantLine)
	}
	cliRows := genRowsJSON(t, poolCLI)
	cliIP, cliTP, cliIH, cliTH := genShape(t, poolCLI)
	if cliIP != 16 || cliTP != 16 || cliIH != 16 || cliTH != 16 {
		t.Fatalf("CLI bootstrap shape = parts %d/%d hnsw %d/%d, want 16 partitions and 16 HNSW indexes per corpus", cliIP, cliTP, cliIH, cliTH)
	}

	// Worker boot on another empty database: the exact call of internal/worker Run.
	dsnBoot := reembedTestDSN(t)
	poolBoot := dbtest.Pool(t, dsnBoot)
	var shadowPtr *embedding.ClientConfig
	if sc, ok := cfg.EmbeddingShadow(); ok {
		shadowPtr = &sc
	}
	cs, err := embedding.NewClientSetFromConfigs(ctx, cfg.EmbeddingPrimary(), shadowPtr, embedding.ClientDeps{})
	if err != nil {
		t.Fatalf("client set: %v", err)
	}
	bootRes, err := bootstrapLikeWorkerBoot(ctx, poolBoot, cs, reembedCalibration(cfg))
	if err != nil || !bootRes {
		t.Fatalf("boot bootstrap: created=%v err=%v", bootRes, err)
	}
	if bootRows := genRowsJSON(t, poolBoot); bootRows != cliRows {
		t.Fatalf("CLI bootstrap row differs from worker boot row:\n cli=%s\nboot=%s", cliRows, bootRows)
	}
	bIP, bTP, bIH, bTH := genShape(t, poolBoot)
	if bIP != cliIP || bTP != cliTP || bIH != cliIH || bTH != cliTH {
		t.Fatalf("physical shape differs: cli %d/%d/%d/%d boot %d/%d/%d/%d", cliIP, cliTP, cliIH, cliTH, bIP, bTP, bIH, bTH)
	}

	// A second CLI call, and a boot after the CLI, are no-ops (exit 0, row unchanged).
	code, out, errb = runGen(t, cfg, "create", "--bootstrap", "--client", "primary")
	if code != 0 || errb != "" || out != "created=false reason=generation_exists\n" {
		t.Fatalf("second create --bootstrap: exit=%d stdout=%q stderr=%q", code, out, errb)
	}
	if created, err := bootstrapLikeWorkerBoot(ctx, poolCLI, cs, reembedCalibration(cfg)); err != nil || created {
		t.Fatalf("boot after CLI bootstrap: created=%v err=%v, want a no-op", created, err)
	}
	if rows := genRowsJSON(t, poolCLI); rows != cliRows {
		t.Fatalf("no-op calls changed the generation row:\n before=%s\n after=%s", cliRows, rows)
	}
	// ... and the CLI after a boot is a no-op too.
	bootCfg := *cfg
	bootCfg.DatabaseURL = dsnBoot
	code, out, errb = runGen(t, &bootCfg, "create", "--bootstrap", "--client", "primary")
	if code != 0 || errb != "" || out != "created=false reason=generation_exists\n" {
		t.Fatalf("create --bootstrap after boot: exit=%d stdout=%q stderr=%q", code, out, errb)
	}
	if rows := genRowsJSON(t, poolBoot); rows != cliRows {
		t.Fatalf("CLI after boot changed the generation row:\n before=%s\n after=%s", cliRows, rows)
	}
}

// TestReembedGenerationRequiresYes: flip, rollback and drop without --yes write
// nothing and answer with the fixed refusal; with --yes they pass that check.
func TestReembedGenerationRequiresYes(t *testing.T) {
	useGenCalibration(t)
	f := newCLIFixture(t)
	cfg := genTestConfig(t, f.dsn)
	evidence := genEvidenceFile(t)
	before := genSnapshot(t, f)

	for _, args := range [][]string{
		{"flip", "--generation", "2"},
		{"flip", "--generation", "2", "--yes=false"},
		{"rollback", "--generation", "1"},
		{"rollback", "--generation", "1", "--yes=false"},
		{"drop", "--generation", "2", "--accepted-evidence", evidence},
		{"drop", "--generation", "2", "--accepted-evidence", evidence, "--yes=false"},
	} {
		code, out, errb := runGen(t, cfg, args...)
		if code != 1 || out != "" || errb != wantReembedErr(errGenerationNeedsYes) {
			t.Fatalf("%v: exit=%d stdout=%q stderr=%q, want exit 1, empty stdout and the --yes refusal", args, code, out, errb)
		}
		if got := genSnapshot(t, f); got != before {
			t.Fatalf("%v wrote something:\n before=%s\n after=%s", args, before, got)
		}
	}

	// Control: with --yes the leaf gets past the confirmation check (it may still
	// be refused by a lifecycle guard; g2 is not verified, g1 is active, g2 is pending).
	for _, args := range [][]string{
		{"flip", "--generation", "2", "--yes"},
		{"rollback", "--generation", "1", "--yes"},
		{"drop", "--generation", "2", "--yes", "--accepted-evidence", evidence},
	} {
		_, _, errb := runGen(t, cfg, args...)
		if strings.Contains(errb, errGenerationNeedsYes.Error()) || strings.Contains(errb, errGenerationGateDisabled.Error()) {
			t.Fatalf("%v with --yes was still refused by the confirmation or gate check: %q", args, errb)
		}
	}
}

// TestReembedGenerationDropNeedsEvidence (OQ-19): drop refuses, writing nothing,
// unless --accepted-evidence names an existing regular file; the path is never echoed.
func TestReembedGenerationDropNeedsEvidence(t *testing.T) {
	useGenCalibration(t)
	f := newCLIFixture(t)
	cfg := genTestConfig(t, f.dsn)
	before := genSnapshot(t, f)
	missing := filepath.Join(t.TempDir(), cliSecretName+"-missing.txt")
	dir := t.TempDir()

	for _, tc := range []struct {
		name string
		args []string
		path string
	}{
		{"flag_absent", []string{"drop", "--generation", "2", "--yes"}, ""},
		{"empty_value", []string{"drop", "--generation", "2", "--yes", "--accepted-evidence", ""}, ""},
		{"blank_value", []string{"drop", "--generation", "2", "--yes", "--accepted-evidence", "   "}, ""},
		{"missing_file", []string{"drop", "--generation", "2", "--yes", "--accepted-evidence", missing}, missing},
		{"directory", []string{"drop", "--generation", "2", "--yes", "--accepted-evidence", dir}, dir},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, out, errb := runGen(t, cfg, tc.args...)
			if code != 1 || out != "" || errb != wantReembedErr(errGenerationEvidence) {
				t.Fatalf("exit=%d stdout=%q stderr=%q, want exit 1, empty stdout and the evidence refusal", code, out, errb)
			}
			if tc.path != "" && strings.Contains(errb, filepath.Base(tc.path)) {
				t.Fatalf("stderr echoes the evidence path: %q", errb)
			}
			if got := genSnapshot(t, f); got != before {
				t.Fatalf("wrote something:\n before=%s\n after=%s", before, got)
			}
		})
	}

	// Control: an existing regular file passes the evidence check; g2 is pending,
	// so the lifecycle guard (not the CLI) decides, and nothing changes.
	code, _, errb := runGen(t, cfg, "drop", "--generation", "2", "--yes", "--accepted-evidence", genEvidenceFile(t))
	if code != 1 || strings.Contains(errb, errGenerationEvidence.Error()) {
		t.Fatalf("existing evidence file: exit=%d stderr=%q, want a refusal that is not the evidence one", code, errb)
	}
	if got := genSnapshot(t, f); got != before {
		t.Fatalf("drop of a pending generation changed state:\n before=%s\n after=%s", before, got)
	}
}

// TestReembedGenerationHonoursEnqueueGate: with semantic search off or a
// noop/unset provider every applying leaf refuses with the fixed error and
// writes nothing; verify and help stay usable.
func TestReembedGenerationHonoursEnqueueGate(t *testing.T) {
	useGenCalibration(t)
	f := newCLIFixture(t)
	base := genTestConfig(t, f.dsn)
	evidence := genEvidenceFile(t)

	applying := [][]string{
		{"create", "--client", "primary"},
		{"create", "--bootstrap", "--client", "primary"},
		{"backfill", "--generation", "2"},
		{"index", "--generation", "2"},
		{"flip", "--generation", "2", "--yes"},
		{"rollback", "--generation", "1", "--yes"},
		{"retire", "--generation", "2"},
		{"drop", "--generation", "2", "--yes", "--accepted-evidence", evidence},
	}
	for _, tc := range []struct {
		name   string
		mutate func(*config.Config)
	}{
		{"semantic_disabled", func(c *config.Config) { c.SearchSemanticEnabled = false }},
		{"noop_provider", func(c *config.Config) { c.EmbeddingProvider = embedding.ProviderNoop }},
		{"unset_provider", func(c *config.Config) { c.EmbeddingProvider = "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := *base
			tc.mutate(&c)
			// verify persists its report, so each case takes its own baseline.
			before := genSnapshot(t, f)
			for _, args := range applying {
				code, out, errb := runGen(t, &c, args...)
				if code != 1 || out != "" || errb != wantReembedErr(errGenerationGateDisabled) {
					t.Fatalf("%v: exit=%d stdout=%q stderr=%q, want exit 1, empty stdout and the gate refusal", args, code, out, errb)
				}
				if got := genSnapshot(t, f); got != before {
					t.Fatalf("%v wrote something while disabled:\n before=%s\n after=%s", args, before, got)
				}
			}
			// verify needs only the database: whatever it answers, it is not the gate.
			_, _, errb := runGen(t, &c, "verify", "--generation", "2")
			if strings.Contains(errb, errGenerationGateDisabled.Error()) {
				t.Fatalf("verify was refused by the enqueue gate: %q", errb)
			}
			if code, out, errb := runGen(t, &c, "help"); code != 0 || errb != "" || !strings.Contains(out, "usage: worker reembed generation") {
				t.Fatalf("help while disabled: exit=%d stdout=%q stderr=%q", code, out, errb)
			}
		})
	}
}

// TestReembedGenerationFlagErrorsAreFixed: malformed or secret-looking input is
// answered with one fixed error and never echoed (flag package diagnostics are
// discarded; every other refusal is a constant string).
func TestReembedGenerationFlagErrorsAreFixed(t *testing.T) {
	// No database: every case fails in flag/argument validation, before any I/O.
	cfg := &config.Config{Env: "development", SearchSemanticEnabled: true, EmbeddingProvider: embedding.ProviderTEI}
	secrets := []string{cliSecretName, cliSecretHint, cliSecretTag, genSecretKey, genSecretURL, "Zq-pw-5521"}

	cases := []struct {
		args  []string
		want  error
		exact bool // stderr is exactly the error (no usage printed first)
	}{
		{[]string{"create", "--client", genSecretKey}, errGenerationClient, true},
		{[]string{"create"}, errGenerationClient, true},
		{[]string{"create", "--client", "primary", "--partitions", genSecretKey}, errReembedFlags, true},
		{[]string{"create", "--client", "primary", "--m", cliSecretName}, errReembedFlags, true},
		{[]string{"create", "--client", "primary", "--base-url", genSecretURL}, errReembedFlags, true},
		{[]string{"create", "--client", "primary", "--api-key", genSecretKey}, errReembedFlags, true},
		{[]string{"create", "--bootstrap", "--client", "shadow"}, errGenerationBootClient, true},
		{[]string{"create", "--bootstrap", "--client", "primary", "--m", "8"}, errGenerationBootShape, true},
		{[]string{"create", "--client", "primary", "--m", "1"}, errGenerationShape, true},
		{[]string{"create", "--client", "primary", "--partitions", "257"}, errGenerationShape, true},
		{[]string{"create", "--client", "primary", "--m", "16", "--ef-construction", "20"}, errGenerationShape, true},
		{[]string{"create", "--client", "primary", genSecretKey}, errGenerationPositional, true},
		{[]string{"backfill"}, errGenerationIDRequired, true},
		{[]string{"backfill", "--generation", "0"}, errGenerationIDRequired, true},
		{[]string{"backfill", "--generation", "-3"}, errGenerationIDRange, true},
		{[]string{"backfill", "--generation", "10000"}, errGenerationIDRange, true},
		{[]string{"backfill", "--generation", "99999999999999999999"}, errReembedFlags, true},
		{[]string{"backfill", "--generation", cliSecretName}, errReembedFlags, true},
		{[]string{"index", "--generation=" + genSecretKey}, errReembedFlags, true},
		{[]string{"verify", "--" + cliSecretName}, errReembedFlags, true},
		{[]string{"verify", "---" + cliSecretTag}, errReembedFlags, true},
		{[]string{"verify", "--generation", "2", "--accepted-evidence", genSecretURL}, errReembedFlags, true},
		{[]string{"retire", "--generation", "2", genSecretKey}, errGenerationPositional, true},
		{[]string{"retire", "--generation", "2", "--yes"}, errReembedFlags, true},
		{[]string{"flip", "--generation", "2", "--yes=" + genSecretKey}, errReembedFlags, true},
		{[]string{"flip", "--generation", "2", "--yes", "--reason", cliSecretHint}, errGenerationReason, true},
		{[]string{"flip", "--generation", "2", "--reason", "bad reason " + genSecretKey}, errGenerationReason, true},
		{[]string{"rollback", "--generation", "1", "--yes", "--reason", genSecretURL}, errGenerationReason, true},
		{[]string{"drop", "--generation", "2", "--yes", "--accepted-evidence"}, errReembedFlags, true},
		{[]string{"drop", "--generation", "2", "--yes", "--" + cliSecretName}, errReembedFlags, true},
		{[]string{"drop", "--generation", "10000", "--yes", "--accepted-evidence", genSecretURL}, errGenerationIDRange, true},
		// Unknown or missing leaf: the safe usage is printed on stderr first.
		{[]string{genSecretKey}, errGenerationLeafUnknown, false},
		{[]string{"--" + cliSecretName}, errGenerationLeafUnknown, false},
		{nil, errGenerationLeafRequired, false},
	}
	for _, tc := range cases {
		code, out, errb := runGen(t, cfg, tc.args...)
		if code != 1 || out != "" {
			t.Fatalf("%v: exit=%d stdout=%q, want exit 1 and empty stdout", tc.args, code, out)
		}
		want := wantReembedErr(tc.want)
		if tc.exact && errb != want {
			t.Fatalf("%v: stderr=%q, want exactly %q", tc.args, errb, want)
		}
		if !tc.exact && !strings.HasSuffix(errb, want) {
			t.Fatalf("%v: stderr=%q, want it to end with %q", tc.args, errb, want)
		}
		for _, s := range secrets {
			if strings.Contains(errb, s) {
				t.Fatalf("%v: stderr echoes %q: %q", tc.args, s, errb)
			}
		}
	}
}

// TestReembedGenerationHelpListsLeaves: help (and -h on any leaf) prints the
// leaves and the safety flags on stdout and exits 0; the subcommand is
// registered next to the T15 ones and shows in the reembed usage.
func TestReembedGenerationHelpListsLeaves(t *testing.T) {
	if _, ok := reembedSubcommands["generation"]; !ok {
		t.Fatal(`"generation" is not registered under reembed`)
	}
	cfg := &config.Config{}
	want := []string{
		"create", "backfill", "index", "verify", "flip", "rollback", "retire", "drop",
		"--bootstrap", "--client primary|shadow", "--generation", "--yes", "--accepted-evidence",
		"--partitions", "--m", "--ef-construction", "1..9999",
	}
	for _, args := range [][]string{{"help"}, {"-h"}, {"--help"}, {"flip", "-h"}, {"create", "--help"}, {"drop", "-help"}} {
		code, out, errb := runGen(t, cfg, args...)
		if code != 0 || errb != "" {
			t.Fatalf("%v: exit=%d stderr=%q, want exit 0 and empty stderr", args, code, errb)
		}
		for _, w := range want {
			if !strings.Contains(out, w) {
				t.Fatalf("%v: usage lacks %q:\n%s", args, w, out)
			}
		}
	}
	var out, errb bytes.Buffer
	env := Env{Cfg: cfg, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Stdout: &out, Stderr: &errb}
	if code := defaultRegistry.dispatch(context.Background(), env, []string{"reembed", "help"},
		func(context.Context, Env) error { return nil }); code != 0 || !strings.Contains(out.String(), "generation") {
		t.Fatalf("reembed help: exit=%d stdout=%q", code, out.String())
	}
}

// TestReembedGenerationOutputHasNoNames: run every leaf (successes and
// refusals alike) against a database that holds names, hints, tag text and
// emails and assert nothing but ids/counts/states/reason codes is printed: no
// plaintext, no user/target ids (job args), no provider URL, no key.
func TestReembedGenerationOutputHasNoNames(t *testing.T) {
	useGenCalibration(t)
	f := newCLIFixture(t)
	cfg := genTestConfig(t, f.dsn)
	evidence := genEvidenceFile(t)

	forbidden := []string{
		cliSecretName, cliSecretHint, cliSecretTag, cliSecretEmail, cliOffEmail, "sk-test-cli-key",
		cfg.TEIURL.Reveal(), cfg.EmbeddingShadowBaseURL.Reveal(), "127.0.0.1", "localhost",
		f.userOn.String(), f.userOff.String(), f.itemFresh.String(), f.itemStale.String(),
		f.itemGone.String(), f.itemOff.String(), f.tagLive.String(),
		"user_id", "target_id", "input_hash", "{",
	}
	steps := [][]string{
		{"create", "--client", "primary"},
		{"create", "--client", "shadow", "--partitions", "4", "--m", "8", "--ef-construction", "32"},
		{"backfill", "--generation", "2"},
		{"verify", "--generation", "2"},
		{"index", "--generation", "2"},
		{"flip", "--generation", "2", "--yes"},
		{"rollback", "--generation", "1", "--yes"},
		{"backfill", "--generation", "1"},
		{"retire", "--generation", "2"},
		{"create", "--client", "primary"},
		{"create", "--bootstrap", "--client", "primary"},
		{"verify", "--generation", "3"},
		{"drop", "--generation", "3", "--yes", "--accepted-evidence", evidence},
		{"backfill", "--generation", "9999"},
		{"help"},
	}
	for _, args := range steps {
		_, out, errb := runGen(t, cfg, args...)
		all := out + errb
		if all == "" {
			t.Fatalf("%v printed nothing", args)
		}
		for _, s := range forbidden {
			if strings.Contains(all, s) {
				t.Fatalf("%v output contains %q:\nstdout=%q\nstderr=%q", args, s, out, errb)
			}
		}
	}
}

// bootstrapLikeWorkerBoot makes the call internal/worker Run makes at boot:
// generation.Bootstrap(ctx, pool, cs.Primary().Identity, calib). It reports
// whether g1 was created.
func bootstrapLikeWorkerBoot(ctx context.Context, pool *pgxpool.Pool, cs *embedding.ClientSet, calib embedid.CalibrationLookup) (bool, error) {
	res, err := generation.Bootstrap(ctx, pool, cs.Primary().Identity, calib)
	return res.Created, err
}
