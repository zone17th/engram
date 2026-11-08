package main

import (
	"context"
	"flag"
	"fmt"
	"io"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/config"
	"github.com/zone17th/engram/apps/api/internal/db"
)

type noopMailer struct{}

func (noopMailer) Send(context.Context, string, string, string) error { return nil }
func buildDeleteService(cfg *config.Config, pool *pgxpool.Pool, riverc *river.Client[pgx.Tx]) (*auth.Service, error) {
	svc, _, _, err := compose.NewAuth(cfg, pool, riverc, nil, noopMailer{}, nil)
	return svc, err
}

const usageText = `Usage: admin <command> [flags]

Commands:
  account-delete --email <email> --confirm
`

// run parses argv and executes the subcommand, returning the process exit code
// (0 success, 2 usage/validation, 1 runtime error). Output contains only
// user_id and audit_id — never the email or other PII.
func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = io.WriteString(stderr, usageText)
		return 2
	}
	switch args[0] {
	case "-h", "--help", "help":
		_, _ = io.WriteString(stdout, usageText)
		return 0
	case "account-delete":
		return runAccountDelete(ctx, args[1:], stdout, stderr)
	default:
		_, _ = fmt.Fprintf(stderr, "unknown command %q\n%s", args[0], usageText)
		return 2
	}
}

func runAccountDelete(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("account-delete", flag.ContinueOnError)
	fs.SetOutput(stderr)
	email := fs.String("email", "", "email of the account to delete")
	confirm := fs.Bool("confirm", false, "confirm irreversible account deletion")
	help := fs.Bool("help", false, "show help")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *help {
		fs.PrintDefaults()
		return 0
	}
	if fs.NArg() != 0 || !*confirm {
		_, _ = io.WriteString(stderr, "account-delete requires --email <email> --confirm\n")
		return 2
	}
	if _, err := auth.NormalizeEmail(*email); err != nil {
		_, _ = io.WriteString(stderr, "invalid --email\n")
		return 2
	}

	cfg, err := config.Load()
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "config: %v\n", err)
		return 1
	}
	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "db pool: %v\n", err)
		return 1
	}
	defer pool.Close()

	riverc, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "river client: %v\n", err)
		return 1
	}
	svc, err := buildDeleteService(cfg, pool, riverc)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "auth service: %v\n", err)
		return 1
	}
	defer svc.Close()

	res, err := svc.DeleteAccountByEmail(ctx, *email)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "account-delete failed: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintf(stdout, "user_id=%s audit_id=%d\n", res.UserID, res.AuditID)
	return 0
}
