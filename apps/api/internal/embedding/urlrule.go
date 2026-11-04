package embedding

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// MaxResponseBodyBytes is the hard 4 MiB cap on HTTP response bodies read from
// embedding providers (plan P05 mục 2.12).
const MaxResponseBodyBytes = 4 << 20 // 4 MiB

var (
	// ErrDisallowedURL is returned when an embedding provider URL violates the
	// scheme, userinfo, host, or IP policy.
	ErrDisallowedURL = errors.New("embedding: URL violates security policy")
	// ErrDisallowedIP is returned at config validation or dial time when an
	// http:// target resolves to a non-private / non-loopback IP address.
	ErrDisallowedIP = errors.New("embedding: http destination IP is not loopback/private/CGNAT/ULA")
	// ErrResponseTooLarge is returned when a provider response body exceeds
	// MaxResponseBodyBytes (4 MiB). It wraps ErrBadResponse.
	ErrResponseTooLarge = fmt.Errorf("%w: response body exceeds 4 MiB cap", ErrBadResponse)
)

var (
	cgnatPrefix = netip.MustParsePrefix("100.64.0.0/10")
	ulaPrefix   = netip.MustParsePrefix("fc00::/7")
)

// IsAllowedHTTPAddr reports whether ip is permitted as a destination for
// plaintext http:// embedding provider requests (plan P05 mục 2.12, SPEC §4.4):
//   - loopback (127.0.0.0/8, ::1)
//   - RFC 1918 private IPv4 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
//   - RFC 6598 CGNAT / Tailscale (100.64.0.0/10)
//   - RFC 4193 IPv6 Unique Local Addresses (fc00::/7)
//
// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are unmapped before checking.
func IsAllowedHTTPAddr(ip netip.Addr) bool {
	if !ip.IsValid() {
		return false
	}
	ip = ip.Unmap()
	if ip.IsLoopback() || ip.IsPrivate() {
		return true
	}
	if ip.Is4() && cgnatPrefix.Contains(ip) {
		return true
	}
	if ip.Is6() && ulaPrefix.Contains(ip) {
		return true
	}
	return false
}

// CheckHTTPAddr validates that ip is permitted for an http:// connection.
func CheckHTTPAddr(ip netip.Addr) error {
	if !IsAllowedHTTPAddr(ip) {
		return ErrDisallowedIP
	}
	return nil
}

// CheckURL validates a provider base URL at config load time (plan P05 mục 2.12,
// SPEC §4.4):
//   - Must have scheme "https" or "http" and a non-empty host.
//   - Must not contain userinfo (username or password) or fragment.
//   - For "https", any host (literal IP or hostname) is accepted.
//   - For "http" with a literal IP address, the IP must satisfy IsAllowedHTTPAddr
//     (loopback, RFC 1918, 100.64.0.0/10, or fc00::/7).
//   - For "http" with a DNS hostname, CheckURL accepts the hostname without
//     performing DNS resolution (so process boot never depends on DNS), and
//     NewHTTPClient enforces IsAllowedHTTPAddr on every resolved IP on every dial
//     (preventing DNS rebinding).
//
// Error messages never echo raw URLs or credentials.
func CheckURL(raw string) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return fmt.Errorf("%w: empty URL", ErrDisallowedURL)
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return fmt.Errorf("%w: invalid URL syntax", ErrDisallowedURL)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("%w: scheme must be http or https", ErrDisallowedURL)
	}
	if u.User != nil {
		return fmt.Errorf("%w: userinfo is not allowed in URL", ErrDisallowedURL)
	}
	if u.Fragment != "" {
		return fmt.Errorf("%w: URL fragment is not allowed", ErrDisallowedURL)
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("%w: missing host", ErrDisallowedURL)
	}
	if p := u.Port(); p != "" {
		if _, err := net.LookupPort("tcp", p); err != nil {
			return fmt.Errorf("%w: invalid port", ErrDisallowedURL)
		}
	}

	if scheme == "https" {
		return nil
	}

	// scheme == "http": if host is an IP literal (netip.ParseAddr or net.ParseIP),
	// enforce the private/loopback/CGNAT/ULA rule immediately.
	if addr, err := netip.ParseAddr(host); err == nil {
		if !IsAllowedHTTPAddr(addr) {
			return ErrDisallowedIP
		}
		return nil
	}
	if ip := net.ParseIP(host); ip != nil {
		addr, ok := netip.AddrFromSlice(ip)
		if !ok || !IsAllowedHTTPAddr(addr) {
			return ErrDisallowedIP
		}
		return nil
	}
	return nil
}

// HostResolver resolves a hostname into IP addresses during dialing.
type HostResolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// DialFunc dials a resolved network address ("ip:port").
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// HTTPClientOption configures NewHTTPClient.
type HTTPClientOption func(*httpClientConfig)

type httpClientConfig struct {
	timeout  time.Duration
	resolver HostResolver
	dial     DialFunc
}

// WithTimeout sets the overall timeout on the returned *http.Client.
func WithTimeout(d time.Duration) HTTPClientOption {
	return func(cfg *httpClientConfig) {
		cfg.timeout = d
	}
}

// WithResolver overrides the DNS resolver used when dialing hostnames (for
// deterministic tests without live DNS).
func WithResolver(r HostResolver) HTTPClientOption {
	return func(cfg *httpClientConfig) {
		cfg.resolver = r
	}
}

// WithDialFunc overrides the low-level TCP dialer called after IP validation.
func WithDialFunc(fn DialFunc) HTTPClientOption {
	return func(cfg *httpClientConfig) {
		cfg.dial = fn
	}
}

// NewHTTPClient returns an *http.Client shared by TEI and openai_compat
// providers (plan P05 mục 2.12):
//   - Never follows HTTP redirects (CheckRedirect returns http.ErrUseLastResponse).
//   - Resolves and checks destination IPs on every dial when the request uses
//     plaintext http:// (blocking public IPs and DNS rebinding).
func NewHTTPClient(opts ...HTTPClientOption) *http.Client {
	cfg := httpClientConfig{
		resolver: net.DefaultResolver,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	rawDial := cfg.dial
	if rawDial == nil {
		rawDial = dialer.DialContext
	}
	resolver := cfg.resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}

	// Plain HTTP transport enforces IsAllowedHTTPAddr on every resolved IP and
	// again on the connected socket remote address via dialer Control/post-check.
	httpTransport := &http.Transport{
		Proxy:                 nil,
		DialContext:           makeCheckedDialContext(resolver, rawDial, true),
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          32,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	httpsTransport := &http.Transport{
		Proxy:                 nil,
		DialContext:           makeCheckedDialContext(resolver, rawDial, false),
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          32,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}

	return &http.Client{
		Timeout: cfg.timeout,
		Transport: &schemeSplitRoundTripper{
			httpRT:  httpTransport,
			httpsRT: httpsTransport,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

type schemeSplitRoundTripper struct {
	httpRT  http.RoundTripper
	httpsRT http.RoundTripper
}

func (rt *schemeSplitRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if req == nil || req.URL == nil {
		return nil, fmt.Errorf("%w: missing request URL", ErrDisallowedURL)
	}
	if req.URL.User != nil {
		return nil, fmt.Errorf("%w: userinfo is not allowed in URL", ErrDisallowedURL)
	}
	switch strings.ToLower(req.URL.Scheme) {
	case "http":
		return rt.httpRT.RoundTrip(req)
	case "https":
		return rt.httpsRT.RoundTrip(req)
	default:
		return nil, fmt.Errorf("%w: unsupported scheme", ErrDisallowedURL)
	}
}

func makeCheckedDialContext(resolver HostResolver, rawDial DialFunc, checkPrivateIP bool) DialFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid dial address", ErrDisallowedURL)
		}
		var addrs []netip.Addr
		if ip, parseErr := netip.ParseAddr(host); parseErr == nil {
			addrs = []netip.Addr{ip}
		} else {
			resolved, lookupErr := resolver.LookupNetIP(ctx, "ip", host)
			if lookupErr != nil {
				class := ClassRefused
				detail := "dns lookup failed"
				if IsTimeoutError(lookupErr) || IsTimeoutError(ctx.Err()) {
					class = ClassTimeout
					detail = "dns lookup timed out"
				}
				return nil, &ProviderError{
					Class:  class,
					Detail: detail,
					Err:    lookupErr,
				}
			}
			if len(resolved) == 0 {
				return nil, &ProviderError{
					Class:  ClassRefused,
					Detail: "dns lookup returned no addresses",
				}
			}
			addrs = resolved
		}

		if checkPrivateIP {
			// Every resolved IP must be allowed before any connection attempt
			// is made (SPEC §4.4: "http:// chỉ khi mọi IP đích thuộc ...").
			for _, addr := range addrs {
				if !IsAllowedHTTPAddr(addr) {
					return nil, &ProviderError{
						Class:  ClassRefused,
						Detail: "http destination IP rejected by URL rule",
						Err:    ErrDisallowedIP,
					}
				}
			}
		}

		var lastErr error
		for _, addr := range addrs {
			target := net.JoinHostPort(addr.Unmap().String(), port)
			conn, dialErr := rawDial(ctx, network, target)
			if dialErr != nil {
				lastErr = dialErr
				continue
			}
			if checkPrivateIP && conn != nil && conn.RemoteAddr() != nil {
				if tcpAddr, ok := conn.RemoteAddr().(*net.TCPAddr); ok {
					if remoteIP, ok := netip.AddrFromSlice(tcpAddr.IP); !ok || !IsAllowedHTTPAddr(remoteIP) {
						_ = conn.Close()
						return nil, &ProviderError{
							Class:  ClassRefused,
							Detail: "connected socket remote IP rejected by URL rule",
							Err:    ErrDisallowedIP,
						}
					}
				}
			}
			return conn, nil
		}
		if lastErr == nil {
			lastErr = errors.New("no dialable addresses")
		}
		class := ClassRefused
		detail := "dial failed"
		if IsTimeoutError(lastErr) || IsTimeoutError(ctx.Err()) {
			class = ClassTimeout
			detail = "dial timed out"
		}
		return nil, &ProviderError{
			Class:  class,
			Detail: detail,
			Err:    lastErr,
		}
	}
}

// ReadBodyCapped reads up to MaxResponseBodyBytes (4 MiB) from r. If the stream
// contains more than MaxResponseBodyBytes, it returns ErrResponseTooLarge
// (which wraps ErrBadResponse and is classified as ClassBadResponse).
func ReadBodyCapped(r io.Reader) ([]byte, error) {
	return ReadBodyWithLimit(r, MaxResponseBodyBytes)
}

// ReadBodyWithLimit reads all bytes from r up to maxBytes. If r yields more
// than maxBytes bytes, it returns a *ProviderError with ClassBadResponse
// wrapping ErrResponseTooLarge / ErrBadResponse.
func ReadBodyWithLimit(r io.Reader, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		maxBytes = MaxResponseBodyBytes
	}
	lr := &io.LimitedReader{R: r, N: maxBytes + 1}
	data, err := io.ReadAll(lr)
	if err != nil {
		class := ClassBadResponse
		detail := "failed reading response body"
		if IsTimeoutError(err) {
			class = ClassTimeout
			detail = "reading response body timed out"
		}
		return nil, &ProviderError{
			Class:  class,
			Detail: detail,
			Err:    err,
		}
	}
	if int64(len(data)) > maxBytes {
		return nil, &ProviderError{
			Class:  ClassBadResponse,
			Detail: "response body exceeds size cap",
			Err:    ErrResponseTooLarge,
		}
	}
	return data, nil
}
