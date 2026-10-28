package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
)

const (
	GrantTTL = 5 * time.Minute
	grantVer = 1
)

var ReauthActions = map[string]struct{}{
	"account.email_change": {}, "account.password_change": {},
	"account.identity_link": {}, "account.identity_unlink": {},
	"session.revoke_others": {},
	"vault.rewrap":          {}, "vault.recover": {},
	"vault.recovery_keys_regenerate": {}, "vault.recovery_keys_rotate": {},
	"vault.passkey_register": {}, "vault.passkey_revoke": {},
	"vault.reset": {}, "export.decrypted": {}, "account.delete": {},
}

func ValidReauthAction(action string) bool {
	_, ok := ReauthActions[action]
	return ok
}

type Grants struct {
	secret []byte
	clk    clock.Clock
}

func NewGrants(secret []byte, clk clock.Clock) *Grants {
	if clk == nil {
		clk = clock.System{}
	}
	return &Grants{secret: secret, clk: clk}
}

func (g *Grants) Issue(p authctx.Principal, action string) (ReauthGrant, error) {
	if !ValidReauthAction(action) {
		return ReauthGrant{}, ErrInvalidRequest
	}
	now := g.clk.Now()
	exp := now.Add(GrantTTL)
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return ReauthGrant{}, err
	}
	raw := g.sign(p, action, now, exp, nonce)
	return ReauthGrant{Grant: raw, Action: action, ExpiresAt: exp}, nil
}

func (g *Grants) Verify(p authctx.Principal, action, token string) error {
	if !ValidReauthAction(action) || token == "" {
		return ErrReauthInvalid
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return ErrReauthInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return ErrReauthInvalid
	}
	mac, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(mac) != sha256.Size {
		return ErrReauthInvalid
	}
	fields := strings.Split(string(payload), "|")
	if len(fields) != 7 || fields[0] != "v1" {
		return ErrReauthInvalid
	}
	if fields[1] != p.UserID.String() || fields[2] != p.SessionID.String() || fields[3] != action {
		return ErrReauthInvalid
	}
	expUnix, ok := parseInt64(fields[5])
	if !ok {
		return ErrReauthInvalid
	}
	exp := time.Unix(expUnix, 0).UTC()
	now := g.clk.Now()
	if !now.Before(exp) { // now >= exp
		return ErrReauthInvalid
	}
	iatUnix, ok := parseInt64(fields[4])
	if !ok {
		return ErrReauthInvalid
	}
	if time.Unix(iatUnix, 0).UTC().After(now.Add(30 * time.Second)) {
		return ErrReauthInvalid
	}
	if exp.Sub(time.Unix(iatUnix, 0).UTC()) > GrantTTL {
		return ErrReauthInvalid
	}
	want := g.mac(p, action, time.Unix(iatUnix, 0).UTC(), exp, fields[6])
	if subtle.ConstantTimeCompare(mac, want) != 1 {
		return ErrReauthInvalid
	}
	return nil
}

// VerifiedExpiry kiểm grant rồi trả exp đã ký — dùng để gắn deadline vào OAuth link.
func (g *Grants) VerifiedExpiry(p authctx.Principal, action, token string) (time.Time, error) {
	if err := g.Verify(p, action, token); err != nil {
		return time.Time{}, err
	}
	parts := strings.Split(token, ".")
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return time.Time{}, ErrReauthInvalid
	}
	fields := strings.Split(string(payload), "|")
	if len(fields) != 7 {
		return time.Time{}, ErrReauthInvalid
	}
	expUnix, ok := parseInt64(fields[5])
	if !ok {
		return time.Time{}, ErrReauthInvalid
	}
	return time.Unix(expUnix, 0).UTC(), nil
}

func (g *Grants) sign(p authctx.Principal, action string, iat, exp time.Time, nonce []byte) string {
	n := base64.RawURLEncoding.EncodeToString(nonce)
	payload := strings.Join([]string{
		"v1", p.UserID.String(), p.SessionID.String(), action,
		formatInt64(iat.Unix()), formatInt64(exp.Unix()), n,
	}, "|")
	mac := g.mac(p, action, iat, exp, n)
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(mac)
}

func (g *Grants) mac(p authctx.Principal, action string, iat, exp time.Time, nonce string) []byte {
	m := hmac.New(sha256.New, g.secret)
	m.Write([]byte("sabk.reauth.v1"))
	m.Write([]byte{0})
	m.Write(p.UserID[:])
	m.Write(p.SessionID[:])
	m.Write([]byte(action))
	var b [16]byte
	binary.BigEndian.PutUint64(b[0:8], uint64(iat.Unix()))
	binary.BigEndian.PutUint64(b[8:16], uint64(exp.Unix()))
	m.Write(b[:])
	m.Write([]byte(nonce))
	return m.Sum(nil)
}

func MustParseUUID(s string) uuid.UUID {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil
	}
	return id
}
