package httpx_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/httpx"
)

func TestAccessLogNeverContainsCredentialTokenOrCookieSecrets(t *testing.T) {
	var logs bytes.Buffer
	r := httpx.NewRouter(testDeps(&logs))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/healthz?query_secret=query-sentinel", strings.NewReader(`{"password":"password-sentinel","token":"body-token-sentinel"}`))
	req.Header.Set("Authorization", "Bearer header-token-sentinel")
	req.Header.Set("X-CSRF-Token", "csrf-header-sentinel")
	req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "cookie-token-sentinel"})
	req.AddCookie(&http.Cookie{Name: "sabk_reauth", Value: "cookie-grant-sentinel"})
	r.ServeHTTP(httptest.NewRecorder(), req)

	output := logs.String()
	for _, sentinel := range []string{
		"query-sentinel",
		"password-sentinel",
		"body-token-sentinel",
		"header-token-sentinel",
		"csrf-header-sentinel",
		"cookie-token-sentinel",
		"cookie-grant-sentinel",
	} {
		if strings.Contains(output, sentinel) {
			t.Fatalf("access log contains %q: %s", sentinel, output)
		}
	}
}
