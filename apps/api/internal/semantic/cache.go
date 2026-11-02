package semantic

import (
	"container/list"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	// DefaultCacheMaxEntries is the maximum number of query-vector entries kept
	// in the in-process LRU cache (plan P05 mục 2.7, 2.13; SPEC §6.6).
	DefaultCacheMaxEntries = 5000

	// DefaultCacheTTL is the 24-hour TTL for cached query vectors (plan P05
	// mục 2.7, 2.13; SPEC §6.6).
	DefaultCacheTTL = 24 * time.Hour

	// CacheHMACKeyBytes is the 32-byte random HMAC key size generated at process
	// start via crypto/rand (D1, advisor-dec-243).
	CacheHMACKeyBytes = 32

	// CacheKeyBytes is the fixed 52-byte length of a CacheKey:
	// 16 B user_id || 4 B big-endian generation_id || 32 B HMAC-SHA256(k, qn).
	CacheKeyBytes = 16 + 4 + sha256.Size
)

// Metric labels for semantic_query_cache_total{result} (obs.SemanticCacheResults).
const (
	CacheResultHit  = "hit"
	CacheResultMiss = "miss"
)

// CacheKey is the fixed-length 52-byte binary key for the query-embedding cache:
// `user_id (16 B) || generation_id (4 B) || HMAC-SHA256(k, qn) (32 B)`
// (plan P05 mục 2.7 D1, advisor-dec-243).
//
// Security invariant: never contains raw query text `q` or `qn`, and is always
// scoped to a single (user_id, generation_id).
type CacheKey [CacheKeyBytes]byte

type cacheEntry struct {
	key       CacheKey
	vec       []float32
	expiresAt time.Time
}

// QueryCache is a thread-safe in-process LRU + TTL cache for query embeddings
// (plan P05 mục 2.7, Task 12; SPEC §6.6).
//
// Invariants:
//   - Key = `user_id || generation_id || HMAC-SHA256(k, qn)` where `k` is 32
//     bytes from `crypto/rand` generated at construction (never written to disk,
//     never logged).
//   - Never stores raw `q` or `qn` anywhere in memory.
//   - Never shares entries across users or across generations.
type QueryCache struct {
	hmacKey    *[CacheHMACKeyBytes]byte
	maxEntries int
	ttl        time.Duration
	now        func() time.Time

	mu    sync.Mutex
	ll    *list.List
	items map[CacheKey]*list.Element
}

// NewQueryCache constructs a QueryCache with maxEntries (defaults to 5000 when
// <= 0), ttl (defaults to 24 h when <= 0), and an injectable clock (defaults to
// time.Now). It generates a fresh 32-byte HMAC secret from crypto/rand.
func NewQueryCache(maxEntries int, ttl time.Duration, now func() time.Time) *QueryCache {
	var key [CacheHMACKeyBytes]byte
	if _, err := rand.Read(key[:]); err != nil {
		panic(fmt.Sprintf("semantic: crypto/rand failed reading cache HMAC key: %v", err))
	}
	return newQueryCacheWithKey(key, maxEntries, ttl, now)
}

func newQueryCacheWithKey(key [CacheHMACKeyBytes]byte, maxEntries int, ttl time.Duration, now func() time.Time) *QueryCache {
	if maxEntries <= 0 {
		maxEntries = DefaultCacheMaxEntries
	}
	if ttl <= 0 {
		ttl = DefaultCacheTTL
	}
	if now == nil {
		now = time.Now
	}
	keyCopy := key
	return &QueryCache{
		hmacKey:    &keyCopy,
		maxEntries: maxEntries,
		ttl:        ttl,
		now:        now,
		ll:         list.New(),
		items:      make(map[CacheKey]*list.Element),
	}
}

// Key computes `user_id || generation_id || HMAC-SHA256(k, qn)` for (userID, genID, qn).
func (c *QueryCache) Key(userID uuid.UUID, genID int, qn string) CacheKey {
	var out CacheKey
	copy(out[0:16], userID[:])
	binary.BigEndian.PutUint32(out[16:20], uint32(genID))
	mac := hmac.New(sha256.New, c.hmacKey[:])
	_, _ = mac.Write([]byte(qn))
	sum := mac.Sum(nil)
	copy(out[20:52], sum)
	return out
}

// Get looks up the cached query vector for (userID, genID, qn). On hit, it
// promotes the entry to the front of the LRU list and returns a defensive copy
// of the vector slice. If expired, the entry is evicted and (nil, false) is returned.
func (c *QueryCache) Get(userID uuid.UUID, genID int, qn string) ([]float32, bool) {
	if c == nil || userID == uuid.Nil || genID <= 0 {
		return nil, false
	}
	k := c.Key(userID, genID, qn)
	now := c.now()

	c.mu.Lock()
	defer c.mu.Unlock()

	elem, ok := c.items[k]
	if !ok {
		return nil, false
	}
	ent := elem.Value.(*cacheEntry)
	if !now.Before(ent.expiresAt) {
		c.removeElementLocked(elem)
		return nil, false
	}
	c.ll.MoveToFront(elem)
	out := make([]float32, len(ent.vec))
	copy(out, ent.vec)
	return out, true
}

// Put stores a defensive copy of vec under (userID, genID, qn) and evicts the
// least-recently-used entry if the cache exceeds maxEntries.
func (c *QueryCache) Put(userID uuid.UUID, genID int, qn string, vec []float32) {
	if c == nil || userID == uuid.Nil || genID <= 0 || len(vec) == 0 {
		return
	}
	k := c.Key(userID, genID, qn)
	vecCopy := make([]float32, len(vec))
	copy(vecCopy, vec)
	expiresAt := c.now().Add(c.ttl)

	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[k]; ok {
		ent := elem.Value.(*cacheEntry)
		ent.vec = vecCopy
		ent.expiresAt = expiresAt
		c.ll.MoveToFront(elem)
		return
	}

	ent := &cacheEntry{
		key:       k,
		vec:       vecCopy,
		expiresAt: expiresAt,
	}
	elem := c.ll.PushFront(ent)
	c.items[k] = elem

	for c.ll.Len() > c.maxEntries {
		oldest := c.ll.Back()
		if oldest == nil {
			break
		}
		c.removeElementLocked(oldest)
	}
}

// Len returns the current number of entries in the cache.
func (c *QueryCache) Len() int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}

// KeysSnapshot returns a copy of all active CacheKeys currently stored in the
// cache (in MRU-to-LRU order) for test inspection (e.g. TestCacheKeyNoRawQuery).
func (c *QueryCache) KeysSnapshot() []CacheKey {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]CacheKey, 0, c.ll.Len())
	for e := c.ll.Front(); e != nil; e = e.Next() {
		out = append(out, e.Value.(*cacheEntry).key)
	}
	return out
}

func (c *QueryCache) removeElementLocked(e *list.Element) {
	c.ll.Remove(e)
	ent := e.Value.(*cacheEntry)
	delete(c.items, ent.key)
}

func (*QueryCache) redactedSummary() string {
	return "QueryCache{HMACKey:[redacted]}"
}

// String redacts QueryCache so fmt never prints internal state.
func (c *QueryCache) String() string {
	return c.redactedSummary()
}

// GoString redacts QueryCache so fmt %#v never prints internal state.
func (c *QueryCache) GoString() string {
	return c.redactedSummary()
}
