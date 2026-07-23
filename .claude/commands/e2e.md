---
description: Run the signals-dpg external E2E functional suite against an environment
argument-hint: <env> [api|ui|preflight|all]
allowed-tools: Bash(bash e2e/run-e2e.sh:*)
---

Run the signals-dpg external E2E functional suite for arguments: `$ARGUMENTS`

- First token is the environment (`local`, `dev`, …) → selects `e2e/config/<env>.json`
  and loads gitignored `e2e/.env.<env>` for service credentials.
- Optional second token is the tier: `api`, `ui`, `preflight`, or `all` (default `all`).

Do exactly this, and nothing else:

1. Run: `bash e2e/run-e2e.sh $ARGUMENTS`
2. Report the outcome from its output — passed / failed / skipped counts and the
   HTML report path. If anything failed, list the failing test names. Do not modify
   any files or re-run unless asked.
