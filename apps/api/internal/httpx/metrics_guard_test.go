package httpx_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/httpx"
)

func TestMetricsGuard(t *testing.T) {
	var buf bytes.Buffer
	r := httpx.NewRouter(httpx.Deps{
		Config: &config.Config{Env: "test", EmbeddingProvider: "noop"},
		Logger: testDeps(&buf).Logger,
		Ready:  func(context.Context) error { return nil },
		Metrics: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("metrics-body"))
		}),
	})

	cases := []struct {
		name    string
		remote  string
		headers map[string]string
		want    int
	}{
		{name: "loopback v4", remote: "127.0.0.1:5000", want: http.StatusOK},
		{name: "loopback v6", remote: "[::1]:5000", want: http.StatusOK},
		{name: "docker bridge gateway", remote: "172.18.0.1:5000", want: http.StatusOK},
		{name: "docker network 10/8", remote: "10.0.3.7:5000", want: http.StatusOK},
		{name: "v4-mapped loopback", remote: "[::ffff:127.0.0.1]:5000", want: http.StatusOK},
		{name: "public ip", remote: "203.0.113.9:5000", want: http.StatusNotFound},
		{name: "172.32 outside /12", remote: "172.32.0.1:5000", want: http.StatusNotFound},
		{name: "edge proxy X-Forwarded-For", remote: "172.18.0.1:5000", headers: map[string]string{"X-Forwarded-For": "1.2.3.4"}, want: http.StatusNotFound},
		{name: "edge proxy X-Real-IP", remote: "127.0.0.1:5000", headers: map[string]string{"X-Real-IP": "1.2.3.4"}, want: http.StatusNotFound},
		{name: "Forwarded header", remote: "127.0.0.1:5000", headers: map[string]string{"Forwarded": "for=1.2.3.4"}, want: http.StatusNotFound},
		{name: "empty X-Forwarded-For still proxied", remote: "127.0.0.1:5000", headers: map[string]string{"X-Forwarded-For": ""}, want: http.StatusNotFound},
		{name: "unparseable remote", remote: "garbage", want: http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
			req.RemoteAddr = tc.remote
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, muốn %d", rec.Code, tc.want)
			}
			if tc.want == http.StatusOK {
				if rec.Body.String() != "metrics-body" {
					t.Fatalf("body = %q", rec.Body.String())
				}
				return
			}
			if bytes.Contains(rec.Body.Bytes(), []byte("metrics-body")) {
				t.Fatal("request bị chặn vẫn lộ body metrics")
			}
			var p struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil || p.Code != "not_found" {
				t.Fatalf("problem code = %q (err %v), muốn not_found; body %s", p.Code, err, rec.Body.String())
			}
		})
	}
}
