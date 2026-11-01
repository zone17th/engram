// Package itemhttp cung cấp HTTP handlers và đăng ký route cho `/api/v1/items*`
// theo hợp đồng OpenAPI (operationIds `itemsList`, `itemsLookupExact`, `itemCreate`,
// `itemGet`, `itemUpdate`, `itemDelete`, `itemRestore`) và plan P04 mục 2.1–2.8, 3, Task 4.
//
// Ràng buộc bảo mật (user-dec-016):
//   - Tuyệt đối không đưa `name`, `hint` hoặc `q` vào log, metric label, audit meta
//     hay thông điệp chi tiết lỗi.
package itemhttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/audit"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/item"
	"github.com/zone17th/engram/apps/api/internal/textnorm"
)

// ContentProvider là giao diện cục bộ trên `*compose.Content` (advisor-dec-149)
// để `itemhttp` truy cập pool, clock, audit, logger và `ChainItemTagWrite` mà
// không gây vòng import với package `compose`.
type ContentProvider interface {
	ContentPool() *pgxpool.Pool
	ContentClock() clock.Clock
	ContentAudit() *audit.Store
	ContentLogger() *slog.Logger
	ChainItemTagWrite(d httpx.Deps, requireIfMatch bool, fn http.HandlerFunc) http.Handler
}

// API gom các phụ thuộc HTTP của nhóm route `/api/v1/items*` (Task 4).
type API struct {
	provider ContentProvider
	svc      *item.Service
}

// NewAPI khởi tạo `*API` cho các route `/api/v1/items*`.
func NewAPI(provider ContentProvider) *API {
	if provider == nil {
		panic("itemhttp.NewAPI: missing ContentProvider")
	}
	return &API{
		provider: provider,
		svc:      item.NewService(provider.ContentPool(), provider.ContentClock()),
	}
}

// Service trả về `*item.Service` gắn với API.
func (a *API) Service() *item.Service { return a.svc }

// Mount đăng ký các route `/api/v1/items*` của P04 Task 4:
//   - GET /items (`itemsList`): S
//   - GET /items/lookup (`itemsLookupExact`): S
//   - POST /items (`itemCreate`): S + C + I + R (16 KiB limit)
//   - GET /items/{id} (`itemGet`): S
//   - PATCH /items/{id} (`itemUpdate`): S + C + I + R + M (16 KiB limit)
//   - DELETE /items/{id} (`itemDelete`): S + C(AllowEmptyDelete) + I + R (16 KiB limit)
//   - POST /items/{id}/restore (`itemRestore`): S + C + I + R (16 KiB limit)
//
// Giữ chữ ký `Mount(deps ...any)` theo seam Task 3b (advisor-dec-149):
// tham số đầu tiên có thể là `*API` hoặc `ContentProvider` (`*compose.Content`);
// nếu thiếu hoặc không khớp giao diện sẽ panic rõ ràng lúc khởi động.
func Mount(deps ...any) func(v1 chi.Router, d httpx.Deps) {
	if len(deps) == 0 || deps[0] == nil {
		panic("itemhttp.Mount: requires ContentProvider (*compose.Content) or *itemhttp.API")
	}
	var api *API
	switch v := deps[0].(type) {
	case *API:
		api = v
	case ContentProvider:
		api = NewAPI(v)
	default:
		panic("itemhttp.Mount: first argument must implement itemhttp.ContentProvider or be *itemhttp.API")
	}

	return func(v1 chi.Router, d httpx.Deps) {
		requireSess := httpx.RequireSession(d.Authenticator)

		// Read routes (S)
		v1.With(requireSess).Get("/items", api.List)
		v1.With(requireSess).Get("/items/lookup", api.LookupExact)
		v1.With(requireSess).Get("/items/{id}", api.Get)

		// Write routes (S + C + I + R [+ M]) via ChainItemTagWrite
		v1.Method(http.MethodPost, "/items", api.provider.ChainItemTagWrite(d, false, api.Create))
		v1.Method(http.MethodPatch, "/items/{id}", api.provider.ChainItemTagWrite(d, true, api.Update))
		v1.Method(http.MethodDelete, "/items/{id}", api.provider.ChainItemTagWrite(d, false, api.Delete))
		v1.Method(http.MethodPost, "/items/{id}/restore", api.provider.ChainItemTagWrite(d, false, api.Restore))
	}
}

// NoStore đặt `Cache-Control: no-store` và xoá `ETag` nếu có (SPEC §9.1).
func NoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Del("ETag")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	NoStore(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONBytes(w http.ResponseWriter, status int, body []byte) {
	NoStore(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// WriteDomainError ánh xạ lỗi domain của `item`, `textnorm`, hoặc `httpx` sang RFC 9457 Problem.
// Không bao giờ nhúng chuỗi người dùng vào `detail` (user-dec-016).
func WriteDomainError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	if errors.Is(err, httpx.ErrIdempotencyOwnerMismatch) {
		retry := 1
		httpx.WriteProblemExtra(
			w,
			r,
			http.StatusConflict,
			"idempotency_in_progress",
			httpx.ProblemTitle("idempotency_in_progress")+".",
			httpx.ProblemExtra{RetryAfter: &retry},
		)
		return
	}
	if te, ok := textnorm.AsError(err); ok {
		status := httpx.ContentProblemStatus(te.Code)
		httpx.WriteProblem(w, r, status, te.Code, httpx.ProblemTitle(te.Code)+".")
		return
	}
	if ie, ok := item.AsError(err); ok {
		if ie.Code == "version_mismatch" && ie.CurrentVersion != nil {
			httpx.WriteVersionMismatch(w, r, *ie.CurrentVersion)
			return
		}
		status := httpx.ContentProblemStatus(ie.Code)
		detail := ie.Detail
		if detail == "" {
			detail = httpx.ProblemTitle(ie.Code) + "."
		}
		httpx.WriteProblem(w, r, status, ie.Code, detail)
		return
	}
	httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
}

var rawMessageType = reflect.TypeOf(json.RawMessage(nil))

// DecodeStrictJSON đọc và kiểm tra nghiêm ngặt JSON body của các route item/tag (trần 16 KiB):
//   - Kiểm tra `Content-Type: application/json`, giới hạn kích thước 16 KiB, không rỗng.
//   - Kiểm tra không có khoá trùng lặp (duplicate keys) hoặc trường không đúng tên canonical JSON
//     ở mọi cấp trước khi unmarshal.
//   - Từ chối trường lạ (`DisallowUnknownFields`) và dữ liệu thừa phía sau.
func DecodeStrictJSON(w http.ResponseWriter, r *http.Request, dst any) ([]byte, bool) {
	ct := r.Header.Get("Content-Type")
	if mt := strings.TrimSpace(strings.Split(ct, ";")[0]); !strings.EqualFold(mt, "application/json") {
		httpx.WriteProblem(w, r, http.StatusUnsupportedMediaType, "invalid_request", "Yêu cầu Content-Type application/json.")
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, httpx.ContentItemTagJSONLimit+1))
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Không đọc được nội dung.")
		return nil, false
	}
	if int64(len(body)) > httpx.ContentItemTagJSONLimit {
		httpx.WriteProblem(w, r, http.StatusRequestEntityTooLarge, "invalid_request", "Nội dung quá lớn.")
		return nil, false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Thiếu nội dung JSON.")
		return nil, false
	}
	if err := rejectDuplicateOrUnknownJSONKeys(body, reflect.TypeOf(dst)); err != nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return nil, false
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON có dữ liệu thừa.")
		return nil, false
	}
	return body, true
}

func rejectDuplicateOrUnknownJSONKeys(data []byte, dstType reflect.Type) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return walkStrictJSON(dec, dstType)
}

func derefType(t reflect.Type) reflect.Type {
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t
}

func allowedStructJSONFields(t reflect.Type) map[string]reflect.Type {
	out := make(map[string]reflect.Type, t.NumField())
	for i := range t.NumField() {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		tag := f.Tag.Get("json")
		if tag == "-" {
			continue
		}
		name := f.Name
		if tag != "" {
			if head, _, _ := strings.Cut(tag, ","); head != "" {
				name = head
			}
		}
		out[name] = f.Type
	}
	return out
}

func walkStrictJSON(dec *json.Decoder, targetType reflect.Type) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	t := derefType(targetType)
	if t == rawMessageType {
		t = nil
	}
	switch d := tok.(type) {
	case json.Delim:
		switch d {
		case '{':
			var allowed map[string]reflect.Type
			if t != nil && t.Kind() == reflect.Struct {
				allowed = allowedStructJSONFields(t)
			}
			seen := map[string]struct{}{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return err
				}
				k, ok := kt.(string)
				if !ok {
					return errors.New("object key not string")
				}
				if _, dup := seen[k]; dup {
					return errors.New("duplicate key")
				}
				seen[k] = struct{}{}
				var childType reflect.Type
				if allowed != nil {
					ft, ok := allowed[k]
					if !ok {
						return errors.New("unknown JSON property")
					}
					childType = ft
				}
				if err := walkStrictJSON(dec, childType); err != nil {
					return err
				}
			}
			end, err := dec.Token()
			if err != nil {
				return err
			}
			if ed, ok := end.(json.Delim); !ok || ed != '}' {
				return errors.New("unclosed object")
			}
		case '[':
			var elemType reflect.Type
			if t != nil && (t.Kind() == reflect.Slice || t.Kind() == reflect.Array) {
				elemType = t.Elem()
			}
			for dec.More() {
				if err := walkStrictJSON(dec, elemType); err != nil {
					return err
				}
			}
			end, err := dec.Token()
			if err != nil {
				return err
			}
			if ed, ok := end.(json.Delim); !ok || ed != ']' {
				return errors.New("unclosed array")
			}
		default:
			return errors.New("unexpected delimiter")
		}
	default:
		if t != nil && t.Kind() == reflect.Struct {
			return errors.New("expected JSON object")
		}
	}
	return nil
}

func parsePageLimit(raw string) (int, error) {
	if raw == "" {
		return item.DefaultPageLimit, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < item.MinPageLimit || n > item.MaxPageLimit {
		return 0, item.ErrInvalidRequest
	}
	return n, nil
}

func parsePathItemID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	raw := chi.URLParam(r, "id")
	id, err := uuid.Parse(raw)
	if err != nil || len(raw) != 36 {
		httpx.WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "ID mục không hợp lệ.")
		return uuid.Nil, false
	}
	return id, true
}

// List xử lý `GET /api/v1/items` (`itemsList`, plan mục 2.7, 3, Task 4).
func (a *API) List(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}

	qParams := r.URL.Query()
	for k, vals := range qParams {
		switch k {
		case "tag_id", "q", "cursor", "limit", "sort":
			if len(vals) > 1 {
				WriteDomainError(w, r, item.ErrInvalidRequest)
				return
			}
		default:
			WriteDomainError(w, r, item.ErrInvalidRequest)
			return
		}
	}

	sortBy := qParams.Get("sort")
	if sortBy == "" {
		sortBy = item.SortRecent
	}
	if sortBy != item.SortRecent && sortBy != item.SortAlpha {
		WriteDomainError(w, r, item.ErrInvalidRequest)
		return
	}

	limit, err := parsePageLimit(qParams.Get("limit"))
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}

	var tagID *uuid.UUID
	if rawTag := qParams.Get("tag_id"); rawTag != "" {
		parsedTag, err := uuid.Parse(rawTag)
		if err != nil || len(rawTag) != 36 {
			WriteDomainError(w, r, item.ErrInvalidRequest)
			return
		}
		tagID = &parsedTag
	}

	var qNormalized string
	if _, hasQ := qParams["q"]; hasQ {
		rawQ := qParams.Get("q")
		if strings.TrimSpace(rawQ) == "" {
			WriteDomainError(w, r, item.ErrNameInvalid)
			return
		}
		norm, err := textnorm.NormalizeQuery(rawQ)
		if err != nil || norm == "" {
			WriteDomainError(w, r, item.ErrNameInvalid)
			return
		}
		qNormalized = norm
	}

	page, err := a.svc.List(r.Context(), item.ListInput{
		UserID:      p.UserID,
		Sort:        sortBy,
		TagID:       tagID,
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

// LookupExact xử lý `GET /api/v1/items/lookup` (`itemsLookupExact`, plan mục 2.7, 3, Task 4).
func (a *API) LookupExact(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}

	qParams := r.URL.Query()
	for k, vals := range qParams {
		switch k {
		case "name", "cursor", "limit":
			if len(vals) > 1 {
				WriteDomainError(w, r, item.ErrInvalidRequest)
				return
			}
		default:
			WriteDomainError(w, r, item.ErrInvalidRequest)
			return
		}
	}

	if _, hasName := qParams["name"]; !hasName {
		WriteDomainError(w, r, item.ErrNameInvalid)
		return
	}
	nameNormalized, err := textnorm.NormalizeLookupName(qParams.Get("name"))
	if err != nil {
		WriteDomainError(w, r, item.ErrNameInvalid)
		return
	}

	limit, err := parsePageLimit(qParams.Get("limit"))
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}

	res, err := a.svc.LookupExact(r.Context(), item.LookupInput{
		UserID:         p.UserID,
		NameNormalized: nameNormalized,
		Cursor:         qParams.Get("cursor"),
		Limit:          limit,
	})
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// Get xử lý `GET /api/v1/items/{id}` (`itemGet`, plan mục 3, Task 4).
func (a *API) Get(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	itemID, ok := parsePathItemID(w, r)
	if !ok {
		return
	}

	summary, err := a.svc.Get(r.Context(), p.UserID, itemID)
	if err != nil {
		WriteDomainError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

type itemCreateRequest struct {
	ID   *string         `json:"id"`
	Name *string         `json:"name"`
	Hint json.RawMessage `json:"hint"`
}

// Create xử lý `POST /api/v1/items` (`itemCreate`, plan mục 2.5, 2.7, 3, Task 4).
func (a *API) Create(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}

	var req itemCreateRequest
	if _, ok := DecodeStrictJSON(w, r, &req); !ok {
		return
	}
	if req.Name == nil {
		WriteDomainError(w, r, item.ErrInvalidRequest)
		return
	}

	var clientID *uuid.UUID
	if req.ID != nil {
		parsedID, err := uuid.Parse(*req.ID)
		if err != nil || len(*req.ID) != 36 {
			WriteDomainError(w, r, item.ErrInvalidRequest)
			return
		}
		clientID = &parsedID
	}

	nameDisplay, nameNormalized, err := textnorm.NormalizeName(*req.Name)
	if err != nil {
		WriteDomainError(w, r, item.ErrNameInvalid)
		return
	}

	hintPtr, err := parseOptionalHintField(req.Hint)
	if err != nil {
		WriteDomainError(w, r, err)
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

	row, err := q.InsertItem(ctx, gen.InsertItemParams{
		ID:             clientID,
		UserID:         p.UserID,
		Name:           nameDisplay,
		NameNormalized: nameNormalized,
		Hint:           hintPtr,
	})
	if err != nil {
		if item.IsItemPrimaryKeyConflict(err) {
			WriteDomainError(w, r, item.ErrItemIDConflict)
			return
		}
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	summary := item.BuildSummaryFromRow(row, []item.TagRef{})
	respBytes, err := json.Marshal(summary)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
		return
	}

	if err := httpx.CommitIdempotencyTx(ctx, tx, http.StatusCreated, respBytes); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		WriteDomainError(w, r, err)
		return
	}

	a.svc.EnqueueEmbed(ctx, p.UserID, row.ID)
	writeJSONBytes(w, http.StatusCreated, respBytes)
}

type itemUpdateRequest struct {
	Name *string         `json:"name"`
	Hint json.RawMessage `json:"hint"`
}

// Update xử lý `PATCH /api/v1/items/{id}` (`itemUpdate`, plan mục 2.4, 2.5, 2.7, 3, Task 4).
func (a *API) Update(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	itemID, ok := parsePathItemID(w, r)
	if !ok {
		return
	}
	expectedVersion, ok := httpx.ParseVersionIfMatchFromRequest(w, r)
	if !ok {
		return
	}

	var req itemUpdateRequest
	if _, ok := DecodeStrictJSON(w, r, &req); !ok {
		return
	}
	hasName := req.Name != nil
	hasHint := len(req.Hint) > 0
	if !hasName && !hasHint {
		WriteDomainError(w, r, item.ErrInvalidRequest)
		return
	}

	var newNameDisplay, newNameNormalized string
	if hasName {
		var err error
		newNameDisplay, newNameNormalized, err = textnorm.NormalizeName(*req.Name)
		if err != nil {
			WriteDomainError(w, r, item.ErrNameInvalid)
			return
		}
	}

	var parsedHint *string
	if hasHint {
		var err error
		parsedHint, err = parseOptionalHintField(req.Hint)
		if err != nil {
			WriteDomainError(w, r, err)
			return
		}
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
	locked, err := item.LockUserContentAndItem(ctx, q, p.UserID, itemID, true)
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		WriteDomainError(w, r, err)
		return
	}

	if locked.Version != expectedVersion {
		WriteDomainError(w, r, item.NewVersionMismatchError(locked.Version))
		return
	}

	finalName := locked.Name
	finalNorm := locked.NameNormalized
	if hasName {
		finalName = newNameDisplay
		finalNorm = newNameNormalized
	}
	finalHint := locked.Hint
	if hasHint {
		finalHint = parsedHint
	}

	changed := finalName != locked.Name || finalNorm != locked.NameNormalized || !equalStringPtr(finalHint, locked.Hint)
	updatedRow := locked
	if changed {
		updatedRow, err = q.UpdateItemNameAndHint(ctx, gen.UpdateItemNameAndHintParams{
			Name:            finalName,
			NameNormalized:  finalNorm,
			Hint:            finalHint,
			UserID:          p.UserID,
			ID:              itemID,
			ExpectedVersion: expectedVersion,
		})
		if err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}
	}

	summary, err := item.BuildSummary(ctx, q, updatedRow)
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

	if changed {
		a.svc.EnqueueEmbed(ctx, p.UserID, updatedRow.ID)
	}
	writeJSONBytes(w, http.StatusOK, respBytes)
}

// Delete xử lý `DELETE /api/v1/items/{id}` (`itemDelete`, plan mục 2.5, 2.8, 3, Task 4).
func (a *API) Delete(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	itemID, ok := parsePathItemID(w, r)
	if !ok {
		return
	}

	// OpenAPI: "Không có request body; DELETE body rỗng không cần Content-Type (có body thì phải là application/json, không thì 415)".
	// Nếu client gửi body JSON (ví dụ `{}`), kiểm tra strict EmptyObject.
	if r.Body != nil && r.Body != http.NoBody {
		raw, err := io.ReadAll(io.LimitReader(r.Body, httpx.ContentItemTagJSONLimit+1))
		if err != nil {
			WriteDomainError(w, r, item.ErrInvalidRequest)
			return
		}
		if len(bytes.TrimSpace(raw)) > 0 {
			r.Body = io.NopCloser(bytes.NewReader(raw))
			var empty struct{}
			if _, ok := DecodeStrictJSON(w, r, &empty); !ok {
				return
			}
		}
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
	locked, err := item.LockUserContentAndItem(ctx, q, p.UserID, itemID, false)
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		WriteDomainError(w, r, err)
		return
	}

	if !locked.DeletedAt.Valid {
		// Bước 4 (thứ tự khoá toàn cục mục 2.5): khoá mọi hàng tag gắn với item theo id ASC.
		if _, err := q.LockTagsOfItemForUpdate(ctx, gen.LockTagsOfItemForUpdateParams{
			UserID: p.UserID,
			ItemID: itemID,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}

		// Bước 5: khoá các entry sống của item theo id ASC trước khi soft-delete.
		if _, err := q.LockLiveEntriesOfItemForUpdate(ctx, gen.LockLiveEntriesOfItemForUpdateParams{
			UserID: p.UserID,
			ItemID: itemID,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}

		batchID := uuid.New()
		if _, err := q.SoftDeleteItem(ctx, gen.SoftDeleteItemParams{
			DeleteBatch: &batchID,
			UserID:      p.UserID,
			ID:          itemID,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}

		if _, err := q.SoftDeleteLiveEntriesByItem(ctx, gen.SoftDeleteLiveEntriesByItemParams{
			DeleteBatch: &batchID,
			UserID:      p.UserID,
			ItemID:      itemID,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}

		if _, err := q.AdjustAllLinkedTagsItemCountForItem(ctx, gen.AdjustAllLinkedTagsItemCountForItemParams{
			Delta:  -1,
			UserID: p.UserID,
			ItemID: itemID,
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

	NoStore(w)
	w.WriteHeader(http.StatusNoContent)
}

// Restore xử lý `POST /api/v1/items/{id}/restore` (`itemRestore`, plan mục 2.5, 2.8, 3, Task 4).
func (a *API) Restore(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}
	itemID, ok := parsePathItemID(w, r)
	if !ok {
		return
	}

	// OpenAPI `itemRestore`: "Client gửi `{}` với `Content-Type: application/json` như mọi POST
	// (thiếu header -> 415 invalid_request); server vẫn nhận body rỗng."
	if r.Body != nil && r.Body != http.NoBody {
		raw, err := io.ReadAll(io.LimitReader(r.Body, httpx.ContentItemTagJSONLimit+1))
		if err != nil {
			WriteDomainError(w, r, item.ErrInvalidRequest)
			return
		}
		if len(bytes.TrimSpace(raw)) > 0 {
			r.Body = io.NopCloser(bytes.NewReader(raw))
			var empty struct{}
			if _, ok := DecodeStrictJSON(w, r, &empty); !ok {
				return
			}
		}
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
	locked, err := item.LockUserContentAndItem(ctx, q, p.UserID, itemID, false)
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		WriteDomainError(w, r, err)
		return
	}

	restoredRow := locked
	if locked.DeletedAt.Valid {
		// Bước 4 (thứ tự khoá toàn cục mục 2.5): khoá mọi hàng tag gắn với item theo id ASC.
		if _, err := q.LockTagsOfItemForUpdate(ctx, gen.LockTagsOfItemForUpdateParams{
			UserID: p.UserID,
			ItemID: itemID,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}

		// P4BE1-3: kiểm số tag sống gắn với item sau restore phải <= 20; nếu > 20 trả
		// `409 item_tag_limit` và không khôi phục bất kỳ thứ gì.
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
		if liveTagCount > item.MaxLiveTagsPerItem {
			WriteDomainError(w, r, item.ErrItemTagLimit)
			return
		}

		// Bước 5: đếm và khôi phục chỉ các entry có `deleted_via='item' AND delete_batch = item.delete_batch` (A8).
		var batchCount int32
		if locked.DeleteBatch != nil {
			batchCount, err = q.CountEntriesByItemBatch(ctx, gen.CountEntriesByItemBatchParams{
				UserID:      p.UserID,
				ItemID:      itemID,
				DeleteBatch: locked.DeleteBatch,
			})
			if err != nil {
				if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
					return
				}
				httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
				return
			}
		}
		if batchCount > item.MaxLiveEntriesPerItem {
			WriteDomainError(w, r, item.ErrItemEntryLimit)
			return
		}

		var restoredEntries int64
		if locked.DeleteBatch != nil {
			restoredEntries, err = q.RestoreEntriesByItemBatch(ctx, gen.RestoreEntriesByItemBatchParams{
				UserID:      p.UserID,
				ItemID:      itemID,
				DeleteBatch: locked.DeleteBatch,
			})
			if err != nil {
				if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
					return
				}
				httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
				return
			}
		}

		restoredRow, err = q.RestoreItem(ctx, gen.RestoreItemParams{
			EntryCount: int32(restoredEntries),
			UserID:     p.UserID,
			ID:         itemID,
		})
		if err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}

		if _, err := q.AdjustAllLinkedTagsItemCountForItem(ctx, gen.AdjustAllLinkedTagsItemCountForItemParams{
			Delta:  1,
			UserID: p.UserID,
			ItemID: itemID,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ gặp lỗi.")
			return
		}
	}

	summary, err := item.BuildSummary(ctx, q, restoredRow)
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

// parseOptionalHintField phân tích giá trị `hint` từ `json.RawMessage`:
//   - Rỗng hoặc `null` -> `nil` (xoá hoặc không đặt hint).
//   - Chuỗi hợp lệ -> `textnorm.ValidateHint`, nếu sau trim rỗng (`""`) thì lưu `nil` hoặc `""`?
//     Wait: kiểm tra OpenAPI `ItemHint`: `type: [string, 'null'], maxLength: 120, description: Gợi ý tuỳ chọn... 0–120 rune; null = không có hoặc xoá hint`.
func parseOptionalHintField(raw json.RawMessage) (*string, error) {
	trimmedRaw := bytes.TrimSpace(raw)
	if len(trimmedRaw) == 0 || bytes.Equal(trimmedRaw, []byte("null")) {
		return nil, nil
	}
	var s string
	dec := json.NewDecoder(bytes.NewReader(trimmedRaw))
	if err := dec.Decode(&s); err != nil {
		return nil, item.ErrInvalidRequest
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, item.ErrInvalidRequest
	}
	validated, err := textnorm.ValidateHint(s)
	if err != nil {
		return nil, item.ErrHintInvalid
	}
	return &validated, nil
}

func equalStringPtr(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}
