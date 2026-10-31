-- P03: vault, recovery key, passkey WebAuthn, challenge, idempotency, rate limit.
-- Server không bao giờ nhận/lưu passphrase, KEK, VK, plaintext RK, PWK hay private key chưa wrap.
-- Forward-only trên production; down chỉ dùng DB test.

CREATE TABLE vault (
  user_id                  uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
  version                  int  NOT NULL DEFAULT 1,
  kdf                      jsonb NOT NULL,
  vault_key_id             text  NOT NULL UNIQUE,
  vault_key_wrapped_by_kek bytea NOT NULL,
  x25519_public            bytea NOT NULL,
  ed25519_public           bytea NOT NULL,
  private_keys_wrapped     bytea NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vault_recovery_key (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id    uuid NOT NULL REFERENCES vault (user_id) ON DELETE CASCADE,
  slot        int  NOT NULL CHECK (slot BETWEEN 1 AND 10),
  lookup_hash bytea NOT NULL UNIQUE,
  wrap        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault_id, slot)
);

CREATE TABLE vault_passkey (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES vault (user_id) ON DELETE CASCADE,
  cred_id    bytea NOT NULL UNIQUE,
  pubkey     bytea NOT NULL,
  prf_salt   bytea NOT NULL,
  vk_wrap    bytea NOT NULL,
  aaguid     bytea,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_passkey_user_idx ON vault_passkey (user_id);

CREATE TABLE webauthn_challenge (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  session_id     uuid NOT NULL REFERENCES session (id) ON DELETE CASCADE,
  vault_key_id   text NOT NULL,
  challenge_hash bytea NOT NULL UNIQUE,
  prf_salt       bytea NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webauthn_challenge_expires_idx ON webauthn_challenge (expires_at);

CREATE TABLE idempotency_key (
  user_id      uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  key          text NOT NULL CHECK (char_length(key) BETWEEN 16 AND 128),
  method       text NOT NULL,
  path         text NOT NULL,
  request_hash bytea NOT NULL,
  status       text NOT NULL CHECK (status IN ('in_progress', 'done')),
  owner_token  uuid NOT NULL,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  status_code  int,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_key_user_path_idx ON idempotency_key (user_id, path);
CREATE INDEX idempotency_key_expires_idx ON idempotency_key (expires_at);

CREATE TABLE rate_event (
  id      bigserial PRIMARY KEY,
  scope   text NOT NULL,
  user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_event_scope_user_at_idx ON rate_event (scope, user_id, at DESC);
CREATE INDEX rate_event_at_idx ON rate_event (at);
