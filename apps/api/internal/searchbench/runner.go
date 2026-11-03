//go:build searchbench

package searchbench

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pgvector/pgvector-go"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/semantic"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// Runner for the P05 search benchmark (plan mục 2.23, Task 10 W3).
//
// Requests go through the real chi router built like cmd/api mounts the search
// routes (httpx.NewRouter + RequestScopeMiddleware + suggest.Mount), with the
// production auth.SessionStore (real JWT parse + session/user DB lookups) and
// no network listener. The search_read token bucket is relaxed (compose.NewSearch
// has no injection point for it, so the same mount is assembled here with a
// relaxed bucket; the values are recorded in the report). The query-embedding
// provider is an in-process stub that never touches the network.

const (
	// BenchBucketCapacity / BenchBucketRefill relax the `search_read` limiter
	// (production: 40 burst, 20/s) so the benchmark measures the search path.
	BenchBucketCapacity = 1_000_000
	BenchBucketRefill   = 1_000_000.0

	sessionCookie = "sabk_session"
)

// ---- stub provider ---------------------------------------------------------

// StubProvider is the offline embedding provider of the benchmark: EmbedQuery
// sleeps `delay` (90 ms for C1-M) and returns the dataset's query vector for the
// normalized query text. It performs no network I/O and is never given q beyond
// the in-process map lookup.
type StubProvider struct {
	delay time.Duration
	mu    sync.RWMutex
	vecs  map[string][]float32
	calls atomic.Int64
}

// NewStubProvider constructs a stub with the given embed latency.
func NewStubProvider(delay time.Duration) *StubProvider {
	return &StubProvider{delay: delay, vecs: make(map[string][]float32)}
}

// Register maps normalized query texts to their dataset query vectors.
func (p *StubProvider) Register(qs []TextQuery) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, q := range qs {
		if q.QN != "" && q.Vec != nil {
			p.vecs[q.QN] = q.Vec
		}
	}
}

// Calls returns the number of EmbedQuery calls so far.
func (p *StubProvider) Calls() int64 { return p.calls.Load() }

func (p *StubProvider) Name() string         { return BenchProvider }
func (p *StubProvider) Model() string        { return BenchModel }
func (p *StubProvider) ModelVersion() string { return BenchModelVersion }
func (p *StubProvider) Dims() int            { return BenchDims }
func (p *StubProvider) MaxBatch() int        { return embedding.MaxBatch }

func (p *StubProvider) EmbedDocuments(context.Context, []string) ([][]float32, error) {
	return nil, errors.New("searchbench stub: documents are never embedded")
}

func (p *StubProvider) EmbedQuery(ctx context.Context, q string) ([]float32, error) {
	p.calls.Add(1)
	if p.delay > 0 {
		t := time.NewTimer(p.delay)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return nil, ctx.Err()
		}
	}
	p.mu.RLock()
	v, ok := p.vecs[q]
	p.mu.RUnlock()
	if !ok {
		return nil, errors.New("searchbench stub: unknown query")
	}
	return v, nil
}

// ---- recording vector searcher ----------------------------------------------

// RecordingSearcher wraps the production StoreVectorSearcher and counts the
// execution paths of every vector branch of the hybrid scenarios.
type RecordingSearcher struct {
	inner semantic.VectorSearcher
	mu    sync.Mutex
	paths map[string]int64
	timed int64
	under int64
}

// Snapshot returns path counts, timeouts and unrecovered underfills so far.
func (r *RecordingSearcher) Snapshot() (paths map[string]int64, timedOut, underfill int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	paths = make(map[string]int64, len(r.paths))
	for k, v := range r.paths {
		paths[k] = v
	}
	return paths, r.timed, r.under
}

func (r *RecordingSearcher) VectorSearch(ctx context.Context, pin generation.Pin, userID uuid.UUID,
	corpus generation.Corpus, qvec []float32, k int, deadline time.Time, knobs semantic.VectorSearchKnobs,
) ([]semantic.VectorHit, semantic.VectorPathStats, error) {
	hits, st, err := r.inner.VectorSearch(ctx, pin, userID, corpus, qvec, k, deadline, knobs)
	r.mu.Lock()
	r.paths[string(corpus)+"/"+string(st.Path)]++
	if st.TimedOut {
		r.timed++
	}
	if st.Underfill && st.Path == semantic.VectorPathANNShort {
		r.under++
	}
	r.mu.Unlock()
	return hits, st, err
}

// ---- harness ---------------------------------------------------------------

// HarnessConfig configures NewHarness.
type HarnessConfig struct {
	PoolMaxConns int           // 0 = production pool (db.NewPool, 10 conns)
	Semantic     bool          // wire the real semantic.Runtime + stub provider (hybrid scenarios)
	StubDelay    time.Duration // 90 ms for C1-M

	// SessionSQL is run on every new connection of the harness pool (pgxpool
	// AfterConnect). TEST-ONLY: the low-recall self-check uses it to make the
	// planner scan the HNSW index of its tiny fixture (advisor-dec-289 pattern);
	// it is never set for the benchmark (see benchHarnessConfig) and never exists
	// in production code, so every measured cell runs on Postgres defaults.
	SessionSQL []string
}

// benchHarnessConfig is the harness of TestSearchBench: the hybrid scenarios with
// the 90 ms stub and the production pool, with NO session/planner overrides.
func benchHarnessConfig() HarnessConfig {
	return HarnessConfig{Semantic: true, StubDelay: StubEmbedDelay}
}

// Harness bundles the router, pool and stubs of one benchmark database.
type Harness struct {
	Pool     *pgxpool.Pool
	Router   http.Handler
	Service  *suggest.Service
	Runtime  *semantic.Runtime
	Stub     *StubProvider
	Searcher *RecordingSearcher
	Sessions *auth.SessionStore
	Seed     *SeedResult
	Pin      generation.Pin
	PoolMax  int

	// SessionSQL echoes HarnessConfig.SessionSQL (test-only planner overrides).
	SessionSQL []string

	// LogSink receives every server log record (httpx router + semantic runtime)
	// through the allowlist handler of advisor-dec-313; RunLoad drains it per level.
	LogSink *LogSink

	tokMu  sync.Mutex
	tokens map[int]string
}

// NewHarness opens the pool, builds the router and pins g1.
func NewHarness(ctx context.Context, dsn string, sr *SeedResult, cfg HarnessConfig) (*Harness, error) {
	var (
		pool *pgxpool.Pool
		err  error
	)
	if cfg.PoolMaxConns <= 0 && len(cfg.SessionSQL) == 0 {
		pool, err = db.NewPool(ctx, dsn)
	} else {
		var pc *pgxpool.Config
		pc, err = pgxpool.ParseConfig(dsn)
		if err == nil {
			pc.MaxConns = int32(cfg.PoolMaxConns)
			if cfg.PoolMaxConns <= 0 {
				pc.MaxConns = 10 // the production pool size (db.NewPool)
			}
			pc.MinConns = 1
			if len(cfg.SessionSQL) > 0 {
				stmts := append([]string(nil), cfg.SessionSQL...)
				pc.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
					for _, s := range stmts {
						if _, err := c.Exec(ctx, s); err != nil {
							return fmt.Errorf("session setup %q: %w", s, err)
						}
					}
					return nil
				}
			}
			pool, err = pgxpool.NewWithConfig(ctx, pc)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("searchbench: open pool: %w", err)
	}
	h := &Harness{Pool: pool, Seed: sr, PoolMax: int(pool.Config().MaxConns), SessionSQL: cfg.SessionSQL, tokens: map[int]string{}, LogSink: NewLogSink()}

	// Warm a few connections so the first requests do not pay the handshake.
	var warm []*pgxpool.Conn
	for range min(4, h.PoolMax) {
		c, err := pool.Acquire(ctx)
		if err != nil {
			pool.Close()
			return nil, fmt.Errorf("searchbench: warm pool: %w", err)
		}
		warm = append(warm, c)
	}
	for _, c := range warm {
		c.Release()
	}

	pinner := generation.NewPinner(pool)
	pin, err := pinner.ActivePin(ctx)
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("searchbench: g1 is not active: %w", err)
	}
	h.Pin = pin

	_, metrics := obs.NewRegistry()
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		pool.Close()
		return nil, err
	}
	cursorKey, err := suggest.DeriveCursorKey(secret)
	if err != nil {
		pool.Close()
		return nil, err
	}

	// Real session store; the issuer/validator clock is frozen at start so the
	// 10-minute access token never expires mid-run (JWT parse + 2 DB lookups
	// per request are still the production code path).
	frozen := clock.NewFixed(time.Now())
	tokens := auth.NewTokenIssuer(secret, "https://bench.invalid", "https://bench.invalid", frozen)
	h.Sessions = auth.NewSessionStore(pool, tokens, frozen)

	var near suggest.NearSource = suggest.NewNoopNearSource()
	if cfg.Semantic {
		h.Stub = NewStubProvider(cfg.StubDelay)
		client := embedding.NewClient(h.Stub, "", "")
		if client.Identity.Key() != BenchIdentity().Key() {
			pool.Close()
			return nil, errors.New("searchbench: stub client identity differs from g1 identity")
		}
		h.Searcher = &RecordingSearcher{inner: semantic.NewStoreVectorSearcher(pool), paths: map[string]int64{}}
		h.Runtime = semantic.NewRuntime(semantic.RuntimeConfig{
			Enabled:   true,
			Provider:  BenchProvider,
			Knobs:     semantic.DefaultVectorSearchKnobs(),
			ClientSet: embedding.NewClientSet(client, nil),
			Pinner:    pinner,
			Calibration: func(id embedid.Identity) (float64, string, bool) {
				if id.Key() == BenchIdentity().Key() {
					return float64(MinCos), BenchCalibrationRef, true
				}
				return 0, "", false
			},
			Cache:          semantic.NewQueryCache(semantic.DefaultCacheMaxEntries, semantic.DefaultCacheTTL, nil),
			VectorSearcher: h.Searcher,
			SettingsReader: semantic.NewDBUserSettingsReader(pool),
			ItemTagLoader:  semantic.NewDBItemTagRefLoader(pool),
			Metrics:        metrics,
			Logger:         h.LogSink.Logger(), // advisor-dec-313: allowlist sink, not io.Discard
			Clock:          clock.System{},
		})
		near = h.Runtime.NearSource()
	}

	h.Service = suggest.NewService(pool, clock.System{}, near, metrics, cursorKey)
	bucket := httpx.NewTokenBucket(BenchBucketCapacity, BenchBucketRefill, clock.System{})
	handler := suggest.NewHandler(h.Service, bucket)
	inner := suggest.Mount(handler)
	h.Router = httpx.NewRouter(httpx.Deps{
		Logger:           h.LogSink.Logger(), // advisor-dec-313
		MetricsCollector: metrics,
		Authenticator:    h.Sessions,
		MountAPI: func(v1 chi.Router, d httpx.Deps) {
			v1.Group(func(r chi.Router) {
				r.Use(semantic.RequestScopeMiddleware)
				inner(r, d)
			})
		},
	})
	return h, nil
}

// Close releases the pool.
func (h *Harness) Close() {
	if h != nil && h.Pool != nil {
		h.Pool.Close()
	}
}

// ensureTokens issues a real session + access token for each tenant user.
func (h *Harness) ensureTokens(ctx context.Context, tenants []int) error {
	h.tokMu.Lock()
	defer h.tokMu.Unlock()
	for _, t := range tenants {
		if _, ok := h.tokens[t]; ok {
			continue
		}
		res, err := h.Sessions.Issue(ctx, nil, auth.IssueParams{
			UserID: h.Seed.Spec.Tenants[t].UserID, IPHash: make([]byte, 32), UserAgent: "searchbench", DeviceLabel: "searchbench",
		})
		if err != nil {
			return fmt.Errorf("searchbench: issue session for tenant %d: %w", t, err)
		}
		h.tokens[t] = res.Access
	}
	return nil
}

func (h *Harness) token(t int) string {
	h.tokMu.Lock()
	defer h.tokMu.Unlock()
	return h.tokens[t]
}

// ---- sanitized server log sink (advisor-dec-313) ----------------------------

// advisor-dec-313: the harness server loggers used io.Discard, so a single c=8
// HTTP 500 (CI 41502888581: lexical statements cancelled, SQLSTATE 57014) was
// undiagnosable. LogSink is an in-memory slog.Handler that keeps ONLY an
// allowlist of attributes (see allowedLogKey) and drops everything else, so no
// q text, names, ids, SQL or error strings can reach the report (privacy lens).
// Log messages are fixed lower-case constants by project convention and are kept
// (capped) when they fit the message vocabulary (safeLogMessage); any other message is
// counted under "other" and its text is dropped.

const (
	maxLogSamples    = 5   // sanitized sample lines kept per drained run
	maxLogClasses    = 24  // distinct (level, message, error_class) kept per drained run
	maxLogValueLen   = 80  // longest allowlisted string attribute value kept
	maxLogMessageLen = 120 // longest log message kept
)

// allowedLogKey is the attribute allowlist: error_class, problem code, status,
// route pattern, corpus/branch, counts and (FU-SB-2b, advisor-dec-337) the fields
// of the "suggest lexical branch partial" line: the enum tokens mode and phase
// and the integer millisecond timings setup_ms, set_local_ms and query_ms. Level
// and message are record fields, always kept. Every other key (q, name, sql,
// request_id, err, user id, ...) is dropped.
func allowedLogKey(k string) bool {
	switch k {
	case "error_class", "code", "problem_code", "status", "route", "corpus", "branch", "count",
		"mode", "phase", "setup_ms", "set_local_ms", "query_ms":
		return true
	}
	return strings.HasSuffix(k, "_count")
}

func numericLogKey(k string) bool {
	switch k {
	case "status", "count", "setup_ms", "set_local_ms", "query_ms":
		return true
	}
	return strings.HasSuffix(k, "_count")
}

// enumLogValues pins the keys whose value is a closed enum in production code
// (suggest.CorpusItem/CorpusTag, suggest.ModePrefix/ModeFull/ModeRecent, the
// phases of runBranch). A value outside the enum is dropped even though it would
// pass safeLogToken, so a hostile or mistaken value (a corpus or mode that is
// really a user-chosen name) can never reach the report or the artifact.
var enumLogValues = map[string]map[string]bool{
	"corpus": {"item": true, "tag": true},
	"mode":   {"prefix": true, "full": true, "recent": true},
	"phase":  {"setup": true, "set_local": true, "query": true},
}

// enumLogValueOK reports whether v is allowed for key k (always true for keys
// that are not pinned to an enum).
func enumLogValueOK(k, v string) bool {
	allowed, pinned := enumLogValues[k]
	return !pinned || allowed[v]
}

// safeLogToken accepts only short fixed-vocabulary tokens (codes, route
// patterns, corpus/branch names): no spaces, quotes or free text.
func safeLogToken(v string) bool {
	if v == "" || len(v) > maxLogValueLen {
		return false
	}
	for _, r := range v {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case strings.ContainsRune("_./{}:*-", r):
		default:
			return false
		}
	}
	return true
}

// appendSanitized appends the allowlisted, value-checked "key=value" pairs of a
// to out (groups are flattened by leaf key). Anything else is dropped.
func appendSanitized(out []string, a slog.Attr) []string {
	v := a.Value.Resolve()
	if v.Kind() == slog.KindGroup {
		for _, g := range v.Group() {
			out = appendSanitized(out, g)
		}
		return out
	}
	if !allowedLogKey(a.Key) {
		return out
	}
	if numericLogKey(a.Key) {
		switch v.Kind() {
		case slog.KindInt64:
			return append(out, a.Key+"="+strconv.FormatInt(v.Int64(), 10))
		case slog.KindUint64:
			return append(out, a.Key+"="+strconv.FormatUint(v.Uint64(), 10))
		}
		return out
	}
	if v.Kind() == slog.KindString && safeLogToken(v.String()) && enumLogValueOK(a.Key, v.String()) {
		return append(out, a.Key+"="+v.String())
	}
	return out
}

type logClassKey struct{ level, message, errorClass string }

// LogSink collects sanitized server log records; safe for concurrent use.
type LogSink struct {
	mu       sync.Mutex
	counts   map[logClassKey]int
	samples  []string
	seen     map[string]bool
	partials []PartialRecord // FU-SB-2b: parsed "suggest lexical branch partial" lines
	overflow int             // partial lines beyond maxPartialRecords
	rejected int             // partial lines the parser refused (field or enum drift)
}

// NewLogSink returns an empty sink.
func NewLogSink() *LogSink {
	return &LogSink{counts: map[logClassKey]int{}, seen: map[string]bool{}}
}

// Logger returns a slog.Logger that writes into the sink.
func (s *LogSink) Logger() *slog.Logger { return slog.New(&sinkHandler{sink: s}) }

// Drain returns the accumulated summary and resets the sink.
func (s *LogSink) Drain() ServerLogSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out ServerLogSummary
	for k, n := range s.counts {
		out.Classes = append(out.Classes, LogClassCount{Level: k.level, Message: k.message, ErrorClass: k.errorClass, Count: n})
	}
	sort.Slice(out.Classes, func(i, j int) bool {
		a, b := out.Classes[i], out.Classes[j]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		if a.Level != b.Level {
			return a.Level < b.Level
		}
		if a.Message != b.Message {
			return a.Message < b.Message
		}
		return a.ErrorClass < b.ErrorClass
	})
	if len(out.Classes) > maxLogClasses {
		out.Classes = out.Classes[:maxLogClasses]
	}
	out.Samples = append(out.Samples, s.samples...)
	out.Partials = AggregatePartials(s.partials)
	out.PartialsOverflow = s.overflow
	out.PartialsRejected = s.rejected
	s.rejected = 0
	s.counts = map[logClassKey]int{}
	s.samples = nil
	s.seen = map[string]bool{}
	s.partials = nil
	s.overflow = 0
	return out
}

func (s *LogSink) record(level slog.Level, msg string, kv []string) {
	if len(msg) > maxLogMessageLen {
		msg = msg[:maxLogMessageLen]
	}
	// Outside the message vocabulary the text is not kept, only the count (RV-W4-1-5).
	msg = safeLogMessage(msg)
	class := ""
	for _, p := range kv {
		if v, ok := strings.CutPrefix(p, "error_class="); ok {
			class = v
		}
	}
	line := "level=" + level.String() + " msg=" + strconv.Quote(msg)
	if len(kv) > 0 {
		line += " " + strings.Join(kv, " ")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.counts[logClassKey{level.String(), msg, class}]++
	if msg == PartialLogMessage {
		if rec, ok := parsePartialRecord(kv); !ok {
			// Counted, never dropped silently: a changed partial line shape must not
			// read as "0 partial branches" (RV-W4-1-3).
			s.rejected++
		} else if len(s.partials) < maxPartialRecords {
			s.partials = append(s.partials, rec)
		} else {
			s.overflow++
		}
	}
	// Samples: first distinct WARN+ lines only (the INFO access log is counted, not sampled).
	if level >= slog.LevelWarn && len(s.samples) < maxLogSamples && !s.seen[line] {
		s.seen[line] = true
		s.samples = append(s.samples, line)
	}
}

type sinkHandler struct {
	sink *LogSink
	kv   []string // sanitized WithAttrs pairs
}

func (h *sinkHandler) Enabled(_ context.Context, l slog.Level) bool { return l >= slog.LevelInfo }

func (h *sinkHandler) Handle(_ context.Context, r slog.Record) error {
	kv := append([]string(nil), h.kv...)
	r.Attrs(func(a slog.Attr) bool {
		kv = appendSanitized(kv, a)
		return true
	})
	h.sink.record(r.Level, r.Message, kv)
	return nil
}

func (h *sinkHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	kv := append([]string(nil), h.kv...)
	for _, a := range attrs {
		kv = appendSanitized(kv, a)
	}
	return &sinkHandler{sink: h.sink, kv: kv}
}

// WithGroup is a no-op: groups are flattened by leaf key.
func (h *sinkHandler) WithGroup(string) slog.Handler { return h }

type statusProblem struct {
	status int
	code   string
}

// problemCodeOf reads ONLY the `code` field of a JSON problem body (advisor-dec-313);
// the body itself is never kept. Non-JSON -> "unparsed", missing -> "none",
// not a safe token -> "invalid".
func problemCodeOf(body []byte) string {
	var p struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return "unparsed"
	}
	if p.Code == "" {
		return "none"
	}
	if !safeLogToken(p.Code) {
		return "invalid"
	}
	return p.Code
}

func sortedStatusCodes(m map[statusProblem]int) []StatusCodeCount {
	out := make([]StatusCodeCount, 0, len(m))
	for k, n := range m {
		out = append(out, StatusCodeCount{Status: k.status, ProblemCode: k.code, Count: n})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Status != out[j].Status {
			return out[i].Status < out[j].Status
		}
		return out[i].ProblemCode < out[j].ProblemCode
	})
	return out
}

// ---- closed-loop load ------------------------------------------------------

// LoadReq is one request of a closed-loop run.
type LoadReq struct {
	Tenant int
	Raw    string // raw query string (never logged)
}

// LoadSpec describes one closed-loop run.
type LoadSpec struct {
	Concurrency int
	Warmup      int // first requests, discarded
	Measured    int
	Tenants     []int
	Req         func(i int) LoadReq
}

// LoadResult is the raw outcome of one closed-loop run.
type LoadResult struct {
	Concurrency    int
	Warmup         int
	Latencies      []time.Duration // measured requests only
	Errors         int
	Statuses       map[int]int
	ErrorCodes     []StatusCodeCount // non-200 responses by (status, problem code); advisor-dec-313
	ServerLogs     ServerLogSummary  // sanitized server log classes of the run (warm-up included)
	CrossTenant    int
	SemanticRan    int
	SemanticOff    int
	SemanticReason map[string]int // reason counts of the requests where semantic did not run
	LexicalPartial int
	Wall           time.Duration
	StubCalls      int64
}

type suggestIDs struct {
	Tags []struct {
		ID uuid.UUID `json:"id"`
	} `json:"tags"`
	Items []struct {
		ID   uuid.UUID `json:"id"`
		Tags []struct {
			ID uuid.UUID `json:"id"`
		} `json:"tags"`
	} `json:"items"`
	Near []struct {
		ID uuid.UUID `json:"id"`
	} `json:"near"`
	Semantic       bool     `json:"semantic"`
	SemanticReason *string  `json:"semantic_reason"`
	LexicalPartial []string `json:"lexical_partial"`
}

type workerAcc struct {
	lat            []time.Duration
	errors         int
	statuses       map[int]int
	errCodes       map[statusProblem]int
	cross          int
	semRan, semOff int
	semReasons     map[string]int // why semantic did not run (response semantic_reason)
	partial        int
}

// RunLoad executes spec as a closed loop of `Concurrency` clients through the
// router. Warm-up requests are executed (to warm caches/plans) but discarded.
func (h *Harness) RunLoad(ctx context.Context, spec LoadSpec) (LoadResult, error) {
	if err := h.ensureTokens(ctx, spec.Tenants); err != nil {
		return LoadResult{}, err
	}
	tok := map[int]string{}
	for _, t := range spec.Tenants {
		tok[t] = h.token(t)
	}
	total := spec.Warmup + spec.Measured
	conc := max(1, spec.Concurrency)
	var next atomic.Int64
	accs := make([]*workerAcc, conc)
	var wg sync.WaitGroup
	stubBefore := int64(0)
	if h.Stub != nil {
		stubBefore = h.Stub.Calls()
	}
	owner := h.Seed.Owner
	h.LogSink.Drain() // isolate this run's server log records
	start := time.Now()
	for w := range conc {
		acc := &workerAcc{statuses: map[int]int{}, errCodes: map[statusProblem]int{}, semReasons: map[string]int{}}
		accs[w] = acc
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				i := int(next.Add(1) - 1)
				if i >= total {
					return
				}
				lr := spec.Req(i)
				req := httptest.NewRequest(http.MethodGet, "/api/v1/suggest?"+lr.Raw, nil)
				req.AddCookie(&http.Cookie{Name: sessionCookie, Value: tok[lr.Tenant]})
				rec := httptest.NewRecorder()
				t0 := time.Now()
				h.Router.ServeHTTP(rec, req)
				lat := time.Since(t0)
				if i < spec.Warmup {
					continue
				}
				acc.lat = append(acc.lat, lat)
				acc.statuses[rec.Code]++
				if rec.Code != http.StatusOK {
					acc.errors++
					// advisor-dec-313: only the problem `code` field of the body is read.
					acc.errCodes[statusProblem{rec.Code, problemCodeOf(rec.Body.Bytes())}]++
					continue
				}
				var body suggestIDs
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					acc.errors++
					continue
				}
				if body.Semantic {
					acc.semRan++
				} else {
					acc.semOff++
					reason := "none"
					if body.SemanticReason != nil {
						reason = *body.SemanticReason
					}
					acc.semReasons[reason]++
				}
				if len(body.LexicalPartial) > 0 {
					acc.partial++
				}
				want := int32(lr.Tenant)
				check := func(id uuid.UUID) {
					if o, ok := owner[id]; !ok || o != want {
						acc.cross++
					}
				}
				for _, x := range body.Tags {
					check(x.ID)
				}
				for _, x := range body.Items {
					check(x.ID)
					for _, tr := range x.Tags {
						check(tr.ID)
					}
				}
				for _, x := range body.Near {
					check(x.ID)
				}
			}
		}()
	}
	wg.Wait()
	res := LoadResult{Concurrency: conc, Warmup: spec.Warmup, Statuses: map[int]int{}, SemanticReason: map[string]int{}, Wall: time.Since(start)}
	res.ServerLogs = h.LogSink.Drain()
	errCodes := map[statusProblem]int{}
	for _, a := range accs {
		for k, n := range a.errCodes {
			errCodes[k] += n
		}
		res.Latencies = append(res.Latencies, a.lat...)
		res.Errors += a.errors
		res.CrossTenant += a.cross
		res.SemanticRan += a.semRan
		res.SemanticOff += a.semOff
		res.LexicalPartial += a.partial
		for c, n := range a.statuses {
			res.Statuses[c] += n
		}
		for r, n := range a.semReasons {
			res.SemanticReason[r] += n
		}
	}
	res.ErrorCodes = sortedStatusCodes(errCodes)
	if h.Stub != nil {
		res.StubCalls = h.Stub.Calls() - stubBefore
	}
	if err := ctx.Err(); err != nil {
		return res, err
	}
	return res, nil
}

func levelReport(r LoadResult) LevelReport {
	rps := 0.0
	if r.Wall > 0 {
		rps = float64(len(r.Latencies)+r.Warmup) / r.Wall.Seconds()
	}
	return LevelReport{
		Concurrency: r.Concurrency, Stats: Summarize(r.Latencies, r.Errors), Warmup: r.Warmup,
		Wall: r.Wall.Seconds(), RPS: rps, SemanticRan: r.SemanticRan, SemanticOff: r.SemanticOff,
		SemanticOffReasons: r.SemanticReason, Statuses: r.Statuses, ErrorCodes: r.ErrorCodes, ServerLogs: r.ServerLogs, LexicalPartial: r.LexicalPartial, CrossTenant: r.CrossTenant, StubCalls: r.StubCalls,
	}
}

// ---- C1 scenarios ----------------------------------------------------------

// LoadLevel is one concurrency level of a scenario.
type LoadLevel struct{ Concurrency, Warmup, Measured int }

// ScenarioPlan lists the concurrency levels (targets apply at 8).
type ScenarioPlan struct{ Levels []LoadLevel }

func suggestRaw(q string, semantic bool) string {
	v := url.Values{}
	v.Set("q", q)
	if semantic {
		v.Set("semantic", "1")
	} else {
		v.Set("semantic", "0")
	}
	return v.Encode()
}

// RunC1L runs the lexical scenario (semantic=0) on the given queries.
func (h *Harness) RunC1L(ctx context.Context, qs []TextQuery, plan ScenarioPlan) (ScenarioReport, error) {
	rep := ScenarioReport{ID: "C1-L", Description: "lexical server (semantic=0) on the whale tenant(s)", Valid: true}
	tenants := tenantsOf(qs)
	for _, lv := range plan.Levels {
		r, err := h.RunLoad(ctx, LoadSpec{Concurrency: lv.Concurrency, Warmup: lv.Warmup, Measured: lv.Measured, Tenants: tenants,
			Req: func(i int) LoadReq {
				q := qs[i%len(qs)]
				return LoadReq{Tenant: q.TenantIdx, Raw: suggestRaw(q.Text, false)}
			}})
		if err != nil {
			return rep, err
		}
		rep.Levels = append(rep.Levels, levelReport(r))
		if r.SemanticRan > 0 {
			rep.Invalidate("semantic ran in a semantic=0 scenario")
		}
	}
	return rep, nil
}

// RunC1H runs hybrid with the query-embedding cache warm (every measured
// request is a cache hit; the stub must not be called during the run).
func (h *Harness) RunC1H(ctx context.Context, qs []TextQuery, plan ScenarioPlan) (ScenarioReport, error) {
	rep := ScenarioReport{ID: "C1-H", Description: "hybrid, query-embedding cache hit", Valid: true}
	if h.Stub == nil {
		return rep, errors.New("searchbench: C1-H needs a semantic harness")
	}
	h.Stub.Register(qs)
	tenants := tenantsOf(qs)
	mk := func(i int) LoadReq {
		q := qs[i%len(qs)]
		return LoadReq{Tenant: q.TenantIdx, Raw: suggestRaw(q.Text, true)}
	}
	// Fill the cache: one pass through every query (discarded), the stub delay
	// does not matter here.
	h.Stub.delay = 0
	if _, err := h.RunLoad(ctx, LoadSpec{Concurrency: 4, Warmup: len(qs), Measured: 0, Tenants: tenants, Req: mk}); err != nil {
		return rep, err
	}
	for _, lv := range plan.Levels {
		r, err := h.RunLoad(ctx, LoadSpec{Concurrency: lv.Concurrency, Warmup: lv.Warmup, Measured: lv.Measured, Tenants: tenants, Req: mk})
		if err != nil {
			return rep, err
		}
		rep.Levels = append(rep.Levels, levelReport(r))
		if r.StubCalls > 0 {
			rep.Invalidate(fmt.Sprintf("%d provider calls during the run: not a pure cache-hit run (c=%d)", r.StubCalls, lv.Concurrency))
		}
		// At the target concurrency every measured request must have run
		// semantic (SBW3-1-4); other levels only warn (LevelWarnings).
		rep.CheckHybridLevel(rep.Levels[len(rep.Levels)-1])
	}
	return rep, nil
}

// RunC1M runs hybrid with a guaranteed cache miss per request (unique query
// text) and the 90 ms stub provider (OQ-21).
func (h *Harness) RunC1M(ctx context.Context, g *Generator, tenants []int, plan ScenarioPlan, itemLimit map[int]int) (ScenarioReport, error) {
	rep := ScenarioReport{ID: "C1-M", Description: fmt.Sprintf("hybrid, cache miss, stub provider %.0f ms", ms(StubEmbedDelay)), Valid: true}
	if h.Stub == nil {
		return rep, errors.New("searchbench: C1-M needs a semantic harness")
	}
	h.Stub.delay = StubEmbedDelay
	for li, lv := range plan.Levels {
		total := lv.Warmup + lv.Measured
		var qs []TextQuery
		perTenant := (total + len(tenants) - 1) / len(tenants)
		for ti, t := range tenants {
			qs = append(qs, BuildHybridQueries(g, t, perTenant, true, 1_000_000*(li+1)+100_000*ti, itemLimit[t])...)
		}
		if len(qs) < total {
			return rep, fmt.Errorf("searchbench: built %d unique hybrid queries, need %d", len(qs), total)
		}
		h.Stub.Register(qs)
		r, err := h.RunLoad(ctx, LoadSpec{Concurrency: lv.Concurrency, Warmup: lv.Warmup, Measured: lv.Measured, Tenants: tenants,
			Req: func(i int) LoadReq {
				q := qs[i]
				return LoadReq{Tenant: q.TenantIdx, Raw: suggestRaw(q.Text, true)}
			}})
		if err != nil {
			return rep, err
		}
		rep.Levels = append(rep.Levels, levelReport(r))
		if r.StubCalls < int64(total)*95/100 {
			rep.Invalidate(fmt.Sprintf("only %d provider calls for %d requests: not a cache-miss run (c=%d)", r.StubCalls, total, lv.Concurrency))
		}
		// At the target concurrency every measured request must have run
		// semantic (SBW3-1-4); other levels only warn (LevelWarnings).
		rep.CheckHybridLevel(rep.Levels[len(rep.Levels)-1])
	}
	return rep, nil
}

func tenantsOf(qs []TextQuery) []int {
	seen := map[int]struct{}{}
	var out []int
	for _, q := range qs {
		if _, ok := seen[q.TenantIdx]; !ok {
			seen[q.TenantIdx] = struct{}{}
			out = append(out, q.TenantIdx)
		}
	}
	return out
}

// ---- C2 --------------------------------------------------------------------

const unlimitedScan = store.MaxHNSWMaxScanTuples

// NewKnob builds a KnobSet with its canonical label.
func NewKnob(ef, scan, exactMax int) KnobSet {
	scanLabel := fmt.Sprintf("%d", scan)
	if scan >= unlimitedScan {
		scanLabel = "unlimited"
	}
	return KnobSet{
		Label:    fmt.Sprintf("ef%d_scan%s_exact%d", ef, scanLabel, exactMax),
		EfSearch: ef, MaxScanTuples: scan, ExactMax: exactMax,
	}
}

// DefaultKnob is the production default (SPEC §6.4: ef 64, scan 20000, exact 5000).
func DefaultKnob() KnobSet {
	return NewKnob(store.DefaultHNSWEfSearch, store.DefaultHNSWMaxScanTuples, store.DefaultExactMaxVectors)
}

// FullKnobMatrix is the whole plan 2.23 matrix: ef_search {40,64,100} x
// max_scan_tuples {20000, 50000, unlimited} x SEARCH_EXACT_MAX_VECTORS {5000,10000,20000}.
func FullKnobMatrix() []KnobSet {
	var out []KnobSet
	for _, ex := range []int{5000, 10000, 20000} {
		for _, scan := range []int{20000, 50000, unlimitedScan} {
			for _, ef := range []int{40, 64, 100} {
				out = append(out, NewKnob(ef, scan, ex))
			}
		}
	}
	return out
}

// SmokeKnobMatrix is the documented smoke subset: the production default plus
// ef_search {40,64,100} x max_scan_tuples {20000, unlimited} at
// SEARCH_EXACT_MAX_VECTORS=1000, which forces the 10k item and 2k tag corpora of
// the smoke tenant onto ANN (the default 5000 keeps the 2k tag corpus exact).
func SmokeKnobMatrix() []KnobSet {
	out := []KnobSet{DefaultKnob()}
	for _, scan := range []int{20000, unlimitedScan} {
		for _, ef := range []int{40, 64, 100} {
			out = append(out, NewKnob(ef, scan, 1000))
		}
	}
	return out
}

func (k KnobSet) storeKnobs(branch time.Duration) store.VectorSearchKnobs {
	fb := k.FallbackMax
	switch {
	case k.ForceNoFallbk:
		fb = k.ExactMax
	case fb == 0:
		fb = max(store.DefaultExactFallbackMaxVectors, k.ExactMax)
	}
	return store.VectorSearchKnobs{
		ExactMaxVectors: k.ExactMax, FallbackMaxVectors: fb,
		EfSearch: k.EfSearch, MaxScanTuples: k.MaxScanTuples, IterativeScan: k.Iterative,
		BranchTimeout: branch, FallbackMinBudget: store.DefaultVectorFallbackMinBudget,
	}
}

// C2Config configures RunC2.
type C2Config struct {
	QueriesPerCell int
	Workers        int
	Knobs          []KnobSet
	Default        KnobSet
	MatrixNote     string
	Corpora        []generation.Corpus
	Classes        map[TenantClass][]int // seeded tenants per class
	ItemLimit      map[int]int           // self-check truncation (0/absent = all)
	TagLimit       map[int]int
	BranchTimeout  time.Duration // 0 = production 80 ms
	CountSamples   int
	Explain        bool
}

func (h *Harness) tableOf(corpus generation.Corpus) (string, string) {
	if corpus == generation.CorpusItem {
		return h.Pin.ItemTable, "item"
	}
	return h.Pin.TagTable, "tag"
}

// exactOracle returns the tenant's exact top-k (ordered by cosine distance)
// with cosine values. The planner cannot use HNSW: the vectors are read through a
// MATERIALIZED pre-selection by tenant PK and ordered in a second step.
func (h *Harness) exactOracle(ctx context.Context, corpus generation.Corpus, user uuid.UUID, vec []float32, k int) ([]ScoredID, error) {
	tbl, live := h.tableOf(corpus)
	sql := fmt.Sprintf(`WITH t AS MATERIALIZED (SELECT target_id, embedding FROM %s WHERE user_id = $1)
SELECT t.target_id, 1 - (t.embedding <=> $2::vector)
  FROM t JOIN %s x ON x.user_id = $1 AND x.id = t.target_id AND x.deleted_at IS NULL
 ORDER BY t.embedding <=> $2::vector, t.target_id
 LIMIT $3`, pgx.Identifier{tbl}.Sanitize(), pgx.Identifier{live}.Sanitize())
	rows, err := h.Pool.Query(ctx, sql, user, pgvector.NewVector(vec), k)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ScoredID
	for rows.Next() {
		var s ScoredID
		if err := rows.Scan(&s.ID, &s.Cos); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

type vqJob struct {
	q VectorQuery
	e []uuid.UUID
}

func parallelEach(ctx context.Context, workers, n int, fn func(i int) error) error {
	var next atomic.Int64
	var wg sync.WaitGroup
	var first error
	var mu sync.Mutex
	for range max(1, workers) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				i := int(next.Add(1) - 1)
				if i >= n {
					return
				}
				if err := fn(i); err != nil {
					mu.Lock()
					if first == nil {
						first = err
					}
					mu.Unlock()
					return
				}
			}
		}()
	}
	wg.Wait()
	if first != nil {
		return first
	}
	return ctx.Err()
}

// RunVectorCell runs one knob set over prepared queries (with their oracle E)
// and scores every outcome with the frozen definitions.
func (h *Harness) RunVectorCell(ctx context.Context, corpus generation.Corpus, class TenantClass, knob KnobSet,
	jobs []vqJob, workers int, branch time.Duration) (CellAgg, error) {
	outs := make([]QueryOutcome, len(jobs))
	kn := knob.storeKnobs(branch)
	err := parallelEach(ctx, workers, len(jobs), func(i int) error {
		j := jobs[i]
		user := h.Seed.Spec.Tenants[j.q.TenantIdx].UserID
		t0 := time.Now()
		hits, st, err := store.VectorSearch(ctx, h.Pool, h.Pin, user, corpus, j.q.Vec, RecallK, time.Now().Add(branch), kn)
		lat := time.Since(t0)
		if err != nil {
			return fmt.Errorf("searchbench: VectorSearch (%s/%s/%s): %w", corpus, class, knob.Label, err)
		}
		got := make([]uuid.UUID, len(hits))
		cross := 0
		for x, hit := range hits {
			got[x] = hit.ID
			if o, ok := h.Seed.Owner[hit.ID]; !ok || o != int32(j.q.TenantIdx) {
				cross++
			}
		}
		outs[i] = QueryOutcome{
			Corpus: string(corpus), Class: string(class), Kind: j.q.Kind, ESize: len(j.e), Rows: len(got),
			Hits: ScoreQuery(j.e, got), Path: string(st.Path), ANNCandidates: st.ANNCandidates,
			UnderfillBefore: st.Underfill, FallbackUsed: st.FallbackUsed, TimedOut: st.TimedOut,
			CappedCount: st.CappedCount, CrossTenant: cross, Latency: lat,
		}
		return nil
	})
	if err != nil {
		return CellAgg{}, err
	}
	return AggregateCell(string(corpus), string(class), knob.Label, outs), nil
}

// annKnobStatements renders the hnsw.* SET LOCAL statements the store applies to
// an ANN query for this knob set (same values and defaults as
// store.buildANNSetLocalStatements).
func annKnobStatements(k KnobSet) []string {
	iter := k.Iterative
	if iter == "" {
		iter = store.IterativeScanRelaxedOrder
	}
	ef, scan := k.EfSearch, k.MaxScanTuples
	if ef == 0 {
		ef = store.DefaultHNSWEfSearch
	}
	if scan == 0 {
		scan = store.DefaultHNSWMaxScanTuples
	}
	return []string{
		"SET LOCAL hnsw.iterative_scan = " + iter,
		fmt.Sprintf("SET LOCAL hnsw.ef_search = %d", ef),
		fmt.Sprintf("SET LOCAL hnsw.max_scan_tuples = %d", scan),
	}
}

// explainANNSQL runs EXPLAIN of the ACTUAL ANN SQL (store.ANNSearchSQL, with its
// bound parameters) in a read-only transaction on the harness pool, under the
// hnsw.* knobs of `knob`. The pool's own session settings apply (Postgres
// defaults for the benchmark; the test-only overrides for the low-recall
// self-check), so the plan is the one the measured queries get.
func (h *Harness) explainANNSQL(ctx context.Context, corpus generation.Corpus, user uuid.UUID, vec []float32, knob KnobSet, analyze bool) ([]string, error) {
	ident, err := h.Pin.TableIdent(corpus)
	if err != nil {
		return nil, err
	}
	sql, err := store.ANNSearchSQL(ident.Sanitize(), corpus)
	if err != nil {
		return nil, err
	}
	tx, err := h.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	for _, s := range annKnobStatements(knob) {
		if _, err := tx.Exec(ctx, s); err != nil {
			return nil, err
		}
	}
	prefix := "EXPLAIN (COSTS OFF) "
	if analyze {
		prefix = "EXPLAIN (ANALYZE, BUFFERS) "
	}
	rows, err := tx.Query(ctx, prefix+sql, user, pgvector.NewVector(vec), float64(h.Pin.MinCos), RecallK)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var lines []string
	for rows.Next() {
		var l string
		if err := rows.Scan(&l); err != nil {
			return nil, err
		}
		lines = append(lines, l)
	}
	return lines, rows.Err()
}

// indexAM resolves an index name to its access method ("hnsw", "btree", ...).
func (h *Harness) indexAM(ctx context.Context, name string) string {
	var am string
	err := h.Pool.QueryRow(ctx, `SELECT am.amname FROM pg_class c JOIN pg_am am ON am.oid = c.relam
	                              WHERE c.relkind IN ('i', 'I') AND c.relname = $1 LIMIT 1`, name).Scan(&am)
	if err != nil {
		return ""
	}
	return am
}

// ANNPlanEvidence runs EXPLAIN of the actual ANN SQL under `knob` and reports
// whether it scans the tenant's pruned partition through its HNSW index. An
// EXPLAIN error is reported as a plan problem, not as a run failure.
func (h *Harness) ANNPlanEvidence(ctx context.Context, corpus generation.Corpus, user uuid.UUID, vec []float32, knob KnobSet) *PlanEvidence {
	lines, err := h.explainANNSQL(ctx, corpus, user, vec, knob, false)
	if err != nil {
		return &PlanEvidence{Problem: "EXPLAIN of the ANN SQL failed: " + err.Error()}
	}
	tbl, _ := h.tableOf(corpus)
	names := map[string]string{}
	ev := ParseANNPlan(lines, tbl, func(idx string) string {
		if am, ok := names[idx]; ok {
			return am
		}
		am := h.indexAM(ctx, idx)
		names[idx] = am
		return am
	})
	return &ev
}

// MaxANNPlanTenants caps the number of distinct ANN-entering tenants explained
// per C2 cell.
const MaxANNPlanTenants = 3

// tenantVectorCount returns the seeded vector count for tenant tIdx in corpus,
// honoring the optional truncation map `limits`.
func tenantVectorCount(spec ProfileSpec, corpus generation.Corpus, tIdx int, limits map[int]int) int {
	if tIdx < 0 || tIdx >= len(spec.Tenants) {
		return 0
	}
	c := spec.Tenants[tIdx].ItemCount
	if corpus == generation.CorpusTag {
		c = spec.Tenants[tIdx].TagCount
	}
	if l := limits[tIdx]; l > 0 && l < c {
		c = l
	}
	return c
}

// tenantEntersANN reports whether a tenant with `count` vectors enters the ANN
// branch under `knob` (matching store.VectorSearch: ExactMax == 0 forces ANN,
// otherwise count > ExactMax).
func tenantEntersANN(count int, knob KnobSet) bool {
	if knob.ExactMax <= 0 {
		return count > 0
	}
	return count > knob.ExactMax
}

// SelectANNPlanJobs returns the first job for each distinct tenant in `jobs`
// whose seeded vector count enters the ANN branch under `knob` (count >
// knob.ExactMax, or count > 0 when knob.ExactMax == 0), capped at
// MaxANNPlanTenants (3).
func SelectANNPlanJobs(spec ProfileSpec, corpus generation.Corpus, jobs []vqJob, knob KnobSet, limits map[int]int) []vqJob {
	seen := map[int]struct{}{}
	var out []vqJob
	for _, j := range jobs {
		tIdx := j.q.TenantIdx
		if _, ok := seen[tIdx]; ok {
			continue
		}
		seen[tIdx] = struct{}{}
		if !tenantEntersANN(tenantVectorCount(spec, corpus, tIdx, limits), knob) {
			continue
		}
		out = append(out, j)
		if len(out) >= MaxANNPlanTenants {
			break
		}
	}
	return out
}

// CellANNPlanEvidence runs ANNPlanEvidence on up to 3 distinct ANN-entering
// tenants in `jobs` and combines the per-tenant (tenant index, partition,
// verdict) results. If no tenant in `jobs` enters ANN, it returns a
// PlanEvidence with Problem "no ANN tenant in this cell".
func (h *Harness) CellANNPlanEvidence(ctx context.Context, corpus generation.Corpus, jobs []vqJob, knob KnobSet, limits map[int]int) *PlanEvidence {
	selected := SelectANNPlanJobs(h.Seed.Spec, corpus, jobs, knob, limits)
	if len(selected) == 0 {
		return CombineTenantPlanEvidence(nil)
	}
	tbl, _ := h.tableOf(corpus)
	tenants := make([]TenantPlanEvidence, 0, len(selected))
	for _, j := range selected {
		tSpec := h.Seed.Spec.Tenants[j.q.TenantIdx]
		ev := h.ANNPlanEvidence(ctx, corpus, tSpec.UserID, j.q.Vec, knob)
		part := ev.Relation
		if part == "" {
			part = fmt.Sprintf("%s_p%d", tbl, tSpec.PartitionRemainder)
		}
		tenants = append(tenants, TenantPlanEvidence{
			TenantIdx: j.q.TenantIdx,
			Partition: part,
			Verdict:   ev.Verdict(),
			Plan:      *ev,
		})
	}
	return CombineTenantPlanEvidence(tenants)
}

// explainANN is the representative EXPLAIN (ANALYZE, BUFFERS) of the ANN SQL under
// the production default knobs. Vector literals (planner constants) are scrubbed.
func (h *Harness) explainANN(ctx context.Context, corpus generation.Corpus, user uuid.UUID, vec []float32) ([]string, error) {
	lines, err := h.explainANNSQL(ctx, corpus, user, vec, DefaultKnob(), true)
	for i, l := range lines {
		lines[i] = planVector.ReplaceAllString(l, "'[vector]'")
	}
	return lines, err
}

// RunC2 computes the exact oracle per query and scores the knob matrix.
func (h *Harness) RunC2(ctx context.Context, cfg C2Config) (*C2Report, error) {
	if cfg.Workers <= 0 {
		cfg.Workers = TargetConcurrency
	}
	branch := cfg.BranchTimeout
	if branch <= 0 {
		branch = store.DefaultVectorBranchTimeout
	}
	rep := &C2Report{
		DefaultKnob: cfg.Default.Label, Matrix: cfg.Knobs, MatrixNote: cfg.MatrixNote,
		Queries: map[string]int{}, Explain: map[string][]string{}, MatrixPass: map[string][]Verdict{},
		PlannerOverrides: append([]string(nil), h.SessionSQL...),
	}
	for _, corpus := range cfg.Corpora {
		for _, class := range ClassOrder {
			tenants := cfg.Classes[class]
			if len(tenants) == 0 {
				continue
			}
			limits := cfg.ItemLimit
			if corpus == generation.CorpusTag {
				limits = cfg.TagLimit
			}
			qs := BuildVectorQueries(h.Seed.Gen, corpus, class, tenants, cfg.QueriesPerCell, limits)
			rep.Queries[string(corpus)+"/"+string(class)] = len(qs)

			// Exact oracle E per query (independent of the knob set).
			jobs := make([]vqJob, len(qs))
			err := parallelEach(ctx, cfg.Workers, len(qs), func(i int) error {
				user := h.Seed.Spec.Tenants[qs[i].TenantIdx].UserID
				exact, err := h.exactOracle(ctx, corpus, user, qs[i].Vec, RecallK)
				if err != nil {
					return fmt.Errorf("searchbench: exact oracle (%s/%s): %w", corpus, class, err)
				}
				jobs[i] = vqJob{q: qs[i], e: BuildExpected(exact, float64(h.Pin.MinCos), RecallK)}
				return nil
			})
			if err != nil {
				return rep, err
			}

			// Discarded warm pass (HNSW pages, plans) before the timed knob runs.
			warm := jobs[:min(len(jobs), 100)]
			if _, err := h.RunVectorCell(ctx, corpus, class, cfg.Default, warm, cfg.Workers, branch); err != nil {
				return rep, err
			}
			for _, knob := range cfg.Knobs {
				cell, err := h.RunVectorCell(ctx, corpus, class, knob, jobs, cfg.Workers, branch)
				if err != nil {
					return rep, err
				}
				// One EXPLAIN per ANN cell, under the cell's own knobs: record whether
				// the planner's plan for the ANN SQL is an HNSW scan of the pruned
				// partition, so a sequential scan can never be reported as "ANN".
				if cell.ANNQueries > 0 && len(jobs) > 0 {
					cell.Plan = h.CellANNPlanEvidence(ctx, corpus, jobs, knob, limits)
				}
				rep.Cells = append(rep.Cells, cell)
			}

			// Capped-count cost (plan 2.16, BE-2): sampled on the class' first tenant.
			if cfg.CountSamples > 0 {
				user := h.Seed.Spec.Tenants[tenants[0]].UserID
				ident, err := h.Pin.TableIdent(corpus)
				if err != nil {
					return rep, err
				}
				var lat []time.Duration
				count := 0
				capN := max(store.DefaultExactFallbackMaxVectors, cfg.Default.ExactMax) + 1
				for s := 0; s < cfg.CountSamples+3; s++ {
					t0 := time.Now()
					c, err := store.CappedVectorCount(ctx, h.Pool, ident.Sanitize(), user, capN)
					d := time.Since(t0)
					if err != nil {
						return rep, fmt.Errorf("searchbench: capped count: %w", err)
					}
					count = c
					if s >= 3 {
						lat = append(lat, d)
					}
				}
				rep.CountCost = append(rep.CountCost, CountCostRow{Corpus: string(corpus), Class: string(class), Count: count, Stats: Summarize(lat, 0)})
			}

			if cfg.Explain && class == ClassWhale && len(qs) > 0 {
				user := h.Seed.Spec.Tenants[qs[0].TenantIdx].UserID
				lines, err := h.explainANN(ctx, corpus, user, qs[0].Vec)
				if err != nil {
					rep.Explain[string(corpus)+"/"+string(class)] = []string{"explain failed: " + err.Error()}
				} else {
					rep.Explain[string(corpus)+"/"+string(class)] = lines
				}
			}
		}
	}
	for _, knob := range cfg.Knobs {
		rep.MatrixPass[knob.Label] = []Verdict{
			EvaluateC2R(rep.Cells, knob.Label), EvaluateC2Q(rep.Cells, knob.Label),
			EvaluateC2U(rep.Cells, knob.Label), EvaluateC2B(rep.Cells, knob.Label),
		}
	}
	return rep, nil
}

// ---- orchestration ---------------------------------------------------------

// BenchConfig holds the per-profile run sizes.
type BenchConfig struct {
	Plan         ScenarioPlan
	LexQueries   int
	HitQueries   int
	C2Queries    int
	C2Matrix     []KnobSet
	MatrixNote   string
	RequestsNote string
	MinMeasured  int
}

// ConfigFor returns the documented run sizes of a profile. Smoke is the PR-time
// run (< 20 min job): smaller c=1 plan and the knob subset. Full runs the whole
// plan 2.23 matrix with >= 2000 measured requests at every level.
func ConfigFor(p ProfileName) BenchConfig {
	if p == ProfileFull {
		return BenchConfig{
			Plan:       ScenarioPlan{Levels: []LoadLevel{{1, 200, 2000}, {8, 300, 4000}, {32, 300, 4000}}},
			LexQueries: 1000, HitQueries: 400, C2Queries: 500,
			C2Matrix: FullKnobMatrix(), MatrixNote: "Full matrix: ef_search {40,64,100} x max_scan_tuples {20000,50000,unlimited(1e6)} x SEARCH_EXACT_MAX_VECTORS {5000,10000,20000}; verdicts for the production default knob set.",
			RequestsNote: "c=1: 2000, c=8: 4000, c=32: 4000 measured (+ warm-up discarded)", MinMeasured: MinMeasuredPerScenario,
		}
	}
	return BenchConfig{
		Plan:       ScenarioPlan{Levels: []LoadLevel{{1, 50, 600}, {8, 200, 2000}, {32, 200, 2000}}},
		LexQueries: 600, HitQueries: 300, C2Queries: 300,
		C2Matrix: SmokeKnobMatrix(), MatrixNote: "Smoke subset: production default + ef_search {40,64,100} x max_scan_tuples {20000,unlimited(1e6)} at SEARCH_EXACT_MAX_VECTORS=1000 (forces the 2k tag and 10k item corpora onto ANN); the full 3x3x3 matrix runs only in `full`.",
		RequestsNote: "c=1: 600 (smoke subset to fit the 20 min job), c=8: 2000, c=32: 2000 measured (+ warm-up discarded)", MinMeasured: MinMeasuredPerScenario,
	}
}

// RunBenchmark runs C1 and C2 on a seeded database and fills rep progressively
// (so a failure still leaves a partial report to write).
func RunBenchmark(ctx context.Context, env Env, dsn string, sr *SeedResult, rep *Report, logf func(string, ...any)) error {
	cfg := ConfigFor(env.Profile)
	h, err := NewHarness(ctx, dsn, sr, benchHarnessConfig())
	if err != nil {
		return err
	}
	defer h.Close()

	rep.Harness = HarnessKnobs{
		MinCos: float64(MinCos), GenerationID: BenchGenerationID, Partitions: sr.Spec.Partitions,
		HnswM: generation.DefaultHnswM, HnswEfConstr: generation.DefaultHnswEfConstruction,
		StubDelayMs: ms(StubEmbedDelay), RateLimitCapacity: BenchBucketCapacity, RateLimitRefill: BenchBucketRefill,
		PoolMaxConns: h.PoolMax, Concurrency: []int{1, 8, 32}, Requests: cfg.RequestsNote,
		ProductionKnobs: "ef_search 64, max_scan_tuples 20000, iterative_scan relaxed_order, exact max 5000, fallback max 20000, branch timeout 80 ms, fallback min budget 30 ms, lexical branch timeout 50 ms",
		SearchEndpoint:  "GET /api/v1/suggest (limit default, scope all)",
		Notes: []string{
			"Requests go through httpx.NewRouter + semantic.RequestScopeMiddleware + suggest.Mount with the production auth.SessionStore (real JWT parse and session/user DB lookups; validator clock frozen at start so the 10-minute access token never expires mid-run). No network listener.",
			"The query-embedding provider is an in-process stub: it never dials anything; EmbedQuery sleeps the stub delay and returns the dataset query vector.",
			"API connection pool is the production size (db.NewPool, 10 connections); concurrency 32 therefore also measures pool queueing, as production would.",
			"Planner settings are the Postgres defaults on every measured pool (no enable_* or other planner override anywhere in the benchmark); each C2 ANN cell records the plan the planner chose for the ANN SQL (HNSW or not).",
			"Hybrid scenarios use the production default knobs; C2 re-runs store.VectorSearch directly with each knob set under the same 80 ms branch budget.",
		},
	}
	rep.Hardware.PG = CollectPGInfo(ctx, h.Pool)

	classes := ClassifyTenants(sr.Spec)
	seeded := map[int]bool{}
	for _, t := range sr.Tenants {
		seeded[t] = true
	}
	for c, ts := range classes {
		var keep []int
		for _, t := range ts {
			if seeded[t] {
				keep = append(keep, t)
			}
		}
		classes[c] = keep
	}
	whales := classes[ClassWhale]
	if len(whales) == 0 {
		return errors.New("searchbench: no whale tenant seeded")
	}

	// ---- C1 ----
	lexQ := BuildLexicalQueries(sr.Gen, whales, cfg.LexQueries, nil)
	l, err := h.RunC1L(ctx, lexQ, cfg.Plan)
	rep.C1 = append(rep.C1, l)
	if err != nil {
		return err
	}
	logf("C1-L done")
	var hitQ []TextQuery
	for ti, t := range whales {
		hitQ = append(hitQ, BuildHybridQueries(sr.Gen, t, cfg.HitQueries/len(whales), false, 10_000_000+ti*100_000, 0)...)
	}
	hres, err := h.RunC1H(ctx, hitQ, cfg.Plan)
	rep.C1 = append(rep.C1, hres)
	if err != nil {
		return err
	}
	logf("C1-H done")
	m, err := h.RunC1M(ctx, sr.Gen, whales, cfg.Plan, nil)
	rep.C1 = append(rep.C1, m)
	if err != nil {
		return err
	}
	rep.C1Info = ComputeOpenAICompatInfo(m)
	logf("C1-M done")
	if paths, timedOut, under := h.Searcher.Snapshot(); len(paths) > 0 {
		rep.Notes = append(rep.Notes, fmt.Sprintf("Hybrid vector-branch paths over all C1 hybrid runs: %v; branch timeouts: %d; unrecovered underfill (ann_short): %d.", paths, timedOut, under))
	}

	// ---- C2 ----
	c2, err := h.RunC2(ctx, C2Config{
		QueriesPerCell: cfg.C2Queries, Workers: TargetConcurrency, Knobs: cfg.C2Matrix, Default: DefaultKnob(),
		MatrixNote: cfg.MatrixNote, Corpora: []generation.Corpus{generation.CorpusItem, generation.CorpusTag},
		Classes: classes, CountSamples: 30, Explain: true,
	})
	rep.C2 = c2
	if err == nil {
		logf("C2 done")
	}
	// Task 23 additions (advisor-dec-337): quiet phase after every measured cell, on
	// their own connections. They run even when C2 failed, so the evidence is not
	// lost, and a failed section is recorded without failing the benchmark. With no
	// time left every section is recorded as skipped_budget (RV-W4-1-2).
	rep.Extras = RunExtras(ctx, dsn, sr, classes, ExtrasConfigFor(env.Profile), logf)
	return err
}

// FinalizeReport fills verdicts, hard failures and derived sections.
func FinalizeReport(rep *Report, minMeasured int) {
	rep.Verdicts = ConsolidateVerdicts(rep.C1, rep.C2, minMeasured, rep.Run.DatasetHash != "")
	rep.Hard = HardFailures(rep)
	// Smoke: c=8 hybrid degradation is invalid evidence + a warning, not a hard
	// failure (advisor-dec-310, targets.md section 4); see HardFailures.
	rep.Warnings = DegradationWarnings(rep)
	for _, s := range rep.C1 {
		rep.Warnings = append(rep.Warnings, LevelWarnings(s)...)
	}
	if rep.Extras != nil {
		for _, e := range rep.Extras.Errors {
			rep.Warnings = append(rep.Warnings, "Task 23 extra failed (not part of any target): "+e)
		}
	}
	if rep.C2 != nil {
		if cells := NonHNSWANNCells(rep.C2.Cells); len(cells) > 0 {
			rep.Notes = append(rep.Notes, fmt.Sprintf(
				"WARNING - ANN cells whose planner-chosen plan is not an HNSW scan of one partition (the planner chose another plan on default settings; their recall/latency measure that plan, not HNSW): %s.",
				strings.Join(cells, "; ")))
		}
	}
	if rep.Run.Profile == string(ProfileSmoke) {
		rep.Notes = append(rep.Notes, "smoke — not acceptance evidence (targets.md §4): verdicts above are informational and must not be used to claim a target met or missed.")
	}
	rep.Notes = append(rep.Notes, "Query text is synthetic and is never logged or written to this report; only counts, kinds and statistics appear.")
	if rep.Run.TargetsCommit == "" {
		rep.Run.TargetsCommit = "unknown (filled by the job / Task 23)"
	}
	if rep.Run.TargetsAncestor == "" {
		rep.Run.TargetsAncestor = "unknown (filled by the job / Task 23)"
	}
	if rep.Run.Conclusion == "" {
		rep.Run.Conclusion = "(set by CI job)"
	}
}

// ensure strings is referenced (used in error text builders above in some builds).
var _ = strings.TrimSpace
