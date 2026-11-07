package config_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/embedding"
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
		"EXPORT_AT_REST_SECRET": b64(37),
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
		"EXPORT_AT_REST_SECRET": b64(37),
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
	if strings.Contains(dump, b64(32)) {
		t.Fatal("Redacted lộ AUTH_JWT_SECRET")
	}
	if strings.Contains(dump, "postgres://engram") {
		t.Fatal("Redacted lộ DATABASE_URL")
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
		"EXPORT_AT_REST_SECRET": b64(37),
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
		"EXPORT_AT_REST_SECRET": b64(37),
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
		"EXPORT_AT_REST_SECRET": b64(37),
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
				"EXPORT_AT_REST_SECRET":        b64(37),
			})
			if _, err := config.Load(); err == nil {
				t.Fatalf("%s must refuse boot when AUTH_MAIL_CAPTURE_AS_DELIVERY=true", envName)
			}
		})
	}
}

func TestP05EmbeddingAndSearchDefaults(t *testing.T) {
	setEnv(t, nil)
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.SearchSemanticEnabled {
		t.Error("SEARCH_SEMANTIC_ENABLED mặc định phải true")
	}
	if cfg.EmbeddingModel != "openrouter/qwen/qwen3-embedding-8b" {
		t.Errorf("EmbeddingModel = %q, muốn openrouter/qwen/qwen3-embedding-8b", cfg.EmbeddingModel)
	}
	if cfg.EmbeddingDimensions != 1024 {
		t.Errorf("EmbeddingDimensions = %d, muốn 1024", cfg.EmbeddingDimensions)
	}
	wantInstr := "Given a short search query, retrieve matching item names or tags"
	if cfg.EmbeddingQueryInstruction != wantInstr {
		t.Errorf("EmbeddingQueryInstruction = %q, muốn %q", cfg.EmbeddingQueryInstruction, wantInstr)
	}
	if cfg.EmbeddingQueryTimeout != 300*time.Millisecond {
		t.Errorf("EmbeddingQueryTimeout = %v, muốn 300ms", cfg.EmbeddingQueryTimeout)
	}
	if cfg.EmbeddingDocumentTimeout != 30*time.Second {
		t.Errorf("EmbeddingDocumentTimeout = %v, muốn 30s", cfg.EmbeddingDocumentTimeout)
	}
	if cfg.SearchExactMaxVectors != 3000 {
		t.Errorf("SearchExactMaxVectors = %d, muốn 3000", cfg.SearchExactMaxVectors)
	}
	if cfg.SearchExactFallbackMaxVectors != 3000 {
		t.Errorf("SearchExactFallbackMaxVectors = %d, muốn 3000", cfg.SearchExactFallbackMaxVectors)
	}
	if cfg.SearchHNSWEfSearch != 64 {
		t.Errorf("SearchHNSWEfSearch = %d, muốn 64", cfg.SearchHNSWEfSearch)
	}
	if cfg.SearchHNSWMaxScanTuples != 250 {
		t.Errorf("SearchHNSWMaxScanTuples = %d, muốn 250", cfg.SearchHNSWMaxScanTuples)
	}
	if cfg.SearchHNSWIterativeScan != "relaxed_order" {
		t.Errorf("SearchHNSWIterativeScan = %q, muốn relaxed_order", cfg.SearchHNSWIterativeScan)
	}
	if cfg.SearchANNRandomPageCost != 1.1 {
		t.Errorf("SearchANNRandomPageCost = %v, muốn 1.1", cfg.SearchANNRandomPageCost)
	}
	if !cfg.SearchLexicalForceCustomPlan || !cfg.LexicalForceCustomPlanEnabled() {
		t.Errorf("SearchLexicalForceCustomPlan = %v (enabled=%v), muốn true", cfg.SearchLexicalForceCustomPlan, cfg.LexicalForceCustomPlanEnabled())
	}
	if cfg.SearchVectorBranchTimeout != 80*time.Millisecond {
		t.Errorf("SearchVectorBranchTimeout = %v, muốn 80ms", cfg.SearchVectorBranchTimeout)
	}
	if cfg.SearchVectorFallbackMinBudget != 30*time.Millisecond {
		t.Errorf("SearchVectorFallbackMinBudget = %v, muốn 30ms", cfg.SearchVectorFallbackMinBudget)
	}
	if cfg.SearchRollbackWindow != 168*time.Hour {
		t.Errorf("SearchRollbackWindow = %v, muốn 168h", cfg.SearchRollbackWindow)
	}
	if cfg.WorkerMetricsAddr != "" {
		t.Errorf("WorkerMetricsAddr = %q, muốn rỗng", cfg.WorkerMetricsAddr)
	}
	if cfg.EmbeddingBootstrapFlipInterval != time.Minute {
		t.Errorf("EmbeddingBootstrapFlipInterval = %v, muốn 1m", cfg.EmbeddingBootstrapFlipInterval)
	}
	if _, ok := cfg.EmbeddingShadow(); ok {
		t.Error("EmbeddingShadow() mặc định phải false")
	}
}

func TestP05ProviderValidationAndDefaultTimeouts(t *testing.T) {
	// 1. tei thiếu TEI_URL bị từ chối.
	t.Run("tei_missing_tei_url_rejected", func(t *testing.T) {
		setEnv(t, map[string]string{
			"EMBEDDING_PROVIDER": "tei",
			"TEI_URL":            "",
		})
		if _, err := config.Load(); err == nil {
			t.Fatal("Load() phải từ chối EMBEDDING_PROVIDER=tei khi thiếu TEI_URL")
		}
	})

	// 2. tei đủ TEI_URL -> default query timeout 300ms (kể cả khi unset hoặc đặt rỗng).
	t.Run("tei_default_query_timeout_300ms_unset_and_empty", func(t *testing.T) {
		for _, rawTimeout := range []struct {
			name string
			set  bool
			val  string
		}{
			{"unset", false, ""},
			{"explicit_empty", true, ""},
			{"whitespace_only", true, "   "},
		} {
			t.Run(rawTimeout.name, func(t *testing.T) {
				env := map[string]string{
					"EMBEDDING_PROVIDER":        "tei",
					"TEI_URL":                   "http://10.0.0.5:8080",
					"TEI_INPUT_PREFIX_QUERY":    "query: ",
					"TEI_INPUT_PREFIX_DOCUMENT": "passage: ",
				}
				if rawTimeout.set {
					env["EMBEDDING_QUERY_TIMEOUT"] = rawTimeout.val
				}
				setEnv(t, env)
				cfg, err := config.Load()
				if err != nil {
					t.Fatalf("Load() error = %v", err)
				}
				if cfg.EmbeddingQueryTimeout != 300*time.Millisecond {
					t.Fatalf("EmbeddingQueryTimeout = %v, muốn 300ms", cfg.EmbeddingQueryTimeout)
				}
				prim := cfg.EmbeddingPrimary()
				if prim.Provider != "tei" || prim.BaseURL.Reveal() != "http://10.0.0.5:8080" || prim.QueryPrefix != "query: " || prim.DocPrefix != "passage: " || prim.QueryTimeout != 300*time.Millisecond {
					t.Fatalf("EmbeddingPrimary() = %+v", prim)
				}
			})
		}
	})

	// 3. openai_compat thiếu EMBEDDING_BASE_URL hoặc EMBEDDING_API_KEY bị từ chối.
	t.Run("openai_compat_missing_base_url_or_api_key_rejected", func(t *testing.T) {
		setEnv(t, map[string]string{
			"EMBEDDING_PROVIDER": "openai_compat",
			"EMBEDDING_API_KEY":  "fake-key-for-test-only",
		})
		if _, err := config.Load(); err == nil {
			t.Fatal("Load() phải từ chối openai_compat khi thiếu EMBEDDING_BASE_URL")
		}

		setEnv(t, map[string]string{
			"EMBEDDING_PROVIDER": "openai_compat",
			"EMBEDDING_BASE_URL": "http://10.0.0.5:8080/v1",
			"EMBEDDING_API_KEY":  "",
		})
		if _, err := config.Load(); err == nil {
			t.Fatal("Load() phải từ chối openai_compat khi thiếu EMBEDDING_API_KEY")
		}
	})

	// 4. openai_compat đủ -> default query timeout 4s (unset và đặt rỗng), explicit timeout thắng.
	t.Run("openai_compat_default_4s_unset_empty_and_explicit_override", func(t *testing.T) {
		for _, rawTimeout := range []struct {
			name string
			set  bool
			val  string
		}{
			{"unset", false, ""},
			{"explicit_empty", true, ""},
			{"whitespace_only", true, "  "},
		} {
			t.Run(rawTimeout.name, func(t *testing.T) {
				env := map[string]string{
					"EMBEDDING_PROVIDER": "openai_compat",
					"EMBEDDING_BASE_URL": "https://router.example.invalid/v1",
					"EMBEDDING_API_KEY":  "fake-key-for-test-only",
				}
				if rawTimeout.set {
					env["EMBEDDING_QUERY_TIMEOUT"] = rawTimeout.val
				}
				setEnv(t, env)
				cfg, err := config.Load()
				if err != nil {
					t.Fatalf("Load() error = %v", err)
				}
				if cfg.EmbeddingQueryTimeout != 4*time.Second {
					t.Fatalf("EmbeddingQueryTimeout = %v, muốn 4s", cfg.EmbeddingQueryTimeout)
				}
			})
		}

		setEnv(t, map[string]string{
			"EMBEDDING_PROVIDER":      "openai_compat",
			"EMBEDDING_BASE_URL":      "http://10.0.0.5:8080/v1",
			"EMBEDDING_API_KEY":       "fake-key-for-test-only",
			"EMBEDDING_QUERY_TIMEOUT": "1500ms",
		})
		cfgOverride, err := config.Load()
		if err != nil {
			t.Fatalf("Load() override error = %v", err)
		}
		if cfgOverride.EmbeddingQueryTimeout != 1500*time.Millisecond {
			t.Fatalf("EmbeddingQueryTimeout = %v, muốn 1.5s", cfgOverride.EmbeddingQueryTimeout)
		}
	})

	// 5. EMBEDDING_QUERY_TIMEOUT từ chối 0s, âm, sai cú pháp, quá biên (>5m hoặc <1ms).
	t.Run("primary_query_timeout_rejects_zero_negative_malformed_over_bound", func(t *testing.T) {
		for _, bad := range []string{"0s", "0", "-1ms", "-5s", "500us", "5m1s", "10m", "not-a-duration"} {
			t.Run(bad, func(t *testing.T) {
				setEnv(t, map[string]string{
					"EMBEDDING_PROVIDER":      "tei",
					"TEI_URL":                 "http://10.0.0.5:8080",
					"EMBEDDING_QUERY_TIMEOUT": bad,
				})
				if _, err := config.Load(); err == nil {
					t.Fatalf("EMBEDDING_QUERY_TIMEOUT=%q phải bị từ chối", bad)
				}
			})
		}
	})
}

func TestP05ShadowProviderRules(t *testing.T) {
	t.Run("shadow_unknown_provider_rejected", func(t *testing.T) {
		setEnv(t, map[string]string{
			"EMBEDDING_SHADOW_PROVIDER": "unknown",
		})
		if _, err := config.Load(); err == nil {
			t.Fatal("Load() phải từ chối EMBEDDING_SHADOW_PROVIDER lạ")
		}
	})

	t.Run("shadow_tei_requires_shadow_base_url", func(t *testing.T) {
		setEnv(t, map[string]string{
			"EMBEDDING_SHADOW_PROVIDER": "tei",
		})
		if _, err := config.Load(); err == nil {
			t.Fatal("Load() phải từ chối shadow tei thiếu EMBEDDING_SHADOW_BASE_URL")
		}

		for _, rawTimeout := range []struct {
			name string
			set  bool
			val  string
			want time.Duration
		}{
			{"unset", false, "", 300 * time.Millisecond},
			{"explicit_empty", true, "", 300 * time.Millisecond},
			{"positive_override", true, "450ms", 450 * time.Millisecond},
		} {
			t.Run(rawTimeout.name, func(t *testing.T) {
				env := map[string]string{
					"EMBEDDING_SHADOW_PROVIDER":              "tei",
					"EMBEDDING_SHADOW_BASE_URL":              "http://10.0.0.9:80",
					"EMBEDDING_SHADOW_INPUT_PREFIX_QUERY":    "query: ",
					"EMBEDDING_SHADOW_INPUT_PREFIX_DOCUMENT": "passage: ",
				}
				if rawTimeout.set {
					env["EMBEDDING_SHADOW_QUERY_TIMEOUT"] = rawTimeout.val
				}
				setEnv(t, env)
				cfg, err := config.Load()
				if err != nil {
					t.Fatalf("Load() error = %v", err)
				}
				sh, ok := cfg.EmbeddingShadow()
				if !ok {
					t.Fatal("EmbeddingShadow() = false, muốn true")
				}
				if sh.Provider != "tei" || sh.QueryTimeout != rawTimeout.want || sh.QueryPrefix != "query: " || sh.DocPrefix != "passage: " {
					t.Fatalf("EmbeddingShadow() = %+v, muốn QueryTimeout=%v", sh, rawTimeout.want)
				}
			})
		}
	})

	t.Run("shadow_openai_compat_requires_base_url_and_key", func(t *testing.T) {
		setEnv(t, map[string]string{
			"EMBEDDING_SHADOW_PROVIDER": "openai_compat",
			"EMBEDDING_SHADOW_BASE_URL": "https://shadow.example.invalid/v1",
		})
		if _, err := config.Load(); err == nil {
			t.Fatal("Load() phải từ chối shadow openai_compat thiếu EMBEDDING_SHADOW_API_KEY")
		}

		for _, rawTimeout := range []struct {
			name string
			set  bool
			val  string
			want time.Duration
		}{
			{"unset", false, "", 4 * time.Second},
			{"explicit_empty", true, "", 4 * time.Second},
			{"positive_override", true, "2500ms", 2500 * time.Millisecond},
		} {
			t.Run(rawTimeout.name, func(t *testing.T) {
				env := map[string]string{
					"EMBEDDING_SHADOW_PROVIDER": "openai_compat",
					"EMBEDDING_SHADOW_BASE_URL": "https://shadow.example.invalid/v1",
					"EMBEDDING_SHADOW_API_KEY":  "fake-shadow-key",
				}
				if rawTimeout.set {
					env["EMBEDDING_SHADOW_QUERY_TIMEOUT"] = rawTimeout.val
				}
				setEnv(t, env)
				cfg, err := config.Load()
				if err != nil {
					t.Fatalf("Load() error = %v", err)
				}
				sh, ok := cfg.EmbeddingShadow()
				if !ok {
					t.Fatal("EmbeddingShadow() = false, muốn true")
				}
				if sh.Provider != "openai_compat" || sh.QueryTimeout != rawTimeout.want || sh.Dims != 1024 {
					t.Fatalf("EmbeddingShadow() = %+v, muốn QueryTimeout=%v", sh, rawTimeout.want)
				}
			})
		}
	})

	t.Run("shadow_query_timeout_empty_when_disabled_and_rejects_invalid_values", func(t *testing.T) {
		setEnv(t, map[string]string{
			"EMBEDDING_SHADOW_PROVIDER":      "",
			"EMBEDDING_SHADOW_QUERY_TIMEOUT": "",
		})
		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("Load() với EMBEDDING_SHADOW_QUERY_TIMEOUT rỗng khi shadow tắt bị lỗi: %v", err)
		}
		if cfg.EmbeddingShadowQueryTimeout != 300*time.Millisecond {
			t.Fatalf("EmbeddingShadowQueryTimeout = %v, muốn 300ms", cfg.EmbeddingShadowQueryTimeout)
		}

		for _, bad := range []string{"0s", "0", "-1ms", "-10s", "500us", "5m1s", "10m", "invalid"} {
			t.Run(bad, func(t *testing.T) {
				setEnv(t, map[string]string{
					"EMBEDDING_SHADOW_PROVIDER":      "openai_compat",
					"EMBEDDING_SHADOW_BASE_URL":      "https://shadow.example.invalid/v1",
					"EMBEDDING_SHADOW_API_KEY":       "fake-shadow-key",
					"EMBEDDING_SHADOW_QUERY_TIMEOUT": bad,
				})
				if _, err := config.Load(); err == nil {
					t.Fatalf("EMBEDDING_SHADOW_QUERY_TIMEOUT=%q phải bị từ chối", bad)
				}
			})
		}
	})
}

func TestP05SearchKnobsAndBootstrapFlipIntervalValidation(t *testing.T) {
	t.Run("fallback_less_than_exact_rejected", func(t *testing.T) {
		setEnv(t, map[string]string{
			"SEARCH_EXACT_MAX_VECTORS":          "10000",
			"SEARCH_EXACT_FALLBACK_MAX_VECTORS": "5000",
		})
		if _, err := config.Load(); err == nil {
			t.Fatal("Load() phải từ chối SEARCH_EXACT_FALLBACK_MAX_VECTORS < SEARCH_EXACT_MAX_VECTORS")
		}
	})

	t.Run("iterative_scan_oneof", func(t *testing.T) {
		for _, valid := range []string{"off", "relaxed_order", "strict_order"} {
			setEnv(t, map[string]string{"SEARCH_HNSW_ITERATIVE_SCAN": valid})
			if _, err := config.Load(); err != nil {
				t.Fatalf("SEARCH_HNSW_ITERATIVE_SCAN=%s bị từ chối: %v", valid, err)
			}
		}
		setEnv(t, map[string]string{"SEARCH_HNSW_ITERATIVE_SCAN": "invalid_mode"})
		if _, err := config.Load(); err == nil {
			t.Fatal("SEARCH_HNSW_ITERATIVE_SCAN=invalid_mode phải bị từ chối")
		}
	})

	t.Run("ann_random_page_cost_bounds_and_off_switch", func(t *testing.T) {
		for _, tc := range []struct {
			raw  string
			want float64
		}{
			{"", 1.1},
			{"1.1", 1.1},
			{"0.5", 0.5},
			{"4.0", 4.0},
			{"2.25", 2.25},
			{"off", -1.0},
			{"OFF", -1.0},
			{"0", -1.0},
			{"0.0", -1.0},
		} {
			setEnv(t, map[string]string{"SEARCH_ANN_RANDOM_PAGE_COST": tc.raw})
			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("SEARCH_ANN_RANDOM_PAGE_COST=%q bị từ chối: %v", tc.raw, err)
			}
			if cfg.SearchANNRandomPageCost != tc.want {
				t.Fatalf("SEARCH_ANN_RANDOM_PAGE_COST=%q -> %v, muốn %v", tc.raw, cfg.SearchANNRandomPageCost, tc.want)
			}
		}

		for _, bad := range []string{"0.49", "4.01", "-1", "-0.5", "NaN", "Inf", "invalid", "1.1; SET role postgres"} {
			setEnv(t, map[string]string{"SEARCH_ANN_RANDOM_PAGE_COST": bad})
			if _, err := config.Load(); err == nil {
				t.Fatalf("SEARCH_ANN_RANDOM_PAGE_COST=%q phải bị từ chối", bad)
			}
		}
	})

	t.Run("lexical_force_custom_plan_parse_and_off_switch", func(t *testing.T) {
		if !new(config.Config).LexicalForceCustomPlanEnabled() {
			t.Fatal("zero-value Config.LexicalForceCustomPlanEnabled() phải mặc định true")
		}
		for _, tc := range []struct {
			raw  string
			want bool
		}{
			{"", true},
			{"on", true},
			{"ON", true},
			{"true", true},
			{"TRUE", true},
			{"1", true},
			{"  on  ", true},
			{"off", false},
			{"OFF", false},
			{"false", false},
			{"FALSE", false},
			{"0", false},
			{"  off  ", false},
		} {
			setEnv(t, map[string]string{"SEARCH_LEXICAL_FORCE_CUSTOM_PLAN": tc.raw})
			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("SEARCH_LEXICAL_FORCE_CUSTOM_PLAN=%q bị từ chối: %v", tc.raw, err)
			}
			if cfg.SearchLexicalForceCustomPlan != tc.want || cfg.LexicalForceCustomPlanEnabled() != tc.want {
				t.Fatalf("SEARCH_LEXICAL_FORCE_CUSTOM_PLAN=%q -> %v (enabled=%v), muốn %v",
					tc.raw, cfg.SearchLexicalForceCustomPlan, cfg.LexicalForceCustomPlanEnabled(), tc.want)
			}
			if got := cfg.Redacted()["search_lexical_force_custom_plan"]; got != tc.want {
				t.Fatalf("Redacted()[search_lexical_force_custom_plan]=%v, muốn %v", got, tc.want)
			}
		}

		for _, bad := range []string{"yes", "no", "2", "-1", "auto", "force_custom_plan", "force_generic_plan", "invalid", "on; SET role postgres"} {
			setEnv(t, map[string]string{"SEARCH_LEXICAL_FORCE_CUSTOM_PLAN": bad})
			if _, err := config.Load(); err == nil {
				t.Fatalf("SEARCH_LEXICAL_FORCE_CUSTOM_PLAN=%q phải bị từ chối", bad)
			}
		}
	})

	t.Run("bootstrap_flip_interval_production_rejected_dev_accepted", func(t *testing.T) {
		setEnv(t, map[string]string{
			"APP_ENV":                           "development",
			"EMBEDDING_BOOTSTRAP_FLIP_INTERVAL": "5s",
		})
		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("development phải chấp nhận EMBEDDING_BOOTSTRAP_FLIP_INTERVAL=5s: %v", err)
		}
		if cfg.EmbeddingBootstrapFlipInterval != 5*time.Second {
			t.Fatalf("EmbeddingBootstrapFlipInterval = %v, muốn 5s", cfg.EmbeddingBootstrapFlipInterval)
		}

		setEnv(t, map[string]string{
			"APP_ENV":                           "production",
			"APP_ORIGIN":                        "https://engram.zone17.click",
			"AUTH_JWT_SECRET":                   b64(32),
			"AUTH_CSRF_SECRET":                  b64(33),
			"AUTH_REAUTH_SECRET":                b64(34),
			"AUTH_IP_PEPPER":                    b64(35),
			"AUTH_EMAIL_PEPPER":                 b64(36),
			"EXPORT_AT_REST_SECRET":             b64(37),
			"EMBEDDING_BOOTSTRAP_FLIP_INTERVAL": "5s",
		})
		if _, err := config.Load(); err == nil {
			t.Fatal("production phải từ chối EMBEDDING_BOOTSTRAP_FLIP_INTERVAL khác rỗng")
		}
	})
}

func TestP05URLRuleInConfigAndSecretRedaction(t *testing.T) {
	t.Run("url_rule_rejects_public_http_accepts_private_http_and_https", func(t *testing.T) {
		setEnv(t, map[string]string{
			"EMBEDDING_PROVIDER": "openai_compat",
			"EMBEDDING_BASE_URL": "http://8.8.8.8/v1",
			"EMBEDDING_API_KEY":  "fake-key-test",
		})
		if _, err := config.Load(); err == nil {
			t.Fatal("http://8.8.8.8 phải bị từ chối")
		}

		setEnv(t, map[string]string{
			"EMBEDDING_PROVIDER": "openai_compat",
			"EMBEDDING_BASE_URL": "http://10.0.0.5:8080/v1",
			"EMBEDDING_API_KEY":  "fake-key-test",
		})
		if _, err := config.Load(); err != nil {
			t.Fatalf("http://10.0.0.5:8080/v1 phải được chấp nhận: %v", err)
		}

		setEnv(t, map[string]string{
			"EMBEDDING_PROVIDER": "openai_compat",
			"EMBEDDING_BASE_URL": "https://api.example.invalid/v1",
			"EMBEDDING_API_KEY":  "fake-key-test",
		})
		if _, err := config.Load(); err != nil {
			t.Fatalf("https://api.example.invalid/v1 phải được chấp nhận: %v", err)
		}
	})

	t.Run("redacted_and_errors_never_leak_api_key_or_full_urls", func(t *testing.T) {
		const distinctivePrimaryKey = "sk-test-distinctive-primary-secret-998877"
		const distinctiveShadowKey = "sk-test-distinctive-shadow-secret-112233"
		const primaryURL = "https://primary-router.example.invalid/v1/secret-path"
		const shadowURL = "https://shadow-router.example.invalid/v1/secret-path"
		const teiURL = "https://tei-internal.example.invalid/v1/secret-tei-path"

		setEnv(t, map[string]string{
			"EMBEDDING_PROVIDER":        "openai_compat",
			"TEI_URL":                   teiURL,
			"EMBEDDING_BASE_URL":        primaryURL,
			"EMBEDDING_API_KEY":         distinctivePrimaryKey,
			"EMBEDDING_SHADOW_PROVIDER": "openai_compat",
			"EMBEDDING_SHADOW_BASE_URL": shadowURL,
			"EMBEDDING_SHADOW_API_KEY":  distinctiveShadowKey,
		})
		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}

		redacted := cfg.Redacted()
		if redacted["embedding_api_key_set"] != true {
			t.Fatalf("embedding_api_key_set = %v, muốn true", redacted["embedding_api_key_set"])
		}
		if redacted["embedding_shadow_api_key_set"] != true {
			t.Fatalf("embedding_shadow_api_key_set = %v, muốn true", redacted["embedding_shadow_api_key_set"])
		}
		shadowClient, shadowOK := cfg.EmbeddingShadow()
		if !shadowOK {
			t.Fatal("EmbeddingShadow() = false, muốn true")
		}
		primaryClient := cfg.EmbeddingPrimary()

		if primaryClient.APIKey.Reveal() != distinctivePrimaryKey {
			t.Fatalf("primaryClient.APIKey.Reveal() = %q, muốn %q", primaryClient.APIKey.Reveal(), distinctivePrimaryKey)
		}
		if shadowClient.APIKey.Reveal() != distinctiveShadowKey {
			t.Fatalf("shadowClient.APIKey.Reveal() = %q, muốn %q", shadowClient.APIKey.Reveal(), distinctiveShadowKey)
		}
		if cfg.EmbeddingAPIKey.Reveal() != distinctivePrimaryKey || cfg.EmbeddingShadowAPIKey.Reveal() != distinctiveShadowKey {
			t.Fatal("cfg.EmbeddingAPIKey / EmbeddingShadowAPIKey Reveal() không khớp")
		}
		if cfg.TEIURL.Reveal() != teiURL || cfg.EmbeddingBaseURL.Reveal() != primaryURL || cfg.EmbeddingShadowBaseURL.Reveal() != shadowURL {
			t.Fatal("cfg.TEIURL / EmbeddingBaseURL / EmbeddingShadowBaseURL Reveal() không khớp")
		}

		cfgJSON, err := json.Marshal(cfg)
		if err != nil {
			t.Fatalf("json.Marshal(cfg) error = %v", err)
		}
		primaryJSON, err := json.Marshal(primaryClient)
		if err != nil {
			t.Fatalf("json.Marshal(primaryClient) error = %v", err)
		}
		shadowJSON, err := json.Marshal(shadowClient)
		if err != nil {
			t.Fatalf("json.Marshal(shadowClient) error = %v", err)
		}
		keyText, err := primaryClient.APIKey.MarshalText()
		if err != nil {
			t.Fatalf("APIKey.MarshalText() error = %v", err)
		}
		primaryText, err := primaryClient.MarshalText()
		if err != nil {
			t.Fatalf("primaryClient.MarshalText() error = %v", err)
		}
		shadowText, err := shadowClient.MarshalText()
		if err != nil {
			t.Fatalf("shadowClient.MarshalText() error = %v", err)
		}

		var logBuf bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&logBuf, nil))
		logger.Info("config_dump",
			slog.Any("cfg", cfg),
			slog.Any("cfg_val", *cfg),
			slog.Any("primary", primaryClient),
			slog.Any("shadow", shadowClient),
			slog.Any("primary_key", primaryClient.APIKey),
			slog.Any("shadow_key", shadowClient.APIKey),
		)

		unexportedSecretPrimary := struct{ key embedding.Secret }{key: cfg.EmbeddingAPIKey}
		unexportedSecretShadow := struct{ key embedding.Secret }{key: cfg.EmbeddingShadowAPIKey}
		unexportedEndpointTEI := struct{ ep embedding.Endpoint }{ep: cfg.TEIURL}
		unexportedEndpointPrimary := struct{ ep embedding.Endpoint }{ep: cfg.EmbeddingBaseURL}
		unexportedEndpointShadow := struct{ ep embedding.Endpoint }{ep: cfg.EmbeddingShadowBaseURL}
		unexportedCfgHolder := struct{ cfg config.Config }{cfg: *cfg}
		formattedParts := []string{
			fmt.Sprint(redacted),
			fmtMap(redacted),
			fmt.Sprintf("%v|%s|%+v|%#v", cfg, cfg, cfg, cfg),
			fmt.Sprintf("%v|%s|%+v|%#v", *cfg, *cfg, *cfg, *cfg),
			fmt.Sprintf("%v|%+v|%#v", unexportedSecretPrimary, unexportedSecretPrimary, unexportedSecretPrimary),
			fmt.Sprintf("%v|%+v|%#v", unexportedSecretShadow, unexportedSecretShadow, unexportedSecretShadow),
			fmt.Sprintf("%v|%+v|%#v", unexportedEndpointTEI, unexportedEndpointTEI, unexportedEndpointTEI),
			fmt.Sprintf("%v|%+v|%#v", unexportedEndpointPrimary, unexportedEndpointPrimary, unexportedEndpointPrimary),
			fmt.Sprintf("%v|%+v|%#v", unexportedEndpointShadow, unexportedEndpointShadow, unexportedEndpointShadow),
			fmt.Sprintf("%v|%+v|%#v", unexportedCfgHolder, unexportedCfgHolder, unexportedCfgHolder),
			fmt.Sprintf("%v|%s|%+v|%#v|%q", primaryClient, primaryClient, primaryClient, primaryClient, primaryClient),
			fmt.Sprintf("%v|%s|%+v|%#v|%q", &primaryClient, &primaryClient, &primaryClient, &primaryClient, &primaryClient),
			fmt.Sprintf("%v|%s|%+v|%#v|%q", shadowClient, shadowClient, shadowClient, shadowClient, shadowClient),
			fmt.Sprintf("%v|%s|%+v|%#v|%q", &shadowClient, &shadowClient, &shadowClient, &shadowClient, &shadowClient),
			fmt.Sprintf("%v|%s|%+v|%#v|%q|%x", primaryClient.APIKey, primaryClient.APIKey, primaryClient.APIKey, primaryClient.APIKey, primaryClient.APIKey, primaryClient.APIKey),
			fmt.Sprintf("%v|%s|%+v|%#v|%q|%x", shadowClient.APIKey, shadowClient.APIKey, shadowClient.APIKey, shadowClient.APIKey, shadowClient.APIKey, shadowClient.APIKey),
			string(primaryJSON),
			string(shadowJSON),
			string(primaryText),
			string(shadowText),
			string(keyText),
			logBuf.String(),
		}
		sentinels := []struct {
			name  string
			value string
		}{
			{name: "primary API key", value: distinctivePrimaryKey},
			{name: "shadow API key", value: distinctiveShadowKey},
			{name: "primary URL", value: primaryURL},
			{name: "shadow URL", value: shadowURL},
			{name: "TEI URL", value: teiURL},
		}
		for partIdx, part := range formattedParts {
			for _, sentinel := range sentinels {
				if strings.Contains(part, sentinel.value) {
					t.Fatalf("Formatting / JSON / slog Config / ClientConfig làm lộ sentinel %s ở formattedParts[%d]", sentinel.name, partIdx)
				}
			}
		}
		for _, sentinel := range sentinels {
			if strings.Contains(string(cfgJSON), sentinel.value) {
				t.Fatalf("json.Marshal(cfg) làm lộ sentinel %s", sentinel.name)
			}
		}
		// Trigger validation errors with the distinctive key set and verify no error contains the key.
		errCases := []map[string]string{
			{
				"EMBEDDING_PROVIDER": "openai_compat",
				"EMBEDDING_BASE_URL": "http://8.8.8.8/v1",
				"EMBEDDING_API_KEY":  distinctivePrimaryKey,
			},
			{
				"EMBEDDING_PROVIDER":   "openai_compat",
				"EMBEDDING_BASE_URL":   primaryURL,
				"EMBEDDING_API_KEY":    distinctivePrimaryKey,
				"EMBEDDING_DIMENSIONS": "9999",
			},
			{
				"EMBEDDING_PROVIDER":        "openai_compat",
				"EMBEDDING_BASE_URL":        primaryURL,
				"EMBEDDING_API_KEY":         distinctivePrimaryKey,
				"EMBEDDING_SHADOW_PROVIDER": "openai_compat",
				"EMBEDDING_SHADOW_BASE_URL": "http://8.8.8.8/v1",
				"EMBEDDING_SHADOW_API_KEY":  distinctiveShadowKey,
			},
		}
		for i, env := range errCases {
			setEnv(t, env)
			_, loadErr := config.Load()
			if loadErr == nil {
				t.Fatalf("errCase[%d]: Load() = nil, muốn lỗi", i)
			}
			errStr := loadErr.Error()
			for _, sentinel := range sentinels {
				if strings.Contains(errStr, sentinel.value) {
					t.Fatalf("errCase[%d]: lỗi Load() làm lộ sentinel %s", i, sentinel.name)
				}
			}
		}

		// Zero-value Secret and Endpoint regression: nil-pointer safe Reveal, IsEmpty, fmt, JSON, text, slog.
		var zeroSecret embedding.Secret
		var zeroEndpoint embedding.Endpoint
		if !zeroSecret.IsEmpty() || zeroSecret.Reveal() != "" {
			t.Fatalf("zero Secret: IsEmpty=%t Reveal=%q", zeroSecret.IsEmpty(), zeroSecret.Reveal())
		}
		if !zeroEndpoint.IsEmpty() || zeroEndpoint.Reveal() != "" {
			t.Fatalf("zero Endpoint: IsEmpty=%t Reveal=%q", zeroEndpoint.IsEmpty(), zeroEndpoint.Reveal())
		}
		if embedding.NewSecret("   ").Reveal() != "" || !embedding.NewSecret("   ").IsEmpty() {
			t.Fatal("whitespace Secret phải chuẩn hoá về zero Secret")
		}
		if embedding.NewEndpoint("   ").Reveal() != "" || !embedding.NewEndpoint("   ").IsEmpty() {
			t.Fatal("whitespace Endpoint phải chuẩn hoá về zero Endpoint")
		}
		if fmt.Sprintf("%v|%#v|%q", zeroSecret, zeroSecret, zeroSecret) != `[redacted]|[redacted]|"[redacted]"` {
			t.Fatalf("zero Secret fmt = %s", fmt.Sprintf("%v|%#v|%q", zeroSecret, zeroSecret, zeroSecret))
		}
		if fmt.Sprintf("%v|%#v|%q", zeroEndpoint, zeroEndpoint, zeroEndpoint) != `[redacted]|[redacted]|"[redacted]"` {
			t.Fatalf("zero Endpoint fmt = %s", fmt.Sprintf("%v|%#v|%q", zeroEndpoint, zeroEndpoint, zeroEndpoint))
		}
	})
}

func TestConfig_ExportAtRestSecretRequired(t *testing.T) {
	for _, envName := range []string{"staging", "production"} {
		t.Run(envName+"_missing_rejected", func(t *testing.T) {
			setEnv(t, map[string]string{
				"APP_ENV":               envName,
				"APP_ORIGIN":            "https://engram.zone17.click",
				"AUTH_JWT_SECRET":       b64(32),
				"AUTH_CSRF_SECRET":      b64(33),
				"AUTH_REAUTH_SECRET":    b64(34),
				"AUTH_IP_PEPPER":        b64(35),
				"AUTH_EMAIL_PEPPER":     b64(36),
				"EXPORT_AT_REST_SECRET": "",
			})
			if _, err := config.Load(); err == nil {
				t.Fatalf("%s thiếu EXPORT_AT_REST_SECRET phải báo lỗi", envName)
			}
		})

		t.Run(envName+"_short_rejected", func(t *testing.T) {
			setEnv(t, map[string]string{
				"APP_ENV":               envName,
				"APP_ORIGIN":            "https://engram.zone17.click",
				"AUTH_JWT_SECRET":       b64(32),
				"AUTH_CSRF_SECRET":      b64(33),
				"AUTH_REAUTH_SECRET":    b64(34),
				"AUTH_IP_PEPPER":        b64(35),
				"AUTH_EMAIL_PEPPER":     b64(36),
				"EXPORT_AT_REST_SECRET": base64.StdEncoding.EncodeToString([]byte("short")),
			})
			if _, err := config.Load(); err == nil {
				t.Fatalf("%s EXPORT_AT_REST_SECRET < 32B phải báo lỗi", envName)
			}
		})
	}
}

func TestConfig_ExportAtRestSecretDevConstant(t *testing.T) {
	setEnv(t, map[string]string{
		"APP_ENV":               "development",
		"EXPORT_AT_REST_SECRET": "",
	})
	cfg1, err := config.Load()
	if err != nil {
		t.Fatalf("Load() 1: %v", err)
	}
	cfg2, err := config.Load()
	if err != nil {
		t.Fatalf("Load() 2: %v", err)
	}
	if len(cfg1.ExportAtRestSecret) != 32 {
		t.Fatalf("len(ExportAtRestSecret) = %d, muốn 32", len(cfg1.ExportAtRestSecret))
	}
	if !bytes.Equal(cfg1.ExportAtRestSecret, cfg2.ExportAtRestSecret) || !bytes.Equal(cfg1.ExportAtRestSecret, config.DevExportAtRestSecret) {
		t.Fatal("development với EXPORT_AT_REST_SECRET trống phải trả cùng hằng cố định 32B qua nhiều lần Load()")
	}

	devConstB64 := base64.StdEncoding.EncodeToString(config.DevExportAtRestSecret)
	for _, envName := range []string{"staging", "production"} {
		t.Run(envName+"_rejects_dev_constant", func(t *testing.T) {
			setEnv(t, map[string]string{
				"APP_ENV":               envName,
				"APP_ORIGIN":            "https://engram.zone17.click",
				"AUTH_JWT_SECRET":       b64(32),
				"AUTH_CSRF_SECRET":      b64(33),
				"AUTH_REAUTH_SECRET":    b64(34),
				"AUTH_IP_PEPPER":        b64(35),
				"AUTH_EMAIL_PEPPER":     b64(36),
				"EXPORT_AT_REST_SECRET": devConstB64,
			})
			if _, err := config.Load(); err == nil {
				t.Fatalf("%s phải từ chối hằng development cho EXPORT_AT_REST_SECRET", envName)
			}
		})
	}
}

func TestConfig_SMTPTLSNoneRejectedInProd(t *testing.T) {
	for _, envName := range []string{"staging", "production"} {
		t.Run(envName, func(t *testing.T) {
			setEnv(t, map[string]string{
				"APP_ENV":               envName,
				"APP_ORIGIN":            "https://engram.zone17.click",
				"AUTH_JWT_SECRET":       b64(32),
				"AUTH_CSRF_SECRET":      b64(33),
				"AUTH_REAUTH_SECRET":    b64(34),
				"AUTH_IP_PEPPER":        b64(35),
				"AUTH_EMAIL_PEPPER":     b64(36),
				"EXPORT_AT_REST_SECRET": b64(37),
				"SMTP_TLS_MODE":         "none",
			})
			if _, err := config.Load(); err == nil {
				t.Fatalf("%s phải từ chối SMTP_TLS_MODE=none", envName)
			}
		})
	}

	t.Run("development_allows_smtp_tls_none_and_validates_smtp_pairs", func(t *testing.T) {
		setEnv(t, map[string]string{
			"APP_ENV":       "development",
			"SMTP_TLS_MODE": "none",
		})
		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("development SMTP_TLS_MODE=none: %v", err)
		}
		if cfg.SMTPTLSMode != "none" || cfg.ExportSpoolDir != ".data/exports" || cfg.ExportMaxSpoolBytes != 4294967296 || cfg.ExportCreatePaused {
			t.Fatalf("defaults lệch: SMTPTLSMode=%q ExportSpoolDir=%q ExportMaxSpoolBytes=%d ExportCreatePaused=%v",
				cfg.SMTPTLSMode, cfg.ExportSpoolDir, cfg.ExportMaxSpoolBytes, cfg.ExportCreatePaused)
		}

		setEnv(t, map[string]string{
			"APP_ENV":   "development",
			"SMTP_USER": "user-only",
		})
		if _, err := config.Load(); err == nil {
			t.Fatal("nửa cặp SMTP_USER/SMTP_PASSWORD phải bị từ chối")
		}

		setEnv(t, map[string]string{
			"APP_ENV":   "development",
			"SMTP_HOST": "smtp.example.invalid",
		})
		if _, err := config.Load(); err == nil {
			t.Fatal("SMTP_HOST khác rỗng nhưng thiếu SMTP_FROM phải bị từ chối")
		}

		const smtpSecret = "smtp-distinctive-password-secret-445566"
		setEnv(t, map[string]string{
			"APP_ENV":       "development",
			"SMTP_HOST":     "smtp.example.invalid",
			"SMTP_PORT":     "465",
			"SMTP_USER":     "mailer",
			"SMTP_PASSWORD": smtpSecret,
			"SMTP_FROM":     "engram <no-reply@example.invalid>",
			"SMTP_TLS_MODE": "implicit",
		})
		cfgSMTP, err := config.Load()
		if err != nil {
			t.Fatalf("Load() SMTP hợp lệ: %v", err)
		}
		if cfgSMTP.SMTPPassword.Reveal() != smtpSecret {
			t.Fatalf("SMTPPassword.Reveal() = %q", cfgSMTP.SMTPPassword.Reveal())
		}
		dump := fmtMap(cfgSMTP.Redacted()) + "|" + fmt.Sprintf("%v|%+v|%#v", cfgSMTP, *cfgSMTP, cfgSMTP)
		if strings.Contains(dump, smtpSecret) {
			t.Fatal("Redacted/String làm lộ SMTP_PASSWORD")
		}
	})
}
