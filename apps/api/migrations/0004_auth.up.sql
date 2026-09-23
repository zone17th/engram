-- P02: tài khoản, session, OAuth transaction, verification, audit, notification.
-- Không tạo bảng vault. Forward-only trên production; down chỉ dùng DB test.

CREATE TABLE app_user (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext UNIQUE NOT NULL,
  email_verified_at  timestamptz,
  locale             text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'vi')),
  theme              text NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  auto_lock_minutes  int  NOT NULL DEFAULT 15 CHECK (auto_lock_minutes IN (0, 5, 15, 60)),
  settings           jsonb NOT NULL DEFAULT '{"semantic_suggest": true}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE TABLE auth_identity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('password', 'google', 'github')),
  provider_uid  text,
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider),
  CHECK (
    (provider = 'password' AND password_hash IS NOT NULL AND provider_uid IS NULL)
    OR
    (provider IN ('google', 'github') AND provider_uid IS NOT NULL AND password_hash IS NULL)
  )
);
CREATE UNIQUE INDEX auth_identity_provider_uid_uq
  ON auth_identity (provider, provider_uid)
  WHERE provider_uid IS NOT NULL;

CREATE TABLE session (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  refresh_token_hash bytea NOT NULL UNIQUE,
  device_label       text,
  ip_hash            bytea,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz
);
CREATE INDEX session_user_idx ON session (user_id) WHERE revoked_at IS NULL;

CREATE TABLE session_refresh_used (
  token_hash bytea PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES session (id) ON DELETE CASCADE,
  used_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_refresh_used_session_idx ON session_refresh_used (session_id);

CREATE TABLE auth_throttle (
  subject_hash   bytea PRIMARY KEY,
  failed_count   int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_failed_at timestamptz
);

CREATE TABLE email_verification (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  session_id             uuid REFERENCES session (id) ON DELETE SET NULL,
  purpose                text NOT NULL CHECK (purpose IN ('signup', 'email_change', 'password_enroll')),
  target_email           citext NOT NULL,
  expected_current_email citext,
  token_hash             bytea NOT NULL UNIQUE,
  expires_at             timestamptz NOT NULL,
  consumed_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (
    purpose = 'signup'
    OR (purpose IN ('email_change', 'password_enroll') AND session_id IS NOT NULL)
  )
);
CREATE INDEX email_verification_pending_idx
  ON email_verification (user_id, purpose)
  WHERE consumed_at IS NULL;
CREATE INDEX email_verification_expires_idx ON email_verification (expires_at);

CREATE TABLE oauth_transaction (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                text NOT NULL CHECK (provider IN ('google', 'github')),
  mode                    text NOT NULL CHECK (mode IN ('login', 'link', 'reauth')),
  status                  text NOT NULL CHECK (status IN ('pending', 'claimed', 'ready', 'completed')),
  state_hash              bytea NOT NULL UNIQUE,
  cookie_binding_hash     bytea NOT NULL,
  pkce_verifier           text,
  nonce                   text,
  expected_user_id        uuid REFERENCES app_user (id) ON DELETE CASCADE,
  expected_session_id     uuid REFERENCES session (id) ON DELETE CASCADE,
  action                  text,
  identity_provider       text,
  identity_provider_uid   text,
  identity_email          citext,
  identity_email_verified boolean,
  completion_deadline     timestamptz,
  started_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  claimed_at              timestamptz,
  consumed_at             timestamptz
);
CREATE INDEX oauth_transaction_expires_idx ON oauth_transaction (expires_at);
CREATE INDEX oauth_transaction_binding_idx
  ON oauth_transaction (cookie_binding_hash)
  WHERE consumed_at IS NULL;

CREATE TABLE oauth_reauth_receipt (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES session (id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('google')),
  action      text NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_reauth_receipt_expires_idx ON oauth_reauth_receipt (expires_at);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES app_user (id) ON DELETE SET NULL,
  session_id uuid,
  event      text NOT NULL,
  result     text NOT NULL CHECK (result IN ('success', 'failure')),
  actor      text,
  ip_hash    bytea,
  user_agent text,
  meta       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_user_time_idx ON audit_log (user_id, created_at DESC, id DESC);
CREATE INDEX audit_created_idx ON audit_log (created_at);

CREATE TABLE user_notification (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  kind          text NOT NULL,
  meta          jsonb,
  email_targets citext[],
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_notification_user_time_idx
  ON user_notification (user_id, created_at DESC, id DESC);
CREATE INDEX user_notification_created_idx ON user_notification (created_at);
