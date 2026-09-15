// Package config đọc cấu hình từ biến môi trường và validate một lần lúc boot.
package config

import (
	"fmt"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/kelseyhightower/envconfig"
)

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
	return &cfg, nil
}

// SemanticAvailable cho biết tìm kiếm ngữ nghĩa có thật sự dùng được không.
// Provider noop KHÔNG sinh vector thật, nên phải báo false để UI không quảng cáo
// tính năng chưa có (P01 §Phạm vi).
func (c *Config) SemanticAvailable() bool {
	return c.EmbeddingProvider == "tei" && c.TEIURL != ""
}

// Redacted trả bản sao an toàn để log: che chuỗi kết nối DB.
func (c *Config) Redacted() map[string]any {
	return map[string]any{
		"env":                c.Env,
		"http_addr":          c.HTTPAddr,
		"app_origin":         c.AppOrigin,
		"embedding_provider": c.EmbeddingProvider,
		"semantic_available": c.SemanticAvailable(),
		"log_level":          c.LogLevel,
		"database_url":       "[redacted]",
	}
}
