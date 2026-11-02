package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pgvector/pgvector-go"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/reconcile"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
)

// Verify reason codes (VerifyReport.Reason).
const (
	ReasonOK                 = "ok"
	ReasonIndexNotReady      = "index_not_ready"
	ReasonJobsPending        = "jobs_pending"
	ReasonCoverageIncomplete = "coverage_incomplete"
	ReasonIntegrity          = "integrity_failed"
	ReasonRecallBelowTarget  = "recall_below_target"
	ReasonNotReceiving       = "generation_not_receiving"
	// ReasonRecallSampleShort: fewer sample vectors could be read than requested
	// although enough exist (GL-2). The generation is never passed on a short sample.
	ReasonRecallSampleShort = "recall_sample_short"
	// ReasonRecallBaseline: no exact recall baseline could be obtained (GL-4).
	ReasonRecallBaseline = "recall_baseline_unavailable"
	// ReasonRecallPath: the measured query did not take the ANN path (GL-4).
	ReasonRecallPath = "recall_path_invalid"
)

const (
	// RecallSampleSize is the plan sample of query vectors (N4/FS-33).
	RecallSampleSize = 200
	// RecallK is the K of recall@K (docs/benchmarks/P05-search/targets.md).
	RecallK = 20
	// RecallMean is the C2-R target: mean recall per corpus.
	RecallMean = 0.95
	// RecallPerQueryMin and RecallPerQueryShare are the C2-Q target: at least
	// 95 % of queries reach recall >= 0.80.
	RecallPerQueryMin   = 0.80
	RecallPerQueryShare = 0.95
)

// VerifyOpts tunes Verify. The zero value is production behaviour.
type VerifyOpts struct {
	// Now is a legacy injectable clock; verification itself reads the database
	// clock (watermark) and does not use it.
	Now func() time.Time
	// RecallSampleSize overrides RecallSampleSize (0 = default). Recall is
	// skipped when the generation holds fewer vectors than this.
	RecallSampleSize int
	// BranchTimeout bounds each vector query of the recall sample (0 = 5 s). The
	// exact baseline reads every vector of the sampled tenant: when it cannot
	// finish in time (a very large tenant) verification fails with
	// ReasonRecallBaseline rather than passing without an exact oracle.
	BranchTimeout time.Duration
	// AfterWatermark is a test-only hook called right after the watermark is
	// taken and the exclusive lock released.
	AfterWatermark func()
	// AfterSampleCount is a test-only hook called once the recall sample has been
	// sized (row counts read) and before the sample is read (GL-2).
	AfterSampleCount func()
}

// CoverageReport is the aggregate result of reconcile.Reconcile(All, DryRun)
// over both corpora (counts only; Reconcile does not split by corpus).
type CoverageReport struct {
	Scanned            int  `json:"scanned"`
	Missing            int  `json:"missing"`
	Stale              int  `json:"stale"`
	WouldDeleteOrphan  int  `json:"orphan"`
	WouldDeleteUserOff int  `json:"user_off"`
	SkippedUserOff     int  `json:"skipped_user_off"`
	Complete           bool `json:"complete"`
}

// RecallReport summarises the ANN-vs-exact recall sample (counts and ratios
// only).
type RecallReport struct {
	// Requested is the sample size asked for; Sampled the vectors actually used.
	Requested      int     `json:"requested"`
	Sampled        int     `json:"sampled"`
	Eligible       int     `json:"eligible"`
	MeanRecall     float64 `json:"mean_recall"`
	QueryShareOK   float64 `json:"query_share_ok"`
	FalsePositives int     `json:"false_positives"`
	K              int     `json:"k"`
	Passed         bool    `json:"passed"`
}

// VerifyReport is persisted to embedding_generation.verify_report. It holds
// counts, ratios and reason codes only.
type VerifyReport struct {
	GenerationID int `json:"generation_id"`
	// ItemRows and TagRows are the vector row counts (capped at 1 000 000).
	ItemRows int `json:"item_rows"`
	TagRows  int `json:"tag_rows"`
	// Coverage is the dry-run result.
	Coverage CoverageReport `json:"coverage"`
	// DimsOK: stored vector columns have the generation's declared dims.
	DimsOK bool `json:"dims_ok"`
	// PartitionsOK: both corpora have the declared number of partitions.
	PartitionsOK bool `json:"partitions_ok"`
	// IndexReady: every per-partition index is valid.
	IndexReady bool `json:"index_ready"`
	// Recall is nil when skipped (see RecallSkippedBelow200).
	Recall *RecallReport `json:"recall"`
	// RecallSkippedBelow200 is true when the generation holds < 200 vectors.
	RecallSkippedBelow200 bool `json:"recall_skipped_below_200"`
	// JobsPendingBeforeWatermark counts embed_item/embed_tag jobs of this
	// generation created before Watermark in available, retryable, running,
	// scheduled or pending.
	JobsPendingBeforeWatermark int       `json:"jobs_pending_before_watermark"`
	Watermark                  time.Time `json:"watermark"`
	Passed                     bool      `json:"passed"`
	// Reason is one of the Reason* codes.
	Reason string `json:"reason"`
}

// Verify is plan 2.15 step 4. Under a watermark W taken briefly under the
// exclusive generation lock it checks (a) no embed job of this generation
// created before W is still available/retryable/running/scheduled/pending,
// (b) reconcile.Reconcile(All, ModeDryRun, nil) reports no missing, stale or
// orphan vectors (and no user-off vectors for openai_compat), (c) integrity
// (dims, partitions, per-partition indexes), (d) recall of a sample of up to
// 200 stored vectors (ANN vs exact) meets C2 - skipped below 200 vectors; the
// other checks still apply. The report (counts only) is persisted via
// SetEmbeddingGenerationVerified whether it passed or not. Returns
// ErrNotPending when the generation is not pending.
func Verify(ctx context.Context, pool *pgxpool.Pool, genID int, opts VerifyOpts) (VerifyReport, error) {
	if pool == nil {
		return VerifyReport{}, generation.ErrNilTx
	}
	g, err := getPending(ctx, pool, genID)
	if err != nil {
		return VerifyReport{}, err
	}
	return verifyGeneration(ctx, pool, g, opts, generation.StatePending)
}

// verifyGeneration runs the step-4 checks for g, which must currently be in
// state want (pending for Verify, retired for Rollback), and persists the
// report.
func verifyGeneration(
	ctx context.Context,
	pool *pgxpool.Pool,
	g0 generation.Generation,
	opts VerifyOpts,
	want string,
) (VerifyReport, error) {
	w, g, err := takeWatermark(ctx, pool, g0.ID)
	if err != nil {
		return VerifyReport{}, err
	}
	if g.State != want {
		if want == generation.StateRetired {
			return VerifyReport{}, ErrNotRetired
		}
		return VerifyReport{}, ErrNotPending
	}
	if opts.AfterWatermark != nil {
		opts.AfterWatermark()
	}

	rep := VerifyReport{GenerationID: g.ID, Watermark: w.UTC()}

	parts, err := partitionTables(g)
	if err != nil {
		return VerifyReport{}, err
	}
	validIdx, err := countValidPartitionIndexes(ctx, pool, parts)
	if err != nil {
		return VerifyReport{}, err
	}
	rep.IndexReady = validIdx == len(parts)

	rep.JobsPendingBeforeWatermark, err = countEmbedJobs(ctx, pool, g.ID, &w)
	if err != nil {
		return VerifyReport{}, err
	}

	rep.Coverage, err = coverageOf(ctx, pool, g)
	if err != nil {
		return VerifyReport{}, err
	}

	if err := integrityOf(ctx, pool, g, &rep); err != nil {
		return VerifyReport{}, err
	}

	switch {
	case !rep.IndexReady:
		rep.Reason = ReasonIndexNotReady
	case rep.JobsPendingBeforeWatermark > 0:
		rep.Reason = ReasonJobsPending
	case !rep.Coverage.Complete:
		rep.Reason = ReasonCoverageIncomplete
	case !rep.DimsOK || !rep.PartitionsOK:
		rep.Reason = ReasonIntegrity
	default:
		rep.Reason = ReasonOK
	}

	if rep.Reason == ReasonOK {
		sample := opts.RecallSampleSize
		if sample <= 0 {
			sample = RecallSampleSize
		}
		if rep.ItemRows+rep.TagRows < sample {
			// N4/FS-33: too few vectors for a meaningful recall sample; the
			// coverage and integrity checks above still gate the flip.
			rep.RecallSkippedBelow200 = true
		} else {
			rr, err := recallOf(ctx, pool, g, sample, opts.BranchTimeout, opts.AfterSampleCount)
			switch {
			case errors.Is(err, errRecallSampleShort):
				rep.Recall, rep.Reason = &rr, ReasonRecallSampleShort
			case errors.Is(err, errRecallBaseline):
				rep.Recall, rep.Reason = &rr, ReasonRecallBaseline
			case errors.Is(err, errRecallPath):
				rep.Recall, rep.Reason = &rr, ReasonRecallPath
			case err != nil:
				return VerifyReport{}, err
			default:
				rep.Recall = &rr
				if !rr.Passed {
					rep.Reason = ReasonRecallBelowTarget
				}
			}
		}
	}
	rep.Passed = rep.Reason == ReasonOK

	blob, err := json.Marshal(rep)
	if err != nil {
		return VerifyReport{}, err
	}
	if _, err := gen.New(pool).SetEmbeddingGenerationVerified(ctx, gen.SetEmbeddingGenerationVerifiedParams{
		VerifyReport: blob,
		ID:           int32(g.ID),
	}); err != nil {
		return VerifyReport{}, err
	}
	return rep, nil
}

// takeWatermark briefly takes the exclusive generation lock so that every
// mutation already in flight has committed (and fanned out to g, which is in
// R), reads W from the database clock and re-reads g in the same transaction.
// The lock is released before any verification work runs.
func takeWatermark(ctx context.Context, pool *pgxpool.Pool, genID int) (time.Time, generation.Generation, error) {
	tx, err := beginExclusive(ctx, pool)
	if err != nil {
		return time.Time{}, generation.Generation{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	g, err := generation.GetByID(ctx, tx, genID)
	if err != nil {
		return time.Time{}, generation.Generation{}, err
	}
	var w time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&w); err != nil {
		return time.Time{}, generation.Generation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return time.Time{}, generation.Generation{}, err
	}
	return w, g, nil
}

// coverageOf runs reconcile.Reconcile(All, ModeDryRun, nil) directly (BE-11,
// M2): it writes nothing and enqueues nothing. Complete means every eligible
// live target has a current vector and no vector of a deleted target (and, for
// openai_compat, of a user-off user) remains.
func coverageOf(ctx context.Context, pool *pgxpool.Pool, g generation.Generation) (CoverageReport, error) {
	res, err := reconcile.Reconcile(ctx, pool, g, reconcile.All(), reconcile.ModeDryRun, nil)
	if err != nil {
		return CoverageReport{}, fmt.Errorf("lifecycle: coverage dry run failed: %w", sanitizeDBErr(err))
	}
	cov := CoverageReport{
		Scanned:            res.Scanned,
		Missing:            res.Missing,
		Stale:              res.Stale,
		WouldDeleteOrphan:  res.WouldDeleteOrphan,
		WouldDeleteUserOff: res.WouldDeleteUserOff,
		SkippedUserOff:     res.SkippedUserOff,
	}
	cov.Complete = res.StopReason == "" &&
		res.Missing+res.Stale == 0 &&
		res.WouldDeleteOrphan == 0 &&
		(g.Provider != generation.ProviderOpenAICompat || res.WouldDeleteUserOff == 0)
	return cov, nil
}

// rowCountCap bounds the per-corpus row counts of the report.
const rowCountCap = 1000000

// integrityOf fills rows, dims_ok and partitions_ok of rep.
func integrityOf(ctx context.Context, pool *pgxpool.Pool, g generation.Generation, rep *VerifyReport) error {
	rep.DimsOK = true
	rep.PartitionsOK = true
	for _, corpus := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		tbl, err := store.SanitizedTable(g, corpus)
		if err != nil {
			return err
		}
		var rows int
		// #nosec G202 -- tbl is validated against allowlist ^(item|tag)_embedding_g[1-9][0-9]{0,3}$ and quoted via pgx.Identifier.Sanitize().
		if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM (SELECT 1 FROM `+tbl+` LIMIT $1) s`, rowCountCap).Scan(&rows); err != nil {
			return fmt.Errorf("lifecycle: row count failed: %w", sanitizeDBErr(err))
		}
		var typmod int
		if err := pool.QueryRow(ctx, `
SELECT a.atttypmod FROM pg_attribute a
WHERE a.attrelid = to_regclass($1) AND a.attname = 'embedding' AND NOT a.attisdropped`, tbl).Scan(&typmod); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				rep.DimsOK = false
			} else {
				return fmt.Errorf("lifecycle: dims check failed: %w", sanitizeDBErr(err))
			}
		} else if typmod != g.Dims {
			rep.DimsOK = false
		}
		var parts int
		if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM pg_inherits WHERE inhparent = to_regclass($1)`, tbl).Scan(&parts); err != nil {
			return fmt.Errorf("lifecycle: partition check failed: %w", sanitizeDBErr(err))
		}
		if parts != g.Partitions {
			rep.PartitionsOK = false
		}
		if corpus == generation.CorpusItem {
			rep.ItemRows = rows
		} else {
			rep.TagRows = rows
		}
	}
	return nil
}

// recallOf measures ANN recall@RecallK against an exact oracle for a sample of
// vectors read from g's own tables (no provider call). Per
// docs/benchmarks/P05-search/targets.md: E = exact top-min(20, eligible) after
// the min_cos threshold; queries with |E| = 0 are excluded and must return no
// ANN rows (false positives). Each corpus must reach mean recall >= RecallMean
// and >= RecallPerQueryShare of queries with recall >= RecallPerQueryMin; the
// report carries the worst corpus.
//
// The sample (GL-2) is up to `sample` distinct stored vectors spread over the
// populated corpora by key position (sampleVectors); a sample shorter than
// requested while enough vectors exist fails with errRecallSampleShort.
//
// The oracle (GL-4) is store.ExactSearchSQL run directly, never the search
// router: its MATERIALIZED primary-key CTE cannot be planned onto the HNSW
// index whatever the tenant size, so an exact baseline either is exact or is not
// obtained (errRecallBaseline). The measured side must take the ANN path
// (errRecallPath otherwise), so a passing report can never be ANN-vs-ANN or
// exact-vs-exact. The report is returned alongside those errors so the caller
// can persist a failing report with an explicit reason.
func recallOf(ctx context.Context, pool *pgxpool.Pool, g generation.Generation, sample int, branchTimeout time.Duration, afterSampleCount func()) (RecallReport, error) {
	if branchTimeout <= 0 {
		branchTimeout = 5 * time.Second
	}
	pin, err := generation.PinFromGeneration(g)
	if err != nil {
		return RecallReport{}, err
	}
	annKnobs := store.VectorSearchKnobs{
		ExactMaxVectors:    0, // force ANN
		FallbackMaxVectors: 0, // no exact fallback: measure the index itself
		BranchTimeout:      branchTimeout,
	}

	out := RecallReport{K: RecallK, Requested: sample, Passed: true, MeanRecall: 1, QueryShareOK: 1}
	corpora := []generation.Corpus{generation.CorpusItem, generation.CorpusTag}
	var counts [2]int64
	for i, corpus := range corpora {
		tbl, err := store.SanitizedTable(g, corpus)
		if err != nil {
			return RecallReport{}, err
		}
		if counts[i], err = exactRowCount(ctx, pool, tbl); err != nil {
			return RecallReport{}, err
		}
	}
	quotas := splitRecallQuota(counts[0], counts[1], sample)
	if afterSampleCount != nil {
		afterSampleCount()
	}
	if quotas[0]+quotas[1] < sample {
		out.Passed = false
		return out, errRecallSampleShort
	}

	for i, corpus := range corpora {
		qs, err := sampleVectors(ctx, pool, g, corpus, counts[i], quotas[i])
		if err != nil {
			return RecallReport{}, err
		}
		out.Sampled += len(qs)
		if len(qs) < quotas[i] {
			out.Passed = false
			return out, errRecallSampleShort
		}
		var eligible, good int
		var sum float64
		for _, q := range qs {
			want, err := exactTopK(ctx, pool, g, corpus, q.userID, q.vec, pin.MinCos, RecallK, branchTimeout)
			if err != nil {
				out.Passed = false
				return out, err
			}
			ann, as, err := store.VectorSearch(ctx, pool, pin, q.userID, corpus, q.vec, RecallK, time.Now().Add(branchTimeout), annKnobs)
			if err != nil {
				return RecallReport{}, fmt.Errorf("lifecycle: recall ann query failed: %w", sanitizeDBErr(err))
			}
			if as.TimedOut {
				return RecallReport{}, errors.New("lifecycle: recall sample query timed out")
			}
			if as.Path != store.VectorPathANN && as.Path != store.VectorPathANNShort {
				out.Passed = false
				return out, errRecallPath
			}
			if len(want) == 0 {
				if len(ann) > 0 {
					out.FalsePositives++
				}
				continue
			}
			hit := 0
			for _, h := range ann {
				if _, ok := want[h.ID]; ok {
					hit++
				}
			}
			r := float64(hit) / float64(len(want))
			eligible++
			sum += r
			if r >= RecallPerQueryMin {
				good++
			}
		}
		out.Eligible += eligible
		if eligible == 0 {
			continue
		}
		mean := sum / float64(eligible)
		share := float64(good) / float64(eligible)
		if mean < out.MeanRecall {
			out.MeanRecall = mean
		}
		if share < out.QueryShareOK {
			out.QueryShareOK = share
		}
		if mean < RecallMean || share < RecallPerQueryShare {
			out.Passed = false
		}
	}
	if out.FalsePositives > 0 {
		out.Passed = false
	}
	return out, nil
}

// Recall failures that are reported (counts and a reason code), not returned as
// errors by Verify.
var (
	errRecallSampleShort = errors.New("lifecycle: recall sample shorter than requested")
	errRecallBaseline    = errors.New("lifecycle: exact recall baseline unavailable")
	errRecallPath        = errors.New("lifecycle: recall query did not take the ANN path")
)

// splitRecallQuota splits a sample of size want between the item and tag
// corpora holding items and tags vectors: half each when both are populated,
// the rest filled from whichever corpus still has vectors. The quotas sum to
// want whenever items+tags >= want, and never exceed a corpus' size.
func splitRecallQuota(items, tags int64, want int) [2]int {
	if want <= 0 {
		return [2]int{}
	}
	minInt64 := func(a, b int64) int64 {
		if a < b {
			return a
		}
		return b
	}
	w := int64(want)
	qTag := minInt64(tags, (w+1)/2)
	qItem := minInt64(items, w-qTag)
	qTag = minInt64(tags, w-qItem)
	return [2]int{int(qItem), int(qTag)}
}

// exactTopK is the exact oracle: store.ExactSearchSQL (tenant-scoped, live
// targets, min_cos threshold, dist/id order, LIMIT k) run directly in a
// read-only transaction with a statement timeout. A statement timeout means no
// exact baseline could be obtained (errRecallBaseline).
func exactTopK(
	ctx context.Context,
	pool *pgxpool.Pool,
	g generation.Generation,
	corpus generation.Corpus,
	userID uuid.UUID,
	qvec []float32,
	minCos float64,
	k int,
	timeout time.Duration,
) (map[uuid.UUID]struct{}, error) {
	query, err := exactOracleSQL(g, corpus)
	if err != nil {
		return nil, err
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("lifecycle: recall exact begin failed: %w", sanitizeDBErr(err))
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('statement_timeout', $1, true)", strconv.FormatInt(timeout.Milliseconds(), 10)+"ms"); err != nil {
		return nil, fmt.Errorf("lifecycle: recall exact timeout failed: %w", sanitizeDBErr(err))
	}
	rows, err := tx.Query(ctx, query, userID, pgvector.NewVector(qvec), minCos, k)
	if err != nil {
		return nil, exactErr(err)
	}
	defer rows.Close()
	want := make(map[uuid.UUID]struct{}, k)
	for rows.Next() {
		// Column 0 is the target id; the remaining six (name/display, count,
		// timestamps, dist, cos) are discarded and never retained or logged.
		var id uuid.UUID
		var skip [6]any
		dest := make([]any, 0, 7)
		dest = append(dest, &id)
		for i := range skip {
			dest = append(dest, &skip[i])
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, fmt.Errorf("lifecycle: recall exact scan failed: %w", sanitizeDBErr(err))
		}
		want[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, exactErr(err)
	}
	return want, nil
}

// exactErr classifies a failed exact query: a statement timeout (SQLSTATE
// 57014) is "no exact baseline" (reported), anything else an error.
func exactErr(err error) error {
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "57014" {
		return errRecallBaseline
	}
	return fmt.Errorf("lifecycle: recall exact query failed: %w", sanitizeDBErr(err))
}

// exactOracleSQL returns the SQL of the exact oracle for corpus of g. It is
// store.ExactSearchSQL (never the VectorSearch router) and is asserted to be the
// materialized primary-key form that the planner cannot move onto HNSW.
func exactOracleSQL(g generation.Generation, corpus generation.Corpus) (string, error) {
	tbl, err := store.SanitizedTable(g, corpus)
	if err != nil {
		return "", err
	}
	query, err := store.ExactSearchSQL(tbl, corpus)
	if err != nil {
		return "", err
	}
	if !strings.Contains(query, "AS MATERIALIZED") || !strings.Contains(query, "ORDER BY user_id, target_id") {
		return "", errRecallBaseline
	}
	return query, nil
}

type sampledVector struct {
	userID   uuid.UUID
	targetID uuid.UUID
	vec      []float32
}

// exactRowCount counts the rows of tbl without a cap (primary-key scan).
func exactRowCount(ctx context.Context, db gen.DBTX, tbl string) (int64, error) {
	var n int64
	// #nosec G202 -- tbl is validated against allowlist ^(item|tag)_embedding_g[1-9][0-9]{0,3}$ and quoted via pgx.Identifier.Sanitize().
	if err := db.QueryRow(ctx, `SELECT count(*)::bigint FROM `+tbl).Scan(&n); err != nil {
		return 0, fmt.Errorf("lifecycle: row count failed: %w", sanitizeDBErr(err))
	}
	return n, nil
}

// sampleVectors reads quota distinct stored vectors of corpus (which holds n
// rows) at evenly spaced positions of the (user_id, target_id) key order:
// position i is 1 + floor(i*n/quota). That is deterministic, spreads the sample
// over every tenant and the whole key range (a single tenant included), and
// needs one pass over the keys only. quota > n yields fewer rows (the caller
// fails the verification). The vectors are the generation's own, so no provider
// is called.
func sampleVectors(ctx context.Context, pool *pgxpool.Pool, g generation.Generation, corpus generation.Corpus, n int64, quota int) ([]sampledVector, error) {
	if quota <= 0 || n <= 0 {
		return nil, nil
	}
	tbl, err := store.SanitizedTable(g, corpus)
	if err != nil {
		return nil, err
	}
	// #nosec G202 -- tbl is validated against allowlist ^(item|tag)_embedding_g[1-9][0-9]{0,3}$ and quoted via pgx.Identifier.Sanitize().
	rows, err := pool.Query(ctx, `
WITH pos AS (
  SELECT 1 + (i * $1::bigint) / $2::bigint AS rn FROM generate_series(0::bigint, $2::bigint - 1) AS i
), keyed AS (
  SELECT user_id, target_id, row_number() OVER (ORDER BY user_id, target_id) AS rn FROM `+tbl+`
)
SELECT e.user_id, e.target_id, e.embedding::text
FROM keyed k
JOIN pos p ON p.rn = k.rn
JOIN `+tbl+` e ON e.user_id = k.user_id AND e.target_id = k.target_id
ORDER BY e.user_id, e.target_id`, n, int64(quota))
	if err != nil {
		return nil, fmt.Errorf("lifecycle: recall sample failed: %w", sanitizeDBErr(err))
	}
	defer rows.Close()
	out := make([]sampledVector, 0, quota)
	for rows.Next() {
		var uid, tid uuid.UUID
		var txt string
		if err := rows.Scan(&uid, &tid, &txt); err != nil {
			return nil, fmt.Errorf("lifecycle: recall sample scan failed: %w", sanitizeDBErr(err))
		}
		vec, err := parseVectorText(txt)
		if err != nil {
			return nil, err
		}
		out = append(out, sampledVector{userID: uid, targetID: tid, vec: vec})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("lifecycle: recall sample failed: %w", sanitizeDBErr(err))
	}
	return out, nil
}

// parseVectorText parses pgvector's text form "[0.1,0.2,...]".
func parseVectorText(s string) ([]float32, error) {
	s = strings.TrimSpace(s)
	if len(s) < 2 || s[0] != '[' || s[len(s)-1] != ']' {
		return nil, errors.New("lifecycle: unexpected vector text")
	}
	body := s[1 : len(s)-1]
	if body == "" {
		return nil, errors.New("lifecycle: empty vector")
	}
	parts := strings.Split(body, ",")
	out := make([]float32, len(parts))
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 32)
		if err != nil {
			return nil, errors.New("lifecycle: unexpected vector text")
		}
		out[i] = float32(f)
	}
	return out, nil
}
