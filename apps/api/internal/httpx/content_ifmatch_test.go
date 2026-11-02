package httpx_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/httpx"
)

func TestParseVersionIfMatch(t *testing.T) {
	validCases := []struct {
		in   string
		want int32
	}{
		{in: "1", want: 1},
		{in: `"1"`, want: 1},
		{in: "2", want: 2},
		{in: `"42"`, want: 42},
		{in: "2147483647", want: 2147483647},
		{in: `"2147483647"`, want: 2147483647},
	}
	for _, tc := range validCases {
		got, ok := httpx.ParseVersionIfMatch(tc.in)
		if !ok || got != tc.want {
			t.Fatalf("ParseVersionIfMatch(%q) = (%d, %v), want (%d, true)", tc.in, got, ok, tc.want)
		}
	}

	invalidCases := []string{
		"",
		`""`,
		"*",
		`"*"`,
		`W/"1"`,
		`w/"1"`,
		`"0"`,
		"0",
		`"01"`,
		"01",
		`"00"`,
		`"-1"`,
		"-1",
		`"+1"`,
		"+1",
		`"1", "2"`,
		`"1a"`,
		`"a1"`,
		`" 1"`,
		`"1 "`,
		" 1",
		"1 ",
		`"2147483648"`, // > math.MaxInt32
		"2147483648",
		`"99999999999999999999"`,
		`"` + validTestVaultKeyID + `:1"`, // vault ETag format is rejected for content version If-Match
	}
	for _, in := range invalidCases {
		if got, ok := httpx.ParseVersionIfMatch(in); ok {
			t.Fatalf("ParseVersionIfMatch(%q) = (%d, true), want (_, false)", in, got)
		}
	}
}

func TestParseVersionIfMatchFromRequestAndRequireVersionIfMatch428(t *testing.T) {
	cases := []struct {
		name    string
		headers []string
		wantVer int32
		wantOK  bool
	}{
		{name: "missing", headers: nil, wantOK: false},
		{name: "empty", headers: []string{""}, wantOK: false},
		{name: "wildcard", headers: []string{"*"}, wantOK: false},
		{name: "weak_upper", headers: []string{`W/"1"`}, wantOK: false},
		{name: "weak_lower", headers: []string{`w/"1"`}, wantOK: false},
		{name: "list_single_header", headers: []string{`"1", "2"`}, wantOK: false},
		{name: "list_multi_header", headers: []string{`"1"`, `"2"`}, wantOK: false},
		{name: "leading_zero", headers: []string{`"01"`}, wantOK: false},
		{name: "zero", headers: []string{`"0"`}, wantOK: false},
		{name: "negative", headers: []string{`"-1"`}, wantOK: false},
		{name: "overflow_int32", headers: []string{`"2147483648"`}, wantOK: false},
		{name: "vault_format", headers: []string{`"` + validTestVaultKeyID + `:1"`}, wantOK: false},
		{name: "unquoted", headers: []string{`1`}, wantOK: false},
		{name: "valid_1", headers: []string{`"1"`}, wantVer: 1, wantOK: true},
		{name: "valid_19", headers: []string{`"19"`}, wantVer: 19, wantOK: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			var parsedVer int32
			h := httpx.RequireVersionIfMatch(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				v, ok := httpx.ParseVersionIfMatchFromRequest(w, r)
				if !ok {
					return
				}
				parsedVer = v
				w.WriteHeader(http.StatusNoContent)
			}))

			req := httptest.NewRequest(http.MethodPut, "/api/v1/entries/00000000-0000-0000-0000-000000000001", nil)
			for _, hdr := range tc.headers {
				req.Header.Add(httpx.HeaderIfMatch, hdr)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if !tc.wantOK {
				if called {
					t.Fatalf("%s: handler must not be called for invalid If-Match", tc.name)
				}
				if rec.Code != http.StatusPreconditionRequired {
					t.Fatalf("%s: status = %d, want 428", tc.name, rec.Code)
				}
				prob := decodeProblem(t, rec)
				if prob.Code != "precondition_required" {
					t.Fatalf("%s: problem code = %q, want precondition_required", tc.name, prob.Code)
				}
				return
			}

			if !called || rec.Code != http.StatusNoContent || parsedVer != tc.wantVer {
				t.Fatalf("%s: called=%v status=%d parsedVer=%d, want true/204/%d", tc.name, called, rec.Code, parsedVer, tc.wantVer)
			}
		})
	}
}
