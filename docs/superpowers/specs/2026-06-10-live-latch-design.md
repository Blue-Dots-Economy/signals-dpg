# Live latch: make `live → draft` impossible, drop destructive action cancellation

**Date:** 2026-06-10
**Status:** Design — pending implementation
**Supersedes the relevant parts of:** `2026-06-03-participant-onboarding-lifecycle-design.md` §7, §10

## 1. Problem

Under the participant-onboarding-lifecycle design, an already-`live` profile demotes to
`draft` whenever an item update clears a required field (`classify_item` re-runs over the
merged post-write state). On that `live → draft` transition the system **hard-cancels every
pending action** (`created`/`submitted`) where the item is source or target —
`cancel_pending_actions_for_item`, in the same transaction.

That cancellation is **destructive and irreversible**: a counterparty's in-flight request is
killed because the profile owner did a routine edit. It is also asymmetric with the PII reveal
gate (§12 of the original spec), which merely *gates* access on both-endpoints-live and
auto-restores when the profile returns to live — nothing is destroyed.

## 2. Goal

A profile that has reached `live` does not silently fall back to `draft`, and no destructive
side-effect fires on the states a profile can leave `live` for. Completeness is preserved by
**rejecting the demoting write**, not by reclassifying after it.

## 3. Decisions

| # | Decision |
|---|----------|
| D1 | **`live → draft` is made impossible by construction.** Signalstack rejects any item update that would leave a required field unpopulated **when the item is currently `live`**. |
| D2 | **Enforcement point:** `updateItemInternal` (`apps/api/src/services/item_service.ts`) — the single chokepoint behind both the owner/UI edit route (`routes/v1/item/update_item.ts`) and the aggregator/admin re-onboard path (`routes/v1/admin/participant.ts`). |
| D3 | **Scope: `live` only.** A `paused` profile is *not* guarded (see §6 back-door). |
| D4 | **Remove destructive cancellation entirely.** `cancel_pending_actions_for_item` and its call sites are deleted. Nothing auto-leaves `live` anymore, and explicit `pause` no longer cancels — pending actions survive and resume on unpause. |
| D5 | **The `§10 PROFILE_NOT_LIVE` gate is the sole enforcement while not-live**, recomputed fresh at perform/accept time (mirrors the PII gate). It graduates from "residual race guard" to primary guard. |
| D6 | **No classifier change.** With D1 in place, `classify_item` over a live item always sees complete data, so it can only return `live`. The `live → draft` branch is unreachable through a direct edit. |
| D7 | **No signals UI change.** RJSF (`@rjsf/validator-ajv8` in `apps/ui/src/components/forms/schema-form.tsx`) already enforces `required` on submit and blocks emptying a required field. Signals UI remains full-profile-only; partial/`draft` profiles originate only from the aggregator's public registration path. |

## 4. Behavior

### 4.1 The guard (D1, D2)

In `updateItemInternal`, after the merged full state is built and shape-validated
(`item_service.ts` ~L297–321) and before the transaction `UPDATE`:

```ts
const required = Array.isArray((itemSchema as { required?: unknown }).required)
  ? ((itemSchema as { required?: string[] }).required as string[])
  : [];
const requiredComplete = required.every((k) => is_populated(mergedFullState[k]));

if (!requiredComplete && existingItem.lifecycle_status === 'live') {
  throw new ItemServiceError(
    409,
    'REQUIRED_FIELD_LOCKED_WHILE_LIVE',
    'Cannot clear a required field on a live profile; pause it first',
  );
}
```

`is_populated` is the existing predicate in `services/metrics/profile_completion.ts`
(`null`/`undefined`/`""`/`[]` are not populated; `false`/`0` are).

**Merge nuance:** a partial update can only add/overwrite keys, never delete one. A required
field is only "cleared" when the caller *explicitly* sends `null`/`""`/`[]` for it. Aggregator
partial re-onboards (which layer onto prior full state) therefore never trip the guard; only a
deliberate blank-out does. That is exactly the case being blocked.

### 4.2 Removing cancellation (D4, D5)

Deleted:
- `apps/api/src/services/items/cancel_pending_actions.ts` and its `__tests__`.
- The two call sites: `item_service.ts` (`updateItemInternal` leave-live block) and
  `routes/v1/item/lifecycle.ts` (pause branch).
- `cancelled_pending_actions` from `ItemLifecycleResponse` (`packages/schemas/src/item/lifecycle.ts`).
- `leavingLive` and `cancelledPendingActions` from `UpdateItemInternalResult`
  (`item_service.ts`). Both existing consumers (`update_item.ts`, `participant.ts`) already
  ignore these fields.

`§10` gate is unchanged in code (it already requires both endpoints `live` at perform and at
accept time) — only its role/wording changes.

### 4.3 Error code

`REQUIRED_FIELD_LOCKED_WHILE_LIVE` → `409`, registered alongside the other machine-readable
codes (e.g. the `PROFILE_NOT_LIVE` registry). Routes already translate
`ItemServiceError.statusCode`/`errorCode` into `reply.code(N).send({ error, message })`, so no
new per-route handling is needed beyond confirming the existing `ItemServiceError` catch.

## 5. What stays the same

- `classify_item` (paused-sticky; vacuous-required → live; else required-complete ? live : draft).
- PII reveal gate (§12) — both-live, recomputed per read, auto-restore.
- Discovery: non-live profiles are not discoverable, so no *new* action can target a non-live
  profile; only pre-existing pending actions remain, gated.
- Pause/unpause semantics and `409 PROFILE_NOT_LIVE`.
- `profile_completion_pct` (required-only). A live profile is always 100% required-complete
  under this design (the guard guarantees it).

## 6. Known back-door (accepted, block-on-`live`-only)

Because the guard is scoped to `live` only (D3), one multi-step route to `draft` for an
already-live profile survives:

```
live → pause (live → paused) → edit clears a required field (allowed: paused is unguarded)
     → unpause → classify_item reclassifies from data → draft
```

Properties:
- Requires deliberate, multi-step owner action — not an accidental single edit.
- Causes **no cancellation** (D4 removed it); pending actions are merely gated while not-live.
- Lands the profile in `draft` (gated, recoverable by re-completing required + it re-lives via
  the normal `draft → live` classification on the next write).

Closing this later = extend the D1 guard scope to `paused` as well (one condition change). Left
open by explicit decision to keep scope minimal.

## 7. Testing

Unit / integration (PG):
- **Guard:** live profile + update that clears a required field → `409
  REQUIRED_FIELD_LOCKED_WHILE_LIVE`; the row stays `live`; the item_state is unchanged.
- **Allowed edit:** live profile + update that *changes* a required field to another non-empty
  value → `200`, stays `live`.
- **No cancellation:** live profile with a pending action → owner `pause` → the pending action
  is **still** `created`/`submitted` (not `cancelled`); `perform`/`accept` returns `409
  PROFILE_NOT_LIVE`; after `unpause` → `live`, the same action `perform`/`accept` succeeds.
- **Back-door:** live → pause → (admin/aggregator) update clears required (allowed) → unpause →
  `draft`; no actions cancelled.

Delete the old "leaving-live pending-cancel" integration scenario and the
`cancel_pending_actions` unit tests.

## 8. Out of scope / follow-ups

- Counterparty visibility of "on hold" pending actions (kept opaque for now — only `409` on
  attempt).
- Optional TTL to retire indefinitely-gated pending actions.
- Aggregator-dpg consumers of `cancelled_pending_actions` (folds into the separately-tracked
  aggregator `completion_pct`/lifecycle cleanup).
