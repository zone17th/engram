// Package embedding provides the embedding provider contract, URL/IP safety
// rules, canonical input preprocessing/hashing, and identity-bound client sets
// (plan P05 mục 2.12, 2.14, 2.21; SPEC §4.4, §6.6).
package embedding

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/zone17th/engram/apps/api/internal/obs"
)

const (
	// MaxBatch is the maximum number of document inputs per EmbedDocuments call (SPEC §4.4).
	MaxBatch = 64
	// Preprocessing is the preprocessing algorithm version recorded in embedid.Identity.
	Preprocessing = "v1"
)

// Provider names supported by the runtime (SPEC §4.4).
const (
	ProviderNoop         = "noop"
	ProviderTEI          = "tei"
	ProviderOpenAICompat = "openai_compat"
)

// Provider operation labels used in metrics and structured logs (plan P05 mục 2.21).
const (
	OpQuery    = "query"
	OpDocument = "document"
	OpBootInfo = "info"
)

// Default per-call timeouts when ClientConfig leaves them zero (plan P05 mục 2.13).
const (
	DefaultOpenAIQueryTimeout = 4 * time.Second
	DefaultTEIQueryTimeout    = 300 * time.Millisecond
	DefaultDocumentTimeout    = 30 * time.Second
)

// Provider abstracts an embedding backend (SPEC §4.4, plan P05 mục 2.12).
type Provider interface {
	Name() string         // "openai_compat" | "tei" | "noop"
	Model() string        // "openai_compat/<EMBEDDING_MODEL>" | "tei/<model_id>"
	ModelVersion() string // openai_compat: "dims=1024;instr=<sha8>"; tei: "<model_sha>;qp=<sha8>;dp=<sha8>"
	Dims() int
	MaxBatch() int // 64
	EmbedDocuments(ctx context.Context, inputs []string) ([][]float32, error)
	EmbedQuery(ctx context.Context, q string) ([]float32, error)
}

// Sentinel errors returned by providers. Error messages never include raw
// inputs, query strings, API keys, full URLs, headers, or response bodies.
var (
	// ErrUnavailable is returned by the noop provider on every Embed* call.
	ErrUnavailable = errors.New("embedding: provider unavailable")
	// ErrBadResponse is returned (or wrapped by *ProviderError) when a provider
	// returns malformed JSON, wrong count/indices, wrong dimensions, NaN/Inf,
	// zero-norm vectors, an unexpected redirect, or an oversized body.
	ErrBadResponse = errors.New("embedding: bad provider response")
	// ErrBatchTooLarge is returned when EmbedDocuments receives more than MaxBatch (64) inputs.
	ErrBatchTooLarge = errors.New("embedding: batch size exceeds MaxBatch")
	// ErrEmptyBatch is returned when EmbedDocuments receives zero inputs.
	ErrEmptyBatch = errors.New("embedding: empty document batch")
)

// ErrorClass enumerates the provider failure reason codes (plan P05 mục 2.21, SPEC §6.6).
type ErrorClass string

const (
	ClassTimeout     ErrorClass = "provider_timeout"
	Class5xx         ErrorClass = "provider_5xx"
	Class429         ErrorClass = "provider_429"
	ClassRefused     ErrorClass = "provider_refused"
	ClassBadResponse ErrorClass = "provider_bad_response"
)

// MetricOutcome maps an ErrorClass to the Prometheus outcome label value of
// embedding_provider_requests_total ("timeout|http_5xx|http_429|refused|bad_response").
func (c ErrorClass) MetricOutcome() string {
	switch c {
	case ClassTimeout:
		return "timeout"
	case Class5xx:
		return "http_5xx"
	case Class429:
		return "http_429"
	case ClassRefused:
		return "refused"
	case ClassBadResponse:
		return "bad_response"
	default:
		return "bad_response"
	}
}

// OutcomeForError returns the metric outcome label ("ok" when err == nil, or
// the mapped ErrorClass outcome).
func OutcomeForError(err error) string {
	if err == nil {
		return "ok"
	}
	var pe *ProviderError
	if errors.As(err, &pe) && pe != nil {
		return pe.Class.MetricOutcome()
	}
	if errors.Is(err, ErrBadResponse) {
		return ClassBadResponse.MetricOutcome()
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ClassTimeout.MetricOutcome()
	}
	return ClassRefused.MetricOutcome()
}

// ProviderError is a classified error returned by concrete providers. Its
// Error() string never includes inputs, queries, keys, URLs, headers, or bodies.
type ProviderError struct {
	Class      ErrorClass
	HTTPStatus int
	RetryAfter time.Duration
	Detail     string // safe internal constant description only
	Err        error
}

func (e *ProviderError) Error() string {
	if e == nil {
		return "<nil>"
	}
	if e.HTTPStatus > 0 {
		if e.Detail != "" {
			return fmt.Sprintf("embedding: %s (status=%d): %s", e.Class, e.HTTPStatus, e.Detail)
		}
		return fmt.Sprintf("embedding: %s (status=%d)", e.Class, e.HTTPStatus)
	}
	if e.Detail != "" {
		return fmt.Sprintf("embedding: %s: %s", e.Class, e.Detail)
	}
	return fmt.Sprintf("embedding: %s", e.Class)
}

func (e *ProviderError) Unwrap() error {
	if e == nil {
		return nil
	}
	if e.Err != nil {
		return e.Err
	}
	if e.Class == ClassBadResponse {
		return ErrBadResponse
	}
	return nil
}

// Is reports whether target matches ErrBadResponse when Class == ClassBadResponse.
func (e *ProviderError) Is(target error) bool {
	if e == nil {
		return false
	}
	if target == ErrBadResponse && e.Class == ClassBadResponse {
		return true
	}
	return false
}

// ClientConfig holds the configuration for a single embedding provider client
// (primary or shadow). Its String and GoString methods redact APIKey and
// BaseURL so formatting with %v / %+v / %#v never leaks secrets or full URLs.
type ClientConfig struct {
	Provider         string
	BaseURL          string
	APIKey           string
	Model            string
	Dims             int
	QueryInstruction string
	QueryTimeout     time.Duration
	DocumentTimeout  time.Duration
	QueryPrefix      string
	DocPrefix        string
}

func (c ClientConfig) redactedSummary() string {
	keySet := c.APIKey != ""
	urlSet := c.BaseURL != ""
	return fmt.Sprintf(
		"ClientConfig{Provider:%q, BaseURLSet:%t, APIKeySet:%t, Model:%q, Dims:%d, QueryTimeout:%s, DocumentTimeout:%s}",
		c.Provider, urlSet, keySet, c.Model, c.Dims, c.QueryTimeout, c.DocumentTimeout,
	)
}

// String returns a redacted representation safe for logging.
func (c ClientConfig) String() string {
	return c.redactedSummary()
}

// GoString returns a redacted representation so fmt %#v never leaks APIKey.
func (c ClientConfig) GoString() string {
	return c.redactedSummary()
}

// EffectivePrefixes returns the (queryPrefix, docPrefix) pair that a client
// built from c uses and records in embedid.Identity (plan P05 mục 2.12, ADR 0004):
//   - openai_compat: QueryPrefix = "Instruct: " + QueryInstruction + "\nQuery:", DocPrefix = ""
//   - tei: QueryPrefix = c.QueryPrefix, DocPrefix = c.DocPrefix
//   - noop (or other): "", ""
func (c ClientConfig) EffectivePrefixes() (queryPrefix, docPrefix string) {
	switch c.Provider {
	case ProviderOpenAICompat:
		return OpenAIQueryPrefix(c.QueryInstruction), ""
	case ProviderTEI:
		return c.QueryPrefix, c.DocPrefix
	default:
		return "", ""
	}
}

// OpenAIQueryPrefix formats the Qwen3 instruction query prefix for openai_compat
// ("Instruct: " + instruction + "\nQuery:").
func OpenAIQueryPrefix(instruction string) string {
	return "Instruct: " + instruction + "\nQuery:"
}

// ShortHash8 returns the first 8 lowercase hex characters of SHA-256(s), used
// to construct ModelVersion strings (SPEC §4.4: "dims=1024;instr=<sha8>" and
// "<model_sha>;qp=<sha8>;dp=<sha8>").
func ShortHash8(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:4])
}

// OpenAIModelVersion returns the canonical ModelVersion for an openai_compat
// configuration: "dims=<dims>;instr=<sha8(instruction)>".
func OpenAIModelVersion(dims int, instruction string) string {
	return fmt.Sprintf("dims=%d;instr=%s", dims, ShortHash8(instruction))
}

// TEIModelVersion returns the canonical ModelVersion for a TEI provider:
// "<model_sha>;qp=<sha8(queryPrefix)>;dp=<sha8(docPrefix)>".
func TEIModelVersion(modelSHA, queryPrefix, docPrefix string) string {
	return fmt.Sprintf("%s;qp=%s;dp=%s", modelSHA, ShortHash8(queryPrefix), ShortHash8(docPrefix))
}

// ValidateAndNormalizeL2 checks that v has length dims, contains no NaN/Inf,
// has positive L2 norm, and returns a new slice L2-normalized in float64
// precision (plan P05 mục 2.12). On failure it returns a *ProviderError with
// ClassBadResponse wrapping ErrBadResponse.
func ValidateAndNormalizeL2(v []float32, dims int) ([]float32, error) {
	if dims <= 0 || len(v) != dims {
		return nil, &ProviderError{
			Class:  ClassBadResponse,
			Detail: "vector dimension mismatch",
			Err:    ErrBadResponse,
		}
	}
	var sumSq float64
	for _, x := range v {
		f := float64(x)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, &ProviderError{
				Class:  ClassBadResponse,
				Detail: "vector contains NaN or Inf",
				Err:    ErrBadResponse,
			}
		}
		sumSq += f * f
	}
	norm := math.Sqrt(sumSq)
	if norm == 0 || math.IsNaN(norm) || math.IsInf(norm, 0) {
		return nil, &ProviderError{
			Class:  ClassBadResponse,
			Detail: "vector has zero or invalid norm",
			Err:    ErrBadResponse,
		}
	}
	out := make([]float32, dims)
	inv := 1.0 / norm
	for i, x := range v {
		out[i] = float32(float64(x) * inv)
	}
	return out, nil
}

// ParseRetryAfter parses an HTTP Retry-After header value as either a
// non-negative integer number of seconds or an RFC 7231 HTTP-date relative to
// now (plan P05 mục 2.12). If header is empty, unparseable, or in the past, it
// returns (0, false).
func ParseRetryAfter(header string, now time.Time) (time.Duration, bool) {
	raw := strings.TrimSpace(header)
	if raw == "" {
		return 0, false
	}
	if secs, err := strconv.ParseInt(raw, 10, 64); err == nil {
		if secs <= 0 {
			return 0, false
		}
		const maxSecs = int64(365 * 24 * 3600)
		if secs > maxSecs {
			secs = maxSecs
		}
		return time.Duration(secs) * time.Second, true
	}
	if t, err := http.ParseTime(raw); err == nil {
		if now.IsZero() {
			now = time.Now()
		}
		d := t.Sub(now)
		if d <= 0 {
			return 0, false
		}
		return d, true
	}
	return 0, false
}

// classifyTransportError maps an error returned by http.Client.Do (before an
// HTTP response is received) into a sanitized *ProviderError.
//
// Note: http.Client.Do wraps the underlying transport/context error in a
// *url.Error whose Error() includes the full request URL. We NEVER retain or
// format the raw *url.Error as Detail or Err when it could expose the URL.
func classifyTransportError(err error) *ProviderError {
	if err == nil {
		return nil
	}
	// Check context deadline and network timeout first so any timeout during
	// DNS resolution, dialing, or body reading is always classified as
	// ClassTimeout (never ClassRefused or ClassBadResponse).
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return &ProviderError{
			Class:  ClassTimeout,
			Detail: "request deadline exceeded",
			Err:    context.DeadlineExceeded,
		}
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return &ProviderError{
			Class:  ClassTimeout,
			Detail: "network timeout",
			Err:    context.DeadlineExceeded,
		}
	}
	var pe *ProviderError
	if errors.As(err, &pe) && pe != nil {
		return &ProviderError{
			Class:      pe.Class,
			HTTPStatus: pe.HTTPStatus,
			RetryAfter: pe.RetryAfter,
			Detail:     pe.Detail,
			Err:        safeUnwrapErr(pe.Err),
		}
	}
	if errors.Is(err, ErrDisallowedIP) {
		return &ProviderError{
			Class:  ClassRefused,
			Detail: "http destination IP rejected by URL rule",
			Err:    ErrDisallowedIP,
		}
	}
	if errors.Is(err, ErrDisallowedURL) {
		return &ProviderError{
			Class:  ClassRefused,
			Detail: "request URL rejected by URL rule",
			Err:    ErrDisallowedURL,
		}
	}
	return &ProviderError{
		Class:  ClassRefused,
		Detail: "network error",
	}
}

func safeUnwrapErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrBadResponse):
		return ErrBadResponse
	case errors.Is(err, ErrDisallowedIP):
		return ErrDisallowedIP
	case errors.Is(err, ErrDisallowedURL):
		return ErrDisallowedURL
	case errors.Is(err, context.DeadlineExceeded):
		return context.DeadlineExceeded
	case errors.Is(err, context.Canceled):
		return context.Canceled
	default:
		return nil
	}
}

// classifyHTTPStatus maps a non-2xx HTTP status code into a *ProviderError
// (plan P05 mục 2.12, 2.21):
//   - 3xx (unfollowed redirect): ClassBadResponse (wraps ErrBadResponse)
//   - 429: Class429 with RetryAfter parsed from Retry-After header
//   - 5xx: Class5xx
//   - other non-2xx (e.g. 400, 401, 403, 404): ClassRefused
func classifyHTTPStatus(status int, header http.Header, now time.Time) *ProviderError {
	if status >= 300 && status < 400 {
		return &ProviderError{
			Class:      ClassBadResponse,
			HTTPStatus: status,
			Detail:     "unexpected redirect response",
			Err:        ErrBadResponse,
		}
	}
	if status == http.StatusTooManyRequests {
		var retryAfter time.Duration
		if header != nil {
			if d, ok := ParseRetryAfter(header.Get("Retry-After"), now); ok {
				retryAfter = d
			}
		}
		return &ProviderError{
			Class:      Class429,
			HTTPStatus: status,
			RetryAfter: retryAfter,
			Detail:     "rate limited by provider",
		}
	}
	if status >= 500 && status < 600 {
		return &ProviderError{
			Class:      Class5xx,
			HTTPStatus: status,
			Detail:     "upstream server error",
		}
	}
	return &ProviderError{
		Class:      ClassRefused,
		HTTPStatus: status,
		Detail:     "unexpected HTTP status",
	}
}

// recordProviderCall updates Prometheus metrics (when metrics != nil) and
// writes a sanitized structured log entry (when logger != nil).
//
// Security invariant (plan P05 mục 1, 2.12, SPEC §10.2/§10.3):
// Logs and metric labels NEVER include inputs, query text, API keys, response
// bodies, full URLs, or HTTP headers. Only provider, op, input_count,
// latency_ms, error_class, and http_status are emitted.
func recordProviderCall(
	ctx context.Context,
	metrics *obs.EmbeddingMetrics,
	logger *slog.Logger,
	provider string,
	op string,
	inputCount int,
	latency time.Duration,
	httpStatus int,
	err error,
) {
	if metrics != nil && (op == OpQuery || op == OpDocument) {
		outcome := OutcomeForError(err)
		if metrics.ProviderRequestsTotal != nil {
			metrics.ProviderRequestsTotal.WithLabelValues(provider, op, outcome).Inc()
		}
		if metrics.ProviderLatency != nil {
			metrics.ProviderLatency.WithLabelValues(provider, op).Observe(latency.Seconds())
		}
	}
	if logger == nil {
		return
	}
	var errClass string
	if err != nil {
		var pe *ProviderError
		if errors.As(err, &pe) && pe != nil {
			errClass = string(pe.Class)
			if httpStatus == 0 {
				httpStatus = pe.HTTPStatus
			}
		} else if errors.Is(err, ErrBadResponse) {
			errClass = string(ClassBadResponse)
		} else if errors.Is(err, context.DeadlineExceeded) {
			errClass = string(ClassTimeout)
		} else {
			errClass = string(ClassRefused)
		}
	}
	attrs := []slog.Attr{
		slog.String("provider", provider),
		slog.String("op", op),
		slog.Int("input_count", inputCount),
		slog.Float64("latency_ms", float64(latency.Microseconds())/1000.0),
		slog.String("error_class", errClass),
		slog.Int("http_status", httpStatus),
	}
	if err != nil {
		logger.LogAttrs(ctx, slog.LevelWarn, "embedding provider request failed", attrs...)
	} else {
		logger.LogAttrs(ctx, slog.LevelDebug, "embedding provider request completed", attrs...)
	}
}
