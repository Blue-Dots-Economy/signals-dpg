# Action Perform & Update-Status — On-Behalf-Of for Voice DPG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let voice-type orgs (apikey + `x-acting-org-id`) file `/api/v1/action/perform` and `/api/v1/action/update-status` calls on behalf of users they onboarded by passing `acting_as_user_id` in the body, with audit columns on `item_actions` and an explicit deny for aggregator / network_service callers.

**Architecture:** A new optional variant of Plan 1's acting_org preHandler is mounted on `/api/v1/action/*`. A pure `resolve_acting_actor` helper consumes `(request.acting_org, body.acting_as_user_id, request.user)` plus the target user's `onboarded_by_org_id` and returns either `{ effective_user_id, audit }` or a typed error. Two nullable FK columns (`performed_by_org_id`, `performed_by_service_user_id`) carry the audit trail on `item_actions`. The source-instance `/action/perform` orchestrator forwards the resolved owner + audit into the existing target-instance `/network/action/perform` handler, which writes the row.

**Tech Stack:** Fastify, Zod via `fastify-type-provider-zod`, Drizzle ORM, Postgres, Vitest. All changes inside `apps/api`, `packages/database`, `packages/schemas`, plus docs.

**Spec:** [docs/superpowers/specs/2026-05-22-action-perform-on-behalf-of-design.md](../specs/2026-05-22-action-perform-on-behalf-of-design.md)

**Related plans:** Plan 1 (`2026-05-21-aggregator-service-auth.md`), Plan 2 (`2026-05-21-participant-onboarding-attribution.md`), Plan 3 (`2026-05-21-participant-metrics-service.md`).

---

## File map (created vs. modified)

**Created:**
- `apps/api/src/middleware/acting_org_optional.ts` — wrapper preHandler.
- `apps/api/src/middleware/__tests__/acting_org_optional.test.ts` — unit tests.
- `apps/api/src/routes/v1/action/_resolve_acting_actor.ts` — pure helper.
- `apps/api/src/routes/v1/action/__tests__/resolve_acting_actor.test.ts` — matrix unit tests.
- `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts` — route tests (failing-first).
- `apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts` — route tests (failing-first).
- `apps/api/src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts` — integration test against real Postgres.

**Modified:**
- `packages/schemas/src/api/action_schemas.ts` — three Zod bodies gain on-behalf-of fields.
- `packages/database/src/drizzle_ref_tables/item_actions.ts` — two new audit columns.
- `packages/database/src/utils/sql_scripts/create_actions_events.sql` — same two columns in `CREATE TABLE` + idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` + FK constraint blocks.
- `apps/api/src/routes/v1/action/action_routes.ts` — mounts the optional preHandler.
- `apps/api/src/routes/v1/action/perform_action.ts` — calls the helper, propagates owner + audit downstream.
- `apps/api/src/routes/v1/network/action/perform_action.ts` — accepts + persists audit columns on insert.
- `apps/api/src/routes/v1/action/update_action_status.ts` — calls the helper, persists audit columns on UPDATE.
- `docs/operations/integrating-dpgs.md` — new "Acting on behalf of a user (voice)" section, error-code table updated.
- `docs/postman/Signals-DPG.postman_collection.json` — two new voice/provider on-behalf-of requests.

**Helm bundle regenerated** (not hand-edited): `helmcharts/dpg/files/schema/schema.sql` via `pnpm schema:bundle`.

---

## Task ordering rationale

1. **Schemas + DB columns first** (Tasks 1 + 2) — every other layer reads them. If Zod doesn't accept `acting_as_user_id` in the body, the route handlers can't even reach the auth checks. If `item_actions` doesn't have the columns, inserts and updates will fail at PG.
2. **Optional preHandler** (Task 3) — drop-in dependency for the route changes; small enough to ship + test on its own.
3. **Pure helper with matrix unit tests** (Task 4) — captures the entire authorization spec in one file with cheap (no-DB) tests. The route tasks then just have to call it and propagate the result.
4. **Routes** (Tasks 5 + 6) — both wire the same pieces; perform handles the cross-instance proxy hop, update-status writes locally.
5. **Integration test** (Task 7) — proves the four layers compose against real Postgres.
6. **Docs + Postman** (Task 8) — last, so the prose matches what shipped.

---

## Task 1: Extend Zod body schemas with on-behalf-of fields

**Files:**
- Modify: `packages/schemas/src/api/action_schemas.ts:20-39`

- [ ] **Step 1: Open the file and find the three schemas to extend**

`PerformActionBodySchema` (current lines 20–25), `UpdateActionStatusBodySchema` (35–39), and `PerformNetworkActionBodySchema` (27–33). Add `acting_as_user_id` (optional, min(1)) to the first two; add `performed_by_org_id` + `performed_by_service_user_id` (each optional, nullable, min(1)) to the third.

- [ ] **Step 2: Edit the file**

Replace the three schemas with:

```ts
export const PerformActionBodySchema = z.object({
  action_type: z.string().min(1),
  source_item: ActionItemRefSchema,
  target_item: ActionTargetItemRefSchema,
  requirements_snapshot: z.record(z.string(), z.unknown()),
  acting_as_user_id: z.string().min(1).optional(),
});

export const PerformNetworkActionBodySchema = z.object({
  action_type: z.string().min(1),
  source_item: ActionItemRefWithInstanceSchema,
  target_item: ActionItemRefWithInstanceSchema,
  source_item_owner: z.string().min(1),
  requirements_snapshot: z.record(z.string(), z.unknown()),
  performed_by_org_id: z.string().min(1).nullable().optional(),
  performed_by_service_user_id: z.string().min(1).nullable().optional(),
});

export const UpdateActionStatusBodySchema = z.object({
  action_id: z.uuid(),
  action_status: z.string().min(1),
  remarks: z.string().min(1).optional(),
  acting_as_user_id: z.string().min(1).optional(),
});
```

- [ ] **Step 3: Typecheck the schemas package**

Run: `pnpm --filter @dpg/schemas typecheck` (or `pnpm typecheck` to verify nothing else breaks yet).
Expected: PASS. Optional fields are additive; existing callers compile unchanged.

- [ ] **Step 4: Commit**

```bash
git add packages/schemas/src/api/action_schemas.ts
git commit -m "feat(schemas): add acting_as_user_id + audit fields to action bodies"
```

---

## Task 2: Add audit columns to `item_actions` (Drizzle + SQL bundle + helm regen)

**Files:**
- Modify: `packages/database/src/drizzle_ref_tables/item_actions.ts:27-34`
- Modify: `packages/database/src/utils/sql_scripts/create_actions_events.sql:3-43, 145+`
- Modify (regenerated): `helmcharts/dpg/files/schema/schema.sql`

- [ ] **Step 1: Add the two columns to the Drizzle reference table**

In `packages/database/src/drizzle_ref_tables/item_actions.ts`, just after `target_item_owner` (line 34), add:

```ts
    target_item_owner: text('target_item_owner'),

    performed_by_org_id: text('performed_by_org_id'),
    performed_by_service_user_id: text('performed_by_service_user_id'),

    requirements_snapshot: jsonb('requirements_snapshot')
```

Both columns are nullable text (matches the auth `user.id` and `organization.id` representations). No new indexes per spec.

- [ ] **Step 2: Mirror the columns into the idempotent SQL bundle's CREATE TABLE**

In `packages/database/src/utils/sql_scripts/create_actions_events.sql`, inside the `CREATE TABLE IF NOT EXISTS item_actions (…)` block (currently lines 3–43), add the two columns after `target_item_owner TEXT,` (line 22):

```sql
  target_item_owner TEXT,

  performed_by_org_id TEXT,
  performed_by_service_user_id TEXT,

  requirements_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
```

- [ ] **Step 3: Add idempotent ALTER TABLE statements for upgrade paths**

After the table-create block and before the index block (i.e. just before `CREATE INDEX IF NOT EXISTS item_actions_source_item_idx`, current line 45), add:

```sql
-- Plan A: audit trail for on-behalf-of action filing.
ALTER TABLE item_actions ADD COLUMN IF NOT EXISTS performed_by_org_id TEXT;
ALTER TABLE item_actions ADD COLUMN IF NOT EXISTS performed_by_service_user_id TEXT;
```

- [ ] **Step 4: Add FK constraint DO blocks at the end of the file**

At the end of `create_actions_events.sql` (after the last action_events index — current line 144), append:

```sql

-- Plan A: FK audit columns -> organization / user. No cascade per spec —
-- keep audit even if the voice org or its service user row is deleted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'item_actions_performed_by_org_id_organization_id_fk'
  ) THEN
    ALTER TABLE item_actions
      ADD CONSTRAINT item_actions_performed_by_org_id_organization_id_fk
      FOREIGN KEY (performed_by_org_id) REFERENCES "organization"(id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'item_actions_performed_by_service_user_id_user_id_fk'
  ) THEN
    ALTER TABLE item_actions
      ADD CONSTRAINT item_actions_performed_by_service_user_id_user_id_fk
      FOREIGN KEY (performed_by_service_user_id) REFERENCES "user"(id);
  END IF;
END
$$;
```

- [ ] **Step 5: Regenerate the helm-bundled schema**

Run: `pnpm schema:bundle`
Expected output: `helmcharts/dpg/files/schema/schema.sql` rewritten. Inspect that it now contains the two new column lines + the ALTER + FK DO blocks.

- [ ] **Step 6: Verify the bundle is consistent**

Run: `pnpm schema:bundle:check`
Expected: PASS (script exits 0; no diff between regenerated and committed bundle).

- [ ] **Step 7: Apply to local PG to confirm it parses + is idempotent**

Run twice to confirm idempotence:
```bash
pnpm db:init:api
pnpm db:init:api
```
Expected: both runs complete without error; second run is a no-op for the new columns / constraints because of `IF NOT EXISTS` / `pg_constraint` guards.

- [ ] **Step 8: Sanity-check the columns landed**

Run: `docker compose exec db psql -U postgres -d signals_dpg -c "\\d+ item_actions" | grep performed_by`
Expected: two rows printed for `performed_by_org_id` and `performed_by_service_user_id`, both `text`, both nullable.

- [ ] **Step 9: Commit**

```bash
git add packages/database/src/drizzle_ref_tables/item_actions.ts \
        packages/database/src/utils/sql_scripts/create_actions_events.sql \
        helmcharts/dpg/files/schema/schema.sql
git commit -m "feat(db): add performed_by_{org,service_user} audit columns to item_actions"
```

---

## Task 3: Optional `acting_org` preHandler wrapper

**Files:**
- Create: `apps/api/src/middleware/acting_org_optional.ts`
- Create: `apps/api/src/middleware/__tests__/acting_org_optional.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/middleware/__tests__/acting_org_optional.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

const stricts: Array<{ called: boolean }> = [];

vi.mock('../acting_org.js', () => ({
  acting_org_preHandler: vi.fn(async (req: FastifyRequest) => {
    stricts.push({ called: true });
    (req as any).acting_org = {
      org_id: 'org_voice',
      org_type: 'voice',
      service_user_id: 'svc',
    };
  }),
}));

// Imported after mock so the strict is the mock.
import { acting_org_preHandler_optional } from '../acting_org_optional.js';

const makeReply = () => {
  const reply: any = {
    code: vi.fn(function (this: any) { return this; }),
    send: vi.fn(function (this: any) { return this; }),
  };
  return reply as FastifyReply;
};

const makeRequest = (overrides: { headers?: Record<string, string | string[]> } = {}): FastifyRequest =>
  ({
    headers: overrides.headers ?? {},
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }) as unknown as FastifyRequest;

describe('acting_org_preHandler_optional', () => {
  it('sets request.acting_org = undefined and does NOT call strict when header absent', async () => {
    stricts.length = 0;
    const req = makeRequest();
    const reply = makeReply();
    await acting_org_preHandler_optional(req, reply);
    expect((req as any).acting_org).toBeUndefined();
    expect(reply.code).not.toHaveBeenCalled();
    expect(stricts).toHaveLength(0);
  });

  it('treats blank-after-trim header as absent', async () => {
    stricts.length = 0;
    const req = makeRequest({ headers: { 'x-acting-org-id': '   ' } });
    const reply = makeReply();
    await acting_org_preHandler_optional(req, reply);
    expect((req as any).acting_org).toBeUndefined();
    expect(stricts).toHaveLength(0);
  });

  it('delegates to strict preHandler when header is present', async () => {
    stricts.length = 0;
    const req = makeRequest({ headers: { 'x-acting-org-id': 'org_voice' } });
    const reply = makeReply();
    await acting_org_preHandler_optional(req, reply);
    expect(stricts).toHaveLength(1);
    expect((req as any).acting_org?.org_id).toBe('org_voice');
  });

  it('treats array-shaped header by checking first value for emptiness', async () => {
    stricts.length = 0;
    const req = makeRequest({ headers: { 'x-acting-org-id': ['  ', 'org_other'] } });
    const reply = makeReply();
    await acting_org_preHandler_optional(req, reply);
    // First value is blank after trim → treated as absent → strict NOT called.
    expect(stricts).toHaveLength(0);
    expect((req as any).acting_org).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api exec vitest run src/middleware/__tests__/acting_org_optional.test.ts`
Expected: FAIL — `Cannot find module '../acting_org_optional.js'`.

- [ ] **Step 3: Implement the wrapper**

Create `apps/api/src/middleware/acting_org_optional.ts`:

```ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import { acting_org_preHandler } from './acting_org.js';

const get_header_value = (raw: string | string[] | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Optional variant of `acting_org_preHandler`.
 *
 * - Header absent (or blank-after-trim) → leave `request.acting_org`
 *   undefined and resolve. The downstream route handler decides whether
 *   that's allowed.
 * - Header present → delegate to the strict preHandler, which either
 *   attaches `request.acting_org` or terminates the request with an
 *   error reply.
 *
 * Mount this on routes that need to accept BOTH self-acted calls and
 * acting_org-scoped calls (e.g. `/api/v1/action/*`).
 */
export const acting_org_preHandler_optional = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const acting_org_id = get_header_value(
    request.headers['x-acting-org-id'] as string | string[] | undefined,
  );
  if (!acting_org_id) {
    return;
  }
  await acting_org_preHandler(request, reply);
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter api exec vitest run src/middleware/__tests__/acting_org_optional.test.ts`
Expected: PASS — all four cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/acting_org_optional.ts \
        apps/api/src/middleware/__tests__/acting_org_optional.test.ts
git commit -m "feat(api): optional acting_org preHandler wrapper for /action/*"
```

---

## Task 4: Pure `resolve_acting_actor` helper + matrix tests

**Files:**
- Create: `apps/api/src/routes/v1/action/_resolve_acting_actor.ts`
- Create: `apps/api/src/routes/v1/action/__tests__/resolve_acting_actor.test.ts`

This helper captures the entire authorization matrix from the spec in one place, so the route tasks can stay focused on plumbing.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/v1/action/__tests__/resolve_acting_actor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolve_acting_actor } from '../_resolve_acting_actor.js';

const baseAggregator = {
  org_id: 'org_bbmp',
  org_type: 'aggregator' as const,
  service_user_id: 'svc_agg',
};
const baseVoice = {
  org_id: 'org_voice_1',
  org_type: 'voice' as const,
  service_user_id: 'svc_voice_1',
};
const baseNetwork = {
  org_id: 'org_signals',
  org_type: 'network_service' as const,
  service_user_id: 'svc_signals',
};

const lookupOnboarded = async (user_id: string): Promise<string | null> => {
  if (user_id === 'usr_voice_owned') return 'org_voice_1';
  if (user_id === 'usr_other_voice_owned') return 'org_voice_2';
  if (user_id === 'usr_no_attribution') return null;
  return null;
};

describe('resolve_acting_actor', () => {
  it('self-acted: no acting_org and no acting_as_user_id → effective_user = request.user', async () => {
    const res = await resolve_acting_actor({
      acting_org: undefined,
      request_user_id: 'usr_self',
      acting_as_user_id: undefined,
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({
      ok: true,
      effective_user_id: 'usr_self',
      audit: { performed_by_org_id: null, performed_by_service_user_id: null },
    });
  });

  it('no acting_org + body field present → 400 CANNOT_OVERRIDE_SELF', async () => {
    const res = await resolve_acting_actor({
      acting_org: undefined,
      request_user_id: 'usr_self',
      acting_as_user_id: 'usr_target',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({ ok: false, status: 400, error: 'CANNOT_OVERRIDE_SELF' });
  });

  it('aggregator acting_org → 403 ACTING_ORG_TYPE_NOT_ALLOWED (regardless of body field)', async () => {
    const res1 = await resolve_acting_actor({
      acting_org: baseAggregator,
      request_user_id: 'svc_agg',
      acting_as_user_id: 'usr_voice_owned',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res1).toEqual({ ok: false, status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });

    const res2 = await resolve_acting_actor({
      acting_org: baseAggregator,
      request_user_id: 'svc_agg',
      acting_as_user_id: undefined,
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res2).toEqual({ ok: false, status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });
  });

  it('network_service acting_org → 403 ACTING_ORG_TYPE_NOT_ALLOWED', async () => {
    const res = await resolve_acting_actor({
      acting_org: baseNetwork,
      request_user_id: 'svc_signals',
      acting_as_user_id: 'usr_voice_owned',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({ ok: false, status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });
  });

  it('voice acting_org + missing body field → 400 MISSING_ACTING_AS_USER_ID', async () => {
    const res = await resolve_acting_actor({
      acting_org: baseVoice,
      request_user_id: 'svc_voice_1',
      acting_as_user_id: undefined,
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({ ok: false, status: 400, error: 'MISSING_ACTING_AS_USER_ID' });
  });

  it('voice acting_org + target onboarded by THIS voice org → success, audit populated', async () => {
    const res = await resolve_acting_actor({
      acting_org: baseVoice,
      request_user_id: 'svc_voice_1',
      acting_as_user_id: 'usr_voice_owned',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({
      ok: true,
      effective_user_id: 'usr_voice_owned',
      audit: {
        performed_by_org_id: 'org_voice_1',
        performed_by_service_user_id: 'svc_voice_1',
      },
    });
  });

  it('voice acting_org + target onboarded by ANOTHER voice org → 403 NOT_AUTHORIZED_FOR_TARGET', async () => {
    const res = await resolve_acting_actor({
      acting_org: baseVoice,
      request_user_id: 'svc_voice_1',
      acting_as_user_id: 'usr_other_voice_owned',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({ ok: false, status: 403, error: 'NOT_AUTHORIZED_FOR_TARGET' });
  });

  it('voice acting_org + target with NULL onboarded_by → 403 NOT_AUTHORIZED_FOR_TARGET', async () => {
    const res = await resolve_acting_actor({
      acting_org: baseVoice,
      request_user_id: 'svc_voice_1',
      acting_as_user_id: 'usr_no_attribution',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({ ok: false, status: 403, error: 'NOT_AUTHORIZED_FOR_TARGET' });
  });

  it('voice acting_org + target_user_id not found at all → 403 NOT_AUTHORIZED_FOR_TARGET', async () => {
    const res = await resolve_acting_actor({
      acting_org: baseVoice,
      request_user_id: 'svc_voice_1',
      acting_as_user_id: 'usr_does_not_exist',
      lookup_onboarded_by: lookupOnboarded,
    });
    expect(res).toEqual({ ok: false, status: 403, error: 'NOT_AUTHORIZED_FOR_TARGET' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/resolve_acting_actor.test.ts`
Expected: FAIL — `Cannot find module '../_resolve_acting_actor.js'`.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/routes/v1/action/_resolve_acting_actor.ts`:

```ts
type ActingOrg = {
  org_id: string;
  org_type: 'aggregator' | 'voice' | 'network_service';
  service_user_id: string;
};

type Audit = {
  performed_by_org_id: string | null;
  performed_by_service_user_id: string | null;
};

type ResolveOk = {
  ok: true;
  effective_user_id: string;
  audit: Audit;
};

type ResolveErr = {
  ok: false;
  status: 400 | 403;
  error:
    | 'CANNOT_OVERRIDE_SELF'
    | 'MISSING_ACTING_AS_USER_ID'
    | 'ACTING_ORG_TYPE_NOT_ALLOWED'
    | 'NOT_AUTHORIZED_FOR_TARGET';
};

export type ResolveActingActorResult = ResolveOk | ResolveErr;

export type ResolveActingActorInput = {
  acting_org: ActingOrg | undefined;
  request_user_id: string;
  acting_as_user_id: string | undefined;
  /**
   * Returns `user.onboarded_by_org_id` for the given user_id, or `null`
   * if the user does not exist or has no attribution. The route handlers
   * back this with a single SELECT.
   */
  lookup_onboarded_by: (user_id: string) => Promise<string | null>;
};

const NO_AUDIT: Audit = {
  performed_by_org_id: null,
  performed_by_service_user_id: null,
};

/**
 * Single source of truth for the authorization matrix in
 * docs/superpowers/specs/2026-05-22-action-perform-on-behalf-of-design.md.
 *
 * Returns either the effective user id + audit columns to persist, or a
 * status/error code for the route handler to reply with.
 */
export const resolve_acting_actor = async (
  input: ResolveActingActorInput,
): Promise<ResolveActingActorResult> => {
  const { acting_org, request_user_id, acting_as_user_id, lookup_onboarded_by } = input;

  if (!acting_org) {
    if (acting_as_user_id) {
      return { ok: false, status: 400, error: 'CANNOT_OVERRIDE_SELF' };
    }
    return { ok: true, effective_user_id: request_user_id, audit: NO_AUDIT };
  }

  if (acting_org.org_type !== 'voice') {
    return { ok: false, status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' };
  }

  if (!acting_as_user_id) {
    return { ok: false, status: 400, error: 'MISSING_ACTING_AS_USER_ID' };
  }

  const onboarded_by = await lookup_onboarded_by(acting_as_user_id);
  if (onboarded_by !== acting_org.org_id) {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/resolve_acting_actor.test.ts`
Expected: PASS — all nine cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/action/_resolve_acting_actor.ts \
        apps/api/src/routes/v1/action/__tests__/resolve_acting_actor.test.ts
git commit -m "feat(api): pure resolve_acting_actor helper with full auth matrix"
```

---

## Task 5: Wire `/action/perform` + propagate audit through `/network/action/perform`

This task touches three files together: the action-routes wiring (mount optional preHandler), `perform_action.ts` (source orchestrator — calls helper, picks effective owner, forwards audit), and `network/action/perform.ts` (target persistence — accepts the new body fields and writes them on insert). They're glued together; doing them in one commit avoids an inconsistent intermediate state.

**Files:**
- Modify: `apps/api/src/routes/v1/action/action_routes.ts`
- Modify: `apps/api/src/routes/v1/action/perform_action.ts`
- Modify: `apps/api/src/routes/v1/network/action/perform_action.ts`
- Create: `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

// --- mock @api/db/postgres/drizzle_config: db.select for onboarded_by lookup ---
const dbState: {
  userRows: Array<{ id: string; onboardedByOrgId: string | null }>;
  itemRows: Array<{ created_by: string; item_id: string }>;
} = {
  userRows: [],
  itemRows: [],
};

vi.mock('@api/db/postgres/drizzle_config', () => {
  // Two consecutive selects per request: (a) user.onboarded_by_org_id,
  // (b) source item snapshot via fetchLocalItemSnapshot. The mock cycles
  // between userRows and itemRows.
  let toggle: 'user' | 'item' = 'user';
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => {
              const rows = toggle === 'user' ? dbState.userRows : dbState.itemRows;
              toggle = toggle === 'user' ? 'item' : 'user';
              return Promise.resolve(rows);
            }),
          })),
        })),
      })),
    },
  };
});

// --- mock fetch() so the proxy hop returns a deterministic response ---
const fetchCalls: Array<{ url: string; body: unknown }> = [];
const fetchResponse: { status: number; body: Record<string, unknown> } = {
  status: 201,
  body: { action_id: '00000000-0000-0000-0000-000000000001' },
};
vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit) => {
  fetchCalls.push({ url: String(url), body: JSON.parse(init.body as string) });
  return new Response(JSON.stringify(fetchResponse.body), {
    status: fetchResponse.status,
    headers: { 'content-type': 'application/json' },
  });
}));

// --- mock helpers from action_event_runtime: only fetchLocalItemSnapshot is on the perform path ---
vi.mock('@/utils/action_event_runtime', async () => {
  const actual = await vi.importActual<typeof import('@/utils/action_event_runtime')>(
    '@/utils/action_event_runtime',
  );
  return {
    ...actual,
    fetchLocalItemSnapshot: vi.fn(async () => ({
      created_by: 'usr_voice_owned',
      item_id: 'src_item_1',
      item_latitude: null,
      item_longitude: null,
      item_private_state: {},
    })),
  };
});

// --- mock served domain guard so the test isn't sensitive to env config ---
vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: () => true,
  replyForUnservedDomain: vi.fn(),
}));

// --- mock network config + interaction lookup ---
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    domains: [{ id: 'provider' }],
    instances: [{ domain_id: 'provider', instance_url: 'http://target.local' }],
  })),
}));

vi.mock('@dpg/schemas', async () => {
  const actual = await vi.importActual<typeof import('@dpg/schemas')>('@dpg/schemas');
  return {
    ...actual,
    getActionInteraction: vi.fn(() => ({
      requirement_schema: { type: 'object', properties: {}, additionalProperties: true },
    })),
    validateAgainstJsonSchema: vi.fn(),
    mergeItemStateWithPrivate: vi.fn((a: any) => a),
    projectPrivateStateForSchema: vi.fn(() => ({})),
  };
});

// Imported after mocks.
import { perform_action } from '../perform_action.js';

const VALID_BODY = {
  action_type: 'apply',
  source_item: {
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_id: '11111111-1111-1111-1111-111111111111',
  },
  target_item: {
    item_network: 'blue_dot',
    item_domain: 'provider',
    item_type: 'job_posting_1.0',
    item_id: '22222222-2222-2222-2222-222222222222',
    item_instance_url: 'http://target.local',
  },
  requirements_snapshot: {},
};

const buildApp = (acting_org?: any, request_user = { id: 'usr_self' }): FastifyInstance => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', async (req) => {
    (req as any).user = request_user;
    if (acting_org) (req as any).acting_org = acting_org;
  });
  app.register(perform_action);
  return app;
};

describe('POST /api/v1/action/perform — on-behalf-of', () => {
  beforeEach(() => {
    dbState.userRows = [];
    dbState.itemRows = [];
    fetchCalls.length = 0;
  });

  it('self-acted: no acting_org, no body field → forwards request.user.id as source_item_owner, audit null', async () => {
    const app = buildApp(undefined, { id: 'usr_self' });
    const res = await app.inject({ method: 'POST', url: '/perform', payload: VALID_BODY });
    expect(res.statusCode).toBe(201);
    expect(fetchCalls[0].body).toMatchObject({
      source_item_owner: 'usr_voice_owned', // taken from fetchLocalItemSnapshot
      performed_by_org_id: null,
      performed_by_service_user_id: null,
    });
  });

  it('400 CANNOT_OVERRIDE_SELF when body field present but no acting_org', async () => {
    const app = buildApp(undefined, { id: 'usr_self' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_target' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'CANNOT_OVERRIDE_SELF' });
  });

  it('400 MISSING_ACTING_AS_USER_ID when voice acting_org but no body field', async () => {
    const app = buildApp({ org_id: 'org_voice_1', org_type: 'voice', service_user_id: 'svc' });
    const res = await app.inject({ method: 'POST', url: '/perform', payload: VALID_BODY });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'MISSING_ACTING_AS_USER_ID' });
  });

  it('403 ACTING_ORG_TYPE_NOT_ALLOWED for aggregator acting_org', async () => {
    const app = buildApp({ org_id: 'org_agg', org_type: 'aggregator', service_user_id: 'svc_agg' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_target' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });
  });

  it('403 NOT_AUTHORIZED_FOR_TARGET when target onboarded by another voice org', async () => {
    dbState.userRows = [{ id: 'usr_other', onboardedByOrgId: 'org_voice_2' }];
    const app = buildApp({ org_id: 'org_voice_1', org_type: 'voice', service_user_id: 'svc' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_other' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'NOT_AUTHORIZED_FOR_TARGET' });
  });

  it('voice happy path: forwards acting_as_user_id as source_item_owner + populates audit', async () => {
    dbState.userRows = [{ id: 'usr_voice_owned', onboardedByOrgId: 'org_voice_1' }];
    const app = buildApp({ org_id: 'org_voice_1', org_type: 'voice', service_user_id: 'svc_voice_1' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_voice_owned' },
    });
    expect(res.statusCode).toBe(201);
    expect(fetchCalls[0].body).toMatchObject({
      source_item_owner: 'usr_voice_owned',
      performed_by_org_id: 'org_voice_1',
      performed_by_service_user_id: 'svc_voice_1',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/perform_action.test.ts`
Expected: FAIL on multiple cases — the current handler ignores `acting_as_user_id`, doesn't call the helper, doesn't forward audit fields.

- [ ] **Step 3: Mount the optional preHandler on /action/***

Edit `apps/api/src/routes/v1/action/action_routes.ts` to:

```ts
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { acting_org_preHandler_optional } from '@/middleware/acting_org_optional';
import { fetch_actions } from '@/routes/v1/action/fetch_actions';
import { perform_action } from '@/routes/v1/action/perform_action';
import { update_action_status } from '@/routes/v1/action/update_action_status';

const action_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook('preHandler', acting_org_preHandler_optional);
  fastify.register(fetch_actions);
  fastify.register(perform_action);
  fastify.register(update_action_status);
};

export default action_routes;
```

`fetch_actions` doesn't read `request.acting_org` so the added hook is a no-op for it; the optional variant adds zero overhead when the header is absent.

- [ ] **Step 4: Update the perform-action source orchestrator**

Edit `apps/api/src/routes/v1/action/perform_action.ts`. Two changes:

(a) Import the helper and the auth schema:
```ts
import { eq } from 'drizzle-orm';
import { user } from '@api/db/postgres/schema/auth';
import { resolve_acting_actor } from './_resolve_acting_actor.js';
```

(b) Replace the body of `perform_action_handler` so that, immediately after `const body = request.body;` (currently line 57), it calls the helper and uses the result. Insert this block right after the body declaration:

```ts
  const actor = await resolve_acting_actor({
    acting_org: request.acting_org,
    request_user_id: request.user.id,
    acting_as_user_id: body.acting_as_user_id,
    lookup_onboarded_by: async (user_id) => {
      const rows = await db
        .select({ onboardedByOrgId: user.onboardedByOrgId })
        .from(user)
        .where(eq(user.id, user_id))
        .limit(1);
      return rows[0]?.onboardedByOrgId ?? null;
    },
  });

  if (!actor.ok) {
    return reply.code(actor.status).send({
      error: actor.error,
      message: action_error_messages[actor.error],
    });
  }
```

Add a small message map at the top of the file (after imports):

```ts
const action_error_messages = {
  CANNOT_OVERRIDE_SELF:
    'acting_as_user_id requires an x-acting-org-id header from a voice-type service apikey.',
  MISSING_ACTING_AS_USER_ID:
    'voice-type acting_org requires acting_as_user_id in the request body.',
  ACTING_ORG_TYPE_NOT_ALLOWED:
    'only voice-type acting orgs may act on behalf of users today.',
  NOT_AUTHORIZED_FOR_TARGET:
    'acting_as_user_id is not a user onboarded by this voice org.',
} as const;
```

Then, change the proxy fetch call to inject the audit fields and use the resolved owner. The current call sends (lines 159–174):

```ts
        body: JSON.stringify({
          action_type: body.action_type,
          source_item: sourceItem,
          target_item: targetItem,
          source_item_owner: sourceItemSnapshot.created_by,
          requirements_snapshot: requirementsSnapshot,
        }),
```

Replace with:

```ts
        body: JSON.stringify({
          action_type: body.action_type,
          source_item: sourceItem,
          target_item: targetItem,
          source_item_owner: actor.effective_user_id,
          requirements_snapshot: requirementsSnapshot,
          performed_by_org_id: actor.audit.performed_by_org_id,
          performed_by_service_user_id: actor.audit.performed_by_service_user_id,
        }),
```

Also, validate ownership of the source item against the effective actor. Replace the existing snapshot-existence check (currently lines 79–85) so it also enforces `source_item.created_by === effective_user_id`:

```ts
  const sourceItemSnapshot = await fetchLocalItemSnapshot(db, sourceItem);
  if (!sourceItemSnapshot) {
    return reply.code(404).send({
      error: 'SOURCE_ITEM_NOT_FOUND',
      message: 'Source item does not exist on this instance',
    });
  }
  if (sourceItemSnapshot.created_by !== actor.effective_user_id) {
    return reply.code(403).send({
      error: 'SOURCE_ITEM_NOT_OWNED_BY_ACTOR',
      message:
        'source_item must be owned by the effective actor (request.user or acting_as_user_id)',
    });
  }
```

- [ ] **Step 5: Update the target-instance network handler to persist audit fields**

Edit `apps/api/src/routes/v1/network/action/perform_action.ts`. Change the `db.insert(item_actions).values({…})` block (currently lines 181–202) to include the audit columns:

```ts
  const [created] = await db
    .insert(item_actions)
    .values({
      action_type: body.action_type,
      partition_network: body.target_item.item_network,
      action_status: actionStatus,
      update_count: updateCount,
      source_item_network: body.source_item.item_network,
      source_item_domain: body.source_item.item_domain,
      source_item_type: body.source_item.item_type,
      source_item_id: body.source_item.item_id,
      source_item_instance_url: body.source_item.item_instance_url,
      source_item_owner: body.source_item_owner,
      target_item_network: body.target_item.item_network,
      target_item_domain: body.target_item.item_domain,
      target_item_type: body.target_item.item_type,
      target_item_id: body.target_item.item_id,
      target_item_instance_url: body.target_item.item_instance_url,
      target_item_owner: targetItemSnapshot.created_by,
      requirements_snapshot: body.requirements_snapshot,
      remarks: null,
      performed_by_org_id: body.performed_by_org_id ?? null,
      performed_by_service_user_id: body.performed_by_service_user_id ?? null,
    })
    .returning({
      // unchanged
      action_id: item_actions.action_id,
      action_type: item_actions.action_type,
      action_status: item_actions.action_status,
      update_count: item_actions.update_count,
      source_item_id: item_actions.source_item_id,
      target_item_id: item_actions.target_item_id,
    });
```

- [ ] **Step 6: Run the perform-action tests**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/perform_action.test.ts`
Expected: PASS — all six cases green.

- [ ] **Step 7: Run the full API unit test suite to catch regressions**

Run: `pnpm --filter api test`
Expected: all previously-passing tests still pass; no new failures.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/v1/action/action_routes.ts \
        apps/api/src/routes/v1/action/perform_action.ts \
        apps/api/src/routes/v1/network/action/perform_action.ts \
        apps/api/src/routes/v1/action/__tests__/perform_action.test.ts
git commit -m "feat(api): voice on-behalf-of for /action/perform"
```

---

## Task 6: Wire `/action/update-status` with the same helper + persist audit

**Files:**
- Modify: `apps/api/src/routes/v1/action/update_action_status.ts`
- Create: `apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

const dbState: {
  userRows: Array<{ id: string; onboardedByOrgId: string | null }>;
  existingAction: any;
  updates: Array<Record<string, unknown>>;
} = {
  userRows: [],
  existingAction: null,
  updates: [],
};

vi.mock('@api/db/postgres/drizzle_config', () => {
  let nextSelect: 'user' | 'action' = 'action';
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => {
              const which = nextSelect;
              nextSelect = nextSelect === 'action' ? 'user' : 'action';
              if (which === 'user') return Promise.resolve(dbState.userRows);
              return Promise.resolve(dbState.existingAction ? [dbState.existingAction] : []);
            }),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => ({
            returning: vi.fn(() => {
              dbState.updates.push(values);
              return Promise.resolve([{
                ...(dbState.existingAction ?? {}),
                ...values,
                action_id: dbState.existingAction.action_id,
              }]);
            }),
          })),
        })),
      })),
    },
  };
});

vi.mock('@dpg/database', async () => {
  const actual = await vi.importActual<typeof import('@dpg/database')>('@dpg/database');
  return { ...actual, ensureActionEventPartition: vi.fn(async () => undefined) };
});

vi.mock('@/utils/action_event_runtime', async () => {
  const actual = await vi.importActual<typeof import('@/utils/action_event_runtime')>(
    '@/utils/action_event_runtime',
  );
  return {
    ...actual,
    buildActionEventPayload: vi.fn(() => ({})),
    validateActionEventPayload: vi.fn(),
    insertActionEvent: vi.fn(async () => undefined),
    mirrorActionEventToSourceInstance: vi.fn(() => undefined),
    fetchLocalItemSnapshot: vi.fn(async () => ({
      created_by: 'usr_voice_owned',
      item_id: 'target_item_1',
      item_latitude: null,
      item_longitude: null,
      item_private_state: {},
    })),
  };
});

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({ /* opaque */ })),
}));

vi.mock('@dpg/schemas', async () => {
  const actual = await vi.importActual<typeof import('@dpg/schemas')>('@dpg/schemas');
  return {
    ...actual,
    getActionInteraction: vi.fn(() => ({ event_schema: {} })),
  };
});

import { update_action_status } from '../update_action_status.js';

const EXISTING_ACTION = {
  action_id: '00000000-0000-0000-0000-000000000aaa',
  action_type: 'apply',
  action_status: 'created',
  update_count: 0,
  remarks: null,
  source_item_network: 'blue_dot',
  source_item_domain: 'seeker',
  source_item_type: 'profile_1.0',
  source_item_id: '11111111-1111-1111-1111-111111111111',
  source_item_instance_url: 'http://source.local',
  source_item_owner: 'usr_seeker',
  target_item_network: 'blue_dot',
  target_item_domain: 'provider',
  target_item_type: 'job_posting_1.0',
  target_item_id: '22222222-2222-2222-2222-222222222222',
  target_item_instance_url: 'http://target.local',
  target_item_owner: 'usr_voice_owned',
  requirements_snapshot: {},
};

const VALID_BODY = {
  action_id: EXISTING_ACTION.action_id,
  action_status: 'shortlisted',
};

const buildApp = (acting_org?: any, request_user = { id: 'usr_voice_owned' }): FastifyInstance => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', async (req) => {
    (req as any).user = request_user;
    if (acting_org) (req as any).acting_org = acting_org;
  });
  app.register(update_action_status);
  return app;
};

describe('POST /api/v1/action/update-status — on-behalf-of', () => {
  beforeEach(() => {
    dbState.userRows = [];
    dbState.existingAction = { ...EXISTING_ACTION };
    dbState.updates = [];
  });

  it('self-acted: writes audit nulls', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/update-status', payload: VALID_BODY });
    expect(res.statusCode).toBe(200);
    expect(dbState.updates[0]).toMatchObject({
      performed_by_org_id: null,
      performed_by_service_user_id: null,
    });
  });

  it('400 CANNOT_OVERRIDE_SELF when body field present but no acting_org', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_other' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 MISSING_ACTING_AS_USER_ID with voice acting_org and no body field', async () => {
    const app = buildApp({ org_id: 'org_voice_1', org_type: 'voice', service_user_id: 'svc' });
    const res = await app.inject({ method: 'POST', url: '/update-status', payload: VALID_BODY });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'MISSING_ACTING_AS_USER_ID' });
  });

  it('403 ACTING_ORG_TYPE_NOT_ALLOWED for aggregator', async () => {
    const app = buildApp({ org_id: 'org_agg', org_type: 'aggregator', service_user_id: 'svc_agg' });
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_voice_owned' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });
  });

  it('403 NOT_AUTHORIZED_FOR_TARGET when target onboarded by another voice org', async () => {
    dbState.userRows = [{ id: 'usr_voice_owned', onboardedByOrgId: 'org_voice_2' }];
    const app = buildApp({ org_id: 'org_voice_1', org_type: 'voice', service_user_id: 'svc' });
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_voice_owned' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'NOT_AUTHORIZED_FOR_TARGET' });
  });

  it('voice happy path: writes audit fields to the UPDATE', async () => {
    dbState.userRows = [{ id: 'usr_voice_owned', onboardedByOrgId: 'org_voice_1' }];
    const app = buildApp({ org_id: 'org_voice_1', org_type: 'voice', service_user_id: 'svc_voice_1' });
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_voice_owned' },
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.updates[0]).toMatchObject({
      performed_by_org_id: 'org_voice_1',
      performed_by_service_user_id: 'svc_voice_1',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/update_action_status.test.ts`
Expected: FAIL — all on-behalf-of cases fail because the route ignores the new fields and writes no audit columns.

- [ ] **Step 3: Update the handler**

Edit `apps/api/src/routes/v1/action/update_action_status.ts`. Add imports at the top:

```ts
import { user } from '@api/db/postgres/schema/auth';
import { resolve_acting_actor } from './_resolve_acting_actor.js';
```

Just after the `existingAction` lookup (current lines 56–67), insert the actor resolution. The "target user" for update-status authorization is the target item's owner (the provider whose item received the action):

```ts
  const actor = await resolve_acting_actor({
    acting_org: request.acting_org,
    request_user_id: request.user.id,
    acting_as_user_id: body.acting_as_user_id,
    lookup_onboarded_by: async (user_id) => {
      const rows = await db
        .select({ onboardedByOrgId: user.onboardedByOrgId })
        .from(user)
        .where(eq(user.id, user_id))
        .limit(1);
      return rows[0]?.onboardedByOrgId ?? null;
    },
  });

  if (!actor.ok) {
    const messages: Record<typeof actor.error, string> = {
      CANNOT_OVERRIDE_SELF:
        'acting_as_user_id requires an x-acting-org-id header from a voice-type service apikey.',
      MISSING_ACTING_AS_USER_ID:
        'voice-type acting_org requires acting_as_user_id in the request body.',
      ACTING_ORG_TYPE_NOT_ALLOWED:
        'only voice-type acting orgs may act on behalf of users today.',
      NOT_AUTHORIZED_FOR_TARGET:
        'acting_as_user_id is not a user onboarded by this voice org.',
    };
    return reply.code(actor.status).send({
      error: actor.error,
      message: messages[actor.error],
    });
  }

  if (existingAction.target_item_owner !== actor.effective_user_id) {
    return reply.code(403).send({
      error: 'NOT_TARGET_ITEM_OWNER',
      message: 'update-status may only be called by the target item owner (provider).',
    });
  }
```

Then, modify the `db.update(item_actions).set({…})` block (currently lines 148–156) to include the audit fields. The newest values overwrite, per spec; emit a WARN log if the existing row already had audit values:

```ts
  if (
    actor.audit.performed_by_org_id &&
    existingAction.performed_by_org_id &&
    existingAction.performed_by_org_id !== actor.audit.performed_by_org_id
  ) {
    request.log.warn(
      {
        action_id: existingAction.action_id,
        previous_performed_by_org_id: existingAction.performed_by_org_id,
        new_performed_by_org_id: actor.audit.performed_by_org_id,
      },
      'overwriting on-behalf-of audit fields on action update',
    );
  }

  const nextUpdateCount = existingAction.update_count + 1;
  const [updatedAction] = await db
    .update(item_actions)
    .set({
      action_status: body.action_status,
      update_count: nextUpdateCount,
      remarks: body.remarks ?? existingAction.remarks,
      updated_at: new Date(),
      performed_by_org_id: actor.audit.performed_by_org_id,
      performed_by_service_user_id: actor.audit.performed_by_service_user_id,
    })
    .where(eq(item_actions.action_id, existingAction.action_id))
    .returning({
      // unchanged returning fields
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
```

- [ ] **Step 4: Run the update-status tests**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/update_action_status.test.ts`
Expected: PASS — all six cases green.

- [ ] **Step 5: Run the full API unit test suite**

Run: `pnpm --filter api test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/action/update_action_status.ts \
        apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts
git commit -m "feat(api): voice on-behalf-of for /action/update-status"
```

---

## Task 7: Integration test against real Postgres

**Files:**
- Create: `apps/api/src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts`

Uses the same env-gated harness pattern as `apps/api/src/routes/v1/admin/__tests__/onboard_participant.integration.test.ts`. Run only via `pnpm --filter api test:integration`. Excluded from `pnpm --filter api test` by the existing vitest config glob (`*.integration.test.ts` is opt-in).

- [ ] **Step 1: Write the integration test**

Create `apps/api/src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts`. The test seeds a voice service user + apikey + voice org row, onboards a user via the voice org, creates a profile_1.0 item, calls `/api/v1/action/perform` with `x-api-key` + `x-acting-org-id` + `acting_as_user_id`, then asserts the row in `item_actions` has both audit columns populated and `source_item_owner` set to the target user.

Skeleton (fill in seed/factory references; pattern is taken from `onboard_participant.integration.test.ts`):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build_test_server } from '@/test_utils/build_test_server';
import { db } from '@api/db/postgres/drizzle_config';
import { item_actions } from '@dpg/database';
import { and, eq } from 'drizzle-orm';

const integrationGuard = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

integrationGuard('/action/perform on-behalf-of integration', () => {
  let server: Awaited<ReturnType<typeof build_test_server>>;
  let voice_org_id: string;
  let voice_service_user_id: string;
  let voice_apikey: string;
  let target_user_id: string;
  let source_item_id: string;

  beforeAll(async () => {
    server = await build_test_server();
    // 1) Seed voice org + service user + apikey via the seed util.
    const seeded = await server.seed_voice_service_user_and_org();
    voice_org_id = seeded.org_id;
    voice_service_user_id = seeded.service_user_id;
    voice_apikey = seeded.apikey;

    // 2) Onboard a user attributed to the voice org.
    const onboardRes = await server.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard_participant',
      headers: { 'x-api-key': voice_apikey, 'x-acting-org-id': voice_org_id },
      payload: {
        phone_number: '+919999999999',
        terms_accepted: true,
        privacy_accepted: true,
        onboarded_via: 'voice',
        onboarded_source_id: 'voice_session_test_1',
        profile_item: { /* minimal valid seeker profile */ },
      },
    });
    expect(onboardRes.statusCode).toBe(201);
    target_user_id = onboardRes.json().user_id;
    source_item_id = onboardRes.json().profile_item.item_id;
  });

  afterAll(async () => {
    await server.close();
  });

  it('files an action attributed to the target user with audit columns populated', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: { 'x-api-key': voice_apikey, 'x-acting-org-id': voice_org_id },
      payload: {
        action_type: 'apply',
        source_item: {
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          item_id: source_item_id,
        },
        target_item: {
          // a pre-seeded provider item; fixture lives in test_utils.
          item_network: 'blue_dot',
          item_domain: 'provider',
          item_type: 'job_posting_1.0',
          item_id: server.fixtures.provider_item_id,
          item_instance_url: server.api_base_url,
        },
        requirements_snapshot: {},
        acting_as_user_id: target_user_id,
      },
    });
    expect(res.statusCode).toBe(201);
    const action_id = res.json().action_id;

    const [row] = await db
      .select()
      .from(item_actions)
      .where(eq(item_actions.action_id, action_id))
      .limit(1);

    expect(row.source_item_owner).toBe(target_user_id);
    expect(row.performed_by_org_id).toBe(voice_org_id);
    expect(row.performed_by_service_user_id).toBe(voice_service_user_id);
  });

  it('rejects when another voice org tries to act for this user', async () => {
    const otherVoice = await server.seed_voice_service_user_and_org({ slug: 'voice-dpg-other' });
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/action/perform',
      headers: { 'x-api-key': otherVoice.apikey, 'x-acting-org-id': otherVoice.org_id },
      payload: {
        action_type: 'apply',
        source_item: {
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          item_id: source_item_id,
        },
        target_item: {
          item_network: 'blue_dot',
          item_domain: 'provider',
          item_type: 'job_posting_1.0',
          item_id: server.fixtures.provider_item_id,
          item_instance_url: server.api_base_url,
        },
        requirements_snapshot: {},
        acting_as_user_id: target_user_id,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'NOT_AUTHORIZED_FOR_TARGET' });
  });
});
```

If `build_test_server` doesn't yet expose `seed_voice_service_user_and_org` or `fixtures.provider_item_id`, extend it in the same commit — they belong to the integration harness, not production code. Mirror the pattern used by Plan 2's integration test (`apps/api/src/routes/v1/admin/__tests__/onboard_participant.integration.test.ts`).

- [ ] **Step 2: Run the integration test**

Run: `docker compose up -d db redis && pnpm --filter api test:integration` (or `RUN_INTEGRATION=1` via the project's existing convention — check `apps/api/vitest.config.ts` for the gate).
Expected: both cases pass.

- [ ] **Step 3: Run the standard unit suite to ensure the integration test does NOT run there**

Run: `pnpm --filter api test`
Expected: integration test is skipped/excluded; all unit tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts \
        apps/api/src/test_utils/*    # only if you extended the harness
git commit -m "test(api): integration test for /action/perform on-behalf-of"
```

---

## Task 8: Docs + Postman

**Files:**
- Modify: `docs/operations/integrating-dpgs.md`
- Modify: `docs/postman/Signals-DPG.postman_collection.json`

- [ ] **Step 1: Add the on-behalf-of section to integrating-dpgs.md**

Insert this section just before "## Voice DPG follows the same pattern" (currently line 326):

```markdown
## Acting on behalf of a user (voice only)

Voice DPG instances can file actions on behalf of users they onboarded.
Two endpoints accept an optional `acting_as_user_id` body field:

- `POST /api/v1/action/perform`
- `POST /api/v1/action/update-status`

### Required headers + body

```http
POST /api/v1/action/perform
x-api-key: <voice-dpg apikey>
x-acting-org-id: <voice org id from /admin/aggregator/upsert>

{
  "action_type": "apply",
  "source_item": { ... },
  "target_item": { ... },
  "requirements_snapshot": { ... },
  "acting_as_user_id": "<target user id>"
}
```

### Authorization rules

The target user (`acting_as_user_id`) must satisfy:

- `user.onboarded_by_org_id === <x-acting-org-id>`

The channel value (`user.onboarded_via`) is NOT part of the check — a
voice org that onboarded a user via `bulk` earlier can still act for that
user via `voice` later.

Only `voice`-type acting orgs may use `acting_as_user_id`. `aggregator`
and `network_service` callers receive `403 ACTING_ORG_TYPE_NOT_ALLOWED`.
Aggregator on-behalf-of is intentionally deferred (see the spec for the
when-product-asks path).

### Error matrix

| Caller shape | `acting_as_user_id` | Outcome |
|---|---|---|
| No `x-acting-org-id` | absent | Self-acted (unchanged). |
| No `x-acting-org-id` | present | `400 CANNOT_OVERRIDE_SELF` |
| Voice acting_org | absent | `400 MISSING_ACTING_AS_USER_ID` |
| Voice acting_org | present, owned by this voice org | `200 / 201` |
| Voice acting_org | present, owned by another org | `403 NOT_AUTHORIZED_FOR_TARGET` |
| Aggregator / network_service acting_org | any | `403 ACTING_ORG_TYPE_NOT_ALLOWED` |

### Audit trail

Successful on-behalf-of writes populate two columns on `item_actions`:

| Column | Value |
|---|---|
| `performed_by_org_id` | the voice org id from `x-acting-org-id` |
| `performed_by_service_user_id` | the apikey owner's user id (Signals service account) |

For self-acted writes, both columns are NULL. There are no indexes on
these columns today — query via `WHERE performed_by_org_id = $1`
sequentially when needed. Indexes will be added if audit queries
become a hot path.
```

- [ ] **Step 2: Update the error-code reference table**

Update the table at lines 280–286 of `docs/operations/integrating-dpgs.md` to mention that the on-behalf-of rows are added by `/action/*` only:

```markdown
| Caller asserts `acting_as_user_id` on `/action/*` with no `x-acting-org-id` | 400 | `CANNOT_OVERRIDE_SELF` | body field present, header absent |
| Caller asserts `x-acting-org-id` (voice) on `/action/*` with no `acting_as_user_id` | 400 | `MISSING_ACTING_AS_USER_ID` | header present, body field absent |
| `acting_as_user_id` is not a user onboarded by this voice org | 403 | `NOT_AUTHORIZED_FOR_TARGET` | `user.onboarded_by_org_id !== acting_org_id` |
| `acting_as_user_id` used by a non-voice org type | 403 | `ACTING_ORG_TYPE_NOT_ALLOWED` | only voice may act on behalf today |
```

Slot these rows below the existing rows in the same table.

- [ ] **Step 3: Add the related-plan link**

Append to the "Related plans" list at the end of the file (currently line 341+):

```markdown
- [Plan A — action perform on-behalf-of](../superpowers/plans/2026-05-22-action-perform-on-behalf-of.md) —
  this plan: voice DPG files actions on behalf of users it onboarded;
  adds the optional acting_org preHandler and two audit columns on
  `item_actions`.
```

- [ ] **Step 4: Add the two Postman requests**

Edit `docs/postman/Signals-DPG.postman_collection.json`. Under the Voice folder, add an "Apply on behalf of seeker" request — POST `/api/v1/action/perform` with the headers `x-api-key: {{voice_apikey}}` + `x-acting-org-id: {{voice_org_id}}` and the standard perform body plus `"acting_as_user_id": "{{target_user_id}}"`. Under the Provider folder, add "Accept on behalf of provider" — POST `/api/v1/action/update-status` with the same headers and `"action_id"`, `"action_status": "shortlisted"`, `"acting_as_user_id": "{{provider_user_id}}"`. Mirror the JSON shape of the existing "Apply" / "Update Status" requests; just add the two new headers and the body field.

Bind the `{{voice_apikey}}`, `{{voice_org_id}}`, `{{target_user_id}}`, `{{provider_user_id}}` variables in the local environment file (`docs/postman/environments/Signals-DPG-local.postman_environment.json`) with empty values; the README's "fill these in after seeding" list now grows.

- [ ] **Step 5: Run docs build (Astro) to catch broken links**

Run: `pnpm --filter docs build` (or whatever the existing `pnpm typecheck` runs for docs)
Expected: PASS — no broken-link warnings on the new plan-file link.

- [ ] **Step 6: Commit**

```bash
git add docs/operations/integrating-dpgs.md \
        docs/postman/Signals-DPG.postman_collection.json \
        docs/postman/environments/Signals-DPG-local.postman_environment.json
git commit -m "docs: voice on-behalf-of action endpoints + postman entries"
```

---

## Final checklist before opening PR

- [ ] All Task 1–8 commits land on `chore/plan-a-action-on-behalf-of`.
- [ ] `pnpm typecheck` is clean across api / ui / docs.
- [ ] `pnpm --filter api test` is clean.
- [ ] `pnpm schema:bundle:check` is clean (helm bundle matches checked-in copy).
- [ ] Manual run of `pnpm --filter api test:integration` is clean against a fresh `docker compose up -d db redis`.
- [ ] Postman environment values updated locally; collection imports cleanly.
- [ ] Open a single rolling PR per [[feedback-branch-per-task]]: branch off `develop`, single PR per plan, opened only when complete (not draft).

---

## Self-review notes

**Spec coverage (each section of the spec mapped to a task):**

| Spec section | Task(s) |
|---|---|
| Authorization matrix (§2) | Task 4 (helper) + Task 5 (perform) + Task 6 (update-status) |
| Schema changes — 2 audit columns (§3) | Task 2 |
| Three sources updated together (Drizzle, SQL bundle, helm) (§3.1) | Task 2 steps 1–5 |
| Wiring — optional preHandler (§4) | Task 3 + Task 5 step 3 |
| Behavior detail — perform handler (§5) | Task 5 |
| Behavior detail — update-status handler (§5) | Task 6 |
| Test plan — 14 unit cases (§7) | Task 4 (9 helper cases) + Task 5 (6 perform cases) + Task 6 (6 update-status cases) — 21 cases total, exceeding spec's 14 because the helper tests cover combinations cheaply |
| Test plan — integration test (§7) | Task 7 |
| Postman collection updates (§8) | Task 8 step 4 |
| Docs update (spec §9 implicit) | Task 8 steps 1–3 |
| Out of scope (§6) | Not implemented (deferred per spec) |

**Placeholder scan:** None. Every step contains either exact code, exact commands, or specific file:line references.

**Type consistency:** `resolve_acting_actor` returns the same `ResolveActingActorResult` shape used by both `perform_action.ts` and `update_action_status.ts`. The audit column names (`performed_by_org_id`, `performed_by_service_user_id`) are spelled identically across Drizzle, SQL, Zod, helper output, and both route handlers' `.values({})` / `.set({})` calls.

**Granularity:** Each task has 3–9 bite-sized steps, each 2–5 minutes. Largest steps (Task 5 step 4, Task 6 step 3) involve multi-line edits but stay scoped to a single handler each.
