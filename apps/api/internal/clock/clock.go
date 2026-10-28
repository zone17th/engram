// Package clock trừu tượng hoá thời gian để test TTL/expiry không sleep.
package clock

import (
	"sync"
	"time"
)

// Clock trả thời điểm hiện tại.
type Clock interface {
	Now() time.Time
}

// System dùng time.Now.
type System struct{}

func (System) Now() time.Time { return time.Now() }

// Fixed cho test; Advance dịch kim đồng hồ.
type Fixed struct {
	mu sync.Mutex
	t  time.Time
}

func NewFixed(t time.Time) *Fixed {
	return &Fixed{t: t}
}

func (f *Fixed) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t
}

func (f *Fixed) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = f.t.Add(d)
}

func (f *Fixed) Set(t time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = t
}
