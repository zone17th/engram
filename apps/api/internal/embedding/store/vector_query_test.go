package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/obs"
)

type panicDB struct{}

func (panicDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	panic("unexpected Exec on panicDB")
}

func (panicDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("unexpected Query on panicDB")
}

func (panicDB) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("unexpected QueryRow on panicDB")
}

func (panicDB) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	panic("unexpected BeginTx on panicDB")
}

func TestVectorSearchValidationUnit(t *testing.T) {
	ctx := context.Background()
	pin := generation.Pin{
		GenID: 1,
		Identity: embedid.Identity{
			Provider:      generation.ProviderTEI,
			Model:         "tei/bge-m3",
			ModelVersion:  "v1",
			Dims:          3,
			Preprocessing: "v1",
		},
		MinCos:    0.55,
		ItemTable: "item_embedding_g1",
		TagTable:  "tag_embedding_g1",
	}
	knobs := store.DefaultVectorSearchKnobs()
	deadline := time.Now().Add(time.Second)
	uid := uuid.New()

	// 1. Nil DB handle rejected before SQL.
	if _, _, err := store.VectorSearch(ctx, nil, pin, uid, generation.CorpusItem, []float32{1, 0, 0}, 5, deadline, knobs); !errors.Is(err, store.ErrNilDB) {
		t.Fatalf("nil db err = %v, want ErrNilDB", err)
	}

	// Use a dummy non-nil VectorQueryDB that panics if any SQL method is called,
	// proving pre-SQL validation rejects bad inputs without touching the database.
	var noSQL panicDB

	// 2. Dims mismatch rejected before any SQL (plan mục 2.15, 2.16).
	if _, _, err := store.VectorSearch(ctx, noSQL, pin, uid, generation.CorpusItem, []float32{1, 0}, 5, deadline, knobs); !errors.Is(err, store.ErrDimsMismatch) {
		t.Fatalf("dims mismatch err = %v, want ErrDimsMismatch", err)
	}

	// 3. k <= 0 rejected before any SQL.
	if _, _, err := store.VectorSearch(ctx, noSQL, pin, uid, generation.CorpusItem, []float32{1, 0, 0}, 0, deadline, knobs); !errors.Is(err, store.ErrInvalidK) {
		t.Fatalf("k=0 err = %v, want ErrInvalidK", err)
	}
	if _, _, err := store.VectorSearch(ctx, noSQL, pin, uid, generation.CorpusItem, []float32{1, 0, 0}, -3, deadline, knobs); !errors.Is(err, store.ErrInvalidK) {
		t.Fatalf("k=-3 err = %v, want ErrInvalidK", err)
	}

	// 4. Invalid corpus rejected before any SQL.
	if _, _, err := store.VectorSearch(ctx, noSQL, pin, uid, generation.Corpus("entry"), []float32{1, 0, 0}, 5, deadline, knobs); !errors.Is(err, generation.ErrInvalidCorpus) {
		t.Fatalf("bad corpus err = %v, want ErrInvalidCorpus", err)
	}

	// 5. Invalid table name on Pin rejected before any SQL.
	badPin := pin
	badPin.ItemTable = "item_embedding_g1; DROP TABLE item"
	if _, _, err := store.VectorSearch(ctx, noSQL, badPin, uid, generation.CorpusItem, []float32{1, 0, 0}, 5, deadline, knobs); !errors.Is(err, generation.ErrInvalidTableName) {
		t.Fatalf("bad table name err = %v, want ErrInvalidTableName", err)
	}

	// 6. Invalid knobs (FallbackMaxVectors < ExactMaxVectors or bad IterativeScan) rejected before any SQL.
	badKnobs := knobs
	badKnobs.ExactMaxVectors = 100
	badKnobs.FallbackMaxVectors = 50
	if _, _, err := store.VectorSearch(ctx, noSQL, pin, uid, generation.CorpusItem, []float32{1, 0, 0}, 5, deadline, badKnobs); !errors.Is(err, store.ErrInvalidKnobs) {
		t.Fatalf("FallbackMax < ExactMax err = %v, want ErrInvalidKnobs", err)
	}
	badIterKnobs := knobs
	badIterKnobs.IterativeScan = "relaxed_order; SET role postgres"
	if _, _, err := store.VectorSearch(ctx, noSQL, pin, uid, generation.CorpusItem, []float32{1, 0, 0}, 5, deadline, badIterKnobs); !errors.Is(err, store.ErrInvalidKnobs) {
		t.Fatalf("bad IterativeScan err = %v, want ErrInvalidKnobs", err)
	}

	// 7. Caller context.Canceled stays context.Canceled.
	canceledCtx, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, err := store.VectorSearch(canceledCtx, noSQL, pin, uid, generation.CorpusItem, []float32{1, 0, 0}, 5, deadline, knobs); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled ctx err = %v, want context.Canceled", err)
	}

	// 8. Expired deadline returns empty partial result + TimedOut=true, err=nil (never panics).
	hits, stats, err := store.VectorSearch(ctx, noSQL, pin, uid, generation.CorpusItem, []float32{1, 0, 0}, 5, time.Now().Add(-time.Second), knobs)
	if err != nil {
		t.Fatalf("expired deadline err = %v, want nil", err)
	}
	if !stats.TimedOut || len(hits) != 0 {
		t.Fatalf("expired deadline stats=%+v hits=%+v, want TimedOut=true and empty hits", stats, hits)
	}
}

// TestCountBoundaries verifies all boundary transitions of the single capped
// count (`SELECT count(*) FROM (SELECT 1 FROM <tbl> WHERE user_id=$1 LIMIT $fallbackMax+1) s`)
// against both `ExactMaxVectors` and `FallbackMaxVectors` (plan P05 mục 2.16,
// Task 14, BE-2):
//   - N / N+1 against ExactMaxVectors (exact at count == exactMax, ANN at count == exactMax+1)
//     using injected small caps (5/6, matching the 5000/5001 boundary semantics).
//   - M / M+1 against FallbackMaxVectors under forced underfill (ann_fallback_exact
//     at count == fallbackMax, ann_short at count == fallbackMax+1) using injected
//     small caps (8/9, matching the 20000/20001 boundary semantics).
//   - ExactMaxVectors == 0 (benchmark force-ANN) always takes ANN even for 1 row
//     while still honouring FallbackMaxVectors (falls back to exact when
//     count <= FallbackMaxVectors, refuses fallback when count == FallbackMaxVectors+1).
func TestCountBoundaries(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	// Injected thresholds: exactMax = 5 (representing 5000/5001), fallbackMax = 8
	// (representing 20000/20001). Semantics and SQL comparisons are identical.
	const (
		exactMax    = 5
		fallbackMax = 8
	)

	g1, pin := seedGenerationForVectorSearch(t, ctx, pool, 1, 3, 4, 0.50, true)
	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "boundaries@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}

	hash := makeHash(0x81)
	insertOneItem := func(idx int) uuid.UUID {
		it, err := q.InsertItem(ctx, gen.InsertItemParams{
			UserID:         u.ID,
			Name:           "Boundary Item " + uuid.NewString(),
			NameNormalized: "boundary item " + string(rune('a'+(idx%26))) + uuid.NewString()[:8],
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, u.ID, it.ID, []float32{1, 0, 0}, hash); err != nil {
			t.Fatal(err)
		}
		return it.ID
	}

	// Seed 5 items -> count == exactMax (5 == 5, representing 5000).
	for i := range exactMax {
		insertOneItem(i)
	}

	knobs := store.DefaultVectorSearchKnobs()
	knobs.ExactMaxVectors = exactMax
	knobs.FallbackMaxVectors = fallbackMax

	// 1. At count == exactMax (5): path must be "exact".
	hits, stats, err := store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusItem, []float32{1, 0, 0}, 3, time.Now().Add(2*time.Second), knobs,
	)
	if err != nil {
		t.Fatalf("count == exactMax: %v", err)
	}
	if stats.CappedCount != exactMax || stats.Path != store.VectorPathExact || len(hits) != 3 {
		t.Fatalf("at count == exactMax (%d): stats=%+v len(hits)=%d, want CappedCount=%d Path=exact len=3",
			exactMax, stats, len(hits), exactMax)
	}

	// 2. With ExactMaxVectors == 0 (benchmark force-ANN): even at count == 5,
	// path must be ANN (not exact), and when k=10 causes underfill (5 < 10)
	// with count (5) <= FallbackMaxVectors (8), it still honours FallbackMaxVectors
	// and takes "ann_fallback_exact".
	zeroKnobs := knobs
	zeroKnobs.ExactMaxVectors = 0
	_, statsZeroANN, err := store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusItem, []float32{1, 0, 0}, 3, time.Now().Add(2*time.Second), zeroKnobs,
	)
	if err != nil {
		t.Fatalf("ExactMaxVectors=0 (k=3): %v", err)
	}
	if statsZeroANN.Path != store.VectorPathANN {
		t.Fatalf("ExactMaxVectors=0 (k=3): stats.Path = %q, want %q", statsZeroANN.Path, store.VectorPathANN)
	}

	_, statsZeroFallback, err := store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusItem, []float32{1, 0, 0}, 10, time.Now().Add(2*time.Second), zeroKnobs,
	)
	if err != nil {
		t.Fatalf("ExactMaxVectors=0 (k=10 underfill <= fallbackMax): %v", err)
	}
	if statsZeroFallback.Path != store.VectorPathANNFallbackExact {
		t.Fatalf("ExactMaxVectors=0 (k=10 underfill <= fallbackMax): stats.Path = %q, want %q",
			statsZeroFallback.Path, store.VectorPathANNFallbackExact)
	}

	// 3. Insert 6th item -> count == exactMax + 1 (6 > 5, representing 5001):
	// with k=3 (no underfill), path transitions from "exact" to "ann".
	insertOneItem(exactMax)
	hits, stats, err = store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusItem, []float32{1, 0, 0}, 3, time.Now().Add(2*time.Second), knobs,
	)
	if err != nil {
		t.Fatalf("count == exactMax+1: %v", err)
	}
	if stats.CappedCount != exactMax+1 || stats.Path != store.VectorPathANN || len(hits) != 3 {
		t.Fatalf("at count == exactMax+1 (%d): stats=%+v len(hits)=%d, want CappedCount=%d Path=ann len=3",
			exactMax+1, stats, len(hits), exactMax+1)
	}

	// 4. Seed up to count == fallbackMax (8, representing 20000).
	// Request k=20 so ANN candidates before threshold filter (8) < k (20) -> underfill.
	// Since count (8) <= fallbackMax (8) and budget >= 30ms, path must be "ann_fallback_exact".
	for i := exactMax + 1; i < fallbackMax; i++ {
		insertOneItem(i)
	}
	hits, stats, err = store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusItem, []float32{1, 0, 0}, 20, time.Now().Add(2*time.Second), knobs,
	)
	if err != nil {
		t.Fatalf("count == fallbackMax: %v", err)
	}
	if stats.CappedCount != fallbackMax || stats.Path != store.VectorPathANNFallbackExact || !stats.FallbackUsed || len(hits) != fallbackMax {
		t.Fatalf("at count == fallbackMax (%d): stats=%+v len(hits)=%d, want CappedCount=%d Path=ann_fallback_exact len=%d",
			fallbackMax, stats, len(hits), fallbackMax, fallbackMax)
	}

	// 5. Insert 9th item -> count == fallbackMax + 1 (9 > 8, representing 20001):
	// Capped count stops at fallbackMax + 1 (9). Request k=20 -> underfill (9 < 20),
	// and because count (9) > fallbackMax (8), exact fallback is blocked and path
	// transitions to "ann_short" (also under ExactMaxVectors == 0).
	insertOneItem(fallbackMax)
	_, m := obs.NewRegistry()
	knobs.Metrics = m.Search
	beforeShort := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_short"))
	beforeUnderfill := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item"))

	hits, stats, err = store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusItem, []float32{1, 0, 0}, 20, time.Now().Add(2*time.Second), knobs,
	)
	if err != nil {
		t.Fatalf("count == fallbackMax+1: %v", err)
	}
	if stats.CappedCount != fallbackMax+1 || stats.Path != store.VectorPathANNShort || stats.FallbackUsed {
		t.Fatalf("at count == fallbackMax+1 (%d): stats=%+v, want CappedCount=%d Path=ann_short FallbackUsed=false",
			fallbackMax+1, stats, fallbackMax+1)
	}
	if len(hits) != fallbackMax+1 {
		t.Fatalf("at count == fallbackMax+1: len(hits) = %d, want %d", len(hits), fallbackMax+1)
	}
	if got := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_short")) - beforeShort; got != 1 {
		t.Fatalf("VectorPathTotal{item,ann_short} delta = %v, want 1", got)
	}
	if got := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item")) - beforeUnderfill; got != 1 {
		t.Fatalf("VectorUnderfillTotal{item} delta = %v, want 1", got)
	}

	// Also verify ExactMaxVectors == 0 still honours the fallback cap at fallbackMax + 1.
	zeroKnobs.Metrics = m.Search
	_, statsZeroCap, err := store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusItem, []float32{1, 0, 0}, 20, time.Now().Add(2*time.Second), zeroKnobs,
	)
	if err != nil {
		t.Fatalf("ExactMaxVectors=0 at fallbackMax+1: %v", err)
	}
	if statsZeroCap.Path != store.VectorPathANNShort || statsZeroCap.FallbackUsed {
		t.Fatalf("ExactMaxVectors=0 at fallbackMax+1: stats=%+v, want Path=ann_short FallbackUsed=false", statsZeroCap)
	}
}

func TestWhaleNeverFallsBackToExact(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	// Per Task 14 contract: whale tenant has count == FallbackMaxVectors + 1;
	// use small injected caps so CI Go checks stays fast while exercising the
	// exact same capped count (`LIMIT fallbackMax + 1`) and forced underfill logic.
	const (
		exactMax    = 3
		fallbackMax = 6
	)

	g1, pin := seedGenerationForVectorSearch(t, ctx, pool, 1, 3, 4, 0.50, true)
	whale, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "whale@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "whale-coloc@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}

	hash := makeHash(0x82)
	// Insert fallbackMax + 5 (11) items for the whale so the capped count query
	// (`LIMIT fallbackMax + 1` = 7) returns exactly fallbackMax + 1 = 7.
	for i := range fallbackMax + 5 {
		it, err := q.InsertItem(ctx, gen.InsertItemParams{
			UserID:         whale.ID,
			Name:           "Whale Item " + uuid.NewString(),
			NameNormalized: "whale item " + string(rune('a'+(i%26))) + uuid.NewString()[:8],
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, whale.ID, it.ID, []float32{1, 0, 0}, hash); err != nil {
			t.Fatal(err)
		}
	}
	// Also insert 20 items for another user so the partition has extra tuples.
	for i := range 20 {
		it, err := q.InsertItem(ctx, gen.InsertItemParams{
			UserID:         other.ID,
			Name:           "Other Item " + uuid.NewString(),
			NameNormalized: "other item " + string(rune('a'+(i%26))) + uuid.NewString()[:8],
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, other.ID, it.ID, []float32{0, 1, 0}, hash); err != nil {
			t.Fatal(err)
		}
	}

	_, m := obs.NewRegistry()
	knobs := store.DefaultVectorSearchKnobs()
	knobs.ExactMaxVectors = exactMax
	knobs.FallbackMaxVectors = fallbackMax
	knobs.Metrics = m.Search

	// Force underfill on the whale (request k = 20 while whale only has 11 rows,
	// and also set IterativeScan = off, EfSearch = 1, MaxScanTuples = 1).
	knobs.IterativeScan = store.IterativeScanOff
	knobs.EfSearch = 1
	knobs.MaxScanTuples = 1

	beforeFallbackExact := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_fallback_exact"))
	beforeShort := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_short"))
	beforeUnderfill := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item"))

	_, stats, err := store.VectorSearch(
		ctx, pool, pin, whale.ID, generation.CorpusItem, []float32{1, 0, 0}, 20, time.Now().Add(5*time.Second), knobs,
	)
	if err != nil {
		t.Fatalf("whale VectorSearch: %v", err)
	}
	if stats.CappedCount != fallbackMax+1 {
		t.Fatalf("whale stats.CappedCount = %d, want %d (fallbackMax+1)", stats.CappedCount, fallbackMax+1)
	}
	if stats.Path == store.VectorPathANNFallbackExact || stats.Path == store.VectorPathExact || stats.FallbackUsed {
		t.Fatalf("whale must NEVER fall back to exact: got stats=%+v", stats)
	}
	if stats.Path != store.VectorPathANNShort {
		t.Fatalf("whale forced underfill stats.Path = %q, want %q", stats.Path, store.VectorPathANNShort)
	}
	if got := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_fallback_exact")) - beforeFallbackExact; got != 0 {
		t.Fatalf("VectorPathTotal{item,ann_fallback_exact} delta = %v, want 0", got)
	}
	if got := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_short")) - beforeShort; got != 1 {
		t.Fatalf("VectorPathTotal{item,ann_short} delta = %v, want 1", got)
	}
	if got := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item")) - beforeUnderfill; got != 1 {
		t.Fatalf("VectorUnderfillTotal{item} delta = %v, want 1", got)
	}
}

func TestUnderfillFallbackWithinBudget(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	g1, pin := seedGenerationForVectorSearch(t, ctx, pool, 1, 3, 4, 0.50, true)
	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "budget@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}

	hash := makeHash(0x83)
	// Seed 4 items for u, set ExactMaxVectors = 2, FallbackMaxVectors = 10, and
	// query with k = 10 so ANN always underfills (4 < 10) while count (4) <= FallbackMaxVectors (10).
	for i := range 4 {
		it, err := q.InsertItem(ctx, gen.InsertItemParams{
			UserID:         u.ID,
			Name:           "Budget Item " + string(rune('1'+i)),
			NameNormalized: "budget item " + string(rune('1'+i)),
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, u.ID, it.ID, []float32{1, 0, 0}, hash); err != nil {
			t.Fatal(err)
		}
	}

	_, m := obs.NewRegistry()

	// Case 1: Sufficient remaining budget (remaining = 60ms >= FallbackMinBudget = 30ms)
	// -> executes exact fallback (`ann_fallback_exact`).
	// Real context deadline comes from time.Now() sampled at call time via
	// BranchTimeout (zero caller deadline), while simulated elapsed time is
	// advanced deterministically via knobs.Now + knobs.AfterANN with zero
	// dependence on the wall-clock calendar date/time (VQ-1).
	clock1 := time.Now()
	knobsOK := store.DefaultVectorSearchKnobs()
	knobsOK.ExactMaxVectors = 2
	knobsOK.FallbackMaxVectors = 10
	knobsOK.BranchTimeout = 80 * time.Millisecond
	knobsOK.FallbackMinBudget = 30 * time.Millisecond
	knobsOK.Metrics = m.Search
	knobsOK.Now = func() time.Time { return clock1 }
	knobsOK.AfterANN = func() {
		// Advance clock by 20ms during ANN -> 60ms remaining >= 30ms FallbackMinBudget.
		clock1 = clock1.Add(20 * time.Millisecond)
	}

	beforeFallbackOK := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_fallback_exact"))
	beforeShortOK := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_short"))
	beforeUnderfillOK := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item"))

	hitsOK, statsOK, err := store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusItem, []float32{1, 0, 0}, 10, time.Time{}, knobsOK,
	)
	if err != nil {
		t.Fatalf("VectorSearch with sufficient budget: %v", err)
	}
	if statsOK.Path != store.VectorPathANNFallbackExact || !statsOK.FallbackUsed || len(hitsOK) != 4 {
		t.Fatalf("with sufficient budget: stats=%+v len(hits)=%d, want Path=ann_fallback_exact FallbackUsed=true len=4",
			statsOK, len(hitsOK))
	}
	if got := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_fallback_exact")) - beforeFallbackOK; got != 1 {
		t.Fatalf("VectorPathTotal{item,ann_fallback_exact} delta = %v, want 1", got)
	}
	if got := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_short")) - beforeShortOK; got != 0 {
		t.Fatalf("VectorPathTotal{item,ann_short} delta = %v, want 0", got)
	}
	if got := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item")) - beforeUnderfillOK; got != 0 {
		t.Fatalf("VectorUnderfillTotal{item} delta = %v, want 0", got)
	}

	// Case 2: Remaining budget after ANN is below FallbackMinBudget (remaining = 15ms < 30ms)
	// -> skips exact fallback, returns partial ANN results (`ann_short`), and increments VectorUnderfillTotal.
	clock2 := time.Now()
	knobsExhausted := store.DefaultVectorSearchKnobs()
	knobsExhausted.ExactMaxVectors = 2
	knobsExhausted.FallbackMaxVectors = 10
	knobsExhausted.BranchTimeout = 80 * time.Millisecond
	knobsExhausted.FallbackMinBudget = 30 * time.Millisecond
	knobsExhausted.Metrics = m.Search
	knobsExhausted.Now = func() time.Time { return clock2 }
	knobsExhausted.AfterANN = func() {
		// Advance clock by 65ms during ANN -> only 15ms remaining (< 30ms FallbackMinBudget).
		clock2 = clock2.Add(65 * time.Millisecond)
	}

	beforeFallbackEx := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_fallback_exact"))
	beforeShortEx := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_short"))
	beforeUnderfillEx := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item"))

	hitsEx, statsEx, err := store.VectorSearch(
		ctx, pool, pin, u.ID, generation.CorpusItem, []float32{1, 0, 0}, 10, time.Time{}, knobsExhausted,
	)
	if err != nil {
		t.Fatalf("VectorSearch with exhausted fallback budget: %v", err)
	}
	if statsEx.Path != store.VectorPathANNShort || statsEx.FallbackUsed {
		t.Fatalf("with exhausted budget: stats=%+v, want Path=ann_short FallbackUsed=false", statsEx)
	}
	if len(hitsEx) != 4 {
		t.Fatalf("with exhausted budget: expected partial ANN hits (4), got %d", len(hitsEx))
	}
	if got := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_fallback_exact")) - beforeFallbackEx; got != 0 {
		t.Fatalf("VectorPathTotal{item,ann_fallback_exact} delta = %v, want 0", got)
	}
	if got := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_short")) - beforeShortEx; got != 1 {
		t.Fatalf("VectorPathTotal{item,ann_short} delta = %v, want 1", got)
	}
	if got := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item")) - beforeUnderfillEx; got != 1 {
		t.Fatalf("VectorUnderfillTotal{item} delta = %v, want 1", got)
	}
}

func TestErrorsCarryNoRowData(t *testing.T) {
	// Ensure error strings from VectorSearch validation never include vector floats or table data.
	ctx := context.Background()
	pin := generation.Pin{
		GenID: 1,
		Identity: embedid.Identity{
			Provider:      generation.ProviderTEI,
			Model:         "tei/bge-m3",
			ModelVersion:  "v1",
			Dims:          3,
			Preprocessing: "v1",
		},
		MinCos:    0.55,
		ItemTable: "item_embedding_g1",
		TagTable:  "tag_embedding_g1",
	}
	var noSQL panicDB
	_, _, err := store.VectorSearch(
		ctx,
		noSQL,
		pin,
		uuid.New(),
		generation.CorpusItem,
		[]float32{0.123456, 0.654321},
		5,
		time.Now().Add(time.Second),
		store.DefaultVectorSearchKnobs(),
	)
	if err == nil {
		t.Fatal("expected ErrDimsMismatch")
	}
	if strings.Contains(err.Error(), "0.123456") || strings.Contains(err.Error(), "0.654321") {
		t.Fatalf("error leaked vector float values: %v", err)
	}
}

// --- Deterministic fake pgx.Rows / pgx.BatchResults / pgx.Tx / VectorQueryDB for VQ-2 ---

type fakeCountRow struct {
	count int
	err   error
}

func (r fakeCountRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*dest[0].(*int) = r.count
	return nil
}

type fakeVectorRows struct {
	corpus  generation.Corpus
	isANN   bool
	annRows []fakeANNRowData
	exRows  []store.Hit
	idx     int
	iterErr error
	scanErr error
}

type fakeANNRowData struct {
	candidates int
	hit        *store.Hit
}

func (r *fakeVectorRows) Close()                                       {}
func (r *fakeVectorRows) Err() error                                   { return r.iterErr }
func (r *fakeVectorRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *fakeVectorRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *fakeVectorRows) Values() ([]any, error)                       { return nil, nil }
func (r *fakeVectorRows) RawValues() [][]byte                          { return nil }
func (r *fakeVectorRows) Conn() *pgx.Conn                              { return nil }

func (r *fakeVectorRows) Next() bool {
	if r.isANN {
		if r.idx < len(r.annRows) {
			r.idx++
			return true
		}
		return false
	}
	if r.idx < len(r.exRows) {
		r.idx++
		return true
	}
	return false
}

func (r *fakeVectorRows) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	if r.isANN {
		row := r.annRows[r.idx-1]
		*dest[0].(*int) = row.candidates
		if row.hit == nil {
			*dest[1].(**uuid.UUID) = nil
			return nil
		}
		h := row.hit
		idCopy := h.ID
		textCopy := h.Name
		if r.corpus == generation.CorpusTag {
			textCopy = h.Display
		}
		cntCopy := h.Count
		luCopy := h.LastUsedAt
		crCopy := h.CreatedAt
		distCopy := h.Dist
		cosCopy := h.Cos

		*dest[1].(**uuid.UUID) = &idCopy
		*dest[2].(**string) = &textCopy
		*dest[3].(**int) = &cntCopy
		*dest[4].(**time.Time) = &luCopy
		*dest[5].(**time.Time) = &crCopy
		*dest[6].(**float64) = &distCopy
		*dest[7].(**float64) = &cosCopy
		return nil
	}

	h := r.exRows[r.idx-1]
	*dest[0].(*uuid.UUID) = h.ID
	if r.corpus == generation.CorpusTag {
		*dest[1].(*string) = h.Display
	} else {
		*dest[1].(*string) = h.Name
	}
	*dest[2].(*int) = h.Count
	*dest[3].(*time.Time) = h.LastUsedAt
	*dest[4].(*time.Time) = h.CreatedAt
	*dest[5].(*float64) = h.Dist
	*dest[6].(*float64) = h.Cos
	return nil
}

type fakeBatchResults struct {
	rows     pgx.Rows
	execErr  error
	queryErr error
	closeErr error
}

func (b *fakeBatchResults) Exec() (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, b.execErr
}

func (b *fakeBatchResults) Query() (pgx.Rows, error) {
	if b.queryErr != nil {
		return nil, b.queryErr
	}
	return b.rows, nil
}

func (b *fakeBatchResults) QueryRow() pgx.Row { return fakeCountRow{} }
func (b *fakeBatchResults) Close() error      { return b.closeErr }

type fakeTx struct {
	br        pgx.BatchResults
	commitErr error
}

func (t *fakeTx) Begin(context.Context) (pgx.Tx, error) { return t, nil }
func (t *fakeTx) Commit(context.Context) error          { return t.commitErr }
func (t *fakeTx) Rollback(context.Context) error        { return nil }
func (t *fakeTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, nil
}
func (t *fakeTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return t.br }
func (t *fakeTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }

func (t *fakeTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, nil
}

func (t *fakeTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}
func (t *fakeTx) Query(context.Context, string, ...any) (pgx.Rows, error) { return nil, nil }
func (t *fakeTx) QueryRow(context.Context, string, ...any) pgx.Row        { return fakeCountRow{} }
func (t *fakeTx) Conn() *pgx.Conn                                         { return nil }

type fakeVectorDB struct {
	count int
	txs   []*fakeTx
	txIdx int

	// waitBranchExpiry makes BeginTx block until the branch context handed to it
	// is done, then records ctx.Err() in branchErr. This deterministically
	// reproduces "the branch deadline expired before the error was classified"
	// without sleeping a guessed duration or racing a timer.
	waitBranchExpiry bool
	branchErr        error
}

func (db *fakeVectorDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (db *fakeVectorDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, nil
}

func (db *fakeVectorDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return fakeCountRow{count: db.count}
}

func (db *fakeVectorDB) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	if db.waitBranchExpiry {
		<-ctx.Done()
		db.branchErr = ctx.Err()
	}
	tx := db.txs[db.txIdx]
	db.txIdx++
	return tx, nil
}

func TestVectorSearchTimeoutPreservesPartialHits(t *testing.T) {
	ctx := context.Background()
	pin := generation.Pin{
		GenID: 1,
		Identity: embedid.Identity{
			Provider:      generation.ProviderTEI,
			Model:         "tei/bge-m3",
			ModelVersion:  "v1",
			Dims:          3,
			Preprocessing: "v1",
		},
		MinCos:    0.55,
		ItemTable: "item_embedding_g1",
		TagTable:  "tag_embedding_g1",
	}
	uid := uuid.New()
	qvec := []float32{1, 0, 0}
	now := time.Now().UTC().Truncate(time.Microsecond)

	id1 := uuid.MustParse("00000000-0000-0000-0000-000000000010")
	id2 := uuid.MustParse("00000000-0000-0000-0000-000000000020")
	id3 := uuid.MustParse("00000000-0000-0000-0000-000000000030")

	hitFar := store.Hit{ID: id3, Name: "far", Count: 1, LastUsedAt: now, CreatedAt: now, Dist: 0.25, Cos: 0.75}
	hitTieHi := store.Hit{ID: id2, Name: "tie-hi", Count: 2, LastUsedAt: now, CreatedAt: now, Dist: 0.10, Cos: 0.90}
	hitTieLo := store.Hit{ID: id1, Name: "tie-lo", Count: 3, LastUsedAt: now, CreatedAt: now, Dist: 0.10, Cos: 0.90}

	sqlTimeout57014 := &pgconn.PgError{Code: "57014", Message: "canceling statement due to statement timeout"}
	otherSQLErr := &pgconn.PgError{Code: "42P01", Message: "undefined_table"}

	// 1. Exact path: yields 3 unsorted rows then rows.Err() returns SQLSTATE 57014.
	// Must return all 3 partial hits sorted by (Dist ASC, ID ASC), Returned=3, TimedOut=true, err=nil.
	{
		_, m := obs.NewRegistry()
		knobs := store.DefaultVectorSearchKnobs()
		knobs.ExactMaxVectors = 5
		knobs.FallbackMaxVectors = 10
		knobs.Metrics = m.Search

		db := &fakeVectorDB{
			count: 3,
			txs: []*fakeTx{
				{
					br: &fakeBatchResults{
						rows: &fakeVectorRows{
							corpus:  generation.CorpusItem,
							isANN:   false,
							exRows:  []store.Hit{hitFar, hitTieHi, hitTieLo},
							iterErr: sqlTimeout57014,
						},
					},
				},
			},
		}

		hits, stats, err := store.VectorSearch(ctx, db, pin, uid, generation.CorpusItem, qvec, 5, time.Now().Add(time.Second), knobs)
		if err != nil {
			t.Fatalf("exact 57014 after partial rows: err = %v, want nil", err)
		}
		if !stats.TimedOut || stats.Path != store.VectorPathExact || stats.Returned != 3 || stats.CappedCount != 3 {
			t.Fatalf("exact 57014 stats = %+v, want Path=exact TimedOut=true Returned=3 CappedCount=3", stats)
		}
		wantIDs := []uuid.UUID{id1, id2, id3}
		if len(hits) != 3 || hits[0].ID != wantIDs[0] || hits[1].ID != wantIDs[1] || hits[2].ID != wantIDs[2] {
			t.Fatalf("exact 57014 hits = %+v, want sorted %v", hits, wantIDs)
		}
	}

	// 2. Exact path: rows scan cleanly, then read-only tx.Commit returns context.DeadlineExceeded.
	// Because the transaction is read-only, already-scanned hits remain valid and must be returned.
	{
		knobs := store.DefaultVectorSearchKnobs()
		knobs.ExactMaxVectors = 5
		knobs.FallbackMaxVectors = 10

		db := &fakeVectorDB{
			count: 2,
			txs: []*fakeTx{
				{
					br: &fakeBatchResults{
						rows: &fakeVectorRows{
							corpus: generation.CorpusItem,
							isANN:  false,
							exRows: []store.Hit{hitTieHi, hitTieLo},
						},
					},
					commitErr: context.DeadlineExceeded,
				},
			},
		}

		hits, stats, err := store.VectorSearch(ctx, db, pin, uid, generation.CorpusItem, qvec, 5, time.Now().Add(time.Second), knobs)
		if err != nil {
			t.Fatalf("exact commit DeadlineExceeded: err = %v, want nil", err)
		}
		if !stats.TimedOut || stats.Path != store.VectorPathExact || stats.Returned != 2 {
			t.Fatalf("exact commit DeadlineExceeded stats = %+v, want Path=exact TimedOut=true Returned=2", stats)
		}
		if len(hits) != 2 || hits[0].ID != id1 || hits[1].ID != id2 {
			t.Fatalf("exact commit DeadlineExceeded hits = %+v, want [%s, %s]", hits, id1, id2)
		}
	}

	// 3. ANN path: yields 2 out-of-order rows (with ann_candidates = 2 < k = 5) then 57014 on rows.Err().
	// Must return both hits sorted by (Dist ASC, ID ASC), ANNCandidates=2, Returned=2,
	// Path=ann_short, Underfill=true, TimedOut=true, err=nil, and increment VectorUnderfillTotal.
	{
		_, m := obs.NewRegistry()
		knobs := store.DefaultVectorSearchKnobs()
		knobs.ExactMaxVectors = 2
		knobs.FallbackMaxVectors = 10
		knobs.Metrics = m.Search

		beforeShort := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_short"))
		beforeUnderfill := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item"))

		hFar := hitFar
		hLo := hitTieLo
		db := &fakeVectorDB{
			count: 6,
			txs: []*fakeTx{
				{
					br: &fakeBatchResults{
						rows: &fakeVectorRows{
							corpus: generation.CorpusItem,
							isANN:  true,
							annRows: []fakeANNRowData{
								{candidates: 2, hit: &hFar},
								{candidates: 2, hit: &hLo},
							},
							iterErr: sqlTimeout57014,
						},
					},
				},
			},
		}

		hits, stats, err := store.VectorSearch(ctx, db, pin, uid, generation.CorpusItem, qvec, 5, time.Now().Add(time.Second), knobs)
		if err != nil {
			t.Fatalf("ann 57014 after partial rows: err = %v, want nil", err)
		}
		if !stats.TimedOut || !stats.Underfill || stats.Path != store.VectorPathANNShort || stats.ANNCandidates != 2 || stats.Returned != 2 {
			t.Fatalf("ann 57014 stats = %+v, want Path=ann_short TimedOut=true Underfill=true ANNCandidates=2 Returned=2", stats)
		}
		if len(hits) != 2 || hits[0].ID != id1 || hits[1].ID != id3 {
			t.Fatalf("ann 57014 hits = %+v, want sorted [%s, %s]", hits, id1, id3)
		}
		if got := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann_short")) - beforeShort; got != 1 {
			t.Fatalf("VectorPathTotal{item,ann_short} delta = %v, want 1", got)
		}
		if got := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item")) - beforeUnderfill; got != 1 {
			t.Fatalf("VectorUnderfillTotal{item} delta = %v, want 1", got)
		}
	}

	// 4. ANN path: rows scan cleanly (ann_candidates = 3 >= k = 3), then batch Close returns DeadlineExceeded.
	// Must return all 3 hits sorted by (Dist ASC, ID ASC), ANNCandidates=3, Returned=3,
	// Path=ann, Underfill=false, TimedOut=true, err=nil.
	{
		_, m := obs.NewRegistry()
		knobs := store.DefaultVectorSearchKnobs()
		knobs.ExactMaxVectors = 2
		knobs.FallbackMaxVectors = 10
		knobs.Metrics = m.Search

		beforeANN := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann"))
		beforeUnderfill := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item"))

		hFar := hitFar
		hHi := hitTieHi
		hLo := hitTieLo
		db := &fakeVectorDB{
			count: 6,
			txs: []*fakeTx{
				{
					br: &fakeBatchResults{
						rows: &fakeVectorRows{
							corpus: generation.CorpusItem,
							isANN:  true,
							annRows: []fakeANNRowData{
								{candidates: 3, hit: &hFar},
								{candidates: 3, hit: &hHi},
								{candidates: 3, hit: &hLo},
							},
						},
						closeErr: context.DeadlineExceeded,
					},
				},
			},
		}

		hits, stats, err := store.VectorSearch(ctx, db, pin, uid, generation.CorpusItem, qvec, 3, time.Now().Add(time.Second), knobs)
		if err != nil {
			t.Fatalf("ann batch close DeadlineExceeded: err = %v, want nil", err)
		}
		if !stats.TimedOut || stats.Underfill || stats.Path != store.VectorPathANN || stats.ANNCandidates != 3 || stats.Returned != 3 {
			t.Fatalf("ann batch close DeadlineExceeded stats = %+v, want Path=ann TimedOut=true Underfill=false ANNCandidates=3 Returned=3", stats)
		}
		if len(hits) != 3 || hits[0].ID != id1 || hits[1].ID != id2 || hits[2].ID != id3 {
			t.Fatalf("ann batch close DeadlineExceeded hits = %+v, want sorted [%s, %s, %s]", hits, id1, id2, id3)
		}
		if got := counterValue(t, m.Search.VectorPathTotal.WithLabelValues("item", "ann")) - beforeANN; got != 1 {
			t.Fatalf("VectorPathTotal{item,ann} delta = %v, want 1", got)
		}
		if got := counterValue(t, m.Search.VectorUnderfillTotal.WithLabelValues("item")) - beforeUnderfill; got != 0 {
			t.Fatalf("VectorUnderfillTotal{item} delta = %v, want 0", got)
		}
	}

	// 5. Caller context.Canceled mid-stream stays context.Canceled (never treated as partial success).
	{
		knobs := store.DefaultVectorSearchKnobs()
		knobs.ExactMaxVectors = 5
		knobs.FallbackMaxVectors = 10

		hLo := hitTieLo
		db := &fakeVectorDB{
			count: 2,
			txs: []*fakeTx{
				{
					br: &fakeBatchResults{
						rows: &fakeVectorRows{
							corpus:  generation.CorpusItem,
							isANN:   false,
							exRows:  []store.Hit{hLo},
							iterErr: context.Canceled,
						},
					},
				},
			},
		}

		_, _, err := store.VectorSearch(ctx, db, pin, uid, generation.CorpusItem, qvec, 5, time.Now().Add(time.Second), knobs)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("caller context.Canceled mid-stream: err = %v, want context.Canceled", err)
		}
	}

	// 6. Unrelated SQL error (e.g. 42P01) after partial rows stays an error (never silently success).
	{
		knobs := store.DefaultVectorSearchKnobs()
		knobs.ExactMaxVectors = 2
		knobs.FallbackMaxVectors = 10

		hLo := hitTieLo
		db := &fakeVectorDB{
			count: 6,
			txs: []*fakeTx{
				{
					br: &fakeBatchResults{
						rows: &fakeVectorRows{
							corpus: generation.CorpusItem,
							isANN:  true,
							annRows: []fakeANNRowData{
								{candidates: 1, hit: &hLo},
							},
							iterErr: otherSQLErr,
						},
					},
				},
			},
		}

		_, _, err := store.VectorSearch(ctx, db, pin, uid, generation.CorpusItem, qvec, 5, time.Now().Add(time.Second), knobs)
		if err == nil {
			t.Fatal("unrelated SQL error 42P01: got nil error, want non-nil")
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "42P01" {
			t.Fatalf("unrelated SQL error = %v, want PgError 42P01", err)
		}
	}
}

// TestVectorSearchExpiredBranchErrorPrecedence pins the classifier order of
// isTimeoutOrDeadline when the branch deadline has already expired by the time
// the error is classified (VQ-2 remaining edge): an explicit PgError is judged
// by its SQLSTATE only, and the branch-context fallback is limited to
// otherwise-unclassified (transport-style) errors.
func TestVectorSearchExpiredBranchErrorPrecedence(t *testing.T) {
	pin := generation.Pin{
		GenID: 1,
		Identity: embedid.Identity{
			Provider:      generation.ProviderTEI,
			Model:         "tei/bge-m3",
			ModelVersion:  "v1",
			Dims:          3,
			Preprocessing: "v1",
		},
		MinCos:    0.55,
		ItemTable: "item_embedding_g1",
		TagTable:  "tag_embedding_g1",
	}
	uid := uuid.New()
	qvec := []float32{1, 0, 0}
	now := time.Now().UTC().Truncate(time.Microsecond)

	id1 := uuid.MustParse("00000000-0000-0000-0000-000000000010")
	id2 := uuid.MustParse("00000000-0000-0000-0000-000000000020")
	id3 := uuid.MustParse("00000000-0000-0000-0000-000000000030")

	hitFar := store.Hit{ID: id3, Name: "far", Count: 1, LastUsedAt: now, CreatedAt: now, Dist: 0.25, Cos: 0.75}
	hitTieHi := store.Hit{ID: id2, Name: "tie-hi", Count: 2, LastUsedAt: now, CreatedAt: now, Dist: 0.10, Cos: 0.90}
	hitTieLo := store.Hit{ID: id1, Name: "tie-lo", Count: 3, LastUsedAt: now, CreatedAt: now, Dist: 0.10, Cos: 0.90}

	timeout57014 := &pgconn.PgError{Code: "57014", Message: "canceling statement due to statement timeout"}
	undefinedTable := &pgconn.PgError{Code: "42P01", Message: "undefined_table"}
	adminShutdown := &pgconn.PgError{Code: "57P01", Message: "terminating connection due to administrator command"}

	fixedNow := time.Now() // relative-elapsed clock only; never used as a context deadline

	cases := []struct {
		name        string
		ann         bool
		count       int
		k           int
		iterErr     error
		wantErrCode string // non-empty: error must be a PgError with this SQLSTATE
		wantErrText string // non-empty: error must contain this text (non-PgError)
		wantIDs     []uuid.UUID
		wantPath    store.VectorPath
		wantCands   int
		wantUnder   bool
	}{
		{
			name: "exact expired branch + 42P01 stays error", count: 3, k: 5,
			iterErr: undefinedTable, wantErrCode: "42P01",
		},
		{
			name: "ann expired branch + 42P01 stays error", ann: true, count: 6, k: 5,
			iterErr: undefinedTable, wantErrCode: "42P01",
		},
		{
			name: "ann expired branch + 57P01 stays error", ann: true, count: 6, k: 5,
			iterErr: adminShutdown, wantErrCode: "57P01",
		},
		{
			name: "exact expired branch + 57014 is timeout with partial hits", count: 3, k: 5,
			iterErr: timeout57014, wantIDs: []uuid.UUID{id1, id2, id3}, wantPath: store.VectorPathExact,
		},
		{
			name: "ann expired branch + 57014 is timeout with partial hits", ann: true, count: 6, k: 5,
			iterErr: timeout57014, wantIDs: []uuid.UUID{id1, id3}, wantPath: store.VectorPathANNShort,
			wantCands: 2, wantUnder: true,
		},
		{
			name: "exact expired branch + unclassified transport error is timeout", count: 3, k: 5,
			iterErr: errors.New("connection reset"), wantIDs: []uuid.UUID{id1, id2, id3}, wantPath: store.VectorPathExact,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			knobs := store.DefaultVectorSearchKnobs()
			knobs.ExactMaxVectors = 5
			knobs.FallbackMaxVectors = 10
			if tc.ann {
				knobs.ExactMaxVectors = 2
			}
			// Real branch context expires after 50ms (BeginTx blocks until then);
			// the injected fixed clock keeps the relative budget at the full 50ms so
			// no scheduler stall can short-circuit the search before BeginTx.
			knobs.BranchTimeout = 50 * time.Millisecond
			knobs.FallbackMinBudget = 10 * time.Millisecond
			knobs.Now = func() time.Time { return fixedNow }

			hFar, hHi, hLo := hitFar, hitTieHi, hitTieLo
			rows := &fakeVectorRows{corpus: generation.CorpusItem, isANN: tc.ann, iterErr: tc.iterErr}
			if tc.ann {
				rows.annRows = []fakeANNRowData{{candidates: 2, hit: &hFar}, {candidates: 2, hit: &hLo}}
			} else {
				rows.exRows = []store.Hit{hFar, hHi, hLo}
			}
			db := &fakeVectorDB{
				count:            tc.count,
				txs:              []*fakeTx{{br: &fakeBatchResults{rows: rows}}},
				waitBranchExpiry: true,
			}

			hits, stats, err := store.VectorSearch(context.Background(), db, pin, uid, generation.CorpusItem, qvec, tc.k, time.Now().Add(time.Second), knobs)

			// Guard against a vacuous test: the branch context really had expired.
			if !errors.Is(db.branchErr, context.DeadlineExceeded) {
				t.Fatalf("branch ctx err at BeginTx = %v, want context.DeadlineExceeded", db.branchErr)
			}

			if tc.wantErrCode != "" {
				if err == nil {
					t.Fatalf("expired branch + %s: got nil error (stats %+v), want PgError %s", tc.wantErrCode, stats, tc.wantErrCode)
				}
				var pgErr *pgconn.PgError
				if !errors.As(err, &pgErr) || pgErr.Code != tc.wantErrCode {
					t.Fatalf("err = %v, want PgError %s", err, tc.wantErrCode)
				}
				if hits != nil || stats.TimedOut {
					t.Fatalf("error path returned hits=%v TimedOut=%v, want nil hits and TimedOut=false", hits, stats.TimedOut)
				}
				return
			}

			if err != nil {
				t.Fatalf("err = %v, want nil (timeout with partial hits)", err)
			}
			if !stats.TimedOut || stats.Path != tc.wantPath || stats.Returned != len(tc.wantIDs) ||
				stats.ANNCandidates != tc.wantCands || stats.Underfill != tc.wantUnder {
				t.Fatalf("stats = %+v, want Path=%s TimedOut=true Returned=%d ANNCandidates=%d Underfill=%v",
					stats, tc.wantPath, len(tc.wantIDs), tc.wantCands, tc.wantUnder)
			}
			if len(hits) != len(tc.wantIDs) {
				t.Fatalf("hits = %+v, want ids %v", hits, tc.wantIDs)
			}
			for i, id := range tc.wantIDs {
				if hits[i].ID != id {
					t.Fatalf("hits[%d].ID = %s, want %s (all hits %+v)", i, hits[i].ID, id, hits)
				}
			}
		})
	}
}
