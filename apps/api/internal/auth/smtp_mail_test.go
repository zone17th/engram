package auth_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"log/slog"
	"math/big"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/audit"
	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/notification"
)

const fakeSMTPPassword = "fake-smtp-password-canary-7f3a"

// fakeSMTP is a minimal in-process SMTP server (STARTTLS / implicit TLS, AUTH
// PLAIN) for adapter tests. It never relays anything.
type fakeSMTP struct {
	t         *testing.T
	ln        net.Listener
	tlsCfg    *tls.Config
	implicit  bool
	noSTARTTL bool
	rcptReply string // e.g. "550 5.1.1 no such user <x@y>"; empty = 250
	stall     bool   // accept but never greet

	mu       sync.Mutex
	messages []string
	authOK   bool
	sawTLS   bool
}

func newTLSPair(t *testing.T) (*tls.Config, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		DNSNames:     []string{"localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA:         true, BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}, pool
}

func startFakeSMTP(t *testing.T, f *fakeSMTP) (port int) {
	t.Helper()
	f.t = t
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f.ln = ln
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func (f *fakeSMTP) serve(c net.Conn) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(20 * time.Second))
	isTLS := false
	if f.implicit {
		tc := tls.Server(c, f.tlsCfg)
		if tc.Handshake() != nil {
			return
		}
		c, isTLS = tc, true
	}
	if f.stall {
		_, _ = c.Read(make([]byte, 1))
		return
	}
	r := bufio.NewReader(c)
	w := func(s string) { _, _ = c.Write([]byte(s + "\r\n")) }
	w("220 fake ESMTP")
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.TrimRight(line, "\r\n")
		up := strings.ToUpper(cmd)
		switch {
		case strings.HasPrefix(up, "EHLO"), strings.HasPrefix(up, "HELO"):
			ext := []string{"250-fake"}
			if !isTLS && !f.noSTARTTL && !f.implicit {
				ext = append(ext, "250-STARTTLS")
			}
			ext = append(ext, "250 AUTH PLAIN")
			w(strings.Join(ext, "\r\n"))
		case up == "STARTTLS":
			w("220 go ahead")
			tc := tls.Server(c, f.tlsCfg)
			if tc.Handshake() != nil {
				return
			}
			c, isTLS = tc, true
			r = bufio.NewReader(c)
		case strings.HasPrefix(up, "AUTH PLAIN"):
			raw, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(cmd[len("AUTH PLAIN"):]))
			parts := bytes.Split(raw, []byte{0})
			f.mu.Lock()
			f.authOK = len(parts) == 3 && string(parts[1]) == "mailer" && string(parts[2]) == fakeSMTPPassword
			f.sawTLS = isTLS
			ok := f.authOK
			f.mu.Unlock()
			if !ok {
				w("535 5.7.8 bad credentials")
				continue
			}
			w("235 ok")
		case strings.HasPrefix(up, "MAIL FROM"):
			w("250 ok")
		case strings.HasPrefix(up, "RCPT TO"):
			if f.rcptReply != "" {
				w(f.rcptReply)
				continue
			}
			w("250 ok")
		case up == "DATA":
			w("354 send")
			var b strings.Builder
			for {
				l, err := r.ReadString('\n')
				if err != nil {
					return
				}
				if l == ".\r\n" {
					break
				}
				b.WriteString(l)
			}
			f.mu.Lock()
			f.messages = append(f.messages, b.String())
			f.mu.Unlock()
			w("250 queued")
		case up == "QUIT":
			w("221 bye")
			return
		default:
			w("502 unknown")
		}
	}
}

func newTestSMTPMailer(t *testing.T, port int, mode string, roots *x509.CertPool, logs *bytes.Buffer) *auth.SMTPMailer {
	t.Helper()
	m, err := auth.NewSMTPMailer(auth.SMTPConfig{
		Host: "127.0.0.1", Port: port, Username: "mailer", Password: fakeSMTPPassword,
		From: "engram <no-reply@engram.example>", TLSMode: mode,
		Logger:    slog.New(slog.NewTextHandler(logs, nil)),
		TLSConfig: &tls.Config{RootCAs: roots, ServerName: "localhost", MinVersion: tls.VersionTLS12},
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestSMTPMailerTLS(t *testing.T) {
	srvTLS, roots := newTLSPair(t)
	for _, mode := range []string{auth.SMTPTLSStartTLS, auth.SMTPTLSImplicit} {
		t.Run(mode, func(t *testing.T) {
			f := &fakeSMTP{tlsCfg: srvTLS, implicit: mode == auth.SMTPTLSImplicit}
			port := startFakeSMTP(t, f)
			var logs bytes.Buffer
			m := newTestSMTPMailer(t, port, mode, roots, &logs)
			if !m.MailDeliveryAvailable() {
				t.Fatal("SMTP mailer must report delivery available")
			}
			link := "https://engram.example/app/auth/verify-email#token=abc"
			if err := m.Send(context.Background(), "alice@example.org", "signup", link); err != nil {
				t.Fatalf("send: %v", err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if !f.authOK || !f.sawTLS {
				t.Fatalf("auth over TLS: authOK=%v sawTLS=%v", f.authOK, f.sawTLS)
			}
			if len(f.messages) != 1 || !strings.Contains(f.messages[0], link) || !strings.Contains(f.messages[0], "To: alice@example.org") {
				t.Fatalf("delivered messages = %q", f.messages)
			}
		})
	}

	t.Run("starttls_required_never_downgrades", func(t *testing.T) {
		f := &fakeSMTP{tlsCfg: srvTLS, noSTARTTL: true}
		port := startFakeSMTP(t, f)
		var logs bytes.Buffer
		m := newTestSMTPMailer(t, port, auth.SMTPTLSStartTLS, roots, &logs)
		err := m.Send(context.Background(), "alice@example.org", "signup", "x")
		if !auth.IsPermanentMailError(err) || !errors.Is(err, auth.ErrMailDeliveryUnavailable) {
			t.Fatalf("missing STARTTLS: err=%v, want permanent mail_delivery_unavailable", err)
		}
		if len(f.messages) != 0 || f.authOK {
			t.Fatal("credentials or mail sent without TLS")
		}
	})

	t.Run("untrusted_certificate_rejected", func(t *testing.T) {
		f := &fakeSMTP{tlsCfg: srvTLS}
		port := startFakeSMTP(t, f)
		var logs bytes.Buffer
		m := newTestSMTPMailer(t, port, auth.SMTPTLSStartTLS, x509.NewCertPool(), &logs)
		if err := m.Send(context.Background(), "alice@example.org", "signup", "x"); err == nil {
			t.Fatal("untrusted certificate accepted")
		}
		if f.authOK {
			t.Fatal("credentials sent to untrusted server")
		}
	})

	t.Run("permanent_5xx_and_transient_4xx_classified_without_leaks", func(t *testing.T) {
		for _, tc := range []struct {
			reply     string
			permanent bool
		}{
			{"550 5.1.1 <bob@victim.example> no such user", true},
			{"451 4.3.0 <bob@victim.example> try later", false},
		} {
			f := &fakeSMTP{tlsCfg: srvTLS, rcptReply: tc.reply}
			port := startFakeSMTP(t, f)
			var logs bytes.Buffer
			m := newTestSMTPMailer(t, port, auth.SMTPTLSStartTLS, roots, &logs)
			err := m.Send(context.Background(), "bob@victim.example", "signup", "x")
			if err == nil || auth.IsPermanentMailError(err) != tc.permanent {
				t.Fatalf("reply %q: err=%v permanent=%v, want permanent=%v", tc.reply, err, auth.IsPermanentMailError(err), tc.permanent)
			}
			out := err.Error() + logs.String()
			for _, secret := range []string{"bob@victim.example", "bob@", fakeSMTPPassword} {
				if strings.Contains(out, secret) {
					t.Fatalf("error/log leaks %q: %s", secret, out)
				}
			}
			if !strings.Contains(logs.String(), "recipient_domain=victim.example") {
				t.Fatalf("log must carry only the recipient domain: %s", logs.String())
			}
		}
	})

	t.Run("timeout_is_transient", func(t *testing.T) {
		f := &fakeSMTP{tlsCfg: srvTLS, stall: true}
		port := startFakeSMTP(t, f)
		var logs bytes.Buffer
		m := newTestSMTPMailer(t, port, auth.SMTPTLSStartTLS, roots, &logs)
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer cancel()
		start := time.Now()
		err := m.Send(ctx, "alice@example.org", "signup", "x")
		if err == nil || auth.IsPermanentMailError(err) {
			t.Fatalf("stalled server: err=%v, want transient", err)
		}
		if time.Since(start) > 5*time.Second {
			t.Fatal("ctx deadline not honoured")
		}
	})

	t.Run("header_injection_rejected", func(t *testing.T) {
		f := &fakeSMTP{tlsCfg: srvTLS}
		port := startFakeSMTP(t, f)
		var logs bytes.Buffer
		m := newTestSMTPMailer(t, port, auth.SMTPTLSStartTLS, roots, &logs)
		err := m.Send(context.Background(), "a@example.org\r\nBcc: x@evil.example", "signup", "x")
		if !auth.IsPermanentMailError(err) || len(f.messages) != 0 {
			t.Fatalf("CRLF recipient: err=%v messages=%d", err, len(f.messages))
		}
	})
}

func TestSMTPMailerRejectsBadConfig(t *testing.T) {
	for name, c := range map[string]auth.SMTPConfig{
		"no_host":  {Port: 587, From: "a@b.example"},
		"no_from":  {Host: "smtp.example", Port: 587},
		"bad_port": {Host: "smtp.example", Port: 0, From: "a@b.example"},
		"bad_mode": {Host: "smtp.example", Port: 587, From: "a@b.example", TLSMode: "ssl"},
		"crlf":     {Host: "smtp.example", Port: 587, From: "a@b.example\r\nBcc: x@y"},
	} {
		if _, err := auth.NewSMTPMailer(c); err == nil {
			t.Errorf("%s: config accepted", name)
		}
	}
}

// MAIL-CAP-P02: without a delivering adapter the three self-service mail
// routes refuse with mail_delivery_unavailable (HTTP 503) before any
// verification token row exists.
func TestMailDeliveryUnavailable(t *testing.T) {
	pool := semNewPool(t)
	clk := clock.NewFixed(time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC))
	sink, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for name, mailer := range map[string]auth.Mailer{"no_adapter": nil, "sink_not_delivery": sink} {
		t.Run(name, func(t *testing.T) {
			cfg := &config.Config{
				AppOrigin:        "http://localhost:3000",
				AuthJWTSecret:    bytes.Repeat([]byte{1}, 32),
				AuthCSRFSecret:   bytes.Repeat([]byte{2}, 32),
				AuthReauthSecret: bytes.Repeat([]byte{3}, 32),
				AuthIPPepper:     bytes.Repeat([]byte{4}, 32),
				AuthEmailPepper:  bytes.Repeat([]byte{5}, 32),
			}
			tokens := auth.NewTokenIssuer(cfg.AuthJWTSecret, cfg.JWTIssuer(), cfg.JWTAudience(), clk)
			sessions := auth.NewSessionStore(pool, tokens, clk)
			aud := audit.NewStore(pool)
			sessions.SetAuditor(aud)
			svc, err := auth.NewService(cfg, pool, sessions, auth.NewCSRF(cfg.AuthCSRFSecret, clk), tokens,
				auth.NewGrants(cfg.AuthReauthSecret, clk), auth.NewLockout(pool, clk), clk, aud,
				notification.NewStore(pool, nil), nil, mailer, nil)
			if err != nil {
				t.Fatal(err)
			}
			if svc.MailDeliveryAvailable() {
				t.Fatal("precondition: mail must be unavailable")
			}
			ctx := context.Background()
			_, issued, err := svc.Signup(ctx, auth.SignupInput{Email: "mailcap-" + name + "@example.com", Password: "correcthorse"})
			if err != nil {
				t.Fatal(err)
			}
			p := issued.Principal
			rows := func() int {
				var n int
				if err := pool.QueryRow(ctx, `SELECT count(*) FROM email_verification WHERE user_id = $1`, p.UserID).Scan(&n); err != nil {
					t.Fatal(err)
				}
				return n
			}
			before := rows()
			grant, err := svc.Grants().Issue(p, "account.email_change")
			if err != nil {
				t.Fatal(err)
			}
			calls := map[string]func() error{
				"SendVerifyCurrent":  func() error { return svc.SendVerifyCurrent(ctx, p) },
				"SendEnroll":         func() error { return svc.SendEnroll(ctx, p) },
				"RequestEmailChange": func() error { return svc.RequestEmailChange(ctx, p, "new-"+name+"@example.com", grant.Grant) },
			}
			for route, call := range calls {
				if err := call(); !errors.Is(err, auth.ErrMailDeliveryUnavailable) {
					t.Fatalf("%s: err=%v, want mail_delivery_unavailable", route, err)
				}
			}
			if after := rows(); after != before {
				t.Fatalf("token rows %d -> %d: refusal must happen before token creation", before, after)
			}
		})
	}
}
