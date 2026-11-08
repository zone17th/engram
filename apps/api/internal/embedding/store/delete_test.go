package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
)

// TestDeleteUserAllGenerations: account deletion removes the user's item and
// tag vectors from every existing generation (tei and openai_compat, active,
// pending, retired past its window) and leaves other users untouched.
func TestDeleteUserAllGenerations(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	expired := time.Now().Add(-48 * time.Hour)
	g3 := seedGenerationWithTables(t, ctx, pool, 3, generation.ProviderTEI, 3, 4, generation.StateRetired, &expired)
	g1 := seedGenerationWithTables(t, ctx, pool, 1, generation.ProviderTEI, 3, 4, generation.StateActive, nil)
	g2 := seedGenerationWithTables(t, ctx, pool, 2, generation.ProviderOpenAICompat, 3, 4, generation.StatePending, nil)
	gens := []generation.Generation{g1, g2, g3}

	u1, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "u1-all@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	u2, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "u2-all@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	item1, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: u1.ID, Name: "Item U1", NameNormalized: "item u1"})
	if err != nil {
		t.Fatal(err)
	}
	tag1, err := q.InsertTag(ctx, gen.InsertTagParams{UserID: u1.ID, Display: "TagU1", Normalized: "tagu1"})
	if err != nil {
		t.Fatal(err)
	}
	item2, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: u2.ID, Name: "Item U2", NameNormalized: "item u2"})
	if err != nil {
		t.Fatal(err)
	}
	vec := []float32{1, 0, 0}
	hash := makeHash(0x44)
	for _, g := range gens {
		if err := store.Upsert(ctx, pool, g, generation.CorpusItem, u1.ID, item1.ID, vec, hash); err != nil {
			t.Fatalf("Upsert u1 item g%d: %v", g.ID, err)
		}
		if err := store.Upsert(ctx, pool, g, generation.CorpusTag, u1.ID, tag1.ID, vec, hash); err != nil {
			t.Fatalf("Upsert u1 tag g%d: %v", g.ID, err)
		}
		if err := store.Upsert(ctx, pool, g, generation.CorpusItem, u2.ID, item2.ID, vec, hash); err != nil {
			t.Fatalf("Upsert u2 item g%d: %v", g.ID, err)
		}
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := generation.LockGenerationSetShared(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteUserAllGenerations(ctx, tx, u1.ID); err != nil {
		t.Fatalf("DeleteUserAllGenerations: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	for _, g := range gens {
		if _, ok, err := store.GetTargetMeta(ctx, pool, g, generation.CorpusItem, u1.ID, item1.ID); err != nil || ok {
			t.Fatalf("g%d item vector of u1 must be deleted: ok=%v err=%v", g.ID, ok, err)
		}
		if _, ok, err := store.GetTargetMeta(ctx, pool, g, generation.CorpusTag, u1.ID, tag1.ID); err != nil || ok {
			t.Fatalf("g%d tag vector of u1 must be deleted: ok=%v err=%v", g.ID, ok, err)
		}
		if _, ok, err := store.GetTargetMeta(ctx, pool, g, generation.CorpusItem, u2.ID, item2.ID); err != nil || !ok {
			t.Fatalf("g%d item vector of u2 must be kept: ok=%v err=%v", g.ID, ok, err)
		}
	}

	if err := store.DeleteUserAllGenerations(ctx, nil, u1.ID); err != store.ErrNilDB {
		t.Fatalf("nil tx = %v, want ErrNilDB", err)
	}
}
