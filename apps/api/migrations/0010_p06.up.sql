-- P06: export_job lifecycle table, durable export_file_cleanup table (no FK/PII),
-- and semantic search consent default-off + seen timestamp on app_user.
-- Forward-only on production; down is for ephemeral test databases only.

CREATE TABLE export_job (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  kind                  text NOT NULL CHECK (kind IN ('encrypted')),
  status                text NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed', 'cancelled', 'expired')),
  attempt_id            uuid,
  lease_until           timestamptz,
  snapshot_vault_key_id text CHECK (snapshot_vault_key_id IS NULL OR snapshot_vault_key_id ~ '^vk:[A-Za-z0-9_-]{22}$'),
  snapshot_vault_ver    int,
  file_name             text CHECK (file_name IS NULL OR file_name ~ '^[0-9a-f-]{36}\.[0-9a-f-]{36}\.(tmp|sabk\.enc)$'),
  size_bytes            bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  items_total           int CHECK (items_total IS NULL OR items_total >= 0),
  items_processed       int CHECK (items_processed IS NULL OR items_processed >= 0),
  error_code            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  completed_at          timestamptz,
  cancelled_at          timestamptz,
  expires_at            timestamptz,
  CHECK ((status = 'ready') <= (expires_at IS NOT NULL AND size_bytes IS NOT NULL AND attempt_id IS NOT NULL AND file_name IS NOT NULL))
);

CREATE INDEX export_job_user_created_idx
  ON export_job (user_id, created_at DESC, id DESC);

CREATE INDEX export_job_prune_idx
  ON export_job (expires_at)
  WHERE status = 'ready' OR file_name IS NOT NULL;

CREATE UNIQUE INDEX export_job_one_active_idx
  ON export_job (user_id, kind)
  WHERE status IN ('queued', 'running');

CREATE TABLE export_file_cleanup (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name  text NOT NULL CHECK (file_name ~ '^[0-9a-f-]{36}\.[0-9a-f-]{36}\.(tmp|sabk\.enc)$'),
  job_id     uuid NOT NULL,
  attempt_id uuid,
  reason     text NOT NULL CHECK (reason IN ('expired', 'replaced', 'cancelled', 'reset', 'account_delete', 'rescue', 'drain', 'worker_lost')),
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at    timestamptz,
  attempts   int NOT NULL DEFAULT 0
);

CREATE INDEX export_file_cleanup_pending_idx
  ON export_file_cleanup (created_at)
  WHERE done_at IS NULL;

CREATE INDEX export_file_cleanup_done_idx
  ON export_file_cleanup (done_at)
  WHERE done_at IS NOT NULL;

ALTER TABLE app_user
  ALTER COLUMN settings SET DEFAULT '{"semantic_suggest": false}'::jsonb,
  ADD COLUMN semantic_consent_seen_at timestamptz NULL;
