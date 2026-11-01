// Package tag cung cấp domain logic, helper dựng Tag/TagList, cursor keyset và
// các thao tác danh sách cho thực thể Tag của P04 (Task 5).
//
// Ràng buộc bảo mật (user-dec-016):
//   - Không bao giờ đưa `display` hoặc `q` vào log, metric label, audit meta
//     hay thông điệp chi tiết lỗi.
package tag

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/item"
)

const (
	// MaxLiveTagsPerItem là trần 20 tag sống trên mỗi item sống (SPEC §2.4, plan mục 2.3).
	MaxLiveTagsPerItem = item.MaxLiveTagsPerItem

	// DefaultPageLimit là kích thước trang mặc định cho `GET /tags` (plan mục 2.3).
	DefaultPageLimit = item.DefaultPageLimit

	// MinPageLimit là giới hạn dưới của `limit` (plan mục 2.3).
	MinPageLimit = item.MinPageLimit

	// MaxPageLimit là giới hạn trên của `limit` cho `GET /tags` (plan mục 2.3).
	MaxPageLimit = item.MaxPageLimit

	// SortRecent sắp danh sách theo `last_used_at DESC, id DESC` (mặc định).
	SortRecent = item.SortRecent

	// SortAlpha sắp danh sách theo `normalized ASC, id ASC`.
	SortAlpha = item.SortAlpha
)

// Error là lỗi domain có gắn mã RFC 9457 chuẩn trong `httpx.ProblemCodes`.
// Detail luôn là chuỗi tĩnh an toàn, không chứa dữ liệu người dùng.
type Error struct {
	Code   string
	Detail string
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

// Sentinel domain errors cho package tag.
var (
	ErrInvalidRequest    = &Error{Code: "invalid_request", Detail: "Yêu cầu không hợp lệ."}
	ErrNotFound          = &Error{Code: "not_found", Detail: "Không tìm thấy thẻ."}
	ErrTagDisplayInvalid = &Error{Code: "tag_display_invalid", Detail: "Tên thẻ không hợp lệ."}
	ErrTagConflict       = &Error{Code: "tag_conflict", Detail: "Tên thẻ đã tồn tại."}
	ErrItemTagLimit      = &Error{Code: "item_tag_limit", Detail: "Mục đã đạt giới hạn 20 tag."}
)

// AsError trích xuất `*Error` từ `err` nếu có.
func AsError(err error) (*Error, bool) {
	if err == nil {
		return nil, false
	}
	var te *Error
	if errors.As(err, &te) && te != nil {
		return te, true
	}
	return nil, false
}

// Tag biểu diễn OpenAPI schema `Tag` (`{id, display, item_count, last_used_at, created_at}`, plan mục 2.7, 3).
type Tag struct {
	ID         uuid.UUID `json:"id"`
	Display    string    `json:"display"`
	ItemCount  int32     `json:"item_count"`
	LastUsedAt time.Time `json:"last_used_at"`
	CreatedAt  time.Time `json:"created_at"`
}

// ListPage biểu diễn OpenAPI schema `TagList` (`{items, next_cursor}`).
type ListPage struct {
	Items      []Tag   `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

// BuildTag chuyển đổi một `gen.Tag` thành `Tag` chuẩn OpenAPI.
func BuildTag(row gen.Tag) Tag {
	return Tag{
		ID:         row.ID,
		Display:    row.Display,
		ItemCount:  row.ItemCount,
		LastUsedAt: row.LastUsedAt.Time.UTC(),
		CreatedAt:  row.CreatedAt.Time.UTC(),
	}
}

// BuildTags chuyển đổi một slice `gen.Tag` thành `[]Tag` (luôn trả slice không-nil, `[]` khi rỗng).
func BuildTags(rows []gen.Tag) []Tag {
	if len(rows) == 0 {
		return []Tag{}
	}
	out := make([]Tag, len(rows))
	for i, r := range rows {
		out[i] = BuildTag(r)
	}
	return out
}

// listCursorPayload là cấu trúc dữ liệu bên trong cursor base64url opaque của `GET /tags`.
// Gắn chặt `sort` và `q` (đã normalize) để đổi bất kỳ tham số lọc nào đều trả
// `400 invalid_request` (plan mục 2.7, 3).
type listCursorPayload struct {
	V              int       `json:"v"`
	Sort           string    `json:"s"`
	Q              string    `json:"q,omitempty"`
	LastUsedAtNano int64     `json:"lu,omitempty"`
	Normalized     string    `json:"n,omitempty"`
	ID             uuid.UUID `json:"id"`
}

func encodeListCursor(p listCursorPayload) string {
	p.V = 1
	raw, _ := json.Marshal(p)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeListCursor(raw string, expectedSort, expectedQ string) (listCursorPayload, error) {
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
	if p.Sort != expectedSort || p.Q != expectedQ {
		return zero, ErrInvalidRequest
	}
	switch expectedSort {
	case SortRecent:
		if p.LastUsedAtNano == 0 || p.Normalized != "" {
			return zero, ErrInvalidRequest
		}
	case SortAlpha:
		if p.Normalized == "" || p.LastUsedAtNano != 0 {
			return zero, ErrInvalidRequest
		}
	default:
		return zero, ErrInvalidRequest
	}
	return p, nil
}

// Service cung cấp các thao tác đọc và hỗ trợ domain cho thực thể `Tag`.
type Service struct {
	pool *pgxpool.Pool
	clk  clock.Clock
}

// NewService khởi tạo `*Service` cho `Tag`.
func NewService(pool *pgxpool.Pool, clk clock.Clock) *Service {
	if clk == nil {
		clk = clock.System{}
	}
	return &Service{
		pool: pool,
		clk:  clk,
	}
}

// Pool trả về `*pgxpool.Pool`.
func (s *Service) Pool() *pgxpool.Pool { return s.pool }

// Clock trả về `clock.Clock`.
func (s *Service) Clock() clock.Clock { return s.clk }

// ListInput là tham số đã xác thực của `List`.
type ListInput struct {
	UserID      uuid.UUID
	Sort        string
	QNormalized string
	Cursor      string
	Limit       int
}

// List thực hiện `GET /tags` theo `sort=recent|alpha`, hỗ trợ lọc prefix `q` trên
// `normalized` với `%`, `_`, `\` đã được escape (plan mục 2.7, 3, Task 5).
func (s *Service) List(ctx context.Context, in ListInput) (ListPage, error) {
	var cur listCursorPayload
	if in.Cursor != "" {
		var err error
		cur, err = decodeListCursor(in.Cursor, in.Sort, in.QNormalized)
		if err != nil {
			return ListPage{}, err
		}
	}

	var qPrefix *string
	if in.QNormalized != "" {
		escaped := item.EscapeLikePrefix(in.QNormalized)
		qPrefix = &escaped
	}

	q := gen.New(s.pool)
	var rows []gen.Tag
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
		rows, err = q.ListLiveTagsRecent(ctx, gen.ListLiveTagsRecentParams{
			UserID:           in.UserID,
			QPrefix:          qPrefix,
			CursorLastUsedAt: cLastUsed,
			CursorID:         cID,
			PageLimit:        int32(in.Limit + 1),
		})
	case SortAlpha:
		var cNorm *string
		var cID *uuid.UUID
		if in.Cursor != "" {
			normCopy := cur.Normalized
			idCopy := cur.ID
			cNorm = &normCopy
			cID = &idCopy
		}
		rows, err = q.ListLiveTagsAlpha(ctx, gen.ListLiveTagsAlphaParams{
			UserID:           in.UserID,
			QPrefix:          qPrefix,
			CursorNormalized: cNorm,
			CursorID:         cID,
			PageLimit:        int32(in.Limit + 1),
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
			Sort: in.Sort,
			Q:    in.QNormalized,
			ID:   last.ID,
		}
		if in.Sort == SortRecent {
			payload.LastUsedAtNano = last.LastUsedAt.Time.UTC().UnixNano()
		} else {
			payload.Normalized = last.Normalized
		}
		tok := encodeListCursor(payload)
		nextCursor = &tok
		rows = rows[:in.Limit]
	}

	return ListPage{
		Items:      BuildTags(rows),
		NextCursor: nextCursor,
	}, nil
}
