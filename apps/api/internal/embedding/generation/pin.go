package generation

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
)

const (
	// NotifyChannel is the Postgres LISTEN/NOTIFY channel fired whenever the
	// active embedding generation changes (plan P05 mục 2.15, 2.18; M3, FS-25).
	NotifyChannel = "embedding_generation_changed"

	// DefaultPinCacheTTL is the maximum TTL (≤ 2 s) for the in-process active
	// generation Pin cache before it refreshes from the database.
	DefaultPinCacheTTL = 2 * time.Second
)

// ErrNoActiveGeneration is returned by ActivePin when embedding_active has no
// active generation row.
var ErrNoActiveGeneration = errors.New("generation: no active embedding generation")

// ErrPinnerClosed is returned by StartListener when called on a closed Pinner
// or when Close races with an in-progress StartListener.
var ErrPinnerClosed = errors.New("generation: pinner is closed")

// Pin holds the immutable snapshot of the active embedding generation for a
// single request (plan P05 mục 2.15, ADR 0007 §4; M1, BE-13).
//
// Identity carries all seven fields populated from the same single
// embedding_generation row read by ActivePin.
type Pin struct {
	GenID     int
	Identity  embedid.Identity
	MinCos    float64
	ItemTable string
	TagTable  string
}

// PinFromGeneration constructs a Pin from a validated Generation row.
func PinFromGeneration(g Generation) (Pin, error) {
	if err := ValidateRowTableNames(g.ID, g.ItemTable, g.TagTable); err != nil {
		return Pin{}, err
	}
	return Pin{
		GenID:     g.ID,
		Identity:  g.Identity(),
		MinCos:    g.SemanticMinCos,
		ItemTable: g.ItemTable,
		TagTable:  g.TagTable,
	}, nil
}

// TableIdent validates and returns the pgx.Identifier for corpus ("item" or "tag")
// on this Pin.
func (p Pin) TableIdent(corpus Corpus) (pgx.Identifier, error) {
	switch corpus {
	case CorpusItem:
		return TableIdentFromName(p.GenID, CorpusItem, p.ItemTable)
	case CorpusTag:
		return TableIdentFromName(p.GenID, CorpusTag, p.TagTable)
	default:
		return nil, ErrInvalidCorpus
	}
}

type pinReadHookKey struct{}

// WithAfterPinReadHook attaches a test-only callback to ctx that fires
// immediately after ActivePin has resolved a Pin for the caller (so a test can
// deterministically trigger a generation flip while the request continues using
// the already-pinned Pin — TestPinStableAcrossFlip). In production, no hook is
// present on ctx and this is a no-op.
func WithAfterPinReadHook(ctx context.Context, fn func(Pin)) context.Context {
	return context.WithValue(ctx, pinReadHookKey{}, fn)
}

// PinnerOption configures a Pinner.
type PinnerOption func(*Pinner)

// WithPinCacheTTL overrides the Pin cache TTL (clamped to ≤ DefaultPinCacheTTL).
func WithPinCacheTTL(ttl time.Duration) PinnerOption {
	return func(p *Pinner) {
		if ttl > 0 && ttl <= DefaultPinCacheTTL {
			p.ttl = ttl
		}
	}
}

// WithPinNowFunc overrides the clock function used for Pin cache expiry (for tests).
func WithPinNowFunc(now func() time.Time) PinnerOption {
	return func(p *Pinner) {
		if now != nil {
			p.now = now
		}
	}
}

// Pinner reads and caches the active embedding generation Pin for ≤ 2 s and
// listens on NotifyChannel to invalidate its cache and invoke registered
// subscribers immediately on generation flip (plan P05 mục 2.15, 2.18; M3).
type Pinner struct {
	db           gen.DBTX
	pool         *pgxpool.Pool
	ttl          time.Duration
	now          func() time.Time
	onQuery      func()
	beforeListen func(context.Context) error

	mu          sync.Mutex
	cached      Pin
	hasCached   bool
	cachedEmpty bool
	expiresAt   time.Time
	cacheEpoch  uint64
	subscribers []func()

	closed      bool
	listening   bool
	starting    bool
	startCancel context.CancelFunc
	startDone   chan struct{}
	startErr    error
	listenStop  context.CancelFunc
	listenDone  chan struct{}
}

// WithBeforeListenHook configures a test-only callback invoked after pool
// connection acquisition and before executing LISTEN in StartListener.
func WithBeforeListenHook(fn func(context.Context) error) PinnerOption {
	return func(p *Pinner) {
		p.beforeListen = fn
	}
}

// NewPinner creates a Pinner backed by pool with a ≤ 2 s cache TTL.
// Call StartListener (or let StartListener be called at boot) to open the
// dedicated LISTEN embedding_generation_changed connection.
func NewPinner(pool *pgxpool.Pool, opts ...PinnerOption) *Pinner {
	var db gen.DBTX
	if pool != nil {
		db = pool
	}
	p := &Pinner{
		db:   db,
		pool: pool,
		ttl:  DefaultPinCacheTTL,
		now:  time.Now,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(p)
		}
	}
	return p
}

// SetQueryCountHook registers an optional test spy callback invoked each time
// ActivePin executes the underlying SQL query against the database.
func (p *Pinner) SetQueryCountHook(fn func()) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.onQuery = fn
}

// Subscribe registers fn to be called whenever an embedding_generation_changed
// notification is received (after the Pin cache has been cleared). Task 12 uses
// this to invalidate the 30 s availability cache simultaneously (M3, FS-25).
func (p *Pinner) Subscribe(fn func()) {
	if fn == nil {
		return
	}
	p.mu.Lock()
	p.subscribers = append(p.subscribers, fn)
	p.mu.Unlock()
}

// Invalidate clears the cached Pin immediately and notifies all subscribers.
func (p *Pinner) Invalidate() {
	p.mu.Lock()
	p.hasCached = false
	p.cachedEmpty = false
	p.expiresAt = time.Time{}
	p.cacheEpoch++
	subs := make([]func(), len(p.subscribers))
	copy(subs, p.subscribers)
	p.mu.Unlock()

	for _, fn := range subs {
		fn()
	}
}

// ActivePin returns the active generation Pin, reading the single joined
// embedding_active + embedding_generation row at most once per cache TTL or
// after a NOTIFY invalidation. When no generation is active, it returns
// ErrNoActiveGeneration.
func (p *Pinner) ActivePin(ctx context.Context) (Pin, error) {
	if p == nil || p.db == nil {
		return Pin{}, ErrNilTx
	}

	now := p.now()
	p.mu.Lock()
	if now.Before(p.expiresAt) {
		if p.hasCached {
			pin := p.cached
			p.mu.Unlock()
			fireAfterPinReadHook(ctx, pin)
			return pin, nil
		}
		if p.cachedEmpty {
			p.mu.Unlock()
			return Pin{}, ErrNoActiveGeneration
		}
	}
	epoch := p.cacheEpoch
	onQuery := p.onQuery
	p.mu.Unlock()

	if onQuery != nil {
		onQuery()
	}

	row, err := gen.New(p.db).GetActiveEmbeddingGeneration(ctx)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			p.mu.Lock()
			if p.cacheEpoch == epoch {
				p.hasCached = false
				p.cachedEmpty = true
				p.expiresAt = p.now().Add(p.ttl)
			}
			p.mu.Unlock()
			return Pin{}, ErrNoActiveGeneration
		}
		return Pin{}, err
	}

	g, err := FromDBRow(row)
	if err != nil {
		return Pin{}, err
	}
	pin, err := PinFromGeneration(g)
	if err != nil {
		return Pin{}, err
	}

	p.mu.Lock()
	if p.cacheEpoch == epoch {
		p.cached = pin
		p.hasCached = true
		p.cachedEmpty = false
		p.expiresAt = p.now().Add(p.ttl)
	}
	p.mu.Unlock()

	fireAfterPinReadHook(ctx, pin)
	return pin, nil
}

func fireAfterPinReadHook(ctx context.Context, pin Pin) {
	if ctx == nil {
		return
	}
	if fn, ok := ctx.Value(pinReadHookKey{}).(func(Pin)); ok && fn != nil {
		fn(pin)
	}
}

// StartListener acquires a dedicated connection from the pool, executes
// LISTEN embedding_generation_changed, and starts a background goroutine that
// calls Invalidate() on every notification until ctx is cancelled or Close is
// called. StartListener blocks until LISTEN has succeeded on the dedicated
// connection so callers can rely on notifications immediately after it returns.
//
// If initial acquisition or LISTEN fails, StartListener does not latch the
// failure: a subsequent StartListener call with a healthy context retries.
// If Close is called before or during StartListener, StartListener aborts,
// releases any acquired connection, and returns ErrPinnerClosed (or the
// cancellation error).
func (p *Pinner) StartListener(ctx context.Context) error {
	if p == nil || p.pool == nil {
		return ErrNilTx
	}

	for {
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return ErrPinnerClosed
		}
		if p.listening {
			p.mu.Unlock()
			return nil
		}
		if p.starting {
			waitCh := p.startDone
			p.mu.Unlock()
			select {
			case <-waitCh:
				p.mu.Lock()
				closed := p.closed
				listening := p.listening
				err := p.startErr
				p.mu.Unlock()
				if closed {
					return ErrPinnerClosed
				}
				if listening {
					return nil
				}
				return err
			case <-ctx.Done():
				return ctx.Err()
			}
		}

		attemptCtx, attemptCancel := context.WithCancel(ctx)
		startDone := make(chan struct{})
		p.starting = true
		p.startCancel = attemptCancel
		p.startDone = startDone
		p.startErr = nil
		beforeListen := p.beforeListen
		p.mu.Unlock()

		conn, err := p.pool.Acquire(attemptCtx)
		if err == nil && beforeListen != nil {
			if hookErr := beforeListen(attemptCtx); hookErr != nil {
				conn.Release()
				conn = nil
				err = hookErr
			}
		}
		if err == nil {
			if _, execErr := conn.Exec(attemptCtx, "LISTEN "+NotifyChannel); execErr != nil {
				conn.Release()
				conn = nil
				err = execErr
			}
		}

		p.mu.Lock()
		p.starting = false
		p.startCancel = nil
		if err != nil || p.closed {
			if conn != nil {
				conn.Release()
				conn = nil
			}
			if p.closed {
				err = ErrPinnerClosed
			}
			p.startErr = err
			close(startDone)
			p.mu.Unlock()
			attemptCancel()
			return err
		}

		listenDone := make(chan struct{})
		p.listening = true
		p.listenStop = attemptCancel
		p.listenDone = listenDone
		p.startErr = nil
		close(startDone)
		p.mu.Unlock()

		go p.runListenLoop(attemptCtx, conn, listenDone)
		return nil
	}
}

func (p *Pinner) runListenLoop(ctx context.Context, conn *pgxpool.Conn, done chan struct{}) {
	defer close(done)
	defer func() {
		if conn != nil {
			unlistenCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_, _ = conn.Exec(unlistenCtx, "UNLISTEN "+NotifyChannel)
			cancel()
			conn.Release()
		}
	}()

	for {
		if ctx.Err() != nil {
			return
		}
		if conn == nil {
			acConn, err := p.pool.Acquire(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(100 * time.Millisecond):
					continue
				}
			}
			if _, err := acConn.Exec(ctx, "LISTEN "+NotifyChannel); err != nil {
				acConn.Release()
				if ctx.Err() != nil {
					return
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(100 * time.Millisecond):
					continue
				}
			}
			conn = acConn
			// Clear cache after reconnect in case a notification arrived while disconnected.
			p.Invalidate()
		}

		_, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			conn.Release()
			conn = nil
			continue
		}
		p.Invalidate()
	}
}

// Close stops the background LISTEN goroutine (or cancels and waits for any
// in-progress StartListener), waits for it to release its dedicated pool
// connection, and prevents any subsequent listener from starting.
func (p *Pinner) Close() {
	if p == nil {
		return
	}
	p.mu.Lock()
	p.closed = true
	startCancel := p.startCancel
	startDone := p.startDone
	starting := p.starting
	stop := p.listenStop
	done := p.listenDone
	p.mu.Unlock()

	if startCancel != nil {
		startCancel()
	}
	if stop != nil {
		stop()
	}
	if starting && startDone != nil {
		<-startDone
		p.mu.Lock()
		done = p.listenDone
		p.mu.Unlock()
	}
	if done != nil {
		<-done
	}
}
