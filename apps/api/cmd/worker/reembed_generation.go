package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/embedding/lifecycle"
)

// `worker reembed generation <leaf>` is the operator surface of the embedding
// generation lifecycle (plan P05 mục 2.15 steps 1-7, mục 2.22, Task 19):
//
//	create [--bootstrap] --client primary|shadow [--partitions N --m N --ef-construction N]
//	backfill|index|verify|flip|rollback|retire|drop --generation N
//
// Safety contract: no key ever travels on argv (the identity comes from the
// env-built embedding.ClientSet), flip/rollback/drop need --yes, drop needs
// --accepted-evidence, every applying leaf honours the deployment gate, and the
// output is ids, counts, states and reason codes only: never names, hints, tag
// text, query text, vectors, provider URLs, keys or job args.

func init() {
	registerReembedSub("generation", reembedGenerationRun)
}

const (
	minGenerationID = 1
	maxGenerationID = 9999

	// Shape bounds of embedding_generation_create_tables (migration 0009).
	maxGenPartitions  = 256
	minGenHnswM       = 2
	maxGenHnswM       = 100
	minGenHnswEfc     = 4
	maxGenHnswEfc     = 1000
	defaultFlipReason = "cli_flip"
	defaultRollReason = "cli_rollback"
)

// errGenerationGateDisabled is the fixed refusal of every applying leaf when the
// deployment does not enqueue embeddings (SPEC 6.6/6.10), same rule as
// `reembed all` (enqueueAllowed). verify is the one leaf that stays usable: it
// writes only its own report and never a vector, job or generation state.
var errGenerationGateDisabled = errors.New("embedding is disabled in this deployment (semantic search off or noop provider); nothing was written, 'reembed status' and 'reembed generation verify' still work")

var (
	errGenerationLeafRequired = errors.New("generation needs a leaf (run 'worker reembed generation help' for usage)")
	errGenerationLeafUnknown  = errors.New("unknown generation leaf (run 'worker reembed generation help' for usage)")
	errGenerationPositional   = errors.New("unexpected positional arguments")
	errGenerationIDRequired   = errors.New("--generation is required")
	errGenerationIDRange      = fmt.Errorf("--generation must be an id between %d and %d", minGenerationID, maxGenerationID)
	errGenerationNeedsYes     = errors.New("this leaf changes the active generation set or deletes data: pass --yes to confirm; nothing was written")
	errGenerationEvidence     = errors.New("--accepted-evidence must name an existing regular file; nothing was written")
	errGenerationReason       = errors.New("--reason must be a short token of lowercase letters, digits, '_', '-' or '.' (at most 64 bytes)")
	errGenerationClient       = errors.New("--client must be primary or shadow")
	errGenerationBootClient   = errors.New("--bootstrap is only allowed with --client primary")
	errGenerationBootShape    = errors.New("--bootstrap uses the default partitions and HNSW parameters: do not pass --partitions, --m or --ef-construction")
	errGenerationShape        = fmt.Errorf("invalid shape: --partitions 1..%d, --m %d..%d, --ef-construction %d..%d and >= 2*m (0 = default)",
		maxGenPartitions, minGenHnswM, maxGenHnswM, minGenHnswEfc, maxGenHnswEfc)
	errGenerationNoShadow   = errors.New("--client shadow needs EMBEDDING_SHADOW_PROVIDER configured (non-noop)")
	errGenerationNoClient   = errors.New("cannot build the embedding client from the environment")
	errGenerationNoIdentity = errors.New("the embedding client has no usable identity")
)

var reasonTokenRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)

// reembedCalibration returns the calibration lookup used by `create`. It is the
// same constructor worker boot uses (internal/worker Run); a variable only so a
// test can supply a deterministic calibration for its fake identities.
var reembedCalibration = func(cfg *config.Config) embedid.CalibrationLookup {
	env := ""
	if cfg != nil {
		env = cfg.Env
	}
	return embedding.CalibrationLookupFor(env)
}

// generationSentinels are the lifecycle/generation errors whose fixed text is
// safe to print; everything else goes through safeErr.
var generationSentinels = []error{
	lifecycle.ErrNotPending,
	lifecycle.ErrNotRetired,
	lifecycle.ErrPendingExists,
	lifecycle.ErrCalibrationMissing,
	lifecycle.ErrDimsMismatch,
	lifecycle.ErrIndexNotReady,
	lifecycle.ErrNotVerified,
	lifecycle.ErrVerifyStale,
	lifecycle.ErrCoverageIncomplete,
	lifecycle.ErrGenerationNotCaughtUp,
	lifecycle.ErrRollbackWindowClosed,
	lifecycle.ErrDropGuard,
	lifecycle.ErrIsActive,
	generation.ErrGenerationNotFound,
	generation.ErrInvalidBootstrapIdentity,
}

// generationErr maps a lifecycle/generation error to its fixed sentinel text
// (any wrapped detail is dropped) or, for anything else, to safeErr.
func generationErr(what string, err error) error {
	for _, s := range generationSentinels {
		if errors.Is(err, s) {
			return fmt.Errorf("%s: %s", what, s.Error())
		}
	}
	return safeErr(what, err)
}

func writeGenerationUsage(w io.Writer) {
	lines := []string{
		"usage: worker reembed generation <leaf> [flags]",
		"  create [--bootstrap] --client primary|shadow [--partitions N --m N --ef-construction N]",
		"  backfill --generation N     enqueue embed jobs for a pending generation",
		"  index --generation N        build the per-partition HNSW indexes",
		"  verify --generation N       dry-run coverage, integrity and recall; persists the report",
		"  flip --generation N --yes [--reason TOKEN]       pending -> active (manual)",
		"  rollback --generation N --yes [--reason TOKEN]   reactivate a retired generation inside its window",
		"  retire --generation N       abandon a pending generation or close a retired window early",
		"  drop --generation N --yes --accepted-evidence <file>   drop the tables of a retired generation past its window",
		"safety: no key on argv (the identity comes from the env-built client set); --generation is 1..9999;",
		"  flip, rollback and drop refuse without --yes; drop refuses without an existing --accepted-evidence file;",
		"  create, backfill, index, flip, rollback, retire and drop need semantic search enabled and a non-noop provider;",
		"  verify only needs the database; create --bootstrap only with --client primary (same function as worker boot);",
		"  output is ids, counts, states and reason codes only",
	}
	for _, l := range lines {
		_, _ = fmt.Fprintln(w, l)
	}
}

func reembedGenerationRun(ctx context.Context, env Env, args []string) error {
	if len(args) == 0 {
		writeGenerationUsage(env.Stderr)
		return errGenerationLeafRequired
	}
	leaf, rest := args[0], args[1:]
	switch leaf {
	case "help", "-h", "--help":
		writeGenerationUsage(env.Stdout)
		return flag.ErrHelp
	case "create":
		return reembedGenerationCreate(ctx, env, rest)
	case "backfill":
		return reembedGenerationBackfill(ctx, env, rest)
	case "index":
		return reembedGenerationIndex(ctx, env, rest)
	case "verify":
		return reembedGenerationVerify(ctx, env, rest)
	case "flip":
		return reembedGenerationFlip(ctx, env, rest)
	case "rollback":
		return reembedGenerationRollback(ctx, env, rest)
	case "retire":
		return reembedGenerationRetire(ctx, env, rest)
	case "drop":
		return reembedGenerationDrop(ctx, env, rest)
	default:
		writeGenerationUsage(env.Stderr)
		return errGenerationLeafUnknown
	}
}

// parseGenerationFlags is parseReembedFlags plus the generation usage on -h.
func parseGenerationFlags(fs *flag.FlagSet, env Env, args []string) error {
	err := parseReembedFlags(fs, env, args)
	if errors.Is(err, flag.ErrHelp) {
		writeGenerationUsage(env.Stdout)
	}
	if err == nil && fs.NArg() > 0 {
		return errGenerationPositional
	}
	return err
}

// leafSpec describes which safety flags a --generation leaf takes.
type leafSpec struct {
	yes      bool
	evidence bool
	reason   bool
}

// leafFlags are the parsed and validated flags of a --generation leaf.
type leafFlags struct {
	genID    int
	evidence string
	reason   string
}

// parseGenerationLeaf parses and validates a --generation leaf without touching
// the environment or the database: flags, range, --yes, evidence, reason.
func parseGenerationLeaf(env Env, name string, spec leafSpec, defaultReason string, args []string) (leafFlags, error) {
	fs := flag.NewFlagSet("reembed generation "+name, flag.ContinueOnError)
	genID := fs.Int("generation", 0, "generation id (1..9999)")
	var yes *bool
	if spec.yes {
		yes = fs.Bool("yes", false, "confirm")
	}
	var evidence, reason *string
	if spec.evidence {
		evidence = fs.String("accepted-evidence", "", "path of the accepted-evidence file")
	}
	if spec.reason {
		reason = fs.String("reason", defaultReason, "short operator token")
	}
	if err := parseGenerationFlags(fs, env, args); err != nil {
		return leafFlags{}, err
	}
	if *genID == 0 {
		return leafFlags{}, errGenerationIDRequired
	}
	if *genID < minGenerationID || *genID > maxGenerationID {
		return leafFlags{}, errGenerationIDRange
	}
	out := leafFlags{genID: *genID}
	if spec.reason {
		if !reasonTokenRE.MatchString(*reason) {
			return leafFlags{}, errGenerationReason
		}
		out.reason = *reason
	}
	if spec.yes && !*yes {
		return leafFlags{}, errGenerationNeedsYes
	}
	if spec.evidence {
		path := strings.TrimSpace(*evidence)
		if path == "" {
			return leafFlags{}, errGenerationEvidence
		}
		st, err := os.Stat(path)
		if err != nil || !st.Mode().IsRegular() {
			return leafFlags{}, errGenerationEvidence
		}
		out.evidence = path
	}
	return out, nil
}

// applyGate refuses an applying leaf when the deployment enqueues no embeddings.
func applyGate(env Env) error {
	if !enqueueAllowed(env.Cfg) {
		return errGenerationGateDisabled
	}
	return nil
}

// rollbackWindow is the configured SEARCH_ROLLBACK_WINDOW (0 = lifecycle default).
func rollbackWindow(env Env) time.Duration {
	if env.Cfg == nil {
		return 0
	}
	return env.Cfg.SearchRollbackWindow
}

// printGenerationRow prints the privacy-safe columns of one generation.
func printGenerationRow(w io.Writer, prefix string, g generation.Generation) {
	_, _ = fmt.Fprintf(w, "%sgeneration=%d state=%s bootstrap=%t provider=%s dims=%d partitions=%d hnsw_m=%d hnsw_ef_construction=%d index_ready=%t\n",
		prefix, g.ID, g.State, g.Bootstrap, g.Provider, g.Dims, g.Partitions, g.HnswM, g.HnswEfConstruction, g.IndexReady)
}

// printGenerationState re-reads the generation and prints its state after an action.
func printGenerationState(ctx context.Context, w io.Writer, pool *pgxpool.Pool, action string, genID int) error {
	g, err := generation.GetByID(ctx, pool, genID)
	if err != nil {
		return generationErr(fmt.Sprintf("generation %d read", genID), err)
	}
	_, _ = fmt.Fprintf(w, "generation=%d action=%s state=%s bootstrap=%t index_ready=%t\n", g.ID, action, g.State, g.Bootstrap, g.IndexReady)
	return nil
}

func reembedGenerationCreate(ctx context.Context, env Env, args []string) error {
	fs := flag.NewFlagSet("reembed generation create", flag.ContinueOnError)
	bootstrap := fs.Bool("bootstrap", false, "create the bootstrap generation g1 (primary client only)")
	client := fs.String("client", "", "primary or shadow")
	partitions := fs.Int("partitions", 0, "hash partitions (0 = default)")
	m := fs.Int("m", 0, "HNSW m (0 = default)")
	efc := fs.Int("ef-construction", 0, "HNSW ef_construction (0 = default)")
	if err := parseGenerationFlags(fs, env, args); err != nil {
		return err
	}
	if *client != "primary" && *client != "shadow" {
		return errGenerationClient
	}
	shaped := *partitions != 0 || *m != 0 || *efc != 0
	if *bootstrap {
		if *client != "primary" {
			return errGenerationBootClient
		}
		if shaped {
			return errGenerationBootShape
		}
	}
	if !validGenerationShape(*partitions, *m, *efc) {
		return errGenerationShape
	}
	if err := applyGate(env); err != nil {
		return err
	}

	ident, err := generationIdentity(ctx, env, *client)
	if err != nil {
		return err
	}
	calib := reembedCalibration(env.Cfg)

	pool, err := reembedPool(ctx, env)
	if err != nil {
		return err
	}
	defer pool.Close()

	if *bootstrap {
		// L8/FS-8: the very same function worker boot calls (internal/worker
		// Run); TestCLIBootstrapSameFunctionAsBoot pins it.
		res, err := generation.Bootstrap(ctx, pool, ident, calib)
		if err != nil {
			return generationErr("generation bootstrap", err)
		}
		if !res.Created {
			_, _ = fmt.Fprintln(env.Stdout, "created=false reason=generation_exists")
			return nil
		}
		_, _ = fmt.Fprint(env.Stdout, "created=true ")
		printGenerationRow(env.Stdout, "", res.Generation)
		return nil
	}

	g, err := lifecycle.Create(ctx, pool, ident, calib, lifecycle.CreateOpts{
		Partitions: *partitions, M: *m, EfConstruction: *efc,
	})
	if err != nil {
		return generationErr("generation create", err)
	}
	_, _ = fmt.Fprint(env.Stdout, "created=true ")
	printGenerationRow(env.Stdout, "", g)
	return nil
}

func validGenerationShape(partitions, m, efc int) bool {
	if partitions < 0 || partitions > maxGenPartitions || m < 0 || efc < 0 {
		return false
	}
	if m != 0 && (m < minGenHnswM || m > maxGenHnswM) {
		return false
	}
	if efc != 0 && (efc < minGenHnswEfc || efc > maxGenHnswEfc) {
		return false
	}
	// The DDL requires ef_construction >= 2*m; resolve defaults before checking.
	rm, refc := m, efc
	if rm == 0 {
		rm = generation.DefaultHnswM
	}
	if refc == 0 {
		refc = generation.DefaultHnswEfConstruction
	}
	return refc >= 2*rm
}

// generationIdentity builds the env ClientSet (the same constructor worker boot
// uses) and returns the identity of the chosen client. No key is read from argv.
func generationIdentity(ctx context.Context, env Env, which string) (embedid.Identity, error) {
	cfg := env.Cfg
	var shadowPtr *embedding.ClientConfig
	if sc, ok := cfg.EmbeddingShadow(); ok {
		shadowPtr = &sc
	}
	cs, err := embedding.NewClientSetFromConfigs(ctx, cfg.EmbeddingPrimary(), shadowPtr, embedding.ClientDeps{Logger: env.Logger, Now: time.Now})
	if err != nil {
		return embedid.Identity{}, errGenerationNoClient
	}
	c := cs.Primary()
	if which == "shadow" {
		sc, ok := cs.Shadow()
		if !ok {
			return embedid.Identity{}, errGenerationNoShadow
		}
		c = sc
	}
	if c.Provider == nil || c.Identity.Provider == "" || c.Identity.Provider == embedding.ProviderNoop {
		return embedid.Identity{}, errGenerationNoIdentity
	}
	return c.Identity, nil
}

func reembedGenerationBackfill(ctx context.Context, env Env, args []string) error {
	lf, err := parseGenerationLeaf(env, "backfill", leafSpec{}, "", args)
	if err != nil {
		return err
	}
	if err := applyGate(env); err != nil {
		return err
	}
	pool, err := reembedPool(ctx, env)
	if err != nil {
		return err
	}
	defer pool.Close()
	client, err := reembedInsertClient(pool)
	if err != nil {
		return err
	}
	enq := jobs.ReembedEnqueueFunc(jobs.RiverClientInserter{Client: client})
	res, err := lifecycle.Backfill(ctx, pool, lf.genID, enq)
	if err != nil {
		return generationErr(fmt.Sprintf("generation %d backfill", lf.genID), err)
	}
	printReconcileResult(env.Stdout, lf.genID, res)
	return nil
}

func reembedGenerationIndex(ctx context.Context, env Env, args []string) error {
	lf, err := parseGenerationLeaf(env, "index", leafSpec{}, "", args)
	if err != nil {
		return err
	}
	if err := applyGate(env); err != nil {
		return err
	}
	pool, err := reembedPool(ctx, env)
	if err != nil {
		return err
	}
	defer pool.Close()
	res, err := lifecycle.Index(ctx, pool, lf.genID)
	if err != nil {
		return generationErr(fmt.Sprintf("generation %d index", lf.genID), err)
	}
	_, _ = fmt.Fprintf(env.Stdout, "generation=%d expected=%d built=%d repaired=%d already_valid=%d valid=%d ready=%t\n",
		lf.genID, res.Expected, res.Built, res.Repaired, res.AlreadyValid, res.Valid, res.Ready)
	return nil
}

// reembedGenerationVerify is deliberately NOT behind the enqueue gate: it
// enqueues nothing and changes no vector, job or generation state. Its only
// write is the verification report (counts, ratios and a reason code) under the
// generation lock, so an operator can still inspect a generation of a
// deployment where semantic search was switched off. It needs the database only.
func reembedGenerationVerify(ctx context.Context, env Env, args []string) error {
	lf, err := parseGenerationLeaf(env, "verify", leafSpec{}, "", args)
	if err != nil {
		return err
	}
	pool, err := reembedPool(ctx, env)
	if err != nil {
		return err
	}
	defer pool.Close()
	rep, err := lifecycle.Verify(ctx, pool, lf.genID, lifecycle.VerifyOpts{})
	if err != nil {
		return generationErr(fmt.Sprintf("generation %d verify", lf.genID), err)
	}
	printVerifyReport(env.Stdout, lf.genID, rep)
	if !rep.Passed {
		return fmt.Errorf("verification did not pass (reason=%s)", safeReason(rep.Reason))
	}
	return nil
}

// safeReason prints a verify reason only when it is one of the fixed codes.
func safeReason(r string) string {
	switch r {
	case lifecycle.ReasonOK, lifecycle.ReasonIndexNotReady, lifecycle.ReasonJobsPending,
		lifecycle.ReasonCoverageIncomplete, lifecycle.ReasonIntegrity,
		lifecycle.ReasonRecallBelowTarget, lifecycle.ReasonNotReceiving,
		lifecycle.ReasonRecallSampleShort, lifecycle.ReasonRecallBaseline, lifecycle.ReasonRecallPath:
		return r
	default:
		return "unknown"
	}
}

func printVerifyReport(w io.Writer, genID int, r lifecycle.VerifyReport) {
	c := r.Coverage
	_, _ = fmt.Fprintf(w,
		"generation=%d passed=%t reason=%s item_rows=%d tag_rows=%d scanned=%d missing=%d stale=%d would_delete_orphan=%d would_delete_user_off=%d skipped_user_off=%d coverage_complete=%t dims_ok=%t partitions_ok=%t index_ready=%t jobs_pending_before_watermark=%d recall_skipped_below_200=%t\n",
		genID, r.Passed, safeReason(r.Reason), r.ItemRows, r.TagRows,
		c.Scanned, c.Missing, c.Stale, c.WouldDeleteOrphan, c.WouldDeleteUserOff, c.SkippedUserOff, c.Complete,
		r.DimsOK, r.PartitionsOK, r.IndexReady, r.JobsPendingBeforeWatermark, r.RecallSkippedBelow200)
	if rc := r.Recall; rc != nil {
		_, _ = fmt.Fprintf(w, "generation=%d recall_requested=%d recall_sampled=%d recall_eligible=%d recall_mean=%.4f recall_query_share_ok=%.4f recall_false_positives=%d recall_k=%d recall_passed=%t\n",
			genID, rc.Requested, rc.Sampled, rc.Eligible, rc.MeanRecall, rc.QueryShareOK, rc.FalsePositives, rc.K, rc.Passed)
	}
}

func reembedGenerationFlip(ctx context.Context, env Env, args []string) error {
	lf, err := parseGenerationLeaf(env, "flip", leafSpec{yes: true, reason: true}, defaultFlipReason, args)
	if err != nil {
		return err
	}
	if err := applyGate(env); err != nil {
		return err
	}
	pool, err := reembedPool(ctx, env)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := lifecycle.Flip(ctx, pool, lf.genID, lifecycle.FlipOpts{
		Reason: lf.reason, RollbackWindow: rollbackWindow(env),
	}); err != nil {
		return generationErr(fmt.Sprintf("generation %d flip", lf.genID), err)
	}
	return printGenerationState(ctx, env.Stdout, pool, "flip", lf.genID)
}

func reembedGenerationRollback(ctx context.Context, env Env, args []string) error {
	lf, err := parseGenerationLeaf(env, "rollback", leafSpec{yes: true, reason: true}, defaultRollReason, args)
	if err != nil {
		return err
	}
	if err := applyGate(env); err != nil {
		return err
	}
	pool, err := reembedPool(ctx, env)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := lifecycle.Rollback(ctx, pool, lf.genID, lifecycle.RollbackOpts{
		Reason: lf.reason, RollbackWindow: rollbackWindow(env),
	}); err != nil {
		return generationErr(fmt.Sprintf("generation %d rollback", lf.genID), err)
	}
	return printGenerationState(ctx, env.Stdout, pool, "rollback", lf.genID)
}

func reembedGenerationRetire(ctx context.Context, env Env, args []string) error {
	lf, err := parseGenerationLeaf(env, "retire", leafSpec{}, "", args)
	if err != nil {
		return err
	}
	if err := applyGate(env); err != nil {
		return err
	}
	pool, err := reembedPool(ctx, env)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := lifecycle.Retire(ctx, pool, lf.genID, lifecycle.RetireOpts{}); err != nil {
		return generationErr(fmt.Sprintf("generation %d retire", lf.genID), err)
	}
	return printGenerationState(ctx, env.Stdout, pool, "retire", lf.genID)
}

func reembedGenerationDrop(ctx context.Context, env Env, args []string) error {
	lf, err := parseGenerationLeaf(env, "drop", leafSpec{yes: true, evidence: true}, "", args)
	if err != nil {
		return err
	}
	if err := applyGate(env); err != nil {
		return err
	}
	pool, err := reembedPool(ctx, env)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := lifecycle.Drop(ctx, pool, lf.genID, lifecycle.DropOpts{AcceptedEvidence: lf.evidence}); err != nil {
		return generationErr(fmt.Sprintf("generation %d drop", lf.genID), err)
	}
	return printGenerationState(ctx, env.Stdout, pool, "drop", lf.genID)
}
