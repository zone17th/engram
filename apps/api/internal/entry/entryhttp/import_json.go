package entryhttp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/httpx"
	"github.com/zone17th/engram/apps/api/internal/secevent"
)

type importJSONEntryRequest struct {
	ID                 *string         `json:"id"`
	Type               *string         `json:"type"`
	Envelope           json.RawMessage `json:"envelope"`
	Ciphertext         *string         `json:"ciphertext"`
	PlaintextLenBucket *int32          `json:"plaintext_len_bucket"`
	Source             *string         `json:"source"`
}

// entryImportJSON xử lý `POST /api/v1/items/{id}/entries/import-json` (`entryImportJson`, plan mục 2.3, 2.5, 2.6, 3, Task 6c).
//
// Hợp đồng (mục 3, Task 6c, advisor-dec-105, user-dec-016):
//   - Dùng chung luồng tạo entry với `entryCreate` (trần body 400 KiB trước `Idempotency.Lookup`, idempotency,
//     rate limit `content_write`, thứ tự khoá `(1) LockVaultKeyForShare -> (2) LockUserContent -> (3) LockItemForUpdate -> (5) entry`,
//     trần 200 entry sống, position = max(position)+1 tính cả tombstone, cập nhật `entry_count`, metric `entries_created_total{type="json"}`).
//   - Decode request nghiêm ngặt (`decodeStrictEntryJSON`): mọi trường lạ như `filename` hoặc thiếu trường bắt buộc -> `400 invalid_request`.
//   - `source` bắt buộc thuộc `{"paste", "file"}` (giá trị khác hoặc thiếu -> `400 invalid_request`).
//   - `type` bắt buộc bằng `"json"` (giá trị khác -> `400 entry_invalid`).
//   - Ghi bản ghi audit `entry.import` với `Meta{ImportSource: source}` qua `ContentAudit().Record(ctx, tx, ...)`
//     ngay trong cùng transaction mutation trước `CommitIdempotencyTx` (không ghi khi request thất bại/rollback,
//     không ghi lần hai khi replay idempotent, không bao giờ chứa filename/body/ciphertext/envelope/item.name).
func (h *handler) entryImportJSON(w http.ResponseWriter, r *http.Request) {
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

	var req importJSONEntryRequest
	if !decodeStrictEntryJSON(w, r, &req) {
		return
	}
	if req.ID == nil || req.Type == nil || len(req.Envelope) == 0 || req.Ciphertext == nil || req.PlaintextLenBucket == nil || req.Source == nil {
		writeContentProblem(w, r, "invalid_request")
		return
	}
	if !entry.IsAllowedImportSource(*req.Source) {
		writeContentProblem(w, r, "invalid_request")
		return
	}

	entryID, ok := entry.ParseEntryUUID(*req.ID)
	if !ok {
		writeContentProblem(w, r, "entry_invalid")
		return
	}
	if *req.Type != entry.TypeJSON {
		writeContentProblem(w, r, "entry_invalid")
		return
	}

	payload, errCode := entry.ValidatePayload(req.Envelope, *req.Ciphertext, *req.PlaintextLenBucket)
	if errCode != "" {
		writeContentProblem(w, r, errCode)
		return
	}

	importSource := *req.Source
	userAgent := r.UserAgent()
	aud := h.c.ContentAudit()

	h.createAndCommitEntry(w, r, p, itemID, entryID, entry.TypeJSON, payload, func(ctx context.Context, tx pgx.Tx) error {
		if aud == nil {
			return errors.New("content audit store is nil")
		}
		uid := p.UserID
		sid := p.SessionID
		return aud.Record(ctx, tx, secevent.Record{
			UserID:    &uid,
			SessionID: &sid,
			Event:     secevent.EventEntryImport,
			Result:    secevent.ResultSuccess,
			Actor:     "user",
			UserAgent: userAgent,
			Meta: secevent.Meta{
				ImportSource: importSource,
			},
		})
	})
}
