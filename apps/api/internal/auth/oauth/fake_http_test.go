package oauth_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/oauth"
)

func TestFakeAuthorizeHTMLFormThenContinue(t *testing.T) {
	f := oauth.NewFake("google", true, oauth.Identity{
		Provider: "google", UID: "def", Email: "def@example.test", EmailVerified: true,
	})
	req := httptest.NewRequest(http.MethodGet, "/__fake/oauth/google?state=st&redirect_uri=http://localhost:3000/cb&code_challenge=ch", nil)
	req.Header.Set("Accept", "text/html")
	rec := httptest.NewRecorder()
	f.ServeAuthorize(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("form status = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "not Google or GitHub production") || !strings.Contains(body, "Cancel") {
		t.Fatalf("form = %s", body)
	}

	form := url.Values{
		"state":          {"st"},
		"redirect_uri":   {"http://localhost:3000/cb"},
		"code_challenge": {"ch"},
		"email":          {"unique@example.test"},
		"subject":        {"sub-unique"},
		"outcome":        {"ok"},
	}
	post := httptest.NewRequest(http.MethodPost, "/__fake/oauth/google", strings.NewReader(form.Encode()))
	post.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec2 := httptest.NewRecorder()
	f.ServeAuthorize(rec2, post)
	if rec2.Code != http.StatusFound {
		t.Fatalf("continue = %d", rec2.Code)
	}
	loc := rec2.Header().Get("Location")
	u, err := url.Parse(loc)
	if err != nil {
		t.Fatal(err)
	}
	if u.Query().Get("code") == "" || u.Query().Get("error") != "" {
		t.Fatalf("location = %s", loc)
	}
}

func TestFakeAuthorizeCancelRedirectsWithError(t *testing.T) {
	f := oauth.NewFake("google", true, oauth.Identity{Provider: "google", UID: "x", Email: "x@example.test", EmailVerified: true})
	req := httptest.NewRequest(http.MethodGet, "/__fake/oauth/google?state=st&redirect_uri=http://localhost:3000/cb&outcome=cancel", nil)
	rec := httptest.NewRecorder()
	f.ServeAuthorize(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Location"); !strings.Contains(got, "error=access_denied") {
		t.Fatalf("location = %s", got)
	}
}

func TestFakeAuthorizeNonHTMLStillAutoRedirects(t *testing.T) {
	f := oauth.NewFake("google", true, oauth.Identity{Provider: "google", UID: "x", Email: "x@example.test", EmailVerified: true})
	req := httptest.NewRequest(http.MethodGet, "/__fake/oauth/google?state=st&redirect_uri=http://localhost:3000/cb", nil)
	rec := httptest.NewRecorder()
	f.ServeAuthorize(rec, req)
	if rec.Code != http.StatusFound {
		b, _ := io.ReadAll(rec.Body)
		t.Fatalf("status = %d %s", rec.Code, b)
	}
	if got := rec.Header().Get("Location"); !strings.Contains(got, "code=fake-st") {
		t.Fatalf("location = %s", got)
	}
}
