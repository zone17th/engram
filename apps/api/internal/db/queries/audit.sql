-- name: InsertAudit :one
INSERT INTO audit_log (
  user_id, session_id, event, result, actor, ip_hash, user_agent, meta
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: ListAuditByUser :many
SELECT id, user_id, session_id, event, result, actor, meta, created_at
FROM audit_log
WHERE user_id = $1
  AND (
    sqlc.narg('cursor_created')::timestamptz IS NULL
    OR (created_at, id) < (sqlc.narg('cursor_created')::timestamptz, sqlc.narg('cursor_id')::bigint)
  )
ORDER BY created_at DESC, id DESC
LIMIT $2;

-- name: DeleteAuditOlderThan :execrows
DELETE FROM audit_log WHERE created_at < $1;
