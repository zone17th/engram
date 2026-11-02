package db_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
)

func TestEmbeddingMigration0009SchemaAndFunctions(t *testing.T) {
	ctx := context.Background()

	// Single shared container for the test: start at version 7, seed P04 data
	// (user, item, tag, entry), migrate up to latest (without assuming version 8
	// is already on this branch), verify P04 rows survive, then exercise all
	// 0009 schema constraints, DDL functions, and down migration.
	dsn := dbtest.StartPostgres(t)
	migrateToVersion(t, dsn, 7)

	v7, dirty7, err := db.Version(dsn)
	if err != nil || dirty7 || v7 != 7 {
		t.Fatalf("at v7: version=%d dirty=%v err=%v", v7, dirty7, err)
	}

	pool := dbtest.Pool(t, dsn)
	q := gen.New(pool)

	uP04, err := q.InsertUser(ctx, gen.InsertUserParams{
		Email:  "p04-embed-survivor@example.com",
		Locale: "vi",
	})
	if err != nil {
		t.Fatalf("InsertUser at v7: %v", err)
	}

	itemP04, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         uP04.ID,
		Name:           "Tài khoản ngân hàng",
		NameNormalized: "tài khoản ngân hàng",
		Hint:           new("VCB chính"),
	})
	if err != nil {
		t.Fatalf("InsertItem at v7: %v", err)
	}

	tagP04, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     uP04.ID,
		Display:    "Tài chính",
		Normalized: "tài chính",
	})
	if err != nil {
		t.Fatalf("InsertTag at v7: %v", err)
	}

	validEnv := []byte(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"vk:AAAAAAAAAAAAAAAAAAAAAA","nonce":"AAAAAAAAAAAAAAAAAAAAAAAA","ct_enc":"utf8"}`)
	entryP04, err := q.InsertEntry(ctx, gen.InsertEntryParams{
		ID:                 uuid.New(),
		UserID:             uP04.ID,
		ItemID:             itemP04.ID,
		Type:               "text",
		Envelope:           validEnv,
		Ciphertext:         make([]byte, 32),
		PlaintextLenBucket: 256,
	})
	if err != nil {
		t.Fatalf("InsertEntry at v7: %v", err)
	}

	// Migrate up from 7 to latest (0009).
	dbtest.MigrateUp(t, dsn)
	vUp, dirtyUp, err := db.Version(dsn)
	if err != nil || dirtyUp || vUp < 9 {
		t.Fatalf("after MigrateUp: version=%d dirty=%v err=%v", vUp, dirtyUp, err)
	}

	// Verify P04 rows survive intact.
	gotUser, err := q.GetUserByID(ctx, uP04.ID)
	if err != nil || gotUser.Email != uP04.Email {
		t.Fatalf("GetUserByID after 0009: got=%+v err=%v", gotUser, err)
	}
	gotItem, err := q.GetItemByUserAndID(ctx, gen.GetItemByUserAndIDParams{
		UserID: uP04.ID,
		ID:     itemP04.ID,
	})
	if err != nil || gotItem.Name != itemP04.Name {
		t.Fatalf("GetItemByUserAndID after 0009: got=%+v err=%v", gotItem, err)
	}
	gotTag, err := q.GetTagByUserAndID(ctx, gen.GetTagByUserAndIDParams{
		UserID: uP04.ID,
		ID:     tagP04.ID,
	})
	if err != nil || gotTag.Display != tagP04.Display {
		t.Fatalf("GetTagByUserAndID after 0009: got=%+v err=%v", gotTag, err)
	}
	var entryCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM entry WHERE id = $1 AND user_id = $2`, entryP04.ID, uP04.ID).Scan(&entryCount); err != nil || entryCount != 1 {
		t.Fatalf("entry after 0009: count=%d err=%v", entryCount, err)
	}

	// Verify 0009 tables exist and no item_embedding_g* / tag_embedding_g* tables exist yet.
	for _, tbl := range []string{"embedding_generation", "embedding_active"} {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, tbl).Scan(&n); err != nil {
			t.Fatalf("query table %s: %v", tbl, err)
		}
		if n != 1 {
			t.Fatalf("expected table %s after 0009, got count=%d", tbl, n)
		}
	}
	var gTables int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'item_embedding_g%' OR table_name LIKE 'tag_embedding_g%'`,
	).Scan(&gTables); err != nil {
		t.Fatal(err)
	}
	if gTables != 0 {
		t.Fatalf("0009 migration itself must not create g<N> tables, got %d", gTables)
	}

	insertGenSQL := `
		INSERT INTO embedding_generation (
			id, provider, model, model_version, preprocessing,
			query_prefix, doc_prefix, dims, semantic_min_cos,
			calibration_ref, item_table, tag_table, state, bootstrap
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
	`

	// CHECK constraints on embedding_generation:
	// 1. id 0, 10000, and -1 rejected specifically by the id range CHECK
	// (using table names derived from badID so item_table/tag_table CHECKs are satisfied).
	for _, badID := range []int{0, 10000, -1} {
		_, err := pool.Exec(ctx, insertGenSQL,
			badID, "tei", "tei/bge-m3", "v1", "v1", "", "", 3, 0.5,
			"docs/benchmarks/semantic-eval/report.json",
			fmt.Sprintf("item_embedding_g%d", badID),
			fmt.Sprintf("tag_embedding_g%d", badID),
			"pending", false,
		)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" || pgErr.ConstraintName != "embedding_generation_id_check" {
			t.Fatalf("id=%d must fail CHECK embedding_generation_id_check, got err=%v (constraint=%q)",
				badID, err, func() string {
					if pgErr != nil {
						return pgErr.ConstraintName
					}
					return ""
				}())
		}
	}

	// 2. dims 0 and 2001 rejected.
	for _, badDims := range []int{0, 2001, -5} {
		_, err := pool.Exec(ctx, insertGenSQL,
			1, "tei", "tei/bge-m3", "v1", "v1", "", "", badDims, 0.5,
			"docs/benchmarks/semantic-eval/report.json",
			"item_embedding_g1", "tag_embedding_g1", "pending", false,
		)
		if !isCheckViolation(err) {
			t.Fatalf("dims=%d must fail CHECK, got err=%v", badDims, err)
		}
	}

	// 3. semantic_min_cos 0 and 1 (and negative / >1) rejected.
	for _, badCos := range []float32{0, 1, -0.1, 1.1} {
		_, err := pool.Exec(ctx, insertGenSQL,
			1, "tei", "tei/bge-m3", "v1", "v1", "", "", 3, badCos,
			"docs/benchmarks/semantic-eval/report.json",
			"item_embedding_g1", "tag_embedding_g1", "pending", false,
		)
		if !isCheckViolation(err) {
			t.Fatalf("semantic_min_cos=%v must fail CHECK, got err=%v", badCos, err)
		}
	}

	// 4. bad provider and bad state rejected.
	if _, err := pool.Exec(ctx, insertGenSQL,
		1, "noop", "noop", "v1", "v1", "", "", 3, 0.5,
		"docs/benchmarks/semantic-eval/report.json",
		"item_embedding_g1", "tag_embedding_g1", "pending", false,
	); !isCheckViolation(err) {
		t.Fatalf("provider='noop' must fail CHECK, got err=%v", err)
	}
	if _, err := pool.Exec(ctx, insertGenSQL,
		1, "tei", "tei/bge-m3", "v1", "v1", "", "", 3, 0.5,
		"docs/benchmarks/semantic-eval/report.json",
		"item_embedding_g1", "tag_embedding_g1", "running", false,
	); !isCheckViolation(err) {
		t.Fatalf("state='running' must fail CHECK, got err=%v", err)
	}

	// 5. mismatched item_table / tag_table rejected.
	if _, err := pool.Exec(ctx, insertGenSQL,
		1, "tei", "tei/bge-m3", "v1", "v1", "", "", 3, 0.5,
		"docs/benchmarks/semantic-eval/report.json",
		"item_embedding_g2", "tag_embedding_g1", "pending", false,
	); !isCheckViolation(err) {
		t.Fatalf("mismatched item_table must fail CHECK, got err=%v", err)
	}
	if _, err := pool.Exec(ctx, insertGenSQL,
		1, "tei", "tei/bge-m3", "v1", "v1", "", "", 3, 0.5,
		"docs/benchmarks/semantic-eval/report.json",
		"item_embedding_g1", "tag_embedding_g2", "pending", false,
	); !isCheckViolation(err) {
		t.Fatalf("mismatched tag_table must fail CHECK, got err=%v", err)
	}

	// Insert valid g1 pending.
	if _, err := pool.Exec(ctx, insertGenSQL,
		1, "tei", "tei/bge-m3", "sha1", "v1", "", "", 3, 0.55,
		"docs/benchmarks/semantic-eval/report.json",
		"item_embedding_g1", "tag_embedding_g1", "pending", true,
	); err != nil {
		t.Fatalf("insert valid g1 pending: %v", err)
	}

	// 6. Second pending generation rejected by partial unique index.
	if _, err := pool.Exec(ctx, insertGenSQL,
		2, "openai_compat", "openai_compat/qwen3", "sha2", "v1", "Instruct: q\nQuery:", "", 3, 0.60,
		"docs/benchmarks/semantic-eval/report2.json",
		"item_embedding_g2", "tag_embedding_g2", "pending", false,
	); !isUniqueViolation(err) {
		t.Fatalf("second pending generation must fail unique index, got err=%v", err)
	}

	// 7. embedding_generation_create_tables range checks.
	badCreateCalls := []struct {
		name string
		id   int
		dims int
		part int
		m    int
		efc  int
	}{
		{"id=0", 0, 3, 4, 16, 64},
		{"id=10000", 10000, 3, 4, 16, 64},
		{"dims=0", 1, 0, 4, 16, 64},
		{"dims=2001", 1, 2001, 4, 16, 64},
		{"partitions=0", 1, 3, 0, 16, 64},
		{"partitions=257", 1, 3, 257, 16, 64},
		{"m=1", 1, 3, 4, 1, 64},
		{"efc<2*m", 1, 3, 4, 16, 16},
		{"missing gen", 99, 3, 4, 16, 64},
	}
	for _, tc := range badCreateCalls {
		if _, err := pool.Exec(ctx,
			`SELECT embedding_generation_create_tables($1, $2, $3, false, $4, $5)`,
			tc.id, tc.dims, tc.part, tc.m, tc.efc,
		); err == nil {
			t.Fatalf("create_tables(%s) must fail", tc.name)
		}
	}

	// Create tables for g1 with 4 partitions and HNSW on empty tables (dims=3).
	if _, err := pool.Exec(ctx, `SELECT embedding_generation_create_tables(1, 3, 4, true, 16, 64)`); err != nil {
		t.Fatalf("create_tables g1: %v", err)
	}
	var partCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'item_embedding_g1_p%' OR table_name LIKE 'tag_embedding_g1_p%'`,
	).Scan(&partCount); err != nil || partCount != 8 {
		t.Fatalf("expected 8 partitions (4 item + 4 tag), got %d err=%v", partCount, err)
	}
	var hnswCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM pg_indexes WHERE indexname LIKE 'item_embedding_g1_p%_hnsw' OR indexname LIKE 'tag_embedding_g1_p%_hnsw'`,
	).Scan(&hnswCount); err != nil || hnswCount != 8 {
		t.Fatalf("expected 8 HNSW partition indexes, got %d err=%v", hnswCount, err)
	}

	// 8. embedding_generation_drop_tables refuses pending and active generations.
	if _, err := pool.Exec(ctx, `SELECT embedding_generation_drop_tables(1)`); err == nil {
		t.Fatal("drop_tables must refuse pending generation")
	}
	if _, err := pool.Exec(ctx, `UPDATE embedding_generation SET state = 'active', activated_at = now() WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO embedding_active (singleton, generation_id, flipped_reason) VALUES (true, 1, 'test')`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `SELECT embedding_generation_drop_tables(1)`); err == nil {
		t.Fatal("drop_tables must refuse active generation")
	}
	// Even if state were retired while still pointed to by embedding_active, drop_tables must refuse.
	if _, err := pool.Exec(ctx, `UPDATE embedding_generation SET state = 'retired', retired_at = now() WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `SELECT embedding_generation_drop_tables(1)`); err == nil || !strings.Contains(err.Error(), "active") {
		t.Fatalf("drop_tables must refuse generation referenced by embedding_active, got err=%v", err)
	}

	// Remove active pointer and verify drop_tables succeeds when state='retired' and not active.
	if _, err := pool.Exec(ctx, `DELETE FROM embedding_active`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `SELECT embedding_generation_drop_tables(1)`); err != nil {
		t.Fatalf("drop_tables on retired non-active g1: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'item_embedding_g1%' OR table_name LIKE 'tag_embedding_g1%'`,
	).Scan(&partCount); err != nil || partCount != 0 {
		t.Fatalf("expected 0 g1 tables after drop_tables, got %d err=%v", partCount, err)
	}

	// Recreate g1 tables so we also verify down migration drops remaining g<N> tables cleanly.
	if _, err := pool.Exec(ctx, `SELECT embedding_generation_create_tables(1, 3, 2, false, 16, 64)`); err != nil {
		t.Fatalf("recreate g1 tables before MigrateDown: %v", err)
	}

	// 9. Down migration works and cleans up 0009 objects while preserving P04 data.
	if err := db.MigrateDown(dsn); err != nil {
		t.Fatalf("MigrateDown from 0009: %v", err)
	}
	for _, tbl := range []string{"embedding_generation", "embedding_active", "item_embedding_g1", "tag_embedding_g1"} {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, tbl).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("MigrateDown must drop %s, got count=%d", tbl, n)
		}
	}
	if _, err := q.GetItemByUserAndID(ctx, gen.GetItemByUserAndIDParams{UserID: uP04.ID, ID: itemP04.ID}); err != nil {
		t.Fatalf("P04 item must survive MigrateDown: %v", err)
	}

	// Migrate back up to leave DB at latest.
	dbtest.MigrateUp(t, dsn)
}
