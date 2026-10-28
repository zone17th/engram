package oauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	providerHTTPTimeout = 10 * time.Second
	providerMaxBody     = 1 << 20
)

var errProviderHTTP = errors.New("oauth provider request failed")

// providerHTTPClient does not follow redirects. A redirect from a token or
// API endpoint must never turn into a bearer-token request to another host.
var providerHTTPClient = &http.Client{
	Timeout: providerHTTPTimeout,
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

func normalizeProviderHTTPClient(client *http.Client) *http.Client {
	if client != nil {
		copy := *client
		if copy.Timeout == 0 || copy.Timeout > providerHTTPTimeout {
			copy.Timeout = providerHTTPTimeout
		}
		copy.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}
		return &copy
	}
	return providerHTTPClient
}

func providerRequestContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithTimeout(ctx, providerHTTPTimeout)
}

func providerAuthorizationURL(raw, clientID, scope string, in AuthRequest, nonce bool) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", errProviderHTTP
	}
	q := u.Query()
	q.Set("client_id", clientID)
	q.Set("redirect_uri", in.RedirectURI)
	q.Set("response_type", "code")
	q.Set("scope", scope)
	q.Set("state", in.State)
	q.Set("code_challenge", in.CodeChallenge)
	q.Set("code_challenge_method", "S256")
	if nonce {
		if in.Nonce == "" {
			return "", errProviderHTTP
		}
		q.Set("nonce", in.Nonce)
	}
	if in.PromptLogin {
		q.Set("prompt", "select_account")
		q.Set("max_age", "0")
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func postProviderJSON(ctx context.Context, client *http.Client, endpoint string, form url.Values, headers map[string]string, out any) error {
	requestCtx, cancel := providerRequestContext(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return errProviderHTTP
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return errProviderHTTP
	}
	if resp == nil || resp.Body == nil {
		return errProviderHTTP
	}
	defer func() { _ = resp.Body.Close() }()
	return decodeProviderResponse(resp, out)
}

func getProviderJSON(ctx context.Context, client *http.Client, endpoint string, headers map[string]string, out any) error {
	requestCtx, cancel := providerRequestContext(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return errProviderHTTP
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return errProviderHTTP
	}
	if resp == nil || resp.Body == nil {
		return errProviderHTTP
	}
	defer func() { _ = resp.Body.Close() }()
	return decodeProviderResponse(resp, out)
}

func decodeProviderResponse(resp *http.Response, out any) error {
	if resp == nil {
		return errProviderHTTP
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return errProviderHTTP
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, providerMaxBody+1))
	if err != nil || len(body) > providerMaxBody {
		return errProviderHTTP
	}
	if out == nil || len(bytes.TrimSpace(body)) == 0 {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(out); err != nil {
		return errProviderHTTP
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errProviderHTTP
	}
	return nil
}
