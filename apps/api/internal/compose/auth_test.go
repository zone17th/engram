package compose

import (
	"testing"

	"github.com/zone17th/engram/apps/api/internal/auth/oauth"
	"github.com/zone17th/engram/apps/api/internal/config"
)

func TestDefaultProvidersUseConfiguredRealAdapters(t *testing.T) {
	cfg := &config.Config{
		AppOrigin:               "https://app.example.test",
		OAuthGoogleClientID:     "google-client",
		OAuthGoogleClientSecret: "google-secret",
		OAuthGitHubClientID:     "github-client",
		OAuthGitHubClientSecret: "github-secret",
		GoogleReauthEnabled:     true,
	}

	providers := DefaultProviders(cfg)
	if len(providers) != 2 {
		t.Fatalf("providers = %d, want 2", len(providers))
	}
	google, ok := providers[0].(*oauth.GoogleProvider)
	if !ok || google.Name() != "google" {
		t.Fatalf("google provider = %T", providers[0])
	}
	if !google.SupportsReauth() {
		t.Fatal("configured Google reauth should be advertised")
	}
	github, ok := providers[1].(*oauth.GitHubProvider)
	if !ok || github.Name() != "github" {
		t.Fatalf("GitHub provider = %T", providers[1])
	}
	if github.SupportsReauth() {
		t.Fatal("GitHub must not advertise reauth")
	}
}

func TestDefaultProvidersDoNotAdvertiseGoogleReauthWhenDisabled(t *testing.T) {
	cfg := &config.Config{
		AppOrigin:               "https://app.example.test",
		OAuthGoogleClientID:     "google-client",
		OAuthGoogleClientSecret: "google-secret",
	}
	providers := DefaultProviders(cfg)
	if len(providers) != 1 {
		t.Fatalf("providers = %d, want 1", len(providers))
	}
	if providers[0].SupportsReauth() {
		t.Fatal("Google reauth must remain disabled unless configured")
	}
}
