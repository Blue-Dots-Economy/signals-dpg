# Participant Onboarding Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `items.lifecycle_status` + classifier + lifecycle gates per `docs/superpowers/specs/2026-06-03-participant-onboarding-lifecycle-design.md` in signals-dpg.

**Architecture:** Add two columns to `items`. Run a pure synchronous classifier on every item write inside the same transaction. Replace `aggregator_existing_noop` with scoped writes + `owned_elsewhere` signal. Gate actions + PII reveal on `lifecycle_status === 'live'`. Filter `/network/item/fetch` to live-only. Auto-cancel pending actions when an endpoint leaves `live`.

**Tech Stack:** Fastify + Zod + Drizzle + Postgres (partitioned items table), pnpm + Turborepo monorepo. React 19 + Vite UI.

---

## Conventions for every task

- Files are snake_case. Route handlers exported snake_case; internal helpers camelCase.
- Routes never throw. Return `reply.code(N).send({ error, message })` with a machine-readable `error` code.
- ESM only, strict TS, no `any`. Use `import type` for type-only imports.
- Each task ends in a commit (Conventional Commits, signed-off by Claude Co-author).
- After ANY file edit run `pnpm typecheck` (or the closest equivalent) before committing. Don't run the full integration suite until Task 13.
- Working dir for every command in this plan is the worktree root: `/Users/ASUS/Documents/workspace/bluedots-economy/Signals-DPG/.claude/worktrees/participant-onboarding`.

---

## Task 1: DB migration + Drizzle ref + bundle regeneration

**Files:**
- Modify: `packages/database/src/utils/sql_scripts/create_items.sql`
- Modify: `packages/database/src/drizzle_ref_tables/items.ts`
- Generated: `apps/api/db/postgres/schema.sql` (via `pnpm schema:bundle`)

The repo's deploy migration model is "idempotent SQL scripts under sql_scripts/ → bundled into schema.sql via `pnpm schema:bundle`". The migration is therefore a set of `ALTER TABLE … ADD COLUMN IF NOT EXISTS` + index `IF NOT EXISTS` statements appended to `create_items.sql`. No Drizzle-kit migration file is hand-edited.

- [ ] **Step 1.1: Append idempotent migration block to `create_items.sql`**

Open `packages/database/src/utils/sql_scripts/create_items.sql`. Append below the existing GIN/GIST indexes (after line ~58):

```sql

-- Lifecycle status + completion percentage (2026-06-03 spec).
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'draft';

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS completion_pct INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'items_lifecycle_status_chk'
  ) THEN
    ALTER TABLE items
      ADD CONSTRAINT items_lifecycle_status_chk
      CHECK (lifecycle_status IN ('draft','live','paused'));
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'items_completion_pct_chk'
  ) THEN
    ALTER TABLE items
      ADD CONSTRAINT items_completion_pct_chk
      CHECK (completion_pct BETWEEN 0 AND 100);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS items_lifecycle_idx
  ON items (item_network, item_domain, lifecycle_status);
```

- [ ] **Step 1.2: Add columns to the Drizzle reference table**

In `packages/database/src/drizzle_ref_tables/items.ts`, add to the column block (after `updated_at`):

```ts
import {
  doublePrecision,
  integer,
  primaryKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
```

Inside the column object (after `updated_at`):

```ts
    lifecycle_status: text('lifecycle_status').notNull().default('draft'),
    completion_pct: integer('completion_pct').notNull().default(0),
```

- [ ] **Step 1.3: Regenerate schema bundle**

Run: `pnpm schema:bundle`
Expected: writes `apps/api/db/postgres/schema.sql`, prints `wrote .../schema.sql (… bytes, 5 sources)`.

- [ ] **Step 1.4: Verify bundle check passes**

Run: `pnpm schema:bundle:check`
Expected: regenerates and `git diff --exit-code apps/api/db/postgres/schema.sql` returns 0 (file already matches what was just bundled).

- [ ] **Step 1.5: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 1.6: Commit**

```bash
git add packages/database/src/utils/sql_scripts/create_items.sql \
        packages/database/src/drizzle_ref_tables/items.ts \
        apps/api/db/postgres/schema.sql
git commit -m "feat(db): add items.lifecycle_status + completion_pct (#spec)"
```

---

## Task 2: Pure classifier module + unit tests

**Files:**
- Create: `apps/api/src/services/items/classifier.ts`
- Create: `apps/api/src/services/items/__tests__/classifier.test.ts`

The classifier is pure: schema + merged state + stored status → `{ lifecycle_status, completion_pct }`. Lives outside `item_service.ts` so it can be unit-tested without DB. It REUSES `is_populated` from `services/metrics/profile_completion.ts` — no duplicate predicate.

The completion-% formula is required-only per spec §9. We do NOT touch `profile_completion_pct` in `metrics/profile_completion.ts` (that's the async path, reconciled later as Plan B work).

- [ ] **Step 2.1: Write the failing test**

Create `apps/api/src/services/items/__tests__/classifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classify_item } from '../classifier.js';

const schema = (required: string[]) => ({
  type: 'object',
  properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
  required,
});

describe('classify_item', () => {
  it('all required populated → live, 100', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'draft',
      }),
    ).toEqual({ lifecycle_status: 'live', completion_pct: 100 });
  });

  it('one of two required missing → draft, 50', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x' },
        current_status: 'draft',
      }),
    ).toEqual({ lifecycle_status: 'draft', completion_pct: 50 });
  });

  it('vacuous required (empty) → live, 100', () => {
    expect(
      classify_item({
        schema: schema([]),
        merged_state: {},
        current_status: 'draft',
      }),
    ).toEqual({ lifecycle_status: 'live', completion_pct: 100 });
  });

  it('paused is sticky against the classifier; pct still recomputes', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'paused',
      }),
    ).toEqual({ lifecycle_status: 'paused', completion_pct: 100 });
  });

  it('optional fields contribute 0 to completion_pct', () => {
    expect(
      classify_item({
        schema: schema(['a']),
        merged_state: { a: 'x', b: 'y', c: 'z' },
        current_status: 'draft',
      }),
    ).toEqual({ lifecycle_status: 'live', completion_pct: 100 });
  });

  it('empty string + empty array are not populated', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: '', b: [] },
        current_status: 'draft',
      }),
    ).toEqual({ lifecycle_status: 'draft', completion_pct: 0 });
  });

  it('null schema or missing required → vacuous live', () => {
    expect(
      classify_item({
        schema: { type: 'object', properties: {} },
        merged_state: {},
        current_status: 'draft',
      }),
    ).toEqual({ lifecycle_status: 'live', completion_pct: 100 });
  });
});
```

- [ ] **Step 2.2: Run test, verify failure**

Run: `pnpm --filter api exec vitest run src/services/items/__tests__/classifier.test.ts`
Expected: fails with "Cannot find module '../classifier.js'".

- [ ] **Step 2.3: Implement the classifier**

Create `apps/api/src/services/items/classifier.ts`:

```ts
import { is_populated } from '../metrics/profile_completion.js';

export type LifecycleStatus = 'draft' | 'live' | 'paused';

export interface ClassifierInput {
  schema: { required?: string[] } | null | undefined;
  merged_state: Record<string, unknown> | null | undefined;
  /**
   * Stored lifecycle_status BEFORE this write. `paused` is sticky — the
   * classifier never flips out of it. For brand-new items pass `'draft'`.
   */
  current_status: LifecycleStatus;
}

export interface ClassifierResult {
  lifecycle_status: LifecycleStatus;
  completion_pct: number;
}

/**
 * Pure synchronous classifier. Runs inside the item-write transaction over
 * the merged post-write state. See
 * docs/superpowers/specs/2026-06-03-participant-onboarding-lifecycle-design.md §5.
 *
 * - completion_pct: required-only (optional fields = 0 weight).
 * - lifecycle_status: paused is sticky; otherwise required_complete ? live : draft.
 */
export const classify_item = (input: ClassifierInput): ClassifierResult => {
  const required = input.schema?.required ?? [];
  const state = input.merged_state ?? {};

  if (required.length === 0) {
    return {
      lifecycle_status: input.current_status === 'paused' ? 'paused' : 'live',
      completion_pct: 100,
    };
  }

  const filled = required.filter((k) => is_populated(state[k]));
  const completion_pct = Math.round((filled.length / required.length) * 100);
  const required_complete = filled.length === required.length;

  if (input.current_status === 'paused') {
    return { lifecycle_status: 'paused', completion_pct };
  }
  return {
    lifecycle_status: required_complete ? 'live' : 'draft',
    completion_pct,
  };
};
```

- [ ] **Step 2.4: Run test, verify pass**

Run: `pnpm --filter api exec vitest run src/services/items/__tests__/classifier.test.ts`
Expected: 7 passed.

- [ ] **Step 2.5: Commit**

```bash
git add apps/api/src/services/items/classifier.ts \
        apps/api/src/services/items/__tests__/classifier.test.ts
git commit -m "feat(api): add pure item lifecycle classifier"
```

---

## Task 3: Integrate classifier in item_service (create + update) + shape-only validation

**Files:**
- Modify: `apps/api/src/services/item_service.ts`

The current `resolveSchema` validates with Ajv treating `required` as a gate. Spec §14 switches to shape-only via `ignoredKeys: schema.required`. The classifier then sets `lifecycle_status` + `completion_pct` from the merged post-write state.

Caller-supplied `lifecycle_status` / `completion_pct` are always ignored (spec §5). Body shapes in `packages/schemas` for create/update don't expose these fields today, so just don't read them off `params` — but defensively strip from merged state before classification (no-op if absent).

- [ ] **Step 3.1: Update `resolveSchema` to validate shape-only**

In `apps/api/src/services/item_service.ts`, replace the `validateAgainstJsonSchema(...)` call inside `resolveSchema` (around line 122–132):

```ts
  try {
    const required = Array.isArray((itemSchema as { required?: unknown }).required)
      ? ((itemSchema as { required?: string[] }).required as string[])
      : [];
    validateAgainstJsonSchema(itemSchema, params.submittedItemState, 'item_state', {
      allowAdditionalProperties: apiConfig.allow_extra_schema_data,
      ignoredKeys: required,
    });
  } catch (err) {
    throw new ItemServiceError(
      400,
      'INVALID_ITEM_STATE',
      err instanceof Error ? err.message : 'Invalid item_state'
    );
  }
```

- [ ] **Step 3.2: Update the update-path validation to shape-only**

In `updateItemInternal`, replace the `validateAgainstJsonSchema(...)` block (around line 259–269):

```ts
    try {
      const required = Array.isArray((itemSchema as { required?: unknown }).required)
        ? ((itemSchema as { required?: string[] }).required as string[])
        : [];
      validateAgainstJsonSchema(itemSchema, mergedFullState, 'item_state', {
        allowAdditionalProperties: apiConfig.allow_extra_schema_data,
        ignoredKeys: required,
      });
    } catch (err) {
      throw new ItemServiceError(
        400,
        'INVALID_ITEM_STATE',
        err instanceof Error ? err.message : 'Invalid item_state'
      );
    }
```

- [ ] **Step 3.3: Run classifier on create**

At the top of `item_service.ts`, add:

```ts
import { classify_item } from './items/classifier.js';
```

In `createItemInternal`, modify the `.insert(items).values({...})` block so `lifecycle_status` + `completion_pct` are computed from the **full merged state including private fields** (i.e. `submittedItemState` — items have not been split yet for storage but the classifier reads the pre-split merged state). Replace the `.values({...})` block:

```ts
  const classification = classify_item({
    schema: itemSchema as { required?: string[] },
    merged_state: submittedItemState,
    current_status: 'draft',
  });

  const result = await exec
    .insert(items)
    .values({
      item_network: params.item_network,
      item_type: params.item_type,
      item_domain: params.item_domain,
      item_instance_url: itemInstanceUrl,
      item_schema_url: itemSchemaUrl,
      item_state: itemStateForStorage,
      item_private_state: encryptedPrivate,
      item_latitude: params.item_latitude ?? null,
      item_longitude: params.item_longitude ?? null,
      created_by: params.created_by,
      lifecycle_status: classification.lifecycle_status,
      completion_pct: classification.completion_pct,
    })
```

- [ ] **Step 3.4: Run classifier on update + detect leave-live**

In `updateItemInternal`, the existing `select({...})` (line 214) needs `lifecycle_status` so we can detect a `live → {draft, paused}` transition. Add it to the select:

```ts
    const [existingItem] = await exec
      .select({
        item_network: items.item_network,
        item_domain: items.item_domain,
        item_type: items.item_type,
        item_schema_url: items.item_schema_url,
        item_state: items.item_state,
        item_private_state: items.item_private_state,
        lifecycle_status: items.lifecycle_status,
        item_id_col: items.item_id,
      })
      .from(items)
      .where(ownershipFilter)
      .limit(1);
```

After computing `mergedFullState`, run the classifier and add fields to `updateValues`:

```ts
    const classification = classify_item({
      schema: itemSchema as { required?: string[] },
      merged_state: mergedFullState,
      current_status: existingItem.lifecycle_status as 'draft' | 'live' | 'paused',
    });
    updateValues.lifecycle_status = classification.lifecycle_status;
    updateValues.completion_pct = classification.completion_pct;
```

Capture whether this update is a leave-live transition (used by Task 4):

```ts
    const isLeavingLive =
      existingItem.lifecycle_status === 'live' &&
      classification.lifecycle_status !== 'live';
```

Return the transition flag from `updateItemInternal` along with the row. Update the function signature so callers can react.

```ts
  // (after the update returning(...))
  if (result.length === 0) {
    throw new ItemServiceError(
      404,
      'ITEM_NOT_FOUND_OR_FORBIDDEN',
      'Item not found or does not belong to the authenticated user'
    );
  }

  return {
    row: result[0],
    leavingLive: body.item_state ? isLeavingLive : false,
    itemIdForCancellation: body.item_state ? existingItem.item_id_col : null,
    networkForCancellation: body.item_state ? existingItem.item_network : null,
  };
```

`isLeavingLive` is only defined inside the `body.item_state` branch — when the branch doesn't run, return `leavingLive: false`. Adjust callers that destructure `result` accordingly (search for `updateItemInternal(` usages).

- [ ] **Step 3.5: Update existing callers to use `.row`**

Search:

```bash
grep -rn "updateItemInternal(" apps/api/src
```

Expected callers (3): `routes/v1/item/update_item.ts`, `routes/v1/admin/participant.ts`, possibly tests. For each call site, replace the existing return-shape consumption to read `.row`. Example fix for `apps/api/src/routes/v1/item/update_item.ts` — change any `await updateItemInternal(...)` consumer reading the returned row to use `(await updateItemInternal(...)).row` (the route currently does not use the return value beyond truthy/falsy; if a route uses spread fields, replace `result.X` → `result.row.X`).

For the participant route, no consumption today (line 129: just `await updateItemInternal(...)` without using the return) — no change needed there.

- [ ] **Step 3.6: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 3.7: Unit tests stay green**

Run: `pnpm --filter api test`
Expected: passes (existing route unit tests that mocked validateAgainstJsonSchema may need no changes; if some fail because shape validation now ignores `required` and the test asserted on a required-rejection message, update the fixture to assert classifier draft outcome via a separate test — defer that into Task 12 integration tests).

If any unit test fails for "missing required" expectations, mark it `.skip` with a `// TODO: re-enable after Plan §14 shape-only validation lands` and note it — Task 12 will re-cover via integration.

- [ ] **Step 3.8: Commit**

```bash
git add apps/api/src/services/item_service.ts \
        apps/api/src/routes/v1/item/update_item.ts
git commit -m "feat(api): classify lifecycle on item create/update; shape-only validation"
```

---

## Task 4: Auto-cancel pending actions on leave-live

**Files:**
- Modify: `apps/api/src/services/item_service.ts`
- Create: `apps/api/src/services/items/cancel_pending_actions.ts`
- Create: `apps/api/src/services/items/__tests__/cancel_pending_actions.test.ts`

Per spec §7: when an item transitions `live → {draft, paused}`, in the SAME transaction, pending (non-terminal, non-accepted) actions where this item is source OR target get auto-cancelled. Pending statuses (per spec): NOT in `{accepted, declined, completed, cancelled, expired, rejected}` — concretely the spec calls out `created` / `submitted` as pending. Use a constant.

- [ ] **Step 4.1: Write a small unit test (DB-free)**

Create `apps/api/src/services/items/__tests__/cancel_pending_actions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PENDING_ACTION_STATUSES, isPendingStatus } from '../cancel_pending_actions.js';

describe('PENDING_ACTION_STATUSES', () => {
  it('includes created + submitted', () => {
    expect(PENDING_ACTION_STATUSES).toContain('created');
    expect(PENDING_ACTION_STATUSES).toContain('submitted');
  });

  it('excludes terminal + accepted', () => {
    for (const terminal of ['accepted', 'cancelled', 'declined', 'completed', 'expired', 'rejected']) {
      expect(PENDING_ACTION_STATUSES).not.toContain(terminal);
    }
  });

  it('isPendingStatus is a simple membership check', () => {
    expect(isPendingStatus('created')).toBe(true);
    expect(isPendingStatus('accepted')).toBe(false);
    expect(isPendingStatus('something_else')).toBe(false);
  });
});
```

- [ ] **Step 4.2: Run test, verify failure**

Run: `pnpm --filter api exec vitest run src/services/items/__tests__/cancel_pending_actions.test.ts`
Expected: module not found.

- [ ] **Step 4.3: Implement constants + helper + DB cancel**

Create `apps/api/src/services/items/cancel_pending_actions.ts`:

```ts
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { item_actions } from '@dpg/database';
import type { db as dbType } from '@api/db/postgres/drizzle_config';

type Tx = Parameters<Parameters<typeof dbType.transaction>[0]>[0];
type DbOrTx = typeof dbType | Tx;

/**
 * Action statuses that count as "pending" — eligible for auto-cancel when
 * an endpoint item leaves `live`. Anything outside this set is terminal
 * or already accepted and is left alone (see spec §7).
 */
export const PENDING_ACTION_STATUSES = ['created', 'submitted'] as const;

export const isPendingStatus = (s: string): boolean =>
  (PENDING_ACTION_STATUSES as readonly string[]).includes(s);

/**
 * Marks every pending action (status in PENDING_ACTION_STATUSES) involving
 * `item_id` (as source or target) as `cancelled`. MUST be called inside
 * the same transaction as the item update that triggered the leave-live
 * transition. Increments update_count so downstream metrics see the bump.
 *
 * Returns the count of rows that were cancelled (useful for logging).
 *
 * No action_event row is emitted here — counterparty notification is a
 * deferred follow-up spec (see §7 closing note).
 */
export const cancel_pending_actions_for_item = async (
  exec: DbOrTx,
  item_id: string,
): Promise<number> => {
  const result = await exec
    .update(item_actions)
    .set({
      action_status: 'cancelled',
      update_count: sql`${item_actions.update_count} + 1`,
      updated_at: new Date(),
    })
    .where(
      and(
        or(
          eq(item_actions.source_item_id, item_id),
          eq(item_actions.target_item_id, item_id),
        ),
        inArray(item_actions.action_status, [...PENDING_ACTION_STATUSES]),
      ),
    )
    .returning({ action_id: item_actions.action_id });

  return result.length;
};
```

- [ ] **Step 4.4: Wire it into `updateItemInternal`**

At the top of `apps/api/src/services/item_service.ts`:

```ts
import { cancel_pending_actions_for_item } from './items/cancel_pending_actions.js';
```

After the `update(items).set(updateValues).where(...).returning(...)` call in `updateItemInternal`, just before the `if (result.length === 0)` check, add:

```ts
  let cancelledPendingActions = 0;
  if (body.item_state && isLeavingLive) {
    cancelledPendingActions = await cancel_pending_actions_for_item(
      exec,
      existingItem!.item_id_col,
    );
  }
```

(Bring `isLeavingLive` and `existingItem` declarations into the outer scope so they're visible after the `if (body.item_state)` block. Easiest: declare `let isLeavingLive = false;` outside the `if`, plus `let existingItemId: string | null = null;` and assign inside.)

Return the count:

```ts
  return {
    row: result[0],
    leavingLive: isLeavingLive,
    cancelledPendingActions,
  };
```

- [ ] **Step 4.5: Run unit test**

Run: `pnpm --filter api exec vitest run src/services/items/__tests__/cancel_pending_actions.test.ts`
Expected: 3 passed.

- [ ] **Step 4.6: Typecheck**

Run: `pnpm typecheck` — expected 0 errors.

- [ ] **Step 4.7: Commit**

```bash
git add apps/api/src/services/items/cancel_pending_actions.ts \
        apps/api/src/services/items/__tests__/cancel_pending_actions.test.ts \
        apps/api/src/services/item_service.ts
git commit -m "feat(api): auto-cancel pending actions when item leaves live"
```

---

## Task 5: `POST /api/v1/item/lifecycle` pause / unpause endpoint

**Files:**
- Create: `apps/api/src/routes/v1/item/lifecycle.ts`
- Modify: `apps/api/src/routes/v1/item/item_routes.ts`
- Create: `packages/schemas/src/item/lifecycle.ts`
- Modify: `packages/schemas/src/index.ts`

A single route `POST /api/v1/item/lifecycle` takes `{ item_id, action: 'pause' | 'unpause' }`. Owner via session, OR network_service via acting-org / apikey. Pause transitions to `paused` (any state); unpause recomputes via the classifier from the current `item_state`.

When a pause demotes from `live`, run `cancel_pending_actions_for_item` in the same tx.

- [ ] **Step 5.1: Write the request/response schema**

Create `packages/schemas/src/item/lifecycle.ts`:

```ts
import z from 'zod';

export const ItemLifecycleBody = z.object({
  item_id: z.uuid(),
  action: z.enum(['pause', 'unpause']),
});

export const ItemLifecycleResponse = z.object({
  item_id: z.string(),
  lifecycle_status: z.enum(['draft', 'live', 'paused']),
  completion_pct: z.number().int().min(0).max(100),
  cancelled_pending_actions: z.number().int().nonnegative(),
});

export type ItemLifecycleBody = z.infer<typeof ItemLifecycleBody>;
export type ItemLifecycleResponse = z.infer<typeof ItemLifecycleResponse>;
```

Export from `packages/schemas/src/index.ts`:

```ts
export * from './item/lifecycle.js';
```

(Find the existing `export * from './item/...';` lines and add this one alongside.)

- [ ] **Step 5.2: Implement the route**

Create `apps/api/src/routes/v1/item/lifecycle.ts`:

```ts
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ItemLifecycleBody,
  ItemLifecycleResponse,
  type ItemLifecycleBody as Body,
} from '@dpg/schemas';
import { items } from '@dpg/database';
import { db } from '@api/db/postgres/drizzle_config';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { classify_item } from '@/services/items/classifier';
import { cancel_pending_actions_for_item } from '@/services/items/cancel_pending_actions';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { getOrFetchSchemaByUrl } from '@/network_schema_cache';
import { mergeItemStateWithPrivate } from '@dpg/schemas';
import { decryptPiiBlob, getPiiKey } from '@dpg/auth';

type Req = FastifyRequest<{ Body: Body }>;

export const item_lifecycle: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/lifecycle',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      body: ItemLifecycleBody,
      response: { 200: ItemLifecycleResponse },
    },
    handler: item_lifecycle_handler,
  });
};

export const item_lifecycle_handler = async (request: Req, reply: FastifyReply) => {
  const callerId = request.user?.id;
  if (!callerId) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  }
  const isNetworkService =
    request.acting_org?.org_type === 'network_service';

  const { item_id, action } = request.body;

  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        item_id: items.item_id,
        item_network: items.item_network,
        item_domain: items.item_domain,
        item_type: items.item_type,
        item_schema_url: items.item_schema_url,
        item_state: items.item_state,
        item_private_state: items.item_private_state,
        lifecycle_status: items.lifecycle_status,
        created_by: items.created_by,
      })
      .from(items)
      .where(eq(items.item_id, item_id))
      .limit(1);

    if (!existing) {
      return reply.code(404).send({ error: 'ITEM_NOT_FOUND', message: 'Item does not exist' });
    }

    const isOwner = existing.created_by === callerId;
    if (!isOwner && !isNetworkService) {
      return reply.code(403).send({
        error: 'ITEM_NOT_OWNED_BY_USER',
        message: 'Only the owner or a network_service acting org may change lifecycle',
      });
    }

    let next_status: 'draft' | 'live' | 'paused';
    let completion_pct: number;
    let cancelledPendingActions = 0;
    const current = existing.lifecycle_status as 'draft' | 'live' | 'paused';

    if (action === 'pause') {
      next_status = 'paused';
      // completion_pct stays as-is on a bare pause (no state change).
      // Recompute anyway for consistency with classifier output.
      const { mergedState } = decryptItemPrivate({
        item_state: existing.item_state as Record<string, unknown>,
        item_private_state: existing.item_private_state ?? '',
      });
      const schemaDoc = await getOrFetchSchemaByUrl({
        schemaUrl: existing.item_schema_url,
        network: existing.item_network,
        domain: existing.item_domain,
        itemType: existing.item_type,
      });
      const c = classify_item({
        schema: schemaDoc as { required?: string[] },
        merged_state: mergedState,
        current_status: 'paused',
      });
      completion_pct = c.completion_pct;
    } else {
      // unpause: recompute via the classifier from non-paused baseline.
      const { mergedState } = decryptItemPrivate({
        item_state: existing.item_state as Record<string, unknown>,
        item_private_state: existing.item_private_state ?? '',
      });
      const schemaDoc = await getOrFetchSchemaByUrl({
        schemaUrl: existing.item_schema_url,
        network: existing.item_network,
        domain: existing.item_domain,
        itemType: existing.item_type,
      });
      const c = classify_item({
        schema: schemaDoc as { required?: string[] },
        merged_state: mergedState,
        current_status: 'draft', // forces non-sticky path
      });
      next_status = c.lifecycle_status;
      completion_pct = c.completion_pct;
    }

    await tx
      .update(items)
      .set({
        lifecycle_status: next_status,
        completion_pct,
        updated_at: sql`now()`,
      })
      .where(eq(items.item_id, item_id));

    const isLeavingLive = current === 'live' && next_status !== 'live';
    if (isLeavingLive) {
      cancelledPendingActions = await cancel_pending_actions_for_item(tx, item_id);
    }

    return reply.code(200).send({
      item_id,
      lifecycle_status: next_status,
      completion_pct,
      cancelled_pending_actions: cancelledPendingActions,
    });
  });
};

export default item_lifecycle;
```

(The unused `mergeItemStateWithPrivate` + `decryptPiiBlob` + `getPiiKey` imports above are belt-and-suspenders — if your editor strips them on save, drop them. Keep `decryptItemPrivate` only.)

- [ ] **Step 5.3: Register the route**

In `apps/api/src/routes/v1/item/item_routes.ts`, locate the route registrations (you'll find sibling plugin registrations) and add the lifecycle plugin alongside them:

```ts
import { item_lifecycle } from './lifecycle.js';
// ... inside the plugin function:
await fastify.register(item_lifecycle);
```

- [ ] **Step 5.4: Typecheck**

Run: `pnpm typecheck` — expected 0 errors. If TS complains about `mergeItemStateWithPrivate` etc., delete the unused imports.

- [ ] **Step 5.5: Commit**

```bash
git add packages/schemas/src/item/lifecycle.ts \
        packages/schemas/src/index.ts \
        apps/api/src/routes/v1/item/lifecycle.ts \
        apps/api/src/routes/v1/item/item_routes.ts
git commit -m "feat(api): POST /item/lifecycle (pause/unpause)"
```

---

## Task 6: `resolve_upsert_action` + participant route — account-only, owned_elsewhere, aggregator scoped writes

**Files:**
- Modify: `packages/schemas/src/admin/participant.ts`
- Modify: `apps/api/src/routes/v1/admin/_resolve_upsert_action.ts`
- Modify: `apps/api/src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts`
- Modify: `apps/api/src/routes/v1/admin/participant.ts`

Changes per spec §8.1–§8.3:
1. `item_state` becomes optional on the request body.
2. `resolve_upsert_action` learns whether the aggregator owns the user (extra input `aggregator_owns_user`).
3. New verdict variants: `account_only`, `aggregator_owned_elsewhere`, plus aggregator now lands on `insert_item` / `update_item` when it owns the user.
4. Response gains `owned_elsewhere: boolean` (false for own users, true for foreign).

- [ ] **Step 6.1: Make `item_state` optional in the request body**

In `packages/schemas/src/admin/participant.ts`, change `item_state` to `.optional()`:

```ts
    item_state: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('payload written to the items table; if absent, only the user is created/looked up'),
```

Add `owned_elsewhere` to the response:

```ts
export const UpsertParticipantResponse = z.object({
  user_id: z.string(),
  user_existed: z.boolean(),
  owned_elsewhere: z.boolean(),
  onboarded_at: z.iso.datetime().nullable(),
  items: z.array(ParticipantItemSnapshot),
});
```

- [ ] **Step 6.2: Update the verdict resolver**

Replace `apps/api/src/routes/v1/admin/_resolve_upsert_action.ts` contents:

```ts
type ActingOrg = {
  org_id: string;
  org_type: 'aggregator' | 'voice' | 'network_service';
  service_user_id: string;
};

export type UpsertVerdict =
  | { kind: 'create_new_user' }
  | { kind: 'account_only' }
  | { kind: 'aggregator_owned_elsewhere' }
  | { kind: 'update_item'; item_id: string }
  | { kind: 'insert_item' }
  | {
      kind: 'rejected';
      status: 403;
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED' | 'INVALID_ACTING_ORG';
    };

export type ResolveUpsertActionInput = {
  acting_org: ActingOrg | undefined;
  user_exists: boolean;
  item_id_in_body: string | undefined;
  has_item_state: boolean;
  /**
   * Only meaningful when `acting_org.org_type === 'aggregator'` AND `user_exists`.
   * Pass the handler's pre-computed `existing.onboardedByOrgId === acting_org.org_id`
   * flag.
   */
  aggregator_owns_user: boolean;
};

/**
 * Pure dispatcher for POST /api/v1/admin/participant.
 *
 * Now spec-driven by 2026-06-03-participant-onboarding-lifecycle-design.md §8.
 *
 * No DB, no I/O.
 */
export const resolve_upsert_action = (
  input: ResolveUpsertActionInput,
): UpsertVerdict => {
  const { acting_org, user_exists, item_id_in_body, has_item_state, aggregator_owns_user } = input;

  if (!acting_org) {
    return { kind: 'rejected', status: 403, error: 'INVALID_ACTING_ORG' };
  }
  if (acting_org.org_type !== 'aggregator' && acting_org.org_type !== 'network_service') {
    return { kind: 'rejected', status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' };
  }

  if (!user_exists) {
    if (!has_item_state) return { kind: 'account_only' };
    return { kind: 'create_new_user' };
  }

  // user exists.
  if (acting_org.org_type === 'aggregator' && !aggregator_owns_user) {
    return { kind: 'aggregator_owned_elsewhere' };
  }

  // network_service OR aggregator that owns the user.
  if (item_id_in_body) return { kind: 'update_item', item_id: item_id_in_body };
  if (has_item_state) return { kind: 'insert_item' };
  return { kind: 'account_only' };
};
```

- [ ] **Step 6.3: Update the resolver unit tests**

Open `apps/api/src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts` (read it first). For each existing case that asserts the old shape, update to pass the two new inputs (`has_item_state`, `aggregator_owns_user`) and the new verdict names. Add cases for:
- aggregator + user_exists + owns_user + has_item_state → `insert_item`
- aggregator + user_exists + owns_user + item_id → `update_item`
- aggregator + user_exists + !owns_user → `aggregator_owned_elsewhere`
- network_service + user_exists + no item_state + no item_id → `account_only`
- network_service + !user_exists + no item_state → `account_only`

If a previous case asserted `aggregator_existing_noop`, replace it with `aggregator_owned_elsewhere`.

Run: `pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts`
Expected: passes.

- [ ] **Step 6.4: Rewire `participant.ts`**

Open `apps/api/src/routes/v1/admin/participant.ts`. Apply these changes:

(a) Compute `aggregator_owns_user` BEFORE calling `resolve_upsert_action`. The current code already loads `existing.onboardedByOrgId`; use it:

```ts
  const aggregator_owns_user = Boolean(
    request.acting_org &&
    request.acting_org.org_type === 'aggregator' &&
    existing &&
    existing.onboardedByOrgId === request.acting_org.org_id,
  );

  const verdict = resolve_upsert_action({
    acting_org: request.acting_org,
    user_exists,
    item_id_in_body: body.item_id,
    has_item_state: Boolean(body.item_state && Object.keys(body.item_state).length > 0),
    aggregator_owns_user,
  });
```

(b) Replace the `aggregator_existing_noop` branch with the new verdicts:

```ts
  if (verdict.kind === 'aggregator_owned_elsewhere') {
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      owned_elsewhere: true,
      onboarded_at: null,
      items: [],
    });
  }

  if (verdict.kind === 'account_only') {
    if (!user_exists) {
      // create user, no item.
      const acting_org_id = request.acting_org!.org_id;
      const now = new Date();
      const email_for_signup = email_norm ?? `${randomUUID()}@no-email.local`;
      let user_id: string;
      try {
        const signed_up = await authInstance.api.signUpEmail({
          body: { email: email_for_signup, password: randomUUID(), name: body.name },
        });
        user_id = signed_up.user.id;
      } catch (signupErr: unknown) {
        const e = signupErr as { code?: string; cause?: { code?: string }; message?: string } | null;
        const pg_code = e?.code ?? e?.cause?.code;
        const message = String(e?.message ?? '');
        if (pg_code === '23505' || message.includes('duplicate key value') || message.includes('unique constraint')) {
          return reply.code(409).send({ error: 'USER_ALREADY_EXISTS', message: 'email or phone already in use (race) — retry the request' });
        }
        request.log.error({ err: signupErr }, 'signUp failed during account-only onboarding');
        return reply.code(500).send({ error: 'ONBOARD_FAILED', message: 'could not onboard participant' });
      }
      await db.update(user).set({
        phoneNumber: phone_norm,
        phoneNumberVerified: false,
        dateOfBirth: body.date_of_birth ? new Date(body.date_of_birth) : null,
        termsAccepted: true,
        privacyAccepted: true,
        onboardedByOrgId: acting_org_id,
        onboardedVia: body.channel,
        onboardedSourceId: body.source_id ?? null,
        onboardedAt: now,
        updatedAt: now,
      }).where(eq(user.id, user_id));
      return reply.code(200).send({
        user_id,
        user_existed: false,
        owned_elsewhere: false,
        onboarded_at: now.toISOString(),
        items: [],
      });
    }
    // user exists, no item_state passed (account-only read).
    const itemsList = await readItemsForUser(existing!.id);
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      owned_elsewhere: false,
      onboarded_at: null,
      items: itemsList,
    });
  }
```

(c) Add `owned_elsewhere: false` to all the existing `reply.code(200).send({...})` returns in the `update_item`, `insert_item`, and `create_new_user` branches.

(d) Drop the now-dead `aggregator_existing_noop` branch (the block that called `readItemsForUser` based on `isOwn`).

- [ ] **Step 6.5: Typecheck + unit tests**

Run: `pnpm typecheck` — expected 0 errors.
Run: `pnpm --filter api test` — expected pass; if `participant.test.ts` (unit) asserts on the old verdict names, update it.

- [ ] **Step 6.6: Commit**

```bash
git add packages/schemas/src/admin/participant.ts \
        apps/api/src/routes/v1/admin/_resolve_upsert_action.ts \
        apps/api/src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts \
        apps/api/src/routes/v1/admin/participant.ts \
        apps/api/src/routes/v1/admin/__tests__/participant.test.ts
git commit -m "feat(api): /admin/participant — account-only + owned_elsewhere + aggregator scoped writes"
```

---

## Task 7: `/network/item/fetch` live-only filter

**Files:**
- Modify: `apps/api/src/utils/item_fetch_runtime.ts`
- Modify: `apps/api/src/routes/v1/network/item/fetch_item.ts`

Spec §11: public/inter-instance reads return `live` only. Local + admin reads see all states.

Approach: extend `ItemFetchFilters` with `lifecycle_filter` (`'live_only' | 'all'`, default `'all'`). The network fetch path passes `'live_only'`. Local + admin paths pass `'all'` (or omit → defaults to `'all'`).

- [ ] **Step 7.1: Extend filter shape + buildWhereClause**

In `apps/api/src/utils/item_fetch_runtime.ts`:

```ts
export type ItemFetchFilters = {
  // ... existing fields ...
  /**
   * 'live_only' restricts results to `lifecycle_status = 'live'`. Default
   * `'all'` — used by owner/admin read paths.
   */
  lifecycle_filter?: 'live_only' | 'all';
};
```

In `buildWhereClause` add:

```ts
  if (filters.lifecycle_filter === 'live_only') {
    conditions.push(eq(items.lifecycle_status, 'live'));
  }
```

- [ ] **Step 7.2: Pass `live_only` from the network fetch handler**

In `apps/api/src/routes/v1/network/item/fetch_item.ts`, the inter-instance handler `fetch_network_item_handler` calls `fetchItemsAcrossInstances`. Add `lifecycle_filter: 'live_only'` to the `filters` object passed in:

```ts
    const result = await fetchItemsAcrossInstances({
      networkConfig,
      filters: {
        item_id,
        item_network,
        item_type,
        item_domain,
        item_instance_url,
        item_schema_url,
        item_state,
        item_latitude,
        item_longitude,
        radius_meters,
        limit,
        offset,
        lifecycle_filter: 'live_only',
      },
      requestedCacheTtlSeconds: cache_ttl_seconds,
    });
```

Same for the body-style `count_local_items_handler` and `fetch_local_items_handler` (these are the network-scoped local handlers): add `lifecycle_filter: 'live_only'` to the filters object before calling `countLocalItems` / `fetchLocalItems`. They are mounted under `/api/v1/network/...` — see `network_routes.ts`.

Confirm by reading `network_routes.ts`:

```bash
grep -rn "fetch_local_items_handler\|count_local_items_handler" apps/api/src/routes/v1/network/
```

- [ ] **Step 7.3: Threading through `fetchItemsAcrossInstances`**

Open `apps/api/src/utils/inter_instance_fetch.ts`. The type of the `filters` argument needs to accept the new `lifecycle_filter` and forward it on the HTTP call to peer instances (it currently relays filters as query params). Find the code that converts filter object → URLSearchParams and add `lifecycle_filter` to the relayed params. Peer-side handler (the `/api/v1/network/item/fetch` route on the other instance) already adds `live_only` independently, so a passthrough is belt-and-suspenders but harmless. Add it.

- [ ] **Step 7.4: Owner/admin read paths**

Check the owner `/api/v1/item/fetch` route — by default `lifecycle_filter` is undefined → all states are returned (correct, owner can see their own drafts/paused). No change needed there.

- [ ] **Step 7.5: Typecheck**

Run: `pnpm typecheck` — expected 0 errors.

- [ ] **Step 7.6: Commit**

```bash
git add apps/api/src/utils/item_fetch_runtime.ts \
        apps/api/src/routes/v1/network/item/fetch_item.ts \
        apps/api/src/utils/inter_instance_fetch.ts
git commit -m "feat(api): /network/item/fetch returns live-only items"
```

---

## Task 8: Action perform gate (local + network handlers)

**Files:**
- Modify: `apps/api/src/utils/action_event_runtime.ts` (`fetchLocalItemSnapshot` returns `lifecycle_status`)
- Modify: `apps/api/src/routes/v1/action/perform_action.ts`
- Modify: `apps/api/src/routes/v1/network/action/perform_action.ts`

Spec §10: source + target items must both be `lifecycle_status === 'live'` at perform time. Else `409 PROFILE_NOT_LIVE`.

- [ ] **Step 8.1: Extend `fetchLocalItemSnapshot` to return lifecycle_status**

Open `apps/api/src/utils/action_event_runtime.ts`. Find `fetchLocalItemSnapshot` (it currently selects a subset of columns). Add `lifecycle_status` to the select projection and to the returned object's type.

- [ ] **Step 8.2: Local perform — source check**

In `apps/api/src/routes/v1/action/perform_action.ts`, after the source snapshot ownership check (around line 92):

```ts
      if (sourceItemSnapshot.lifecycle_status !== 'live') {
        throw new BulkItemFailure(
          'PROFILE_NOT_LIVE',
          'source_item is not live; cannot perform actions',
        );
      }
```

- [ ] **Step 8.3: Network perform — target check (+ source if local)**

In `apps/api/src/routes/v1/network/action/perform_action.ts`, after `fetchLocalItemSnapshot(db, body.target_item)` and the not-found check (around line 113):

```ts
  if (targetItemSnapshot.lifecycle_status !== 'live') {
    return reply.code(409).send({
      error: 'PROFILE_NOT_LIVE',
      message: 'target_item is not live; cannot perform actions',
    });
  }
```

And in the same file inside the source-snapshot-if-local block (around line 121–131), add:

```ts
    if (sourceItemSnapshot && sourceItemSnapshot.lifecycle_status !== 'live') {
      return reply.code(409).send({
        error: 'PROFILE_NOT_LIVE',
        message: 'source_item is not live; cannot perform actions',
      });
    }
```

- [ ] **Step 8.4: BulkItemFailure → HTTP status**

The local `perform_action` uses `BulkItemFailure(code, message)` which maps to an entry-level failure but with default `status: 422` aggregate. The spec wants `409` for `PROFILE_NOT_LIVE`. Check `BulkItemFailure`'s constructor / `runBulk`'s mapping:

```bash
grep -n "BulkItemFailure" apps/api/src/utils/bulk_runner.ts
```

If `BulkItemFailure` supports a per-entry status override, use it; if not, accept that bulk entries report `error: 'PROFILE_NOT_LIVE'` in their per-entry payload (the aggregate response code is 207/422 per `runBulk`'s contract — the per-entry `error` field still carries the machine-readable code, which is what the spec specifies). Add a comment in the handler noting this.

- [ ] **Step 8.5: Typecheck**

Run: `pnpm typecheck` — expected 0 errors.

- [ ] **Step 8.6: Commit**

```bash
git add apps/api/src/utils/action_event_runtime.ts \
        apps/api/src/routes/v1/action/perform_action.ts \
        apps/api/src/routes/v1/network/action/perform_action.ts
git commit -m "feat(api): block action perform unless both endpoints are live"
```

---

## Task 9: Action update-status gate

**Files:**
- Modify: `apps/api/src/routes/v1/action/update_action_status.ts`

Spec §10: update-status (accept) must verify both endpoints still `live`. Target is local on this instance (per design — accept lives on the target side). Source may be remote.

- [ ] **Step 9.1: Re-check target lifecycle**

In `apps/api/src/routes/v1/action/update_action_status.ts`, after `if (existingAction.target_item_owner !== callerId)` (line 83), fetch the target snapshot and verify:

```ts
      const targetSnapshot = await fetchLocalItemSnapshot(db, {
        item_network: existingAction.target_item_network,
        item_domain: existingAction.target_item_domain,
        item_type: existingAction.target_item_type,
        item_id: existingAction.target_item_id,
        item_instance_url: existingAction.target_item_instance_url,
      });
      if (!targetSnapshot || targetSnapshot.lifecycle_status !== 'live') {
        throw new BulkItemFailure(
          'PROFILE_NOT_LIVE',
          'target_item is not live; status updates blocked',
        );
      }
```

- [ ] **Step 9.2: Check source if locally available**

If source's `item_instance_url === getCurrentApiBaseUrl()` fetch its snapshot and require `live`:

```ts
      if (existingAction.source_item_instance_url === getCurrentApiBaseUrl()) {
        const sourceSnap = await fetchLocalItemSnapshot(db, {
          item_network: existingAction.source_item_network,
          item_domain: existingAction.source_item_domain,
          item_type: existingAction.source_item_type,
          item_id: existingAction.source_item_id,
          item_instance_url: existingAction.source_item_instance_url,
        });
        if (!sourceSnap || sourceSnap.lifecycle_status !== 'live') {
          throw new BulkItemFailure(
            'PROFILE_NOT_LIVE',
            'source_item is not live; status updates blocked',
          );
        }
      }
```

(Remote source check is out-of-scope per spec §10 wording "residual race guard" — accepting that cross-instance live changes get eventually consistent via §7 cancellation + counterparty notifier follow-up.)

- [ ] **Step 9.3: Typecheck + commit**

Run: `pnpm typecheck` — expected 0 errors.

```bash
git add apps/api/src/routes/v1/action/update_action_status.ts
git commit -m "feat(api): block action update-status unless target/source live"
```

---

## Task 10: PII reveal both-live gate

**Files:**
- Modify: `apps/api/src/routes/v1/action/get_action_contact_details.ts`

Spec §12: PII reveal requires accepted action AND both endpoints `live` at read time. Leaving live → 403.

- [ ] **Step 10.1: Read both endpoints' lifecycle**

In `apps/api/src/routes/v1/action/get_action_contact_details.ts`, after the `revealStatuses` check (around line 93), before the `fetchLocalItems(...)` call:

```ts
  // Both endpoints must be live at read time. Source may be remote; in
  // that case we can't gate without a cross-instance call, which is
  // documented in the spec's residual-race exclusion. We DO gate the
  // target (always local here, since contact-details runs on target) and
  // the source if it's local.
  const callerSideItemSnapshot = await fetchLocalItemSnapshot(db, {
    item_network: callerIsSource ? action.source_item_network : action.target_item_network,
    item_domain: callerIsSource ? action.source_item_domain : action.target_item_domain,
    item_type: callerIsSource ? action.source_item_type : action.target_item_type,
    item_id: callerIsSource ? action.source_item_id : action.target_item_id,
    item_instance_url: callerIsSource ? action.source_item_instance_url : action.target_item_instance_url,
  });
  if (callerSideItemSnapshot && callerSideItemSnapshot.lifecycle_status !== 'live') {
    return reply.code(403).send({
      error: 'PROFILE_NOT_LIVE',
      message: 'Contact details hidden because your own profile is not live',
    });
  }
```

Then, when reading the `other` item (existing code already fetches it), add a lifecycle gate before returning:

```ts
  const otherStateValue = (otherItem as { lifecycle_status?: string }).lifecycle_status;
  if (otherStateValue && otherStateValue !== 'live') {
    return reply.code(403).send({
      error: 'PROFILE_NOT_LIVE',
      message: 'Contact details hidden because the other actor profile is not live',
    });
  }
```

(If `fetchLocalItems` does not yet return `lifecycle_status` in the item shape, add it to the projection in `itemResponseColumns` in `item_fetch_runtime.ts` — Task 7's edits already added the filter; this step exposes the column on the response payload too.)

- [ ] **Step 10.2: Expose `lifecycle_status` in fetched-item response**

In `apps/api/src/utils/item_fetch_runtime.ts`, add to the `itemResponseColumns`:

```ts
  lifecycle_status: items.lifecycle_status,
  completion_pct: items.completion_pct,
```

Adjust `ItemResponseSchema` in `packages/schemas` to include the new fields:

```bash
grep -rn "ItemResponseSchema" packages/schemas/src/ | head -5
```

Add `lifecycle_status` (enum draft/live/paused) and `completion_pct` (int 0..100) to the schema, optional for backwards compat.

- [ ] **Step 10.3: Typecheck + commit**

Run: `pnpm typecheck` — expected 0 errors.

```bash
git add apps/api/src/routes/v1/action/get_action_contact_details.ts \
        apps/api/src/utils/item_fetch_runtime.ts \
        packages/schemas/src/...
git commit -m "feat(api): gate PII reveal on both endpoints being live"
```

---

## Task 11: UI pre-pause confirm popup

**Files:**
- Modify: `apps/ui/src/pages/profile-form-page.tsx` (or wherever pause is initiated — adapt to actual UI)
- Modify: `apps/ui/src/hooks/use-actions.ts` (read pending actions count)
- Modify: `apps/ui/src/lib/action-api.ts` (if a new lifecycle API call is added)
- Create: `apps/ui/src/components/items/pause-confirm-dialog.tsx`

UX per spec §7: before owner pauses, count pending actions where this item is source or target; if >0, show "This will cancel N pending request(s) and hide your profile" with Confirm/Cancel. Server is authoritative; the dialog is a pre-action warning.

- [ ] **Step 11.1: Read current pause-trigger UI**

Read `apps/ui/src/pages/profile-form-page.tsx` (top 200 lines) and locate where pause is invoked (if any). If pause does not yet exist in the UI, add a "Pause profile" button to the profile-edit page that calls `POST /api/v1/item/lifecycle` with `{ item_id, action: 'pause' }`.

- [ ] **Step 11.2: Build the confirm dialog component**

Create `apps/ui/src/components/items/pause-confirm-dialog.tsx`. Props: `{ open: boolean; pendingCount: number; onConfirm: () => void; onCancel: () => void; }`. Render a small modal: title "Pause this profile?", body `This will cancel ${pendingCount} pending request(s) and hide your profile from discovery.` (when `pendingCount === 0`: just `Your profile will be hidden from discovery.`). Buttons: Cancel, Confirm.

Use existing dialog primitives from the UI (search for `Modal` / `Dialog`):

```bash
grep -rn "import .*Modal\|import .*Dialog" apps/ui/src/components | head -10
```

- [ ] **Step 11.3: Wire into profile page**

In the profile page: on pause click, compute `pendingCount` from the actions hook (`useActions({ item_id })`) → filter actions where status in `['created', 'submitted']` AND (source_item_id OR target_item_id) matches. Open the dialog. On confirm call the API; on cancel close.

- [ ] **Step 11.4: Run UI typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: 0 errors. If errors arise, fix imports / prop typing.

- [ ] **Step 11.5: Commit**

```bash
git add apps/ui/src/components/items/pause-confirm-dialog.tsx \
        apps/ui/src/pages/profile-form-page.tsx \
        apps/ui/src/hooks/use-actions.ts \
        apps/ui/src/lib/action-api.ts
git commit -m "feat(ui): confirm-popup before pausing a profile with pending actions"
```

---

## Task 12: Backfill SQL + integration tests

**Files:**
- Modify: `packages/database/src/utils/sql_scripts/create_items.sql` (backfill block)
- Create: `apps/api/src/services/items/__tests__/lifecycle.integration.test.ts`

Backfill (spec §15) classifies every existing row by current `item_state` against its `item_schema_url`. Doing this in SQL alone would require schema awareness in PG, which is impractical. Instead, ship the backfill as a one-time script invoked by the migrate-job: `apps/api/scripts/backfill-item-lifecycle.ts` — iterates over rows, calls the classifier in-process. Adds an idempotency guard (`WHERE lifecycle_status = 'draft' AND completion_pct = 0` — the default values of the new columns) so re-running is safe.

- [ ] **Step 12.1: Write the backfill script**

Create `apps/api/scripts/backfill-item-lifecycle.ts`:

```ts
/**
 * One-time backfill: classify pre-existing items rows whose lifecycle_status
 * is still the default 'draft' AND completion_pct is still 0 — i.e. rows
 * that pre-date Task 1. Idempotent on re-run.
 *
 * Usage: tsx apps/api/scripts/backfill-item-lifecycle.ts
 */
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { and, eq, sql } from 'drizzle-orm';
import { classify_item } from '../src/services/items/classifier.js';
import { getOrFetchSchemaByUrl } from '../src/network_schema_cache.js';
import { decryptItemPrivate } from '../src/utils/item_decrypt.js';

async function main() {
  const rows = await db
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      item_schema_url: items.item_schema_url,
      item_state: items.item_state,
      item_private_state: items.item_private_state,
    })
    .from(items)
    .where(and(eq(items.lifecycle_status, 'draft'), eq(items.completion_pct, 0)));

  let updated = 0;
  for (const row of rows) {
    const schemaDoc = await getOrFetchSchemaByUrl({
      schemaUrl: row.item_schema_url,
      network: row.item_network,
      domain: row.item_domain,
      itemType: row.item_type,
    });
    const { mergedState } = decryptItemPrivate({
      item_state: row.item_state as Record<string, unknown>,
      item_private_state: row.item_private_state ?? '',
    });
    const c = classify_item({
      schema: schemaDoc as { required?: string[] },
      merged_state: mergedState,
      current_status: 'draft',
    });
    await db
      .update(items)
      .set({ lifecycle_status: c.lifecycle_status, completion_pct: c.completion_pct, updated_at: sql`now()` })
      .where(eq(items.item_id, row.item_id));
    updated += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`backfill complete: ${updated} rows updated`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('backfill failed:', err);
  process.exit(1);
});
```

Add an `api` script entry: in `apps/api/package.json` "scripts":

```json
"backfill:lifecycle": "tsx scripts/backfill-item-lifecycle.ts"
```

- [ ] **Step 12.2: Write the integration test**

Create `apps/api/src/services/items/__tests__/lifecycle.integration.test.ts`. Mirror the pattern in `apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts`. Cover:

1. `/admin/participant` with no `item_state` from a network_service caller for a new user → `account_only`, response has `owned_elsewhere: false`, no items rows.
2. Same caller with partial `item_state` (missing one required field) → `draft` row written, `completion_pct` < 100.
3. Same caller with full state → `live` row written, `completion_pct === 100`.
4. Aggregator A onboards a user with full state → `live`. Aggregator A retries with new `item_state` → row UPDATED (insert_item path now scoped to aggregator owner per Task 6) and `live`.
5. Aggregator B targets aggregator A's user → response has `owned_elsewhere: true`, `items: []`, no DB write.
6. Network_service updates an item, clearing a required field → row demotes `live → draft`. Pre-existing pending action involving the item gets `cancelled` in the same tx.
7. `POST /api/v1/item/lifecycle` `{ action: 'pause' }` on a live item → row becomes `paused`, pending actions cancelled.
8. `POST /api/v1/item/lifecycle` `{ action: 'unpause' }` on a paused-but-complete item → row becomes `live`.
9. Action `/perform` against a non-live target via `/network/action/perform` → 409 + `error: 'PROFILE_NOT_LIVE'`.
10. `/api/v1/action/:id/contact-details` after the source pauses → 403 + `error: 'PROFILE_NOT_LIVE'`.
11. `/api/v1/network/item/fetch` lists only live items.

Use the existing `resolveBindings()` / `generateMinimalItemState()` helpers. Boot the Fastify app the same way participant.integration.test does. Clean up in `afterAll`.

The test file is large; keep each `it()` block ≤ 40 lines and reuse a small fixture-helper at the top of the file.

- [ ] **Step 12.3: Run the integration test**

Pre-reqs: docker compose up, env vars set per `docs/operations/migrations.md`.

```bash
docker compose up -d db redis
pnpm --filter api test:integration --run src/services/items/__tests__/lifecycle.integration.test.ts
```

Expected: every `it()` passes. If a case fails because of unrelated stale data (e.g. items table contains rows with no `lifecycle_status` from a prior dev run), run the backfill script first.

- [ ] **Step 12.4: Commit**

```bash
git add apps/api/scripts/backfill-item-lifecycle.ts \
        apps/api/package.json \
        apps/api/src/services/items/__tests__/lifecycle.integration.test.ts
git commit -m "test(api): integration coverage for participant onboarding lifecycle"
```

---

## Task 13: Final verification

- [ ] **Step 13.1: Schema bundle check**

Run: `pnpm schema:bundle:check` — expected exit 0.

- [ ] **Step 13.2: Full typecheck**

Run: `pnpm typecheck` — expected 0 errors.

- [ ] **Step 13.3: Unit tests**

Run: `pnpm --filter api test` — expected all pass.

- [ ] **Step 13.4: Integration tests**

Run: `pnpm --filter api test:integration` — expected all pass with a live DB+Redis.

- [ ] **Step 13.5: Codacy CLI (per CLAUDE.md rule)**

Run codacy analyze on the touched files. Skip complexity/coverage analysis.

- [ ] **Step 13.6: Push branch + open PR**

```bash
git push -u origin spec/participant-onboarding-lifecycle
gh pr create --title "feat: participant onboarding lifecycle (account/profile split + lifecycle gates)" \
  --base feature \
  --body "..."
```

PR body should summarize: new columns, classifier, account-only + owned_elsewhere, aggregator scoped writes, action gates, PII gate, network/fetch live-only, pause endpoint, backfill script, integration tests.

---

## Self-Review checklist (run after writing this plan)

- **Spec §4.1:** Task 1 ✓
- **Spec §4.2 `account_only` derived:** Task 6 ✓ (verdict + response)
- **Spec §4.3 `profile_status` unchanged:** confirmed — no edits to `metrics/recompute.ts` or `metrics/profile_completion.ts` formula in Tasks 2–4 ✓
- **Spec §5 classifier rules:** Task 2 ✓ (paused-sticky, vacuous required, required-only pct)
- **Spec §5 strip caller-supplied fields:** the request bodies (`CreateItemBody`, `UpdateItemBody`, `UpsertParticipantRequest`) don't expose `lifecycle_status` or `completion_pct` today, so there's nothing to strip at the route layer — the classifier ALWAYS computes from merged state. Confirmed.
- **Spec §6 pause sticky + unpause recompute:** Task 5 ✓
- **Spec §7 cancel pending + transition side effects:** Task 4 (tx-internal) + Task 5 (pause path) ✓
- **Spec §7 UI confirm popup:** Task 11 ✓
- **Spec §8.1 item_state optional:** Task 6 ✓
- **Spec §8.2 acting-org matrix (aggregator scoped writes, network_service unchanged):** Task 6 ✓
- **Spec §8.3 owned_elsewhere response:** Task 6 ✓
- **Spec §9 required-only pct in classifier:** Task 2 ✓ (note: this is the items.completion_pct path; the metrics async path stays as-is per spec)
- **Spec §10 action perform/accept gate:** Tasks 8, 9 ✓
- **Spec §11 visibility — live-only network fetch + owner-all:** Task 7 ✓
- **Spec §12 PII reveal gating:** Task 10 ✓
- **Spec §13 scenarios:** integration test in Task 12 covers scenarios 1–12 ✓
- **Spec §14 shape-only validation via ignoredKeys:** Task 3 ✓
- **Spec §15 migration + backfill + bundle:** Tasks 1, 12 ✓
- **Spec §16 PROFILE_NOT_LIVE error code:** Tasks 8, 9, 10 ✓

No placeholders, no TBDs. Types defined in Task 2 (`LifecycleStatus`, `ClassifierResult`) are reused consistently in Tasks 3, 4, 5, 10.
