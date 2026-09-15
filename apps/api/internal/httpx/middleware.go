package httpx

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
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

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// AccessLog ghi đúng bốn thứ: route pattern, method, status, latency (+ request ID).
// TUYỆT ĐỐI không log r.URL.RawQuery hay body: query chứa từ khoá riêng tư của người
// dùng và body có thể là ciphertext/plaintext không được phép rời client (SPEC §10).
func AccessLog(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

			next.ServeHTTP(rec, r)

			route := chi.RouteContext(r.Context()).RoutePattern()
			if route == "" {
				route = "unmatched"
			}
			logger.InfoContext(r.Context(), "http_request",
				slog.String("route", route),
				slog.String("method", r.Method),
				slog.Int("status", rec.status),
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
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

			next.ServeHTTP(rec, r)

			route := chi.RouteContext(r.Context()).RoutePattern()
			if route == "" {
				route = "unmatched"
			}
			m.RequestDuration.
				WithLabelValues(route, r.Method, strconv.Itoa(rec.status)).
				Observe(time.Since(start).Seconds())
		})
	}
}
