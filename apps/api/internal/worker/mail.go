package worker

import (
	"log/slog"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
)

// NewWorkerMailer builds the worker's Mailer through compose.NewMailer, the same
// adapter cmd/api uses (plan P06 Task 5, R1-13). Without SMTP or a sink it is a
// NoopMailer: the notice worker stays registered and cancels its jobs instead of
// leaving them queued forever.
func NewWorkerMailer(cfg *config.Config) (auth.Mailer, error) {
	return compose.NewMailer(cfg, slog.Default())
}
