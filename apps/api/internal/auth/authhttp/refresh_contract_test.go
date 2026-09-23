package authhttp_test

import (
	"net/http"
	"testing"
)

func TestRefreshConsumesCredentialRateLimit(t *testing.T) {
	h := newHarness(t, nil)
	h.csrf()
	resp := h.doAs(h.jar, http.MethodPost, "/api/v1/auth/signup", `{"email":"refresh-limit@example.com","password":"correcthorse"}`, true, "203.0.113.90")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("signup = %d %s", resp.StatusCode, h.body(resp))
	}
	_ = resp.Body.Close()

	for i := 1; i <= 5; i++ {
		resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/refresh", "", true, "203.0.113.91")
		if resp.StatusCode != http.StatusNoContent {
			t.Fatalf("refresh %d = %d %s", i, resp.StatusCode, h.body(resp))
		}
		_ = resp.Body.Close()
	}

	resp = h.doAs(h.jar, http.MethodPost, "/api/v1/auth/refresh", "", true, "203.0.113.91")
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("refresh 6 = %d %s", resp.StatusCode, h.body(resp))
	}
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("refresh 6 missing Retry-After")
	}
	_ = resp.Body.Close()
}
