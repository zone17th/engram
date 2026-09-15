package httpx

import (
	"encoding/json"
	"net/http"
)

// healthz chỉ trả lời "tiến trình còn sống" — không chạm DB, không chạm TEI.
func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// bản tạm — Task 5 thay bằng bản kiểm tra DB thật.
func readyz(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := d.Ready(r.Context()); err != nil {
			WriteProblem(w, r, http.StatusServiceUnavailable, "dependency_unavailable", "Phụ thuộc bắt buộc chưa sẵn sàng.")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
	}
}
