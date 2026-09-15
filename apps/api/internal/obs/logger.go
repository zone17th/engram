package obs

import (
	"log/slog"
	"os"
)

// NewLogger trả logger JSON. Dev cũng dùng JSON để log giống production,
// tránh chuyện "chỉ production mới lộ field".
func NewLogger(level, env string) *slog.Logger {
	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(level)); err != nil {
		lvl = slog.LevelInfo
	}
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl})
	return slog.New(h).With(slog.String("service", "engram-api"), slog.String("env", env))
}
