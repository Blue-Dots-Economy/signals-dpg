#!/usr/bin/env bash
# Exact teardown for one e2e run. Three scopes, each covering the previous
# one's blind spot: the run's ledger of created primary keys, the run's tag on
# every identifier it minted, and a per-table row-count snapshot diffed against
# the pre-run one.
#
# NEVER a type-wide or network-wide DELETE — a stray `WHERE item_type = ...`
# or `WHERE item_network = ...` here would wipe a developer's own local data.
# Every statement below is bound to this run's ids (the ledger) or its tag
# (email/phone/slug LIKE '%RUN_ID%').
#
# Usage: cleanup.sh <run-id> [--snapshot-only|--verify-only]
set -uo pipefail

RUN_ID="${1:?usage: cleanup.sh <run-id> [--snapshot-only|--verify-only]}"
MODE="${2:-full}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$HERE/../../../../e2e" && pwd)"
SNAP_DIR="$E2E_DIR/run/$RUN_ID"
mkdir -p "$SNAP_DIR"

PG_CONTAINER="${PG_CONTAINER:-dpg-db}"
PGUSER="${PGUSER:-postgres}"
PGDB="${PGDB:-signals}"

# Every table this script knows about, in reverse-dependency order (children
# before the parents they reference) — mirrors e2e/src/ledger.ts's
# CLEANUP_TABLES exactly; keep the two lists in sync.
#
# `item_locations` and `session` are deliberately NOT here: neither is a real
# table. `item_locations` is a jsonb column on `items`
# (apps/api/db/postgres/schema.sql), and better-auth here stores sessions in
# Redis via `secondaryStorage` (packages/auth/src/config.ts) — confirmed by
# querying the live schema (`\dt` on the target container lists no `session`
# relation). Snapshotting or deleting either name would hit a table that
# doesn't exist, and `2>/dev/null` below would swallow that error silently —
# exactly the failure mode this script exists to prevent.
TABLES="action_events item_actions item_search item_metrics consent_record items account verification member organization user"

# Per-table identifying column for the ledger-replay delete (scope 1). Every
# entry was confirmed against the live schema (`information_schema` PK query
# + `\d <table>` on the shared dpg-db container), not assumed:
#
#   action_events    event_id          composite PK (partition_network,
#                                      action_type, event_id); event_id is a
#                                      gen_random_uuid() default, practically
#                                      unique on its own — same carve-out as
#                                      items/item_id below. Not ledgered by
#                                      any recordCreated() call yet (only
#                                      flows.ts/auth.ts ledger 'items'/'user'
#                                      so far), so this row is currently inert
#                                      infrastructure for a later task.
#   item_actions     action_id         composite PK (partition_network,
#                                      action_type, action_id); same
#                                      practically-unique-uuid carve-out. Also
#                                      not ledgered yet.
#   item_search      item_id           composite PK includes item_network/
#                                      item_domain/item_type/item_id; filtering
#                                      on item_id alone is the same accepted
#                                      carve-out as `items` (see below).
#   item_metrics     item_id           actual PRIMARY KEY (verified via
#                                      information_schema) — item_id alone,
#                                      not composite, unlike items/item_search.
#   consent_record   id                PRIMARY KEY, a gen_random_uuid().
#   items            item_id           NOT the PK column alone — items' real
#                                      PK is composite (item_network,
#                                      item_domain, item_type, item_id). item_id
#                                      is a uuid, unique in practice, so
#                                      filtering on it alone is safe — but it is
#                                      not "the primary key".
#   account          id                PRIMARY KEY.
#   verification     id                PRIMARY KEY.
#   member           id                PRIMARY KEY.
#   organization     id                PRIMARY KEY.
#   user             id                PRIMARY KEY.
pk_column_for() {
  case "$1" in
    action_events) echo event_id ;;
    item_actions) echo action_id ;;
    item_search|item_metrics|items) echo item_id ;;
    *) echo id ;;
  esac
}

psql_q() { docker exec -i "$PG_CONTAINER" psql -U "$PGUSER" -d "$PGDB" -tAc "$1"; }

snapshot() {
  : > "$SNAP_DIR/snapshot-$1.txt"
  for t in $TABLES; do
    n=$(psql_q "SELECT count(*) FROM \"$t\";" 2>/dev/null || echo NA)
    printf '%s %s\n' "$t" "$n" >> "$SNAP_DIR/snapshot-$1.txt"
  done
  echo "[cleanup] snapshot-$1 written to $SNAP_DIR/snapshot-$1.txt"
}

if [ "$MODE" = "--snapshot-only" ]; then snapshot before; exit 0; fi

if [ "$MODE" != "--verify-only" ]; then
  # Scope 1 — the ledger, deleted child-first so FKs never block a delete
  # (items.created_by -> user is ON DELETE RESTRICT: a user row cannot be
  # removed while it still owns an item, so items must go first).
  LEDGER="$SNAP_DIR/created.jsonl"
  if [ -f "$LEDGER" ]; then
    for t in $TABLES; do
      ids=$(node -e '
        const fs=require("fs");
        const t=process.argv[1];
        const ids=fs.readFileSync(process.argv[2],"utf8").split("\n")
          .filter(Boolean).flatMap(l=>{try{const r=JSON.parse(l);return r.table===t?[r.pk]:[]}catch{return[]}});
        process.stdout.write([...new Set(ids)].map(i=>`'"'"'${i}'"'"'`).join(","));
      ' "$t" "$LEDGER")
      [ -z "$ids" ] && continue
      pk="$(pk_column_for "$t")"
      psql_q "DELETE FROM \"$t\" WHERE $pk::text IN ($ids);" >/dev/null 2>&1
    done
    echo "[cleanup] ledger replayed"
  fi

  # Scope 2 — the run tag on minted identifiers. Bound to the tag, nothing
  # else. Runs AFTER the ledger replay above, so any item this run created but
  # never ledgered (a gap in today's coverage — see ledger.ts's CLEANUP_TABLES
  # comment) can still block this DELETE via the same RESTRICT FK; that
  # failure is swallowed here too, but scope 3 below will catch it as residue
  # on both `items` and `user` rather than reporting a false clean.
  psql_q "DELETE FROM \"user\" WHERE email LIKE '%${RUN_ID}%' OR phone_number LIKE '%${RUN_ID}%';" >/dev/null 2>&1
  psql_q "DELETE FROM organization WHERE slug LIKE '%${RUN_ID}%';" >/dev/null 2>&1
  echo "[cleanup] tag sweep done"

  # Redis: this run's caches and counters only. This clears the shared
  # 1-second item-fetch cache namespace, not persistent data — safe even
  # though it isn't scoped to this run specifically.
  REDIS_CONTAINER="${REDIS_CONTAINER:-dpg-redis}"
  if [ -n "${REDIS_PASSWORD:-}" ]; then
    docker exec "$REDIS_CONTAINER" redis-cli -a "$REDIS_PASSWORD" --no-auth-warning \
      EVAL "local n=0; for _,k in ipairs(redis.call('keys','item-*')) do redis.call('del',k); n=n+1 end; return n" 0 >/dev/null 2>&1
  fi
fi

# Scope 3 — residue. The only check that catches what we neither tagged nor
# ledgered. A non-zero delta is a REPORTED FAILURE, not a warning.
snapshot after
RESIDUE=0
while read -r t before; do
  after=$(awk -v k="$t" '$1==k{print $2}' "$SNAP_DIR/snapshot-after.txt")
  if [ "$before" != "NA" ] && [ "$after" != "NA" ] && [ "$after" -gt "$before" ] 2>/dev/null; then
    echo "[cleanup] RESIDUE $t: before=$before after=$after (+$((after-before)))"
    RESIDUE=$((RESIDUE+1))
  fi
done < "$SNAP_DIR/snapshot-before.txt"

if [ "$RESIDUE" -gt 0 ]; then
  echo "[cleanup] FAIL — $RESIDUE table(s) left rows behind"
  exit 1
fi
echo "[cleanup] clean — no residue"
