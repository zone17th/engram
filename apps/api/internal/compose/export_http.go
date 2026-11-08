package compose

import (
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/export/exporthttp"
)

// NewExportHTTP builds exporthttp.API on top of NewExport (plan P06 Task 11).
// EXPORT_CREATE_PAUSED is read from cfg for the pre-idempotency pause gate.
func NewExportHTTP(
	cfg *config.Config,
	pool *pgxpool.Pool,
	riverc *river.Client[pgx.Tx],
	clk clock.Clock,
	logger *slog.Logger,
) (*exporthttp.API, error) {
	comp, err := NewExport(cfg, pool, riverc, clk)
	if err != nil {
		return nil, err
	}
	paused := cfg.ExportCreatePaused
	return exporthttp.NewAPI(comp.Service, comp.Idempotency, func() bool { return paused }, cfg.TrustedProxyContains, logger), nil
}
