package httpx_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

func TestWriteProblemShape(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/readyz?q=bimat", nil)

	httpx.WriteProblem(rec, req, http.StatusServiceUnavailable, "dependency_unavailable", "Cơ sở dữ liệu chưa sẵn sàng.")

	if got := rec.Header().Get("Content-Type"); got != "application/problem+json" {
		t.Errorf("Content-Type = %q, muốn application/problem+json", got)
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, muốn 503", rec.Code)
	}

	var p httpx.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("body không phải JSON hợp lệ: %v", err)
	}
	if p.Type != "https://key.zone17th.click/problems/dependency_unavailable" {
		t.Errorf("type = %q", p.Type)
	}
	if p.Code != "dependency_unavailable" {
		t.Errorf("code = %q", p.Code)
	}
	if p.Status != http.StatusServiceUnavailable {
		t.Errorf("status trong body = %d", p.Status)
	}
}

func TestWriteProblemNeverEchoesQuery(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/readyz?q=bimat", nil)

	httpx.WriteProblem(rec, req, http.StatusBadRequest, "invalid_request", "Tham số không hợp lệ.")

	if body := rec.Body.String(); contains(body, "bimat") {
		t.Fatalf("problem body lộ query người dùng: %s", body)
	}
}

func contains(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) &&
		func() bool {
			for i := 0; i+len(needle) <= len(haystack); i++ {
				if haystack[i:i+len(needle)] == needle {
					return true
				}
			}
			return false
		}()
}
