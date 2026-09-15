package httpx

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
)

// ReadyFunc kiểm tra các phụ thuộc BẮT BUỘC. TEI là optional nên không nằm ở đây.
type ReadyFunc func(ctx context.Context) error

// Deps là mọi thứ router cần, truyền tường minh để test dựng được router thật.
type Deps struct {
	Config           *config.Config
	Logger           *slog.Logger
	Ready            ReadyFunc
	Metrics          http.Handler // handler của /api/v1/metrics
	MetricsCollector *obs.Metrics // nơi ghi số liệu
}

// NewRouter mount toàn bộ API dưới /api/v1. Không có endpoint nào ở root.
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(RequestID)
	r.Use(AccessLog(d.Logger))
	if d.MetricsCollector != nil {
		r.Use(Observe(d.MetricsCollector))
	}

	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		WriteProblem(w, r, http.StatusNotFound, "not_found", "Không có tài nguyên ở đường dẫn này.")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		WriteProblem(w, r, http.StatusMethodNotAllowed, "invalid_request", "Phương thức không được hỗ trợ.")
	})

	r.Route("/api/v1", func(v1 chi.Router) {
		v1.Get("/healthz", healthz)
		v1.Get("/readyz", readyz(d))
		v1.Handle("/metrics", d.Metrics)
	})

	return r
}
