package embedding

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/zone17th/engram/apps/api/internal/obs"
)

// TEIOption configures a TEI provider.
type TEIOption func(*TEI)

// WithTEIHTTPClient overrides the *http.Client used by TEI.
func WithTEIHTTPClient(client *http.Client) TEIOption {
	return func(p *TEI) {
		if client != nil {
			p.httpClient = client
		}
	}
}

// WithTEIMetrics injects the Prometheus EmbeddingMetrics collector into TEI
// (nil-safe).
func WithTEIMetrics(m *obs.EmbeddingMetrics) TEIOption {
	return func(p *TEI) {
		p.metrics = m
	}
}

// WithTEILogger injects the structured logger into TEI (nil-safe).
func WithTEILogger(l *slog.Logger) TEIOption {
	return func(p *TEI) {
		p.logger = l
	}
}

// WithTEIClock overrides the clock used for latency measurement and
// Retry-After HTTP-date parsing in TEI (for deterministic tests).
func WithTEIClock(now func() time.Time) TEIOption {
	return func(p *TEI) {
		if now != nil {
			p.now = now
		}
	}
}

// TEI implements Provider over a Hugging Face Text Embeddings Inference server
// (plan P05 mục 2.12, SPEC §4.4, §6.7).
type TEI struct {
	baseURL         string
	infoURL         string
	embedURL        string
	modelID         string
	modelSHA        string
	fullModel       string
	modelVersion    string
	dims            int
	queryPrefix     string
	docPrefix       string
	queryTimeout    time.Duration
	documentTimeout time.Duration
	httpClient      *http.Client
	metrics         *obs.EmbeddingMetrics
	logger          *slog.Logger
	now             func() time.Time
}

type teiInfoResponse struct {
	ModelID  string `json:"model_id"`
	ModelSHA string `json:"model_sha"`
	SHA      string `json:"sha"`
}

// NewTEI validates cfg, fetches GET {TEI_URL}/info using DocumentTimeout to
// resolve model_id and model_sha, and returns a configured TEI provider
// (plan P05 mục 2.12).
//
// Security invariant: error messages never include raw URLs, headers, or
// response bodies.
func NewTEI(ctx context.Context, cfg ClientConfig, opts ...TEIOption) (*TEI, error) {
	baseURL := strings.TrimSpace(cfg.BaseURL)
	if err := CheckURL(baseURL); err != nil {
		return nil, err
	}
	if cfg.Dims <= 0 || cfg.Dims > 2000 {
		return nil, fmt.Errorf("embedding: tei dimensions must be in 1..2000")
	}

	queryTimeout := cfg.QueryTimeout
	if queryTimeout <= 0 {
		queryTimeout = DefaultTEIQueryTimeout
	}
	docTimeout := cfg.DocumentTimeout
	if docTimeout <= 0 {
		docTimeout = DefaultDocumentTimeout
	}

	trimmedBase := strings.TrimRight(baseURL, "/")
	p := &TEI{
		baseURL:         trimmedBase,
		infoURL:         trimmedBase + "/info",
		embedURL:        trimmedBase + "/embed",
		dims:            cfg.Dims,
		queryPrefix:     cfg.QueryPrefix,
		docPrefix:       cfg.DocPrefix,
		queryTimeout:    queryTimeout,
		documentTimeout: docTimeout,
		httpClient:      NewHTTPClient(),
		now:             time.Now,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(p)
		}
	}

	if err := p.fetchBootInfo(ctx); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *TEI) fetchBootInfo(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	infoCtx, cancel := context.WithTimeout(ctx, p.documentTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(infoCtx, http.MethodGet, p.infoURL, nil)
	if err != nil {
		return &ProviderError{
			Class:  ClassRefused,
			Detail: "failed constructing TEI info request",
		}
	}
	req.Header.Set("Accept", "application/json")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		return classifyTransportError(err)
	}
	defer resp.Body.Close()

	bodyBytes, readErr := ReadBodyCapped(resp.Body)
	if readErr != nil {
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return classifyHTTPStatus(resp.StatusCode, resp.Header, p.now())
		}
		return classifyTransportError(readErr)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return classifyHTTPStatus(resp.StatusCode, resp.Header, p.now())
	}

	var info teiInfoResponse
	if err := json.Unmarshal(bodyBytes, &info); err != nil {
		return &ProviderError{
			Class:      ClassBadResponse,
			HTTPStatus: resp.StatusCode,
			Detail:     "malformed TEI /info JSON",
			Err:        ErrBadResponse,
		}
	}

	modelID := strings.TrimSpace(info.ModelID)
	if modelID == "" {
		return &ProviderError{
			Class:      ClassBadResponse,
			HTTPStatus: resp.StatusCode,
			Detail:     "TEI /info missing model_id",
			Err:        ErrBadResponse,
		}
	}
	modelSHA := strings.TrimSpace(info.ModelSHA)
	if modelSHA == "" {
		modelSHA = strings.TrimSpace(info.SHA)
	}
	if modelSHA == "" {
		modelSHA = "unknown"
	}

	p.modelID = modelID
	p.modelSHA = modelSHA
	p.fullModel = ProviderTEI + "/" + modelID
	p.modelVersion = TEIModelVersion(modelSHA, p.queryPrefix, p.docPrefix)
	return nil
}

// Name returns "tei".
func (p *TEI) Name() string {
	return ProviderTEI
}

// Model returns "tei/<model_id>".
func (p *TEI) Model() string {
	return p.fullModel
}

// ModelVersion returns "<model_sha>;qp=<sha8>;dp=<sha8>".
func (p *TEI) ModelVersion() string {
	return p.modelVersion
}

// Dims returns the configured vector dimension.
func (p *TEI) Dims() int {
	return p.dims
}

// MaxBatch returns MaxBatch (64).
func (p *TEI) MaxBatch() int {
	return MaxBatch
}

// String returns a redacted summary of the TEI provider.
func (p *TEI) String() string {
	if p == nil {
		return "<nil>"
	}
	return fmt.Sprintf("TEI{Model:%q, ModelVersion:%q, Dims:%d}", p.fullModel, p.modelVersion, p.dims)
}

// GoString returns a redacted summary of the TEI provider.
func (p *TEI) GoString() string {
	return p.String()
}

// EmbedDocuments embeds up to MaxBatch (64) document inputs, prepending
// TEI_INPUT_PREFIX_DOCUMENT to each input (plan P05 mục 2.12).
func (p *TEI) EmbedDocuments(ctx context.Context, inputs []string) ([][]float32, error) {
	if len(inputs) == 0 {
		return nil, ErrEmptyBatch
	}
	if len(inputs) > MaxBatch {
		return nil, fmt.Errorf("%w: got %d, max %d", ErrBatchTooLarge, len(inputs), MaxBatch)
	}
	prefixed := make([]string, len(inputs))
	for i, in := range inputs {
		prefixed[i] = p.docPrefix + in
	}
	return p.doEmbed(ctx, OpDocument, prefixed, p.documentTimeout)
}

// EmbedQuery embeds a single search query, prepending TEI_INPUT_PREFIX_QUERY
// (plan P05 mục 2.12).
func (p *TEI) EmbedQuery(ctx context.Context, q string) ([]float32, error) {
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

type teiEmbedPayload struct {
	Inputs    []string `json:"inputs"`
	Normalize bool     `json:"normalize"`
	Truncate  bool     `json:"truncate"`
}

func (p *TEI) doEmbed(ctx context.Context, op string, inputs []string, timeout time.Duration) ([][]float32, error) {
	start := p.now()
	var httpStatus int
	var retErr error
	defer func() {
		latency := p.now().Sub(start)
		if latency < 0 {
			latency = 0
		}
		recordProviderCall(ctx, p.metrics, p.logger, ProviderTEI, op, len(inputs), latency, httpStatus, retErr)
	}()

	callCtx := ctx
	var cancel context.CancelFunc
	if timeout > 0 {
		callCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	reqBody, err := json.Marshal(teiEmbedPayload{
		Inputs:    inputs,
		Normalize: true,
		Truncate:  true,
	})
	if err != nil {
		retErr = &ProviderError{
			Class:  ClassBadResponse,
			Detail: "failed encoding TEI request payload",
			Err:    ErrBadResponse,
		}
		return nil, retErr
	}

	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, p.embedURL, bytes.NewReader(reqBody))
	if err != nil {
		retErr = &ProviderError{
			Class:  ClassRefused,
			Detail: "failed constructing TEI request",
		}
		return nil, retErr
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := p.httpClient.Do(req)
	if err != nil {
		retErr = classifyTransportError(err)
		return nil, retErr
	}
	defer resp.Body.Close()

	httpStatus = resp.StatusCode
	bodyBytes, readErr := ReadBodyCapped(resp.Body)
	if readErr != nil {
		if httpStatus < 200 || httpStatus >= 300 {
			retErr = classifyHTTPStatus(httpStatus, resp.Header, p.now())
			return nil, retErr
		}
		retErr = classifyTransportError(readErr)
		return nil, retErr
	}

	if httpStatus < 200 || httpStatus >= 300 {
		retErr = classifyHTTPStatus(httpStatus, resp.Header, p.now())
		return nil, retErr
	}

	var rawVecs [][]float32
	if err := json.Unmarshal(bodyBytes, &rawVecs); err != nil {
		retErr = &ProviderError{
			Class:      ClassBadResponse,
			HTTPStatus: httpStatus,
			Detail:     "malformed TEI /embed JSON",
			Err:        ErrBadResponse,
		}
		return nil, retErr
	}

	n := len(inputs)
	if len(rawVecs) != n {
		retErr = &ProviderError{
			Class:      ClassBadResponse,
			HTTPStatus: httpStatus,
			Detail:     "TEI response vector count mismatch",
			Err:        ErrBadResponse,
		}
		return nil, retErr
	}

	out := make([][]float32, n)
	for i, v := range rawVecs {
		normed, normErr := ValidateAndNormalizeL2(v, p.dims)
		if normErr != nil {
			retErr = &ProviderError{
				Class:      ClassBadResponse,
				HTTPStatus: httpStatus,
				Detail:     "invalid TEI embedding vector",
				Err:        ErrBadResponse,
			}
			return nil, retErr
		}
		out[i] = normed
	}

	return out, nil
}
