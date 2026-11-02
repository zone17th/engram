package oauth_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/oauth"
)

func TestGoogleProviderExchangesAndVerifiesOIDC(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	claims := googleClaimsForTest(now)
	claims["auth_time"] = now.Unix()
	idToken := signGoogleToken(t, key, "kid-1", claims)

	var gotForm url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			if err := r.ParseForm(); err != nil {
				t.Errorf("parse token form: %v", err)
			}
			gotForm = r.PostForm
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "access", "id_token": idToken, "token_type": "Bearer"})
		case "/certs":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{rsaJWK(key, "kid-1")}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	provider := oauth.NewGoogleProviderWithHTTP("google-client", "google-secret", true, srv.Client(), oauth.GoogleEndpoints{
		AuthorizationURL: srv.URL + "/authorize",
		TokenURL:         srv.URL + "/token",
		JWKSURL:          srv.URL + "/certs",
	})
	identity, err := provider.Exchange(context.Background(), oauth.ExchangeRequest{
		Code:         "code-1",
		CodeVerifier: "verifier-1",
		RedirectURI:  "https://app.example.test/api/v1/auth/oauth/google/callback",
		Nonce:        "nonce",
	})
	if err != nil {
		t.Fatal(err)
	}
	if identity.Provider != "google" || identity.UID != "google-sub" || identity.Email != "person@example.com" || !identity.EmailVerified {
		t.Fatalf("identity = %+v", identity)
	}
	if identity.AuthTime == nil || !identity.AuthTime.Equal(now) {
		t.Fatalf("auth_time = %v, want %v", identity.AuthTime, now)
	}
	if gotForm.Get("client_secret") != "google-secret" || gotForm.Get("code_verifier") != "verifier-1" || gotForm.Get("redirect_uri") == "" {
		t.Fatalf("token form missing expected fields: client_secret=%t code_verifier=%t redirect_uri=%t",
			gotForm.Get("client_secret") == "google-secret", gotForm.Get("code_verifier") == "verifier-1", gotForm.Get("redirect_uri") != "")
	}
	if !provider.SupportsReauth() {
		t.Fatal("configured Google provider should advertise reauth")
	}

	authURL, err := provider.AuthorizationURL(oauth.AuthRequest{
		State:         "state-1",
		RedirectURI:   "https://app.example.test/callback",
		CodeChallenge: "challenge-1",
		Nonce:         "nonce",
		PromptLogin:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	authQuery, err := url.Parse(authURL)
	if err != nil {
		t.Fatal(err)
	}
	if authQuery.Query().Get("client_id") != "google-client" || authQuery.Query().Get("code_challenge_method") != "S256" || authQuery.Query().Get("prompt") != "select_account" || authQuery.Query().Get("max_age") != "0" {
		t.Fatalf("authorization URL = %s", authURL)
	}
}

func TestGoogleProviderRejectsInvalidOIDCClaims(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	cases := []struct {
		name   string
		claims jwt.MapClaims
		signer *rsa.PrivateKey
	}{
		{name: "nonce", claims: mergeGoogleClaims(googleClaimsForTest(now), map[string]any{"nonce": "wrong"}), signer: key},
		{name: "issuer", claims: mergeGoogleClaims(googleClaimsForTest(now), map[string]any{"iss": "https://issuer.example.test"}), signer: key},
		{name: "audience", claims: mergeGoogleClaims(googleClaimsForTest(now), map[string]any{"aud": "other-client"}), signer: key},
		{name: "signature", claims: googleClaimsForTest(now), signer: otherKey},
		{name: "expired", claims: mergeGoogleClaims(googleClaimsForTest(now), map[string]any{"exp": now.Add(-time.Minute).Unix(), "iat": now.Add(-2 * time.Minute).Unix()}), signer: key},
		{name: "unverified email", claims: mergeGoogleClaims(googleClaimsForTest(now), map[string]any{"email_verified": false}), signer: key},
		{name: "missing auth time is still a login identity", claims: mergeGoogleClaims(googleClaimsForTest(now), map[string]any{"auth_time": nil}), signer: key},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			idToken := signGoogleToken(t, tc.signer, "kid-1", tc.claims)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/token":
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "access", "id_token": idToken})
				case "/certs":
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{rsaJWK(key, "kid-1")}})
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			provider := oauth.NewGoogleProviderWithHTTP("google-client", "google-secret", true, srv.Client(), oauth.GoogleEndpoints{
				TokenURL: srv.URL + "/token",
				JWKSURL:  srv.URL + "/certs",
			})
			identity, err := provider.Exchange(context.Background(), oauth.ExchangeRequest{
				Code: "code", CodeVerifier: "verifier", RedirectURI: "https://app.example.test/callback", Nonce: "nonce",
			})
			if tc.name == "missing auth time is still a login identity" {
				if err != nil || identity.Email != "person@example.com" || identity.AuthTime != nil {
					t.Fatalf("identity = %+v, err = %v", identity, err)
				}
				return
			}
			if !errors.Is(err, auth.ErrOAuthProviderError) {
				t.Fatalf("err = %v, want oauth_provider_error", err)
			}
			if identity != (oauth.Identity{}) {
				t.Fatalf("identity on failure = %+v", identity)
			}
		})
	}

	// Multiple audiences require an authorized party bound to this client.
	t.Run("multiple audiences require azp", func(t *testing.T) {
		claims := mergeGoogleClaims(googleClaimsForTest(now), map[string]any{"aud": []string{"google-client", "another-client"}})
		idToken := signGoogleToken(t, key, "kid-1", claims)
		srv := googleTokenJWKSStub(t, idToken, key)
		defer srv.Close()
		provider := oauth.NewGoogleProviderWithHTTP("google-client", "google-secret", false, srv.Client(), oauth.GoogleEndpoints{TokenURL: srv.URL + "/token", JWKSURL: srv.URL + "/certs"})
		_, err := provider.Exchange(context.Background(), oauth.ExchangeRequest{Code: "code", CodeVerifier: "verifier", RedirectURI: "https://app.example.test/callback", Nonce: "nonce"})
		if !errors.Is(err, auth.ErrOAuthProviderError) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestGoogleProviderAcceptsOnlyDocumentedIssuerForms(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	claims := googleClaimsForTest(now)
	claims["iss"] = "accounts.google.com"
	idToken := signGoogleToken(t, key, "kid-1", claims)
	srv := googleTokenJWKSStub(t, idToken, key)
	defer srv.Close()
	provider := oauth.NewGoogleProviderWithHTTP("google-client", "google-secret", false, srv.Client(), oauth.GoogleEndpoints{
		TokenURL: srv.URL + "/token", JWKSURL: srv.URL + "/certs",
	})
	identity, err := provider.Exchange(context.Background(), oauth.ExchangeRequest{
		Code: "code", CodeVerifier: "verifier", RedirectURI: "https://app.example.test/callback", Nonce: "nonce",
	})
	if err != nil || identity.UID != "google-sub" {
		t.Fatalf("identity = %+v, err = %v", identity, err)
	}
}

func TestGitHubProviderUsesVerifiedEmailAndImmutableID(t *testing.T) {
	var gotForm url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			if err := r.ParseForm(); err != nil {
				t.Errorf("parse token form: %v", err)
			}
			gotForm = r.PostForm
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "gh-token", "token_type": "bearer"})
		case "/user":
			if r.Header.Get("Authorization") != "Bearer gh-token" {
				t.Errorf("authorization = %q", r.Header.Get("Authorization"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":987654321,"email":"untrusted@example.com"}`))
		case "/emails":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"email":"unverified@example.com","primary":true,"verified":false},{"email":"secondary@example.com","primary":false,"verified":true},{"email":"primary@example.com","primary":true,"verified":true}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	provider := oauth.NewGitHubProviderWithHTTP("github-client", "github-secret", srv.Client(), oauth.GitHubEndpoints{
		AuthorizationURL: srv.URL + "/authorize",
		TokenURL:         srv.URL + "/token",
		UserURL:          srv.URL + "/user",
		EmailsURL:        srv.URL + "/emails",
	})
	identity, err := provider.Exchange(context.Background(), oauth.ExchangeRequest{
		Code: "code", CodeVerifier: "verifier", RedirectURI: "https://app.example.test/callback",
	})
	if err != nil {
		t.Fatal(err)
	}
	if identity.Provider != "github" || identity.UID != "987654321" || identity.Email != "primary@example.com" || !identity.EmailVerified || identity.AuthTime != nil {
		t.Fatalf("identity = %+v", identity)
	}
	if gotForm.Get("client_secret") != "github-secret" || gotForm.Get("code_verifier") != "verifier" || gotForm.Get("redirect_uri") == "" {
		t.Fatalf("token form missing expected fields: client_secret=%t code_verifier=%t redirect_uri=%t",
			gotForm.Get("client_secret") == "github-secret", gotForm.Get("code_verifier") == "verifier", gotForm.Get("redirect_uri") != "")
	}
	if provider.SupportsReauth() {
		t.Fatal("GitHub must never advertise OIDC reauth")
	}

	authURL, err := provider.AuthorizationURL(oauth.AuthRequest{State: "state", RedirectURI: "https://app.example.test/callback", CodeChallenge: "challenge"})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(authURL)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Query().Get("scope") != "read:user user:email" || parsed.Query().Get("code_challenge_method") != "S256" {
		t.Fatalf("authorization URL = %s", authURL)
	}
}

func TestGitHubProviderRejectsMissingVerifiedEmailAndUpstreamErrors(t *testing.T) {
	cases := []struct {
		name       string
		tokenCode  int
		userStatus int
		emails     string
	}{
		{name: "no verified primary email", emails: `[{"email":"primary@example.com","primary":true,"verified":false},{"email":"secondary@example.com","primary":false,"verified":true}]`},
		{name: "token error", tokenCode: http.StatusBadGateway, emails: `[]`},
		{name: "user error", userStatus: http.StatusForbidden, emails: `[]`},
		{name: "emails malformed", emails: `{`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/token":
					if tc.tokenCode != 0 {
						w.WriteHeader(tc.tokenCode)
						return
					}
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"access_token":"token"}`))
				case "/user":
					if tc.userStatus != 0 {
						w.WriteHeader(tc.userStatus)
						return
					}
					_, _ = w.Write([]byte(`{"id":42}`))
				case "/emails":
					_, _ = w.Write([]byte(tc.emails))
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			provider := oauth.NewGitHubProviderWithHTTP("client", "secret", srv.Client(), oauth.GitHubEndpoints{
				TokenURL: srv.URL + "/token", UserURL: srv.URL + "/user", EmailsURL: srv.URL + "/emails",
			})
			_, err := provider.Exchange(context.Background(), oauth.ExchangeRequest{Code: "code", CodeVerifier: "verifier", RedirectURI: "https://app.example.test/callback"})
			if !errors.Is(err, auth.ErrOAuthProviderError) {
				t.Fatalf("err = %v, want oauth_provider_error", err)
			}
		})
	}
}

func googleClaimsForTest(now time.Time) jwt.MapClaims {
	return jwt.MapClaims{
		"iss":            "https://accounts.google.com",
		"sub":            "google-sub",
		"aud":            "google-client",
		"exp":            now.Add(5 * time.Minute).Unix(),
		"iat":            now.Add(-time.Second).Unix(),
		"nonce":          "nonce",
		"email":          "person@example.com",
		"email_verified": true,
	}
}

func mergeGoogleClaims(base jwt.MapClaims, updates map[string]any) jwt.MapClaims {
	for key, value := range updates {
		base[key] = value
	}
	return base
}

func signGoogleToken(t *testing.T, key *rsa.PrivateKey, kid string, claims jwt.MapClaims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = kid
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func rsaJWK(key *rsa.PrivateKey, kid string) map[string]string {
	return map[string]string{
		"kty": "RSA",
		"kid": kid,
		"alg": "RS256",
		"use": "sig",
		"n":   base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes()),
	}
}

func googleTokenJWKSStub(t *testing.T, idToken string, key *rsa.PrivateKey) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"access","id_token":"` + idToken + `"}`))
		case "/certs":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{rsaJWK(key, "kid-1")}})
		default:
			http.NotFound(w, r)
		}
	}))
}
