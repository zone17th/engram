package httpx_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
)

type stubAuth struct {
	p   authctx.Principal
	err error
}

func (s stubAuth) Authenticate(context.Context, string) (authctx.Principal, error) {
	return s.p, s.err
}

type stubCSRF struct{ err error }

func (s stubCSRF) VerifyCSRF(context.Context, *authctx.Principal, string, string) error {
	return s.err
}

type stubReauth struct{ err error }

func (s stubReauth) VerifyReauth(context.Context, authctx.Principal, string, string) error {
	return s.err
}

func TestRequireSessionNilFailsClosed(t *testing.T) {
	r := chi.NewRouter()
	r.Use(httpx.RequireSession(nil))
	r.Get("/x", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("nil authenticator = %d, muốn 500", rec.Code)
	}
}

func TestRequireSessionAccessExpired(t *testing.T) {
	r := chi.NewRouter()
	r.Use(httpx.RequireSession(stubAuth{err: &httpx.AuthError{Code: "access_expired"}}))
	r.Get("/x", func(w http.ResponseWriter, r *http.Request) { t.Fatal("không được vào handler") })
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
	var p httpx.Problem
	_ = json.Unmarshal(rec.Body.Bytes(), &p)
	if p.Code != "access_expired" {
		t.Fatalf("code = %s", p.Code)
	}
}

func TestRequireCSRFAndReauthOrder(t *testing.T) {
	p := authctx.Principal{UserID: uuid.MustParse("11111111-1111-1111-1111-111111111111"), SessionID: uuid.MustParse("22222222-2222-2222-2222-222222222222")}
	r := chi.NewRouter()
	r.Use(httpx.RequireSession(stubAuth{p: p}))
	r.Use(httpx.RequireCSRF(stubCSRF{}))
	r.Use(httpx.RequireReauth(stubReauth{}, "account.email_change"))
	called := false
	r.Post("/x", func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(http.StatusNoContent) })
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
	req.AddCookie(&http.Cookie{Name: "sabk_csrf", Value: "c"})
	req.Header.Set("X-CSRF-Token", "c")
	req.Header.Set("X-Reauth-Token", "g")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if !called || rec.Code != http.StatusNoContent {
		t.Fatalf("guard thật phải cho qua, code=%d", rec.Code)
	}

	r2 := chi.NewRouter()
	r2.Use(httpx.RequireSession(stubAuth{p: p}))
	r2.Use(httpx.RequireReauth(nil, "account.email_change"))
	r2.Post("/x", func(w http.ResponseWriter, r *http.Request) { t.Fatal("nil reauth") })
	req2 := httptest.NewRequest(http.MethodPost, "/x", nil)
	req2.AddCookie(&http.Cookie{Name: "sabk_session", Value: "tok"})
	rec2 := httptest.NewRecorder()
	r2.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusInternalServerError {
		t.Fatalf("nil reauth = %d", rec2.Code)
	}
}

func TestRequireJSONContentRejectsForm(t *testing.T) {
	r := chi.NewRouter()
	r.Use(httpx.RequireJSONContent)
	r.Post("/x", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestRequireOriginRejectsMismatch(t *testing.T) {
	r := chi.NewRouter()
	r.Use(httpx.RequireOrigin("http://localhost:3000"))
	r.Post("/x", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	req := httptest.NewRequest(http.MethodPost, "/x", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d", rec.Code)
	}
}
