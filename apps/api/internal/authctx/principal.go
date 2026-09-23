// Package authctx giữ principal dùng chung — không token, email hay trạng thái vault.
package authctx

import (
	"context"

	"github.com/google/uuid"
)

// Principal định danh user + session đã xác minh ở DB.
type Principal struct {
	UserID    uuid.UUID
	SessionID uuid.UUID
}

type ctxKey int

const principalKey ctxKey = iota

// WithPrincipal gắn principal vào context.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey, p)
}

// PrincipalFrom lấy principal; ok=false nếu chưa qua RequireSession.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey).(Principal)
	return p, ok
}
