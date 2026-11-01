// Package contenttest cung cấp helper kiểm tra bất biến counter/trần SQL (`AssertInvariants`)
// và bộ harness HTTP hai người dùng dùng chung cho các test P04 (Task 3b–8).
package contenttest

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// MaxLiveTagsPerItem là trần số tag sống tối đa trên một item sống (SPEC §2.4, plan mục 2.3).
	MaxLiveTagsPerItem = 20

	// MaxLiveEntriesPerItem là trần số entry sống tối đa trên một item (SPEC §2.4, plan mục 2.3).
	MaxLiveEntriesPerItem = 200
)

// AssertInvariants kiểm tra các bất biến dữ liệu content P04 cho `userID` bằng SQL thuần
// (plan mục 2.1, 2.8, Task 3b, P04-A2):
//  1. `item.entry_count` bằng đúng số entry sống (`deleted_at IS NULL`) của từng item
//     (mọi item đã xoá phải có `entry_count = 0` và 0 entry sống).
//  2. `tag.item_count` bằng đúng số item sống (`item.deleted_at IS NULL`) gắn với tag đó
//     qua `item_tag`, bất kể tag đang sống hay đã soft-delete.
//  3. Số tag sống (`tag.deleted_at IS NULL`) của mỗi item sống (`item.deleted_at IS NULL`) <= 20.
//  4. Số entry sống (`entry.deleted_at IS NULL`) của mỗi item <= 200.
func AssertInvariants(t testing.TB, pool *pgxpool.Pool, userID uuid.UUID) {
	t.Helper()
	ctx := context.Background()

	// 1. item.entry_count == số entry sống của từng item (cả item sống và item đã soft-delete).
	itemRows, err := pool.Query(ctx, `
		SELECT
			i.id,
			i.deleted_at IS NOT NULL AS item_deleted,
			i.entry_count,
			COUNT(e.id)::int AS live_entries
		FROM item AS i
		LEFT JOIN entry AS e
			ON e.item_id = i.id
			AND e.user_id = i.user_id
			AND e.deleted_at IS NULL
		WHERE i.user_id = $1
		GROUP BY i.id, i.deleted_at, i.entry_count
		HAVING i.entry_count <> COUNT(e.id)::int
			OR (i.deleted_at IS NOT NULL AND (i.entry_count <> 0 OR COUNT(e.id)::int <> 0))
	`, userID)
	if err != nil {
		t.Fatalf("AssertInvariants query item.entry_count (user=%s): %v", userID, err)
	}
	defer itemRows.Close()
	for itemRows.Next() {
		var itemID uuid.UUID
		var itemDeleted bool
		var entryCount, liveEntries int
		if err := itemRows.Scan(&itemID, &itemDeleted, &entryCount, &liveEntries); err != nil {
			t.Fatalf("AssertInvariants scan item.entry_count: %v", err)
		}
		t.Fatalf(
			"AssertInvariants violated for user=%s item=%s (deleted=%v): entry_count=%d but live_entries=%d",
			userID, itemID, itemDeleted, entryCount, liveEntries,
		)
	}
	if err := itemRows.Err(); err != nil {
		t.Fatalf("AssertInvariants rows item.entry_count: %v", err)
	}

	// 2. tag.item_count == số item sống gắn với tag qua item_tag (mọi tag, sống hay đã soft-delete).
	tagRows, err := pool.Query(ctx, `
		SELECT
			t.id,
			t.deleted_at IS NOT NULL AS tag_deleted,
			t.item_count,
			COUNT(i.id)::int AS live_items
		FROM tag AS t
		LEFT JOIN item_tag AS it
			ON it.tag_id = t.id
		LEFT JOIN item AS i
			ON i.id = it.item_id
			AND i.user_id = t.user_id
			AND i.deleted_at IS NULL
		WHERE t.user_id = $1
		GROUP BY t.id, t.deleted_at, t.item_count
		HAVING t.item_count <> COUNT(i.id)::int
	`, userID)
	if err != nil {
		t.Fatalf("AssertInvariants query tag.item_count (user=%s): %v", userID, err)
	}
	defer tagRows.Close()
	for tagRows.Next() {
		var tagID uuid.UUID
		var tagDeleted bool
		var itemCount, liveItems int
		if err := tagRows.Scan(&tagID, &tagDeleted, &itemCount, &liveItems); err != nil {
			t.Fatalf("AssertInvariants scan tag.item_count: %v", err)
		}
		t.Fatalf(
			"AssertInvariants violated for user=%s tag=%s (deleted=%v): item_count=%d but live_items=%d",
			userID, tagID, tagDeleted, itemCount, liveItems,
		)
	}
	if err := tagRows.Err(); err != nil {
		t.Fatalf("AssertInvariants rows tag.item_count: %v", err)
	}

	// 3. Số tag sống mỗi item sống <= 20.
	tagCapRows, err := pool.Query(ctx, `
		SELECT
			i.id,
			COUNT(t.id)::int AS live_tags
		FROM item AS i
		JOIN item_tag AS it
			ON it.item_id = i.id
		JOIN tag AS t
			ON t.id = it.tag_id
			AND t.user_id = i.user_id
			AND t.deleted_at IS NULL
		WHERE i.user_id = $1
			AND i.deleted_at IS NULL
		GROUP BY i.id
		HAVING COUNT(t.id)::int > $2
	`, userID, MaxLiveTagsPerItem)
	if err != nil {
		t.Fatalf("AssertInvariants query live tags per live item (user=%s): %v", userID, err)
	}
	defer tagCapRows.Close()
	for tagCapRows.Next() {
		var itemID uuid.UUID
		var liveTags int
		if err := tagCapRows.Scan(&itemID, &liveTags); err != nil {
			t.Fatalf("AssertInvariants scan live tags cap: %v", err)
		}
		t.Fatalf(
			"AssertInvariants violated for user=%s item=%s: live_tags=%d > %d",
			userID, itemID, liveTags, MaxLiveTagsPerItem,
		)
	}
	if err := tagCapRows.Err(); err != nil {
		t.Fatalf("AssertInvariants rows live tags cap: %v", err)
	}

	// 4. Số entry sống mỗi item <= 200.
	entryCapRows, err := pool.Query(ctx, `
		SELECT
			i.id,
			COUNT(e.id)::int AS live_entries
		FROM item AS i
		JOIN entry AS e
			ON e.item_id = i.id
			AND e.user_id = i.user_id
			AND e.deleted_at IS NULL
		WHERE i.user_id = $1
		GROUP BY i.id
		HAVING COUNT(e.id)::int > $2
	`, userID, MaxLiveEntriesPerItem)
	if err != nil {
		t.Fatalf("AssertInvariants query live entries per item (user=%s): %v", userID, err)
	}
	defer entryCapRows.Close()
	for entryCapRows.Next() {
		var itemID uuid.UUID
		var liveEntries int
		if err := entryCapRows.Scan(&itemID, &liveEntries); err != nil {
			t.Fatalf("AssertInvariants scan live entries cap: %v", err)
		}
		t.Fatalf(
			"AssertInvariants violated for user=%s item=%s: live_entries=%d > %d",
			userID, itemID, liveEntries, MaxLiveEntriesPerItem,
		)
	}
	if err := entryCapRows.Err(); err != nil {
		t.Fatalf("AssertInvariants rows live entries cap: %v", err)
	}
}
