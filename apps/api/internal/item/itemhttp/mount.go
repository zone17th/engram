// Package itemhttp cung cấp HTTP handlers và đăng ký route cho `/api/v1/items*`.
package itemhttp

import (
	"github.com/go-chi/chi/v5"

	"github.com/zone17th/engram/apps/api/internal/httpx"
)

// Mount đăng ký các route `/api/v1/items*` của P04.
// Ở Task 3b hàm này là stub chưa gắn route nào; lane `itemtag` sẽ điền đầy đủ
// các operation item ở Wave 2 (Task 4–5).
func Mount(_ ...any) func(v1 chi.Router, d httpx.Deps) {
	return func(_ chi.Router, _ httpx.Deps) {}
}
