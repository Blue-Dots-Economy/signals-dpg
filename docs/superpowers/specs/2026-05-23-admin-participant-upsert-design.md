# Admin Participant Upsert (Tier-aware) — Design

**Status:** spec — awaiting implementation plan
**Author:** brainstorming session, 2026-05-23
**Related:** Plan 1 (acting_org preHandler), Plan 2 (onboard_participant — current implementation being replaced), Plan A (action on-behalf-of, sets the precedent for tier-aware authorization in admin routes).

## Goal

Replace `POST /api/v1/admin/onboard_participant` with `POST /api/v1/admin/participant` — a tier-aware upsert endpoint that handles new-user creation, existing-user reads, and (for network_service-tier callers) item updates and additional-item inserts. The response always returns the post-write set of items for the targeted user.

## Why now

The three-tier authorization model — `network_service` (ecosystem manager / network admin) at the top, `aggregator` in the middle, and `participant` (seeker / provider via UI) at the bottom — has been partially encoded in the codebase but isn't reflected in `/admin/onboard_participant`'s behavior. Today the endpoint treats aggregator and voice acting_orgs identically and returns `409 USER_ALREADY_EXISTS` for any caller hitting a pre-existing user. That breaks two real use cases:

1. The voice bot is currently run by the network admin (an `ecosystem manager` use case), needs to operate on participants regardless of who onboarded them, and must be able to add or update items on an existing user. With today's 409, it can't.
2. Aggregators legitimately need to know "is this user already in the system?" — but a 409 with just an error code doesn't let them act on the information. Returning the existing items lets them adapt without a second roundtrip.

The endpoint's name also misleads — "onboard" implies a single-shot create. The semantics are now upsert.

## Three tiers and what each can do

| Tier | acting_org.org_type | Onboard new user | Read existing user's items | Update existing item | Insert additional item for existing user |
|---|---|---|---|---|---|
| Ecosystem manager / network admin | `network_service` | yes | yes | yes (via `item_id` in body) | yes (omit `item_id`) |
| Aggregator | `aggregator` | yes | yes (read-only — returned as part of the response) | no | no |
| Voice (future tier, currently non-existent) | `voice` | no (rejected) | no | no | no |
| Anyone else / missing acting_org | n/a | no (rejected) | no | no | no |

Voice-typed orgs do not exist in production today (see [[project-action-on-behalf-acting-org-type]] for the scope reset rationale). When voice is eventually delegated to aggregator tier (the user's stated future direction), the voice-dpg apikey starts asserting an aggregator-typed `x-acting-org-id` and the aggregator-tier behavior here kicks in automatically. No code change needed at that boundary — the discriminator is `acting_org.org_type` end-to-end.

## Endpoint contract

### URL

`POST /api/v1/admin/participant`

The old `POST /api/v1/admin/onboard_participant` is removed. No external clients depend on it yet (pre-pilot), so a hard rename is safe.

### Auth

Same preHandler chain as the rest of `/admin/*`: `auth_middleware_if_enabled` → strict `acting_org_preHandler`. The strict preHandler guarantees `request.acting_org` is populated before the handler runs; the handler then narrows on `org_type`.

### Allowed `acting_org.org_type`

- `aggregator` — narrow scope. May onboard new users; may read existing users; may not write to existing users.
- `network_service` — broad scope. May onboard new users; may read, update, and add items for any existing user.
- `voice` — rejected with `403 ACTING_ORG_TYPE_NOT_ALLOWED` (no such org rows exist today; placeholder for the matrix).
- No `acting_org` — rejected with `403 INVALID_ACTING_ORG`. (Strict preHandler already guarantees `acting_org` is set, so this branch is defensive.)

### Behavior matrix

| `acting_org.org_type` | User exists? | `item_id` in body? | Outcome |
|---|---|---|---|
| `aggregator` | no | (ignored) | Onboard new user + create one item with the supplied `item_state`. Return `{ user_existed: false, items: [new_item] }`. |
| `aggregator` | yes | (ignored) | **No writes.** Return `{ user_existed: true, items: [...all items for that user, served-domain scoped...] }`. The user's `onboarded_by_org_id` / `onboarded_via` is preserved verbatim. |
| `network_service` | no | (ignored) | Onboard new user + create one item. Same flow as aggregator new-user. |
| `network_service` | yes | provided + valid (item belongs to this user) | PATCH-style update of that item (mirror of `PATCH /api/v1/item/:itemId` semantics — schema-validate the incoming `item_state`, run privacy split, replace `item_state` and `item_private_state`, update `updated_at`). Return all items. |
| `network_service` | yes | provided but item doesn't belong to user (or doesn't exist) | `403 ITEM_NOT_OWNED_BY_USER`. No writes. |
| `network_service` | yes | absent | **Insert a new item** with the supplied `item_state` — even if a (network, domain, item_type) match already exists for this user. The items table has no uniqueness constraint on that tuple; a user may legitimately have multiple seeker profiles. Return all items. |
| `voice` | (any) | (any) | `403 ACTING_ORG_TYPE_NOT_ALLOWED`. |
| (no acting_org) | (any) | (any) | `403 INVALID_ACTING_ORG` (defensive). |

### Request shape

```ts
{
  email?: string,                        // optional (one of email/phone required by refine)
  phone_number?: string,                 // E.164, regex /^\+\d{10,15}$/
  name: string,
  date_of_birth?: ISO-datetime,
  terms_accepted: true,                  // literally true (refine)
  privacy_accepted: true,                // literally true (refine)
  channel: 'bulk' | 'link' | 'voice' | 'self',
  source_id?: string,
  network?: string,                      // default 'blue_dot'
  domain?: string,                       // default 'seeker'
  item_type?: string,                    // default 'profile_1.0'
  item_state: Record<string, unknown>,   // RENAMED from `profile`. The payload validated
                                         //   against the item schema, split into public /
                                         //   private state, and written to `items`.
  item_id?: string,                      // RENAMED from `profile_item_id`. UUID. Only
                                         //   meaningful when acting_org is network_service
                                         //   AND user exists. Otherwise ignored.
}
```

Schema-level refine `email || phone_number` is preserved.

### Response shape

```ts
{
  user_id: string,
  user_existed: boolean,
  onboarded_at: ISO-datetime | null,     // null when user_existed=true (we didn't onboard)
  items: Array<{                         // RENAMED from `profiles`. Always reflects the
                                         //   POST-WRITE state.
    item_id: string,
    item_network: string,
    item_domain: string,
    item_type: string,
    item_state: Record<string, unknown>, // merged public + private state; admin scope
                                         //   sees private fields
    created_at: ISO-datetime,
    updated_at: ISO-datetime,
  }>,
}
```

`items` is filtered to **served-domain networks only** — `item_network IN (apiConfig.served_domains.map(d => d.network))`. Prevents leaking item data from networks this instance doesn't serve, which mirrors the aggregator dashboard's served-domain scoping.

## Implementation outline

### Files

- **Modify:** rename `apps/api/src/routes/v1/admin/onboard_participant.ts` → `apps/api/src/routes/v1/admin/participant.ts`. Replace the handler.
- **Modify:** `apps/api/src/routes/v1/admin/admin_routes.ts` — change the import and registration to point at the renamed handler.
- **Modify:** `packages/schemas/src/admin/onboard_participant.ts` — rename file to `participant.ts`. Replace `OnboardParticipantRequest` / `OnboardParticipantResponse` with `UpsertParticipantRequest` / `UpsertParticipantResponse`. Field renames: `profile` → `item_state`, add optional `item_id`. Response: `profile_item_id` → `items: Array<ItemSnapshot>`.
- **Create:** `apps/api/src/routes/v1/admin/_resolve_upsert_action.ts` — pure helper. Inputs: `{acting_org, user_exists, item_id_in_body}`. Output: discriminated union of 5 verdicts (see below). Mirrors the pattern from Plan A's `resolve_acting_actor`.
- **Create:** `apps/api/src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts` — full matrix unit tests, no DB.
- **Create:** `apps/api/src/routes/v1/admin/__tests__/participant.test.ts` — route-level tests, mocked DB.
- **Create:** `apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts` — real PG, mirrors `on_behalf_of.integration.test.ts` shape.
- **Modify (side-task 7a):** every route file under `apps/api/src/routes/v1/admin/**` adds `tags: ['admin']` to its Fastify route schema. Every route file under `apps/api/src/routes/v1/aggregator/**` adds `tags: ['aggregator']`.
- **Modify (side-task 7b):** `docs/postman/Signals-DPG.postman_collection.json` — add new folder `08 Admin Participant` with one request per matrix row (7 requests total); update the existing `Apply on behalf of seeker` request body to use `{{action_requirements_snapshot_json}}` for `requirements_snapshot`. Both Blue-Dots and Purple-Dots env files gain `action_requirements_snapshot_json` and any missing `_org_id` vars.

### Pure helper: `resolve_upsert_action`

```ts
type Verdict =
  | { kind: 'create_new_user' }                          // either tier, user doesn't exist
  | { kind: 'aggregator_existing_noop' }                 // aggregator, user exists
  | { kind: 'update_item'; item_id: string }             // network_service, user exists, item_id in body
  | { kind: 'insert_item' }                              // network_service, user exists, no item_id
  | { kind: 'rejected'; status: 403; error: 'ACTING_ORG_TYPE_NOT_ALLOWED' | 'INVALID_ACTING_ORG' };

resolve_upsert_action(input: {
  acting_org: ActingOrg | undefined,
  user_exists: boolean,
  item_id_in_body: string | undefined,
}): Verdict
```

Branch order (first-match-wins):
1. `acting_org` undefined → rejected `INVALID_ACTING_ORG`.
2. `acting_org.org_type` not in `{ 'aggregator', 'network_service' }` → rejected `ACTING_ORG_TYPE_NOT_ALLOWED`.
3. `user_exists === false` → `create_new_user` (item_id is ignored).
4. `acting_org.org_type === 'aggregator'` → `aggregator_existing_noop` (item_id is ignored).
5. `item_id_in_body` provided → `update_item`.
6. Otherwise → `insert_item`.

Tests: 9-10 cases covering each verdict + branch-order checks (e.g., user_exists wins over item_id presence; voice rejection wins over everything).

Note: the `ITEM_NOT_OWNED_BY_USER` 403 is NOT a verdict — it's an outcome of the DB lookup AFTER the helper decides `update_item`. The handler does that check at runtime, not the helper. Keeps the helper pure (no DB).

### Handler flow

```
1. Validate `acting_org` and `acting_org.org_type` via resolve_upsert_action.
   - If 'rejected' → reply with status + error.

2. Normalize email/phone, look up user by email OR phone.

3. Call resolve_upsert_action with user_exists + item_id_in_body. Switch on verdict:

   case 'create_new_user':
     - signUpEmail (better-auth) + tx (attribution UPDATE + create_profile_item).
     - Compensate orphan user on tx failure (same as today).
     - SELECT items for user (served-domain scoped) → return.

   case 'aggregator_existing_noop':
     - No writes.
     - SELECT items for user (served-domain scoped) → return with onboarded_at=null.

   case 'update_item':
     - SELECT item by item_id. If created_by !== user.id → reply 403 ITEM_NOT_OWNED_BY_USER.
     - Mirror update_item_handler logic: fetch schema, validate item_state, privacy split,
       UPDATE items.set({item_state, item_private_state, updated_at: now}).where(item_id).
     - SELECT items for user (served-domain scoped) → return with onboarded_at=null.

   case 'insert_item':
     - Run create_profile_item (existing helper) with the supplied item_state +
       network/domain/item_type defaults.
     - SELECT items for user (served-domain scoped) → return with onboarded_at=null.

4. Common error handling for PG 23505 / 23503 / ItemServiceError as today.
```

### `items` final-read query

```ts
const networks = apiConfig.served_domains.map(d => d.network);
const items_rows = await db
  .select({ /* the 7 ItemSnapshot fields */ })
  .from(items)
  .where(and(
    eq(items.created_by, user_id),
    inArray(items.item_network, networks),
  ))
  .orderBy(items.created_at);
```

`item_state` returned by this query is the public split — re-merge with private state per item via `mergeItemStateWithPrivate` (same helper as `update_item_handler`).

## Test plan

### Unit — `resolve_upsert_action.test.ts` (no DB)

9 cases:
1. `acting_org` undefined → rejected INVALID_ACTING_ORG.
2. `acting_org` voice → rejected ACTING_ORG_TYPE_NOT_ALLOWED.
3. Aggregator + user doesn't exist → create_new_user.
4. Aggregator + user exists → aggregator_existing_noop.
5. Aggregator + user exists + item_id provided → aggregator_existing_noop (item_id ignored).
6. Network_service + user doesn't exist → create_new_user.
7. Network_service + user doesn't exist + item_id provided → create_new_user (item_id ignored).
8. Network_service + user exists + item_id provided → update_item.
9. Network_service + user exists + no item_id → insert_item.

### Unit — `participant.test.ts` (mocked DB)

Mirrors `Plan A's perform_action.test.ts` isolation pattern. ~12 cases covering:
- All 4 happy paths (matrix rows 1, 3, 4, 6).
- Aggregator + existing user → returns items, no writes asserted via dbState.
- Network_service + update_item → asserts schema validation called + UPDATE called with new item_state.
- Network_service + update_item with mismatched item_id → 403 ITEM_NOT_OWNED_BY_USER.
- Network_service + insert_item with duplicate (network, domain, item_type) → no error (new row).
- 403 rejections (voice, missing acting_org).
- Items response always scoped to served-domain networks.

### Integration — `participant.integration.test.ts` (real PG)

Mirrors Plan A's `on_behalf_of.integration.test.ts`. Seeds two aggregator orgs + one network_service org (via existing `seed_service_users.ts` pattern). Cases:
1. Aggregator-A onboards a new user. Asserts user row, items[0], onboarded_by_org_id = agg_A.
2. Aggregator-A hits same user — gets items back, no new rows in DB.
3. Aggregator-B hits user onboarded by A — same: items back, no writes, attribution unchanged.
4. Network_service updates that user's profile_1.0 item — DB shows updated `item_state`.
5. Network_service adds a provider-domain item for the same user — DB now has 2 items, attribution unchanged.
6. Network_service tries `item_id` from a different user — 403 ITEM_NOT_OWNED_BY_USER, no writes.

### Other

- `pnpm typecheck` clean.
- `pnpm --filter api test` 128/128 → 140+ /140+ (12 new unit cases).
- OpenAPI/Swagger output shows `admin` + `aggregator` tags after side-task 7a.
- Postman collection imports cleanly; the new folder has 7 requests + the `Apply on behalf of seeker` body fix.

## Out of scope (deferred)

- `GET /admin/participants` — list/search across users. Not needed today; can be added if product asks.
- Bulk upsert (multiple participants per call).
- Profile delete from admin scope (item-level routes already cover it).
- Per-service-user permission scopes (`member.permissions` allowlist). Same future-capability flag as Plan A.
- Audit columns on `items` similar to Plan A's audit columns on `item_actions` (who touched this item). Defer until audit query patterns emerge.

## Open follow-ups

- When voice tier ships (aggregator-delegated voice), no code change needed — voice-dpg asserts aggregator-typed acting_org and inherits the aggregator behavior. But document the migration path in `docs/operations/integrating-dpgs.md` when the time comes.
- The `items` admin-scope response includes private fields. If the admin UI exposes this data to operators with narrower trust, add a per-field redaction layer.

---

## Spec self-review

- **Placeholders:** no TBD / TODO. Every behavior cell is concrete.
- **Internal consistency:** the matrix in §"Behavior matrix" matches the verdicts in `resolve_upsert_action` (5 verdicts ↔ 5 non-rejected matrix rows + 2 rejected rows = 7 rows). The request shape's renames are mirrored in the response shape (`profile` → `item_state`; `profile_item_id` → `item_id`; response `profiles` → `items`). The served-domain filter is documented in §"Response shape" and reused in §"Implementation outline" final-read query.
- **Scope:** the helper is pure (mirrors Plan A's pattern). The handler dispatches on 4 verdict kinds plus rejected. No new DB columns, no new tables. Fits a single PR comfortably (8-9 tasks).
- **Ambiguity:** the network_service-existing-user-no-item_id case is explicit ("always create a new item, even if (network, domain, item_type) matches"). The voice rejection is explicit ("placeholder for future tier"). The 403 ITEM_NOT_OWNED_BY_USER is documented as a runtime outcome separate from the helper's verdicts so it's clear where the check lives.
