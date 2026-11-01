-- =============================================================================
-- Section 1: Entry lock & conflict helpers (global lock order step 5: entry)
-- =============================================================================

-- name: EntryIDExistsGlobal :one
SELECT EXISTS (
  SELECT 1
  FROM entry
  WHERE id = sqlc.arg('id')
);

-- name: LockEntryForUpdate :one
SELECT *
FROM entry
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
FOR UPDATE;

-- name: LockLiveEntriesOfItemForUpdate :many
SELECT
  id,
  item_id,
  type,
  position,
  version,
  plaintext_len_bucket,
  created_at,
  updated_at
FROM entry
WHERE user_id = sqlc.arg('user_id')
  AND item_id = sqlc.arg('item_id')
  AND deleted_at IS NULL
ORDER BY id ASC
FOR UPDATE;

-- =============================================================================
-- Section 2: Entry insert, get, list metadata, body update (plan §2.6, §3)
-- position = COALESCE(MAX(position) + 1, 0) over ALL rows of the item (incl.
-- tombstones). updated_at = clock_timestamp() on every entry change; version
-- increments ONLY on body update (PUT).
-- =============================================================================

-- name: InsertEntry :one
INSERT INTO entry (
  id,
  user_id,
  item_id,
  type,
  position,
  envelope,
  ciphertext,
  plaintext_len_bucket,
  version,
  created_at,
  updated_at
) VALUES (
  sqlc.arg('id'),
  sqlc.arg('user_id'),
  sqlc.arg('item_id'),
  sqlc.arg('type'),
  COALESCE(
    (
      SELECT MAX(existing.position) + 1
      FROM entry AS existing
      WHERE existing.user_id = sqlc.arg('user_id')
        AND existing.item_id = sqlc.arg('item_id')
    ),
    0
  ),
  sqlc.arg('envelope'),
  sqlc.arg('ciphertext'),
  sqlc.arg('plaintext_len_bucket'),
  1,
  clock_timestamp(),
  clock_timestamp()
)
RETURNING
  id,
  user_id,
  item_id,
  type,
  position,
  version,
  plaintext_len_bucket,
  created_at,
  updated_at;

-- name: GetLiveEntryByUserAndID :one
SELECT *
FROM entry
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NULL;

-- name: GetEntryByUserAndID :one
SELECT *
FROM entry
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id');

-- name: ListLiveEntryMetadataByItem :many
SELECT
  id,
  item_id,
  type,
  position,
  version,
  plaintext_len_bucket,
  created_at,
  updated_at
FROM entry
WHERE user_id = sqlc.arg('user_id')
  AND item_id = sqlc.arg('item_id')
  AND deleted_at IS NULL
  AND (
    sqlc.narg('cursor_position')::int IS NULL
    OR (position, id) > (
      sqlc.narg('cursor_position')::int,
      sqlc.narg('cursor_id')::uuid
    )
  )
ORDER BY position ASC, id ASC
LIMIT sqlc.arg('page_limit');

-- name: UpdateEntryBody :one
UPDATE entry
SET
  envelope = sqlc.arg('envelope'),
  ciphertext = sqlc.arg('ciphertext'),
  plaintext_len_bucket = sqlc.arg('plaintext_len_bucket'),
  version = version + 1,
  updated_at = clock_timestamp()
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NULL
  AND version = sqlc.arg('expected_version')
RETURNING
  id,
  user_id,
  item_id,
  type,
  position,
  version,
  plaintext_len_bucket,
  created_at,
  updated_at;

-- =============================================================================
-- Section 3: Entry soft-delete, restore, and reorder (plan §2.8)
-- Neither soft-delete, restore, nor reorder increments entry.version.
-- =============================================================================

-- name: SoftDeleteEntry :one
UPDATE entry
SET
  deleted_at = clock_timestamp(),
  deleted_via = 'entry',
  delete_batch = NULL,
  updated_at = clock_timestamp()
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NULL
RETURNING
  id,
  user_id,
  item_id,
  type,
  position,
  version,
  plaintext_len_bucket,
  created_at,
  updated_at,
  deleted_at,
  deleted_via,
  delete_batch;

-- name: RestoreEntry :one
UPDATE entry
SET
  deleted_at = NULL,
  deleted_via = NULL,
  delete_batch = NULL,
  updated_at = clock_timestamp()
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NOT NULL
  AND deleted_via = 'entry'
RETURNING
  id,
  user_id,
  item_id,
  type,
  position,
  version,
  plaintext_len_bucket,
  created_at,
  updated_at;

-- name: SoftDeleteLiveEntriesByItem :execrows
UPDATE entry
SET
  deleted_at = clock_timestamp(),
  deleted_via = 'item',
  delete_batch = sqlc.arg('delete_batch'),
  updated_at = clock_timestamp()
WHERE user_id = sqlc.arg('user_id')
  AND item_id = sqlc.arg('item_id')
  AND deleted_at IS NULL;

-- name: RestoreEntriesByItemBatch :execrows
UPDATE entry
SET
  deleted_at = NULL,
  deleted_via = NULL,
  delete_batch = NULL,
  updated_at = clock_timestamp()
WHERE user_id = sqlc.arg('user_id')
  AND item_id = sqlc.arg('item_id')
  AND deleted_via = 'item'
  AND delete_batch = sqlc.arg('delete_batch');

-- name: CountEntriesByItemBatch :one
SELECT count(*)::int AS batch_entry_count
FROM entry
WHERE user_id = sqlc.arg('user_id')
  AND item_id = sqlc.arg('item_id')
  AND deleted_via = 'item'
  AND delete_batch = sqlc.arg('delete_batch');

-- name: ReorderLiveEntriesByItem :many
UPDATE entry AS e
SET
  position = (ord.idx - 1)::int,
  updated_at = clock_timestamp()
FROM unnest(sqlc.arg('entry_ids')::uuid[]) WITH ORDINALITY AS ord(id, idx)
WHERE e.user_id = sqlc.arg('user_id')
  AND e.item_id = sqlc.arg('item_id')
  AND e.id = ord.id
  AND e.deleted_at IS NULL
RETURNING e.id, e.position;

-- name: UpdateEntryPosition :one
UPDATE entry
SET
  position = sqlc.arg('position'),
  updated_at = clock_timestamp()
WHERE user_id = sqlc.arg('user_id')
  AND item_id = sqlc.arg('item_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NULL
RETURNING id, position;

-- =============================================================================
-- Section 4: Entry changes feed & watermark (plan §2.9)
-- Keyset on (updated_at, id) ASC with since and no upper bound; includes tombstones.
-- ContentClockNow captures the server's database clock_timestamp() watermark
-- before the first page of a feed cursor chain (plan §2.9), independently of
-- whether the page returns any rows. Subsequent pages carry the first page's
-- watermark in the cursor rather than calling ContentClockNow again.
-- =============================================================================

-- ContentClockNow returns the database clock_timestamp() watermark captured
-- before the first page of GET /entries/changes (plan §2.9).
-- name: ContentClockNow :one
SELECT clock_timestamp()::timestamptz AS watermark;

-- name: ListEntryChangesSince :many
SELECT
  id,
  item_id,
  type,
  position,
  version,
  plaintext_len_bucket,
  created_at,
  updated_at,
  deleted_at
FROM entry
WHERE user_id = sqlc.arg('user_id')
  AND updated_at >= sqlc.arg('since')
  AND (
    sqlc.narg('cursor_updated_at')::timestamptz IS NULL
    OR (updated_at, id) > (
      sqlc.narg('cursor_updated_at')::timestamptz,
      sqlc.narg('cursor_id')::uuid
    )
  )
ORDER BY updated_at ASC, id ASC
LIMIT sqlc.arg('page_limit');

-- =============================================================================
-- Section 5: Entry purge & vault reset (plan §2.8, Task 8)
-- =============================================================================

-- name: ListUsersWithPurgeableEntries :many
SELECT DISTINCT user_id
FROM entry
WHERE deleted_at IS NOT NULL
  AND deleted_at < sqlc.arg('cutoff')
ORDER BY user_id ASC
LIMIT sqlc.arg('max_users');

-- name: PurgeExpiredEntriesByUserBatch :execrows
DELETE FROM entry
WHERE entry.user_id = sqlc.arg('user_id')
  AND entry.id IN (
    SELECT expired.id
    FROM entry AS expired
    WHERE expired.user_id = sqlc.arg('user_id')
      AND expired.deleted_at IS NOT NULL
      AND expired.deleted_at < sqlc.arg('cutoff')
    ORDER BY expired.deleted_at ASC, expired.id ASC
    LIMIT sqlc.arg('batch_limit')
  );

-- name: DeleteEntriesByUser :execrows
DELETE FROM entry
WHERE user_id = sqlc.arg('user_id');

-- name: ShiftLiveEntriesOnRestoreCollision :execrows
UPDATE entry
SET
  position = entry.position + 1,
  updated_at = clock_timestamp()
WHERE entry.user_id = sqlc.arg('user_id')
  AND entry.item_id = sqlc.arg('item_id')
  AND entry.deleted_at IS NULL
  AND entry.position >= sqlc.arg('restored_position')
  AND EXISTS (
    SELECT 1
    FROM entry AS occupied
    WHERE occupied.user_id = sqlc.arg('user_id')
      AND occupied.item_id = sqlc.arg('item_id')
      AND occupied.deleted_at IS NULL
      AND occupied.position = sqlc.arg('restored_position')
  );

-- name: LockExpiredItemsForPurgeByUserBatch :many
SELECT i.id
FROM item AS i
WHERE i.user_id = sqlc.arg('user_id')
  AND i.id IN (
    SELECT expired.id
    FROM item AS expired
    WHERE expired.user_id = sqlc.arg('user_id')
      AND expired.deleted_at IS NOT NULL
      AND expired.deleted_at < sqlc.arg('cutoff')
    ORDER BY expired.deleted_at ASC, expired.id ASC
    LIMIT sqlc.arg('batch_limit')
  )
ORDER BY i.id ASC
FOR UPDATE;

-- name: LockExpiredTagsForPurgeByUserBatch :many
SELECT t.id
FROM tag AS t
WHERE t.user_id = sqlc.arg('user_id')
  AND t.id IN (
    SELECT expired.id
    FROM tag AS expired
    WHERE expired.user_id = sqlc.arg('user_id')
      AND expired.deleted_at IS NOT NULL
      AND expired.deleted_at < sqlc.arg('cutoff')
    ORDER BY expired.deleted_at ASC, expired.id ASC
    LIMIT sqlc.arg('batch_limit')
  )
ORDER BY t.id ASC
FOR UPDATE;

-- name: DeleteExpiredItemsByUserIDs :execrows
DELETE FROM item
WHERE user_id = sqlc.arg('user_id')
  AND id = ANY(sqlc.arg('ids')::uuid[])
  AND deleted_at IS NOT NULL
  AND deleted_at < sqlc.arg('cutoff');

-- name: DeleteExpiredTagsByUserIDs :execrows
DELETE FROM tag
WHERE user_id = sqlc.arg('user_id')
  AND id = ANY(sqlc.arg('ids')::uuid[])
  AND deleted_at IS NOT NULL
  AND deleted_at < sqlc.arg('cutoff');
