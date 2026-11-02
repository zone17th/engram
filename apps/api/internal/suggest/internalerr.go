package suggest

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
)

// error_class values logged by the handler for a genuine server error on
// `/suggest` and `/search` (FU-SB-1, dec-268). The set is fixed and bounded: a
// class never carries user input, SQL text, or an err.Error() string.
const (
	// ClassLexicalItemDB: non-timeout failure on the lexical item branch
	// (BeginTx, SET LOCAL, the item query).
	ClassLexicalItemDB = "lexical_item_db"
	// ClassLexicalItemTagRefs: non-timeout failure loading the tag chips of item rows.
	ClassLexicalItemTagRefs = "lexical_item_tagrefs"
	// ClassLexicalTagDB: non-timeout failure on the lexical tag branch.
	ClassLexicalTagDB = "lexical_tag_db"
	// ClassNearSource: NearSource.Near returned an error.
	ClassNearSource = "near_source"
	// ClassRequestContext: the request context ended with a deadline (not a
	// client cancel) before or while a branch ran.
	ClassRequestContext = "request_context"
	// ClassSearchPrimaryTimeout: the 50 ms budget fired on the PRIMARY paged corpus of
	// /search (advisor-dec-287). The response is the static 500; the handler logs it once.
	ClassSearchPrimaryTimeout = "search_primary_timeout"
	// ClassGenerationLookup: NearSource.ActiveGeneration failed on /search. Marker only, never
	// logged by the handler: the NearSource owns that log (the semantic source emits
	// active_generation_lookup_failed before returning the error), so logging it here too would
	// emit two WARN lines for one failure. The response is still the static 500.
	ClassGenerationLookup = "generation_lookup"
	// ClassUnclassified: any other non-domain error that reached the handler
	// (for example cursor encoding).
	ClassUnclassified = "unclassified"
)

// InternalError is a genuine (non-timeout, non-client-cancel) server error from
// the lexical or near path. Error() never embeds the cause text because a pgx
// error string may contain SQL parameters (the query); the cause stays reachable
// through Unwrap for errors.Is / errors.As only. Corpus, Mode, Scope are fixed
// enums and PGCode is a SQLSTATE; all four may be empty.
type InternalError struct {
	Class  string
	Corpus string
	Mode   string
	Scope  string
	PGCode string
	cause  error
}

func (e *InternalError) Error() string { return "suggest: internal error: " + e.Class }

func (e *InternalError) Unwrap() error { return e.cause }

func newInternalError(class, corpus, mode string, cause error) *InternalError {
	return &InternalError{Class: class, Corpus: corpus, Mode: mode, PGCode: sqlState(cause), cause: cause}
}

// withScope sets the effective scope (and mode if unset) on an *InternalError so the
// handler can log it; any other error is returned untouched.
func withScope(err error, scope, mode string) error {
	var ie *InternalError
	if errors.As(err, &ie) {
		if ie.Scope == "" {
			ie.Scope = scope
		}
		if ie.Mode == "" {
			ie.Mode = mode
		}
	}
	return err
}

// sqlState returns the 5-character SQLSTATE of a pgx server error, or "".
func sqlState(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && len(pgErr.Code) == 5 {
		return pgErr.Code
	}
	return ""
}

// parentDoneErr reports the request context ending: a cancel (client disconnect) is returned
// as the wrapped context error so the handler logs nothing, a deadline becomes
// ClassRequestContext. It returns nil while the request context is alive.
func parentDoneErr(parent context.Context, corpus, mode string) error {
	perr := parent.Err()
	if perr == nil {
		return nil
	}
	if errors.Is(perr, context.Canceled) {
		return fmt.Errorf("suggest: request canceled: %w", perr)
	}
	return newInternalError(ClassRequestContext, corpus, mode, perr)
}

// classifyBranchErr decides what a failed step of a lexical branch means. It looks at
// the contexts first and the error shape last, because the error pgx produces when
// the 50 ms branch budget fires is not stable: besides context.DeadlineExceeded and
// SQLSTATE 57014 it can be a wrapped conn-busy/closed error, a deadline from the
// socket (os.ErrDeadlineExceeded), or a Begin/Acquire failure (FU-SB-1).
//
// Order matters (RV-SB1-BE-1). The branch state and the error shape are snapshotted
// FIRST and the parent is read LAST, because a derived context is canceled by its parent:
// if the parent were read first, a cancel arriving between the two reads would make the
// branch look expired while the parent looked alive. Reading the parent last means a parent
// that is done at any point up to that read wins.
//
//   - parent ctx ended (client disconnect or request deadline): never partial. A cancel is
//     returned as the context error so the handler logs nothing; a deadline becomes
//     ClassRequestContext.
//   - the branch ran out of its OWN budget (branch.Err() == context.DeadlineExceeded) or err
//     is a recognised timeout shape (57014, DeadlineExceeded) while the parent is alive:
//     partial. A child context.Canceled is NOT a branch timeout: the branch ctx is only
//     canceled by its parent or by its own deferred cancel, never by the budget.
//   - anything else is a genuine error of `class`.
func classifyBranchErr(parent, branch context.Context, err error, corpus, mode, class string) (partial bool, out error) {
	ownBudget := branch.Err() == context.DeadlineExceeded
	recognised := isBranchTimeout(err)
	if perr := parentDoneErr(parent, corpus, mode); perr != nil {
		return false, perr
	}
	if ownBudget || recognised {
		return true, nil
	}
	return false, newInternalError(class, corpus, mode, err)
}
