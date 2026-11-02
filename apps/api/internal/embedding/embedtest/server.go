// Package embedtest provides a deterministic fake embedding server that speaks
// both the Hugging Face TEI protocol (GET /info, GET /health, POST /embed) and
// the OpenAI-compatible embeddings protocol (POST /embeddings,
// POST /v1/embeddings).
//
// It does NOT import the standard library "testing" package so that it can be
// reused both in unit tests (via NewServer, backed by net/http/httptest) and
// in the standalone CI binary apps/api/cmd/fakeembed (plan P05 mục 2.12, 2.22,
// Task 5, Task 16).
package embedtest

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
)

// Default configuration values for the fake embedding server.
const (
	DefaultDims     = 1024
	DefaultModelID  = "BAAI/bge-m3"
	DefaultModelSHA = "fakeembed-tei-sha-0001"
)

// Mode controls the fault-injection or response shape behavior of a Server.
type Mode string

const (
	ModeOK             Mode = "ok"
	ModeSlow           Mode = "slow"
	ModeDown           Mode = "down" // alias for 5xx in /__control (plan Task 16)
	Mode5xx            Mode = "5xx"
	Mode429            Mode = "429"
	ModeWrongDims      Mode = "wrong_dims"
	ModeNaN            Mode = "nan"
	ModeMissingIndex   Mode = "missing_index"
	ModeDuplicateIndex Mode = "duplicate_index"
	ModeRedirect       Mode = "redirect"
	ModeOversizeBody   Mode = "oversize_body"
)

// Options configures a fake embedding Server.
type Options struct {
	Dims              int
	ModelID           string
	ModelSHA          string
	ScaleFactor       float32 // Default 2.5 for OpenAI path (unnormalized to exercise Go L2 normalization)
	SlowDelay         time.Duration
	RetryAfterHeader  string
	RedirectURL       string
	OversizeBodyBytes int
	QueryPrefix       string // Optional query instruction prefix stripped before alias lookup
}

// RecordedCall captures a single embedding request observed by the Server.
type RecordedCall struct {
	Protocol       string // "openai" | "tei"
	Path           string
	Model          string
	Dims           int
	EncodingFormat string
	AuthHeader     string
	Normalize      bool
	Truncate       bool
	Inputs         []string
}

// Stats holds request counters separated by query vs document operations.
// It never contains raw inputs or query strings (plan Task 16 N1).
type Stats struct {
	QueryRequests    int64 `json:"query_requests"`
	DocumentRequests int64 `json:"document_requests"`
	TotalRequests    int64 `json:"total_requests"`
}

// Server is a thread-safe fake embedding HTTP handler supporting TEI and
// OpenAI-compatible endpoints plus runtime fault injection.
type Server struct {
	mu          sync.RWMutex
	dims        int
	modelID     string
	modelSHA    string
	scaleFactor float32
	mode        Mode
	slowDelay   time.Duration
	statusCode  int
	retryAfter  string
	redirectURL string
	oversizeLen int
	queryPrefix string
	aliases     map[string]string
	calls       []RecordedCall

	queryCount    atomic.Int64
	documentCount atomic.Int64
	infoCount     atomic.Int64
	healthCount   atomic.Int64

	httpServer *httptest.Server
}

// NewHandler creates a new fake embedding Server (which implements http.Handler)
// without starting a listener.
func NewHandler(opts Options) *Server {
	dims := opts.Dims
	if dims <= 0 {
		dims = DefaultDims
	}
	modelID := strings.TrimSpace(opts.ModelID)
	if modelID == "" {
		modelID = DefaultModelID
	}
	modelSHA := strings.TrimSpace(opts.ModelSHA)
	if modelSHA == "" {
		modelSHA = DefaultModelSHA
	}
	scale := opts.ScaleFactor
	if scale == 0 {
		scale = 2.5
	}
	slowDelay := opts.SlowDelay
	if slowDelay <= 0 {
		slowDelay = 250 * time.Millisecond
	}
	retryAfter := opts.RetryAfterHeader
	if retryAfter == "" {
		retryAfter = "15"
	}
	oversize := opts.OversizeBodyBytes
	if oversize <= 0 {
		oversize = (4 << 20) + 64*1024 // > 4 MiB cap
	}
	return &Server{
		dims:        dims,
		modelID:     modelID,
		modelSHA:    modelSHA,
		scaleFactor: scale,
		mode:        ModeOK,
		slowDelay:   slowDelay,
		statusCode:  http.StatusServiceUnavailable,
		retryAfter:  retryAfter,
		redirectURL: opts.RedirectURL,
		oversizeLen: oversize,
		queryPrefix: opts.QueryPrefix,
		aliases:     make(map[string]string),
	}
}

// NewServer creates a Server and starts an httptest.Server listening on
// loopback. Call Close() when done.
func NewServer(opts Options) *Server {
	s := NewHandler(opts)
	s.httpServer = httptest.NewServer(s)
	return s
}

// URL returns the base URL of the underlying httptest.Server, or "" if
// constructed via NewHandler.
func (s *Server) URL() string {
	if s.httpServer == nil {
		return ""
	}
	return s.httpServer.URL
}

// HTTPServer returns the underlying *httptest.Server (or nil if constructed via
// NewHandler).
func (s *Server) HTTPServer() *httptest.Server {
	return s.httpServer
}

// Close shuts down the underlying httptest.Server if one was started.
func (s *Server) Close() {
	if s.httpServer != nil {
		s.httpServer.Close()
	}
}

// SetMode sets the active response mode.
func (s *Server) SetMode(m Mode) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mode = m
}

// Mode returns the current response mode.
func (s *Server) Mode() Mode {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.mode
}

// SetSlow registers ModeSlow with the given delay duration.
func (s *Server) SetSlow(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mode = ModeSlow
	s.slowDelay = d
}

// Set5xx configures Mode5xx with a specific 5xx HTTP status code (defaults to
// 503 if status < 500 or >= 600).
func (s *Server) Set5xx(status int) {
	if status < 500 || status >= 600 {
		status = http.StatusServiceUnavailable
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mode = Mode5xx
	s.statusCode = status
}

// Set429 configures Mode429 with the given Retry-After header value (seconds
// or HTTP-date; may be empty).
func (s *Server) Set429(retryAfter string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mode = Mode429
	s.retryAfter = retryAfter
}

// SetRedirect configures ModeRedirect to redirect requests to targetURL with
// HTTP 302 Found.
func (s *Server) SetRedirect(targetURL string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mode = ModeRedirect
	s.redirectURL = targetURL
}

// SetDims updates the default vector dimension returned by the server.
func (s *Server) SetDims(dims int) {
	if dims <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dims = dims
}

// SetModel updates the TEI model_id and sha reported by GET /info.
func (s *Server) SetModel(modelID, modelSHA string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if modelID != "" {
		s.modelID = modelID
	}
	if modelSHA != "" {
		s.modelSHA = modelSHA
	}
}

// SetAliases replaces the probe-query -> target-document alias map. When an
// input (or a query after stripping its "Instruct: ...\nQuery:" prefix) matches
// a key in aliases, the server computes its vector from the mapped target
// string so cosine similarity is 1.0 (plan Task 16 N1).
func (s *Server) SetAliases(aliases map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make(map[string]string, len(aliases))
	for k, v := range aliases {
		cp[k] = v
	}
	s.aliases = cp
}

// Calls returns a deep copy of all recorded embedding calls in arrival order.
func (s *Server) Calls() []RecordedCall {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]RecordedCall, len(s.calls))
	for i, c := range s.calls {
		inputs := make([]string, len(c.Inputs))
		copy(inputs, c.Inputs)
		c.Inputs = inputs
		out[i] = c
	}
	return out
}

// ReceivedInputs returns all input strings received across all recorded
// embedding requests in arrival order.
func (s *Server) ReceivedInputs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []string
	for _, c := range s.calls {
		out = append(out, c.Inputs...)
	}
	return out
}

// LastCall returns the most recent RecordedCall and true, or false if no
// embedding call has been recorded.
func (s *Server) LastCall() (RecordedCall, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.calls) == 0 {
		return RecordedCall{}, false
	}
	last := s.calls[len(s.calls)-1]
	inputs := make([]string, len(last.Inputs))
	copy(inputs, last.Inputs)
	last.Inputs = inputs
	return last, true
}

// ResetCalls clears the recorded calls history and request counters.
func (s *Server) ResetCalls() {
	s.mu.Lock()
	s.calls = nil
	s.mu.Unlock()
	s.queryCount.Store(0)
	s.documentCount.Store(0)
	s.infoCount.Store(0)
	s.healthCount.Store(0)
}

// Stats returns the current query/document request counters.
func (s *Server) Stats() Stats {
	q := s.queryCount.Load()
	d := s.documentCount.Load()
	return Stats{
		QueryRequests:    q,
		DocumentRequests: d,
		TotalRequests:    q + d,
	}
}

// InfoCount returns the number of GET /info requests handled.
func (s *Server) InfoCount() int64 {
	return s.infoCount.Load()
}

// HealthCount returns the number of GET /health requests handled.
func (s *Server) HealthCount() int64 {
	return s.healthCount.Load()
}

// ServeHTTP dispatches TEI, OpenAI, and control endpoints.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/health":
		s.handleHealth(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/info":
		s.handleTEIInfo(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/embed":
		s.handleTEIEmbed(w, r)
	case r.Method == http.MethodPost && (r.URL.Path == "/embeddings" || r.URL.Path == "/v1/embeddings"):
		s.handleOpenAIEmbeddings(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/__control":
		s.handleControl(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/__control/stats":
		s.handleControlStats(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.healthCount.Add(1)
	if !s.applyFaultMode(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

func (s *Server) handleTEIInfo(w http.ResponseWriter, r *http.Request) {
	s.infoCount.Add(1)
	if !s.applyFaultMode(w, r) {
		return
	}
	s.mu.RLock()
	modelID := s.modelID
	modelSHA := s.modelSHA
	s.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"model_id":   modelID,
		"model_sha":  modelSHA,
		"model_type": "embedding",
	})
}

type teiEmbedRequest struct {
	Inputs    json.RawMessage `json:"inputs"`
	Normalize *bool           `json:"normalize"`
	Truncate  *bool           `json:"truncate"`
}

func (s *Server) handleTEIEmbed(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	var req teiEmbedRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	inputs, err := parseInputsField(req.Inputs)
	if err != nil || len(inputs) == 0 {
		http.Error(w, "invalid inputs", http.StatusBadRequest)
		return
	}

	norm := true
	if req.Normalize != nil {
		norm = *req.Normalize
	}
	trunc := false
	if req.Truncate != nil {
		trunc = *req.Truncate
	}

	s.recordCall(RecordedCall{
		Protocol:  "tei",
		Path:      r.URL.Path,
		Normalize: norm,
		Truncate:  trunc,
		Inputs:    inputs,
	})

	if !s.applyFaultMode(w, r) {
		return
	}

	s.mu.RLock()
	dims := s.dims
	mode := s.mode
	scale := s.scaleFactor
	s.mu.RUnlock()

	if mode == ModeWrongDims {
		dims = dims + 3
	}

	scaleToUse := float32(1.0)
	if !norm {
		scaleToUse = scale
	}

	vecs := make([][]float32, len(inputs))
	for i, text := range inputs {
		effective := s.resolveAlias(text)
		vecs[i] = DeterministicVector(effective, dims, norm, scaleToUse)
	}

	if mode == ModeNaN {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(buildNaNJSON("tei", dims, len(inputs)))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(vecs)
}

type openAIEmbedRequest struct {
	Model          string          `json:"model"`
	Input          json.RawMessage `json:"input"`
	Dimensions     int             `json:"dimensions"`
	EncodingFormat string          `json:"encoding_format"`
}

type openAIEmbedResponse struct {
	Object string            `json:"object"`
	Model  string            `json:"model"`
	Data   []openAIEmbedItem `json:"data"`
}

type openAIEmbedItem struct {
	Object    string    `json:"object"`
	Index     int       `json:"index"`
	Embedding []float32 `json:"embedding"`
}

func (s *Server) handleOpenAIEmbeddings(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	var req openAIEmbedRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	inputs, err := parseInputsField(req.Input)
	if err != nil || len(inputs) == 0 {
		http.Error(w, "invalid input", http.StatusBadRequest)
		return
	}

	s.recordCall(RecordedCall{
		Protocol:       "openai",
		Path:           r.URL.Path,
		Model:          req.Model,
		Dims:           req.Dimensions,
		EncodingFormat: req.EncodingFormat,
		AuthHeader:     r.Header.Get("Authorization"),
		Inputs:         inputs,
	})

	if !s.applyFaultMode(w, r) {
		return
	}

	s.mu.RLock()
	dims := s.dims
	if req.Dimensions > 0 {
		dims = req.Dimensions
	}
	mode := s.mode
	scale := s.scaleFactor
	s.mu.RUnlock()

	if mode == ModeWrongDims {
		dims = dims + 3
	}

	if mode == ModeNaN {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(buildNaNJSON("openai", dims, len(inputs)))
		return
	}

	data := make([]openAIEmbedItem, len(inputs))
	for i, text := range inputs {
		effective := s.resolveAlias(text)
		// OpenAI path returns unnormalized vectors (scaled by scaleFactor) so
		// callers verify Go-side float64 L2 normalization.
		vec := DeterministicVector(effective, dims, false, scale)
		idx := i
		switch mode {
		case ModeMissingIndex:
			idx = i + 1 // shifts 0..n-1 to 1..n so index 0 is missing
		case ModeDuplicateIndex:
			idx = 0 // all items share index 0
		}
		data[i] = openAIEmbedItem{
			Object:    "embedding",
			Index:     idx,
			Embedding: vec,
		}
	}

	// Reverse order when >= 2 items in normal mode so the client's index sorting
	// is exercised on multi-item batches.
	if mode == ModeOK && len(data) > 1 {
		for l, r := 0, len(data)-1; l < r; l, r = l+1, r-1 {
			data[l], data[r] = data[r], data[l]
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(openAIEmbedResponse{
		Object: "list",
		Model:  req.Model,
		Data:   data,
	})
}

type controlRequest struct {
	Mode       string            `json:"mode"`
	DelayMs    int               `json:"delay_ms,omitempty"`
	RetryAfter string            `json:"retry_after,omitempty"`
	Aliases    map[string]string `json:"aliases,omitempty"`
}

func (s *Server) handleControl(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	var req controlRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	switch Mode(req.Mode) {
	case "", ModeOK:
		s.mode = ModeOK
	case ModeDown, Mode5xx:
		s.mode = Mode5xx
		if s.statusCode < 500 || s.statusCode >= 600 {
			s.statusCode = http.StatusServiceUnavailable
		}
	case ModeSlow:
		s.mode = ModeSlow
		if req.DelayMs > 0 {
			s.slowDelay = time.Duration(req.DelayMs) * time.Millisecond
		}
	case Mode429:
		s.mode = Mode429
		if req.RetryAfter != "" {
			s.retryAfter = req.RetryAfter
		}
	case ModeWrongDims, ModeNaN, ModeMissingIndex, ModeDuplicateIndex, ModeRedirect, ModeOversizeBody:
		s.mode = Mode(req.Mode)
	default:
		s.mu.Unlock()
		http.Error(w, "unsupported mode", http.StatusBadRequest)
		return
	}
	if req.Aliases != nil {
		cp := make(map[string]string, len(req.Aliases))
		for k, v := range req.Aliases {
			cp[k] = v
		}
		s.aliases = cp
	}
	currentMode := s.mode
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":   true,
		"mode": string(currentMode),
	})
}

func (s *Server) handleControlStats(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(s.Stats())
}

func (s *Server) recordCall(c RecordedCall) {
	isQuery := len(c.Inputs) == 1 && isQueryInput(c.Inputs[0], s.queryPrefix)
	if isQuery {
		s.queryCount.Add(1)
	} else {
		s.documentCount.Add(1)
	}
	s.mu.Lock()
	s.calls = append(s.calls, c)
	s.mu.Unlock()
}

func isQueryInput(input, configuredPrefix string) bool {
	if strings.HasPrefix(input, "Instruct: ") && strings.Contains(input, "\nQuery:") {
		return true
	}
	if configuredPrefix != "" && strings.HasPrefix(input, configuredPrefix) {
		return true
	}
	return false
}

func (s *Server) resolveAlias(raw string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.aliases) == 0 {
		return raw
	}
	if target, ok := s.aliases[raw]; ok {
		return target
	}
	stripped := stripQueryPrefix(raw, s.queryPrefix)
	if stripped != raw {
		if target, ok := s.aliases[stripped]; ok {
			return target
		}
	}
	return raw
}

func stripQueryPrefix(raw, configuredPrefix string) string {
	if configuredPrefix != "" && strings.HasPrefix(raw, configuredPrefix) {
		return strings.TrimPrefix(raw, configuredPrefix)
	}
	if strings.HasPrefix(raw, "Instruct: ") {
		if idx := strings.Index(raw, "\nQuery:"); idx >= 0 {
			return raw[idx+len("\nQuery:"):]
		}
	}
	return raw
}

// applyFaultMode executes any configured slow delay or non-200 fault mode. It
// returns true if the handler should proceed with a normal 200 response.
func (s *Server) applyFaultMode(w http.ResponseWriter, r *http.Request) bool {
	s.mu.RLock()
	mode := s.mode
	delay := s.slowDelay
	status := s.statusCode
	retryAfter := s.retryAfter
	redirectURL := s.redirectURL
	oversizeLen := s.oversizeLen
	s.mu.RUnlock()

	switch mode {
	case ModeSlow:
		if delay > 0 {
			timer := time.NewTimer(delay)
			select {
			case <-r.Context().Done():
				timer.Stop()
				return false
			case <-timer.C:
			}
		}
		return true
	case Mode5xx, ModeDown:
		if status < 500 || status >= 600 {
			status = http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"error":{"message":"upstream unavailable"}}`))
		return false
	case Mode429:
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"rate limit exceeded"}}`))
		return false
	case ModeRedirect:
		target := redirectURL
		if target == "" {
			target = "/redirected-target"
		}
		http.Redirect(w, r, target, http.StatusFound)
		return false
	case ModeOversizeBody:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		chunk := bytes.Repeat([]byte("a"), 32*1024)
		written := 0
		_, _ = w.Write([]byte(`{"pad":"`))
		for written < oversizeLen {
			n, err := w.Write(chunk)
			written += n
			if err != nil {
				break
			}
		}
		_, _ = w.Write([]byte(`"}`))
		return false
	default:
		return true
	}
}

func parseInputsField(raw json.RawMessage) ([]string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("empty inputs")
	}
	if trimmed[0] == '[' {
		var list []string
		if err := json.Unmarshal(trimmed, &list); err != nil {
			return nil, err
		}
		return list, nil
	}
	var single string
	if err := json.Unmarshal(trimmed, &single); err != nil {
		return nil, err
	}
	return []string{single}, nil
}

func buildNaNJSON(protocol string, dims, count int) []byte {
	var b strings.Builder
	if dims <= 0 {
		dims = 4
	}
	writeVec := func() {
		b.WriteByte('[')
		for i := range dims {
			if i > 0 {
				b.WriteByte(',')
			}
			if i == 0 {
				b.WriteString("NaN")
			} else {
				b.WriteString("0.5")
			}
		}
		b.WriteByte(']')
	}
	if protocol == "tei" {
		b.WriteByte('[')
		for i := range count {
			if i > 0 {
				b.WriteByte(',')
			}
			writeVec()
		}
		b.WriteByte(']')
		return []byte(b.String())
	}
	b.WriteString(`{"object":"list","model":"fake","data":[`)
	for i := range count {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"object":"embedding","index":`)
		b.WriteString(strconv.Itoa(i))
		b.WriteString(`,"embedding":`)
		writeVec()
		b.WriteByte('}')
	}
	b.WriteString(`]}`)
	return []byte(b.String())
}

// DeterministicVector computes a deterministic float32 embedding vector of
// length dims from the hashed character trigrams (3-rune sliding window with
// boundary markers) of text.
//
// Properties guaranteed by this construction:
//   - Same text + dims -> identical vector across runs and platforms.
//   - Texts sharing character trigrams -> high cosine similarity.
//   - Every returned vector has strictly positive L2 norm (a small baseline
//     component derived from the full-string hash ensures even empty strings
//     produce a valid non-zero vector).
//   - When normalize is true, the returned vector is L2-normalized in float64;
//     when normalize is false, the L2-normalized vector is multiplied by
//     scaleFactor (defaulting to 2.5 if scaleFactor <= 0) so callers can test
//     their own L2 normalization.
func DeterministicVector(text string, dims int, normalize bool, scaleFactor float32) []float32 {
	if dims <= 0 {
		dims = DefaultDims
	}
	accum := make([]float64, dims)

	canonical := normalizeForTrigrams(text)
	runes := []rune("^" + canonical + "$")

	if len(runes) >= 3 {
		for i := 0; i <= len(runes)-3; i++ {
			tri := string(runes[i : i+3])
			accumulateFeature(accum, tri, 1.0)
		}
	}
	// Also hash individual space-separated tokens so shared words reinforce
	// similarity even across short strings.
	for _, tok := range strings.Fields(canonical) {
		accumulateFeature(accum, "tok:"+tok, 1.5)
	}

	// Ensure non-zero norm for any input by adding a deterministic baseline
	// across 4 buckets derived from the raw text.
	baseH := fnv64a("base:" + text)
	for k := range 4 {
		idx := int((baseH + uint64(k)*0x9e3779b97f4a7c15) % uint64(dims))
		if idx < 0 {
			idx = -idx
		}
		sign := 1.0
		if (baseH>>uint(k+8))&1 == 1 {
			sign = -1.0
		}
		accum[idx] += sign * 0.125
	}

	var sumSq float64
	for _, v := range accum {
		sumSq += v * v
	}
	if sumSq == 0 {
		accum[0] = 1.0
		sumSq = 1.0
	}
	norm := math.Sqrt(sumSq)
	mult := 1.0 / norm
	if !normalize {
		sf := float64(scaleFactor)
		if sf <= 0 {
			sf = 2.5
		}
		mult *= sf
	}

	out := make([]float32, dims)
	for i, v := range accum {
		out[i] = float32(v * mult)
	}
	return out
}

func normalizeForTrigrams(s string) string {
	// Strip Qwen3 query instruction prefix if present so queries and matching
	// documents share character trigrams instead of being dominated by the
	// fixed instruction template.
	if strings.HasPrefix(s, "Instruct: ") {
		if idx := strings.Index(s, "\nQuery:"); idx >= 0 {
			s = s[idx+len("\nQuery:"):]
		}
	}
	var b strings.Builder
	b.Grow(len(s))
	lastSpace := true
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		if unicode.IsSpace(r) || unicode.IsPunct(r) {
			if !lastSpace {
				b.WriteByte(' ')
				lastSpace = true
			}
			continue
		}
		b.WriteRune(r)
		lastSpace = false
	}
	return strings.TrimSpace(b.String())
}

func accumulateFeature(accum []float64, feature string, weight float64) {
	dims := len(accum)
	h1 := fnv64a(feature)
	h2 := fnv64a("salt:" + feature)
	// Project each feature into 4 signed coordinates (CountSketch style).
	for j := range 4 {
		combined := h1 + uint64(j)*h2 + uint64(j*0x517cc1b727220a95)
		idx := int(combined % uint64(dims))
		sign := weight
		if (combined>>63)&1 == 1 {
			sign = -weight
		}
		accum[idx] += sign
	}
}

func fnv64a(s string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], h.Sum64())
	return binary.BigEndian.Uint64(buf[:])
}
