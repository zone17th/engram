package worker_test

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
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/notification"
	"github.com/zone17th/engram/apps/api/internal/secevent"
	"github.com/zone17th/engram/apps/api/internal/worker"
)

// plainSMTPSink is a plaintext fake SMTP server (development SMTP_TLS_MODE=none)
// that records DATA payloads and answers RCPT with rcptReply (empty = 250).
type plainSMTPSink struct {
	rcptReply string
	tlsCfg    *tls.Config
	mu        sync.Mutex
	messages  []string
	rcpts     int
}

func (s *plainSMTPSink) start(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(c)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func (s *plainSMTPSink) serve(c net.Conn) {
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(20 * time.Second))
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
			if s.tlsCfg != nil {
				w("250-sink\r\n250 STARTTLS")
			} else {
				w("250 sink")
			}
		case up == "STARTTLS" && s.tlsCfg != nil:
			w("220 go ahead")
			tc := tls.Server(c, s.tlsCfg)
			if tc.Handshake() != nil {
				return
			}
			c, r = tc, bufio.NewReader(tc)
			s.tlsCfg = nil
		case strings.HasPrefix(up, "MAIL FROM"):
			w("250 ok")
		case strings.HasPrefix(up, "RCPT TO"):
			s.mu.Lock()
			s.rcpts++
			s.mu.Unlock()
			if s.rcptReply != "" {
				w(s.rcptReply)
				continue
			}
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
			s.mu.Lock()
			s.messages = append(s.messages, b.String())
			s.mu.Unlock()
			w("250 queued")
		case up == "QUIT":
			w("221 bye")
			return
		default:
			w("502 no")
		}
	}
}

func (s *plainSMTPSink) snapshot() ([]string, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.messages...), s.rcpts
}

func plainSMTPMailer(t *testing.T, port int) *auth.SMTPMailer {
	t.Helper()
	m, err := auth.NewSMTPMailer(auth.SMTPConfig{
		Host: "127.0.0.1", Port: port, From: "no-reply@engram.example", TLSMode: auth.SMTPTLSNone,
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func seedNotice(t *testing.T, pool *pgxpool.Pool, email string) int64 {
	t.Helper()
	ctx := context.Background()
	var userID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO app_user (email, email_verified_at, locale) VALUES ($1, now(), 'en') RETURNING id`, email,
	).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	var id int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_notification (user_id, kind, meta, email_targets) VALUES ($1, 'security', '{}', $2) RETURNING id`,
		userID, []string{email},
	).Scan(&id); err != nil {
		t.Fatalf("insert notification: %v", err)
	}
	return id
}

func noticeJob(id int64) *river.Job[notification.SecurityNoticeArgs] {
	return &river.Job[notification.SecurityNoticeArgs]{Args: notification.SecurityNoticeArgs{NotificationID: id}}
}

func isJobCancel(err error) bool {
	var jc *river.JobCancelError
	return errors.As(err, &jc)
}

// waitJobState polls the single security_notice_mail job until it reaches want.
func waitJobState(t *testing.T, pool *pgxpool.Pool, want string) (attempt int) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		var state string
		err := pool.QueryRow(context.Background(),
			`SELECT state::text, attempt FROM river_job WHERE kind = 'security_notice_mail' ORDER BY id DESC LIMIT 1`,
		).Scan(&state, &attempt)
		if err == nil && state == want {
			return attempt
		}
		if time.Now().After(deadline) {
			t.Fatalf("job state = %q (err %v), want %q", state, err, want)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A notification removed by account deletion (cascade) cancels the job once,
// through the real River client: no retry.
func TestNoticeMailMissingNotificationCancels(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	sink := &plainSMTPSink{}
	mail := plainSMTPMailer(t, sink.start(t))
	if err := worker.NewSecurityNoticeWorker(pool, mail, silentLogger()).Work(ctx, noticeJob(987654)); !isJobCancel(err) {
		t.Fatalf("Work on missing notification = %v, want river.JobCancel", err)
	}

	client, err := worker.NewWithMail(pool, silentLogger(), 90, mail)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = client.Stop(stopCtx)
	})
	id := seedNotice(t, pool, "deleted-user@example.com")
	if _, err := pool.Exec(ctx, `DELETE FROM app_user WHERE email = 'deleted-user@example.com'`); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Insert(ctx, notification.SecurityNoticeArgs{NotificationID: id}, nil); err != nil {
		t.Fatal(err)
	}
	if attempt := waitJobState(t, pool, "cancelled"); attempt != 1 {
		t.Fatalf("cancelled after %d attempts, want exactly 1", attempt)
	}
	if msgs, rcpts := sink.snapshot(); len(msgs) != 0 || rcpts != 0 {
		t.Fatalf("mail sent for deleted notification: %d msgs %d rcpts", len(msgs), rcpts)
	}
}

func TestNoticeMailNoopCancels(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	id := seedNotice(t, pool, "noop@example.com")

	cfg := &config.Config{Env: "production"}
	noop, err := worker.NewWorkerMailer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := noop.(*auth.NoopMailer); !ok {
		t.Fatalf("production worker without SMTP = %T, want NoopMailer", noop)
	}
	for name, m := range map[string]auth.Mailer{"noop": noop, "nil": nil} {
		if err := worker.NewSecurityNoticeWorker(pool, m, silentLogger()).Work(context.Background(), noticeJob(id)); !isJobCancel(err) {
			t.Fatalf("%s mailer: Work = %v, want river.JobCancel", name, err)
		}
	}
	// Through NewWithMail (which wraps the mailer in worker.go's mailAdapter):
	ctx := context.Background()
	client, err := worker.NewWithMail(pool, silentLogger(), 90, noop)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = client.Stop(stopCtx)
	})
	if _, err := client.Insert(ctx, notification.SecurityNoticeArgs{NotificationID: id}, nil); err != nil {
		t.Fatal(err)
	}
	if attempt := waitJobState(t, pool, "cancelled"); attempt != 1 {
		t.Fatalf("Noop through NewWithMail: attempts=%d, want 1", attempt)
	}
}

func TestNoticeMailTransientRetries(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	id := seedNotice(t, pool, "retry@example.com")
	ctx := context.Background()

	transient := &plainSMTPSink{rcptReply: "451 4.3.0 try later"}
	err := worker.NewSecurityNoticeWorker(pool, plainSMTPMailer(t, transient.start(t)), silentLogger()).Work(ctx, noticeJob(id))
	if err == nil || isJobCancel(err) || auth.IsPermanentMailError(err) {
		t.Fatalf("4xx: Work = %v, want a plain error so River retries", err)
	}

	// Connection refused (closed port) is transient too.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	err = worker.NewSecurityNoticeWorker(pool, plainSMTPMailer(t, port), silentLogger()).Work(ctx, noticeJob(id))
	if err == nil || isJobCancel(err) {
		t.Fatalf("dial failure: Work = %v, want retryable error", err)
	}

	reg := prometheus.NewRegistry()
	if err := worker.RegisterNoticeMailMetrics(reg); err != nil {
		t.Fatal(err)
	}
	beforePerm := metricVal(t, "smtp_permanent")
	permanent := &plainSMTPSink{rcptReply: "550 5.1.1 no such user"}
	err = worker.NewSecurityNoticeWorker(pool, plainSMTPMailer(t, permanent.start(t)), silentLogger()).Work(ctx, noticeJob(id))
	if !isJobCancel(err) {
		t.Fatalf("5xx: Work = %v, want river.JobCancel", err)
	}
	if got := metricVal(t, "smtp_permanent") - beforePerm; got != 1 {
		t.Fatalf("smtp_permanent metric delta = %v, want 1", got)
	}
}

// The real worker (worker.Run, config from env) delivers a security notice to
// an SMTP server through the shared compose.NewMailer adapter.
func TestWorkerSecurityNoticeSMTP(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()
	sink := &plainSMTPSink{}
	port := sink.start(t)

	certFile, srvTLS := writeTestCA(t)
	sink.tlsCfg = srvTLS
	t.Chdir(t.TempDir())
	t.Setenv("SSL_CERT_FILE", certFile)
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", "https://engram.example")
	t.Setenv("APP_ENV", "production")
	t.Setenv("AUTH_MAIL_SINK_DIR", "")
	t.Setenv("AUTH_MAIL_CAPTURE_AS_DELIVERY", "false")
	for i, k := range []string{"AUTH_JWT_SECRET", "AUTH_CSRF_SECRET", "AUTH_REAUTH_SECRET", "AUTH_IP_PEPPER", "AUTH_EMAIL_PEPPER", "EXPORT_AT_REST_SECRET"} {
		b := make([]byte, 32)
		for j := range b {
			b[j] = byte(i*40 + j + 1)
		}
		t.Setenv(k, base64.StdEncoding.EncodeToString(b))
	}
	t.Setenv("SMTP_HOST", "127.0.0.1")
	t.Setenv("SMTP_PORT", strconv.Itoa(port))
	t.Setenv("SMTP_FROM", "no-reply@engram.example")
	t.Setenv("SMTP_TLS_MODE", "starttls")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	cfg.ShutdownTimeout = 5 * time.Second

	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- worker.Run(runCtx, cfg, silentLogger()) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("worker.Run did not stop")
		}
	})

	email := "smtp-notice@example.com"
	var userID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO app_user (email, email_verified_at, locale) VALUES ($1, now(), 'en') RETURNING id`, email,
	).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	riverInsert, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := notification.NewStore(pool, riverInsert).NotifySecurity(ctx, nil, secevent.Notice{
		UserID: userID, Kind: secevent.NoticeSecurity, Meta: secevent.Meta{}, EmailTargets: []string{email},
	}); err != nil {
		t.Fatal(err)
	}
	waitJobState(t, pool, "completed")
	msgs, _ := sink.snapshot()
	if len(msgs) != 1 || !strings.Contains(msgs[0], "To: "+email) {
		t.Fatalf("SMTP sink messages = %q, want one notice to %s", msgs, email)
	}
}

func metricVal(t *testing.T, outcome string) float64 {
	t.Helper()
	var m dto.Metric
	if err := worker.NoticeMailOutcomes.WithLabelValues(outcome).Write(&m); err != nil {
		t.Fatal(err)
	}
	return m.GetCounter().GetValue()
}

func writeTestCA(t *testing.T) (string, *tls.Config) {
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
	p := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return p, &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
}
