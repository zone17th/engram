package compose

import (
	"log/slog"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/config"
)

// NewMailer is the single mail adapter factory for cmd/api (NewAuth) and the
// worker (worker.NewWorkerMailer), so both processes deliver through the same
// adapter (plan P06 Task 5, R1-13):
//   - SMTP_HOST set → generic SMTP relay;
//   - else a mail sink directory (AUTH_MAIL_SINK_DIR, or the development
//     default; config rejects a sink outside development) → SinkMailer;
//   - else NoopMailer (mail_delivery_available=false).
func NewMailer(cfg *config.Config, logger *slog.Logger) (auth.Mailer, error) {
	if cfg == nil {
		return auth.NewNoopMailer(), nil
	}
	if cfg.SMTPHost != "" {
		return auth.NewSMTPMailer(auth.SMTPConfig{
			Host:     cfg.SMTPHost,
			Port:     cfg.SMTPPort,
			Username: cfg.SMTPUsername,
			Password: cfg.SMTPPassword.Reveal(),
			From:     cfg.SMTPFrom,
			TLSMode:  cfg.SMTPTLSMode,
			Logger:   logger,
		})
	}
	if dir := cfg.EffectiveMailSinkDir(); dir != "" {
		return auth.NewSinkMailer(dir)
	}
	return auth.NewNoopMailer(), nil
}

// MailDeliveryCapable reports whether m can actually deliver (false for nil and
// NoopMailer). Adapters without the method (SinkMailer, test fakes) count as
// capable; auth.Service applies its own sink rule on top.
func MailDeliveryCapable(m auth.Mailer) bool {
	if m == nil {
		return false
	}
	if c, ok := m.(interface{ MailDeliveryAvailable() bool }); ok {
		return c.MailDeliveryAvailable()
	}
	return true
}
