package suggest

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type recordingTx struct {
	pgx.Tx
	stmts []string
}

func (r *recordingTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	r.stmts = append(r.stmts, sql)
	return pgconn.CommandTag{}, nil
}

func (r *recordingTx) Rollback(context.Context) error { return nil }

type recordingTxStarter struct {
	tx *recordingTx
}

func (s *recordingTxStarter) BeginTx(_ context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	s.tx = &recordingTx{}
	return s.tx, nil
}

func TestLexicalTxStatementsAndServiceKnob(t *testing.T) {
	t.Run("statements_include_force_custom_plan_when_on_and_omit_when_off", func(t *testing.T) {
		wantOn := []string{
			"SET LOCAL statement_timeout = '50ms'",
			"SET LOCAL pg_trgm.similarity_threshold = 0.35",
			"SET LOCAL pg_trgm.word_similarity_threshold = 0.5",
			"SET LOCAL plan_cache_mode = force_custom_plan",
		}
		gotOn := LexicalTxStatements(true, true)
		if !slices.Equal(gotOn, wantOn) {
			t.Fatalf("LexicalTxStatements(true, true) = %#v, want %#v", gotOn, wantOn)
		}

		wantOff := []string{
			"SET LOCAL statement_timeout = '50ms'",
			"SET LOCAL pg_trgm.similarity_threshold = 0.35",
			"SET LOCAL pg_trgm.word_similarity_threshold = 0.5",
		}
		gotOff := LexicalTxStatements(true, false)
		if !slices.Equal(gotOff, wantOff) {
			t.Fatalf("LexicalTxStatements(true, false) = %#v, want %#v", gotOff, wantOff)
		}
		for _, s := range gotOff {
			if strings.Contains(s, "plan_cache_mode") {
				t.Fatalf("expected no plan_cache_mode when off, got %#v", gotOff)
			}
		}

		wantRecent := []string{"SET LOCAL statement_timeout = '50ms'"}
		for _, force := range []bool{true, false} {
			if got := LexicalTxStatements(false, force); !slices.Equal(got, wantRecent) {
				t.Fatalf("LexicalTxStatements(false, %v) = %#v, want %#v", force, got, wantRecent)
			}
		}
	})

	t.Run("service_run_branch_executes_configured_set_locals", func(t *testing.T) {
		svc := NewService(nil, nil, nil, nil, nil)
		if !svc.LexicalForceCustomPlan() {
			t.Fatal("NewService must default LexicalForceCustomPlan to true")
		}
		starter := &recordingTxStarter{}
		svc.SetTxStarter(starter)

		partial, err := svc.runBranch(context.Background(), CorpusItem, ModeFull, ClassLexicalItemDB, true, func(context.Context, pgx.Tx) (string, error) {
			return "", nil
		})
		if partial || err != nil {
			t.Fatalf("runBranch on: partial=%v err=%v", partial, err)
		}
		if !slices.Contains(starter.tx.stmts, "SET LOCAL plan_cache_mode = force_custom_plan") {
			t.Fatalf("runBranch with default on missing force_custom_plan: %#v", starter.tx.stmts)
		}

		svc.SetLexicalForceCustomPlan(false)
		if svc.LexicalForceCustomPlan() {
			t.Fatal("SetLexicalForceCustomPlan(false) must disable force_custom_plan")
		}
		partial, err = svc.runBranch(context.Background(), CorpusItem, ModeFull, ClassLexicalItemDB, true, func(context.Context, pgx.Tx) (string, error) {
			return "", nil
		})
		if partial || err != nil {
			t.Fatalf("runBranch off: partial=%v err=%v", partial, err)
		}
		if slices.Contains(starter.tx.stmts, "SET LOCAL plan_cache_mode = force_custom_plan") {
			t.Fatalf("runBranch with off must omit force_custom_plan, got: %#v", starter.tx.stmts)
		}
	})
}
