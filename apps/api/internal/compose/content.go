package compose

import (
	"fmt"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/audit"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/entry/entryhttp"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/item/itemhttp"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/tag/taghttp"
)

// ContentRouteKind phân loại trần body của route ghi content P04 (mục 2.3):
//   - ContentRouteItemTag: 16 KiB -> 413 invalid_request
//   - ContentRouteEntry:   400 KiB -> 413 entry_too_large
type ContentRouteKind int

const (
	// ContentRouteItemTag dùng cho các route ghi `/items*` (ngoài entries) và `/tags*` (16 KiB).
	ContentRouteItemTag ContentRouteKind = iota
	// ContentRouteEntry dùng cho các route ghi `/items/{id}/entries*` và `/entries*` (400 KiB).
	ContentRouteEntry
)

// ContentBodyLimit trả về cấu hình trần đọc request body trước `Idempotency.Lookup`
// ứng với từng nhóm route ghi content P04 (mục 2.3).
func ContentBodyLimit(kind ContentRouteKind) httpx.IdempotencyBodyLimit {
	switch kind {
	case ContentRouteEntry:
		return httpx.ContentEntryBodyLimit
	default:
		return httpx.ContentItemTagBodyLimit
	}
}

// Content gom các thành phần dùng chung của nhóm route content P04 (`/items*`, `/tags*`, `/entries*`):
// bộ quản lý `Idempotency`, `UserLimiter` gắn rule `ScopeContentWrite` (10 req / 1s / user),
// factory cấu hình/ghép `ChainIdempotencyMiddleware` cho mọi mutation content, và hàm `Mount`.
type Content struct {
	Config      *config.Config
	Pool        *pgxpool.Pool
	Clock       clock.Clock
	Audit       *audit.Store
	Metrics     *obs.Metrics
	Logger      *slog.Logger
	Idempotency *httpx.Idempotency
	Limiter     *httpx.UserLimiter
	Mount       func(v1 chi.Router, d httpx.Deps)
}

// NewContent khởi tạo các thành phần dùng chung cho content P04 theo đúng mẫu `compose.NewVault`
// (plan mục 2.3, 2.4, 2.5, Task 3b).
func NewContent(
	cfg *config.Config,
	pool *pgxpool.Pool,
	clk clock.Clock,
	metrics *obs.Metrics,
	logger *slog.Logger,
) (*Content, error) {
	if cfg == nil || pool == nil {
		return nil, fmt.Errorf("compose content thiếu config/pool")
	}
	if clk == nil {
		clk = clock.System{}
	}
	aud := audit.NewStore(pool)
	if aud == nil {
		return nil, fmt.Errorf("audit store nil")
	}
	idem := httpx.NewIdempotency(pool, clk)
	limiter := httpx.NewUserLimiter(pool, clk)

	c := &Content{
		Config:      cfg,
		Pool:        pool,
		Clock:       clk,
		Audit:       aud,
		Metrics:     metrics,
		Logger:      logger,
		Idempotency: idem,
		Limiter:     limiter,
	}
	c.Mount = MountAll(
		itemhttp.Mount(c),
		taghttp.Mount(c),
		entryhttp.Mount(c),
	)
	return c, nil
}

// RouteConfig tạo `httpx.IdempotencyRouteConfig` chuẩn cho một route ghi content P04 (mục 2.5):
//   - `RateLimit: httpx.LimitUser(c.Limiter, httpx.ScopeContentWrite)` (10 request / 1 giây / user)
//   - `AllowEmptyDelete: true`
//   - `BodyLimit`: 400 KiB (`entry_too_large`) cho `ContentRouteEntry`, 16 KiB (`invalid_request`) cho `ContentRouteItemTag`
//   - `RequireIfMatch`: bật cho `PATCH /items/{id}` và `PUT /entries/{id}`
func (c *Content) RouteConfig(d httpx.Deps, kind ContentRouteKind, requireIfMatch bool) httpx.IdempotencyRouteConfig {
	origin := ""
	if d.Config != nil {
		origin = d.Config.AppOrigin
	} else if c != nil && c.Config != nil {
		origin = c.Config.AppOrigin
	}
	var idem *httpx.Idempotency
	var limiter *httpx.UserLimiter
	if c != nil {
		idem = c.Idempotency
		limiter = c.Limiter
	}
	return httpx.IdempotencyRouteConfig{
		AppOrigin:        origin,
		Authenticator:    d.Authenticator,
		CSRF:             d.CSRF,
		Idempotency:      idem,
		Reauth:           d.Reauth,
		RateLimit:        httpx.LimitUser(limiter, httpx.ScopeContentWrite),
		RequireIfMatch:   requireIfMatch,
		AllowEmptyDelete: true,
		BodyLimit:        ContentBodyLimit(kind),
	}
}

// ChainWrite bọc `handler` bằng `httpx.ChainIdempotencyMiddleware` với cấu hình chuẩn của route ghi content P04.
// Mọi route ghi W2 (`itemhttp`, `taghttp`, `entryhttp`) đều đi qua helper này.
func (c *Content) ChainWrite(d httpx.Deps, kind ContentRouteKind, requireIfMatch bool, handler http.Handler) http.Handler {
	return httpx.ChainIdempotencyMiddleware(c.RouteConfig(d, kind, requireIfMatch), handler)
}

// ChainWriteFunc là dạng nhận `http.HandlerFunc` của `ChainWrite`.
func (c *Content) ChainWriteFunc(d httpx.Deps, kind ContentRouteKind, requireIfMatch bool, fn http.HandlerFunc) http.Handler {
	return c.ChainWrite(d, kind, requireIfMatch, fn)
}

// ChainItemTagWrite bọc route ghi `/items*` (ngoài entries) hoặc `/tags*` (trần 16 KiB -> `413 invalid_request`).
func (c *Content) ChainItemTagWrite(d httpx.Deps, requireIfMatch bool, fn http.HandlerFunc) http.Handler {
	return c.ChainWrite(d, ContentRouteItemTag, requireIfMatch, fn)
}

// ChainEntryWrite bọc route ghi `/items/{id}/entries*` hoặc `/entries*` (trần 400 KiB -> `413 entry_too_large`).
func (c *Content) ChainEntryWrite(d httpx.Deps, requireIfMatch bool, fn http.HandlerFunc) http.Handler {
	return c.ChainWrite(d, ContentRouteEntry, requireIfMatch, fn)
}
