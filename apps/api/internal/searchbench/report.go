//go:build searchbench

package searchbench

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Aggregation, pass/fail and report rendering for the P05 search benchmark.
//
// Every recall/underfill number is computed here, literally per
// docs/benchmarks/P05-search/targets.md §2 (frozen definition, never redefined
// in the runner). The same functions are used by the benchmark run and by the
// self-checks in search_bench_test.go (BE-7), so a harness that stops
// detecting a slow lexical branch or a low recall fails its own tests.

// ---- frozen targets (docs/benchmarks/P05-search/targets.md §1) -------------

const (
	TargetC1LP95      = 40 * time.Millisecond  // C1-L: p95 <  40 ms
	TargetC1HP95      = 100 * time.Millisecond // C1-H: p95 < 100 ms
	TargetC1MP95      = 350 * time.Millisecond // C1-M: p95 < 350 ms (stub 90 ms)
	TargetC2RMean     = 0.95                   // C2-R: mean recall@20 per (corpus x class going ANN) >= 0.95
	TargetC2QRecall   = 0.80                   // C2-Q: per-query recall@20 >= 0.80 ...
	TargetC2QFraction = 0.95                   // ... for >= 95 % of queries
	TargetC2UMax      = 0.01                   // C2-U: underfill after fallback <= 1 % of queries
	TargetC2BP95      = 80 * time.Millisecond  // C2-B: single-corpus vector branch p95 <= 80 ms

	// RecallK is the k of recall@20 and of every vector query.
	RecallK = 20
	// TargetConcurrency is the closed-loop client count the targets apply to.
	TargetConcurrency = 8
	// MinMeasuredPerScenario is the per-scenario minimum of measured requests.
	MinMeasuredPerScenario = 2000

	// StubEmbedDelay is the C1-M stub provider latency (OQ-21, advisor-dec-244).
	StubEmbedDelay = 90 * time.Millisecond
	// OpenAICompatAssumedLatency is the informational openai_compat cache-miss
	// provider latency on host `bro` (~2.3 s, targets.md §1 notes).
	OpenAICompatAssumedLatency = 2300 * time.Millisecond

	recallEps = 1e-9
)

// ---- latency ---------------------------------------------------------------

// LatencyStats summarizes measured latencies (nearest-rank percentiles).
type LatencyStats struct {
	N      int     `json:"n"`
	Errors int     `json:"errors"`
	P50Ms  float64 `json:"p50_ms"`
	P95Ms  float64 `json:"p95_ms"`
	P99Ms  float64 `json:"p99_ms"`
	MaxMs  float64 `json:"max_ms"`
}

// NearestRank returns the nearest-rank percentile q (0 < q <= 1) of an
// ascending-sorted slice: the value at rank ceil(q*n) (1-based).
func NearestRank(sorted []time.Duration, q float64) time.Duration {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	rank := int(math.Ceil(q*float64(n) - 1e-9))
	if rank < 1 {
		rank = 1
	}
	if rank > n {
		rank = n
	}
	return sorted[rank-1]
}

func ms(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

// Summarize sorts a copy of lat and returns its statistics.
func Summarize(lat []time.Duration, errors int) LatencyStats {
	s := append([]time.Duration(nil), lat...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	st := LatencyStats{N: len(s), Errors: errors}
	if len(s) == 0 {
		return st
	}
	st.P50Ms = ms(NearestRank(s, 0.50))
	st.P95Ms = ms(NearestRank(s, 0.95))
	st.P99Ms = ms(NearestRank(s, 0.99))
	st.MaxMs = ms(s[len(s)-1])
	return st
}

// ---- verdicts --------------------------------------------------------------

// Verdict is the pass/fail of one target ID.
type Verdict struct {
	ID         string `json:"id"`
	Metric     string `json:"metric"`
	Target     string `json:"target"`
	Measured   string `json:"measured"`
	Applicable bool   `json:"applicable"` // false: nothing to evaluate (e.g. no tenant class went ANN)
	Pass       bool   `json:"pass"`
	Note       string `json:"note,omitempty"`
}

// Status is "pass", "fail" or "n/a".
func (v Verdict) Status() string {
	if !v.Applicable {
		return "n/a"
	}
	if v.Pass {
		return "pass"
	}
	return "fail"
}

// EvaluateLatency applies a p95 target. strictLess selects p95 < limit
// (C1-L/H/M) vs p95 <= limit (C2-B). A scenario with errors, fewer than minN
// measured requests, or an invalid setup (valid=false) fails.
func EvaluateLatency(id, metric string, st LatencyStats, limit time.Duration, strictLess bool, minN int, valid bool, invalid string) Verdict {
	op := "<"
	if !strictLess {
		op = "<="
	}
	v := Verdict{
		ID: id, Metric: metric, Applicable: true,
		Target:   fmt.Sprintf("p95 %s %.0f ms", op, ms(limit)),
		Measured: fmt.Sprintf("p95 %.2f ms (n=%d, p99 %.2f, max %.2f, errors %d)", st.P95Ms, st.N, st.P99Ms, st.MaxMs, st.Errors),
	}
	switch {
	case !valid:
		v.Note = "scenario invalid: " + invalid
	case st.Errors > 0:
		v.Note = fmt.Sprintf("%d request errors", st.Errors)
	case st.N < minN:
		v.Note = fmt.Sprintf("only %d measured requests (< %d)", st.N, minN)
	default:
		lim := ms(limit)
		if strictLess {
			v.Pass = st.P95Ms < lim
		} else {
			v.Pass = st.P95Ms <= lim
		}
	}
	return v
}

// ---- recall / underfill (frozen definition, targets.md §2) -----------------

// ScoredID is one exact-oracle row with its cosine similarity.
type ScoredID struct {
	ID  uuid.UUID
	Cos float64
}

// BuildExpected returns E: the top-min(k, eligible) rows of the exact oracle
// AFTER the min_cos filter, where eligible counts the oracle rows with
// cos >= minCos. `exact` must be ordered by similarity (best first) and hold at
// least the top k rows of the tenant (rows below min_cos may be included).
func BuildExpected(exact []ScoredID, minCos float64, k int) []uuid.UUID {
	e := make([]uuid.UUID, 0, k)
	for _, r := range exact {
		if r.Cos+recallEps < minCos {
			continue
		}
		if len(e) == k {
			break
		}
		e = append(e, r.ID)
	}
	return e
}

// IsANNFamily reports whether a store path entered the ANN branch (count >
// SEARCH_EXACT_MAX_VECTORS): "ann", "ann_short" and "ann_fallback_exact".
func IsANNFamily(path string) bool {
	switch path {
	case "ann", "ann_short", "ann_fallback_exact":
		return true
	}
	return false
}

// QueryOutcome is the scored result of one vector query.
type QueryOutcome struct {
	Corpus          string        `json:"-"`
	Class           string        `json:"-"`
	Kind            QueryKind     `json:"-"`
	ESize           int           `json:"-"` // |E|
	Rows            int           `json:"-"` // rows returned after threshold (and fallback)
	Hits            int           `json:"-"` // |ANN ∩ E|
	Path            string        `json:"-"`
	ANNCandidates   int           `json:"-"`
	UnderfillBefore bool          `json:"-"` // ANN candidates before threshold < k (production fallback rule, plan 2.16)
	FallbackUsed    bool          `json:"-"`
	TimedOut        bool          `json:"-"`
	CappedCount     int           `json:"-"`
	CrossTenant     int           `json:"-"` // returned rows owned by another tenant (C2-T)
	Latency         time.Duration `json:"-"`
}

// ScoreQuery computes |ANN ∩ E| for one query.
func ScoreQuery(e []uuid.UUID, got []uuid.UUID) int {
	set := make(map[uuid.UUID]struct{}, len(e))
	for _, id := range e {
		set[id] = struct{}{}
	}
	hits := 0
	seen := make(map[uuid.UUID]struct{}, len(got))
	for _, id := range got {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		if _, ok := set[id]; ok {
			hits++
		}
	}
	return hits
}

// CellAgg aggregates the outcomes of one (corpus x tenant class x knob set).
type CellAgg struct {
	Corpus string `json:"corpus"`
	Class  string `json:"class"`
	Knob   string `json:"knob"`

	Queries    int            `json:"queries"`
	PathCounts map[string]int `json:"path_counts"`
	ANNQueries int            `json:"ann_queries"` // queries that entered the ANN branch
	Eligible   int            `json:"eligible_ann_queries"`
	ExcludedE0 int            `json:"excluded_e0_ann_queries"` // |E|=0, excluded from C2-R/C2-Q

	RecallMean     float64 `json:"recall_mean"`          // C2-R input (|E|>0 ANN queries)
	QFraction      float64 `json:"recall_ge_080_frac"`   // C2-Q input
	UnderfillAfter float64 `json:"underfill_after_frac"` // C2-U input (after threshold and after fallback)
	OverlapMean    float64 `json:"overlap_jaccard_mean"` // |A∩E| / |A∪E| after threshold
	MeanE          float64 `json:"mean_e_size"`
	ESmallerThanK  int     `json:"e_smaller_than_20"`

	FalsePositives     int     `json:"false_positives_e0"` // |E|=0 but rows returned (all paths)
	UnderfillBeforeANN float64 `json:"ann_candidate_underfill_before_threshold_frac"`
	ScanCapSuspect     int     `json:"scan_cap_suspect"` // ANN candidate underfill although the tenant has >= k vectors (proxy for a hit of ef/max_scan_tuples; PathStats has no direct signal)
	FallbackUsed       int     `json:"fallback_exact_used"`
	TimedOut           int     `json:"timed_out"`
	CrossTenantRows    int     `json:"cross_tenant_rows"`

	// Exact-path queries (count <= SEARCH_EXACT_MAX_VECTORS) are not C2-R inputs;
	// their recall is reported as a sanity line (must be 1.0).
	ExactQueries    int     `json:"exact_path_queries_e_gt0"`
	ExactRecallMean float64 `json:"exact_path_recall_mean"`

	BranchLatency    LatencyStats `json:"branch_latency_all"`
	ANNBranchLatency LatencyStats `json:"branch_latency_ann"` // C2-B input
}

// AggregateCell applies the frozen definitions to a set of outcomes.
func AggregateCell(corpus, class, knob string, outs []QueryOutcome) CellAgg {
	c := CellAgg{Corpus: corpus, Class: class, Knob: knob, Queries: len(outs), PathCounts: map[string]int{}}
	var (
		recallSum, overlapSum, eSum float64
		exactSum                    float64
		ge80, underAfter, underBef  int
		allLat, annLat              []time.Duration
	)
	for _, o := range outs {
		c.PathCounts[o.Path]++
		allLat = append(allLat, o.Latency)
		c.CrossTenantRows += o.CrossTenant
		if o.TimedOut {
			c.TimedOut++
		}
		if o.ESize == 0 && o.Rows > 0 {
			c.FalsePositives++
		}
		if !IsANNFamily(o.Path) {
			if o.ESize > 0 {
				c.ExactQueries++
				exactSum += float64(o.Hits) / float64(o.ESize)
			}
			continue
		}
		c.ANNQueries++
		annLat = append(annLat, o.Latency)
		if o.FallbackUsed {
			c.FallbackUsed++
		}
		if o.UnderfillBefore {
			underBef++
			if o.CappedCount >= RecallK {
				c.ScanCapSuspect++
			}
		}
		if o.ESize == 0 {
			c.ExcludedE0++
			continue
		}
		c.Eligible++
		eSum += float64(o.ESize)
		if o.ESize < RecallK {
			c.ESmallerThanK++
		}
		r := float64(o.Hits) / float64(o.ESize)
		recallSum += r
		if r >= TargetC2QRecall-recallEps {
			ge80++
		}
		if o.Rows < o.ESize {
			underAfter++
		}
		union := o.Rows + o.ESize - o.Hits
		if union > 0 {
			overlapSum += float64(o.Hits) / float64(union)
		}
	}
	if c.Eligible > 0 {
		n := float64(c.Eligible)
		c.RecallMean = recallSum / n
		c.QFraction = float64(ge80) / n
		c.UnderfillAfter = float64(underAfter) / n
		c.OverlapMean = overlapSum / n
		c.MeanE = eSum / n
	}
	if c.ExactQueries > 0 {
		c.ExactRecallMean = exactSum / float64(c.ExactQueries)
	}
	if c.ANNQueries > 0 {
		c.UnderfillBeforeANN = float64(underBef) / float64(c.ANNQueries)
	}
	c.BranchLatency = Summarize(allLat, 0)
	c.ANNBranchLatency = Summarize(annLat, 0)
	return c
}

// applicableCells keeps the cells of one knob set that entered ANN with |E|>0.
func applicableCells(cells []CellAgg, knob string) []CellAgg {
	var out []CellAgg
	for _, c := range cells {
		if c.Knob == knob && c.ANNQueries > 0 && c.Eligible > 0 {
			out = append(out, c)
		}
	}
	return out
}

func cellLabel(c CellAgg) string { return c.Corpus + "/" + c.Class }

func perCellVerdict(id, metric, target string, cells []CellAgg, knob string,
	value func(CellAgg) (float64, string), ok func(float64) bool) Verdict {
	v := Verdict{ID: id, Metric: metric, Target: target}
	app := applicableCells(cells, knob)
	if len(app) == 0 {
		v.Measured = "no (corpus x class) went ANN with |E|>0"
		v.Note = "not applicable for this knob set"
		return v
	}
	v.Applicable, v.Pass = true, true
	var parts, failed []string
	for _, c := range app {
		val, txt := value(c)
		parts = append(parts, fmt.Sprintf("%s %s", cellLabel(c), txt))
		if !ok(val) {
			v.Pass = false
			failed = append(failed, cellLabel(c))
		}
	}
	v.Measured = strings.Join(parts, "; ")
	if len(failed) > 0 {
		v.Note = "failing cells: " + strings.Join(failed, ", ")
	}
	return v
}

// EvaluateC2R: mean recall@20 of every applicable (corpus x class) >= 0.95.
func EvaluateC2R(cells []CellAgg, knob string) Verdict {
	return perCellVerdict("C2-R", "recall@20 mean per (corpus x class going ANN)", ">= 0.95", cells, knob,
		func(c CellAgg) (float64, string) { return c.RecallMean, fmt.Sprintf("%.4f", c.RecallMean) },
		func(x float64) bool { return x >= TargetC2RMean-recallEps })
}

// EvaluateC2Q: >= 95 % of |E|>0 queries have recall@20 >= 0.80, per cell.
func EvaluateC2Q(cells []CellAgg, knob string) Verdict {
	return perCellVerdict("C2-Q", "per-query recall@20 >= 0.80", ">= 95 % of queries", cells, knob,
		func(c CellAgg) (float64, string) { return c.QFraction, fmt.Sprintf("%.2f%%", 100*c.QFraction) },
		func(x float64) bool { return x >= TargetC2QFraction-recallEps })
}

// EvaluateC2U: underfill after threshold and fallback <= 1 % of queries, per cell.
func EvaluateC2U(cells []CellAgg, knob string) Verdict {
	return perCellVerdict("C2-U", "underfill after fallback", "<= 1 % of queries", cells, knob,
		func(c CellAgg) (float64, string) {
			return c.UnderfillAfter, fmt.Sprintf("%.2f%%", 100*c.UnderfillAfter)
		},
		func(x float64) bool { return x <= TargetC2UMax+recallEps })
}

// EvaluateC2B: single-corpus vector branch p95 <= 80 ms (ANN queries), per cell.
func EvaluateC2B(cells []CellAgg, knob string) Verdict {
	return perCellVerdict("C2-B", "vector branch latency (single corpus)", "p95 <= 80 ms (p99 reported)", cells, knob,
		func(c CellAgg) (float64, string) {
			return c.ANNBranchLatency.P95Ms, fmt.Sprintf("p95 %.2f / p99 %.2f ms", c.ANNBranchLatency.P95Ms, c.ANNBranchLatency.P99Ms)
		},
		func(x float64) bool { return x <= ms(TargetC2BP95) })
}

// EvaluateC2T: cross-tenant rows must be exactly zero (hard).
func EvaluateC2T(crossTenantRows int) Verdict {
	return Verdict{
		ID: "C2-T", Metric: "rows owned by another tenant", Target: "0 (hard)", Applicable: true,
		Pass: crossTenantRows == 0, Measured: strconv.Itoa(crossTenantRows),
	}
}

// EvaluateFalsePositives: ANN rows for |E| = 0 must be zero (targets.md §2).
func EvaluateFalsePositives(cells []CellAgg, knob string) Verdict {
	total, any := 0, false
	for _, c := range cells {
		if c.Knob == knob {
			any = true
			total += c.FalsePositives
		}
	}
	return Verdict{ID: "C2-FP", Metric: "rows returned when |E| = 0", Target: "0", Applicable: any,
		Pass: total == 0, Measured: strconv.Itoa(total)}
}

// ---- sizing / disk estimate (FS-15, L17) -----------------------------------

const (
	// GB is a decimal gigabyte (the precheck numbers in protocol §3 are decimal).
	GB int64 = 1_000_000_000

	// Estimate assumptions (plan mục 2.23): vector(1024) ~ 4.1 KB, ~1 row per
	// 8 KiB page, HNSW the same order => ~16 KiB per vector (heap + HNSW).
	EstPerVectorBytes  int64 = 16 << 10
	EstPerItemRowBytes int64 = 1 << 10 // item row + its btree/GIN trigram indexes
	EstPerTagRowBytes  int64 = 512
	EstWALCapBytes     int64 = 800_000_000 // transient WAL during COPY + HNSW build
)

// EstimateDiskBytes is the pure, profile-derived disk estimate (rounded up to
// whole decimal GB, minimum 1 GB). full => 10 GB, so the precheck floor is
// DiskFloorBytes = 1.5 x estimate = 15 GB (protocol §3). The CI job's precheck
// uses fixed numbers from the plan; keep them consistent with this function.
func EstimateDiskBytes(spec ProfileSpec) int64 {
	vectors := int64(spec.TotalItems + spec.TotalTags)
	data := vectors*EstPerVectorBytes +
		int64(spec.TotalItems)*EstPerItemRowBytes + int64(spec.TotalTags)*EstPerTagRowBytes
	wal := min(EstWALCapBytes, data/10)
	total := data + wal
	gbs := (total + GB - 1) / GB
	if gbs < 1 {
		gbs = 1
	}
	return gbs * GB
}

// DiskFloorBytes is the recommended free-disk floor: 1.5 x estimate.
func DiskFloorBytes(estimate int64) int64 { return estimate * 3 / 2 }

// SizingTable is the FS-15/L17 sizing table: measured bytes/vector and HNSW
// build seconds from the run, extrapolated to the `full` profile.
type SizingTable struct {
	MeasuredProfile string `json:"measured_profile"`
	ItemVectors     int    `json:"measured_item_vectors"`
	TagVectors      int    `json:"measured_tag_vectors"`

	ItemHeapBytesPerVector float64 `json:"item_heap_bytes_per_vector"` // pg_table_size / rows (heap + TOAST)
	ItemPKBytesPerVector   float64 `json:"item_pk_index_bytes_per_vector"`
	ItemHNSWBytesPerVector float64 `json:"item_hnsw_bytes_per_vector"`
	TagHeapBytesPerVector  float64 `json:"tag_heap_bytes_per_vector"`
	TagPKBytesPerVector    float64 `json:"tag_pk_index_bytes_per_vector"`
	TagHNSWBytesPerVector  float64 `json:"tag_hnsw_bytes_per_vector"`
	ItemHNSWSecPerVector   float64 `json:"item_hnsw_build_seconds_per_vector"`
	TagHNSWSecPerVector    float64 `json:"tag_hnsw_build_seconds_per_vector"`

	FullItems int `json:"full_item_vectors"`
	FullTags  int `json:"full_tag_vectors"`

	FullItemHeapBytes int64   `json:"full_item_heap_bytes"`
	FullItemHNSWBytes int64   `json:"full_item_hnsw_bytes"`
	FullTagHeapBytes  int64   `json:"full_tag_heap_bytes"`
	FullTagHNSWBytes  int64   `json:"full_tag_hnsw_bytes"`
	FullPKBytes       int64   `json:"full_pk_index_bytes"`
	FullHNSWBuildSecs float64 `json:"full_hnsw_build_seconds_linear_lower_bound"`

	FormulaEstimateBytes  int64  `json:"formula_estimate_bytes"`
	ExtrapolatedBytes     int64  `json:"extrapolated_total_bytes"` // measured bytes/vector x full + base tables + WAL cap
	RecommendedFloorBytes int64  `json:"recommended_free_disk_floor_bytes"`
	SmokeEstimateBytes    int64  `json:"smoke_estimate_bytes"`
	SmokeFloorBytes       int64  `json:"smoke_free_disk_floor_bytes"`
	Note                  string `json:"note"`
}

// BuildSizingTable derives the sizing table from a seed result. It returns nil
// when the seed has no vectors (lexical-only self-check seeds).
func BuildSizingTable(sr *SeedResult) *SizingTable {
	if sr == nil || sr.ItemVectors == 0 || sr.TagVectors == 0 {
		return nil
	}
	full, err := BuildProfileSpec(ProfileFull, sr.Spec.Seed, sr.Spec.Partitions)
	if err != nil {
		return nil
	}
	per := func(b int64, n int) float64 {
		if n == 0 {
			return 0
		}
		return float64(b) / float64(n)
	}
	iv, tv := sr.Sizes.ItemVectors, sr.Sizes.TagVectors
	st := &SizingTable{
		MeasuredProfile: string(sr.Spec.Name), ItemVectors: sr.ItemVectors, TagVectors: sr.TagVectors,
		ItemHeapBytesPerVector: per(iv.TableBytes, sr.ItemVectors),
		ItemPKBytesPerVector:   per(iv.IndexBytes-iv.HNSWBytes, sr.ItemVectors),
		ItemHNSWBytesPerVector: per(iv.HNSWBytes, sr.ItemVectors),
		TagHeapBytesPerVector:  per(tv.TableBytes, sr.TagVectors),
		TagPKBytesPerVector:    per(tv.IndexBytes-tv.HNSWBytes, sr.TagVectors),
		TagHNSWBytesPerVector:  per(tv.HNSWBytes, sr.TagVectors),
		ItemHNSWSecPerVector:   sr.Timings.HNSWItem / float64(sr.ItemVectors),
		TagHNSWSecPerVector:    sr.Timings.HNSWTag / float64(sr.TagVectors),
		FullItems:              full.TotalItems,
		FullTags:               full.TotalTags,
	}
	fi, ft := float64(full.TotalItems), float64(full.TotalTags)
	st.FullItemHeapBytes = int64(st.ItemHeapBytesPerVector * fi)
	st.FullItemHNSWBytes = int64(st.ItemHNSWBytesPerVector * fi)
	st.FullTagHeapBytes = int64(st.TagHeapBytesPerVector * ft)
	st.FullTagHNSWBytes = int64(st.TagHNSWBytesPerVector * ft)
	st.FullPKBytes = int64(st.ItemPKBytesPerVector*fi + st.TagPKBytesPerVector*ft)
	st.FullHNSWBuildSecs = st.ItemHNSWSecPerVector*fi + st.TagHNSWSecPerVector*ft

	base := int64(float64(sr.Sizes.Item.TotalBytes+sr.Sizes.Tag.TotalBytes+sr.Sizes.ItemTag.TotalBytes) /
		float64(max(1, sr.Items+sr.Tags)) * float64(full.TotalItems+full.TotalTags))
	st.ExtrapolatedBytes = st.FullItemHeapBytes + st.FullItemHNSWBytes + st.FullTagHeapBytes + st.FullTagHNSWBytes +
		st.FullPKBytes + base + EstWALCapBytes
	st.FormulaEstimateBytes = EstimateDiskBytes(full)
	est := max(st.FormulaEstimateBytes, ((st.ExtrapolatedBytes+GB-1)/GB)*GB)
	st.RecommendedFloorBytes = DiskFloorBytes(est)
	if smoke, err := BuildProfileSpec(ProfileSmoke, sr.Spec.Seed, sr.Spec.Partitions); err == nil {
		st.SmokeEstimateBytes = EstimateDiskBytes(smoke)
		st.SmokeFloorBytes = DiskFloorBytes(st.SmokeEstimateBytes)
	}
	st.Note = "Linear extrapolation from the measured profile; HNSW build time grows faster than linearly " +
		"(graph no longer fits maintenance_work_mem), so build seconds are a lower bound. " +
		"Floor = 1.5 x max(formula estimate, extrapolated total) per protocol §3."
	return st
}

// ---- report ----------------------------------------------------------------

// LevelReport is one closed-loop concurrency level of a C1 scenario.
type LevelReport struct {
	Concurrency    int          `json:"concurrency"`
	Stats          LatencyStats `json:"stats"`
	Warmup         int          `json:"warmup_discarded"`
	Wall           float64      `json:"wall_seconds"`
	RPS            float64      `json:"requests_per_second"`
	SemanticRan    int          `json:"semantic_ran"`
	SemanticOff    int          `json:"semantic_not_ran"`
	LexicalPartial int          `json:"lexical_partial"`
	CrossTenant    int          `json:"cross_tenant_rows"`
	StubCalls      int64        `json:"stub_provider_calls"`
}

// ScenarioReport is one C1 scenario across 1/8/32 clients.
type ScenarioReport struct {
	ID            string        `json:"id"`
	Description   string        `json:"description"`
	Valid         bool          `json:"valid"`
	InvalidReason string        `json:"invalid_reason,omitempty"`
	Levels        []LevelReport `json:"levels"`
}

// Level returns the report of the given concurrency (ok=false if absent).
func (s ScenarioReport) Level(c int) (LevelReport, bool) {
	for _, l := range s.Levels {
		if l.Concurrency == c {
			return l, true
		}
	}
	return LevelReport{}, false
}

// EvaluateScenario applies the C1 target of a scenario at concurrency 8.
func EvaluateScenario(s ScenarioReport, limit time.Duration, minN int) Verdict {
	metric := map[string]string{
		"C1-L": "lexical server (semantic=0), whale tenant, concurrency 8, warm",
		"C1-H": "hybrid, query-embedding cache hit, concurrency 8, warm",
		"C1-M": "hybrid, cache miss, stub provider 90 ms, concurrency 8, warm",
	}[s.ID]
	l, ok := s.Level(TargetConcurrency)
	if !ok {
		return Verdict{ID: s.ID, Metric: metric, Target: fmt.Sprintf("p95 < %.0f ms", ms(limit)), Applicable: true,
			Measured: "concurrency 8 level missing", Note: "scenario not run at concurrency 8"}
	}
	return EvaluateLatency(s.ID, metric, l.Stats, limit, true, minN, s.Valid, s.InvalidReason)
}

// OpenAICompatInfo is the informational (non-target) openai_compat cache-miss line.
type OpenAICompatInfo struct {
	Label            string  `json:"label"`
	AssumedProviderS float64 `json:"assumed_provider_latency_seconds"`
	EstimatedP50Ms   float64 `json:"estimated_p50_ms"`
	EstimatedP95Ms   float64 `json:"estimated_p95_ms"`
	Basis            string  `json:"basis"`
}

// ComputeOpenAICompatInfo derives the informational line from the measured
// C1-M latency at concurrency 8 by replacing the 90 ms stub with ~2.3 s. It is
// arithmetic, not a measurement against any provider, and not a target.
func ComputeOpenAICompatInfo(m ScenarioReport) *OpenAICompatInfo {
	l, ok := m.Level(TargetConcurrency)
	if !ok || l.Stats.N == 0 {
		return nil
	}
	delta := ms(OpenAICompatAssumedLatency - StubEmbedDelay)
	return &OpenAICompatInfo{
		Label:            "INFORMATIONAL - computed, not measured, not a P05 target (operational number for P06)",
		AssumedProviderS: OpenAICompatAssumedLatency.Seconds(),
		EstimatedP50Ms:   l.Stats.P50Ms + delta,
		EstimatedP95Ms:   l.Stats.P95Ms + delta,
		Basis:            "C1-M concurrency 8 latency - 90 ms stub + 2300 ms; the UI never waits for semantic (lexical shows first).",
	}
}

// CountCostRow is the cost of the single capped count query (plan 2.16, BE-2).
type CountCostRow struct {
	Corpus string       `json:"corpus"`
	Class  string       `json:"class"`
	Count  int          `json:"capped_count"`
	Stats  LatencyStats `json:"latency"`
}

// KnobSet is one point of the C2 knob matrix.
type KnobSet struct {
	Label         string `json:"label"`
	EfSearch      int    `json:"ef_search"`
	MaxScanTuples int    `json:"max_scan_tuples"`
	ExactMax      int    `json:"search_exact_max_vectors"`
	FallbackMax   int    `json:"search_exact_fallback_max_vectors"` // 0 = max(20000, ExactMax) except in forced-ANN self-checks
	Iterative     string `json:"hnsw_iterative_scan"`
	ForceNoFallbk bool   `json:"fallback_exact_disabled"`
}

// C2Report holds the whole C2 section.
type C2Report struct {
	DefaultKnob string               `json:"default_knob"`
	Matrix      []KnobSet            `json:"matrix"`
	MatrixNote  string               `json:"matrix_note"`
	Queries     map[string]int       `json:"queries_per_corpus_class"`
	Cells       []CellAgg            `json:"cells"`
	CountCost   []CountCostRow       `json:"capped_count_cost"`
	Explain     map[string][]string  `json:"explain_analyze_buffers"`
	MatrixPass  map[string][]Verdict `json:"matrix_verdicts"`
}

// HardwareInfo is the part of hardware-template.md that Go can collect.
type HardwareInfo struct {
	NotProduction string `json:"not_production_host"`
	Runner        string `json:"runner"`
	GOOS          string `json:"goos"`
	GOARCH        string `json:"goarch"`
	NumCPU        int    `json:"num_cpu"`
	GoVersion     string `json:"go_version"`
	CPUModel      string `json:"cpu_model"`
	MemTotalMB    int    `json:"mem_total_mb"`
	Kernel        string `json:"kernel"`
	BuildTags     string `json:"build_tags"`
	PostgresImage string `json:"postgres_image"`
	PG            PGInfo `json:"postgres"`
}

// RunInfo identifies the run.
type RunInfo struct {
	DateUTC         string `json:"date_utc"`
	HeadSHA         string `json:"head_sha"`
	RunURL          string `json:"run_url"`
	Job             string `json:"job"`
	Conclusion      string `json:"conclusion"`
	TargetsCommit   string `json:"targets_md_commit"`
	TargetsAncestor string `json:"targets_md_is_ancestor_exit_code"`
	Profile         string `json:"profile"`
	Seed            uint64 `json:"seed"`
	DatasetHash     string `json:"dataset_hash"`
	GOARCH          string `json:"arch"`
}

// HarnessKnobs records the harness-side configuration of the run.
type HarnessKnobs struct {
	MinCos            float64  `json:"min_cos_benchmark"`
	GenerationID      int      `json:"generation_id"`
	Partitions        int      `json:"partitions"`
	HnswM             int      `json:"hnsw_m"`
	HnswEfConstr      int      `json:"hnsw_ef_construction"`
	StubDelayMs       float64  `json:"stub_embed_delay_ms"`
	RateLimitCapacity int      `json:"search_read_bucket_capacity"`
	RateLimitRefill   float64  `json:"search_read_bucket_refill_per_sec"`
	PoolMaxConns      int      `json:"api_pool_max_conns"`
	Concurrency       []int    `json:"concurrency_levels"`
	Requests          string   `json:"requests_per_scenario"`
	ProductionKnobs   string   `json:"production_default_knobs"`
	SearchEndpoint    string   `json:"endpoint"`
	Notes             []string `json:"notes,omitempty"`
}

// SeedSummary is the seed section of the report.
type SeedSummary struct {
	Users       int              `json:"users"`
	Items       int              `json:"items"`
	Tags        int              `json:"tags"`
	ItemTags    int              `json:"item_tags"`
	ItemVectors int              `json:"item_vectors"`
	TagVectors  int              `json:"tag_vectors"`
	Timings     SeedTimings      `json:"timings"`
	HNSW        []HNSWBuild      `json:"hnsw_builds"`
	Sizes       SizeReport       `json:"sizes"`
	Colocation  ColocationReport `json:"colocation"`
}

// Report is the complete benchmark report (JSON + Markdown).
type Report struct {
	Schema   string            `json:"schema"`
	Label    string            `json:"label"`
	Run      RunInfo           `json:"run"`
	Hardware HardwareInfo      `json:"hardware"`
	Harness  HarnessKnobs      `json:"harness"`
	Seed     *SeedSummary      `json:"seed,omitempty"`
	Sizing   *SizingTable      `json:"sizing,omitempty"`
	Disk     DiskPrecheck      `json:"disk_precheck_numbers"`
	C1       []ScenarioReport  `json:"c1"`
	C1Info   *OpenAICompatInfo `json:"c1_openai_compat_informational,omitempty"`
	C2       *C2Report         `json:"c2,omitempty"`
	Verdicts []Verdict         `json:"verdicts_concurrency_8"`
	Hard     []string          `json:"hard_failures"`
	Notes    []string          `json:"notes,omitempty"`
}

// DiskPrecheck records the estimate numbers the CI job's precheck must match.
type DiskPrecheck struct {
	FullEstimateBytes int64 `json:"full_estimate_bytes"`
	FullFloorBytes    int64 `json:"full_floor_bytes"`
	SmokeEstimate     int64 `json:"smoke_estimate_bytes"`
	SmokeFloorBytes   int64 `json:"smoke_floor_bytes"`
}

// ReportLabel is the evidence label of a profile (targets.md §4).
func ReportLabel(p ProfileName) string {
	if p == ProfileSmoke {
		return "smoke - not acceptance evidence"
	}
	return "full - acceptance candidate (targets apply)"
}

// ReportFileBase builds `<YYYY-MM-DD>-<sha7>-<profile>-<arch>` (plan 2.23).
func ReportFileBase(date time.Time, headSHA string, p ProfileName, arch string) string {
	sha := strings.TrimSpace(headSHA)
	if len(sha) > 7 {
		sha = sha[:7]
	}
	if sha == "" {
		sha = "nosha"
	}
	return fmt.Sprintf("%s-%s-%s-%s", date.UTC().Format("2006-01-02"), sha, p, arch)
}

// ConsolidateVerdicts evaluates every target at concurrency 8 (C2 for the
// default knob set) with the same functions the self-checks use.
func ConsolidateVerdicts(c1 []ScenarioReport, c2 *C2Report, minN int, seedHash bool) []Verdict {
	var out []Verdict
	limits := map[string]time.Duration{"C1-L": TargetC1LP95, "C1-H": TargetC1HP95, "C1-M": TargetC1MP95}
	for _, id := range []string{"C1-L", "C1-H", "C1-M"} {
		for _, s := range c1 {
			if s.ID == id {
				out = append(out, EvaluateScenario(s, limits[id], minN))
			}
		}
	}
	if c2 != nil {
		k := c2.DefaultKnob
		out = append(out,
			EvaluateC2R(c2.Cells, k), EvaluateC2Q(c2.Cells, k), EvaluateC2U(c2.Cells, k),
			EvaluateC2B(c2.Cells, k), EvaluateC2T(totalCrossTenant(c2.Cells)), EvaluateFalsePositives(c2.Cells, k))
	}
	_ = seedHash
	return out
}

func totalCrossTenant(cells []CellAgg) int {
	t := 0
	for _, c := range cells {
		t += c.CrossTenantRows
	}
	return t
}

// HardFailures lists conditions that fail the run even for `smoke`: a harness
// that cannot measure, or a hard target (C2-T).
func HardFailures(r *Report) []string {
	var out []string
	for _, s := range r.C1 {
		if !s.Valid {
			out = append(out, fmt.Sprintf("%s invalid: %s", s.ID, s.InvalidReason))
		}
		for _, l := range s.Levels {
			if l.Stats.Errors > 0 {
				out = append(out, fmt.Sprintf("%s c=%d: %d request errors", s.ID, l.Concurrency, l.Stats.Errors))
			}
			if l.CrossTenant > 0 {
				out = append(out, fmt.Sprintf("%s c=%d: %d cross-tenant rows (C2-T)", s.ID, l.Concurrency, l.CrossTenant))
			}
		}
	}
	if r.C2 != nil {
		if n := totalCrossTenant(r.C2.Cells); n > 0 {
			out = append(out, fmt.Sprintf("C2-T: %d cross-tenant rows", n))
		}
	}
	if r.Seed != nil && !r.Seed.Colocation.OK && r.Seed.Colocation.TenantsChecked > 0 {
		out = append(out, "colocation check failed")
	}
	return out
}

// TargetFailures lists failed (applicable) target verdicts.
func TargetFailures(vs []Verdict) []string {
	var out []string
	for _, v := range vs {
		if v.Applicable && !v.Pass {
			out = append(out, v.ID+": "+v.Measured)
		}
	}
	return out
}

// CollectHardware gathers what Go can know about the machine (best effort).
func CollectHardware(env Env, pg PGInfo) HardwareInfo {
	h := HardwareInfo{
		NotProduction: "Không phải host production `bro`",
		Runner:        orUnknown(env.Runner),
		GOOS:          runtime.GOOS,
		GOARCH:        runtime.GOARCH,
		NumCPU:        runtime.NumCPU(),
		GoVersion:     runtime.Version(),
		CPUModel:      "unknown",
		Kernel:        "unknown",
		BuildTags:     "searchbench",
		PostgresImage: orUnknown(env.PostgresPin),
		PG:            pg,
	}
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			l := strings.ToLower(line)
			if strings.HasPrefix(l, "model name") || strings.HasPrefix(l, "hardware") || strings.HasPrefix(l, "cpu model") {
				if i := strings.Index(line, ":"); i >= 0 {
					h.CPUModel = strings.TrimSpace(line[i+1:])
					break
				}
			}
		}
	}
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "MemTotal:") {
				f := strings.Fields(line)
				if len(f) >= 2 {
					if kb, err := strconv.Atoi(f[1]); err == nil {
						h.MemTotalMB = kb / 1024
					}
				}
				break
			}
		}
	}
	if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		h.Kernel = strings.TrimSpace(string(b))
	}
	return h
}

func orUnknown(s string) string {
	if strings.TrimSpace(s) == "" {
		return "unknown"
	}
	return s
}

// ---- writers ---------------------------------------------------------------

// WriteReport writes `<dir>/<base>.json` and `<dir>/<base>.md` and returns the
// Markdown text (for $GITHUB_STEP_SUMMARY).
func WriteReport(dir, base string, r *Report) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	jb, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, base+".json"), append(jb, '\n'), 0o644); err != nil {
		return "", err
	}
	md := RenderMarkdown(r)
	if err := os.WriteFile(filepath.Join(dir, base+".md"), []byte(md), 0o644); err != nil {
		return "", err
	}
	return md, nil
}

// AppendStepSummary appends md to the file named by $GITHUB_STEP_SUMMARY.
func AppendStepSummary(path, md string) error {
	if path == "" {
		return nil
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(md + "\n")
	return err
}

func gbStr(b int64) string  { return fmt.Sprintf("%.2f GB", float64(b)/float64(GB)) }
func mibStr(b int64) string { return fmt.Sprintf("%.1f MiB", float64(b)/(1<<20)) }

// RenderMarkdown renders the report following docs/benchmarks/P05-search/hardware-template.md.
func RenderMarkdown(r *Report) string {
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }
	w("# P05 search benchmark - %s\n\n", r.Label)
	if r.Run.Profile == string(ProfileSmoke) {
		w("> **smoke - not acceptance evidence.** Targets are reported below for information only (targets.md §4); smoke never claims a target was met or missed.\n\n")
	}
	w("> **Không phải host production `bro`.** CI runner numbers do not replace production latency.\n\n")

	w("## Run\n\n| Item | Value |\n|---|---|\n")
	w("| Run URL | %s |\n| Job / conclusion | `%s` / %s |\n| Head SHA | `%s` |\n", orUnknown(r.Run.RunURL), r.Run.Job, r.Run.Conclusion, orUnknown(r.Run.HeadSHA))
	w("| targets.md commit | `%s` (is-ancestor exit code: %s) |\n", r.Run.TargetsCommit, r.Run.TargetsAncestor)
	w("| Profile / seed | `%s` / `%d` |\n| Dataset hash | `%s` |\n| Date (UTC) | %s |\n| Arch | %s |\n\n",
		r.Run.Profile, r.Run.Seed, r.Run.DatasetHash, r.Run.DateUTC, r.Run.GOARCH)

	h := r.Hardware
	w("## Hardware and software\n\n| Item | Value |\n|---|---|\n")
	w("| Runner | %s |\n| GOOS/GOARCH | %s/%s |\n| CPU | %s (%d logical) |\n| RAM total | %d MB |\n| Kernel | %s |\n",
		h.Runner, h.GOOS, h.GOARCH, h.CPUModel, h.NumCPU, h.MemTotalMB, h.Kernel)
	w("| Go | %s |\n| Build tags | `%s` |\n| Postgres | %s |\n| pgvector | %s |\n| Postgres image | %s |\n",
		h.GoVersion, h.BuildTags, h.PG.Version, h.PG.Vector, h.PostgresImage)
	keys := make([]string, 0, len(h.PG.Settings))
	for k := range h.PG.Settings {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		w("| `%s` | %s |\n", k, h.PG.Settings[k])
	}
	w("\n")

	k := r.Harness
	w("## Harness configuration\n\n| Knob | Value |\n|---|---|\n")
	w("| min_cos benchmark | %.2f |\n| Generation / partitions / hnsw m / ef_construction | g%d / %d / %d / %d |\n",
		k.MinCos, k.GenerationID, k.Partitions, k.HnswM, k.HnswEfConstr)
	w("| Stub embed (cache miss) | %.0f ms |\n| `search_read` bucket (relaxed) | capacity %d, refill %.0f/s |\n| API pool max conns | %d |\n",
		k.StubDelayMs, k.RateLimitCapacity, k.RateLimitRefill, k.PoolMaxConns)
	w("| Concurrency | %v (targets at %d) |\n| Requests per scenario | %s |\n| Endpoint | `%s` |\n| Production knobs (hybrid scenarios) | %s |\n\n",
		k.Concurrency, TargetConcurrency, k.Requests, k.SearchEndpoint, k.ProductionKnobs)
	for _, n := range k.Notes {
		w("- %s\n", n)
	}
	if len(k.Notes) > 0 {
		w("\n")
	}

	w("## Disk precheck numbers\n\n| Profile | Estimate | Free-disk floor (1.5x) |\n|---|---|---|\n")
	w("| full | %s | %s |\n| smoke | %s | %s |\n\n", gbStr(r.Disk.FullEstimateBytes), gbStr(r.Disk.FullFloorBytes), gbStr(r.Disk.SmokeEstimate), gbStr(r.Disk.SmokeFloorBytes))

	w("## Targets at concurrency 8\n\n")
	if r.Run.Profile == string(ProfileSmoke) {
		w("_smoke - not acceptance evidence: verdicts are informational._\n\n")
	}
	w("| ID | Metric | Target | Measured | Verdict |\n|---|---|---|---|---|\n")
	for _, v := range r.Verdicts {
		note := ""
		if v.Note != "" {
			note = " - " + v.Note
		}
		w("| %s | %s | %s | %s%s | **%s** |\n", v.ID, v.Metric, v.Target, v.Measured, note, strings.ToUpper(v.Status()))
	}
	w("\n")
	if len(r.Hard) > 0 {
		w("### Hard failures\n\n")
		for _, f := range r.Hard {
			w("- %s\n", f)
		}
		w("\n")
	}

	w("## C1 - latency (closed loop, warm-up discarded)\n\n")
	for _, s := range r.C1 {
		w("### %s - %s\n\n", s.ID, s.Description)
		if !s.Valid {
			w("**INVALID**: %s\n\n", s.InvalidReason)
		}
		w("| Clients | n | p50 ms | p95 ms | p99 ms | max ms | errors | req/s | semantic ran/off | lexical_partial | stub calls | cross-tenant |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n")
		for _, l := range s.Levels {
			w("| %d | %d | %.2f | %.2f | %.2f | %.2f | %d | %.0f | %d/%d | %d | %d | %d |\n", l.Concurrency, l.Stats.N,
				l.Stats.P50Ms, l.Stats.P95Ms, l.Stats.P99Ms, l.Stats.MaxMs, l.Stats.Errors, l.RPS,
				l.SemanticRan, l.SemanticOff, l.LexicalPartial, l.StubCalls, l.CrossTenant)
		}
		w("\n")
	}
	if r.C1Info != nil {
		w("### openai_compat cache miss (~2.3 s) - %s\n\n", r.C1Info.Label)
		w("Estimated p50 %.0f ms, p95 %.0f ms. Basis: %s\n\n", r.C1Info.EstimatedP50Ms, r.C1Info.EstimatedP95Ms, r.C1Info.Basis)
	}

	if r.C2 != nil {
		c := r.C2
		w("## C2 - recall / underfill / vector branch\n\n")
		w("Default knob set: `%s`. %s\n\n", c.DefaultKnob, c.MatrixNote)
		w("| Corpus | Class | Knob | Queries | ANN q. | |E|>0 | |E|=0 | recall@20 mean | recall>=0.8 | underfill after | underfill before (ANN cand.) | overlap | false+ | scan-cap suspect | fallback | timeout | cross-tenant | branch p95/p99 ms (ANN) | paths |\n")
		w("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n")
		for _, x := range c.Cells {
			var paths []string
			for _, p := range []string{"exact", "ann", "ann_fallback_exact", "ann_short"} {
				if n := x.PathCounts[p]; n > 0 {
					paths = append(paths, fmt.Sprintf("%s %d (%.0f%%)", p, n, 100*float64(n)/float64(x.Queries)))
				}
			}
			w("| %s | %s | %s | %d | %d | %d | %d | %.4f | %.1f%% | %.2f%% | %.1f%% | %.3f | %d | %d | %d | %d | %d | %.1f / %.1f | %s |\n",
				x.Corpus, x.Class, x.Knob, x.Queries, x.ANNQueries, x.Eligible, x.ExcludedE0, x.RecallMean, 100*x.QFraction,
				100*x.UnderfillAfter, 100*x.UnderfillBeforeANN, x.OverlapMean, x.FalsePositives, x.ScanCapSuspect,
				x.FallbackUsed, x.TimedOut, x.CrossTenantRows, x.ANNBranchLatency.P95Ms, x.ANNBranchLatency.P99Ms, strings.Join(paths, ", "))
		}
		w("\n_scan-cap suspect_ = ANN candidate underfill although the tenant has >= 20 vectors (proxy for ef_search / max_scan_tuples stopping the scan; `PathStats` has no direct scan-cap signal). _overlap_ = |ANN ∩ E| / |ANN ∪ E| after threshold.\n\n")
		if len(c.CountCost) > 0 {
			w("### Capped count cost (BE-2)\n\n| Corpus | Class | count (capped) | p50 ms | p95 ms | p99 ms | n |\n|---|---|---|---|---|---|---|\n")
			for _, x := range c.CountCost {
				w("| %s | %s | %d | %.2f | %.2f | %.2f | %d |\n", x.Corpus, x.Class, x.Count, x.Stats.P50Ms, x.Stats.P95Ms, x.Stats.P99Ms, x.Stats.N)
			}
			w("\n")
		}
		if len(c.MatrixPass) > 0 {
			w("### Knob matrix verdicts (C2-R / C2-Q / C2-U / C2-B)\n\n| Knob | C2-R | C2-Q | C2-U | C2-B |\n|---|---|---|---|---|\n")
			labels := make([]string, 0, len(c.MatrixPass))
			for l := range c.MatrixPass {
				labels = append(labels, l)
			}
			sort.Strings(labels)
			for _, l := range labels {
				row := c.MatrixPass[l]
				w("| `%s` |", l)
				for _, v := range row {
					w(" %s |", v.Status())
				}
				w("\n")
			}
			w("\n")
		}
		if len(c.Explain) > 0 {
			w("### EXPLAIN (ANALYZE, BUFFERS) of a representative ANN candidate query\n\n_Simplified candidate query (not byte-identical to production SQL); vector parameter not shown._\n\n")
			keys := make([]string, 0, len(c.Explain))
			for k := range c.Explain {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				w("**%s**\n\n```\n%s\n```\n\n", k, strings.Join(c.Explain[k], "\n"))
			}
		}
	}

	if r.Seed != nil {
		s := r.Seed
		w("## Dataset, sizes and build times\n\n| Item | Value |\n|---|---|\n")
		w("| Users / items / tags / item_tags | %d / %d / %d / %d |\n| Vectors (item / tag) | %d / %d |\n", s.Users, s.Items, s.Tags, s.ItemTags, s.ItemVectors, s.TagVectors)
		w("| item_embedding_g1 heap+TOAST / indexes (HNSW) | %s / %s (%s) |\n", mibStr(s.Sizes.ItemVectors.TableBytes), mibStr(s.Sizes.ItemVectors.IndexBytes), mibStr(s.Sizes.ItemVectors.HNSWBytes))
		w("| tag_embedding_g1 heap+TOAST / indexes (HNSW) | %s / %s (%s) |\n", mibStr(s.Sizes.TagVectors.TableBytes), mibStr(s.Sizes.TagVectors.IndexBytes), mibStr(s.Sizes.TagVectors.HNSWBytes))
		w("| item / tag / item_tag total | %s / %s / %s |\n", mibStr(s.Sizes.Item.TotalBytes), mibStr(s.Sizes.Tag.TotalBytes), mibStr(s.Sizes.ItemTag.TotalBytes))
		t := s.Timings
		w("| Seed: users / g1 DDL / COPY tag / COPY item / COPY embeddings | %.1f / %.1f / %.1f / %.1f / %.1f s |\n", t.Users, t.Generate, t.CopyTags, t.CopyItems, t.CopyEmb)
		w("| HNSW build total (item / tag) | %.1f s (%.1f / %.1f) |\n| ANALYZE / dataset hash / total seed | %.1f / %.1f / %.1f s |\n", t.HNSWTotal, t.HNSWItem, t.HNSWTag, t.Analyze, t.Hash, t.Total)
		w("| Colocation (satisfies_hash_partition) | ok=%v, tenants checked %d, colocated tenants %v, whale partition `%s` |\n\n",
			s.Colocation.OK, s.Colocation.TenantsChecked, s.Colocation.ColocatedTenants, s.Colocation.WhalePartition)
		if len(s.HNSW) > 0 {
			w("<details><summary>HNSW build per partition</summary>\n\n| Corpus | Partition | Rows | Seconds | Index MiB |\n|---|---|---|---|---|\n")
			for _, x := range s.HNSW {
				w("| %s | %s | %d | %.2f | %.1f |\n", x.Corpus, x.Part, x.Rows, x.Seconds, float64(x.Bytes)/(1<<20))
			}
			w("\n</details>\n\n")
		}
	}

	if z := r.Sizing; z != nil {
		w("## Sizing table (FS-15, L17) - measured on `%s`, extrapolated to `full`\n\n", z.MeasuredProfile)
		w("| Metric | Item | Tag |\n|---|---|---|\n")
		w("| Heap+TOAST bytes / vector | %.0f | %.0f |\n| PK btree bytes / vector | %.0f | %.0f |\n| HNSW bytes / vector | %.0f | %.0f |\n| HNSW build s / vector | %.5f | %.5f |\n",
			z.ItemHeapBytesPerVector, z.TagHeapBytesPerVector, z.ItemPKBytesPerVector, z.TagPKBytesPerVector,
			z.ItemHNSWBytesPerVector, z.TagHNSWBytesPerVector, z.ItemHNSWSecPerVector, z.TagHNSWSecPerVector)
		w("| Full vectors | %d | %d |\n| Full heap+TOAST | %s | %s |\n| Full HNSW | %s | %s |\n\n",
			z.FullItems, z.FullTags, gbStr(z.FullItemHeapBytes), gbStr(z.FullTagHeapBytes), gbStr(z.FullItemHNSWBytes), gbStr(z.FullTagHNSWBytes))
		w("- Full HNSW build (linear lower bound): %.0f s (%.1f min)\n", z.FullHNSWBuildSecs, z.FullHNSWBuildSecs/60)
		w("- Formula estimate (job precheck numbers): %s; measured extrapolation incl. base tables + WAL cap: %s\n", gbStr(z.FormulaEstimateBytes), gbStr(z.ExtrapolatedBytes))
		w("- **Recommended free-disk floor for `full` (1.5x): %s**; smoke estimate %s, floor %s\n- %s\n\n",
			gbStr(z.RecommendedFloorBytes), gbStr(z.SmokeEstimateBytes), gbStr(z.SmokeFloorBytes), z.Note)
	}

	if len(r.Notes) > 0 {
		w("## Notes\n\n")
		for _, n := range r.Notes {
			w("- %s\n", n)
		}
	}
	return b.String()
}
