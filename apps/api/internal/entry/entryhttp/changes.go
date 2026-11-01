package entryhttp

import (
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/entry"
	"github.com/zone17th/engram/apps/api/internal/httpx"
)

// entriesChanges xử lý `GET /api/v1/entries/changes?since&cursor&limit` (`entriesChanges`,
// plan mục 2.9, mục 3, Task 7; ADR 0005 §11).
//
// Hợp đồng:
//   - Chỉ xác thực session (`S`).
//   - `limit`: 1..200, mặc định 100 (`400 invalid_request` nếu rỗng/ngoài khoảng/sai dạng/nhiều giá trị).
//   - Không có `since` và không có `cursor`: bootstrap trả `{changes: [], next_cursor: null, watermark}`
//     từ `ContentClockNow`, không quét bảng `entry` (OpenAPI `ChangesSince`).
//   - Có `cursor` nhưng thiếu `since`: `400 invalid_request`.
//   - `since` theo `RFC3339Nano` (sai dạng -> `400 invalid_request`).
//   - Kiểm tra cửa sổ 29 ngày (`since < dbNow - 29 days` -> `410 changes_window_expired`) dựa trên
//     đồng hồ DB `ContentClockNow` (`clock_timestamp()`) thay vì đồng hồ Go (`clock.Fixed`), để mọi
//     timestamp `entry.updated_at` / `entry.deleted_at` (vốn luôn sinh từ `clock_timestamp()` của
//     Postgres) cùng một nguồn thời gian nhất quán và các bài test có thể suy luận chính xác.
//   - `watermark` được lấy từ `ContentClockNow` ở đầu trang đầu tiên của chuỗi phân trang và đóng gói
//     vào `cursor` cùng `user_id`, `since`, và keyset `(updated_at, id)`; các trang tiếp theo giữ
//     nguyên `watermark` của trang đầu và lọc `updated_at >= since` + keyset mà không áp cận trên.
//   - Cursor của user khác hoặc lệch `since` -> `400 invalid_request`.
//   - Response chỉ chứa metadata (`EntryChange`, gồm cả tombstone `deleted_at != nil`), không bao giờ
//     có `envelope` hay `ciphertext` (user-dec-016). `changes` luôn là mảng `[]` khi rỗng.
func (h *handler) entriesChanges(w http.ResponseWriter, r *http.Request) {
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok {
		httpx.WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return
	}

	qParams := r.URL.Query()

	limit := entry.DefaultChangesLimit
	if rawLimits, hasLimit := qParams["limit"]; hasLimit {
		if len(rawLimits) != 1 || rawLimits[0] == "" {
			writeContentProblem(w, r, "invalid_request")
			return
		}
		parsed, err := strconv.Atoi(rawLimits[0])
		if err != nil || parsed < entry.MinChangesLimit || parsed > entry.MaxChangesLimit {
			writeContentProblem(w, r, "invalid_request")
			return
		}
		limit = parsed
	}

	rawSinces, hasSince := qParams["since"]
	rawCursors, hasCursor := qParams["cursor"]

	if hasSince && (len(rawSinces) != 1 || rawSinces[0] == "") {
		writeContentProblem(w, r, "invalid_request")
		return
	}
	if hasCursor && (len(rawCursors) != 1 || rawCursors[0] == "") {
		writeContentProblem(w, r, "invalid_request")
		return
	}

	ctx := r.Context()
	q := gen.New(h.c.ContentPool())

	// Bootstrap khi không có `since`: chỉ hợp lệ khi cũng không có `cursor` (OpenAPI `ChangesSince`).
	if !hasSince {
		if hasCursor {
			writeContentProblem(w, r, "invalid_request")
			return
		}
		dbNowTS, err := q.ContentClockNow(ctx)
		if err != nil || !dbNowTS.Valid {
			httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
			return
		}
		writeJSON(w, http.StatusOK, entry.ChangesPage{
			Changes:    []entry.Change{},
			NextCursor: nil,
			Watermark:  entry.FormatTimestamp(dbNowTS),
		})
		return
	}

	sinceTime, err := time.Parse(time.RFC3339Nano, rawSinces[0])
	if err != nil {
		writeContentProblem(w, r, "invalid_request")
		return
	}
	sinceTime = sinceTime.UTC()

	var (
		cursorUpdatedAt pgtype.Timestamptz
		cursorID        *uuid.UUID
		decodedCur      entry.DecodedChangesCursor
	)
	if hasCursor {
		var validCur bool
		decodedCur, validCur = entry.DecodeChangesCursor(rawCursors[0], p.UserID, sinceTime)
		if !validCur {
			writeContentProblem(w, r, "invalid_request")
			return
		}
		cursorUpdatedAt = pgtype.Timestamptz{
			Time:  decodedCur.CursorUpdatedAt,
			Valid: true,
		}
		cid := decodedCur.CursorID
		cursorID = &cid
	}

	// Lấy `clock_timestamp()` từ DB (`ContentClockNow`) để:
	//   1. Kiểm tra `since < dbNow - 29 days` -> `410 changes_window_expired`.
	//   2. Dùng làm `watermark` khi đây là trang đầu tiên (không có `cursor`).
	dbNowTS, err := q.ContentClockNow(ctx)
	if err != nil || !dbNowTS.Valid {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}
	dbNow := dbNowTS.Time.UTC()
	if sinceTime.Before(dbNow.Add(-entry.ChangesRetentionWindow)) {
		writeContentProblem(w, r, "changes_window_expired")
		return
	}

	watermarkTime := dbNow
	if hasCursor {
		watermarkTime = decodedCur.Watermark
	}

	rows, err := q.ListEntryChangesSince(ctx, gen.ListEntryChangesSinceParams{
		UserID:          p.UserID,
		Since:           pgtype.Timestamptz{Time: sinceTime, Valid: true},
		CursorUpdatedAt: cursorUpdatedAt,
		CursorID:        cursorID,
		PageLimit:       int32(limit + 1),
	})
	if err != nil {
		httpx.WriteProblem(w, r, http.StatusInternalServerError, "internal_error", httpx.ProblemTitle("internal_error")+".")
		return
	}

	changes := make([]entry.Change, 0, min(len(rows), limit))
	var nextCursor *string
	for i, row := range rows {
		if i == limit {
			last := rows[limit-1]
			c := entry.EncodeChangesCursor(p.UserID, sinceTime, watermarkTime, last.UpdatedAt.Time.UTC(), last.ID)
			nextCursor = &c
			break
		}
		changes = append(changes, entry.ChangeFromRow(row))
	}

	writeJSON(w, http.StatusOK, entry.ChangesPage{
		Changes:    changes,
		NextCursor: nextCursor,
		Watermark:  watermarkTime.UTC().Format(time.RFC3339Nano),
	})
}
