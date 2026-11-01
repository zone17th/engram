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

	idempotencyStateKey ctxKey = iota + 200
)

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
}

// ChainIdempotencyMiddleware ghép đúng thứ tự 8 bước của mục 2.3:
//  1. RequireOrigin -> RequireSession -> RequireCSRF -> RequireJSONContent (hoặc RequireJSONContentExceptEmptyDelete)
//  2. Idempotency.Lookup
//  3. RequireReauth(action) nếu có ReauthAction
//  4. RateLimit nếu khác nil
//  5. RequireIfMatch nếu bật
//  6. Idempotency.Claim (kèm bước 8 Release trong defer)
//  7. Handler (chạy mutation trong tx và gọi FinishIdempotencyTx / CommitIdempotencyTx).
func ChainIdempotencyMiddleware(cfg IdempotencyRouteConfig, handler http.Handler) http.Handler {
	h := handler
	h = cfg.Idempotency.Claim(h)
	if cfg.RequireIfMatch {
		h = RequireIfMatch(h)
	}
	if cfg.RateLimit != nil {
		h = cfg.RateLimit(h)
	}
	if cfg.ReauthAction != "" {
		h = RequireReauth(cfg.Reauth, cfg.ReauthAction)(h)
	}
	h = cfg.Idempotency.Lookup(h)
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
