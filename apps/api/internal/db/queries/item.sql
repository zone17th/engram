-- =============================================================================
-- Section 1: Lock helpers (global lock order per plan §2.5)
-- Order: (1) vault FOR SHARE / FOR UPDATE -> (2) LockUserContent -> (3) item
-- ORDER BY id ASC -> (4) tag ORDER BY id ASC -> (5) entry.
-- =============================================================================

-- name: LockVaultKeyForShare :one
SELECT vault_key_id
FROM vault
WHERE user_id = sqlc.arg('user_id')
FOR SHARE;

-- name: LockUserContent :exec
SELECT pg_advisory_xact_lock(
  hashtext('engram.content'),
  hashtext((sqlc.arg('user_id')::uuid)::text)
);

-- name: LockItemForUpdate :one
SELECT *
FROM item
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
FOR UPDATE;

-- name: LockItemsForUpdate :many
SELECT *
FROM item
WHERE user_id = sqlc.arg('user_id')
  AND id = ANY(sqlc.arg('ids')::uuid[])
ORDER BY id ASC
FOR UPDATE;

-- name: LockAllItemsOfUserForUpdate :many
SELECT id
FROM item
WHERE user_id = sqlc.arg('user_id')
ORDER BY id ASC
FOR UPDATE;

-- =============================================================================
-- Section 2: Item CRUD (insert, get, update, touch last_used_at)
-- =============================================================================

-- name: InsertItem :one
INSERT INTO item (
  id,
  user_id,
  name,
  name_normalized,
  hint
) VALUES (
  COALESCE(sqlc.narg('id')::uuid, gen_random_uuid()),
  sqlc.arg('user_id'),
  sqlc.arg('name'),
  sqlc.arg('name_normalized'),
  sqlc.narg('hint')
)
RETURNING *;

-- name: GetLiveItemByUserAndID :one
SELECT *
FROM item
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NULL;

-- name: GetItemByUserAndID :one
SELECT *
FROM item
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id');

-- name: UpdateItemNameAndHint :one
UPDATE item
SET
  name = sqlc.arg('name'),
  name_normalized = sqlc.arg('name_normalized'),
  hint = sqlc.narg('hint'),
  version = version + 1,
  updated_at = now()
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NULL
  AND version = sqlc.arg('expected_version')
RETURNING *;

-- name: TouchItemLastUsedAt :execrows
UPDATE item
SET last_used_at = sqlc.arg('now')
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NULL
  AND last_used_at < sqlc.arg('threshold');

-- =============================================================================
-- Section 3: Exact lookup by name_normalized (plan §2.7)
-- Sorted created_at DESC, id ASC with keyset cursor + exact count(*).
-- =============================================================================

-- name: LookupLiveItemsByNameExact :many
SELECT *
FROM item
WHERE user_id = sqlc.arg('user_id')
  AND name_normalized = sqlc.arg('name_normalized')
  AND deleted_at IS NULL
  AND (
    sqlc.narg('cursor_created_at')::timestamptz IS NULL
    OR created_at < sqlc.narg('cursor_created_at')::timestamptz
    OR (
      created_at = sqlc.narg('cursor_created_at')::timestamptz
      AND id > sqlc.narg('cursor_id')::uuid
    )
  )
ORDER BY created_at DESC, id ASC
LIMIT sqlc.arg('page_limit');

-- name: CountLiveItemsByNameExact :one
SELECT count(*)::int AS total
FROM item
WHERE user_id = sqlc.arg('user_id')
  AND name_normalized = sqlc.arg('name_normalized')
  AND deleted_at IS NULL;

-- =============================================================================
-- Section 4: Item list keyset (sort=recent | sort=alpha, optional tag_id and q)
-- NOTE on q_prefix: caller MUST escape '\' first, then '%' and '_' with '\',
-- and only then append trailing '%' (e.g. escaped_q || '%') before passing
-- q_prefix so LIKE uses ESCAPE '\' and can use item_user_name_prefix
-- (text_pattern_ops). Pass NULL when no q filter.
-- =============================================================================

-- name: ListLiveItemsRecent :many
SELECT i.*
FROM item AS i
WHERE i.user_id = sqlc.arg('user_id')
  AND i.deleted_at IS NULL
  AND (
    sqlc.narg('q_prefix')::text IS NULL
    OR i.name_normalized LIKE sqlc.narg('q_prefix')::text ESCAPE '\'
  )
  AND (
    sqlc.narg('tag_id')::uuid IS NULL
    OR EXISTS (
      SELECT 1
      FROM item_tag AS it
      JOIN tag AS t ON t.id = it.tag_id AND t.user_id = i.user_id
      WHERE it.item_id = i.id
        AND it.tag_id = sqlc.narg('tag_id')::uuid
        AND t.deleted_at IS NULL
    )
  )
  AND (
    sqlc.narg('cursor_last_used_at')::timestamptz IS NULL
    OR i.last_used_at < sqlc.narg('cursor_last_used_at')::timestamptz
    OR (
      i.last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
      AND i.id < sqlc.narg('cursor_id')::uuid
    )
  )
ORDER BY i.last_used_at DESC, i.id DESC
LIMIT sqlc.arg('page_limit');

-- NOTE on q_prefix: caller MUST escape '\' first, then '%' and '_' with '\',
-- and only then append trailing '%' (e.g. escaped_q || '%') before passing
-- q_prefix so LIKE uses ESCAPE '\' and can use item_user_name_prefix
-- (text_pattern_ops). Pass NULL when no q filter.
-- name: ListLiveItemsAlpha :many
SELECT i.*
FROM item AS i
WHERE i.user_id = sqlc.arg('user_id')
  AND i.deleted_at IS NULL
  AND (
    sqlc.narg('q_prefix')::text IS NULL
    OR i.name_normalized LIKE sqlc.narg('q_prefix')::text ESCAPE '\'
  )
  AND (
    sqlc.narg('tag_id')::uuid IS NULL
    OR EXISTS (
      SELECT 1
      FROM item_tag AS it
      JOIN tag AS t ON t.id = it.tag_id AND t.user_id = i.user_id
      WHERE it.item_id = i.id
        AND it.tag_id = sqlc.narg('tag_id')::uuid
        AND t.deleted_at IS NULL
    )
  )
  AND (
    sqlc.narg('cursor_name_normalized')::text IS NULL
    OR (i.name_normalized, i.id) > (
      sqlc.narg('cursor_name_normalized')::text,
      sqlc.narg('cursor_id')::uuid
    )
  )
ORDER BY i.name_normalized ASC, i.id ASC
LIMIT sqlc.arg('page_limit');

-- =============================================================================
-- Section 5: Item soft-delete, restore, and counters (plan §2.8)
-- Cascade soft-delete/restore of entries is in entry.sql; tag counter updates
-- across ALL linked tags (live or soft-deleted) are in tag.sql.
-- =============================================================================

-- name: SoftDeleteItem :one
UPDATE item
SET
  deleted_at = now(),
  delete_batch = sqlc.arg('delete_batch'),
  entry_count = 0,
  updated_at = now()
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NULL
RETURNING *;

-- name: RestoreItem :one
UPDATE item
SET
  deleted_at = NULL,
  delete_batch = NULL,
  entry_count = sqlc.arg('entry_count'),
  updated_at = now()
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NOT NULL
RETURNING *;

-- name: CountLiveTagsByItem :one
SELECT count(*)::int AS live_tag_count
FROM item_tag AS it
JOIN item AS i ON i.id = it.item_id AND i.user_id = sqlc.arg('user_id')
JOIN tag AS t ON t.id = it.tag_id AND t.user_id = sqlc.arg('user_id')
WHERE it.item_id = sqlc.arg('item_id')
  AND t.deleted_at IS NULL;

-- name: AddItemEntryCount :one
UPDATE item
SET
  entry_count = GREATEST(0, entry_count + sqlc.arg('delta')::int),
  updated_at = now()
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
RETURNING *;

-- name: ZeroEntryCountByUser :execrows
UPDATE item
SET
  entry_count = 0,
  updated_at = now()
WHERE user_id = sqlc.arg('user_id')
  AND entry_count <> 0;

-- =============================================================================
-- Section 6: Item purge (batches of 500 per user under LockUserContent, plan §2.8)
-- =============================================================================

-- name: ListUsersWithPurgeableItems :many
SELECT DISTINCT user_id
FROM item
WHERE deleted_at IS NOT NULL
  AND deleted_at < sqlc.arg('cutoff')
ORDER BY user_id ASC
LIMIT sqlc.arg('max_users');

-- name: PurgeExpiredItemsByUserBatch :execrows
DELETE FROM item
WHERE item.user_id = sqlc.arg('user_id')
  AND item.id IN (
    SELECT expired.id
    FROM item AS expired
    WHERE expired.user_id = sqlc.arg('user_id')
      AND expired.deleted_at IS NOT NULL
      AND expired.deleted_at < sqlc.arg('cutoff')
    ORDER BY expired.deleted_at ASC, expired.id ASC
    LIMIT sqlc.arg('batch_limit')
  );
