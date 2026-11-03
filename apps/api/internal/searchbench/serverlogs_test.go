//go:build searchbench

package searchbench

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Pure self-checks of the sanitized API-log evidence (FU-SB-2b, advisor-dec-337):
// partial-line aggregation and the server-logs.json artifact. No database.

func partialLogger(sink *LogSink) func(corpus, mode, phase string, setup, setLocal, query int64) {
	lg := sink.Logger()
	return func(corpus, mode, phase string, setup, setLocal, query int64) {
		lg.Info(PartialLogMessage,
			slog.String("corpus", corpus), slog.String("mode", mode), slog.String("phase", phase),
			slog.Int64("setup_ms", setup), slog.Int64("set_local_ms", setLocal), slog.Int64("query_ms", query))
	}
}

// TestLexicalPartialAggregation (FU-SB-2b): the "suggest lexical branch partial"
// lines of a level are counted by (corpus, mode, phase) with nearest-rank p50/p95/max
// of setup_ms / set_local_ms / query_ms; malformed lines are not aggregated; Drain
// resets; the aggregate reaches JSON and Markdown.
func TestLexicalPartialAggregation(t *testing.T) {
	sink := NewLogSink()
	emit := partialLogger(sink)
	// item/full/query: query 5,10,15,20,25 -> p50 15, p95 25, max 25; setup 0,0,0,1,100 -> p50 0, p95 100.
	for i, q := range []int64{25, 5, 15, 10, 20} {
		setup := []int64{100, 0, 0, 1, 0}[i]
		emit("item", "full", "query", setup, 2, q)
	}
	emit("tag", "prefix", "setup", 2400, 0, 0)
	emit("tag", "prefix", "setup", 2100, 0, 0)
	// Malformed lines never enter the aggregate: out-of-enum corpus, unknown phase,
	// negative timing, missing field.
	emit("alice-notes", "full", "query", 1, 1, 1)
	emit("item", "full", "warmup", 1, 1, 1)
	emit("item", "full", "query", -5, 1, 1)
	sink.Logger().Info(PartialLogMessage, slog.String("corpus", "item"), slog.String("mode", "full"), slog.String("phase", "query"), slog.Int64("setup_ms", 1))

	got := sink.Drain()
	if len(got.Partials) != 2 {
		t.Fatalf("aggregate rows = %d, want 2 (item/full/query, tag/prefix/setup): %+v", len(got.Partials), got.Partials)
	}
	it, tg := got.Partials[0], got.Partials[1]
	if it.Corpus != "item" || it.Mode != "full" || it.Phase != "query" || it.Count != 5 {
		t.Fatalf("item row = %+v", it)
	}
	if it.QueryPhase != (MsStats{P50Ms: 15, P95Ms: 25, MaxMs: 25}) {
		t.Errorf("item query stats = %+v, want p50 15 p95 25 max 25", it.QueryPhase)
	}
	if it.Setup != (MsStats{P50Ms: 0, P95Ms: 100, MaxMs: 100}) {
		t.Errorf("item setup stats = %+v, want p50 0 p95 100 max 100", it.Setup)
	}
	if it.SetLocal != (MsStats{P50Ms: 2, P95Ms: 2, MaxMs: 2}) {
		t.Errorf("item set_local stats = %+v", it.SetLocal)
	}
	if tg.Corpus != "tag" || tg.Count != 2 || tg.Setup.MaxMs != 2400 || tg.Setup.P50Ms != 2100 {
		t.Errorf("tag row = %+v, want count 2, setup p50 2100 max 2400", tg)
	}
	if again := sink.Drain(); len(again.Partials) != 0 || again.PartialsOverflow != 0 {
		t.Errorf("Drain must reset the partial records: %+v", again)
	}

	// The aggregate reaches the JSON and Markdown report.
	rep := &Report{Run: RunInfo{Profile: string(ProfileSmoke)}, C1: []ScenarioReport{{ID: "C1-L", Valid: true, Levels: []LevelReport{{Concurrency: 8, ServerLogs: got}}}}}
	b, err := json.Marshal(rep)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"lexical_partials"`, `"set_local_ms"`, `"p95_ms":25`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("JSON must contain %s", want)
		}
	}
	md := RenderMarkdown(rep)
	if !strings.Contains(md, "## Lexical branch partials (FU-SB-2b)") || !strings.Contains(md, "| C1-L | 8 | item | full | query | 5 | 0 / 100 / 100 | 2 / 2 / 2 | 15 / 25 / 25 |") {
		t.Errorf("Markdown lacks the partial table:\n%s", md)
	}
	if errs := mdTableShapeErrors(md); len(errs) > 0 {
		t.Errorf("Markdown table shape: %v", errs)
	}
	if none := RenderMarkdown(&Report{Run: RunInfo{Profile: string(ProfileSmoke)}}); !strings.Contains(none, "0 partial branches") {
		t.Errorf("a run without partial lines must say so")
	}
}

// TestServerLogsFileHasOnlyAllowlistedTokens (FU-SB-2b, privacy lens): hostile
// attributes (query text, a DSN with a password, an error string, SQL, names, ids)
// and hostile values of allowlisted keys never reach <base>-server-logs.json; the
// final scrub drops what a future sink change might let through; the allowlisted
// partial aggregates and class counts do reach it.
func TestServerLogsFileHasOnlyAllowlistedTokens(t *testing.T) {
	// Built from parts: a fake credential, never a real one.
	const dsn = "postgres://engram:" + "fake-pass-xyz" + "@127.0.0.1:55432/engram?sslmode=disable"
	sink := NewLogSink()
	lg := sink.Logger().With(slog.String("q", "with-attrs-secret"), slog.String("dsn", dsn))
	hostile := []slog.Attr{
		slog.String("q", "super secret query text"),
		slog.String("name", "Alice private item"),
		slog.String("tag", "private-tag-text"),
		slog.String("dsn", dsn),
		slog.String("err", `ERROR: relation "item" does not exist (SQLSTATE 42P01)`),
		slog.String("sql", "SELECT name FROM item WHERE user_id = 'u'"),
		slog.String("request_id", "req-secret-1"),
		slog.String("user_id", uuid.NewString()),
		slog.Group("detail", slog.String("q", "group-secret"), slog.String("dsn", dsn)),
		// allowlisted keys with hostile values
		slog.String("error_class", dsn),
		slog.String("route", "/api/v1/suggest?q=hostile-route-secret"),
		slog.String("branch", "alice private branch"),
		slog.String("status", "500; DROP TABLE item"),
	}
	lg.LogAttrs(context.Background(), slog.LevelWarn, "hostile warn line", hostile...)
	// A message that carries a DSN and one that carries q text: the sink keeps messages
	// (constants by convention), the scrub must still refuse them.
	lg.Warn("connect failed " + dsn)
	lg.Error("lexical failed for q=my-secret-query")
	// Hostile enum values on the partial line: dropped by the sink, never aggregated.
	lg.LogAttrs(context.Background(), slog.LevelInfo, PartialLogMessage,
		slog.String("corpus", "alice-private-notes"), slog.String("mode", "hello world secret"), slog.String("phase", dsn),
		slog.String("setup_ms", "7; DROP TABLE item"), slog.Int64("set_local_ms", 1), slog.Int64("query_ms", 1))
	// One valid partial line.
	partialLogger(sink)("item", "full", "query", 3, 1, 61)
	lg.Info("http_request", slog.String("route", "/api/v1/suggest"), slog.Int("status", 200))

	rep := &Report{
		Run: RunInfo{Profile: string(ProfileSmoke), HeadSHA: "0123456789abcdef0123456789abcdef01234567", GOARCH: "amd64"},
		C1:  []ScenarioReport{{ID: "C1-L", Valid: true, Levels: []LevelReport{{Concurrency: 8, ServerLogs: sink.Drain()}}}},
	}
	dir := t.TempDir()
	base := ReportFileBase(time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC), rep.Run.HeadSHA, ProfileSmoke, "amd64")
	path, err := WriteServerLogs(dir, base, rep)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != base+"-server-logs.json" || filepath.Dir(path) != dir {
		t.Fatalf("file = %s, want %s/%s-server-logs.json", path, dir, base)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, bad := range []string{
		"secret", "fake-pass-xyz", "postgres://", "sslmode", "127.0.0.1", "Alice", "private", "SELECT", "DROP TABLE",
		"does not exist", "42P01", "req-secret", "hostile-route", "my-secret-query", "dsn", "user_id", "request_id", "q=",
	} {
		if strings.Contains(text, bad) {
			t.Errorf("server-logs.json leaks %q:\n%s", bad, text)
		}
	}
	var doc ServerLogsDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("server-logs.json is not valid JSON: %v", err)
	}
	if doc.Schema != ServerLogsSchema || len(doc.Scenarios) != 1 || len(doc.Scenarios[0].Levels) != 1 {
		t.Fatalf("unexpected document shape: %+v", doc)
	}
	lv := doc.Scenarios[0].Levels[0]
	if lv.PartialLines != 1 || len(lv.Partials) != 1 || lv.Partials[0].Corpus != "item" || lv.Partials[0].QueryPhase.MaxMs != 61 {
		t.Errorf("the valid partial aggregate must reach the file: %+v", lv)
	}
	classes := map[string]int{}
	for _, c := range lv.Classes {
		classes[c.Level+"|"+c.Message] = c.Count
	}
	if classes["INFO|http_request"] != 1 || classes["WARN|hostile warn line"] != 1 {
		t.Errorf("allowlisted class counts must reach the file: %v", classes)
	}
	if doc.Dropped < 2 {
		t.Errorf("scrub_dropped_entries = %d, want >= 2 (the DSN and q= messages)", doc.Dropped)
	}

	// The scrub on its own: a document built by hand with a bad class message, a bad
	// sample, an out-of-enum partial and a bad SHA loses exactly those entries.
	d := ServerLogsDoc{Profile: "smoke", Arch: "amd64", HeadSHA: "not hex; secret", Scenarios: []ServerLogsScenario{{ID: "C1-L", Levels: []ServerLogsLevel{{
		Classes: []LogClassCount{{Level: "WARN", Message: "ok message", Count: 1}, {Level: "WARN", Message: "has q=secret", Count: 1}, {Level: "ERROR", Message: "fine", ErrorClass: "has spaces", Count: 1}},
		Samples: []string{`level=WARN msg="ok" status=500`, `level=WARN msg="ok" q=secret text`},
		Partials: []PartialAgg{
			{Corpus: "item", Mode: "full", Phase: "query", Count: 1},
			{Corpus: "alice", Mode: "full", Phase: "query", Count: 1},
		},
	}}}}}
	if n := ScrubServerLogsDoc(&d); n != 5 {
		t.Errorf("scrub dropped %d entries, want 5 (SHA, class message, class error_class, sample, partial)", n)
	}
	l := d.Scenarios[0].Levels[0]
	if d.HeadSHA != "" || len(l.Classes) != 1 || len(l.Samples) != 1 || len(l.Partials) != 1 {
		t.Errorf("scrub result = %+v / %+v", d, l)
	}
}
