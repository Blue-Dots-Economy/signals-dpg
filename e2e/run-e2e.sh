#!/usr/bin/env bash
#
# Run the signals-dpg external E2E suite against a named environment.
#
#   bash e2e/run-e2e.sh <env> [api|ui|preflight|all]
#
# <env> selects config/<env>.json (E2E_ENV) and sources gitignored per-env
# secrets/overrides from e2e/.env.<env> (E2E_SERVICE_API_KEY, E2E_ACTING_ORG_ID,
# optional URL overrides). Runnable directly or via the /e2e Claude command.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_NAME="${1:-}"
TIER="${2:-all}"

list_envs() { ls config/*.json 2>/dev/null | sed 's#config/##; s#\.json##; s/^/  - /' >&2 || true; }

if [[ -z "$ENV_NAME" ]]; then
  echo "usage: run-e2e.sh <env> [api|ui|preflight|all]" >&2
  echo "available envs:" >&2; list_envs
  exit 2
fi

if [[ ! -f "config/${ENV_NAME}.json" ]]; then
  echo "[e2e] no config/${ENV_NAME}.json (E2E_ENV=${ENV_NAME})" >&2
  echo "available envs:" >&2; list_envs
  exit 2
fi

# Per-env secrets + overrides (gitignored). Exports every KEY=value it defines.
if [[ -f ".env.${ENV_NAME}" ]]; then
  echo "[e2e] loading .env.${ENV_NAME}"
  set -a; . "./.env.${ENV_NAME}"; set +a
else
  echo "[e2e] no .env.${ENV_NAME} found — using process env only."
  echo "      (copy .env.${ENV_NAME}.example to .env.${ENV_NAME} to set service creds)"
fi

export E2E_ENV="$ENV_NAME"

# First-run install (idempotent: skipped when node_modules already exists).
if [[ ! -d node_modules ]]; then
  echo "[e2e] first run — installing dependencies + chromium…"
  npm install
  npx playwright install chromium
fi

case "$TIER" in
  all)       SCRIPT="e2e" ;;
  api)       SCRIPT="e2e:api" ;;
  ui)        SCRIPT="e2e:ui" ;;
  preflight) SCRIPT="preflight" ;;
  *) echo "[e2e] unknown tier '${TIER}' (use: api | ui | preflight | all)" >&2; exit 2 ;;
esac

echo "[e2e] env=${ENV_NAME} tier=${TIER} → npm run ${SCRIPT}"
set +e
npm run "$SCRIPT"
CODE=$?
set -e

echo ""
echo "[e2e] HTML report: ${SCRIPT_DIR}/playwright-report/index.html"
echo "[e2e] open with:   npm --prefix \"${SCRIPT_DIR}\" run e2e:report"
exit "$CODE"
