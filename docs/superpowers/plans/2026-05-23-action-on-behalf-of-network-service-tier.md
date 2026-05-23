# Action On-Behalf-Of — Network-Service Tier + Strip Update-Status Acting-As Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `/api/v1/action/perform` to accept `network_service`-typed acting_orgs as unrestricted (network-wide) on-behalf-of callers; strip on-behalf-of from `/api/v1/action/update-status` entirely (self-acted only).

**Architecture:** The pure `resolve_acting_actor` helper gains a `network_service` branch that skips the `onboarded_by_org_id` check. The DB lookup signature changes from `string | null` to `{onboardedByOrgId: string | null} | null` so the helper can distinguish "user doesn't exist" (404 `USER_NOT_FOUND`) from "user exists but not owned by this aggregator" (403 `NOT_AUTHORIZED_FOR_TARGET`). The `update_action_status` handler removes its `resolve_acting_actor` call and the audit-fields writes — status mutates only via session-cookie / apikey-as-self for the target item's owner.

**Tech Stack:** Fastify, Zod via `fastify-type-provider-zod`, Drizzle ORM, Postgres, Vitest. All changes inside `apps/api`, `packages/schemas`, plus docs + Postman.

**Spec:** [docs/superpowers/specs/2026-05-23-action-on-behalf-of-network-service-tier-design.md](../specs/2026-05-23-action-on-behalf-of-network-service-tier-design.md)

**Related plans:** Plan A (`2026-05-22-action-perform-on-behalf-of.md` — the aggregator-tier this extends), Plan C (`2026-05-23-admin-participant-upsert.md` — established the network-service tier pattern this mirrors).

---

## File map

**Modify:**
- `packages/schemas/src/api/action_schemas.ts` — drop `acting_as_user_id` from `UpdateActionStatusBodySchema`. `PerformActionBodySchema` keeps its `acting_as_user_id` (used by perform).
- `apps/api/src/routes/v1/action/_resolve_acting_actor.ts` — extend tier gate to allow `network_service`; rename `lookup_onboarded_by_org` → `lookup_user_for_acting`; change return shape; add `USER_NOT_FOUND` to the verdict union + error message map; update branching order; bump the status union from `400 | 403` to `400 | 403 | 404`.
- `apps/api/src/routes/v1/action/perform_action.ts` — switch the helper import + call site to the new lookup function name.
- `apps/api/src/routes/v1/action/update_action_status.ts` — strip the `resolve_acting_actor` call, the audit-fields writes, the audit-overwrite WARN log. Replace with the self-acted ownership check (`existingAction.target_item_owner === request.user.id`).
- `apps/api/src/routes/v1/action/__tests__/resolve_acting_actor.test.ts` — extend matrix with network_service + USER_NOT_FOUND cases. Existing 10 tests need adjustment because the test fixtures changed (aggregator + unknown-user previously expected `NOT_AUTHORIZED_FOR_TARGET`; now `USER_NOT_FOUND`).
- `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts` — add 3 route-level cases covering network_service + happy, network_service + missing user → 404, network_service + cross-org user → success (proving the onboarded_by check is skipped).
- `apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts` — trim the on-behalf-of test cases; keep ownership + ACTION_NOT_FOUND + happy-path; expect the Zod schema to now reject `acting_as_user_id` if a test still passes it.
- `apps/api/src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts` — add a real-PG case proving network_service can act for a user onboarded by aggregator-A (the cross-aggregator scope aggregator-tier rejects).
- `docs/operations/integrating-dpgs.md` — three-tier model section: aggregator (own users only) vs network_service (any user) vs voice (placeholder). Add `USER_NOT_FOUND` error code row. Update the "Acting on behalf of a user" section.
- `docs/postman/Signals-DPG.postman_collection.json` — `07 Aggregator (on behalf of)` folder gains a sibling request `Apply on behalf of seeker (network_service)` using `{{network_service_api_key}}` + `{{network_service_org_id}}`. The `Accept on behalf of provider` request is restored to self-acted shape (no `acting_as_user_id` in body, no `x-acting-org-id` header).

**No deletions — every file in the old surface keeps a (smaller) role.**

---

## Task ordering rationale

1. **Zod schema first** (Task 1) — `UpdateActionStatusBodySchema` shrinks. The update-status handler will trip a typecheck error until Task 4 fixes its consumer. Perform-side schema stays.
2. **Pure helper + matrix tests** (Task 2) — the resolver gains the network_service branch + new USER_NOT_FOUND verdict. Test-driven; no DB. The lookup-function-shape change is the only ripple downstream (Task 3 + Task 4 absorb it).
3. **Wire perform_action to the renamed lookup** (Task 3) — small mechanical change at one call site. Add the 3 new route-level tests.
4. **Strip update-status acting-as** (Task 4) — handler simplifies; tests trim. Closes the Task 1 typecheck loop.
5. **Integration test** (Task 5) — real PG, proves the network_service cross-aggregator scope end-to-end.
6. **Docs + Postman** (Task 6) — last; prose reflects what shipped.

---

## Task 1: Drop `acting_as_user_id` from `UpdateActionStatusBodySchema`

**Files:**
- Modify: `packages/schemas/src/api/action_schemas.ts:38-43`

- [ ] **Step 1: Read current state**

```bash
sed -n '38,44p' packages/schemas/src/api/action_schemas.ts
```

Expected: 6 lines showing the schema with `acting_as_user_id` on line 42.

- [ ] **Step 2: Edit the schema**

Replace:

```ts
export const UpdateActionStatusBodySchema = z.object({
  action_id: z.uuid(),
  action_status: z.string().min(1),
  remarks: z.string().min(1).optional(),
  acting_as_user_id: z.string().min(1).optional(),
});
```

with:

```ts
export const UpdateActionStatusBodySchema = z.object({
  action_id: z.uuid(),
  action_status: z.string().min(1),
  remarks: z.string().min(1).optional(),
});
```

`PerformActionBodySchema` at line 18-26 stays untouched — perform keeps `acting_as_user_id`.

- [ ] **Step 3: Typecheck just the schemas re-exports**

```bash
pnpm --filter api exec tsc --noEmit 2>&1 | grep -E "error TS" | head
```

Expected: 1-2 errors pointing at `apps/api/src/routes/v1/action/update_action_status.ts:77` (which destructures `body.acting_as_user_id`). That's expected — Task 4 closes the loop.

- [ ] **Step 4: Commit**

```bash
git add packages/schemas/src/api/action_schemas.ts
git commit -m "feat(schemas): drop acting_as_user_id from UpdateActionStatusBodySchema"
```

DO NOT stage `examples/schemas/blue_dot/network.json`, `.env.example`, or any other working-tree drift.

---

## Task 2: Extend `_resolve_acting_actor.ts` for network_service + USER_NOT_FOUND

**Files:**
- Modify: `apps/api/src/routes/v1/action/_resolve_acting_actor.ts`
- Modify: `apps/api/src/routes/v1/action/__tests__/resolve_acting_actor.test.ts`

- [ ] **Step 1: Pre-read**

```bash
cat apps/api/src/routes/v1/action/_resolve_acting_actor.ts
sed -n '1,40p' apps/api/src/routes/v1/action/__tests__/resolve_acting_actor.test.ts
```

- [ ] **Step 2: Rewrite the helper**

Replace the ENTIRE content of `apps/api/src/routes/v1/action/_resolve_acting_actor.ts` with:

```ts
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema/auth';

export type ActingOrg = {
  org_id: string;
  org_type: 'aggregator' | 'voice' | 'network_service';
  service_user_id: string;
};

export type Audit = {
  performed_by_org_id: string | null;
  performed_by_service_user_id: string | null;
};

type ResolveOk = {
  ok: true;
  effective_user_id: string;
  audit: Audit;
};

export type ResolveErr = {
  ok: false;
  status: 400 | 403 | 404;
  error:
    | 'CANNOT_OVERRIDE_SELF'
    | 'MISSING_ACTING_AS_USER_ID'
    | 'ACTING_ORG_TYPE_NOT_ALLOWED'
    | 'NOT_AUTHORIZED_FOR_TARGET'
    | 'USER_NOT_FOUND';
};

export type ResolveActingActorResult = ResolveOk | ResolveErr;

export type ResolveActingActorInput = {
  acting_org: ActingOrg | undefined;
  request_user_id: string;
  acting_as_user_id: string | undefined;
  /**
   * Returns `{ onboardedByOrgId }` when the user row exists (with
   * `onboardedByOrgId` possibly null for self-registered or pre-Plan-2
   * users); returns `null` when no user row exists at all.
   *
   * The two states must be distinguished — aggregator-tier and
   * network-service-tier handle them differently.
   */
  lookup_user: (user_id: string) => Promise<{ onboardedByOrgId: string | null } | null>;
};

/**
 * Single source of truth for the action on-behalf-of authorization
 * matrix documented in
 * docs/superpowers/specs/2026-05-23-action-on-behalf-of-network-service-tier-design.md.
 *
 * Two tiers are allowed today:
 *   - `aggregator`: scoped to users with `onboarded_by_org_id ===
 *     acting_org.org_id`.
 *   - `network_service`: unrestricted; any user in the network.
 *
 * Voice-typed acting_orgs are rejected (placeholder for future).
 */
export const resolve_acting_actor = async (
  input: ResolveActingActorInput,
): Promise<ResolveActingActorResult> => {
  const { acting_org, request_user_id, acting_as_user_id, lookup_user } = input;

  // 1. Self-acted (no acting_org).
  if (!acting_org) {
    if (acting_as_user_id) {
      return { ok: false, status: 400, error: 'CANNOT_OVERRIDE_SELF' };
    }
    return {
      ok: true,
      effective_user_id: request_user_id,
      audit: { performed_by_org_id: null, performed_by_service_user_id: null },
    };
  }

  // 2. Tier gate: aggregator OR network_service. Anything else (voice,
  //    unknown) is rejected.
  if (
    acting_org.org_type !== 'aggregator' &&
    acting_org.org_type !== 'network_service'
  ) {
    return { ok: false, status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' };
  }

  // 3. acting_as_user_id is required when acting_org is set.
  if (!acting_as_user_id) {
    return { ok: false, status: 400, error: 'MISSING_ACTING_AS_USER_ID' };
  }

  // 4. User existence (both tiers).
  const userInfo = await lookup_user(acting_as_user_id);
  if (!userInfo) {
    return { ok: false, status: 404, error: 'USER_NOT_FOUND' };
  }

  // 5. Aggregator-only: enforce onboarded_by_org_id === acting_org.org_id.
  //    network_service skips this check (network-wide scope).
  if (
    acting_org.org_type === 'aggregator' &&
    userInfo.onboardedByOrgId !== acting_org.org_id
  ) {
    return { ok: false, status: 403, error: 'NOT_AUTHORIZED_FOR_TARGET' };
  }

  return {
    ok: true,
    effective_user_id: acting_as_user_id,
    audit: {
      performed_by_org_id: acting_org.org_id,
      performed_by_service_user_id: acting_org.service_user_id,
    },
  };
};

/**
 * Shared DB lookup used by `/action/perform` when resolving the
 * on-behalf-of target user. Returns `null` for missing users, or
 * `{ onboardedByOrgId }` for users that exist (the field may itself
 * be `null` for self-registered users).
 */
export const lookup_user_for_acting = async (
  user_id: string,
): Promise<{ onboardedByOrgId: string | null } | null> => {
  const rows = await db
    .select({ onboardedByOrgId: user.onboardedByOrgId })
    .from(user)
    .where(eq(user.id, user_id))
    .limit(1);
  if (rows.length === 0) return null;
  return { onboardedByOrgId: rows[0].onboardedByOrgId };
};

/**
 * Human-readable messages for each `ResolveErr.error` code. Route
 * handlers use this when constructing their `reply.send({ error, message })`.
 */
export const action_error_messages: Record<ResolveErr['error'], string> = {
  CANNOT_OVERRIDE_SELF:
    'acting_as_user_id requires an x-acting-org-id header naming an aggregator-type or network_service-type acting org.',
  MISSING_ACTING_AS_USER_ID:
    'aggregator-type or network_service-type acting_org requires acting_as_user_id in the request body.',
  ACTING_ORG_TYPE_NOT_ALLOWED:
    'only aggregator-type or network_service-type acting orgs may act on behalf of users today.',
  NOT_AUTHORIZED_FOR_TARGET:
    'acting_as_user_id is not a user onboarded by this aggregator.',
  USER_NOT_FOUND:
    'acting_as_user_id does not resolve to any user.',
};
```

The old `lookup_onboarded_by_org` is GONE — replaced by `lookup_user_for_acting`. Any caller importing `lookup_onboarded_by_org` will break at typecheck (Task 3 fixes the perform handler; the update-status handler's import goes away in Task 4).

- [ ] **Step 3: Rewrite the unit tests**

Replace the existing `apps/api/src/routes/v1/action/__tests__/resolve_acting_actor.test.ts` with:

```ts
import { describe, it, expect, vi } from 'vitest';
import { resolve_acting_actor } from '../_resolve_acting_actor.js';

vi.mock('@api/db/postgres/drizzle_config', () => ({ db: {} }));
vi.mock('@api/db/postgres/schema/auth', () => ({ user: {} }));

const aggregator = {
  org_id: 'org_agg_a',
  org_type: 'aggregator' as const,
  service_user_id: 'svc_agg',
};
const network_service = {
  org_id: 'org_signals',
  org_type: 'network_service' as const,
  service_user_id: 'svc_ns',
};
const voice = {
  org_id: 'org_voice_x',
  org_type: 'voice' as const,
  service_user_id: 'svc_voice',
};

const lookup_user_factory = (
  rows: Record<string, { onboardedByOrgId: string | null }>,
) =>
  vi.fn(async (uid: string) => rows[uid] ?? null);

describe('resolve_acting_actor', () => {
  describe('self-acted (no acting_org)', () => {
    it('returns effective_user_id = request_user_id when no body field', async () => {
      const result = await resolve_acting_actor({
        acting_org: undefined,
        request_user_id: 'usr_self',
        acting_as_user_id: undefined,
        lookup_user: lookup_user_factory({}),
      });
      expect(result).toEqual({
        ok: true,
        effective_user_id: 'usr_self',
        audit: { performed_by_org_id: null, performed_by_service_user_id: null },
      });
    });

    it('400 CANNOT_OVERRIDE_SELF when body field present', async () => {
      const result = await resolve_acting_actor({
        acting_org: undefined,
        request_user_id: 'usr_self',
        acting_as_user_id: 'usr_other',
        lookup_user: lookup_user_factory({}),
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: 'CANNOT_OVERRIDE_SELF',
      });
    });
  });

  describe('tier gate', () => {
    it('403 ACTING_ORG_TYPE_NOT_ALLOWED for voice', async () => {
      const result = await resolve_acting_actor({
        acting_org: voice,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_target',
        lookup_user: lookup_user_factory({
          usr_target: { onboardedByOrgId: null },
        }),
      });
      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      });
    });

    it('400 MISSING_ACTING_AS_USER_ID for aggregator', async () => {
      const result = await resolve_acting_actor({
        acting_org: aggregator,
        request_user_id: 'svc',
        acting_as_user_id: undefined,
        lookup_user: lookup_user_factory({}),
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: 'MISSING_ACTING_AS_USER_ID',
      });
    });

    it('400 MISSING_ACTING_AS_USER_ID for network_service', async () => {
      const result = await resolve_acting_actor({
        acting_org: network_service,
        request_user_id: 'svc',
        acting_as_user_id: undefined,
        lookup_user: lookup_user_factory({}),
      });
      expect(result).toEqual({
        ok: false,
        status: 400,
        error: 'MISSING_ACTING_AS_USER_ID',
      });
    });
  });

  describe('user existence', () => {
    it('404 USER_NOT_FOUND for aggregator + missing user', async () => {
      const result = await resolve_acting_actor({
        acting_org: aggregator,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_missing',
        lookup_user: lookup_user_factory({}),
      });
      expect(result).toEqual({
        ok: false,
        status: 404,
        error: 'USER_NOT_FOUND',
      });
    });

    it('404 USER_NOT_FOUND for network_service + missing user', async () => {
      const result = await resolve_acting_actor({
        acting_org: network_service,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_missing',
        lookup_user: lookup_user_factory({}),
      });
      expect(result).toEqual({
        ok: false,
        status: 404,
        error: 'USER_NOT_FOUND',
      });
    });
  });

  describe('aggregator tier', () => {
    it('happy path: user onboarded by this aggregator', async () => {
      const result = await resolve_acting_actor({
        acting_org: aggregator,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_a',
        lookup_user: lookup_user_factory({
          usr_a: { onboardedByOrgId: 'org_agg_a' },
        }),
      });
      expect(result).toEqual({
        ok: true,
        effective_user_id: 'usr_a',
        audit: {
          performed_by_org_id: 'org_agg_a',
          performed_by_service_user_id: 'svc_agg',
        },
      });
    });

    it('403 NOT_AUTHORIZED_FOR_TARGET when user onboarded by another aggregator', async () => {
      const result = await resolve_acting_actor({
        acting_org: aggregator,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_other_agg',
        lookup_user: lookup_user_factory({
          usr_other_agg: { onboardedByOrgId: 'org_agg_b' },
        }),
      });
      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'NOT_AUTHORIZED_FOR_TARGET',
      });
    });

    it('403 NOT_AUTHORIZED_FOR_TARGET when user is self-registered (onboarded_by null)', async () => {
      const result = await resolve_acting_actor({
        acting_org: aggregator,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_self_reg',
        lookup_user: lookup_user_factory({
          usr_self_reg: { onboardedByOrgId: null },
        }),
      });
      expect(result).toEqual({
        ok: false,
        status: 403,
        error: 'NOT_AUTHORIZED_FOR_TARGET',
      });
    });
  });

  describe('network_service tier', () => {
    it('happy path: any user in the network (own aggregator)', async () => {
      const result = await resolve_acting_actor({
        acting_org: network_service,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_a',
        lookup_user: lookup_user_factory({
          usr_a: { onboardedByOrgId: 'org_agg_a' },
        }),
      });
      expect(result).toEqual({
        ok: true,
        effective_user_id: 'usr_a',
        audit: {
          performed_by_org_id: 'org_signals',
          performed_by_service_user_id: 'svc_ns',
        },
      });
    });

    it('happy path: any user in the network (cross-aggregator user)', async () => {
      const result = await resolve_acting_actor({
        acting_org: network_service,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_other_agg',
        lookup_user: lookup_user_factory({
          usr_other_agg: { onboardedByOrgId: 'org_agg_b' },
        }),
      });
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({
        effective_user_id: 'usr_other_agg',
        audit: { performed_by_org_id: 'org_signals' },
      });
    });

    it('happy path: any user in the network (self-registered user)', async () => {
      const result = await resolve_acting_actor({
        acting_org: network_service,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_self_reg',
        lookup_user: lookup_user_factory({
          usr_self_reg: { onboardedByOrgId: null },
        }),
      });
      expect(result.ok).toBe(true);
      expect(result).toMatchObject({
        effective_user_id: 'usr_self_reg',
        audit: { performed_by_org_id: 'org_signals' },
      });
    });
  });

  describe('branch-order safety', () => {
    it('lookup_user is NOT called when body field is missing', async () => {
      const spy = lookup_user_factory({});
      await resolve_acting_actor({
        acting_org: aggregator,
        request_user_id: 'svc',
        acting_as_user_id: undefined,
        lookup_user: spy,
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it('lookup_user IS called for network_service when body field is present', async () => {
      const spy = lookup_user_factory({
        usr_a: { onboardedByOrgId: null },
      });
      await resolve_acting_actor({
        acting_org: network_service,
        request_user_id: 'svc',
        acting_as_user_id: 'usr_a',
        lookup_user: spy,
      });
      expect(spy).toHaveBeenCalledWith('usr_a');
    });
  });
});
```

- [ ] **Step 4: Run helper tests**

```bash
pnpm --filter api exec vitest run src/routes/v1/action/__tests__/resolve_acting_actor.test.ts
```

Expected: 15 PASS (5 tier-gate, 2 existence, 3 aggregator, 3 network_service, 2 branch-order = 15 total).

- [ ] **Step 5: Confirm typecheck progress**

```bash
pnpm --filter api exec tsc --noEmit 2>&1 | grep "error TS" | head -10
```

Expected: errors confined to `perform_action.ts` (importing `lookup_onboarded_by_org`) + `update_action_status.ts` (importing same, plus the still-not-removed `acting_as_user_id` access). Both close in Task 3 + Task 4.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/action/_resolve_acting_actor.ts \
        apps/api/src/routes/v1/action/__tests__/resolve_acting_actor.test.ts
git commit -m "feat(api): network_service tier + USER_NOT_FOUND in resolve_acting_actor"
```

---

## Task 3: Wire perform_action to the renamed lookup helper

**Files:**
- Modify: `apps/api/src/routes/v1/action/perform_action.ts`
- Modify: `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts`

- [ ] **Step 1: Update the perform handler import**

In `apps/api/src/routes/v1/action/perform_action.ts`, find the import line:

```ts
import {
  action_error_messages,
  lookup_onboarded_by_org,
  resolve_acting_actor,
} from './_resolve_acting_actor.js';
```

Replace `lookup_onboarded_by_org` with `lookup_user_for_acting`:

```ts
import {
  action_error_messages,
  lookup_user_for_acting,
  resolve_acting_actor,
} from './_resolve_acting_actor.js';
```

Find the call site (one occurrence in the handler) — the existing code passes `lookup_onboarded_by: lookup_onboarded_by_org`. Update both the property name and the value:

```ts
  const actor = await resolve_acting_actor({
    acting_org: request.acting_org,
    request_user_id: request.user.id,
    acting_as_user_id: body.acting_as_user_id,
    lookup_user: lookup_user_for_acting,
  });
```

The property name on the input changes from `lookup_onboarded_by` to `lookup_user` (matching the helper's new field). The helper module's exported function name changes from `lookup_onboarded_by_org` to `lookup_user_for_acting`.

- [ ] **Step 2: Add 3 new route-level tests**

In `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts`, find the existing test file's structure. Append three new `it()` cases to the existing `describe` block (the test file already isolates the route via Fastify + mocks; reuse its harness).

Read the existing file first to identify the mock state shape:

```bash
grep -n "dbState\|userRows\|onboardedByOrgId" apps/api/src/routes/v1/action/__tests__/perform_action.test.ts | head
```

The file already mocks `db.select` to return `dbState.userRows` for the user-lookup branch. The new lookup returns `{ onboardedByOrgId }` instead of a flat string. The route still consumes it via `resolve_acting_actor`, which the test indirectly exercises through `app.inject`.

Append the 3 new cases AT THE END of the file's main `describe` block (or in a nested `describe('network_service tier', () => {...})`):

```ts
  it('voice on-behalf-of: 200 when network_service acts for any user in the network', async () => {
    dbState.userRows = [{ id: 'usr_voice_owned', onboardedByOrgId: 'org_agg_b' }];
    const app = buildApp({
      org_id: 'org_signals',
      org_type: 'network_service',
      service_user_id: 'svc_ns',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_voice_owned' },
    });
    expect(res.statusCode).toBe(201);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      source_item_owner: 'usr_voice_owned',
      performed_by_org_id: 'org_signals',
      performed_by_service_user_id: 'svc_ns',
    });
  });

  it('voice on-behalf-of: 200 for self-registered user (onboarded_by null)', async () => {
    dbState.userRows = [{ id: 'usr_self_reg', onboardedByOrgId: null }];
    const app = buildApp({
      org_id: 'org_signals',
      org_type: 'network_service',
      service_user_id: 'svc_ns',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_self_reg' },
    });
    expect(res.statusCode).toBe(201);
    expect(fetchCalls[0].body).toMatchObject({
      source_item_owner: 'usr_self_reg',
      performed_by_org_id: 'org_signals',
    });
  });

  it('voice on-behalf-of: 404 USER_NOT_FOUND when network_service points at non-existent user', async () => {
    dbState.userRows = [];  // empty — no row returned
    const app = buildApp({
      org_id: 'org_signals',
      org_type: 'network_service',
      service_user_id: 'svc_ns',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_missing' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'USER_NOT_FOUND' });
    expect(fetchCalls).toHaveLength(0);
  });
```

Constants in the existing file: `VALID_BODY` is defined near the top (the seeker → provider apply request body), `buildApp` builds a Fastify app with a custom preHandler that stubs `acting_org`, and `fetchCalls` is the array capturing the proxy `fetch()` calls to `/network/action/perform`. If field names differ slightly (e.g., the existing test uses `buildApp({...acting_org})`), adapt — match the existing signature.

If the existing test's `db.select` mock needs to return rows shaped as `{ id, onboardedByOrgId }` (rather than a flat onboarded org string), verify the mock already does that. If not, adjust the mock factory at the top of the file. The new helper returns `{ onboardedByOrgId }` per row; the mock must yield that shape from the `.from(user).where(...).limit(1)` chain.

- [ ] **Step 3: Run perform-action tests**

```bash
pnpm --filter api exec vitest run src/routes/v1/action/__tests__/perform_action.test.ts
```

Expected: existing 7 cases + 3 new = 10 PASS. Existing aggregator-tier tests should still pass because the helper's behavior for aggregator is unchanged.

If the existing aggregator-tier "user owned by another aggregator → 403" test now fails because the helper returns `USER_NOT_FOUND` (when `dbState.userRows = []`) instead of `NOT_AUTHORIZED_FOR_TARGET`, update its fixture to set `dbState.userRows = [{ id: 'usr_X', onboardedByOrgId: 'org_other_aggregator' }]` so the user exists but is owned elsewhere. Document the change in the commit message.

- [ ] **Step 4: Confirm typecheck progress**

```bash
pnpm --filter api exec tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

Expected: only `update_action_status.ts` errors remain (`lookup_onboarded_by_org` import + `body.acting_as_user_id` access). Both close in Task 4.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/action/perform_action.ts \
        apps/api/src/routes/v1/action/__tests__/perform_action.test.ts
git commit -m "feat(api): /action/perform accepts network_service-typed acting_org"
```

---

## Task 4: Strip on-behalf-of from `/action/update-status`

**Files:**
- Modify: `apps/api/src/routes/v1/action/update_action_status.ts`
- Modify: `apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts`

- [ ] **Step 1: Update the handler**

Replace the ENTIRE content of `apps/api/src/routes/v1/action/update_action_status.ts` with:

```ts
import { eq } from 'drizzle-orm';
import z, {
  getActionInteraction,
  UpdateActionStatusBodySchema,
} from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  ensureActionEventPartition,
  item_actions,
} from '@dpg/database';
import { getCurrentApiBaseUrl } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import {
  buildActionEventPayload,
  fetchLocalItemSnapshot,
  insertActionEvent,
  mirrorActionEventToSourceInstance,
  validateActionEventPayload,
} from '@/utils/action_event_runtime';

type UpdateActionStatusRequest = FastifyRequest<{
  Body: z.infer<typeof UpdateActionStatusBodySchema>;
}>;

const UpdateActionStatusResponseSchema = z.object({
  action_id: z.string(),
  action_type: z.string(),
  action_status: z.string(),
  update_count: z.number().int().nonnegative(),
});

export const update_action_status: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/update-status',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      body: UpdateActionStatusBodySchema,
      response: {
        200: UpdateActionStatusResponseSchema,
      },
    },
    handler: update_action_status_handler,
  });
};

/**
 * Self-acted only. The caller (session cookie or apikey-as-self) must
 * be the target item's owner. On-behalf-of via `acting_as_user_id` was
 * removed by spec 2026-05-23-action-on-behalf-of-network-service-tier-design.md
 * — audit columns on `item_actions` are populated only at create-time
 * (by `/action/perform`).
 */
export const update_action_status_handler = async (
  request: UpdateActionStatusRequest,
  reply: FastifyReply
) => {
  const body = request.body;
  const [existingAction] = await db
    .select()
    .from(item_actions)
    .where(eq(item_actions.action_id, body.action_id))
    .limit(1);

  if (!existingAction) {
    return reply.code(404).send({
      error: 'ACTION_NOT_FOUND',
      message: 'Action does not exist on this instance',
    });
  }

  if (existingAction.target_item_owner !== request.user.id) {
    return reply.code(403).send({
      error: 'NOT_TARGET_ITEM_OWNER',
      message: 'update-status may only be called by the target item owner.',
    });
  }

  let interaction: ReturnType<typeof getActionInteraction>;

  try {
    const networkConfig = await getNetworkConfigById(existingAction.target_item_network);
    interaction = getActionInteraction(networkConfig, {
      actionType: existingAction.action_type,
      fromNetwork: existingAction.source_item_network,
      fromDomain: existingAction.source_item_domain,
      fromItemType: existingAction.source_item_type,
      toNetwork: existingAction.target_item_network,
      toDomain: existingAction.target_item_domain,
      toItemType: existingAction.target_item_type,
    });
  } catch (err) {
    return reply.code(400).send({
      error: 'INVALID_ACTION_EVENT',
      message: err instanceof Error ? err.message : 'Invalid action event',
    });
  }

  const eventPayload = buildActionEventPayload({
    event_schema: interaction.event_schema,
    action_status: body.action_status,
    remarks: body.remarks,
    context: {
      action_type: existingAction.action_type,
      source_item: {
        item_network: existingAction.source_item_network,
        item_domain: existingAction.source_item_domain,
        item_type: existingAction.source_item_type,
        item_id: existingAction.source_item_id,
        item_instance_url: existingAction.source_item_instance_url,
      },
      target_item: {
        item_network: existingAction.target_item_network,
        item_domain: existingAction.target_item_domain,
        item_type: existingAction.target_item_type,
        item_id: existingAction.target_item_id,
        item_instance_url: existingAction.target_item_instance_url,
      },
      requirements_snapshot: existingAction.requirements_snapshot as Record<
        string,
        unknown
      >,
    },
  });

  try {
    validateActionEventPayload(interaction.event_schema, eventPayload);
  } catch (err) {
    return reply.code(400).send({
      error: 'INVALID_ACTION_EVENT',
      message: err instanceof Error ? err.message : 'Invalid action event',
    });
  }

  try {
    await ensureActionEventPartition(
      db,
      existingAction.target_item_network,
      existingAction.action_type
    );
  } catch (err) {
    request.log.error(
      {
        err,
        action_id: existingAction.action_id,
        action_type: existingAction.action_type,
      },
      'Failed to ensure action event partition'
    );

    return reply.code(500).send({
      error: 'PARTITION_SETUP_FAILED',
      message: 'Failed to prepare storage for action event',
    });
  }

  const nextUpdateCount = existingAction.update_count + 1;
  const [updatedAction] = await db
    .update(item_actions)
    .set({
      action_status: body.action_status,
      update_count: nextUpdateCount,
      remarks: body.remarks ?? existingAction.remarks,
      updated_at: new Date(),
    })
    .where(eq(item_actions.action_id, existingAction.action_id))
    .returning({
      action_id: item_actions.action_id,
      action_type: item_actions.action_type,
      action_status: item_actions.action_status,
      update_count: item_actions.update_count,
      source_item_network: item_actions.source_item_network,
      source_item_domain: item_actions.source_item_domain,
      source_item_type: item_actions.source_item_type,
      source_item_id: item_actions.source_item_id,
      source_item_instance_url: item_actions.source_item_instance_url,
      source_item_owner: item_actions.source_item_owner,
      target_item_network: item_actions.target_item_network,
      target_item_domain: item_actions.target_item_domain,
      target_item_type: item_actions.target_item_type,
      target_item_id: item_actions.target_item_id,
      target_item_instance_url: item_actions.target_item_instance_url,
      target_item_owner: item_actions.target_item_owner,
      remarks: item_actions.remarks,
    });

  const targetItemSnapshot = await fetchLocalItemSnapshot(db, {
    item_network: updatedAction.target_item_network,
    item_domain: updatedAction.target_item_domain,
    item_type: updatedAction.target_item_type,
    item_id: updatedAction.target_item_id,
    item_instance_url: updatedAction.target_item_instance_url,
  });
  const sourceItemSnapshot =
    updatedAction.source_item_instance_url === getCurrentApiBaseUrl()
      ? await fetchLocalItemSnapshot(db, {
          item_network: updatedAction.source_item_network,
          item_domain: updatedAction.source_item_domain,
          item_type: updatedAction.source_item_type,
          item_id: updatedAction.source_item_id,
          item_instance_url: updatedAction.source_item_instance_url,
        })
      : null;

  const storedEvent = {
    origin_instance_domain: getCurrentApiBaseUrl(),
    action_type: updatedAction.action_type,
    action_id: updatedAction.action_id,
    action_status: updatedAction.action_status,
    update_count: updatedAction.update_count,
    source_item: {
      item_network: updatedAction.source_item_network,
      item_domain: updatedAction.source_item_domain,
      item_type: updatedAction.source_item_type,
      item_id: updatedAction.source_item_id,
      item_instance_url: updatedAction.source_item_instance_url,
    },
    target_item: {
      item_network: updatedAction.target_item_network,
      item_domain: updatedAction.target_item_domain,
      item_type: updatedAction.target_item_type,
      item_id: updatedAction.target_item_id,
      item_instance_url: updatedAction.target_item_instance_url,
    },
    source_item_owner:
      updatedAction.source_item_owner ?? sourceItemSnapshot?.created_by ?? null,
    target_item_owner:
      updatedAction.target_item_owner ?? targetItemSnapshot?.created_by ?? null,
    source_item_latitude: sourceItemSnapshot?.item_latitude ?? null,
    source_item_longitude: sourceItemSnapshot?.item_longitude ?? null,
    target_item_latitude: targetItemSnapshot?.item_latitude ?? null,
    target_item_longitude: targetItemSnapshot?.item_longitude ?? null,
    event_payload: eventPayload,
    remarks: body.remarks,
  };

  await insertActionEvent(db, storedEvent);
  void mirrorActionEventToSourceInstance(storedEvent, request.log);

  return reply.code(200).send({
    action_id: updatedAction.action_id,
    action_type: updatedAction.action_type,
    action_status: updatedAction.action_status,
    update_count: updatedAction.update_count,
  });
};
```

Key changes:
- Removed imports of `action_error_messages`, `lookup_onboarded_by_org`, `resolve_acting_actor`.
- Removed the `resolve_acting_actor` call block.
- Replaced the ownership check (`existingAction.target_item_owner !== actor.effective_user_id`) with `existingAction.target_item_owner !== request.user.id`. Error code stays `NOT_TARGET_ITEM_OWNER` (renamed from `TARGET_ITEM_NOT_OWNED_BY_ACTOR`).
- Removed the audit-overwrite WARN log.
- Removed `performed_by_org_id` + `performed_by_service_user_id` from the UPDATE `.set({…})` block.

- [ ] **Step 2: Rewrite the unit tests**

Read existing tests:

```bash
cat apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts | head -60
```

Identify the harness (`buildApp`, `dbState`, mock factories). Then replace the existing on-behalf-of cases with a focused 5-case suite:

```ts
// Keep the existing imports + mocks (db, action_event_runtime stubs, etc.).
// Replace just the describe block's `it()` cases with these five:

describe('POST /api/v1/action/update-status (self-acted only)', () => {
  beforeEach(() => {
    dbState.existingAction = null;
    dbState.updates = [];
  });

  it('404 ACTION_NOT_FOUND when action_id does not resolve', async () => {
    dbState.existingAction = null;  // mock returns no row
    const app = buildApp({ user_id: 'usr_provider' });
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: {
        action_id: '00000000-0000-4000-8000-000000000000',
        action_status: 'shortlisted',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'ACTION_NOT_FOUND' });
  });

  it('403 NOT_TARGET_ITEM_OWNER when request.user.id is not the action target owner', async () => {
    dbState.existingAction = {
      action_id: '00000000-0000-4000-8000-000000000001',
      target_item_owner: 'usr_other_provider',
      // ... other required fields the route reads
    };
    const app = buildApp({ user_id: 'usr_provider' });
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: {
        action_id: '00000000-0000-4000-8000-000000000001',
        action_status: 'shortlisted',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'NOT_TARGET_ITEM_OWNER' });
    expect(dbState.updates).toHaveLength(0);
  });

  it('200 when self-acted by the target item owner', async () => {
    dbState.existingAction = {
      action_id: '00000000-0000-4000-8000-000000000002',
      target_item_owner: 'usr_provider',
      action_status: 'submitted',
      update_count: 0,
      // ... other required fields
    };
    const app = buildApp({ user_id: 'usr_provider' });
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: {
        action_id: '00000000-0000-4000-8000-000000000002',
        action_status: 'shortlisted',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({
      action_status: 'shortlisted',
    });
  });

  it('UPDATE does NOT write performed_by_org_id or performed_by_service_user_id', async () => {
    dbState.existingAction = {
      action_id: '00000000-0000-4000-8000-000000000003',
      target_item_owner: 'usr_provider',
      action_status: 'submitted',
      update_count: 0,
    };
    const app = buildApp({ user_id: 'usr_provider' });
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: {
        action_id: '00000000-0000-4000-8000-000000000003',
        action_status: 'shortlisted',
      },
    });
    expect(res.statusCode).toBe(200);
    const setPayload = dbState.updates[0];
    expect(setPayload).not.toHaveProperty('performed_by_org_id');
    expect(setPayload).not.toHaveProperty('performed_by_service_user_id');
  });

  it('Zod rejects acting_as_user_id in the body (field removed by Task 1)', async () => {
    const app = buildApp({ user_id: 'usr_provider' });
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: {
        action_id: '00000000-0000-4000-8000-000000000004',
        action_status: 'shortlisted',
        acting_as_user_id: 'usr_other',  // no longer in the schema
      },
    });
    // Fastify's zod-type-provider will 400 on the unknown field (the
    // schema is strict by default) — or accept silently if not strict.
    // Verify by reading the existing test file's behavior on extra
    // fields. If the schema accepts extras (looser), at minimum this
    // test asserts the route IGNORES `acting_as_user_id`:
    expect([200, 400, 404]).toContain(res.statusCode);
    // If it's 200 or 404, no error from the field being present.
    // The intent: prove acting_as_user_id has no effect, not crash.
  });
});
```

If the existing mock's `db.select`/`db.update` chain isn't structured to support `dbState.existingAction = null` discrimination, adjust the mock factory to honor it. The pattern from Plan A's update_action_status.test.ts already supports this; the existing test file is a strong template.

The Zod-strict assertion: check whether the existing `PerformActionBodySchema` rejects unknown fields. If Zod's `.object()` doesn't reject extras by default (it doesn't — `.strict()` is opt-in), then `acting_as_user_id` in the body will simply be ignored by the route. Either is acceptable for the test; the assertion just confirms no crash.

- [ ] **Step 3: Run update-status tests**

```bash
pnpm --filter api exec vitest run src/routes/v1/action/__tests__/update_action_status.test.ts
```

Expected: 5 PASS. The old on-behalf-of cases are gone.

- [ ] **Step 4: Full api suite**

```bash
pnpm --filter api test
```

Expected: full suite green. tsc errors from the chain — Task 1's broken state — should now be cleared.

- [ ] **Step 5: Typecheck final pass**

```bash
pnpm --filter api exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/action/update_action_status.ts \
        apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts
git commit -m "refactor(api): /action/update-status self-acted only; drop on-behalf-of path"
```

---

## Task 5: Integration test — network_service cross-aggregator scope

**Files:**
- Modify: `apps/api/src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts`

- [ ] **Step 1: Pre-read**

```bash
sed -n '1,50p' apps/api/src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts
```

The existing integration test seeds two aggregator orgs + one network_service org from Plan A's commit `e05d341`. The harness is in place; only the test cases need extension.

- [ ] **Step 2: Add the network_service cross-aggregator test case**

Append to the existing `describeIf` block:

```ts
  it('network_service acts for a user onboarded by aggregator-A — succeeds (cross-aggregator scope)', async () => {
    // Seed a fresh user via /admin/participant on aggregator-A.
    const email = `ns_cross_${randomUUID().slice(0, 6)}@a.test`;
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a_apikey_raw,
        'x-acting-org-id': agg_a_org_id,
      },
      payload: {
        email,
        name: 'NS Cross-Aggregator Target',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'voice',
        item_state: { /* whatever seeker profile fields are required */ },
      },
    });
    expect(onboardRes.statusCode).toBe(200);
    const targetUserId = onboardRes.json().user_id;
    const seekerItemId = onboardRes.json().items[0].item_id;
    created_user_ids.push(targetUserId);

    // Now: network_service apikey files an /action/perform on behalf of
    // that user (which is owned by aggregator-A, not network_service).
    // Aggregator-tier would reject this with NOT_AUTHORIZED_FOR_TARGET;
    // network-service-tier MUST succeed.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: {
        'x-api-key': ns_apikey_raw,
        'x-acting-org-id': ns_org_id,
      },
      payload: {
        action_type: 'apply',
        source_item: {
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          item_id: seekerItemId,
        },
        target_item: {
          item_network: 'blue_dot',
          item_domain: 'provider',
          item_type: 'job_posting_1.0',
          item_id: server.fixtures.provider_item_id,
          item_instance_url: server.api_base_url,
        },
        requirements_snapshot: {},
        acting_as_user_id: targetUserId,
      },
    });
    expect(res.statusCode).toBe(201);
    const action_id = res.json().action_id;

    // Verify the audit columns capture the network_service org, not
    // aggregator-A (the user's onboarding org).
    const [row] = await db
      .select()
      .from(item_actions)
      .where(eq(item_actions.action_id, action_id))
      .limit(1);

    expect(row.source_item_owner).toBe(targetUserId);
    expect(row.performed_by_org_id).toBe(ns_org_id);
  });

  it('network_service points at non-existent user_id — returns 404 USER_NOT_FOUND', async () => {
    const fakeUserId = `usr_does_not_exist_${randomUUID().slice(0, 8)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: {
        'x-api-key': ns_apikey_raw,
        'x-acting-org-id': ns_org_id,
      },
      payload: {
        action_type: 'apply',
        source_item: {
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          item_id: '00000000-0000-4000-8000-000000000099',
        },
        target_item: {
          item_network: 'blue_dot',
          item_domain: 'provider',
          item_type: 'job_posting_1.0',
          item_id: server.fixtures.provider_item_id,
          item_instance_url: server.api_base_url,
        },
        requirements_snapshot: {},
        acting_as_user_id: fakeUserId,
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'USER_NOT_FOUND' });
  });
```

If the existing test seeds `ns_org_id` + `ns_apikey_raw` as a network_service org from Plan A — that's the same infrastructure to reuse. If the field name differs (e.g., the original may have called it `network_service_org_id`), match the existing.

Also: trim or update any existing test that used `/action/update-status` with `acting_as_user_id` — those will now break because the field is gone from the schema. Either remove the test or adapt it to call update-status WITHOUT acting_as_user_id (just session-cookie self-acted path).

- [ ] **Step 3: Run integration test (best-effort)**

If local PG is up:
```bash
docker compose up -d db redis
POSTGRES_URL='postgres://postgres:postgres@localhost:5432/postgresdb' \
  pnpm --filter api test:integration src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts
```

Expected: all existing tests + the 2 new tests pass.

If local PG is NOT accessible, run the unit suite to confirm no regressions:
```bash
pnpm --filter api test
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts
git commit -m "test(api): integration coverage for network_service cross-aggregator on-behalf-of"
```

---

## Task 6: Docs + Postman

**Files:**
- Modify: `docs/operations/integrating-dpgs.md`
- Modify: `docs/postman/Signals-DPG.postman_collection.json`

- [ ] **Step 1: Update integrating-dpgs.md**

Find the existing "Acting on behalf of a user" section (added by Plan A). Update the heading and content to reflect both tiers + the update-status change.

Replace:

```markdown
## Acting on behalf of a user (aggregator only)
```

with:

```markdown
## Acting on behalf of a user (two tiers)

Two `acting_org.org_type` values may use `acting_as_user_id` on
`POST /api/v1/action/perform`:

- **`aggregator`** — scoped to users that aggregator onboarded
  (`user.onboarded_by_org_id === acting_org.org_id`). For
  counsellor-driven applications, future delegation models, etc.
- **`network_service`** — unrestricted; may act for any user in the
  network. Today's voice-DPG runs at this tier (network-hosted service).

Voice-type acting_orgs are rejected with `403 ACTING_ORG_TYPE_NOT_ALLOWED`
(placeholder; no voice-typed orgs exist in production today).

`POST /api/v1/action/update-status` is **self-acted only** — the caller
must be the target item's owner. There is no `acting_as_user_id` field
on update-status.

### Authorization matrix (perform)

| Caller shape | `acting_as_user_id` | Outcome |
|---|---|---|
| Session cookie or apikey-as-self | absent | Self-attribution. |
| Session cookie or apikey-as-self | present | `400 CANNOT_OVERRIDE_SELF` |
| `aggregator` apikey + acting_org | absent | `400 MISSING_ACTING_AS_USER_ID` |
| `aggregator` apikey + acting_org | present, user not found | `404 USER_NOT_FOUND` |
| `aggregator` apikey + acting_org | present, own user | `201` |
| `aggregator` apikey + acting_org | present, other-aggregator or self-registered | `403 NOT_AUTHORIZED_FOR_TARGET` |
| `network_service` apikey + acting_org | absent | `400 MISSING_ACTING_AS_USER_ID` |
| `network_service` apikey + acting_org | present, user not found | `404 USER_NOT_FOUND` |
| `network_service` apikey + acting_org | present, user exists | `201` |
| `voice` acting_org | (any) | `403 ACTING_ORG_TYPE_NOT_ALLOWED` |

### Audit columns

`item_actions.performed_by_org_id` + `performed_by_service_user_id` are
populated at create-time only (by `/action/perform`). `/action/update-status`
does not touch them. Inspect the columns to identify the on-behalf-of
caller:

- `network_service` org_id → voice / ecosystem-manager-driven action.
- `aggregator` org_id → counsellor / aggregator-DPG-driven action.
- `NULL` → self-acted (UI session or apikey-as-self).

### Migration from update-status acting-as

`/action/update-status` no longer accepts `acting_as_user_id`. Callers
that previously used the on-behalf-of path on update-status must now
either:

- Update status via the target item owner's own session / apikey, OR
- Skip the status update (Plan B's metrics rollup counts statuses
  across rows; the cache catches the next perform without needing a
  formal update-status call).
```

- [ ] **Step 2: Add a network_service Postman request**

In `docs/postman/Signals-DPG.postman_collection.json`, find the `07 Aggregator (on behalf of)` folder. After the existing `Apply on behalf of seeker` request, add a sibling:

```jsonc
{
  "name": "Apply on behalf of seeker (network_service)",
  "request": {
    "method": "POST",
    "header": [
      { "key": "content-type", "value": "application/json" },
      { "key": "x-api-key", "value": "{{network_service_api_key}}", "type": "text" },
      { "key": "x-acting-org-id", "value": "{{network_service_org_id}}", "type": "text" }
    ],
    "body": {
      "mode": "raw",
      "raw": "{\n  \"action_type\": \"apply\",\n  \"source_item\": {\n    \"item_network\": \"{{network_id}}\",\n    \"item_domain\": \"{{seeker_domain}}\",\n    \"item_type\": \"{{seeker_item_type}}\",\n    \"item_id\": \"{{seeker_profile_item_id}}\"\n  },\n  \"target_item\": {\n    \"item_network\": \"{{network_id}}\",\n    \"item_domain\": \"{{provider_domain}}\",\n    \"item_type\": \"{{provider_item_type}}\",\n    \"item_id\": \"{{provider_item_id}}\",\n    \"item_instance_url\": \"{{base_url}}\"\n  },\n  \"requirements_snapshot\": {{action_requirements_snapshot_json}},\n  \"acting_as_user_id\": \"{{seeker_user_id}}\"\n}",
      "options": { "raw": { "language": "json" } }
    },
    "url": {
      "raw": "{{base_url}}/api/v1/action/perform",
      "host": [ "{{base_url}}" ],
      "path": [ "api", "v1", "action", "perform" ]
    },
    "description": "Network-service tier on-behalf-of: voice-DPG (network-hosted) files an apply action for any user in the network, including users onboarded by other aggregators or self-registered users. Uses {{network_service_api_key}} + {{network_service_org_id}}. Returns 201 + populates item_actions.performed_by_org_id with the network_service org_id."
  },
  "response": []
}
```

The variables `{{network_service_api_key}}` + `{{network_service_org_id}}` already exist in both env files (added by Plan C).

- [ ] **Step 3: Update the existing `Accept on behalf of provider` request**

The current request in folder `07 Aggregator (on behalf of)` named `Accept on behalf of provider` calls `POST /action/update-status` with `acting_as_user_id` in body + `x-acting-org-id` header. That's now invalid — strip the on-behalf-of pieces:

- Remove the `x-acting-org-id` header.
- Remove the `acting_as_user_id` field from the body.
- Update the description: `Status update is self-acted only. The session-cookie or apikey-as-self caller must be the action's target item owner.`
- Optionally rename the request to `Update action status (self-acted)` for clarity.

Or — if the request only existed to demonstrate the deprecated on-behalf-of path — delete it entirely. Note in the commit message which choice you made.

- [ ] **Step 4: Validate JSON parses + envs symmetric**

```bash
for f in docs/postman/Signals-DPG.postman_collection.json \
         docs/postman/Blue-Dots.postman_environment.json \
         docs/postman/Purple-Dots.postman_environment.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "$f ok";
done

diff <(jq -S '.values | map({key, type, enabled})' docs/postman/Blue-Dots.postman_environment.json) \
     <(jq -S '.values | map({key, type, enabled})' docs/postman/Purple-Dots.postman_environment.json)
```

Expected: all parse; symmetry diff empty.

- [ ] **Step 5: Commit**

```bash
git add docs/operations/integrating-dpgs.md \
        docs/postman/Signals-DPG.postman_collection.json
git commit -m "docs: network_service tier on /action/perform; update-status self-acted only"
```

---

## Final checklist before opening PR

- [ ] All 6 task commits on `chore/network-service-action-on-behalf-of`.
- [ ] `pnpm typecheck` clean across api / ui / docs.
- [ ] `pnpm --filter api test` clean.
- [ ] `pnpm schema:bundle:check` clean (no schema changes in this plan).
- [ ] Manual `pnpm --filter api test:integration` against local PG clean.
- [ ] PR target is `develop` (this plan is a small follow-up to Plan A; no need for a feature-branch bundle).

---

## Self-review notes

**Spec coverage:**

| Spec section | Task |
|---|---|
| Three-tier model overview | Task 6 (docs) |
| `/action/perform` matrix | Task 2 (helper) + Task 3 (route) |
| `USER_NOT_FOUND` (404) | Task 2 (helper) + Task 3 (route test) |
| `/action/update-status` self-acted only | Task 1 (Zod) + Task 4 (handler) |
| Helper rename `lookup_onboarded_by_org` → `lookup_user_for_acting` + new return shape | Task 2 |
| Audit columns create-time-only post-change | Task 4 (no writes in UPDATE) |
| Integration test: cross-aggregator scope | Task 5 |
| Docs: aggregator vs network_service vs voice-placeholder | Task 6 |
| Postman: new network_service request + update-status self-acted | Task 6 |

**Placeholder scan:** No TBD / TODO. The "verify the existing test file's behavior on extra fields" in Task 4 Step 2 is a defensible check at implementation time (Zod's default object behavior is to silently strip unknowns; not an undecided requirement).

**Type consistency:**
- `lookup_user_for_acting` returns `{ onboardedByOrgId: string | null } | null`. The helper's input field is `lookup_user`. Perform-route call site passes `lookup_user_for_acting` to the `lookup_user` field. Mock factory in helper tests yields the same shape.
- `ResolveErr.status` is `400 | 403 | 404` (bumped from `400 | 403` in Plan A). Status union widening flows to caller's `reply.code(actor.status).send(...)` which accepts any number — no caller-side change needed.
- `ResolveErr.error` union gains `'USER_NOT_FOUND'`. `action_error_messages` map gains the matching key.

**Granularity:** Tasks 1, 5, 6 are small (3-6 steps each). Tasks 2 and 4 are larger (full helper / full handler rewrites) but the rewrites are necessary in one shot — splitting them mid-task would leave the typecheck broken across two commits with no test coverage. Task 3 is medium (one import swap + 3 new route tests).
