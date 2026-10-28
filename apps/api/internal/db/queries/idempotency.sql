-- name: GetIdempotencyKey :one
SELECT * FROM idempotency_key
WHERE user_id = sqlc.arg('user_id')
  AND key = sqlc.arg('key')
  AND expires_at > sqlc.arg('now');

-- name: ClaimIdempotencyKey :one
INSERT INTO idempotency_key (
  user_id,
  key,
  method,
  path,
  request_hash,
  status,
  owner_token,
  claimed_at,
  expires_at,
  response,
  status_code
) VALUES (
  sqlc.arg('user_id'),
  sqlc.arg('key'),
  sqlc.arg('method'),
  sqlc.arg('path'),
  sqlc.arg('request_hash'),
  'in_progress',
  sqlc.arg('owner_token'),
  sqlc.arg('now')::timestamptz,
  sqlc.arg('now')::timestamptz + interval '24 hours',
  NULL,
  NULL
)
ON CONFLICT (user_id, key) DO UPDATE SET
  method = EXCLUDED.method,
  path = EXCLUDED.path,
  request_hash = EXCLUDED.request_hash,
  status = 'in_progress',
  owner_token = EXCLUDED.owner_token,
  claimed_at = EXCLUDED.claimed_at,
  expires_at = EXCLUDED.expires_at,
  response = NULL,
  status_code = NULL
WHERE idempotency_key.expires_at <= EXCLUDED.claimed_at
   OR (
     idempotency_key.status = 'in_progress'
     AND idempotency_key.request_hash = EXCLUDED.request_hash
     AND idempotency_key.claimed_at < EXCLUDED.claimed_at - interval '60 seconds'
   )
RETURNING owner_token;

-- name: FinishIdempotencyKey :execrows
UPDATE idempotency_key
SET
  status = 'done',
  status_code = sqlc.arg('status_code')::int,
  response = sqlc.arg('response')
WHERE user_id = sqlc.arg('user_id')
  AND key = sqlc.arg('key')
  AND owner_token = sqlc.arg('owner_token');

-- name: ReleaseIdempotencyKey :execrows
DELETE FROM idempotency_key
WHERE user_id = sqlc.arg('user_id')
  AND key = sqlc.arg('key')
  AND owner_token = sqlc.arg('owner_token')
  AND status = 'in_progress';

-- name: PurgeVaultIdempotencyKeys :execrows
DELETE FROM idempotency_key
WHERE user_id = sqlc.arg('user_id')
  AND path LIKE '/api/v1/vault%'
  AND key <> sqlc.arg('key');

-- name: PruneExpiredIdempotencyKeys :execrows
DELETE FROM idempotency_key
WHERE expires_at < sqlc.arg('now');

-- name: PruneExpiredIdempotencyKeysByUser :execrows
DELETE FROM idempotency_key
WHERE user_id = sqlc.arg('user_id')
  AND expires_at < sqlc.arg('now');
