# E2E Purple Dot Integration Scripts

Operator-driven scripts that exercise the full Aggregator-DPG ↔ Signals-DPG
handshake for the Purple Dot network. See the full runbook at
[`docs/operations/e2e-purple-dot-runbook.md`](../../docs/operations/e2e-purple-dot-runbook.md).

## Quick reference

```bash
# Submit synthetic QR seekers (after creating an active link via Aggregator UI)
pnpm e2e:qr <link-slug> [count=10]

# Drive connect actions + backdate timestamps so the dashboard shows items
# distributed across new/active/at_risk/inactive
pnpm e2e:actions
```

## Setup

Copy `.env.example` to `.env` and fill in the values from your aggregator
registration steps. `.env` is gitignored.

```bash
cp scripts/e2e/.env.example scripts/e2e/.env
$EDITOR scripts/e2e/.env
set -a; source scripts/e2e/.env; set +a
```

## Files

| Path | Purpose |
|---|---|
| `submit_qr_participants.mts` | POSTs synthetic seeker payloads to Aggregator's public registration endpoint. |
| `seed_actions.mts` | Redirect to the canonical implementation under `apps/api/scripts/e2e/`. |
| `fixtures/purple_dot_qr_payloads.json` | 10 deterministic seeker records (rotated if count > 10). |
| `fixtures/purple_dot_providers.csv` | 5-row CSV uploaded via Aggregator's bulk-upload UI. |
| `.env.example` | Template for required environment variables. |
