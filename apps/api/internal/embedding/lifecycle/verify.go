package lifecycle

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
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
	// Now is an injectable clock (default time.Now), used for rollback checks.
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
	return VerifyReport{}, errors.New("not implemented")
}
