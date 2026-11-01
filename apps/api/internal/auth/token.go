package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/clock"
)

const (
	AccessTTL          = 10 * time.Minute
	SessionTTL         = 30 * 24 * time.Hour
	RefreshBytes       = 32
	OpaqueTokenBytes   = 32
	jwtIatSkew         = 30 * time.Second
	accessCookieMaxAge = int(AccessTTL / time.Second)
	accessTokenVersion = 1
)

// AccessClaims là claim JWT allowlist HS256.
type AccessClaims struct {
	jwt.RegisteredClaims
	Version   int    `json:"ver"`
	SessionID string `json:"sid"`
}

type TokenIssuer struct {
	secret []byte
	iss    string
	aud    string
	clk    clock.Clock
}

func NewTokenIssuer(secret []byte, issuer, audience string, clk clock.Clock) *TokenIssuer {
	if clk == nil {
		clk = clock.System{}
	}
	return &TokenIssuer{secret: secret, iss: issuer, aud: audience, clk: clk}
}

// IssueAccess tạo JWT; exp = min(now+10m, sessionExpiresAt).
func (t *TokenIssuer) IssueAccess(userID, sessionID uuid.UUID, sessionExpiresAt time.Time) (string, time.Time, error) {
	now := t.clk.Now()
	exp := now.Add(AccessTTL)
	if sessionExpiresAt.Before(exp) {
		exp = sessionExpiresAt
	}
	if !exp.After(now) {
		return "", time.Time{}, ErrAccessExpired
	}
	jti, err := uuid.NewRandom()
	if err != nil {
		return "", time.Time{}, err
	}
	claims := AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    t.iss,
			Subject:   userID.String(),
			Audience:  jwt.ClaimStrings{t.aud},
			ExpiresAt: jwt.NewNumericDate(exp),
			IssuedAt:  jwt.NewNumericDate(now),
			ID:        jti.String(),
		},
		Version:   accessTokenVersion,
		SessionID: sessionID.String(),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString(t.secret)
	if err != nil {
		return "", time.Time{}, err
	}
	return signed, exp, nil
}

func (t *TokenIssuer) ParseAccess(token string) (userID, sessionID uuid.UUID, exp time.Time, err error) {
	now := t.clk.Now()
	parsed, parseErr := jwt.ParseWithClaims(token, &AccessClaims{}, func(tok *jwt.Token) (any, error) {
		if tok.Method != jwt.SigningMethodHS256 {
			return nil, ErrUnauthenticated
		}
		return t.secret, nil
	}, jwt.WithIssuer(t.iss), jwt.WithAudience(t.aud), jwt.WithExpirationRequired(), jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithTimeFunc(func() time.Time { return now }))
	if parsed == nil {
		return uuid.Nil, uuid.Nil, time.Time{}, ErrUnauthenticated
	}
	claims, ok := parsed.Claims.(*AccessClaims)
	if !ok {
		return uuid.Nil, uuid.Nil, time.Time{}, ErrUnauthenticated
	}
	userID, sessionID, ok = t.accessClaimValues(claims, now)
	if !ok {
		return uuid.Nil, uuid.Nil, time.Time{}, ErrUnauthenticated
	}
	if parseErr != nil {
		if t.isExpired(parseErr) {
			return uuid.Nil, uuid.Nil, time.Time{}, ErrAccessExpired
		}
		return uuid.Nil, uuid.Nil, time.Time{}, ErrUnauthenticated
	}
	if !parsed.Valid || !claims.ExpiresAt.After(now) {
		return uuid.Nil, uuid.Nil, time.Time{}, ErrUnauthenticated
	}
	return userID, sessionID, claims.ExpiresAt.Time, nil
}

func (t *TokenIssuer) accessClaimValues(claims *AccessClaims, now time.Time) (userID, sessionID uuid.UUID, ok bool) {
	if claims.Version != accessTokenVersion || claims.Issuer == "" || claims.Issuer != t.iss ||
		t.aud == "" || !hasAudience(claims.Audience, t.aud) || claims.Subject == "" ||
		claims.SessionID == "" || claims.IssuedAt == nil || claims.ExpiresAt == nil || claims.ID == "" ||
		claims.IssuedAt.After(now.Add(jwtIatSkew)) {
		return uuid.Nil, uuid.Nil, false
	}
	userID, err := uuid.Parse(claims.Subject)
	if err != nil {
		return uuid.Nil, uuid.Nil, false
	}
	sessionID, err = uuid.Parse(claims.SessionID)
	if err != nil {
		return uuid.Nil, uuid.Nil, false
	}
	return userID, sessionID, true
}

func hasAudience(aud jwt.ClaimStrings, want string) bool {
	for _, got := range aud {
		if got == want {
			return true
		}
	}
	return false
}

func (t *TokenIssuer) isExpired(err error) bool {
	if err == nil || !errors.Is(err, jwt.ErrTokenExpired) {
		return false
	}
	for _, other := range []error{
		jwt.ErrTokenMalformed,
		jwt.ErrTokenUnverifiable,
		jwt.ErrTokenSignatureInvalid,
		jwt.ErrTokenRequiredClaimMissing,
		jwt.ErrTokenInvalidAudience,
		jwt.ErrTokenUsedBeforeIssued,
		jwt.ErrTokenInvalidIssuer,
		jwt.ErrTokenInvalidSubject,
		jwt.ErrTokenNotValidYet,
		jwt.ErrTokenInvalidId,
		jwt.ErrInvalidType,
	} {
		if errors.Is(err, other) {
			return false
		}
	}
	return true
}

// NewOpaqueToken trả raw 32 byte + dạng base64url để đưa vào cookie.
func NewOpaqueToken() (raw []byte, encoded string, err error) {
	raw = make([]byte, OpaqueTokenBytes)
	if _, err = rand.Read(raw); err != nil {
		return nil, "", err
	}
	return raw, base64.RawURLEncoding.EncodeToString(raw), nil
}

// ParseOpaqueToken chỉ nhận đúng 32 byte sau base64url.
func ParseOpaqueToken(encoded string) ([]byte, error) {
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) != OpaqueTokenBytes {
		return nil, ErrSessionInvalid
	}
	return raw, nil
}

func RefreshHash(raw []byte) []byte {
	return SHA256Bytes(raw)
}
