// Package config đọc cấu hình từ biến môi trường và validate một lần lúc boot.
package config

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/kelseyhightower/envconfig"
)

const minSecretLen = 32

// Config là toàn bộ cấu hình runtime của API/worker/migrate.
// Không lộ secret nào được log ra ngoài: Ghi log cấu hình phải dùng Redacted().
type Config struct {
	Env               string        `envconfig:"APP_ENV" default:"development" validate:"oneof=development staging production"`
	HTTPAddr          string        `envconfig:"HTTP_ADDR" default:"127.0.0.1:8080" validate:"required,hostname_port"`
	DatabaseURL       string        `envconfig:"DATABASE_URL" required:"true" validate:"required,startswith=postgres"`
	AppOrigin         string        `envconfig:"APP_ORIGIN" default:"http://localhost:3000" validate:"required,url"`
	EmbeddingProvider string        `envconfig:"EMBEDDING_PROVIDER" default:"noop" validate:"oneof=noop tei"`
	TEIURL            string        `envconfig:"TEI_URL" validate:"omitempty,url"`
	LogLevel          string        `envconfig:"LOG_LEVEL" default:"info" validate:"oneof=debug info warn error"`
	ShutdownTimeout   time.Duration `envconfig:"SHUTDOWN_TIMEOUT" default:"15s" validate:"required"`

	AuthJWTSecret    []byte `ignored:"true"`
	AuthCSRFSecret   []byte `ignored:"true"`
	AuthReauthSecret []byte `ignored:"true"`
	AuthIPPepper     []byte `ignored:"true"`
	AuthEmailPepper  []byte `ignored:"true"`

	RequireEmailVerification bool `envconfig:"AUTH_REQUIRE_EMAIL_VERIFICATION" default:"false"`
	GoogleReauthEnabled      bool `envconfig:"AUTH_GOOGLE_REAUTH_ENABLED" default:"false"`
	FakeOAuth                bool `envconfig:"AUTH_FAKE_OAUTH" default:"false"`
	AuditRetentionDays       int  `envconfig:"AUTH_AUDIT_RETENTION_DAYS" default:"90"`

	KeyMutationsDisabled    bool   `envconfig:"VAULT_KEY_MUTATIONS_DISABLED" default:"false"`
	WebAuthnRPID            string `envconfig:"WEBAUTHN_RP_ID"`
	WebAuthnRPOrigin        string `envconfig:"WEBAUTHN_RP_ORIGIN"`
	OAuthGoogleClientID     string `envconfig:"OAUTH_GOOGLE_CLIENT_ID"`
	OAuthGoogleClientSecret string `envconfig:"OAUTH_GOOGLE_CLIENT_SECRET"`
	OAuthGitHubClientID     string `envconfig:"OAUTH_GITHUB_CLIENT_ID"`
	OAuthGitHubClientSecret string `envconfig:"OAUTH_GITHUB_CLIENT_SECRET"`

	TurnstileSiteKey string `envconfig:"TURNSTILE_SITE_KEY"`
	TurnstileSecret  string `envconfig:"TURNSTILE_SECRET"`

	MailSinkDir string `envconfig:"AUTH_MAIL_SINK_DIR"`

	TrustedProxyCIDRs []net.IPNet `ignored:"true"`

	// EphemeralSecrets là true khi development/test tự sinh key vì env trống.
	EphemeralSecrets bool `ignored:"true"`

	rawJWT    string `ignored:"true"`
	rawCSRF   string `ignored:"true"`
	rawReauth string `ignored:"true"`
	rawIP     string `ignored:"true"`
	rawEmail  string `ignored:"true"`
	rawCIDRs  string `ignored:"true"`
}

type secretEnv struct {
	AuthJWTSecret    string `envconfig:"AUTH_JWT_SECRET"`
	AuthCSRFSecret   string `envconfig:"AUTH_CSRF_SECRET"`
	AuthReauthSecret string `envconfig:"AUTH_REAUTH_SECRET"`
	AuthIPPepper     string `envconfig:"AUTH_IP_PEPPER"`
	AuthEmailPepper  string `envconfig:"AUTH_EMAIL_PEPPER"`
}

// proxyEnv đọc AUTH_TRUSTED_PROXY_CIDRS qua field exported: envconfig bỏ qua field
// unexported, nên tag trên Config.rawCIDRs trước đây không bao giờ được nạp.
type proxyEnv struct {
	TrustedProxyCIDRs string `envconfig:"AUTH_TRUSTED_PROXY_CIDRS"`
}

// Load đọc env, áp default rồi validate. Lỗi cấu hình phải làm process chết ngay
// thay vì chạy tiếp với giá trị nửa vời.
func Load() (*Config, error) {
	var cfg Config
	if err := envconfig.Process("", &cfg); err != nil {
		return nil, fmt.Errorf("đọc env: %w", err)
	}
	if err := validator.New().Struct(&cfg); err != nil {
		return nil, fmt.Errorf("cấu hình không hợp lệ: %w", err)
	}

	var secrets secretEnv
	if err := envconfig.Process("", &secrets); err != nil {
		return nil, fmt.Errorf("đọc secret env: %w", err)
	}
	cfg.rawJWT = secrets.AuthJWTSecret
	cfg.rawCSRF = secrets.AuthCSRFSecret
	cfg.rawReauth = secrets.AuthReauthSecret
	cfg.rawIP = secrets.AuthIPPepper
	cfg.rawEmail = secrets.AuthEmailPepper

	var proxies proxyEnv
	if err := envconfig.Process("", &proxies); err != nil {
		return nil, fmt.Errorf("đọc proxy env: %w", err)
	}
	cfg.rawCIDRs = proxies.TrustedProxyCIDRs

	if err := cfg.loadSecrets(); err != nil {
		return nil, err
	}
	if err := cfg.loadTrustedProxies(); err != nil {
		return nil, err
	}
	if err := cfg.validateAuthPolicy(); err != nil {
		return nil, err
	}
	if err := cfg.validateWebAuthnPolicy(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) loadSecrets() error {
	strict := c.Env == "production" || c.Env == "staging"
	names := []struct {
		raw  string
		name string
		dst  *[]byte
	}{
		{c.rawJWT, "AUTH_JWT_SECRET", &c.AuthJWTSecret},
		{c.rawCSRF, "AUTH_CSRF_SECRET", &c.AuthCSRFSecret},
		{c.rawReauth, "AUTH_REAUTH_SECRET", &c.AuthReauthSecret},
		{c.rawIP, "AUTH_IP_PEPPER", &c.AuthIPPepper},
		{c.rawEmail, "AUTH_EMAIL_PEPPER", &c.AuthEmailPepper},
	}
	for _, s := range names {
		b, ephemeral, err := decodeOrGenerate(s.name, s.raw, strict)
		if err != nil {
			return err
		}
		*s.dst = b
		if ephemeral {
			c.EphemeralSecrets = true
		}
	}
	if bytesEqual(c.AuthJWTSecret, c.AuthCSRFSecret) ||
		bytesEqual(c.AuthJWTSecret, c.AuthReauthSecret) ||
		bytesEqual(c.AuthCSRFSecret, c.AuthReauthSecret) ||
		bytesEqual(c.AuthIPPepper, c.AuthEmailPepper) {
		return fmt.Errorf("các secret auth phải độc lập, không dùng chung key")
	}
	return nil
}

func decodeOrGenerate(name, raw string, strict bool) ([]byte, bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		if strict {
			return nil, false, fmt.Errorf("%s là bắt buộc", name)
		}
		b := make([]byte, minSecretLen)
		if _, err := rand.Read(b); err != nil {
			return nil, false, fmt.Errorf("sinh %s: %w", name, err)
		}
		return b, true, nil
	}
	b, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		b, err = base64.RawStdEncoding.DecodeString(raw)
	}
	if err != nil {
		return nil, false, fmt.Errorf("%s không phải base64 hợp lệ", name)
	}
	if len(b) < minSecretLen {
		return nil, false, fmt.Errorf("%s phải giải mã tối thiểu %d byte", name, minSecretLen)
	}
	return b, false, nil
}

func (c *Config) loadTrustedProxies() error {
	raw := strings.TrimSpace(c.rawCIDRs)
	if raw == "" && c.Env == "development" {
		raw = "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
	}
	if raw == "" {
		return nil
	}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		_, n, err := net.ParseCIDR(part)
		if err != nil {
			return fmt.Errorf("AUTH_TRUSTED_PROXY_CIDRS không hợp lệ")
		}
		c.TrustedProxyCIDRs = append(c.TrustedProxyCIDRs, *n)
	}
	return nil
}

func (c *Config) validateAuthPolicy() error {
	if c.AuditRetentionDays < 1 {
		return fmt.Errorf("AUTH_AUDIT_RETENTION_DAYS phải >= 1")
	}
	if err := requirePair("OAUTH_GOOGLE_CLIENT_ID", "OAUTH_GOOGLE_CLIENT_SECRET", c.OAuthGoogleClientID, c.OAuthGoogleClientSecret); err != nil {
		return err
	}
	if err := requirePair("OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET", c.OAuthGitHubClientID, c.OAuthGitHubClientSecret); err != nil {
		return err
	}
	if err := requirePair("TURNSTILE_SITE_KEY", "TURNSTILE_SECRET", c.TurnstileSiteKey, c.TurnstileSecret); err != nil {
		return err
	}
	if c.Env == "production" || c.Env == "staging" {
		u, err := url.Parse(c.AppOrigin)
		if err != nil || u.Scheme != "https" {
			return fmt.Errorf("APP_ORIGIN ở %s phải là HTTPS", c.Env)
		}
		if c.MailSinkDir != "" {
			return fmt.Errorf("AUTH_MAIL_SINK_DIR không dùng được ở %s", c.Env)
		}
	}
	if c.GoogleReauthEnabled && !c.GoogleLoginEnabled() && !c.FakeOAuth {
		return fmt.Errorf("AUTH_GOOGLE_REAUTH_ENABLED cần đủ cặp OAuth Google")
	}
	if c.FakeOAuth {
		if c.Env == "production" || c.Env == "staging" {
			return fmt.Errorf("AUTH_FAKE_OAUTH không dùng được ở %s", c.Env)
		}
		if c.GoogleLoginEnabled() || c.GitHubLoginEnabled() {
			return fmt.Errorf("AUTH_FAKE_OAUTH không kết hợp credential Google/GitHub")
		}
	}
	return nil
}

func (c *Config) validateWebAuthnPolicy() error {
	rawAppOrigin := strings.TrimRight(strings.TrimSpace(c.AppOrigin), "/")
	appURL, err := parseStrictOrigin(rawAppOrigin)
	if err != nil {
		return fmt.Errorf("APP_ORIGIN không hợp lệ cho WebAuthn: %w", err)
	}
	canonicalAppOrigin := appURL.Scheme + "://" + strings.ToLower(appURL.Host)
	originHost := strings.ToLower(appURL.Hostname())

	if c.Env == "production" || c.Env == "staging" {
		if originHost == "localhost" || net.ParseIP(originHost) != nil || strings.Count(originHost, ".") < 1 {
			return fmt.Errorf("APP_ORIGIN ở %s không được dùng localhost hoặc IP cho WebAuthn", c.Env)
		}
	}

	rawRPOrigin := strings.TrimRight(strings.TrimSpace(c.WebAuthnRPOrigin), "/")
	if rawRPOrigin == "" {
		rawRPOrigin = canonicalAppOrigin
	} else {
		rpURL, err := parseStrictOrigin(rawRPOrigin)
		if err != nil {
			return fmt.Errorf("WEBAUTHN_RP_ORIGIN không hợp lệ: %w", err)
		}
		rawRPOrigin = rpURL.Scheme + "://" + strings.ToLower(rpURL.Host)
	}
	if rawRPOrigin != canonicalAppOrigin {
		return fmt.Errorf("WEBAUTHN_RP_ORIGIN (%s) phải khớp chính xác APP_ORIGIN (%s)", rawRPOrigin, canonicalAppOrigin)
	}

	rpID := strings.ToLower(strings.TrimSpace(c.WebAuthnRPID))
	if rpID == "" {
		rpID = originHost
	}
	if !isValidRPIDHost(rpID) {
		return fmt.Errorf("WEBAUTHN_RP_ID (%q) không hợp lệ", c.WebAuthnRPID)
	}
	if !isRPIDMatchOrRegistrableSuffix(rpID, originHost) {
		return fmt.Errorf("WEBAUTHN_RP_ID (%q) không khớp với host của APP_ORIGIN (%q)", rpID, originHost)
	}

	c.WebAuthnRPID = rpID
	c.WebAuthnRPOrigin = rawRPOrigin
	return nil
}

func parseStrictOrigin(raw string) (*url.URL, error) {
	if raw == "" {
		return nil, fmt.Errorf("origin rỗng")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("scheme phải là http hoặc https")
	}
	if u.Host == "" || u.Hostname() == "" || u.User != nil {
		return nil, fmt.Errorf("thiếu host hợp lệ")
	}
	if strings.HasSuffix(u.Host, ":") {
		return nil, fmt.Errorf("port rỗng")
	}
	if u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.Contains(raw, "?") || strings.Contains(raw, "#") {
		return nil, fmt.Errorf("origin không được chứa path, query hoặc fragment")
	}
	return u, nil
}

func isValidRPIDHost(rpID string) bool {
	if rpID == "" {
		return false
	}
	if net.ParseIP(rpID) != nil {
		return true
	}
	if strings.ContainsAny(rpID, ":/?#@ \t\r\n") {
		return false
	}
	if strings.HasPrefix(rpID, ".") || strings.HasSuffix(rpID, ".") || strings.Contains(rpID, "..") {
		return false
	}
	labels := strings.Split(rpID, ".")
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 {
			return false
		}
		if label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for i := range len(label) {
			ch := label[i]
			isLower := ch >= 'a' && ch <= 'z'
			isDigit := ch >= '0' && ch <= '9'
			if !isLower && !isDigit && ch != '-' {
				return false
			}
		}
	}
	return true
}

func isRPIDMatchOrRegistrableSuffix(rpID, originHost string) bool {
	if rpID == originHost {
		return true
	}
	if net.ParseIP(originHost) != nil || net.ParseIP(rpID) != nil {
		return false
	}
	if strings.Count(rpID, ".") < 1 {
		return false
	}
	return strings.HasSuffix(originHost, "."+rpID)
}

func requirePair(aName, bName, a, b string) error {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	if (a == "") != (b == "") {
		return fmt.Errorf("%s và %s phải cùng có hoặc cùng trống", aName, bName)
	}
	return nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// SemanticAvailable cho biết tìm kiếm ngữ nghĩa có thật sự dùng được không.
func (c *Config) SemanticAvailable() bool {
	return c.EmbeddingProvider == "tei" && c.TEIURL != ""
}

func (c *Config) GoogleLoginEnabled() bool {
	return strings.TrimSpace(c.OAuthGoogleClientID) != ""
}

func (c *Config) GitHubLoginEnabled() bool {
	return strings.TrimSpace(c.OAuthGitHubClientID) != ""
}

// OAuthProviders always returns a non-nil slice: OpenAPI marks oauth_providers as a required,
// non-nullable array, and a nil slice would serialise to JSON null.
func (c *Config) OAuthProviders() []string {
	if c.FakeOAuth {
		return []string{"google", "github"}
	}
	out := []string{}
	if c.GoogleLoginEnabled() {
		out = append(out, "google")
	}
	if c.GitHubLoginEnabled() {
		out = append(out, "github")
	}
	return out
}

// OAuthReauthProviders always returns a non-nil slice for the same reason as OAuthProviders.
func (c *Config) OAuthReauthProviders() []string {
	if c.FakeOAuth {
		return []string{"google"}
	}
	if c.GoogleReauthEnabled && c.GoogleLoginEnabled() {
		return []string{"google"}
	}
	return []string{}
}

func (c *Config) TurnstileEnabled() bool {
	return strings.TrimSpace(c.TurnstileSiteKey) != ""
}

func (c *Config) CaptchaSiteKey() *string {
	if !c.TurnstileEnabled() {
		return nil
	}
	k := c.TurnstileSiteKey
	return &k
}

// OAuthCallbackURL xây từ APP_ORIGIN cố định, không từ Host header.
func (c *Config) OAuthCallbackURL(provider string) string {
	return strings.TrimRight(c.AppOrigin, "/") + "/api/v1/auth/oauth/" + provider + "/callback"
}

func (c *Config) JWTIssuer() string {
	return strings.TrimRight(c.AppOrigin, "/")
}

func (c *Config) JWTAudience() string {
	return strings.TrimRight(c.AppOrigin, "/")
}

// EffectiveMailSinkDir trả thư mục mail sink hiệu lực:
// dùng MailSinkDir nếu đã cấu hình; ngược lại ở môi trường development (hoặc rỗng)
// dùng mặc định `.data/mail-sink`; các môi trường khác trả chuỗi rỗng.
func (c *Config) EffectiveMailSinkDir() string {
	if c == nil {
		return ""
	}
	if c.MailSinkDir != "" {
		return c.MailSinkDir
	}
	if c.Env == "development" || c.Env == "" {
		return filepath.Join(".data", "mail-sink")
	}
	return ""
}

// EffectiveWebAuthnRPID trả về RP ID đã cấu hình hoặc tự suy từ host của APP_ORIGIN.
func (c *Config) EffectiveWebAuthnRPID() string {
	if c == nil {
		return ""
	}
	if rpID := strings.ToLower(strings.TrimSpace(c.WebAuthnRPID)); rpID != "" {
		return rpID
	}
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(c.AppOrigin), "/"))
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// EffectiveWebAuthnRPOrigin trả về RP origin đã cấu hình hoặc chuẩn hoá từ APP_ORIGIN.
func (c *Config) EffectiveWebAuthnRPOrigin() string {
	if c == nil {
		return ""
	}
	if rpOrigin := strings.TrimRight(strings.TrimSpace(c.WebAuthnRPOrigin), "/"); rpOrigin != "" {
		return rpOrigin
	}
	return strings.TrimRight(strings.TrimSpace(c.AppOrigin), "/")
}

func (c *Config) TrustedProxyContains(ip net.IP) bool {
	for _, n := range c.TrustedProxyCIDRs {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// Redacted trả bản sao an toàn để log: che chuỗi kết nối DB và mọi secret.
func (c *Config) Redacted() map[string]any {
	return map[string]any{
		"env":                             c.Env,
		"http_addr":                       c.HTTPAddr,
		"app_origin":                      c.AppOrigin,
		"embedding_provider":              c.EmbeddingProvider,
		"semantic_available":              c.SemanticAvailable(),
		"log_level":                       c.LogLevel,
		"database_url":                    "[redacted]",
		"auth_require_email_verification": c.RequireEmailVerification,
		"auth_google_reauth_enabled":      c.GoogleReauthEnabled,
		"oauth_google":                    c.GoogleLoginEnabled(),
		"oauth_github":                    c.GitHubLoginEnabled(),
		"auth_fake_oauth":                 c.FakeOAuth,
		"turnstile":                       c.TurnstileEnabled(),
		"mail_sink_configured":            c.MailSinkDir != "",
		"ephemeral_secrets":               c.EphemeralSecrets,
		"audit_retention_days":            c.AuditRetentionDays,
		"trusted_proxy_cidrs":             len(c.TrustedProxyCIDRs),
		"vault_key_mutations_disabled":    c.KeyMutationsDisabled,
		"webauthn_rp_id":                  c.WebAuthnRPID,
		"webauthn_rp_origin":              c.WebAuthnRPOrigin,
	}
}
