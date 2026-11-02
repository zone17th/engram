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
	"time"
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

// IsTimeoutError reports whether err represents a deadline or network timeout
// (context.DeadlineExceeded or net.Error with Timeout() == true).
func IsTimeoutError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne != nil && ne.Timeout()
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
	if IsTimeoutError(err) {
		return ClassTimeout.MetricOutcome()
	}
	if errors.Is(err, ErrBadResponse) {
		return ClassBadResponse.MetricOutcome()
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

// Secret holds a sensitive credential (such as an embedding API key) whose
// formatting, JSON/text marshaling, and structured logging representations are
// unconditionally redacted to "[redacted]". Call Reveal() only at the exact
// site that constructs an outbound Authorization header.
type Secret string

const redactedMask = "[redacted]"

// Reveal returns the underlying raw secret string.
func (s Secret) Reveal() string {
	return string(s)
}

// IsEmpty reports whether the secret is empty.
func (s Secret) IsEmpty() bool {
	return s == ""
}

// String implements fmt.Stringer with a fixed redaction mask.
func (s Secret) String() string {
	return redactedMask
}

// GoString implements fmt.GoStringer so %#v never leaks the secret.
func (s Secret) GoString() string {
	return redactedMask
}

// Format implements fmt.Formatter so every verb (%v, %+v, %#v, %s, %q, %x, ...)
// writes the redaction mask rather than the raw secret bytes.
func (s Secret) Format(f fmt.State, verb rune) {
	if verb == 'q' {
		_, _ = fmt.Fprintf(f, "%q", redactedMask)
		return
	}
	_, _ = f.Write([]byte(redactedMask))
}

// MarshalJSON implements json.Marshaler with a fixed redaction mask.
func (s Secret) MarshalJSON() ([]byte, error) {
	return []byte(`"[redacted]"`), nil
}

// MarshalText implements encoding.TextMarshaler with a fixed redaction mask.
func (s Secret) MarshalText() ([]byte, error) {
	return []byte(redactedMask), nil
}

// LogValue implements slog.LogValuer with a fixed redaction mask.
func (s Secret) LogValue() slog.Value {
	return slog.StringValue(redactedMask)
}

// ClientConfig holds the configuration for a single embedding provider client
// (primary or shadow). Its String and GoString methods redact APIKey and
// BaseURL so formatting with %v / %+v / %#v never leaks secrets or full URLs.
type ClientConfig struct {
	Provider         string
	BaseURL          string
	APIKey           Secret
	Model            string
	Dims             int
	QueryInstruction string
	QueryTimeout     time.Duration
	DocumentTimeout  time.Duration
	QueryPrefix      string
	DocPrefix        string
}

func (c ClientConfig) redactedSummary() string {
	keySet := !c.APIKey.IsEmpty()
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

// LogValue implements slog.LogValuer with a redacted representation so logging
// a ClientConfig directly never exposes APIKey or BaseURL.
func (c ClientConfig) LogValue() slog.Value {
	return slog.StringValue(c.redactedSummary())
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
