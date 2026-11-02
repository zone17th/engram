package jobs_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding"
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/jobs"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
	"github.com/zone17th/engram/apps/api/internal/item"
)

func hasSharedGenSetLockInTx(t *testing.T, ctx context.Context, tx gen.DBTX) bool {
	t.Helper()
	var held bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM pg_locks
			WHERE pid = pg_backend_pid()
			  AND locktype = 'advisory'
			  AND mode = 'ShareLock'
			  AND granted
			  AND ((classid::bigint << 32) | (objid::bigint & 4294967295)) = $1
		)
	`, generation.GenerationSetLockKey).Scan(&held)
	if err != nil {
		t.Fatalf("check shared advisory lock in tx: %v", err)
	}
	return held
}

// TestEnqueuerDeploymentOffNoopNoLock verifies plan P05 mục 2.17 / 2.18:
// When deployment semantic search is disabled (`!Enabled` or `Provider == "noop"`
// or nil River client), `Enqueuer.OnUpsert` is a pure no-op that inserts 0 jobs
// and does NOT acquire `LockGenerationSetShared`.
func TestEnqueuerDeploymentOffNoopNoLock(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	ident := embedid.Identity{
		Provider:      generation.ProviderTEI,
		Model:         "tei/BAAI/bge-m3",
		ModelVersion:  "rev-1;qp=00000000;dp=00000000",
		Dims:          8,
		Preprocessing: "v1",
	}
	_ = seedGenerationForIdentity(t, ctx, pool, 1, ident, generation.StateActive, nil)

	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "enq-off@example.com", Locale: "vi"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	riverClient := newInsertClient(t, pool)

	cases := []struct {
		name string
		enq  *jobs.Enqueuer
	}{
		{
			name: "disabled_flag",
			enq:  jobs.NewEnqueuer(riverClient, false, embedding.ProviderTEI, nil),
		},
		{
			name: "noop_provider",
			enq:  jobs.NewEnqueuer(riverClient, true, embedding.ProviderNoop, nil),
		},
		{
			name: "nil_client",
			enq:  jobs.NewEnqueuer(nil, true, embedding.ProviderTEI, nil),
		},
	}

	for _, tc := range cases {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("[%s] Begin: %v", tc.name, err)
		}
		if err := tc.enq.OnUpsert(ctx, tx, user.ID, item.EmbedKindItem, uuid.New(), "Name — hint"); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("[%s] OnUpsert: %v", tc.name, err)
		}
		if hasSharedGenSetLockInTx(t, ctx, tx) {
			_ = tx.Rollback(ctx)
			t.Fatalf("[%s] expected NO shared generation-set lock when deployment is off", tc.name)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("[%s] Commit: %v", tc.name, err)
		}
	}

	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job`).Scan(&count); err != nil {
		t.Fatalf("count river_job: %v", err)
	}
	if count != 0 {
		t.Fatalf("river_job count = %d, want 0 when deployment off", count)
	}
}

// TestEnqueueTxFanOutLockAndBootstrapPending verifies plan P05 mục 2.15 / 2.17
// (BE-3, BE-4, OQ-16):
//   - Acquires `LockGenerationSetShared` inside `tx` before reading `R`.
//   - When `R = {g1 bootstrap pending}` (no active generation yet), `EnqueueTx`
//     still enqueues 1 job for g1 (BE-4).
//   - When `R = {g1 tei active, g2 openai_compat pending, g3 tei retired within window}`
//     and `g4` is retired past `rollback_until`, `EnqueueTx` fans out across the
//     3 receiving generations (skipping `g4`), and when the user has
//     `semantic_suggest=false` it skips ONLY `g2` (`openai_compat`) while still
//     enqueuing `g1` and `g3` (`tei`) (BE-3).
func TestEnqueueTxFanOutLockAndBootstrapPending(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)
	riverClient := newInsertClient(t, pool)

	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "enq-fanout@example.com", Locale: "vi"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}

	teiIdent := embedid.Identity{
		Provider:      generation.ProviderTEI,
		Model:         "tei/BAAI/bge-m3",
		ModelVersion:  "rev-tei-1;qp=00000000;dp=11111111",
		Dims:          8,
		DocPrefix:     "passage: ",
		Preprocessing: "v1",
	}

	// 1. Seed ONLY g1 in state 'pending' (bootstrap=true, no active generation).
	g1Pending := seedGenerationForIdentity(t, ctx, pool, 1, teiIdent, generation.StatePending, nil)

	targetID1 := uuid.New()
	input1 := embedding.ItemInput("Bootstrap Target", "pending g1")
	wantHash1 := embedding.InputHashFor(g1Pending.Identity(), input1)

	tx1, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin tx1: %v", err)
	}
	defer func() { _ = tx1.Rollback(ctx) }()

	if err := jobs.EnqueueTx(ctx, tx1, riverClient, user.ID, item.EmbedKindItem, targetID1, input1); err != nil {
		t.Fatalf("EnqueueTx bootstrap pending: %v", err)
	}
	if !hasSharedGenSetLockInTx(t, ctx, tx1) {
		t.Fatal("expected LockGenerationSetShared to be held inside tx1 after EnqueueTx")
	}
	if err := tx1.Commit(ctx); err != nil {
		t.Fatalf("Commit tx1: %v", err)
	}

	var gotGenID int
	var gotHashHex string
	if err := pool.QueryRow(ctx,
		`SELECT (args->>'generation_id')::int, args->>'input_hash' FROM river_job WHERE kind = 'embed_item'`,
	).Scan(&gotGenID, &gotHashHex); err != nil {
		t.Fatalf("read bootstrap pending job: %v", err)
	}
	if gotGenID != g1Pending.ID || gotHashHex != hex.EncodeToString(wantHash1[:]) {
		t.Fatalf("bootstrap pending job = (gen=%d, hash=%s), want (gen=%d, hash=%x)", gotGenID, gotHashHex, g1Pending.ID, wantHash1[:])
	}

	if _, err := pool.Exec(ctx, `DELETE FROM river_job`); err != nil {
		t.Fatalf("clear river_job: %v", err)
	}

	// 2. Activate g1 (tei), seed g3 (tei retired within rollback window), g4 (tei retired expired),
	// and finally g2 (openai_compat pending).
	if _, err := q.ActivateEmbeddingGeneration(ctx, int32(g1Pending.ID)); err != nil {
		t.Fatalf("ActivateEmbeddingGeneration g1: %v", err)
	}
	openAIIdent := embedid.Identity{
		Provider:      generation.ProviderOpenAICompat,
		Model:         "openrouter/qwen/qwen3-embedding-8b",
		ModelVersion:  "openrouter/qwen/qwen3-embedding-8b@dims=8;qi=abcd1234",
		Dims:          8,
		Preprocessing: "v1",
	}
	futureRollback := time.Now().Add(2 * time.Hour)
	pastRollback := time.Now().Add(-2 * time.Hour)
	teiIdent3 := teiIdent
	teiIdent3.ModelVersion = "rev-tei-3;qp=00000000;dp=11111111"
	g3RetiredReceiving := seedGenerationForIdentity(t, ctx, pool, 3, teiIdent3, generation.StateRetired, &futureRollback)
	teiIdent4 := teiIdent
	teiIdent4.ModelVersion = "rev-tei-4;qp=00000000;dp=11111111"
	_ = seedGenerationForIdentity(t, ctx, pool, 4, teiIdent4, generation.StateRetired, &pastRollback)
	g2OpenAIPending := seedGenerationForIdentity(t, ctx, pool, 2, openAIIdent, generation.StatePending, nil)

	// User has semantic_suggest = true -> all 3 receiving generations (g1, g2, g3) receive jobs.
	tagIDOn := uuid.New()
	txOn, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin txOn: %v", err)
	}
	defer func() { _ = txOn.Rollback(ctx) }()
	if err := jobs.EnqueueTx(ctx, txOn, riverClient, user.ID, item.EmbedKindTag, tagIDOn, embedding.TagInput("tag-on")); err != nil {
		t.Fatalf("EnqueueTx user on: %v", err)
	}
	if err := txOn.Commit(ctx); err != nil {
		t.Fatalf("Commit txOn: %v", err)
	}

	genIDsOn := queryEnqueuedGenIDs(t, ctx, pool, "embed_tag", tagIDOn)
	wantOn := []int{g1Pending.ID, g2OpenAIPending.ID, g3RetiredReceiving.ID}
	if !equalIntSlice(genIDsOn, wantOn) {
		t.Fatalf("enqueued generation IDs (user on) = %v, want %v", genIDsOn, wantOn)
	}

	// Turn user's semantic_suggest = false -> skips g2 (openai_compat), still enqueues g1 & g3 (tei) (BE-3).
	if _, err := pool.Exec(ctx,
		`UPDATE app_user SET settings = jsonb_set(settings, '{semantic_suggest}', 'false'::jsonb) WHERE id = $1`,
		user.ID,
	); err != nil {
		t.Fatalf("set semantic_suggest=false: %v", err)
	}

	tagIDOff := uuid.New()
	txOff, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin txOff: %v", err)
	}
	defer func() { _ = txOff.Rollback(ctx) }()
	if err := jobs.EnqueueTx(ctx, txOff, riverClient, user.ID, item.EmbedKindTag, tagIDOff, embedding.TagInput("tag-off")); err != nil {
		t.Fatalf("EnqueueTx user off: %v", err)
	}
	if err := txOff.Commit(ctx); err != nil {
		t.Fatalf("Commit txOff: %v", err)
	}

	genIDsOff := queryEnqueuedGenIDs(t, ctx, pool, "embed_tag", tagIDOff)
	wantOff := []int{g1Pending.ID, g3RetiredReceiving.ID}
	if !equalIntSlice(genIDsOff, wantOff) {
		t.Fatalf("enqueued generation IDs (user off, BE-3) = %v, want %v", genIDsOff, wantOff)
	}
}

// TestEnqueuerOnDeleteRemovesVectorsEvenWhenDeploymentOff verifies plan P05
// mục 2.15 / 2.17 / Task 11b:
// `Enqueuer.OnDelete` acquires `LockGenerationSetShared` and deletes the target's
// vector across every existing generation (`state <> 'dropped'`, including
// retired generations past their rollback window), even when the Enqueuer is
// configured with `Enabled: false` or `Provider: "noop"`.
func TestEnqueuerOnDeleteRemovesVectorsEvenWhenDeploymentOff(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	ident1 := embedid.Identity{
		Provider:      generation.ProviderTEI,
		Model:         "tei/BAAI/bge-m3",
		ModelVersion:  "rev-del-1",
		Dims:          4,
		Preprocessing: "v1",
	}
	ident2 := ident1
	ident2.ModelVersion = "rev-del-2"
	ident3 := ident1
	ident3.ModelVersion = "rev-del-3"
	ident4 := ident1
	ident4.ModelVersion = "rev-del-4"

	pastRollback := time.Now().Add(-24 * time.Hour)
	gActive := seedGenerationForIdentity(t, ctx, pool, 1, ident1, generation.StateActive, nil)
	gRetiredExpired := seedGenerationForIdentity(t, ctx, pool, 3, ident3, generation.StateRetired, &pastRollback)
	_ = seedGenerationForIdentity(t, ctx, pool, 4, ident4, generation.StateDropped, nil)
	gPending := seedGenerationForIdentity(t, ctx, pool, 2, ident2, generation.StatePending, nil)

	user, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "enq-del-off@example.com", Locale: "vi"})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	itemRow, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         user.ID,
		Name:           "Delete Me Item",
		NameNormalized: strings.ToLower("Delete Me Item"),
	})
	if err != nil {
		t.Fatalf("InsertItem: %v", err)
	}

	vec := []float32{0.5, 0.5, 0.5, 0.5}
	hash := bytes.Repeat([]byte{0x11}, 32)
	for _, g := range []generation.Generation{gActive, gPending, gRetiredExpired} {
		if err := store.Upsert(ctx, pool, g, generation.CorpusItem, user.ID, itemRow.ID, vec, hash); err != nil {
			t.Fatalf("store.Upsert g%d: %v", g.ID, err)
		}
	}

	// Enqueuer has Enabled=false and Provider="noop", yet OnDelete must still clean all existing tables.
	enqOff := jobs.NewEnqueuer(nil, false, embedding.ProviderNoop, nil)
	txDel, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin txDel: %v", err)
	}
	defer func() { _ = txDel.Rollback(ctx) }()

	if err := enqOff.OnDelete(ctx, txDel, user.ID, item.EmbedKindItem, itemRow.ID); err != nil {
		t.Fatalf("OnDelete: %v", err)
	}
	if !hasSharedGenSetLockInTx(t, ctx, txDel) {
		t.Fatal("expected LockGenerationSetShared to be held inside txDel after OnDelete")
	}
	if err := txDel.Commit(ctx); err != nil {
		t.Fatalf("Commit txDel: %v", err)
	}

	for _, g := range []generation.Generation{gActive, gPending, gRetiredExpired} {
		if _, hasVec, err := store.GetTargetMeta(ctx, pool, g, generation.CorpusItem, user.ID, itemRow.ID); err != nil || hasVec {
			t.Fatalf("g%d (state=%s) retained deleted item vector: hasVec=%v err=%v", g.ID, g.State, hasVec, err)
		}
	}

	// Also verify invalid embed kind returns ErrInvalidEmbedKind.
	txBad, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin txBad: %v", err)
	}
	defer func() { _ = txBad.Rollback(ctx) }()
	if err := enqOff.OnDelete(ctx, txBad, user.ID, item.EmbedKind("unknown"), itemRow.ID); !errors.Is(err, jobs.ErrInvalidEmbedKind) {
		t.Fatalf("OnDelete invalid kind err = %v, want ErrInvalidEmbedKind", err)
	}
}

func queryEnqueuedGenIDs(t *testing.T, ctx context.Context, pool *pgxpool.Pool, kind string, targetID uuid.UUID) []int {
	t.Helper()
	rows, err := pool.Query(ctx,
		`SELECT (args->>'generation_id')::int FROM river_job WHERE kind = $1 AND args->>'target_id' = $2 ORDER BY (args->>'generation_id')::int ASC`,
		kind, targetID.String(),
	)
	if err != nil {
		t.Fatalf("query river_job gen IDs: %v", err)
	}
	defer rows.Close()
	var ids []int
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("Scan gen ID: %v", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}
	return ids
}

func equalIntSlice(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
