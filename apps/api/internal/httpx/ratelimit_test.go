package httpx_test

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

func TestFixedWindowSixthDenied(t *testing.T) {
	l := httpx.NewFixedWindow(5)
	for i := 0; i < 5; i++ {
		ok, _ := l.Allow("ip")
		if !ok {
			t.Fatalf("request %d phải qua", i+1)
		}
	}
	ok, retry := l.Allow("ip")
	if ok || retry < 1 {
		t.Fatalf("request 6 phải 429 retry=%d", retry)
	}
	ok, _ = l.Allow("other")
	if !ok {
		t.Fatal("IP khác không chung bucket")
	}
}

func TestClientIPTrustedXFF(t *testing.T) {
	trusted := func(ip net.IP) bool { return ip.Equal(net.ParseIP("127.0.0.1")) }
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "127.0.0.1:1"
	req.Header.Set("X-Forwarded-For", "203.0.113.9, 127.0.0.1")
	if got := httpx.ClientIP(req, trusted); got != "203.0.113.9" {
		t.Fatalf("got %s", got)
	}
	req2 := httptest.NewRequest(http.MethodGet, "/", nil)
	req2.RemoteAddr = "203.0.113.1:2"
	req2.Header.Set("X-Forwarded-For", "198.51.100.1")
	if got := httpx.ClientIP(req2, trusted); got != "203.0.113.1" {
		t.Fatalf("untrusted peer phải dùng RemoteAddr, got %s", got)
	}
}

func TestLimitIPWritesRetryAfter(t *testing.T) {
	l := httpx.NewFixedWindow(1)
	h := httpx.LimitIP(l, func(*http.Request) string { return "k" })(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("thiếu Retry-After")
	}
}
