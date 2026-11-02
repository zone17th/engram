package suggest

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// RV-SB1-BE-1: deterministic tests of classifyBranchErr. No database, no sleeps: the
// contexts are controlled so the cancel lands exactly between the reads.

// flipCtx is a context whose Err() runs onErr after reading the wrapped context. It lets a
// test cancel the parent at an exact point of the classifier (between two reads).
type flipCtx struct {
	context.Context
	onErr func()
}

func (c flipCtx) Err() error {
	err := c.Context.Err()
	if c.onErr != nil {
		c.onErr()
	}
	return err
}

// expiredCtx returns a context whose own deadline has already passed (DeadlineExceeded).
func expiredCtx(t *testing.T, parent context.Context) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(parent, 0)
	t.Cleanup(cancel)
	<-ctx.Done()
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("expiredCtx Err = %v, want DeadlineExceeded", ctx.Err())
	}
	return ctx
}

var opaqueErr = fmt.Errorf("conn busy: %v", errors.New("opaque driver state"))

func pgTimeout() error {
	return fmt.Errorf("query: %w", &pgconn.PgError{Code: "57014", Message: "canceling statement due to statement timeout"})
}

func wantCanceled(t *testing.T, partial bool, out error) {
	t.Helper()
	if partial {
		t.Fatalf("partial = true, want false (the request was canceled)")
	}
	if !errors.Is(out, context.Canceled) {
		t.Fatalf("out = %v, want a context.Canceled error", out)
	}
	var ie *InternalError
	if errors.As(out, &ie) {
		t.Fatalf("a client cancel must not be an *InternalError (it would be logged): %v", out)
	}
}

func TestClassifyBranchErrParentCancelBetweenReadsWins(t *testing.T) {
	// The branch ran out of its own budget; the parent is canceled right after the branch
	// state is read. The old order (parent first, then branch) saw an alive parent and an
	// expired branch -> partial. The parent must win.
	for _, err := range []error{opaqueErr, pgTimeout(), context.DeadlineExceeded} {
		parent, cancel := context.WithCancel(context.Background())
		branch := flipCtx{Context: expiredCtx(t, parent), onErr: cancel}
		partial, out := classifyBranchErr(parent, branch, err, CorpusItem, ModeFull, ClassLexicalItemDB)
		wantCanceled(t, partial, out)
		cancel()
	}
}

func TestClassifyBranchErrParentCancelWithPG57014(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	cancel()
	// A 57014 that PostgreSQL returns while the client is gone is not a branch timeout.
	partial, out := classifyBranchErr(parent, context.Background(), pgTimeout(), CorpusTag, ModePrefix, ClassLexicalTagDB)
	wantCanceled(t, partial, out)

	// The child ctx canceled by the parent's cancel, with a recognised shape.
	child, cancelChild := context.WithCancel(parent)
	defer cancelChild()
	partial, out = classifyBranchErr(parent, child, pgTimeout(), CorpusTag, ModePrefix, ClassLexicalTagDB)
	wantCanceled(t, partial, out)
}

func TestClassifyBranchErrParentDeadlineIsRequestContext(t *testing.T) {
	parent := expiredCtx(t, context.Background())
	// The branch inherits the parent deadline (so branch.Err() is DeadlineExceeded too).
	branch, cancel := context.WithTimeout(parent, BranchTimeout)
	defer cancel()
	for _, err := range []error{opaqueErr, pgTimeout(), context.DeadlineExceeded} {
		partial, out := classifyBranchErr(parent, branch, err, CorpusItem, ModeFull, ClassLexicalItemDB)
		if partial {
			t.Fatalf("err %v: partial = true, want false (the request deadline fired)", err)
		}
		var ie *InternalError
		if !errors.As(out, &ie) || ie.Class != ClassRequestContext || ie.Corpus != CorpusItem || ie.Mode != ModeFull {
			t.Fatalf("err %v: out = %#v, want *InternalError class %s", err, out, ClassRequestContext)
		}
		if errors.Is(out, context.Canceled) {
			t.Fatalf("a deadline is not a client cancel: %v", out)
		}
	}
}

func TestClassifyBranchErrOwnBudgetWithLiveParentIsPartial(t *testing.T) {
	parent := context.Background()
	branch := expiredCtx(t, parent)
	for _, err := range []error{opaqueErr, os.ErrDeadlineExceeded, nil} {
		partial, out := classifyBranchErr(parent, branch, err, CorpusItem, ModeFull, ClassLexicalItemDB)
		if !partial || out != nil {
			t.Fatalf("err %v: (partial, out) = (%v, %v), want (true, nil)", err, partial, out)
		}
	}
}

func TestClassifyBranchErrRecognisedShapeWithLiveParentIsPartial(t *testing.T) {
	parent := context.Background()
	branch, cancel := context.WithCancel(parent)
	defer cancel() // branch ctx alive: only the error shape says "budget"
	for _, err := range []error{
		pgTimeout(),
		fmt.Errorf("begin: %w", context.DeadlineExceeded),
	} {
		partial, out := classifyBranchErr(parent, branch, err, CorpusTag, ModeFull, ClassLexicalTagDB)
		if !partial || out != nil {
			t.Fatalf("err %v: (partial, out) = (%v, %v), want (true, nil)", err, partial, out)
		}
	}
}

func TestClassifyBranchErrChildCanceledWithLiveParentIsNotPartial(t *testing.T) {
	parent := context.Background()
	branch, cancel := context.WithCancel(parent)
	cancel() // the branch ctx is canceled but NOT by its own budget and not by the parent
	if !errors.Is(branch.Err(), context.Canceled) {
		t.Fatalf("branch.Err = %v", branch.Err())
	}
	partial, out := classifyBranchErr(parent, branch, fmt.Errorf("x: %w", context.Canceled), CorpusItem, ModeFull, ClassLexicalItemDB)
	if partial {
		t.Fatalf("a child context.Canceled with a live parent must not be a branch timeout")
	}
	var ie *InternalError
	if !errors.As(out, &ie) || ie.Class != ClassLexicalItemDB {
		t.Fatalf("out = %#v, want genuine *InternalError class %s", out, ClassLexicalItemDB)
	}
}

func TestClassifyBranchErrGenuineErrorKeepsClassAndSQLState(t *testing.T) {
	parent := context.Background()
	branch, cancel := context.WithCancel(parent)
	defer cancel()
	cause := &pgconn.PgError{Code: "22012", Message: "division by zero SecretParam"}
	partial, out := classifyBranchErr(parent, branch, cause, CorpusItem, ModeRecent, ClassLexicalItemTagRefs)
	if partial {
		t.Fatalf("a genuine error must not be partial")
	}
	var ie *InternalError
	if !errors.As(out, &ie) {
		t.Fatalf("out = %v, want *InternalError", out)
	}
	if ie.Class != ClassLexicalItemTagRefs || ie.Corpus != CorpusItem || ie.Mode != ModeRecent || ie.PGCode != "22012" {
		t.Fatalf("InternalError = %#v", ie)
	}
	if got := out.Error(); got != "suggest: internal error: "+ClassLexicalItemTagRefs {
		t.Fatalf("Error() = %q, must not embed the cause text", got)
	}
	if !errors.Is(out, cause) {
		t.Fatalf("the cause must stay reachable through Unwrap")
	}
}
