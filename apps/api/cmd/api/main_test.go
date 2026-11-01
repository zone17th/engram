package main

import (
	"errors"
	"net"
	"net/http"
	"testing"
	"time"

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

func TestRunClosesAuthWorkerOnErrorAfterConstruction(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)

	t.Chdir(t.TempDir())
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", "http://localhost:3000")
	t.Setenv("APP_ENV", "development")
	// Invalid HTTP_ADDR causes srv.ListenAndServe() inside run() to fail after compose.NewAuth,
	// exercising the defer svc.Close() path before defer pool.Close().
	t.Setenv("HTTP_ADDR", "127.0.0.1:invalid-port")

	if err := run(); err == nil {
		t.Fatal("expected run() to fail on invalid HTTP_ADDR after constructing auth service")
	}
}
