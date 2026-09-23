-- name: InsertUser :one
INSERT INTO app_user (email, locale)
VALUES ($1, $2)
RETURNING *;

-- name: GetUserByID :one
SELECT * FROM app_user
WHERE id = $1 AND deleted_at IS NULL;

-- name: GetUserByIDForUpdate :one
SELECT * FROM app_user
WHERE id = $1 AND deleted_at IS NULL
FOR UPDATE;

-- name: GetUserByEmail :one
SELECT * FROM app_user
WHERE email = $1 AND deleted_at IS NULL;

-- name: SoftDeleteUser :exec
UPDATE app_user SET deleted_at = now()
WHERE id = $1 AND deleted_at IS NULL;

-- name: UpdateUserEmailVerified :one
UPDATE app_user
SET email_verified_at = $2
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: UpdateUserEmail :one
UPDATE app_user
SET email = $2, email_verified_at = $3
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: UpdateUserLocaleThemeAutoLock :one
UPDATE app_user
SET
  locale = COALESCE(sqlc.narg('locale')::text, locale),
  theme = COALESCE(sqlc.narg('theme')::text, theme),
  auto_lock_minutes = COALESCE(sqlc.narg('auto_lock_minutes')::int, auto_lock_minutes)
WHERE id = sqlc.arg('id') AND deleted_at IS NULL
RETURNING *;

-- name: UpdateUserSemanticSuggest :one
UPDATE app_user
SET settings = jsonb_set(settings, '{semantic_suggest}', to_jsonb(sqlc.arg('semantic_suggest')::boolean), true)
WHERE id = sqlc.arg('id') AND deleted_at IS NULL
RETURNING *;

-- name: InsertPasswordIdentity :one
INSERT INTO auth_identity (user_id, provider, password_hash)
VALUES ($1, 'password', $2)
RETURNING *;

-- name: InsertOAuthIdentity :one
INSERT INTO auth_identity (user_id, provider, provider_uid)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetIdentitiesByUser :many
SELECT * FROM auth_identity
WHERE user_id = $1
ORDER BY created_at ASC, id ASC;

-- name: GetIdentityByUserProvider :one
SELECT * FROM auth_identity
WHERE user_id = $1 AND provider = $2;

-- name: GetIdentityByProviderUID :one
SELECT * FROM auth_identity
WHERE provider = $1 AND provider_uid = $2;

-- name: CountIdentitiesByUser :one
SELECT count(*)::int AS n FROM auth_identity WHERE user_id = $1;

-- name: DeleteIdentity :execrows
DELETE FROM auth_identity
WHERE user_id = $1 AND provider = $2;

-- name: UpdatePasswordHash :one
UPDATE auth_identity
SET password_hash = $2
WHERE user_id = $1 AND provider = 'password'
RETURNING *;

-- name: InsertSession :one
INSERT INTO session (
  user_id, refresh_token_hash, device_label, ip_hash, user_agent, expires_at
) VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetSessionByID :one
SELECT * FROM session WHERE id = $1;

-- name: GetSessionByIDForUpdate :one
SELECT * FROM session WHERE id = $1 FOR UPDATE;

-- name: GetSessionByRefreshHash :one
SELECT * FROM session WHERE refresh_token_hash = $1;

-- name: GetSessionByRefreshHashForUpdate :one
SELECT * FROM session WHERE refresh_token_hash = $1 FOR UPDATE;

-- name: GetSessionByUsedRefreshHash :one
SELECT s.*
FROM session_refresh_used u
JOIN session s ON s.id = u.session_id
WHERE u.token_hash = $1;

-- name: GetSessionByUsedRefreshHashForUpdate :one
SELECT s.*
FROM session_refresh_used u
JOIN session s ON s.id = u.session_id
WHERE u.token_hash = $1
FOR UPDATE OF s;

-- name: ListAliveSessionsByUser :many
SELECT * FROM session
WHERE user_id = $1
  AND revoked_at IS NULL
  AND expires_at > $2
  AND (
    sqlc.narg('cursor_created')::timestamptz IS NULL
    OR (created_at, id) > (sqlc.narg('cursor_created')::timestamptz, sqlc.narg('cursor_id')::uuid)
  )
ORDER BY created_at ASC, id ASC
LIMIT $3;

-- name: TouchSessionLastSeen :exec
UPDATE session
SET last_seen_at = $2
WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < $3);

-- name: RotateSessionRefresh :one
UPDATE session
SET refresh_token_hash = $2
WHERE id = $1
RETURNING *;

-- name: InsertRefreshUsed :exec
INSERT INTO session_refresh_used (token_hash, session_id, used_at)
VALUES ($1, $2, $3);

-- name: RevokeSession :one
UPDATE session
SET revoked_at = $2
WHERE id = $1 AND revoked_at IS NULL
RETURNING *;

-- name: RevokeOtherSessions :execrows
UPDATE session
SET revoked_at = $3
WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL;

-- name: CountOtherAliveSessions :one
SELECT count(*)::int AS n
FROM session
WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL AND expires_at > $3;

-- name: UpsertThrottleFailure :one
INSERT INTO auth_throttle (subject_hash, failed_count, locked_until, last_failed_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (subject_hash) DO UPDATE
SET
  failed_count = EXCLUDED.failed_count,
  locked_until = EXCLUDED.locked_until,
  last_failed_at = EXCLUDED.last_failed_at
RETURNING *;

-- name: GetThrottleForUpdate :one
INSERT INTO auth_throttle (subject_hash, failed_count)
VALUES ($1, 0)
ON CONFLICT (subject_hash) DO UPDATE
SET subject_hash = auth_throttle.subject_hash
RETURNING *;

-- name: UpdateThrottle :one
UPDATE auth_throttle
SET failed_count = $2, locked_until = $3, last_failed_at = $4
WHERE subject_hash = $1
RETURNING *;

-- name: ResetThrottle :exec
UPDATE auth_throttle
SET failed_count = 0, locked_until = NULL, last_failed_at = NULL
WHERE subject_hash = $1;

-- name: DeleteInactiveThrottle :execrows
DELETE FROM auth_throttle
WHERE last_failed_at IS NULL OR last_failed_at < $1;

-- name: InsertEmailVerification :one
INSERT INTO email_verification (
  user_id, session_id, purpose, target_email, expected_current_email, token_hash, expires_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: GetEmailVerificationByHash :one
SELECT * FROM email_verification WHERE token_hash = $1;

-- name: GetEmailVerificationByHashForUpdate :one
SELECT * FROM email_verification WHERE token_hash = $1 FOR UPDATE;

-- name: ConsumeEmailVerification :one
UPDATE email_verification
SET consumed_at = $2
WHERE id = $1 AND consumed_at IS NULL
RETURNING *;

-- name: ExpirePendingByUserPurpose :execrows
UPDATE email_verification
SET consumed_at = $3
WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL;

-- name: CancelPendingEmailProofs :execrows
UPDATE email_verification
SET consumed_at = $2
WHERE user_id = $1
  AND consumed_at IS NULL
  AND purpose IN ('email_change', 'password_enroll', 'signup');

-- name: CancelPendingBySession :execrows
UPDATE email_verification
SET consumed_at = $2
WHERE session_id = $1
  AND consumed_at IS NULL
  AND purpose IN ('email_change', 'password_enroll');

-- name: DeleteExpiredVerifications :execrows
DELETE FROM email_verification
WHERE expires_at < $1;

-- name: InsertOAuthTransaction :one
INSERT INTO oauth_transaction (
  provider, mode, status, state_hash, cookie_binding_hash, pkce_verifier, nonce,
  expected_user_id, expected_session_id, action, started_at, expires_at
) VALUES (
  $1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11
)
RETURNING *;

-- name: GetOAuthTxByStateHash :one
SELECT * FROM oauth_transaction WHERE state_hash = $1;

-- name: GetOAuthTxByIDForUpdate :one
SELECT * FROM oauth_transaction WHERE id = $1 FOR UPDATE;

-- name: GetLatestOAuthTxByBinding :one
SELECT * FROM oauth_transaction
WHERE cookie_binding_hash = $1
ORDER BY started_at DESC
LIMIT 1;

-- name: CancelPendingOAuthByBinding :execrows
UPDATE oauth_transaction
SET consumed_at = $2, status = 'completed'
WHERE cookie_binding_hash = $1
  AND consumed_at IS NULL
  AND status IN ('pending', 'claimed', 'ready');

-- name: CancelPendingOAuthBySession :execrows
UPDATE oauth_transaction
SET consumed_at = $2, status = 'completed'
WHERE expected_session_id = $1 AND consumed_at IS NULL;

-- name: ClaimOAuthTransaction :one
UPDATE oauth_transaction
SET status = 'claimed', claimed_at = $2, pkce_verifier = NULL
WHERE id = $1 AND status = 'pending' AND claimed_at IS NULL
RETURNING *;

-- name: MarkOAuthReady :one
UPDATE oauth_transaction
SET
  status = 'ready',
  identity_provider = $2,
  identity_provider_uid = $3,
  identity_email = $4,
  identity_email_verified = $5,
  completion_deadline = $6
WHERE id = $1 AND status = 'claimed'
RETURNING *;

-- name: CompleteOAuthTransaction :one
UPDATE oauth_transaction
SET status = 'completed', consumed_at = $2
WHERE id = $1 AND consumed_at IS NULL AND status IN ('claimed', 'ready')
RETURNING *;

-- name: CancelPendingByUserExceptSession :execrows
UPDATE email_verification
SET consumed_at = $3
WHERE user_id = $1
  AND session_id IS NOT NULL
  AND session_id <> $2
  AND consumed_at IS NULL
  AND purpose IN ('email_change', 'password_enroll');

-- name: CancelPendingOAuthByUserExceptSession :execrows
UPDATE oauth_transaction
SET consumed_at = $3, status = 'completed'
WHERE expected_user_id = $1
  AND (expected_session_id IS NULL OR expected_session_id <> $2)
  AND consumed_at IS NULL;

-- name: CancelReceiptsByUserExceptSession :execrows
UPDATE oauth_reauth_receipt
SET consumed_at = $3
WHERE user_id = $1 AND session_id <> $2 AND consumed_at IS NULL;

-- name: DeleteExpiredOAuthTransactions :execrows
DELETE FROM oauth_transaction
WHERE expires_at < $1;

-- name: InsertReauthReceipt :one
INSERT INTO oauth_reauth_receipt (
  user_id, session_id, provider, action, token_hash, expires_at
) VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetReceiptByHashForUpdate :one
SELECT * FROM oauth_reauth_receipt WHERE token_hash = $1 FOR UPDATE;

-- name: ConsumeReceipt :one
UPDATE oauth_reauth_receipt
SET consumed_at = $2
WHERE id = $1 AND consumed_at IS NULL
RETURNING *;

-- name: CancelReceiptsBySession :execrows
UPDATE oauth_reauth_receipt
SET consumed_at = $2
WHERE session_id = $1 AND consumed_at IS NULL;

-- name: DeleteExpiredReceipts :execrows
DELETE FROM oauth_reauth_receipt
WHERE expires_at < $1;

-- name: DeleteRefreshUsedForDeadSessions :execrows
DELETE FROM session_refresh_used u
USING session s
WHERE u.session_id = s.id
  AND (
    (s.revoked_at IS NOT NULL AND s.revoked_at < $1)
    OR s.expires_at < $1
  );
