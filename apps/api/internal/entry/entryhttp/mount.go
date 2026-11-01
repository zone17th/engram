// Package entryhttp cung cấp HTTP handlers và đăng ký route cho `/api/v1/entries*`
// và `/api/v1/items/{id}/entries*`.
package entryhttp

import (
	"github.com/go-chi/chi/v5"

	"github.com/zone17th/engram/apps/api/internal/httpx"
)

// Mount đăng ký các route `/api/v1/entries*` và `/api/v1/items/{id}/entries*` của P04.
// Ở Task 3b hàm này là stub chưa gắn route nào; lane `entryapi` sẽ điền đầy đủ
// các operation entry ở Wave 2 (Task 6a–7).
func Mount(_ ...any) func(v1 chi.Router, d httpx.Deps) {
	return func(_ chi.Router, _ httpx.Deps) {}
}
