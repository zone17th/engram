package embedding

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/zone17th/engram/apps/api/internal/obs"
)

// OpenAICompatOption configures an OpenAICompat provider.
type OpenAICompatOption func(*OpenAICompat)

// WithOpenAIHTTPOptions configures the underlying NewHTTPClient used by
// OpenAICompat without bypassing the no-redirect, no-proxy, dial-IP check, or
// 4 MiB response body cap policy.
func WithOpenAIHTTPOptions(opts ...HTTPClientOption) OpenAICompatOption {
	return func(p *OpenAICompat) {
		if len(opts) > 0 {
			p.httpOpts = append(p.httpOpts, opts...)
		}
	}
}

// WithOpenAIMetrics injects the Prometheus EmbeddingMetrics collector into
// OpenAICompat (nil-safe).
func WithOpenAIMetrics(m *obs.EmbeddingMetrics) OpenAICompatOption {
	return func(p *OpenAICompat) {
		p.metrics = m
	}
}

// WithOpenAILogger injects the structured logger into OpenAICompat (nil-safe).
func WithOpenAILogger(l *slog.Logger) OpenAICompatOption {
	return func(p *OpenAICompat) {
		p.logger = l
	}
}

// WithOpenAIClock overrides the clock used for latency measurement and
// Retry-After HTTP-date parsing in OpenAICompat (for deterministic tests).
func WithOpenAIClock(now func() time.Time) OpenAICompatOption {
	return func(p *OpenAICompat) {
		if now != nil {
			p.now = now
		}
	}
}

// OpenAICompat implements Provider over an OpenAI-compatible /embeddings API
// (ADR 0004, plan P05 mục 2.12, SPEC §4.4).
type OpenAICompat struct {
	endpoint        Endpoint
	apiKey          Secret
	rawModel        string
	fullModel       string
	modelVersion    string
	dims            int
	instruction     string
	queryPrefix     string
	queryTimeout    time.Duration
	documentTimeout time.Duration
	httpOpts        []HTTPClientOption
	httpClient      *http.Client
	metrics         *obs.EmbeddingMetrics
	logger          *slog.Logger
	now             func() time.Time
}

// NewOpenAICompat validates cfg and constructs an OpenAICompat provider.
//
// Security invariant: error messages returned here never include raw URLs or
// API keys.
func NewOpenAICompat(cfg ClientConfig, opts ...OpenAICompatOption) (*OpenAICompat, error) {
	baseURL := strings.TrimSpace(cfg.BaseURL.Reveal())
	if err := CheckURL(baseURL); err != nil {
		return nil, err
	}
	apiKey := cfg.APIKey
	if apiKey.IsEmpty() {
		return nil, fmt.Errorf("embedding: openai_compat requires non-empty API key")
	}
	rawModel := strings.TrimSpace(cfg.Model)
	if rawModel == "" {
		return nil, fmt.Errorf("embedding: openai_compat requires non-empty model")
	}
	if cfg.Dims <= 0 || cfg.Dims > 2000 {
		return nil, fmt.Errorf("embedding: openai_compat dimensions must be in 1..2000")
	}

	queryTimeout := cfg.QueryTimeout
	if queryTimeout <= 0 {
		queryTimeout = DefaultOpenAIQueryTimeout
	}
	docTimeout := cfg.DocumentTimeout
	if docTimeout <= 0 {
		docTimeout = DefaultDocumentTimeout
	}

	endpoint := NewEndpoint(strings.TrimRight(baseURL, "/") + "/embeddings")
	p := &OpenAICompat{
		endpoint:        endpoint,
		apiKey:          apiKey,
		rawModel:        rawModel,
		fullModel:       ProviderOpenAICompat + "/" + rawModel,
		modelVersion:    OpenAIModelVersion(cfg.Dims, cfg.QueryInstruction),
		dims:            cfg.Dims,
		instruction:     cfg.QueryInstruction,
		queryPrefix:     OpenAIQueryPrefix(cfg.QueryInstruction),
		queryTimeout:    queryTimeout,
		documentTimeout: docTimeout,
		now:             time.Now,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(p)
		}
	}
	p.httpClient = NewHTTPClient(p.httpOpts...)
	return p, nil
}

// Name returns "openai_compat".
func (p *OpenAICompat) Name() string {
	return ProviderOpenAICompat
}

// Model returns "openai_compat/<EMBEDDING_MODEL>".
func (p *OpenAICompat) Model() string {
	return p.fullModel
}

// ModelVersion returns "dims=<dims>;instr=<sha8(instruction)>".
func (p *OpenAICompat) ModelVersion() string {
	return p.modelVersion
}

// Dims returns the configured vector dimension.
func (p *OpenAICompat) Dims() int {
	return p.dims
}

// MaxBatch returns MaxBatch (64).
func (p *OpenAICompat) MaxBatch() int {
	return MaxBatch
}

func (p OpenAICompat) redactedSummary() string {
	return fmt.Sprintf("OpenAICompat{Model:%q, ModelVersion:%q, Dims:%d}", p.fullModel, p.modelVersion, p.dims)
}

// String redacts internal credentials and URLs if the provider is formatted
// (both value and pointer receivers).
func (p OpenAICompat) String() string {
	return p.redactedSummary()
}

// GoString redacts internal credentials and URLs if formatted with %#v
// (both value and pointer receivers).
func (p OpenAICompat) GoString() string {
	return p.redactedSummary()
}

// Format implements fmt.Formatter on the value receiver so %v, %+v, %#v, %s,
// and %q on either OpenAICompat or *OpenAICompat never disclose endpoint URLs
// or credentials.
func (p OpenAICompat) Format(f fmt.State, verb rune) {
	summary := p.redactedSummary()
	if verb == 'q' {
		_, _ = fmt.Fprintf(f, "%q", summary)
		return
	}
	_, _ = f.Write([]byte(summary))
}

// LogValue implements slog.LogValuer so logging an OpenAICompat or
// *OpenAICompat directly never exposes endpoint URLs or credentials.
func (p OpenAICompat) LogValue() slog.Value {
	return slog.StringValue(p.redactedSummary())
}

// EmbedDocuments embeds up to MaxBatch (64) document inputs without any query
// instruction prefix (plan P05 mục 2.12). More than 64 inputs returns an error
// without making a network request (the caller is responsible for chunking).
func (p *OpenAICompat) EmbedDocuments(ctx context.Context, inputs []string) ([][]float32, error) {
	if len(inputs) == 0 {
		return nil, ErrEmptyBatch
	}
	if len(inputs) > MaxBatch {
		return nil, fmt.Errorf("%w: got %d, max %d", ErrBatchTooLarge, len(inputs), MaxBatch)
	}
	// Documents have NO prefix in openai_compat (plan P05 mục 2.12, ADR 0004).
	return p.doEmbed(ctx, OpDocument, inputs, p.documentTimeout)
}

// EmbedQuery embeds a single search query with the Qwen3 instruction prefix
// "Instruct: <instruction>\nQuery:<q>" (plan P05 mục 2.12, ADR 0004).
// There is no retry inside a call.
func (p *OpenAICompat) EmbedQuery(ctx context.Context, q string) ([]float32, error) {
	prefixed := p.queryPrefix + q
	vecs, err := p.doEmbed(ctx, OpQuery, []string{prefixed}, p.queryTimeout)
	if err != nil {
		return nil, err
	}
	if len(vecs) != 1 {
		return nil, &ProviderError{
			Class:  ClassBadResponse,
			Detail: "unexpected vector count for query",
			Err:    ErrBadResponse,
		}
	}
	return vecs[0], nil
}

type openAIRequestPayload struct {
	Model          string   `json:"model"`
	Input          []string `json:"input"`
	Dimensions     int      `json:"dimensions"`
	EncodingFormat string   `json:"encoding_format"`
}

type openAIResponsePayload struct {
	Data []openAIResponseItem `json:"data"`
}

type openAIResponseItem struct {
	Index     *int            `json:"index"`
	Embedding json.RawMessage `json:"embedding"`
}

func (p *OpenAICompat) doEmbed(ctx context.Context, op string, inputs []string, timeout time.Duration) ([][]float32, error) {
	start := p.now()
	var httpStatus int
	var retErr error
	defer func() {
		latency := p.now().Sub(start)
		if latency < 0 {
			latency = 0
		}
		recordProviderCall(ctx, p.metrics, p.logger, ProviderOpenAICompat, op, len(inputs), latency, httpStatus, retErr)
	}()

	callCtx := ctx
	var cancel context.CancelFunc
	if timeout > 0 {
		callCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	reqBody, err := json.Marshal(openAIRequestPayload{
		Model:          p.rawModel,
		Input:          inputs,
		Dimensions:     p.dims,
		EncodingFormat: "float",
	})
	if err != nil {
		retErr = &ProviderError{
			Class:  ClassBadResponse,
			Detail: "failed encoding request payload",
			Err:    ErrBadResponse,
		}
		return nil, retErr
	}

	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, p.endpoint.Reveal(), bytes.NewReader(reqBody))
	if err != nil {
		retErr = &ProviderError{
			Class:  ClassRefused,
			Detail: "failed constructing request",
		}
		return nil, retErr
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.apiKey.Reveal())

	resp, err := p.httpClient.Do(req)
	if err != nil {
		retErr = classifyTransportError(err)
		return nil, retErr
	}
	defer resp.Body.Close()

	httpStatus = resp.StatusCode
	if httpStatus < 200 || httpStatus >= 300 {
		retErr = classifyHTTPStatus(httpStatus, resp.Header, p.now())
		return nil, retErr
	}

	bodyBytes, readErr := ReadBodyCapped(resp.Body)
	if readErr != nil {
		retErr = classifyTransportError(readErr)
		return nil, retErr
	}

	var parsed openAIResponsePayload
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		retErr = &ProviderError{
			Class:      ClassBadResponse,
			HTTPStatus: httpStatus,
			Detail:     "malformed response JSON",
			Err:        ErrBadResponse,
		}
		return nil, retErr
	}

	n := len(inputs)
	if len(parsed.Data) != n {
		retErr = &ProviderError{
			Class:      ClassBadResponse,
			HTTPStatus: httpStatus,
			Detail:     "response vector count mismatch",
			Err:        ErrBadResponse,
		}
		return nil, retErr
	}

	for i := range parsed.Data {
		if parsed.Data[i].Index == nil {
			retErr = &ProviderError{
				Class:      ClassBadResponse,
				HTTPStatus: httpStatus,
				Detail:     "response item missing index",
				Err:        ErrBadResponse,
			}
			return nil, retErr
		}
	}

	// Sort by data[].index and require exact contiguous indices 0..n-1.
	sort.Slice(parsed.Data, func(i, j int) bool {
		return *parsed.Data[i].Index < *parsed.Data[j].Index
	})

	out := make([][]float32, n)
	for i, item := range parsed.Data {
		if *item.Index != i {
			retErr = &ProviderError{
				Class:      ClassBadResponse,
				HTTPStatus: httpStatus,
				Detail:     "response indices are not contiguous 0..n-1",
				Err:        ErrBadResponse,
			}
			return nil, retErr
		}
		coords, coordErr := strictFloat32Vector(item.Embedding)
		if coordErr != nil {
			retErr = &ProviderError{
				Class:      ClassBadResponse,
				HTTPStatus: httpStatus,
				Detail:     "invalid embedding vector",
				Err:        ErrBadResponse,
			}
			return nil, retErr
		}
		normed, normErr := ValidateAndNormalizeL2(coords, p.dims)
		if normErr != nil {
			retErr = &ProviderError{
				Class:      ClassBadResponse,
				HTTPStatus: httpStatus,
				Detail:     "invalid embedding vector",
				Err:        ErrBadResponse,
			}
			return nil, retErr
		}
		out[i] = normed
	}

	return out, nil
}
