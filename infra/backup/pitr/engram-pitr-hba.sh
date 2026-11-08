#!/usr/bin/env bash
# Add/remove the PITR replication HBA rule in the DB container (P06 Task 9). Run under GO PROD-STEP-4.
#   engram-pitr-hba.sh apply    [container]   move/insert the rule to line 1 of pg_hba.conf (before every generic rule),
#                                             verify it is the first rule matching engram_replication replication, reload
#   engram-pitr-hba.sh rollback [container]   remove the rule, reload, DROP ROLE engram_replication
# Idempotent; no secret is involved. Publication is failure-atomic: the new file is built as a same-directory
# temporary with the live file's owner/mode, synced and renamed over the live file; the previous file is kept as
# a same-directory copy until the new one parses cleanly (pg_hba_file_rules) and passes the precedence check,
# otherwise it is renamed back and nothing is reloaded. Any failure before the rename leaves the live file untouched.
set -euo pipefail

action="${1:-}"
CONTAINER="${2:-${ENGRAM_DB_CONTAINER:-engram-db-1}}"
DB_USER="${ENGRAM_DB_USER:-engram}"
RULE='local replication engram_replication scram-sha-256'

case "$action" in
  apply | rollback) ;;
  *) echo "usage: $0 apply|rollback [container]" >&2; exit 2 ;;
esac

psql_c() { docker exec -u postgres "$CONTAINER" psql -X -At -v ON_ERROR_STOP=1 -U "$DB_USER" -d postgres -c "$1"; }

hba="$(psql_c 'SHOW hba_file')"

# Build + publish inside the container (same filesystem as the live file). Exit 3 = nothing published.
docker exec -u postgres -e HBA="$hba" -e RULE="$RULE" -e ACTION="$action" "$CONTAINER" bash -c '
  set -euo pipefail
  new="$HBA.engram-new"; prev="$HBA.engram-prev"
  if [ -e "$new" ] || [ -e "$prev" ]; then
    echo "engram-pitr-hba: $new or $prev exists (concurrent or interrupted run); live file untouched" >&2
    exit 3
  fi
  trap "rm -f \"$new\"" EXIT
  set +e
  if [ "$ACTION" = apply ]; then
    { printf "%s\n" "$RULE"; grep -vxF "$RULE" "$HBA"; } >"$new"
    rc=$?
  else
    grep -vxF "$RULE" "$HBA" >"$new"
    rc=$?
  fi
  set -e
  # grep: 0 = lines kept, 1 = no line kept (only the rule itself was there), >1 = read error
  [ "$rc" -le 1 ] || { echo "engram-pitr-hba: could not build $new (rc=$rc); live file untouched" >&2; exit 3; }
  chmod --reference="$HBA" "$new"
  sync "$new"
  cp -p "$HBA" "$prev"
  sync "$prev"
  mv -f "$new" "$HBA"
  sync "$(dirname "$HBA")"
' || { echo "engram-pitr-hba: $action aborted before publication" >&2; exit 1; }

restore_prev() {
  docker exec -u postgres -e HBA="$hba" "$CONTAINER" sh -c 'mv -f "$HBA.engram-prev" "$HBA" && sync "$(dirname "$HBA")"'
  echo "engram-pitr-hba: restored the previous pg_hba.conf; nothing reloaded" >&2
  exit 1
}

# Validate the published file BEFORE reloading (pg_hba_file_rules parses the file on disk).
errors="$(psql_c 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" || restore_prev
[ "$errors" = 0 ] || { echo "engram-pitr-hba: new pg_hba.conf has $errors invalid lines" >&2; restore_prev; }
# Effective precedence: the first rule that can match a local replication connection of engram_replication.
first="$(psql_c "SELECT array_to_string(user_name, ',') || ' ' || auth_method FROM pg_hba_file_rules
  WHERE type = 'local' AND database && ARRAY['replication'] AND user_name && ARRAY['all', 'engram_replication']
  ORDER BY rule_number LIMIT 1")" || restore_prev
if [ "$action" = apply ] && [ "$first" != 'engram_replication scram-sha-256' ]; then
  echo "engram-pitr-hba: SCRAM rule is not the first matching replication rule (got: ${first:-none})" >&2
  restore_prev
fi
if [ "$action" = rollback ] && [ "$first" = 'engram_replication scram-sha-256' ]; then
  echo "engram-pitr-hba: rule still first after rollback" >&2
  restore_prev
fi

[ "$(psql_c 'SELECT pg_reload_conf()')" = t ]
docker exec -u postgres "$CONTAINER" rm -f "$hba.engram-prev"
if [ "$action" = rollback ]; then
  psql_c 'DROP ROLE IF EXISTS engram_replication' >/dev/null
fi
echo "engram-pitr-hba: $action done; first matching local replication rule: ${first:-none}"
