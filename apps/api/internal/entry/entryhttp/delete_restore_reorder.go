package entryhttp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/httpx"
)

type emptyObjectRequest struct{}

type reorderEntriesRequest struct {
	EntryIDs []string `json:"entry_ids"`
}

// entryDelete xử lý `DELETE /api/v1/entries/{id}` (`entryDelete`, plan mục 2.5, 2.8, 3, Task 6b).
// Thứ tự khoá mục 2.5 (không khoá vault): (2) LockUserContent -> (3) item FOR UPDATE -> (5) entry FOR UPDATE.
// Entry đã xoá mềm -> 204 không đổi gì.
func (h *handler) entryDelete(w http.ResponseWriter, r *http.Request) {
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

	if !decodeOptionalEmptyJSON(w, r, httpx.ContentEntryJSONLimit, "entry_too_large") {
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

	// Bước khoá (2): LockUserContent (mục 2.5 — không khoá vault trên xoá/restore/reorder).
	if err := q.LockUserContent(ctx, p.UserID); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	// Tra cứu entry dưới LockUserContent (không khoá hàng entry trước hàng item) để lấy item_id
	// rồi khoá đúng thứ tự mục 2.5: (3) item FOR UPDATE -> (5) entry FOR UPDATE.
	existingEntry, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{
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

	// Bước khoá (3): item FOR UPDATE.
	if _, err := q.LockItemForUpdate(ctx, gen.LockItemForUpdateParams{
		UserID: p.UserID,
		ID:     existingEntry.ItemID,
	}); err != nil {
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

	// Bước khoá (5): entry FOR UPDATE.
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

	// Nếu entry chưa bị xoá mềm thì xoá mềm với deleted_via='entry' và giảm item.entry_count đi 1.
	// Nếu đã ở trạng thái xoá -> 204 không đổi gì (plan mục 2.8, Task 6b).
	if !lockedEntry.DeletedAt.Valid {
		if _, err := q.SoftDeleteEntry(ctx, gen.SoftDeleteEntryParams{
			UserID: p.UserID,
			ID:     entryID,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
			return
		}
		if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{
			Delta:  -1,
			UserID: p.UserID,
			ID:     lockedEntry.ItemID,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
			return
		}
	}

	if err := httpx.CommitIdempotencyTx(ctx, tx, http.StatusNoContent, nil); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	w.Header().Del("ETag")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// entryRestore xử lý `POST /api/v1/entries/{id}/restore` (`entryRestore`, plan mục 2.5, 2.8, 3, Task 6b).
// Thứ tự khoá mục 2.5 (không khoá vault): (2) LockUserContent -> (3) item FOR UPDATE -> (5) entry FOR UPDATE.
// Entry đang sống -> 200 với trạng thái hiện tại, không đổi gì.
func (h *handler) entryRestore(w http.ResponseWriter, r *http.Request) {
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

	if !decodeOptionalEmptyJSON(w, r, httpx.ContentEntryJSONLimit, "entry_too_large") {
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

	// Bước khoá (2): LockUserContent (mục 2.5).
	if err := q.LockUserContent(ctx, p.UserID); err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	existingEntry, err := q.GetEntryByUserAndID(ctx, gen.GetEntryByUserAndIDParams{
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

	// Bước khoá (3): item FOR UPDATE.
	lockedItem, err := q.LockItemForUpdate(ctx, gen.LockItemForUpdateParams{
		UserID: p.UserID,
		ID:     existingEntry.ItemID,
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

	// Bước khoá (5): entry FOR UPDATE.
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

	var meta entry.Meta
	if !lockedEntry.DeletedAt.Valid {
		// Entry đang sống -> 200 với trạng thái hiện tại, không đổi gì (plan mục 2.8, Task 6b).
		meta = entry.MetaFromModel(lockedEntry)
	} else {
		// Kiểm tra provenance xoá: deleted_via='item' -> 409 entry_restore_via_item.
		if lockedEntry.DeletedVia != nil && *lockedEntry.DeletedVia == entry.DeletedViaItem {
			writeContentProblem(w, r, "entry_restore_via_item")
			return
		}
		if lockedEntry.DeletedVia == nil || *lockedEntry.DeletedVia != entry.DeletedViaEntry {
			writeContentProblem(w, r, "entry_restore_via_item")
			return
		}
		// Mục đã xoá -> 409 item_deleted.
		if lockedItem.DeletedAt.Valid {
			writeContentProblem(w, r, "item_deleted")
			return
		}
		// Trần 200 entry sống trên mục -> 409 item_entry_limit.
		if lockedItem.EntryCount >= entry.MaxLiveEntriesPerItem {
			writeContentProblem(w, r, "item_entry_limit")
			return
		}

		// Bước khoá (5, tiếp): khoá các hàng entry đang sống của mục theo id ASC trước khi dời vị trí.
		if _, err := q.LockLiveEntriesOfItemForUpdate(ctx, gen.LockLiveEntriesOfItemForUpdateParams{
			UserID: p.UserID,
			ItemID: lockedEntry.ItemID,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
			return
		}

		// advisor-dec-160 (EA6b-R1-2): nếu đã có entry sống của mục chiếm position cũ của entry được restore
		// (ví dụ do reorder sau khi xoá), dời mọi entry sống có position >= position cũ lên +1 trong MỘT UPDATE,
		// cập nhật updated_at = clock_timestamp() (để feed thấy) và giữ nguyên version trước khi restore.
		if _, err := q.ShiftLiveEntriesOnRestoreCollision(ctx, gen.ShiftLiveEntriesOnRestoreCollisionParams{
			UserID:           p.UserID,
			ItemID:           lockedEntry.ItemID,
			RestoredPosition: lockedEntry.Position,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
			return
		}
		restored, err := q.RestoreEntry(ctx, gen.RestoreEntryParams{
			UserID: p.UserID,
			ID:     entryID,
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
			ID:     lockedEntry.ItemID,
		}); err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
			return
		}
		meta = entry.MetaFromRestoreRow(restored)
	}

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

// itemEntriesReorder xử lý `PATCH /api/v1/items/{id}/entries/reorder` (`itemEntriesReorder`, plan mục 2.5, 2.8, 3, Task 6b).
// Thứ tự khoá mục 2.5 (không khoá vault): (2) LockUserContent -> (3) item FOR UPDATE -> (5) LockLiveEntriesOfItemForUpdate (ORDER BY id ASC).
// Đánh lại `position` 0..n-1 và cập nhật `updated_at = clock_timestamp()` trên toàn bộ các hàng entry sống trong hoán vị
// (qua `ReorderLiveEntriesByItem`) để feed Task 7 nhận diện thứ tự mới đầy đủ; `version` KHÔNG tăng.
func (h *handler) itemEntriesReorder(w http.ResponseWriter, r *http.Request) {
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

	var req reorderEntriesRequest
	if !decodeStrictJSONWithLimit(w, r, &req, httpx.ContentItemTagJSONLimit, "invalid_request") {
		return
	}
	if req.EntryIDs == nil {
		writeContentProblem(w, r, "invalid_request")
		return
	}

	requestedIDs, errCode := entry.ValidateReorderIDs(req.EntryIDs)
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

	// Bước khoá (2): LockUserContent (mục 2.5).
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

	// Bước khoá (5): khoá toàn bộ entry sống của mục theo id ASC (`LockLiveEntriesOfItemForUpdate`).
	liveRows, err := q.LockLiveEntriesOfItemForUpdate(ctx, gen.LockLiveEntriesOfItemForUpdateParams{
		UserID: p.UserID,
		ItemID: itemID,
	})
	if err != nil {
		if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
			return
		}
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	liveIDs := make([]uuid.UUID, len(liveRows))
	for i, row := range liveRows {
		liveIDs[i] = row.ID
	}
	if !entry.MatchLiveEntrySet(requestedIDs, liveIDs) {
		writeContentProblem(w, r, "reorder_mismatch")
		return
	}

	entriesOut := make([]entry.Position, len(requestedIDs))
	if len(requestedIDs) > 0 {
		updatedRows, err := q.ReorderLiveEntriesByItem(ctx, gen.ReorderLiveEntriesByItemParams{
			UserID:   p.UserID,
			ItemID:   itemID,
			EntryIds: requestedIDs,
		})
		if err != nil {
			if httpx.WriteContentTxError(ctx, w, r, pool, tx, err) {
				return
			}
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
			return
		}
		if len(updatedRows) != len(requestedIDs) {
			writeContentProblem(w, r, "reorder_mismatch")
			return
		}
		for i, id := range requestedIDs {
			entriesOut[i] = entry.Position{
				ID:       id.String(),
				Position: int32(i),
			}
		}
	}

	respDTO := entry.ReorderResponse{
		Entries: entriesOut,
	}
	respBytes, err := json.Marshal(respDTO)
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

func decodeStrictJSONWithLimit(w http.ResponseWriter, r *http.Request, dst any, maxBytes int64, tooLargeCode string) bool {
	ct := r.Header.Get("Content-Type")
	if mt := strings.TrimSpace(strings.Split(ct, ";")[0]); !strings.EqualFold(mt, "application/json") {
		httpx.WriteProblem(w, r, http.StatusUnsupportedMediaType, "invalid_request", httpx.ProblemTitle("invalid_request")+".")
		return false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBytes+1))
	if err != nil {
		writeContentProblem(w, r, "invalid_request")
		return false
	}
	if int64(len(body)) > maxBytes {
		httpx.WriteProblem(w, r, http.StatusRequestEntityTooLarge, tooLargeCode, httpx.ProblemTitle(tooLargeCode)+".")
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

// decodeOptionalEmptyJSON kiểm tra body của `DELETE /entries/{id}` và `POST /entries/{id}/restore`
// (OpenAPI: body rỗng hoặc `{}` hợp lệ; có trường lạ / JSON hỏng -> `400 invalid_request`).
func decodeOptionalEmptyJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, tooLargeCode string) bool {
	if r.Body == nil || r.Body == http.NoBody {
		return true
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBytes+1))
	if err != nil {
		writeContentProblem(w, r, "invalid_request")
		return false
	}
	if int64(len(body)) > maxBytes {
		httpx.WriteProblem(w, r, http.StatusRequestEntityTooLarge, tooLargeCode, httpx.ProblemTitle(tooLargeCode)+".")
		return false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return true
	}
	if !utf8.Valid(body) {
		writeContentProblem(w, r, "invalid_request")
		return false
	}
	var dst emptyObjectRequest
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&dst); err != nil {
		writeContentProblem(w, r, "invalid_request")
		return false
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		writeContentProblem(w, r, "invalid_request")
		return false
	}
	if err := rejectDuplicateOrUnknownTopKeys(body, reflect.TypeOf(&dst)); err != nil {
		writeContentProblem(w, r, "invalid_request")
		return false
	}
	return true
}
