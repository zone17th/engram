package httpx_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

func routerWithReady(buf *bytes.Buffer, cfg *config.Config, ready httpx.ReadyFunc) http.Handler {
	d := testDeps(buf)
	d.Config = cfg
	d.Ready = ready
	return httpx.NewRouter(d)
}

func TestReadyzOKWhenDatabaseUp(t *testing.T) {
	var buf bytes.Buffer
	cfg := &config.Config{Env: "test", EmbeddingProvider: "noop"}
	r := routerWithReady(&buf, cfg, func(context.Context) error { return nil })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/readyz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, muốn 200", rec.Code)
	}
	var body struct {
		Status            string            `json:"status"`
		Checks            map[string]string `json:"checks"`
		SemanticAvailable bool              `json:"semantic_available"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body: %v", err)
	}
	if body.Status != "ready" {
		t.Errorf("status = %q", body.Status)
	}
	if body.Checks["database"] != "ok" {
		t.Errorf(`checks.database = %q`, body.Checks["database"])
	}
	// Provider noop KHÔNG được quảng cáo semantic là sẵn sàng.
	if body.SemanticAvailable {
		t.Error("semantic_available = true với provider noop")
	}
}

func TestReadyzFailsWhenDatabaseDown(t *testing.T) {
	var buf bytes.Buffer
	cfg := &config.Config{Env: "test", EmbeddingProvider: "noop"}
	r := routerWithReady(&buf, cfg, func(context.Context) error { return errors.New("connection refused") })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/readyz", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, muốn 503", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Errorf("Content-Type = %q", ct)
	}
	// Chi tiết lỗi hạ tầng không được rò ra client.
	if body := rec.Body.String(); bytes.Contains([]byte(body), []byte("connection refused")) {
		t.Errorf("readyz lộ chi tiết lỗi nội bộ: %s", body)
	}
}

// Healthz phản ánh tiến trình, không phụ thuộc DB (P01-A2).
func TestHealthzStillOKWhenDatabaseDown(t *testing.T) {
	var buf bytes.Buffer
	cfg := &config.Config{Env: "test", EmbeddingProvider: "noop"}
	r := routerWithReady(&buf, cfg, func(context.Context) error { return errors.New("db down") })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("healthz status = %d, muốn 200", rec.Code)
	}
}

// TEI là optional: deployment lexical-only vẫn phải ready (P01 §Contract).
func TestReadyzIgnoresTEI(t *testing.T) {
	var buf bytes.Buffer
	cfg := &config.Config{Env: "test", EmbeddingProvider: "tei", TEIURL: "http://tei-khong-ton-tai:80"}
	r := routerWithReady(&buf, cfg, func(context.Context) error { return nil })

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/readyz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, muốn 200 — TEI không được làm ready fail", rec.Code)
	}
}
