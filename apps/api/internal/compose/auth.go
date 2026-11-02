package compose

import (
	"fmt"
	"net"
	"os"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/audit"
	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/auth/oauth"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/notification"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

type Auth struct {
	Service       *auth.Service
	OAuth         *oauth.Service
	API           *authhttp.API
	Authenticator httpx.Authenticator
	CSRF          httpx.CSRFVerifier
	Reauth        httpx.ReauthVerifier
	Mount         func(v1 interface{ Route(string, func()) }, d httpx.Deps)
}

func NewAuth(cfg *config.Config, pool *pgxpool.Pool, riverc *river.Client[pgx.Tx], clk clock.Clock, mail auth.Mailer, providers []oauth.Provider) (*auth.Service, *oauth.Service, *authhttp.API, error) {
	if cfg == nil || pool == nil {
		return nil, nil, nil, fmt.Errorf("compose auth thiếu config/pool")
	}
	if clk == nil {
		clk = clock.System{}
	}
	if mail == nil {
		dir := cfg.EffectiveMailSinkDir()
		if dir == "" {
			return nil, nil, nil, fmt.Errorf("thiếu mail adapter")
		}
		m, err := auth.NewSinkMailer(dir)
		if err != nil {
			return nil, nil, nil, err
		}
		mail = m
	}
	tokens := auth.NewTokenIssuer(cfg.AuthJWTSecret, cfg.JWTIssuer(), cfg.JWTAudience(), clk)
	sessions := auth.NewSessionStore(pool, tokens, clk)
	csrf := auth.NewCSRF(cfg.AuthCSRFSecret, clk)
	grants := auth.NewGrants(cfg.AuthReauthSecret, clk)
	lockout := auth.NewLockout(pool, clk)
	aud := audit.NewStore(pool)
	if aud == nil {
		return nil, nil, nil, fmt.Errorf("audit store nil")
	}
	sessions.SetAuditor(aud)
	notes := notification.NewStore(pool, riverc)
	if notes == nil {
		return nil, nil, nil, fmt.Errorf("notification store nil")
	}
	svc, err := auth.NewService(cfg, pool, sessions, csrf, tokens, grants, lockout, clk, aud, notes, auth.ConfigProbe(cfg), mail, vault.NewVaultStatus(pool))
	if err != nil {
		return nil, nil, nil, err
	}
	if fn := getOnNewAuthService(); fn != nil {
		fn(svc)
	}
	if len(providers) == 0 {
		providers = DefaultProviders(cfg)
	}
	oa := oauth.NewService(cfg, pool, sessions, aud, clk, providers)
	var captcha auth.Captcha = auth.NoCaptcha{}
	if cfg.TurnstileEnabled() {
		host := ""
		if u := cfg.AppOrigin; u != "" {
			host = hostFromOrigin(u)
		}
		captcha = auth.NewTurnstile(cfg.TurnstileSecret, host, "login", nil)
	}
	api := authhttp.NewAPI(svc, oa, captcha, cfg.TrustedProxyContains)
	return svc, oa, api, nil
}

var (
	onNewAuthServiceMu sync.RWMutex
	onNewAuthService   func(*auth.Service)
)

// SetOnNewAuthService registers an optional hook called when NewAuth constructs
// an *auth.Service (used by lifecycle tests).
func SetOnNewAuthService(fn func(*auth.Service)) {
	onNewAuthServiceMu.Lock()
	onNewAuthService = fn
	onNewAuthServiceMu.Unlock()
}

func getOnNewAuthService() func(*auth.Service) {
	onNewAuthServiceMu.RLock()
	defer onNewAuthServiceMu.RUnlock()
	return onNewAuthService
}

func Adapters(svc *auth.Service) (httpx.Authenticator, httpx.CSRFVerifier, httpx.ReauthVerifier) {
	return authhttp.SessionAdapter{Sessions: svc.Sessions()},
		authhttp.CSRFAdapter{CSRF: svc.CSRF()},
		authhttp.GrantAdapter{Grants: svc.Grants(), Sessions: svc.Sessions()}
}

func DefaultProviders(cfg *config.Config) []oauth.Provider {
	if cfg.FakeOAuth {
		origin := strings.TrimRight(cfg.AppOrigin, "/")
		google := oauth.NewFake("google", true, oauth.Identity{
			Provider: "google", UID: "fake-google", Email: "fake-google@example.test", EmailVerified: true,
		})
		google.SetAuthorizeBase(origin + "/api/v1/__fake/oauth/google")
		github := oauth.NewFake("github", false, oauth.Identity{
			Provider: "github", UID: "fake-github", Email: "fake-github@example.test", EmailVerified: true,
		})
		github.SetAuthorizeBase(origin + "/api/v1/__fake/oauth/github")
		return []oauth.Provider{google, github}
	}
	var out []oauth.Provider
	if cfg.GoogleLoginEnabled() {
		out = append(out, oauth.NewGoogleProvider(
			cfg.OAuthGoogleClientID,
			cfg.OAuthGoogleClientSecret,
			cfg.GoogleReauthEnabled,
		))
	}
	if cfg.GitHubLoginEnabled() {
		out = append(out, oauth.NewGitHubProvider(
			cfg.OAuthGitHubClientID,
			cfg.OAuthGitHubClientSecret,
		))
	}
	return out
}

func hostFromOrigin(origin string) string {
	for i := 0; i < len(origin); i++ {
		if origin[i] == '/' && i+2 < len(origin) && origin[i+1] == '/' {
			rest := origin[i+2:]
			for j := 0; j < len(rest); j++ {
				if rest[j] == '/' || rest[j] == ':' {
					return rest[:j]
				}
			}
			return rest
		}
	}
	return origin
}

func Trusted(cfg *config.Config) func(net.IP) bool {
	return cfg.TrustedProxyContains
}

func EnsureMailSinkDir(dir string) error {
	if dir == "" {
		return nil
	}
	return os.MkdirAll(dir, 0o700)
}
