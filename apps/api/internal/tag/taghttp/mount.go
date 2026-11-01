// Package taghttp cung cấp HTTP handlers và đăng ký route cho `/api/v1/tags*`.
package taghttp

import (
	"github.com/go-chi/chi/v5"

	"github.com/zone17th/engram/apps/api/internal/httpx"
)

// Mount đăng ký các route `/api/v1/tags*` của P04.
// Ở Task 3b hàm này là stub chưa gắn route nào; lane `itemtag` sẽ điền đầy đủ
// các operation tag ở Wave 2 (Task 5).
func Mount(_ ...any) func(v1 chi.Router, d httpx.Deps) {
	return func(_ chi.Router, _ httpx.Deps) {}
}
