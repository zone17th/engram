-- name: CancelUserExportJobs :many
UPDATE export_job
SET
  status = 'cancelled',
  cancelled_at = COALESCE(cancelled_at, now())
WHERE user_id = sqlc.arg('user_id')
  AND status IN ('queued', 'running', 'ready')
RETURNING *;

-- name: InsertExportFileCleanup :one
INSERT INTO export_file_cleanup (
  file_name,
  job_id,
  attempt_id,
  reason
) VALUES (
  sqlc.arg('file_name'),
  sqlc.arg('job_id'),
  sqlc.narg('attempt_id'),
  sqlc.arg('reason')
)
RETURNING *;

-- name: ListPendingCleanup :many
SELECT * FROM export_file_cleanup
WHERE done_at IS NULL
ORDER BY created_at ASC, id ASC
LIMIT sqlc.arg('batch_limit');

-- name: CompleteCleanup :execrows
UPDATE export_file_cleanup
SET
  done_at = COALESCE(done_at, now()),
  attempts = attempts + 1
WHERE id = sqlc.arg('id')
  AND done_at IS NULL;

-- name: PruneDoneCleanup :execrows
DELETE FROM export_file_cleanup
WHERE done_at IS NOT NULL
  AND done_at < sqlc.arg('before');
