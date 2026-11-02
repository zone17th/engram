package suggest

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"sync/atomic"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/textnorm"
)

// Handler serves `/api/v1/suggest` (Task 3) and `/api/v1/search` (Task 4).
//
// Security invariants (user-dec-016, SPEC §9.2, §10, plan P05 mục 2.7):
//   - Never logs `q` or `qn`.
//   - Never echoes `q` or `qn` in RFC 9457 problem details or response bodies.
//   - Always sets `Cache-Control: no-store`.
//   - A genuine server error logs ONE WARN with only error_class, route, corpus, mode, scope,
//     pgcode (SQLSTATE). No err.Error() text (a pgx error may embed query parameters). A client
//     disconnect (request context canceled) is never logged as a server error (FU-SB-1).
type Handler struct {
	svc    *Service
	bucket *httpx.TokenBucket
	logger atomic.Pointer[slog.Logger]
}

// SetLogger attaches the logger used for server-error lines. nil disables logging.
// `Mount` calls it with `httpx.Deps.Logger` when none was set, so NewHandler and the
// compose call sites stay unchanged.
func (h *Handler) SetLogger(l *slog.Logger) { h.logger.Store(l) }

const (
	routeSuggest = "/api/v1/suggest"
	routeSearch  = "/api/v1/search"
)

// logServerError emits the single WARN line for a genuine internal error. Domain errors
// (4xx) and client disconnects are not server errors and log nothing.
func (h *Handler) logServerError(r *http.Request, route string, err error) {
	l := h.logger.Load()
	if l == nil || err == nil {
		return
	}
	if _, ok := AsError(err); ok {
		return
	}
	if _, ok := textnorm.AsError(err); ok {
		return
	}
	if errors.Is(r.Context().Err(), context.Canceled) {
		return
	}
	class := ClassUnclassified
	attrs := []slog.Attr{slog.String("route", route)}
	var ie *InternalError
	switch {
	case errors.As(err, &ie):
		class = ie.Class
		for _, kv := range [][2]string{{"corpus", ie.Corpus}, {"mode", ie.Mode}, {"scope", ie.Scope}, {"pgcode", ie.PGCode}} {
			if kv[1] != "" {
				attrs = append(attrs, slog.String(kv[0], kv[1]))
			}
		}
	case errors.Is(err, ErrSearchInternal):
		class = ClassSearchInternal
	}
	attrs = append([]slog.Attr{slog.String("error_class", class)}, attrs...)
	l.LogAttrs(r.Context(), slog.LevelWarn, "suggest server error", attrs...)
}

// NewHandler constructs a Handler for `/suggest` (and `/search` in Task 4).
// If `bucket` is nil, `httpx.NewSearchReadBucket(nil)` is used.
func NewHandler(svc *Service, bucket *httpx.TokenBucket) *Handler {
	if svc == nil {
		panic("suggest.NewHandler: missing *suggest.Service")
	}
	if bucket == nil {
		bucket = httpx.NewSearchReadBucket(svc.clk)
	}
	return &Handler{
		svc:    svc,
		bucket: bucket,
	}
}

// Service returns the underlying `*Service`.
func (h *Handler) Service() *Service { return h.svc }

// TokenBucket returns the `search_read` `*httpx.TokenBucket` attached to the handler.
func (h *Handler) TokenBucket() *httpx.TokenBucket { return h.bucket }

// Suggest handles `GET /api/v1/suggest` (`operationId: suggest`, SPEC §6.2–§6.4, §9.2, plan P05 mục 2.2–2.7, 3, Task 3).
func (h *Handler) Suggest(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok || p.UserID == uuid.Nil {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}

	// Reject malformed percent-encoding in the query string (never use url.Query() alone,
	// which silently discards malformed segments).
	qParams, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		WriteDomainError(w, r, ErrInvalidRequest)
		return
	}

	for k, vals := range qParams {
		switch k {
		case "q", "scope", "limit", "semantic":
			if len(vals) > 1 {
				WriteDomainError(w, r, ErrInvalidRequest)
				return
			}
		default:
			WriteDomainError(w, r, ErrInvalidRequest)
			return
		}
	}

	scope := ScopeAll
	if _, hasScope := qParams["scope"]; hasScope {
		rawScope := qParams.Get("scope")
		if !ValidSuggestScope(rawScope) {
			WriteDomainError(w, r, ErrInvalidRequest)
			return
		}
		scope = rawScope
	}

	limit := DefaultSuggestLimit
	if _, hasLimit := qParams["limit"]; hasLimit {
		rawLimit := qParams.Get("limit")
		parsedLimit, err := strconv.Atoi(rawLimit)
		if err != nil || !ValidSuggestLimit(parsedLimit) {
			WriteDomainError(w, r, ErrInvalidRequest)
			return
		}
		limit = parsedLimit
	}

	semantic := true
	if _, hasSem := qParams["semantic"]; hasSem {
		switch qParams.Get("semantic") {
		case "1":
			semantic = true
		case "0":
			semantic = false
		default:
			WriteDomainError(w, r, ErrInvalidRequest)
			return
		}
	}

	var rawQ string
	if _, hasQ := qParams["q"]; hasQ {
		rawQ = qParams.Get("q")
	}

	resp, err := h.svc.Suggest(r.Context(), SuggestInput{
		UserID:   p.UserID,
		RawQ:     rawQ,
		Scope:    scope,
		Limit:    limit,
		Semantic: semantic,
	})
	if err != nil {
		h.logServerError(r, routeSuggest, err)
		WriteDomainError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// Search handles `GET /api/v1/search` (`operationId: search`, SPEC §6.2–§6.4, §6.8, §9.2, plan P05 mục 2.2–2.7, 3, Task 4).
func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok || p.UserID == uuid.Nil {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}

	qParams, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		WriteDomainError(w, r, ErrInvalidRequest)
		return
	}

	for k, vals := range qParams {
		switch k {
		case "q", "scope", "limit", "cursor", "semantic":
			if len(vals) > 1 {
				WriteDomainError(w, r, ErrInvalidRequest)
				return
			}
		default:
			WriteDomainError(w, r, ErrInvalidRequest)
			return
		}
	}

	scope := ScopeAll
	if _, hasScope := qParams["scope"]; hasScope {
		rawScope := qParams.Get("scope")
		if !ValidSuggestScope(rawScope) {
			WriteDomainError(w, r, ErrInvalidRequest)
			return
		}
		scope = rawScope
	}

	limit := DefaultSearchLimit
	if _, hasLimit := qParams["limit"]; hasLimit {
		rawLimit := qParams.Get("limit")
		parsedLimit, err := strconv.Atoi(rawLimit)
		if err != nil || !ValidSearchLimit(parsedLimit) {
			WriteDomainError(w, r, ErrInvalidRequest)
			return
		}
		limit = parsedLimit
	}

	cursor := ""
	if _, hasCursor := qParams["cursor"]; hasCursor {
		rawCursor := qParams.Get("cursor")
		if rawCursor == "" {
			WriteDomainError(w, r, ErrInvalidRequest)
			return
		}
		cursor = rawCursor
	}

	semantic := true
	if _, hasSem := qParams["semantic"]; hasSem {
		switch qParams.Get("semantic") {
		case "1":
			semantic = true
		case "0":
			semantic = false
		default:
			WriteDomainError(w, r, ErrInvalidRequest)
			return
		}
	}

	rawQ, hasQ := "", false
	if _, ok := qParams["q"]; ok {
		hasQ = true
		rawQ = qParams.Get("q")
	}
	if !hasQ {
		WriteDomainError(w, r, ErrNameInvalid)
		return
	}

	resp, err := h.svc.Search(r.Context(), SearchInput{
		UserID:   p.UserID,
		RawQ:     rawQ,
		Scope:    scope,
		Limit:    limit,
		Cursor:   cursor,
		Semantic: semantic,
	})
	if err != nil {
		h.logServerError(r, routeSearch, err)
		WriteDomainError(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// WriteDomainError maps domain errors from `suggest` or `textnorm` to RFC 9457 Problem responses.
// Never embeds user input (`q`, `qn`, `name`, `display`) into `detail` (user-dec-016).
func WriteDomainError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	if se, ok := AsError(err); ok {
		status := httpx.ContentProblemStatus(se.Code)
		detail := se.Detail
		if detail == "" {
			detail = httpx.ProblemTitle(se.Code) + "."
		}
		httpx.WriteProblem(w, r, status, se.Code, detail)
		return
	}
	if te, ok := textnorm.AsError(err); ok {
		status := httpx.ContentProblemStatus(te.Code)
		httpx.WriteProblem(w, r, status, te.Code, httpx.ProblemTitle(te.Code)+".")
		return
	}
	httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Del("ETag")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
