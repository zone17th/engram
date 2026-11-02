package httpx

import (
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
)

// Các hằng chuẩn cho scope `search_read` (SPEC §9.1, plan P05 mục 2.6, Task 3).
const (
	ScopeSearchRead = "search_read"

	DefaultSearchReadCapacity   = 40
	DefaultSearchReadRefillRate = 20.0
	DefaultTokenBucketMaxKeys   = 100_000
)

type tokenBucketEntry struct {
	tokens float64
	last   time.Time
}

// TokenBucket là bộ giới hạn tốc độ token bucket in-memory theo user_id (hoặc key chuỗi),
// có trần số lượng key và cơ chế dọn dẹp giống FixedWindow (plan P05 mục 2.6).
// Không dùng rate_event trong DB (tránh 1 INSERT + advisory lock trên mỗi phím gõ)
// và không dùng golang.org/x/time.
type TokenBucket struct {
	mu       sync.Mutex
	buckets  map[string]tokenBucketEntry
	capacity float64
	rate     float64 // số token nạp mỗi giây
	maxKeys  int
	now      func() time.Time
}

// NewSearchReadBucket khởi tạo TokenBucket chuẩn cho scope `search_read`
// (dung lượng 40, nạp 20 token/giây, trần 100 000 key).
func NewSearchReadBucket(clk clock.Clock) *TokenBucket {
	return NewTokenBucket(DefaultSearchReadCapacity, DefaultSearchReadRefillRate, clk)
}

// NewTokenBucket khởi tạo TokenBucket với dung lượng `capacity` và tốc độ nạp `refillPerSec`.
func NewTokenBucket(capacity int, refillPerSec float64, clk clock.Clock) *TokenBucket {
	return NewTokenBucketWithCap(capacity, refillPerSec, DefaultTokenBucketMaxKeys, clk)
}

// NewTokenBucketWithCap khởi tạo TokenBucket với trần số lượng key `maxKeys` tuỳ chỉnh (phục vụ test).
func NewTokenBucketWithCap(capacity int, refillPerSec float64, maxKeys int, clk clock.Clock) *TokenBucket {
	if capacity <= 0 {
		capacity = DefaultSearchReadCapacity
	}
	if refillPerSec <= 0 {
		refillPerSec = DefaultSearchReadRefillRate
	}
	if maxKeys <= 0 {
		maxKeys = DefaultTokenBucketMaxKeys
	}
	nowFn := time.Now
	if clk != nil {
		nowFn = clk.Now
	}
	return &TokenBucket{
		buckets:  make(map[string]tokenBucketEntry),
		capacity: float64(capacity),
		rate:     refillPerSec,
		maxKeys:  maxKeys,
		now:      nowFn,
	}
}

// Len trả số lượng key hiện đang lưu trong bộ nhớ (phục vụ test kiểm tra eviction).
func (b *TokenBucket) Len() int {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.buckets)
}

// AllowUser kiểm tra và tiêu thụ 1 token cho `userID`.
func (b *TokenBucket) AllowUser(userID uuid.UUID) (ok bool, retryAfter int) {
	if userID == uuid.Nil {
		return false, 1
	}
	return b.Allow(userID.String())
}

// Allow kiểm tra và tiêu thụ 1 token cho `key`.
// Nếu hết token, trả `ok=false` kèm `retryAfter >= 1` (số giây nguyên làm tròn lên
// để nạp đủ ít nhất 1 token).
func (b *TokenBucket) Allow(key string) (ok bool, retryAfter int) {
	if b == nil {
		return false, 1
	}
	b.mu.Lock()
	defer b.mu.Unlock()

	now := b.now()
	entry, exists := b.buckets[key]
	if !exists {
		if len(b.buckets) >= b.maxKeys {
			b.evict(now)
		}
		entry = tokenBucketEntry{
			tokens: b.capacity,
			last:   now,
		}
	} else {
		elapsed := now.Sub(entry.last).Seconds()
		if elapsed > 0 {
			entry.tokens = math.Min(b.capacity, entry.tokens+elapsed*b.rate)
			entry.last = now
		}
	}

	if entry.tokens >= 1.0 {
		entry.tokens -= 1.0
		b.buckets[key] = entry
		return true, 0
	}

	b.buckets[key] = entry
	deficit := 1.0 - entry.tokens
	waitSec := int(math.Ceil(deficit / b.rate))
	if waitSec < 1 {
		waitSec = 1
	}
	return false, waitSec
}

// evict xoá các bucket đã nạp đầy ở thời điểm `now`. Nếu sau khi xoá các bucket đầy
// mà map vẫn đạt trần `maxKeys`, hàm xoá các mục cũ nhất cho tới khi dưới trần để
// đảm bảo tổng số key không bao giờ vượt `maxKeys`.
func (b *TokenBucket) evict(now time.Time) {
	fullAfter := time.Duration(float64(time.Second) * (b.capacity / b.rate))
	for k, e := range b.buckets {
		elapsed := now.Sub(e.last)
		if elapsed >= fullAfter || e.tokens+elapsed.Seconds()*b.rate >= b.capacity {
			delete(b.buckets, k)
		}
	}
	for len(b.buckets) >= b.maxKeys {
		var oldestKey string
		var oldestTime time.Time
		first := true
		for k, e := range b.buckets {
			if first || e.last.Before(oldestTime) {
				oldestKey = k
				oldestTime = e.last
				first = false
			}
		}
		if first {
			break
		}
		delete(b.buckets, oldestKey)
	}
}

// Check lấy `user_id` từ `authctx.Principal` (đặt sau `RequireSession`) rồi tiêu thụ 1 token.
// Request bị chặn ở bước xác thực trước đó không bao giờ đi vào đây và không tốn token.
func (b *TokenBucket) Check(w http.ResponseWriter, r *http.Request) bool {
	if b == nil {
		WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ chưa sẵn sàng.")
		return false
	}
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok || p.UserID == uuid.Nil {
		WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return false
	}
	allowed, retry := b.AllowUser(p.UserID)
	if !allowed {
		WriteProblemExtra(w, r, http.StatusTooManyRequests, "rate_limited", "Quá nhiều yêu cầu.", ProblemExtra{RetryAfter: &retry})
		return false
	}
	return true
}

// Middleware trả về HTTP middleware áp giới hạn token bucket theo `user_id` (scope `search_read`).
// Phải đặt SAU `RequireSession` để request chưa xác thực không tiêu tốn token.
func (b *TokenBucket) Middleware() func(http.Handler) http.Handler {
	return LimitSearchRead(b)
}

// LimitSearchRead gắn middleware token bucket scope `search_read` theo `user_id` từ `authctx.Principal`.
func LimitSearchRead(b *TokenBucket) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !b.Check(w, r) {
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
