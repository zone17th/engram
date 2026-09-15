package httpx

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// healthz chỉ trả lời "tiến trình còn sống" — không chạm DB, không chạm TEI.
func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

type readyResponse struct {
	Status            string            `json:"status"`
	Checks            map[string]string `json:"checks"`
	SemanticAvailable bool              `json:"semantic_available"`
}

// readyz kiểm tra các phụ thuộc BẮT BUỘC (hiện chỉ có Postgres). TEI là optional:
// deployment lexical-only vẫn ready khi TEI chết (P01 §Contract).
// Lý do lỗi chỉ đi vào log, không đi vào response.
func readyz(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := d.Ready(r.Context()); err != nil {
			d.Logger.ErrorContext(r.Context(), "readyz thất bại",
				slog.String("check", "database"),
				slog.String("err", err.Error()),
				slog.String("request_id", RequestIDFrom(r.Context())),
			)
			WriteProblem(w, r, http.StatusServiceUnavailable, "dependency_unavailable",
				"Phụ thuộc bắt buộc chưa sẵn sàng.")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(readyResponse{
			Status:            "ready",
			Checks:            map[string]string{"database": "ok"},
			SemanticAvailable: d.Config.SemanticAvailable(),
		})
	}
}
