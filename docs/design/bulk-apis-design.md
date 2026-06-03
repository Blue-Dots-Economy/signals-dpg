# Bulk APIs Design — Create, Connect, Accept/Reject

- **Date:** 2026-06-03
- **Status:** Approved (pending spec review)
- **Branch:** `bulk-apis` (off `feature`)

## Goal

Make three currently one-to-one APIs support bulk operations by accepting an
**array** payload and processing each element independently. Sending an array
of one performs a single operation; sending many performs many.

Target endpoints:

| Name | Route | Handler | Nature |
|---|---|---|---|
| Create | `POST /api/v1/item/create` | `item/create_item.ts` | Local DB write |
| Connect | `POST /api/v1/action/perform` | `action/perform_action.ts` | Validates locally, then HTTP-delegates to the target item's instance |
| Accept/Reject | `POST /api/v1/action/update-status` | `action/update_action_status.ts` | Local DB update + event insert + async mirror to source instance |

## Decisions (locked)

| Decision | Choice |
|---|---|
| Payload shape | **Array-only.** Body must be a JSON array. (Breaking change — accepted.) |
| Element validation | **Per-item lenient.** Route accepts a loose array; each element is schema-validated inside the handler. A malformed element becomes one error in the results; valid elements still process. |
| Failure mode | **Best-effort per item.** Each element is processed independently; successes commit even if siblings fail. |
| Response | **Per-item results array** (in input order) + summary counts. |
| HTTP status | All succeed → `201` (create/connect) / `200` (update-status); mixed → `207`; all fail → `422`; request-level error (not array / empty / over limit) → `400`. |
| Batch limit | **Configurable** via `BULK_MAX_ITEMS` (default `100`). |
| Connect fan-out | **Loop per item**, reusing the existing single inter-instance endpoint (`/api/v1/network/action/perform`). No change to the peer-facing network-tier API. |
| Concurrency | **Sequential** for v1 (all three). Bounded-concurrency for Connect is a possible later optimization. |

## Out of scope

- Bulk variant of the inter-instance `/api/v1/network/action/perform` (grouping
  by target instance). Connect loops per item over the existing single endpoint.
- Updating external callers (aggregator-dpg, voice-dpg) — see Migration.

## Architecture

### Shared bulk runner

A small generic utility owns the cross-cutting concerns so the three endpoints
stay consistent and each is testable in isolation.

```
runBulk(elements, processOne, { okStatus, concurrency = 1 }) -> {
  results: Array<PerItemResult>,   // input order, each tagged with `index`
  summary: { total, succeeded, failed },
  httpStatus,                      // okStatus (201 create/connect, 200 update) | 207 | 422
}
```

`okStatus` is supplied by each endpoint (201 for create/connect, 200 for
update-status); the runner returns it on all-success, `207` on mixed, `422` on
all-fail.

Responsibilities of `runBulk`:
- Enforce non-empty and `<= BULK_MAX_ITEMS` (else the caller returns `400`).
- For each element: run `processOne`, catch any throw, record a success or error
  result keyed by `index`.
- Compute summary counts and the aggregate HTTP status.

Each endpoint provides a focused `processOne(element, ctx)` that contains its
existing single-item logic, refactored out of today's handler.

### Per-endpoint `processOne`

**Create** — per element: `CreateItemBodySchema.safeParse` → served-domain check
→ `ensureItemPartition` → `createItemInternal` → cache invalidate. `created_by`
stays per-element (admin api-key may author for different users in one batch;
non-admin callers still may not set it). Auth (caller id / admin-api-key rules)
is resolved once per request.

**Connect** — per element: `PerformActionBodySchema.safeParse` → resolve acting
actor → source-ownership check → interaction/consent/requirements validation →
existing HTTP call to `target_item.item_instance_url`
`/api/v1/network/action/perform`. Each element may carry its own
`acting_as_user_id`, `consent`, `requirements_snapshot`.

**Accept/Reject** — per element: `UpdateActionStatusBodySchema.safeParse` → load
action by `action_id` → target-owner check → interaction/consent/event
validation → `ensureActionEventPartition` → update row → insert event → mirror
to source instance.

## Request / response contract

### Request

All three: body is a JSON array. Route schema:
```ts
z.array(z.unknown()).min(1).max(BULK_MAX_ITEMS)
```
The element schema (`CreateItemBodySchema` / `PerformActionBodySchema` /
`UpdateActionStatusBodySchema`) is applied per element inside the handler via
`safeParse` so one bad element does not reject the batch.

### Response envelope

```jsonc
{
  "results": [
    { "index": 0, "status": "success", /* endpoint-specific success fields */ },
    { "index": 1, "status": "error", "error": "ERROR_CODE", "message": "..." }
  ],
  "summary": { "total": 2, "succeeded": 1, "failed": 1 }
}
```

Per-item success fields (mirror today's single responses):

- **Create:** `item_id`, `item_type`
- **Connect:** `action_id`, `action_type`, `action_status`, `update_count`, `source_item_id`, `target_item_id`
- **Accept/Reject:** `action_id`, `action_type`, `action_status`, `update_count`

Per-item error: `error` (machine code, e.g. `INVALID_PAYLOAD`,
`UNSERVED_DOMAIN_BINDING`, `SOURCE_ITEM_NOT_FOUND`, `ACTION_NOT_FOUND`,
`NOT_TARGET_ITEM_OWNER`, `CONSENT_REQUIRED`, `TARGET_INSTANCE_UNAVAILABLE`,
`INTERNAL_SERVER_ERROR`, …) + human `message`. Existing per-item error codes are
reused unchanged; `INVALID_PAYLOAD` is new for per-element schema failures.

### Status codes

- `201` / `200` — every element succeeded.
- `207` — mixed success and failure.
- `422` — every element failed (each still carries its own code in `results`).
- `400` — request-level: body is not an array, empty array, or exceeds
  `BULK_MAX_ITEMS`.

## Configuration

Add `BULK_MAX_ITEMS` (positive int, default `100`) following the repo's env-var
rule:
1. Zod env schema in `packages/config/src/secrets.ts`.
2. `turbo.json` `globalPassThroughEnv`.

Exposed on the API config object (alongside `allow_extra_schema_data`) and read
by the bulk runner.

## UI impact

The breaking contract is absorbed in the **API client layer** so component call
sites stay essentially unchanged:

- `lib/item-api.ts` `createItem`, `lib/action-api.ts` `performAction` /
  `updateActionStatus`: send `[payload]`, read `results[0]`, and throw when
  `results[0].status === 'error'` (surfacing `error`/`message` as today).
- Existing single-item screens (profile create/edit, connect, accept/reject)
  keep their current single-call ergonomics.
- A future multi-item screen can call a bulk-aware client function directly.

## Migration (required follow-up, separate from this change)

Array-only is breaking for **all** callers:
- API tests that post single objects (`perform_action.test.ts`,
  `update_action_status.test.ts`, create tests) are updated to arrays as part of
  this change.
- External callers (**aggregator-dpg**, **voice-dpg**) that hit these endpoints
  must be updated to send arrays — done as a coordinated follow-up after this
  lands. Out of scope for this repo/PR.

## Testing

Per endpoint (vitest, following existing `__tests__` patterns):
- All-success array → `201`/`200`, results all `success`, summary correct.
- Partial failure (mix of valid + invalid) → `207`, per-item codes correct,
  valid elements committed.
- Malformed element (lenient) → that index `INVALID_PAYLOAD`, others succeed.
- Over-limit array → `400`.
- Empty array / non-array body → `400`.
- Single-element array → behaves exactly like the old single call.
- Bulk runner unit tests: ordering, status computation, limit enforcement,
  throw-to-error mapping.

## Risks / notes

- Connect sequential fan-out means a large batch with slow/unreachable target
  instances takes proportionally longer; bounded concurrency is the documented
  later optimization.
- Per-item partition creation (`ensureItemPartition`,
  `ensureActionEventPartition`) is idempotent, so repeated calls within a batch
  are safe.
