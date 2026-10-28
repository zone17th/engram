package oauth_test

import (
	"context"
	"testing"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth/oauth"
)

func TestFakePKCERejectsWrongVerifier(t *testing.T) {
	id := oauth.Identity{Provider: "google", UID: "1", Email: "a@example.com", EmailVerified: true}
	f := oauth.NewFake("google", false, id)
	v, err := oauth.NewPKCEVerifier()
	if err != nil {
		t.Fatal(err)
	}
	ch := oauth.PKCEChallenge(v)
	code := f.IssueCode("state-1", ch, "nonce")
	if _, err := f.Exchange(context.Background(), oauth.ExchangeRequest{Code: code, CodeVerifier: "wrong-verifier"}); err == nil {
		t.Fatal("PKCE sai phải fail")
	}
	code2 := f.IssueCode("state-2", ch, "nonce")
	got, err := f.Exchange(context.Background(), oauth.ExchangeRequest{Code: code2, CodeVerifier: v, Nonce: "nonce"})
	if err != nil {
		t.Fatal(err)
	}
	if got.UID != "1" || !got.EmailVerified {
		t.Fatalf("%+v", got)
	}
}
