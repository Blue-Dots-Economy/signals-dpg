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
# e2e-only concerns on top: capability env, the UI identity + port probe, and
# the marker.
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
# INVOCATION — this script is EXECUTED with bash, never sourced:
#
#   bash .claude/skills/signals-e2e/lib/stack-up.sh <dot> [run-id]
#   source e2e/run/<run-id>/env.sh
#
# It used to be designed to be `source`d directly, so the caller's shell would
# pick up the exports as a side effect. That breaks under zsh (the user's
# actual shell, and what Task 10's run.sh must work from): zsh has no
# BASH_SOURCE array (used below to locate this script's own directory) and
# reserves `status` as a read-only special variable (which a `local` inside a
# helper function collided with). Both are bash-only assumptions a script
# meant to be sourced by *either* shell cannot make about itself. Rather than
# patch around those two zsh-isms one at a time, the fix changes the
# mechanism: this script always runs under a real bash (`bash script.sh`,
# regardless of the caller's own shell), and instead of exporting into the
# caller's environment directly, it writes plain `export KEY='value'` lines to
# e2e/run/<run>/env.sh. That file has no bash-only syntax in it, so sourcing
# it works identically from bash or zsh. All progress/diagnostic output below
# goes to stderr; stdout is unused, so nothing here needs `eval`-ing.
set -uo pipefail

NET_DIR="${1:-blue_dot}"
RUN="${2:-e2e-$(date +%s)}"

log() { echo "[stack-up] $*" >&2; }

# Anchored to this script's own location, like cleanup.sh and ledger.ts — NOT
# to the caller's cwd and NOT to $REPO (the stack's checkout, resolved below,
# which may be a different directory entirely). A run's artifacts (the env
# file, the reuse marker) belong to THIS worktree's e2e/run/, regardless of
# which checkout is actually running the stack or where the caller invoked
# this script from.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$HERE/../../../../e2e" && pwd)"
RUN_DIR="$E2E_DIR/run/$RUN"
mkdir -p "$RUN_DIR"
ENV_OUT="$RUN_DIR/env.sh"
MARKER="$RUN_DIR/stack.marker"
: > "$ENV_OUT"

# Single-quoted `export KEY='value'` lines, sourceable identically by bash and
# zsh — this is the only artifact meant to be sourced (see the header
# comment). Embedded single quotes are escaped with the standard
# close-quote/escaped-quote/reopen-quote trick so a value containing one
# (a password, say) still round-trips safely.
emit_export() {
  local key="$1" value="$2" escaped
  escaped="${value//\'/\'\\\'\'}"
  printf "export %s='%s'\n" "$key" "$escaped" >> "$ENV_OUT"
}

SCRIPT_REPO="$(cd "$HERE/../../../.." && pwd)"
REPO="${SIGNALS_REPO:-$SCRIPT_REPO}"
STACK_ENV="$REPO/.env"

if [ ! -f "$STACK_ENV" ]; then
  log "FAIL: no .env at $STACK_ENV."
  log "This worktree does not itself run the stack. Set SIGNALS_REPO to the"
  log "checkout that does (e.g. SIGNALS_REPO=/path/to/your/Signals-DPG clone),"
  log "and make sure that repo has been brought up once via the run-signals-dpg skill."
  exit 1
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
#
# Caveat: a `.env` with the same key defined twice resolves to the FIRST
# occurrence (the regex is non-global, `.match` not `.matchAll`), whereas
# `source .env` (bash) or docker's `env_file:` would take the LAST one. A
# duplicate key is a malformed .env either way; this just means a reader here
# and a `source`d value could disagree on which duplicate wins. Not fixed
# because the actual `.env` files in this repo don't have duplicate keys
# today (confirmed via .env.example) — flagged so a future duplicate doesn't
# silently pick the "wrong" one against that assumption.
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
    log "FAIL: could not read $path."
    return 1
  fi
  if [ "$status" -ne 0 ] || [ -z "$value" ]; then
    log "FAIL: $key is missing or empty in $path — set it before the db capability can be enabled."
    return 1
  fi
  printf '%s' "$value"
}

emit_export E2E_RUN_ID "$RUN"

# --- 1. the stack itself, via the run-signals-dpg skill's block -------------
# The caller (SKILL.md phase 1) invokes that skill first, against $REPO. This
# script assumes the API is coming up there already and only waits for it.
SCHEMA_FILE="$REPO/examples/schemas/$NET_DIR/network.json"
if [ ! -f "$SCHEMA_FILE" ]; then
  log "FAIL: no network schema at $SCHEMA_FILE (dot=$NET_DIR, repo=$REPO)."
  exit 1
fi
NET_ID=$(cd "$REPO" && node -e "console.log(require('./examples/schemas/$NET_DIR/network.json').id)")
for _ in $(seq 1 40); do
  curl -sf "http://localhost:2742/api/v1/network/schemas?network=$NET_ID" >/dev/null 2>&1 && break
  sleep 1
done
SCHEMA_COUNT=$(curl -s "http://localhost:2742/api/v1/network/schemas?network=$NET_ID" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}})')
if [ "${SCHEMA_COUNT:-0}" -lt 1 ]; then
  log "FAIL: /network/schemas returned 0 entries for $NET_ID — the UI will be blank."
  log "Clear the schema cache and relaunch the API directly (see run-signals-dpg)."
  exit 1
fi

# --- 2. UI identity + port probe (audit §1.3) -------------------------------
# config/local.json says :5173; run-signals-dpg serves :3000; some branches do
# use Vite's default. Probe rather than hardcode either — but a port
# answering isn't enough: on this host :3000 is the Blue Dots AGGREGATOR
# portal, a completely different product built on Next.js. It happened to
# answer 307 (a redirect), so the old 200-only check skipped it by luck; had
# it answered 200, every Signals UI spec would have run against the wrong
# app. So verify identity, not just liveness.
#
# Marker choice: `/src/main.tsx` as a literal `<script type="module" src=...>`
# value in apps/ui/index.html. This is NOT the page <title> (brand-configurable
# per network via brand.json — "Signal Stack" isn't guaranteed to appear) and
# NOT `window.__DPG_UI_CONFIG__` (a naming convention shared across the whole
# "DPG" product family, so it says nothing about which product). `/src/main.tsx`
# is specific to how Vite's dev server serves an unbundled SPA entry point —
# the aggregator portal is Next.js and has no such file or serving model, so it
# structurally cannot produce this string. Caveat: this only holds for the dev
# server this script targets (`pnpm dev:ui`); a built/production bundle
# rewrites that script tag to a hashed asset path and would need a different
# marker.
is_signals_ui() {
  local url="$1" body
  body="$(curl -s "$url/" 2>/dev/null)"
  case "$body" in
    *'/src/main.tsx'*) return 0 ;;
    *) return 1 ;;
  esac
}

UI_URL=""
if [ -n "${E2E_UI_BASE_URL:-}" ]; then
  # An explicit override is the caller's own choice — respect it rather than
  # probing over the top of it (and rather than re-verifying identity: the
  # caller who set this presumably knows what it points at).
  UI_URL="${E2E_UI_BASE_URL%/}"
  log "using pre-set E2E_UI_BASE_URL=$UI_URL (not probing)"
else
  for port in 3000 5173; do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$port/" 2>/dev/null)"
    case "$code" in
      200)
        if is_signals_ui "http://localhost:$port"; then
          UI_URL="http://localhost:$port"
          break
        fi
        log "port $port answered 200 but is not the Signals UI (no /src/main.tsx module script in the body) — something else is serving :$port"
        ;;
      000) ;; # nothing listening — silent, expected for the port not in use
      *) log "port $port answered $code (not 200) — skipping" ;;
    esac
  done
fi
if [ -z "$UI_URL" ]; then
  log "FAIL: no Signals UI found on :3000 or :5173 — check /tmp/signals-ui.log"
  exit 1
fi
emit_export E2E_UI_BASE_URL "$UI_URL"
emit_export E2E_API_BASE_URL "http://localhost:2742"

# --- 3. capabilities ---------------------------------------------------------
# db: real credentials read from the stack's own .env, never guessed.
PGUSER=$(read_env_var POSTGRES_USER "$STACK_ENV") || exit 1
PGDB=$(read_env_var POSTGRES_DB "$STACK_ENV") || exit 1
PGPW=$(read_env_var POSTGRES_PASSWORD "$STACK_ENV") || exit 1
# DATABASE_PORT is the host-side port docker-compose.yaml maps to the
# container's 5432 (`'${DATABASE_PORT}:5432'`) — not necessarily 5432 itself.
# Unlike the credentials above, a wrong port fails loudly at connection time
# (never silently), so this one degrades to the compose default rather than
# aborting the whole run over a cosmetic env gap.
PGPORT=$(read_env_var DATABASE_PORT "$STACK_ENV" 2>/dev/null) || PGPORT=5432
emit_export E2E_DB_URL "postgres://$PGUSER:$PGPW@localhost:$PGPORT/$PGDB"

emit_export E2E_NOTIFICATION_STUB_URL "http://localhost:4545"
emit_export E2E_SEARCH_STUB_URL "http://localhost:4546"
emit_export E2E_FAULT_INJECTION "true"
emit_export E2E_DETERMINISTIC_PII_KEY "true"
# E2E_REAL_SEARCH_URL is deliberately NOT exported: signals-search does now run
# locally behind docker compose's `search` profile, but its images are
# amd64-only and its embedder wants 3-8 GB, so it stays opt-in per host. Set
# E2E_REAL_SEARCH_URL yourself (after `docker compose --profile search up -d`)
# to turn the `realSearch` capability on for a run.

# --- 4. reuse marker ---------------------------------------------------------
printf 'dot=%s\nnetwork=%s\nui=%s\napi=%s\nrun=%s\n' \
  "$NET_DIR" "$NET_ID" "$UI_URL" "http://localhost:2742" "$RUN" > "$MARKER"

log "ready  dot=$NET_DIR network=$NET_ID ui=$UI_URL run=$RUN"
log "env file: $ENV_OUT — source it to pick up the exports"
log "capabilities: db notificationStub faultInjection deterministicKey"
log "NOT enabled: realSearch (amd64-only, 3-8GB — opt in with --profile search + E2E_REAL_SEARCH_URL), peer (needs a 2nd API)"
