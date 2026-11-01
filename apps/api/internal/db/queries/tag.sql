-- =============================================================================
-- Section 1: Tag lock helpers (global lock order step 4: tag ORDER BY id ASC)
-- =============================================================================

-- name: LockTagForUpdate :one
SELECT *
FROM tag
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
FOR UPDATE;

-- name: LockTagsForUpdate :many
SELECT *
FROM tag
WHERE user_id = sqlc.arg('user_id')
  AND id = ANY(sqlc.arg('ids')::uuid[])
ORDER BY id ASC
FOR UPDATE;

-- name: LockTagsOfItemForUpdate :many
SELECT t.*
FROM tag AS t
JOIN item_tag AS it ON it.tag_id = t.id
JOIN item AS i ON i.id = it.item_id AND i.user_id = t.user_id
WHERE t.user_id = sqlc.arg('user_id')
  AND it.item_id = sqlc.arg('item_id')
ORDER BY t.id ASC
FOR UPDATE OF t;

-- =============================================================================
-- Section 2: Tag upsert parts, get, rename, soft-delete, restore (plan §2.7-2.8)
-- =============================================================================

-- name: GetLiveTagByUserAndNormalized :one
SELECT *
FROM tag
WHERE user_id = sqlc.arg('user_id')
  AND normalized = sqlc.arg('normalized')
  AND deleted_at IS NULL;

-- name: InsertTag :one
INSERT INTO tag (
  user_id,
  display,
  normalized
) VALUES (
  sqlc.arg('user_id'),
  sqlc.arg('display'),
  sqlc.arg('normalized')
)
RETURNING *;

-- name: GetLiveTagByUserAndID :one
SELECT *
FROM tag
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NULL;

-- name: GetTagByUserAndID :one
SELECT *
FROM tag
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id');

-- name: RenameTag :one
UPDATE tag
SET
  display = sqlc.arg('display'),
  normalized = sqlc.arg('normalized'),
  updated_at = now()
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NULL
RETURNING *;

-- name: SoftDeleteTag :one
UPDATE tag
SET
  deleted_at = now(),
  updated_at = now()
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NULL
RETURNING *;

-- name: RestoreTag :one
UPDATE tag
SET
  deleted_at = NULL,
  updated_at = now()
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NOT NULL
RETURNING *;

-- name: MaxLiveTagCountOnLiveItemsForTag :one
SELECT COALESCE(MAX(sub.live_tags), 0)::int AS max_live_tags
FROM (
  SELECT count(t2.id)::int AS live_tags
  FROM item_tag AS it_target
  JOIN item AS i ON i.id = it_target.item_id AND i.user_id = sqlc.arg('user_id')
  LEFT JOIN item_tag AS it_all ON it_all.item_id = i.id
  LEFT JOIN tag AS t2 ON t2.id = it_all.tag_id
    AND t2.user_id = sqlc.arg('user_id')
    AND t2.deleted_at IS NULL
  WHERE it_target.tag_id = sqlc.arg('tag_id')
    AND i.deleted_at IS NULL
  GROUP BY i.id
) AS sub;

-- =============================================================================
-- Section 3: Tag list keyset (sort=recent | sort=alpha, optional q prefix)
-- NOTE on q_prefix: caller MUST escape '\' first, then '%' and '_' with '\',
-- and only then append trailing '%' (e.g. escaped_q || '%') before passing
-- q_prefix so LIKE uses ESCAPE '\' and can use tag_user_norm_prefix
-- (text_pattern_ops). Pass NULL when no q filter.
-- =============================================================================

-- name: ListLiveTagsRecent :many
SELECT *
FROM tag
WHERE user_id = sqlc.arg('user_id')
  AND deleted_at IS NULL
  AND (
    sqlc.narg('q_prefix')::text IS NULL
    OR normalized LIKE sqlc.narg('q_prefix')::text ESCAPE '\'
  )
  AND (
    sqlc.narg('cursor_last_used_at')::timestamptz IS NULL
    OR last_used_at < sqlc.narg('cursor_last_used_at')::timestamptz
    OR (
      last_used_at = sqlc.narg('cursor_last_used_at')::timestamptz
      AND id < sqlc.narg('cursor_id')::uuid
    )
  )
ORDER BY last_used_at DESC, id DESC
LIMIT sqlc.arg('page_limit');

-- NOTE on q_prefix: caller MUST escape '\' first, then '%' and '_' with '\',
-- and only then append trailing '%' (e.g. escaped_q || '%') before passing
-- q_prefix so LIKE uses ESCAPE '\' and can use tag_user_norm_prefix
-- (text_pattern_ops). Pass NULL when no q filter.
-- name: ListLiveTagsAlpha :many
SELECT *
FROM tag
WHERE user_id = sqlc.arg('user_id')
  AND deleted_at IS NULL
  AND (
    sqlc.narg('q_prefix')::text IS NULL
    OR normalized LIKE sqlc.narg('q_prefix')::text ESCAPE '\'
  )
  AND (
    sqlc.narg('cursor_normalized')::text IS NULL
    OR (normalized, id) > (
      sqlc.narg('cursor_normalized')::text,
      sqlc.narg('cursor_id')::uuid
    )
  )
ORDER BY normalized ASC, id ASC
LIMIT sqlc.arg('page_limit');

-- =============================================================================
-- Section 4: Item-Tag assignment, unassignment, counters, and ItemSummary tags
-- =============================================================================

-- name: AssignItemTag :one
INSERT INTO item_tag (
  item_id,
  tag_id
)
SELECT i.id, t.id
FROM item AS i
JOIN tag AS t ON t.user_id = i.user_id
WHERE i.user_id = sqlc.arg('user_id')
  AND i.id = sqlc.arg('item_id')
  AND i.deleted_at IS NULL
  AND t.id = sqlc.arg('tag_id')
  AND t.deleted_at IS NULL
ON CONFLICT (item_id, tag_id) DO NOTHING
RETURNING item_id, tag_id, created_at;

-- name: AssignItemTags :many
INSERT INTO item_tag (
  item_id,
  tag_id
)
SELECT i.id, t.id
FROM item AS i
JOIN tag AS t ON t.user_id = i.user_id
WHERE i.user_id = sqlc.arg('user_id')
  AND i.id = sqlc.arg('item_id')
  AND i.deleted_at IS NULL
  AND t.id = ANY(sqlc.arg('tag_ids')::uuid[])
  AND t.deleted_at IS NULL
ON CONFLICT (item_id, tag_id) DO NOTHING
RETURNING item_id, tag_id, created_at;

-- name: UnassignItemTag :execrows
DELETE FROM item_tag AS it
USING item AS i, tag AS t
WHERE it.item_id = i.id
  AND it.tag_id = t.id
  AND i.user_id = sqlc.arg('user_id')
  AND t.user_id = sqlc.arg('user_id')
  AND it.item_id = sqlc.arg('item_id')
  AND it.tag_id = sqlc.arg('tag_id');

-- name: IncrementTagsItemCountAndTouch :execrows
UPDATE tag
SET
  item_count = item_count + 1,
  last_used_at = sqlc.arg('now'),
  updated_at = now()
WHERE user_id = sqlc.arg('user_id')
  AND id = ANY(sqlc.arg('tag_ids')::uuid[]);

-- name: DecrementTagItemCount :execrows
UPDATE tag
SET
  item_count = GREATEST(0, item_count - 1),
  updated_at = now()
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('tag_id');

-- name: AdjustAllLinkedTagsItemCountForItem :execrows
UPDATE tag AS t
SET
  item_count = GREATEST(0, t.item_count + sqlc.arg('delta')::int),
  updated_at = now()
FROM item_tag AS it
JOIN item AS i ON i.id = it.item_id AND i.user_id = sqlc.arg('user_id')
WHERE t.user_id = sqlc.arg('user_id')
  AND t.id = it.tag_id
  AND it.item_id = sqlc.arg('item_id');

-- name: TouchTagLastUsedAt :execrows
UPDATE tag
SET last_used_at = sqlc.arg('now')
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
  AND deleted_at IS NULL
  AND last_used_at < sqlc.arg('threshold');

-- name: ListLiveTagsForItem :many
SELECT
  t.id,
  t.display
FROM item_tag AS it
JOIN item AS i ON i.id = it.item_id AND i.user_id = sqlc.arg('user_id')
JOIN tag AS t ON t.id = it.tag_id AND t.user_id = sqlc.arg('user_id')
WHERE it.item_id = sqlc.arg('item_id')
  AND t.deleted_at IS NULL
ORDER BY t.display ASC, t.id ASC;

-- name: ListLiveTagsForItems :many
SELECT
  it.item_id,
  t.id AS tag_id,
  t.display
FROM item_tag AS it
JOIN item AS i ON i.id = it.item_id AND i.user_id = sqlc.arg('user_id')
JOIN tag AS t ON t.id = it.tag_id AND t.user_id = sqlc.arg('user_id')
WHERE it.item_id = ANY(sqlc.arg('item_ids')::uuid[])
  AND t.deleted_at IS NULL
ORDER BY it.item_id ASC, t.display ASC, t.id ASC;

-- =============================================================================
-- Section 5: Tag purge (batches of 500 per user under LockUserContent, plan §2.8)
-- =============================================================================

-- name: ListUsersWithPurgeableTags :many
SELECT DISTINCT user_id
FROM tag
WHERE deleted_at IS NOT NULL
  AND deleted_at < sqlc.arg('cutoff')
ORDER BY user_id ASC
LIMIT sqlc.arg('max_users');

-- name: PurgeExpiredTagsByUserBatch :execrows
DELETE FROM tag
WHERE tag.user_id = sqlc.arg('user_id')
  AND tag.id IN (
    SELECT expired.id
    FROM tag AS expired
    WHERE expired.user_id = sqlc.arg('user_id')
      AND expired.deleted_at IS NOT NULL
      AND expired.deleted_at < sqlc.arg('cutoff')
    ORDER BY expired.deleted_at ASC, expired.id ASC
    LIMIT sqlc.arg('batch_limit')
  );
