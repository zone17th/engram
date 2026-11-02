package semantic

import (
	"context"
	"errors"
	"net/http"
	"sync"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

type requestScopeKey struct{}

// requestScope is a mutable, request-local carrier stored in context.Context
// under requestScopeKey. It caches at most one ActivePin resolution (along with
// the owning userID) across ActiveGeneration(ctx, userID) and Near(ctx, req)
// within a single logical request (RV-T12-BE-10, advisor-dec-290, dec-294).
//
// Privacy: holds only the user UUID and Pin metadata; never holds or logs q,
// names, vectors, keys, or URLs.
type requestScope struct {
	mu       sync.Mutex
	resolved bool
	userID   uuid.UUID
	pin      generation.Pin
	hasPin   bool
	err      error
}

// WithRequestScope returns a child context carrying a fresh request-local Pin
// resolution scope.
//
// WithRequestScope is intentionally NOT idempotent: every call installs a
// brand-new carrier so each logical request (even when derived from a shared
// parent context) gets its own isolated Pin slot. Child contexts derived from
// the returned context via context.WithValue, context.WithCancel, or
// context.WithTimeout automatically inherit the same carrier via ctx.Value.
//
// Callers that invoke ActiveGeneration(ctx, userID) followed by Near(ctx, req)
// (such as `/search` page 1) and require cursor.gen == response.generation
// consistency across a concurrent generation flip must install this scope on
// the request context (or route through RequestScopeMiddleware). Without a
// carrier in ctx, ActiveGeneration and Near fall back to reading ActivePin
// independently on each call.
func WithRequestScope(ctx context.Context) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, requestScopeKey{}, &requestScope{})
}

// RequestScopeMiddleware installs a fresh request-scoped Pin carrier on every
// incoming HTTP request context via WithRequestScope.
func RequestScopeMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(WithRequestScope(r.Context())))
	})
}

func requestScopeFromContext(ctx context.Context) *requestScope {
	if ctx == nil {
		return nil
	}
	scope, _ := ctx.Value(requestScopeKey{}).(*requestScope)
	return scope
}

// resolveOrReadPin resolves the active generation Pin for userID using the
// request-scoped carrier in ctx when present:
//   - With carrier: the first call for userID reads rt.readActivePin(ctx) once
//     and stores the outcome (including ErrNoActiveGeneration and lookup errors);
//     a subsequent call in the same request with the same non-Nil userID reuses
//     that exact resolution without calling ActivePin again. If userID does not
//     match the carrier's recorded userID (or userID == uuid.Nil), it does not
//     reuse or overwrite the carrier and instead reads fresh from rt.readActivePin(ctx).
//   - Without carrier: reads fresh from rt.readActivePin(ctx) on every call.
func (r *Runtime) resolveOrReadPin(ctx context.Context, userID uuid.UUID) (generation.Pin, bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	scope := requestScopeFromContext(ctx)
	if scope == nil || userID == uuid.Nil {
		return r.readPinOutcome(ctx)
	}

	scope.mu.Lock()
	if scope.resolved {
		if scope.userID == userID {
			pin, hasPin, err := scope.pin, scope.hasPin, scope.err
			scope.mu.Unlock()
			return pin, hasPin, err
		}
		scope.mu.Unlock()
		return r.readPinOutcome(ctx)
	}

	pin, hasPin, err := r.readPinOutcome(ctx)
	scope.resolved = true
	scope.userID = userID
	scope.pin = pin
	scope.hasPin = hasPin
	scope.err = err
	scope.mu.Unlock()
	return pin, hasPin, err
}

func (r *Runtime) readPinOutcome(ctx context.Context) (generation.Pin, bool, error) {
	pin, err := r.readActivePin(ctx)
	if err != nil {
		if errors.Is(err, generation.ErrNoActiveGeneration) {
			return generation.Pin{}, false, nil
		}
		return generation.Pin{}, false, err
	}
	return pin, true, nil
}
