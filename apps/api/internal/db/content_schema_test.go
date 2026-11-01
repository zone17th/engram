package db_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/zone17th/engram/apps/api/internal/db"
	"github.com/zone17th/engram/apps/api/internal/db/dbtest"
	"github.com/zone17th/engram/apps/api/internal/db/gen"
)

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

func TestContentMigration0006CleanAndFrom0005WithData(t *testing.T) {
	ctx := context.Background()

	// 1. Migrate a clean DB directly to latest (version 6).
	dsnClean := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsnClean)

	v, dirty, err := db.Version(dsnClean)
	if err != nil {
		t.Fatalf("Version clean: %v", err)
	}
	if dirty || v != 6 {
		t.Fatalf("clean DB: version = %d dirty = %v, want version = 6 dirty = false", v, dirty)
	}

	poolClean := dbtest.Pool(t, dsnClean)
	contentTables := []string{"item", "tag", "item_tag", "entry"}
	for _, table := range contentTables {
		var n int
		if err := poolClean.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, table).Scan(&n); err != nil {
			t.Fatalf("query table %s: %v", table, err)
		}
		if n != 1 {
			t.Fatalf("missing table %s after migration 0006", table)
		}
	}

	type expectedIndexSpec struct {
		name           string
		mustContain    []string
		mustNotContain []string
	}
	expectedIndexes := map[string][]expectedIndexSpec{
		"item": {
			{
				name:        "item_user_name_prefix",
				mustContain: []string{"(user_id, name_normalized text_pattern_ops)", "where (deleted_at is null)"},
			},
			{
				name:        "item_name_trgm",
				mustContain: []string{"using gin (name_unaccent gin_trgm_ops)"},
			},
			{
				name:        "item_user_recent",
				mustContain: []string{"(user_id, last_used_at desc, id desc)", "where (deleted_at is null)"},
			},
			{
				name:        "item_user_created",
				mustContain: []string{"(user_id, created_at desc)", "where (deleted_at is null)"},
			},
			{
				name:        "item_user_name_exact",
				mustContain: []string{"(user_id, name_normalized, created_at desc, id)", "where (deleted_at is null)"},
			},
			{
				name:        "item_user_name_alpha",
				mustContain: []string{"(user_id, name_normalized, id)", "where (deleted_at is null)"},
			},
			{
				name:        "item_purge_idx",
				mustContain: []string{"(deleted_at)", "where (deleted_at is not null)"},
			},
		},
		"tag": {
			{
				name:        "tag_user_norm_uq",
				mustContain: []string{"unique index", "(user_id, normalized)", "where (deleted_at is null)"},
			},
			{
				name:        "tag_user_norm_prefix",
				mustContain: []string{"(user_id, normalized text_pattern_ops)", "where (deleted_at is null)"},
			},
			{
				name:        "tag_norm_trgm",
				mustContain: []string{"using gin (tag_unaccent gin_trgm_ops)"},
			},
			{
				name:        "tag_user_recent",
				mustContain: []string{"(user_id, last_used_at desc, id desc)", "where (deleted_at is null)"},
			},
			{
				name:        "tag_purge_idx",
				mustContain: []string{"(deleted_at)", "where (deleted_at is not null)"},
			},
		},
		"item_tag": {
			{
				name:        "item_tag_tag_idx",
				mustContain: []string{"(tag_id, item_id)"},
			},
		},
		"entry": {
			{
				name:        "entry_item_live_pos_idx",
				mustContain: []string{"(item_id, \"position\", id)", "where (deleted_at is null)"},
			},
			{
				name:        "entry_user_updated_idx",
				mustContain: []string{"(user_id, updated_at desc)", "where (deleted_at is null)"},
			},
			{
				name:           "entry_user_changes_idx",
				mustContain:    []string{"(user_id, updated_at, id)"},
				mustNotContain: []string{"deleted_at"},
			},
			{
				name:        "entry_purge_idx",
				mustContain: []string{"(deleted_at)", "where (deleted_at is not null)"},
			},
		},
	}
	for table, specs := range expectedIndexes {
		for _, spec := range specs {
			var idxDef string
			if err := poolClean.QueryRow(ctx, `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname = $2`, table, spec.name).Scan(&idxDef); err != nil {
				t.Fatalf("query indexdef %s.%s: %v", table, spec.name, err)
			}
			lowerDef := strings.ToLower(idxDef)
			for _, sub := range spec.mustContain {
				if !strings.Contains(lowerDef, sub) {
					t.Fatalf("index %s.%s definition mismatch: got %q, want substring %q", table, spec.name, idxDef, sub)
				}
			}
			for _, forbidden := range spec.mustNotContain {
				if strings.Contains(lowerDef, forbidden) {
					t.Fatalf("index %s.%s definition must not contain %q: got %q", table, spec.name, forbidden, idxDef)
				}
			}
		}
	}
	// Verify entry_item_pos_idx is replaced by entry_item_live_pos_idx.
	var legacyPosIdx int
	if err := poolClean.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE tablename = 'entry' AND indexname = 'entry_item_pos_idx'`).Scan(&legacyPosIdx); err != nil {
		t.Fatal(err)
	}
	if legacyPosIdx != 0 {
		t.Fatalf("legacy entry_item_pos_idx should not exist, count=%d", legacyPosIdx)
	}

	// 2. Migrate to 5, insert representative P03 rows (user, vault, recovery key,
	// idempotency row), migrate to 6, and verify P03 rows survive intact.
	dsnUpgrade := dbtest.StartPostgres(t)
	migrateToVersion(t, dsnUpgrade, 5)
	poolUpgrade := dbtest.Pool(t, dsnUpgrade)
	qUpgrade := gen.New(poolUpgrade)

	uP03, err := qUpgrade.InsertUser(ctx, gen.InsertUserParams{
		Email:  "p03-survivor@example.com",
		Locale: "vi",
	})
	if err != nil {
		t.Fatalf("InsertUser at v5: %v", err)
	}

	kdfJSON := []byte(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"AAAAAAAAAAAAAAAAAAAAAA"}`)
	vaultP03, err := qUpgrade.InsertVault(ctx, gen.InsertVaultParams{
		UserID:               uP03.ID,
		Kdf:                  kdfJSON,
		VaultKeyID:           "vk:PPPPPPPPPPPPPPPPPPPPPP",
		VaultKeyWrappedByKek: make([]byte, 73),
		X25519Public:         make([]byte, 32),
		Ed25519Public:        make([]byte, 32),
		PrivateKeysWrapped:   make([]byte, 105),
	})
	if err != nil {
		t.Fatalf("InsertVault at v5: %v", err)
	}

	rkHash := []byte("p03-rk-lookup-hash-0000000000001")
	rkP03, err := qUpgrade.InsertRecoveryKey(ctx, gen.InsertRecoveryKeyParams{
		UserID:     uP03.ID,
		Slot:       1,
		LookupHash: rkHash,
		Wrap:       make([]byte, 73),
	})
	if err != nil {
		t.Fatalf("InsertRecoveryKey at v5: %v", err)
	}

	nowTs := pgtype.Timestamptz{Time: time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC), Valid: true}
	ownerTok := uuid.New()
	claimedTok, err := qUpgrade.ClaimIdempotencyKey(ctx, gen.ClaimIdempotencyKeyParams{
		UserID:      uP03.ID,
		Key:         "p03-idem-key-000001",
		Method:      "POST",
		Path:        "/api/v1/vault",
		RequestHash: []byte("p03-req-hash-0000000000000000001"),
		OwnerToken:  ownerTok,
		Now:         nowTs,
	})
	if err != nil || claimedTok != ownerTok {
		t.Fatalf("ClaimIdempotencyKey at v5: tok=%v err=%v", claimedTok, err)
	}

	// Migrate 5 -> 6.
	dbtest.MigrateUp(t, dsnUpgrade)
	vUp, dirtyUp, err := db.Version(dsnUpgrade)
	if err != nil || dirtyUp || vUp != 6 {
		t.Fatalf("upgrade 5->6: v=%d dirty=%v err=%v", vUp, dirtyUp, err)
	}

	// Verify P03 rows survive after 0006 migration.
	gotUser, err := qUpgrade.GetUserByID(ctx, uP03.ID)
	if err != nil || gotUser.Email != uP03.Email {
		t.Fatalf("GetUserByID after 0006: got=%+v err=%v", gotUser, err)
	}
	gotVault, err := qUpgrade.GetVaultByUser(ctx, uP03.ID)
	if err != nil || gotVault.VaultKeyID != vaultP03.VaultKeyID || gotVault.Version != 1 {
		t.Fatalf("GetVaultByUser after 0006: got=%+v err=%v", gotVault, err)
	}
	gotRK, err := qUpgrade.GetRecoveryKeyByUserAndHash(ctx, gen.GetRecoveryKeyByUserAndHashParams{
		UserID:     uP03.ID,
		LookupHash: rkHash,
	})
	if err != nil || gotRK.ID != rkP03.ID {
		t.Fatalf("GetRecoveryKeyByUserAndHash after 0006: got=%+v err=%v", gotRK, err)
	}
	gotIdem, err := qUpgrade.GetIdempotencyKey(ctx, gen.GetIdempotencyKeyParams{
		UserID: uP03.ID,
		Key:    "p03-idem-key-000001",
		Now:    nowTs,
	})
	if err != nil || gotIdem.OwnerToken != ownerTok {
		t.Fatalf("GetIdempotencyKey after 0006: got=%+v err=%v", gotIdem, err)
	}

	// 3. Down migration 6 -> 5 drops content tables while keeping P03 rows intact.
	if err := db.MigrateDown(dsnUpgrade); err != nil {
		t.Fatalf("MigrateDown 6->5: %v", err)
	}
	vDown, dirtyDown, err := db.Version(dsnUpgrade)
	if err != nil || dirtyDown || vDown != 5 {
		t.Fatalf("after MigrateDown: v=%d dirty=%v err=%v", vDown, dirtyDown, err)
	}
	for _, table := range contentTables {
		var n int
		if err := poolUpgrade.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("MigrateDown 6->5 must drop table %s, count=%d", table, n)
		}
	}
	if _, err := qUpgrade.GetVaultByUser(ctx, uP03.ID); err != nil {
		t.Fatalf("P03 vault must survive MigrateDown 6->5: %v", err)
	}
	dbtest.MigrateUp(t, dsnUpgrade)
}

func TestContentSchemaConstraintsAndCompositeFK(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	q := gen.New(pool)

	u1, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "c1@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser u1: %v", err)
	}
	u2, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "c2@example.com", Locale: "en"})
	if err != nil {
		t.Fatalf("InsertUser u2: %v", err)
	}

	itemU1, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u1.ID,
		Name:           "Mục Tiếng Việt",
		NameNormalized: "mục tiếng việt",
		Hint:           new("gợi ý"),
	})
	if err != nil {
		t.Fatalf("InsertItem u1: %v", err)
	}
	if itemU1.NameUnaccent == nil || *itemU1.NameUnaccent != "muc tieng viet" {
		t.Fatalf("item.name_unaccent = %v, want 'muc tieng viet'", itemU1.NameUnaccent)
	}
	if itemU1.Version != 1 || itemU1.EntryCount != 0 {
		t.Fatalf("item defaults: version=%d entry_count=%d", itemU1.Version, itemU1.EntryCount)
	}

	itemU2, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u2.ID,
		Name:           "Other User Item",
		NameNormalized: "other user item",
	})
	if err != nil {
		t.Fatalf("InsertItem u2: %v", err)
	}

	// Item name / hint length CHECKs.
	if _, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u1.ID,
		Name:           "",
		NameNormalized: "valid",
	}); !isCheckViolation(err) {
		t.Fatalf("empty item.name must fail CHECK, err=%v", err)
	}
	if _, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u1.ID,
		Name:           strings.Repeat("a", 201),
		NameNormalized: "valid",
	}); !isCheckViolation(err) {
		t.Fatalf("201-char item.name must fail CHECK, err=%v", err)
	}
	if _, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u1.ID,
		Name:           "valid",
		NameNormalized: "valid",
		Hint:           new(strings.Repeat("h", 121)),
	}); !isCheckViolation(err) {
		t.Fatalf("121-char item.hint must fail CHECK, err=%v", err)
	}

	// Tag generated unaccent, partial unique index tag_user_norm_uq, and length CHECKs.
	tag1, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     u1.ID,
		Display:    "Nhà Cửa",
		Normalized: "nhà cửa",
	})
	if err != nil {
		t.Fatalf("InsertTag: %v", err)
	}
	if tag1.TagUnaccent == nil || *tag1.TagUnaccent != "nha cua" {
		t.Fatalf("tag.tag_unaccent = %v, want 'nha cua'", tag1.TagUnaccent)
	}
	if _, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     u1.ID,
		Display:    "Nhà Cửa 2",
		Normalized: "nhà cửa",
	}); !isUniqueViolation(err) {
		t.Fatalf("live duplicate (user_id, normalized) must fail tag_user_norm_uq, err=%v", err)
	}
	if _, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     u1.ID,
		Display:    strings.Repeat("t", 51),
		Normalized: "valid",
	}); !isCheckViolation(err) {
		t.Fatalf("51-char tag.display must fail CHECK, err=%v", err)
	}

	// Soft-deleting tag1 allows inserting a new live tag with the same normalized value.
	if _, err := q.SoftDeleteTag(ctx, gen.SoftDeleteTagParams{UserID: u1.ID, ID: tag1.ID}); err != nil {
		t.Fatalf("SoftDeleteTag: %v", err)
	}
	if _, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     u1.ID,
		Display:    "Nhà Cửa Mới",
		Normalized: "nhà cửa",
	}); err != nil {
		t.Fatalf("partial unique index tag_user_norm_uq must allow live tag after soft-delete: %v", err)
	}

	validEnv := []byte(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"vk:AAAAAAAAAAAAAAAAAAAAAA","nonce":"AAAAAAAAAAAAAAAAAAAAAAAA","ct_enc":"utf8"}`)
	validCT := make([]byte, 32)

	// Entry bucket CHECKs: reject 0, 255, 300, 262400; accept 256 and 262144.
	for _, badBucket := range []int32{0, 255, 300, 262400} {
		_, err := q.InsertEntry(ctx, gen.InsertEntryParams{
			ID:                 uuid.New(),
			UserID:             u1.ID,
			ItemID:             itemU1.ID,
			Type:               "text",
			Envelope:           validEnv,
			Ciphertext:         validCT,
			PlaintextLenBucket: badBucket,
		})
		if !isCheckViolation(err) {
			t.Fatalf("plaintext_len_bucket=%d must be rejected by CHECK, err=%v", badBucket, err)
		}
	}

	// Entry ciphertext length CHECKs: reject 16 and 263169; accept 17 and 263168.
	for _, badLen := range []int{16, 263169} {
		_, err := q.InsertEntry(ctx, gen.InsertEntryParams{
			ID:                 uuid.New(),
			UserID:             u1.ID,
			ItemID:             itemU1.ID,
			Type:               "text",
			Envelope:           validEnv,
			Ciphertext:         make([]byte, badLen),
			PlaintextLenBucket: 256,
		})
		if !isCheckViolation(err) {
			t.Fatalf("octet_length(ciphertext)=%d must be rejected by CHECK, err=%v", badLen, err)
		}
	}

	// Entry type CHECK: reject invalid type.
	if _, err := q.InsertEntry(ctx, gen.InsertEntryParams{
		ID:                 uuid.New(),
		UserID:             u1.ID,
		ItemID:             itemU1.ID,
		Type:               "invalid_type",
		Envelope:           validEnv,
		Ciphertext:         validCT,
		PlaintextLenBucket: 256,
	}); !isCheckViolation(err) {
		t.Fatalf("invalid entry.type must be rejected by CHECK, err=%v", err)
	}

	// Composite FK entry (user_id, item_id) -> item (user_id, id):
	// Reject an entry claiming u1.ID while pointing to itemU2.ID (owned by u2).
	if _, err := q.InsertEntry(ctx, gen.InsertEntryParams{
		ID:                 uuid.New(),
		UserID:             u1.ID,
		ItemID:             itemU2.ID,
		Type:               "text",
		Envelope:           validEnv,
		Ciphertext:         validCT,
		PlaintextLenBucket: 256,
	}); !isForeignKeyViolation(err) {
		t.Fatalf("cross-tenant entry (u1 with u2's item) must be rejected by composite FK, err=%v", err)
	}

	// Valid boundary entry (17 B ciphertext, bucket 256) and max entry (263168 B ciphertext, bucket 262144).
	entry1, err := q.InsertEntry(ctx, gen.InsertEntryParams{
		ID:                 uuid.New(),
		UserID:             u1.ID,
		ItemID:             itemU1.ID,
		Type:               "text",
		Envelope:           validEnv,
		Ciphertext:         make([]byte, 17),
		PlaintextLenBucket: 256,
	})
	if err != nil {
		t.Fatalf("InsertEntry min valid: %v", err)
	}
	entry2, err := q.InsertEntry(ctx, gen.InsertEntryParams{
		ID:                 uuid.New(),
		UserID:             u1.ID,
		ItemID:             itemU1.ID,
		Type:               "json",
		Envelope:           validEnv,
		Ciphertext:         make([]byte, 263168),
		PlaintextLenBucket: 262144,
	})
	if err != nil {
		t.Fatalf("InsertEntry max valid: %v", err)
	}
	if entry1.Position != 0 || entry2.Position != 1 {
		t.Fatalf("positions = (%d, %d), want (0, 1)", entry1.Position, entry2.Position)
	}

	// CHECK ((deleted_at IS NULL) = (deleted_via IS NULL)) and deleted_via IN ('entry','item').
	if _, err := pool.Exec(ctx,
		`UPDATE entry SET deleted_at = now(), deleted_via = NULL WHERE id = $1`,
		entry1.ID,
	); !isCheckViolation(err) {
		t.Fatalf("deleted_at NOT NULL with deleted_via NULL must fail CHECK, err=%v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE entry SET deleted_at = NULL, deleted_via = 'entry' WHERE id = $1`,
		entry1.ID,
	); !isCheckViolation(err) {
		t.Fatalf("deleted_at NULL with deleted_via NOT NULL must fail CHECK, err=%v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE entry SET deleted_at = now(), deleted_via = 'other' WHERE id = $1`,
		entry1.ID,
	); !isCheckViolation(err) {
		t.Fatalf("deleted_via='other' must fail CHECK, err=%v", err)
	}
}

func TestContentQueriesBehavior(t *testing.T) {
	ctx := context.Background()
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	q := gen.New(pool)

	u1, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "b1@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	u2, err := q.InsertUser(ctx, gen.InsertUserParams{Email: "b2@example.com", Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}

	kdfJSON := []byte(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"AAAAAAAAAAAAAAAAAAAAAA"}`)
	if _, err := q.InsertVault(ctx, gen.InsertVaultParams{
		UserID:               u1.ID,
		Kdf:                  kdfJSON,
		VaultKeyID:           "vk:1111111111111111111111",
		VaultKeyWrappedByKek: make([]byte, 73),
		X25519Public:         make([]byte, 32),
		Ed25519Public:        make([]byte, 32),
		PrivateKeysWrapped:   make([]byte, 105),
	}); err != nil {
		t.Fatal(err)
	}

	// Lock helpers inside a tx (global order: vault FOR SHARE -> LockUserContent -> items -> tags).
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qt := q.WithTx(tx)

	vkID, err := qt.LockVaultKeyForShare(ctx, u1.ID)
	if err != nil || vkID != "vk:1111111111111111111111" {
		t.Fatalf("LockVaultKeyForShare: vkID=%q err=%v", vkID, err)
	}
	if _, err := qt.LockVaultKeyForShare(ctx, u2.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("LockVaultKeyForShare without vault must return ErrNoRows, err=%v", err)
	}
	if err := qt.LockUserContent(ctx, u1.ID); err != nil {
		t.Fatalf("LockUserContent: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// Exact lookup + count + keyset pagination.
	clientItemID := uuid.New()
	it1, err := q.InsertItem(ctx, gen.InsertItemParams{
		ID:             new(clientItemID),
		UserID:         u1.ID,
		Name:           "Wifi",
		NameNormalized: "wifi",
	})
	if err != nil || it1.ID != clientItemID {
		t.Fatalf("InsertItem with client ID: got=%v err=%v", it1.ID, err)
	}
	it2, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u1.ID,
		Name:           "WIFI",
		NameNormalized: "wifi",
	})
	if err != nil {
		t.Fatal(err)
	}
	totalExact, err := q.CountLiveItemsByNameExact(ctx, gen.CountLiveItemsByNameExactParams{
		UserID:         u1.ID,
		NameNormalized: "wifi",
	})
	if err != nil || totalExact != 2 {
		t.Fatalf("CountLiveItemsByNameExact = %d, err=%v", totalExact, err)
	}
	page1, err := q.LookupLiveItemsByNameExact(ctx, gen.LookupLiveItemsByNameExactParams{
		UserID:         u1.ID,
		NameNormalized: "wifi",
		PageLimit:      1,
	})
	if err != nil || len(page1) != 1 {
		t.Fatalf("LookupLiveItemsByNameExact page1: len=%d err=%v", len(page1), err)
	}
	page2, err := q.LookupLiveItemsByNameExact(ctx, gen.LookupLiveItemsByNameExactParams{
		UserID:          u1.ID,
		NameNormalized:  "wifi",
		CursorCreatedAt: page1[0].CreatedAt,
		CursorID:        new(page1[0].ID),
		PageLimit:       10,
	})
	if err != nil || len(page2) != 1 || page2[0].ID == page1[0].ID {
		t.Fatalf("LookupLiveItemsByNameExact page2: %+v err=%v", page2, err)
	}

	// Tag assign ON CONFLICT DO NOTHING returning only newly inserted pairs + counter updates.
	tLive, err := q.InsertTag(ctx, gen.InsertTagParams{UserID: u1.ID, Display: "home", Normalized: "home"})
	if err != nil {
		t.Fatal(err)
	}
	tSoftDeleted, err := q.InsertTag(ctx, gen.InsertTagParams{UserID: u1.ID, Display: "old", Normalized: "old"})
	if err != nil {
		t.Fatal(err)
	}
	insertedPairs, err := q.AssignItemTags(ctx, gen.AssignItemTagsParams{
		UserID: u1.ID,
		ItemID: it1.ID,
		TagIds: []uuid.UUID{tLive.ID, tSoftDeleted.ID},
	})
	if err != nil || len(insertedPairs) != 2 {
		t.Fatalf("AssignItemTags first call: len=%d err=%v", len(insertedPairs), err)
	}
	nowPg := pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	if _, err := q.IncrementTagsItemCountAndTouch(ctx, gen.IncrementTagsItemCountAndTouchParams{
		UserID: u1.ID,
		TagIds: []uuid.UUID{tLive.ID, tSoftDeleted.ID},
		Now:    nowPg,
	}); err != nil {
		t.Fatal(err)
	}
	// Duplicate assign returns 0 rows.
	dupPairs, err := q.AssignItemTags(ctx, gen.AssignItemTagsParams{
		UserID: u1.ID,
		ItemID: it1.ID,
		TagIds: []uuid.UUID{tLive.ID},
	})
	if err != nil || len(dupPairs) != 0 {
		t.Fatalf("AssignItemTags duplicate call must return 0 rows, got=%d err=%v", len(dupPairs), err)
	}

	// Soft-delete tSoftDeleted: live-tag count on it1 becomes 1, but item deletion must
	// still decrement item_count on BOTH tLive and tSoftDeleted (plan §2.1, P4BE1-4).
	if _, err := q.SoftDeleteTag(ctx, gen.SoftDeleteTagParams{UserID: u1.ID, ID: tSoftDeleted.ID}); err != nil {
		t.Fatal(err)
	}
	liveTagsCount, err := q.CountLiveTagsByItem(ctx, gen.CountLiveTagsByItemParams{
		UserID: u1.ID,
		ItemID: it1.ID,
	})
	if err != nil || liveTagsCount != 1 {
		t.Fatalf("CountLiveTagsByItem = %d, want 1 (err=%v)", liveTagsCount, err)
	}

	// Entry position over ALL rows incl. tombstones + provenance restore (plan §2.8).
	validEnv := []byte(`{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"vk:1111111111111111111111","nonce":"AAAAAAAAAAAAAAAAAAAAAAAA","ct_enc":"utf8"}`)
	e1, err := q.InsertEntry(ctx, gen.InsertEntryParams{
		ID: uuid.New(), UserID: u1.ID, ItemID: it1.ID, Type: "text",
		Envelope: validEnv, Ciphertext: make([]byte, 32), PlaintextLenBucket: 256,
	})
	if err != nil || e1.Position != 0 {
		t.Fatalf("InsertEntry e1: pos=%d err=%v", e1.Position, err)
	}
	// Soft-delete e1 individually (deleted_via='entry').
	if _, err := q.SoftDeleteEntry(ctx, gen.SoftDeleteEntryParams{UserID: u1.ID, ID: e1.ID}); err != nil {
		t.Fatalf("SoftDeleteEntry e1: %v", err)
	}
	// Insert e2: position must be max(0)+1 = 1 even though e1 is a tombstone.
	e2, err := q.InsertEntry(ctx, gen.InsertEntryParams{
		ID: uuid.New(), UserID: u1.ID, ItemID: it1.ID, Type: "text",
		Envelope: validEnv, Ciphertext: make([]byte, 32), PlaintextLenBucket: 256,
	})
	if err != nil || e2.Position != 1 {
		t.Fatalf("InsertEntry e2 after tombstone e1: pos=%d want 1, err=%v", e2.Position, err)
	}

	// Soft-delete item it1 with batch: only live e2 gets deleted_via='item' + batch; e1 keeps deleted_via='entry'.
	batchID := uuid.New()
	if _, err := q.SoftDeleteItem(ctx, gen.SoftDeleteItemParams{
		UserID: u1.ID, ID: it1.ID, DeleteBatch: new(batchID),
	}); err != nil {
		t.Fatal(err)
	}
	cascaded, err := q.SoftDeleteLiveEntriesByItem(ctx, gen.SoftDeleteLiveEntriesByItemParams{
		UserID: u1.ID, ItemID: it1.ID, DeleteBatch: new(batchID),
	})
	if err != nil || cascaded != 1 {
		t.Fatalf("SoftDeleteLiveEntriesByItem cascaded=%d want 1, err=%v", cascaded, err)
	}
	if _, err := q.AdjustAllLinkedTagsItemCountForItem(ctx, gen.AdjustAllLinkedTagsItemCountForItemParams{
		UserID: u1.ID, ItemID: it1.ID, Delta: -1,
	}); err != nil {
		t.Fatal(err)
	}
	tSoftAfterDel, err := q.GetTagByUserAndID(ctx, gen.GetTagByUserAndIDParams{UserID: u1.ID, ID: tSoftDeleted.ID})
	if err != nil || tSoftAfterDel.ItemCount != 0 {
		t.Fatalf("soft-deleted tag item_count after item delete = %d, want 0 (err=%v)", tSoftAfterDel.ItemCount, err)
	}

	// Restore item batch: only e2 is restored; e1 stays soft-deleted.
	restoredEntries, err := q.RestoreEntriesByItemBatch(ctx, gen.RestoreEntriesByItemBatchParams{
		UserID: u1.ID, ItemID: it1.ID, DeleteBatch: new(batchID),
	})
	if err != nil || restoredEntries != 1 {
		t.Fatalf("RestoreEntriesByItemBatch = %d want 1, err=%v", restoredEntries, err)
	}
	if _, err := q.RestoreItem(ctx, gen.RestoreItemParams{
		UserID: u1.ID, ID: it1.ID, EntryCount: int32(restoredEntries),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.AdjustAllLinkedTagsItemCountForItem(ctx, gen.AdjustAllLinkedTagsItemCountForItemParams{
		UserID: u1.ID, ItemID: it1.ID, Delta: 1,
	}); err != nil {
		t.Fatal(err)
	}

	// Global entry ID conflict check returns true across users.
	exists, err := q.EntryIDExistsGlobal(ctx, e2.ID)
	if err != nil || !exists {
		t.Fatalf("EntryIDExistsGlobal = %v, err=%v", exists, err)
	}

	// Database clock watermark helper (plan §2.9) returns a valid timestamp independently of rows.
	watermark, err := q.ContentClockNow(ctx)
	if err != nil || !watermark.Valid || watermark.Time.IsZero() {
		t.Fatalf("ContentClockNow: watermark=%+v err=%v", watermark, err)
	}

	// Seed user u2 with a live item, live tag (linked), and live entry so reset of u1
	// can be verified to leave u2's rows and counters completely untouched (CC2-R1-4).
	itU2, err := q.InsertItem(ctx, gen.InsertItemParams{
		UserID:         u2.ID,
		Name:           "U2 Item",
		NameNormalized: "u2 item",
	})
	if err != nil {
		t.Fatalf("InsertItem u2: %v", err)
	}
	tU2, err := q.InsertTag(ctx, gen.InsertTagParams{
		UserID:     u2.ID,
		Display:    "u2tag",
		Normalized: "u2tag",
	})
	if err != nil {
		t.Fatalf("InsertTag u2: %v", err)
	}
	if _, err := q.AssignItemTag(ctx, gen.AssignItemTagParams{
		UserID: u2.ID,
		ItemID: itU2.ID,
		TagID:  tU2.ID,
	}); err != nil {
		t.Fatalf("AssignItemTag u2: %v", err)
	}
	if _, err := q.IncrementTagsItemCountAndTouch(ctx, gen.IncrementTagsItemCountAndTouchParams{
		UserID: u2.ID,
		TagIds: []uuid.UUID{tU2.ID},
		Now:    nowPg,
	}); err != nil {
		t.Fatalf("IncrementTagsItemCountAndTouch u2: %v", err)
	}
	eU2, err := q.InsertEntry(ctx, gen.InsertEntryParams{
		ID:                 uuid.New(),
		UserID:             u2.ID,
		ItemID:             itU2.ID,
		Type:               "text",
		Envelope:           validEnv,
		Ciphertext:         make([]byte, 32),
		PlaintextLenBucket: 256,
	})
	if err != nil {
		t.Fatalf("InsertEntry u2: %v", err)
	}
	if _, err := q.AddItemEntryCount(ctx, gen.AddItemEntryCountParams{
		UserID: u2.ID,
		ID:     itU2.ID,
		Delta:  1,
	}); err != nil {
		t.Fatalf("AddItemEntryCount u2: %v", err)
	}

	// Verify pre-reset state: u1's it1 has entry_count=1 (from RestoreItem above),
	// and u2's itU2 has entry_count=1.
	it1BeforeReset, err := q.GetLiveItemByUserAndID(ctx, gen.GetLiveItemByUserAndIDParams{UserID: u1.ID, ID: it1.ID})
	if err != nil || it1BeforeReset.EntryCount != 1 {
		t.Fatalf("pre-reset it1 entry_count = %d, want 1 (err=%v)", it1BeforeReset.EntryCount, err)
	}
	itU2BeforeReset, err := q.GetLiveItemByUserAndID(ctx, gen.GetLiveItemByUserAndIDParams{UserID: u2.ID, ID: itU2.ID})
	if err != nil || itU2BeforeReset.EntryCount != 1 {
		t.Fatalf("pre-reset itU2 entry_count = %d, want 1 (err=%v)", itU2BeforeReset.EntryCount, err)
	}

	// Reset queries for u1: LockAllItemsOfUserForUpdate + DeleteEntriesByUser + ZeroEntryCountByUser.
	if _, err := q.LockAllItemsOfUserForUpdate(ctx, u1.ID); err != nil {
		t.Fatal(err)
	}
	delCount, err := q.DeleteEntriesByUser(ctx, u1.ID)
	if err != nil || delCount != 2 {
		t.Fatalf("DeleteEntriesByUser = %d want 2, err=%v", delCount, err)
	}
	zeroedItems, err := q.ZeroEntryCountByUser(ctx, u1.ID)
	if err != nil || zeroedItems != 1 {
		t.Fatalf("ZeroEntryCountByUser = %d want 1, err=%v", zeroedItems, err)
	}

	// Assert real nonzero -> zero transition on it1 (which had live entries) as well as it2 surviving.
	it1AfterReset, err := q.GetLiveItemByUserAndID(ctx, gen.GetLiveItemByUserAndIDParams{UserID: u1.ID, ID: it1.ID})
	if err != nil || it1AfterReset.EntryCount != 0 {
		t.Fatalf("it1 after reset must transition entry_count 1->0: got=%+v err=%v", it1AfterReset, err)
	}
	it2Check, err := q.GetLiveItemByUserAndID(ctx, gen.GetLiveItemByUserAndIDParams{UserID: u1.ID, ID: it2.ID})
	if err != nil || it2Check.EntryCount != 0 {
		t.Fatalf("it2 survives reset with entry_count=0: got=%+v err=%v", it2Check, err)
	}

	// Verify u2's item, tag, and entry rows and counters are completely untouched by u1's reset.
	itU2AfterReset, err := q.GetLiveItemByUserAndID(ctx, gen.GetLiveItemByUserAndIDParams{UserID: u2.ID, ID: itU2.ID})
	if err != nil || itU2AfterReset.EntryCount != 1 {
		t.Fatalf("u2 item entry_count must remain 1 after u1 reset: got=%+v err=%v", itU2AfterReset, err)
	}
	tU2AfterReset, err := q.GetLiveTagByUserAndID(ctx, gen.GetLiveTagByUserAndIDParams{UserID: u2.ID, ID: tU2.ID})
	if err != nil || tU2AfterReset.ItemCount != 1 {
		t.Fatalf("u2 tag item_count must remain 1 after u1 reset: got=%+v err=%v", tU2AfterReset, err)
	}
	eU2AfterReset, err := q.GetLiveEntryByUserAndID(ctx, gen.GetLiveEntryByUserAndIDParams{UserID: u2.ID, ID: eU2.ID})
	if err != nil || eU2AfterReset.ID != eU2.ID {
		t.Fatalf("u2 entry must survive u1 reset: got=%+v err=%v", eU2AfterReset, err)
	}
}
