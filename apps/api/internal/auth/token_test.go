package auth_test

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/clock"
)

func testIssuer(t *testing.T, clk clock.Clock) *auth.TokenIssuer {
	t.Helper()
	return auth.NewTokenIssuer(bytes32(1), "http://localhost:3000", "http://localhost:3000", clk)
}

func bytes32(v byte) []byte {
	b := make([]byte, 32)
	for i := range b {
		b[i] = v
	}
	return b
}

func TestAccessRoundTripAndCap(t *testing.T) {
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(now)
	iss := testIssuer(t, clk)
	uid, sid := uuid.MustParse("11111111-1111-1111-1111-111111111111"), uuid.MustParse("22222222-2222-2222-2222-222222222222")

	tok, exp, err := iss.IssueAccess(uid, sid, now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if !exp.Equal(now.Add(2 * time.Minute)) {
		t.Fatalf("access không được vượt hạn session: %v", exp)
	}
	gotU, gotS, gotExp, err := iss.ParseAccess(tok)
	if err != nil {
		t.Fatal(err)
	}
	if gotU != uid || gotS != sid || !gotExp.Equal(exp) {
		t.Fatalf("claims lệch: %s %s %v", gotU, gotS, gotExp)
	}

	clk.Advance(2*time.Minute + time.Second)
	if _, _, _, err := iss.ParseAccess(tok); err != auth.ErrAccessExpired {
		t.Fatalf("hết hạn muốn access_expired, được %v", err)
	}
}

func TestRejectWrongAlgAndTamper(t *testing.T) {
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	iss := testIssuer(t, clk)
	uid, sid := uuid.New(), uuid.New()
	tok, _, err := iss.IssueAccess(uid, sid, clk.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(tok, ".")
	parts[2] = parts[2][:len(parts[2])-2] + "aa"
	if _, _, _, err := iss.ParseAccess(strings.Join(parts, ".")); err != auth.ErrUnauthenticated {
		t.Fatalf("tamper: %v", err)
	}

	other := auth.NewTokenIssuer(bytes32(2), "http://localhost:3000", "http://localhost:3000", clk)
	if _, _, _, err := other.ParseAccess(tok); err != auth.ErrUnauthenticated {
		t.Fatalf("sai key: %v", err)
	}
}

func TestRejectMissingClaims(t *testing.T) {
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	iss := testIssuer(t, clk)
	claims := auth.AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "http://localhost:3000",
			Subject:   uuid.NewString(),
			Audience:  jwt.ClaimStrings{"http://localhost:3000"},
			ExpiresAt: jwt.NewNumericDate(clk.Now().Add(time.Minute)),
			IssuedAt:  jwt.NewNumericDate(clk.Now()),
			ID:        uuid.NewString(),
		},
		Version:   1,
		SessionID: uuid.NewString(),
	}
	for name, mutate := range map[string]func(*auth.AccessClaims){
		"version": func(c *auth.AccessClaims) { c.Version = 0 },
		"subject": func(c *auth.AccessClaims) { c.Subject = "" },
		"session": func(c *auth.AccessClaims) { c.SessionID = "" },
		"iat":     func(c *auth.AccessClaims) { c.IssuedAt = nil },
		"exp":     func(c *auth.AccessClaims) { c.ExpiresAt = nil },
		"jti":     func(c *auth.AccessClaims) { c.ID = "" },
	} {
		t.Run(name, func(t *testing.T) {
			got := claims
			mutate(&got)
			if _, _, _, err := iss.ParseAccess(signAccessClaims(t, got, bytes32(1))); err != auth.ErrUnauthenticated {
				t.Fatalf("missing %s: %v", name, err)
			}
		})
	}
}

func TestExpiredClassificationRequiresValidToken(t *testing.T) {
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(now)
	iss := testIssuer(t, clk)
	base := auth.AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "http://localhost:3000",
			Subject:   uuid.NewString(),
			Audience:  jwt.ClaimStrings{"http://localhost:3000"},
			ExpiresAt: jwt.NewNumericDate(now.Add(-time.Minute)),
			IssuedAt:  jwt.NewNumericDate(now.Add(-2 * time.Minute)),
			ID:        uuid.NewString(),
		},
		Version:   1,
		SessionID: uuid.NewString(),
	}

	t.Run("valid expired", func(t *testing.T) {
		if _, _, _, err := iss.ParseAccess(signAccessClaims(t, base, bytes32(1))); err != auth.ErrAccessExpired {
			t.Fatalf("expired: %v", err)
		}
	})

	t.Run("wrong issuer expired", func(t *testing.T) {
		claims := base
		claims.Issuer = "http://evil.example"
		if _, _, _, err := iss.ParseAccess(signAccessClaims(t, claims, bytes32(1))); err != auth.ErrUnauthenticated {
			t.Fatalf("wrong issuer: %v", err)
		}
	})

	t.Run("wrong version expired", func(t *testing.T) {
		claims := base
		claims.Version = 2
		if _, _, _, err := iss.ParseAccess(signAccessClaims(t, claims, bytes32(1))); err != auth.ErrUnauthenticated {
			t.Fatalf("wrong version: %v", err)
		}
	})

	t.Run("tampered expired", func(t *testing.T) {
		parts := strings.Split(signAccessClaims(t, base, bytes32(1)), ".")
		parts[2] = strings.Repeat("A", len(parts[2]))
		if _, _, _, err := iss.ParseAccess(strings.Join(parts, ".")); err != auth.ErrUnauthenticated {
			t.Fatalf("tampered: %v", err)
		}
	})
}

func signAccessClaims(t *testing.T, claims auth.AccessClaims, secret []byte) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func TestFutureIATRejected(t *testing.T) {
	now := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFixed(now)
	iss := testIssuer(t, clk)
	uid, sid := uuid.New(), uuid.New()
	tok, _, err := iss.IssueAccess(uid, sid, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	clk.Set(now.Add(-2 * time.Minute))
	if _, _, _, err := iss.ParseAccess(tok); err != auth.ErrUnauthenticated {
		t.Fatalf("iat tương lai: %v", err)
	}
}

func TestOpaqueRefreshRoundTrip(t *testing.T) {
	raw, enc, err := auth.NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != 32 {
		t.Fatalf("len=%d", len(raw))
	}
	got, err := auth.ParseOpaqueToken(enc)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(raw) {
		t.Fatal("round-trip lệch")
	}
	if _, err := auth.ParseOpaqueToken("short"); err == nil {
		t.Fatal("encoding sai phải reject")
	}
	if _, err := auth.ParseOpaqueToken(enc + "A"); err == nil {
		t.Fatal("length sai phải reject")
	}
}
