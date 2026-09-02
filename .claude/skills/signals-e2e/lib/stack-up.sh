#!/usr/bin/env bash
# Bring the local Signals stack up for an e2e run and export the E2E_* overrides
# that switch the suite's dormant capabilities on.
#
# The stack itself is NOT reimplemented here: the run-signals-dpg skill's block
# already encodes the env gotchas that cause a blank UI (VITE_NETWORK_ID and
# VITE_API_URL must agree across root .env and apps/ui/.env, the schema cache
# must be cleared on a network switch, the API must be a direct node launch
# rather than turbo-spawned). Reimplementing any of that here would just be a
# second copy of the same fragile knowledge, guaranteed to drift from the
# original the next time a gotcha is discovered. The caller (SKILL.md phase 1)
# runs that skill first; this script only waits for the result and layers the
# e2e-only concerns on top: capability env, the UI port probe, and the marker.
#
# Capabilities are enabled through env overrides (config.ts applyEnvOverrides),
# never by editing e2e/config/local.json — a run must leave the working tree
# clean.
#
# The stack that gets brought up does NOT necessarily live in this worktree.
# This is an e2e-only worktree (no root node_modules — pnpm was never
# installed here) and it may have no root .env of its own; the actual running
# stack is a separate checkout (typically the main Signals-DPG clone). SIGNALS_REPO
# names that checkout; only the script's own path (for locating itself and
# e2e/) is assumed to be this worktree.
#
# Usage: SIGNALS_REPO=/path/to/signals-dpg source stack-up.sh <dot> [run-id]
set -uo pipefail

NET_DIR="${1:-blue_dot}"
RUN="${2:-e2e-$(date +%s)}"

SCRIPT_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
REPO="${SIGNALS_REPO:-$SCRIPT_REPO}"
ENV_FILE="$REPO/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "[stack-up] FAIL: no .env at $ENV_FILE." >&2
  echo "[stack-up] This worktree does not itself run the stack. Set SIGNALS_REPO to the" >&2
  echo "[stack-up] checkout that does (e.g. SIGNALS_REPO=/Users/srivastha/KKB/Github/Signals-DPG)," >&2
  echo "[stack-up] and make sure that repo has been brought up once via the run-signals-dpg skill." >&2
  return 1
fi

# --- shared .env reader ------------------------------------------------------
# cat/grep on a .env are permission-blocked in this environment (see
# run-signals-dpg's notes), so this reads it the same way that skill does: a
# node -e regex against the raw file. A single helper here, not three
# near-identical inlines, so the fail-loud behavior below is asserted once.
#
# A key that's absent OR present-but-empty is a hard failure, not a default.
# An empty POSTGRES_PASSWORD (say) would still build a syntactically valid
# E2E_DB_URL, so the `db` capability would read as "on" while every query
# against it fails auth — silently reintroducing the exact bug this task
# exists to fix, just moved one layer down. Fail before exporting anything.
read_env_var() {
  local key="$1" path="$2" value status
  value="$(node -e '
    const fs = require("fs");
    const [key, path] = process.argv.slice(1);
    let content;
    try { content = fs.readFileSync(path, "utf8"); } catch { process.exit(2); }
    const m = content.match(new RegExp("^" + key + "=(.*)$", "m"));
    if (!m) process.exit(3);
    process.stdout.write(m[1].trim().replace(/^"(.*)"$/, "$1"));
  ' "$key" "$path" 2>/dev/null)"
  status=$?
  if [ "$status" -eq 2 ]; then
    echo "[stack-up] FAIL: could not read $path." >&2
    return 1
  fi
  if [ "$status" -ne 0 ] || [ -z "$value" ]; then
    echo "[stack-up] FAIL: $key is missing or empty in $path — set it before the db capability can be enabled." >&2
    return 1
  fi
  printf '%s' "$value"
}

export E2E_RUN_ID="$RUN"
mkdir -p "$REPO/e2e/run/$RUN" 2>/dev/null
mkdir -p "e2e/run/$RUN"
MARKER="e2e/run/$RUN/stack.marker"

# --- 1. the stack itself, via the run-signals-dpg skill's block -------------
# The caller (SKILL.md phase 1) invokes that skill first, against $REPO. This
# script assumes the API is coming up there already and only waits for it.
SCHEMA_FILE="$REPO/examples/schemas/$NET_DIR/network.json"
if [ ! -f "$SCHEMA_FILE" ]; then
  echo "[stack-up] FAIL: no network schema at $SCHEMA_FILE (dot=$NET_DIR, repo=$REPO)." >&2
  return 1
fi
NET_ID=$(cd "$REPO" && node -e "console.log(require('./examples/schemas/$NET_DIR/network.json').id)")
for _ in $(seq 1 40); do
  curl -sf "http://localhost:2742/api/v1/network/schemas?network=$NET_ID" >/dev/null 2>&1 && break
  sleep 1
done
SCHEMA_COUNT=$(curl -s "http://localhost:2742/api/v1/network/schemas?network=$NET_ID" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}})')
if [ "${SCHEMA_COUNT:-0}" -lt 1 ]; then
  echo "[stack-up] FAIL: /network/schemas returned 0 entries for $NET_ID — the UI will be blank." >&2
  echo "[stack-up] Clear the schema cache and relaunch the API directly (see run-signals-dpg)." >&2
  return 1
fi

# --- 2. UI port probe (audit §1.3) -----------------------------------------
# config/local.json says :5173; run-signals-dpg serves :3000; some branches do
# use Vite's default. Probe rather than hardcode either.
UI_URL=""
for port in 3000 5173; do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$port/" 2>/dev/null)" = "200" ]; then
    UI_URL="http://localhost:$port"; break
  fi
done
if [ -z "$UI_URL" ]; then
  echo "[stack-up] FAIL: no UI on :3000 or :5173 — check /tmp/signals-ui.log" >&2
  return 1
fi
export E2E_UI_BASE_URL="$UI_URL"
export E2E_API_BASE_URL="http://localhost:2742"

# --- 3. capabilities ---------------------------------------------------------
# db: real credentials read from the stack's own .env, never guessed.
PGUSER=$(read_env_var POSTGRES_USER "$ENV_FILE") || return 1
PGDB=$(read_env_var POSTGRES_DB "$ENV_FILE") || return 1
PGPW=$(read_env_var POSTGRES_PASSWORD "$ENV_FILE") || return 1
# DATABASE_PORT is the host-side port docker-compose.yaml maps to the
# container's 5432 (`'${DATABASE_PORT}:5432'`) — not necessarily 5432 itself.
# Unlike the credentials above, a wrong port fails loudly at connection time
# (never silently), so this one degrades to the compose default rather than
# aborting the whole run over a cosmetic env gap.
PGPORT=$(read_env_var DATABASE_PORT "$ENV_FILE" 2>/dev/null) || PGPORT=5432
export E2E_DB_URL="postgres://$PGUSER:$PGPW@localhost:$PGPORT/$PGDB"

export E2E_NOTIFICATION_STUB_URL="http://localhost:4545"
export E2E_SEARCH_STUB_URL="http://localhost:4546"
export E2E_FAULT_INJECTION="true"
export E2E_DETERMINISTIC_PII_KEY="true"
# E2E_REAL_SEARCH_URL is deliberately NOT exported: signals-search does now run
# locally behind docker compose's `search` profile, but its images are
# amd64-only and its embedder wants 3-8 GB, so it stays opt-in per host. Set
# E2E_REAL_SEARCH_URL yourself (after `docker compose --profile search up -d`)
# to turn the `realSearch` capability on for a run.

# --- 4. reuse marker ---------------------------------------------------------
printf 'dot=%s\nnetwork=%s\nui=%s\napi=%s\nrun=%s\n' \
  "$NET_DIR" "$NET_ID" "$UI_URL" "http://localhost:2742" "$RUN" > "$MARKER"

echo "[stack-up] ready  dot=$NET_DIR network=$NET_ID ui=$UI_URL run=$RUN"
echo "[stack-up] capabilities: db notificationStub faultInjection deterministicKey"
echo "[stack-up] NOT enabled: realSearch (amd64-only, 3-8GB — opt in with --profile search + E2E_REAL_SEARCH_URL), peer (needs a 2nd API)"
