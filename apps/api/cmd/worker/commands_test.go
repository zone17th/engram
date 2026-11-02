package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/config"
)

func newTestEnv() (Env, *bytes.Buffer, *bytes.Buffer) {
	var stdout, stderr bytes.Buffer
	env := Env{
		Cfg:    &config.Config{},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Stdout: &stdout,
		Stderr: &stderr,
	}
	return env, &stdout, &stderr
}

func TestNoArgsRunsWorker(t *testing.T) {
	reg := &registry{}
	cmdCalled := 0
	reg.register(Command{
		Name:    "fake",
		Summary: "fake command",
		Run: func(ctx context.Context, env Env, args []string) error {
			cmdCalled++
			return nil
		},
	})

	env, _, _ := newTestEnv()

	workerCalls := 0
	code := reg.dispatch(context.Background(), env, nil, func(ctx context.Context, gotEnv Env) error {
		workerCalls++
		return nil
	})
	if code != 0 {
		t.Fatalf("expected exit code 0 for nil args, got %d", code)
	}
	if workerCalls != 1 {
		t.Fatalf("expected runWorker called once for nil args, got %d", workerCalls)
	}

	workerCalls = 0
	code = reg.dispatch(context.Background(), env, []string{}, func(ctx context.Context, gotEnv Env) error {
		workerCalls++
		return nil
	})
	if code != 0 {
		t.Fatalf("expected exit code 0 for empty args, got %d", code)
	}
	if workerCalls != 1 {
		t.Fatalf("expected runWorker called once for empty args, got %d", workerCalls)
	}

	workerCalls = 0
	code = reg.dispatch(context.Background(), env, nil, func(ctx context.Context, gotEnv Env) error {
		workerCalls++
		return errors.New("worker failed")
	})
	if code != 1 {
		t.Fatalf("expected exit code 1 on runWorker error, got %d", code)
	}
	if workerCalls != 1 {
		t.Fatalf("expected runWorker called once on error path, got %d", workerCalls)
	}
	if cmdCalled != 0 {
		t.Fatalf("expected fake command not called, got %d", cmdCalled)
	}
}

func TestDispatchKnownCommand(t *testing.T) {
	type ctxKey struct{}
	ctx := context.WithValue(context.Background(), ctxKey{}, "marker")
	env, stdout, stderr := newTestEnv()

	reg := &registry{}
	var gotArgs []string
	var gotMarker any
	var gotCfg *config.Config
	reg.register(Command{
		Name:    "reembed",
		Summary: "reembed items and tags",
		Run: func(c context.Context, e Env, args []string) error {
			gotMarker = c.Value(ctxKey{})
			gotCfg = e.Cfg
			gotArgs = append([]string(nil), args...)
			_, _ = io.WriteString(e.Stdout, "ok\n")
			return nil
		},
	})

	workerCalled := false
	code := reg.dispatch(ctx, env, []string{"reembed", "all", "--dry-run"}, func(ctx context.Context, env Env) error {
		workerCalled = true
		return nil
	})
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}
	if workerCalled {
		t.Fatalf("expected runWorker not called")
	}
	if gotMarker != "marker" {
		t.Fatalf("expected context value propagated, got %v", gotMarker)
	}
	if gotCfg != env.Cfg {
		t.Fatalf("expected env.Cfg propagated")
	}
	wantArgs := []string{"all", "--dry-run"}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Fatalf("expected args %v, got %v", wantArgs, gotArgs)
	}
	if stdout.String() != "ok\n" {
		t.Fatalf("unexpected stdout: %q", stdout.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("expected empty stderr, got %q", stderr.String())
	}
}

func TestDispatchUnknownCommandExit2(t *testing.T) {
	reg := &registry{}
	reg.register(Command{
		Name:    "semeval",
		Summary: "evaluate threshold",
		Run: func(ctx context.Context, env Env, args []string) error {
			return nil
		},
	})

	env, stdout, stderr := newTestEnv()
	code := reg.dispatch(context.Background(), env, []string{"unknown"}, func(ctx context.Context, env Env) error {
		t.Fatal("runWorker must not be called")
		return nil
	})
	if code != 2 {
		t.Fatalf("expected exit code 2, got %d", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("expected empty stdout, got %q", stdout.String())
	}
	if !strings.Contains(stderr.String(), "unknown") || !strings.Contains(stderr.String(), "semeval") {
		t.Fatalf("expected stderr to mention unknown command and usage, got %q", stderr.String())
	}
}

func TestHelpListsCommandsSorted(t *testing.T) {
	reg := &registry{}
	reg.register(Command{
		Name:    "semeval",
		Summary: "evaluate semantic threshold",
		Run:     func(ctx context.Context, env Env, args []string) error { return nil },
	})
	reg.register(Command{
		Name:    "alpha",
		Summary: "first command",
		Run:     func(ctx context.Context, env Env, args []string) error { return nil },
	})
	reg.register(Command{
		Name:    "reembed",
		Summary: "reconcile embeddings",
		Run:     func(ctx context.Context, env Env, args []string) error { return nil },
	})

	for _, helpArg := range []string{"help", "-h", "--help"} {
		env, stdout, stderr := newTestEnv()
		code := reg.dispatch(context.Background(), env, []string{helpArg}, func(ctx context.Context, env Env) error {
			t.Fatal("runWorker must not be called")
			return nil
		})
		if code != 0 {
			t.Fatalf("%s: expected exit code 0, got %d", helpArg, code)
		}
		if stderr.Len() != 0 {
			t.Fatalf("%s: expected empty stderr, got %q", helpArg, stderr.String())
		}
		out := stdout.String()
		idxAlpha := strings.Index(out, "alpha")
		idxReembed := strings.Index(out, "reembed")
		idxSemeval := strings.Index(out, "semeval")
		if idxAlpha < 0 || idxReembed < 0 || idxSemeval < 0 {
			t.Fatalf("%s: expected all commands in output, got %q", helpArg, out)
		}
		if !(idxAlpha < idxReembed && idxReembed < idxSemeval) {
			t.Fatalf("%s: expected sorted order alpha < reembed < semeval, got %q", helpArg, out)
		}
		if !strings.Contains(out, "evaluate semantic threshold") ||
			!strings.Contains(out, "first command") ||
			!strings.Contains(out, "reconcile embeddings") {
			t.Fatalf("%s: expected summaries in help output, got %q", helpArg, out)
		}
	}
}

func TestCommandErrorExit1(t *testing.T) {
	reg := &registry{}
	reg.register(Command{
		Name:    "reembed",
		Summary: "reembed command",
		Run: func(ctx context.Context, env Env, args []string) error {
			return errors.New("missing --user")
		},
	})

	env, stdout, stderr := newTestEnv()
	code := reg.dispatch(context.Background(), env, []string{"reembed"}, func(ctx context.Context, env Env) error {
		t.Fatal("runWorker must not be called")
		return nil
	})
	if code != 1 {
		t.Fatalf("expected exit code 1, got %d", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("expected empty stdout, got %q", stdout.String())
	}
	if stderr.String() != "reembed: missing --user\n" {
		t.Fatalf("expected stderr %q, got %q", "reembed: missing --user\n", stderr.String())
	}
}

func TestRegisterRejectsDuplicateAndEmpty(t *testing.T) {
	assertPanics := func(t *testing.T, label string, fn func()) {
		t.Helper()
		defer func() {
			if r := recover(); r == nil {
				t.Fatalf("%s: expected panic, got none", label)
			}
		}()
		fn()
	}

	reg := &registry{}
	assertPanics(t, "empty name", func() {
		reg.register(Command{
			Name:    "",
			Summary: "empty",
			Run:     func(ctx context.Context, env Env, args []string) error { return nil },
		})
	})

	assertPanics(t, "nil Run", func() {
		reg.register(Command{
			Name:    "semeval",
			Summary: "nil run",
			Run:     nil,
		})
	})

	reg.register(Command{
		Name:    "semeval",
		Summary: "valid",
		Run:     func(ctx context.Context, env Env, args []string) error { return nil },
	})
	assertPanics(t, "duplicate name", func() {
		reg.register(Command{
			Name:    "semeval",
			Summary: "duplicate",
			Run:     func(ctx context.Context, env Env, args []string) error { return nil },
		})
	})
}

func TestFlagHelpExit0(t *testing.T) {
	reg := &registry{}
	reg.register(Command{
		Name:    "semeval",
		Summary: "evaluate threshold",
		Run: func(ctx context.Context, env Env, args []string) error {
			fs := flag.NewFlagSet("semeval", flag.ContinueOnError)
			fs.SetOutput(env.Stderr)
			_ = fs.String("pairs", "", "pairs file")
			return fs.Parse(args)
		},
	})

	env, _, _ := newTestEnv()
	code := reg.dispatch(context.Background(), env, []string{"semeval", "-h"}, func(ctx context.Context, env Env) error {
		t.Fatal("runWorker must not be called")
		return nil
	})
	if code != 0 {
		t.Fatalf("expected exit code 0 when FlagSet returns flag.ErrHelp, got %d", code)
	}
}
