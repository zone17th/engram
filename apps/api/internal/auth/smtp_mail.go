package auth

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net"
	netmail "net/mail"
	"net/smtp"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"time"
)

// SMTP TLS modes (SMTP_TLS_MODE). config.Validate already rejects "none" in
// production/staging.
const (
	SMTPTLSStartTLS = "starttls"
	SMTPTLSImplicit = "implicit"
	SMTPTLSNone     = "none"
)

// SMTPSendTimeout bounds one whole delivery (dial + TLS + auth + DATA).
const SMTPSendTimeout = 10 * time.Second

// SMTPConfig is the generic SMTP adapter configuration (plan P06 Task 5).
type SMTPConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	TLSMode  string
	Logger   *slog.Logger
	// TLSConfig overrides the client TLS config (tests: trust a fake server's
	// CA). ServerName defaults to Host.
	TLSConfig *tls.Config
}

// SMTPMailer delivers mail through a generic SMTP relay with net/smtp.
type SMTPMailer struct {
	host, from, envFrom, tlsMode, username, password string
	port                                             int
	tlsConfig                                        *tls.Config
	logger                                           *slog.Logger
}

// SMTPError classifies a failed delivery. It never carries the server reply
// text (which may echo addresses) nor any credential.
type SMTPError struct {
	Stage     string // dial, tls, auth, mail, rcpt, data, quit
	Code      int    // SMTP reply code, 0 when not a protocol reply
	Permanent bool
}

func (e *SMTPError) Error() string {
	kind := "temporary"
	if e.Permanent {
		kind = "permanent"
	}
	if e.Code > 0 {
		return fmt.Sprintf("smtp %s failed (%s, code %d)", e.Stage, kind, e.Code)
	}
	return fmt.Sprintf("smtp %s failed (%s)", e.Stage, kind)
}

// Is lets callers keep using errors.Is(err, ErrMailDeliveryUnavailable).
func (e *SMTPError) Is(target error) bool { return target == ErrMailDeliveryUnavailable }

// IsPermanentMailError reports whether err is a permanent (5xx / invalid
// input) delivery failure; retrying it cannot succeed.
func IsPermanentMailError(err error) bool {
	var se *SMTPError
	return errors.As(err, &se) && se.Permanent
}

func NewSMTPMailer(c SMTPConfig) (*SMTPMailer, error) {
	host := strings.TrimSpace(c.Host)
	if host == "" || c.From == "" {
		return nil, errors.New("smtp: host và from là bắt buộc")
	}
	if c.Port < 1 || c.Port > 65535 {
		return nil, errors.New("smtp: port không hợp lệ")
	}
	mode := c.TLSMode
	if mode == "" {
		mode = SMTPTLSStartTLS
	}
	switch mode {
	case SMTPTLSStartTLS, SMTPTLSImplicit, SMTPTLSNone:
	default:
		return nil, fmt.Errorf("smtp: SMTP_TLS_MODE %q không hợp lệ", mode)
	}
	if hasCRLF(c.From) {
		return nil, errors.New("smtp: from không hợp lệ")
	}
	fromAddr, err := netmail.ParseAddress(c.From)
	if err != nil {
		return nil, errors.New("smtp: from không hợp lệ")
	}
	tc := &tls.Config{MinVersion: tls.VersionTLS12}
	if c.TLSConfig != nil {
		tc = c.TLSConfig.Clone()
	}
	if tc.ServerName == "" {
		tc.ServerName = host
	}
	if tc.RootCAs == nil {
		if f := os.Getenv("SSL_CERT_FILE"); f != "" {
			if pemBytes, err := os.ReadFile(f); err == nil {
				pool, _ := x509.SystemCertPool()
				if pool == nil {
					pool = x509.NewCertPool()
				}
				if pool.AppendCertsFromPEM(pemBytes) {
					tc.RootCAs = pool
				}
			}
		}
	}
	return &SMTPMailer{
		host: host, port: c.Port, from: c.From, envFrom: fromAddr.Address, tlsMode: mode,
		username: c.Username, password: c.Password, tlsConfig: tc, logger: c.Logger,
	}, nil
}

func (*SMTPMailer) MailDeliveryAvailable() bool { return true }

func (m *SMTPMailer) Send(ctx context.Context, recipient, purpose, link string) error {
	err := m.send(ctx, recipient, purpose, link)
	if err != nil && m.logger != nil {
		attrs := []slog.Attr{
			slog.String("purpose", purpose),
			slog.String("recipient_domain", emailDomain(recipient)),
		}
		var se *SMTPError
		if errors.As(err, &se) {
			attrs = append(attrs, slog.String("stage", se.Stage), slog.Int("code", se.Code), slog.Bool("permanent", se.Permanent))
		}
		m.logger.LogAttrs(ctx, slog.LevelWarn, "gửi mail SMTP thất bại", attrs...)
	}
	return err
}

func (m *SMTPMailer) send(ctx context.Context, recipient, purpose, link string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = &SMTPError{Stage: "internal"}
		}
	}()
	if recipient == "" || hasCRLF(recipient) || !strings.Contains(recipient, "@") {
		return &SMTPError{Stage: "rcpt", Permanent: true}
	}
	ctx, cancel := context.WithTimeout(ctx, SMTPSendTimeout)
	defer cancel()
	deadline, _ := ctx.Deadline()

	addr := net.JoinHostPort(m.host, strconv.Itoa(m.port))
	var d net.Dialer
	rawConn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return &SMTPError{Stage: "dial"}
	}
	// Abort blocking I/O when ctx ends before the deadline (caller cancel).
	// Always use the immutable rawConn so wrapping conn for implicit TLS never
	// races with the AfterFunc callback (R1-01).
	stop := context.AfterFunc(ctx, func() { _ = rawConn.SetDeadline(time.Unix(1, 0)) })
	defer stop()
	defer func() { _ = rawConn.Close() }()
	if err := rawConn.SetDeadline(deadline); err != nil {
		return &SMTPError{Stage: "dial"}
	}
	conn := rawConn
	if m.tlsMode == SMTPTLSImplicit {
		tc := tls.Client(rawConn, m.tlsConfig)
		if err := tc.HandshakeContext(ctx); err != nil {
			return &SMTPError{Stage: "tls", Permanent: isCertError(err)}
		}
		conn = tc
	}
	c, err := smtp.NewClient(conn, m.host)
	if err != nil {
		return classify("greeting", err)
	}
	defer func() { _ = c.Close() }()
	if err := c.Hello("localhost"); err != nil {
		return classify("hello", err)
	}
	if m.tlsMode == SMTPTLSStartTLS {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			// Never downgrade to plaintext when STARTTLS was required.
			return &SMTPError{Stage: "tls", Permanent: true}
		}
		if err := c.StartTLS(m.tlsConfig); err != nil {
			var tp *textproto.Error
			if errors.As(err, &tp) {
				return classify("tls", err)
			}
			return &SMTPError{Stage: "tls", Permanent: isCertError(err)}
		}
	}
	if m.username != "" {
		if ok, _ := c.Extension("AUTH"); !ok {
			return &SMTPError{Stage: "auth", Permanent: true}
		}
		if err := c.Auth(smtp.PlainAuth("", m.username, m.password, m.host)); err != nil {
			return classify("auth", err)
		}
	}
	if err := c.Mail(m.envFrom); err != nil {
		return classify("mail", err)
	}
	if err := c.Rcpt(recipient); err != nil {
		return classify("rcpt", err)
	}
	w, err := c.Data()
	if err != nil {
		return classify("data", err)
	}
	if _, err := w.Write(buildMessage(m.from, recipient, purpose, link, time.Now())); err != nil {
		_ = w.Close()
		return classify("data", err)
	}
	if err := w.Close(); err != nil {
		return classify("data", err)
	}
	_ = c.Quit()
	return nil
}

func classify(stage string, err error) error {
	var tp *textproto.Error
	if errors.As(err, &tp) {
		return &SMTPError{Stage: stage, Code: tp.Code, Permanent: tp.Code >= 500}
	}
	// Network failures, timeouts and unexpected EOFs are transient.
	return &SMTPError{Stage: stage}
}

func isCertError(err error) bool {
	var verr *tls.CertificateVerificationError
	return errors.As(err, &verr)
}

func hasCRLF(s string) bool { return strings.ContainsAny(s, "\r\n") }

func emailDomain(addr string) string {
	if i := strings.LastIndexByte(addr, '@'); i >= 0 && i+1 < len(addr) {
		return strings.ToLower(addr[i+1:])
	}
	return ""
}

func mailContent(purpose, link string) (subject, body string) {
	const footer = "\r\n\r\n-- \r\nengram"
	switch purpose {
	case "signup":
		return "Xác minh email engram / Verify your engram email",
			"Mở liên kết sau để xác minh email (hết hạn sau 24 giờ):\r\nOpen this link to verify your email (expires in 24 hours):\r\n\r\n" + link + footer
	case "email_change":
		return "Xác nhận email mới cho engram / Confirm your new engram email",
			"Mở liên kết sau để xác nhận email mới (hết hạn sau 30 phút):\r\nOpen this link to confirm your new email (expires in 30 minutes):\r\n\r\n" + link + footer
	case "password_enroll":
		return "Thêm mật khẩu đăng nhập engram / Add an engram login password",
			"Mở liên kết sau để thêm mật khẩu đăng nhập (hết hạn sau 10 phút):\r\nOpen this link to add a login password (expires in 10 minutes):\r\n\r\n" + link + footer
	case PurposePasswordReset:
		return "Đặt lại mật khẩu engram / Reset your engram password",
			"Mở liên kết sau để đặt lại mật khẩu đăng nhập. Nếu bạn không yêu cầu, hãy bỏ qua thư này.\r\nOpen this link to reset your login password. If you did not ask for this, ignore this email.\r\n\r\n" + link + footer
	case PurposePasswordResetOAuthOnly:
		return "Đăng nhập engram / Sign in to engram",
			"Tài khoản của bạn đăng nhập bằng Google/GitHub, không có mật khẩu để đặt lại. Đăng nhập tại:\r\nYour account signs in with Google/GitHub and has no password to reset. Sign in here:\r\n\r\n" + link + footer
	case PurposePasswordResetNotice:
		return "Mật khẩu engram đã được đặt lại / Your engram password was reset", link + footer
	default:
		return "Thông báo bảo mật engram / engram security notice",
			"Có thay đổi bảo mật trên tài khoản engram của bạn. Xem trong Cài đặt.\r\nThere was a security change on your engram account. Review it in Settings." + footer
	}
}

func buildMessage(from, to, purpose, link string, now time.Time) []byte {
	subject, body := mailContent(purpose, link)
	var id [12]byte
	_, _ = rand.Read(id[:])
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\n")
	b.WriteString("Date: " + now.UTC().Format(time.RFC1123Z) + "\r\n")
	b.WriteString("Message-ID: <" + hex.EncodeToString(id[:]) + "@" + emailDomainOr(from) + ">\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
	b.WriteString(normalizeCRLF(body))
	b.WriteString("\r\n")
	return []byte(b.String())
}

func emailDomainOr(from string) string {
	if a, err := netmail.ParseAddress(from); err == nil {
		from = a.Address
	}
	if d := emailDomain(from); d != "" {
		return d
	}
	return "engram.local"
}

func normalizeCRLF(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\n", "\r\n")
}
