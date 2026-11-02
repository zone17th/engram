// Package config đọc cấu hình từ biến môi trường và validate một lần lúc boot.
package config

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/kelseyhightower/envconfig"
	"golang.org/x/net/publicsuffix"

	"github.com/zone17th/engram/apps/api/internal/embedding"
)

const minSecretLen = 32

// Config là toàn bộ cấu hình runtime của API/worker/migrate.
// Không lộ secret nào được log ra ngoài: Ghi log cấu hình phải dùng Redacted().
type Config struct {
	Env                       string             `envconfig:"APP_ENV" default:"development" validate:"oneof=development staging production"`
	HTTPAddr                  string             `envconfig:"HTTP_ADDR" default:"127.0.0.1:8080" validate:"required,hostname_port"`
	DatabaseURL               string             `envconfig:"DATABASE_URL" required:"true" validate:"required,startswith=postgres"`
	AppOrigin                 string             `envconfig:"APP_ORIGIN" default:"http://localhost:3000" validate:"required,url"`
	EmbeddingProvider         string             `envconfig:"EMBEDDING_PROVIDER" default:"noop" validate:"oneof=noop tei openai_compat"`
	TEIURL                    embedding.Endpoint `ignored:"true"`
	TEIInputPrefixQuery       string             `envconfig:"TEI_INPUT_PREFIX_QUERY"`
	TEIInputPrefixDocument    string             `envconfig:"TEI_INPUT_PREFIX_DOCUMENT"`
	EmbeddingBaseURL          embedding.Endpoint `ignored:"true"`
	EmbeddingAPIKey           embedding.Secret   `ignored:"true"`
	EmbeddingModel            string             `envconfig:"EMBEDDING_MODEL" default:"openrouter/qwen/qwen3-embedding-8b"`
	EmbeddingDimensions       int                `envconfig:"EMBEDDING_DIMENSIONS" default:"1024" validate:"min=1,max=2000"`
	EmbeddingQueryInstruction string             `envconfig:"EMBEDDING_QUERY_INSTRUCTION" default:"Given a short search query, retrieve matching item names or tags"`
	EmbeddingQueryTimeout     time.Duration      `ignored:"true"`
	EmbeddingDocumentTimeout  time.Duration      `envconfig:"EMBEDDING_DOCUMENT_TIMEOUT" default:"30s"`

	// Bộ cấu hình client thứ hai cho cutover generation (SPEC §4.4, §6.6, plan P05 mục 2.13):
	//   - EMBEDDING_SHADOW_PROVIDER (rỗng = tắt; hoặc noop|tei|openai_compat)
	//   - EMBEDDING_SHADOW_BASE_URL (với shadow tei đây là TEI URL của shadow)
	//   - EMBEDDING_SHADOW_API_KEY (secret, bắt buộc khi shadow là openai_compat)
	//   - EMBEDDING_SHADOW_MODEL (mặc định openrouter/qwen/qwen3-embedding-8b)
	//   - EMBEDDING_SHADOW_DIMENSIONS (mặc định 1024, 1..2000)
	//   - EMBEDDING_SHADOW_QUERY_INSTRUCTION (mặc định Given a short search query, retrieve matching item names or tags)
	//   - EMBEDDING_SHADOW_QUERY_TIMEOUT (rỗng -> 300ms cho tei, 4s cho openai_compat)
	//   - EMBEDDING_SHADOW_DOCUMENT_TIMEOUT (mặc định 30s)
	//   - EMBEDDING_SHADOW_INPUT_PREFIX_QUERY
	//   - EMBEDDING_SHADOW_INPUT_PREFIX_DOCUMENT
	EmbeddingShadowProvider         string             `envconfig:"EMBEDDING_SHADOW_PROVIDER" validate:"omitempty,oneof=noop tei openai_compat"`
	EmbeddingShadowBaseURL          embedding.Endpoint `ignored:"true"`
	EmbeddingShadowAPIKey           embedding.Secret   `ignored:"true"`
	EmbeddingShadowModel            string             `envconfig:"EMBEDDING_SHADOW_MODEL" default:"openrouter/qwen/qwen3-embedding-8b"`
	EmbeddingShadowDimensions       int                `envconfig:"EMBEDDING_SHADOW_DIMENSIONS" default:"1024" validate:"min=1,max=2000"`
	EmbeddingShadowQueryInstruction string             `envconfig:"EMBEDDING_SHADOW_QUERY_INSTRUCTION" default:"Given a short search query, retrieve matching item names or tags"`
	EmbeddingShadowQueryTimeout     time.Duration      `ignored:"true"`
	EmbeddingShadowDocumentTimeout  time.Duration      `envconfig:"EMBEDDING_SHADOW_DOCUMENT_TIMEOUT" default:"30s"`
	EmbeddingShadowInputPrefixQuery string             `envconfig:"EMBEDDING_SHADOW_INPUT_PREFIX_QUERY"`
	EmbeddingShadowInputPrefixDoc   string             `envconfig:"EMBEDDING_SHADOW_INPUT_PREFIX_DOCUMENT"`

	// Các knob tìm kiếm P05 (SPEC §4.4, §6.3, §6.4, §6.6, plan P05 mục 2.13).
	SearchSemanticEnabled         bool          `envconfig:"SEARCH_SEMANTIC_ENABLED" default:"true"`
	SearchExactMaxVectors         int           `envconfig:"SEARCH_EXACT_MAX_VECTORS" default:"5000" validate:"min=0,max=1000000"`
	SearchExactFallbackMaxVectors int           `envconfig:"SEARCH_EXACT_FALLBACK_MAX_VECTORS" default:"20000" validate:"min=0,max=1000000"`
	SearchHNSWEfSearch            int           `envconfig:"SEARCH_HNSW_EF_SEARCH" default:"64" validate:"min=1,max=2000"`
	SearchHNSWMaxScanTuples       int           `envconfig:"SEARCH_HNSW_MAX_SCAN_TUPLES" default:"20000" validate:"min=1,max=1000000"`
	SearchHNSWIterativeScan       string        `envconfig:"SEARCH_HNSW_ITERATIVE_SCAN" default:"relaxed_order" validate:"oneof=off relaxed_order strict_order"`
	SearchVectorBranchTimeout     time.Duration `envconfig:"SEARCH_VECTOR_BRANCH_TIMEOUT" default:"80ms"`
	SearchVectorFallbackMinBudget time.Duration `envconfig:"SEARCH_VECTOR_FALLBACK_MIN_BUDGET" default:"30ms"`
	SearchRollbackWindow          time.Duration `envconfig:"SEARCH_ROLLBACK_WINDOW" default:"168h"`
	WorkerMetricsAddr             string        `envconfig:"WORKER_METRICS_ADDR" validate:"omitempty,hostname_port"`
	// EmbeddingBootstrapFlipInterval là chu kỳ job periodic embedding_bootstrap_flip
	// (mặc định 1m khi env rỗng; chỉ cho phép đặt khác rỗng ngoài production — M3).
	EmbeddingBootstrapFlipInterval time.Duration `ignored:"true"`
	LogLevel                       string        `envconfig:"LOG_LEVEL" default:"info" validate:"oneof=debug info warn error"`
	ShutdownTimeout                time.Duration `envconfig:"SHUTDOWN_TIMEOUT" default:"15s" validate:"required"`

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

	MailSinkDir           string `envconfig:"AUTH_MAIL_SINK_DIR"`
	MailCaptureAsDelivery bool   `envconfig:"AUTH_MAIL_CAPTURE_AS_DELIVERY" default:"false"`

	TrustedProxyCIDRs []net.IPNet `ignored:"true"`

	// EphemeralSecrets là true khi development/test tự sinh key vì env trống.
	EphemeralSecrets bool `ignored:"true"`

	rawJWT                         string           `ignored:"true"`
	rawCSRF                        string           `ignored:"true"`
	rawReauth                      string           `ignored:"true"`
	rawIP                          string           `ignored:"true"`
	rawEmail                       string           `ignored:"true"`
	rawCIDRs                       string           `ignored:"true"`
	rawEmbeddingAPIKey             embedding.Secret `ignored:"true"`
	rawEmbeddingShadowAPIKey       embedding.Secret `ignored:"true"`
	rawBootstrapFlipInterval       string           `ignored:"true"`
	rawEmbeddingQueryTimeout       string           `ignored:"true"`
	rawEmbeddingShadowQueryTimeout string           `ignored:"true"`
}

type secretEnv struct {
	AuthJWTSecret          string `envconfig:"AUTH_JWT_SECRET"`
	AuthCSRFSecret         string `envconfig:"AUTH_CSRF_SECRET"`
	AuthReauthSecret       string `envconfig:"AUTH_REAUTH_SECRET"`
	AuthIPPepper           string `envconfig:"AUTH_IP_PEPPER"`
	AuthEmailPepper        string `envconfig:"AUTH_EMAIL_PEPPER"`
	EmbeddingAPIKey        string `envconfig:"EMBEDDING_API_KEY"`
	EmbeddingShadowAPIKey  string `envconfig:"EMBEDDING_SHADOW_API_KEY"`
	TEIURL                 string `envconfig:"TEI_URL"`
	EmbeddingBaseURL       string `envconfig:"EMBEDDING_BASE_URL"`
	EmbeddingShadowBaseURL string `envconfig:"EMBEDDING_SHADOW_BASE_URL"`
}

// proxyEnv đọc AUTH_TRUSTED_PROXY_CIDRS qua field exported: envconfig bỏ qua field
// unexported, nên tag trên Config.rawCIDRs trước đây không bao giờ được nạp.
type proxyEnv struct {
	TrustedProxyCIDRs           string `envconfig:"AUTH_TRUSTED_PROXY_CIDRS"`
	BootstrapFlipInterval       string `envconfig:"EMBEDDING_BOOTSTRAP_FLIP_INTERVAL"`
	EmbeddingQueryTimeout       string `envconfig:"EMBEDDING_QUERY_TIMEOUT"`
	EmbeddingShadowQueryTimeout string `envconfig:"EMBEDDING_SHADOW_QUERY_TIMEOUT"`
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
	cfg.rawEmbeddingAPIKey = embedding.NewSecret(secrets.EmbeddingAPIKey)
	cfg.rawEmbeddingShadowAPIKey = embedding.NewSecret(secrets.EmbeddingShadowAPIKey)
	cfg.EmbeddingAPIKey = cfg.rawEmbeddingAPIKey
	cfg.EmbeddingShadowAPIKey = cfg.rawEmbeddingShadowAPIKey
	cfg.TEIURL = embedding.NewEndpoint(secrets.TEIURL)
	cfg.EmbeddingBaseURL = embedding.NewEndpoint(secrets.EmbeddingBaseURL)
	cfg.EmbeddingShadowBaseURL = embedding.NewEndpoint(secrets.EmbeddingShadowBaseURL)

	var proxies proxyEnv
	if err := envconfig.Process("", &proxies); err != nil {
		return nil, fmt.Errorf("đọc proxy env: %w", err)
	}
	cfg.rawCIDRs = proxies.TrustedProxyCIDRs
	cfg.rawBootstrapFlipInterval = strings.TrimSpace(proxies.BootstrapFlipInterval)
	cfg.rawEmbeddingQueryTimeout = strings.TrimSpace(proxies.EmbeddingQueryTimeout)
	cfg.rawEmbeddingShadowQueryTimeout = strings.TrimSpace(proxies.EmbeddingShadowQueryTimeout)

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
	if err := cfg.validateP05Policy(); err != nil {
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
		if c.MailCaptureAsDelivery {
			return fmt.Errorf("AUTH_MAIL_CAPTURE_AS_DELIVERY không dùng được ở %s", c.Env)
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
		return fmt.Errorf("WEBAUTHN_RP_ID (%q) không khớp với host của APP_ORIGIN (%q) hoặc là public suffix", rpID, originHost)
	}

	c.WebAuthnRPID = rpID
	c.WebAuthnRPOrigin = rawRPOrigin
	return nil
}

// validateP05Policy kiểm tra cấu hình provider embedding (primary + shadow), URL
// rule và các biên của knob tìm kiếm P05 (plan P05 mục 2.13, SPEC §4.4).
//
// Các biên dương cho knob P05:
//   - SEARCH_HNSW_EF_SEARCH: 1..2000 (mặc định 64)
//   - SEARCH_HNSW_MAX_SCAN_TUPLES: 1..1000000 (mặc định 20000)
//   - EMBEDDING_QUERY_TIMEOUT / SHADOW: 1ms..5m (mặc định 300ms cho tei, 4s cho openai_compat)
//   - EMBEDDING_DOCUMENT_TIMEOUT / SHADOW: 1ms..10m (mặc định 30s)
//   - SEARCH_VECTOR_BRANCH_TIMEOUT: 1ms..30s (mặc định 80ms)
//   - SEARCH_VECTOR_FALLBACK_MIN_BUDGET: 1ms..30s và <= SEARCH_VECTOR_BRANCH_TIMEOUT (mặc định 30ms)
//   - SEARCH_ROLLBACK_WINDOW: 1m..8760h (mặc định 168h)
//   - EMBEDDING_BOOTSTRAP_FLIP_INTERVAL: rỗng -> 1m; khác rỗng ở production bị từ chối (M3), ngoài production phải >= 100ms
func (c *Config) validateP05Policy() error {
	c.EmbeddingShadowProvider = strings.TrimSpace(c.EmbeddingShadowProvider)
	c.WorkerMetricsAddr = strings.TrimSpace(c.WorkerMetricsAddr)

	// Kiểm tra URL rule trên cả 3 biến URL nếu có đặt (kể cả khi provider hiện tại là noop).
	if !c.TEIURL.IsEmpty() {
		if err := embedding.CheckURL(c.TEIURL.Reveal()); err != nil {
			return fmt.Errorf("TEI_URL không hợp lệ: %w", err)
		}
	}
	if !c.EmbeddingBaseURL.IsEmpty() {
		if err := embedding.CheckURL(c.EmbeddingBaseURL.Reveal()); err != nil {
			return fmt.Errorf("EMBEDDING_BASE_URL không hợp lệ: %w", err)
		}
	}
	if !c.EmbeddingShadowBaseURL.IsEmpty() {
		if err := embedding.CheckURL(c.EmbeddingShadowBaseURL.Reveal()); err != nil {
			return fmt.Errorf("EMBEDDING_SHADOW_BASE_URL không hợp lệ: %w", err)
		}
	}

	// Primary provider requirements & default query timeout.
	switch c.EmbeddingProvider {
	case embedding.ProviderTEI:
		if c.TEIURL.IsEmpty() {
			return fmt.Errorf("TEI_URL là bắt buộc khi EMBEDDING_PROVIDER=tei")
		}
	case embedding.ProviderOpenAICompat:
		if c.EmbeddingBaseURL.IsEmpty() {
			return fmt.Errorf("EMBEDDING_BASE_URL là bắt buộc khi EMBEDDING_PROVIDER=openai_compat")
		}
		if c.rawEmbeddingAPIKey.IsEmpty() {
			return fmt.Errorf("EMBEDDING_API_KEY là bắt buộc khi EMBEDDING_PROVIDER=openai_compat")
		}
		if strings.TrimSpace(c.EmbeddingModel) == "" {
			return fmt.Errorf("EMBEDDING_MODEL không được rỗng")
		}
	}
	queryTimeout, err := parseOrDefaultDuration(
		"EMBEDDING_QUERY_TIMEOUT",
		c.rawEmbeddingQueryTimeout,
		defaultQueryTimeoutForProvider(c.EmbeddingProvider),
		time.Millisecond,
		5*time.Minute,
	)
	if err != nil {
		return err
	}
	c.EmbeddingQueryTimeout = queryTimeout
	if c.EmbeddingDocumentTimeout < time.Millisecond || c.EmbeddingDocumentTimeout > 10*time.Minute {
		return fmt.Errorf("EMBEDDING_DOCUMENT_TIMEOUT phải trong khoảng 1ms..10m")
	}

	// Shadow provider requirements & default query timeout.
	switch c.EmbeddingShadowProvider {
	case "":
		// Không cấu hình shadow.
	case embedding.ProviderNoop:
		// Hợp lệ (tắt shadow).
	case embedding.ProviderTEI:
		if c.EmbeddingShadowBaseURL.IsEmpty() {
			return fmt.Errorf("EMBEDDING_SHADOW_BASE_URL là bắt buộc khi EMBEDDING_SHADOW_PROVIDER=tei")
		}
	case embedding.ProviderOpenAICompat:
		if c.EmbeddingShadowBaseURL.IsEmpty() {
			return fmt.Errorf("EMBEDDING_SHADOW_BASE_URL là bắt buộc khi EMBEDDING_SHADOW_PROVIDER=openai_compat")
		}
		if c.rawEmbeddingShadowAPIKey.IsEmpty() {
			return fmt.Errorf("EMBEDDING_SHADOW_API_KEY là bắt buộc khi EMBEDDING_SHADOW_PROVIDER=openai_compat")
		}
		if strings.TrimSpace(c.EmbeddingShadowModel) == "" {
			return fmt.Errorf("EMBEDDING_SHADOW_MODEL không được rỗng")
		}
	}
	shadowQueryTimeout, err := parseOrDefaultDuration(
		"EMBEDDING_SHADOW_QUERY_TIMEOUT",
		c.rawEmbeddingShadowQueryTimeout,
		defaultQueryTimeoutForProvider(c.EmbeddingShadowProvider),
		time.Millisecond,
		5*time.Minute,
	)
	if err != nil {
		return err
	}
	c.EmbeddingShadowQueryTimeout = shadowQueryTimeout
	if c.EmbeddingShadowDocumentTimeout < time.Millisecond || c.EmbeddingShadowDocumentTimeout > 10*time.Minute {
		return fmt.Errorf("EMBEDDING_SHADOW_DOCUMENT_TIMEOUT phải trong khoảng 1ms..10m")
	}

	// Search knobs validation (BE-2, M3).
	if c.SearchExactFallbackMaxVectors < c.SearchExactMaxVectors {
		return fmt.Errorf("SEARCH_EXACT_FALLBACK_MAX_VECTORS (%d) phải >= SEARCH_EXACT_MAX_VECTORS (%d)",
			c.SearchExactFallbackMaxVectors, c.SearchExactMaxVectors)
	}
	if c.SearchVectorBranchTimeout < time.Millisecond || c.SearchVectorBranchTimeout > 30*time.Second {
		return fmt.Errorf("SEARCH_VECTOR_BRANCH_TIMEOUT phải trong khoảng 1ms..30s")
	}
	if c.SearchVectorFallbackMinBudget < time.Millisecond || c.SearchVectorFallbackMinBudget > c.SearchVectorBranchTimeout {
		return fmt.Errorf("SEARCH_VECTOR_FALLBACK_MIN_BUDGET phải >= 1ms và <= SEARCH_VECTOR_BRANCH_TIMEOUT")
	}
	if c.SearchRollbackWindow < time.Minute || c.SearchRollbackWindow > 365*24*time.Hour {
		return fmt.Errorf("SEARCH_ROLLBACK_WINDOW phải trong khoảng 1m..8760h")
	}

	if c.rawBootstrapFlipInterval == "" {
		c.EmbeddingBootstrapFlipInterval = time.Minute
	} else {
		if c.Env == "production" {
			return fmt.Errorf("EMBEDDING_BOOTSTRAP_FLIP_INTERVAL là biến chỉ dùng cho test, không được đặt ở production")
		}
		d, err := time.ParseDuration(c.rawBootstrapFlipInterval)
		if err != nil || d < 100*time.Millisecond || d > time.Hour {
			return fmt.Errorf("EMBEDDING_BOOTSTRAP_FLIP_INTERVAL không hợp lệ (phải là duration trong khoảng 100ms..1h)")
		}
		c.EmbeddingBootstrapFlipInterval = d
	}
	return nil
}

func defaultQueryTimeoutForProvider(provider string) time.Duration {
	if provider == embedding.ProviderOpenAICompat {
		return 4 * time.Second
	}
	return 300 * time.Millisecond
}

func parseOrDefaultDuration(name, raw string, def, min, max time.Duration) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return def, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < min || d > max {
		return 0, fmt.Errorf("%s phải trong khoảng %s..%s", name, min, max)
	}
	return d, nil
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

// isRPIDMatchOrRegistrableSuffix nhận rpID khi nó bằng host của origin hoặc là hậu tố domain đăng ký được của host
// đó. RP ID là public suffix bị từ chối (KS-PSL, P04 Task 9): xét cả phần ICANN lẫn phần private của Public Suffix
// List (`github.io` là suffix private) nên không lọc theo cờ icann. Ngoại lệ tường minh duy nhất là `localhost`
// (dev). IP chỉ được nhận khi trùng chính xác host của origin, không qua tra PSL.
func isRPIDMatchOrRegistrableSuffix(rpID, originHost string) bool {
	if net.ParseIP(originHost) != nil || net.ParseIP(rpID) != nil {
		return rpID == originHost
	}
	if rpID != "localhost" {
		if suffix, _ := publicsuffix.PublicSuffix(rpID); suffix == rpID {
			return false
		}
	}
	if rpID == originHost {
		return true
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
	return c.EmbeddingProvider == "tei" && !c.TEIURL.IsEmpty()
}

// EmbeddingPrimary trả cấu hình client embedding chính (plan P05 mục 2.12, 2.13).
func (c *Config) EmbeddingPrimary() embedding.ClientConfig {
	if c == nil {
		return embedding.ClientConfig{Provider: embedding.ProviderNoop}
	}
	baseURL := c.EmbeddingBaseURL
	if c.EmbeddingProvider == embedding.ProviderTEI {
		baseURL = c.TEIURL
	}
	return embedding.ClientConfig{
		Provider:         c.EmbeddingProvider,
		BaseURL:          baseURL,
		APIKey:           c.rawEmbeddingAPIKey,
		Model:            c.EmbeddingModel,
		Dims:             c.EmbeddingDimensions,
		QueryInstruction: c.EmbeddingQueryInstruction,
		QueryTimeout:     c.EmbeddingQueryTimeout,
		DocumentTimeout:  c.EmbeddingDocumentTimeout,
		QueryPrefix:      c.TEIInputPrefixQuery,
		DocPrefix:        c.TEIInputPrefixDocument,
	}
}

// EmbeddingShadow trả cấu hình client embedding thứ hai (shadow) và true nếu
// EMBEDDING_SHADOW_PROVIDER được cấu hình khác rỗng và khác noop.
func (c *Config) EmbeddingShadow() (embedding.ClientConfig, bool) {
	if c == nil || c.EmbeddingShadowProvider == "" || c.EmbeddingShadowProvider == embedding.ProviderNoop {
		return embedding.ClientConfig{}, false
	}
	return embedding.ClientConfig{
		Provider:         c.EmbeddingShadowProvider,
		BaseURL:          c.EmbeddingShadowBaseURL,
		APIKey:           c.rawEmbeddingShadowAPIKey,
		Model:            c.EmbeddingShadowModel,
		Dims:             c.EmbeddingShadowDimensions,
		QueryInstruction: c.EmbeddingShadowQueryInstruction,
		QueryTimeout:     c.EmbeddingShadowQueryTimeout,
		DocumentTimeout:  c.EmbeddingShadowDocumentTimeout,
		QueryPrefix:      c.EmbeddingShadowInputPrefixQuery,
		DocPrefix:        c.EmbeddingShadowInputPrefixDoc,
	}, true
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

// String trả về chuỗi tóm tắt đã che secret và URL đầy đủ để fmt (%v, %+v, %s)
// trên cả giá trị Config lẫn con trỏ *Config không bao giờ làm lộ API key hay
// secret khác.
func (c Config) String() string {
	return c.redactedSummary()
}

// GoString trả về chuỗi tóm tắt đã che secret và URL đầy đủ để fmt %#v trên cả
// giá trị Config lẫn con trỏ *Config không bao giờ làm lộ API key hay secret.
func (c Config) GoString() string {
	return c.redactedSummary()
}

// LogValue implements slog.LogValuer so logging Config or *Config directly via
// slog never exposes secrets or full URLs.
func (c Config) LogValue() slog.Value {
	return slog.StringValue(c.redactedSummary())
}

func (c Config) redactedSummary() string {
	return fmt.Sprintf(
		"Config{Env:%q, HTTPAddr:%q, AppOrigin:%q, EmbeddingProvider:%q, EmbeddingAPIKeySet:%t, EmbeddingBaseURLSet:%t, TEIURLSet:%t, EmbeddingModel:%q, EmbeddingDimensions:%d, EmbeddingQueryTimeout:%s, EmbeddingDocumentTimeout:%s, EmbeddingShadowProvider:%q, EmbeddingShadowAPIKeySet:%t, EmbeddingShadowBaseURLSet:%t, SearchSemanticEnabled:%t}",
		c.Env,
		c.HTTPAddr,
		c.AppOrigin,
		c.EmbeddingProvider,
		!c.EmbeddingAPIKey.IsEmpty() || !c.rawEmbeddingAPIKey.IsEmpty(),
		!c.EmbeddingBaseURL.IsEmpty(),
		!c.TEIURL.IsEmpty(),
		c.EmbeddingModel,
		c.EmbeddingDimensions,
		c.EmbeddingQueryTimeout,
		c.EmbeddingDocumentTimeout,
		c.EmbeddingShadowProvider,
		!c.EmbeddingShadowAPIKey.IsEmpty() || !c.rawEmbeddingShadowAPIKey.IsEmpty(),
		!c.EmbeddingShadowBaseURL.IsEmpty(),
		c.SearchSemanticEnabled,
	)
}

// Redacted trả bản sao an toàn để log: che chuỗi kết nối DB và mọi secret.
func (c *Config) Redacted() map[string]any {
	if c == nil {
		return map[string]any{}
	}
	return map[string]any{
		"env":                               c.Env,
		"http_addr":                         c.HTTPAddr,
		"app_origin":                        c.AppOrigin,
		"embedding_provider":                c.EmbeddingProvider,
		"embedding_api_key_set":             !c.EmbeddingAPIKey.IsEmpty() || !c.rawEmbeddingAPIKey.IsEmpty(),
		"embedding_base_url_set":            !c.EmbeddingBaseURL.IsEmpty(),
		"tei_url_set":                       !c.TEIURL.IsEmpty(),
		"embedding_model":                   c.EmbeddingModel,
		"embedding_dimensions":              c.EmbeddingDimensions,
		"embedding_query_timeout":           c.EmbeddingQueryTimeout.String(),
		"embedding_document_timeout":        c.EmbeddingDocumentTimeout.String(),
		"embedding_shadow_provider":         c.EmbeddingShadowProvider,
		"embedding_shadow_api_key_set":      !c.EmbeddingShadowAPIKey.IsEmpty() || !c.rawEmbeddingShadowAPIKey.IsEmpty(),
		"embedding_shadow_base_url_set":     !c.EmbeddingShadowBaseURL.IsEmpty(),
		"embedding_shadow_model":            c.EmbeddingShadowModel,
		"embedding_shadow_dimensions":       c.EmbeddingShadowDimensions,
		"embedding_shadow_query_timeout":    c.EmbeddingShadowQueryTimeout.String(),
		"embedding_shadow_document_timeout": c.EmbeddingShadowDocumentTimeout.String(),
		"search_semantic_enabled":           c.SearchSemanticEnabled,
		"search_exact_max_vectors":          c.SearchExactMaxVectors,
		"search_exact_fallback_max_vectors": c.SearchExactFallbackMaxVectors,
		"search_hnsw_ef_search":             c.SearchHNSWEfSearch,
		"search_hnsw_max_scan_tuples":       c.SearchHNSWMaxScanTuples,
		"search_hnsw_iterative_scan":        c.SearchHNSWIterativeScan,
		"search_vector_branch_timeout":      c.SearchVectorBranchTimeout.String(),
		"search_vector_fallback_min_budget": c.SearchVectorFallbackMinBudget.String(),
		"search_rollback_window":            c.SearchRollbackWindow.String(),
		"worker_metrics_addr":               c.WorkerMetricsAddr,
		"embedding_bootstrap_flip_interval": c.EmbeddingBootstrapFlipInterval.String(),
		"semantic_available":                c.SemanticAvailable(),
		"log_level":                         c.LogLevel,
		"database_url":                      "[redacted]",
		"auth_require_email_verification":   c.RequireEmailVerification,
		"auth_google_reauth_enabled":        c.GoogleReauthEnabled,
		"oauth_google":                      c.GoogleLoginEnabled(),
		"oauth_github":                      c.GitHubLoginEnabled(),
		"auth_fake_oauth":                   c.FakeOAuth,
		"turnstile":                         c.TurnstileEnabled(),
		"mail_sink_configured":              c.MailSinkDir != "",
		"auth_mail_capture_as_delivery":     c.MailCaptureAsDelivery,
		"ephemeral_secrets":                 c.EphemeralSecrets,
		"audit_retention_days":              c.AuditRetentionDays,
		"trusted_proxy_cidrs":               len(c.TrustedProxyCIDRs),
		"vault_key_mutations_disabled":      c.KeyMutationsDisabled,
		"webauthn_rp_id":                    c.WebAuthnRPID,
		"webauthn_rp_origin":                c.WebAuthnRPOrigin,
	}
}
