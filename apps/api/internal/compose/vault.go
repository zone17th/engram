package compose

import (
	"fmt"
	"log/slog"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/audit"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/notification"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault/vaulthttp"
)

// Vault gom các thành phần đã lắp ráp cho nhóm `/api/v1/vault*`.
type Vault struct {
	Service     *vault.Service
	API         *vaulthttp.API
	Idempotency *httpx.Idempotency
	Limiter     *httpx.UserLimiter
	Mount       func(v1 chi.Router, d httpx.Deps)
}

// NewVault khởi tạo `vault.Service` và `vaulthttp.API` giống như `compose.NewAuth` (plan Task 8).
func NewVault(
	cfg *config.Config,
	pool *pgxpool.Pool,
	riverc *river.Client[pgx.Tx],
	clk clock.Clock,
	_ vault.Mailer,
	metrics *obs.Metrics,
	resetHook vault.ResetHook,
	logger *slog.Logger,
) (*vault.Service, *vaulthttp.API, error) {
	if cfg == nil || pool == nil {
		return nil, nil, fmt.Errorf("compose vault thiếu config/pool")
	}
	if clk == nil {
		clk = clock.System{}
	}
	aud := audit.NewStore(pool)
	if aud == nil {
		return nil, nil, fmt.Errorf("audit store nil")
	}
	notes := notification.NewStore(pool, riverc)
	if notes == nil {
		return nil, nil, fmt.Errorf("notification store nil")
	}
	vMetrics := vault.MetricsFromObs(metrics)
	svc, err := vault.NewService(cfg, pool, clk, aud, notes, nil, vMetrics, resetHook, logger)
	if err != nil {
		return nil, nil, err
	}
	idem := httpx.NewIdempotency(pool, clk)
	limiter := httpx.NewUserLimiter(pool, clk)
	api := vaulthttp.NewAPI(svc, idem, limiter, cfg.TrustedProxyContains)
	return svc, api, nil
}

// MountAll ghép nhiều hàm mount `/api/v1` (ví dụ `authhttp.Mount(authAPI)` và `vaulthttp.Mount(vaultAPI)`)
// thành một `MountAPI` duy nhất cho `httpx.Deps`.
func MountAll(mounts ...func(v1 chi.Router, d httpx.Deps)) func(v1 chi.Router, d httpx.Deps) {
	return func(v1 chi.Router, d httpx.Deps) {
		for _, m := range mounts {
			if m != nil {
				m(v1, d)
			}
		}
	}
}
