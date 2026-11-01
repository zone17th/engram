package httpx

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/authctx"
	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
)

// Các scope giới hạn tốc độ theo người dùng (SPEC §9.1 / plan mục 2.4).
const (
	ScopeVaultRecoveryLookup   = "vault_recovery_lookup"
	ScopeVaultRecoveryComplete = "vault_recovery_complete"
	ScopeVaultPasskeyOptions   = "vault_passkey_options"
	ScopeVaultSensitive        = "vault_sensitive"

	// MaxRateLimitWindow là cửa sổ dài nhất của rate_event (phục vụ job prune).
	MaxRateLimitWindow = 15 * time.Minute
)

// RateLimitRule mô tả ngưỡng của một scope cửa sổ trượt.
type RateLimitRule struct {
	Limit  int
	Window time.Duration
}

// DefaultUserLimitRules là bảng giới hạn chuẩn của P03 mục 2.4.
func DefaultUserLimitRules() map[string]RateLimitRule {
	return map[string]RateLimitRule{
		ScopeVaultRecoveryLookup: {
			Limit:  5,
			Window: 15 * time.Minute,
		},
		ScopeVaultRecoveryComplete: {
			Limit:  5,
			Window: 15 * time.Minute,
		},
		ScopeVaultPasskeyOptions: {
			Limit:  20,
			Window: time.Minute,
		},
		ScopeVaultSensitive: {
			Limit:  10,
			Window: time.Minute,
		},
	}
}

// UserLimiter kiểm tra giới hạn tốc độ theo user_id với cửa sổ trượt trên bảng rate_event.
// Mọi kiểm tra đều giữ pg_advisory_xact_lock(hashtext(scope), hashtext(user_id)) trong cùng
// transaction đếm + ghi để nhiều instance song song hoặc đổi IP không thể vượt ngưỡng.
type UserLimiter struct {
	pool  *pgxpool.Pool
	clk   clock.Clock
	rules map[string]RateLimitRule
}

// NewUserLimiter khởi tạo UserLimiter với bảng quy tắc mặc định mục 2.4.
func NewUserLimiter(pool *pgxpool.Pool, clk clock.Clock) *UserLimiter {
	return NewUserLimiterWithRules(pool, clk, DefaultUserLimitRules())
}

// NewUserLimiterWithRules khởi tạo UserLimiter với tập quy tắc tuỳ chỉnh (dùng chung định dạng mục 2.4).
func NewUserLimiterWithRules(pool *pgxpool.Pool, clk clock.Clock, rules map[string]RateLimitRule) *UserLimiter {
	if clk == nil {
		clk = clock.System{}
	}
	copied := make(map[string]RateLimitRule, len(rules))
	for k, v := range rules {
		copied[k] = v
	}
	return &UserLimiter{
		pool:  pool,
		clk:   clk,
		rules: copied,
	}
}

// Rule trả quy tắc của một scope.
func (l *UserLimiter) Rule(scope string) (RateLimitRule, bool) {
	if l == nil {
		return RateLimitRule{}, false
	}
	r, ok := l.rules[scope]
	return r, ok
}

// Allow kiểm tra và ghi nhận một sự kiện trong scope cho userID.
// Nếu bị chặn (count >= limit trong cửa sổ (now - window, now]), hàm KHÔNG ghi thêm rate_event
// và trả ok=false kèm số giây Retry-After (>= 1).
func (l *UserLimiter) Allow(ctx context.Context, scope string, userID uuid.UUID) (ok bool, retryAfter int, err error) {
	if l == nil || l.pool == nil {
		return false, 0, fmt.Errorf("user limiter chưa khởi tạo pool")
	}
	if userID == uuid.Nil {
		return false, 0, fmt.Errorf("user_id rỗng")
	}
	rule, exists := l.rules[scope]
	if !exists || rule.Limit <= 0 || rule.Window <= 0 {
		return false, 0, fmt.Errorf("scope rate limit không hợp lệ: %q", scope)
	}

	tx, err := l.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, 0, err
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	q := gen.New(tx)
	if err := q.AcquireRateLimitLock(ctx, gen.AcquireRateLimitLockParams{
		Scope:  scope,
		UserID: userID,
	}); err != nil {
		return false, 0, err
	}

	now := l.clk.Now().UTC()
	since := now.Add(-rule.Window)
	sinceTS := pgtype.Timestamptz{Time: since, Valid: true}
	nowTS := pgtype.Timestamptz{Time: now, Valid: true}
	count, err := q.CountRateEventsSince(ctx, gen.CountRateEventsSinceParams{
		Scope:  scope,
		UserID: userID,
		Since:  sinceTS,
	})
	if err != nil {
		return false, 0, err
	}

	if int(count) >= rule.Limit {
		retry := int(math.Ceil(rule.Window.Seconds()))
		oldest, err := q.GetOldestRateEventSince(ctx, gen.GetOldestRateEventSinceParams{
			Scope:  scope,
			UserID: userID,
			Since:  sinceTS,
		})
		if err == nil && oldest.Valid {
			rem := oldest.Time.Add(rule.Window).Sub(now)
			if rem > 0 {
				retry = int(math.Ceil(rem.Seconds()))
			} else {
				retry = 1
			}
		}
		if retry < 1 {
			retry = 1
		}
		// Không ghi thêm rate_event khi bị chặn.
		if err := tx.Commit(ctx); err != nil {
			return false, 0, err
		}
		return false, retry, nil
	}

	if _, err := q.InsertRateEvent(ctx, gen.InsertRateEventParams{
		Scope:  scope,
		UserID: userID,
		At:     nowTS,
	}); err != nil {
		return false, 0, err
	}

	if err := tx.Commit(ctx); err != nil {
		return false, 0, err
	}
	return true, 0, nil
}

// Check lấy user_id từ authctx.Principal của request rồi kiểm tra giới hạn tốc độ cho scope.
// Trả true nếu được phép đi tiếp; trả false nếu đã ghi response lỗi (401/429/500).
// Thông điệp 429 cố định, không bao giờ tiết lộ số RK còn lại hay trạng thái passphrase.
func (l *UserLimiter) Check(w http.ResponseWriter, r *http.Request, scope string) bool {
	if l == nil || l.pool == nil {
		WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ chưa sẵn sàng.")
		return false
	}
	p, ok := authctx.PrincipalFrom(r.Context())
	if !ok || p.UserID == uuid.Nil {
		WriteProblem(w, r, http.StatusUnauthorized, "unauthenticated", "Cần đăng nhập.")
		return false
	}
	allowed, retry, err := l.Allow(r.Context(), scope, p.UserID)
	if err != nil {
		WriteProblem(w, r, http.StatusInternalServerError, "internal_error", "Máy chủ chưa sẵn sàng.")
		return false
	}
	if !allowed {
		WriteProblemExtra(w, r, http.StatusTooManyRequests, "rate_limited", "Quá nhiều yêu cầu.", ProblemExtra{RetryAfter: &retry})
		return false
	}
	return true
}

// Middleware trả middleware giới hạn tốc độ theo user cho scope đã chọn.
// Đặt sau bước replay idempotency và sau RequireReauth (plan mục 2.3 bước 4).
func (l *UserLimiter) Middleware(scope string) func(http.Handler) http.Handler {
	return LimitUser(l, scope)
}

// LimitUser gắn giới hạn tốc độ theo user_id (từ authctx.Principal) cho một scope.
// Fail-closed nếu limiter chưa khởi tạo hoặc thiếu principal.
func LimitUser(l *UserLimiter, scope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !l.Check(w, r, scope) {
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
