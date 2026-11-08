package compose

import (
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/export"
	"github.com/zone17th/engram/apps/api/internal/httpx"
)

// Export bundles the assembled export service and shared HTTP helpers for
// Task 11 (`exportapi` / `compose/export_http.go`).
type Export struct {
	Service     *export.Service
	Idempotency *httpx.Idempotency
	Limiter     *httpx.UserLimiter
}

// NewExport constructs export.Service along with Idempotency and UserLimiter
// sharing the same pool and clock (plan P06 mục 4.2, Task 2).
func NewExport(
	cfg *config.Config,
	pool *pgxpool.Pool,
	riverc *river.Client[pgx.Tx],
	clk clock.Clock,
) (*Export, error) {
	if cfg == nil || pool == nil {
		return nil, fmt.Errorf("compose export thiếu config/pool")
	}
	if clk == nil {
		clk = clock.System{}
	}
	limiter := httpx.NewUserLimiter(pool, clk)
	svc, err := export.NewService(cfg, pool, riverc, limiter, clk)
	if err != nil {
		return nil, err
	}
	idem := httpx.NewIdempotency(pool, clk)
	return &Export{
		Service:     svc,
		Idempotency: idem,
		Limiter:     limiter,
	}, nil
}
