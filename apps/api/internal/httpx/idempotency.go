package httpx

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
)

const (
	// HeaderIdempotencyKey là tên header chống lặp thao tác (SPEC §9.1).
	HeaderIdempotencyKey = "Idempotency-Key"

	// IdempotencyInProgressWindow là thời gian 60 giây một claim in_progress được bảo vệ
	// trước khi retry cùng fingerprint có thể giành lại claim (mục 2.3 bước 2 & 6).
	IdempotencyInProgressWindow = 60 * time.Second

	// IdempotencyMaxBodyBytes là giới hạn đọc body ở tầng idempotency (512 KiB, đủ cho
	// mọi route vault và entry 256 KiB của P04).
	IdempotencyMaxBodyBytes = 512 * 1024

	// ContentEntryJSONLimit là trần body JSON cho các route ghi entry P04 (400 KiB, mục 2.3).
	ContentEntryJSONLimit int64 = 400 * 1024

	// ContentItemTagJSONLimit là trần body JSON cho các route ghi item và tag P04 (16 KiB, mục 2.3).
	ContentItemTagJSONLimit int64 = 16 * 1024

	// ContentEntryTooLargeCode là mã lỗi 413 khi body route entry vượt ContentEntryJSONLimit.
	ContentEntryTooLargeCode = "entry_too_large"

	// ContentItemTagTooLargeCode là mã lỗi 413 khi body route item/tag vượt ContentItemTagJSONLimit.
	ContentItemTagTooLargeCode = "invalid_request"

	// SQLSTATE của PostgreSQL cho deadlock, lock timeout và unique violation (mục 2.5, 2.7).
	PGCodeDeadlockDetected = "40P01"
	PGCodeLockNotAvailable = "55P03"
	PGCodeUniqueViolation  = "23505"

	idempotencyStateKey ctxKey = iota + 200
)

// IdempotencyBodyLimit cấu hình trần đọc request body trước bước Idempotency.Lookup (mục 2.3, P4BE2-2).
// Giá trị rỗng (Bytes <= 0) giữ nguyên hành vi P03 (Lookup đọc tối đa IdempotencyMaxBodyBytes = 512 KiB).
type IdempotencyBodyLimit struct {
	Bytes int64
	Code  string
}

// ContentEntryBodyLimit là cấu hình BodyLimit chuẩn cho các route ghi entry (400 KiB -> 413 entry_too_large).
var ContentEntryBodyLimit = IdempotencyBodyLimit{
	Bytes: ContentEntryJSONLimit,
	Code:  ContentEntryTooLargeCode,
}

// ContentItemTagBodyLimit là cấu hình BodyLimit chuẩn cho các route ghi item/tag (16 KiB -> 413 invalid_request).
var ContentItemTagBodyLimit = IdempotencyBodyLimit{
	Bytes: ContentItemTagJSONLimit,
	Code:  ContentItemTagTooLargeCode,
}

var idempotencyKeyRegex = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// ErrIdempotencyOwnerMismatch báo hiệu câu lệnh UPDATE idempotency_key ... status='done'
// cuối transaction không cập nhật đúng 1 dòng (ví dụ request đầu chạy quá 60 giây và bị
// request sau giành lại claim). Handler bắt buộc rollback toàn bộ transaction mutation.
var ErrIdempotencyOwnerMismatch = errors.New("idempotency: owner_token không còn sở hữu claim")

// IdempotencyDB là tập kết nối/pool tối thiểu mà middleware Idempotency cần:
// vừa chạy được truy vấn đơn lẻ (qua gen.DBTX), vừa mở được transaction ngắn cho bước Claim
// hoặc transaction mutation có timeout 30 giây.
type IdempotencyDB interface {
	gen.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// IdempotencyTxStarter là đối tượng mở được pgx.Tx (ví dụ *pgxpool.Pool hoặc *pgx.Conn).
type IdempotencyTxStarter interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// IdempotencyTx là giao diện tối thiểu của một transaction (pgx.Tx thỏa mãn trực tiếp,
// đồng thời cho phép test giả lập lỗi ngay lúc Commit để kiểm tra bước 8).
type IdempotencyTx interface {
	gen.DBTX
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

type idempotencyClassification int

const (
	idemProceed idempotencyClassification = iota
	idemReplayed
	idemConflict
	idemInProgress
)

// IdempotencyClaim giữ thông tin bản ghi idempotency đã được middleware đọc và claim.
// Handler dùng đối tượng này để ghi `done` trong cùng `pgx.Tx` của mutation và báo cho
// bước 8 biết chắc chắn transaction đã commit hay chưa.
type IdempotencyClaim struct {
	UserID      uuid.UUID
	Key         string
	Method      string
	Path        string
	RequestHash []byte

	mu          sync.Mutex
	ownerToken  uuid.UUID
	claimed     bool
	finished    bool
	commitUncer bool // true từ ngay trước tx.Commit() nếu Commit trả lỗi (không biết chắc đã commit chưa)
	committed   bool // true sau khi tx.Commit() trả nil
}

// OwnerToken trả owner_token đã claim ở bước 6.
func (c *IdempotencyClaim) OwnerToken() uuid.UUID {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ownerToken
}

func (c *IdempotencyClaim) setClaimed(tok uuid.UUID) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ownerToken = tok
	c.claimed = true
}

// MarkCommitAmbiguous đánh dấu trạng thái không biết chắc COMMIT đã thành công hay chưa
// (ví dụ lỗi mạng ngay trong lúc COMMIT). Bước 8 sẽ giữ nguyên hàng trên DB.
func (c *IdempotencyClaim) MarkCommitAmbiguous() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.commitUncer = true
}

// MarkCommitted đánh dấu transaction mutation đã COMMIT thành công. Bước 8 sẽ không bao giờ
// xóa hàng `done`, kể cả khi có lỗi xảy ra sau COMMIT (ghi response, gửi notice/mail).
func (c *IdempotencyClaim) MarkCommitted() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.committed = true
	c.commitUncer = false
}

func (c *IdempotencyClaim) shouldReleaseOnExit(statusCode int, panicked bool) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.claimed {
		return false
	}
	if c.committed || c.commitUncer {
		return false
	}
	if panicked {
		return true
	}
	// Nếu handler chưa gọi FinishTx (ví dụ trả lỗi 4xx/5xx trước khi mở hoặc trước khi kết thúc tx)
	// hoặc status >= 400 và chưa commit, chắc chắn mutation chưa commit -> được phép release.
	if !c.finished || statusCode >= http.StatusBadRequest {
		return true
	}
	return false
}

// IdempotencyClaimFrom lấy *IdempotencyClaim đã gắn vào context.
func IdempotencyClaimFrom(ctx context.Context) (*IdempotencyClaim, bool) {
	c, ok := ctx.Value(idempotencyStateKey).(*IdempotencyClaim)
	return c, ok && c != nil
}

// ValidateIdempotencyKey kiểm tra key theo SPEC §8 / §9.1: độ dài 16–128 ký tự `[A-Za-z0-9_-]`.
func ValidateIdempotencyKey(key string) bool {
	return idempotencyKeyRegex.MatchString(key)
}

// ConcreteRequestPath trả concrete path đúng như server nhận (percent-encoded nếu có,
// không decode, không kèm query string) theo SPEC §9.1 / plan mục 2.3.
func ConcreteRequestPath(r *http.Request) string {
	if r == nil {
		return ""
	}
	if raw := r.RequestURI; raw != "" {
		if idx := strings.IndexByte(raw, '?'); idx >= 0 {
			raw = raw[:idx]
		}
		if strings.HasPrefix(raw, "/") || raw == "*" {
			return raw
		}
		if idx := strings.Index(raw, "://"); idx > 0 && hasValidSchemePrefix(raw[:idx]) {
			rest := raw[idx+3:]
			if slash := strings.IndexByte(rest, '/'); slash >= 0 {
				raw = rest[slash:]
			} else {
				raw = "/"
			}
		}
		if raw != "" {
			return raw
		}
	}
	if r.URL != nil {
		if r.URL.RawPath != "" {
			return r.URL.RawPath
		}
		if esc := r.URL.EscapedPath(); esc != "" {
			return esc
		}
		if r.URL.Path != "" {
			return r.URL.Path
		}
	}
	return ""
}

func hasValidSchemePrefix(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		b := s[i]
		isAlpha := (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
		if i == 0 {
			if !isAlpha {
				return false
			}
			continue
		}
		isDigit := b >= '0' && b <= '9'
		if !isAlpha && !isDigit && b != '+' && b != '-' && b != '.' {
			return false
		}
	}
	return true
}

// ComputeIdempotencyFingerprint tính SHA-256(method || 0x00 || path || 0x00 || body).
func ComputeIdempotencyFingerprint(method, path string, body []byte) []byte {
	h := sha256.New()
	h.Write([]byte(method))
	h.Write([]byte{0})
	h.Write([]byte(path))
	h.Write([]byte{0})
	h.Write(body)
	return h.Sum(nil)
}

// Idempotency quản lý bước 2 (Lookup) và bước 6–8 (Claim, Finish trong Tx, Release)
// theo đúng thứ tự 8 bước của plan mục 2.3 và SPEC §9.1.
type Idempotency struct {
	db            IdempotencyDB
	clk           clock.Clock
	onClaimRace   func() // test hook tùy chọn chạy ngay trước câu lệnh INSERT ... ON CONFLICT ở bước 6
	onClaimReread func() // test hook tùy chọn chạy ngay trước khi request thua race đọc lại hàng ở bước 6
}

// NewIdempotency tạo bộ quản lý middleware idempotency. Nếu clk == nil thì dùng clock.System{}.
func NewIdempotency(db IdempotencyDB, clk clock.Clock) *Idempotency {
	if clk == nil {
		clk = clock.System{}
	}
	return &Idempotency{db: db, clk: clk}
}

// Lookup là middleware bước 2 (đứng sau RequireOrigin -> RequireSession -> RequireCSRF -> RequireJSONContent,
// và đứng TRƯỚC RequireReauth, RateLimit, RequireIfMatch):
//   - Kiểm tra header Idempotency-Key hợp lệ (16..128 ký tự [A-Za-z0-9_-]).
//   - Đọc body bytes (khôi phục lại r.Body cho handler) và tính fingerprint = SHA-256(method 0x00 path 0x00 body)
//     với concrete path đã nhận.
//   - Tra cứu theo (user_id, key) với expires_at > now():
//   - done + cùng fingerprint -> trả ngay response đã lưu (status_code, body hoặc rỗng) và dừng.
//   - done hoặc in_progress + fingerprint khác -> 409 idempotency_conflict.
//   - in_progress + cùng fingerprint, claimed_at trong 60 giây -> 409 idempotency_in_progress kèm Retry-After: 1.
//   - Không có hàng còn hạn, hoặc in_progress cùng fingerprint quá 60 giây -> gắn thông tin vào context để sang bước 3.
func (m *Idempotency) Lookup(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m == nil || m.db == nil {
			WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ chưa sẵn sàng.")
			return
		}
		p, ok := authctx.PrincipalFrom(r.Context())
		if !ok {
			WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
			return
		}
		vals := r.Header.Values(HeaderIdempotencyKey)
		if len(vals) != 1 || !ValidateIdempotencyKey(vals[0]) {
			WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Thiếu hoặc sai định dạng Idempotency-Key.")
			return
		}
		key := vals[0]

		var bodyBytes []byte
		if r.Body != nil && r.Body != http.NoBody {
			var err error
			bodyBytes, err = io.ReadAll(io.LimitReader(r.Body, IdempotencyMaxBodyBytes+1))
			if err != nil {
				WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Không đọc được nội dung.")
				return
			}
			if len(bodyBytes) > IdempotencyMaxBodyBytes {
				WriteProblem(w, r, http.StatusRequestEntityTooLarge, "invalid_request", "Nội dung quá lớn.")
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		}

		path := ConcreteRequestPath(r)
		fp := ComputeIdempotencyFingerprint(r.Method, path, bodyBytes)
		now := m.clk.Now().UTC()

		q := gen.New(m.db)
		row, err := q.GetIdempotencyKey(r.Context(), gen.GetIdempotencyKeyParams{
			UserID: p.UserID,
			Key:    key,
			Now:    pgtype.Timestamptz{Time: now, Valid: true},
		})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi máy chủ.")
			return
		}
		if err == nil {
			if m.classifyAndRespond(w, r, row, fp, now) != idemProceed {
				return
			}
		}

		claim := &IdempotencyClaim{
			UserID:      p.UserID,
			Key:         key,
			Method:      r.Method,
			Path:        path,
			RequestHash: fp,
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), idempotencyStateKey, claim)))
	})
}

// Claim là middleware bước 6 & bước 8 (đứng SAU RequireReauth, RateLimit, RequireIfMatch và ngay trước Handler):
//   - Bước 6: mở một transaction ngắn riêng để chạy câu lệnh ClaimIdempotencyKey (INSERT ... ON CONFLICT DO UPDATE ... RETURNING owner_token).
//     Nếu không có dòng trả về (thua race với request song song), đọc lại hàng và phân loại y hệt bước 2.
//   - Bước 7: gọi handler.
//   - Bước 8 (Release): khi handler kết thúc, chỉ khi biết chắc transaction mutation chưa commit
//     (lỗi trước COMMIT, hoặc rollback thành công) mới DELETE hàng in_progress có cùng owner_token.
//     Nếu lỗi ngay lúc COMMIT (commitUncer) hoặc đã COMMIT thành công (committed) thì giữ nguyên hàng.
func (m *Idempotency) Claim(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m == nil || m.db == nil {
			WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ chưa sẵn sàng.")
			return
		}
		claim, ok := IdempotencyClaimFrom(r.Context())
		if !ok {
			WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Thiếu bước tra cứu idempotency.")
			return
		}

		if m.onClaimRace != nil {
			m.onClaimRace()
		}

		now := m.clk.Now().UTC()
		tok := uuid.New()
		claimedTok, won, err := m.tryClaimInShortTx(r.Context(), claim, tok, now)
		if err != nil {
			WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi máy chủ.")
			return
		}
		if !won {
			if m.onClaimReread != nil {
				m.onClaimReread()
			}
			q := gen.New(m.db)
			row, getErr := q.GetIdempotencyKey(r.Context(), gen.GetIdempotencyKeyParams{
				UserID: claim.UserID,
				Key:    claim.Key,
				Now:    pgtype.Timestamptz{Time: now, Valid: true},
			})
			if getErr != nil {
				if errors.Is(getErr, pgx.ErrNoRows) {
					// Đối thủ vừa thắng race nhưng gặp lỗi trước COMMIT và đã release (xóa) hàng,
					// hoặc hàng vừa hết hạn ngay giữa lúc thua race và lúc đọc lại:
					// trả 409 idempotency_in_progress kèm Retry-After: 1 để client thử lại an toàn.
					retry := 1
					WriteProblemExtra(w, r, http.StatusConflict, "idempotency_in_progress", "Yêu cầu cùng khoá idempotency đang xử lý.", ProblemExtra{RetryAfter: &retry})
					return
				}
				WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Lỗi máy chủ.")
				return
			}
			if m.classifyAndRespond(w, r, row, claim.RequestHash, now) == idemProceed {
				retry := 1
				WriteProblemExtra(w, r, http.StatusConflict, "idempotency_in_progress", "Yêu cầu cùng khoá idempotency đang xử lý.", ProblemExtra{RetryAfter: &retry})
			}
			return
		}

		claim.setClaimed(claimedTok)
		rec := &idempotencyStatusRecorder{ResponseWriter: w}
		panicked := true
		defer func() {
			if claim.shouldReleaseOnExit(rec.statusCode(), panicked) {
				releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_, _ = gen.New(m.db).ReleaseIdempotencyKey(releaseCtx, gen.ReleaseIdempotencyKeyParams{
					UserID:     claim.UserID,
					Key:        claim.Key,
					OwnerToken: claimedTok,
				})
			}
		}()

		next.ServeHTTP(rec, r)
		panicked = false
	})
}

func (m *Idempotency) tryClaimInShortTx(ctx context.Context, claim *IdempotencyClaim, tok uuid.UUID, now time.Time) (uuid.UUID, bool, error) {
	tx, err := m.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := gen.New(tx)
	ownerTok, err := q.ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
		UserID:      claim.UserID,
		Key:         claim.Key,
		Method:      claim.Method,
		Path:        claim.Path,
		RequestHash: claim.RequestHash,
		OwnerToken:  tok,
		Now:         pgtype.Timestamptz{Time: now, Valid: true},
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, false, nil
		}
		return uuid.Nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, false, err
	}
	return ownerTok, true, nil
}

func (m *Idempotency) classifyAndRespond(w http.ResponseWriter, r *http.Request, row gen.IdempotencyKey, fp []byte, now time.Time) idempotencyClassification {
	sameFP := bytes.Equal(row.RequestHash, fp)
	if !sameFP {
		WriteProblem(w, r, http.StatusConflict, "idempotency_conflict", "Khoá idempotency đã được dùng cho yêu cầu khác.")
		return idemConflict
	}
	switch row.Status {
	case "done":
		code := http.StatusOK
		if row.StatusCode != nil && *row.StatusCode > 0 {
			code = int(*row.StatusCode)
		}
		w.Header().Set("Cache-Control", "no-store")
		if len(row.Response) > 0 && code != http.StatusNoContent {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(code)
			_, _ = w.Write(row.Response)
		} else {
			w.WriteHeader(code)
		}
		return idemReplayed
	case "in_progress":
		claimedAt := row.ClaimedAt.Time.UTC()
		// Trong 60 giây kể từ claimed_at (tương đương claimed_at >= now - 60s, khớp phủ định của
		// điều kiện SQL `claimed_at < now - interval '60 seconds'`).
		if !claimedAt.Before(now.Add(-IdempotencyInProgressWindow)) {
			retry := 1
			WriteProblemExtra(w, r, http.StatusConflict, "idempotency_in_progress", "Yêu cầu cùng khoá idempotency đang xử lý.", ProblemExtra{RetryAfter: &retry})
			return idemInProgress
		}
		return idemProceed
	default:
		return idemProceed
	}
}

// BeginMutationTx mở một pgx.Tx và đặt `SET LOCAL lock_timeout = '30s'` cùng
// `SET LOCAL statement_timeout = '30s'` theo đúng bước 7 của plan mục 2.3.
func BeginMutationTx(ctx context.Context, starter IdempotencyTxStarter) (pgx.Tx, error) {
	tx, err := starter.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if err := ConfigureMutationTxTimeouts(ctx, tx); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// ConfigureMutationTxTimeouts thiết lập `lock_timeout` và `statement_timeout` 30 giây
// trong phạm vi transaction hiện tại (`SET LOCAL`).
func ConfigureMutationTxTimeouts(ctx context.Context, tx gen.DBTX) error {
	if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '30s'"); err != nil {
		return fmt.Errorf("set lock_timeout: %w", err)
	}
	if _, err := tx.Exec(ctx, "SET LOCAL statement_timeout = '30s'"); err != nil {
		return fmt.Errorf("set statement_timeout: %w", err)
	}
	return nil
}

// FinishIdempotencyTx ghi trạng thái `done`, `status_code` và `response` (NULL nếu responseBody rỗng
// hoặc status 204) ngay cuối transaction mutation của handler (trước COMMIT), kiểm tra `owner_token`.
// Nếu số dòng cập nhật khác 1 (request khác đã giành claim sau 60s), hàm trả `ErrIdempotencyOwnerMismatch`
// để handler rollback toàn bộ mutation.
func FinishIdempotencyTx(ctx context.Context, tx gen.DBTX, statusCode int, responseBody []byte) error {
	claim, ok := IdempotencyClaimFrom(ctx)
	if !ok {
		return errors.New("idempotency: thiếu claim trong context")
	}
	return claim.FinishTx(ctx, tx, statusCode, responseBody)
}

// FinishTx thực hiện `UPDATE idempotency_key SET status='done', status_code=$s, response=$r WHERE user_id=$u AND key=$k AND owner_token=$tok`
// bằng chính `tx` của mutation.
func (c *IdempotencyClaim) FinishTx(ctx context.Context, tx gen.DBTX, statusCode int, responseBody []byte) error {
	c.mu.Lock()
	if !c.claimed {
		c.mu.Unlock()
		return errors.New("idempotency: claim chưa được khởi tạo")
	}
	tok := c.ownerToken
	c.mu.Unlock()

	var resp []byte
	if len(responseBody) > 0 && statusCode != http.StatusNoContent {
		if !json.Valid(responseBody) {
			return errors.New("idempotency: responseBody không phải JSON hợp lệ")
		}
		resp = responseBody
	}

	q := gen.New(tx)
	rows, err := q.FinishIdempotencyKey(ctx, gen.FinishIdempotencyKeyParams{
		StatusCode: int32(statusCode),
		Response:   resp,
		UserID:     c.UserID,
		Key:        c.Key,
		OwnerToken: tok,
	})
	if err != nil {
		return err
	}
	if rows != 1 {
		return ErrIdempotencyOwnerMismatch
	}

	c.mu.Lock()
	c.finished = true
	c.mu.Unlock()
	return nil
}

// CommitIdempotencyTx thực hiện bước cuối của bước 7 và chuẩn bị trạng thái cho bước 8:
//  1. Gọi FinishIdempotencyTx trên `tx` (nếu khác 1 dòng -> `tx.Rollback(ctx)` và trả `ErrIdempotencyOwnerMismatch`).
//  2. Đánh dấu trạng thái đang COMMIT rồi gọi `tx.Commit(ctx)`:
//     - Nếu `Commit` trả lỗi: giữ cờ `MarkCommitAmbiguous()` để bước 8 KHÔNG xóa hàng (vì không biết chắc DB đã commit hay chưa).
//     - Nếu `Commit` thành công: gọi `MarkCommitted()` để bước 8 biết chắc hàng đã là `done` và giữ nguyên kể cả khi bước sau COMMIT gặp lỗi.
func CommitIdempotencyTx(ctx context.Context, tx IdempotencyTx, statusCode int, responseBody []byte) error {
	claim, ok := IdempotencyClaimFrom(ctx)
	if !ok {
		_ = tx.Rollback(ctx)
		return errors.New("idempotency: thiếu claim trong context")
	}
	if err := claim.FinishTx(ctx, tx, statusCode, responseBody); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	claim.MarkCommitAmbiguous()
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	claim.MarkCommitted()
	return nil
}

// PurgeOtherVaultIdempotencyKeysTx xóa các bản ghi idempotency khác của cùng user trên
// `/api/v1/vault%` trong cùng transaction reset vault (`DELETE /vault`), giữ lại bản ghi
// của chính request reset hiện tại để khi retry vẫn nhận lại 204 (mục 2.3).
func PurgeOtherVaultIdempotencyKeysTx(ctx context.Context, tx gen.DBTX) error {
	claim, ok := IdempotencyClaimFrom(ctx)
	if !ok {
		return errors.New("idempotency: thiếu claim trong context")
	}
	_, err := gen.New(tx).PurgeVaultIdempotencyKeys(ctx, gen.PurgeVaultIdempotencyKeysParams{
		UserID: claim.UserID,
		Key:    claim.Key,
	})
	return err
}

// ReleaseIdempotencyClaim xóa tường minh hàng `in_progress` thuộc `owner_token` của request hiện tại
// khi caller biết chắc chắn transaction mutation đã rollback hoặc chưa từng commit.
func ReleaseIdempotencyClaim(ctx context.Context, db gen.DBTX) error {
	claim, ok := IdempotencyClaimFrom(ctx)
	if !ok {
		return nil
	}
	claim.mu.Lock()
	if !claim.claimed || claim.committed || claim.commitUncer {
		claim.mu.Unlock()
		return nil
	}
	tok := claim.ownerToken
	claim.mu.Unlock()

	_, err := gen.New(db).ReleaseIdempotencyKey(ctx, gen.ReleaseIdempotencyKeyParams{
		UserID:     claim.UserID,
		Key:        claim.Key,
		OwnerToken: tok,
	})
	return err
}

// IsContentRetryableTxError kiểm tra lỗi PostgreSQL cần chuyển thành 503 dependency_unavailable
// kèm Retry-After: 1 trên các transaction ghi content P04 (mục 2.5, 2.7):
//   - 40P01 (deadlock_detected)
//   - 55P03 (lock_not_available / lock timeout)
//   - 23505 (unique_violation — lưới an toàn cho race qua partial unique index như tag_user_norm_uq)
//
// Lưu ý cho W2 handlers (itemtag / entryapi):
// Các xung đột ID do client gửi (`item_id_conflict` trên POST /items, `entry_id_conflict` trên
// POST /items/{id}/entries hoặc import-json) và xung đột tên tag (`tag_conflict` trên PATCH /tags/{id}
// hoặc POST /tags/{id}/restore) được kiểm tra tường minh trong handler dưới LockUserContent TRƯỚC khi
// INSERT/UPDATE. Nếu W2 handler chọn bắt 23505 theo tên constraint cho `item_pkey`/`item_user_id_id_key`
// hoặc `entry_pkey`, handler kiểm tra constraint đó trước khi gọi WriteContentTxError; mọi 23505 còn lại
// (hoặc khi gọi trực tiếp WriteContentTxError) đều ánh xạ an toàn về 503 dependency_unavailable + Retry-After: 1
// và giải phóng claim idempotency để client thử lại cùng key.
func IsContentRetryableTxError(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	switch pgErr.Code {
	case PGCodeDeadlockDetected, PGCodeLockNotAvailable, PGCodeUniqueViolation:
		return true
	default:
		return false
	}
}

// WriteContentTxError kiểm tra nếu `err` là lỗi transaction PostgreSQL có thể thử lại của content
// (`40P01`, `55P03`, `23505` theo mục 2.5): rollback `tx` (nếu khác nil), giải phóng claim idempotency
// hiện tại (chưa commit) để retry cùng Idempotency-Key chạy lại từ đầu, và ghi response
// `503 dependency_unavailable` kèm header `Retry-After: 1` (và trường `retry_after: 1` trong body).
// Trả `true` nếu đã xử lý và ghi response; trả `false` nếu `err` không thuộc nhóm trên.
func WriteContentTxError(ctx context.Context, w http.ResponseWriter, r *http.Request, db gen.DBTX, tx IdempotencyTx, err error) bool {
	if !IsContentRetryableTxError(err) {
		return false
	}
	if tx != nil {
		_ = tx.Rollback(ctx)
	}
	if db != nil {
		_ = ReleaseIdempotencyClaim(ctx, db)
	}
	retry := 1
	WriteProblemExtra(
		w,
		r,
		http.StatusServiceUnavailable,
		"dependency_unavailable",
		"Hệ thống đang bận, vui lòng thử lại.",
		ProblemExtra{RetryAfter: &retry},
	)
	return true
}

// EnforceBodyLimit đọc trước tối đa `limit.Bytes + 1` byte từ `r.Body` bất kể có `Content-Length`
// hay không (kể cả chunked / unknown length):
//   - Nếu lỗi đọc thông thường -> ghi `400 invalid_request`.
//   - Nếu số byte đọc được > `limit.Bytes` -> ghi `413` với mã `limit.Code` (mặc định `invalid_request`),
//     không tạo claim và không ghi DB.
//   - Nếu không vượt -> đặt lại đúng các byte đã đọc vào `r.Body` để `Idempotency.Lookup` và handler
//     đọc nguyên vẹn (fingerprint khớp đúng body gốc).
//
// Nếu `limit.Bytes <= 0`, trả về `next` nguyên trạng (giữ nguyên hành vi P03).
func EnforceBodyLimit(limit IdempotencyBodyLimit) func(http.Handler) http.Handler {
	if limit.Bytes <= 0 {
		return func(next http.Handler) http.Handler { return next }
	}
	code := limit.Code
	if code == "" {
		code = "invalid_request"
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil && r.Body != http.NoBody {
				bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, limit.Bytes+1))
				if err != nil {
					WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Không đọc được nội dung.")
					return
				}
				if int64(len(bodyBytes)) > limit.Bytes {
					WriteProblem(w, r, http.StatusRequestEntityTooLarge, code, "Nội dung quá lớn.")
					return
				}
				_ = r.Body.Close()
				r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireVersionIfMatch là middleware bước 5 cho các route content P04 có `If-Match`:
// sau khi `RequireIfMatch` tách strong ETag, kiểm tra thêm tag phải là số nguyên dương
// thập phân hợp lệ theo `ParseVersionIfMatch` (nếu sai dạng như `"01"`, `"abc"`, `"vk:...:1"`
// thì trả ngay `428 precondition_required` trước khi `Idempotency.Claim` tạo bản ghi).
func RequireVersionIfMatch(next http.Handler) http.Handler {
	return RequireIfMatch(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tag, ok := IfMatchFrom(r.Context())
		if !ok {
			WriteProblem(w, r, http.StatusPreconditionRequired, "precondition_required", "Thiếu hoặc sai định dạng If-Match.")
			return
		}
		if _, ok := ParseVersionIfMatch(tag); !ok {
			WriteProblem(w, r, http.StatusPreconditionRequired, "precondition_required", "Thiếu hoặc sai định dạng If-Match.")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

// IdempotencyRouteConfig cấu hình chuỗi middleware 8 bước của mục 2.3 cho một route có idempotency.
type IdempotencyRouteConfig struct {
	AppOrigin        string
	Authenticator    Authenticator
	CSRF             CSRFVerifier
	Idempotency      *Idempotency
	Reauth           ReauthVerifier
	ReauthAction     string                          // rỗng nếu route không yêu cầu A (ví dụ POST /vault)
	RateLimit        func(http.Handler) http.Handler // nil nếu route không gắn R
	RequireIfMatch   bool                            // true nếu route yêu cầu M
	AllowEmptyDelete bool                            // true cho DELETE không có body (bỏ qua RequireJSONContent khi không có body)
	BodyLimit        IdempotencyBodyLimit            // trần đọc body trước Lookup (mục 2.3; rỗng giữ nguyên P03)
}

// ChainIdempotencyMiddleware ghép đúng thứ tự 8 bước của mục 2.3:
//  1. RequireOrigin -> RequireSession -> RequireCSRF -> RequireJSONContent (hoặc RequireJSONContentExceptEmptyDelete)
//     1b. EnforceBodyLimit (nếu BodyLimit.Bytes > 0, chặn trước Idempotency.Lookup theo P04 mục 2.3)
//  2. Idempotency.Lookup
//  3. RequireReauth(action) nếu có ReauthAction
//  4. RateLimit nếu khác nil
//  5. RequireIfMatch nếu bật (với route content có BodyLimit đặt, kiểm luôn định dạng version nguyên dương trước Claim)
//  6. Idempotency.Claim (kèm bước 8 Release trong defer)
//  7. Handler (chạy mutation trong tx và gọi FinishIdempotencyTx / CommitIdempotencyTx).
func ChainIdempotencyMiddleware(cfg IdempotencyRouteConfig, handler http.Handler) http.Handler {
	h := handler
	h = cfg.Idempotency.Claim(h)
	if cfg.RequireIfMatch {
		if cfg.BodyLimit.Bytes > 0 {
			h = RequireVersionIfMatch(h)
		} else {
			h = RequireIfMatch(h)
		}
	}
	if cfg.RateLimit != nil {
		h = cfg.RateLimit(h)
	}
	if cfg.ReauthAction != "" {
		h = RequireReauth(cfg.Reauth, cfg.ReauthAction)(h)
	}
	h = cfg.Idempotency.Lookup(h)
	if cfg.BodyLimit.Bytes > 0 {
		h = EnforceBodyLimit(cfg.BodyLimit)(h)
	}
	if cfg.AllowEmptyDelete {
		h = RequireJSONContentExceptEmptyDelete(h)
	} else {
		h = RequireJSONContent(h)
	}
	h = RequireCSRF(cfg.CSRF)(h)
	h = RequireSession(cfg.Authenticator)(h)
	h = RequireOrigin(cfg.AppOrigin)(h)
	return h
}

type idempotencyStatusRecorder struct {
	http.ResponseWriter
	code        int
	wroteHeader bool
}

func (r *idempotencyStatusRecorder) WriteHeader(statusCode int) {
	if !r.wroteHeader {
		r.code = statusCode
		r.wroteHeader = true
	}
	r.ResponseWriter.WriteHeader(statusCode)
}

func (r *idempotencyStatusRecorder) Write(b []byte) (int, error) {
	if !r.wroteHeader {
		r.code = http.StatusOK
		r.wroteHeader = true
	}
	return r.ResponseWriter.Write(b)
}

func (r *idempotencyStatusRecorder) statusCode() int {
	if !r.wroteHeader {
		return http.StatusOK
	}
	return r.code
}
