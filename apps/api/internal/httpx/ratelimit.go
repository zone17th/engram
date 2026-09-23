package httpx

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type window struct {
	count int
	start time.Time
}

// FixedWindow là limiter 60s in-memory, có cap để IP ngẫu nhiên không nổ RAM.
type FixedWindow struct {
	mu      sync.Mutex
	windows map[string]window
	limit   int
	window  time.Duration
	cap     int
	now     func() time.Time
}

func NewFixedWindow(limit int) *FixedWindow {
	return NewFixedWindowWith(limit, time.Minute)
}

func NewFixedWindowWith(limit int, d time.Duration) *FixedWindow {
	if d <= 0 {
		d = time.Minute
	}
	return &FixedWindow{
		windows: make(map[string]window),
		limit:   limit,
		window:  d,
		cap:     100_000,
		now:     time.Now,
	}
}

func (f *FixedWindow) Allow(key string) (ok bool, retryAfter int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	if len(f.windows) > f.cap {
		f.evict(now)
	}
	w, exists := f.windows[key]
	if !exists || now.Sub(w.start) >= f.window {
		f.windows[key] = window{count: 1, start: now}
		return true, 0
	}
	if w.count >= f.limit {
		left := int(f.window.Seconds() - now.Sub(w.start).Seconds())
		if left < 1 {
			left = 1
		}
		return false, left
	}
	w.count++
	f.windows[key] = w
	return true, 0
}

func (f *FixedWindow) evict(now time.Time) {
	for k, w := range f.windows {
		if now.Sub(w.start) >= f.window {
			delete(f.windows, k)
		}
	}
}

func LimitIP(l *FixedWindow, keyFn func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if l == nil {
				next.ServeHTTP(w, r)
				return
			}
			ok, retry := l.Allow(keyFn(r))
			if !ok {
				WriteProblemExtra(w, r, http.StatusTooManyRequests, "rate_limited", "Quá nhiều yêu cầu.", ProblemExtra{RetryAfter: &retry})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func ClientIP(r *http.Request, trusted func(net.IP) bool) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remote := net.ParseIP(host)
	if remote == nil || trusted == nil || !trusted(remote) {
		return host
	}
	xff := r.Header.Get("X-Forwarded-For")
	if xff == "" {
		return host
	}
	parts := strings.Split(xff, ",")
	// phải sang trái qua hop đã trust
	for i := len(parts) - 1; i >= 0; i-- {
		ip := net.ParseIP(strings.TrimSpace(parts[i]))
		if ip == nil {
			continue
		}
		if !trusted(ip) {
			return ip.String()
		}
		if i == 0 {
			return ip.String()
		}
	}
	return host
}
