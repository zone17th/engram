// Package taghttp cung cấp HTTP handlers và đăng ký route cho `/api/v1/tags*`
// cũng như `/api/v1/items/{id}/tags*` theo hợp đồng OpenAPI (operationIds
// `tagsList`, `tagUpsert`, `tagRename`, `tagDelete`, `tagRestore`, `itemTagsAdd`,
// `itemTagRemove`) và plan P04 mục 2.1–2.8, 3, Task 5.
//
// Ràng buộc bảo mật (user-dec-016):
//   - Tuyệt đối không đưa `display` hoặc `q` vào log, metric label, audit meta
//     hay thông điệp chi tiết lỗi.
package taghttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
	"sync/atomic"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/item"
	"github.com/zone17th/engram/apps/api/internal/item/itemhttp"
	"github.com/zone17th/engram/apps/api/internal/tag"
	"github.com/zone17th/engram/apps/api/internal/textnorm"
)

// ContentProvider là giao diện cục bộ trên `*compose.Content` (advisor-dec-149),
// dùng chung định nghĩa với `itemhttp.ContentProvider`.
type ContentProvider = itemhttp.ContentProvider

// TestHooks cho phép các test đồng thời (barrier tests P4BE1-6, A2) của Task 5
// đồng bộ hoá tại thời điểm giữ `LockUserContent` hoặc giữa hai bước `SELECT` và
// `INSERT`/trả về của `tagUpsert` mà không dùng `time.Sleep`.
type TestHooks struct {
	// OnLockUserContent được gọi ngay sau khi handler lấy `LockUserContent`
	// (hoặc `item.LockUserContentAndItem`).
	OnLockUserContent func(ctx context.Context, userID uuid.UUID, op string)
	// OnBetweenUpsertSteps được gọi trong `POST /tags` (`tagUpsert`) ngay sau
	// bước `GetLiveTagByUserAndNormalized` và trước khi trả về 200 hoặc gọi `InsertTag` (P4BE1-6).
	OnBetweenUpsertSteps func(ctx context.Context, userID uuid.UUID, normalized string, foundLive bool)
}

var globalTestHooks atomic.Pointer[TestHooks]

// RegisterTestHooks đăng ký `*TestHooks` cho phiên kiểm thử hiện tại và tự động
// gỡ khi `tb.Cleanup` chạy.
func RegisterTestHooks(tb interface{ Cleanup(func()) }, hooks *TestHooks) {
	globalTestHooks.Store(hooks)
	if tb != nil {
		tb.Cleanup(func() {
			globalTestHooks.CompareAndSwap(hooks, nil)
		})
	}
}

// API gom các phụ thuộc HTTP của nhóm route `/api/v1/tags*` và `/api/v1/items/{id}/tags*` (Task 5).
type API struct {
	provider ContentProvider
	svc      *tag.Service
	hooks    atomic.Pointer[TestHooks]
}

// NewAPI khởi tạo `*API` cho các route tag và gán tag (Task 5).
func NewAPI(provider ContentProvider) *API {
	if provider == nil {
		panic("taghttp.NewAPI: missing ContentProvider")
	}
	return &API{
		provider: provider,
		svc:      tag.NewService(provider.ContentPool(), provider.ContentClock()),
	}
}

// Service trả về `*tag.Service` gắn với API.
func (a *API) Service() *tag.Service { return a.svc }

// SetTestHooks gắn `*TestHooks` trực tiếp lên thực thể `*API`.
func (a *API) SetTestHooks(hooks *TestHooks) {
	a.hooks.Store(hooks)
}

func (a *API) activeHooks() *TestHooks {
	if h := a.hooks.Load(); h != nil {
		return h
	}
	return globalTestHooks.Load()
}

func (a *API) fireOnLockUserContent(ctx context.Context, userID uuid.UUID, op string) {
	if h := a.activeHooks(); h != nil && h.OnLockUserContent != nil {
		h.OnLockUserContent(ctx, userID, op)
	}
}

func (a *API) fireOnBetweenUpsertSteps(ctx context.Context, userID uuid.UUID, normalized string, foundLive bool) {
	if h := a.activeHooks(); h != nil && h.OnBetweenUpsertSteps != nil {
		h.OnBetweenUpsertSteps(ctx, userID, normalized, foundLive)
	}
}

// Mount đăng ký các route `/api/v1/tags*` và `/api/v1/items/{id}/tags*` của P04 Task 5:
//   - GET /tags (`tagsList`): S
//   - POST /tags (`tagUpsert`): S + C + I + R (16 KiB limit)
//   - PATCH /tags/{id} (`tagRename`): S + C + I + R (16 KiB limit)
//   - DELETE /tags/{id} (`tagDelete`): S + C(AllowEmptyDelete) + I + R (16 KiB limit)
//   - POST /tags/{id}/restore (`tagRestore`): S + C + I + R (16 KiB limit)
//   - POST /items/{id}/tags (`itemTagsAdd`): S + C + I + R (16 KiB limit)
//   - DELETE /items/{id}/tags/{tag_id} (`itemTagRemove`): S + C(AllowEmptyDelete) + I + R (16 KiB limit)
//
// Giữ chữ ký `Mount(deps ...any)` theo seam Task 3b (advisor-dec-149):
// tham số đầu tiên có thể là `*API` hoặc `ContentProvider` (`*compose.Content`);
// nếu thiếu hoặc không khớp giao diện sẽ panic rõ ràng lúc khởi động.
func Mount(deps ...any) func(v1 chi.Router, d httpx.Deps) {
	if len(deps) == 0 || deps[0] == nil {
		panic("taghttp.Mount: requires ContentProvider (*compose.Content) or *taghttp.API")
	}
	var api *API
	switch v := deps[0].(type) {
	case *API:
		api = v
	case ContentProvider:
		api = NewAPI(v)
	default:
		panic("taghttp.Mount: first argument must implement taghttp.ContentProvider or be *taghttp.API")
	}

	return func(v1 chi.Router, d httpx.Deps) {
		requireSess := httpx.RequireSession(d.Authenticator)

		// Read routes (S)
		v1.With(requireSess).Get("/tags", api.List)

		// Write routes (S + C + I + R) via ChainItemTagWrite
		v1.Method(http.MethodPost, "/tags", api.provider.ChainItemTagWrite(d, false, api.Upsert))
		v1.Method(http.MethodPatch, "/tags/{id}", api.provider.ChainItemTagWrite(d, false, api.Rename))
		v1.Method(http.MethodDelete, "/tags/{id}", api.provider.ChainItemTagWrite(d, false, api.Delete))
		v1.Method(http.MethodPost, "/tags/{id}/restore", api.provider.ChainItemTagWrite(d, false, api.Restore))
		v1.Method(http.MethodPost, "/items/{id}/tags", api.provider.ChainItemTagWrite(d, false, api.AddItemTags))
		v1.Method(http.MethodDelete, "/items/{id}/tags/{tag_id}", api.provider.ChainItemTagWrite(d, false, api.RemoveItemTag))
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	itemhttp.NoStore(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONBytes(w http.ResponseWriter, status int, body []byte) {
	itemhttp.NoStore(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// WriteDomainError ánh xạ lỗi domain của `tag`, `item`, `textnorm`, hoặc `httpx` sang RFC 9457 Problem.
// Không bao giờ nhúng chuỗi người dùng vào `detail` (user-dec-016).
func WriteDomainError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	if te, ok := tag.AsError(err); ok {
		status := httpx.ContentProblemStatus(te.Code)
		detail := te.Detail
		if detail == "" {
			detail = httpx.ProblemTitle(te.Code) + "."
		}
		httpx.WriteProblem(w, r, status, te.Code, detail)
		return
	}
	itemhttp.WriteDomainError(w, r, err)
}

func parsePageLimit(raw string) (int, error) {
	if raw == "" {
		return tag.DefaultPageLimit, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < tag.MinPageLimit || n > tag.MaxPageLimit {
		return 0, tag.ErrInvalidRequest
	}
	return n, nil
}

func parsePathUUID(w http.ResponseWriter, r *http.Request, param, detail string) (uuid.UUID, bool) {
	raw := chi.URLParam(r, param)
	id, err := uuid.Parse(raw)
	if err != nil || len(raw) != 36 {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", detail)
		return uuid.Nil, false
	}
	return id, true
}

func validateOptionalEmptyJSONBody(w http.ResponseWriter, r *http.Request) bool {
	if r.Body == nil || r.Body == http.NoBody {
		return true
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, httpx.ContentItemTagJSONLimit+1))
	if err != nil {
		WriteDomainError(w, r, tag.ErrInvalidRequest)
		return false
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return true
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	var empty struct{}
	_, ok := itemhttp.DecodeStrictJSON(w, r, &empty)
	return ok
}

// List xử lý `GET /api/v1/tags` (`tagsList`, plan mục 2.7, 3, Task 5).
func (a *API) List(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}

	qParams := r.URL.Query()
	for k, vals := range qParams {
		switch k {
		case "q", "cursor", "limit", "sort":
			if len(vals) > 1 {
				WriteDomainError(w, r, tag.ErrInvalidRequest)
				return
			}
		default:
			WriteDomainError(w, r, tag.ErrInvalidRequest)
			return
		}
	}

	sortBy := qParams.Get("sort")
	if sortBy == "" {
		sortBy = tag.SortRecent
	}
	if sortBy != tag.SortRecent && sortBy != tag.SortAlpha {
		WriteDomainError(w, r, tag.ErrInvalidRequest)
		return
	}

	limit, err := parsePageLimit(qParams.Get("limit"))
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}

	var qNormalized string
	if _, hasQ := qParams["q"]; hasQ {
		_, norm, err := textnorm.NormalizeTag(qParams.Get("q"))
		if err != nil {
			WriteDomainError(w, r, tag.ErrTagDisplayInvalid)
			return
		}
		qNormalized = norm
	}

	page, err := a.svc.List(r.Context(), tag.ListInput{
		UserID:      p.UserID,
		Sort:        sortBy,
		QNormalized: qNormalized,
		Cursor:      qParams.Get("cursor"),
		Limit:       limit,
	})
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

type tagDisplayRequest struct {
	Display *string `json:"display"`
}

// Upsert xử lý `POST /api/v1/tags` (`tagUpsert`, plan mục 2.5, 2.7, 3, Task 5).
func (a *API) Upsert(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}

	var req tagDisplayRequest
	if _, ok := itemhttp.DecodeStrictJSON(w, r, &req); !ok {
		return
	}
	if req.Display == nil {
		WriteDomainError(w, r, tag.ErrInvalidRequest)
		return
	}

	display, normalized, err := textnorm.NormalizeTag(*req.Display)
	if err != nil {
		WriteDomainError(w, r, tag.ErrTagDisplayInvalid)
		return
	}

	ctx := r.Context()
	pool := a.provider.ContentPool()
	tx, err := httpx.BeginMutationTx(ctx, pool)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := gen.New(tx)
	if err := q.LockUserContent(ctx, p.UserID); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	a.fireOnLockUserContent(ctx, p.UserID, "tagUpsert")

	var status int
	var outTag tag.Tag
	existing, err := q.GetLiveTagByUserAndNormalized(ctx, gen.GetLiveTagByUserAndNormalizedParams{
		UserID:     p.UserID,
		Normalized: normalized,
	})
	switch {
	case err == nil:
		a.fireOnBetweenUpsertSteps(ctx, p.UserID, normalized, true)
		status = http.StatusOK
		outTag = tag.BuildTag(existing)
	case errors.Is(err, pgx.ErrNoRows):
		a.fireOnBetweenUpsertSteps(ctx, p.UserID, normalized, false)
		created, insertErr := q.InsertTag(ctx, gen.InsertTagParams{
			UserID:     p.UserID,
			Display:    display,
			Normalized: normalized,
		})
		if insertErr != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, insertErr) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}
		status = http.StatusCreated
		outTag = tag.BuildTag(created)
	default:
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	respBytes, err := json.Marshal(outTag)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	if err := httpx.CommitIdempotencyTx(ctx, tx, status, respBytes); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		WriteDomainError(w, r, err)
		return
	}

	writeJSONBytes(w, status, respBytes)
}

// Rename xử lý `PATCH /api/v1/tags/{id}` (`tagRename`, plan mục 2.5, 2.7, 3, Task 5).
func (a *API) Rename(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	tagID, ok := parsePathUUID(w, r, "id", "ID thẻ không hợp lệ.")
	if !ok {
		return
	}

	var req tagDisplayRequest
	if _, ok := itemhttp.DecodeStrictJSON(w, r, &req); !ok {
		return
	}
	if req.Display == nil {
		WriteDomainError(w, r, tag.ErrInvalidRequest)
		return
	}

	display, normalized, err := textnorm.NormalizeTag(*req.Display)
	if err != nil {
		WriteDomainError(w, r, tag.ErrTagDisplayInvalid)
		return
	}

	ctx := r.Context()
	pool := a.provider.ContentPool()
	tx, err := httpx.BeginMutationTx(ctx, pool)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := gen.New(tx)
	if err := q.LockUserContent(ctx, p.UserID); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	a.fireOnLockUserContent(ctx, p.UserID, "tagRename")

	locked, err := q.LockTagForUpdate(ctx, gen.LockTagForUpdateParams{
		UserID: p.UserID,
		ID:     tagID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			WriteDomainError(w, r, tag.ErrNotFound)
			return
		}
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	if locked.DeletedAt.Valid {
		WriteDomainError(w, r, tag.ErrNotFound)
		return
	}

	existing, err := q.GetLiveTagByUserAndNormalized(ctx, gen.GetLiveTagByUserAndNormalizedParams{
		UserID:     p.UserID,
		Normalized: normalized,
	})
	if err == nil && existing.ID != tagID {
		WriteDomainError(w, r, tag.ErrTagConflict)
		return
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	updated, err := q.RenameTag(ctx, gen.RenameTagParams{
		Display:    display,
		Normalized: normalized,
		UserID:     p.UserID,
		ID:         tagID,
	})
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	respBytes, err := json.Marshal(tag.BuildTag(updated))
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	if err := httpx.CommitIdempotencyTx(ctx, tx, http.StatusOK, respBytes); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		WriteDomainError(w, r, err)
		return
	}

	writeJSONBytes(w, http.StatusOK, respBytes)
}

// Delete xử lý `DELETE /api/v1/tags/{id}` (`tagDelete`, plan mục 2.5, 2.8, 3, Task 5).
func (a *API) Delete(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	tagID, ok := parsePathUUID(w, r, "id", "ID thẻ không hợp lệ.")
	if !ok {
		return
	}
	if !validateOptionalEmptyJSONBody(w, r) {
		return
	}

	ctx := r.Context()
	pool := a.provider.ContentPool()
	tx, err := httpx.BeginMutationTx(ctx, pool)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := gen.New(tx)
	if err := q.LockUserContent(ctx, p.UserID); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	a.fireOnLockUserContent(ctx, p.UserID, "tagDelete")

	locked, err := q.LockTagForUpdate(ctx, gen.LockTagForUpdateParams{
		UserID: p.UserID,
		ID:     tagID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			WriteDomainError(w, r, tag.ErrNotFound)
			return
		}
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	if !locked.DeletedAt.Valid {
		if _, err := q.SoftDeleteTag(ctx, gen.SoftDeleteTagParams{
			UserID: p.UserID,
			ID:     tagID,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}
	}

	if err := httpx.CommitIdempotencyTx(ctx, tx, http.StatusNoContent, nil); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		WriteDomainError(w, r, err)
		return
	}

	itemhttp.NoStore(w)
	w.WriteHeader(http.StatusNoContent)
}

// Restore xử lý `POST /api/v1/tags/{id}/restore` (`tagRestore`, plan mục 2.5, 2.8, 3, Task 5).
func (a *API) Restore(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	tagID, ok := parsePathUUID(w, r, "id", "ID thẻ không hợp lệ.")
	if !ok {
		return
	}
	if !validateOptionalEmptyJSONBody(w, r) {
		return
	}

	ctx := r.Context()
	pool := a.provider.ContentPool()
	tx, err := httpx.BeginMutationTx(ctx, pool)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := gen.New(tx)
	if err := q.LockUserContent(ctx, p.UserID); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	a.fireOnLockUserContent(ctx, p.UserID, "tagRestore")

	locked, err := q.LockTagForUpdate(ctx, gen.LockTagForUpdateParams{
		UserID: p.UserID,
		ID:     tagID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			WriteDomainError(w, r, tag.ErrNotFound)
			return
		}
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	restoredRow := locked
	if locked.DeletedAt.Valid {
		// 1. Kiểm tra nếu `normalized` đã bị một tag sống khác của cùng user chiếm -> `409 tag_conflict`.
		existing, err := q.GetLiveTagByUserAndNormalized(ctx, gen.GetLiveTagByUserAndNormalizedParams{
			UserID:     p.UserID,
			Normalized: locked.Normalized,
		})
		if err == nil && existing.ID != tagID {
			WriteDomainError(w, r, tag.ErrTagConflict)
			return
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}

		// 2. Kiểm tra nếu bất kỳ item sống nào đang gắn tag này đã có đủ 20 tag sống -> `409 item_tag_limit`, không restore gì.
		maxLiveTags, err := q.MaxLiveTagCountOnLiveItemsForTag(ctx, gen.MaxLiveTagCountOnLiveItemsForTagParams{
			UserID: p.UserID,
			TagID:  tagID,
		})
		if err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}
		if maxLiveTags >= tag.MaxLiveTagsPerItem {
			WriteDomainError(w, r, tag.ErrItemTagLimit)
			return
		}

		// 3. Khôi phục tag; `item_count` giữ nguyên (không tính lại, plan mục 2.1, 2.8).
		restoredRow, err = q.RestoreTag(ctx, gen.RestoreTagParams{
			UserID: p.UserID,
			ID:     tagID,
		})
		if err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}
	}

	respBytes, err := json.Marshal(tag.BuildTag(restoredRow))
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	if err := httpx.CommitIdempotencyTx(ctx, tx, http.StatusOK, respBytes); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		WriteDomainError(w, r, err)
		return
	}

	writeJSONBytes(w, http.StatusOK, respBytes)
}

type itemTagsAddRequest struct {
	TagIDs *[]string `json:"tag_ids"`
}

// AddItemTags xử lý `POST /api/v1/items/{id}/tags` (`itemTagsAdd`, plan mục 2.5, 2.7, 3, Task 5).
func (a *API) AddItemTags(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	itemID, ok := parsePathUUID(w, r, "id", "ID mục không hợp lệ.")
	if !ok {
		return
	}

	var req itemTagsAddRequest
	if _, ok := itemhttp.DecodeStrictJSON(w, r, &req); !ok {
		return
	}
	if req.TagIDs == nil || len(*req.TagIDs) < 1 || len(*req.TagIDs) > tag.MaxLiveTagsPerItem {
		WriteDomainError(w, r, tag.ErrInvalidRequest)
		return
	}

	seen := make(map[uuid.UUID]struct{}, len(*req.TagIDs))
	sortedTagIDs := make([]uuid.UUID, 0, len(*req.TagIDs))
	for _, rawID := range *req.TagIDs {
		parsedID, err := uuid.Parse(rawID)
		if err != nil || len(rawID) != 36 {
			WriteDomainError(w, r, tag.ErrInvalidRequest)
			return
		}
		if _, dup := seen[parsedID]; dup {
			WriteDomainError(w, r, tag.ErrInvalidRequest)
			return
		}
		seen[parsedID] = struct{}{}
		sortedTagIDs = append(sortedTagIDs, parsedID)
	}
	slices.SortFunc(sortedTagIDs, func(a, b uuid.UUID) int {
		return bytes.Compare(a[:], b[:])
	})

	ctx := r.Context()
	pool := a.provider.ContentPool()
	tx, err := httpx.BeginMutationTx(ctx, pool)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := gen.New(tx)
	// Bước 2 (LockUserContent) + Bước 3 (LockItemForUpdate, requireLive=true).
	itemRow, err := item.LockUserContentAndItem(ctx, q, p.UserID, itemID, true)
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		WriteDomainError(w, r, err)
		return
	}
	a.fireOnLockUserContent(ctx, p.UserID, "itemTagsAdd")

	// Bước 4 (thứ tự khoá toàn cục mục 2.5): khoá các hàng `tag` theo `id ASC`.
	lockedTags, err := q.LockTagsForUpdate(ctx, gen.LockTagsForUpdateParams{
		UserID: p.UserID,
		Ids:    sortedTagIDs,
	})
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	if len(lockedTags) != len(sortedTagIDs) {
		WriteDomainError(w, r, tag.ErrNotFound)
		return
	}
	for _, lt := range lockedTags {
		if lt.DeletedAt.Valid {
			WriteDomainError(w, r, tag.ErrNotFound)
			return
		}
	}

	// Gán cộng dồn (`ON CONFLICT DO NOTHING`), chỉ trả về các cặp mới được chèn.
	inserted, err := q.AssignItemTags(ctx, gen.AssignItemTagsParams{
		UserID: p.UserID,
		ItemID: itemID,
		TagIds: sortedTagIDs,
	})
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	// Kiểm tra tổng số tag sống của mục sau hợp <= 20; vượt -> 409 item_tag_limit (rollback toàn bộ).
	liveTagCount, err := q.CountLiveTagsByItem(ctx, gen.CountLiveTagsByItemParams{
		UserID: p.UserID,
		ItemID: itemID,
	})
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	if liveTagCount > tag.MaxLiveTagsPerItem {
		WriteDomainError(w, r, tag.ErrItemTagLimit)
		return
	}

	if len(inserted) > 0 {
		newTagIDs := make([]uuid.UUID, len(inserted))
		for i, pair := range inserted {
			newTagIDs[i] = pair.TagID
		}
		slices.SortFunc(newTagIDs, func(a, b uuid.UUID) int {
			return bytes.Compare(a[:], b[:])
		})
		now := a.svc.Clock().Now().UTC()
		if _, err := q.IncrementTagsItemCountAndTouch(ctx, gen.IncrementTagsItemCountAndTouchParams{
			Now:    pgtype.Timestamptz{Time: now, Valid: true},
			UserID: p.UserID,
			TagIds: newTagIDs,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}
	}

	summary, err := item.BuildSummary(ctx, q, itemRow)
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	respBytes, err := json.Marshal(summary)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	if err := httpx.CommitIdempotencyTx(ctx, tx, http.StatusOK, respBytes); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		WriteDomainError(w, r, err)
		return
	}

	writeJSONBytes(w, http.StatusOK, respBytes)
}

// RemoveItemTag xử lý `DELETE /api/v1/items/{id}/tags/{tag_id}` (`itemTagRemove`, plan mục 2.5, 2.7, 3, Task 5).
func (a *API) RemoveItemTag(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	itemID, ok := parsePathUUID(w, r, "id", "ID mục không hợp lệ.")
	if !ok {
		return
	}
	tagID, ok := parsePathUUID(w, r, "tag_id", "ID thẻ không hợp lệ.")
	if !ok {
		return
	}
	if !validateOptionalEmptyJSONBody(w, r) {
		return
	}

	ctx := r.Context()
	pool := a.provider.ContentPool()
	tx, err := httpx.BeginMutationTx(ctx, pool)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := gen.New(tx)
	// Bước 2 (LockUserContent) + Bước 3 (LockItemForUpdate, requireLive=true).
	itemRow, err := item.LockUserContentAndItem(ctx, q, p.UserID, itemID, true)
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		WriteDomainError(w, r, err)
		return
	}
	a.fireOnLockUserContent(ctx, p.UserID, "itemTagRemove")

	// Bước 4 (thứ tự khoá toàn cục mục 2.5): khoá hàng `tag` nếu thuộc user hiện tại.
	if _, err := q.LockTagForUpdate(ctx, gen.LockTagForUpdateParams{
		UserID: p.UserID,
		ID:     tagID,
	}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	removed, err := q.UnassignItemTag(ctx, gen.UnassignItemTagParams{
		UserID: p.UserID,
		ItemID: itemID,
		TagID:  tagID,
	})
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	if removed > 0 {
		if _, err := q.DecrementTagItemCount(ctx, gen.DecrementTagItemCountParams{
			UserID: p.UserID,
			TagID:  tagID,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}
	}

	summary, err := item.BuildSummary(ctx, q, itemRow)
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	respBytes, err := json.Marshal(summary)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	if err := httpx.CommitIdempotencyTx(ctx, tx, http.StatusOK, respBytes); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		WriteDomainError(w, r, err)
		return
	}

	writeJSONBytes(w, http.StatusOK, respBytes)
}
