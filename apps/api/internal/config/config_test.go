package config_test

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
)

func setEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	base := map[string]string{
		"DATABASE_URL": "postgres://engram:engram@localhost:5432/engram?sslmode=disable",
		"APP_ORIGIN":   "http://localhost:3000",
	}
	for k, v := range base {
		if _, ok := kv[k]; !ok {
			t.Setenv(k, v)
		}
	}
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

func b64(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i + 1)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func TestLoadDefaults(t *testing.T) {
	setEnv(t, nil)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.HTTPAddr != "127.0.0.1:8080" {
		t.Errorf("HTTPAddr = %q, muốn 127.0.0.1:8080", cfg.HTTPAddr)
	}
	if cfg.EmbeddingProvider != "noop" {
		t.Errorf("EmbeddingProvider = %q, muốn noop", cfg.EmbeddingProvider)
	}
	if cfg.ShutdownTimeout != 15*time.Second {
		t.Errorf("ShutdownTimeout = %v, muốn 15s", cfg.ShutdownTimeout)
	}
	if cfg.RequireEmailVerification {
		t.Error("AUTH_REQUIRE_EMAIL_VERIFICATION mặc định phải false")
	}
	if cfg.GoogleReauthEnabled {
		t.Error("AUTH_GOOGLE_REAUTH_ENABLED mặc định phải false")
	}
	if cfg.KeyMutationsDisabled {
		t.Error("VAULT_KEY_MUTATIONS_DISABLED mặc định phải false")
	}
	if cfg.AuditRetentionDays != 90 {
		t.Errorf("AuditRetentionDays = %d", cfg.AuditRetentionDays)
	}
	if len(cfg.AuthJWTSecret) < 32 || len(cfg.AuthCSRFSecret) < 32 {
		t.Fatal("development phải có secret đủ dài")
	}
	if !cfg.EphemeralSecrets {
		t.Error("env trống ở development phải đánh dấu ephemeral")
	}
}

func TestSemanticAvailable(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		teiURL   string
		want     bool
	}{
		{"noop mặc định", "noop", "", false},
		{"noop dù có TEI_URL", "noop", "http://tei:80", false},
		{"tei thiếu URL", "tei", "", false},
		{"tei đủ URL", "tei", "http://tei:80", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setEnv(t, map[string]string{
				"EMBEDDING_PROVIDER": tc.provider,
				"TEI_URL":            tc.teiURL,
			})
			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if got := cfg.SemanticAvailable(); got != tc.want {
				t.Errorf("SemanticAvailable() = %v, muốn %v", got, tc.want)
			}
		})
	}
}

func TestLoadRejectsUnknownProvider(t *testing.T) {
	setEnv(t, map[string]string{"EMBEDDING_PROVIDER": "openai"})
	if _, err := config.Load(); err == nil {
		t.Fatal("Load() muốn lỗi với provider lạ, nhận nil")
	}
}

func TestLoadRequiresDatabaseURL(t *testing.T) {
	t.Setenv("APP_ORIGIN", "http://localhost:3000")
	t.Setenv("DATABASE_URL", "")
	if _, err := config.Load(); err == nil {
		t.Fatal("Load() muốn lỗi khi thiếu DATABASE_URL, nhận nil")
	}
}

func TestProductionRejectsMissingSecretsAndHTTP(t *testing.T) {
	setEnv(t, map[string]string{
		"APP_ENV":    "production",
		"APP_ORIGIN": "http://localhost:3000",
	})
	if _, err := config.Load(); err == nil {
		t.Fatal("production thiếu secret và HTTP phải bị reject")
	}
}

func TestProductionAcceptsHTTPSAndDistinctSecrets(t *testing.T) {
	setEnv(t, map[string]string{
		"APP_ENV":            "production",
		"APP_ORIGIN":         "https://key.zone17th.click",
		"AUTH_JWT_SECRET":    b64(32),
		"AUTH_CSRF_SECRET":   b64(33),
		"AUTH_REAUTH_SECRET": b64(34),
		"AUTH_IP_PEPPER":     b64(35),
		"AUTH_EMAIL_PEPPER":  b64(36),
	})
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.EphemeralSecrets {
		t.Error("không được sinh ephemeral ở production")
	}
}

func TestRejectsSharedSecrets(t *testing.T) {
	same := b64(32)
	setEnv(t, map[string]string{
		"AUTH_JWT_SECRET":    same,
		"AUTH_CSRF_SECRET":   same,
		"AUTH_REAUTH_SECRET": b64(33),
		"AUTH_IP_PEPPER":     b64(34),
		"AUTH_EMAIL_PEPPER":  b64(35),
	})
	if _, err := config.Load(); err == nil {
		t.Fatal("secret trùng nhau phải bị reject")
	}
}

func TestFakeOAuthRejectedInProduction(t *testing.T) {
	setEnv(t, map[string]string{
		"APP_ENV":            "production",
		"APP_ORIGIN":         "https://key.zone17th.click",
		"AUTH_FAKE_OAUTH":    "true",
		"AUTH_JWT_SECRET":    b64(32),
		"AUTH_CSRF_SECRET":   b64(33),
		"AUTH_REAUTH_SECRET": b64(34),
		"AUTH_IP_PEPPER":     b64(35),
		"AUTH_EMAIL_PEPPER":  b64(36),
	})
	if _, err := config.Load(); err == nil {
		t.Fatal("production không được bật AUTH_FAKE_OAUTH")
	}
}

func TestFakeOAuthListsProvidersWithoutProductionCredentials(t *testing.T) {
	setEnv(t, map[string]string{"AUTH_FAKE_OAUTH": "true"})
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.OAuthProviders(); len(got) != 2 || got[0] != "google" || got[1] != "github" {
		t.Fatalf("providers = %v", got)
	}
	if got := cfg.OAuthReauthProviders(); len(got) != 1 || got[0] != "google" {
		t.Fatalf("reauth providers = %v", got)
	}
}

func TestRejectsHalfOAuthPair(t *testing.T) {
	setEnv(t, map[string]string{"OAUTH_GOOGLE_CLIENT_ID": "id-only"})
	if _, err := config.Load(); err == nil {
		t.Fatal("nửa cặp OAuth phải bị reject")
	}
}

func TestRejectsShortSecret(t *testing.T) {
	setEnv(t, map[string]string{"AUTH_JWT_SECRET": base64.StdEncoding.EncodeToString([]byte("short"))})
	if _, err := config.Load(); err == nil {
		t.Fatal("secret ngắn phải bị reject")
	}
}

func TestRedactedOmitsSecrets(t *testing.T) {
	setEnv(t, map[string]string{
		"AUTH_JWT_SECRET":    b64(32),
		"AUTH_CSRF_SECRET":   b64(33),
		"AUTH_REAUTH_SECRET": b64(34),
		"AUTH_IP_PEPPER":     b64(35),
		"AUTH_EMAIL_PEPPER":  b64(36),
	})
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	dump := fmtMap(cfg.Redacted())
	if strings.Contains(dump, b64(32)) || strings.Contains(dump, "postgres://engram") {
		t.Fatalf("Redacted lộ secret: %s", dump)
	}
}

func TestOAuthCallbackUsesAppOrigin(t *testing.T) {
	setEnv(t, nil)
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	got := cfg.OAuthCallbackURL("google")
	if got != "http://localhost:3000/api/v1/auth/oauth/google/callback" {
		t.Fatalf("callback = %q", got)
	}
}

func TestLoadKeyMutationsDisabledParse(t *testing.T) {
	setEnv(t, map[string]string{
		"VAULT_KEY_MUTATIONS_DISABLED": "true",
	})
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.KeyMutationsDisabled {
		t.Fatal("VAULT_KEY_MUTATIONS_DISABLED=true phải parse thành true")
	}
	if got, ok := cfg.Redacted()["vault_key_mutations_disabled"].(bool); !ok || !got {
		t.Fatalf("Redacted()[vault_key_mutations_disabled] = %v, muốn true", cfg.Redacted()["vault_key_mutations_disabled"])
	}

	setEnv(t, map[string]string{
		"VAULT_KEY_MUTATIONS_DISABLED": "not-a-bool",
	})
	if _, err := config.Load(); err == nil {
		t.Fatal("VAULT_KEY_MUTATIONS_DISABLED không hợp lệ phải báo lỗi lúc boot")
	}
}

func fmtMap(m map[string]any) string {
	var b strings.Builder
	for k, v := range m {
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(strings.TrimSpace(strings.ReplaceAll(fmt.Sprint(v), "\n", " ")))
		b.WriteByte(';')
	}
	return b.String()
}
