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

// WithTEIHTTPOptions configures the underlying NewHTTPClient used by TEI
// without bypassing the no-redirect, no-proxy, dial-IP check, or 4 MiB
// response body cap policy.
func WithTEIHTTPOptions(opts ...HTTPClientOption) TEIOption {
	return func(p *TEI) {
		if len(opts) > 0 {
			p.httpOpts = append(p.httpOpts, opts...)
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
	baseURL         Endpoint
	infoURL         Endpoint
	embedURL        Endpoint
	modelID         string
	modelSHA        string
	fullModel       string
	modelVersion    string
	dims            int
	queryPrefix     string
	docPrefix       string
	queryTimeout    time.Duration
	documentTimeout time.Duration
	httpOpts        []HTTPClientOption
	httpClient      *http.Client
	metrics         *obs.EmbeddingMetrics
	logger          *slog.Logger
	now             func() time.Time
}

type teiInfoResponse struct {
	ModelID  string `json:"model_id"`
	ModelSHA string `json:"model_sha"`
}

// NewTEI validates cfg, fetches GET {TEI_URL}/info using DocumentTimeout to
// resolve model_id and model_sha, and returns a configured TEI provider
// (plan P05 mục 2.12).
//
// Security invariant: error messages never include raw URLs, headers, or
// response bodies.
func NewTEI(ctx context.Context, cfg ClientConfig, opts ...TEIOption) (*TEI, error) {
	baseURL := strings.TrimSpace(cfg.BaseURL.Reveal())
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
		baseURL:         NewEndpoint(trimmedBase),
		infoURL:         NewEndpoint(trimmedBase + "/info"),
		embedURL:        NewEndpoint(trimmedBase + "/embed"),
		dims:            cfg.Dims,
		queryPrefix:     cfg.QueryPrefix,
		docPrefix:       cfg.DocPrefix,
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

	req, err := http.NewRequestWithContext(infoCtx, http.MethodGet, p.infoURL.Reveal(), nil)
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

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return classifyHTTPStatus(resp.StatusCode, resp.Header, p.now())
	}

	bodyBytes, readErr := ReadBodyCapped(resp.Body)
	if readErr != nil {
		return classifyTransportError(readErr)
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
	if !isValidTEIInfoToken(modelID) {
		return &ProviderError{
			Class:      ClassBadResponse,
			HTTPStatus: resp.StatusCode,
			Detail:     "TEI /info missing or invalid model_id",
			Err:        ErrBadResponse,
		}
	}
	modelSHA := strings.TrimSpace(info.ModelSHA)
	if !isValidTEIInfoToken(modelSHA) {
		return &ProviderError{
			Class:      ClassBadResponse,
			HTTPStatus: resp.StatusCode,
			Detail:     "TEI /info missing or invalid model_sha",
			Err:        ErrBadResponse,
		}
	}
	p.modelID = modelID
	p.modelSHA = modelSHA
	p.fullModel = ProviderTEI + "/" + modelID
	p.modelVersion = TEIModelVersion(modelSHA, p.queryPrefix, p.docPrefix)
	return nil
}

// isValidTEIInfoToken enforces the strict charset and length rule
// ^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,127}$ on TEI /info model_id and model_sha
// values so untrusted response strings cannot inject arbitrary text or control
// characters into generation identity strings.
func isValidTEIInfoToken(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	c0 := s[0]
	if !((c0 >= 'A' && c0 <= 'Z') || (c0 >= 'a' && c0 <= 'z') || (c0 >= '0' && c0 <= '9')) {
		return false
	}
	for i := 1; i < len(s); i++ {
		ch := s[i]
		if (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') {
			continue
		}
		switch ch {
		case '.', '_', '/', ':', '@', '+', '-':
			continue
		default:
			return false
		}
	}
	return true
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

func (p TEI) redactedSummary() string {
	return fmt.Sprintf("TEI{Provider:%q, Dims:%d, Endpoint:%s}", ProviderTEI, p.dims, redactedMask)
}

// String returns a redacted summary of the TEI provider (both value and pointer receivers).
func (p TEI) String() string {
	return p.redactedSummary()
}

// GoString returns a redacted summary of the TEI provider (both value and pointer receivers).
func (p TEI) GoString() string {
	return p.redactedSummary()
}

// Format implements fmt.Formatter on the value receiver so %v, %+v, %#v, %s,
// and %q on either TEI or *TEI never disclose endpoint URLs.
func (p TEI) Format(f fmt.State, verb rune) {
	summary := p.redactedSummary()
	if verb == 'q' {
		_, _ = fmt.Fprintf(f, "%q", summary)
		return
	}
	_, _ = f.Write([]byte(summary))
}

// LogValue implements slog.LogValuer so logging a TEI or *TEI directly never
// exposes endpoint URLs.
func (p TEI) LogValue() slog.Value {
	return slog.StringValue(p.redactedSummary())
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

	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, p.embedURL.Reveal(), bytes.NewReader(reqBody))
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
	if httpStatus < 200 || httpStatus >= 300 {
		retErr = classifyHTTPStatus(httpStatus, resp.Header, p.now())
		return nil, retErr
	}

	bodyBytes, readErr := ReadBodyCapped(resp.Body)
	if readErr != nil {
		retErr = classifyTransportError(readErr)
		return nil, retErr
	}

	var rawVecs []json.RawMessage
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
	for i, rawVec := range rawVecs {
		coords, coordErr := strictFloat32Vector(rawVec)
		if coordErr != nil {
			retErr = &ProviderError{
				Class:      ClassBadResponse,
				HTTPStatus: httpStatus,
				Detail:     "invalid TEI embedding vector",
				Err:        ErrBadResponse,
			}
			return nil, retErr
		}
		normed, normErr := ValidateAndNormalizeL2(coords, p.dims)
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
