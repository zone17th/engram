#!/usr/bin/env bash
# Add/remove the PITR replication HBA rule in the DB container (P06 Task 9). Run under GO PROD-STEP-4.
#   engram-pitr-hba.sh apply    [container]   insert rule at the top of pg_hba.conf (before every generic rule), reload
#   engram-pitr-hba.sh rollback [container]   remove rule, DROP ROLE engram_replication, reload
# Idempotent; no secret is involved.
set -euo pipefail

action="${1:-}"
CONTAINER="${2:-${ENGRAM_DB_CONTAINER:-engram-db-1}}"
DB_USER="${ENGRAM_DB_USER:-engram}"
RULE='local replication engram_replication scram-sha-256'

psql_c() { docker exec -u postgres "$CONTAINER" psql -X -At -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres -c "$1"; }

hba="$(psql_c 'SHOW hba_file')"
case "$action" in
  apply)
    docker exec -u postgres -e HBA="$hba" -e RULE="$RULE" "$CONTAINER" sh -ec '
      if ! grep -qxF "$RULE" "$HBA"; then
        { printf "%s\n" "$RULE"; cat "$HBA"; } >"$HBA.engram-new"
        cat "$HBA.engram-new" >"$HBA"
        rm -f "$HBA.engram-new"
      fi'
    ;;
  rollback)
    docker exec -u postgres -e HBA="$hba" -e RULE="$RULE" "$CONTAINER" sh -ec '
      grep -vxF "$RULE" "$HBA" >"$HBA.engram-new" || true
      cat "$HBA.engram-new" >"$HBA"
      rm -f "$HBA.engram-new"'
    psql_c 'DROP ROLE IF EXISTS engram_replication' >/dev/null
    ;;
  *)
    echo "usage: $0 apply|rollback [container]" >&2
    exit 2
    ;;
esac
[ "$(psql_c 'SELECT pg_reload_conf()')" = t ]
errors="$(psql_c 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')"
[ "$errors" = 0 ] || { echo "pg_hba.conf has $errors invalid lines" >&2; exit 1; }
first="$(psql_c "SELECT type||' '||array_to_string(database,',')||' '||array_to_string(user_name,',')||' '||auth_method FROM pg_hba_file_rules ORDER BY rule_number LIMIT 1")"
echo "engram-pitr-hba: $action done; first rule: $first"
