# Design: `action/perform` Raya-tool compatibility (single-object body + `/bulk` route)

- **Issue:** [signals-dpg#293](https://github.com/Blue-Dots-Economy/signals-dpg/issues/293) — "Array JSON Not supported by vendors"
- **Blocks:** [signals-dpg#160](https://github.com/Blue-Dots-Economy/signals-dpg/issues/160) (UP Blue Dots prod launch + voice bot)
- **Companion:** [signals-search#33 flat search wrapper](https://github.com/Blue-Dots-Economy/signals-search/issues/33) — same Raya root cause, separate spec in that repo.
- **Date:** 2026-07-14

## Problem

`POST /api/v1/action/perform` takes a **top-level JSON array** body (`z.array(z.unknown())`), running each element as a best-effort batch. Raya (Litwiz) LLM tools cannot produce a top-level array: a tool's `api_details.payload_template` **must be a JSON object**, and arguments are injected as `{{param}}` strings into that object. So the voice bot cannot call `action/perform` at all.

We want the simplest fix that lets Raya send a plain object **without losing the real batch capability** the UI depends on.

### Raya constraint (root cause, shared with #33)

Per [Raya LLM-tools docs](https://docs.litwizlabs.com/documentation/agents-llm-tools):
- `function.parameters` (LLM-filled args): nested objects **one level deep only**; arrays must contain **primitives only**.
- `api_details.payload_template` (the HTTP body Raya sends): **must be a JSON object** (never a top-level array); may nest, but `{{param}}` placeholders inject values as **strings**.

A top-level array simply has no representation as a `payload_template`.

## Decision

Split the single array-bodied route into two routes; keep the batch engine and response envelope unchanged.

| Route | Body | Behavior |
|---|---|---|
| `POST /api/v1/action/perform` (**changed**) | single object `PerformActionBodySchema` | wrap to `[body]`, run existing `runBulk`, return `{ results, summary }` with `total: 1` |
| `POST /api/v1/action/perform/bulk` (**new**) | array (today's `z.array(z.unknown())`, unchanged) | exactly today's behavior: 201 all-ok / 207 partial / 422 all-fail; 400 `BULK_EMPTY_ARRAY` / `BULK_LIMIT_EXCEEDED` |

**Rationale for keeping the envelope on the single route:** uniform response shape across both routes; the batch runner and response schemas (`bulk_schemas.ts`) are reused verbatim. Response nesting (`results[0]`) is not subject to Raya's request-side constraint.

## Design

### Route layer (`apps/api/src/routes/v1/action/`)

- `perform_action.ts`: today's handler (array body → `runBulk`) **moves to** the `/perform/bulk` registration. Body schema unchanged (`BulkPerformActionBodySchema = z.array(z.unknown())`).
- New single handler on `/perform`:
  - body schema = `PerformActionBodySchema` (the per-item object, already defined in `packages/schemas/src/api/action_schemas.ts`).
  - handler wraps the validated object as `[body]` and calls the same `runBulk` path, returning the same `{ results, summary }` envelope (`total: 1`).
- Both share `bulk_runner.ts` and the peer-forward logic (`POST /api/v1/network/action/perform`) with no change.
- Auth / acting-org preHandlers apply identically to both routes.

### OpenAPI
Generated from the Zod route schemas (`fastify-type-provider-zod` + `@fastify/swagger`). `/perform` now documents a single-object body; `/perform/bulk` documents the array body. The per-item shape becomes visible on `/perform` (previously hidden inside the array element validation).

## Affected callers (cutover — all first-party)

| Caller | File | Change |
|---|---|---|
| UI single | `apps/ui/src/lib/action-api.ts` `performAction` | POST **single object** to `/action/perform` (drop the `[payload]` array wrap) |
| UI bulk | `apps/ui/src/lib/action-api.ts` `performActionsBulk` | repoint to `/action/perform/bulk` (body unchanged) |
| ai-diffusion voice config | `ai-diffusion-dpg/dev-kit/configs/blue-dots-economy/action_gateway.yaml` | `body_template` single-element array → **single object** on `/action/perform` *(separate repo, small follow-on PR)* |
| Postman | `docs/postman/Signals-DPG.postman_collection.json` | apply/connect requests → single object |

**Not affected:** `match-engine` calls the peer route `POST /api/v1/network/action/perform`, not this client route. `signalstack-writer`, aggregator-dpg, bluedots-automation have no callers.

## Testing

- `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts`: add single-object cases against `/perform` (201 + `{results:[one], summary:{total:1}}`, per-item validation failure → 422); **move** the existing array cases to a new `/perform/bulk` test (or parametrize).
- Keep `on_behalf_of.integration.test.ts` / `consent_flow.integration.test.ts` green; update any that post arrays to `/perform` so they hit `/perform/bulk` or send a single object.

## Rollout / cutover

Because `/action/perform` becomes single-object-only, the array senders above must cut over together. All are first-party and controlled. Land the signals-dpg route change + UI + Postman + tests on one branch (`spec/action-perform-raya-compat` → implementation branch off `feature`); ai-diffusion config as a small follow-on PR referencing this spec. Merge path: feature → develop → main per repo convention.

## Out of scope

- No change to the batch engine semantics, per-item schema, consent gating, or peer-forward behavior.
- The search-side Raya fix (#33) is a separate spec in signals-search.
