# Participant Onboarding — Account/Profile Separation + Profile Lifecycle (signals-dpg foundation)

> **Status:** Design (brainstormed 2026-06-03)
> **Scope:** signals-dpg only (the canonical store + classifier). Aggregator-dpg and voice/chat outbound are dependent follow-up specs.
> **Supersedes:** the cross-repo draft `participant-onboarding-lifecycle-2.md` (which conflated user/item state, reused `active`/`inactive` against the engagement classifier, and bundled three subsystems).

---

## 1. Problem

Participant onboarding today couples **account creation** (the `user` row) with **profile creation** (the `items` row) in a single `POST /admin/participant` transaction, and item writes reject any payload missing a required field. Outbound campaigns from aggregators and data imports from other sources frequently yield **partial data**. The current behaviour turns that into either a hard failure or an inaccessible participant.

Product now requires: capture **minimal identity** (phone/email + name), create the user, trigger an outbound campaign (voice/chat) to collect the rest, and let the profile exist in an **incomplete state** until completed — without failing and without letting an incomplete profile interact on the network.

## 2. Goals

- Let partial profile data land instead of failing.
- A profile carries an explicit **lifecycle** so we can tell "in progress" from "ready".
- Only **ready** profiles may interact (connect/apply) or be discovered publicly.
- Decouple the account stage from the profile stage so completion can happen later, via a different actor (self-serve link **or** on-behalf voice/chat).
- Preserve the aggregator "user exists but owned elsewhere" signal.

## 3. Non-goals (explicit, deferred to follow-up specs)

- Aggregator-dpg endpoints: identity lookup, `completion_actions[]`, notifier dispatch, dashboard tiles.
- Voice/chat outbound orchestration and IVR completion UX.
- The broader Plan B engagement-metrics redesign. This spec touches **only** the completion-% formula (§9), not the engagement classifier.
- A reconciled/mirrored status cache on aggregator's `participants` table.

## 4. State model — two independent axes

This is the central correction over the draft. There are **two** status concepts; they never share vocabulary.

### 4.1 `items.lifecycle_status` (new, item-level, synchronous)

New first-class column, written **only** by signals service code inside the item-write transaction. Never declared in `network.json`, never stored in `item_state`.

| Value | Meaning | Set by |
|-------|---------|--------|
| `draft` | Required fields incomplete. Cannot interact; not discoverable. | Classifier (§5) |
| `live` | All required fields present. Discoverable; can connect/apply. | Classifier (§5) |
| `paused` | Owner/admin-hidden, **reversible**. Cannot interact; not discoverable. | Explicit action (§6) |

```sql
ALTER TABLE items
  ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_status IN ('draft','live','paused')),
  ADD COLUMN completion_pct integer NOT NULL DEFAULT 0;
CREATE INDEX items_lifecycle_idx
  ON items (item_network, item_domain, lifecycle_status);
```

(`items` is partitioned by `(item_network, item_domain, item_type)`; the index is created per the partition-aware pattern.)

### 4.2 `account_only` — derived, never stored

"User row exists, **zero** item rows." It is **not** a `lifecycle_status` value and lives on no column. Rollups compute it via a LEFT JOIN anti-pattern (`user` rows whose `id` has no matching `items.created_by`). The first item created for a user ends the `account_only` condition.

### 4.3 `item_metrics.profile_status` — unchanged

The existing engagement classifier (`new`/`active`/`at_risk`/`inactive`, computed async via each domain's `status_rules`) is **untouched** and is computed **only for `lifecycle_status = 'live'`** items. No column reuses `active`/`inactive` across the two axes — the draft's biggest readability hazard is removed.

## 5. Classifier (pure, synchronous, runs on every item write)

A pure function evaluated inside the create/update transaction over the **merged post-write state** (not the delta):

```
required        = schema.required ?? []
filled_required = required.filter(k => is_populated(merged_state[k]))
required_complete = filled_required.length === required.length   // vacuously true when required is empty
completion_pct    = required.length === 0 ? 100
                    : round(filled_required.length / required.length * 100)
```

Transition applied to `lifecycle_status`:

- If the **stored** status is `paused` → **stays `paused`** (explicit owner intent is sticky; the classifier never auto-flips out of `paused`). The new `completion_pct` is still written.
- Otherwise → `required_complete ? 'live' : 'draft'`.

Rules:

- A caller-supplied `lifecycle_status` (or `completion_pct`) in any request body is **always ignored**.
- Classification is unconditional on every write: completing the last required field flips `draft → live`; clearing a required field flips `live → draft` (see §7).
- `is_populated` reuses the existing predicate (`null`/`undefined`/`""`/`[]` → not populated).

## 6. Pause / unpause (explicit, owner or admin)

- `pause`: any state → `paused`. Sticky against the classifier.
- `unpause`: recompute `draft`/`live` from current data via §5.
- Editing a profile **while paused** keeps it `paused` (data updates, status does not); the recompute happens only on `unpause`.

Endpoint: `POST /api/v1/item/:.../lifecycle` (or a dedicated `pause`/`unpause` route — exact shape decided in the plan), session (owner) or admin/on-behalf per §8.

## 7. Leaving `live` — transitions and side effects

A profile leaves `live` two ways: **auto-demote** (an update clears a required field → `live → draft`) or **explicit pause** (`live → paused`). On any `live → {draft,paused}` transition, **in the same transaction**:

1. **Pending actions** (status not yet `accepted`/terminal — i.e. `created`/`submitted`) where this item is source or target are **auto-cancelled**.
2. **New actions** are blocked (§10 gate).
3. The profile is **excluded from discovery** (§11).

**UI affordance (signals `apps/ui`):** before an owner self-initiates a pause, or submits an edit that would clear a required field, when the profile has pending actions, the UI shows a **confirmation popup** ("This will cancel N pending request(s) and hide your profile") before calling the API. The UI determines the pending count via the existing actions fetch. The server performs the cancellation regardless; the popup is a pre-action warning, not an enforcement point.

**Counterparties** of auto-cancelled actions are notified via the deferred notification mechanism (out of scope here; noted for the follow-up).

## 8. Endpoint & permission model

### 8.1 `POST /api/v1/admin/participant` — `item_state` becomes optional

| `item_state` | Result |
|--------------|--------|
| absent / empty | create-or-lookup **user only** → `account_only` (no item row) |
| present | user + item; classifier (§5) sets `draft`/`live` |

Profile completion later reuses the **existing `POST /api/v1/item/create` / `update` path**, on-behalf, governed by the matrix below.

### 8.2 Acting-org permission matrix

| `organization.type` | user resolution | read/write scope | change vs today |
|---|---|---|---|
| `network_service` | any | full admin; all users, all items | **unchanged** — this is how voice-dpg gets full access to an authorizing caller (voice-dpg acts under its `network_service` identity; the "only-the-caller-on-the-line" scoping is voice-dpg's trust-based responsibility, as today) |
| `aggregator` | by phone/email | **only** users with `onboarded_by_org_id == acting_org.id`: may create users, read **and now insert/update** their items | **NEW**: gains scoped insert/update (today `aggregator_existing_noop` blocks item writes on existing users) |
| `voice` (org type) | — | — | **unchanged** (still not used for direct item access; voice-dpg uses `network_service`) |

`resolve_upsert_action` and the acting-org checks change to encode the aggregator scoped-write grant. Ownership for aggregator writes is enforced by `onboarded_by_org_id == acting_org.id` on the target user.

### 8.3 "Exists elsewhere" response (aggregator)

When an `aggregator` caller targets an existing user **not** onboarded by it, the response carries an explicit, **non-disclosing** signal:

```jsonc
{
  "user_existed": true,
  "owned_elsewhere": true,   // explicit; replaces today's ambiguous empty-items inference
  "items": []                // no data, owning org NOT disclosed
}
```

For an aggregator's **own** existing user, `owned_elsewhere: false` and `items` reflects their items (states per §11).

## 9. Profile completion percentage (changed to required-only)

The existing weighted formula (`required ×1.0 + optional ×0.5`) is **replaced** with required-only:

```
completion_pct = required.length === 0 ? 100
                 : round(filled_required.length / required.length * 100)
```

Optional fields are still **stored** in `item_state` but contribute **zero** to the percentage. `completion_pct` is computed by the classifier (§5) and written to `items.completion_pct` synchronously. Downstream display/consumption of the value is deferred; only the computation + storage are in scope here. (`item_metrics.profile_completion_pct`, written by the async recompute, is reconciled to the same formula as part of the Plan B work — not duplicated here.)

## 10. Action gating

- `POST /api/v1/action/perform` and `/network/action/perform`: the **source and target** items must both be `lifecycle_status = 'live'` at perform time. Otherwise → `409 PROFILE_NOT_LIVE` (machine-readable `error` code, per repo convention).
- `POST /api/v1/action/update-status` (accept): requires both endpoints still `live` (a pending action whose endpoint left `live` was already auto-cancelled in §7, so this is the residual race guard).

## 11. Visibility

| Caller | Returns |
|--------|---------|
| Inter-instance / public (`/network/item/fetch`) | `live` only |
| Owner (`/item/fetch`, session) | all of the caller's own items, any state |
| Admin / on-behalf reads | per §8.2 scope (aggregator: own; network_service: all), all states |

The `live`-only predicate is applied in the network fetch path (and the local fetch stays owner-scoped as today).

## 12. PII reveal gating

`get_action_contact_details` reveals contact PII **iff**:

```
action.status == 'accepted'
AND source_item.lifecycle_status == 'live'
AND target_item.lifecycle_status == 'live'   // evaluated at read time
```

Leaving `live` → reveal returns `403` and PII is hidden (block/revoke). Returning to `live` → the same still-accepted action reveals again, with **no re-consent**. Access is recomputed every read, never granted permanently.

## 13. Scenario coverage

| # | Scenario | Handled by |
|---|----------|-----------|
| 1 | New identity, zero profile data | §8.1 (no `item_state`) → `account_only` |
| 2 | New identity + partial profile | §8.1 + §5 → `draft` |
| 3 | New identity + complete profile | §8.1 + §5 → `live` |
| 4 | Existing `account_only` user, same org adds profile later | §8.1 with `item_state` → insert item → classifier |
| 5 | Existing user owned by another org, aggregator caller | §8.3 `owned_elsewhere: true`, no data |
| 6 | Existing user, network_service caller | §8.2 full admin |
| 7 | Draft completed via voice/chat/link | self-serve session **or** on-behalf write → §5 `draft → live` |
| 8 | Live profile clears a required field | §5 + §7 auto `live → draft`, pending cancelled |
| 9 | Owner pauses / resumes | §6 `live ↔ paused` (reversible) |
| 10 | Action attempted by/at non-live profile | §10 `409 PROFILE_NOT_LIVE` |
| 11 | Profile leaves live with in-flight relationships | §7 pending cancelled; §12 accepted-connection PII gated at read time |
| 12 | Public discovery | §11 `live` only |
| 13 | Self-serve UI create with partial data | §3 shape-only validation → `draft`; UI may nudge completion client-side |

## 14. Validation (shape-only)

All item writes validate via `validateAgainstJsonSchema(schema, payload, 'item_state', { ignoredKeys: schema.required, allowAdditionalProperties: apiConfig.allow_extra_schema_data })`, using the existing `omitRequiredSchemaKeys` helper (`packages/schemas/src/network_workflow.ts`). Effect: types, patterns, enums, and formats are still enforced; **missing-required passes**. `required[]` shifts from "Ajv gate" to "classifier input (the live bar)". Network authors tune the live bar by editing `required[]` only; no `if/then/else` or schema restructuring.

## 15. Migration & backfill

- One additive migration (regenerate via `pnpm db:generate:api`, never hand-edit): add `lifecycle_status` + `completion_pct` + `items_lifecycle_idx` (§4.1).
- **Backfill** existing rows with a one-time classifier pass: `live` if `required_complete` for their current `item_state`, else `draft`; set `completion_pct` accordingly. No existing row becomes `paused`.
- Regenerate the Helm-bundled schema: `pnpm schema:bundle` (+ `pnpm schema:bundle:check`).

## 16. Error codes (new/changed)

| Code | HTTP | Where |
|------|------|-------|
| `PROFILE_NOT_LIVE` | 409 | action perform / accept when an endpoint isn't `live` |
| `owned_elsewhere: true` (response field, not an error) | 200 | aggregator participant on a user owned elsewhere |
| (reveal) `403` reuse existing forbidden code | 403 | contact-details when an endpoint isn't `live` |

## 17. Testing strategy

- **Unit (pure):** classifier (`required_complete`, `completion_pct`, paused-sticky, vacuous-required), `resolve_upsert_action` matrix incl. aggregator scoped-write + `owned_elsewhere`.
- **Integration (PG):** `/admin/participant` account-only vs with-item; aggregator scoped insert/update vs `owned_elsewhere`; classifier draft↔live on create/update; pause/unpause; leaving-live pending-cancel; action `409 PROFILE_NOT_LIVE`; PII reveal gated on both-live and auto-restore; `/network/item/fetch` live-only.
- **Migration:** backfill classifies a mixed fixture correctly; `schema:bundle:check` passes.

## 18. Dependent follow-up specs (separate brainstorms)

1. **aggregator-dpg**: `GET /v1/lookup`, `completion_actions[]` on registration links, notifier dispatcher (sms/voice/chat, idempotent), dashboard tiles by `lifecycle_status` + `account_only` rollup. Consumes §8/§11 contracts.
2. **voice/chat outbound**: IVR/chat completion writing back via `network_service` on-behalf; counterparty notifications for cancelled actions.
