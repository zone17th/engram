-- P06 Task 2 (exportbe): export_job lifecycle + snapshot batches for the
-- export_encrypted worker (plan P06 mục 2.3, 2.4, 2.5, 2.7). Shared cleanup
-- queries live in export_cleanup.sql (contract, read-only here).
-- No query here serves decrypted-pages (R2-02): that path reads only the file.

-- name: CreateExportJob :one
INSERT INTO export_job (user_id, kind, status)
VALUES (sqlc.arg('user_id'), sqlc.arg('kind'), 'queued')
RETURNING *;

-- name: GetActiveExportJobForUpdate :one
SELECT * FROM export_job
WHERE user_id = sqlc.arg('user_id')
  AND kind = sqlc.arg('kind')
  AND status IN ('queued', 'running')
FOR UPDATE;

-- name: GetLatestExportJob :one
SELECT * FROM export_job
WHERE user_id = sqlc.arg('user_id')
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- name: GetExportJobForOwner :one
SELECT * FROM export_job
WHERE id = sqlc.arg('id')
  AND user_id = sqlc.arg('user_id');

-- name: GetExportJobForOwnerForUpdate :one
SELECT * FROM export_job
WHERE id = sqlc.arg('id')
  AND user_id = sqlc.arg('user_id')
FOR UPDATE;

-- name: GetExportJobForUpdate :one
SELECT * FROM export_job
WHERE id = sqlc.arg('id')
FOR UPDATE;

-- name: ClaimExportJob :one
-- CAS claim/rescue (mục 2.4): queued, or running with an expired lease. A new
-- attempt_id is minted per claim; the previous attempt id is returned so the
-- worker can unlink that attempt's files.
WITH prev AS (
  SELECT
    e.id,
    e.attempt_id AS prev_attempt_id,
    gen_random_uuid() AS new_attempt_id
  FROM export_job e
  WHERE e.id = sqlc.arg('id')
  FOR UPDATE
)
UPDATE export_job j
SET
  status = 'running',
  attempt_id = prev.new_attempt_id,
  lease_until = now() + make_interval(secs => sqlc.arg('lease_seconds')::float8),
  started_at = COALESCE(j.started_at, now()),
  file_name = j.id::text || '.' || prev.new_attempt_id::text || '.tmp',
  items_processed = NULL,
  items_total = NULL
FROM prev
WHERE j.id = prev.id
  AND (j.status = 'queued' OR (j.status = 'running' AND j.lease_until < now()))
RETURNING j.user_id, j.attempt_id, prev.prev_attempt_id;

-- name: GetExportJobClaimState :one
SELECT
  status,
  lease_until,
  GREATEST(EXTRACT(EPOCH FROM (lease_until - now())), 0)::float8 AS lease_remaining_seconds
FROM export_job
WHERE id = sqlc.arg('id');

-- name: GetExportJobAttemptState :one
SELECT status, attempt_id
FROM export_job
WHERE id = sqlc.arg('id');

-- name: ReleaseExportLease :execrows
UPDATE export_job
SET lease_until = now()
WHERE id = sqlc.arg('id')
  AND status = 'running'
  AND attempt_id = sqlc.arg('attempt_id');

-- name: RenewExportLease :execrows
UPDATE export_job
SET lease_until = now() + make_interval(secs => sqlc.arg('lease_seconds')::float8)
WHERE id = sqlc.arg('id')
  AND status = 'running'
  AND attempt_id = sqlc.arg('attempt_id');

-- name: UpdateExportProgress :execrows
UPDATE export_job
SET
  items_total = sqlc.arg('items_total'),
  items_processed = sqlc.arg('items_processed')
WHERE id = sqlc.arg('id')
  AND status = 'running'
  AND attempt_id = sqlc.arg('attempt_id');

-- name: LockExportOwnerForShare :one
SELECT id FROM app_user
WHERE id = sqlc.arg('user_id')
FOR SHARE;

-- name: LockExportOwnerForUpdate :one
SELECT id FROM app_user
WHERE id = sqlc.arg('user_id')
FOR UPDATE;

-- name: LockExportOwnerNoKeyUpdate :one
-- Parent-row lock for vault.Reset / account-deletion interop: FOR NO KEY UPDATE
-- conflicts with export Finalize CAS (FOR SHARE) and DELETE /me (FOR UPDATE) but
-- stays compatible with FK FOR KEY SHARE taken by concurrent INSERTs into
-- idempotency_key (advisor review r1, R1-03).
SELECT id FROM app_user
WHERE id = sqlc.arg('user_id')
FOR NO KEY UPDATE;

-- name: GetVaultKeyForShare :one
SELECT vault_key_id, version FROM vault
WHERE user_id = sqlc.arg('user_id')
FOR SHARE;

-- name: FinalizeExportReady :one
-- Finalize CAS (mục 2.4): caller already holds app_user FOR SHARE -> vault FOR
-- SHARE -> export_job FOR UPDATE and checked the live vault_key_id.
UPDATE export_job
SET
  status = 'ready',
  file_name = sqlc.arg('file_name'),
  size_bytes = sqlc.arg('size_bytes'),
  snapshot_vault_key_id = sqlc.arg('snapshot_vault_key_id'),
  snapshot_vault_ver = sqlc.arg('snapshot_vault_ver'),
  completed_at = now(),
  expires_at = now() + make_interval(secs => sqlc.arg('ttl_seconds')::float8),
  lease_until = NULL,
  error_code = NULL
WHERE id = sqlc.arg('id')
  AND status = 'running'
  AND attempt_id = sqlc.arg('attempt_id')
RETURNING *;

-- name: ExpireReplacedExports :many
-- Same tx as FinalizeExportReady: older ready jobs of the user expire only when
-- the replacement is really ready.
UPDATE export_job
SET status = 'expired'
WHERE user_id = sqlc.arg('user_id')
  AND status = 'ready'
  AND id <> sqlc.arg('keep_id')
RETURNING id, attempt_id, file_name;

-- name: FailExportAttempt :execrows
UPDATE export_job
SET
  status = 'failed',
  error_code = sqlc.arg('error_code'),
  lease_until = NULL,
  completed_at = now()
WHERE id = sqlc.arg('id')
  AND status = 'running'
  AND attempt_id = sqlc.arg('attempt_id');

-- name: FailQueuedExport :execrows
UPDATE export_job
SET
  status = 'failed',
  error_code = sqlc.arg('error_code'),
  lease_until = NULL,
  completed_at = now()
WHERE id = sqlc.arg('id')
  AND status = 'queued';

-- name: CancelExportJob :one
UPDATE export_job
SET
  status = 'cancelled',
  cancelled_at = COALESCE(cancelled_at, now()),
  lease_until = NULL
WHERE id = sqlc.arg('id')
  AND user_id = sqlc.arg('user_id')
  AND status IN ('queued', 'running', 'ready')
RETURNING *;

-- name: ListStaleRunningExports :many
-- Reconciler candidates (mục 2.4); the caller checks river_job liveness.
-- Keyset-paged on (lease_until, id) so live rows skipped by the caller do not
-- starve later stale rows (review r1 R1-18).
SELECT id, attempt_id, file_name, lease_until
FROM export_job
WHERE status = 'running'
  AND lease_until < sqlc.arg('before')
  AND (lease_until, id) > (sqlc.arg('after_lease')::timestamptz, sqlc.arg('after_id')::uuid)
ORDER BY lease_until ASC, id ASC
LIMIT sqlc.arg('batch_limit');

-- name: ListStaleQueuedExports :many
-- Queued jobs whose River delivery may be exhausted (r1 R1-16); keyset-paged
-- on (created_at, id). The caller checks river_job liveness before failing.
SELECT id, created_at
FROM export_job
WHERE status = 'queued'
  AND created_at < sqlc.arg('before')
  AND (created_at, id) > (sqlc.arg('after_created')::timestamptz, sqlc.arg('after_id')::uuid)
ORDER BY created_at ASC, id ASC
LIMIT sqlc.arg('batch_limit');

-- name: MarkExportWorkerLost :execrows
UPDATE export_job
SET
  status = 'failed',
  error_code = 'worker_lost',
  lease_until = NULL,
  completed_at = now()
WHERE id = sqlc.arg('id')
  AND status = 'running'
  AND attempt_id IS NOT DISTINCT FROM sqlc.narg('attempt_id')
  AND lease_until < sqlc.arg('before');

-- name: ExpireDueExports :many
UPDATE export_job
SET status = 'expired'
WHERE status = 'ready'
  AND expires_at <= now()
RETURNING id, attempt_id, file_name;

-- name: ListLiveExportAttempts :many
-- Attempts whose files must survive the orphan sweep (mục 2.5.4).
SELECT id, attempt_id
FROM export_job
WHERE attempt_id IS NOT NULL
  AND (status = 'ready' OR (status = 'running' AND lease_until >= now()));

-- name: DeleteOldTerminalExports :execrows
DELETE FROM export_job
WHERE status IN ('failed', 'cancelled', 'expired')
  AND COALESCE(completed_at, cancelled_at, created_at) < sqlc.arg('before');

-- name: GetExportCleanup :one
SELECT * FROM export_file_cleanup
WHERE id = sqlc.arg('id');

-- name: ListPendingCleanupAfter :many
-- Keyset page over pending cleanup obligations so one prune sweep visits every
-- pending row even when an older page fails entirely (r2 R2-02).
SELECT * FROM export_file_cleanup
WHERE done_at IS NULL
  AND (created_at, id) > (sqlc.arg('after_created_at')::timestamptz, sqlc.arg('after_id')::uuid)
ORDER BY created_at ASC, id ASC
LIMIT sqlc.arg('batch_limit');

-- name: ExportSnapshotCounts :one
SELECT
  (SELECT count(*) FROM tag t WHERE t.user_id = sqlc.arg('user_id'))::int AS tags,
  (SELECT count(*) FROM item i WHERE i.user_id = sqlc.arg('user_id'))::int AS items,
  (SELECT count(*) FROM item_tag it JOIN item i2 ON i2.id = it.item_id WHERE i2.user_id = sqlc.arg('user_id'))::int AS item_tags,
  (SELECT count(*) FROM entry e WHERE e.user_id = sqlc.arg('user_id'))::int AS entries;

-- name: ExportRecoveryKeys :many
SELECT slot, lookup_hash, wrap
FROM vault_recovery_key
WHERE vault_id = sqlc.arg('user_id')
ORDER BY slot ASC;

-- name: ExportPasskeys :many
SELECT id, name, cred_id, prf_salt, vk_wrap, pubkey, aaguid, created_at
FROM vault_passkey
WHERE user_id = sqlc.arg('user_id')
ORDER BY created_at ASC, id ASC;

-- name: ExportTagsBatch :many
SELECT id, display, normalized, item_count, last_used_at, created_at, deleted_at
FROM tag
WHERE user_id = sqlc.arg('user_id')
  AND (created_at, id) > (sqlc.arg('after_created_at')::timestamptz, sqlc.arg('after_id')::uuid)
ORDER BY created_at ASC, id ASC
LIMIT sqlc.arg('batch_limit');

-- name: ExportItemsBatch :many
SELECT id, name, name_normalized, hint, entry_count, version, last_used_at,
  created_at, updated_at, deleted_at, delete_batch
FROM item
WHERE user_id = sqlc.arg('user_id')
  AND (created_at, id) > (sqlc.arg('after_created_at')::timestamptz, sqlc.arg('after_id')::uuid)
ORDER BY created_at ASC, id ASC
LIMIT sqlc.arg('batch_limit');

-- name: ExportItemTagsBatch :many
SELECT it.item_id, it.tag_id, it.created_at
FROM item_tag it
JOIN item i ON i.id = it.item_id
WHERE i.user_id = sqlc.arg('user_id')
  AND (it.item_id, it.tag_id) > (sqlc.arg('after_item_id')::uuid, sqlc.arg('after_tag_id')::uuid)
ORDER BY it.item_id ASC, it.tag_id ASC
LIMIT sqlc.arg('batch_limit');

-- name: ExportEntriesBatch :many
SELECT id, item_id, type, position, version, plaintext_len_bucket, envelope,
  ciphertext, created_at, updated_at, deleted_at, deleted_via, delete_batch
FROM entry
WHERE user_id = sqlc.arg('user_id')
  AND (item_id, position, id) > (sqlc.arg('after_item_id')::uuid, sqlc.arg('after_position')::int, sqlc.arg('after_id')::uuid)
ORDER BY item_id ASC, position ASC, id ASC
LIMIT sqlc.arg('batch_limit');
