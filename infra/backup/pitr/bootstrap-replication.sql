-- engram_replication role bootstrap for PITR base backups (P06 Task 9, R4-02/R5-01).
-- Idempotent; meant for a cluster that ALREADY has data (not an init script). Run under GO PROD-STEP-4:
--   docker exec -i engram-db-1 psql -X -U engram -v ON_ERROR_STOP=1 < infra/backup/pitr/bootstrap-replication.sql
-- The password is read INSIDE psql from the read-only secret file (mode 0600, owner postgres); it never travels
-- through argv, -v, or docker -e. Rollback: DROP ROLE engram_replication; remove the HBA line; pg_reload_conf().
\set QUIET on
\set ECHO none
\set VERBOSITY terse
\set SHOW_CONTEXT never
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;

\set repl_password `cat /run/secrets/engram_replication.password`
SELECT length(:'repl_password') >= 16 AS engram_repl_pw_ok \gset
\if :engram_repl_pw_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'replication password file missing or shorter than 16 characters'; END $$;
\endif

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'engram_replication') THEN
    CREATE ROLE engram_replication LOGIN REPLICATION;
  END IF;
END
$$;

SET password_encryption = 'scram-sha-256';
ALTER ROLE engram_replication PASSWORD :'repl_password';
\unset repl_password
SELECT 'engram_replication ready' AS status;
