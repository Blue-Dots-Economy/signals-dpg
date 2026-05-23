# Action Perform & Update-Status — On-Behalf-Of (Aggregator)

**Status:** implemented (Plan A PR #13). Spec re-scoped 2026-05-23 — original voice-typed assumption removed; see "Scope reset" note below.
**Author:** brainstorming session, 2026-05-22; scope reset by user direction, 2026-05-23.
**Related:** Plan 1 (acting_org preHandler), Plan 3 (metrics recompute)

## Scope reset (2026-05-23)

The original 2026-05-22 spec was written around a future `voice`-typed acting org. In production no `voice`-typed organization rows are being created — the only `organization.type` values that exist are `network_service` (the DPG platform service identities seeded via `seed_service_users.ts`) and `aggregator` (real aggregators created via `/admin/aggregator/upsert`). The on-behalf-of party in the production model is the **aggregator**, with the call originating from a `network_service`-typed service apikey (`aggregator-dpg` / `voice-dpg` service users, both of which belong to `network_service`-typed orgs even though their slugs reference voice).

This spec was reworded throughout to reflect that. The semantics are unchanged; the only delta is the allowed `acting_org.org_type` (`voice` → `aggregator`) and the wording in supporting prose.

## Goal

Let a `network_service` apikey caller file actions (`/action/perform`) and update action status (`/action/update-status`) on behalf of users an aggregator onboarded, via apikey + `x-acting-org-id` (pointing at an aggregator org) + an `acting_as_user_id` body field. Today these endpoints only support self-acted calls (the caller's `request.user.id` becomes the action's owner), which means service-driven actions are attributed to the DPG service account rather than the user — breaking metrics, audit, and the dashboard's per-participant counts.

## Why now

The aggregator-dpg / voice-dpg services need to file actions (apply / accept / reject) on behalf of users that aggregators onboarded. Without on-behalf-of support, those actions are attributed to the DPG service account, breaking Plan 3's per-participant metrics. The aggregator is the conceptual party "on whose behalf" the call is made — even when the call is driven by a voice flow, the aggregator is the org that owns the user and the apikey acts as that aggregator's mediator.

## Authorization matrix

Both routes (`POST /api/v1/action/perform`, `POST /api/v1/action/update-status`) accept an optional `acting_as_user_id` in the body. The combination of `x-acting-org-id` header presence + body field + acting_org type determines the outcome:

| Caller shape | `acting_as_user_id` | Outcome |
|---|---|---|
| Session cookie (self), no `x-acting-org-id` | absent | Self-attribution — unchanged from today |
| Session cookie, no `x-acting-org-id` | present | **400 CANNOT_OVERRIDE_SELF** |
| Apikey + no `x-acting-org-id` (service apikey acting as itself) | absent | Self-attribution — unchanged |
| Apikey + no `x-acting-org-id` | present | **400 CANNOT_OVERRIDE_SELF** |
| Apikey + `x-acting-org-id`, `org_type='aggregator'` | **absent** | **400 MISSING_ACTING_AS_USER_ID** — header signalled intent to act on behalf, body didn't name the target |
| Apikey + `x-acting-org-id`, `org_type='aggregator'` | present, target's `user.onboarded_by_org_id === acting_org.org_id` | **200** — action attributed to target user; audit columns populated |
| Apikey + `x-acting-org-id`, `org_type='aggregator'` | present, target NOT onboarded by this aggregator | **403 NOT_AUTHORIZED_FOR_TARGET** |
| Apikey + `x-acting-org-id`, `org_type='voice'` | any | **403 ACTING_ORG_TYPE_NOT_ALLOWED** — voice-typed orgs are not created in production today |
| Apikey + `x-acting-org-id`, `org_type='network_service'` | any | **403 ACTING_ORG_TYPE_NOT_ALLOWED** — the DPG platform does not act on behalf of users |

The "onboarded by this aggregator" check is `user.onboarded_by_org_id === acting_org.org_id`. The channel value (`user.onboarded_via`) is NOT part of the check — a user onboarded via `bulk` or `voice` channel can be acted for through this endpoint regardless.

## Schema changes

`item_actions` gains two nullable columns capturing the on-behalf-of audit trail:

| Column | Type | Constraint | Purpose |
|---|---|---|---|
| `performed_by_org_id` | `text` | FK → `organization(id)`, no cascade | The acting aggregator org that filed the action |
| `performed_by_service_user_id` | `text` | FK → `user(id)`, no cascade | The DPG service account user (the apikey owner) |

Both NULL for self-acted actions. Both populated for on-behalf-of actions.

No cascade on either FK — audit trail survives deletion of the aggregator org or the service user (the action history is the source of truth for "this seeker had an apply filed by aggregator-X via service-user-Y on date Z").

No indexes on these columns in this PR. Add later if audit queries become a hot path.

### Three sources updated together

Plan 4 A.3's CI parity check fails if any of these diverge:

1. **Drizzle reference**: `packages/database/src/drizzle_ref_tables/item_actions.ts`.
2. **Idempotent SQL bundle**: `packages/database/src/utils/sql_scripts/create_actions_events.sql` — add the two columns to the `CREATE TABLE item_actions` block AND emit `ALTER TABLE item_actions ADD COLUMN IF NOT EXISTS` for upgrade paths. Add the FK constraints in DO blocks per the file's convention.
3. **Helm bundle**: regenerated via `pnpm schema:bundle` (actual output path: `helmcharts/dpg/charts/api/files/schema.sql`).

## Wiring

Plan 1's `acting_org_preHandler` requires the `x-acting-org-id` header (returns 400 if missing). Mounting it directly on `/api/v1/action/*` would break self-acted calls.

Introduce an **optional variant**: `acting_org_preHandler_optional` in `apps/api/src/middleware/acting_org_optional.ts`. Behavior:

- If `x-acting-org-id` header is absent → set `request.acting_org = undefined`, return immediately.
- If present → delegate to the existing strict `acting_org_preHandler`.

Mount this optional variant on `/api/v1/action/*` AFTER the route's `auth_middleware_if_enabled` so `request.user` is populated by the time the optional preHandler runs (preHandler-ordering bug caught + fixed in implementation; see PR #13 commit `e05d341`).

The route handler then branches on `request.acting_org`:

- Present + `org_type === 'aggregator'` → enforce the body-field rules + target-user authorization
- Present + other type (`voice` / `network_service`) → 403 ACTING_ORG_TYPE_NOT_ALLOWED
- Absent → self-acted, attribute to `request.user.id`

The new preHandler is reusable for any future route that wants opt-in acting_org context.

## Behavior detail — what changes inside the route handlers

`POST /api/v1/action/perform`:

1. Resolve effective actor via `resolve_acting_actor` helper:
   - If `request.acting_org` present + `org_type === 'aggregator'` + `acting_as_user_id` provided + authorized → `effective_user_id = acting_as_user_id`
   - Otherwise → either `effective_user_id = request.user.id` (self) or a typed error
2. Validate `source_item.created_by === effective_user_id` — the source item must belong to whoever is "performing" the action; else `403 SOURCE_ITEM_NOT_OWNED_BY_ACTOR`.
3. Forward to the downstream `/network/action/perform` handler with:
   - `source_item_owner = effective_user_id` (this is what Plan 3's recompute filters by)
   - `performed_by_org_id = acting_org?.org_id ?? null`
   - `performed_by_service_user_id = acting_org?.service_user_id ?? null`
4. Target instance writes the `item_actions` row with the audit columns populated.

`POST /api/v1/action/update-status`:

1. Look up the action by `action_id`.
2. Same effective-actor resolution as above.
3. Validate `existingAction.target_item_owner === effective_user_id` (the provider whose item received the apply); else `403 TARGET_ITEM_NOT_OWNED_BY_ACTOR`.
4. Update the row, also setting `performed_by_org_id` + `performed_by_service_user_id` from the resolved actor's audit struct. (For status changes, the LATEST on-behalf-of actor is captured. Earlier actors' attribution is lost; acceptable for pilot.)

If the update-status row already had audit fields populated and a DIFFERENT aggregator is updating it, the newest values overwrite. Logged at WARN level with `acting_org_id`, previous + new `performed_by_org_id`, for ops visibility.

## Implementation plan files

See `docs/superpowers/plans/2026-05-22-action-perform-on-behalf-of.md`. The plan was executed via `superpowers:subagent-driven-development` and landed as PR #13 (chore/plan-a-action-on-behalf-of → feat/api-refactor).

## Out of scope

- **Voice-typed on-behalf-of.** No voice-typed organization rows exist in production. If they're ever introduced (e.g. for cross-instance voice trust), extend the org_type allowlist from `=== 'aggregator'` to `in ['aggregator', 'voice']` and revisit the authorization rule (probably still `onboarded_by_org_id === acting_org.org_id`).
- **Per-service-user allowlist.** Today any service user that's a member of any org can assert any aggregator as acting_org. Tightening to "service user X can only act for orgs Y and Z" lives in better-auth's `member.permissions` text column — out of pilot. Add the check between the org-lookup and the existing onboarded_by check.
- **Cross-aggregator target lookup.** Today's check is `onboarded_by_org_id === acting_org.org_id`. If an aggregator needs to act for users onboarded by another aggregator (e.g. company merger), we'd need a permission system. Out of pilot.
- **Audit query endpoint.** No new route to "show all actions filed by org X" today. The two columns make it queryable via direct SQL; surfaces in a UI when product asks.
- **Indexes on the audit columns.** Add later if audit queries become hot.
- **Updating earlier actions filed without audit.** New columns are NULL on existing rows; backfill is not needed (pre-feature actions were all self-acted by definition).
- **Action_state schema validation for on-behalf-of actions.** The `requirements_snapshot` and `action_state` fields work the same regardless of caller — no per-caller-type schema variation.
- **Rate limiting on on-behalf-of.** Service apikeys are trusted today (`rateLimitEnabled: false` per Plan 1 seed). Revisit if abuse pattern emerges.

## Test plan

The failing-tests-then-implementation cycle covers each row of the authorization matrix. Approximately 14 cases across the two routes:

- Self-acted (no header, no body field) — 2 cases (perform + update-status), unchanged behavior asserted.
- Header but no body field — 2 cases × 400 MISSING_ACTING_AS_USER_ID.
- Body field but no header — 2 cases × 400 CANNOT_OVERRIDE_SELF.
- Aggregator org + own user — 2 cases × 200, audit columns populated, source_item_owner = target.
- Aggregator org + other aggregator's user — 2 cases × 403 NOT_AUTHORIZED_FOR_TARGET.
- Voice org type — 2 cases × 403 ACTING_ORG_TYPE_NOT_ALLOWED.
- Network_service org type — 2 cases × 403 ACTING_ORG_TYPE_NOT_ALLOWED.
- Source / target item ownership mismatch — 2 cases × 403 SOURCE_ITEM_NOT_OWNED_BY_ACTOR / TARGET_ITEM_NOT_OWNED_BY_ACTOR.

Plus one integration test against a real Postgres that:
1. Seeds two aggregator orgs + service users + apikeys (directly via Drizzle — the seed script only creates `network_service`-typed service orgs).
2. Onboards a user attributed to aggregator A.
3. Files an action via aggregator A's acting_org → asserts 201 + `item_actions` audit columns populated.
4. Files an action via aggregator B targeting aggregator A's user → asserts 403 NOT_AUTHORIZED_FOR_TARGET.

## Postman collection update

After implementation lands:

- "07 Aggregator (on behalf of)" folder gains "Apply on behalf of seeker" — POST /action/perform with `{{aggregator_api_key}}` + `{{aggregator_org_id}}` + `acting_as_user_id`.
- Same folder gains "Accept on behalf of provider" — same shape on /update-status.

## Open follow-ups (deferred)

- Voice-typed on-behalf-of (if/when voice orgs are introduced).
- Per-service-user `member.permissions` allowlist.
- Audit query endpoint.
- Indexes on audit columns.
- Cross-aggregator target lookup (cross-instance trust model).

---

## Spec self-review

- **Placeholder scan**: no TBD / TODO. Each "investigate during implementation" call-out is a concrete grep, not a hand-wave.
- **Internal consistency**: authorization matrix covers all combinations of `(header present, body field present, org type)`. The wiring section (optional preHandler) matches the route-handler logic in the behavior detail. Schema additions referenced consistently across schema section + behavior detail + test plan.
- **Scope check**: focused on the two routes + two columns + one new preHandler wrapper + a pure helper. Implementation fit in 8 tasks; single coherent PR (#13).
- **Ambiguity check**: "cross-aggregator target lookup" called out as out-of-scope so it's not implicitly answered either way. The `onboarded_by_org_id === acting_org.org_id` check is the only authorization rule; documented explicitly.
- **Scope reset**: the 2026-05-23 voice → aggregator flip is documented in this spec, the plan file, and memory. Code, tests, docs, and Postman were updated in the same PR as a coherent commit (`b2a97d5`).
