package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/auth"
	"github.com/zone17th/engram/apps/api/internal/compose"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
)

func TestProbeHealthOK(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	srv := &http.Server{Handler: mux}
	serveTestServer(t, srv, ln)

	_, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	t.Setenv("HTTP_ADDR", "0.0.0.0:"+port)

	// Cho server kịp nhận kết nối.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := probeHealth(); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := probeHealth(); err != nil {
		t.Fatalf("probeHealth: %v", err)
	}
}

func TestProbeHealthFailsWhenDown(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	_, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	if err := ln.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}

	t.Setenv("HTTP_ADDR", "127.0.0.1:"+port)
	if err := probeHealth(); err == nil {
		t.Fatal("probeHealth phải lỗi khi không có server")
	}
}

func TestProbeHealthRejectsNonOK(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	srv := &http.Server{Handler: mux}
	serveTestServer(t, srv, ln)

	_, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	t.Setenv("HTTP_ADDR", "127.0.0.1:"+port)

	deadline := time.Now().Add(2 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		last = probeHealth()
		if last != nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	if last == nil {
		t.Fatal("probeHealth phải lỗi khi healthz != 200")
	}
}

func serveTestServer(t *testing.T, srv *http.Server, ln net.Listener) {
	t.Helper()
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.Serve(ln)
	}()
	t.Cleanup(func() {
		if err := srv.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Errorf("close server: %v", err)
		}
		if err := <-serveErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
			t.Errorf("serve: %v", err)
		}
	})
}

func TestRunClosesAuthWorkerBeforePoolOnErrorAfterConstruction(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	extPool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	const email = "run-close-order@example.com"
	var uid uuid.UUID
	if err := extPool.QueryRow(ctx,
		`INSERT INTO app_user (email, locale) VALUES ($1, 'en') RETURNING id`,
		email,
	).Scan(&uid); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	holdTx, err := extPool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin holdTx: %v", err)
	}
	defer func() { _ = holdTx.Rollback(ctx) }()
	var holderPID int32
	if err := holdTx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&holderPID); err != nil {
		t.Fatalf("holder pid: %v", err)
	}
	if _, err := holdTx.Exec(ctx, `SELECT id FROM app_user WHERE id = $1 FOR UPDATE`, uid); err != nil {
		t.Fatalf("lock user: %v", err)
	}

	occupiedLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen occupied port: %v", err)
	}
	t.Cleanup(func() { _ = occupiedLn.Close() })

	var constructed atomic.Bool
	var observedBlocked atomic.Bool
	var capturedSvc *auth.Service
	var svcMu sync.Mutex
	jobDone := make(chan error, 1)

	t.Cleanup(func() {
		compose.SetOnNewAuthService(nil)
		svcMu.Lock()
		s := capturedSvc
		svcMu.Unlock()
		if s != nil {
			s.SetForgotHooks(auth.ForgotHooks{})
			s.Close()
		}
	})

	compose.SetOnNewAuthService(func(svc *auth.Service) {
		svcMu.Lock()
		capturedSvc = svc
		svcMu.Unlock()
		constructed.Store(true)

		jobStarted := make(chan struct{})
		svc.SetForgotHooks(auth.ForgotHooks{
			OnJobStart: func(_ auth.ForgotJob) {
				close(jobStarted)
			},
			OnJobDone: func(_ auth.ForgotJob, jobErr error) {
				jobDone <- jobErr
			},
		})
		svc.EnqueueForgotPassword(email, "en")
		<-jobStarted

		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			var blocked int
			if qErr := extPool.QueryRow(ctx,
				`SELECT count(*) FROM pg_locks w WHERE NOT w.granted AND $1 = ANY(pg_blocking_pids(w.pid))`,
				holderPID,
			).Scan(&blocked); qErr == nil && blocked > 0 {
				observedBlocked.Store(true)
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
	})

	t.Chdir(t.TempDir())
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", "http://localhost:3000")
	t.Setenv("APP_ENV", "development")
	t.Setenv("AUTH_MAIL_CAPTURE_AS_DELIVERY", "true")
	t.Setenv("HTTP_ADDR", occupiedLn.Addr().String())

	runDone := make(chan error, 1)
	go func() {
		runDone <- run()
	}()

	select {
	case runErr := <-runDone:
		if runErr == nil {
			t.Fatal("expected run() to fail on occupied HTTP_ADDR after constructing auth service")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run() hung on post-construction error path: defer svc.Close() missing or did not cancel worker before pool.Close()")
	}

	if !constructed.Load() {
		t.Fatal("compose.NewAuth was never reached during run()")
	}
	if !observedBlocked.Load() {
		t.Fatal("forgot worker was never positively observed blocked on holderPID before run() unwound")
	}
	select {
	case jobErr := <-jobDone:
		if jobErr == nil {
			t.Fatal("expected blocked forgot job to fail on context cancellation during run() shutdown")
		}
	default:
		t.Fatal("run() returned before auth worker finished OnJobDone")
	}
}
