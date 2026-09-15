package httpx_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

func TestHealthzOK(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, muốn 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body không phải JSON: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf(`status = %v, muốn "ok"`, body["status"])
	}
}

// Ba endpoint vận hành chỉ tồn tại dưới /api/v1 — không có bản sao ở root (P01 §Contract).
func TestNoRootDuplicates(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	for _, path := range []string{"/healthz", "/readyz", "/metrics"} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, muốn 404", path, rec.Code)
		}
	}
}

func TestNotFoundReturnsProblemJSON(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/khong-ton-tai", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, muốn 404", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Errorf("Content-Type = %q, muốn application/problem+json", ct)
	}
}
