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
	"github.com/jackc/pgx/v5/pgxpool"

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
	// BranchTimeout bounds each vector query of the recall sample (0 = 5 s).
	BranchTimeout time.Duration
	// AfterWatermark is a test-only hook called right after the watermark is
	// taken and the exclusive lock released.
	AfterWatermark func()
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
			rr, err := recallOf(ctx, pool, g, sample, opts.BranchTimeout)
			if err != nil {
				return VerifyReport{}, err
			}
			rep.Recall = &rr
			if !rr.Passed {
				rep.Reason = ReasonRecallBelowTarget
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

// recallOf measures ANN recall@RecallK against the exact oracle for a sample of
// vectors read from g's own tables (no provider call). Per
// docs/benchmarks/P05-search/targets.md: E = exact top-min(20, eligible) after
// the min_cos threshold; queries with |E| = 0 are excluded and must return no
// ANN rows (false positives). Each corpus must reach mean recall >= RecallMean
// and >= RecallPerQueryShare of queries with recall >= RecallPerQueryMin; the
// report carries the worst corpus.
func recallOf(ctx context.Context, pool *pgxpool.Pool, g generation.Generation, sample int, branchTimeout time.Duration) (RecallReport, error) {
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
	exactKnobs := store.VectorSearchKnobs{
		ExactMaxVectors:    store.MaxExactCapVectors,
		FallbackMaxVectors: store.MaxExactCapVectors,
		BranchTimeout:      branchTimeout,
	}

	out := RecallReport{K: RecallK, Passed: true, MeanRecall: 1, QueryShareOK: 1}
	perCorpus := (sample + 1) / 2
	for _, corpus := range []generation.Corpus{generation.CorpusItem, generation.CorpusTag} {
		qs, err := sampleVectors(ctx, pool, g, corpus, perCorpus)
		if err != nil {
			return RecallReport{}, err
		}
		var eligible, good int
		var sum float64
		for _, q := range qs {
			out.Sampled++
			exact, es, err := store.VectorSearch(ctx, pool, pin, q.userID, corpus, q.vec, RecallK, time.Now().Add(branchTimeout), exactKnobs)
			if err != nil {
				return RecallReport{}, fmt.Errorf("lifecycle: recall exact query failed: %w", sanitizeDBErr(err))
			}
			ann, as, err := store.VectorSearch(ctx, pool, pin, q.userID, corpus, q.vec, RecallK, time.Now().Add(branchTimeout), annKnobs)
			if err != nil {
				return RecallReport{}, fmt.Errorf("lifecycle: recall ann query failed: %w", sanitizeDBErr(err))
			}
			if es.TimedOut || as.TimedOut {
				return RecallReport{}, errors.New("lifecycle: recall sample query timed out")
			}
			if len(exact) == 0 {
				if len(ann) > 0 {
					out.FalsePositives++
				}
				continue
			}
			want := make(map[uuid.UUID]struct{}, len(exact))
			for _, h := range exact {
				want[h.ID] = struct{}{}
			}
			hit := 0
			for _, h := range ann {
				if _, ok := want[h.ID]; ok {
					hit++
				}
			}
			r := float64(hit) / float64(len(exact))
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

type sampledVector struct {
	userID uuid.UUID
	vec    []float32
}

// sampleVectors reads up to quota stored vectors of corpus without a full scan:
// several short PK-ordered runs that start at random user ids. Duplicates are
// dropped. The vectors are the generation's own, so no provider is called.
func sampleVectors(ctx context.Context, pool *pgxpool.Pool, g generation.Generation, corpus generation.Corpus, quota int) ([]sampledVector, error) {
	tbl, err := store.SanitizedTable(g, corpus)
	if err != nil {
		return nil, err
	}
	const perRun = 10
	runs := (quota + perRun - 1) / perRun
	starts := make([]uuid.UUID, 0, runs+1)
	starts = append(starts, uuid.Nil)
	for len(starts) < runs+1 {
		starts = append(starts, uuid.New())
	}
	seen := make(map[[32]byte]struct{}, quota)
	var out []sampledVector
	for _, start := range starts {
		if len(out) >= quota {
			break
		}
		// #nosec G202 -- tbl is validated against allowlist ^(item|tag)_embedding_g[1-9][0-9]{0,3}$ and quoted via pgx.Identifier.Sanitize().
		rows, err := pool.Query(ctx, `SELECT user_id, target_id, embedding::text FROM `+tbl+
			` WHERE user_id >= $1 ORDER BY user_id, target_id LIMIT $2`, start, perRun)
		if err != nil {
			return nil, fmt.Errorf("lifecycle: recall sample failed: %w", sanitizeDBErr(err))
		}
		for rows.Next() {
			var uid, tid uuid.UUID
			var txt string
			if err := rows.Scan(&uid, &tid, &txt); err != nil {
				rows.Close()
				return nil, fmt.Errorf("lifecycle: recall sample scan failed: %w", sanitizeDBErr(err))
			}
			var key [32]byte
			copy(key[:16], uid[:])
			copy(key[16:], tid[:])
			if _, dup := seen[key]; dup || len(out) >= quota {
				continue
			}
			vec, err := parseVectorText(txt)
			if err != nil {
				rows.Close()
				return nil, err
			}
			seen[key] = struct{}{}
			out = append(out, sampledVector{userID: uid, vec: vec})
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("lifecycle: recall sample failed: %w", sanitizeDBErr(err))
		}
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
