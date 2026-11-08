package compose_test

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
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
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
		port, certFile, messages := startSMTPSink(t, false)
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

		// Also boot the actual cmd/api and cmd/worker binaries as OS processes in
		// APP_ENV=production (absent and present SMTP_HOST), query /api/v1/auth/config
		// over HTTP, and verify clean exit (R1-03).
		binDir := t.TempDir()
		apiBin := filepath.Join(binDir, "api")
		workerBin := filepath.Join(binDir, "worker")
		for _, target := range [][2]string{{apiBin, "../../cmd/api"}, {workerBin, "../../cmd/worker"}} {
			cmd := exec.Command("go", "build", "-o", target[0], target[1])
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("go build %s: %v\n%s", target[1], err, out)
			}
		}
		countTokens := func() int {
			var n int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM email_verification`).Scan(&n); err != nil {
				t.Fatal(err)
			}
			return n
		}
		iport, icertFile, imessages := startSMTPSink(t, true)
		t.Run("binary_no_smtp_host_boots_and_refuses_mail", func(t *testing.T) {
			assertCmdBinariesBoot(t, apiBin, workerBin, dsn, binarySMTP{}, false, nil, countTokens, "binary-nosmtp@example.org")
		})
		t.Run("binary_starttls_delivers", func(t *testing.T) {
			assertCmdBinariesBoot(t, apiBin, workerBin, dsn, binarySMTP{host: "127.0.0.1", port: port, certFile: certFile, tlsMode: "starttls"}, true, messages, countTokens, "binary-starttls@example.org")
		})
		t.Run("binary_implicit_tls_delivers", func(t *testing.T) {
			assertCmdBinariesBoot(t, apiBin, workerBin, dsn, binarySMTP{host: "127.0.0.1", port: iport, certFile: icertFile, tlsMode: "implicit"}, true, imessages, countTokens, "binary-implicit@example.org")
		})
		for _, tc := range incompleteSMTPCases {
			t.Run("binary_rejects_"+tc.name, func(t *testing.T) {
				for _, bin := range []string{apiBin, workerBin} {
					env := prodBinaryEnv(dsn, freeLocalAddr(t))
					for k, v := range tc.env {
						env = append(env, k+"="+v)
					}
					ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					cmd := exec.CommandContext(ctx, bin)
					cmd.Env = env
					out, err := cmd.CombinedOutput()
					timedOut := ctx.Err() != nil
					cancel()
					var exitErr *exec.ExitError
					if timedOut || !errors.As(err, &exitErr) || exitErr.ExitCode() == 0 || !strings.Contains(string(out), tc.want) {
						t.Fatalf("%s with %s: err=%v timedOut=%v, want nonzero exit naming %s; out=%s", filepath.Base(bin), tc.name, err, timedOut, tc.want, out)
					}
					t.Logf("%s rejected %s: exit=%d", filepath.Base(bin), tc.name, exitErr.ExitCode())
				}
			})
		}
	})
}

// incompleteSMTPCases are production SMTP configurations that config.Load must
// reject, so api and worker fail closed at startup instead of booting without mail.
var incompleteSMTPCases = []struct {
	name string
	env  map[string]string
	want string
}{
	{"missing_from", map[string]string{"SMTP_HOST": "smtp.invalid", "SMTP_FROM": ""}, "SMTP_FROM"},
	{"username_without_password", map[string]string{"SMTP_HOST": "smtp.invalid", "SMTP_FROM": "engram <no-reply@engram.example>", "SMTP_USERNAME": "mailer"}, "SMTP_PASSWORD"},
	{"password_without_username", map[string]string{"SMTP_HOST": "smtp.invalid", "SMTP_FROM": "engram <no-reply@engram.example>", "SMTP_PASSWORD": "pw-only-test"}, "SMTP_USERNAME"},
	{"tls_mode_none", map[string]string{"SMTP_HOST": "smtp.invalid", "SMTP_FROM": "engram <no-reply@engram.example>", "SMTP_TLS_MODE": "none"}, "SMTP_TLS_MODE"},
}

type binarySMTP struct {
	host     string
	port     int
	certFile string
	tlsMode  string
}

func prodBinaryEnv(dsn, httpAddr string) []string {
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"APP_ENV=production",
		"DATABASE_URL=" + dsn,
		"HTTP_ADDR=" + httpAddr,
		"WORKER_METRICS_ADDR=",
		"APP_ORIGIN=https://engram.example",
		"AUTH_MAIL_SINK_DIR=",
		"AUTH_MAIL_CAPTURE_AS_DELIVERY=false",
		"AUTH_FAKE_OAUTH=false",
		"SEARCH_SEMANTIC_ENABLED=false",
		"EMBEDDING_PROVIDER=noop",
		"SHUTDOWN_TIMEOUT=5s",
	}
	for i, k := range []string{
		"AUTH_JWT_SECRET", "AUTH_CSRF_SECRET", "AUTH_REAUTH_SECRET",
		"AUTH_IP_PEPPER", "AUTH_EMAIL_PEPPER", "EXPORT_AT_REST_SECRET",
	} {
		env = append(env, k+"="+secretB64(byte(i*35+1)))
	}
	return env
}

func freeLocalAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

func assertCmdBinariesBoot(t *testing.T, apiBin, workerBin, dsn string, smtp binarySMTP, wantMail bool, messages func() []string, countTokens func() int, email string) {
	t.Helper()
	httpAddr := freeLocalAddr(t)
	env := prodBinaryEnv(dsn, httpAddr)
	if smtp.host != "" {
		env = append(env,
			"SSL_CERT_FILE="+smtp.certFile,
			"SMTP_HOST="+smtp.host,
			"SMTP_PORT="+strconv.Itoa(smtp.port),
			"SMTP_FROM=engram <no-reply@engram.example>",
			"SMTP_TLS_MODE="+smtp.tlsMode,
		)
	}
	apiCmd := exec.Command(apiBin)
	apiCmd.Env = env
	var apiOut bytes.Buffer
	apiCmd.Stdout = &apiOut
	apiCmd.Stderr = &apiOut
	if err := apiCmd.Start(); err != nil {
		t.Fatalf("start api binary: %v", err)
	}
	defer func() { _ = apiCmd.Process.Kill() }()

	workerCmd := exec.Command(workerBin)
	workerCmd.Env = env
	rw := &readyLogWriter{ready: make(chan struct{})}
	var workerOut bytes.Buffer
	workerCmd.Stdout = io.MultiWriter(&workerOut, rw)
	workerCmd.Stderr = io.MultiWriter(&workerOut, rw)
	if err := workerCmd.Start(); err != nil {
		t.Fatalf("start worker binary: %v", err)
	}
	defer func() { _ = workerCmd.Process.Kill() }()

	select {
	case <-rw.ready:
	case <-time.After(15 * time.Second):
		t.Fatalf("worker binary did not log ready; out=%s", workerOut.String())
	}

	client := &http.Client{Timeout: 2 * time.Second}
	readyURL := "http://" + httpAddr + "/api/v1/readyz"
	deadline := time.Now().Add(15 * time.Second)
	for {
		resp, err := client.Get(readyURL)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("api binary did not become ready at %s; out=%s", readyURL, apiOut.String())
		}
		time.Sleep(100 * time.Millisecond)
	}

	cfgResp, err := client.Get("http://" + httpAddr + "/api/v1/auth/config")
	if err != nil {
		t.Fatalf("GET /api/v1/auth/config from api binary: %v", err)
	}
	rawBody, _ := io.ReadAll(cfgResp.Body)
	_ = cfgResp.Body.Close()
	var cfgBody struct {
		MailDeliveryAvailable bool `json:"mail_delivery_available"`
	}
	if cfgResp.StatusCode != http.StatusOK || json.Unmarshal(rawBody, &cfgBody) != nil || cfgBody.MailDeliveryAvailable != wantMail {
		t.Fatalf("api binary /api/v1/auth/config: status=%d body=%s, want mail_delivery_available=%v", cfgResp.StatusCode, rawBody, wantMail)
	}

	if wantMail {
		beforeCount := len(messages())
		status, raw := httpSignupAndSendVerify(t, client, "http://"+httpAddr, email, nil)
		if status != http.StatusAccepted {
			t.Fatalf("POST /api/v1/auth/verify-email/send (%s): status=%d body=%s", smtp.tlsMode, status, raw)
		}
		afterMsgs := messages()
		if len(afterMsgs) != beforeCount+1 || !strings.Contains(afterMsgs[len(afterMsgs)-1], "https://engram.example/app/auth/verify-email#token=") {
			t.Fatalf("HTTP verify email via api binary (%s): messages=%d (before %d)", smtp.tlsMode, len(afterMsgs), beforeCount)
		}
		t.Logf("api+worker binaries (%s): mail_delivery_available=true, verify-email/send=202, SMTP sink received message", smtp.tlsMode)
	} else {
		var before int
		status, raw := httpSignupAndSendVerify(t, client, "http://"+httpAddr, email, func() { before = countTokens() })
		assertMailUnavailable(t, status, raw)
		if after := countTokens(); after != before {
			t.Fatalf("email_verification rows %d -> %d: token created despite 503", before, after)
		}
		t.Logf("api+worker binaries (no SMTP_HOST): mail_delivery_available=false, verify-email/send=503 mail_delivery_unavailable, email_verification rows unchanged (%d)", before)
	}

	for _, p := range []*exec.Cmd{apiCmd, workerCmd} {
		_ = p.Process.Signal(os.Interrupt)
		if err := p.Wait(); err != nil {
			t.Fatalf("binary exit (%s): %v", p.Path, err)
		}
	}
}

type readyLogWriter struct {
	once  sync.Once
	ready chan struct{}
}

func (w *readyLogWriter) Write(p []byte) (int, error) {
	if strings.Contains(string(p), "worker đang chạy") {
		w.once.Do(func() { close(w.ready) })
	}
	return len(p), nil
}

func startWorker(t *testing.T, ctx context.Context, cfg *config.Config) (context.CancelFunc, <-chan error) {
	t.Helper()
	wctx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	rw := &readyLogWriter{ready: make(chan struct{})}
	go func() {
		done <- worker.Run(wctx, cfg, slog.New(slog.NewJSONHandler(rw, nil)))
	}()
	t.Cleanup(cancel)
	select {
	case <-rw.ready:
	case err := <-done:
		t.Fatalf("worker exited before ready: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for worker.Run ready")
	}
	return cancel, done
}

func startSMTPSink(t *testing.T, implicit bool) (port int, certFile string, messages func() []string) {
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
				defer func() { _ = c.Close() }()
				_ = c.SetDeadline(time.Now().Add(20 * time.Second))
				tlsDone := false
				if implicit {
					tc := tls.Server(c, tlsCfg)
					if tc.Handshake() != nil {
						return
					}
					c, tlsDone = tc, true
				}
				r := bufio.NewReader(c)
				w := func(l string) { _, _ = c.Write([]byte(l + "\r\n")) }
				w("220 sink")
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

func assertMailUnavailable(t *testing.T, status int, raw []byte) {
	t.Helper()
	if status != http.StatusServiceUnavailable || !strings.Contains(string(raw), "mail_delivery_unavailable") {
		t.Fatalf("POST /api/v1/auth/verify-email/send: status=%d body=%s, want 503 mail_delivery_unavailable", status, raw)
	}
}

// httpSignupAndSendVerify signs up email over HTTP (CSRF + cookies), calls
// beforeSend (if any), then POSTs /api/v1/auth/verify-email/send and returns its
// status and body.
func httpSignupAndSendVerify(t *testing.T, client *http.Client, baseURL, email string, beforeSend func()) (int, []byte) {
	t.Helper()
	cookies := map[string]*http.Cookie{}
	doJSON := func(method, path, body string) (int, []byte) {
		var rdr io.Reader
		if body != "" {
			rdr = strings.NewReader(body)
		}
		req, err := http.NewRequest(method, baseURL+path, rdr)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", "https://engram.example")
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if c := cookies[authhttp.CookieCSRF]; c != nil {
			req.Header.Set("X-CSRF-Token", c.Value)
		}
		for _, c := range cookies {
			req.AddCookie(&http.Cookie{Name: c.Name, Value: c.Value})
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		raw, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		for _, c := range resp.Cookies() {
			if c.Value == "" {
				delete(cookies, c.Name)
			} else {
				cookies[c.Name] = c
			}
		}
		return resp.StatusCode, raw
	}
	if status, raw := doJSON(http.MethodGet, "/api/v1/auth/csrf", ""); status != http.StatusNoContent || cookies[authhttp.CookieCSRF] == nil {
		t.Fatalf("GET /api/v1/auth/csrf: status=%d body=%s", status, raw)
	}
	body, _ := json.Marshal(map[string]string{"email": email, "password": "correcthorsebatterystaple"})
	if status, raw := doJSON(http.MethodPost, "/api/v1/auth/signup", string(body)); status != http.StatusCreated {
		t.Fatalf("POST /api/v1/auth/signup: status=%d body=%s", status, raw)
	}
	if cookies[authhttp.CookieCSRF] == nil {
		t.Fatal("missing rotated sabk_csrf cookie after signup")
	}
	if beforeSend != nil {
		beforeSend()
	}
	return doJSON(http.MethodPost, "/api/v1/auth/verify-email/send", `{}`)
}

// TestProductionStackComposeSmoke boots the actual infra/docker-compose.yml api
// and worker containers on the cloud runner (OPS_CONFIG_COMPOSE_STACK_SMOKE=1)
// with APP_ENV=production, AUTH_MAIL_SINK_DIR=”, APP_ORIGIN=https://engram.example
// in both absent-SMTP and present-SMTP (Docker smtp-sink container) modes,
// verifies docker compose ps + /api/v1/auth/config (false/true), and observes
// verification mail delivery to the Docker SMTP sink container (R1-03).
func TestProductionStackComposeSmoke(t *testing.T) {
	if os.Getenv("OPS_CONFIG_COMPOSE_STACK_SMOKE") != "1" {
		t.Skip("skipping Compose stack production smoke (set OPS_CONFIG_COMPOSE_STACK_SMOKE=1 on cloud-runner)")
	}
	topOut, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Fatal(err)
	}
	repoRoot := strings.TrimSpace(string(topOut))
	tmpDir := t.TempDir()
	_ = os.Chmod(filepath.Dir(tmpDir), 0o755)
	if err := os.Chmod(tmpDir, 0o755); err != nil {
		t.Fatal(err)
	}
	mkdirCmd := exec.Command("mkdir", "-p", filepath.Join(repoRoot, ".data", "mail-sink"))
	if out, err := mkdirCmd.CombinedOutput(); err != nil {
		t.Fatalf("mkdir .data/mail-sink: %v\n%s", err, out)
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "smtp-sink"},
		DNSNames:     []string{"smtp-sink", "localhost"},
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
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "ca.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmpDir, "key.pem"), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o644); err != nil {
		t.Fatal(err)
	}

	sinkScript := `import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
const cert = fs.readFileSync("/tmp/smtp/ca.pem");
const key = fs.readFileSync("/tmp/smtp/key.pem");
const msgs = [];
const handle = (c, mode) => {
  let s = c, tlsDone = mode === "implicit", buf = "", inData = false, dataBuf = "";
  const send = (l) => s.write(l + "\r\n");
  const onLine = (line) => {
    if (inData) {
      if (line === ".") { inData = false; msgs.push({ mode, data: dataBuf }); dataBuf = ""; send("250 queued"); }
      else { dataBuf += line + "\n"; }
      return;
    }
    const up = line.toUpperCase();
    if (up.startsWith("EHLO") || up.startsWith("HELO")) send(tlsDone ? "250 sink" : "250-sink\r\n250 STARTTLS");
    else if (up === "STARTTLS") {
      send("220 go");
      s.removeAllListeners("data");
      const tc = new tls.TLSSocket(c, { isServer: true, cert, key });
      s = tc; tlsDone = true; buf = "";
      tc.on("data", onChunk);
    } else if (up.startsWith("MAIL FROM") || up.startsWith("RCPT TO")) send("250 ok");
    else if (up === "DATA") { inData = true; dataBuf = ""; send("354 go"); }
    else if (up === "QUIT") { send("221 bye"); s.end(); }
    else send("502 no");
  };
  const onChunk = (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l); }
  };
  c.on("data", onChunk);
  send("220 sink");
};
net.createServer((c) => handle(c, "starttls")).listen(2525, "0.0.0.0");
tls.createServer({ cert, key }, (c) => handle(c, "implicit")).listen(2465, "0.0.0.0");
http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(msgs));
}).listen(8025, "0.0.0.0");
`
	if err := os.WriteFile(filepath.Join(tmpDir, "smtp-sink.mjs"), []byte(sinkScript), 0o644); err != nil {
		t.Fatal(err)
	}

	overridePath := filepath.Join(tmpDir, "compose.override.yml")
	overrideYAML := fmt.Sprintf(`services:
  smtp-sink:
    image: ${NODE_IMAGE}
    command: ['node', '/tmp/smtp/smtp-sink.mjs']
    volumes:
      - %s:/tmp/smtp:ro
    ports:
      - '127.0.0.1:18025:8025'
  api:
    environment:
      APP_ENV: production
      APP_ORIGIN: https://engram.example
      AUTH_MAIL_SINK_DIR: ''
      AUTH_MAIL_CAPTURE_AS_DELIVERY: 'false'
      AUTH_FAKE_OAUTH: 'false'
      SEARCH_SEMANTIC_ENABLED: 'false'
      EMBEDDING_PROVIDER: noop
      AUTH_JWT_SECRET: %s
      AUTH_CSRF_SECRET: %s
      AUTH_REAUTH_SECRET: %s
      AUTH_IP_PEPPER: %s
      AUTH_EMAIL_PEPPER: %s
      EXPORT_AT_REST_SECRET: %s
      SSL_CERT_FILE: /tmp/smtp/ca.pem
      SMTP_HOST: ${SMOKE_SMTP_HOST:-}
      SMTP_PORT: ${SMOKE_SMTP_PORT:-587}
      SMTP_FROM: ${SMOKE_SMTP_FROM:-}
      SMTP_TLS_MODE: ${SMOKE_SMTP_TLS_MODE:-starttls}
      SMTP_USERNAME: ${SMOKE_SMTP_USERNAME:-}
      SMTP_PASSWORD: ${SMOKE_SMTP_PASSWORD:-}
    volumes:
      - %s:/tmp/smtp:ro
  worker:
    environment:
      APP_ENV: production
      APP_ORIGIN: https://engram.example
      AUTH_MAIL_SINK_DIR: ''
      SEARCH_SEMANTIC_ENABLED: 'false'
      EMBEDDING_PROVIDER: noop
      AUTH_JWT_SECRET: %s
      AUTH_CSRF_SECRET: %s
      AUTH_REAUTH_SECRET: %s
      AUTH_IP_PEPPER: %s
      AUTH_EMAIL_PEPPER: %s
      EXPORT_AT_REST_SECRET: %s
      SSL_CERT_FILE: /tmp/smtp/ca.pem
      SMTP_HOST: ${SMOKE_SMTP_HOST:-}
      SMTP_PORT: ${SMOKE_SMTP_PORT:-587}
      SMTP_FROM: ${SMOKE_SMTP_FROM:-}
      SMTP_TLS_MODE: ${SMOKE_SMTP_TLS_MODE:-starttls}
      SMTP_USERNAME: ${SMOKE_SMTP_USERNAME:-}
      SMTP_PASSWORD: ${SMOKE_SMTP_PASSWORD:-}
    volumes:
      - %s:/tmp/smtp:ro
`,
		tmpDir,
		secretB64(11), secretB64(41), secretB64(71), secretB64(101), secretB64(131), secretB64(161), tmpDir,
		secretB64(11), secretB64(41), secretB64(71), secretB64(101), secretB64(131), secretB64(161), tmpDir,
	)
	if err := os.WriteFile(overridePath, []byte(overrideYAML), 0o644); err != nil {
		t.Fatal(err)
	}

	runCompose := func(extraEnv []string, args ...string) string {
		baseArgs := []string{
			"compose",
			"--env-file", filepath.Join(repoRoot, "infra", "image-pins.env"),
			"-f", filepath.Join(repoRoot, "infra", "docker-compose.yml"),
			"-f", overridePath,
		}
		cmd := exec.Command("docker", append(baseArgs, args...)...)
		cmd.Dir = repoRoot
		cmd.Env = append(os.Environ(), extraEnv...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("docker compose %v failed: %v\n%s", args, err, out)
		}
		return string(out)
	}
	t.Cleanup(func() {
		baseArgs := []string{
			"compose",
			"--env-file", filepath.Join(repoRoot, "infra", "image-pins.env"),
			"-f", filepath.Join(repoRoot, "infra", "docker-compose.yml"),
			"-f", overridePath,
			"down", "--volumes", "--remove-orphans",
		}
		cmd := exec.Command("docker", baseArgs...)
		cmd.Dir = repoRoot
		_ = cmd.Run()
	})

	client := &http.Client{Timeout: 3 * time.Second}
	waitAPIReady := func(wantMail bool) {
		deadline := time.Now().Add(60 * time.Second)
		for {
			resp, err := client.Get("http://127.0.0.1:8080/api/v1/readyz")
			if err == nil {
				_ = resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					cfgResp, err := client.Get("http://127.0.0.1:8080/api/v1/auth/config")
					if err == nil {
						raw, _ := io.ReadAll(cfgResp.Body)
						_ = cfgResp.Body.Close()
						var cfg struct {
							MailDeliveryAvailable bool `json:"mail_delivery_available"`
						}
						if cfgResp.StatusCode == http.StatusOK && json.Unmarshal(raw, &cfg) == nil && cfg.MailDeliveryAvailable == wantMail {
							t.Logf("GET /api/v1/auth/config (wantMail=%v): %s", wantMail, strings.TrimSpace(string(raw)))
							return
						}
					}
				}
			}
			if time.Now().After(deadline) {
				psOut := runCompose(nil, "ps")
				logsOut := runCompose(nil, "logs", "--tail=80", "api", "worker")
				t.Fatalf("timed out waiting for Compose api ready (wantMail=%v)\nps:\n%s\nlogs:\n%s", wantMail, psOut, logsOut)
			}
			time.Sleep(500 * time.Millisecond)
		}
	}

	countTokens := func() int {
		out := runCompose(nil, "exec", "-T", "db", "psql", "-U", "engram", "-d", "engram", "-tAc", "SELECT count(*) FROM email_verification")
		lines := strings.Split(strings.TrimSpace(out), "\n")
		n, err := strconv.Atoi(strings.TrimSpace(lines[len(lines)-1]))
		if err != nil {
			t.Fatalf("count email_verification: %v (%s)", err, out)
		}
		return n
	}
	assertPS := func(phase string, env []string) {
		ps := runCompose(env, "ps")
		t.Logf("docker compose ps (%s):\n%s", phase, ps)
		if !strings.Contains(ps, "engram-api-1") || !strings.Contains(ps, "engram-worker-1") || strings.Contains(ps, "Exit") || strings.Contains(ps, "Restarting") {
			t.Fatalf("unexpected docker compose ps (%s):\n%s", phase, ps)
		}
	}
	type sinkMsg struct {
		Mode string `json:"mode"`
		Data string `json:"data"`
	}
	sinkMessages := func() []sinkMsg {
		resp, err := client.Get("http://127.0.0.1:18025/messages")
		if err != nil {
			t.Fatalf("GET smtp-sink /messages: %v", err)
		}
		raw, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		var msgs []sinkMsg
		if err := json.Unmarshal(raw, &msgs); err != nil {
			t.Fatalf("smtp-sink /messages: %v (%s)", err, raw)
		}
		return msgs
	}

	t.Run("stack_no_smtp_host_boots_and_refuses_mail", func(t *testing.T) {
		env := []string{"SMOKE_SMTP_HOST=", "SMOKE_SMTP_PORT=587", "SMOKE_SMTP_FROM=", "SMOKE_SMTP_TLS_MODE=starttls"}
		runCompose(env, "up", "-d", "--build", "db", "migrate", "mail-sink-perms", "smtp-sink", "api", "worker")
		waitAPIReady(false)
		assertPS("no SMTP_HOST", env)
		var before int
		status, raw := httpSignupAndSendVerify(t, client, "http://127.0.0.1:8080", "stack-nosmtp@example.org", func() { before = countTokens() })
		assertMailUnavailable(t, status, raw)
		if after := countTokens(); after != before {
			t.Fatalf("email_verification rows %d -> %d: token created despite 503", before, after)
		}
		if n := len(sinkMessages()); n != 0 {
			t.Fatalf("smtp-sink received %d messages without SMTP_HOST", n)
		}
		t.Logf("no SMTP_HOST: verify-email/send=503 mail_delivery_unavailable, email_verification rows unchanged (%d), sink empty", before)
	})

	for i, tc := range []struct{ mode, port string }{{"starttls", "2525"}, {"implicit", "2465"}} {
		t.Run("stack_"+tc.mode+"_delivers", func(t *testing.T) {
			env := []string{
				"SMOKE_SMTP_HOST=smtp-sink",
				"SMOKE_SMTP_PORT=" + tc.port,
				"SMOKE_SMTP_FROM=engram <no-reply@engram.example>",
				"SMOKE_SMTP_TLS_MODE=" + tc.mode,
			}
			runCompose(env, "up", "-d", "api", "worker")
			waitAPIReady(true)
			assertPS(tc.mode, env)
			email := "stack-" + tc.mode + "@example.org"
			if status, raw := httpSignupAndSendVerify(t, client, "http://127.0.0.1:8080", email, nil); status != http.StatusAccepted {
				t.Fatalf("POST /api/v1/auth/verify-email/send (%s): status=%d body=%s", tc.mode, status, raw)
			}
			msgs := sinkMessages()
			if len(msgs) != i+1 {
				t.Fatalf("smtp-sink messages after %s = %d, want %d", tc.mode, len(msgs), i+1)
			}
			last := msgs[len(msgs)-1]
			if last.Mode != tc.mode || !strings.Contains(last.Data, "https://engram.example/app/auth/verify-email#token=") || !strings.Contains(last.Data, email) {
				t.Fatalf("smtp-sink last message (want %s to %s) = %+v", tc.mode, email, last)
			}
			t.Logf("SMTP_TLS_MODE=%s: mail_delivery_available=true, verify-email/send=202, smtp-sink received via %s listener", tc.mode, last.Mode)
		})
	}

	for _, tc := range incompleteSMTPCases {
		t.Run("stack_rejects_"+tc.name, func(t *testing.T) {
			env := []string{"SMOKE_SMTP_PORT=587", "SMOKE_SMTP_TLS_MODE=starttls"}
			for k, v := range tc.env {
				env = append(env, "SMOKE_"+k+"="+v)
			}
			for _, svc := range []string{"api", "worker"} {
				ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
				cmd := exec.CommandContext(ctx, "docker", "compose",
					"--env-file", filepath.Join(repoRoot, "infra", "image-pins.env"),
					"-f", filepath.Join(repoRoot, "infra", "docker-compose.yml"),
					"-f", overridePath,
					"run", "--rm", "--no-deps", "-T", svc)
				cmd.Dir = repoRoot
				cmd.Env = append(os.Environ(), env...)
				out, err := cmd.CombinedOutput()
				timedOut := ctx.Err() != nil
				cancel()
				var exitErr *exec.ExitError
				if timedOut || !errors.As(err, &exitErr) || exitErr.ExitCode() == 0 || !strings.Contains(string(out), tc.want) {
					t.Fatalf("container %s with %s: err=%v timedOut=%v, want nonzero exit naming %s; out=%s", svc, tc.name, err, timedOut, tc.want, out)
				}
				t.Logf("container %s rejected %s: exit=%d", svc, tc.name, exitErr.ExitCode())
			}
		})
	}
}
