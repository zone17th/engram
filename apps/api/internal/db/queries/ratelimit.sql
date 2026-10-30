-- name: AcquireRateLimitLock :exec
SELECT pg_advisory_xact_lock(hashtext(sqlc.arg('scope')::text), hashtext((sqlc.arg('user_id')::uuid)::text));

-- name: CountRateEventsSince :one
SELECT count(*)::int AS n
FROM rate_event
WHERE scope = sqlc.arg('scope')
  AND user_id = sqlc.arg('user_id')
  AND at > sqlc.arg('since');

-- name: GetOldestRateEventSince :one
SELECT at
FROM rate_event
WHERE scope = sqlc.arg('scope')
  AND user_id = sqlc.arg('user_id')
  AND at > sqlc.arg('since')
ORDER BY at ASC
LIMIT 1;

-- name: InsertRateEvent :one
INSERT INTO rate_event (
  scope,
  user_id,
  at
) VALUES (
  sqlc.arg('scope'),
  sqlc.arg('user_id'),
  sqlc.arg('at')
)
RETURNING *;

-- name: PruneRateEventsOlderThan :execrows
DELETE FROM rate_event
WHERE at < sqlc.arg('before');

-- name: PruneRateEventsOlderThanByUser :execrows
DELETE FROM rate_event
WHERE user_id = sqlc.arg('user_id')
  AND at < sqlc.arg('before');
