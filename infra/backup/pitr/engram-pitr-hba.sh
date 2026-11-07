#!/usr/bin/env bash
# Add/remove the PITR replication HBA rule in the DB container (P06 Task 9). Run under GO PROD-STEP-4.
#   engram-pitr-hba.sh apply    [container]   move/insert the rule to line 1 of pg_hba.conf (before every generic rule),
#                                             reload, verify it is the first rule matching engram_replication replication
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
    # Drop every existing copy of the rule, then put exactly one copy on line 1, so it precedes any generic
    # rule (e.g. "local replication all trust") wherever an earlier install or manual edit left it.
    docker exec -u postgres -e HBA="$hba" -e RULE="$RULE" "$CONTAINER" sh -ec '
      { printf "%s\n" "$RULE"; grep -vxF "$RULE" "$HBA" || true; } >"$HBA.engram-new"
      cat "$HBA.engram-new" >"$HBA"
      rm -f "$HBA.engram-new"'
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
# Effective precedence: the first rule that can match a local replication connection of engram_replication.
first="$(psql_c "SELECT array_to_string(user_name, ',') || ' ' || auth_method FROM pg_hba_file_rules
  WHERE type = 'local' AND database && ARRAY['replication'] AND user_name && ARRAY['all', 'engram_replication']
  ORDER BY rule_number LIMIT 1")"
if [ "$action" = apply ] && [ "$first" != 'engram_replication scram-sha-256' ]; then
  echo "engram-pitr-hba: SCRAM rule is not the first matching replication rule (got: ${first:-none})" >&2
  exit 1
fi
if [ "$action" = rollback ] && [ "$(docker exec -u postgres -e HBA="$hba" -e RULE="$RULE" "$CONTAINER" sh -c 'grep -cxF "$RULE" "$HBA" || true')" != 0 ]; then
  echo "engram-pitr-hba: rule still present after rollback" >&2
  exit 1
fi
echo "engram-pitr-hba: $action done; first matching local replication rule: ${first:-none}"
