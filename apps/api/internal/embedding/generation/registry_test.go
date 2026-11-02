package generation_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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
	"github.com/zone17th/engram/apps/api/internal/embedding/embedid"
	"github.com/zone17th/engram/apps/api/internal/embedding/generation"
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
	dbName := "engram_gen_" + hex.EncodeToString(nonce[:])

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

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func TestTableNameAllowlist(t *testing.T) {
	// Valid IDs and corpora.
	for _, tc := range []struct {
		genID  int
		corpus generation.Corpus
		want   string
	}{
		{1, generation.CorpusItem, "item_embedding_g1"},
		{1, generation.CorpusTag, "tag_embedding_g1"},
		{42, generation.CorpusItem, "item_embedding_g42"},
		{9999, generation.CorpusTag, "tag_embedding_g9999"},
	} {
		ident, err := generation.TableIdent(tc.genID, tc.corpus)
		if err != nil {
			t.Fatalf("TableIdent(%d, %q) unexpected error: %v", tc.genID, tc.corpus, err)
		}
		if len(ident) != 1 || ident[0] != tc.want {
			t.Fatalf("TableIdent(%d, %q) = %v, want [%q]", tc.genID, tc.corpus, ident, tc.want)
		}
		if got := ident.Sanitize(); got != `"`+tc.want+`"` {
			t.Fatalf("Sanitize() = %q, want %q", got, `"`+tc.want+`"`)
		}
		if err := generation.ValidateTableName(tc.genID, tc.corpus, tc.want); err != nil {
			t.Fatalf("ValidateTableName(%d, %q, %q) unexpected error: %v", tc.genID, tc.corpus, tc.want, err)
		}
	}

	// Out-of-range generation IDs or invalid corpora rejected before any DB call.
	for _, badID := range []int{-1, 0, 10000, 99999} {
		if _, err := generation.TableIdent(badID, generation.CorpusItem); !errors.Is(err, generation.ErrInvalidTableName) {
			t.Fatalf("TableIdent(%d, item) = %v, want ErrInvalidTableName", badID, err)
		}
	}
	if _, err := generation.TableIdent(1, generation.Corpus("entry")); !errors.Is(err, generation.ErrInvalidCorpus) {
		t.Fatalf("TableIdent(1, entry) = %v, want ErrInvalidCorpus", err)
	}

	// Disallowed names and mismatched IDs rejected before any DB call.
	badNames := []struct {
		genID  int
		corpus generation.Corpus
		name   string
	}{
		{1, generation.CorpusItem, "item_embedding"},
		{1, generation.CorpusItem, "item_embedding_g0"},
		{1, generation.CorpusItem, "item_embedding_g01"},
		{1, generation.CorpusItem, "item_embedding_g10000"},
		{1, generation.CorpusItem, "item_embedding_g2"}, // valid regex, wrong ID
		{1, generation.CorpusItem, "tag_embedding_g1"},  // wrong corpus for item
		{1, generation.CorpusTag, "item_embedding_g1"},  // wrong corpus for tag
		{1, generation.CorpusItem, "item_embedding_g1; DROP TABLE item;--"},
		{1, generation.CorpusItem, "public.item_embedding_g1"},
		{1, generation.CorpusItem, "item_embedding_g1_p0"},
		{1, generation.CorpusItem, ""},
	}
	for _, tc := range badNames {
		if err := generation.ValidateTableName(tc.genID, tc.corpus, tc.name); !errors.Is(err, generation.ErrInvalidTableName) {
			t.Fatalf("ValidateTableName(%d, %q, %q) = %v, want ErrInvalidTableName", tc.genID, tc.corpus, tc.name, err)
		}
		if _, err := generation.TableIdentFromName(tc.genID, tc.corpus, tc.name); !errors.Is(err, generation.ErrInvalidTableName) {
			t.Fatalf("TableIdentFromName(%d, %q, %q) = %v, want ErrInvalidTableName", tc.genID, tc.corpus, tc.name, err)
		}
	}

	// Row validation rejects corrupted item_table or tag_table on FromDBRow.
	_, err := generation.FromDBRow(gen.EmbeddingGeneration{
		ID:        1,
		ItemTable: "item_embedding_g2",
		TagTable:  "tag_embedding_g1",
	})
	if !errors.Is(err, generation.ErrInvalidTableName) {
		t.Fatalf("FromDBRow with mismatched ItemTable = %v, want ErrInvalidTableName", err)
	}
}

func TestSinglePendingGeneration(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	g1Row, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 1,
		Provider:           generation.ProviderTEI,
		Model:              "tei/BAAI/bge-m3",
		ModelVersion:       "sha1;qp=00000000;dp=00000000",
		Preprocessing:      "v1",
		QueryPrefix:        "",
		DocPrefix:          "",
		Dims:               3,
		Partitions:         4,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.55,
		CalibrationRef:     "docs/benchmarks/semantic-eval/report-bge.json",
		Bootstrap:          true,
	})
	if err != nil {
		t.Fatalf("InsertPendingEmbeddingGeneration g1: %v", err)
	}
	if g1Row.State != generation.StatePending || !g1Row.Bootstrap {
		t.Fatalf("g1 state=%q bootstrap=%v", g1Row.State, g1Row.Bootstrap)
	}

	// Inserting a second pending generation while g1 is pending must fail.
	_, err = q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 2,
		Provider:           generation.ProviderOpenAICompat,
		Model:              "openai_compat/qwen/qwen3-embedding-8b",
		ModelVersion:       "dims=3;instr=12345678",
		Preprocessing:      "v1",
		QueryPrefix:        "Instruct: test\nQuery:",
		DocPrefix:          "",
		Dims:               3,
		Partitions:         4,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.60,
		CalibrationRef:     "docs/benchmarks/semantic-eval/report-qwen.json",
		Bootstrap:          false,
	})
	if !isUniqueViolation(err) {
		t.Fatalf("expected unique violation on second pending generation, got %v", err)
	}

	// Once g1 becomes active, a new pending generation g2 is allowed, and
	// ReceivingGenerations returns R = {active g1, pending g2}.
	if _, err := q.ActivateEmbeddingGeneration(ctx, 1); err != nil {
		t.Fatalf("ActivateEmbeddingGeneration g1: %v", err)
	}
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
		GenerationID:  1,
		FlippedReason: new("initial"),
	}); err != nil {
		t.Fatalf("UpsertEmbeddingActive g1: %v", err)
	}

	if _, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 2,
		Provider:           generation.ProviderOpenAICompat,
		Model:              "openai_compat/qwen/qwen3-embedding-8b",
		ModelVersion:       "dims=3;instr=12345678",
		Preprocessing:      "v1",
		QueryPrefix:        "Instruct: test\nQuery:",
		DocPrefix:          "",
		Dims:               3,
		Partitions:         4,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.60,
		CalibrationRef:     "docs/benchmarks/semantic-eval/report-qwen.json",
		Bootstrap:          false,
	}); err != nil {
		t.Fatalf("InsertPendingEmbeddingGeneration g2 after g1 activated: %v", err)
	}

	// Add g3 retired inside rollback window (in R) and g4 retired past window (not in R, but in ExistingGenerations).
	if _, err := pool.Exec(ctx, `
		INSERT INTO embedding_generation (
			id, provider, model, model_version, preprocessing, query_prefix, doc_prefix,
			dims, semantic_min_cos, calibration_ref, item_table, tag_table, state, rollback_until
		) VALUES
		(3, 'tei', 'tei/old-in-window', 'v1', 'v1', '', '', 3, 0.5, 'ref3', 'item_embedding_g3', 'tag_embedding_g3', 'retired', now() + interval '2 hours'),
		(4, 'tei', 'tei/old-expired',   'v1', 'v1', '', '', 3, 0.5, 'ref4', 'item_embedding_g4', 'tag_embedding_g4', 'retired', now() - interval '2 hours'),
		(5, 'tei', 'tei/dropped',       'v1', 'v1', '', '', 3, 0.5, 'ref5', 'item_embedding_g5', 'tag_embedding_g5', 'dropped', NULL)
	`); err != nil {
		t.Fatalf("seed g3..g5: %v", err)
	}

	receiving, err := generation.ReceivingGenerations(ctx, pool)
	if err != nil {
		t.Fatalf("ReceivingGenerations: %v", err)
	}
	if len(receiving) != 3 || receiving[0].ID != 1 || receiving[1].ID != 2 || receiving[2].ID != 3 {
		t.Fatalf("ReceivingGenerations IDs = %+v, want [1, 2, 3]", receiving)
	}

	existing, err := generation.ExistingGenerations(ctx, pool)
	if err != nil {
		t.Fatalf("ExistingGenerations: %v", err)
	}
	if len(existing) != 4 || existing[0].ID != 1 || existing[1].ID != 2 || existing[2].ID != 3 || existing[3].ID != 4 {
		t.Fatalf("ExistingGenerations IDs = %+v, want [1, 2, 3, 4]", existing)
	}
}

func TestSharedLockBlocksCreate(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool := newTestPool(t)
	q := gen.New(pool)
	ident := sampleBootstrapIdentity()
	calib := func(got embedid.Identity) (float64, string, bool) {
		if got.Key() != ident.Key() {
			return 0, "", false
		}
		return 0.58, "docs/benchmarks/semantic-eval/report-qwen3-3-20261102.json", true
	}

	// Holder transaction acquires the shared generation-set lock (as a mutation tx does).
	txShared, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin txShared: %v", err)
	}
	defer func() { _ = txShared.Rollback(context.Background()) }()

	if err := generation.LockGenerationSetShared(ctx, txShared); err != nil {
		t.Fatalf("LockGenerationSetShared: %v", err)
	}

	type bootResult struct {
		res generation.BootstrapResult
		err error
	}
	bootStarting := make(chan struct{})
	bootDone := make(chan bootResult, 1)
	go func() {
		close(bootStarting)
		res, err := generation.Bootstrap(ctx, pool, ident, calib)
		bootDone <- bootResult{res: res, err: err}
	}()

	<-bootStarting

	// Bounded poll on pg_locks until Bootstrap's exclusive advisory lock request
	// appears with granted = false on the shared generation-set lock key.
	classid := int32(uint64(generation.GenerationSetLockKey) >> 32)
	objid := int32(uint64(generation.GenerationSetLockKey) & 0xffffffff)

	deadline := time.Now().Add(5 * time.Second)
	waitingObserved := false
	for time.Now().Before(deadline) {
		var waitingCount int
		err := pool.QueryRow(ctx, `
			SELECT count(*)
			FROM pg_locks
			WHERE locktype = 'advisory'
			  AND classid = $1
			  AND objid = $2
			  AND mode = 'ExclusiveLock'
			  AND granted = false
		`, classid, objid).Scan(&waitingCount)
		if err != nil {
			t.Fatalf("query pg_locks: %v", err)
		}
		if waitingCount == 1 {
			waitingObserved = true
			break
		}
		runtimeYield(ctx)
	}
	if !waitingObserved {
		t.Fatal("Bootstrap exclusive advisory lock did not block on shared generation-set lock")
	}

	// Verify Bootstrap has NOT completed and no registry row or tables exist before release.
	select {
	case out := <-bootDone:
		t.Fatalf("Bootstrap returned while shared lock held: res=%+v err=%v", out.res, out.err)
	default:
	}

	genCountBefore, err := q.CountEmbeddingGenerations(ctx)
	if err != nil || genCountBefore != 0 {
		t.Fatalf("CountEmbeddingGenerations while blocked = %d err=%v, want 0", genCountBefore, err)
	}
	var tblCountBefore int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'item_embedding_g%' OR table_name LIKE 'tag_embedding_g%'`,
	).Scan(&tblCountBefore); err != nil || tblCountBefore != 0 {
		t.Fatalf("dynamic tables count while blocked = %d err=%v, want 0", tblCountBefore, err)
	}

	// Commit shared transaction -> Bootstrap must now unblock and succeed.
	if err := txShared.Commit(ctx); err != nil {
		t.Fatalf("txShared.Commit: %v", err)
	}

	out := <-bootDone
	if out.err != nil {
		t.Fatalf("Bootstrap after shared release: %v", out.err)
	}
	if !out.res.Created || out.res.Generation.ID != 1 {
		t.Fatalf("Bootstrap result after release = %+v, want Created=true ID=1", out.res)
	}

	genCountAfter, err := q.CountEmbeddingGenerations(ctx)
	if err != nil || genCountAfter != 1 {
		t.Fatalf("CountEmbeddingGenerations after release = %d err=%v, want 1", genCountAfter, err)
	}
	var partCountAfter int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'item_embedding_g1_p%' OR table_name LIKE 'tag_embedding_g1_p%'`,
	).Scan(&partCountAfter); err != nil || partCountAfter != 32 {
		t.Fatalf("partition count after release = %d err=%v, want 32", partCountAfter, err)
	}
}

func runtimeYield(ctx context.Context) {
	select {
	case <-ctx.Done():
	case <-time.After(5 * time.Millisecond):
	}
}

func TestPinCarriesFullIdentity(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	inserted, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 1,
		Provider:           generation.ProviderTEI,
		Model:              "tei/intfloat/multilingual-e5-base",
		ModelVersion:       "rev123;qp=aaaaaaaa;dp=bbbbbbbb",
		Preprocessing:      "v1-custom",
		QueryPrefix:        "query: ",
		DocPrefix:          "passage: ",
		Dims:               768,
		Partitions:         16,
		HnswM:              16,
		HnswEfConstruction: 128,
		SemanticMinCos:     0.62,
		CalibrationRef:     "docs/benchmarks/semantic-eval/report-e5.json",
		Bootstrap:          false,
	})
	if err != nil {
		t.Fatalf("InsertPendingEmbeddingGeneration: %v", err)
	}
	if _, err := q.ActivateEmbeddingGeneration(ctx, inserted.ID); err != nil {
		t.Fatalf("ActivateEmbeddingGeneration: %v", err)
	}
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
		GenerationID:  inserted.ID,
		FlippedReason: new("test"),
	}); err != nil {
		t.Fatalf("UpsertEmbeddingActive: %v", err)
	}

	genRow, err := generation.GetByID(ctx, pool, 1)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}

	var dbReads atomic.Int32
	pinner := generation.NewPinner(pool)
	pinner.SetQueryCountHook(func() {
		dbReads.Add(1)
	})

	pin, err := pinner.ActivePin(ctx)
	if err != nil {
		t.Fatalf("ActivePin: %v", err)
	}
	if got := dbReads.Load(); got != 1 {
		t.Fatalf("ActivePin DB reads = %d, want 1", got)
	}

	// Verify all seven identity fields (including non-empty DocPrefix and custom Preprocessing)
	// and verify Pin.Identity.Key() == genRow.Identity().Key() from the single row read.
	if pin.GenID != 1 {
		t.Fatalf("pin.GenID = %d, want 1", pin.GenID)
	}
	if pin.Identity.Provider != generation.ProviderTEI ||
		pin.Identity.Model != "tei/intfloat/multilingual-e5-base" ||
		pin.Identity.ModelVersion != "rev123;qp=aaaaaaaa;dp=bbbbbbbb" ||
		pin.Identity.Dims != 768 ||
		pin.Identity.QueryPrefix != "query: " ||
		pin.Identity.DocPrefix != "passage: " ||
		pin.Identity.Preprocessing != "v1-custom" {
		t.Fatalf("pin.Identity mismatch: %+v", pin.Identity)
	}
	if pin.Identity.Key() != genRow.Identity().Key() {
		t.Fatalf("pin.Identity.Key() = %q, want %q", pin.Identity.Key(), genRow.Identity().Key())
	}
	if pin.ItemTable != "item_embedding_g1" || pin.TagTable != "tag_embedding_g1" {
		t.Fatalf("pin tables = (%q, %q), want (item_embedding_g1, tag_embedding_g1)", pin.ItemTable, pin.TagTable)
	}

	// Second call within TTL must hit cache (0 additional DB reads).
	pin2, err := pinner.ActivePin(ctx)
	if err != nil {
		t.Fatalf("ActivePin cached: %v", err)
	}
	if got := dbReads.Load(); got != 1 {
		t.Fatalf("ActivePin DB reads after cache hit = %d, want 1", got)
	}
	if pin2.Identity.Key() != pin.Identity.Key() {
		t.Fatalf("cached pin Identity.Key() changed")
	}
}

func TestPinStableAcrossFlip(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t)
	q := gen.New(pool)

	// Seed g1 active and g2 pending.
	if _, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 1,
		Provider:           generation.ProviderTEI,
		Model:              "tei/BAAI/bge-m3",
		ModelVersion:       "v1",
		Preprocessing:      "v1",
		QueryPrefix:        "",
		DocPrefix:          "doc1: ",
		Dims:               1024,
		Partitions:         16,
		HnswM:              16,
		HnswEfConstruction: 128,
		SemanticMinCos:     0.55,
		CalibrationRef:     "ref1",
		Bootstrap:          true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.ActivateEmbeddingGeneration(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
		GenerationID:  1,
		FlippedReason: new("boot"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 2,
		Provider:           generation.ProviderOpenAICompat,
		Model:              "openai_compat/qwen/qwen3-embedding-8b",
		ModelVersion:       "v2",
		Preprocessing:      "v1",
		QueryPrefix:        "Instruct: search\nQuery:",
		DocPrefix:          "doc2: ",
		Dims:               768,
		Partitions:         16,
		HnswM:              16,
		HnswEfConstruction: 128,
		SemanticMinCos:     0.65,
		CalibrationRef:     "ref2",
		Bootstrap:          false,
	}); err != nil {
		t.Fatal(err)
	}

	pinner := generation.NewPinner(pool)

	// Simulate an in-flight request that pins g1, and via the test-only hook a
	// cutover flip to g2 + cache invalidation happens immediately after the request
	// acquired its Pin.
	flipTriggered := false
	reqCtx := generation.WithAfterPinReadHook(ctx, func(pinned generation.Pin) {
		flipTriggered = true
		if pinned.GenID != 1 {
			t.Errorf("hook saw GenID=%d, want 1", pinned.GenID)
		}
		_, err := q.RetireEmbeddingGeneration(ctx, gen.RetireEmbeddingGenerationParams{
			ID:            1,
			RollbackUntil: pgtype.Timestamptz{Time: time.Now().Add(24 * time.Hour), Valid: true},
		})
		if err != nil {
			t.Errorf("RetireEmbeddingGeneration g1: %v", err)
		}
		if _, err := q.ActivateEmbeddingGeneration(ctx, 2); err != nil {
			t.Errorf("ActivateEmbeddingGeneration g2: %v", err)
		}
		if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
			GenerationID:  2,
			FlippedReason: new("cutover"),
		}); err != nil {
			t.Errorf("UpsertEmbeddingActive g2: %v", err)
		}
		pinner.Invalidate()
	})

	// Request 1 acquires its Pin once and uses that same Pin for all downstream steps.
	req1Pin, err := pinner.ActivePin(reqCtx)
	if err != nil {
		t.Fatalf("req1 ActivePin: %v", err)
	}
	if !flipTriggered {
		t.Fatal("expected WithAfterPinReadHook to fire")
	}
	if req1Pin.GenID != 1 || req1Pin.Identity.Dims != 1024 || req1Pin.ItemTable != "item_embedding_g1" || req1Pin.TagTable != "tag_embedding_g1" {
		t.Fatalf("req1Pin mutated or wrong across flip: %+v", req1Pin)
	}

	// Subsequent request sees g2 immediately.
	req2Pin, err := pinner.ActivePin(ctx)
	if err != nil {
		t.Fatalf("req2 ActivePin: %v", err)
	}
	if req2Pin.GenID != 2 || req2Pin.Identity.Dims != 768 || req2Pin.ItemTable != "item_embedding_g2" {
		t.Fatalf("req2Pin = %+v, want GenID=2 Dims=768", req2Pin)
	}
}

func TestPinCacheInvalidatedByNotify(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool := newTestPool(t)
	q := gen.New(pool)

	// Fake clock frozen at t0 so the 2 s TTL never expires during the test.
	t0 := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	pinner := generation.NewPinner(pool, generation.WithPinNowFunc(func() time.Time {
		return t0
	}))
	defer pinner.Close()

	if err := pinner.StartListener(ctx); err != nil {
		t.Fatalf("StartListener: %v", err)
	}

	subNotified := make(chan struct{}, 4)
	pinner.Subscribe(func() {
		select {
		case subNotified <- struct{}{}:
		default:
		}
	})

	// Seed g1 active and g2 pending.
	if _, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 1,
		Provider:           generation.ProviderTEI,
		Model:              "tei/BAAI/bge-m3",
		ModelVersion:       "v1",
		Preprocessing:      "v1",
		QueryPrefix:        "",
		DocPrefix:          "",
		Dims:               3,
		Partitions:         4,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.55,
		CalibrationRef:     "ref1",
		Bootstrap:          true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.ActivateEmbeddingGeneration(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
		GenerationID:  1,
		FlippedReason: new("boot"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 2,
		Provider:           generation.ProviderOpenAICompat,
		Model:              "openai_compat/qwen/qwen3-embedding-8b",
		ModelVersion:       "v2",
		Preprocessing:      "v1",
		QueryPrefix:        "Instruct: q\nQuery:",
		DocPrefix:          "",
		Dims:               3,
		Partitions:         4,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.65,
		CalibrationRef:     "ref2",
		Bootstrap:          false,
	}); err != nil {
		t.Fatal(err)
	}

	// Populate cache with g1.
	pin1, err := pinner.ActivePin(ctx)
	if err != nil || pin1.GenID != 1 {
		t.Fatalf("initial ActivePin = %+v err=%v, want GenID=1", pin1, err)
	}

	// Flip active to g2 and emit NOTIFY embedding_generation_changed.
	if _, err := q.RetireEmbeddingGeneration(ctx, gen.RetireEmbeddingGenerationParams{
		ID:            1,
		RollbackUntil: pgtype.Timestamptz{Time: t0.Add(24 * time.Hour), Valid: true},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.ActivateEmbeddingGeneration(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
		GenerationID:  2,
		FlippedReason: new("flip"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "NOTIFY "+generation.NotifyChannel); err != nil {
		t.Fatalf("NOTIFY: %v", err)
	}

	// Wait on the Subscribe callback channel (no sleep; frozen clock never advances 2 s).
	select {
	case <-subNotified:
	case <-ctx.Done():
		t.Fatal("timed out waiting for Subscribe callback on NOTIFY")
	}

	// Next ActivePin read must immediately return g2 without waiting for the 2 s TTL.
	pin2, err := pinner.ActivePin(ctx)
	if err != nil {
		t.Fatalf("ActivePin after NOTIFY: %v", err)
	}
	if pin2.GenID != 2 || pin2.Identity.Model != "openai_compat/qwen/qwen3-embedding-8b" {
		t.Fatalf("ActivePin after NOTIFY = %+v, want GenID=2", pin2)
	}
}

func TestPinListenerRetryAfterFailedStartReceivesNotify(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool := newTestPool(t)
	q := gen.New(pool)

	t0 := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	var attempt atomic.Int32
	simulatedErr := errors.New("simulated initial startup failure")

	pinner := generation.NewPinner(
		pool,
		generation.WithPinNowFunc(func() time.Time { return t0 }),
		generation.WithBeforeListenHook(func(context.Context) error {
			if attempt.Add(1) == 1 {
				return simulatedErr
			}
			return nil
		}),
	)
	defer pinner.Close()

	// 1. First StartListener call fails via the hook and returns the real error.
	if err := pinner.StartListener(ctx); !errors.Is(err, simulatedErr) {
		t.Fatalf("first StartListener err = %v, want %v", err, simulatedErr)
	}

	// Also verify a canceled-context attempt fails and does not poison subsequent retry.
	canceledCtx, cancelNow := context.WithCancel(ctx)
	cancelNow()
	if err := pinner.StartListener(canceledCtx); err == nil {
		t.Fatal("StartListener with canceled ctx must return error")
	}

	// 2. Retry with healthy context succeeds and starts the listener.
	if err := pinner.StartListener(ctx); err != nil {
		t.Fatalf("retry StartListener with healthy ctx: %v", err)
	}

	subNotified := make(chan struct{}, 4)
	pinner.Subscribe(func() {
		select {
		case subNotified <- struct{}{}:
		default:
		}
	})

	if _, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 1,
		Provider:           generation.ProviderTEI,
		Model:              "tei/BAAI/bge-m3",
		ModelVersion:       "v1",
		Preprocessing:      "v1",
		QueryPrefix:        "",
		DocPrefix:          "",
		Dims:               3,
		Partitions:         4,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.55,
		CalibrationRef:     "ref1",
		Bootstrap:          true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.ActivateEmbeddingGeneration(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
		GenerationID:  1,
		FlippedReason: new("boot"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertPendingEmbeddingGeneration(ctx, gen.InsertPendingEmbeddingGenerationParams{
		ID:                 2,
		Provider:           generation.ProviderOpenAICompat,
		Model:              "openai_compat/qwen/qwen3-embedding-8b",
		ModelVersion:       "v2",
		Preprocessing:      "v1",
		QueryPrefix:        "Instruct: q\nQuery:",
		DocPrefix:          "",
		Dims:               3,
		Partitions:         4,
		HnswM:              16,
		HnswEfConstruction: 64,
		SemanticMinCos:     0.65,
		CalibrationRef:     "ref2",
		Bootstrap:          false,
	}); err != nil {
		t.Fatal(err)
	}

	pin1, err := pinner.ActivePin(ctx)
	if err != nil || pin1.GenID != 1 {
		t.Fatalf("initial ActivePin = %+v err=%v, want GenID=1", pin1, err)
	}

	if _, err := q.RetireEmbeddingGeneration(ctx, gen.RetireEmbeddingGenerationParams{
		ID:            1,
		RollbackUntil: pgtype.Timestamptz{Time: t0.Add(24 * time.Hour), Valid: true},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.ActivateEmbeddingGeneration(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := q.UpsertEmbeddingActive(ctx, gen.UpsertEmbeddingActiveParams{
		GenerationID:  2,
		FlippedReason: new("flip"),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "NOTIFY "+generation.NotifyChannel); err != nil {
		t.Fatalf("NOTIFY: %v", err)
	}

	select {
	case <-subNotified:
	case <-ctx.Done():
		t.Fatal("timed out waiting for Subscribe callback after retry StartListener")
	}

	pin2, err := pinner.ActivePin(ctx)
	if err != nil || pin2.GenID != 2 {
		t.Fatalf("ActivePin after NOTIFY = %+v err=%v, want GenID=2", pin2, err)
	}
}

func TestPinListenerConcurrentWaiterReturnsFailedAttemptError(t *testing.T) {
	pool := newTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)

	attemptAEntered := make(chan struct{})
	var attemptAEnteredOnce sync.Once
	releaseAttemptA := make(chan struct{})
	var releaseAttemptAOnce sync.Once
	doReleaseAttemptA := func() { releaseAttemptAOnce.Do(func() { close(releaseAttemptA) }) }

	attemptCEntered := make(chan struct{})
	var attemptCEnteredOnce sync.Once
	releaseAttemptC := make(chan struct{})
	var releaseAttemptCOnce sync.Once
	doReleaseAttemptC := func() { releaseAttemptCOnce.Do(func() { close(releaseAttemptC) }) }

	errAttemptA := errors.New("simulated startup failure on attempt A")
	var hookCall atomic.Int32

	pinner := generation.NewPinner(
		pool,
		generation.WithBeforeListenHook(func(hookCtx context.Context) error {
			switch hookCall.Add(1) {
			case 1:
				attemptAEnteredOnce.Do(func() { close(attemptAEntered) })
				select {
				case <-releaseAttemptA:
				case <-hookCtx.Done():
				}
				return errAttemptA
			case 2:
				attemptCEnteredOnce.Do(func() { close(attemptCEntered) })
				select {
				case <-releaseAttemptC:
					return hookCtx.Err()
				case <-hookCtx.Done():
					return hookCtx.Err()
				}
			default:
				return nil
			}
		}),
	)

	var wg sync.WaitGroup
	t.Cleanup(func() {
		doReleaseAttemptA()
		doReleaseAttemptC()
		cancel()
		pinner.Close()
		wg.Wait()
	})

	// 1. Launch attempt A and wait until it holds startup in the hook.
	errACh := make(chan error, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		errACh <- pinner.StartListener(ctx)
	}()

	select {
	case <-attemptAEntered:
	case <-ctx.Done():
		t.Fatal("timed out waiting for attempt A to enter hook")
	}

	// 2. Launch waiter B while attempt A is in progress and wait for its goroutine to start.
	waiterBStarting := make(chan struct{})
	errBCh := make(chan error, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		close(waiterBStarting)
		errBCh <- pinner.StartListener(ctx)
	}()
	<-waiterBStarting

	// Release attempt A so it fails with errAttemptA.
	doReleaseAttemptA()
	select {
	case errA := <-errACh:
		if !errors.Is(errA, errAttemptA) {
			t.Fatalf("attempt A error = %v, want %v", errA, errAttemptA)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for attempt A to fail")
	}

	// 3. Launch retry C, which blocks inside the hook without completing LISTEN.
	errCCh := make(chan error, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		errCCh <- pinner.StartListener(ctx)
	}()

	select {
	case <-attemptCEntered:
	case <-ctx.Done():
		t.Fatal("timed out waiting for retry C to enter hook")
	}

	// 4. Waiter B (which waited on attempt A) must return attempt A's error (errAttemptA)
	// and must never return nil while retry C is still blocked before LISTEN.
	select {
	case errB := <-errBCh:
		if !errors.Is(errB, errAttemptA) {
			t.Fatalf("waiter B error = %v, want attempt A error %v", errB, errAttemptA)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for waiter B to return")
	}

	// 5. Release retry C and verify it succeeds and finishes cleanly.
	doReleaseAttemptC()
	select {
	case errC := <-errCCh:
		if errC != nil {
			t.Fatalf("retry C error = %v, want nil", errC)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for retry C to complete")
	}
}

func TestPinListenerCloseCancelsBlockedStart(t *testing.T) {
	pool := newTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)

	inStartup := make(chan struct{})
	var inStartupOnce sync.Once
	cancelObserved := make(chan struct{})
	var cancelObservedOnce sync.Once
	releaseBarrier := make(chan struct{})
	var releaseOnce sync.Once
	doRelease := func() { releaseOnce.Do(func() { close(releaseBarrier) }) }

	pinner := generation.NewPinner(
		pool,
		generation.WithBeforeListenHook(func(hookCtx context.Context) error {
			inStartupOnce.Do(func() { close(inStartup) })
			select {
			case <-releaseBarrier:
				return hookCtx.Err()
			case <-hookCtx.Done():
				cancelObservedOnce.Do(func() { close(cancelObserved) })
				<-releaseBarrier
				return hookCtx.Err()
			}
		}),
	)

	var wg sync.WaitGroup
	// Register idempotent cleanup ordered to run before newTestPool's cleanup (LIFO).
	t.Cleanup(func() {
		doRelease()
		cancel()
		pinner.Close()
		wg.Wait()
	})

	startErrCh := make(chan error, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		startErrCh <- pinner.StartListener(ctx)
	}()

	// Wait until StartListener has acquired a pool connection and entered the barrier.
	select {
	case <-inStartup:
	case <-ctx.Done():
		t.Fatal("timed out waiting for StartListener to enter barrier")
	}
	if got := pool.Stat().AcquiredConns(); got != 1 {
		t.Fatalf("AcquiredConns while in startup barrier = %d, want 1", got)
	}

	closeDone := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		pinner.Close()
		close(closeDone)
	}()

	// Wait until the hook deterministically observes cancellation from Close.
	select {
	case <-cancelObserved:
	case <-ctx.Done():
		t.Fatal("timed out waiting for startup hook to observe cancellation from Close")
	}

	// Before releasing the barrier, Close must still be waiting on the in-progress startup.
	select {
	case <-closeDone:
		t.Fatal("Close returned before blocked StartListener was released from barrier")
	default:
	}

	// Release the barrier so StartListener and Close can finish deterministically.
	doRelease()

	var startErr error
	select {
	case startErr = <-startErrCh:
	case <-ctx.Done():
		t.Fatal("timed out waiting for StartListener to return after Close")
	}
	if !errors.Is(startErr, generation.ErrPinnerClosed) && !errors.Is(startErr, context.Canceled) {
		t.Fatalf("StartListener error after concurrent Close = %v, want ErrPinnerClosed or context.Canceled", startErr)
	}

	select {
	case <-closeDone:
	case <-ctx.Done():
		t.Fatal("timed out waiting for Close to return")
	}

	// Connection must be released back to the pool when Close has returned.
	if got := pool.Stat().AcquiredConns(); got != 0 {
		t.Fatalf("AcquiredConns after Close returned = %d, want 0", got)
	}

	// Subsequent StartListener after Close must fail with ErrPinnerClosed and not acquire a connection.
	if err := pinner.StartListener(ctx); !errors.Is(err, generation.ErrPinnerClosed) {
		t.Fatalf("StartListener after Close = %v, want ErrPinnerClosed", err)
	}
	if got := pool.Stat().AcquiredConns(); got != 0 {
		t.Fatalf("AcquiredConns after post-Close StartListener = %d, want 0", got)
	}
}

func TestPinListenerCloseAfterListenUnlistensBeforePoolRelease(t *testing.T) {
	pool := newTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)

	afterListenEntered := make(chan struct{})
	var enteredOnce sync.Once
	cancelObserved := make(chan struct{})
	var cancelObservedOnce sync.Once
	releaseBarrier := make(chan struct{})
	var releaseOnce sync.Once
	doRelease := func() { releaseOnce.Do(func() { close(releaseBarrier) }) }

	pinner := generation.NewPinner(
		pool,
		generation.WithAfterListenHook(func(hookCtx context.Context) {
			enteredOnce.Do(func() { close(afterListenEntered) })
			select {
			case <-releaseBarrier:
			case <-hookCtx.Done():
				cancelObservedOnce.Do(func() { close(cancelObserved) })
				<-releaseBarrier
			}
		}),
	)

	var wg sync.WaitGroup
	t.Cleanup(func() {
		doRelease()
		cancel()
		pinner.Close()
		wg.Wait()
	})

	startErrCh := make(chan error, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		startErrCh <- pinner.StartListener(ctx)
	}()

	// Wait until LISTEN has succeeded and StartListener is paused before publishing.
	select {
	case <-afterListenEntered:
	case <-ctx.Done():
		t.Fatal("timed out waiting for StartListener to reach afterListen hook")
	}
	if got := pool.Stat().AcquiredConns(); got != 1 {
		t.Fatalf("AcquiredConns during afterListen hook = %d, want 1", got)
	}

	closeDone := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		pinner.Close()
		close(closeDone)
	}()

	// Wait until Close has set closed=true and canceled the startup context.
	select {
	case <-cancelObserved:
	case <-ctx.Done():
		t.Fatal("timed out waiting for afterListen hook to observe cancellation from Close")
	}

	select {
	case <-closeDone:
		t.Fatal("Close returned before afterListen barrier was released")
	default:
	}

	doRelease()

	select {
	case startErr := <-startErrCh:
		if !errors.Is(startErr, generation.ErrPinnerClosed) {
			t.Fatalf("StartListener error after post-LISTEN Close = %v, want ErrPinnerClosed", startErr)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for StartListener to return")
	}

	select {
	case <-closeDone:
	case <-ctx.Done():
		t.Fatal("timed out waiting for Close to return")
	}

	if got := pool.Stat().AcquiredConns(); got != 0 {
		t.Fatalf("AcquiredConns after Close = %d, want 0", got)
	}

	// Inspect every idle connection in the pool (or newly acquired connection)
	// and verify none remain subscribed to NotifyChannel.
	idleCount := int(pool.Stat().IdleConns())
	checkCount := max(idleCount, 1)
	acquired := make([]*pgxpool.Conn, 0, checkCount)
	defer func() {
		for _, c := range acquired {
			c.Release()
		}
	}()
	for i := range checkCount {
		c, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatalf("Acquire connection %d to verify pg_listening_channels: %v", i, err)
		}
		acquired = append(acquired, c)
		rows, err := c.Query(ctx, `SELECT pg_listening_channels()`)
		if err != nil {
			t.Fatalf("query pg_listening_channels on conn %d: %v", i, err)
		}
		channels, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			t.Fatalf("collect pg_listening_channels on conn %d: %v", i, err)
		}
		for _, ch := range channels {
			if ch == generation.NotifyChannel {
				t.Fatalf("pooled connection %d still listening on %q after aborted StartListener", i, ch)
			}
		}
	}
}

func TestBootstrapConcurrentCallersWithDeadline(t *testing.T) {
	pool := newTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	ident := sampleBootstrapIdentity()

	calib := func(got embedid.Identity) (float64, string, bool) {
		if got.Key() != ident.Key() {
			return 0, "", false
		}
		return 0.58, "docs/benchmarks/semantic-eval/report-qwen3-3-20261102.json", true
	}

	type callerResult struct {
		res generation.BootstrapResult
		err error
	}
	startBarrier := make(chan struct{})
	var releaseOnce sync.Once
	doRelease := func() { releaseOnce.Do(func() { close(startBarrier) }) }

	var readyWG sync.WaitGroup
	readyWG.Add(2)
	results := make([]callerResult, 2)
	var doneWG sync.WaitGroup
	doneWG.Add(2)

	t.Cleanup(func() {
		doRelease()
		cancel()
		doneWG.Wait()
	})

	for i := range 2 {
		go func(idx int) {
			defer doneWG.Done()
			readyWG.Done()
			select {
			case <-startBarrier:
			case <-ctx.Done():
				results[idx] = callerResult{err: ctx.Err()}
				return
			}
			res, err := generation.Bootstrap(ctx, pool, ident, calib)
			results[idx] = callerResult{res: res, err: err}
		}(i)
	}

	readyWG.Wait()
	doRelease()
	doneWG.Wait()

	createdCount := 0
	for i, r := range results {
		if r.err != nil {
			t.Fatalf("concurrent caller %d returned error: %v", i, r.err)
		}
		if r.res.Created {
			createdCount++
			if r.res.Generation.ID != 1 ||
				r.res.Generation.State != generation.StatePending ||
				!r.res.Generation.Bootstrap ||
				r.res.Generation.Identity().Key() != ident.Key() {
				t.Fatalf("creator caller %d generation mismatch: %+v", i, r.res.Generation)
			}
		}
	}
	if createdCount != 1 {
		t.Fatalf("concurrent Bootstrap Created count = %d, want 1 (results=%+v)", createdCount, results)
	}

	q := gen.New(pool)
	totalCount, err := q.CountEmbeddingGenerations(ctx)
	if err != nil || totalCount != 1 {
		t.Fatalf("CountEmbeddingGenerations = %d err=%v, want 1", totalCount, err)
	}
}
