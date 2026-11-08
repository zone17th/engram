package main

import (
	"bytes"
	"context"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWorkerHealthcheck(t *testing.T) {
	t.Run("empty DSN fails", func(t *testing.T) {
		var stderr bytes.Buffer
		if code := healthcheck(context.Background(), "", healthcheckTimeout, &stderr); code != 1 {
			t.Fatalf("exit = %d, muốn 1", code)
		}
	})

	t.Run("invalid DSN fails without echoing it", func(t *testing.T) {
		var stderr bytes.Buffer
		dsn := "postgres://u:SecretPw123@%zz"
		if code := healthcheck(context.Background(), dsn, healthcheckTimeout, &stderr); code != 1 {
			t.Fatalf("exit = %d, muốn 1", code)
		}
		if strings.Contains(stderr.String(), "SecretPw123") {
			t.Fatalf("stderr lộ mật khẩu DSN: %q", stderr.String())
		}
	})

	t.Run("unreachable DB fails within timeout", func(t *testing.T) {
		// Listener nhận TCP nhưng không bao giờ trả lời: kiểm timeout 2s, không treo.
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		// Hold every accepted socket open (never reply) until teardown, so the
		// healthcheck must fail through its 2s context deadline, not EOF.
		var mu sync.Mutex
		var conns []net.Conn
		done := make(chan struct{})
		go func() {
			defer close(done)
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				mu.Lock()
				conns = append(conns, c)
				mu.Unlock()
			}
		}()
		t.Cleanup(func() {
			_ = ln.Close()
			<-done
			mu.Lock()
			defer mu.Unlock()
			for _, c := range conns {
				_ = c.Close()
			}
		})
		var stderr bytes.Buffer
		dsn := "postgres://engram:SecretPw123@" + ln.Addr().String() + "/engram?sslmode=disable&connect_timeout=30"
		start := time.Now()
		if code := healthcheck(context.Background(), dsn, healthcheckTimeout, &stderr); code != 1 {
			t.Fatalf("exit = %d, muốn 1", code)
		}
		el := time.Since(start)
		if el < healthcheckTimeout-200*time.Millisecond || el > healthcheckTimeout+time.Second {
			t.Fatalf("healthcheck mất %v, muốn ≈ timeout %v (stalled handshake)", el, healthcheckTimeout)
		}
		if !strings.Contains(stderr.String(), context.DeadlineExceeded.Error()) {
			t.Fatalf("stderr = %q, muốn lỗi deadline", stderr.String())
		}
		if strings.Contains(stderr.String(), "SecretPw123") || strings.Contains(stderr.String(), ln.Addr().String()) {
			t.Fatalf("stderr lộ DSN: %q", stderr.String())
		}
	})

	t.Run("live DB passes", func(t *testing.T) {
		dsn := reembedTestDSN(t)
		var stderr bytes.Buffer
		if code := healthcheck(context.Background(), dsn, healthcheckTimeout, &stderr); code != 0 {
			t.Fatalf("exit = %d, muốn 0; stderr %q", code, stderr.String())
		}
	})
}
