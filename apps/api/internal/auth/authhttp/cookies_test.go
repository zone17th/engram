package authhttp_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/authhttp"
)

func TestSessionCookiesFlags(t *testing.T) {
	rec := httptest.NewRecorder()
	exp := time.Now().Add(10 * time.Minute)
	authhttp.SetSessionCookies(rec, "access", exp, "refresh", exp.Add(24*time.Hour))
	var session, refresh *http.Cookie
	for _, c := range rec.Result().Cookies() {
		switch c.Name {
		case authhttp.CookieSession:
			session = c
		case authhttp.CookieRefresh:
			refresh = c
		}
	}
	if session == nil || !session.HttpOnly || !session.Secure || session.Path != authhttp.PathAPI {
		t.Fatalf("session %+v", session)
	}
	if refresh == nil || !refresh.HttpOnly || refresh.Path != authhttp.PathAuth {
		t.Fatalf("refresh %+v", refresh)
	}
	rec2 := httptest.NewRecorder()
	authhttp.ClearAuthCookies(rec2)
	cleared := map[string]bool{}
	for _, c := range rec2.Result().Cookies() {
		if c.MaxAge < 0 {
			cleared[c.Name] = true
		}
	}
	for _, name := range []string{authhttp.CookieSession, authhttp.CookieRefresh, authhttp.CookieCSRF, authhttp.CookieAnon, authhttp.CookieOAuth, authhttp.CookieReauth} {
		if !cleared[name] {
			t.Fatalf("chưa clear %s", name)
		}
	}
}
