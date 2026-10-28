-- name: InsertNotification :one
INSERT INTO user_notification (user_id, kind, meta, email_targets)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetNotificationByID :one
SELECT id, user_id, kind, meta, read_at, created_at
FROM user_notification
WHERE id = $1;

-- name: GetNotificationForMail :one
SELECT id, user_id, kind, email_targets
FROM user_notification
WHERE id = $1;

-- name: ListNotificationsByUser :many
SELECT id, user_id, kind, meta, read_at, created_at
FROM user_notification
WHERE user_id = $1
  AND (
    sqlc.narg('cursor_created')::timestamptz IS NULL
    OR (created_at, id) < (sqlc.narg('cursor_created')::timestamptz, sqlc.narg('cursor_id')::bigint)
  )
ORDER BY created_at DESC, id DESC
LIMIT $2;

-- name: MarkNotificationRead :execrows
UPDATE user_notification
SET read_at = $3
WHERE id = $1 AND user_id = $2 AND read_at IS NULL;

-- name: DeleteNotificationsOlderThan :execrows
DELETE FROM user_notification WHERE created_at < $1;
