package store_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
	"github.com/zone17th/engram/apps/api/internal/embedding/store"
)

var (
	sharedBaseDSNOnce sync.Once
	sharedBaseDSN     string
	sharedBaseErr     error
	sharedContainer   testcontainers.Container
)

func TestMain(m *testing.M) {
	code := m.Run()
	if sharedContainer != nil {
		_ = testcontainers.TerminateContainer(sharedContainer)
	}
	os.Exit(code)
}

func basePostgresDSN(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping Postgres integration test in -short mode")
	}
	if envDSN := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL")); envDSN != "" {
		return envDSN
	}
	sharedBaseDSNOnce.Do(func() {
		ctx := context.Background()
		c, err := tcpostgres.Run(ctx, "pgvector/pgvector:pg16",
			tcpostgres.WithDatabase("engram"),
			tcpostgres.WithUsername("engram"),
			tcpostgres.WithPassword("engram"),
			testcontainers.WithWaitStrategy(
				wait.ForLog("database system is ready to accept connections").
					WithOccurrence(2).WithStartupTimeout(90*time.Second)),
		)
		if err != nil {
			sharedBaseErr = err
			return
		}
		sharedContainer = c
		sharedBaseDSN, sharedBaseErr = c.ConnectionString(ctx, "sslmode=disable")
	})
	if sharedBaseErr != nil {
		t.Fatalf("start shared Postgres container: %v", sharedBaseErr)
	}
	return sharedBaseDSN
}

func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	base := basePostgresDSN(t)
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse base DSN: %v", err)
	}
	var nonce [6]byte
	_, _ = rand.Read(nonce[:])
	dbName := "engram_store_" + hex.EncodeToString(nonce[:])

	admin := *u
	admin.Path = "/postgres"
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, admin.String())
	if err != nil {
		t.Fatalf("connect admin DB: %v", err)
	}
	if _, err := conn.Exec(ctx, `CREATE DATABASE "`+dbName+`"`); err != nil {
		_ = conn.Close(ctx)
		t.Fatalf("CREATE DATABASE %s: %v", dbName, err)
	}
	_ = conn.Close(ctx)

	u.Path = "/" + dbName
	dsn := u.String()
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), admin.String())
		if err != nil {
			return
		}
		defer func() { _ = c.Close(context.Background()) }()
		_, _ = c.Exec(context.Background(), `DROP DATABASE IF EXISTS "`+dbName+`" WITH (FORCE)`)
	})

	if err := db.MigrateUp(dsn); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}
	return dbtest.Pool(t, dsn)
}

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

func makeHash(seed byte) []byte {
	return bytes.Repeat([]byte{seed}, 32)
}

func seedGenerationWithTables(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	id int,
	provider string,
	dims int,
	partitions int,
	state string,
	rollbackUntil *time.Time,
) generation.Generation {
	t.Helper()
	q := gen.New(pool)

	row, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 int32(id),
		Provider:           provider,
		Model:              provider + "/model-g" + string(rune('0'+id)),
		ModelVersion:       "v1",
		Preprocessing:      "v1",
		QueryPrefix:        "",
		DocPrefix:          "",
		Dims:               int32(dims),
		Partitions:         int32(partitions),
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.55,
		CalibrationRef:     "docs/benchmarks/semantic-eval/report.json",
		Bootstrap:          id == 1,
	})
	if err != nil {
		t.Fatalf("InsertPendingEmbeddingGeneration g%d: %v", id, err)
	}
	if err := q.CreateEmbeddingGenerationTables(ctx, gen.CreateEmbeddingGenerationTablesParams{
		ID:                 int32(id),
		Dims:               int32(dims),
		Partitions:         int32(partitions),
		WithHnsw:           false,
		HnswM:              16,
		HnswEfConstruction: 64,
	}); err != nil {
		t.Fatalf("CreateEmbeddingGenerationTables g%d: %v", id, err)
	}

	switch state {
	case generation.StateActive:
		row, err = q.ActivateEmbeddingGeneration(ctx, int32(id))
		if err != nil {
			t.Fatalf("ActivateEmbeddingGeneration g%d: %v", id, err)
		}
		if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
			GenerationID:  int32(id),
			FlippedReason: new("test"),
		}); err != nil {
			t.Fatalf("UpsertEmbeddingActive g%d: %v", id, err)
		}
	case generation.StateRetired:
		var ts pgtype.Timestamptz
		if rollbackUntil != nil {
			ts = pgtype.Timestamptz{Time: *rollbackUntil, Valid: true}
		}
		row, err = q.RetireEmbeddingGeneration(ctx, gen.RetireEmbeddingGenerationParams{
			ID:            int32(id),
			RollbackUntil: ts,
		})
		if err != nil {
			t.Fatalf("RetireEmbeddingGeneration g%d: %v", id, err)
		}
	}

	g, err := generation.FromDBRow(row)
	if err != nil {
		t.Fatalf("FromDBRow g%d: %v", id, err)
	}
	return g
}

func TestCompositeFKBlocksCrossTenantVector(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	g1 := seedGenerationWithTables(t, ctx, pool, 1, generation.ProviderTEI, 3, 4, generation.StateActive, nil)

	u1, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "u1-fk@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	u2, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "u2-fk@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}

	itemU2, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u2.ID,
		Name:           "Secret Item",
		NameNormalized: "secret item",
	})
	if err != nil {
		t.Fatal(err)
	}
	tagU2, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     u2.ID,
		Display:    "SecretTag",
		Normalized: "secrettag",
	})
	if err != nil {
		t.Fatal(err)
	}

	vec := []float32{0.6, 0.8, 0.0}
	hash := makeHash(0x11)

	// Upsert with wrong dims must be rejected before SQL.
	if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, u2.ID, itemU2.ID, []float32{1.0, 0.0}, hash); !errors.Is(err, store.ErrDimsMismatch) {
		t.Fatalf("Upsert with wrong dims = %v, want ErrDimsMismatch", err)
	}

	// Cross-tenant item vector (claiming u1.ID for u2's itemU2.ID) must fail composite FK.
	err = store.Upsert(ctx, pool, g1, generation.CorpusItem, u1.ID, itemU2.ID, vec, hash)
	if !isForeignKeyViolation(err) {
		t.Fatalf("cross-tenant item vector must fail composite FK, got err=%v", err)
	}

	// Cross-tenant tag vector (claiming u1.ID for u2's tagU2.ID) must fail composite FK.
	err = store.Upsert(ctx, pool, g1, generation.CorpusTag, u1.ID, tagU2.ID, vec, hash)
	if !isForeignKeyViolation(err) {
		t.Fatalf("cross-tenant tag vector must fail composite FK, got err=%v", err)
	}

	// Valid owner u2 succeeds and ON CONFLICT DO UPDATE updates input_hash in place.
	if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, u2.ID, itemU2.ID, vec, hash); err != nil {
		t.Fatalf("valid Upsert item: %v", err)
	}
	hash2 := makeHash(0x22)
	if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, u2.ID, itemU2.ID, vec, hash2); err != nil {
		t.Fatalf("update Upsert item: %v", err)
	}
	meta, ok, err := store.GetTargetMeta(ctx, pool, g1, generation.CorpusItem, u2.ID, itemU2.ID)
	if err != nil || !ok || !bytes.Equal(meta.InputHash, hash2) {
		t.Fatalf("GetTargetMeta = %+v ok=%v err=%v", meta, ok, err)
	}
}

func TestDeleteUserExternalKeepsTEI(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	// g1: tei active
	// g2: openai_compat pending
	// g3: openai_compat retired past rollback window (rollback_until < now())
	expired := time.Now().Add(-48 * time.Hour)
	g3 := seedGenerationWithTables(t, ctx, pool, 3, generation.ProviderOpenAICompat, 3, 4, generation.StateRetired, &expired)
	g1 := seedGenerationWithTables(t, ctx, pool, 1, generation.ProviderTEI, 3, 4, generation.StateActive, nil)
	g2 := seedGenerationWithTables(t, ctx, pool, 2, generation.ProviderOpenAICompat, 3, 4, generation.StatePending, nil)

	u1, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "u1-ext@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	u2, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "u2-ext@example.com", Locale: "en"})
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

	vec := []float32{1.0, 0.0, 0.0}
	hash := makeHash(0x33)

	for _, g := range []generation.Generation{g1, g2, g3} {
		if err := store.Upsert(ctx, pool, g, generation.CorpusItem, u1.ID, item1.ID, vec, hash); err != nil {
			t.Fatalf("Upsert u1 item in g%d: %v", g.ID, err)
		}
		if err := store.Upsert(ctx, pool, g, generation.CorpusTag, u1.ID, tag1.ID, vec, hash); err != nil {
			t.Fatalf("Upsert u1 tag in g%d: %v", g.ID, err)
		}
		if err := store.Upsert(ctx, pool, g, generation.CorpusItem, u2.ID, item2.ID, vec, hash); err != nil {
			t.Fatalf("Upsert u2 item in g%d: %v", g.ID, err)
		}
	}

	// Execute DeleteUserExternal for u1.
	if err := store.DeleteUserExternal(ctx, pool, u1.ID); err != nil {
		t.Fatalf("DeleteUserExternal: %v", err)
	}

	// Verify u1's vectors in g1 (tei) are KEPT for both item and tag.
	if _, ok, err := store.GetTargetMeta(ctx, pool, g1, generation.CorpusItem, u1.ID, item1.ID); err != nil || !ok {
		t.Fatalf("g1 (tei) item vector for u1 must be kept: ok=%v err=%v", ok, err)
	}
	if _, ok, err := store.GetTargetMeta(ctx, pool, g1, generation.CorpusTag, u1.ID, tag1.ID); err != nil || !ok {
		t.Fatalf("g1 (tei) tag vector for u1 must be kept: ok=%v err=%v", ok, err)
	}

	// Verify u1's vectors in g2 (openai_compat pending) and g3 (openai_compat retired past window) are DELETED.
	for _, g := range []generation.Generation{g2, g3} {
		if _, ok, err := store.GetTargetMeta(ctx, pool, g, generation.CorpusItem, u1.ID, item1.ID); err != nil || ok {
			t.Fatalf("g%d (openai_compat) item vector for u1 must be deleted: ok=%v err=%v", g.ID, ok, err)
		}
		if _, ok, err := store.GetTargetMeta(ctx, pool, g, generation.CorpusTag, u1.ID, tag1.ID); err != nil || ok {
			t.Fatalf("g%d (openai_compat) tag vector for u1 must be deleted: ok=%v err=%v", g.ID, ok, err)
		}
		// Verify u2's vectors in g2 and g3 are untouched.
		if _, ok, err := store.GetTargetMeta(ctx, pool, g, generation.CorpusItem, u2.ID, item2.ID); err != nil || !ok {
			t.Fatalf("g%d item vector for other user u2 must be kept: ok=%v err=%v", g.ID, ok, err)
		}
	}
}

func TestHardPurgeCascadesAndDeleteTargetAllGenerations(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	expired := time.Now().Add(-72 * time.Hour)
	g2 := seedGenerationWithTables(t, ctx, pool, 2, generation.ProviderOpenAICompat, 3, 4, generation.StateRetired, &expired)
	g1 := seedGenerationWithTables(t, ctx, pool, 1, generation.ProviderTEI, 3, 4, generation.StateActive, nil)

	u, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "purge@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	itemSoft, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: u.ID, Name: "Soft Deleted", NameNormalized: "soft deleted"})
	if err != nil {
		t.Fatal(err)
	}
	itemHard, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: u.ID, Name: "Hard Purged", NameNormalized: "hard purged"})
	if err != nil {
		t.Fatal(err)
	}
	tagHard, err := q.InsertTag(ctx, gen.InsertTagParams{UserID: u.ID, Display: "HardTag", Normalized: "hardtag"})
	if err != nil {
		t.Fatal(err)
	}

	vec := []float32{0.0, 1.0, 0.0}
	hash := makeHash(0x44)
	for _, g := range []generation.Generation{g1, g2} {
		if err := store.Upsert(ctx, pool, g, generation.CorpusItem, u.ID, itemSoft.ID, vec, hash); err != nil {
			t.Fatal(err)
		}
		if err := store.Upsert(ctx, pool, g, generation.CorpusItem, u.ID, itemHard.ID, vec, hash); err != nil {
			t.Fatal(err)
		}
		if err := store.Upsert(ctx, pool, g, generation.CorpusTag, u.ID, tagHard.ID, vec, hash); err != nil {
			t.Fatal(err)
		}
	}

	// 1. DeleteTarget removes itemSoft across all existing generations (including g2 retired past window).
	if err := store.DeleteTarget(ctx, pool, generation.CorpusItem, u.ID, itemSoft.ID); err != nil {
		t.Fatalf("DeleteTarget: %v", err)
	}
	for _, g := range []generation.Generation{g1, g2} {
		if _, ok, err := store.GetTargetMeta(ctx, pool, g, generation.CorpusItem, u.ID, itemSoft.ID); err != nil || ok {
			t.Fatalf("DeleteTarget must remove itemSoft in g%d: ok=%v err=%v", g.ID, ok, err)
		}
	}

	// 2. Hard purge (DELETE FROM item / DELETE FROM tag) cascades to both g1 and g2 via composite FK ON DELETE CASCADE.
	if _, err := pool.Exec(ctx, `DELETE FROM item WHERE user_id = $1 AND id = $2`, u.ID, itemHard.ID); err != nil {
		t.Fatalf("hard delete item: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM tag WHERE user_id = $1 AND id = $2`, u.ID, tagHard.ID); err != nil {
		t.Fatalf("hard delete tag: %v", err)
	}
	for _, g := range []generation.Generation{g1, g2} {
		if _, ok, err := store.GetTargetMeta(ctx, pool, g, generation.CorpusItem, u.ID, itemHard.ID); err != nil || ok {
			t.Fatalf("hard purge item must cascade to g%d: ok=%v err=%v", g.ID, ok, err)
		}
		if _, ok, err := store.GetTargetMeta(ctx, pool, g, generation.CorpusTag, u.ID, tagHard.ID); err != nil || ok {
			t.Fatalf("hard purge tag must cascade to g%d: ok=%v err=%v", g.ID, ok, err)
		}
	}
}

func TestExplainTouchesSinglePartitionForUserFilter(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)

	// Create g1 with 16 hash partitions.
	_ = seedGenerationWithTables(t, ctx, pool, 1, generation.ProviderTEI, 3, 16, generation.StateActive, nil)

	userID := uuid.New()
	var rawPlan []byte
	if err := pool.QueryRow(ctx,
		`EXPLAIN (FORMAT JSON, COSTS OFF) SELECT target_id FROM item_embedding_g1 WHERE user_id = $1`,
		userID,
	).Scan(&rawPlan); err != nil {
		t.Fatalf("EXPLAIN query: %v", err)
	}

	var planPayload []map[string]any
	if err := json.Unmarshal(rawPlan, &planPayload); err != nil {
		t.Fatalf("unmarshal EXPLAIN JSON: %v\nRaw:\n%s", err, string(rawPlan))
	}

	seenPartitions := make(map[string]struct{})
	var collectPartitionRelations func(v any)
	collectPartitionRelations = func(v any) {
		switch node := v.(type) {
		case map[string]any:
			if rel, ok := node["Relation Name"].(string); ok {
				if strings.HasPrefix(rel, "item_embedding_g1_p") {
					seenPartitions[rel] = struct{}{}
				}
			}
			for k, child := range node {
				if k == "Index Name" {
					continue
				}
				collectPartitionRelations(child)
			}
		case []any:
			for _, elem := range node {
				collectPartitionRelations(elem)
			}
		}
	}
	for _, root := range planPayload {
		collectPartitionRelations(root)
	}

	if len(seenPartitions) != 1 {
		t.Fatalf("expected EXPLAIN to touch exactly 1 partition relation of item_embedding_g1, touched %d (%v)\nPlan JSON:\n%s",
			len(seenPartitions), seenPartitions, string(rawPlan))
	}
}

func TestScanStaleKeysetAndUserPolicy(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	g1 := seedGenerationWithTables(t, ctx, pool, 1, generation.ProviderOpenAICompat, 3, 4, generation.StateActive, nil)

	uOn, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "scan-on@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.UpdateUserSemanticSuggest(ctx, gen.UpdateUserSemanticSuggestParams{
		ID:              uOn.ID,
		SemanticSuggest: true,
	}); err != nil {
		t.Fatal(err)
	}
	uOff, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "scan-off@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.UpdateUserSemanticSuggest(ctx, gen.UpdateUserSemanticSuggestParams{
		ID:              uOff.ID,
		SemanticSuggest: false,
	}); err != nil {
		t.Fatal(err)
	}
	item1, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: uOn.ID, Name: "Item 1", NameNormalized: "item 1", Hint: new("h1")})
	if err != nil {
		t.Fatal(err)
	}
	item2, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: uOn.ID, Name: "Item 2", NameNormalized: "item 2"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertItem(ctx, gen.InsertItemParams{UserID: uOff.ID, Name: "Item Off", NameNormalized: "item off"}); err != nil {
		t.Fatal(err)
	}

	// Upsert vector only for item1 so item2 has nil InputHash.
	hash1 := makeHash(0x55)
	if err := store.Upsert(ctx, pool, g1, generation.CorpusItem, uOn.ID, item1.ID, []float32{1, 0, 0}, hash1); err != nil {
		t.Fatal(err)
	}

	// Page with n=1 across all eligible users: uOff must be skipped because g1 is openai_compat.
	page1, err := store.ScanStale(ctx, pool, g1, generation.CorpusItem, nil, nil, 1)
	if err != nil {
		t.Fatalf("ScanStale page 1: %v", err)
	}
	if len(page1) != 1 {
		t.Fatalf("page1 len = %d, want 1", len(page1))
	}

	cursor := &store.ScanCursor{UserID: page1[0].UserID, TargetID: page1[0].TargetID}
	page2, err := store.ScanStale(ctx, pool, g1, generation.CorpusItem, cursor, nil, 10)
	if err != nil {
		t.Fatalf("ScanStale page 2: %v", err)
	}
	if len(page2) != 1 {
		t.Fatalf("page2 len = %d, want 1 (uOff must be excluded for openai_compat)", len(page2))
	}

	all := append(page1, page2...)
	byID := map[uuid.UUID]store.ScanTargetRow{
		all[0].TargetID: all[0],
		all[1].TargetID: all[1],
	}
	r1, ok1 := byID[item1.ID]
	r2, ok2 := byID[item2.ID]
	if !ok1 || !ok2 {
		t.Fatalf("expected item1 and item2 in ScanStale results, got %+v", all)
	}
	if !r1.HasVector() || !bytes.Equal(r1.InputHash, hash1) || r1.Hint == nil || *r1.Hint != "h1" {
		t.Fatalf("r1 mismatch: %+v", r1)
	}
	if r2.HasVector() || r2.InputHash != nil {
		t.Fatalf("r2 expected nil InputHash, got %+v", r2)
	}
}
