package suggest

import (
	"github.com/go-chi/chi/v5"

	"github.com/zone17th/engram/apps/api/internal/httpx"
)

// SearchProvider is the local interface implemented by `*compose.Search`
// so `suggest.Mount` can accept either `*Handler`, `*Service`, or `SearchProvider`
// without creating an import cycle with `compose`.
type SearchProvider interface {
	SearchHandler() *Handler
}

// Mount registers `/api/v1/suggest` (Task 3; Task 4 adds `/api/v1/search` here):
//   - GET /suggest (`suggest`): S (`RequireSession`) + R(`search_read`, token bucket 20/s burst 40)
//
// `RequireSession` is applied BEFORE `LimitSearchRead` so requests blocked at session
// authentication never consume tokens from any user's bucket (SPEC §9.1, plan P05 mục 2.6).
func Mount(deps ...any) func(v1 chi.Router, d httpx.Deps) {
	if len(deps) == 0 || deps[0] == nil {
		panic("suggest.Mount: requires *suggest.Handler, *suggest.Service, or suggest.SearchProvider (*compose.Search)")
	}
	var h *Handler
	switch v := deps[0].(type) {
	case *Handler:
		h = v
	case *Service:
		h = NewHandler(v, nil)
	case SearchProvider:
		h = v.SearchHandler()
	default:
		panic("suggest.Mount: first argument must be *suggest.Handler, *suggest.Service, or suggest.SearchProvider")
	}
	if h == nil {
		panic("suggest.Mount: nil *suggest.Handler")
	}

	return func(v1 chi.Router, d httpx.Deps) {
		requireSess := httpx.RequireSession(d.Authenticator)
		rateLimit := h.bucket.Middleware()

		v1.With(requireSess, rateLimit).Get("/suggest", h.Suggest)
	}
}
