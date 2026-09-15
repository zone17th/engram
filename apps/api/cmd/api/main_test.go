package main

import (
	"net"
	"net/http"
	"os"
	"testing"
	"time"
)

func TestProbeHealthOK(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	defer srv.Close()

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
	ln.Close()

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
	defer ln.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	defer srv.Close()

	_, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	os.Setenv("HTTP_ADDR", "127.0.0.1:"+port)
	t.Cleanup(func() { os.Unsetenv("HTTP_ADDR") })

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
