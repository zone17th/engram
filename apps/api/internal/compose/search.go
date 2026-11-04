package compose

import (
	"fmt"
	"log/slog"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/semantic"
	"github.com/zone17th/engram/apps/api/internal/suggest"
)

// Search assembles the components for P05 search routes (`/api/v1/suggest` in Task 3,
// `/api/v1/search` in Task 4; semantic `NearSource` wired in Task 12), mirroring
// the style of `compose.Content` (plan P05 mục 4, Task 3).
type Search struct {
	Config      *config.Config
	Pool        *pgxpool.Pool
	Clock       clock.Clock
	Metrics     *obs.Metrics
	Logger      *slog.Logger
	Near        suggest.NearSource
	TokenBucket *httpx.TokenBucket
	Service     *suggest.Service
	Handler     *suggest.Handler
	Mount       func(v1 chi.Router, d httpx.Deps)
}

// NewSearch constructs the P05 search composition (plan P05 Task 3):
//   - Derives `k_cursor = HKDF-SHA256(cfg.AuthJWTSecret, "engram/search-cursor/v1")`
//   - Initializes the in-memory `search_read` token bucket (capacity 40, refill 20/s)
//   - Wires `suggest.NewNoopNearSource()` for Phase A (Task 12 replaces it with the semantic NearSource)
//   - Exposes `Mount` for `compose.MountAll(...)`
func NewSearch(
	cfg *config.Config,
	pool *pgxpool.Pool,
	clk clock.Clock,
	metrics *obs.Metrics,
	logger *slog.Logger,
	nearOpts ...suggest.NearSource,
) (*Search, error) {
	if cfg == nil || pool == nil {
		return nil, fmt.Errorf("compose search thiếu config/pool")
	}
	if clk == nil {
		clk = clock.System{}
	}
	cursorKey, err := suggest.DeriveCursorKey(cfg.AuthJWTSecret)
	if err != nil {
		return nil, fmt.Errorf("compose search cursor key: %w", err)
	}
	var near suggest.NearSource = suggest.NewNoopNearSource()
	for _, opt := range nearOpts {
		if opt != nil {
			near = opt
		}
	}
	bucket := httpx.NewSearchReadBucket(clk)
	svc := suggest.NewService(pool, clk, near, metrics, cursorKey)
	svc.SetLexicalForceCustomPlan(cfg.LexicalForceCustomPlanEnabled())
	handler := suggest.NewHandler(svc, bucket)

	s := &Search{
		Config:      cfg,
		Pool:        pool,
		Clock:       clk,
		Metrics:     metrics,
		Logger:      logger,
		Near:        near,
		TokenBucket: bucket,
		Service:     svc,
		Handler:     handler,
	}
	innerMount := suggest.Mount(s)
	s.Mount = func(v1 chi.Router, d httpx.Deps) {
		v1.Group(func(r chi.Router) {
			r.Use(semantic.RequestScopeMiddleware)
			innerMount(r, d)
		})
	}
	return s, nil
}

// SearchHandler implements `suggest.SearchProvider`.
func (s *Search) SearchHandler() *suggest.Handler {
	if s == nil {
		return nil
	}
	return s.Handler
}
