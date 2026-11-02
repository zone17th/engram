package semantic_test

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zone17th/engram/apps/api/internal/clock"
	"github.com/zone17th/engram/apps/api/internal/semantic"
)

// TestCacheKeyIncludesUser verifies plan P05 mục 2.7 (D1, advisor-dec-243) and
// Task 12:
//   - User B querying the exact same `qn` on the same `generation_id` produces a
//     distinct CacheKey and NEVER hits User A's cached query vector.
//   - Different generations (`generation_id = 1` vs `generation_id = 2`) for the
//     same user and query NEVER share cached entries.
func TestCacheKeyIncludesUser(t *testing.T) {
	clk := clock.NewFixed(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	cache := semantic.NewQueryCache(100, 24*time.Hour, clk.Now)

	userA := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	userB := uuid.MustParse("22222222-2222-4000-8000-000000000002")
	qn := "tài khoản ngân hàng"

	vecA := []float32{0.6, 0.8, 0.0, 0.0}
	cache.Put(userA, 1, qn, vecA)

	// 1. User A hits on generation 1.
	gotA, ok := cache.Get(userA, 1, qn)
	if !ok {
		t.Fatal("expected cache hit for userA on generation 1")
	}
	if len(gotA) != len(vecA) || gotA[0] != vecA[0] || gotA[1] != vecA[1] {
		t.Fatalf("gotA = %v, want %v", gotA, vecA)
	}

	// 2. User B with the exact same query on generation 1 MUST miss.
	keyA := cache.Key(userA, 1, qn)
	keyB := cache.Key(userB, 1, qn)
	if keyA == keyB {
		t.Fatal("CacheKey collision between userA and userB")
	}
	if _, ok := cache.Get(userB, 1, qn); ok {
		t.Fatal("userB must NEVER hit userA's cached query vector")
	}

	// 3. Same userA with the exact same query on generation 2 MUST miss.
	keyGen2 := cache.Key(userA, 2, qn)
	if keyA == keyGen2 {
		t.Fatal("CacheKey collision between generation 1 and generation 2")
	}
	if _, ok := cache.Get(userA, 2, qn); ok {
		t.Fatal("generation 2 must NEVER reuse generation 1's cached query vector")
	}
}

// TestQueryCacheKeyIncludesQuery verifies plan P05 Task 12 (N1, BE-15):
//   - For the same user and the same generation, distinct normalized queries `qn`
//     produce distinct CacheKeys and never hit each other's cache entries (ensuring
//     that E2E readiness probes do not warm the query cache for subsequent scenario
//     queries).
//   - Also verifies TTL 24 h expiry and LRU eviction at maxEntries.
func TestQueryCacheKeyIncludesQuery(t *testing.T) {
	clk := clock.NewFixed(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	cache := semantic.NewQueryCache(3, 24*time.Hour, clk.Now)

	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	qProbe := "probe-readiness-sentinel"
	qScenario := "scenario-slow-query"

	k1 := cache.Key(userID, 1, qProbe)
	k2 := cache.Key(userID, 1, qScenario)
	if k1 == k2 {
		t.Fatal("expected distinct CacheKeys for distinct queries on same user+generation")
	}

	cache.Put(userID, 1, qProbe, []float32{1, 0, 0, 0})
	if _, ok := cache.Get(userID, 1, qScenario); ok {
		t.Fatal("distinct query qScenario must miss when only qProbe is cached")
	}

	// Verify LRU eviction at capacity 3:
	// Insert q2 and q3 (cache now holds: q3, q2, qProbe).
	// Touch qProbe so MRU order becomes: qProbe, q3, q2 (q2 is LRU).
	// Insert q4 -> q2 must be evicted while qProbe, q3, q4 remain.
	cache.Put(userID, 1, "query-two", []float32{0, 1, 0, 0})
	cache.Put(userID, 1, "query-three", []float32{0, 0, 1, 0})
	if _, ok := cache.Get(userID, 1, qProbe); !ok {
		t.Fatal("expected hit on qProbe before LRU eviction")
	}
	cache.Put(userID, 1, "query-four", []float32{0, 0, 0, 1})
	if cache.Len() != 3 {
		t.Fatalf("cache.Len() = %d, want 3", cache.Len())
	}
	if _, ok := cache.Get(userID, 1, "query-two"); ok {
		t.Fatal("expected LRU entry 'query-two' to be evicted")
	}
	if _, ok := cache.Get(userID, 1, qProbe); !ok {
		t.Fatal("expected promoted entry qProbe to remain in cache")
	}

	// Advance clock by 24 h -> TTL expires.
	clk.Advance(24 * time.Hour)
	if _, ok := cache.Get(userID, 1, qProbe); ok {
		t.Fatal("expected entry to expire after 24 h TTL")
	}
}

// TestCacheKeyNoRawQuery verifies plan P05 mục 2.7 (D1) and Task 12:
//   - Neither the 52-byte binary CacheKey nor any key stored in QueryCache nor
//     fmt representations (`%v`, `%+v`, `%#v`, `%s`) of QueryCache ever contain
//     the raw query substring `qn`.
func TestCacheKeyNoRawQuery(t *testing.T) {
	clk := clock.NewFixed(time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC))
	cache := semantic.NewQueryCache(100, 24*time.Hour, clk.Now)

	userID := uuid.MustParse("11111111-1111-4000-8000-000000000001")
	sentinelQN := "raw-query-secret-never-stored-in-key-987654"

	cache.Put(userID, 1, sentinelQN, []float32{0.5, 0.5, 0.5, 0.5})

	key := cache.Key(userID, 1, sentinelQN)
	if bytes.Contains(key[:], []byte(sentinelQN)) || bytes.Contains(key[:], []byte("raw-query-secret")) {
		t.Fatalf("CacheKey bytes contained raw query text: %x", key[:])
	}

	for i, k := range cache.KeysSnapshot() {
		if bytes.Contains(k[:], []byte(sentinelQN)) || bytes.Contains(k[:], []byte("raw-query-secret")) {
			t.Fatalf("KeysSnapshot[%d] contained raw query text: %x", i, k[:])
		}
	}

	formatted := fmt.Sprintf("%v %+v %#v %s", cache, cache, cache, cache)
	if strings.Contains(formatted, sentinelQN) || strings.Contains(formatted, "raw-query-secret") {
		t.Fatalf("formatted QueryCache leaked raw query: %s", formatted)
	}
}
