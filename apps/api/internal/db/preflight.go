package db

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
)

// requiredExtensions là các extension SPEC §4.3 bắt buộc.
var requiredExtensions = []string{"citext", "pg_trgm", "pgcrypto", "unaccent", "vector"}

// minPgvector là sàn version của pgvector theo spec.
const minPgvectorMajor, minPgvectorMinor = 0, 8

// Preflight khẳng định database đã sẵn sàng về mặt schema trước khi phục vụ traffic.
// Gọi một lần lúc boot; lỗi ở đây phải làm process thoát chứ không chỉ log.
func Preflight(ctx context.Context, pool *pgxpool.Pool) error {
	rows, err := gen.New(pool).ExtensionVersions(ctx)
	if err != nil {
		return fmt.Errorf("đọc pg_extension: %w", err)
	}

	installed := make(map[string]string, len(rows))
	for _, r := range rows {
		version := ""
		if r.Extversion != nil {
			version = *r.Extversion
		}
		installed[r.Extname] = version
	}

	var missing []string
	for _, ext := range requiredExtensions {
		if _, ok := installed[ext]; !ok {
			missing = append(missing, ext)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("database thiếu extension %s — chạy `migrate up` trước", strings.Join(missing, ", "))
	}

	if err := checkPgvectorFloor(installed["vector"]); err != nil {
		return err
	}
	return nil
}

func checkPgvectorFloor(version string) error {
	parts := strings.SplitN(version, ".", 3)
	if len(parts) < 2 {
		return fmt.Errorf("không đọc được version pgvector: %q", version)
	}
	major, err1 := strconv.Atoi(parts[0])
	minor, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return fmt.Errorf("version pgvector không hợp lệ: %q", version)
	}
	if major < minPgvectorMajor || (major == minPgvectorMajor && minor < minPgvectorMinor) {
		return fmt.Errorf("pgvector %s thấp hơn sàn %d.%d của spec", version, minPgvectorMajor, minPgvectorMinor)
	}
	return nil
}
