-- P04 (ADR 0006): token đặt lại mật khẩu tài khoản (hash-only, TTL 30m, gắn trạng thái password_hash và bản chụp was_email_unverified).
-- Forward-only trên production; down chỉ dùng DB test.

CREATE TABLE password_reset_token (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  target_email         citext NOT NULL,
  token_hash           bytea NOT NULL UNIQUE,
  password_hash_sha256 bytea NOT NULL,
  was_email_unverified boolean NOT NULL DEFAULT false,
  expires_at           timestamptz NOT NULL,
  consumed_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(token_hash) = 32),
  CHECK (octet_length(password_hash_sha256) = 32)
);

CREATE INDEX password_reset_token_pending_idx
  ON password_reset_token (user_id)
  WHERE consumed_at IS NULL;

CREATE INDEX password_reset_token_expires_idx
  ON password_reset_token (expires_at);
