package oauth

import (
	"context"
	"crypto/rsa"
	"crypto/subtle"
	"encoding/base64"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
)

const (
	googleIssuer       = "https://accounts.google.com"
	googleLegacyIssuer = "accounts.google.com"
)

var defaultGoogleEndpoints = GoogleEndpoints{
	AuthorizationURL: "https://accounts.google.com/o/oauth2/v2/auth",
	TokenURL:         "https://oauth2.googleapis.com/token",
	JWKSURL:          "https://www.googleapis.com/oauth2/v3/certs",
}

// GoogleEndpoints is injectable for provider tests. Production constructors
// always use the fixed Google endpoints above.
type GoogleEndpoints struct {
	AuthorizationURL string
	TokenURL         string
	JWKSURL          string
}

type GoogleProvider struct {
	clientID     string
	clientSecret string
	reauth       bool
	client       *http.Client
	endpoints    GoogleEndpoints
}

func NewGoogleProvider(clientID, clientSecret string, reauth bool) *GoogleProvider {
	return NewGoogleProviderWithHTTP(clientID, clientSecret, reauth, nil, GoogleEndpoints{})
}

func NewGoogleProviderWithHTTP(clientID, clientSecret string, reauth bool, client *http.Client, endpoints GoogleEndpoints) *GoogleProvider {
	if endpoints.AuthorizationURL == "" {
		endpoints.AuthorizationURL = defaultGoogleEndpoints.AuthorizationURL
	}
	if endpoints.TokenURL == "" {
		endpoints.TokenURL = defaultGoogleEndpoints.TokenURL
	}
	if endpoints.JWKSURL == "" {
		endpoints.JWKSURL = defaultGoogleEndpoints.JWKSURL
	}
	return &GoogleProvider{
		clientID:     clientID,
		clientSecret: clientSecret,
		reauth:       reauth,
		client:       normalizeProviderHTTPClient(client),
		endpoints:    endpoints,
	}
}

func (p *GoogleProvider) Name() string         { return "google" }
func (p *GoogleProvider) SupportsReauth() bool { return p.reauth }

func (p *GoogleProvider) AuthorizationURL(in AuthRequest) (string, error) {
	return providerAuthorizationURL(p.endpoints.AuthorizationURL, p.clientID, "openid email", in, true)
}

type googleTokenResponse struct {
	AccessToken string `json:"access_token"`
	IDToken     string `json:"id_token"`
	TokenType   string `json:"token_type"`
}

type googleClaims struct {
	jwt.RegisteredClaims
	Email           string           `json:"email"`
	EmailVerified   bool             `json:"email_verified"`
	Nonce           string           `json:"nonce"`
	AuthTime        *jwt.NumericDate `json:"auth_time"`
	AuthorizedParty string           `json:"azp"`
}

type googleJWKS struct {
	Keys []googleJWK `json:"keys"`
}

type googleJWK struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func (p *GoogleProvider) Exchange(ctx context.Context, in ExchangeRequest) (Identity, error) {
	identity, err := p.exchange(ctx, in)
	if err != nil {
		// Provider and upstream response details never cross the auth boundary.
		return Identity{}, auth.ErrOAuthProviderError
	}
	return identity, nil
}

func (p *GoogleProvider) exchange(ctx context.Context, in ExchangeRequest) (Identity, error) {
	if p == nil || strings.TrimSpace(p.clientID) == "" || strings.TrimSpace(p.clientSecret) == "" ||
		strings.TrimSpace(in.Code) == "" || strings.TrimSpace(in.CodeVerifier) == "" ||
		strings.TrimSpace(in.RedirectURI) == "" || strings.TrimSpace(in.Nonce) == "" {
		return Identity{}, errProviderHTTP
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {in.Code},
		"client_id":     {p.clientID},
		"client_secret": {p.clientSecret},
		"redirect_uri":  {in.RedirectURI},
		"code_verifier": {in.CodeVerifier},
	}
	var token googleTokenResponse
	if err := postProviderJSON(ctx, p.client, p.endpoints.TokenURL, form, map[string]string{
		"Accept": "application/json",
	}, &token); err != nil || strings.TrimSpace(token.AccessToken) == "" || strings.TrimSpace(token.IDToken) == "" {
		return Identity{}, errProviderHTTP
	}

	var keys googleJWKS
	if err := getProviderJSON(ctx, p.client, p.endpoints.JWKSURL, map[string]string{
		"Accept": "application/json",
	}, &keys); err != nil {
		return Identity{}, errProviderHTTP
	}
	keySet, err := googleRSAKeySet(keys)
	if err != nil {
		return Identity{}, errProviderHTTP
	}
	claims := googleClaims{}
	parsed, err := jwt.ParseWithClaims(token.IDToken, &claims, func(parsed *jwt.Token) (any, error) {
		if parsed.Method != jwt.SigningMethodRS256 {
			return nil, errProviderHTTP
		}
		kid, ok := parsed.Header["kid"].(string)
		if !ok || kid == "" {
			return nil, errProviderHTTP
		}
		key, ok := keySet[kid]
		if !ok {
			return nil, errProviderHTTP
		}
		return key, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()}),
		jwt.WithAudience(p.clientID),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt())
	if err != nil || parsed == nil || !parsed.Valid {
		return Identity{}, errProviderHTTP
	}
	if (claims.Issuer != googleIssuer && claims.Issuer != googleLegacyIssuer) || claims.IssuedAt == nil || claims.ExpiresAt == nil || claims.Subject == "" || !claims.EmailVerified {
		return Identity{}, errProviderHTTP
	}
	if subtle.ConstantTimeCompare([]byte(claims.Nonce), []byte(in.Nonce)) != 1 {
		return Identity{}, errProviderHTTP
	}
	if len(claims.Audience) > 1 {
		if claims.AuthorizedParty == "" || claims.AuthorizedParty != p.clientID {
			return Identity{}, errProviderHTTP
		}
	} else if claims.AuthorizedParty != "" && claims.AuthorizedParty != p.clientID {
		return Identity{}, errProviderHTTP
	}
	email, err := auth.NormalizeEmail(claims.Email)
	if err != nil {
		return Identity{}, errProviderHTTP
	}
	var authTime *time.Time
	if claims.AuthTime != nil {
		value := claims.AuthTime.Time
		authTime = &value
	}
	return Identity{
		Provider:      "google",
		UID:           claims.Subject,
		Email:         email,
		EmailVerified: true,
		AuthTime:      authTime,
	}, nil
}

func googleRSAKeySet(doc googleJWKS) (map[string]*rsa.PublicKey, error) {
	if len(doc.Keys) == 0 {
		return nil, errProviderHTTP
	}
	set := make(map[string]*rsa.PublicKey, len(doc.Keys))
	for _, key := range doc.Keys {
		if key.Kid == "" || key.Kty != "RSA" || (key.Alg != "" && key.Alg != "RS256") ||
			(key.Use != "" && key.Use != "sig") || key.N == "" || key.E == "" {
			continue
		}
		publicKey, err := googleRSAKey(key)
		if err != nil {
			continue
		}
		if _, exists := set[key.Kid]; exists {
			return nil, errProviderHTTP
		}
		set[key.Kid] = publicKey
	}
	if len(set) == 0 {
		return nil, errProviderHTTP
	}
	return set, nil
}

func googleRSAKey(key googleJWK) (*rsa.PublicKey, error) {
	modulus, err := base64.RawURLEncoding.DecodeString(key.N)
	if err != nil || len(modulus) == 0 {
		return nil, errProviderHTTP
	}
	exponentBytes, err := base64.RawURLEncoding.DecodeString(key.E)
	if err != nil || len(exponentBytes) == 0 || len(exponentBytes) > 4 {
		return nil, errProviderHTTP
	}
	exponent := 0
	for _, value := range exponentBytes {
		exponent = exponent<<8 | int(value)
	}
	if exponent < 2 || exponent%2 == 0 {
		return nil, errProviderHTTP
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(modulus), E: exponent}, nil
}
