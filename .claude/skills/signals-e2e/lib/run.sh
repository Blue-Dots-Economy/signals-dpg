#!/usr/bin/env bash
# The one entry point for the signals-e2e skill.
#
#   bash lib/run.sh [dot] [alias]     — /signals-e2e [dot] [alias]
#   bash lib/run.sh cleanup <run-id>  — /signals-e2e cleanup [tag]
#
# dot defaults to blue_dot. alias, if given, must be one of the names in
# `print_alias_table` below (spec §6) — an unknown alias prints that table and
# exits 2 rather than silently running everything: a scoped run that quietly
# becomes a full one wastes half an hour, and a full run that quietly becomes
# scoped is worse, because it signs off on work it never touched.
#
# Runs under a real bash (this file is EXECUTED, `bash lib/run.sh ...`, never
# sourced) and is written for bash 3.2 (this host's /bin/bash) deliberately:
# no `declare -A` (macOS system bash has no associative arrays), and no
# `"${arr[@]}"` on an array that might be empty under `set -u` (bash 3.2 throws
# "unbound variable" for that — fixed only in bash 4.4+). Every branch below
# that used to be "build an args array" is a plain if/elif with a literal
# argument list instead.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"        # .../lib
SKILL_DIR="$(cd "$HERE/.." && pwd)"                          # .../signals-e2e
E2E_DIR="$(cd "$SKILL_DIR/../../../e2e" && pwd)"
# This worktree may not be the checkout actually running the stack — same
# SIGNALS_REPO indirection stack-up.sh/search-indexer.mjs use (see their own
# header comments): this is an e2e-only worktree with no root .env of its own.
SCRIPT_REPO="$(cd "$HERE/../../../.." && pwd)"
REPO="${SIGNALS_REPO:-$SCRIPT_REPO}"
STACK_ENV="$REPO/.env"

log() { echo "[signals-e2e] $*" >&2; }

# ---------------------------------------------------------------------------
# `cleanup <run-id>` — the standalone teardown-on-demand entry point. Reads
# the SAME Postgres creds stack-up.sh reads (never cleanup.sh's own generic
# defaults, which name a "signals" db this repo doesn't use), so a prior or
# orphaned run's residue can be cleared without re-deriving anything by hand.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "cleanup" ]; then
  TAG="${2:?usage: run.sh cleanup <run-id>}"
  read_env_var_or() {
    local key="$1" path="$2" fallback="$3" value
    value="$(node -e '
      const fs = require("fs");
      const [key, path] = process.argv.slice(1);
      let content;
      try { content = fs.readFileSync(path, "utf8"); } catch { process.exit(2); }
      const m = content.match(new RegExp("^" + key + "=(.*)$", "m"));
      if (!m) process.exit(3);
      const v = m[1].trim().replace(/^"(.*)"$/, "$1");
      if (!v) process.exit(3);
      process.stdout.write(v);
    ' "$key" "$path" 2>/dev/null)"
    [ -n "$value" ] && printf '%s' "$value" || printf '%s' "$fallback"
  }
  CLEAN_PGUSER="$(read_env_var_or POSTGRES_USER "$STACK_ENV" postgres)"
  CLEAN_PGDB="$(read_env_var_or POSTGRES_DB "$STACK_ENV" signals)"
  log "cleaning run '$TAG' (PGUSER=$CLEAN_PGUSER PGDB=$CLEAN_PGDB)"
  PGUSER="$CLEAN_PGUSER" PGDB="$CLEAN_PGDB" bash "$HERE/cleanup.sh" "$TAG"
  exit $?
fi

# ---------------------------------------------------------------------------
# 1. Parse <dot> [alias]
# ---------------------------------------------------------------------------
DOT="${1:-blue_dot}"
ALIAS="${2:-}"

# ---------------------------------------------------------------------------
# 2. Alias table (spec §6). Resolves to a suite id (report.mjs's `SUITES`
#    catalogue, or empty for a cross-cutting alias with no single suite
#    number) and a Playwright --grep pattern matched against the existing
#    journey titles. An alias not in this table is refused, never silently
#    treated as "run everything".
# ---------------------------------------------------------------------------
print_alias_table() {
  cat >&2 <<'EOF'
Known aliases (spec §6) — usage: run.sh [dot] [alias]

  alias                    suite  grep pattern
  --------------------------------------------------------------------
  auth, login                2   Journey A|Journey B|Authenticated UI
  consent, legal              3   Journey K
  profile, form, schema       4   Journey A|Journey P
  u18, guardian                5   U18
  browse, search              6   Journey H
  map                          7   Journey M   (no journey yet — Plan 2)
  actions, connect, apply      8   Journey D|Journey E|Journey F|Journey R
  match                        9   Match Score (no journey yet — Plan 2)
  lifecycle, retire           10   Journey O
  share, public                11   Shareable Profile (no journey yet — Plan 2)
  support                     12   Journey L
  aggregator, admin           13   Journey I|Journey J|Journey V
  peer                         14   Peer Instance (no journey yet — Plan 2)
  emails                        —   Mail Sweep (cross-cutting, no journey yet — Plan 2)
  tourist                     16   Tourist (no journey yet — Plan 2)
  (omit alias)                  —   full run — every spec in tests/

See .claude/skills/signals-e2e/SKILL.md and references/ for what each suite
actually asserts today versus what is parked for the follow-on coverage plan.
EOF
}

ALIAS_SUITE_ID=""
ALIAS_GREP=""
resolve_alias() {
  case "$1" in
    auth|login)            ALIAS_SUITE_ID=2;  ALIAS_GREP='Journey A|Journey B|Authenticated UI' ;;
    consent|legal)         ALIAS_SUITE_ID=3;  ALIAS_GREP='Journey K' ;;
    profile|form|schema)   ALIAS_SUITE_ID=4;  ALIAS_GREP='Journey A|Journey P' ;;
    u18|guardian)          ALIAS_SUITE_ID=5;  ALIAS_GREP='U18' ;;
    browse|search)         ALIAS_SUITE_ID=6;  ALIAS_GREP='Journey H' ;;
    map)                   ALIAS_SUITE_ID=7;  ALIAS_GREP='Journey M' ;;
    actions|connect|apply) ALIAS_SUITE_ID=8;  ALIAS_GREP='Journey D|Journey E|Journey F|Journey R' ;;
    match)                 ALIAS_SUITE_ID=9;  ALIAS_GREP='Match Score' ;;
    lifecycle|retire)      ALIAS_SUITE_ID=10; ALIAS_GREP='Journey O' ;;
    share|public)          ALIAS_SUITE_ID=11; ALIAS_GREP='Shareable Profile' ;;
    support)               ALIAS_SUITE_ID=12; ALIAS_GREP='Journey L' ;;
    aggregator|admin)      ALIAS_SUITE_ID=13; ALIAS_GREP='Journey I|Journey J|Journey V' ;;
    peer)                  ALIAS_SUITE_ID=14; ALIAS_GREP='Peer Instance' ;;
    emails)                ALIAS_SUITE_ID=""; ALIAS_GREP='Mail Sweep' ;;
    tourist)               ALIAS_SUITE_ID=16; ALIAS_GREP='Tourist' ;;
    *) return 1 ;;
  esac
  return 0
}

if [ -n "$ALIAS" ]; then
  if ! resolve_alias "$ALIAS"; then
    log "unknown alias '$ALIAS'."
    print_alias_table
    exit 2
  fi
fi

# ---------------------------------------------------------------------------
# 3. A fresh run id, every invocation. `newPhone()` (e2e/src/identities.ts)
#    derives its phone-number sequence from the run id, so reusing one across
#    invocations collides with the previous run's identities and produces
#    confusing "identity must be new" failures — never accepted as an
#    argument here, always generated.
# ---------------------------------------------------------------------------
RUN="run$(date +%s)$$"
RUN_DIR="$E2E_DIR/run/$RUN"
mkdir -p "$RUN_DIR"
ENV_FILE="$RUN_DIR/env.sh"

log "run id: $RUN  dot: $DOT  alias: ${ALIAS:-<full run>}  repo: $REPO"

# ---------------------------------------------------------------------------
# Teardown — installed BEFORE anything below can start a process or mutate the
# database, and trapped on EXIT so an interrupted run (Ctrl-C, a killed
# session) cleans up exactly like a finished one. `run_cleanup` is idempotent
# (guarded by CLEANUP_DONE) because the normal path also calls it explicitly,
# after the suite, so its residue count can feed the report — the trap is the
# safety net for every path that never reaches that point.
# ---------------------------------------------------------------------------
NOTIFY_PID=""
SEARCH_STUB_PID=""
INDEXER_PID=""
CLEANUP_DONE=false
RESIDUE_COUNT=0
CLEAN_PGUSER=""
CLEAN_PGDB=""

stop_stubs() {
  local pid
  for pid in "$NOTIFY_PID" "$SEARCH_STUB_PID" "$INDEXER_PID"; do
    if [ -n "$pid" ]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  wait >/dev/null 2>&1 || true
}

run_cleanup() {
  if [ "$CLEANUP_DONE" = true ]; then
    return 0
  fi
  CLEANUP_DONE=true
  if [ -z "$CLEAN_PGUSER" ] || [ -z "$CLEAN_PGDB" ]; then
    log "skipping final cleanup — Postgres creds were never resolved (failed before that step)"
    return 0
  fi
  local out="$RUN_DIR/cleanup-final.log"
  PGUSER="$CLEAN_PGUSER" PGDB="$CLEAN_PGDB" bash "$HERE/cleanup.sh" "$RUN" > "$out" 2>&1
  local code=$?
  cat "$out" >&2
  RESIDUE_COUNT="$(grep -c '^\[cleanup\] RESIDUE ' "$out" 2>/dev/null || true)"
  case "$RESIDUE_COUNT" in ''|*[!0-9]*) RESIDUE_COUNT=0 ;; esac
  return $code
}

teardown() {
  stop_stubs
  run_cleanup || true
}
trap teardown EXIT

# ---------------------------------------------------------------------------
# 4. Stack reuse: a live marker for the SAME dot skips stack-up.sh entirely.
#    Verified live (not just "the marker file exists") by re-probing the api
#    and ui urls it recorded. This run still gets its OWN E2E_RUN_ID (see the
#    run-id comment above) even though the underlying stack is reused.
# ---------------------------------------------------------------------------
find_live_marker() {
  local dot="$1" m api network ui code
  for m in $(ls -t "$E2E_DIR"/run/*/stack.marker 2>/dev/null); do
    [ -f "$m" ] || continue
    grep -q "^dot=${dot}\$" "$m" || continue
    api="$(awk -F= '/^api=/{print $2}' "$m")"
    network="$(awk -F= '/^network=/{print $2}' "$m")"
    ui="$(awk -F= '/^ui=/{print $2}' "$m")"
    [ -z "$api" ] && continue
    code="$(curl -s -o /dev/null -w '%{http_code}' "$api/api/v1/network/schemas?network=$network" 2>/dev/null)"
    [ "$code" = "200" ] || continue
    code="$(curl -s -o /dev/null -w '%{http_code}' "$ui/" 2>/dev/null)"
    [ "$code" = "200" ] || continue
    echo "$m"
    return 0
  done
  return 1
}

STACK_REUSED=false
MARKER_FOUND="$(find_live_marker "$DOT" || true)"
if [ -n "$MARKER_FOUND" ] && [ -f "$(dirname "$MARKER_FOUND")/env.sh" ]; then
  OLD_RUN_DIR="$(dirname "$MARKER_FOUND")"
  log "stack reuse detected — a live target already matches dot=$DOT (marker: $MARKER_FOUND, from run $(basename "$OLD_RUN_DIR")). Skipping stack-up.sh."
  cp "$OLD_RUN_DIR/env.sh" "$ENV_FILE"
  cp "$MARKER_FOUND" "$RUN_DIR/stack.marker"
  # Appended last so it wins when the file is sourced below — this run's own
  # id overrides whatever E2E_RUN_ID the reused stack's env.sh carried.
  printf "export E2E_RUN_ID='%s'\n" "$RUN" >> "$ENV_FILE"
  STACK_REUSED=true
else
  log "no live matching stack for dot=$DOT — running stack-up.sh"
  # EXECUTED under bash, never sourced (stack-up.sh's own header explains why:
  # BASH_SOURCE and a `local status` are bash-only, and the user's shell is
  # zsh). Its exit status is checked BEFORE the env file it wrote is sourced —
  # a mid-failure leaves a partially-populated env.sh alongside a non-zero
  # exit, and sourcing that as if it had succeeded would silently run the
  # suite against half-configured capabilities.
  if ! bash "$HERE/stack-up.sh" "$DOT" "$RUN"; then
    log "FAIL: stack-up.sh could not bring the target to a ready state (see its output above)."
    log "If the stack itself was never started at all, run the run-signals-dpg skill for dot=$DOT first, then retry."
    exit 1
  fi
fi

if [ ! -f "$ENV_FILE" ]; then
  log "FAIL: stack-up.sh reported success but left no env file at $ENV_FILE."
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
log "env loaded — E2E_RUN_ID=${E2E_RUN_ID:-} E2E_UI_BASE_URL=${E2E_UI_BASE_URL:-} E2E_API_BASE_URL=${E2E_API_BASE_URL:-}"

# ---------------------------------------------------------------------------
# 4b. Notification preflight (defect fix). The API's notification client
# (apps/api/src/utils/notificationClient.ts:14-18) returns undefined — logs
# the OTP, sends NOTHING — unless ALL THREE of NOTIFICATION_SERVICE_ENDPOINT,
# _KEY_ID and _SECRET are set on the TARGET (not this worktree). With only the
# endpoint set, `notificationStub` reads as enabled while every mail assertion
# silently passes against an empty inbox. The sink at :4545 ignores HMAC, so
# any non-empty key/secret works — this only asserts presence, never value.
# ---------------------------------------------------------------------------
assert_notification_env() {
  local missing="" key value
  for key in NOTIFICATION_SERVICE_ENDPOINT NOTIFICATION_SERVICE_KEY_ID NOTIFICATION_SERVICE_SECRET; do
    value="$(node -e '
      const fs = require("fs");
      const [key, path] = process.argv.slice(1);
      let content;
      try { content = fs.readFileSync(path, "utf8"); } catch { process.exit(2); }
      const m = content.match(new RegExp("^" + key + "=(.*)$", "m"));
      if (!m) process.exit(3);
      const v = m[1].trim().replace(/^"(.*)"$/, "$1");
      if (!v) process.exit(3);
      process.stdout.write(v);
    ' "$key" "$STACK_ENV" 2>/dev/null)"
    if [ -z "$value" ]; then
      missing="$missing $key"
    fi
  done
  if [ -n "$missing" ]; then
    log "FAIL: the notification client needs ALL THREE of NOTIFICATION_SERVICE_ENDPOINT,"
    log "  NOTIFICATION_SERVICE_KEY_ID and NOTIFICATION_SERVICE_SECRET — missing on $STACK_ENV:$missing"
    log "  With even one absent, the API logs the OTP and sends nothing: notificationStub would"
    log "  read as enabled while every mail assertion silently passes against an empty inbox."
    log "  Set all three (dummy key/secret are fine, the sink ignores HMAC), restart the API, retry."
    return 1
  fi
  log "notification preflight OK — endpoint/key/secret all present on $STACK_ENV"
  return 0
}

if ! assert_notification_env; then
  exit 1
fi

# ---------------------------------------------------------------------------
# 5. Start the three stubs, waiting for each to answer before continuing.
#    Always started fresh (not reused) and always torn down on EXIT — their
#    lifecycle belongs to this invocation, independent of whether the
#    underlying API/UI/DB stack was reused above.
# ---------------------------------------------------------------------------
free_port() {
  local port="$1" pid
  pid="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    log "port $port already in use (pid $pid) — a stray from an earlier run's failed teardown. Killing it."
    kill $pid >/dev/null 2>&1 || true
    sleep 1
  fi
}

wait_for() {
  local url="$1" name="$2" i
  for i in $(seq 1 30); do
    curl -sf "$url" >/dev/null 2>&1 && return 0
    sleep 1
  done
  log "FAIL: $name did not answer at $url within 30s — see $RUN_DIR/$name.log"
  return 1
}

free_port 4545
free_port 4546
free_port 4547

SINK_PORT=4545 node "$HERE/notify-sink.mjs" > "$RUN_DIR/notify-sink.log" 2>&1 &
NOTIFY_PID=$!
NODE_PATH="$E2E_DIR/node_modules" PGURL="$E2E_DB_URL" SEARCH_STUB_PORT=4546 \
  node "$HERE/search-stub.mjs" > "$RUN_DIR/search-stub.log" 2>&1 &
SEARCH_STUB_PID=$!
NODE_PATH="$E2E_DIR/node_modules" PGURL="$E2E_DB_URL" REDIS_CONTAINER="${REDIS_CONTAINER:-dpg-redis}" \
  SIGNALS_REPO="$REPO" INDEXER_PORT=4547 \
  node "$HERE/search-indexer.mjs" > "$RUN_DIR/search-indexer.log" 2>&1 &
INDEXER_PID=$!

if ! wait_for "http://localhost:4545/providers" "notify-sink"; then exit 1; fi
if ! wait_for "http://localhost:4546/_e2e/envelopes" "search-stub"; then exit 1; fi
if ! wait_for "http://localhost:4547/_e2e/stats" "search-indexer"; then exit 1; fi
log "three stubs live — notify-sink:4545 search-stub:4546 search-indexer:4547"

# ---------------------------------------------------------------------------
# 6. Snapshot before, so cleanup can prove "no residue" rather than merely
#    "the deletes ran". Needs the SAME Postgres creds stack-up.sh derived for
#    E2E_DB_URL — parsed back out of it rather than re-read from .env a second
#    time, so there is exactly one place that can disagree with itself.
# ---------------------------------------------------------------------------
if [[ "$E2E_DB_URL" =~ ^postgres://([^:]+):([^@]*)@[^/:]+:[0-9]+/(.+)$ ]]; then
  CLEAN_PGUSER="${BASH_REMATCH[1]}"
  CLEAN_PGDB="${BASH_REMATCH[3]}"
else
  log "FAIL: could not parse E2E_DB_URL to derive Postgres creds for cleanup.sh."
  exit 1
fi

PGUSER="$CLEAN_PGUSER" PGDB="$CLEAN_PGDB" bash "$HERE/cleanup.sh" "$RUN" --snapshot-only

# ---------------------------------------------------------------------------
# 7. Run the suite: API tier (deterministic, no browser), then UI tier
#    (headed, so the run is watchable). Both run even if the first has
#    failures — a failing api spec must not hide the ui tier's own results —
#    and each tier's own `test-results/results.json` is copied out before the
#    next tier's Playwright invocation overwrites the same path.
# ---------------------------------------------------------------------------
cd "$E2E_DIR"
export E2E_ENV="${E2E_ENV:-local}"

rm -f test-results/results.json
if [ -n "$ALIAS_GREP" ]; then
  npm run e2e:api -- --grep "$ALIAS_GREP"
else
  npm run e2e:api
fi
API_CODE=$?
if [ -f test-results/results.json ]; then
  cp test-results/results.json "$RUN_DIR/results-api.json"
else
  echo '{"suites":[]}' > "$RUN_DIR/results-api.json"
fi
log "API tier exit code: $API_CODE"

rm -f test-results/results.json
if [ -n "$ALIAS_GREP" ]; then
  npm run e2e:ui -- --headed --grep "$ALIAS_GREP"
else
  npm run e2e:ui -- --headed
fi
UI_CODE=$?
if [ -f test-results/results.json ]; then
  cp test-results/results.json "$RUN_DIR/results-ui.json"
else
  echo '{"suites":[]}' > "$RUN_DIR/results-ui.json"
fi
log "UI tier exit code: $UI_CODE"

node -e '
  const fs = require("fs");
  const readSuites = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).suites || []; } catch { return []; } };
  const merged = { suites: [...readSuites(process.argv[1]), ...readSuites(process.argv[2])] };
  fs.writeFileSync(process.argv[3], JSON.stringify(merged));
' "$RUN_DIR/results-api.json" "$RUN_DIR/results-ui.json" "$RUN_DIR/results-merged.json"

# ---------------------------------------------------------------------------
# 8a. Final cleanup — explicit (not just the EXIT trap), so its residue count
#     is known before the report is built. Sets CLEANUP_DONE, so the trap's
#     own call to run_cleanup at step 9's `exit` is a no-op.
# ---------------------------------------------------------------------------
run_cleanup
CLEANUP_CODE=$?
if [ "$CLEANUP_CODE" -eq 0 ]; then
  log "cleanup: clean — no residue"
else
  log "cleanup: FAIL — residue in $RESIDUE_COUNT table(s), see $RUN_DIR/cleanup-final.log"
fi

# ---------------------------------------------------------------------------
# 8b. Coverage drift (spec §9) — whatever `npm run coverage` finds unmapped,
#     flattened into the plain string lines report.mjs's section 5 expects.
#     Not gated on its own exit code; a drifted coverage check still has to
#     surface in the SAME signoff, not abort it before section 2 is known.
# ---------------------------------------------------------------------------
node scripts/check-coverage.mjs --json > "$RUN_DIR/coverage.json" 2>"$RUN_DIR/coverage.err.log" || true
node -e '
  const fs = require("fs");
  let data;
  try { data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { data = {}; }
  const lines = [];
  for (const r of data.unmapped || []) lines.push(`route ${r}`);
  for (const [k, v] of Object.entries(data.features || {})) {
    for (const u of (v && v.unmapped) || []) lines.push(`${k} ${u}`);
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(lines));
' "$RUN_DIR/coverage.json" "$RUN_DIR/coverage-drift.json"

# ---------------------------------------------------------------------------
# 9. The five-section report. Exit with ITS code — non-zero iff section 2
#    (Not working) is non-empty, per report.mjs's contract.
# ---------------------------------------------------------------------------
REPORT_MD="$RUN_DIR/report.md"
if [ -n "$ALIAS" ]; then
  node "$SKILL_DIR/lib/report.mjs" \
    --results "$RUN_DIR/results-merged.json" \
    --residue "$RESIDUE_COUNT" \
    --coverage-drift "$RUN_DIR/coverage-drift.json" \
    --scoped-alias "$ALIAS" \
    --scoped-suites "$ALIAS_SUITE_ID" \
    | tee "$REPORT_MD"
else
  node "$SKILL_DIR/lib/report.mjs" \
    --results "$RUN_DIR/results-merged.json" \
    --residue "$RESIDUE_COUNT" \
    --coverage-drift "$RUN_DIR/coverage-drift.json" \
    | tee "$REPORT_MD"
fi
REPORT_CODE="${PIPESTATUS[0]}"

log "report written to $REPORT_MD — exit code $REPORT_CODE"
exit "$REPORT_CODE"
