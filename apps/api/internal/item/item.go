// Package item cung cấp domain logic, helper dựng ItemSummary, khoá item theo
// thứ tự toàn cục (plan mục 2.5), và các thao tác CRUD/lookup/list/restore cho
// thực thể Item của P04 (Task 4), đồng thời xuất các helper dùng chung cho Task 5
// (`itemTagsAdd`, `itemTagRemove`).
//
// Ràng buộc bảo mật (user-dec-016):
//   - Không bao giờ đưa `name`, `hint` hoặc `q` vào log, metric label, audit meta
//     hay thông điệp chi tiết lỗi.
package item

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
)

const (
	// MaxLiveTagsPerItem là trần 20 tag sống trên mỗi item sống (SPEC §2.4, plan mục 2.3).
	MaxLiveTagsPerItem = 20

	// MaxLiveEntriesPerItem là trần 200 entry sống trên mỗi item (SPEC §2.4, plan mục 2.3).
	MaxLiveEntriesPerItem = 200

	// DefaultPageLimit là kích thước trang mặc định cho list/lookup item (plan mục 2.3).
	DefaultPageLimit = 50

	// MinPageLimit là giới hạn dưới của `limit` (plan mục 2.3).
	MinPageLimit = 1

	// MaxPageLimit là giới hạn trên của `limit` cho list/lookup item (plan mục 2.3).
	MaxPageLimit = 100

	// LastUsedTouchThrottle là khoảng thời gian tối thiểu giữa hai lần cập nhật `last_used_at`
	// khi đọc item (5 phút, SPEC §8 / §9.2, plan Task 4).
	LastUsedTouchThrottle = 5 * time.Minute

	// SortRecent sắp danh sách theo `last_used_at DESC, id DESC` (mặc định).
	SortRecent = "recent"

	// SortAlpha sắp danh sách theo `name_normalized ASC, id ASC`.
	SortAlpha = "alpha"
)

// Error là lỗi domain có gắn mã RFC 9457 chuẩn trong `httpx.ProblemCodes`.
// Detail luôn là chuỗi tĩnh an toàn, không chứa dữ liệu người dùng.
type Error struct {
	Code           string
	Detail         string
	CurrentVersion *int32
}

func (e *Error) Error() string { return e.Code }

// Is hỗ trợ so sánh `errors.Is` theo `Code`.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	if !ok || e == nil || t == nil {
		return false
	}
	return e.Code == t.Code
}

// Sentinel domain errors cho package item.
var (
	ErrInvalidRequest       = &Error{Code: "invalid_request", Detail: "Yêu cầu không hợp lệ."}
	ErrNotFound             = &Error{Code: "not_found", Detail: "Không tìm thấy mục."}
	ErrNameInvalid          = &Error{Code: "name_invalid", Detail: "Tên mục không hợp lệ."}
	ErrHintInvalid          = &Error{Code: "hint_invalid", Detail: "Gợi ý không hợp lệ."}
	ErrItemIDConflict       = &Error{Code: "item_id_conflict", Detail: "Mã định danh mục đã tồn tại."}
	ErrItemTagLimit         = &Error{Code: "item_tag_limit", Detail: "Mục đã đạt giới hạn 20 tag."}
	ErrItemEntryLimit       = &Error{Code: "item_entry_limit", Detail: "Mục đã đạt giới hạn 200 entry."}
	ErrPreconditionRequired = &Error{Code: "precondition_required", Detail: "Thiếu hoặc sai định dạng If-Match."}
	ErrVersionMismatch      = &Error{Code: "version_mismatch", Detail: "Phiên bản mục không khớp."}
)

// NewVersionMismatchError tạo lỗi `412 version_mismatch` kèm `current_version`.
func NewVersionMismatchError(currentVersion int32) *Error {
	cv := currentVersion
	return &Error{
		Code:           "version_mismatch",
		Detail:         ErrVersionMismatch.Detail,
		CurrentVersion: &cv,
	}
}

// AsError trích xuất `*Error` từ `err` nếu có.
func AsError(err error) (*Error, bool) {
	if err == nil {
		return nil, false
	}
	var ie *Error
	if errors.As(err, &ie) && ie != nil {
		return ie, true
	}
	return nil, false
}

// TagRef biểu diễn một phần tử tag sống gắn trên `ItemSummary` (OpenAPI schema `TagRef`).
type TagRef struct {
	ID      uuid.UUID `json:"id"`
	Display string    `json:"display"`
}

// Summary biểu diễn OpenAPI schema `ItemSummary` (plan mục 2.7, 3).
// Trường `Tags` luôn là slice không-nil (`[]` khi rỗng), tối đa 20 phần tử, sắp theo `display`.
type Summary struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	Hint       *string   `json:"hint"`
	Tags       []TagRef  `json:"tags"`
	EntryCount int32     `json:"entry_count"`
	Version    int32     `json:"version"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
	LastUsedAt time.Time `json:"last_used_at"`
}

// ListPage biểu diễn OpenAPI schema `ItemList` (`{items, next_cursor}`).
type ListPage struct {
	Items      []Summary `json:"items"`
	NextCursor *string   `json:"next_cursor"`
}

// LookupResult biểu diễn OpenAPI schema `ItemLookupResult` (`{items, total, next_cursor}`).
type LookupResult struct {
	Items      []Summary `json:"items"`
	Total      int32     `json:"total"`
	NextCursor *string   `json:"next_cursor"`
}

// EmbedEnqueueHook là điểm mở rộng giữ chỗ (no-op ở P04; P05 gắn River job re-embed)
// được gọi khi tạo mới item hoặc khi `name`/`hint` thay đổi.
// Ràng buộc user-dec-016: hook chỉ nhận `(userID, itemID)`, tuyệt đối không nhận hay log plaintext.
type EmbedEnqueueHook func(ctx context.Context, userID, itemID uuid.UUID)

// NoopEmbedEnqueueHook là hook mặc định không làm gì cho tới P05.
func NoopEmbedEnqueueHook(_ context.Context, _, _ uuid.UUID) {}

// BuildSummaryFromRow chuyển đổi một `gen.Item` và danh sách `TagRef` đã truy vấn
// thành `Summary` chuẩn OpenAPI (đảm bảo `Tags` không bao giờ `nil` và giới hạn <= 20).
func BuildSummaryFromRow(row gen.Item, tags []TagRef) Summary {
	if tags == nil {
		tags = []TagRef{}
	} else if len(tags) > MaxLiveTagsPerItem {
		tags = tags[:MaxLiveTagsPerItem]
	}
	return Summary{
		ID:         row.ID,
		Name:       row.Name,
		Hint:       row.Hint,
		Tags:       tags,
		EntryCount: row.EntryCount,
		Version:    row.Version,
		CreatedAt:  row.CreatedAt.Time.UTC(),
		UpdatedAt:  row.UpdatedAt.Time.UTC(),
		LastUsedAt: row.LastUsedAt.Time.UTC(),
	}
}

// BuildSummary tải danh sách tag sống của `row` (sắp theo `display ASC, id ASC`) qua `q`
// và trả về `Summary`. Được xuất công khai để Task 5 (`itemTagsAdd`, `itemTagRemove`) tái sử dụng.
func BuildSummary(ctx context.Context, q *gen.Queries, row gen.Item) (Summary, error) {
	tagRows, err := q.ListLiveTagsForItem(ctx, gen.ListLiveTagsForItemParams{
		UserID: row.UserID,
		ItemID: row.ID,
	})
	if err != nil {
		return Summary{}, err
	}
	tags := make([]TagRef, 0, len(tagRows))
	for _, t := range tagRows {
		if len(tags) >= MaxLiveTagsPerItem {
			break
		}
		tags = append(tags, TagRef{
			ID:      t.ID,
			Display: t.Display,
		})
	}
	return BuildSummaryFromRow(row, tags), nil
}

// BuildSummaries tải danh sách tag sống cho một slice `gen.Item` chỉ bằng một truy vấn batch
// `ListLiveTagsForItems` (sắp theo `item_id ASC, display ASC, id ASC`) và dựng `[]Summary`.
// Luôn trả về slice không-nil (`[]Summary{}` khi `rows` rỗng).
func BuildSummaries(ctx context.Context, q *gen.Queries, userID uuid.UUID, rows []gen.Item) ([]Summary, error) {
	if len(rows) == 0 {
		return []Summary{}, nil
	}
	ids := make([]uuid.UUID, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	tagRows, err := q.ListLiveTagsForItems(ctx, gen.ListLiveTagsForItemsParams{
		UserID:  userID,
		ItemIds: ids,
	})
	if err != nil {
		return nil, err
	}
	byItem := make(map[uuid.UUID][]TagRef, len(rows))
	for _, tr := range tagRows {
		cur := byItem[tr.ItemID]
		if len(cur) >= MaxLiveTagsPerItem {
			continue
		}
		byItem[tr.ItemID] = append(cur, TagRef{
			ID:      tr.TagID,
			Display: tr.Display,
		})
	}
	out := make([]Summary, len(rows))
	for i, r := range rows {
		out[i] = BuildSummaryFromRow(r, byItem[r.ID])
	}
	return out, nil
}

// LockUserContentAndItem thực hiện đúng thứ tự khoá bước (2) -> bước (3) của plan mục 2.5
// cho một item của `userID`:
//  1. `q.LockUserContent(ctx, userID)` (advisory lock theo user).
//  2. `q.LockItemForUpdate(ctx, {UserID: userID, ID: itemID})`.
//
// Nếu item không tồn tại hoặc thuộc user khác, trả `ErrNotFound`.
// Nếu `requireLive == true` và item đã soft-delete (`deleted_at IS NOT NULL`), trả `ErrNotFound`.
// Helper này được xuất công khai để Task 5 (`itemTagsAdd`, `itemTagRemove`) dùng chung
// trước khi khoá tiếp các hàng `tag` theo `id ASC` (bước 4).
func LockUserContentAndItem(
	ctx context.Context,
	q *gen.Queries,
	userID uuid.UUID,
	itemID uuid.UUID,
	requireLive bool,
) (gen.Item, error) {
	if err := q.LockUserContent(ctx, userID); err != nil {
		return gen.Item{}, err
	}
	row, err := q.LockItemForUpdate(ctx, gen.LockItemForUpdateParams{
		UserID: userID,
		ID:     itemID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gen.Item{}, ErrNotFound
		}
		return gen.Item{}, err
	}
	if requireLive && row.DeletedAt.Valid {
		return gen.Item{}, ErrNotFound
	}
	return row, nil
}

// EscapeLikePrefix thoát các ký tự đại diện `\`, `%`, `_` (theo đúng thứ tự `\` trước,
// rồi `%` và `_`) và nối `%` ở cuối để dùng với `LIKE ... ESCAPE '\'` trên cột có index
// `text_pattern_ops` (plan mục 2.7, item.sql Section 4).
func EscapeLikePrefix(normalized string) string {
	var b strings.Builder
	b.Grow(len(normalized) + 4)
	for i := range len(normalized) {
		ch := normalized[i]
		if ch == '\\' || ch == '%' || ch == '_' {
			b.WriteByte('\\')
		}
		b.WriteByte(ch)
	}
	b.WriteByte('%')
	return b.String()
}

// IsItemPrimaryKeyConflict kiểm tra lỗi `23505` do trùng khóa chính `item_pkey` hoặc
// `item_user_id_id_key` khi client gửi `id` đã tồn tại trong bảng `item` (của bất kỳ user nào,
// sống hay đã soft-delete, plan mục 2.7).
func IsItemPrimaryKeyConflict(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	if pgErr.Code != "23505" {
		return false
	}
	switch pgErr.ConstraintName {
	case "item_pkey", "item_user_id_id_key":
		return true
	default:
		return false
	}
}

// listCursorPayload là cấu trúc dữ liệu bên trong cursor base64url opaque của `GET /items`.
// Gắn chặt `sort`, `tag_id` và `q` (đã normalize) để đổi bất kỳ tham số lọc nào đều trả
// `400 invalid_request` (plan mục 2.7).
type listCursorPayload struct {
	V              int       `json:"v"`
	Sort           string    `json:"s"`
	TagID          string    `json:"t,omitempty"`
	Q              string    `json:"q,omitempty"`
	LastUsedAtNano int64     `json:"lu,omitempty"`
	NameNormalized string    `json:"nn,omitempty"`
	ID             uuid.UUID `json:"id"`
}

func encodeListCursor(p listCursorPayload) string {
	p.V = 1
	raw, _ := json.Marshal(p)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeListCursor(raw string, expectedSort, expectedTagID, expectedQ string) (listCursorPayload, error) {
	var zero listCursorPayload
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(b) == 0 {
		return zero, ErrInvalidRequest
	}
	var p listCursorPayload
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return zero, ErrInvalidRequest
	}
	if p.V != 1 || p.ID == uuid.Nil {
		return zero, ErrInvalidRequest
	}
	if p.Sort != expectedSort || p.TagID != expectedTagID || p.Q != expectedQ {
		return zero, ErrInvalidRequest
	}
	switch expectedSort {
	case SortRecent:
		if p.LastUsedAtNano == 0 || p.NameNormalized != "" {
			return zero, ErrInvalidRequest
		}
	case SortAlpha:
		if p.NameNormalized == "" || p.LastUsedAtNano != 0 {
			return zero, ErrInvalidRequest
		}
	default:
		return zero, ErrInvalidRequest
	}
	return p, nil
}

// lookupCursorPayload là cấu trúc bên trong cursor base64url opaque của `GET /items/lookup`.
// Gắn chặt `name_normalized` để không dùng chéo cursor sang tên khác.
type lookupCursorPayload struct {
	V              int       `json:"v"`
	NameNormalized string    `json:"nn"`
	CreatedAtNano  int64     `json:"ca"`
	ID             uuid.UUID `json:"id"`
}

func encodeLookupCursor(nameNormalized string, createdAt time.Time, id uuid.UUID) string {
	raw, _ := json.Marshal(lookupCursorPayload{
		V:              1,
		NameNormalized: nameNormalized,
		CreatedAtNano:  createdAt.UTC().UnixNano(),
		ID:             id,
	})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeLookupCursor(raw string, expectedNameNormalized string) (time.Time, uuid.UUID, error) {
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(b) == 0 {
		return time.Time{}, uuid.Nil, ErrInvalidRequest
	}
	var p lookupCursorPayload
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return time.Time{}, uuid.Nil, ErrInvalidRequest
	}
	if p.V != 1 || p.ID == uuid.Nil || p.CreatedAtNano == 0 || p.NameNormalized != expectedNameNormalized {
		return time.Time{}, uuid.Nil, ErrInvalidRequest
	}
	return time.Unix(0, p.CreatedAtNano).UTC(), p.ID, nil
}

// Service cung cấp các thao tác đọc và hỗ trợ domain cho thực thể `Item`.
type Service struct {
	pool    *pgxpool.Pool
	clk     clock.Clock
	onEmbed EmbedEnqueueHook
}

// NewService khởi tạo `*Service` cho `Item`.
func NewService(pool *pgxpool.Pool, clk clock.Clock) *Service {
	if clk == nil {
		clk = clock.System{}
	}
	return &Service{
		pool:    pool,
		clk:     clk,
		onEmbed: NoopEmbedEnqueueHook,
	}
}

// Pool trả về `*pgxpool.Pool`.
func (s *Service) Pool() *pgxpool.Pool { return s.pool }

// Clock trả về `clock.Clock`.
func (s *Service) Clock() clock.Clock { return s.clk }

// SetEmbedEnqueueHook đăng ký hook giữ chỗ re-embed (no-op ở P04, dùng ở P05).
func (s *Service) SetEmbedEnqueueHook(fn EmbedEnqueueHook) {
	if fn == nil {
		s.onEmbed = NoopEmbedEnqueueHook
		return
	}
	s.onEmbed = fn
}

// EnqueueEmbed gọi hook giữ chỗ re-embed (không truyền bất kỳ dữ liệu plaintext nào).
func (s *Service) EnqueueEmbed(ctx context.Context, userID, itemID uuid.UUID) {
	if s.onEmbed != nil {
		s.onEmbed(ctx, userID, itemID)
	}
}

// Get đọc một item sống của `userID` theo `itemID` và cập nhật `last_used_at` nếu đã quá
// ngưỡng throttle 5 phút (`TouchItemLastUsedAt`, plan mục 3, Task 4).
func (s *Service) Get(ctx context.Context, userID, itemID uuid.UUID) (Summary, error) {
	q := gen.New(s.pool)
	row, err := q.GetLiveItemByUserAndID(ctx, gen.GetLiveItemByUserAndIDParams{
		UserID: userID,
		ID:     itemID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Summary{}, ErrNotFound
		}
		return Summary{}, err
	}

	now := s.clk.Now().UTC()
	threshold := now.Add(-LastUsedTouchThrottle)
	if row.LastUsedAt.Valid && row.LastUsedAt.Time.Before(threshold) {
		touchedRows, err := q.TouchItemLastUsedAt(ctx, gen.TouchItemLastUsedAtParams{
			Now:       pgtype.Timestamptz{Time: now, Valid: true},
			UserID:    userID,
			ID:        itemID,
			Threshold: pgtype.Timestamptz{Time: threshold, Valid: true},
		})
		if err != nil {
			return Summary{}, err
		}
		if touchedRows > 0 {
			row.LastUsedAt = pgtype.Timestamptz{Time: now, Valid: true}
		}
	}

	return BuildSummary(ctx, q, row)
}

// LookupInput là tham số đã xác thực của `LookupExact`.
type LookupInput struct {
	UserID         uuid.UUID
	NameNormalized string
	Cursor         string
	Limit          int
}

// LookupExact thực hiện `GET /items/lookup` trong một transaction chỉ đọc `REPEATABLE READ`
// để `total` (`COUNT(*)`) và trang `items` cùng nhìn một snapshot nhất quán (plan mục 2.7, Task 4).
func (s *Service) LookupExact(ctx context.Context, in LookupInput) (LookupResult, error) {
	var cCreated pgtype.Timestamptz
	var cID *uuid.UUID
	if in.Cursor != "" {
		ts, id, err := decodeLookupCursor(in.Cursor, in.NameNormalized)
		if err != nil {
			return LookupResult{}, err
		}
		cCreated = pgtype.Timestamptz{Time: ts, Valid: true}
		cID = &id
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return LookupResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := gen.New(tx)
	total, err := q.CountLiveItemsByNameExact(ctx, gen.CountLiveItemsByNameExactParams{
		UserID:         in.UserID,
		NameNormalized: in.NameNormalized,
	})
	if err != nil {
		return LookupResult{}, err
	}
	if total == 0 {
		if err := tx.Commit(ctx); err != nil {
			return LookupResult{}, err
		}
		return LookupResult{
			Items:      []Summary{},
			Total:      0,
			NextCursor: nil,
		}, nil
	}

	rows, err := q.LookupLiveItemsByNameExact(ctx, gen.LookupLiveItemsByNameExactParams{
		UserID:          in.UserID,
		NameNormalized:  in.NameNormalized,
		CursorCreatedAt: cCreated,
		CursorID:        cID,
		PageLimit:       int32(in.Limit + 1),
	})
	if err != nil {
		return LookupResult{}, err
	}

	var nextCursor *string
	if len(rows) > in.Limit {
		last := rows[in.Limit-1]
		tok := encodeLookupCursor(in.NameNormalized, last.CreatedAt.Time, last.ID)
		nextCursor = &tok
		rows = rows[:in.Limit]
	}

	summaries, err := BuildSummaries(ctx, q, in.UserID, rows)
	if err != nil {
		return LookupResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return LookupResult{}, err
	}

	return LookupResult{
		Items:      summaries,
		Total:      total,
		NextCursor: nextCursor,
	}, nil
}

// ListInput là tham số đã xác thực của `List`.
type ListInput struct {
	UserID      uuid.UUID
	Sort        string
	TagID       *uuid.UUID
	QNormalized string
	Cursor      string
	Limit       int
}

// List thực hiện `GET /items` theo `sort=recent|alpha`, hỗ trợ lọc `tag_id` (kiểm tra tag
// phải tồn tại, thuộc `userID` và chưa xoá; nếu không trả `404 not_found` theo OpenAPI `itemsList`)
// và prefix `q` trên `name_normalized` với `%`, `_`, `\` đã được escape (plan mục 2.7, Task 4).
func (s *Service) List(ctx context.Context, in ListInput) (ListPage, error) {
	tagIDStr := ""
	if in.TagID != nil {
		tagIDStr = in.TagID.String()
	}

	var cur listCursorPayload
	if in.Cursor != "" {
		var err error
		cur, err = decodeListCursor(in.Cursor, in.Sort, tagIDStr, in.QNormalized)
		if err != nil {
			return ListPage{}, err
		}
	}

	q := gen.New(s.pool)
	if in.TagID != nil {
		if _, err := q.GetLiveTagByUserAndID(ctx, gen.GetLiveTagByUserAndIDParams{
			UserID: in.UserID,
			ID:     *in.TagID,
		}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ListPage{}, ErrNotFound
			}
			return ListPage{}, err
		}
	}

	var qPrefix *string
	if in.QNormalized != "" {
		escaped := EscapeLikePrefix(in.QNormalized)
		qPrefix = &escaped
	}

	var rows []gen.Item
	var err error
	switch in.Sort {
	case SortRecent:
		var cLastUsed pgtype.Timestamptz
		var cID *uuid.UUID
		if in.Cursor != "" {
			cLastUsed = pgtype.Timestamptz{
				Time:  time.Unix(0, cur.LastUsedAtNano).UTC(),
				Valid: true,
			}
			idCopy := cur.ID
			cID = &idCopy
		}
		rows, err = q.ListLiveItemsRecent(ctx, gen.ListLiveItemsRecentParams{
			UserID:           in.UserID,
			QPrefix:          qPrefix,
			TagID:            in.TagID,
			CursorLastUsedAt: cLastUsed,
			CursorID:         cID,
			PageLimit:        int32(in.Limit + 1),
		})
	case SortAlpha:
		var cNameNorm *string
		var cID *uuid.UUID
		if in.Cursor != "" {
			nnCopy := cur.NameNormalized
			idCopy := cur.ID
			cNameNorm = &nnCopy
			cID = &idCopy
		}
		rows, err = q.ListLiveItemsAlpha(ctx, gen.ListLiveItemsAlphaParams{
			UserID:               in.UserID,
			QPrefix:              qPrefix,
			TagID:                in.TagID,
			CursorNameNormalized: cNameNorm,
			CursorID:             cID,
			PageLimit:            int32(in.Limit + 1),
		})
	default:
		return ListPage{}, ErrInvalidRequest
	}
	if err != nil {
		return ListPage{}, err
	}

	var nextCursor *string
	if len(rows) > in.Limit {
		last := rows[in.Limit-1]
		payload := listCursorPayload{
			Sort:  in.Sort,
			TagID: tagIDStr,
			Q:     in.QNormalized,
			ID:    last.ID,
		}
		if in.Sort == SortRecent {
			payload.LastUsedAtNano = last.LastUsedAt.Time.UTC().UnixNano()
		} else {
			payload.NameNormalized = last.NameNormalized
		}
		tok := encodeListCursor(payload)
		nextCursor = &tok
		rows = rows[:in.Limit]
	}

	summaries, err := BuildSummaries(ctx, q, in.UserID, rows)
	if err != nil {
		return ListPage{}, err
	}
	return ListPage{
		Items:      summaries,
		NextCursor: nextCursor,
	}, nil
}
