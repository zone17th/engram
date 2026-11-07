package worker

import (
	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/config"
)

// NewWorkerMailer dựng Mailer cho tiến trình worker từ cấu hình (seam W0 cho
// ops-config W1; giữ nguyên hành vi sink/nil hiện tại).
func NewWorkerMailer(cfg *config.Config) (auth.Mailer, error) {
	if cfg == nil {
		return nil, nil
	}
	if dir := cfg.EffectiveMailSinkDir(); dir != "" {
		return auth.NewSinkMailer(dir)
	}
	return nil, nil
}
