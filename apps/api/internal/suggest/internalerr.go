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
	// ClassSearchInternal: /search returned its static ErrSearchInternal
	// (primary-corpus timeout or active-generation lookup failure, dec-287).
	ClassSearchInternal = "search_internal"
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

// classifyBranchErr decides what a failed step of a lexical branch means. It looks at
// the contexts first and the error shape last, because the error pgx produces when
// the 50 ms branch budget fires is not stable: besides context.DeadlineExceeded and
// SQLSTATE 57014 it can be a wrapped conn-busy/closed error, a deadline from the
// socket (os.ErrDeadlineExceeded), or a Begin/Acquire failure (FU-SB-1).
//
//   - parent ctx ended (client disconnect or request deadline): not a branch
//     timeout, never partial. A cancel is returned as the context error so the
//     handler logs nothing; a deadline becomes ClassRequestContext.
//   - branchCtx ended while the parent is alive, or err is a recognised timeout
//     shape (57014, DeadlineExceeded): the branch budget fired -> partial.
//   - anything else is a genuine error of `class`.
func classifyBranchErr(parent, branch context.Context, err error, corpus, mode, class string) (partial bool, out error) {
	if perr := parent.Err(); perr != nil {
		if errors.Is(perr, context.Canceled) {
			return false, fmt.Errorf("suggest: request canceled: %w", perr)
		}
		return false, newInternalError(ClassRequestContext, corpus, mode, perr)
	}
	if branch.Err() != nil || isBranchTimeout(err) {
		return true, nil
	}
	return false, newInternalError(class, corpus, mode, err)
}
