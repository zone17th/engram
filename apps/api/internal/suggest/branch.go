package suggest

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

// BranchSetupTimeout bounds the SETUP of a lexical branch: connection acquire (a cold pool
// may have to dial TCP + TLS/SCRAM first), BEGIN and the transaction-local SET LOCALs
// (FU-SB-2). It is separate from BranchTimeout on purpose: SPEC §6.3 gives each corpus a 50 ms
// budget for the QUERY (`SET LOCAL statement_timeout = '50ms'`), and before FU-SB-2 the 50 ms
// context also covered acquire+BEGIN, so the first request on a cold or idle pool could expire
// before its query ever ran and return `lexical_partial` with that corpus empty (CI 41533446051,
// TestSuggestLexicalIdenticalSemanticOnOff under -race).
//
// 2 s is far above a cold dial plus handshake (tens to a few hundred ms even under -race) and
// far below the request-level timeouts, so it only bites when the database or the pool is really
// unavailable; the user-visible worst case of a degraded response is then
// BranchSetupTimeout + BranchTimeout. The request context still wins over this bound
// (classifyBranchErr: a client cancel or request deadline is never a partial).
const BranchSetupTimeout = 2 * time.Second

// Phases of a lexical branch, the bounded value set of the `phase` field of the partial log line.
const (
	// phaseSetup: connection acquire + BEGIN (pgxpool.BeginTx does both; they cannot be split
	// behind the TxStarter seam).
	phaseSetup = "setup"
	// phaseSetLocal: the SET LOCAL statements.
	phaseSetLocal = "set_local"
	// phaseQuery: the 50 ms query budget (the item/tag query and the tag-chip follow-up).
	phaseQuery = "query"
)

// branchTimings are the whole-millisecond durations of the finished phases of one branch.
type branchTimings struct {
	setup    time.Duration
	setLocal time.Duration
	query    time.Duration
}

// setupContext returns the context bounding acquire + BEGIN + SET LOCAL.
func (s *Service) setupContext(parent context.Context) (context.Context, context.CancelFunc) {
	if h := s.activeHooks(); h != nil && h.SetupTimeout > 0 {
		return context.WithTimeout(parent, h.SetupTimeout)
	}
	return context.WithTimeout(parent, BranchSetupTimeout)
}

// logBranchPartial emits ONE INFO line when a lexical branch degraded to partial (SPEC §6.8).
// INFO, not WARN: the response is a handled 200 whose counter (`search_lexical_partial_total`)
// already carries the alert signal, and a WARN would be indistinguishable from a genuine server
// error line. Fields are a fixed set (dec-268): corpus, mode and phase are enums, the durations
// are integer milliseconds. Never q/qn, names, hints, tags, error text or a user id.
func (s *Service) logBranchPartial(ctx context.Context, corpus, mode, phase string, t branchTimings) {
	l := s.logger.Load()
	if l == nil {
		return
	}
	l.LogAttrs(ctx, slog.LevelInfo, "suggest lexical branch partial",
		slog.String("corpus", corpus),
		slog.String("mode", mode),
		slog.String("phase", phase),
		slog.Int64("setup_ms", t.setup.Milliseconds()),
		slog.Int64("set_local_ms", t.setLocal.Milliseconds()),
		slog.Int64("query_ms", t.query.Milliseconds()),
	)
}

// runBranch runs one lexical branch in two separately bounded stages (FU-SB-2):
//
//  1. setup under BranchSetupTimeout: BeforeBranch hook, acquire + BEGIN, SET LOCALs;
//  2. the query work under the BranchTimeout budget, which starts only after setup is done:
//     the AfterBranchSetLocal hook and `query` (the item/tag query and follow-ups).
//
// A failed step is classified by classifyBranchErr against the context of ITS stage: the stage
// expired while the request is alive -> partial (the caller returns the SPEC §6.8 partial for that
// corpus and one log line names the phase); the request ended -> the parent wins and nothing is
// partial; anything else is a genuine error of `class`. `query` returns the error class of the
// failing step so the tag-chip follow-up keeps its own class.
func (s *Service) runBranch(
	ctx context.Context,
	corpus, mode, class string,
	trgm bool,
	query func(qctx context.Context, tx pgx.Tx) (string, error),
) (partial bool, err error) {
	var (
		tm    branchTimings
		phase = phaseSetup
	)
	fail := func(stage context.Context, stepErr error, stepClass string) (bool, error) {
		p, out := classifyBranchErr(ctx, stage, stepErr, corpus, mode, stepClass)
		if p {
			s.logBranchPartial(ctx, corpus, mode, phase, tm)
		}
		return p, out
	}

	setupCtx, cancelSetup := s.setupContext(ctx)
	defer cancelSetup()

	t0 := time.Now()
	if h := s.activeHooks(); h != nil && h.BeforeBranch != nil {
		if herr := h.BeforeBranch(setupCtx, corpus); herr != nil {
			tm.setup = time.Since(t0)
			return fail(setupCtx, herr, class)
		}
	}
	tx, berr := s.txStarter.BeginTx(setupCtx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	tm.setup = time.Since(t0)
	if berr != nil {
		return fail(setupCtx, berr, class)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	phase = phaseSetLocal
	t1 := time.Now()
	cerr := configureLexicalTx(setupCtx, tx, trgm, s.LexicalForceCustomPlan())
	tm.setLocal = time.Since(t1)
	if cerr != nil {
		return fail(setupCtx, cerr, class)
	}
	cancelSetup()

	// The 50 ms query budget starts here, so acquire/BEGIN/SET LOCAL never spend it.
	branchCtx, cancel := s.branchContext(ctx, corpus)
	defer cancel()

	phase = phaseQuery
	t2 := time.Now()
	if h := s.activeHooks(); h != nil && h.AfterBranchSetLocal != nil {
		if herr := h.AfterBranchSetLocal(branchCtx, tx, corpus); herr != nil {
			tm.query = time.Since(t2)
			return fail(branchCtx, herr, class)
		}
	}
	if stepClass, qerr := query(branchCtx, tx); qerr != nil {
		tm.query = time.Since(t2)
		return fail(branchCtx, qerr, stepClass)
	}
	return false, nil
}
