package compose_test

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/worker"
)

const canarySMTPPassword = "canary-smtp-pw-91c2"

func secretB64(seed byte) string {
	b := make([]byte, 32)
	for i := range b {
		b[i] = seed + byte(i)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func loadProd(t *testing.T, extra map[string]string) *config.Config {
	t.Helper()
	env := map[string]string{
		"DATABASE_URL":                  "postgres://engram:engram@127.0.0.1:1/engram?sslmode=disable",
		"APP_ENV":                       "production",
		"APP_ORIGIN":                    "https://engram.example",
		"AUTH_JWT_SECRET":               secretB64(1),
		"AUTH_CSRF_SECRET":              secretB64(40),
		"AUTH_REAUTH_SECRET":            secretB64(80),
		"AUTH_IP_PEPPER":                secretB64(120),
		"AUTH_EMAIL_PEPPER":             secretB64(160),
		"EXPORT_AT_REST_SECRET":         secretB64(200),
		"AUTH_MAIL_SINK_DIR":            "",
		"AUTH_MAIL_CAPTURE_AS_DELIVERY": "false",
	}
	for k, v := range extra {
		env[k] = v
	}
	for k, v := range env {
		t.Setenv(k, v)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return cfg
}

func smtpEnv() map[string]string {
	return map[string]string{
		"SMTP_HOST":     "smtp.example.net",
		"SMTP_PORT":     "587",
		"SMTP_USERNAME": "mailer",
		"SMTP_PASSWORD": canarySMTPPassword,
		"SMTP_FROM":     "engram <no-reply@engram.example>",
		"SMTP_TLS_MODE": "starttls",
	}
}

func TestNewMailer(t *testing.T) {
	t.Run("smtp_when_host_set_same_adapter_for_api_and_worker", func(t *testing.T) {
		cfg := loadProd(t, smtpEnv())
		api, err := compose.NewMailer(cfg, nil)
		if err != nil {
			t.Fatal(err)
		}
		wk, err := worker.NewWorkerMailer(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := api.(*auth.SMTPMailer); !ok {
			t.Fatalf("api mailer = %T, want *auth.SMTPMailer", api)
		}
		if _, ok := wk.(*auth.SMTPMailer); !ok {
			t.Fatalf("worker mailer = %T, want *auth.SMTPMailer", wk)
		}
		if !compose.MailDeliveryCapable(api) {
			t.Fatal("SMTP mailer must be delivery capable")
		}
		if s := fmt.Sprintf("%v %+v %s", cfg.Redacted(), cfg, cfg); strings.Contains(s, canarySMTPPassword) {
			t.Fatal("config rendering leaks SMTP_PASSWORD")
		}
	})
	t.Run("sink_in_development", func(t *testing.T) {
		cfg := &config.Config{Env: "development", MailSinkDir: t.TempDir()}
		m, err := compose.NewMailer(cfg, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := m.(*auth.SinkMailer); !ok {
			t.Fatalf("dev mailer = %T, want *auth.SinkMailer", m)
		}
	})
	t.Run("noop_otherwise", func(t *testing.T) {
		cfg := loadProd(t, nil)
		for name, build := range map[string]func() (auth.Mailer, error){
			"api":    func() (auth.Mailer, error) { return compose.NewMailer(cfg, nil) },
			"worker": func() (auth.Mailer, error) { return worker.NewWorkerMailer(cfg) },
		} {
			m, err := build()
			if err != nil {
				t.Fatal(err)
			}
			if _, ok := m.(*auth.NoopMailer); !ok || compose.MailDeliveryCapable(m) {
				t.Fatalf("%s mailer = %T, want NoopMailer without delivery", name, m)
			}
		}
	})
}

// APP_ENV=production without SMTP_HOST must boot (no "missing mail adapter")
// and report mail_delivery_available=false; with SMTP it reports true and
// delivers verification mail to the SMTP sink.
func TestProductionBootNoSMTP(t *testing.T) {
	for name, extra := range map[string]map[string]string{"no_smtp": nil, "smtp": smtpEnv()} {
		t.Run(name, func(t *testing.T) {
			cfg := loadProd(t, extra)
			pool, err := pgxpool.New(context.Background(), cfg.DatabaseURL)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			svc, _, api, err := compose.NewAuth(cfg, pool, nil, nil, nil, nil)
			if err != nil {
				t.Fatalf("NewAuth in production: %v", err)
			}
			t.Cleanup(svc.Close)
			want := name == "smtp"
			if got := svc.MailDeliveryAvailable(); got != want {
				t.Fatalf("mail_delivery_available = %v, want %v", got, want)
			}
			authn, csrfv, reauth := compose.Adapters(svc)
			r := httpx.NewRouter(httpx.Deps{
				Config: cfg, Logger: obs.NewLogger("error", "test"),
				Authenticator: authn, CSRF: csrfv, Reauth: reauth,
				MountAPI: authhttp.Mount(api),
			})
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/config", nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("GET /api/v1/auth/config = %d", rec.Code)
			}
			var body struct {
				MailDeliveryAvailable bool `json:"mail_delivery_available"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.MailDeliveryAvailable != want {
				t.Fatalf("/auth/config body = %s, want mail_delivery_available=%v", rec.Body.String(), want)
			}
		})
	}

	t.Run("api_and_worker_boot_and_verify_mail_delivered", func(t *testing.T) {
		dsn := dbtest.StartPostgres(t)
		dbtest.MigrateUp(t, dsn)
		pool := dbtest.Pool(t, dsn)
		ctx := context.Background()

		// Without SMTP_HOST: api + worker boot cleanly in APP_ENV=production.
		cfgNoSMTP := loadProd(t, map[string]string{"DATABASE_URL": dsn})
		cfgNoSMTP.ShutdownTimeout = 5 * time.Second
		stopNoSMTP, doneNoSMTP := startWorker(t, ctx, cfgNoSMTP)
		svcNo, _, _, err := compose.NewAuth(cfgNoSMTP, pool, nil, nil, nil, nil)
		if err != nil || svcNo.MailDeliveryAvailable() {
			t.Fatalf("no-SMTP boot: err=%v available=%v", err, svcNo.MailDeliveryAvailable())
		}
		svcNo.Close()
		stopNoSMTP()
		if err := <-doneNoSMTP; err != nil {
			t.Fatalf("worker (no SMTP) exit: %v", err)
		}

		// With SMTP_HOST: api + worker boot and verification mail lands in the sink.
		port, certFile, messages := startSTARTTLSSink(t)
		cfgSMTP := loadProd(t, map[string]string{
			"DATABASE_URL":  dsn,
			"SSL_CERT_FILE": certFile,
			"SMTP_HOST":     "127.0.0.1",
			"SMTP_PORT":     strconv.Itoa(port),
			"SMTP_FROM":     "engram <no-reply@engram.example>",
			"SMTP_TLS_MODE": "starttls",
		})
		cfgSMTP.ShutdownTimeout = 5 * time.Second
		stopSMTP, doneSMTP := startWorker(t, ctx, cfgSMTP)
		svc, _, _, err := compose.NewAuth(cfgSMTP, pool, nil, nil, nil, nil)
		if err != nil || !svc.MailDeliveryAvailable() {
			t.Fatalf("SMTP boot: err=%v available=%v", err, svc.MailDeliveryAvailable())
		}
		defer svc.Close()
		_, issued, err := svc.Signup(ctx, auth.SignupInput{Email: "prod-verify@example.org", Password: "correcthorse"})
		if err != nil {
			t.Fatalf("Signup: %v", err)
		}
		if err := svc.SendVerifyCurrent(ctx, issued.Principal); err != nil {
			t.Fatalf("SendVerifyCurrent: %v", err)
		}
		msgs := messages()
		if len(msgs) != 1 || !strings.Contains(msgs[0], "https://engram.example/app/auth/verify-email#token=") {
			t.Fatalf("verify mail at SMTP sink = %q", msgs)
		}
		stopSMTP()
		if err := <-doneSMTP; err != nil {
			t.Fatalf("worker (SMTP) exit: %v", err)
		}
	})
}

func startWorker(t *testing.T, ctx context.Context, cfg *config.Config) (context.CancelFunc, <-chan error) {
	t.Helper()
	wctx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		done <- worker.Run(wctx, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	}()
	t.Cleanup(cancel)
	return cancel, done
}

func startSTARTTLSSink(t *testing.T) (port int, certFile string, messages func() []string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
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
	certFile = filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	tlsCfg := &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	var mu sync.Mutex
	var msgs []string
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(20 * time.Second))
				r := bufio.NewReader(c)
				w := func(l string) { _, _ = c.Write([]byte(l + "\r\n")) }
				w("220 sink")
				tlsDone := false
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					up := strings.ToUpper(strings.TrimRight(line, "\r\n"))
					switch {
					case strings.HasPrefix(up, "EHLO"), strings.HasPrefix(up, "HELO"):
						if !tlsDone {
							w("250-sink\r\n250 STARTTLS")
						} else {
							w("250 sink")
						}
					case up == "STARTTLS":
						w("220 go")
						tc := tls.Server(c, tlsCfg)
						if tc.Handshake() != nil {
							return
						}
						c, r, tlsDone = tc, bufio.NewReader(tc), true
					case strings.HasPrefix(up, "MAIL FROM"), strings.HasPrefix(up, "RCPT TO"):
						w("250 ok")
					case up == "DATA":
						w("354 go")
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
						mu.Lock()
						msgs = append(msgs, b.String())
						mu.Unlock()
						w("250 queued")
					case up == "QUIT":
						w("221 bye")
						return
					default:
						w("502 no")
					}
				}
			}(c)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, certFile, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), msgs...)
	}
}
