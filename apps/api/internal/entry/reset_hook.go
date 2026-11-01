package entry

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
)

type resetHookStepKey struct{}

// ResetHookStep identifies a lock/mutation step inside ResetHook for deterministic barrier tests (Task 8).
type ResetHookStep string

const (
	// ResetHookStepAfterUserContentLock fires immediately after LockUserContent(user_id) is acquired.
	ResetHookStepAfterUserContentLock ResetHookStep = "after_user_content_lock"
	// ResetHookStepAfterItemsLocked fires immediately after LockAllItemsOfUserForUpdate(user_id) completes.
	ResetHookStepAfterItemsLocked ResetHookStep = "after_items_locked"
	// ResetHookStepAfterEntriesDeleted fires immediately after DeleteEntriesByUser(user_id) completes.
	ResetHookStepAfterEntriesDeleted ResetHookStep = "after_entries_deleted"
	// ResetHookStepAfterCountsZeroed fires immediately after ZeroEntryCountByUser(user_id) completes.
	ResetHookStepAfterCountsZeroed ResetHookStep = "after_counts_zeroed"
)

// WithResetHookStepCallback attaches a test-only callback to ctx that is invoked at each step of ResetHook.
// In production no callback is present in ctx, making it a zero-cost no-op.
func WithResetHookStepCallback(ctx context.Context, fn func(ctx context.Context, userID uuid.UUID, step ResetHookStep) error) context.Context {
	return context.WithValue(ctx, resetHookStepKey{}, fn)
}

func runResetHookStepCallback(ctx context.Context, userID uuid.UUID, step ResetHookStep) error {
	if fn, ok := ctx.Value(resetHookStepKey{}).(func(ctx context.Context, userID uuid.UUID, step ResetHookStep) error); ok && fn != nil {
		return fn(ctx, userID, step)
	}
	return nil
}

// ResetHook implements vault.ResetHook for P04 (plan mục 1, 2.5, 2.8, 7, Task 8; closes carry-forward T12-P04 on the server side).
//
// It runs inside Service.Reset's transaction after the user's vault row is locked FOR UPDATE (step 1 of the global lock order):
//  1. LockUserContent(userID) — per-user advisory xact lock ('engram.content', userID) (step 2).
//  2. LockAllItemsOfUserForUpdate(userID) — locks all item rows of the user ordered by id ASC (step 3).
//  3. DeleteEntriesByUser(userID) — hard-deletes all entry rows of the user, including soft-deleted tombstones (step 5).
//  4. ZeroEntryCountByUser(userID) — sets entry_count = 0 on any item of the user with a non-zero count.
//
// Item, tag, item_tag, tag.item_count, and content idempotency_key rows are preserved.
// Any error returned by ResetHook aborts and rolls back the entire vault reset transaction.
func ResetHook(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
	q := gen.New(tx)

	if err := q.LockUserContent(ctx, userID); err != nil {
		return err
	}
	if err := runResetHookStepCallback(ctx, userID, ResetHookStepAfterUserContentLock); err != nil {
		return err
	}

	if _, err := q.LockAllItemsOfUserForUpdate(ctx, userID); err != nil {
		return err
	}
	if err := runResetHookStepCallback(ctx, userID, ResetHookStepAfterItemsLocked); err != nil {
		return err
	}

	if _, err := q.DeleteEntriesByUser(ctx, userID); err != nil {
		return err
	}
	if err := runResetHookStepCallback(ctx, userID, ResetHookStepAfterEntriesDeleted); err != nil {
		return err
	}

	if _, err := q.ZeroEntryCountByUser(ctx, userID); err != nil {
		return err
	}
	return runResetHookStepCallback(ctx, userID, ResetHookStepAfterCountsZeroed)
}
