# Aggregator dashboard: decrypt private display names (aggregator-dpg#406)

**Date:** 2026-06-11
**Branch:** `feat/aggregator-private-display-name`
**Status:** locked — approved approach A (existing config fields only)

## Problem

The aggregator dashboard's participant `name` column shows a UUID for purple_dot
seekers. Root cause chain:

1. Seeker schemas mark the name field (`beneficiary_name`) `private: true`.
2. On write, private fields are split out of the public `items.item_state`
   (masked, e.g. `R***`) into `items.item_private_state`, AES-256-GCM encrypted
   (`v1:<base64(iv+ct+tag)>`, key = PII key from env).
3. `item_metrics.display_name` is precomputed from the **public** state via the
   schema's `display_name_field`. Seeker schemas declare none (the validator
   forbids pointing it at a private field), so it falls back to `item_id`.
4. `GET /api/v1/aggregator/dashboard` serves that precomputed value → UUID.

## Constraints (user-set)

- **No changes to `network.json`** — resolution must use fields that already
  exist in the shipped configs.
- The aggregator keeps consuming the existing `name` field of the dashboard
  response; no response-shape change, no aggregator-dpg change.

## Decision

Decrypt at read time inside the two aggregator-scoped endpoints, resolving the
name field per item type with a fallback chain over **existing** config:

```
display_name_field (item schema, e.g. provider → organisation_name)
  else card.title_field (domain card config, e.g. seeker → beneficiary_name)
  else no override (precomputed display_name / UUID stands)
```

`card.title_field` is the existing per-domain hint for "the field that titles
this item" — semantically the same thing the dashboard needs.

### Authorization (no new checks)

Both endpoints already return only rows where
`item_metrics.onboarded_by_org_id = acting aggregator org`, behind
`auth_middleware` (x-api-key) + `acting_org` preHandler + an explicit
`org_type === 'aggregator'` gate. That is the same entitlement under which
`GET /api/v1/admin/participant` already returns fully decrypted state.
Decryption therefore needs no additional check. All other surfaces
(network item fetch, metrics table, UI feeds) keep the masked value.

## Changes (Signals-DPG only)

| File | Change |
|---|---|
| `apps/api/src/routes/v1/aggregator/dashboard.ts` | `resolve_private_display_names(rows)`: group page rows by network/domain, look up per-type name field via the chain above, one `items` query per group (network+domain pinned for partition pruning, `item_id IN (...)`), `decryptItemPrivate` per row, return `item_id → name` for non-empty string values. `name: private_names.get(id) ?? r.displayName`. Any failure (unknown config, bad blob, missing key) silently keeps the precomputed name. |
| `apps/api/src/routes/v1/aggregator/export.ts` | Same resolution per CSV page (shares the exported helper). |
| `packages/schemas/src/network_workflow.ts` | **Reverted to upstream** — validator untouched (no schema ever points `display_name_field` at a private field). |
| `packages/schemas/src/__tests__/network_workflow_metrics.test.ts` | **Reverted to upstream.** |
| `examples/schemas/purple_dot/network.json` | **Reverted to upstream** — zero changes. |

Net diff vs `origin/feature`: 2 files (dashboard.ts, export.ts), ~110 lines.

## Testing

- Existing dashboard + export suites must stay green (35 tests) — they seed
  non-private fixtures, so the fallback path (`?? r.displayName`) covers them.
- New unit coverage in the dashboard test file:
  1. seeker-style row (private name, `card.title_field` set) → decrypted name
     in `name`.
  2. provider-style row (`display_name_field`, non-private) → unchanged.
  3. missing/corrupt `item_private_state` → falls back to precomputed name.
- Full `pnpm --filter api test` + `pnpm typecheck` green before commit.

## Out of scope

- Local purple env schema drift (`service_city` transplant) — environment
  concern, handled separately, never part of this commit.
- PII reveal audit rows for dashboard reads — `participant_read` sets the
  precedent of not auditing aggregator-scope bulk reads; only the
  consent-gated contact-details endpoint audits.

## Execution steps (locked order)

1. Amend `ef9ad63` so it contains only dashboard.ts + export.ts (the three
   revert files drop out) with the fallback-chain resolver.
2. Add the three new unit tests; run api suite + typecheck.
3. Single commit on `feat/aggregator-private-display-name`; push + PR to
   `feature` after user confirms.
