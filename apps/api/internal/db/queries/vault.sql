-- name: VaultExistsByUser :one
SELECT EXISTS (
  SELECT 1 FROM vault WHERE user_id = sqlc.arg('user_id')
);

-- name: GetVaultByUser :one
SELECT * FROM vault
WHERE user_id = sqlc.arg('user_id');

-- name: GetVaultByUserForUpdate :one
SELECT * FROM vault
WHERE user_id = sqlc.arg('user_id')
FOR UPDATE;

-- name: InsertVault :one
INSERT INTO vault (
  user_id,
  version,
  kdf,
  vault_key_id,
  vault_key_wrapped_by_kek,
  x25519_public,
  ed25519_public,
  private_keys_wrapped
) VALUES (
  sqlc.arg('user_id'),
  1,
  sqlc.arg('kdf'),
  sqlc.arg('vault_key_id'),
  sqlc.arg('vault_key_wrapped_by_kek'),
  sqlc.arg('x25519_public'),
  sqlc.arg('ed25519_public'),
  sqlc.arg('private_keys_wrapped')
)
RETURNING *;

-- name: RewrapVaultKEK :one
UPDATE vault
SET
  kdf = sqlc.arg('kdf'),
  vault_key_wrapped_by_kek = sqlc.arg('vault_key_wrapped_by_kek'),
  version = version + 1,
  updated_at = now()
WHERE user_id = sqlc.arg('user_id')
  AND version = sqlc.arg('expected_version')
RETURNING *;

-- name: BumpVaultVersion :one
UPDATE vault
SET
  version = version + 1,
  updated_at = now()
WHERE user_id = sqlc.arg('user_id')
  AND version = sqlc.arg('expected_version')
RETURNING *;

-- name: DeleteVaultByUser :execrows
DELETE FROM vault
WHERE user_id = sqlc.arg('user_id');

-- name: InsertRecoveryKey :one
INSERT INTO vault_recovery_key (
  vault_id,
  slot,
  lookup_hash,
  wrap
) VALUES (
  sqlc.arg('user_id'),
  sqlc.arg('slot'),
  sqlc.arg('lookup_hash'),
  sqlc.arg('wrap')
)
RETURNING *;

-- name: ReplaceRecoveryKeyBySlot :one
INSERT INTO vault_recovery_key (
  vault_id,
  slot,
  lookup_hash,
  wrap
) VALUES (
  sqlc.arg('user_id'),
  sqlc.arg('slot'),
  sqlc.arg('lookup_hash'),
  sqlc.arg('wrap')
)
ON CONFLICT (vault_id, slot) DO UPDATE SET
  id = gen_random_uuid(),
  lookup_hash = EXCLUDED.lookup_hash,
  wrap = EXCLUDED.wrap,
  created_at = now()
RETURNING *;

-- name: GetRecoveryKeyByUserAndHash :one
SELECT * FROM vault_recovery_key
WHERE vault_id = sqlc.arg('user_id')
  AND lookup_hash = sqlc.arg('lookup_hash');

-- name: GetRecoveryKeyByUserAndHashForUpdate :one
SELECT * FROM vault_recovery_key
WHERE vault_id = sqlc.arg('user_id')
  AND lookup_hash = sqlc.arg('lookup_hash')
FOR UPDATE;

-- name: GetRecoveryKeyByUserAndIDForUpdate :one
SELECT * FROM vault_recovery_key
WHERE vault_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
FOR UPDATE;

-- name: ConsumeRecoveryKeyByID :execrows
DELETE FROM vault_recovery_key
WHERE vault_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id');

-- name: ConsumeRecoveryKeyByHash :execrows
DELETE FROM vault_recovery_key
WHERE vault_id = sqlc.arg('user_id')
  AND lookup_hash = sqlc.arg('lookup_hash');

-- name: CountRecoveryKeysByUser :one
SELECT count(*)::int AS n
FROM vault_recovery_key
WHERE vault_id = sqlc.arg('user_id');

-- name: ListRecoveryKeySlotsByUser :many
SELECT slot
FROM vault_recovery_key
WHERE vault_id = sqlc.arg('user_id')
ORDER BY slot ASC;

-- name: DeleteRecoveryKeysByUser :execrows
DELETE FROM vault_recovery_key
WHERE vault_id = sqlc.arg('user_id');

-- name: InsertPasskey :one
INSERT INTO vault_passkey (
  user_id,
  cred_id,
  pubkey,
  prf_salt,
  vk_wrap,
  aaguid,
  name
) VALUES (
  sqlc.arg('user_id'),
  sqlc.arg('cred_id'),
  sqlc.arg('pubkey'),
  sqlc.arg('prf_salt'),
  sqlc.arg('vk_wrap'),
  sqlc.arg('aaguid'),
  sqlc.arg('name')
)
RETURNING *;

-- name: ListPasskeysByUser :many
SELECT * FROM vault_passkey
WHERE user_id = sqlc.arg('user_id')
ORDER BY created_at ASC, id ASC;

-- name: GetPasskeyByUserAndID :one
SELECT * FROM vault_passkey
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id');

-- name: RenamePasskeyByOwner :one
UPDATE vault_passkey
SET name = sqlc.arg('name')
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id')
RETURNING *;

-- name: DeletePasskeyByOwner :execrows
DELETE FROM vault_passkey
WHERE user_id = sqlc.arg('user_id')
  AND id = sqlc.arg('id');

-- name: InsertWebAuthnChallenge :one
INSERT INTO webauthn_challenge (
  user_id,
  session_id,
  vault_key_id,
  challenge_hash,
  prf_salt,
  expires_at
) VALUES (
  sqlc.arg('user_id'),
  sqlc.arg('session_id'),
  sqlc.arg('vault_key_id'),
  sqlc.arg('challenge_hash'),
  sqlc.arg('prf_salt'),
  sqlc.arg('expires_at')
)
RETURNING *;

-- name: ConsumeWebAuthnChallengeByHash :one
UPDATE webauthn_challenge
SET consumed_at = sqlc.arg('now')
WHERE user_id = sqlc.arg('user_id')
  AND session_id = sqlc.arg('session_id')
  AND vault_key_id = sqlc.arg('vault_key_id')
  AND challenge_hash = sqlc.arg('challenge_hash')
  AND consumed_at IS NULL
  AND expires_at > sqlc.arg('now')
RETURNING *;

-- name: ConsumeWebAuthnChallenge :one
UPDATE webauthn_challenge
SET consumed_at = sqlc.arg('now')
WHERE id = sqlc.arg('id')
  AND user_id = sqlc.arg('user_id')
  AND session_id = sqlc.arg('session_id')
  AND vault_key_id = sqlc.arg('vault_key_id')
  AND challenge_hash = sqlc.arg('challenge_hash')
  AND prf_salt = sqlc.arg('prf_salt')
  AND consumed_at IS NULL
  AND expires_at > sqlc.arg('now')
RETURNING *;

-- name: DeleteWebAuthnChallengesByUser :execrows
DELETE FROM webauthn_challenge
WHERE user_id = sqlc.arg('user_id');

-- name: DeleteExpiredWebAuthnChallenges :execrows
DELETE FROM webauthn_challenge
WHERE expires_at < sqlc.arg('now');

-- name: DeleteExpiredWebAuthnChallengesByUser :execrows
DELETE FROM webauthn_challenge
WHERE user_id = sqlc.arg('user_id')
  AND expires_at < sqlc.arg('now');
