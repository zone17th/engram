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

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
)

const (
	CSRFKindSession = "sess"
	CSRFKindAnon    = "anon"
	AnonTTL         = 10 * time.Minute
	csrfVersion     = 1
)

type CSRF struct {
	secret []byte
	clk    clock.Clock
}

func NewCSRF(secret []byte, clk clock.Clock) *CSRF {
	if clk == nil {
		clk = clock.System{}
	}
	return &CSRF{secret: secret, clk: clk}
}

type CSRFToken struct {
	Kind    string
	Subject string
	Nonce   string
	Expiry  time.Time
	Raw     string
}

func (c *CSRF) Issue(kind, subject string, ttl time.Duration) (CSRFToken, error) {
	if ttl <= 0 {
		ttl = AnonTTL
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return CSRFToken{}, err
	}
	n := base64.RawURLEncoding.EncodeToString(nonce)
	exp := c.clk.Now().Add(ttl)
	raw := c.sign(kind, subject, n, exp)
	return CSRFToken{Kind: kind, Subject: subject, Nonce: n, Expiry: exp, Raw: raw}, nil
}

func (c *CSRF) Parse(raw string) (CSRFToken, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 2 {
		return CSRFToken{}, ErrCSRFInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(payload) < 2 {
		return CSRFToken{}, ErrCSRFInvalid
	}
	mac, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(mac) != sha256.Size {
		return CSRFToken{}, ErrCSRFInvalid
	}
	fields := strings.Split(string(payload), "|")
	if len(fields) != 5 || fields[0] != "v1" {
		return CSRFToken{}, ErrCSRFInvalid
	}
	kind, subject, nonce, expStr := fields[1], fields[2], fields[3], fields[4]
	if kind != CSRFKindSession && kind != CSRFKindAnon {
		return CSRFToken{}, ErrCSRFInvalid
	}
	expUnix, ok := parseInt64(expStr)
	if !ok {
		return CSRFToken{}, ErrCSRFInvalid
	}
	exp := time.Unix(expUnix, 0).UTC()
	want := c.mac(kind, subject, nonce, exp)
	if subtle.ConstantTimeCompare(mac, want) != 1 {
		return CSRFToken{}, ErrCSRFInvalid
	}
	if !exp.After(c.clk.Now()) {
		return CSRFToken{}, ErrCSRFInvalid
	}
	return CSRFToken{Kind: kind, Subject: subject, Nonce: nonce, Expiry: exp, Raw: raw}, nil
}

// Verify so cookie và header (constant-time) rồi kiểm subject.
func (c *CSRF) Verify(cookie, header, expectKind, expectSubject string) error {
	if cookie == "" || header == "" {
		return ErrCSRFInvalid
	}
	if subtle.ConstantTimeCompare([]byte(cookie), []byte(header)) != 1 {
		return ErrCSRFInvalid
	}
	tok, err := c.Parse(cookie)
	if err != nil {
		return err
	}
	if tok.Kind != expectKind || tok.Subject != expectSubject {
		return ErrCSRFInvalid
	}
	return nil
}

// ReuseIfValid giữ token còn hạn đúng kind/subject — không rotate nonce mỗi GET.
func (c *CSRF) ReuseIfValid(raw, kind, subject string) (CSRFToken, bool) {
	tok, err := c.Parse(raw)
	if err != nil {
		return CSRFToken{}, false
	}
	if tok.Kind != kind || tok.Subject != subject {
		return CSRFToken{}, false
	}
	return tok, true
}

func (c *CSRF) sign(kind, subject, nonce string, exp time.Time) string {
	payload := "v1|" + kind + "|" + subject + "|" + nonce + "|" + formatInt64(exp.Unix())
	mac := c.mac(kind, subject, nonce, exp)
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(mac)
}

func (c *CSRF) mac(kind, subject, nonce string, exp time.Time) []byte {
	m := hmac.New(sha256.New, c.secret)
	m.Write([]byte("sabk.csrf.v1"))
	m.Write([]byte{0})
	m.Write([]byte(kind))
	m.Write([]byte{0})
	m.Write([]byte(subject))
	m.Write([]byte{0})
	m.Write([]byte(nonce))
	m.Write([]byte{0})
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], uint64(exp.Unix()))
	m.Write(b[:])
	return m.Sum(nil)
}

func parseInt64(s string) (int64, bool) {
	var n int64
	if s == "" {
		return 0, false
	}
	neg := false
	if s[0] == '-' {
		neg = true
		s = s[1:]
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, false
		}
		n = n*10 + int64(r-'0')
	}
	if neg {
		n = -n
	}
	return n, true
}

func formatInt64(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func NewAnonNonce() (string, error) {
	_, enc, err := NewOpaqueToken()
	return enc, err
}
