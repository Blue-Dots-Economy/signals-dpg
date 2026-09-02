#!/usr/bin/env bash
# Exact teardown for one e2e run. Three scopes, each covering the previous
# one's blind spot: the run's ledger of created primary keys, the run's tag on
# every identifier it minted, and a per-table row-count snapshot diffed against
# the pre-run one.
#
# NEVER a type-wide or network-wide DELETE — a stray `WHERE item_type = ...`
# or `WHERE item_network = ...` here would wipe a developer's own local data.
# Every statement below is bound to this run's ids (the ledger) or its tag
# (email/phone/slug carrying this run's identifier).
#
# Usage: cleanup.sh <run-id> [--snapshot-only|--verify-only]
set -uo pipefail

RUN_ID="${1:?usage: cleanup.sh <run-id> [--snapshot-only|--verify-only]}"
MODE="${2:-full}"

# A short run id turns the tag sweep below into a wildcard: the email leg is
# still a bare substring match (`%${RUN_ID}%`, needed because RUN_ID itself
# never appears literally in a phone number — see the RUN_DIGITS derivation
# below), so a value like "e2e" or "529" would match any row whose email
# happens to contain that substring anywhere, tagged test data or not.
# identities.ts:11 documents E2E_RUN_ID as user-settable, so this can't be
# assumed away — enforced here, once, before anything else (including the
# `mkdir -p` below, so a rejected id leaves no artifact at all), for every
# mode (snapshot/verify/full), rather than trusting every caller to have
# picked a safe value.
MIN_RUN_ID_LEN=6
if [ "${#RUN_ID}" -lt "$MIN_RUN_ID_LEN" ]; then
  echo "[cleanup] FAIL — run id '$RUN_ID' is only ${#RUN_ID} char(s); refusing anything under" \
    "$MIN_RUN_ID_LEN. The email leg of the tag sweep is a bare substring match (LIKE '%\${RUN_ID}%')" \
    "— a short id turns it into a wildcard over every row in the table, which is exactly the" \
    "data-loss shape this file exists to prevent. run.sh's generated ids are always well over this;" \
    "only a hand-typed 'cleanup <tag>' invocation can hit this." >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$HERE/../../../../e2e" && pwd)"
SNAP_DIR="$E2E_DIR/run/$RUN_ID"
mkdir -p "$SNAP_DIR"

# Same SIGNALS_REPO indirection run.sh/stack-up.sh use (this worktree has no
# root .env of its own) — needed below to read REDIS_PASSWORD the way
# search-indexer.mjs does, instead of relying on a var nothing ever exports.
SCRIPT_REPO="$(cd "$HERE/../../../.." && pwd)"
REPO="${SIGNALS_REPO:-$SCRIPT_REPO}"
STACK_ENV="$REPO/.env"

# Mutual exclusion per run id. Two cleanup.sh invocations racing on the SAME
# run id (e.g. `/signals-e2e cleanup <tag>` run by hand while that run's own
# EXIT-trap teardown is also in flight) both call `snapshot after`, which
# truncates then re-appends every table's line to the SAME
# snapshot-after.txt — reproduced live: the file ends up with every table
# listed TWICE, so the residue loop's `awk` lookup below returns a two-line
# value like "48\n48" for `$after` instead of "48". That fails the
# `^[0-9]+$` check, which renders as a garbled, line-wrapped
# "not a readable count ... 48\n48'); cannot verify cleanup." message AND
# reports a FALSE "N table(s) left rows behind" — the underlying DELETEs
# succeeded fine; only the snapshot FILE was corrupted by the race. `mkdir`
# is atomic on any POSIX filesystem and needs no extra dependency (macOS has
# no `flock`), so it is the lock primitive here.
LOCK_DIR="$SNAP_DIR/.lock"
LOCK_HELD=false
release_lock() {
  [ "$LOCK_HELD" = true ] && rmdir "$LOCK_DIR" 2>/dev/null
  return 0
}
trap release_lock EXIT
LOCK_TRIES=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  LOCK_TRIES=$((LOCK_TRIES + 1))
  if [ "$LOCK_TRIES" -ge 30 ]; then
    echo "[cleanup] FAIL — could not acquire the lock for run '$RUN_ID' after 30s ($LOCK_DIR)." \
      "Another cleanup.sh is already running against this exact run id, or a stale lock survived" \
      "one that was killed (SIGKILL bypasses the release trap) — remove $LOCK_DIR by hand only" \
      "once you are sure nothing else is cleaning up this run." >&2
    exit 1
  fi
  sleep 1
done
LOCK_HELD=true

PG_CONTAINER="${PG_CONTAINER:-dpg-db}"
PGUSER="${PGUSER:-postgres}"
PGDB="${PGDB:-signals}"

# The table list is DERIVED from e2e/src/ledger.ts's CLEANUP_TABLES rather
# than hand-copied here a second time — two independently maintained lists
# is exactly the kind of drift that lets an untested table name slip in
# unnoticed (a prior version of this script kept a parallel hardcoded string
# "in sync" with a comment; nothing enforced that). ledger.ts has no
# runtime dependency of its own beyond identities.ts (also plain TS, no
# relative-.js-specifier resolution problem — see ledger.ts's import comment),
# so importing it here directly is safe and side-effect-free.
#
# `item_locations` and `session` are deliberately NOT in CLEANUP_TABLES:
# neither is a real table. `item_locations` is a jsonb column on `items`
# (apps/api/db/postgres/schema.sql), and better-auth here stores sessions in
# Redis via `secondaryStorage` (packages/auth/src/config.ts) — confirmed by
# querying the live schema (`\dt` on the target container lists no `session`
# relation). Snapshotting or deleting either name would hit a table that
# doesn't exist, and `2>/dev/null` below would swallow that error silently —
# exactly the failure mode this script exists to prevent.
TABLES="$(node --experimental-strip-types -e '
  (async () => {
    const { CLEANUP_TABLES } = await import(process.argv[1]);
    process.stdout.write(CLEANUP_TABLES.join(" "));
  })();
' "$E2E_DIR/src/ledger.ts" 2>/dev/null)"
if [ -z "$TABLES" ]; then
  echo "[cleanup] FAIL — could not read CLEANUP_TABLES from $E2E_DIR/src/ledger.ts (node import failed). Refusing to run with an empty/unknown table list." >&2
  exit 1
fi

# Per-table identifying column for the ledger-replay delete (scope 1). Every
# entry was confirmed against the live schema (`information_schema` PK query
# + `\d <table>` on the shared dpg-db container), not assumed:
#
#   action_events    event_id          composite PK (partition_network,
#                                      action_type, event_id); event_id is a
#                                      gen_random_uuid() default, practically
#                                      unique on its own — same carve-out as
#                                      items/item_id below. Nothing ledgers
#                                      this row via recordCreated() (only
#                                      flows.ts/auth.ts ledger 'items'/'user'),
#                                      so this pk column is inert for scope 1 —
#                                      L6's owner-column delete in scope 2
#                                      (source_item_owner/target_item_owner)
#                                      is what actually clears these rows.
#   item_actions     action_id         composite PK (partition_network,
#                                      action_type, action_id); same
#                                      practically-unique-uuid carve-out. Also
#                                      not ledgered — same L6 owner-column
#                                      delete covers it too (in addition to
#                                      whatever the items delete cascades).
#   item_search      item_id           composite PK includes item_network/
#                                      item_domain/item_type/item_id; filtering
#                                      on item_id alone is the same accepted
#                                      carve-out as `items` (see below).
#   item_metrics     item_id           actual PRIMARY KEY (verified via
#                                      information_schema) — item_id alone,
#                                      not composite, unlike items/item_search.
#   consent_record   id                PRIMARY KEY, a gen_random_uuid(). Has
#                                      NO FK to items/user at all
#                                      (apps/api/db/postgres/schema/consent_record.ts:
#                                      "app-level integrity only") and no name
#                                      to tag, so it is unreachable by its own
#                                      id via the ledger (nothing ledgers
#                                      'consent_record') or by the tag sweep.
#                                      Handled as a special case below instead:
#                                      deleted by this run's ledgered user_id/
#                                      item_id, not its own pk.
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

# Every ledgered pk for one table, as a comma-separated, single-quoted list
# ready to drop into `... IN (...)`. Empty string when the ledger has no rows
# for that table (or doesn't exist yet).
ledger_ids_for() {
  local table="$1" ledger_file="$2"
  [ -f "$ledger_file" ] || return 0
  node -e '
    const fs=require("fs");
    const t=process.argv[1];
    const ids=fs.readFileSync(process.argv[2],"utf8").split("\n")
      .filter(Boolean).flatMap(l=>{try{const r=JSON.parse(l);return r.table===t?[r.pk]:[]}catch{return[]}});
    process.stdout.write([...new Set(ids)].map(i=>`'"'"'${i}'"'"'`).join(","));
  ' "$table" "$ledger_file"
}

# Fails loudly (non-zero exit, naming the target) instead of writing a
# snapshot full of "count unreadable" placeholders — a target that can't be
# queried is a hard failure, not a clean database. Reproduced case: pointing
# PG_CONTAINER at a nonexistent container previously made every count read
# "NA", which the comparison loop then silently skipped, reporting "clean —
# no residue" against a target cleanup never actually reached.
snapshot() {
  local label="$1"
  : > "$SNAP_DIR/snapshot-$label.txt"
  for t in $TABLES; do
    local n
    n="$(psql_q "SELECT count(*) FROM \"$t\";" 2>/dev/null)"
    if ! [[ "$n" =~ ^[0-9]+$ ]]; then
      echo "[cleanup] FAIL — could not read a row count for \"$t\" from postgres" \
        "(PG_CONTAINER=$PG_CONTAINER PGUSER=$PGUSER PGDB=$PGDB)." \
        "The target is unreachable, misconfigured, or the table is missing —" \
        "treating this as a hard failure rather than a false 'clean'." >&2
      exit 1
    fi
    printf '%s %s\n' "$t" "$n" >> "$SNAP_DIR/snapshot-$label.txt"
  done
  echo "[cleanup] snapshot-$label written to $SNAP_DIR/snapshot-$label.txt"
}

if [ "$MODE" = "--snapshot-only" ]; then snapshot before; exit 0; fi

if [ "$MODE" != "--verify-only" ]; then
  # L6 pre-clean — MUST run before anything below deletes a `user` row.
  #
  # Phone match: identities.ts's newPhone() does NOT embed RUN_ID (which is
  # hex, e.g. "3f9a2b7c") — it embeds RUN_DIGITS, a 5-digit hash OF RUN_ID
  # (e.g. "91767"). Matching on RUN_ID here would never match a single
  # phone-channel persona. RUN_DIGITS is derived by importing identities.ts
  # directly (same reasoning as CLEANUP_TABLES above: one hand-rolled copy of
  # that hash already drifted from the real formula once; a second copy here
  # would just be the same bug again) with E2E_RUN_ID pinned to this run's id
  # so the derivation matches exactly what the run itself used.
  RUN_DIGITS="$(E2E_RUN_ID="$RUN_ID" node --experimental-strip-types -e '
    (async () => {
      const { RUN_DIGITS } = await import(process.argv[1]);
      process.stdout.write(RUN_DIGITS);
    })();
  ' "$E2E_DIR/src/identities.ts" 2>/dev/null)"
  if [ -z "$RUN_DIGITS" ]; then
    echo "[cleanup] FAIL — could not derive RUN_DIGITS from identities.ts for run '$RUN_ID'." >&2
    exit 1
  fi
  # Email leg anchored to the suite's own namespace (identities.ts's
  # newEmail(): `e2e+<label>.<run-id-and-counter>@signals-e2e.test`), not a
  # bare substring — `%${RUN_ID}%` alone would match any row whose email
  # happens to contain that text anywhere, tagged test data or not.
  #
  # Phone leg anchored to newPhone()'s exact shape (`+919` + 5 run digits +
  # 4 sequence digits), not a substring either. Measured live against this
  # DB: 17 phone-bearing users hold 58 distinct 5-digit windows, so a bare
  # `LIKE '%${RUN_DIGITS}%'` would match roughly 0.06% of run ids against a
  # REAL local account — reproduced: RUN_DIGITS='30105' matched
  # +919930105100 (a real seeded user) under the old predicate and zero rows
  # under this one. Four underscores = the 4 sequence digits, each an exact
  # single-character wildcard, never a multi-char one.
  USER_TAG_WHERE="(email LIKE 'e2e+%' AND email LIKE '%${RUN_ID}%' AND email LIKE '%@signals-e2e.test') OR phone_number LIKE '+919${RUN_DIGITS}____'"
  # Reused by every subquery below instead of re-typing `"user" WHERE ...` —
  # one place to keep in sync with USER_TAG_WHERE, and `::text` on `id` guards
  # against a type mismatch against the TEXT owner/created_by columns below
  # regardless of whatever type better-auth's own migration gave `user.id`.
  TAGGED_USER_IDS="SELECT id::text FROM \"user\" WHERE ${USER_TAG_WHERE}"

  # L6: items.created_by -> user is ON DELETE RESTRICT, so a DELETE FROM
  # "user" fails for any tagged user who still owns an item — and that
  # failure is swallowed (`2>/dev/null`) wherever it's issued below. Confirmed
  # live: 65 users survived a run, and deleted fine once their items were
  # removed. recordCreated('items', ...) doesn't reach every item-creating
  # call site in the spec suite (a spec that POSTs /item/create directly,
  # bypassing flows.ts, ledgers nothing), so scope 1's ledger replay below
  # can't be relied on to have already cleared them. Rather than chase down
  # every such call site — a list that only grows and silently breaks again
  # the next time someone forgets it — delete a tagged user's items HERE,
  # bounded to `created_by IN (this run's own tagged users)`. That subquery is
  # still just the run's tag, never item_type/item_network, so it can't reach
  # anyone else's data.
  #
  # item_actions / action_events are handled the same way rather than relying
  # on the items delete above to cascade them: item_actions only cascades from
  # items on the TARGET side (item_actions_target_item_fk), so an action where
  # this run's item was the SOURCE would survive; action_events has no FK to
  # items at all (create_actions_events.sql) and nothing ledgers its rows (see
  # ledger.ts), so it would otherwise be permanent, never-cleaned residue on
  # every run that exercises journey D/E/R. Both tables carry the owning
  # user's id in `source_item_owner`/`target_item_owner` (TEXT), so they can be
  # bound to the same tagged-user subquery directly, independent of the items
  # delete's cascade behaviour.
  #
  # THE ORDERING REASON THIS WHOLE BLOCK IS UP HERE, AHEAD OF SCOPE 1: it has
  # to run while `TAGGED_USER_IDS`' subquery can still see every user this run
  # created. flows.ts/auth.ts DO ledger 'user' (and usually 'items') for the
  # common creation path, so scope 1's ledger replay below deletes most of
  # this run's own users by id — if this block ran AFTER that replay, its
  # subquery would find none of those already-gone users and miss every
  # action/item row they owned, which is exactly the residue this was meant
  # to close (reproduced live: a retire test's action_events survived cleanup
  # this way before this block was moved here).
  psql_q "DELETE FROM item_actions WHERE source_item_owner IN ($TAGGED_USER_IDS) OR target_item_owner IN ($TAGGED_USER_IDS);" >/dev/null 2>&1
  psql_q "DELETE FROM action_events WHERE source_item_owner IN ($TAGGED_USER_IDS) OR target_item_owner IN ($TAGGED_USER_IDS);" >/dev/null 2>&1
  # item_search is DERIVED from items (search-indexer.mjs / signals-search's own
  # sweep maintain it off the SAME items the run created) and is never itself
  # ledgered (nothing calls recordCreated('item_search', ...) — see
  # pk_column_for's comment above) and carries no owner column of its own to
  # tag. So a run with the indexer live left it as permanent residue: `items`
  # went away below while its derived `item_search` row did not, which trained
  # a reader to treat `RESIDUE item_search: +N` as a known-reason FAIL instead
  # of the one signal that must never be ignored. MUST run BEFORE the `items`
  # delete on the next line — the subquery has to see the row while it still
  # exists. Bound to the exact item_ids this run's tagged users created, never
  # item_type/item_network.
  psql_q "DELETE FROM item_search WHERE item_id IN (SELECT item_id FROM items WHERE created_by IN ($TAGGED_USER_IDS));" >/dev/null 2>&1
  psql_q "DELETE FROM items WHERE created_by IN ($TAGGED_USER_IDS);" >/dev/null 2>&1
  echo "[cleanup] L6 pre-clean done"

  # Scope 1 — the ledger, deleted child-first so FKs never block a delete
  # (items.created_by -> user is ON DELETE RESTRICT: a user row cannot be
  # removed while it still owns an item, so items must go first). Mostly
  # redundant with the L6 pre-clean above for 'items'/'user' now, but still
  # the only thing that reaches consent_record and anything else this run
  # ledgered by id rather than by owner/tag.
  LEDGER="$SNAP_DIR/created.jsonl"
  if [ -f "$LEDGER" ]; then
    for t in $TABLES; do
      if [ "$t" = "consent_record" ]; then
        # consent_record has no FK to items/user and nothing ledgers its own
        # id (see pk_column_for's comment) — the only way to reach a row this
        # run created is by the user_id/item_id it was recorded against, both
        # of which we DID ledger. Still strictly bound to this run's ids, not
        # a type/network-wide delete.
        user_ids="$(ledger_ids_for user "$LEDGER")"
        item_ids="$(ledger_ids_for items "$LEDGER")"
        where=""
        [ -n "$user_ids" ] && where="user_id::text IN ($user_ids)"
        if [ -n "$item_ids" ]; then
          [ -n "$where" ] && where="$where OR "
          where="${where}item_id::text IN ($item_ids)"
        fi
        [ -n "$where" ] && psql_q "DELETE FROM consent_record WHERE $where;" >/dev/null 2>&1
        continue
      fi
      ids="$(ledger_ids_for "$t" "$LEDGER")"
      [ -z "$ids" ] && continue
      pk="$(pk_column_for "$t")"
      psql_q "DELETE FROM \"$t\" WHERE $pk::text IN ($ids);" >/dev/null 2>&1
    done
    echo "[cleanup] ledger replayed"
  fi

  # Scope 2 — the run tag on minted identifiers. Bound to the tag, nothing
  # else. The items/item_actions/action_events legs of this used to live here
  # too; they moved above the ledger replay for the ordering reason explained
  # there. What's left is just the identity rows the tag itself names.
  psql_q "DELETE FROM \"user\" WHERE ${USER_TAG_WHERE};" >/dev/null 2>&1
  psql_q "DELETE FROM organization WHERE slug LIKE '%${RUN_ID}%';" >/dev/null 2>&1
  echo "[cleanup] tag sweep done"

  # Redis: EVAL 'keys(item-*)' matches `item-count:<network>:<domain>:*` and
  # `item-page:<network>:<domain>:*` — the inter-instance merge cache written
  # by apps/api/src/utils/inter_instance_fetch.ts, whose TTL is each network's
  # `minimum_cache_ttl_seconds` config (often well over 1s), NOT the 1-second
  # `local-item-fetch:*` own-item cache (item_fetch_cache.ts) that a comment
  # here previously (and wrongly) described. This clears that merge cache
  # process-wide, for every network/domain, not just this run's — acceptable
  # because it's a cache (repopulated on next read), not persistent data, but
  # it is not scoped to this run the way every SQL statement above is.
  # REDIS_PASSWORD is never exported by run.sh (the only references were this
  # gate and search-indexer.mjs:87) — read it from the target's own .env, the
  # same way search-indexer.mjs:63-74 already does, instead of a var nothing
  # ever sets. A silently-skipped cleanup branch (the previous `[ -n ... ]`
  # gate on a var that's always empty) is the exact failure class this file
  # exists to prevent, so a clear that's actually attempted must fail loud,
  # not swallow its own error the way every scoped DELETE above safely can.
  REDIS_CONTAINER="${REDIS_CONTAINER:-dpg-redis}"
  REDIS_PW="${REDIS_PASSWORD:-}"
  if [ -z "$REDIS_PW" ]; then
    REDIS_PW="$(node -e '
      const fs = require("fs");
      const [path] = process.argv.slice(1);
      let content;
      try { content = fs.readFileSync(path, "utf8"); } catch { process.exit(2); }
      const m = content.match(/^REDIS_PASSWORD=(.*)$/m);
      if (!m) process.exit(3);
      const v = m[1].trim().replace(/^"(.*)"$/, "$1");
      if (!v) process.exit(3);
      process.stdout.write(v);
    ' "$STACK_ENV" 2>/dev/null)"
  fi
  if [ -z "$REDIS_PW" ]; then
    echo "[cleanup] FAIL — REDIS_PASSWORD not set (env) and not found in $STACK_ENV;" \
      "cannot clear the inter-instance merge cache on $REDIS_CONTAINER. Set it in that .env or" \
      "export REDIS_PASSWORD before retrying — skipping this silently is what let it go dead." >&2
    exit 1
  fi
  if ! docker exec "$REDIS_CONTAINER" redis-cli -a "$REDIS_PW" --no-auth-warning \
      EVAL "local n=0; for _,k in ipairs(redis.call('keys','item-*')) do redis.call('del',k); n=n+1 end; return n" 0 >/dev/null 2>&1; then
    echo "[cleanup] FAIL — could not clear the item-* merge cache on $REDIS_CONTAINER (redis-cli EVAL errored)." >&2
    exit 1
  fi
fi

# Scope 3 — residue. The only check that catches what we neither tagged nor
# ledgered. A non-zero delta is a REPORTED FAILURE, not a warning — but only
# when there IS a baseline to diff against, and only in `--verify-only` mode
# is a missing baseline itself the failure.
#
# In full mode the ledger replay + tag sweep above already ran regardless of
# whether a baseline exists (nothing above is gated on snapshot-before.txt) —
# this section used to throw that work away by exiting 1 anyway, which made a
# killed or ad-hoc run (no preceding --snapshot-only) impossible to clean up
# at all. That's precisely the case `/signals-e2e cleanup [tag]` and the
# preflight orphan sweep exist to serve (spec §5): there IS no pre-run
# baseline for an orphan from a run that's already over. So full mode now
# skips the residue check with a clear warning instead of failing — the
# deletes still ran and still succeeded; there's just nothing to prove no
# OTHER residue was left. `--verify-only` does no deletes of its own, so for
# that mode a missing baseline is still a hard failure: there's nothing else
# it could report.
snapshot after

if [ ! -f "$SNAP_DIR/snapshot-before.txt" ]; then
  if [ "$MODE" = "--verify-only" ]; then
    echo "[cleanup] FAIL — no snapshot-before.txt for run '$RUN_ID' in $SNAP_DIR." \
      "Run 'cleanup.sh $RUN_ID --snapshot-only' before the suite starts; there is" \
      "nothing to diff against otherwise." >&2
    exit 1
  fi
  echo "[cleanup] WARNING — no snapshot-before.txt for run '$RUN_ID' in $SNAP_DIR;" \
    "skipping the residue check. The ledger replay and tag sweep above still ran," \
    "so this run's own rows are gone — there is just no pre-run baseline to prove" \
    "no OTHER residue was left. Treat this as 'deletes ran', not as a verified-clean run." >&2
  exit 0
fi

RESIDUE=0
while read -r t before; do
  after=$(awk -v k="$t" '$1==k{print $2}' "$SNAP_DIR/snapshot-after.txt")
  if ! [[ "$before" =~ ^[0-9]+$ ]] || ! [[ "$after" =~ ^[0-9]+$ ]]; then
    echo "[cleanup] FAIL — snapshot for \"$t\" is not a readable count (before='$before' after='$after'); cannot verify cleanup."
    RESIDUE=$((RESIDUE+1))
    continue
  fi
  if [ "$after" -gt "$before" ]; then
    echo "[cleanup] RESIDUE $t: before=$before after=$after (+$((after-before)))"
    RESIDUE=$((RESIDUE+1))
  fi
done < "$SNAP_DIR/snapshot-before.txt"

if [ "$RESIDUE" -gt 0 ]; then
  echo "[cleanup] FAIL — $RESIDUE table(s) left rows behind"
  exit 1
fi
echo "[cleanup] clean — no residue"
