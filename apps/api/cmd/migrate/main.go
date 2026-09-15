// Command migrate chạy migration từ CLI: migrate up | down | version.
package main

import (
	"fmt"
	"log/slog"
	"os"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "dùng: migrate up|down|version")
		os.Exit(2)
	}

	cfg, err := config.Load()
	if err != nil {
		slog.Error("cấu hình không hợp lệ", slog.String("err", err.Error()))
		os.Exit(1)
	}

	switch os.Args[1] {
	case "up":
		err = db.MigrateUp(cfg.DatabaseURL)
	case "down":
		err = db.MigrateDown(cfg.DatabaseURL)
	case "version":
		var v uint
		var dirty bool
		v, dirty, err = db.Version(cfg.DatabaseURL)
		if err == nil {
			fmt.Printf("version=%d dirty=%v\n", v, dirty)
		}
	default:
		fmt.Fprintf(os.Stderr, "lệnh không biết: %s\n", os.Args[1])
		os.Exit(2)
	}

	if err != nil {
		slog.Error("migration thất bại", slog.String("err", err.Error()))
		os.Exit(1)
	}
	slog.Info("migration xong", slog.String("cmd", os.Args[1]))
}
