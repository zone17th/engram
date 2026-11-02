package config_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/config"
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
	if cfg.WebAuthnRPID != "localhost" {
		t.Errorf("WebAuthnRPID = %q, muốn localhost", cfg.WebAuthnRPID)
	}
	if cfg.WebAuthnRPOrigin != "http://localhost:3000" {
		t.Errorf("WebAuthnRPOrigin = %q, muốn http://localhost:3000", cfg.WebAuthnRPOrigin)
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
		"APP_ORIGIN":         "https://engram.zone17.click",
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
	if cfg.WebAuthnRPID != "engram.zone17.click" {
		t.Errorf("WebAuthnRPID = %q, muốn engram.zone17.click", cfg.WebAuthnRPID)
	}
	if cfg.WebAuthnRPOrigin != "https://engram.zone17.click" {
		t.Errorf("WebAuthnRPOrigin = %q, muốn https://engram.zone17.click", cfg.WebAuthnRPOrigin)
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
		"APP_ORIGIN":         "https://engram.zone17.click",
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

// HOTFIX-OAUTH-NULL: with OAuth off both lists must be non-nil so they serialise to [] and never null.
func TestOAuthProviderListsAreEmptyNotNilWhenOAuthOff(t *testing.T) {
	setEnv(t, map[string]string{
		"AUTH_FAKE_OAUTH":            "false",
		"AUTH_GOOGLE_REAUTH_ENABLED": "false",
		"OAUTH_GOOGLE_CLIENT_ID":     "",
		"OAUTH_GOOGLE_CLIENT_SECRET": "",
		"OAUTH_GITHUB_CLIENT_ID":     "",
		"OAUTH_GITHUB_CLIENT_SECRET": "",
	})
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	for name, got := range map[string][]string{
		"OAuthProviders":       cfg.OAuthProviders(),
		"OAuthReauthProviders": cfg.OAuthReauthProviders(),
	} {
		if got == nil {
			t.Fatalf("%s() returned nil", name)
		}
		raw, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if string(raw) != "[]" {
			t.Fatalf("%s() marshals to %s, want []", name, raw)
		}
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

func TestEffectiveMailSinkDir(t *testing.T) {
	defaultSink := filepath.Join(".data", "mail-sink")
	customSink := filepath.Join("custom", "sink-dir")
	cases := []struct {
		name string
		env  string
		dir  string
		want string
	}{
		{
			name: "development + empty MailSinkDir uses default .data/mail-sink",
			env:  "development",
			dir:  "",
			want: defaultSink,
		},
		{
			name: "empty Env + empty MailSinkDir uses default .data/mail-sink",
			env:  "",
			dir:  "",
			want: defaultSink,
		},
		{
			name: "development + explicit MailSinkDir preserves explicit dir",
			env:  "development",
			dir:  customSink,
			want: customSink,
		},
		{
			name: "production + empty MailSinkDir returns empty",
			env:  "production",
			dir:  "",
			want: "",
		},
		{
			name: "staging + empty MailSinkDir returns empty",
			env:  "staging",
			dir:  "",
			want: "",
		},
		{
			name: "production + explicit MailSinkDir preserves explicit dir",
			env:  "production",
			dir:  customSink,
			want: customSink,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &config.Config{
				Env:         tc.env,
				MailSinkDir: tc.dir,
			}
			if got := cfg.EffectiveMailSinkDir(); got != tc.want {
				t.Fatalf("EffectiveMailSinkDir() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestWebAuthnRPBootValidation(t *testing.T) {
	prodSecrets := map[string]string{
		"APP_ENV":            "production",
		"APP_ORIGIN":         "https://engram.zone17.click",
		"AUTH_JWT_SECRET":    b64(32),
		"AUTH_CSRF_SECRET":   b64(33),
		"AUTH_REAUTH_SECRET": b64(34),
		"AUTH_IP_PEPPER":     b64(35),
		"AUTH_EMAIL_PEPPER":  b64(36),
	}

	t.Run("production explicit engram.zone17.click and https://engram.zone17.click accepted", func(t *testing.T) {
		env := make(map[string]string, len(prodSecrets)+2)
		for k, v := range prodSecrets {
			env[k] = v
		}
		env["WEBAUTHN_RP_ID"] = "engram.zone17.click"
		env["WEBAUTHN_RP_ORIGIN"] = "https://engram.zone17.click"
		setEnv(t, env)
		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.WebAuthnRPID != "engram.zone17.click" || cfg.WebAuthnRPOrigin != "https://engram.zone17.click" {
			t.Fatalf("got rpID=%q rpOrigin=%q", cfg.WebAuthnRPID, cfg.WebAuthnRPOrigin)
		}
	})

	t.Run("production registrable suffix zone17.click accepted", func(t *testing.T) {
		env := make(map[string]string, len(prodSecrets)+1)
		for k, v := range prodSecrets {
			env[k] = v
		}
		env["WEBAUTHN_RP_ID"] = "zone17.click"
		setEnv(t, env)
		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.WebAuthnRPID != "zone17.click" {
			t.Fatalf("got rpID=%q, want zone17.click", cfg.WebAuthnRPID)
		}
	})

	t.Run("development custom port preserves exact APP_ORIGIN and localhost RP ID", func(t *testing.T) {
		setEnv(t, map[string]string{
			"APP_ENV":    "development",
			"APP_ORIGIN": "http://localhost:18070",
		})
		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.WebAuthnRPID != "localhost" || cfg.WebAuthnRPOrigin != "http://localhost:18070" {
			t.Fatalf("got rpID=%q rpOrigin=%q", cfg.WebAuthnRPID, cfg.WebAuthnRPOrigin)
		}
	})

	rejectCases := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "dev origin port mismatch rejected",
			env: map[string]string{
				"APP_ENV":            "development",
				"APP_ORIGIN":         "http://localhost:3000",
				"WEBAUTHN_RP_ORIGIN": "http://localhost:3001",
			},
		},
		{
			name: "dev origin missing port rejected when APP_ORIGIN has port",
			env: map[string]string{
				"APP_ENV":            "development",
				"APP_ORIGIN":         "http://localhost:3000",
				"WEBAUTHN_RP_ORIGIN": "http://localhost",
			},
		},
		{
			name: "dev RP ID mismatch rejected",
			env: map[string]string{
				"APP_ENV":        "development",
				"APP_ORIGIN":     "http://localhost:3000",
				"WEBAUTHN_RP_ID": "engram.zone17.click",
			},
		},
		{
			name: "dev RP ID containing port rejected",
			env: map[string]string{
				"APP_ENV":        "development",
				"APP_ORIGIN":     "http://localhost:3000",
				"WEBAUTHN_RP_ID": "localhost:3000",
			},
		},
		{
			name: "dev RP ID containing scheme rejected",
			env: map[string]string{
				"APP_ENV":        "development",
				"APP_ORIGIN":     "http://localhost:3000",
				"WEBAUTHN_RP_ID": "http://localhost",
			},
		},
		{
			name: "prod RP ID bare TLD rejected",
			env: func() map[string]string {
				m := make(map[string]string, len(prodSecrets)+1)
				for k, v := range prodSecrets {
					m[k] = v
				}
				m["WEBAUTHN_RP_ID"] = "click"
				return m
			}(),
		},
		{
			name: "prod RP ID unrelated domain rejected",
			env: func() map[string]string {
				m := make(map[string]string, len(prodSecrets)+1)
				for k, v := range prodSecrets {
					m[k] = v
				}
				m["WEBAUTHN_RP_ID"] = "evil.example.com"
				return m
			}(),
		},
		{
			name: "prod RP ID child subdomain of APP_ORIGIN rejected",
			env: func() map[string]string {
				m := make(map[string]string, len(prodSecrets)+1)
				for k, v := range prodSecrets {
					m[k] = v
				}
				m["WEBAUTHN_RP_ID"] = "sub.engram.zone17.click"
				return m
			}(),
		},
		{
			name: "prod RP origin mismatch with port rejected",
			env: func() map[string]string {
				m := make(map[string]string, len(prodSecrets)+1)
				for k, v := range prodSecrets {
					m[k] = v
				}
				m["WEBAUTHN_RP_ORIGIN"] = "https://engram.zone17.click:8443"
				return m
			}(),
		},
		{
			name: "prod localhost APP_ORIGIN rejected",
			env: func() map[string]string {
				m := make(map[string]string, len(prodSecrets))
				for k, v := range prodSecrets {
					m[k] = v
				}
				m["APP_ORIGIN"] = "https://localhost:3000"
				return m
			}(),
		},
	}

	for _, tc := range rejectCases {
		t.Run(tc.name, func(t *testing.T) {
			setEnv(t, tc.env)
			if _, err := config.Load(); err == nil {
				t.Fatalf("Load() muốn lỗi cho %s, nhận nil", tc.name)
			}
		})
	}
}

// KS-PSL (P04 Task 9, P4BE1-8): RP ID là public suffix của phần ICANN hoặc phần private của PSL bị từ chối lúc boot,
// kể cả khi origin là subdomain khớp. Mọi ca từ chối dưới đây đều boot được trước KS-PSL (RP ID bằng host hoặc là hậu
// tố của host), nên chúng chỉ đỏ nhờ kiểm PSL. Ngoại lệ tường minh duy nhất là localhost.
func TestWebAuthnRPIDPublicSuffixBoot(t *testing.T) {
	prodSecrets := map[string]string{
		"APP_ENV":            "production",
		"AUTH_JWT_SECRET":    b64(32),
		"AUTH_CSRF_SECRET":   b64(33),
		"AUTH_REAUTH_SECRET": b64(34),
		"AUTH_IP_PEPPER":     b64(35),
		"AUTH_EMAIL_PEPPER":  b64(36),
	}
	prod := func(origin, rpID string) map[string]string {
		m := make(map[string]string, len(prodSecrets)+2)
		for k, v := range prodSecrets {
			m[k] = v
		}
		m["APP_ORIGIN"] = origin
		if rpID != "" {
			m["WEBAUTHN_RP_ID"] = rpID
		}
		return m
	}
	dev := func(origin, rpID string) map[string]string {
		m := map[string]string{"APP_ENV": "development", "APP_ORIGIN": origin}
		if rpID != "" {
			m["WEBAUTHN_RP_ID"] = rpID
		}
		return m
	}

	rejectCases := []struct {
		name string
		env  map[string]string
	}{
		{"ICANN co.uk as parent of the origin host", prod("https://app.example.co.uk", "co.uk")},
		{"ICANN co.uk equal to the origin host", prod("https://co.uk", "co.uk")},
		{"ICANN co.uk derived from APP_ORIGIN", prod("https://co.uk", "")},
		{"private github.io as parent of the origin host", prod("https://zone17.github.io", "github.io")},
		{"private github.io equal to the origin host", prod("https://github.io", "github.io")},
		{"TLD click derived from a single-label dev origin", dev("http://click:3000", "")},
		{"TLD click explicit with a single-label dev origin", dev("http://click:3000", "click")},
		{"TLD click as parent of the production origin", prod("https://engram.zone17.click", "click")},
	}
	for _, tc := range rejectCases {
		t.Run("reject "+tc.name, func(t *testing.T) {
			setEnv(t, tc.env)
			if _, err := config.Load(); err == nil {
				t.Fatalf("Load() muốn lỗi public suffix cho %s, nhận nil", tc.name)
			}
		})
	}

	acceptCases := []struct {
		name   string
		env    map[string]string
		wantID string
	}{
		{"registrable zone17.click as parent of the production origin", prod("https://engram.zone17.click", "zone17.click"), "zone17.click"},
		{"production engram.zone17.click explicit (ADR 0003, user-dec-013)", prod("https://engram.zone17.click", "engram.zone17.click"), "engram.zone17.click"},
		{"production engram.zone17.click derived from APP_ORIGIN", prod("https://engram.zone17.click", ""), "engram.zone17.click"},
		{"registrable label under private github.io", prod("https://zone17.github.io", "zone17.github.io"), "zone17.github.io"},
		{"dev localhost derived from APP_ORIGIN", dev("http://localhost:3000", ""), "localhost"},
		{"dev localhost explicit", dev("http://localhost:3000", "localhost"), "localhost"},
		{"dev IP origin keeps exact-match path", dev("http://127.0.0.1:3000", ""), "127.0.0.1"},
	}
	for _, tc := range acceptCases {
		t.Run("accept "+tc.name, func(t *testing.T) {
			setEnv(t, tc.env)
			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if cfg.WebAuthnRPID != tc.wantID {
				t.Fatalf("WebAuthnRPID = %q, muốn %q", cfg.WebAuthnRPID, tc.wantID)
			}
		})
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

// AUTH_TRUSTED_PROXY_CIDRS phải được nạp thật (trước đây field unexported nên envconfig bỏ qua,
// development luôn rơi về default còn production luôn trống).
func TestTrustedProxyCIDRsLoaded(t *testing.T) {
	prod := map[string]string{
		"APP_ENV":            "production",
		"APP_ORIGIN":         "https://engram.zone17.click",
		"AUTH_JWT_SECRET":    b64(32),
		"AUTH_CSRF_SECRET":   b64(33),
		"AUTH_REAUTH_SECRET": b64(34),
		"AUTH_IP_PEPPER":     b64(35),
		"AUTH_EMAIL_PEPPER":  b64(36),
	}
	dev := map[string]string{"APP_ENV": "development"}
	with := func(base map[string]string, cidrs string) map[string]string {
		m := make(map[string]string, len(base)+1)
		for k, v := range base {
			m[k] = v
		}
		m["AUTH_TRUSTED_PROXY_CIDRS"] = cidrs
		return m
	}
	cases := []struct {
		name string
		env  map[string]string
		want []string
	}{
		{"development explicit", with(dev, "172.18.0.0/16, 172.30.17.0/24"), []string{"172.18.0.0/16", "172.30.17.0/24"}},
		{"production explicit", with(prod, "172.18.0.0/16,172.30.17.0/24"), []string{"172.18.0.0/16", "172.30.17.0/24"}},
		{"development empty keeps default", with(dev, ""), []string{"127.0.0.1/32", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}},
		{"production empty trusts none", with(prod, ""), nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setEnv(t, tc.env)
			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			got := make([]string, 0, len(cfg.TrustedProxyCIDRs))
			for _, n := range cfg.TrustedProxyCIDRs {
				got = append(got, n.String())
			}
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Fatalf("TrustedProxyCIDRs = %v, want %v", got, tc.want)
			}
		})
	}

	t.Run("explicit list replaces the development default", func(t *testing.T) {
		setEnv(t, with(dev, "172.18.0.0/16"))
		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if !cfg.TrustedProxyContains(net.ParseIP("172.18.0.254")) {
			t.Fatal("172.18.0.254 must be trusted")
		}
		if cfg.TrustedProxyContains(net.ParseIP("192.168.1.10")) {
			t.Fatal("192.168.1.10 must not be trusted when an explicit list is set")
		}
	})

	t.Run("invalid CIDR rejected", func(t *testing.T) {
		setEnv(t, with(dev, "not-a-cidr"))
		if _, err := config.Load(); err == nil {
			t.Fatal("Load() error = nil, want invalid AUTH_TRUSTED_PROXY_CIDRS error")
		}
	})
}

func TestMailCaptureAsDeliveryFailClosedAndRejectedInProduction(t *testing.T) {
	setEnv(t, nil)
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() default: %v", err)
	}
	if cfg.MailCaptureAsDelivery {
		t.Fatal("AUTH_MAIL_CAPTURE_AS_DELIVERY must default to false (fail closed)")
	}

	setEnv(t, map[string]string{
		"APP_ENV":                       "development",
		"AUTH_MAIL_CAPTURE_AS_DELIVERY": "true",
	})
	cfgDev, err := config.Load()
	if err != nil {
		t.Fatalf("Load() development with AUTH_MAIL_CAPTURE_AS_DELIVERY=true: %v", err)
	}
	if !cfgDev.MailCaptureAsDelivery {
		t.Fatal("development should allow AUTH_MAIL_CAPTURE_AS_DELIVERY=true")
	}

	for _, envName := range []string{"production", "staging"} {
		t.Run(envName, func(t *testing.T) {
			setEnv(t, map[string]string{
				"APP_ENV":                       envName,
				"APP_ORIGIN":                    "https://engram.zone17.click",
				"AUTH_MAIL_CAPTURE_AS_DELIVERY": "true",
				"AUTH_JWT_SECRET":               b64(32),
				"AUTH_CSRF_SECRET":              b64(33),
				"AUTH_REAUTH_SECRET":            b64(34),
				"AUTH_IP_PEPPER":                b64(35),
				"AUTH_EMAIL_PEPPER":             b64(36),
			})
			if _, err := config.Load(); err == nil {
				t.Fatalf("%s must refuse boot when AUTH_MAIL_CAPTURE_AS_DELIVERY=true", envName)
			}
		})
	}
}
