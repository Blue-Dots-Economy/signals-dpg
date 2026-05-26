# PII Reveal on Accepted Action — Design

**Status:** spec — awaiting implementation plan
**Author:** brainstorming session, 2026-05-26
**Related:** the `item_state` / `item_private_state` split established earlier in `packages/schemas/src/item_state_privacy.ts`; the `item_actions` lifecycle established by Plan A and the 2026-05-23 on-behalf-of revision.

## Goal

Let two participants exchange contact-level PII only after a network-defined action between their items reaches a status that the network declares "reveal-eligible". Concretely:

1. Add an optional `reveals_pii_on_status: string[]` field to each interaction in `network.json`.
2. Add a new endpoint `GET /api/v1/action/:action_id/contact-details` that, when caller is a participant in the action and the current `action_status` is in the network's reveal list, returns the **other** actor's merged item (public state + private state).
3. Add an append-only `pii_reveal_audit` table that records every successful reveal.
4. Add a "View contact details" button to the action card in the UI when the action is in a reveal-eligible status; clicking opens a modal that calls the new endpoint.

Cross-instance reveals (when the other actor's item lives on a different instance) are explicitly **out of scope** for this iteration; the endpoint returns a typed `501 CROSS_INSTANCE_REVEAL_NOT_SUPPORTED` and the UI surfaces a clear message.

## Why now

Today every action-aware UI surface either shows only public `item_state` (cross-actor reads via `GET /api/v1/network/item/fetch`) or shows full merged state for the owner's own items (`GET /api/v1/item/fetch` with `includePrivateState: true`). There is no path that says "I accepted your connect; now I can see your phone number." The business requires this for Connect / Shortlist / Apply lifecycles on purple_dot and equivalent flows on blue_dot.

Doing this without a deliberate design risks (a) leaking PII via cache, (b) hardcoding `'accepted'` as a magic string the way `'shortlisted'` was hardcoded before Plan B, and (c) leaving no audit trail for "who saw whose data."

## Lifecycle / reveal semantics

| Sender action | Receiver state | Sender sees receiver PII? | Receiver sees sender PII? |
|---|---|---|---|
| `connect` / `shortlist` / `apply` initiated | pending | no | no |
| Receiver `accept`s | accepted | **yes** | **yes** |
| Receiver `reject`s | rejected | no | no |
| Either side `cancel`s | cancelled | no | no |
| Post-accept transition (e.g. `complete`) | in network's reveal list | yes if status still in list | yes if status still in list |

Reveal eligibility is **per current `action_status`** and **declared per interaction in `network.json`** — not hardcoded around the action name or the literal string `'accepted'`. Once status leaves the reveal list (e.g. a hypothetical future `archived`), reveal stops.

## Network schema extension

`network.json` interactions gain an optional `reveals_pii_on_status: string[]`:

```jsonc
"connect": {
  "interactions": [
    {
      "from": { "domain": "seeker", "item_type": "profile_1.0" },
      "to":   { "domain": "provider", "item_type": "profile_1.0" },
      "event_schema": { /* status.enum: ["accepted","rejected","cancelled","completed"] */ },
      "metric_categories": { /* existing — unchanged */ },
      "reveals_pii_on_status": ["accepted", "completed"]   // NEW
    }
  ]
}
```

### Validation

- Optional. Missing or empty list → PII is never revealed for this interaction. This is the safe default.
- When present, **every value must appear in the interaction's `event_schema.properties.status.enum`**. Validated at network-config load time (in the loader used by `getNetworkConfigById`); a mismatch fails fast at boot.
- Validation lives next to existing interaction validation in `@dpg/schemas`.

### Accessor

A new pure helper in `@dpg/schemas`, parallel to `getActionInteraction`:

```ts
export function getInteractionPiiRevealStatuses(
  networkConfig: NetworkConfig,
  interactionKey: {
    actionType: string;
    fromNetwork: string; fromDomain: string; fromItemType: string;
    toNetwork: string;   toDomain: string;   toItemType: string;
  }
): readonly string[];   // empty array when not configured
```

### Seeded values for current networks

- `examples/schemas/purple_dot/network.json` — `connect` seeker→provider interaction: `["accepted", "completed"]`. (purple_dot's event_schema enum needs `"completed"` added — if it isn't already there, that's a prerequisite edit in the same change.)
- `examples/schemas/blue_dot/network.json` — `connect` seeker→provider interaction: `["accepted"]`. (blue_dot's enum doesn't currently include `completed`.)

The implementation plan must confirm the exact enum values per network before committing these seeds.

## Database

One new table, no changes to existing tables.

```sql
CREATE TABLE pii_reveal_audit (
  reveal_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id                       uuid NOT NULL,
  viewer_user_id                  text NOT NULL,
  revealed_item_id                uuid NOT NULL,
  revealed_item_owner             text NOT NULL,
  revealed_action_type            text NOT NULL,
  revealed_action_status_at_view  text NOT NULL,
  viewed_at                       timestamp NOT NULL DEFAULT now()
);

CREATE INDEX pii_reveal_audit_viewer_idx ON pii_reveal_audit (viewer_user_id, viewed_at DESC);
CREATE INDEX pii_reveal_audit_item_idx   ON pii_reveal_audit (revealed_item_id, viewed_at DESC);
```

- Append-only. No updates, no deletes wired up.
- No foreign keys to `item_actions` or `items`: both are partitioned and don't support single-column FKs. App-level integrity is enforced by the handler always reading the action and item rows first.
- Drizzle definition lives in `apps/api/db/postgres/schema/pii_reveal_audit.ts`, re-exported from `apps/api/db/postgres/schema/index.ts`. (Matches the `item_metrics` precedent for API-only tables; `packages/database/src/drizzle_ref_tables/` is reserved for partitioned tables shared across packages.)
- Migration generated via `pnpm db:generate:api`. `pnpm schema:bundle` re-runs to refresh the Helm-bundled `schema.sql`. Schema-parity CI must pass.
- Retention policy is **deferred**; documented as a follow-up rather than designed here.

## API endpoint

`GET /api/v1/action/:action_id/contact-details`

**File:** `apps/api/src/routes/v1/action/get_action_contact_details.ts`, registered in `action_routes.ts` alongside `fetch_actions`, `perform_action`, `update_action_status`. Inherits the plugin-level `auth_middleware_if_enabled` + `acting_org_preHandler_optional`.

### Request

- Path param: `action_id` (uuid).
- No body, no query.
- Caller identified from `request.user.id` (session or apikey-as-self).
- `acting_as_user_id` is **not** supported. Self-acted only, matching the post-2026-05-23 stance on `/update-status`.

### Response 200

```ts
{
  action_id: string,
  action_status: string,         // current status at read time
  other_actor: {
    item: ItemResponse           // merged item_state with item_private_state,
                                 // same shape as /item/fetch returns
  }
}
```

Response header: `Cache-Control: no-store`. No Redis caching.

### Error matrix

| HTTP | `error` code | When |
|---|---|---|
| 401 | `UNAUTHORIZED` | no `request.user` |
| 404 | `ACTION_NOT_FOUND` | no `item_actions` row for `action_id` |
| 403 | `NOT_ACTION_PARTICIPANT` | caller is neither `source_item_owner` nor `target_item_owner` |
| 403 | `PII_NOT_REVEALED` | current `action_status` is not in the interaction's `reveals_pii_on_status` |
| 501 | `CROSS_INSTANCE_REVEAL_NOT_SUPPORTED` | the other actor's `*_instance_url` is not `getCurrentApiBaseUrl()` |
| 404 | `OTHER_ITEM_NOT_FOUND` | other-actor item row missing locally despite the instance URL matching (data anomaly) |
| 500 | `INTERNAL_SERVER_ERROR` | anything else; logged with structured context |

### Handler logic (order matters)

1. Load action row by `action_id`. Else 404.
2. If `request.user.id !== source_item_owner && request.user.id !== target_item_owner` → 403 `NOT_ACTION_PARTICIPANT`.
3. Resolve the interaction via `getActionInteraction(networkConfig, ...)`, then read `getInteractionPiiRevealStatuses(...)`. If current `action_status` not in that list → 403 `PII_NOT_REVEALED`.
4. Determine the "other actor" item by caller role (source vs target). If `other.item_instance_url !== getCurrentApiBaseUrl()` → 501 `CROSS_INSTANCE_REVEAL_NOT_SUPPORTED`.
5. Fetch the other-actor item using the existing partition-aware local helpers. Else 404 `OTHER_ITEM_NOT_FOUND`.
6. Merge with `mergeItemStateWithPrivate(item.item_state, item.item_private_state)`.
7. Insert one `pii_reveal_audit` row with `(action_id, viewer_user_id, revealed_item_id, revealed_item_owner, revealed_action_type, revealed_action_status_at_view)`. **Audit insert failure does not block the response** — it is logged with `request.log.error` and the 200 is still returned.
8. Reply 200 with the merged item shaped under `other_actor.item`, plus `Cache-Control: no-store`.

### Zod schemas

`packages/schemas/src/action.ts` gains:

- `ActionContactDetailsParamsSchema` — `{ action_id: z.string().uuid() }`.
- `ActionContactDetailsResponseSchema` — uses the existing `ItemResponseSchema` nested under `other_actor.item`.

OpenAPI tag: `action`. Postman collection's `04_action` folder gains one new request.

## UI

**File:** `apps/ui/src/components/actions/action-card.tsx`.

New derived state alongside `canAccept`, `canReject`, etc.:

```ts
const canRevealContact =
  action.action_status === 'accepted' || action.action_status === 'completed';
```

The server is authoritative via `reveals_pii_on_status`; the UI hardcodes the union of statuses any current network reveals on so the button shows on both `initiated` and `received` cards in those states. If a future network only reveals on a different status the UI does not know about, the button won't appear — a deliberate trade for not loading network configs into the UI bundle for this iteration. A 403 `PII_NOT_REVEALED` (e.g. if the server's list is stricter than the UI's) is surfaced as a toast.

### New button

Rendered in the `CardFooter` when `canRevealContact`. Placed leftmost in the footer, with an icon (`UserCircle` or `Contact` from `lucide-react`) and label "View contact details". Click opens a modal.

### New modal

`apps/ui/src/components/actions/contact-details-modal.tsx` (new file).

- On open, fires `getActionContactDetails(actionId)` (new helper in `apps/ui/src/lib/action-api.ts`), which calls `GET /api/v1/action/:action_id/contact-details`.
- Loading state: spinner.
- Error state: maps typed `error` codes to human messages.
  - `PII_NOT_REVEALED` → "Contact details are no longer available for this connection."
  - `CROSS_INSTANCE_REVEAL_NOT_SUPPORTED` → "This contact is hosted on another instance and isn't supported yet."
  - `NOT_ACTION_PARTICIPANT` / `UNAUTHORIZED` → generic "You don't have access to these details."
  - `OTHER_ITEM_NOT_FOUND` / `INTERNAL_SERVER_ERROR` → "Something went wrong; please try again."
- Success: renders the other actor's merged item using the existing schema-driven item renderer used elsewhere for `profile_1.0`. The implementation plan will pin down the exact renderer component.

### Things the UI deliberately does not do

- No card-level prefetch. The fetch fires on button click. PII never enters the DOM for cards the user doesn't open. This keeps the no-store cache policy meaningful.
- No optimistic UI on accept. The existing `onStatusUpdate` flow refreshes the list; the button appears in the next render.

## Testing

### Unit tests (`apps/api/src/routes/v1/action/__tests__/get_action_contact_details.test.ts`)

1. 401 when no `request.user`.
2. 404 when action row doesn't exist.
3. 403 `NOT_ACTION_PARTICIPANT` when caller is neither source nor target owner.
4. 403 `PII_NOT_REVEALED` for each non-revealing status (`created`, `pending`, `rejected`, `cancelled`).
5. 200 for both `accepted` and `completed`, asserting `other_actor.item` contains both public and private state fields.
6. 200 when caller is **source** owner — returns target item.
7. 200 when caller is **target** owner — returns source item.
8. 501 `CROSS_INSTANCE_REVEAL_NOT_SUPPORTED` when other actor's `*_instance_url !== getCurrentApiBaseUrl()`.
9. 404 `OTHER_ITEM_NOT_FOUND` when local item lookup misses.
10. Audit row inserted on every 2xx (assertion on the insert mock).
11. Audit insert failure → response still 200, `request.log.error` called with the failure.
12. `Cache-Control: no-store` header set on 2xx responses.

### Schema/loader tests

13. `reveals_pii_on_status` validation: each value must appear in the interaction's `event_schema.properties.status.enum`. Test passes for valid, fails fast at load for invalid.
14. Missing/empty `reveals_pii_on_status` is legal; `getInteractionPiiRevealStatuses` returns `[]`.

### Integration test (`apps/api/src/routes/v1/action/__tests__/get_action_contact_details.integration.test.ts`)

15. End-to-end: seed two users + two items (one with `private:true` fields populated), perform action via `/action/perform`, accept via `/update-status`, call `/action/:id/contact-details` from both sides, assert merged item returned and `pii_reveal_audit` row present.
16. After 2xx, call again — second audit row appended (no dedup).

### UI tests

The repo does not currently have component tests for `action-card.tsx`. This change does not introduce UI test infrastructure; modal behavior is covered indirectly by the integration test.

## Out of scope / deferred follow-ups

- **Cross-instance reveal protocol.** A future iteration will need a signed action-scoped capability token from the source instance so the calling instance can fetch private state on behalf of the participant. For now: 501 and the UI tells the user.
- **`pii_reveal_audit` retention policy.** No TTL or purge job is defined; pick a policy when product/legal asks.
- **Audit dashboard / "who saw my data" surface.** The table is queryable but no UI is built.
- **Schema flag for per-field PII vs non-PII private state.** Today `private: true` is the only granularity. If product wants some private fields to stay hidden even on reveal, that's a future schema-authoring change.
- **`acting_as_user_id` on the reveal endpoint.** Deliberately not supported, matching `/action/update-status`. Service callers do not fetch PII on behalf of participants.

## Open product question

The endpoint requires the action to be in a reveal-eligible status **right now**. There's no notion of "this status was revealed historically, so the contact remains visible after the status moves out of the list." If product later wants permanent unlock after first accept, the cleanest extension is a new `unlocked_at` timestamp column on `item_actions` populated on the first entry into a reveal status, and the reveal handler reads that column instead of (or in addition to) the current status. Flag for product after pilot.
