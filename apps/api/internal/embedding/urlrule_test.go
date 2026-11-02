package embedding_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/zone17th/engram/apps/api/internal/embedding"
)

type fakeResolver struct {
	lookup func(ctx context.Context, network, host string) ([]netip.Addr, error)
}

func (f fakeResolver) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return f.lookup(ctx, network, host)
}

func TestCheckURL(t *testing.T) {
	accepted := []struct {
		name string
		raw  string
	}{
		{"loopback ipv4", "http://127.0.0.1:8080/v1"},
		{"loopback ipv6", "http://[::1]:8080/v1"},
		{"rfc1918 10/8", "http://10.0.0.5:8080/v1"},
		{"rfc1918 172.16/12", "http://172.16.5.4:80"},
		{"rfc1918 192.168/16", "http://192.168.1.10:80"},
		{"cgnat 100.64/10", "http://100.100.1.1:8080/v1"},
		{"cgnat upper bound", "http://100.127.255.254:8080"},
		{"ula fc00::/7 fd", "http://[fd00::1]:8080/v1"},
		{"ula fc00::/7 fc", "http://[fc00::1234]:8080"},
		{"http internal hostname (checked at dial)", "http://tei:80"},
		{"https public hostname", "https://example.invalid/v1"},
		{"https public ip", "https://8.8.8.8/v1"},
	}

	for _, tc := range accepted {
		t.Run("accept_"+tc.name, func(t *testing.T) {
			if err := embedding.CheckURL(tc.raw); err != nil {
				t.Fatalf("CheckURL(%q) unexpected error: %v", tc.raw, err)
			}
		})
	}

	rejected := []struct {
		name    string
		raw     string
		wantErr error
	}{
		{"empty", "", embedding.ErrDisallowedURL},
		{"whitespace", "   ", embedding.ErrDisallowedURL},
		{"ftp scheme", "ftp://10.0.0.5/v1", embedding.ErrDisallowedURL},
		{"missing host", "http:///v1", embedding.ErrDisallowedURL},
		{"userinfo user only", "https://user@example.invalid/v1", embedding.ErrDisallowedURL},
		{"userinfo user:pass", "http://user:secret-token@10.0.0.5:8080/v1", embedding.ErrDisallowedURL},
		{"fragment", "https://example.invalid/v1#frag", embedding.ErrDisallowedURL},
		{"public ipv4 8.8.8.8", "http://8.8.8.8/v1", embedding.ErrDisallowedIP},
		{"public ipv4 1.1.1.1", "http://1.1.1.1:8080/v1", embedding.ErrDisallowedIP},
		{"outside cgnat 100.128.0.1", "http://100.128.0.1:8080/v1", embedding.ErrDisallowedIP},
		{"outside cgnat 100.63.255.255", "http://100.63.255.255:8080/v1", embedding.ErrDisallowedIP},
		{"outside rfc1918 172.32.0.1", "http://172.32.0.1:8080/v1", embedding.ErrDisallowedIP},
		{"public ipv6", "http://[2001:4860:4860::8888]:8080/v1", embedding.ErrDisallowedIP},
		{"link-local ipv4", "http://169.254.169.254/latest/meta-data", embedding.ErrDisallowedIP},
		{"unspecified ipv4", "http://0.0.0.0:8080/v1", embedding.ErrDisallowedIP},
	}

	for _, tc := range rejected {
		t.Run("reject_"+tc.name, func(t *testing.T) {
			err := embedding.CheckURL(tc.raw)
			if err == nil {
				t.Fatalf("CheckURL(%q) = nil, want error", tc.raw)
			}
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("CheckURL(%q) error = %v, want errors.Is(_, %v)", tc.raw, err, tc.wantErr)
			}
			if strings.Contains(err.Error(), "secret-token") {
				t.Fatalf("CheckURL error leaked userinfo secret: %v", err)
			}
		})
	}
}

func TestNewHTTPClientEnforcesDialIPOnEveryRequest(t *testing.T) {
	var dialCalls atomic.Int32
	var rebindLookupCalls atomic.Int32

	// Simulate DNS rebinding: first lookup for rebind.example.invalid returns
	// private IP 10.0.0.5, second lookup returns public IP 198.51.100.7.
	resolver := fakeResolver{
		lookup: func(_ context.Context, _, host string) ([]netip.Addr, error) {
			if host == "rebind.example.invalid" {
				n := rebindLookupCalls.Add(1)
				if n == 1 {
					return []netip.Addr{netip.MustParseAddr("10.0.0.5")}, nil
				}
				return []netip.Addr{netip.MustParseAddr("198.51.100.7")}, nil
			}
			if host == "public.example.invalid" {
				return []netip.Addr{netip.MustParseAddr("203.0.113.10")}, nil
			}
			if host == "mixed.example.invalid" {
				return []netip.Addr{
					netip.MustParseAddr("10.0.0.5"),
					netip.MustParseAddr("203.0.113.10"),
				}, nil
			}
			return nil, errors.New("unknown host")
		},
	}

	// Start a local test server so successful private dials can complete a
	// real HTTP round-trip over loopback.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()
	srvAddr := srv.Listener.Addr().String()

	client := embedding.NewHTTPClient(
		embedding.WithResolver(resolver),
		embedding.WithDialFunc(func(ctx context.Context, network, _ string) (net.Conn, error) {
			dialCalls.Add(1)
			var d net.Dialer
			return d.DialContext(ctx, network, srvAddr)
		}),
	)

	// 1. Hostname resolving to public IP over http:// is rejected before dial.
	resp, err := client.Get("http://public.example.invalid:8080/v1")
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("expected error when http hostname resolves to public IP, got nil")
	}
	if !errors.Is(err, embedding.ErrDisallowedIP) {
		t.Fatalf("expected ErrDisallowedIP, got %v", err)
	}
	if got := dialCalls.Load(); got != 0 {
		t.Fatalf("dialCalls = %d, want 0 when public IP rejected", got)
	}

	// 2. Hostname resolving to mixed (private + public) IPs is rejected before dial.
	resp, err = client.Get("http://mixed.example.invalid:8080/v1")
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("expected error when http hostname resolves to mixed public/private IPs, got nil")
	}
	if !errors.Is(err, embedding.ErrDisallowedIP) {
		t.Fatalf("expected ErrDisallowedIP for mixed IPs, got %v", err)
	}
	if got := dialCalls.Load(); got != 0 {
		t.Fatalf("dialCalls = %d, want 0", got)
	}

	// 3. Literal public IP over http:// is rejected before dial.
	resp, err = client.Get("http://8.8.8.8:8080/v1")
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("expected error for http://8.8.8.8, got nil")
	}
	if !errors.Is(err, embedding.ErrDisallowedIP) {
		t.Fatalf("expected ErrDisallowedIP for 8.8.8.8, got %v", err)
	}

	// 4. DNS rebinding: first request resolves to 10.0.0.5 (allowed), second
	// request on a fresh connection resolves to 198.51.100.7 (rejected).
	req1, err := http.NewRequest(http.MethodGet, "http://rebind.example.invalid:8080/v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	req1.Close = true
	resp1, err := client.Do(req1)
	if err != nil {
		t.Fatalf("first request (private IP) failed: %v", err)
	}
	_ = resp1.Body.Close()
	if dialCalls.Load() != 1 {
		t.Fatalf("dialCalls after first request = %d, want 1", dialCalls.Load())
	}

	req2, err := http.NewRequest(http.MethodGet, "http://rebind.example.invalid:8080/v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	req2.Close = true
	resp2, err := client.Do(req2)
	if err == nil {
		_ = resp2.Body.Close()
		t.Fatal("second request (rebound to public IP) succeeded, want error")
	}
	if !errors.Is(err, embedding.ErrDisallowedIP) {
		t.Fatalf("expected ErrDisallowedIP on rebound lookup, got %v", err)
	}
	if dialCalls.Load() != 1 {
		t.Fatalf("dialCalls after rebound request = %d, want 1 (must not dial public IP)", dialCalls.Load())
	}
}

func TestNewHTTPClientDoesNotFollowRedirects(t *testing.T) {
	var targetHits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/secret", http.StatusFound)
	}))
	defer redirector.Close()

	client := embedding.NewHTTPClient()
	resp, err := client.Get(redirector.URL + "/embed")
	if err != nil {
		t.Fatalf("client.Get returned error: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want %d (302 not followed)", resp.StatusCode, http.StatusFound)
	}
	if got := targetHits.Load(); got != 0 {
		t.Fatalf("redirect target was hit %d times, want 0", got)
	}
}

func TestReadBodyCapped(t *testing.T) {
	// Exactly 4 MiB succeeds.
	exact := bytes.Repeat([]byte{'a'}, embedding.MaxResponseBodyBytes)
	got, err := embedding.ReadBodyCapped(bytes.NewReader(exact))
	if err != nil {
		t.Fatalf("ReadBodyCapped(4 MiB) unexpected error: %v", err)
	}
	if len(got) != embedding.MaxResponseBodyBytes {
		t.Fatalf("len(got) = %d, want %d", len(got), embedding.MaxResponseBodyBytes)
	}

	// 4 MiB + 1 byte fails with ErrResponseTooLarge / ErrBadResponse.
	over := bytes.Repeat([]byte{'a'}, embedding.MaxResponseBodyBytes+1)
	_, err = embedding.ReadBodyCapped(bytes.NewReader(over))
	if err == nil {
		t.Fatal("ReadBodyCapped(4 MiB + 1) = nil, want error")
	}
	if !errors.Is(err, embedding.ErrResponseTooLarge) {
		t.Fatalf("expected ErrResponseTooLarge, got %v", err)
	}
	if !errors.Is(err, embedding.ErrBadResponse) {
		t.Fatalf("expected ErrBadResponse, got %v", err)
	}
	if gotOutcome := embedding.OutcomeForError(err); gotOutcome != "bad_response" {
		t.Fatalf("OutcomeForError = %q, want bad_response", gotOutcome)
	}
}

type fakeNetError struct {
	msg     string
	timeout bool
}

func (e fakeNetError) Error() string   { return e.msg }
func (e fakeNetError) Timeout() bool   { return e.timeout }
func (e fakeNetError) Temporary() bool { return e.timeout }

type errReader struct {
	err error
}

func (r errReader) Read([]byte) (int, error) {
	return 0, r.err
}

func TestTimeoutClassificationInResolverDialAndBodyReader(t *testing.T) {
	t.Run("resolver_deadline_exceeded_classified_as_timeout", func(t *testing.T) {
		client := embedding.NewHTTPClient(
			embedding.WithResolver(fakeResolver{
				lookup: func(context.Context, string, string) ([]netip.Addr, error) {
					return nil, context.DeadlineExceeded
				},
			}),
		)
		resp, err := client.Get("http://slow-dns.example.invalid:8080/v1")
		if err == nil {
			_ = resp.Body.Close()
			t.Fatal("expected error from resolver deadline exceeded, got nil")
		}
		var pe *embedding.ProviderError
		if !errors.As(err, &pe) || pe == nil {
			t.Fatalf("expected *ProviderError, got %T (%v)", err, err)
		}
		if pe.Class != embedding.ClassTimeout {
			t.Fatalf("ProviderError.Class = %q, want %q", pe.Class, embedding.ClassTimeout)
		}
		if got := embedding.OutcomeForError(err); got != "timeout" {
			t.Fatalf("OutcomeForError(err) = %q, want timeout", got)
		}
		if errors.Is(err, embedding.ErrBadResponse) {
			t.Fatalf("errors.Is(err, ErrBadResponse) = true for resolver timeout: %v", err)
		}
	})

	t.Run("resolver_net_timeout_classified_as_timeout", func(t *testing.T) {
		client := embedding.NewHTTPClient(
			embedding.WithResolver(fakeResolver{
				lookup: func(context.Context, string, string) ([]netip.Addr, error) {
					return nil, fakeNetError{msg: "i/o timeout", timeout: true}
				},
			}),
		)
		resp, err := client.Get("http://net-timeout-dns.example.invalid:8080/v1")
		if err == nil {
			_ = resp.Body.Close()
			t.Fatal("expected error from resolver net.Error timeout, got nil")
		}
		var pe *embedding.ProviderError
		if !errors.As(err, &pe) || pe == nil {
			t.Fatalf("expected *ProviderError, got %T (%v)", err, err)
		}
		if pe.Class != embedding.ClassTimeout {
			t.Fatalf("ProviderError.Class = %q, want %q", pe.Class, embedding.ClassTimeout)
		}
		if got := embedding.OutcomeForError(err); got != "timeout" {
			t.Fatalf("OutcomeForError(err) = %q, want timeout", got)
		}
		if errors.Is(err, embedding.ErrBadResponse) {
			t.Fatalf("errors.Is(err, ErrBadResponse) = true for resolver net timeout: %v", err)
		}
	})

	t.Run("resolver_non_timeout_remains_refused", func(t *testing.T) {
		client := embedding.NewHTTPClient(
			embedding.WithResolver(fakeResolver{
				lookup: func(context.Context, string, string) ([]netip.Addr, error) {
					return nil, fakeNetError{msg: "no such host", timeout: false}
				},
			}),
		)
		resp, err := client.Get("http://nxdomain.example.invalid:8080/v1")
		if err == nil {
			_ = resp.Body.Close()
			t.Fatal("expected error from resolver nxdomain, got nil")
		}
		var pe *embedding.ProviderError
		if !errors.As(err, &pe) || pe == nil {
			t.Fatalf("expected *ProviderError, got %T (%v)", err, err)
		}
		if pe.Class != embedding.ClassRefused {
			t.Fatalf("ProviderError.Class = %q, want %q", pe.Class, embedding.ClassRefused)
		}
		if got := embedding.OutcomeForError(err); got != "refused" {
			t.Fatalf("OutcomeForError(err) = %q, want refused", got)
		}
		if errors.Is(err, embedding.ErrBadResponse) {
			t.Fatalf("errors.Is(err, ErrBadResponse) = true for resolver nxdomain: %v", err)
		}
	})

	t.Run("dial_timeout_classified_as_timeout", func(t *testing.T) {
		client := embedding.NewHTTPClient(
			embedding.WithDialFunc(func(context.Context, string, string) (net.Conn, error) {
				return nil, fakeNetError{msg: "dial i/o timeout", timeout: true}
			}),
		)
		resp, err := client.Get("http://10.0.0.5:8080/v1")
		if err == nil {
			_ = resp.Body.Close()
			t.Fatal("expected dial timeout error, got nil")
		}
		var pe *embedding.ProviderError
		if !errors.As(err, &pe) || pe == nil {
			t.Fatalf("expected *ProviderError, got %T (%v)", err, err)
		}
		if pe.Class != embedding.ClassTimeout {
			t.Fatalf("ProviderError.Class = %q, want %q", pe.Class, embedding.ClassTimeout)
		}
		if got := embedding.OutcomeForError(err); got != "timeout" {
			t.Fatalf("OutcomeForError(err) = %q, want timeout", got)
		}
		if errors.Is(err, embedding.ErrBadResponse) {
			t.Fatalf("errors.Is(err, ErrBadResponse) = true for dial timeout: %v", err)
		}
	})

	t.Run("read_body_capped_deadline_exceeded_and_net_timeout_classified_as_timeout", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			err  error
		}{
			{"deadline_exceeded", context.DeadlineExceeded},
			{"wrapped_deadline_exceeded", fmt.Errorf("stream read: %w", context.DeadlineExceeded)},
			{"net_error_timeout", fakeNetError{msg: "read timeout", timeout: true}},
		} {
			t.Run(tc.name, func(t *testing.T) {
				_, err := embedding.ReadBodyCapped(errReader{err: tc.err})
				if err == nil {
					t.Fatal("ReadBodyCapped = nil, want error")
				}
				var pe *embedding.ProviderError
				if !errors.As(err, &pe) || pe == nil {
					t.Fatalf("expected *ProviderError, got %T (%v)", err, err)
				}
				if pe.Class != embedding.ClassTimeout {
					t.Fatalf("ProviderError.Class = %q, want %q", pe.Class, embedding.ClassTimeout)
				}
				if got := embedding.OutcomeForError(err); got != "timeout" {
					t.Fatalf("OutcomeForError(err) = %q, want timeout", got)
				}
				if errors.Is(err, embedding.ErrBadResponse) {
					t.Fatalf("errors.Is(err, ErrBadResponse) = true for timeout error: %v", err)
				}
			})
		}
	})

	t.Run("read_body_capped_non_timeout_error_remains_bad_response", func(t *testing.T) {
		_, err := embedding.ReadBodyCapped(errReader{err: io.ErrUnexpectedEOF})
		if err == nil {
			t.Fatal("ReadBodyCapped = nil, want error")
		}
		var pe *embedding.ProviderError
		if !errors.As(err, &pe) || pe == nil {
			t.Fatalf("expected *ProviderError, got %T (%v)", err, err)
		}
		if pe.Class != embedding.ClassBadResponse {
			t.Fatalf("ProviderError.Class = %q, want %q", pe.Class, embedding.ClassBadResponse)
		}
		if got := embedding.OutcomeForError(err); got != "bad_response" {
			t.Fatalf("OutcomeForError(err) = %q, want bad_response", got)
		}
		if !errors.Is(err, embedding.ErrBadResponse) {
			t.Fatalf("errors.Is(err, ErrBadResponse) = false, want true")
		}
	})

	t.Run("outcome_for_raw_net_timeout_is_timeout", func(t *testing.T) {
		rawNetTimeout := fakeNetError{msg: "i/o timeout", timeout: true}
		if got := embedding.OutcomeForError(rawNetTimeout); got != "timeout" {
			t.Fatalf("OutcomeForError(rawNetTimeout) = %q, want timeout", got)
		}
		if errors.Is(rawNetTimeout, embedding.ErrBadResponse) {
			t.Fatal("errors.Is(rawNetTimeout, ErrBadResponse) = true")
		}
	})
}
