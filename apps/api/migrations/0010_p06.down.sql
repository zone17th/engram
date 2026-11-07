-- P06 down migration (ephemeral test databases only).

ALTER TABLE app_user
  DROP COLUMN IF EXISTS semantic_consent_seen_at,
  ALTER COLUMN settings SET DEFAULT '{"semantic_suggest": true}'::jsonb;

DROP TABLE IF EXISTS export_file_cleanup;
DROP TABLE IF EXISTS export_job;
