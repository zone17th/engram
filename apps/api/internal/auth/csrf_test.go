package auth_test

import (
	"testing"
	"time"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/auth"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
)

func TestCSRFRoundTripAndReject(t *testing.T) {
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	c := auth.NewCSRF(bytes32(9), clk)
	tok, err := c.Issue(auth.CSRFKindSession, "sid-1", 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Verify(tok.Raw, tok.Raw, auth.CSRFKindSession, "sid-1"); err != nil {
		t.Fatal(err)
	}
	if err := c.Verify(tok.Raw, tok.Raw+"x", auth.CSRFKindSession, "sid-1"); err != auth.ErrCSRFInvalid {
		t.Fatalf("header mismatch: %v", err)
	}
	if err := c.Verify(tok.Raw, tok.Raw, auth.CSRFKindSession, "sid-2"); err != auth.ErrCSRFInvalid {
		t.Fatalf("subject B với token A: %v", err)
	}
	if _, ok := c.ReuseIfValid(tok.Raw, auth.CSRFKindSession, "sid-1"); !ok {
		t.Fatal("nonce còn hạn phải reuse")
	}
	clk.Advance(11 * time.Minute)
	if err := c.Verify(tok.Raw, tok.Raw, auth.CSRFKindSession, "sid-1"); err != auth.ErrCSRFInvalid {
		t.Fatalf("hết hạn: %v", err)
	}
}

func TestCSRFAnonPrefixDiffers(t *testing.T) {
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	c := auth.NewCSRF(bytes32(9), clk)
	sess, err := c.Issue(auth.CSRFKindSession, "same", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Verify(sess.Raw, sess.Raw, auth.CSRFKindAnon, "same"); err != auth.ErrCSRFInvalid {
		t.Fatal("prefix session không dùng cho anon")
	}
}
