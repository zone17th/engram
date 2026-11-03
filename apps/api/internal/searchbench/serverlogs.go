//go:build searchbench

package searchbench

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// FU-SB-2b (advisor-dec-333/334/337): the API logs of the benchmark runs become
// evidence. The suggest service logs ONE INFO line per degraded lexical branch,
// "suggest lexical branch partial" (internal/suggest/branch.go logBranchPartial),
// with the enum fields corpus, mode, phase and the integer millisecond timings
// setup_ms, set_local_ms and query_ms. The LogSink keeps those records (numbers and
// enum tokens only), aggregates them per load level (count by corpus/mode/phase and
// p50/p95/max of each timing) and the harness writes a sanitized
// <base>-server-logs.json artifact. Nothing outside the sink allowlist can reach it
// (see allowedLogKey / enumLogValues in runner.go) and WriteServerLogs scrubs the
// document once more before it touches the disk.

// PartialLogMessage is the fixed message of the lexical branch partial line.
const PartialLogMessage = "suggest lexical branch partial"

// maxPartialRecords bounds the per-drain memory of the partial records; a level
// that logs more keeps counting in PartialsOverflow only.
const maxPartialRecords = 200_000

// maxPartialTimingMs rejects an absurd timing (a negative or > 1 h value is a bug,
// not a measurement) instead of letting it skew a percentile.
const maxPartialTimingMs = int64(time.Hour / time.Millisecond)

// PartialRecord is one parsed "suggest lexical branch partial" line.
type PartialRecord struct {
	Corpus     string
	Mode       string
	Phase      string
	SetupMs    int64
	SetLocalMs int64
	QueryMs    int64
}

// parsePartialRecord reads the six sanitized key=value pairs of a partial line.
// It returns false when one is missing, repeated with a bad value, out of enum
// or out of the numeric range, so a malformed line is never aggregated.
func parsePartialRecord(kv []string) (PartialRecord, bool) {
	var (
		rec  PartialRecord
		seen int
	)
	num := func(v string) (int64, bool) {
		n, err := strconv.ParseInt(v, 10, 64)
		return n, err == nil && n >= 0 && n <= maxPartialTimingMs
	}
	for _, p := range kv {
		k, v, ok := strings.Cut(p, "=")
		if !ok {
			continue
		}
		switch k {
		case "corpus":
			if !enumLogValueOK(k, v) {
				return PartialRecord{}, false
			}
			rec.Corpus = v
			seen |= 1
		case "mode":
			if !enumLogValueOK(k, v) {
				return PartialRecord{}, false
			}
			rec.Mode = v
			seen |= 2
		case "phase":
			if !enumLogValueOK(k, v) {
				return PartialRecord{}, false
			}
			rec.Phase = v
			seen |= 4
		case "setup_ms", "set_local_ms", "query_ms":
			n, ok := num(v)
			if !ok {
				return PartialRecord{}, false
			}
			switch k {
			case "setup_ms":
				rec.SetupMs = n
				seen |= 8
			case "set_local_ms":
				rec.SetLocalMs = n
				seen |= 16
			default:
				rec.QueryMs = n
				seen |= 32
			}
		}
	}
	return rec, seen == 63
}

// MsStats are nearest-rank percentiles of a millisecond series.
type MsStats struct {
	P50Ms float64 `json:"p50_ms"`
	P95Ms float64 `json:"p95_ms"`
	MaxMs float64 `json:"max_ms"`
}

// msStatsOf summarizes a millisecond series (nearest rank, like every latency
// statistic of the report).
func msStatsOf(valuesMs []int64) MsStats {
	d := make([]time.Duration, len(valuesMs))
	for i, v := range valuesMs {
		d[i] = time.Duration(v) * time.Millisecond
	}
	st := Summarize(d, 0)
	return MsStats{P50Ms: st.P50Ms, P95Ms: st.P95Ms, MaxMs: st.MaxMs}
}

// PartialAgg is the aggregate of the partial lines of one (corpus, mode, phase).
type PartialAgg struct {
	Corpus     string  `json:"corpus"`
	Mode       string  `json:"mode"`
	Phase      string  `json:"phase"`
	Count      int     `json:"count"`
	Setup      MsStats `json:"setup_ms"`
	SetLocal   MsStats `json:"set_local_ms"`
	QueryPhase MsStats `json:"query_ms"`
}

// AggregatePartials groups the records by (corpus, mode, phase) and computes the
// percentiles of each timing; rows are sorted by corpus, mode, phase.
func AggregatePartials(recs []PartialRecord) []PartialAgg {
	type key struct{ corpus, mode, phase string }
	type series struct{ setup, setLocal, query []int64 }
	groups := map[key]*series{}
	for _, r := range recs {
		k := key{r.Corpus, r.Mode, r.Phase}
		g := groups[k]
		if g == nil {
			g = &series{}
			groups[k] = g
		}
		g.setup = append(g.setup, r.SetupMs)
		g.setLocal = append(g.setLocal, r.SetLocalMs)
		g.query = append(g.query, r.QueryMs)
	}
	out := make([]PartialAgg, 0, len(groups))
	for k, g := range groups {
		out = append(out, PartialAgg{
			Corpus: k.corpus, Mode: k.mode, Phase: k.phase, Count: len(g.setup),
			Setup: msStatsOf(g.setup), SetLocal: msStatsOf(g.setLocal), QueryPhase: msStatsOf(g.query),
		})
	}
	sortPartialAggs(out)
	return out
}

func sortPartialAggs(a []PartialAgg) {
	sort.Slice(a, func(i, j int) bool {
		if a[i].Corpus != a[j].Corpus {
			return a[i].Corpus < a[j].Corpus
		}
		if a[i].Mode != a[j].Mode {
			return a[i].Mode < a[j].Mode
		}
		return a[i].Phase < a[j].Phase
	})
}

// partialTotal sums the counts of the aggregate rows.
func partialTotal(aggs []PartialAgg) int {
	n := 0
	for _, a := range aggs {
		n += a.Count
	}
	return n
}

// ---- sanitized <base>-server-logs.json ----------------------------------------

// ServerLogsSchema identifies the artifact format.
const ServerLogsSchema = "engram.searchbench.serverlogs.v1"

// ServerLogsLevel is the sanitized server log evidence of one load level.
type ServerLogsLevel struct {
	Concurrency int             `json:"concurrency"`
	Classes     []LogClassCount `json:"classes,omitempty"`
	// PartialLines is the number of partial lines aggregated into Partials;
	// PartialsOverflow counts the ones beyond the per-level record cap.
	PartialLines     int          `json:"lexical_partial_lines"`
	PartialsOverflow int          `json:"lexical_partial_overflow,omitempty"`
	Partials         []PartialAgg `json:"lexical_partials,omitempty"`
	Samples          []string     `json:"sample_lines,omitempty"`
}

// ServerLogsScenario groups the levels of one C1 scenario.
type ServerLogsScenario struct {
	ID     string            `json:"id"`
	Levels []ServerLogsLevel `json:"levels"`
}

// ServerLogsDoc is the content of <base>-server-logs.json: per scenario and level
// the log class counts, the lexical partial aggregates and the capped, already
// sanitized sample lines. Only allowlisted tokens and numbers appear in it: no
// query, item, tag or user text, no SQL, no DSN, no secret.
type ServerLogsDoc struct {
	Schema    string               `json:"schema"`
	Profile   string               `json:"profile"`
	Arch      string               `json:"arch"`
	HeadSHA   string               `json:"head_sha"`
	Note      string               `json:"note"`
	Scenarios []ServerLogsScenario `json:"scenarios"`
	// Dropped counts entries the final scrub refused (0 in a healthy run).
	Dropped int `json:"scrub_dropped_entries"`
}

// BuildServerLogsDoc assembles the artifact from the C1 report.
func BuildServerLogsDoc(r *Report) ServerLogsDoc {
	doc := ServerLogsDoc{
		Schema: ServerLogsSchema, Profile: r.Run.Profile, Arch: r.Run.GOARCH, HeadSHA: r.Run.HeadSHA,
		Note: "Sanitized API server log evidence of the search benchmark (FU-SB-2b): allowlisted tokens and numbers only; no query, item, tag or user text, no SQL, no connection string, no credentials. Counts include warm-up requests.",
	}
	for _, s := range r.C1 {
		sc := ServerLogsScenario{ID: s.ID}
		for _, l := range s.Levels {
			sc.Levels = append(sc.Levels, ServerLogsLevel{
				Concurrency: l.Concurrency, Classes: l.ServerLogs.Classes,
				PartialLines: partialTotal(l.ServerLogs.Partials), PartialsOverflow: l.ServerLogs.PartialsOverflow,
				Partials: l.ServerLogs.Partials, Samples: l.ServerLogs.Samples,
			})
		}
		doc.Scenarios = append(doc.Scenarios, sc)
	}
	return doc
}

var (
	sampleLineRE  = regexp.MustCompile(`^level=(?:INFO|WARN|ERROR) msg="[A-Za-z0-9 _.:,/-]{1,120}"(?: [a-z_]+=[A-Za-z0-9_./{}:*-]{1,80})*$`)
	logMessageRE  = regexp.MustCompile(`^[A-Za-z0-9 _.:,/-]{1,120}$`)
	hexSHAPattern = regexp.MustCompile(`^[0-9a-f]{7,64}$`)
)

func okLogLevel(l string) bool { return l == "INFO" || l == "WARN" || l == "ERROR" || l == "DEBUG" }

func okMsStats(s MsStats) bool {
	ok := func(v float64) bool { return v >= 0 && v <= float64(maxPartialTimingMs) }
	return ok(s.P50Ms) && ok(s.P95Ms) && ok(s.MaxMs)
}

// ScrubServerLogsDoc is the last line of defence before the file is written. It
// re-checks every string and number of the document against the same closed
// vocabularies as the sink and DROPS (never rewrites) what does not fit. It
// returns the number of dropped entries. The sink already guarantees this for
// real log records; the scrub exists so a future change of the sink, the record
// parser or the builder cannot leak by accident (privacy lens).
func ScrubServerLogsDoc(doc *ServerLogsDoc) int {
	dropped := 0
	// Run metadata: profile and arch are tokens, the head SHA is hex.
	if doc.Profile != "" && !safeLogToken(doc.Profile) {
		doc.Profile, dropped = "", dropped+1
	}
	if doc.Arch != "" && !safeLogToken(doc.Arch) {
		doc.Arch, dropped = "", dropped+1
	}
	if doc.HeadSHA != "" && !hexSHAPattern.MatchString(doc.HeadSHA) {
		doc.HeadSHA, dropped = "", dropped+1
	}
	for si := range doc.Scenarios {
		sc := &doc.Scenarios[si]
		if !safeLogToken(sc.ID) {
			sc.ID, dropped = "", dropped+1
		}
		for li := range sc.Levels {
			l := &sc.Levels[li]
			classes := l.Classes[:0:0]
			for _, c := range l.Classes {
				if okLogLevel(c.Level) && logMessageRE.MatchString(c.Message) && (c.ErrorClass == "" || safeLogToken(c.ErrorClass)) && c.Count >= 0 {
					classes = append(classes, c)
				} else {
					dropped++
				}
			}
			l.Classes = classes
			partials := l.Partials[:0:0]
			for _, p := range l.Partials {
				if enumLogValueOK("corpus", p.Corpus) && p.Corpus != "" && enumLogValueOK("mode", p.Mode) && p.Mode != "" &&
					enumLogValueOK("phase", p.Phase) && p.Phase != "" && p.Count > 0 &&
					okMsStats(p.Setup) && okMsStats(p.SetLocal) && okMsStats(p.QueryPhase) {
					partials = append(partials, p)
				} else {
					dropped++
				}
			}
			l.Partials = partials
			samples := l.Samples[:0:0]
			for _, s := range l.Samples {
				if sampleLineRE.MatchString(s) {
					samples = append(samples, s)
				} else {
					dropped++
				}
			}
			l.Samples = samples
		}
	}
	doc.Dropped += dropped
	return dropped
}

// ServerLogsFileName is the artifact name for a report base name.
func ServerLogsFileName(base string) string { return base + "-server-logs.json" }

// WriteServerLogs scrubs and writes <dir>/<base>-server-logs.json and returns its path.
func WriteServerLogs(dir, base string, r *Report) (string, error) {
	doc := BuildServerLogsDoc(r)
	ScrubServerLogsDoc(&doc)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, ServerLogsFileName(base))
	if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// ---- Markdown ------------------------------------------------------------------

// renderPartialTables renders the "Lexical branch partials (FU-SB-2b)" section: per
// scenario level the count by (corpus, mode, phase) and p50/p95/max of each phase.
func renderPartialTables(w func(string, ...any), r *Report) {
	w("## Lexical branch partials (FU-SB-2b)\n\n")
	w("Aggregated from the INFO line `%s` of the API log (one line per degraded lexical branch; `phase` is the phase that expired; durations are whole milliseconds of the finished phases, warm-up requests included). Query phase = the 50 ms budget; setup = acquire + BEGIN, set_local = the SET LOCALs.\n\n", PartialLogMessage)
	printed := false
	for _, s := range r.C1 {
		for _, l := range s.Levels {
			if len(l.ServerLogs.Partials) == 0 {
				continue
			}
			if !printed {
				w("| Scenario | Clients | Corpus | Mode | Phase | Partials | setup p50/p95/max ms | set_local p50/p95/max ms | query p50/p95/max ms |\n|---|---|---|---|---|---|---|---|---|\n")
				printed = true
			}
			for _, p := range l.ServerLogs.Partials {
				w("| %s | %d | %s | %s | %s | %d | %s | %s | %s |\n", mdCell(s.ID), l.Concurrency, mdCell(p.Corpus), mdCell(p.Mode), mdCell(p.Phase), p.Count,
					msTriple(p.Setup), msTriple(p.SetLocal), msTriple(p.QueryPhase))
			}
			if l.ServerLogs.PartialsOverflow > 0 {
				w("| %s | %d | - | - | - | +%d | beyond the per-level record cap | - | - |\n", mdCell(s.ID), l.Concurrency, l.ServerLogs.PartialsOverflow)
			}
		}
	}
	if !printed {
		w("No `%s` line was logged by any level of this run (0 partial branches).\n", PartialLogMessage)
	}
	w("\n")
}

func msTriple(s MsStats) string { return fmt.Sprintf("%.0f / %.0f / %.0f", s.P50Ms, s.P95Ms, s.MaxMs) }
