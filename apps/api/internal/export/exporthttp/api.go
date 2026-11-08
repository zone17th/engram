// Package exporthttp mounts the `/api/v1/exports*` and
// `/api/v1/audit/export-decrypted` operations (plan P06 Task 11, mục 3).
package exporthttp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/export"
	"github.com/zone17th/engram/apps/api/internal/httpx"
)

// ReauthAction is the grant action for decrypted-pages and the decrypted audit.
const ReauthAction = "export.decrypted"

// DownloadWriteTimeout bounds one /download response (overrides the server
// WriteTimeout for this route only).
const DownloadWriteTimeout = 30 * time.Minute

// PausedRetryAfter is the Retry-After (seconds) sent with 503 when
// EXPORT_CREATE_PAUSED is on (plan mục 2.4 step 0).
const PausedRetryAfter = 600

// Service is the subset of export.Service the handlers call.
type Service interface {
	Create(ctx context.Context, userID uuid.UUID, kind string) (export.Job, bool, error)
	Latest(ctx context.Context, userID uuid.UUID) (*export.Job, error)
	Get(ctx context.Context, userID, jobID uuid.UUID) (export.Job, error)
	Cancel(ctx context.Context, userID, jobID uuid.UUID) (export.Job, error)
	OpenDownload(ctx context.Context, userID, jobID uuid.UUID) (*export.DownloadStream, error)
	DecryptedPages(ctx context.Context, userID, jobID uuid.UUID, cursor string, budget int) (export.DecryptedPage, error)
	RecordDecryptedAudit(ctx context.Context, p authctx.Principal, ip, ua string) error
}

// API holds the export handlers and their shared middleware dependencies.
type API struct {
	svc     Service
	idem    *httpx.Idempotency
	paused  func() bool
	trusted func(net.IP) bool
	logger  *slog.Logger
}

// NewAPI builds the export HTTP API. paused reports EXPORT_CREATE_PAUSED and is
// checked before any idempotency read/write; trusted resolves proxy CIDRs.
func NewAPI(svc Service, idem *httpx.Idempotency, paused func() bool, trusted func(net.IP) bool, logger *slog.Logger) *API {
	if paused == nil {
		paused = func() bool { return false }
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &API{svc: svc, idem: idem, paused: paused, trusted: trusted, logger: logger}
}

// Mount registers the export routes with the chains of the canonical table
// (plan mục 3). POST /exports deliberately has NO UserLimiter middleware (C05):
// the export_create quota is consumed only by ConsumeTx inside the create tx.
//
//   - POST /exports (exportCreate): pause gate + S + C + I
//   - GET /exports/latest (exportGetLatest): S
//   - GET /exports/{id} (exportGet): S
//   - GET /exports/{id}/download (exportDownload): S
//   - POST /exports/{id}/cancel (exportCancel): S + C + I
//   - GET /exports/{id}/decrypted-pages (exportDecryptedPages): S + A(export.decrypted)
//   - POST /audit/export-decrypted (exportDecryptedAudit): S + C + A(export.decrypted) + I
func Mount(api *API) func(v1 chi.Router, d httpx.Deps) {
	return func(v1 chi.Router, d httpx.Deps) {
		if api == nil || api.svc == nil || api.idem == nil {
			panic("export routes require export.Service and Idempotency — refusing empty mount")
		}
		if d.Authenticator == nil || d.CSRF == nil || d.Reauth == nil {
			panic("export routes require Authenticator, CSRF and Reauth — refusing empty verifiers")
		}
		origin := ""
		if d.Config != nil {
			origin = d.Config.AppOrigin
		}
		reauth := requireTokenReauth{d.Reauth}
		mutation := func(action string, h http.HandlerFunc) http.Handler {
			return httpx.ChainIdempotencyMiddleware(httpx.IdempotencyRouteConfig{
				AppOrigin:     origin,
				Authenticator: d.Authenticator,
				CSRF:          d.CSRF,
				Idempotency:   api.idem,
				Reauth:        reauth,
				ReauthAction:  action,
				BodyLimit:     httpx.IdempotencyBodyLimit{Bytes: httpx.AuthJSONLimit},
			}, h)
		}

		v1.Method(http.MethodPost, "/exports", api.pauseGate(mutation("", api.Create)))
		v1.Method(http.MethodPost, "/exports/{id}/cancel", mutation("", api.Cancel))
		v1.Method(http.MethodPost, "/audit/export-decrypted", mutation(ReauthAction, api.DecryptedAudit))

		v1.Group(func(g chi.Router) {
			g.Use(httpx.RequireSession(d.Authenticator))
			g.Get("/exports/latest", api.Latest)
			g.Get("/exports/{id}", api.Get)
			g.Get("/exports/{id}/download", api.Download)
			g.With(httpx.RequireReauth(reauth, ReauthAction)).Get("/exports/{id}/decrypted-pages", api.DecryptedPages)
		})
	}
}

// requireTokenReauth maps a missing X-Reauth-Token to 401 reauth_required
// before the grant verifier runs (same as DELETE /me).
type requireTokenReauth struct {
	httpx.ReauthVerifier
}

func (r requireTokenReauth) VerifyReauth(ctx context.Context, p authctx.Principal, action, token string) error {
	if strings.TrimSpace(token) == "" {
		return &httpx.AuthError{Code: "reauth_required"}
	}
	return r.ReauthVerifier.VerifyReauth(ctx, p, action, token)
}

// pauseGate answers 503 dependency_unavailable + Retry-After: 600 before
// idempotency replay, claim or any DB write (plan mục 2.4 step 0).
func (a *API) pauseGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a.paused() {
			writePaused(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writePaused(w http.ResponseWriter, r *http.Request) {
	ra := PausedRetryAfter
	noStore(w)
	httpx.WriteProblemExtra(w, r, http.StatusServiceUnavailable, "dependency_unavailable",
		"Tạo bản sao lưu đang tạm dừng.", httpx.ProblemExtra{RetryAfter: &ra})
}

// Create handles POST /api/v1/exports.
func (a *API) Create(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	var in struct {
		Kind string `json:"kind"`
	}
	if !httpx.DecodeJSON(w, r, &in) {
		return
	}
	if in.Kind != export.KindEncrypted {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "kind phải là \"encrypted\".")
		return
	}
	job, _, err := a.svc.Create(r.Context(), p.UserID, in.Kind)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	noStore(w)
	writeJSON(w, http.StatusAccepted, job)
}

// Latest handles GET /api/v1/exports/latest.
func (a *API) Latest(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	job, err := a.svc.Latest(r.Context(), p.UserID)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	noStore(w)
	writeJSON(w, http.StatusOK, struct {
		Job *export.Job `json:"job"`
	}{Job: job})
}

// Get handles GET /api/v1/exports/{id}.
func (a *API) Get(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	id, ok := jobID(w, r)
	if !ok {
		return
	}
	job, err := a.svc.Get(r.Context(), p.UserID, id)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	noStore(w)
	writeJSON(w, http.StatusOK, job)
}

// Download handles GET /api/v1/exports/{id}/download: streams the ENGX1
// at-rest file decrypted to the original .sabk.json bytes.
func (a *API) Download(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	id, ok := jobID(w, r)
	if !ok {
		return
	}
	stream, err := a.svc.OpenDownload(r.Context(), p.UserID, id)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	// The server-wide WriteTimeout (30s) would cut large backups mid-stream;
	// extend it for this response only, still bounded.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(DownloadWriteTimeout))
	defer func() { _ = stream.Close() }()
	h := w.Header()
	h.Del("ETag")
	h.Set("Cache-Control", "no-store, no-transform")
	h.Set("Content-Type", "application/json")
	h.Set("Content-Disposition", `attachment; filename="`+stream.FileName+`"`)
	h.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, stream); err != nil {
		if r.Context().Err() == nil {
			a.logFailure(r, "export download stream aborted", err)
		}
		// Headers are already sent: abort the connection so the client sees a
		// transport error instead of a clean, truncated 200 attachment.
		panic(http.ErrAbortHandler)
	}
}

// Cancel handles POST /api/v1/exports/{id}/cancel.
func (a *API) Cancel(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	id, ok := jobID(w, r)
	if !ok {
		return
	}
	if !decodeEmptyObject(w, r) {
		return
	}
	job, err := a.svc.Cancel(r.Context(), p.UserID, id)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	noStore(w)
	writeJSON(w, http.StatusOK, job)
}

// DecryptedPages handles GET /api/v1/exports/{id}/decrypted-pages. It never
// consumes export_create quota.
func (a *API) DecryptedPages(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	id, ok := jobID(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	if len(q["cursor"]) > 1 {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "cursor không hợp lệ.")
		return
	}
	page, err := a.svc.DecryptedPages(r.Context(), p.UserID, id, q.Get("cursor"), export.DecryptedPageMaxBytes)
	if err != nil {
		a.writeError(w, r, err)
		return
	}
	noStore(w)
	writeJSON(w, http.StatusOK, page)
}

// DecryptedAudit handles POST /api/v1/audit/export-decrypted.
func (a *API) DecryptedAudit(w http.ResponseWriter, r *http.Request) {
	p, ok := principal(w, r)
	if !ok {
		return
	}
	if !decodeEmptyObject(w, r) {
		return
	}
	if err := a.svc.RecordDecryptedAudit(r.Context(), p, httpx.ClientIP(r, a.trusted), r.UserAgent()); err != nil {
		a.writeError(w, r, err)
		return
	}
	noStore(w)
	w.WriteHeader(http.StatusNoContent)
}

// writeError maps export domain errors to the canonical problem codes (mục 3).
func (a *API) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var rl *export.RateLimitError
	switch {
	case errors.As(err, &rl):
		ra := rl.RetryAfter
		if ra < 1 {
			ra = 1
		}
		httpx.WriteProblemExtra(w, r, http.StatusTooManyRequests, "rate_limited",
			"Đã tạo đủ 3 bản sao lưu trong 60 phút.", httpx.ProblemExtra{RetryAfter: &ra})
	case errors.Is(err, export.ErrCreatePaused):
		writePaused(w, r)
	case errors.Is(err, export.ErrVaultAbsent):
		httpx.WriteProblem(w, r, http.StatusNotFound, "vault_absent", httpx.ProblemTitle("vault_absent")+".")
	case errors.Is(err, export.ErrNotFound):
		httpx.WriteProblem(w, r, http.StatusNotFound, "not_found", "Không tìm thấy bản sao lưu.")
	case errors.Is(err, export.ErrNotReady):
		httpx.WriteProblem(w, r, http.StatusConflict, "export_not_ready", httpx.ProblemTitle("export_not_ready")+".")
	case errors.Is(err, export.ErrExpired):
		httpx.WriteProblem(w, r, http.StatusGone, "export_expired", httpx.ProblemTitle("export_expired")+".")
	case errors.Is(err, export.ErrInvalidCursor):
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "cursor không hợp lệ.")
	case httpx.IsContentRetryableTxError(err), errors.Is(err, context.DeadlineExceeded):
		httpx.WriteProblem(w, r, http.StatusServiceUnavailable, "dependency_unavailable", httpx.ProblemTitle("dependency_unavailable")+".")
	default:
		a.logFailure(r, "export handler error", err)
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
	}
}

// decodeEmptyObject accepts exactly the JSON object `{}` (OpenAPI
// EmptyObject); `null`, arrays, scalars and unknown fields are 400.
func decodeEmptyObject(w http.ResponseWriter, r *http.Request) bool {
	var in *struct{}
	if !httpx.DecodeJSON(w, r, &in) {
		return false
	}
	if in == nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Nội dung phải là đối tượng JSON {}.")
		return false
	}
	return true
}

// logFailure logs a bounded error class and the route pattern only: raw
// error strings can carry spool paths, job/attempt IDs or DB values
// (plan mục 2.5.5).
func (a *API) logFailure(r *http.Request, msg string, err error) {
	route := ""
	if rc := chi.RouteContext(r.Context()); rc != nil {
		route = rc.RoutePattern()
	}
	a.logger.ErrorContext(r.Context(), msg, slog.String("route", route), slog.String("error_class", errorClass(err)))
}

func errorClass(err error) string {
	var pgErr *pgconn.PgError
	var pathErr *fs.PathError
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return "context"
	case errors.Is(err, fs.ErrNotExist):
		return "fs_not_exist"
	case errors.Is(err, fs.ErrPermission):
		return "fs_permission"
	case errors.As(err, &pathErr):
		return "fs"
	case errors.As(err, &pgErr):
		return "db_" + pgErr.Code
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "truncated"
	default:
		return "other"
	}
}

func principal(w http.ResponseWriter, r *http.Request) (authctx.Principal, bool) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
	}
	return p, ok
}

func jobID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil || id.Version() != 4 {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "ID bản sao lưu không hợp lệ.")
		return uuid.UUID{}, false
	}
	return id, true
}

func noStore(w http.ResponseWriter) {
	w.Header().Del("ETag")
	w.Header().Set("Cache-Control", "no-store")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
