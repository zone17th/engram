// Package entryhttp cung cấp HTTP handlers và đăng ký route cho `/api/v1/entries*`
// và `/api/v1/items/{id}/entries*` (plan P04 mục 2.3–2.8, mục 3, Task 6a–6b).
//
// Ràng buộc bảo mật (user-dec-016):
//   - Không bao giờ log hay đưa vào thông báo lỗi / metric / audit: ciphertext, các trường
//     envelope (nonce, ct_enc, key_id), raw request body, hoặc tên mục (item.name).
package entryhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/audit"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/vault"
)

type lockHeldHookKey struct{}

// WithLockHeldHook gắn một callback kiểm thử vào `ctx`: khi handler `entryCreate` đã giữ
// `LockUserContent` và `LockItemForUpdate`, nó gọi `fn(ctx, userID, itemID)`.
// Dùng trong barrier test Task 6a qua middleware bọc `ExtraMounts`; production không gắn key
// này nên hoàn toàn là no-op.
func WithLockHeldHook(ctx context.Context, fn func(ctx context.Context, userID, itemID uuid.UUID)) context.Context {
	return context.WithValue(ctx, lockHeldHookKey{}, fn)
}

// ContentDeps định nghĩa giao diện phụ thuộc mà `entryhttp.Mount` nhận từ `*compose.Content`
// (advisor-dec-149). Giữ interface cục bộ trong `entryhttp` để không tạo vòng import với `compose`.
type ContentDeps interface {
	ContentPool() *pgxpool.Pool
	ContentClock() clock.Clock
	ContentAudit() *audit.Store
	ContentLogger() *slog.Logger
	ChainEntryWrite(d httpx.Deps, requireIfMatch bool, fn http.HandlerFunc) http.Handler
	ChainItemTagWrite(d httpx.Deps, requireIfMatch bool, fn http.HandlerFunc) http.Handler
}

// Mount đăng ký các route `/api/v1/items/{id}/entries*` và `/api/v1/entries/{id}*` của Task 6a–6b:
//   - GET    /items/{id}/entries         (`itemEntriesList`): S
//   - POST   /items/{id}/entries         (`entryCreate`): S + C + I + R (qua `ChainEntryWrite(d, false, ...)`)
//   - PATCH  /items/{id}/entries/reorder (`itemEntriesReorder`): S + C + I + R (qua `ChainItemTagWrite(d, false, ...)`)
//   - GET    /entries/{id}               (`entryGet`): S
//   - PUT    /entries/{id}               (`entryUpdate`): S + C + I + R + M (qua `ChainEntryWrite(d, true, ...)`)
//   - DELETE /entries/{id}               (`entryDelete`): S + C + I + R (qua `ChainEntryWrite(d, false, ...)`)
//   - POST   /entries/{id}/restore       (`entryRestore`): S + C + I + R (qua `ChainEntryWrite(d, false, ...)`)
func Mount(c ContentDeps) func(v1 chi.Router, d httpx.Deps) {
	return func(v1 chi.Router, d httpx.Deps) {
		if c == nil || c.ContentPool() == nil {
			panic("entry routes yêu cầu ContentDeps và Pool thật — không mount rỗng")
		}
		if d.Authenticator == nil || d.CSRF == nil {
			panic("entry routes yêu cầu Authenticator và CSRF thật — không mount verifier rỗng")
		}

		h := &handler{
			c:    c,
			deps: d,
		}

		// Nhóm đọc (cột S): GET /items/{id}/entries, GET /entries/{id}
		v1.Group(func(g chi.Router) {
			g.Use(httpx.RequireSession(d.Authenticator))
			g.Get("/items/{id}/entries", h.itemEntriesList)
			g.Get("/entries/{id}", h.entryGet)
		})

		// Các route ghi entry (cột S+C+I+R[+M]) đi qua ChainEntryWrite (trần 400 KiB -> 413 entry_too_large);
		// riêng reorder là route trên item có trần 16 KiB -> 413 invalid_request trước Lookup (SPEC §9.2) nên đi qua ChainItemTagWrite.
		v1.Method(http.MethodPost, "/items/{id}/entries", c.ChainEntryWrite(d, false, h.entryCreate))
		v1.Method(http.MethodPut, "/entries/{id}", c.ChainEntryWrite(d, true, h.entryUpdate))
		v1.Method(http.MethodDelete, "/entries/{id}", c.ChainEntryWrite(d, false, h.entryDelete))
		v1.Method(http.MethodPost, "/entries/{id}/restore", c.ChainEntryWrite(d, false, h.entryRestore))
		v1.Method(http.MethodPatch, "/items/{id}/entries/reorder", c.ChainItemTagWrite(d, false, h.itemEntriesReorder))
	}
}

type handler struct {
	c    ContentDeps
	deps httpx.Deps
}

type createEntryRequest struct {
	ID                 *string         `json:"id"`
	Type               *string         `json:"type"`
	Envelope           json.RawMessage `json:"envelope"`
	Ciphertext         *string         `json:"ciphertext"`
	PlaintextLenBucket *int32          `json:"plaintext_len_bucket"`
}

type updateEntryRequest struct {
	Envelope           json.RawMessage `json:"envelope"`
	Ciphertext         *string         `json:"ciphertext"`
	PlaintextLenBucket *int32          `json:"plaintext_len_bucket"`
}

// entryCreate xử lý `POST /api/v1/items/{id}/entries` (`entryCreate`, plan mục 2.5, 2.6, 3, Task 6a).
func (h *handler) entryCreate(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}

	itemID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeContentProblem(w, r, "invalid_request")
		return
	}

	var req createEntryRequest
	if !decodeStrictEntryJSON(w, r, &req) {
		return
	}
	if req.ID == nil || req.Type == nil || len(req.Envelope) == 0 || req.Ciphertext == nil || req.PlaintextLenBucket == nil {
		writeContentProblem(w, r, "invalid_request")
		return
	}

	entryID, ok := entry.ParseEntryUUID(*req.ID)
	if !ok {
		writeContentProblem(w, r, "entry_invalid")
		return
	}
	if !entry.IsAllowedCreateType(*req.Type) {
		writeContentProblem(w, r, "entry_invalid")
		return
	}

	payload, errCode := entry.ValidatePayload(req.Envelope, *req.Ciphertext, *req.PlaintextLenBucket)
	if errCode != "" {
		writeContentProblem(w, r, errCode)
		return
	}

	ctx := r.Context()
	pool := h.c.ContentPool()
	tx, err := httpx.BeginMutationTx(ctx, pool)
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, nil, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := gen.New(tx)

	// Bước khoá (1): vault FOR SHARE — kiểm tra vault hiện có và so khớp key_id trước mọi khoá khác (mục 2.5, 2.6).
	vaultKeyID, err := q.LockVaultKeyForShare(ctx, p.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeContentProblem(w, r, "vault_absent")
			return
		}
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}
	if payload.Envelope.KeyID != vaultKeyID {
		writeContentProblem(w, r, "entry_key_mismatch")
		return
	}

	// Bước khoá (2): LockUserContent — tuần tự hoá các thao tác ghi content của cùng user (mục 2.5).
	if err := q.LockUserContent(ctx, p.UserID); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	// Bước khoá (3): item FOR UPDATE — không tồn tại / của user khác / đã xoá mềm -> 404 not_found.
	lockedItem, err := q.LockItemForUpdate(ctx, gen.LockItemForUpdateParams{
		UserID: p.UserID,
		ID:     itemID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeContentProblem(w, r, "not_found")
			return
		}
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}
	if lockedItem.DeletedAt.Valid {
		writeContentProblem(w, r, "not_found")
		return
	}
	if fn, ok := ctx.Value(lockHeldHookKey{}).(func(context.Context, uuid.UUID, uuid.UUID)); ok && fn != nil {
		fn(ctx, p.UserID, itemID)
	}

	// Bước (5): entry — kiểm tra xung đột ID toàn cục (mọi user, sống hay đã xoá) mà không lộ chủ sở hữu,
	// rồi kiểm tra trần 200 entry sống trên item (mục 2.3, 2.6).
	existsGlobal, err := q.EntryIDExistsGlobal(ctx, entryID)
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}
	if existsGlobal {
		writeContentProblem(w, r, "entry_id_conflict")
		return
	}

	if lockedItem.EntryCount >= entry.MaxLiveEntriesPerItem {
		writeContentProblem(w, r, "item_entry_limit")
		return
	}

	inserted, err := q.InsertEntry(ctx, gen.InsertEntryParams{
		ID:                 entryID,
		UserID:             p.UserID,
		ItemID:             itemID,
		Type:               *req.Type,
		Envelope:           payload.EnvelopeBytes,
		Ciphertext:         payload.CiphertextBytes,
		PlaintextLenBucket: payload.PlaintextLenBucket,
	})
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{
		Delta:  1,
		UserID: p.UserID,
		ID:     itemID,
	}); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	meta := entry.MetaFromInsertRow(inserted)
	respBytes, err := json.Marshal(meta)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	if err := httpx.CommitIdempotencyTx(ctx, tx, http.StatusCreated, respBytes); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	h.recordEntryCreated(*req.Type)
	writeRawJSON(w, http.StatusCreated, respBytes)
}

// itemEntriesList xử lý `GET /api/v1/items/{id}/entries` (`itemEntriesList`, plan mục 2.3, 3, Task 6a).
// Trả về chỉ metadata `EntryMeta` (không envelope, không ciphertext) sắp theo `(position, id)`.
func (h *handler) itemEntriesList(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}

	itemID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeContentProblem(w, r, "invalid_request")
		return
	}

	limit := entry.DefaultListLimit
	if rawLimit := r.URL.Query().Get("limit"); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed < entry.MinListLimit || parsed > entry.MaxListLimit {
			writeContentProblem(w, r, "invalid_request")
			return
		}
		limit = parsed
	} else if _, hasLimitParam := r.URL.Query()["limit"]; hasLimitParam {
		writeContentProblem(w, r, "invalid_request")
		return
	}

	var cursorPos *int32
	var cursorID *uuid.UUID
	if rawCursor, hasCursorParam := r.URL.Query()["cursor"]; hasCursorParam {
		if len(rawCursor) != 1 || rawCursor[0] == "" {
			writeContentProblem(w, r, "invalid_request")
			return
		}
		pos, cid, ok := entry.DecodeListCursor(rawCursor[0], itemID)
		if !ok {
			writeContentProblem(w, r, "invalid_request")
			return
		}
		cursorPos = &pos
		cursorID = &cid
	}

	ctx := r.Context()
	q := gen.New(h.c.ContentPool())

	// Kiểm tra item tồn tại, thuộc user hiện tại và đang sống (mục 3: 404 not_found nếu không có / của user khác / đã xoá).
	if _, err := q.GetLiveItemByUserAndID(ctx, gen.GetLiveItemByUserAndIDParams{
		UserID: p.UserID,
		ID:     itemID,
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeContentProblem(w, r, "not_found")
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	rows, err := q.ListLiveEntryMetadataByItem(ctx, gen.ListLiveEntryMetadataByItemParams{
		UserID:         p.UserID,
		ItemID:         itemID,
		CursorPosition: cursorPos,
		CursorID:       cursorID,
		PageLimit:      int32(limit + 1),
	})
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	items := make([]entry.Meta, 0, min(len(rows), limit))
	var nextCursor *string
	for i, row := range rows {
		if i == limit {
			last := rows[limit-1]
			c := entry.EncodeListCursor(itemID, last.Position, last.ID)
			nextCursor = &c
			break
		}
		items = append(items, entry.MetaFromListRow(row))
	}

	writeJSON(w, http.StatusOK, entry.MetaList{
		Items:      items,
		NextCursor: nextCursor,
	})
}

// entryGet xử lý `GET /api/v1/entries/{id}` (`entryGet`, plan mục 2.6, 3, Task 6a).
// Trả về `Entry` (`EntryMeta` + `envelope` + `ciphertext` base64url).
func (h *handler) entryGet(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}

	entryID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeContentProblem(w, r, "invalid_request")
		return
	}

	ctx := r.Context()
	q := gen.New(h.c.ContentPool())

	row, err := q.GetLiveEntryByUserAndID(ctx, gen.GetLiveEntryByUserAndIDParams{
		UserID: p.UserID,
		ID:     entryID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeContentProblem(w, r, "not_found")
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	dto, err := entry.EntryFromModel(row)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	writeJSON(w, http.StatusOK, dto)
}

// entryUpdate xử lý `PUT /api/v1/entries/{id}` (`entryUpdate`, plan mục 2.4, 2.5, 2.6, 3, Task 6a).
func (h *handler) entryUpdate(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}

	expectedVersion, ok := httpx.ParseVersionIfMatchFromRequest(w, r)
	if !ok {
		return
	}

	entryID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeContentProblem(w, r, "invalid_request")
		return
	}

	var req updateEntryRequest
	if !decodeStrictEntryJSON(w, r, &req) {
		return
	}
	if len(req.Envelope) == 0 || req.Ciphertext == nil || req.PlaintextLenBucket == nil {
		writeContentProblem(w, r, "invalid_request")
		return
	}

	payload, errCode := entry.ValidatePayload(req.Envelope, *req.Ciphertext, *req.PlaintextLenBucket)
	if errCode != "" {
		writeContentProblem(w, r, errCode)
		return
	}

	ctx := r.Context()
	pool := h.c.ContentPool()
	tx, err := httpx.BeginMutationTx(ctx, pool)
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, nil, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := gen.New(tx)

	// Bước khoá (1): vault FOR SHARE — kiểm tra vault hiện có và so khớp key_id trước mọi khoá khác (mục 2.5, 2.6).
	vaultKeyID, err := q.LockVaultKeyForShare(ctx, p.UserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeContentProblem(w, r, "vault_absent")
			return
		}
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}
	if payload.Envelope.KeyID != vaultKeyID {
		writeContentProblem(w, r, "entry_key_mismatch")
		return
	}

	// Bước khoá (2): LockUserContent (mục 2.5).
	if err := q.LockUserContent(ctx, p.UserID); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	// Giải quyết item_id của entry bằng một lần đọc không khoá trước bước (3) để khoá item
	// trước entry theo đúng thứ tự khoá mục 2.5 (không tồn tại / của user khác -> 404 not_found).
	entryRef, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{
		UserID: p.UserID,
		ID:     entryID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeContentProblem(w, r, "not_found")
			return
		}
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	// Bước khoá (3): item FOR UPDATE — không tồn tại / của user khác / đã xoá mềm -> 404 not_found (ưu tiên hơn 412).
	lockedItem, err := q.LockItemForUpdate(ctx, gen.LockItemForUpdateParams{
		UserID: p.UserID,
		ID:     entryRef.ItemID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeContentProblem(w, r, "not_found")
			return
		}
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}
	if lockedItem.DeletedAt.Valid {
		writeContentProblem(w, r, "not_found")
		return
	}

	// Bước khoá (5): entry FOR UPDATE — không tồn tại / của user khác / đã xoá mềm -> 404 not_found (ưu tiên hơn 412).
	lockedEntry, err := q.LockEntryForUpdate(ctx, gen.LockEntryForUpdateParams{
		UserID: p.UserID,
		ID:     entryID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeContentProblem(w, r, "not_found")
			return
		}
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}
	if lockedEntry.DeletedAt.Valid {
		writeContentProblem(w, r, "not_found")
		return
	}

	// So version: lệch -> 412 version_mismatch kèm current_version (mục 2.4).
	if lockedEntry.Version != expectedVersion {
		httpx.WriteVersionMismatch(w, r, lockedEntry.Version)
		return
	}

	// Kiểm tra không dùng lại nonce đang lưu (mục 2.6: 400 entry_nonce_reused).
	storedEnv, err := vault.ValidateEntryEnvelope(lockedEntry.Envelope)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}
	if payload.Envelope.Nonce == storedEnv.Nonce {
		writeContentProblem(w, r, "entry_nonce_reused")
		return
	}

	updated, err := q.UpdateEntryBody(ctx, gen.UpdateEntryBodyParams{
		Envelope:           payload.EnvelopeBytes,
		Ciphertext:         payload.CiphertextBytes,
		PlaintextLenBucket: payload.PlaintextLenBucket,
		UserID:             p.UserID,
		ID:                 entryID,
		ExpectedVersion:    expectedVersion,
	})
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	meta := entry.MetaFromUpdateRow(updated)
	respBytes, err := json.Marshal(meta)
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	if err := httpx.CommitIdempotencyTx(ctx, tx, http.StatusOK, respBytes); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	writeRawJSON(w, http.StatusOK, respBytes)
}

func (h *handler) recordEntryCreated(entryType string) {
	// user-dec-016 / advisor-dec-149: chỉ ghi nhận label `type` thuộc tập giới hạn {text, json},
	// không bao giờ đưa dữ liệu người dùng.
	if !entry.IsAllowedCreateType(entryType) {
		return
	}
	if h.deps.MetricsCollector != nil && h.deps.MetricsCollector.EntriesCreatedTotal != nil {
		h.deps.MetricsCollector.EntriesCreatedTotal.WithLabelValues(entryType).Inc()
	}
}

func writeContentProblem(w http.ResponseWriter, r *http.Request, code string) {
	status := httpx.ContentProblemStatus(code)
	httpx.WriteProblem(w, r, status, code, httpx.ProblemTitle(code)+".")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Del("ETag")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeRawJSON(w http.ResponseWriter, status int, raw []byte) {
	w.Header().Del("ETag")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

var rawMessageType = reflect.TypeOf(json.RawMessage(nil))

// decodeStrictEntryJSON giải mã nghiêm ngặt JSON body của các route ghi entry:
//   - Giới hạn đọc `httpx.ContentEntryJSONLimit` (400 KiB; vượt -> `413 entry_too_large`).
//   - Kiểm tra UTF-8 hợp lệ, từ chối khoá trùng lặp (duplicate keys) và trường lạ/alias không đúng chữ hoa-thường
//     trước khi unmarshal (nhưng bỏ qua bên trong `json.RawMessage` của `envelope` để `vault.ValidateEntryEnvelope`
//     trả đúng mã `400 entry_invalid`).
//   - Từ chối `DisallowUnknownFields` (ví dụ `PUT /entries/{id}` có gửi `type` -> `400 invalid_request`)
//     và dữ liệu thừa phía sau.
func decodeStrictEntryJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	ct := r.Header.Get("Content-Type")
	if mt := strings.TrimSpace(strings.Split(ct, ";")[0]); !strings.EqualFold(mt, "application/json") {
		httpx.WriteProblem(w, r, http.StatusUnsupportedMediaType, "invalid_request", httpx.ProblemTitle("invalid_request")+".")
		return false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, httpx.ContentEntryJSONLimit+1))
	if err != nil {
		writeContentProblem(w, r, "invalid_request")
		return false
	}
	if int64(len(body)) > httpx.ContentEntryJSONLimit {
		writeContentProblem(w, r, "entry_too_large")
		return false
	}
	if len(bytes.TrimSpace(body)) == 0 || !utf8.Valid(body) {
		writeContentProblem(w, r, "invalid_request")
		return false
	}

	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeContentProblem(w, r, "invalid_request")
		return false
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		writeContentProblem(w, r, "invalid_request")
		return false
	}
	if err := rejectDuplicateOrUnknownTopKeys(body, reflect.TypeOf(dst)); err != nil {
		writeContentProblem(w, r, "invalid_request")
		return false
	}
	return true
}

func rejectDuplicateOrUnknownTopKeys(data []byte, dstType reflect.Type) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return walkStrictTopJSON(dec, dstType)
}

func derefType(t reflect.Type) reflect.Type {
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t
}

func allowedStructFields(t reflect.Type) map[string]reflect.Type {
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

func skipJSONValue(dec *json.Decoder) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	d, isDelim := tok.(json.Delim)
	if !isDelim {
		return nil
	}
	switch d {
	case '{':
		for dec.More() {
			if _, err := dec.Token(); err != nil {
				return err
			}
			if err := skipJSONValue(dec); err != nil {
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
		for dec.More() {
			if err := skipJSONValue(dec); err != nil {
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
	return nil
}

func walkStrictTopJSON(dec *json.Decoder, targetType reflect.Type) error {
	t := derefType(targetType)
	if t == rawMessageType {
		// Bỏ qua kiểm tra duplicate key bên trong `json.RawMessage` (như `envelope`)
		// để `vault.ValidateEntryEnvelope` xử lý và trả `400 entry_invalid` đúng hợp đồng.
		return skipJSONValue(dec)
	}
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	d, isDelim := tok.(json.Delim)
	if !isDelim {
		if t != nil && t.Kind() == reflect.Struct {
			return errors.New("expected JSON object")
		}
		if t != nil && t.Kind() == reflect.String {
			if _, ok := tok.(string); !ok {
				return errors.New("expected JSON string")
			}
		}
		return nil
	}
	switch d {
	case '{':
		var allowed map[string]reflect.Type
		if t != nil && t.Kind() == reflect.Struct {
			allowed = allowedStructFields(t)
		}
		seen := make(map[string]struct{})
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
					return errors.New("unknown or non-canonical JSON property")
				}
				childType = ft
			}
			if err := walkStrictTopJSON(dec, childType); err != nil {
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
		if t != nil && t.Kind() == reflect.Struct {
			return errors.New("expected JSON object, got array")
		}
		var elemType reflect.Type
		if t != nil && (t.Kind() == reflect.Slice || t.Kind() == reflect.Array) {
			elemType = t.Elem()
		}
		for dec.More() {
			if err := walkStrictTopJSON(dec, elemType); err != nil {
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
	return nil
}
