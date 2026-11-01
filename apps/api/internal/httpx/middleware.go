package httpx

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/obs"
)

type ctxKey int

const requestIDKey ctxKey = iota

// RequestIDFrom lấy request ID đã gắn vào context; trả "" nếu chưa qua middleware.
func RequestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// RequestID nhận X-Request-Id từ proxy hoặc sinh mới, rồi echo lại cho client.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if id == "" {
			id = uuid.NewString()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

// responseStatus returns the status that was committed to the response. A
// handler that writes nothing still results in an implicit 200 response.
func responseStatus(w middleware.WrapResponseWriter) int {
	if status := w.Status(); status != 0 {
		return status
	}
	return http.StatusOK
}

// AccessLog ghi đúng bốn thứ: route pattern, method, status, latency (+ request ID).
// TUYỆT ĐỐI không log r.URL.RawQuery hay body: query chứa từ khoá riêng tư của người
// dùng và body có thể là ciphertext/plaintext không được phép rời client (SPEC §10).
func AccessLog(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

			next.ServeHTTP(rec, r)

			route := chi.RouteContext(r.Context()).RoutePattern()
			if route == "" {
				route = "unmatched"
			}
			logger.InfoContext(r.Context(), "http_request",
				slog.String("route", route),
				slog.String("method", r.Method),
				slog.Int("status", responseStatus(rec)),
				slog.Int64("duration_ms", time.Since(start).Milliseconds()),
				slog.String("request_id", RequestIDFrom(r.Context())),
			)
		})
	}
}

// Observe ghi latency vào histogram bằng route pattern — cùng lý do như AccessLog:
// raw path có thể chứa tham số riêng tư và làm nổ cardinality.
func Observe(m *obs.Metrics) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

			next.ServeHTTP(rec, r)

			route := chi.RouteContext(r.Context()).RoutePattern()
			if route == "" {
				route = "unmatched"
			}
			m.RequestDuration.
				WithLabelValues(route, normalizeMethod(r.Method), strconv.Itoa(responseStatus(rec))).
				Observe(time.Since(start).Seconds())
		})
	}
}

func normalizeMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
		http.MethodPatch, http.MethodDelete, http.MethodOptions,
		http.MethodConnect, http.MethodTrace:
		return method
	default:
		return "OTHER"
	}
}
