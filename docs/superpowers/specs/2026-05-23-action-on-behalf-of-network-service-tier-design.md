# Action On-Behalf-Of — Network-Service Tier + Strip Update-Status Acting-As Design

**Status:** spec — awaiting implementation plan
**Author:** brainstorming session, 2026-05-23
**Related:** Plan A (`2026-05-22-action-perform-on-behalf-of-design.md` — the aggregator-tier this extends), Plan C (`2026-05-23-admin-participant-upsert-design.md` — established the network-service tier pattern this mirrors).

## Goal

Two scoped changes to the action-on-behalf-of surface:

1. **Extend `/api/v1/action/perform`** to accept a `network_service`-typed `acting_org` as an unrestricted (network-wide) on-behalf-of caller. The pilot's voice-DPG is network-hosted today and needs to file actions for any participant who dials in, regardless of which aggregator (if any) onboarded them. Aggregator-tier behavior is unchanged.

2. **Strip on-behalf-of from `/api/v1/action/update-status`.** Status updates revert to self-acted-only (session cookie or apikey-as-self). Participants update status for their own items via the UI; service callers do not impersonate users on the update path.

## Why now

Plan A shipped the aggregator-tier on-behalf-of with the assumption that voice would eventually become aggregator-scoped. That assumption holds in the long run, but today voice-DPG runs as a network-level service — it acts for any seeker who dials in, regardless of which aggregator onboarded them (or whether they self-registered). The aggregator-only gate blocks the production voice flow.

Status updates from voice never materialized as a real use case. The `acting_as_user_id` field on `/action/update-status` adds attack surface and audit complexity (Plan A's "WARN on overwrite" path, last-actor-wins audit columns) without a production caller. Removing it tightens the model: status mutates only via the owner's own session / apikey.

## Three-tier model (post-change)

| Tier | acting_org.org_type | `/action/perform` on-behalf-of | `/action/update-status` |
|---|---|---|---|
| Ecosystem manager (network-hosted voice) | `network_service` | yes — any user in the network | self-acted only |
| Aggregator (counsellor-driven, future) | `aggregator` | yes — only own users (`onboarded_by_org_id === acting_org.org_id`) | self-acted only |
| Voice as a separate tier | `voice` | rejected (`ACTING_ORG_TYPE_NOT_ALLOWED`) — placeholder; no voice-typed orgs exist | self-acted only |
| Participant (UI) | (no acting_org) | self-attribution | self-acted (must own target item) |

The future migration path: when voice-DPG moves to aggregator-tier delegation, voice-dpg just starts asserting an aggregator-typed `x-acting-org-id` and inherits the aggregator semantics. No code change at that point.

## Endpoint contract: `POST /api/v1/action/perform`

### Request

Unchanged from Plan A. Body keeps the optional `acting_as_user_id` field.

### Authorization matrix (post-change)

| acting_org | acting_as_user_id | Outcome |
|---|---|---|
| (no acting_org, session-acted) | absent | Self-attribution. `source_item_owner = request.user.id`. Audit columns null. |
| (no acting_org, session-acted) | present | `400 CANNOT_OVERRIDE_SELF` (unchanged). |
| (no acting_org, apikey-as-self) | absent | Self-attribution. `source_item_owner = request.user.id`. Audit columns null. |
| (no acting_org, apikey-as-self) | present | `400 CANNOT_OVERRIDE_SELF` (unchanged). |
| `aggregator` | absent | `400 MISSING_ACTING_AS_USER_ID` (unchanged). |
| `aggregator` | present, user not found | `404 USER_NOT_FOUND` (**new**). |
| `aggregator` | present, owned by this aggregator | `200/201`. Audit columns populated with `acting_org.org_id` + `acting_org.service_user_id`. |
| `aggregator` | present, owned by another org OR self-registered (null) | `403 NOT_AUTHORIZED_FOR_TARGET` (unchanged). |
| `network_service` | absent | `400 MISSING_ACTING_AS_USER_ID` (**new**). |
| `network_service` | present, user not found | `404 USER_NOT_FOUND` (**new**). |
| `network_service` | present, user exists | `200/201`. **Skips the `onboarded_by_org_id` check** — network-wide scope. Audit columns populated with `acting_org.org_id` (network_service) + `acting_org.service_user_id` (the voice/aggregator-dpg service user). |
| `voice` | (any) | `403 ACTING_ORG_TYPE_NOT_ALLOWED` (unchanged — no voice-typed orgs exist in production). |

The `SOURCE_ITEM_NOT_OWNED_BY_ACTOR` 403 guard from Plan A stays as-is — the source item's `created_by` must equal the `effective_user_id` regardless of tier.

### Audit semantics

`item_actions.performed_by_org_id` + `performed_by_service_user_id` are populated only at create-time. Their value identifies which tier filed the action:

- `performed_by_org_id` equals a `network_service`-typed org → voice / ecosystem-manager-driven action.
- `performed_by_org_id` equals an `aggregator`-typed org → counsellor / aggregator-DPG-driven action.
- `performed_by_org_id IS NULL` → self-acted (UI session or apikey-as-self).

No code change to the audit columns themselves — they were defined in Plan A and stay.

## Endpoint contract: `POST /api/v1/action/update-status`

### Request

`UpdateActionStatusBodySchema` loses the `acting_as_user_id` field:

```ts
// packages/schemas/src/api/action_schemas.ts
export const UpdateActionStatusBodySchema = z.object({
  action_id: z.uuid(),
  action_status: z.string().min(1),
  remarks: z.string().min(1).optional(),
  // acting_as_user_id field removed (was Plan A); status updates are self-acted only.
});
```

### Behavior (post-change)

1. Look up `existingAction` by `action_id`. If absent → `404 ACTION_NOT_FOUND` (unchanged).
2. **Skip `resolve_acting_actor`** entirely. Effective actor is always `request.user.id`.
3. Ownership check: `existingAction.target_item_owner === request.user.id`. Else `403 NOT_TARGET_ITEM_OWNER` (renamed from Plan A's `TARGET_ITEM_NOT_OWNED_BY_ACTOR` since "actor" semantics no longer apply — caller is always the target item's owner).
4. UPDATE `action_status` + `remarks` + `updated_at`. **No writes to `performed_by_*` columns.** The audit fields on the row reflect the create-time actor verbatim.
5. The WARN log on overwrite (Plan A's last-actor-wins audit detection) is removed — there's nothing to overwrite anymore.

### What goes away from the handler

- The `resolve_acting_actor` call + the verdict-dispatch branches.
- The `action_error_messages` lookup for `CANNOT_OVERRIDE_SELF` / `MISSING_ACTING_AS_USER_ID` / `ACTING_ORG_TYPE_NOT_ALLOWED` / `NOT_AUTHORIZED_FOR_TARGET` (those still apply on `/action/perform`; the import simply isn't used here).
- The audit-fields portion of the UPDATE `.set({…})` block.
- The audit-overwrite WARN log.

The result is a simpler handler that mirrors the pre-Plan-A shape (modulo Plan A's preHandler ordering fix in `action_routes.ts`, which stays).

## Helper changes — `_resolve_acting_actor.ts`

### Verdict union extension

```ts
export type ResolveErr = {
  ok: false;
  status: 400 | 403 | 404;
  error:
    | 'CANNOT_OVERRIDE_SELF'
    | 'MISSING_ACTING_AS_USER_ID'
    | 'ACTING_ORG_TYPE_NOT_ALLOWED'
    | 'NOT_AUTHORIZED_FOR_TARGET'
    | 'USER_NOT_FOUND';                 // ← new
};
```

### Lookup function signature

Plan A's `lookup_onboarded_by_org` returned `string | null` (the org_id, or null if user-missing OR user-has-no-attribution — both states collapsed). The new tier needs to distinguish "user doesn't exist" from "user exists but not owned by this aggregator."

Replace `lookup_onboarded_by_org` with:

```ts
export const lookup_user_for_acting = async (
  user_id: string,
): Promise<{ onboardedByOrgId: string | null } | null> => {
  const rows = await db
    .select({ onboardedByOrgId: user.onboardedByOrgId })
    .from(user)
    .where(eq(user.id, user_id))
    .limit(1);
  return rows.length === 0 ? null : { onboardedByOrgId: rows[0].onboardedByOrgId };
};
```

The return shape:
- `null` → no row exists for that user_id → `USER_NOT_FOUND`.
- `{ onboardedByOrgId: null }` → user exists, never attributed (self-registered or pre-Plan-2).
- `{ onboardedByOrgId: 'org_…' }` → user exists, attributed to that org.

### Updated branching

```ts
export const resolve_acting_actor = async (input: ResolveActingActorInput): Promise<ResolveActingActorResult> => {
  const { acting_org, request_user_id, acting_as_user_id, lookup_user } = input;

  // 1. Self-acted (no acting_org)
  if (!acting_org) {
    if (acting_as_user_id) {
      return { ok: false, status: 400, error: 'CANNOT_OVERRIDE_SELF' };
    }
    return { ok: true, effective_user_id: request_user_id, audit: { performed_by_org_id: null, performed_by_service_user_id: null } };
  }

  // 2. Tier gate — aggregator OR network_service. Voice + anything else rejected.
  if (acting_org.org_type !== 'aggregator' && acting_org.org_type !== 'network_service') {
    return { ok: false, status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' };
  }

  // 3. acting_as_user_id is required for both tiers when acting_org is present.
  if (!acting_as_user_id) {
    return { ok: false, status: 400, error: 'MISSING_ACTING_AS_USER_ID' };
  }

  // 4. User existence (both tiers need this).
  const userInfo = await lookup_user(acting_as_user_id);
  if (!userInfo) {
    return { ok: false, status: 404, error: 'USER_NOT_FOUND' };
  }

  // 5. Aggregator-only: enforce the onboarded_by_org_id === acting_org.org_id contract.
  if (acting_org.org_type === 'aggregator' && userInfo.onboardedByOrgId !== acting_org.org_id) {
    return { ok: false, status: 403, error: 'NOT_AUTHORIZED_FOR_TARGET' };
  }
  // network_service skips the onboarded_by check — unrestricted network-wide scope.

  return {
    ok: true,
    effective_user_id: acting_as_user_id,
    audit: {
      performed_by_org_id: acting_org.org_id,
      performed_by_service_user_id: acting_org.service_user_id,
    },
  };
};
```

### Error messages

Add `USER_NOT_FOUND` to `action_error_messages` with `'acting_as_user_id does not resolve to any user.'` and update the aggregator-only `NOT_AUTHORIZED_FOR_TARGET` message wording to clarify it applies after the user-existence check.

## Implementation outline

### Files

- **Modify:** `apps/api/src/routes/v1/action/_resolve_acting_actor.ts` — extend tier gate, rename `lookup_onboarded_by_org` → `lookup_user_for_acting`, add `USER_NOT_FOUND` to the verdict union + error message map, update branching order.
- **Modify:** `apps/api/src/routes/v1/action/__tests__/resolve_acting_actor.test.ts` — extend matrix to cover the two new network_service rows + the new USER_NOT_FOUND outcome for both tiers. Existing 10 tests stay; expect ~14 cases total.
- **Modify:** `apps/api/src/routes/v1/action/perform_action.ts` — call the renamed lookup helper (no other handler change; the helper does the work).
- **Modify:** `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts` — add 2-3 new route tests covering: network_service happy path, network_service + missing user → 404, network_service + user-exists-but-other-org-onboarded → 200 (verify the onboarded_by check is genuinely skipped).
- **Modify:** `packages/schemas/src/api/action_schemas.ts` — drop `acting_as_user_id` from `UpdateActionStatusBodySchema`.
- **Modify:** `apps/api/src/routes/v1/action/update_action_status.ts` — strip the `resolve_acting_actor` call, the audit-fields write in the UPDATE clause, the audit-overwrite WARN log. Replace with the self-acted ownership check.
- **Modify:** `apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts` — trim the on-behalf-of test cases; keep the happy-path + ownership-mismatch (now using `request.user.id` directly, not via the helper). Expect ~5 cases.
- **Modify:** `apps/api/src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts` — add a real-PG case where network_service onboards via `/admin/participant` then files an `/action/perform` on behalf of a user NOT onboarded by any aggregator (proving the network-wide scope). Remove or repurpose the update-status on-behalf-of case if present.
- **Modify:** `docs/operations/integrating-dpgs.md` — three-tier model explanation: aggregator (own users only) vs network_service (any user) vs voice (placeholder). Add the new `USER_NOT_FOUND` error code. Update the "Acting on behalf of a user" section.
- **Modify:** `docs/postman/Signals-DPG.postman_collection.json` — `07 Aggregator (on behalf of)` folder gains a sibling pair under `Apply on behalf of seeker (network_service)` using `{{network_service_api_key}}` + `{{network_service_org_id}}`. The "Accept on behalf of provider" request is restored to self-acted (or removed if it was only added for the on-behalf-of demonstration).
- **Modify:** `docs/postman/{Blue-Dots,Purple-Dots}.postman_environment.json` — `network_service_org_id` already exists from Plan C. No new env vars needed.

### Out-of-scope

- **PII masking on `/network/item/fetch`** — surfaced by the user as a follow-up need for the voice flow but explicitly deferred to a separate spec. The voice flow today receives unmasked items via `/network/item/fetch` (acceptable for the pilot; production deployment would need this resolved).
- **On-behalf-of `/item/fetch`** — same. A separate spec when PII masking lands and voice needs to read items as a specific seeker.
- **Voice-typed acting_org** — still rejected; no production rows exist. Future capability if the network model evolves.
- **Aggregator-tier per-service-user `member.permissions` allowlist** — same future-capability flag as Plan A.
- **Apikey-as-self ownership semantics on `/action/update-status`** — the current self-acted path uses `request.user.id`. If the caller is an apikey path (not a session cookie), `request.user.id` is the apikey owner — which is a service user, not a participant. The ownership check `existingAction.target_item_owner === request.user.id` would correctly fail for service apikeys (they don't own participant items). UI users (session cookie) and direct participants (apikey-as-self if they have one) would pass. This matches the pre-Plan-A behavior.

## Test plan

### Unit — `resolve_acting_actor.test.ts` (~14 cases)

Existing 10 stay. Add:

- network_service + new user → `USER_NOT_FOUND` (404).
- aggregator + new user (currently returns `NOT_AUTHORIZED_FOR_TARGET` since lookup is null; new behavior returns `USER_NOT_FOUND` first). Update the existing test that exercised this path.
- network_service + user exists, owned by another aggregator → ok (verify the onboarded_by check is skipped for network_service).
- network_service + user exists, self-registered (onboarded_by null) → ok (same — skipped).
- network_service + happy path → ok with audit columns populated with the network_service org_id.

Branch-order safety: keep the existing `lookup_user` not-called-when-body-field-missing test; extend to assert `lookup_user` IS called for network_service path.

### Unit — `perform_action.test.ts` (extend existing)

Add ~3 cases mirroring the resolver's network_service coverage at the route boundary. Existing cases keep the aggregator + self-acted matrix. Use the same isolation pattern Plan A established.

### Unit — `update_action_status.test.ts` (trim)

Existing on-behalf-of-flavored tests removed. Retain:
- Self-acted happy path (session, owner of target item).
- `ACTION_NOT_FOUND` for non-existent action_id.
- `NOT_TARGET_ITEM_OWNER` when `existingAction.target_item_owner !== request.user.id`.
- Schema validation: `acting_as_user_id` rejected by Zod (the field no longer exists in the schema).

### Integration — `on_behalf_of.integration.test.ts` (extend)

Add a case:
- Seed a user attributed to aggregator-A (via `/admin/participant`).
- Network_service apikey files `/action/perform` with `acting_as_user_id = that user`. Expect 201 + `performed_by_org_id = network_service_org_id`.

This proves the cross-aggregator scope that aggregator-tier rejects.

### Manual smoke

- Voice (network_service) creates an action on behalf of a self-registered user → expect success.
- Voice (network_service) creates an action with a user_id that doesn't exist → expect `404 USER_NOT_FOUND`.
- Participant (UI) updates status on their own action → unchanged; expect 200.
- Aggregator B (apikey) tries to file on behalf of aggregator A's user → unchanged 403.

## Open follow-ups (deferred)

1. **PII masking on `/network/item/fetch`** — and the on-behalf-of `/item/fetch` variant that lets voice fetch items as a specific seeker through the privacy filter.
2. **Voice-typed acting_org** — when product wants a separate tier for voice-hosted-by-aggregator deployments.
3. **Per-service-user `member.permissions` allowlist** — tighten which service users may assert which acting_org.
4. **Aggregator action lifecycle (counsellor-driven status updates)** — if/when product asks, restore on-behalf-of to `/action/update-status` or design a different surface.
5. **Apikey-as-self for participants** — if non-UI clients need to act as themselves (without an acting_org), the ownership semantics on `/action/update-status` need a clarifying contract.

---

## Spec self-review

- **Placeholder scan:** no TBD / TODO. Every behavior cell in the matrix is concrete. The "voice-typed org rejected" row is a documented placeholder, not an undecided requirement.
- **Internal consistency:** authorization matrix matches the helper's branch order step-by-step. The renamed lookup helper signature is consistent across the helper + the route handler import.
- **Scope check:** focused on two endpoints + one pure helper + a small Zod field removal. Implementation should fit comfortably in 6-8 tasks.
- **Ambiguity check:** the `network_service` "skip onboarded_by check" is explicit. The `USER_NOT_FOUND` for both tiers (vs collapsed-to-403 in Plan A) is explicit. The audit columns being create-time-only after this change is explicit.
- **Future migration:** voice moving to aggregator tier is documented as a zero-code-change path. Apikey-as-self on update-status is flagged as a deferred contract clarification rather than an undecided ambiguity in this spec.
