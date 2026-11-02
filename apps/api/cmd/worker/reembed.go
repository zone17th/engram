package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobargs"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/embedding/reconcile"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
)

// maxDeadLetterListed caps the job ids printed by `reembed deadletter list`.
const maxDeadLetterListed = 1000

// reembedSubFn is a nested `reembed <name>` subcommand handler.
type reembedSubFn func(ctx context.Context, env Env, args []string) error

// reembedSubcommands holds the nested subcommands of `worker reembed`. Task 19
// adds `generation` by calling registerReembedSub from its own init() in
// reembed_generation.go, without editing this file.
var reembedSubcommands = map[string]reembedSubFn{}

// registerReembedSub registers a nested `worker reembed <name>` subcommand. It
// panics on an empty name, nil handler or duplicate name (same contract as
// Register).
func registerReembedSub(name string, fn reembedSubFn) {
	if name == "" {
		panic("worker reembed: empty subcommand name")
	}
	if fn == nil {
		panic("worker reembed: nil handler for " + name)
	}
	if _, dup := reembedSubcommands[name]; dup {
		panic("worker reembed: duplicate subcommand " + name)
	}
	reembedSubcommands[name] = fn
}

func init() {
	Register(Command{
		Name:    "reembed",
		Summary: "reconcile embeddings and inspect the embedding queue (all|user|status|deadletter)",
		Run:     reembedRun,
	})
	registerReembedSub("all", reembedAllRun)
	registerReembedSub("user", reembedUserRun)
	registerReembedSub("status", reembedStatusRun)
	registerReembedSub("deadletter", reembedDeadletterRun)
}

func reembedRun(ctx context.Context, env Env, args []string) error {
	if len(args) == 0 {
		writeReembedUsage(env.Stderr)
		return errors.New("subcommand required")
	}
	name := args[0]
	if name == "help" || name == "-h" || name == "--help" {
		writeReembedUsage(env.Stdout)
		return flag.ErrHelp
	}
	fn, ok := reembedSubcommands[name]
	if !ok {
		writeReembedUsage(env.Stderr)
		return errors.New("unknown subcommand")
	}
	return fn(ctx, env, args[1:])
}

func writeReembedUsage(w io.Writer) {
	names := make([]string, 0, len(reembedSubcommands))
	for n := range reembedSubcommands {
		names = append(names, n)
	}
	sort.Strings(names)
	_, _ = fmt.Fprintln(w, "usage: worker reembed <subcommand> [flags]")
	for _, n := range names {
		_, _ = fmt.Fprintf(w, "  %s\n", n)
	}
	_, _ = fmt.Fprintln(w, "  all [--generation N] [--dry-run] | user --user <uuid> [--dry-run] | status | deadletter list|retry [--generation N]")
	_, _ = fmt.Fprintln(w, "  applying all/user needs semantic search enabled and a non-noop provider; --dry-run, status and deadletter list always work")
}

// safeErr turns a database/library error into a privacy-safe one: the registry
// prints "reembed: <err>", so nothing from the underlying message is kept.
func safeErr(what string, err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s: canceled", what)
	}
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		return fmt.Errorf("%s: database error (sqlstate %s)", what, pe.Code)
	}
	return fmt.Errorf("%s: failed", what)
}

// errReembedFlags is the only error a malformed command line produces: the
// flag package echoes rejected values and flag names (which may be pasted names,
// hints, queries or secrets), so its diagnostics are never printed or returned.
var errReembedFlags = errors.New("invalid flags (run 'worker reembed help' for usage)")

// errReembedEnqueueDisabled is returned when an applying run is requested while
// the deployment does not enqueue embeddings (SPEC 6.6/6.10).
var errReembedEnqueueDisabled = errors.New("embedding enqueue is disabled in this deployment (semantic search off or noop provider); nothing was written, use --dry-run to inspect")

// parseReembedFlags parses args into fs without letting the flag package write
// anything: its output is discarded and its error is replaced by a fixed
// privacy-safe one. -h/--help prints the safe usage on stdout and returns
// flag.ErrHelp (dispatch exits 0 and prints nothing more).
func parseReembedFlags(fs *flag.FlagSet, env Env, args []string) error {
	fs.SetOutput(io.Discard)
	fs.Usage = func() {}
	err := fs.Parse(args)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, flag.ErrHelp):
		writeReembedUsage(env.Stdout)
		return flag.ErrHelp
	default:
		return errReembedFlags
	}
}

// enqueueAllowed reports whether the deployment enqueues embeddings: semantic
// search enabled and a configured non-noop provider (same rule as the worker
// boot wiring).
func enqueueAllowed(cfg *config.Config) bool {
	return cfg != nil && cfg.SearchSemanticEnabled &&
		cfg.EmbeddingProvider != "" && cfg.EmbeddingProvider != embedding.ProviderNoop
}

func reembedPool(ctx context.Context, env Env) (*pgxpool.Pool, error) {
	if env.Cfg == nil || env.Cfg.DatabaseURL == "" {
		return nil, errors.New("database is not configured")
	}
	pool, err := db.NewPool(ctx, env.Cfg.DatabaseURL)
	if err != nil {
		return nil, errors.New("cannot open the database pool")
	}
	return pool, nil
}

// reembedInsertClient builds an insert-only River client (no queues, no workers).
func reembedInsertClient(pool *pgxpool.Pool) (*river.Client[pgx.Tx], error) {
	c, err := river.NewClient(riverpgxv5.New(pool), &river.Config{SkipUnknownJobCheck: true})
	if err != nil {
		return nil, errors.New("cannot build the job client")
	}
	return c, nil
}

// receivingTargets returns R, or only generation genID (> 0) when it is in R.
func receivingTargets(ctx context.Context, pool *pgxpool.Pool, genID int) ([]generation.Generation, error) {
	gens, err := generation.ReceivingGenerations(ctx, pool)
	if err != nil {
		return nil, safeErr("read receiving generations", err)
	}
	if genID <= 0 {
		return gens, nil
	}
	for _, g := range gens {
		if g.ID == genID {
			return []generation.Generation{g}, nil
		}
	}
	return nil, fmt.Errorf("generation %d is not in the receiving set", genID)
}

func reembedAllRun(ctx context.Context, env Env, args []string) error {
	fs := flag.NewFlagSet("reembed all", flag.ContinueOnError)
	genID := fs.Int("generation", 0, "reconcile only this generation id (must be in the receiving set)")
	dry := fs.Bool("dry-run", false, "count what would change; write nothing")
	if err := parseReembedFlags(fs, env, args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return errors.New("unexpected positional arguments")
	}
	if *genID < 0 {
		return errors.New("--generation must be a positive id")
	}
	return reembedReconcile(ctx, env, *genID, reconcile.All(), *dry)
}

func reembedUserRun(ctx context.Context, env Env, args []string) error {
	fs := flag.NewFlagSet("reembed user", flag.ContinueOnError)
	userRaw := fs.String("user", "", "user UUID (never an email)")
	dry := fs.Bool("dry-run", false, "count what would change; write nothing")
	if err := parseReembedFlags(fs, env, args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return errors.New("unexpected positional arguments")
	}
	if *userRaw == "" {
		return errors.New("--user is required")
	}
	uid, err := uuid.Parse(*userRaw)
	if err != nil || uid == uuid.Nil {
		return errors.New("--user must be a user UUID")
	}
	return reembedReconcile(ctx, env, 0, reconcile.User(uid), *dry)
}

// reembedReconcile runs Reconcile synchronously in this process for every
// targeted generation and prints counts only. A dry run writes nothing and is
// always allowed; an applying run honours the deployment enqueue gate (SPEC
// 6.6/6.10): with semantic search disabled or a noop provider it refuses before
// touching the database, with no operator override.
func reembedReconcile(ctx context.Context, env Env, genID int, scope reconcile.Scope, dry bool) error {
	if !dry && !enqueueAllowed(env.Cfg) {
		return errReembedEnqueueDisabled
	}
	pool, err := reembedPool(ctx, env)
	if err != nil {
		return err
	}
	defer pool.Close()

	gens, err := receivingTargets(ctx, pool, genID)
	if err != nil {
		return err
	}

	mode := reconcile.ModeEnqueue
	var enq reconcile.EnqueueFunc
	if dry {
		mode = reconcile.ModeDryRun
	} else {
		client, err := reembedInsertClient(pool)
		if err != nil {
			return err
		}
		enq = jobs.ReembedEnqueueFunc(jobs.RiverClientInserter{Client: client})
	}

	_, _ = fmt.Fprintf(env.Stdout, "mode=%s generations=%d\n", mode, len(gens))
	for _, g := range gens {
		res, err := reconcile.Reconcile(ctx, pool, g, scope, mode, enq)
		if err != nil {
			return safeErr(fmt.Sprintf("generation %d reconcile", g.ID), err)
		}
		printReconcileResult(env.Stdout, g.ID, res)
	}
	return nil
}

func printReconcileResult(w io.Writer, genID int, r reconcile.Result) {
	_, _ = fmt.Fprintf(w,
		"generation=%d scanned=%d missing=%d stale=%d enqueued=%d orphan_deleted=%d user_off_deleted=%d skipped_user_off=%d would_enqueue=%d would_delete_orphan=%d would_delete_user_off=%d",
		genID, r.Scanned, r.Missing, r.Stale, r.Enqueued, r.OrphanDeleted, r.UserOffDeleted, r.SkippedUserOff,
		r.WouldEnqueue, r.WouldDeleteOrphan, r.WouldDeleteUserOff)
	if r.StopReason != "" {
		_, _ = fmt.Fprintf(w, " stop_reason=%s", r.StopReason)
	}
	_, _ = fmt.Fprintln(w)
}

// riverJobStates lists every River job state in print order.
var riverJobStates = []string{"available", "pending", "retryable", "running", "scheduled", "completed", "discarded", "cancelled"}

func reembedStatusRun(ctx context.Context, env Env, args []string) error {
	fs := flag.NewFlagSet("reembed status", flag.ContinueOnError)
	if err := parseReembedFlags(fs, env, args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return errors.New("unexpected positional arguments")
	}
	pool, err := reembedPool(ctx, env)
	if err != nil {
		return err
	}
	defer pool.Close()

	gens, err := generation.ExistingGenerations(ctx, pool)
	if err != nil {
		return safeErr("read generations", err)
	}
	for _, g := range gens {
		line := fmt.Sprintf("generation=%d state=%s provider=%s", g.ID, g.State, g.Provider)
		for _, kind := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
			vectors, targets, err := coverage(ctx, pool, g, kind)
			if err != nil {
				return safeErr(fmt.Sprintf("generation %d coverage", g.ID), err)
			}
			pct := 100.0
			if targets > 0 {
				pct = float64(vectors) * 100 / float64(targets)
			}
			line += fmt.Sprintf(" %s_vectors=%d %s_targets=%d %s_coverage_pct=%.1f", kind, vectors, kind, targets, kind, pct)
		}
		_, _ = fmt.Fprintln(env.Stdout, line)
	}

	counts, err := queueStateCounts(ctx, pool)
	if err != nil {
		return safeErr("read queue depth", err)
	}
	for _, st := range riverJobStates {
		_, _ = fmt.Fprintf(env.Stdout, "queue=%s state=%s count=%d\n", jobs.QueueEmbedding, st, counts[st])
	}

	var lag int64
	if err := pool.QueryRow(ctx,
		`SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(scheduled_at)))::bigint, 0)
		 FROM river_job WHERE queue = $1 AND state = 'available'`, jobs.QueueEmbedding).Scan(&lag); err != nil {
		return safeErr("read queue lag", err)
	}
	_, _ = fmt.Fprintf(env.Stdout, "oldest_available_age_seconds=%d\n", lag)

	var dead int
	if err := pool.QueryRow(ctx,
		`SELECT count(*)::int FROM river_job WHERE state = 'discarded' AND kind = ANY($1::text[])`,
		deadLetterKinds()).Scan(&dead); err != nil {
		return safeErr("read dead-letter count", err)
	}
	_, _ = fmt.Fprintf(env.Stdout, "dead_letter_count=%d\n", dead)
	return nil
}

// coverage counts live targets of eligible users (per BE-3 for openai_compat)
// and how many of them hold a vector in g's corpus table.
func coverage(ctx context.Context, pool *pgxpool.Pool, g generation.Generation, kind generation.Corpus) (vectors, targets int, err error) {
	tbl, err := store.SanitizedTable(g, kind)
	if err != nil {
		return 0, 0, err
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
		return 0, 0, err
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*)::int FROM `+target+` t JOIN `+tbl+` e ON e.user_id = t.user_id AND e.target_id = t.id`+eligible,
		external).Scan(&vectors); err != nil {
		return 0, 0, err
	}
	return vectors, targets, nil
}

func queueStateCounts(ctx context.Context, pool *pgxpool.Pool) (map[string]int, error) {
	rows, err := pool.Query(ctx,
		`SELECT state::text, count(*)::int FROM river_job WHERE queue = $1 GROUP BY 1`, jobs.QueueEmbedding)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var st string
		var n int
		if err := rows.Scan(&st, &n); err != nil {
			return nil, err
		}
		out[st] = n
	}
	return out, rows.Err()
}

func deadLetterKinds() []string {
	return []string{jobargs.KindEmbedItem, jobargs.KindEmbedTag}
}

func reembedDeadletterRun(ctx context.Context, env Env, args []string) error {
	if len(args) == 0 {
		return errors.New("deadletter needs list or retry")
	}
	action := args[0]
	if action != "list" && action != "retry" {
		return errors.New("deadletter needs list or retry")
	}
	fs := flag.NewFlagSet("reembed deadletter "+action, flag.ContinueOnError)
	genID := fs.Int("generation", 0, "only jobs of this generation id")
	if err := parseReembedFlags(fs, env, args[1:]); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return errors.New("unexpected positional arguments")
	}
	if *genID < 0 {
		return errors.New("--generation must be a positive id")
	}

	pool, err := reembedPool(ctx, env)
	if err != nil {
		return err
	}
	defer pool.Close()

	// The generation filter reads args in SQL only; args are never selected.
	const filter = `state = 'discarded' AND kind = ANY($1::text[])
		AND ($2::int = 0 OR (args->>'generation_id')::int = $2::int)`

	if action == "list" {
		var total int
		if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM river_job WHERE `+filter,
			deadLetterKinds(), *genID).Scan(&total); err != nil {
			return safeErr("count dead letters", err)
		}
		ids, err := deadLetterIDs(ctx, pool, *genID, maxDeadLetterListed)
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintf(env.Stdout, "dead_letter_count=%d listed=%d\n", total, len(ids))
		for _, id := range ids {
			_, _ = fmt.Fprintf(env.Stdout, "job_id=%d\n", id)
		}
		return nil
	}

	ids, err := deadLetterIDs(ctx, pool, *genID, 0)
	if err != nil {
		return err
	}
	client, err := reembedInsertClient(pool)
	if err != nil {
		return err
	}
	retried, failed := 0, 0
	for _, id := range ids {
		if _, err := client.JobRetry(ctx, id); err != nil {
			failed++
			continue
		}
		retried++
	}
	_, _ = fmt.Fprintf(env.Stdout, "dead_letter_found=%d retried=%d failed=%d\n", len(ids), retried, failed)
	if failed > 0 {
		return errors.New("some dead-letter jobs could not be retried")
	}
	return nil
}

// deadLetterIDs returns discarded embed_item/embed_tag job ids (limit 0 = all).
func deadLetterIDs(ctx context.Context, pool *pgxpool.Pool, genID, limit int) ([]int64, error) {
	rows, err := pool.Query(ctx,
		`SELECT id FROM river_job
		 WHERE state = 'discarded' AND kind = ANY($1::text[])
		   AND ($2::int = 0 OR (args->>'generation_id')::int = $2::int)
		 ORDER BY id ASC
		 LIMIT CASE WHEN $3::int > 0 THEN $3::int ELSE NULL END`,
		deadLetterKinds(), genID, limit)
	if err != nil {
		return nil, safeErr("list dead letters", err)
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, safeErr("list dead letters", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, safeErr("list dead letters", err)
	}
	return ids, nil
}
