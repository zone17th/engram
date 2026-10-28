package oauth

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
)

var defaultGitHubEndpoints = GitHubEndpoints{
	AuthorizationURL: "https://github.com/login/oauth/authorize",
	TokenURL:         "https://github.com/login/oauth/access_token",
	UserURL:          "https://api.github.com/user",
	EmailsURL:        "https://api.github.com/user/emails",
}

// GitHubEndpoints is injectable for provider tests. Production constructors
// always use the fixed GitHub endpoints above.
type GitHubEndpoints struct {
	AuthorizationURL string
	TokenURL         string
	UserURL          string
	EmailsURL        string
}

type GitHubProvider struct {
	clientID     string
	clientSecret string
	client       *http.Client
	endpoints    GitHubEndpoints
}

func NewGitHubProvider(clientID, clientSecret string) *GitHubProvider {
	return NewGitHubProviderWithHTTP(clientID, clientSecret, nil, GitHubEndpoints{})
}

func NewGitHubProviderWithHTTP(clientID, clientSecret string, client *http.Client, endpoints GitHubEndpoints) *GitHubProvider {
	if endpoints.AuthorizationURL == "" {
		endpoints.AuthorizationURL = defaultGitHubEndpoints.AuthorizationURL
	}
	if endpoints.TokenURL == "" {
		endpoints.TokenURL = defaultGitHubEndpoints.TokenURL
	}
	if endpoints.UserURL == "" {
		endpoints.UserURL = defaultGitHubEndpoints.UserURL
	}
	if endpoints.EmailsURL == "" {
		endpoints.EmailsURL = defaultGitHubEndpoints.EmailsURL
	}
	return &GitHubProvider{
		clientID:     clientID,
		clientSecret: clientSecret,
		client:       normalizeProviderHTTPClient(client),
		endpoints:    endpoints,
	}
}

func (p *GitHubProvider) Name() string         { return "github" }
func (p *GitHubProvider) SupportsReauth() bool { return false }

func (p *GitHubProvider) AuthorizationURL(in AuthRequest) (string, error) {
	return providerAuthorizationURL(p.endpoints.AuthorizationURL, p.clientID, "read:user user:email", in, false)
}

type githubTokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
}

type githubUserResponse struct {
	ID int64 `json:"id"`
}

type githubEmailResponse struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

func (p *GitHubProvider) Exchange(ctx context.Context, in ExchangeRequest) (Identity, error) {
	identity, err := p.exchange(ctx, in)
	if err != nil {
		// Provider and upstream response details never cross the auth boundary.
		return Identity{}, auth.ErrOAuthProviderError
	}
	return identity, nil
}

func (p *GitHubProvider) exchange(ctx context.Context, in ExchangeRequest) (Identity, error) {
	if p == nil || strings.TrimSpace(p.clientID) == "" || strings.TrimSpace(p.clientSecret) == "" ||
		strings.TrimSpace(in.Code) == "" || strings.TrimSpace(in.CodeVerifier) == "" ||
		strings.TrimSpace(in.RedirectURI) == "" {
		return Identity{}, errProviderHTTP
	}
	form := url.Values{
		"client_id":     {p.clientID},
		"client_secret": {p.clientSecret},
		"code":          {in.Code},
		"redirect_uri":  {in.RedirectURI},
		"code_verifier": {in.CodeVerifier},
	}
	var token githubTokenResponse
	if err := postProviderJSON(ctx, p.client, p.endpoints.TokenURL, form, map[string]string{
		"Accept": "application/json",
	}, &token); err != nil || strings.TrimSpace(token.AccessToken) == "" {
		return Identity{}, errProviderHTTP
	}

	headers := map[string]string{
		"Accept":               "application/vnd.github+json",
		"Authorization":        "Bearer " + token.AccessToken,
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent":           "engram-auth",
	}
	var user githubUserResponse
	if err := getProviderJSON(ctx, p.client, p.endpoints.UserURL, headers, &user); err != nil || user.ID <= 0 {
		return Identity{}, errProviderHTTP
	}
	var emails []githubEmailResponse
	if err := getProviderJSON(ctx, p.client, p.endpoints.EmailsURL, headers, &emails); err != nil {
		return Identity{}, errProviderHTTP
	}
	email := selectGitHubEmail(emails)
	if email == "" {
		return Identity{}, errProviderHTTP
	}
	normalizedEmail, err := auth.NormalizeEmail(email)
	if err != nil {
		return Identity{}, errProviderHTTP
	}
	return Identity{
		Provider:      "github",
		UID:           strconv.FormatInt(user.ID, 10),
		Email:         normalizedEmail,
		EmailVerified: true,
	}, nil
}

func selectGitHubEmail(emails []githubEmailResponse) string {
	for _, entry := range emails {
		if !entry.Verified || !entry.Primary || strings.TrimSpace(entry.Email) == "" {
			continue
		}
		return entry.Email
	}
	return ""
}
