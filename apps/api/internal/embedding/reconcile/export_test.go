package reconcile

import (
	"context"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
)

// SetAfterOrphanScanHookForTest installs a barrier that runs after an unlocked
// orphan scan page and before the locked delete transaction, and removes it
// when the test ends.
func SetAfterOrphanScanHookForTest(t testing.TB, fn func(ctx context.Context, kind generation.Corpus)) {
	t.Helper()
	afterOrphanScanHook.Store(&fn)
	t.Cleanup(func() { afterOrphanScanHook.Store(nil) })
}
