package main

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/jobs/exportcleanup"
)

// TestAdminRequiresConfirm: missing --confirm, missing --email, invalid email,
// extra positional args or an unknown subcommand exits 2 before touching the DB;
// --help exits 0.
func TestAdminRequiresConfirm(t *testing.T) {
	ctx := context.Background()
	t.Setenv("DATABASE_URL", "postgres://invalid-never-dialed:1/nope")

	var out, errOut bytes.Buffer
	if code := run(ctx, []string{"--help"}, &out, &errOut); code != 0 {
		t.Fatalf("--help code = %d, stderr=%s", code, errOut.String())
	}

	cases := [][]string{
		{},
		{"unknown"},
		{"account-delete"},
		{"account-delete", "--email", "u@example.com"},
		{"account-delete", "--confirm"},
		{"account-delete", "--email", "not-an-email", "--confirm"},
		{"account-delete", "--email", "u@example.com", "--confirm", "extra"},
	}
	for _, argv := range cases {
		out.Reset()
		errOut.Reset()
		if code := run(ctx, argv, &out, &errOut); code != 2 {
			t.Fatalf("argv %v code = %d, want 2 (stdout=%q stderr=%q)", argv, code, out.String(), errOut.String())
		}
		if out.Len() != 0 {
			t.Fatalf("argv %v wrote stdout %q", argv, out.String())
		}
	}
}

// TestAdminDeleteAccountByEmail runs the CLI subcommand against a migrated DB:
// without --confirm nothing is deleted; with --confirm the user, sessions,
// items and export_job rows are deleted in the shared transaction, the cleanup
// row + River job survive, audit_log records account.delete with user_id NULL,
// and stdout prints only user_id and audit_id (never the email).
func TestAdminDeleteAccountByEmail(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ENV", "development")

	q := gen.New(pool)
	email := "ux-audit-202611070555@example.test"
	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: email, Locale: "vi"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: u.ID, Name: "Orphan", NameNormalized: "orphan"}); err != nil {
		t.Fatal(err)
	}
	var jobID, attemptID string
	if err := pool.QueryRow(ctx, `INSERT INTO export_job (user_id, kind, status, attempt_id, lease_until, started_at)
VALUES ($1, 'encrypted', 'running', gen_random_uuid(), now() + interval '10 minutes', now()) RETURNING id::text, attempt_id::text`, u.ID).Scan(&jobID, &attemptID); err != nil {
		t.Fatal(err)
	}

	var out, errOut bytes.Buffer
	if code := run(ctx, []string{"account-delete", "--email", email}, &out, &errOut); code != 2 {
		t.Fatalf("without --confirm code = %d, want 2", code)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM app_user WHERE id = $1`, u.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("user count without --confirm = %d (%v), want 1", count, err)
	}

	out.Reset()
	errOut.Reset()
	if code := run(ctx, []string{"account-delete", "--email", "  " + strings.ToUpper(email) + " ", "--confirm"}, &out, &errOut); code != 0 {
		t.Fatalf("account-delete code = %d, stderr=%s", code, errOut.String())
	}
	stdout := out.String()
	if strings.Contains(strings.ToLower(stdout+errOut.String()), "ux-audit") || strings.Contains(stdout+errOut.String(), "@") {
		t.Fatalf("CLI output must not contain the email: stdout=%q stderr=%q", stdout, errOut.String())
	}
	if !strings.HasPrefix(stdout, fmt.Sprintf("user_id=%s audit_id=", u.ID)) {
		t.Fatalf("stdout = %q, want user_id=%s audit_id=<n>", stdout, u.ID)
	}

	if err := pool.QueryRow(ctx, `SELECT count(*) FROM app_user WHERE id = $1`, u.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("app_user after delete = %d (%v), want 0", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM item WHERE user_id = $1`, u.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("item after delete = %d (%v), want 0", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE event = 'account.delete' AND user_id IS NULL AND actor = 'admin' AND meta = '{}'::jsonb`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("admin audit row = %d (%v), want 1", count, err)
	}
	wantFile := fmt.Sprintf("%s.%s.tmp", jobID, attemptID)
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM export_file_cleanup WHERE file_name = $1 AND reason = 'account_delete' AND done_at IS NULL`, wantFile).Scan(&count); err != nil || count != 1 {
		t.Fatalf("cleanup row = %d (%v), want 1", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = $1`, exportcleanup.Kind).Scan(&count); err != nil || count != 1 {
		t.Fatalf("cleanup river_job = %d (%v), want 1", count, err)
	}

	out.Reset()
	errOut.Reset()
	if code := run(ctx, []string{"account-delete", "--email", email, "--confirm"}, &out, &errOut); code != 1 {
		t.Fatalf("deleting absent user code = %d, want 1", code)
	}
}
