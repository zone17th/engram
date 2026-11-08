package exporthttp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/export"
	"github.com/zone17th/engram/apps/api/internal/export/exporthttp"
	"github.com/zone17th/engram/apps/api/internal/httpx"
)

const testOrigin = "https://engram.test"

type tokenAuth map[string]authctx.Principal

func (a tokenAuth) Authenticate(_ context.Context, tok string) (authctx.Principal, error) {
	if p, ok := a[tok]; ok {
		return p, nil
	}
	return authctx.Principal{}, &httpx.AuthError{Code: "session_invalid"}
}

type strictCSRF struct{}

func (strictCSRF) VerifyCSRF(_ context.Context, p *authctx.Principal, cookie, header string) error {
	if p == nil || cookie == "" || cookie != header {
		return &httpx.AuthError{Code: "csrf_invalid"}
	}
	return nil
}

type grantsReauth struct{ g *auth.Grants }

func (a grantsReauth) VerifyReauth(_ context.Context, p authctx.Principal, action, token string) error {
	if err := a.g.Verify(p, action, token); err != nil {
		return &httpx.AuthError{Code: "reauth_invalid"}
	}
	return nil
}

type env struct {
	t       *testing.T
	pool    *pgxpool.Pool
	svc     *export.Service
	worker  *export.ExportWorker
	grants  *auth.Grants
	handler http.Handler
	paused  bool
	logs    *syncBuffer
	storage string
	users   map[string]authctx.Principal // session token -> principal
}

func newEnv(t *testing.T) *env {
	t.Helper()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	cfg := &config.Config{
		Env:                 "development",
		AppOrigin:           testOrigin,
		ExportStorageDir:    t.TempDir(),
		ExportMaxSpoolBytes: 4 << 30,
		ExportAtRestSecret:  config.NewSecretBytes([]byte(config.DevExportAtRestSecret)),
		AuthIPPepper:        bytes.Repeat([]byte{0x11}, 32),
		AuthEmailPepper:     bytes.Repeat([]byte{0x22}, 32),
	}
	// Real insert-only River client: security_notice_mail must be enqueued.
	riverc, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		t.Fatalf("river client: %v", err)
	}
	svc, err := export.NewService(cfg, pool, riverc, nil, clock.System{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	e := &env{
		t:       t,
		pool:    pool,
		svc:     svc,
		logs:    &syncBuffer{},
		storage: cfg.ExportStorageDir,
		worker: export.NewExportWorker(export.WorkerDeps{
			Pool:       pool,
			StorageDir: cfg.ExportStorageDir,
			Secret:     cfg.ExportAtRestSecret,
		}),
		grants: auth.NewGrants(bytes.Repeat([]byte{0x42}, 32), clock.System{}),
		users: map[string]authctx.Principal{
			"sess-a":       {UserID: e2eUser(t, pool, true), SessionID: uuid.New()},
			"sess-b":       {UserID: e2eUser(t, pool, true), SessionID: uuid.New()},
			"sess-novault": {UserID: e2eUser(t, pool, false), SessionID: uuid.New()},
		},
	}
	api := exporthttp.NewAPI(svc, httpx.NewIdempotency(pool, clock.System{}), func() bool { return e.paused }, cfg.TrustedProxyContains, slog.New(slog.NewTextHandler(e.logs, nil)))
	e.handler = httpx.NewRouter(httpx.Deps{
		Config:        cfg,
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		Authenticator: tokenAuth(e.users),
		CSRF:          strictCSRF{},
		Reauth:        grantsReauth{e.grants},
		MountAPI:      exporthttp.Mount(api),
	})
	return e
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

var vkSeq struct {
	sync.Mutex
	n int
}

// e2eUser inserts an app_user and, when withVault, a vault row whose
// vault_key_id satisfies the export_job snapshot CHECK.
func e2eUser(t *testing.T, pool *pgxpool.Pool, withVault bool) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	id := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (id, email, email_verified_at) VALUES ($1, $2, now())`,
		id, "u-"+id.String()+"@example.com"); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if !withVault {
		return id
	}
	vkSeq.Lock()
	vkSeq.n++
	keyID := fmt.Sprintf("vk:%022d", vkSeq.n)
	vkSeq.Unlock()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault (user_id, version, kdf, vault_key_id, vault_key_wrapped_by_kek, x25519_public, ed25519_public, private_keys_wrapped)
		VALUES ($1, 1, '{"alg":"argon2id"}', $2, $3, $4, $5, $6)`,
		id, keyID, bytes.Repeat([]byte{1}, 73), bytes.Repeat([]byte{2}, 32), bytes.Repeat([]byte{3}, 32), bytes.Repeat([]byte{4}, 105)); err != nil {
		t.Fatalf("insert vault: %v", err)
	}
	return id
}

type reqOpts struct {
	sess    string // "" = no session cookie
	csrf    bool
	origin  string // "" = testOrigin, "-" = none
	idem    string
	reauth  string
	ctype   string // "" = application/json
	noCType bool
}

type resp struct {
	code   int
	header http.Header
	body   []byte
}

func (r resp) problem() string {
	var p struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(r.body, &p)
	return p.Code
}

func (r resp) job(t *testing.T) export.Job {
	t.Helper()
	var j export.Job
	if err := json.Unmarshal(r.body, &j); err != nil {
		t.Fatalf("decode job %s: %v", r.body, err)
	}
	return j
}

func (e *env) do(method, path, body string, o reqOpts) resp {
	e.t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body == "" {
		req.Body = http.NoBody
		req.ContentLength = 0
	}
	switch o.origin {
	case "":
		req.Header.Set("Origin", testOrigin)
	case "-":
	default:
		req.Header.Set("Origin", o.origin)
	}
	if !o.noCType {
		ct := o.ctype
		if ct == "" {
			ct = "application/json"
		}
		req.Header.Set("Content-Type", ct)
	}
	if o.sess != "" {
		req.AddCookie(&http.Cookie{Name: "sabk_session", Value: o.sess})
	}
	req.AddCookie(&http.Cookie{Name: "sabk_csrf", Value: "csrf-ok"})
	if o.csrf {
		req.Header.Set("X-CSRF-Token", "csrf-ok")
	}
	if o.idem != "" {
		req.Header.Set("Idempotency-Key", o.idem)
	}
	if o.reauth != "" {
		req.Header.Set("X-Reauth-Token", o.reauth)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return resp{code: rec.Code, header: rec.Header(), body: rec.Body.Bytes()}
}

func (e *env) create(sess, key string) resp {
	e.t.Helper()
	return e.do(http.MethodPost, "/api/v1/exports", `{"kind":"encrypted"}`, reqOpts{sess: sess, csrf: true, idem: key})
}

func (e *env) cancel(sess string, id uuid.UUID, key string) resp {
	e.t.Helper()
	return e.do(http.MethodPost, "/api/v1/exports/"+id.String()+"/cancel", `{}`, reqOpts{sess: sess, csrf: true, idem: key})
}

func (e *env) grant(sess, action string) string {
	e.t.Helper()
	g, err := e.grants.Issue(e.users[sess], action)
	if err != nil {
		e.t.Fatal(err)
	}
	return g.Grant
}

// readyJob creates a job for sess and runs the real export worker to ready.
func (e *env) readyJob(sess, key string) export.Job {
	e.t.Helper()
	r := e.create(sess, key)
	if r.code != http.StatusAccepted {
		e.t.Fatalf("create = %d %s", r.code, r.body)
	}
	j := r.job(e.t)
	rj := &river.Job[export.ExportEncryptedArgs]{
		JobRow: &rivertype.JobRow{ID: 1, Attempt: 1, MaxAttempts: 3, State: rivertype.JobStateRunning},
		Args:   export.ExportEncryptedArgs{JobID: j.ID, UserID: e.users[sess].UserID},
	}
	if err := e.worker.Work(context.Background(), rj); err != nil {
		e.t.Fatalf("worker: %v", err)
	}
	return j
}

func (e *env) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(context.Background(), sql, args...); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
}

func (e *env) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		e.t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func (e *env) rateEvents(sess string) int {
	return e.count(`SELECT count(*) FROM rate_event WHERE scope = 'export_create' AND user_id = $1`, e.users[sess].UserID)
}

func want(t *testing.T, r resp, code int, problem string) {
	t.Helper()
	if r.code != code || (problem != "" && r.problem() != problem) {
		t.Fatalf("got %d %s, want %d %s", r.code, r.body, code, problem)
	}
}

// TestExportHTTPEndpoints covers every export row of the canonical table
// (plan mục 3): status codes, problem codes, owner 404, 409 vs 410 per state,
// headers and the EXPORT_CREATE_PAUSED gate.
func TestExportHTTPEndpoints(t *testing.T) {
	e := newEnv(t)

	t.Run("latest_empty_then_job", func(t *testing.T) {
		r := e.do(http.MethodGet, "/api/v1/exports/latest", "", reqOpts{sess: "sess-b"})
		want(t, r, http.StatusOK, "")
		if strings.TrimSpace(string(r.body)) != `{"job":null}` || r.header.Get("Cache-Control") != "no-store" {
			t.Fatalf("latest empty = %s %v", r.body, r.header)
		}
		want(t, e.do(http.MethodGet, "/api/v1/exports/latest", "", reqOpts{}), http.StatusUnauthorized, "")
	})

	t.Run("create_validation", func(t *testing.T) {
		want(t, e.do(http.MethodPost, "/api/v1/exports", `{"kind":"plain"}`, reqOpts{sess: "sess-a", csrf: true, idem: "idem-create-badkind-1"}), http.StatusBadRequest, "invalid_request")
		want(t, e.do(http.MethodPost, "/api/v1/exports", `{"kind":"encrypted","x":1}`, reqOpts{sess: "sess-a", csrf: true, idem: "idem-create-extra-01"}), http.StatusBadRequest, "invalid_request")
		want(t, e.do(http.MethodPost, "/api/v1/exports", `{"kind":"encrypted"}`, reqOpts{sess: "sess-a", csrf: true}), http.StatusBadRequest, "")
		want(t, e.do(http.MethodPost, "/api/v1/exports", `{"kind":"encrypted"}`, reqOpts{sess: "sess-a", csrf: true, idem: "idem-create-ctype-01", ctype: "text/plain"}), http.StatusUnsupportedMediaType, "invalid_request")
		big := `{"kind":"encrypted","pad":"` + strings.Repeat("a", 17*1024) + `"}`
		want(t, e.do(http.MethodPost, "/api/v1/exports", big, reqOpts{sess: "sess-a", csrf: true, idem: "idem-create-big-0001"}), http.StatusRequestEntityTooLarge, "")
		want(t, e.create("sess-novault", "idem-create-novault1"), http.StatusNotFound, "vault_absent")
		want(t, e.create("", "idem-create-nosess-1"), http.StatusUnauthorized, "")
	})

	var ready export.Job
	t.Run("create_get_download_ready", func(t *testing.T) {
		ready = e.readyJob("sess-a", "idem-create-ready-01")
		r := e.do(http.MethodGet, "/api/v1/exports/"+ready.ID.String(), "", reqOpts{sess: "sess-a"})
		want(t, r, http.StatusOK, "")
		if j := r.job(t); j.Status != export.StatusReady || j.SizeBytes == nil {
			t.Fatalf("get = %+v", j)
		}
		r = e.do(http.MethodGet, "/api/v1/exports/latest", "", reqOpts{sess: "sess-a"})
		if !strings.Contains(string(r.body), ready.ID.String()) {
			t.Fatalf("latest = %s", r.body)
		}
		r = e.do(http.MethodGet, "/api/v1/exports/"+ready.ID.String()+"/download", "", reqOpts{sess: "sess-a"})
		want(t, r, http.StatusOK, "")
		h := r.header
		if h.Get("Cache-Control") != "no-store, no-transform" || h.Get("Content-Type") != "application/json" ||
			h.Get("X-Content-Type-Options") != "nosniff" ||
			!strings.HasPrefix(h.Get("Content-Disposition"), `attachment; filename="engram-backup-`) ||
			!strings.HasSuffix(h.Get("Content-Disposition"), `.sabk.json"`) {
			t.Fatalf("download headers = %v", h)
		}
		if !json.Valid(r.body) || bytes.HasPrefix(r.body, []byte("ENGX")) {
			t.Fatalf("download body is not plain .sabk.json (%d bytes)", len(r.body))
		}
	})

	t.Run("cross_user_and_bad_id_404_400", func(t *testing.T) {
		id := ready.ID.String()
		g := e.grant("sess-b", exporthttp.ReauthAction)
		want(t, e.do(http.MethodGet, "/api/v1/exports/"+id, "", reqOpts{sess: "sess-b"}), http.StatusNotFound, "not_found")
		want(t, e.do(http.MethodGet, "/api/v1/exports/"+id+"/download", "", reqOpts{sess: "sess-b"}), http.StatusNotFound, "not_found")
		want(t, e.do(http.MethodGet, "/api/v1/exports/"+id+"/decrypted-pages", "", reqOpts{sess: "sess-b", reauth: g}), http.StatusNotFound, "not_found")
		want(t, e.cancel("sess-b", ready.ID, "idem-cancel-xuser-01"), http.StatusNotFound, "not_found")
		want(t, e.do(http.MethodGet, "/api/v1/exports/"+uuid.NewString(), "", reqOpts{sess: "sess-a"}), http.StatusNotFound, "not_found")
		want(t, e.do(http.MethodGet, "/api/v1/exports/not-a-uuid", "", reqOpts{sess: "sess-a"}), http.StatusBadRequest, "invalid_request")
		want(t, e.do(http.MethodGet, "/api/v1/exports/not-a-uuid/download", "", reqOpts{sess: "sess-a"}), http.StatusBadRequest, "invalid_request")
		if e.count(`SELECT count(*) FROM export_job WHERE id = $1 AND status = 'ready'`, ready.ID) != 1 {
			t.Fatal("cross-user cancel changed the job")
		}
	})

	t.Run("decrypted_pages", func(t *testing.T) {
		g := e.grant("sess-a", exporthttp.ReauthAction)
		r := e.do(http.MethodGet, "/api/v1/exports/"+ready.ID.String()+"/decrypted-pages", "", reqOpts{sess: "sess-a", reauth: g})
		want(t, r, http.StatusOK, "")
		var page export.DecryptedPage
		if err := json.Unmarshal(r.body, &page); err != nil || page.SourceExportID != ready.ID || r.header.Get("Cache-Control") != "no-store" {
			t.Fatalf("page = %s err=%v", r.body, err)
		}
		want(t, e.do(http.MethodGet, "/api/v1/exports/"+ready.ID.String()+"/decrypted-pages?cursor=AAAA", "", reqOpts{sess: "sess-a", reauth: g}), http.StatusBadRequest, "invalid_request")
	})

	t.Run("states_409_410", func(t *testing.T) {
		g := e.grant("sess-a", exporthttp.ReauthAction)
		dl := func(id uuid.UUID) resp {
			return e.do(http.MethodGet, "/api/v1/exports/"+id.String()+"/download", "", reqOpts{sess: "sess-a"})
		}
		pages := func(id uuid.UUID) resp {
			return e.do(http.MethodGet, "/api/v1/exports/"+id.String()+"/decrypted-pages", "", reqOpts{sess: "sess-a", reauth: g})
		}

		// queued
		q := e.create("sess-a", "idem-create-queued-01")
		want(t, q, http.StatusAccepted, "")
		qj := q.job(t)
		if qj.Status != export.StatusQueued || q.header.Get("Cache-Control") != "no-store" {
			t.Fatalf("queued create = %+v %v", qj, q.header)
		}
		want(t, dl(qj.ID), http.StatusConflict, "export_not_ready")
		want(t, pages(qj.ID), http.StatusConflict, "export_not_ready")

		// running
		e.exec(`UPDATE export_job SET status='running', attempt_id=gen_random_uuid(), lease_until=now()+interval '10 min', started_at=now() WHERE id=$1`, qj.ID)
		want(t, dl(qj.ID), http.StatusConflict, "export_not_ready")
		want(t, pages(qj.ID), http.StatusConflict, "export_not_ready")

		// cancelled: 200 then idempotent 200 with a new key
		c := e.cancel("sess-a", qj.ID, "idem-cancel-running1")
		want(t, c, http.StatusOK, "")
		if c.job(t).Status != export.StatusCancelled {
			t.Fatalf("cancel = %s", c.body)
		}
		want(t, e.cancel("sess-a", qj.ID, "idem-cancel-again-01"), http.StatusOK, "")
		want(t, dl(qj.ID), http.StatusConflict, "export_not_ready")
		want(t, pages(qj.ID), http.StatusConflict, "export_not_ready")

		// failed
		f := e.create("sess-a", "idem-create-failed-01")
		fj := f.job(t)
		e.exec(`UPDATE export_job SET status='failed', error_code='io' WHERE id=$1`, fj.ID)
		want(t, dl(fj.ID), http.StatusConflict, "export_not_ready")
		want(t, pages(fj.ID), http.StatusConflict, "export_not_ready")
		want(t, e.cancel("sess-a", fj.ID, "idem-cancel-failed-1"), http.StatusConflict, "export_not_ready")

		// ready but past expires_at (prune not run yet) -> 410 everywhere, latest says expired
		e.exec(`UPDATE export_job SET expires_at = now() - interval '1 second' WHERE id=$1`, ready.ID)
		want(t, dl(ready.ID), http.StatusGone, "export_expired")
		want(t, pages(ready.ID), http.StatusGone, "export_expired")
		want(t, e.cancel("sess-a", ready.ID, "idem-cancel-expire-1"), http.StatusGone, "export_expired")
		r := e.do(http.MethodGet, "/api/v1/exports/"+ready.ID.String(), "", reqOpts{sess: "sess-a"})
		if r.job(t).Status != export.StatusExpired {
			t.Fatalf("lazy expired get = %s", r.body)
		}

		// expired row
		e.exec(`UPDATE export_job SET status='expired' WHERE id=$1`, ready.ID)
		want(t, dl(ready.ID), http.StatusGone, "export_expired")
		want(t, pages(ready.ID), http.StatusGone, "export_expired")
		want(t, e.cancel("sess-a", ready.ID, "idem-cancel-expire-2"), http.StatusGone, "export_expired")
	})

	t.Run("cancel_body_strict", func(t *testing.T) {
		j := e.create("sess-b", "idem-create-b-cancel1").job(t)
		want(t, e.do(http.MethodPost, "/api/v1/exports/"+j.ID.String()+"/cancel", `{"x":1}`, reqOpts{sess: "sess-b", csrf: true, idem: "idem-cancel-extra-01"}), http.StatusBadRequest, "invalid_request")
		want(t, e.do(http.MethodPost, "/api/v1/exports/not-a-uuid/cancel", `{}`, reqOpts{sess: "sess-b", csrf: true, idem: "idem-cancel-baduuid1"}), http.StatusBadRequest, "invalid_request")
	})

	t.Run("audit_export_decrypted", func(t *testing.T) {
		e.exec(`DELETE FROM user_notification`)
		e.exec(`DELETE FROM river_job WHERE kind = 'security_notice_mail'`)
		g := e.grant("sess-a", exporthttp.ReauthAction)
		uid := e.users["sess-a"].UserID
		want(t, e.do(http.MethodPost, "/api/v1/audit/export-decrypted", `{"x":1}`, reqOpts{sess: "sess-a", csrf: true, idem: "idem-audit-extra-001", reauth: g}), http.StatusBadRequest, "invalid_request")
		r := e.do(http.MethodPost, "/api/v1/audit/export-decrypted", `{}`, reqOpts{sess: "sess-a", csrf: true, idem: "idem-audit-ok-000001", reauth: g})
		want(t, r, http.StatusNoContent, "")
		if len(r.body) != 0 {
			t.Fatalf("204 body = %q", r.body)
		}
		e.assertDecryptedAuditSideEffects(t, uid, 1)
		// Replay with the same key: 204, no second audit/notice/mail job.
		r = e.do(http.MethodPost, "/api/v1/audit/export-decrypted", `{}`, reqOpts{sess: "sess-a", csrf: true, idem: "idem-audit-ok-000001", reauth: g})
		want(t, r, http.StatusNoContent, "")
		e.assertDecryptedAuditSideEffects(t, uid, 1)
	})

	t.Run("paused_503_before_any_write", func(t *testing.T) {
		e.paused = true
		defer func() { e.paused = false }()
		before := e.rateEvents("sess-b")
		r := e.create("sess-b", "idem-create-paused-01")
		want(t, r, http.StatusServiceUnavailable, "dependency_unavailable")
		if r.header.Get("Retry-After") != "600" {
			t.Fatalf("Retry-After = %q", r.header.Get("Retry-After"))
		}
		if e.rateEvents("sess-b") != before || e.count(`SELECT count(*) FROM idempotency_key WHERE key = 'idem-create-paused-01'`) != 0 {
			t.Fatal("paused create wrote rate_event or idempotency row")
		}
	})
}

// TestExportHTTPCreateCoalesceNotRateLimited: 3 existing events + a running
// job -> POST returns 202 with that job (no 429, no new rate_event); two
// parallel POSTs with distinct keys and no active job -> exactly one new job
// and one rate_event (C05: quota only inside the create tx).
func TestExportHTTPCreateCoalesceNotRateLimited(t *testing.T) {
	e := newEnv(t)
	uid := e.users["sess-a"].UserID

	first := e.create("sess-a", "idem-coalesce-first1")
	want(t, first, http.StatusAccepted, "")
	j := first.job(t)
	e.exec(`UPDATE export_job SET status='running', attempt_id=gen_random_uuid(), lease_until=now()+interval '10 min', started_at=now() WHERE id=$1`, j.ID)
	e.exec(`INSERT INTO rate_event (scope, user_id) VALUES ('export_create', $1), ('export_create', $1)`, uid)
	if e.rateEvents("sess-a") != 3 {
		t.Fatal("setup: want 3 rate events")
	}
	r := e.create("sess-a", "idem-coalesce-second")
	want(t, r, http.StatusAccepted, "")
	if got := r.job(t); got.ID != j.ID || got.Status != export.StatusRunning {
		t.Fatalf("coalesce = %+v, want running %s", got, j.ID)
	}
	if e.rateEvents("sess-a") != 3 {
		t.Fatal("coalesced POST consumed quota")
	}

	// Parallel distinct keys on a fresh user: one INSERT, one rate_event.
	var wg sync.WaitGroup
	results := make([]resp, 2)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = e.create("sess-b", fmt.Sprintf("idem-parallel-key-%02d", i))
		}(i)
	}
	wg.Wait()
	for _, r := range results {
		want(t, r, http.StatusAccepted, "")
	}
	if results[0].job(t).ID != results[1].job(t).ID {
		t.Fatal("parallel POSTs created two jobs")
	}
	if n := e.rateEvents("sess-b"); n != 1 {
		t.Fatalf("parallel POSTs rate_event = %d, want 1", n)
	}
}

// TestExportHTTPCreateFourthIs429: three new jobs (each cancelled, cancelled
// still counts) then a 4th POST -> 429 rate_limited + Retry-After.
func TestExportHTTPCreateFourthIs429(t *testing.T) {
	e := newEnv(t)
	for i := range 3 {
		r := e.create("sess-a", fmt.Sprintf("idem-quota-create-%02d", i))
		want(t, r, http.StatusAccepted, "")
		want(t, e.cancel("sess-a", r.job(t).ID, fmt.Sprintf("idem-quota-cancel-%02d", i)), http.StatusOK, "")
	}
	r := e.create("sess-a", "idem-quota-create-04")
	want(t, r, http.StatusTooManyRequests, "rate_limited")
	if ra := r.header.Get("Retry-After"); ra == "" || ra == "0" {
		t.Fatalf("Retry-After = %q", ra)
	}
	var p struct {
		RetryAfter int `json:"retry_after"`
	}
	if err := json.Unmarshal(r.body, &p); err != nil || p.RetryAfter < 1 {
		t.Fatalf("retry_after body = %s", r.body)
	}
	if n := e.count(`SELECT count(*) FROM export_job WHERE user_id=$1`, e.users["sess-a"].UserID); n != 3 {
		t.Fatalf("jobs = %d, want 3", n)
	}
}

// TestExportHTTPDecryptedPagesNoQuota: 20 decrypted-pages reads add no rate_event.
func TestExportHTTPDecryptedPagesNoQuota(t *testing.T) {
	e := newEnv(t)
	j := e.readyJob("sess-a", "idem-pages-noquota-1")
	before := e.rateEvents("sess-a")
	g := e.grant("sess-a", exporthttp.ReauthAction)
	for range 20 {
		want(t, e.do(http.MethodGet, "/api/v1/exports/"+j.ID.String()+"/decrypted-pages", "", reqOpts{sess: "sess-a", reauth: g}), http.StatusOK, "")
	}
	if n := e.count(`SELECT count(*) FROM rate_event WHERE user_id=$1`, e.users["sess-a"].UserID); n != before {
		t.Fatalf("rate_event %d -> %d after decrypted-pages", before, n)
	}
}

// TestExportHTTPCreateIdempotency: replay with the same key returns the same
// job without a second rate_event; same key + other body -> 409 conflict.
func TestExportHTTPCreateIdempotency(t *testing.T) {
	e := newEnv(t)
	a := e.create("sess-a", "idem-replay-same-key1")
	want(t, a, http.StatusAccepted, "")
	b := e.create("sess-a", "idem-replay-same-key1")
	want(t, b, http.StatusAccepted, "")
	if a.job(t).ID != b.job(t).ID {
		t.Fatal("replay returned a different job")
	}
	if e.rateEvents("sess-a") != 1 {
		t.Fatal("replay consumed quota")
	}
	c := e.do(http.MethodPost, "/api/v1/exports", `{"kind":"encrypted" }`, reqOpts{sess: "sess-a", csrf: true, idem: "idem-replay-same-key1"})
	want(t, c, http.StatusConflict, "idempotency_conflict")

	id := a.job(t).ID
	c1 := e.cancel("sess-a", id, "idem-replay-cancel-01")
	c2 := e.cancel("sess-a", id, "idem-replay-cancel-01")
	want(t, c1, http.StatusOK, "")
	want(t, c2, http.StatusOK, "")
	if !reflect.DeepEqual(c1.job(t), c2.job(t)) {
		t.Fatalf("cancel replay differs: %s vs %s", c1.body, c2.body)
	}
}

// TestExportHTTPMutationsCSRF: every mutation without X-CSRF-Token -> 403.
func TestExportHTTPMutationsCSRF(t *testing.T) {
	e := newEnv(t)
	g := e.grant("sess-a", exporthttp.ReauthAction)
	id := uuid.NewString()
	for _, tc := range []struct{ path, body, key, reauth string }{
		{"/api/v1/exports", `{"kind":"encrypted"}`, "idem-csrf-create-001", ""},
		{"/api/v1/exports/" + id + "/cancel", `{}`, "idem-csrf-cancel-001", ""},
		{"/api/v1/audit/export-decrypted", `{}`, "idem-csrf-audit-0001", g},
	} {
		want(t, e.do(http.MethodPost, tc.path, tc.body, reqOpts{sess: "sess-a", idem: tc.key, reauth: tc.reauth}), http.StatusForbidden, "csrf_invalid")
	}
	if e.count(`SELECT count(*) FROM export_job`) != 0 || e.count(`SELECT count(*) FROM audit_log WHERE event='export.decrypted'`) != 0 {
		t.Fatal("CSRF-rejected mutation wrote state")
	}
}

// TestExportHTTPMutationsOrigin: missing or foreign Origin -> 403.
func TestExportHTTPMutationsOrigin(t *testing.T) {
	e := newEnv(t)
	g := e.grant("sess-a", exporthttp.ReauthAction)
	for _, origin := range []string{"-", "https://evil.example"} {
		for _, tc := range []struct{ path, body, reauth string }{
			{"/api/v1/exports", `{"kind":"encrypted"}`, ""},
			{"/api/v1/exports/" + uuid.NewString() + "/cancel", `{}`, ""},
			{"/api/v1/audit/export-decrypted", `{}`, g},
		} {
			r := e.do(http.MethodPost, tc.path, tc.body, reqOpts{sess: "sess-a", csrf: true, origin: origin, idem: "idem-origin-" + uuid.NewString()[:8], reauth: tc.reauth})
			if r.code != http.StatusForbidden {
				t.Fatalf("%s origin=%s = %d %s", tc.path, origin, r.code, r.body)
			}
		}
	}
	if e.count(`SELECT count(*) FROM export_job`) != 0 {
		t.Fatal("origin-rejected create wrote a job")
	}
}

// TestExportHTTPDecryptedReauth: decrypted-pages and the audit need the
// export.decrypted grant (401 reauth_required / reauth_invalid); the GET
// needs no CSRF token.
func TestExportHTTPDecryptedReauth(t *testing.T) {
	e := newEnv(t)
	j := e.readyJob("sess-a", "idem-reauth-ready-001")
	pagesPath := "/api/v1/exports/" + j.ID.String() + "/decrypted-pages"
	other := e.grant("sess-a", "account.delete")
	otherUser := e.grant("sess-b", exporthttp.ReauthAction)

	want(t, e.do(http.MethodGet, pagesPath, "", reqOpts{sess: "sess-a"}), http.StatusUnauthorized, "reauth_required")
	want(t, e.do(http.MethodGet, pagesPath, "", reqOpts{sess: "sess-a", reauth: "garbage"}), http.StatusUnauthorized, "reauth_invalid")
	want(t, e.do(http.MethodGet, pagesPath, "", reqOpts{sess: "sess-a", reauth: other}), http.StatusUnauthorized, "reauth_invalid")
	want(t, e.do(http.MethodGet, pagesPath, "", reqOpts{sess: "sess-a", reauth: otherUser}), http.StatusUnauthorized, "reauth_invalid")
	// GET without CSRF header and without Origin succeeds with a valid grant.
	want(t, e.do(http.MethodGet, pagesPath, "", reqOpts{sess: "sess-a", origin: "-", noCType: true, reauth: e.grant("sess-a", exporthttp.ReauthAction)}), http.StatusOK, "")

	audit := func(reauth, key string) resp {
		return e.do(http.MethodPost, "/api/v1/audit/export-decrypted", `{}`, reqOpts{sess: "sess-a", csrf: true, idem: key, reauth: reauth})
	}
	want(t, audit("", "idem-reauth-audit-001"), http.StatusUnauthorized, "reauth_required")
	want(t, audit("garbage", "idem-reauth-audit-002"), http.StatusUnauthorized, "reauth_invalid")
	want(t, audit(other, "idem-reauth-audit-003"), http.StatusUnauthorized, "reauth_invalid")
	if e.count(`SELECT count(*) FROM audit_log WHERE event='export.decrypted'`) != 0 {
		t.Fatal("reauth-rejected audit was recorded")
	}
}

// assertDecryptedAuditSideEffects checks exactly n export.decrypted audits
// (meta {}), n notifications and n security_notice_mail River jobs, each job
// linked to one of those notification IDs.
func (e *env) assertDecryptedAuditSideEffects(t *testing.T, uid uuid.UUID, n int) {
	t.Helper()
	if got := e.count(`SELECT count(*) FROM audit_log WHERE user_id=$1 AND event='export.decrypted' AND meta = '{}'::jsonb`, uid); got != n {
		t.Fatalf("export.decrypted audit rows = %d, want %d", got, n)
	}
	if got := e.count(`SELECT count(*) FROM user_notification WHERE user_id=$1`, uid); got != n {
		t.Fatalf("user_notification rows = %d, want %d", got, n)
	}
	if got := e.count(`SELECT count(*) FROM river_job WHERE kind='security_notice_mail'`); got != n {
		t.Fatalf("security_notice_mail jobs = %d, want %d", got, n)
	}
	if got := e.count(`SELECT count(*) FROM river_job j JOIN user_notification u ON u.id = (j.args->>'notification_id')::bigint
		WHERE j.kind='security_notice_mail' AND u.user_id=$1`, uid); got != n {
		t.Fatalf("mail jobs linked to the user's notification = %d, want %d", got, n)
	}
}

// TestExportHTTPStrictEmptyObjectBodies: cancel and the decrypted audit accept
// only `{}`; null, arrays, scalars, unknown/duplicate fields and trailing
// JSON are 400 invalid_request with no state change.
func TestExportHTTPStrictEmptyObjectBodies(t *testing.T) {
	e := newEnv(t)
	uid := e.users["sess-a"].UserID
	j := e.create("sess-a", "idem-strict-create-01").job(t)
	g := e.grant("sess-a", exporthttp.ReauthAction)
	bad := []string{`null`, `[]`, `"x"`, `1`, `true`, `{"a":1}`, `{"a":1,"a":1}`, `{} {}`, `{}null`}
	for i, body := range bad {
		r := e.do(http.MethodPost, "/api/v1/exports/"+j.ID.String()+"/cancel", body, reqOpts{sess: "sess-a", csrf: true, idem: fmt.Sprintf("idem-strict-cancel-%02d", i)})
		want(t, r, http.StatusBadRequest, "invalid_request")
		r = e.do(http.MethodPost, "/api/v1/audit/export-decrypted", body, reqOpts{sess: "sess-a", csrf: true, reauth: g, idem: fmt.Sprintf("idem-strict-audit-%02d", i)})
		want(t, r, http.StatusBadRequest, "invalid_request")
	}
	if e.count(`SELECT count(*) FROM export_job WHERE id=$1 AND status='queued'`, j.ID) != 1 {
		t.Fatal("invalid cancel body changed the job")
	}
	e.assertDecryptedAuditSideEffects(t, uid, 0)
	want(t, e.cancel("sess-a", j.ID, "idem-strict-cancel-ok"), http.StatusOK, "")
}

// seedTags adds n tags so the snapshot spans several 64 KiB ENGX1 frames.
func (e *env) seedTags(sess string, n int) {
	e.t.Helper()
	e.exec(`INSERT INTO tag (user_id, display, normalized)
		SELECT $1, d, d FROM (SELECT 'tag-' || lpad(g::text, 40, '0') AS d FROM generate_series(1, $2) g) s`,
		e.users[sess].UserID, n)
}

func (e *env) jobFilePath(id uuid.UUID) string {
	e.t.Helper()
	var name string
	if err := e.pool.QueryRow(context.Background(), `SELECT file_name FROM export_job WHERE id=$1`, id).Scan(&name); err != nil {
		e.t.Fatal(err)
	}
	return filepath.Join(e.storage, name)
}

func httpGet(t *testing.T, url, sess string) (int, []byte, error) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "sabk_session", Value: sess})
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(res.Body)
	return res.StatusCode, body, err
}

// TestExportHTTPDownloadCorruptStreamAborts: over real HTTP, an intact
// multi-frame snapshot downloads completely; a corrupted later frame makes
// the client see a transport error, never a clean truncated 200.
func TestExportHTTPDownloadCorruptStreamAborts(t *testing.T) {
	e := newEnv(t)
	e.seedTags("sess-a", 3000)
	j := e.readyJob("sess-a", "idem-corrupt-ready-01")
	srv := httptest.NewServer(e.handler)
	defer srv.Close()
	url := srv.URL + "/api/v1/exports/" + j.ID.String() + "/download"

	status, body, err := httpGet(t, url, "sess-a")
	if err != nil || status != http.StatusOK || !json.Valid(body) || len(body) < 3*65536 {
		t.Fatalf("intact download: err=%v len=%d", err, len(body))
	}

	path := e.jobFilePath(j.ID)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	raw[len(raw)-1] ^= 0xff // break the final frame's AEAD tag
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	status, body, err = httpGet(t, url, "sess-a")
	if err == nil {
		t.Fatalf("corrupt download completed cleanly: status=%d len=%d", status, len(body))
	}
	if !strings.Contains(e.logs.String(), "export download stream aborted") {
		t.Fatalf("abort not logged: %s", e.logs.String())
	}
}

// TestExportHTTPDownloadErrorLogPrivacy: a missing spool file yields a
// generic 500 and the log line carries no path, job or attempt ID.
func TestExportHTTPDownloadErrorLogPrivacy(t *testing.T) {
	e := newEnv(t)
	j := e.readyJob("sess-a", "idem-logpriv-ready-01")
	path := e.jobFilePath(j.ID)
	var attempt uuid.UUID
	if err := e.pool.QueryRow(context.Background(), `SELECT attempt_id FROM export_job WHERE id=$1`, j.ID).Scan(&attempt); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	r := e.do(http.MethodGet, "/api/v1/exports/"+j.ID.String()+"/download", "", reqOpts{sess: "sess-a"})
	want(t, r, http.StatusInternalServerError, "internal_error")
	if r.header.Get("Cache-Control") != "no-store" || bytes.Contains(r.body, []byte(j.ID.String())) {
		t.Fatalf("500 response = %v %s", r.header, r.body)
	}
	logs := e.logs.String()
	if !strings.Contains(logs, "error_class=fs_not_exist") {
		t.Fatalf("missing error class: %s", logs)
	}
	for _, secret := range []string{e.storage, filepath.Base(path), j.ID.String(), attempt.String()} {
		if strings.Contains(logs, secret) {
			t.Fatalf("log leaks %q: %s", secret, logs)
		}
	}
}
