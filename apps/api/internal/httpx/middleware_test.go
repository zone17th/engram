package httpx_test

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

func testDeps(buf *bytes.Buffer) httpx.Deps {
	return httpx.Deps{
		Config:  &config.Config{Env: "test", EmbeddingProvider: "noop"},
		Logger:  slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelInfo})),
		Ready:   func(context.Context) error { return nil },
		Metrics: http.NotFoundHandler(),
	}
}

// Log truy cập không được chứa query người dùng: `q` là từ khoá riêng tư (SPEC §10).
func TestAccessLogNeverContainsQuery(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/healthz?q=matkhau-cua-toi", nil)
	r.ServeHTTP(httptest.NewRecorder(), req)

	out := buf.String()
	if strings.Contains(out, "matkhau-cua-toi") || strings.Contains(out, "q=") {
		t.Fatalf("access log lộ query: %s", out)
	}
	if !strings.Contains(out, `"route":"/api/v1/healthz"`) {
		t.Fatalf("access log thiếu route pattern: %s", out)
	}
}

func TestAccessLogNeverContainsBody(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/healthz", strings.NewReader(`{"secret":"dung-log-cai-nay"}`))
	r.ServeHTTP(httptest.NewRecorder(), req)

	if strings.Contains(buf.String(), "dung-log-cai-nay") {
		t.Fatalf("access log lộ body: %s", buf.String())
	}
}

func TestRequestIDEchoedAndStable(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/healthz", nil)
	req.Header.Set("X-Request-Id", "abc-123")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if got := rec.Header().Get("X-Request-Id"); got != "abc-123" {
		t.Errorf("X-Request-Id = %q, muốn abc-123", got)
	}
	if !strings.Contains(buf.String(), `"request_id":"abc-123"`) {
		t.Errorf("log thiếu request_id: %s", buf.String())
	}
}

func TestRequestIDGeneratedWhenAbsent(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(testDeps(&buf))

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/healthz", nil))

	if rec.Header().Get("X-Request-Id") == "" {
		t.Fatal("thiếu X-Request-Id sinh tự động")
	}
}
