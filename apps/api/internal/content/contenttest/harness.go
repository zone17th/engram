package contenttest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/auth/authhttp"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/entry/entryhttp"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/item/itemhttp"
	"github.com/zone17th/engram/apps/api/internal/obs"
	"github.com/zone17th/engram/apps/api/internal/tag/taghttp"
	"github.com/zone17th/engram/apps/api/internal/vault"
	"github.com/zone17th/engram/apps/api/internal/vault/vaulthttp"
)

// CookieJar lưu các cookie của một phiên người dùng trong test HTTP.
type CookieJar map[string]*http.Cookie

// Apply gắn tất cả cookie hiện có trong jar vào `req`.
func (j CookieJar) Apply(req *http.Request) {
	for _, c := range j {
		req.AddCookie(&http.Cookie{Name: c.Name, Value: c.Value})
	}
}

// Capture cập nhật jar từ các header `Set-Cookie` của `resp`.
func (j CookieJar) Capture(resp *http.Response) {
	for _, c := range resp.Cookies() {
		if c.MaxAge < 0 || c.Value == "" {
			delete(j, c.Name)
			continue
		}
		j[c.Name] = c
	}
}

// SafeBuffer là bộ đệm log an toàn cho nhiều goroutine trong test.
type SafeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

// Write ghi `p` vào bộ đệm dưới khóa.
func (b *SafeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

// String trả chuỗi hiện tại trong bộ đệm.
func (b *SafeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// Reset xóa nội dung bộ đệm.
func (b *SafeBuffer) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf.Reset()
}

// HarnessOpts cấu hình khởi tạo `Harness` cho các test content P04.
type HarnessOpts struct {
	RequireEmailVerification bool
	KeyMutationsDisabled     bool
	ResetHook                vault.ResetHook
	ExtraMounts              []func(h *Harness, v1 chi.Router, d httpx.Deps)
}

// Harness là môi trường HTTP test thực tế (Postgres 16 thật qua `dbtest`, đồng hồ giả `clock.Fixed`,
// chuỗi middleware `httpx` + `compose.NewAuth` + `compose.NewVault` + `compose.NewContent` thật)
// được xuất công khai để các test W2 (`itemtag`, `entryapi`) dùng lại theo mẫu `vaulthttp/handlers_test.go`.
type Harness struct {
	T        *testing.T
	Server   *httptest.Server
	Origin   string
	Clock    *clock.Fixed
	Mail     *auth.SinkMailer
	AuthSvc  *auth.Service
	VaultSvc *vault.Service
	VaultAPI *vaulthttp.API
	Content  *compose.Content
	Pool     *pgxpool.Pool
	Registry *prometheus.Registry
	Logs     *SafeBuffer
}

// NewHarness khởi tạo `Harness` với Postgres thật (`dbtest.StartPostgres`), đồng hồ giả cố định,
// và mount đầy đủ `authhttp`, `vaulthttp`, `itemhttp`, `taghttp`, `entryhttp` cùng `opts.ExtraMounts`.
func NewHarness(t *testing.T, opts HarnessOpts) *Harness {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://" + ln.Addr().String()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	clk := clock.NewFixed(time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC))

	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", origin)
	t.Setenv("APP_ENV", "development")
	if opts.RequireEmailVerification {
		t.Setenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "true")
	} else {
		t.Setenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "false")
	}
	if opts.KeyMutationsDisabled {
		t.Setenv("VAULT_KEY_MUTATIONS_DISABLED", "true")
	} else {
		t.Setenv("VAULT_KEY_MUTATIONS_DISABLED", "false")
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	mail, err := auth.NewSinkMailer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	reg, metrics := obs.NewRegistry()

	logBuf := &SafeBuffer{}
	logger := slog.New(slog.NewJSONHandler(logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	riverInsert, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		t.Fatal(err)
	}
	authSvc, _, authAPI, err := compose.NewAuth(cfg, pool, riverInsert, clk, mail, nil)
	if err != nil {
		t.Fatal(err)
	}
	vaultSvc, vaultAPI, err := compose.NewVault(cfg, pool, riverInsert, clk, mail, metrics, opts.ResetHook, logger)
	if err != nil {
		t.Fatal(err)
	}
	contentComp, err := compose.NewContent(cfg, pool, clk, metrics, logger)
	if err != nil {
		t.Fatal(err)
	}
	authn, csrfv, reauth := compose.Adapters(authSvc)

	h := &Harness{
		T:        t,
		Origin:   origin,
		Clock:    clk,
		Mail:     mail,
		AuthSvc:  authSvc,
		VaultSvc: vaultSvc,
		VaultAPI: vaultAPI,
		Content:  contentComp,
		Pool:     pool,
		Registry: reg,
		Logs:     logBuf,
	}

	mounts := []func(v1 chi.Router, d httpx.Deps){
		authhttp.Mount(authAPI),
		vaulthttp.Mount(vaultAPI),
		itemhttp.Mount(contentComp),
		taghttp.Mount(contentComp),
		entryhttp.Mount(contentComp),
	}
	for _, extra := range opts.ExtraMounts {
		if extra == nil {
			continue
		}
		fn := extra
		mounts = append(mounts, func(v1 chi.Router, d httpx.Deps) {
			fn(h, v1, d)
		})
	}

	hnd := httpx.NewRouter(httpx.Deps{
		Config:           cfg,
		Logger:           logger,
		Ready:            func(context.Context) error { return nil },
		Metrics:          promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}),
		MetricsCollector: metrics,
		Authenticator:    authn,
		CSRF:             csrfv,
		Reauth:           reauth,
		MountAPI:         compose.MountAll(mounts...),
	})
	srv := httptest.NewUnstartedServer(hnd)
	_ = srv.Listener.Close()
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	h.Server = srv

	return h
}

// ReqOptions cấu hình header/body cho một request trong `Harness.DoReq`.
type ReqOptions struct {
	IdemKey     string
	IfMatch     string
	Grant       string
	NoCSRF      bool
	ContentType string
	Chunked     bool      // true -> ép gửi Transfer-Encoding: chunked với ContentLength = -1
	BodyReader  io.Reader // nếu khác nil, dùng trực tiếp làm request body (với ContentLength = -1)
}

// TestResponse chứa status code và header của HTTP response trong test.
type TestResponse struct {
	StatusCode int
	Header     http.Header
}

// DoReq gửi một HTTP request tới `h.Server` kèm cookie, Origin, CSRF, `Idempotency-Key`, `If-Match`,
// hỗ trợ cả `Content-Length` xác định lẫn chunked body không rõ độ dài trước.
func (h *Harness) DoReq(j CookieJar, method, path, body string, opt ReqOptions) (TestResponse, string) {
	h.T.Helper()
	var rdr io.Reader
	switch {
	case opt.BodyReader != nil:
		rdr = opt.BodyReader
	case opt.Chunked:
		// Bọc bằng struct chỉ cài io.Reader để net/http không tự tính ContentLength từ *bytes.Buffer/*strings.Reader.
		rdr = io.NopCloser(struct{ io.Reader }{Reader: bytes.NewBufferString(body)})
	case body != "":
		rdr = bytes.NewBufferString(body)
	}

	req, err := http.NewRequest(method, h.Server.URL+path, rdr)
	if err != nil {
		h.T.Fatal(err)
	}
	if opt.Chunked || opt.BodyReader != nil {
		req.ContentLength = -1
	}
	if method != http.MethodGet && method != http.MethodHead {
		if opt.ContentType != "" {
			req.Header.Set("Content-Type", opt.ContentType)
		} else if body != "" || opt.BodyReader != nil || method != http.MethodDelete {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("Origin", h.Origin)
	}
	if j != nil {
		j.Apply(req)
	}
	if !opt.NoCSRF && j != nil {
		if c := j[authhttp.CookieCSRF]; c != nil {
			req.Header.Set(authhttp.HeaderCSRF, c.Value)
		}
	}
	if opt.IdemKey != "" {
		req.Header.Set(httpx.HeaderIdempotencyKey, opt.IdemKey)
	}
	if opt.IfMatch != "" {
		req.Header.Set(httpx.HeaderIfMatch, opt.IfMatch)
	}
	if opt.Grant != "" {
		req.Header.Set(authhttp.HeaderReauth, opt.Grant)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.T.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if j != nil {
		j.Capture(resp)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		h.T.Fatal(err)
	}
	return TestResponse{
		StatusCode: resp.StatusCode,
		Header:     resp.Header,
	}, string(b)
}

// SignupUser đăng ký một tài khoản mới qua `/api/v1/auth/csrf` + `/api/v1/auth/signup`
// và trả về `CookieJar` đã đăng nhập cùng thông tin `auth.Me`.
func (h *Harness) SignupUser(email, password string) (CookieJar, auth.Me) {
	h.T.Helper()
	j := CookieJar{}
	resp, raw := h.DoReq(j, http.MethodGet, "/api/v1/auth/csrf", "", ReqOptions{NoCSRF: true})
	if resp.StatusCode != http.StatusNoContent {
		h.T.Fatalf("csrf = %d %s", resp.StatusCode, raw)
	}
	payload := `{"email":"` + email + `","password":"` + password + `","locale":"en"}`
	resp, raw = h.DoReq(j, http.MethodPost, "/api/v1/auth/signup", payload, ReqOptions{})
	if resp.StatusCode != http.StatusCreated {
		h.T.Fatalf("signup %s = %d %s", email, resp.StatusCode, raw)
	}
	var me auth.Me
	if err := json.Unmarshal([]byte(raw), &me); err != nil {
		h.T.Fatalf("decode me: %v", err)
	}
	return j, me
}

// RefreshSession làm mới phiên đăng nhập hiện tại qua endpoint thật `POST /api/v1/auth/refresh`
// (kèm cookie `sabk_refresh` và CSRF của phiên) và cập nhật lại cookie mới vào `j`.
func (h *Harness) RefreshSession(j CookieJar) {
	h.T.Helper()
	resp, raw := h.DoReq(j, http.MethodPost, "/api/v1/auth/refresh", `{}`, ReqOptions{})
	if resp.StatusCode != http.StatusNoContent {
		h.T.Fatalf("refresh session = %d %s", resp.StatusCode, raw)
	}
}

// SignupTwoUsers đăng ký hai người dùng độc lập (Alice và Bob) cho các test cách ly tenant (P04-A1).
func (h *Harness) SignupTwoUsers() (CookieJar, auth.Me, CookieJar, auth.Me) {
	h.T.Helper()
	jarA, meA := h.SignupUser("alice-content@example.com", "correct-horse-battery-staple-a")
	jarB, meB := h.SignupUser("bob-content@example.com", "correct-horse-battery-staple-b")
	return jarA, meA, jarB, meB
}

// DecodeProblem giải mã JSON RFC 9457 `httpx.Problem` từ body phản hồi.
func DecodeProblem(t testing.TB, raw string) httpx.Problem {
	t.Helper()
	var p httpx.Problem
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatalf("decode problem (%s): %v", raw, err)
	}
	return p
}

// AssertJSONEqual giải mã cả `want` và `got` thành `any` bằng `json.Decoder.UseNumber()`
// và so sánh cấu trúc bằng `reflect.DeepEqual` (phục vụ so sánh body replay từ cột `jsonb`
// của `idempotency_key` với response JSON gốc).
func AssertJSONEqual(t testing.TB, want, got string) {
	t.Helper()
	decode := func(label, s string) any {
		dec := json.NewDecoder(strings.NewReader(s))
		dec.UseNumber()
		var v any
		if err := dec.Decode(&v); err != nil {
			t.Fatalf("AssertJSONEqual decode %s (%q): %v", label, s, err)
		}
		var extra any
		if err := dec.Decode(&extra); err != io.EOF {
			t.Fatalf("AssertJSONEqual trailing data in %s (%q): %v", label, s, err)
		}
		return v
	}
	wantVal := decode("want", want)
	gotVal := decode("got", got)
	if !reflect.DeepEqual(wantVal, gotVal) {
		t.Fatalf("AssertJSONEqual mismatch:\nwant: %s\ngot:  %s", want, got)
	}
}
