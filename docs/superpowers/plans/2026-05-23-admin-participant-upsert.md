# Admin Participant Upsert (Tier-aware) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `POST /api/v1/admin/onboard_participant` with `POST /api/v1/admin/participant`, a tier-aware upsert that supports new-user creation, existing-user reads (scoped to own-aggregator for aggregator callers), item updates via `item_id`, and additional-item inserts. Response always returns the post-write items set for the targeted user, scoped to served-domain networks.

**Architecture:** A pure `resolve_upsert_action` helper captures the authorization matrix and returns one of five verdicts (`create_new_user` / `aggregator_existing_noop` / `update_item` / `insert_item` / `rejected`); the route handler dispatches on the verdict and reuses existing item-service helpers for the writes. A runtime ownership check after `update_item` produces `403 ITEM_NOT_OWNED_BY_USER`. Two side-tasks ride in the same PR: add `admin`/`aggregator` OpenAPI tags to existing routes, and update the Postman collection with the 8 new admin-participant scenarios plus a fix to the action on-behalf-of body.

**Tech Stack:** Fastify, Zod via `fastify-type-provider-zod`, Drizzle ORM, Postgres, Vitest. All changes in `apps/api`, `packages/schemas`, plus docs + Postman.

**Spec:** [docs/superpowers/specs/2026-05-23-admin-participant-upsert-design.md](../specs/2026-05-23-admin-participant-upsert-design.md)

**Related plans:** Plan 1 (`2026-05-21-aggregator-service-auth.md`), Plan 2 (`2026-05-21-participant-onboarding-attribution.md` — implements the endpoint this plan replaces), Plan A (`2026-05-22-action-perform-on-behalf-of.md` — sets the pattern for tier-aware authorization via a pure helper).

---

## File map (created vs. modified vs. renamed)

**Renamed (file move):**
- `packages/schemas/src/admin/onboard_participant.ts` → `packages/schemas/src/admin/participant.ts`
- `apps/api/src/routes/v1/admin/onboard_participant.ts` → `apps/api/src/routes/v1/admin/participant.ts`

**Created:**
- `apps/api/src/routes/v1/admin/_resolve_upsert_action.ts` — pure helper, returns the verdict union.
- `apps/api/src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts` — 9 unit cases.
- `apps/api/src/routes/v1/admin/__tests__/participant.test.ts` — route-level tests (mocked DB), 13 cases.
- `apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts` — real-PG integration, 6 cases.

**Modified:**
- `apps/api/src/routes/v1/admin/admin_routes.ts` — replace `onboard_participant` import with `participant`.
- `packages/schemas/src/index.ts` (or whatever re-exports schemas — verify during Task 1) — drop old names, add new names.
- Every route file under `apps/api/src/routes/v1/admin/**` — add `tags: ['admin']` to the Fastify route `schema.tags` array.
- Every route file under `apps/api/src/routes/v1/aggregator/**` — add `tags: ['aggregator']`.
- `docs/postman/Signals-DPG.postman_collection.json` — add `08 Admin Participant` folder with 8 requests; fix the `Apply on behalf of seeker` body's `requirements_snapshot` to use `{{action_requirements_snapshot_json}}`.
- `docs/postman/Blue-Dots.postman_environment.json` + `Purple-Dots.postman_environment.json` — add 4 new env vars (`action_requirements_snapshot_json`, `network_service_org_id`, `aggregator_b_api_key`, `aggregator_b_org_id`).
- `docs/operations/integrating-dpgs.md` — replace the "onboard a participant" section with the new endpoint + matrix; mention the tier model explicitly.

**Deleted at end of Task 3:**
- The old test file `apps/api/src/routes/v1/admin/__tests__/onboard_participant.test.ts` (replaced by the new `participant.test.ts`).
- The old integration test `apps/api/src/routes/v1/admin/__tests__/onboard_participant.integration.test.ts` (replaced by `participant.integration.test.ts`).

---

## Task ordering rationale

1. **Schemas first** (Task 1) — every other layer reads these types. The Zod renames must land before any handler code references them.
2. **Pure helper next** (Task 2) — captures the matrix logic in isolation; subsequent tasks just call it.
3. **Route handler** (Task 3) — wires the helper + writes + reads together. Replaces the old handler atomically (file rename) so the codebase has exactly one truth.
4. **Integration test** (Task 4) — proves the whole stack against real PG, including the cross-aggregator empty-items case.
5. **OpenAPI tags** (Task 5) — small mechanical change; isolating it keeps the diff clean.
6. **Postman + env files** (Task 6) — consumer-facing artifacts; do these after the API is settled.
7. **Docs** (Task 7) — last; prose follows what shipped.

---

## Task 1: Rename + extend the participant Zod schemas

**Files:**
- Move: `packages/schemas/src/admin/onboard_participant.ts` → `packages/schemas/src/admin/participant.ts`
- Modify: `packages/schemas/src/index.ts` (or the file that re-exports admin schemas — check `packages/schemas/src/` listing).

- [ ] **Step 1: Read context**

```bash
ls packages/schemas/src/admin/
ls packages/schemas/src/
```

Note where the admin schemas are re-exported from (look for `export * from './admin/onboard_participant'` or similar). The new file must be re-exported from the same place.

- [ ] **Step 2: Create the new schema file (move + rewrite)**

Create `packages/schemas/src/admin/participant.ts` with:

```ts
import z from 'zod';

/**
 * Body for POST /api/v1/admin/participant.
 *
 * Tier-aware upsert. Called by aggregator-dpg / voice-dpg / any
 * integrating service to ensure a participant exists on Signals and
 * to add/update their items.
 *
 * Identity rules:
 *  - At least one of `email` or `phone_number` is required (refine).
 *  - Phone numbers are E.164.
 *
 * Consent rules:
 *  - Both `terms_accepted` and `privacy_accepted` must be literally true.
 *
 * Attribution:
 *  - `channel` tags the broad onboarding surface.
 *  - `source_id` is opaque to Signals.
 *
 * `item_state` is the payload written into the items table. `item_id`
 * (optional) targets a specific existing item to update — only
 * meaningful when acting_org is network_service AND the user already
 * exists; ignored otherwise.
 */

const PhoneE164 = z
  .string()
  .regex(/^\+\d{10,15}$/, 'must be E.164 (e.g. +911234567890)');

export const UpsertParticipantRequest = z
  .object({
    email: z.email().optional(),
    phone_number: PhoneE164.optional(),
    name: z.string().min(1),
    date_of_birth: z.iso.datetime().optional(),
    terms_accepted: z
      .boolean()
      .refine((v) => v === true, 'terms_accepted must be true'),
    privacy_accepted: z
      .boolean()
      .refine((v) => v === true, 'privacy_accepted must be true'),
    channel: z.enum(['bulk', 'link', 'voice', 'self']),
    source_id: z.string().min(1).optional(),
    item_state: z
      .record(z.string(), z.unknown())
      .describe('payload written to the items table'),
    item_id: z
      .uuid()
      .optional()
      .describe(
        'UUID. Only meaningful when acting_org is network_service AND user already exists. ' +
        'Targets that specific item for a PATCH-style update. Ignored otherwise.',
      ),
    network: z
      .string()
      .min(1)
      .optional()
      .describe(
        "network id (default: 'blue_dot'). Set when this Signals instance serves a different network.",
      ),
    domain: z
      .string()
      .min(1)
      .optional()
      .describe("domain within the network (default: 'seeker')."),
    item_type: z
      .string()
      .min(1)
      .optional()
      .describe(
        "schema-typed item_type for the item (default: 'profile_1.0').",
      ),
  })
  .refine((b) => Boolean(b.email) || Boolean(b.phone_number), {
    message: 'either email or phone_number is required',
    path: ['email'],
  });

const ItemSnapshot = z.object({
  item_id: z.string(),
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  item_state: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export const UpsertParticipantResponse = z.object({
  user_id: z.string(),
  user_existed: z.boolean(),
  onboarded_at: z.iso.datetime().nullable(),
  items: z.array(ItemSnapshot),
});

export type UpsertParticipantRequest = z.infer<typeof UpsertParticipantRequest>;
export type UpsertParticipantResponse = z.infer<typeof UpsertParticipantResponse>;
```

- [ ] **Step 3: Delete the old schema file**

```bash
git rm packages/schemas/src/admin/onboard_participant.ts
```

(Don't `mv` — we're replacing the type names, so a fresh delete + create is clearer in the diff.)

- [ ] **Step 4: Update re-exports**

Open the schemas re-export file (likely `packages/schemas/src/index.ts` — find via `grep -n onboard_participant packages/schemas/src/index.ts`). Replace:

```ts
export * from './admin/onboard_participant';
// or
export { OnboardParticipantRequest, ... } from './admin/onboard_participant';
```

with:

```ts
export * from './admin/participant';
// or
export { UpsertParticipantRequest, UpsertParticipantResponse } from './admin/participant';
```

- [ ] **Step 5: Typecheck just the schemas package**

Run: `pnpm --filter @dpg/schemas typecheck`
Expected: PASS.

Don't typecheck the api yet — Task 3 still references the old names and will fail until the handler is rewritten. The schema typecheck alone proves the new file is well-formed.

- [ ] **Step 6: Commit**

```bash
git add -A packages/schemas/src/admin/participant.ts \
         packages/schemas/src/admin/onboard_participant.ts \
         packages/schemas/src/index.ts
git commit -m "refactor(schemas): rename onboard_participant -> participant, add item_id"
```

---

## Task 2: Pure `resolve_upsert_action` helper + unit tests

**Files:**
- Create: `apps/api/src/routes/v1/admin/_resolve_upsert_action.ts`
- Create: `apps/api/src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolve_upsert_action } from '../_resolve_upsert_action.js';

const aggregator = {
  org_id: 'org_agg_a',
  org_type: 'aggregator' as const,
  service_user_id: 'svc_agg',
};
const networkService = {
  org_id: 'org_signals',
  org_type: 'network_service' as const,
  service_user_id: 'svc_signals',
};
const voice = {
  org_id: 'org_voice_x',
  org_type: 'voice' as const,
  service_user_id: 'svc_voice',
};

describe('resolve_upsert_action', () => {
  it('rejects when acting_org is undefined', () => {
    const v = resolve_upsert_action({
      acting_org: undefined,
      user_exists: false,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({ kind: 'rejected', status: 403, error: 'INVALID_ACTING_ORG' });
  });

  it('rejects voice-typed acting_org', () => {
    const v = resolve_upsert_action({
      acting_org: voice,
      user_exists: false,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({ kind: 'rejected', status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });
  });

  it('aggregator + new user -> create_new_user', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: false,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({ kind: 'create_new_user' });
  });

  it('aggregator + existing user -> aggregator_existing_noop', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({ kind: 'aggregator_existing_noop' });
  });

  it('aggregator + existing user + item_id (item_id ignored) -> aggregator_existing_noop', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: '11111111-1111-4111-8111-111111111111',
    });
    expect(v).toEqual({ kind: 'aggregator_existing_noop' });
  });

  it('network_service + new user -> create_new_user', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: false,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({ kind: 'create_new_user' });
  });

  it('network_service + new user + item_id (item_id ignored) -> create_new_user', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: false,
      item_id_in_body: '22222222-2222-4222-8222-222222222222',
    });
    expect(v).toEqual({ kind: 'create_new_user' });
  });

  it('network_service + existing user + item_id -> update_item', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: '33333333-3333-4333-8333-333333333333',
    });
    expect(v).toEqual({
      kind: 'update_item',
      item_id: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('network_service + existing user + no item_id -> insert_item', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({ kind: 'insert_item' });
  });
});
```

- [ ] **Step 2: Confirm the test fails**

```bash
pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts
```

Expected: FAIL — `Cannot find module '../_resolve_upsert_action.js'`.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/routes/v1/admin/_resolve_upsert_action.ts`:

```ts
type ActingOrg = {
  org_id: string;
  org_type: 'aggregator' | 'voice' | 'network_service';
  service_user_id: string;
};

export type UpsertVerdict =
  | { kind: 'create_new_user' }
  | { kind: 'aggregator_existing_noop' }
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
};

/**
 * Pure dispatcher for POST /api/v1/admin/participant. Captures the
 * authorization matrix in
 * docs/superpowers/specs/2026-05-23-admin-participant-upsert-design.md.
 *
 * No DB, no I/O. The handler runs this synchronously and then dispatches
 * on the verdict.
 *
 * The runtime check for "item belongs to this user" (which produces
 * ITEM_NOT_OWNED_BY_USER) lives in the handler AFTER the helper returns
 * `update_item` — keeping this function pure.
 */
export const resolve_upsert_action = (
  input: ResolveUpsertActionInput,
): UpsertVerdict => {
  const { acting_org, user_exists, item_id_in_body } = input;

  if (!acting_org) {
    return { kind: 'rejected', status: 403, error: 'INVALID_ACTING_ORG' };
  }

  if (
    acting_org.org_type !== 'aggregator' &&
    acting_org.org_type !== 'network_service'
  ) {
    return {
      kind: 'rejected',
      status: 403,
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
    };
  }

  if (!user_exists) {
    return { kind: 'create_new_user' };
  }

  if (acting_org.org_type === 'aggregator') {
    return { kind: 'aggregator_existing_noop' };
  }

  // acting_org.org_type === 'network_service' && user_exists
  if (item_id_in_body) {
    return { kind: 'update_item', item_id: item_id_in_body };
  }
  return { kind: 'insert_item' };
};
```

- [ ] **Step 4: Run the test, confirm 9/9 PASS**

```bash
pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts
```

Expected: 9 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/admin/_resolve_upsert_action.ts \
        apps/api/src/routes/v1/admin/__tests__/resolve_upsert_action.test.ts
git commit -m "feat(api): pure resolve_upsert_action helper with matrix unit tests"
```

---

## Task 3: Replace the route handler

**Files:**
- Delete: `apps/api/src/routes/v1/admin/onboard_participant.ts`
- Delete: `apps/api/src/routes/v1/admin/__tests__/onboard_participant.test.ts`
- Create: `apps/api/src/routes/v1/admin/participant.ts`
- Create: `apps/api/src/routes/v1/admin/__tests__/participant.test.ts`
- Modify: `apps/api/src/routes/v1/admin/admin_routes.ts`

- [ ] **Step 1: Pre-reading**

```bash
# Confirm signatures of existing helpers the handler will call.
grep -n "export" apps/api/src/services/item_service.ts | head
grep -n "create_profile_item" apps/api/src/lib/profile_item.ts
grep -n "mergeItemStateWithPrivate" packages/schemas/src/item_state_privacy.ts
grep -n "served_domains" apps/api/src/config.ts
```

Note especially:
- `createItemInternal(tx, params)` returns `{ itemNetwork, itemDomain, itemType, itemId }`.
- `updateItemInternal(tx, itemId, callerId, isAdmin, body)` throws `ItemServiceError(404, 'ITEM_NOT_FOUND_OR_FORBIDDEN')` on ownership mismatch — we'll do the ownership check ourselves first to produce `403 ITEM_NOT_OWNED_BY_USER`.
- `apiConfig.served_domains` is an array of `{ network, domain }`.

- [ ] **Step 2: Write the failing route test**

Create `apps/api/src/routes/v1/admin/__tests__/participant.test.ts`. The existing `onboard_participant.test.ts` is the closest template; structure mirrors it.

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

// --- shared mutable DB state captured by the mocks below ---
const dbState: {
  existingUserRows: Array<{
    id: string;
    email: string | null;
    phoneNumber: string | null;
    onboardedByOrgId: string | null;
  }>;
  signUpMode: 'ok' | 'unique_violation';
  signUpUserId: string;
  attributionUpdates: Array<{ id: string; set: Record<string, unknown> }>;
  itemsByUser: Map<string, Array<Record<string, unknown>>>; // user_id -> items[]
  itemOwnerLookup: Map<string, string>; // item_id -> created_by user_id
  updates: Array<{ item_id: string; set: Record<string, unknown> }>;
  inserts: Array<Record<string, unknown>>;
  deletes: Array<{ user_id: string }>;
} = {
  existingUserRows: [],
  signUpMode: 'ok',
  signUpUserId: 'usr_test_default',
  attributionUpdates: [],
  itemsByUser: new Map(),
  itemOwnerLookup: new Map(),
  updates: [],
  inserts: [],
  deletes: [],
};

vi.mock('@api/db/postgres/drizzle_config', () => {
  // user lookup, items list, items ownership lookup all go through db.select.
  // Discriminate by projection shape (cf. Plan A's pattern).
  const select = vi.fn((projection?: Record<string, unknown>) => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => {
          if (projection && 'onboardedByOrgId' in projection) {
            // not used here — user lookup uses a wider projection
            return Promise.resolve(dbState.existingUserRows);
          }
          if (projection && 'createdBy' in projection) {
            // ownership lookup for update_item path
            const item_id = (dbState.lastSelectItemId ??= '');
            const owner = dbState.itemOwnerLookup.get(item_id) ?? null;
            return Promise.resolve(owner ? [{ created_by: owner }] : []);
          }
          // Default: user lookup with full projection { id, email, phoneNumber, onboardedByOrgId }
          return Promise.resolve(dbState.existingUserRows);
        }),
        orderBy: vi.fn(() => {
          // Items listing
          const user_id = dbState.lastSelectUserId ?? '';
          return Promise.resolve(dbState.itemsByUser.get(user_id) ?? []);
        }),
      })),
    })),
  })) as unknown as ReturnType<typeof vi.fn>;
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => {
        if ('item_id' in values || values.updated_at) {
          dbState.updates.push({ item_id: 'see-mock', set: values });
          return Promise.resolve();
        }
        dbState.attributionUpdates.push({ id: dbState.signUpUserId, set: values });
        return Promise.resolve();
      }),
    })),
  }));
  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = { select, update, insert: vi.fn() };
    return cb(tx);
  });
  const deleteFn = vi.fn(() => ({
    where: vi.fn(() => {
      dbState.deletes.push({ user_id: dbState.signUpUserId });
      return Promise.resolve();
    }),
  }));
  return {
    db: { select, update, transaction, delete: deleteFn },
  };
});

vi.mock('@/routes/auth/create_auth', () => ({
  authInstance: {
    api: {
      signUpEmail: vi.fn(async () => {
        if (dbState.signUpMode === 'unique_violation') {
          const err: Error & { code?: string } = new Error('duplicate key value');
          err.code = '23505';
          throw err;
        }
        return { user: { id: dbState.signUpUserId } };
      }),
    },
  },
}));

vi.mock('@/lib/profile_item', () => ({
  create_profile_item: vi.fn(async ({ user_id, payload }) => {
    const item_id = `item_${Math.random().toString(36).slice(2, 8)}`;
    const newItem = {
      item_id,
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_type: 'profile_1.0',
      item_state: payload,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    dbState.itemsByUser.set(user_id, [
      ...(dbState.itemsByUser.get(user_id) ?? []),
      newItem,
    ]);
    dbState.itemOwnerLookup.set(item_id, user_id);
    dbState.inserts.push({ user_id, item_id });
    return { item_id };
  }),
}));

vi.mock('@/services/item_service', () => ({
  updateItemInternal: vi.fn(async (_tx, item_id: string, callerId: string, isAdmin: boolean, body) => {
    const owner = dbState.itemOwnerLookup.get(item_id);
    if (!isAdmin && owner !== callerId) {
      const err: Error & { statusCode?: number; errorCode?: string } = new Error('forbidden');
      err.statusCode = 404;
      err.errorCode = 'ITEM_NOT_FOUND_OR_FORBIDDEN';
      throw err;
    }
    dbState.updates.push({ item_id, set: body });
    // Reflect the update in itemsByUser
    const list = dbState.itemsByUser.get(owner!) ?? [];
    const updated = list.map((it) =>
      it.item_id === item_id ? { ...it, ...body, updated_at: new Date().toISOString() } : it,
    );
    dbState.itemsByUser.set(owner!, updated);
    return { item_id };
  }),
  ItemServiceError: class ItemServiceError extends Error {
    statusCode: number;
    errorCode: string;
    constructor(statusCode: number, errorCode: string, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  },
}));

vi.mock('@dpg/database', () => ({
  ensureItemPartition: vi.fn(async () => undefined),
}));

vi.mock('@/config', () => ({
  apiConfig: {
    allow_extra_schema_data: false,
    served_domains: [
      { network: 'blue_dot', domain: 'seeker' },
      { network: 'blue_dot', domain: 'provider' },
    ],
  },
  getCurrentApiBaseUrl: () => 'http://test.local',
}));

// Imported AFTER mocks.
import { participant } from '../participant.js';

const validBody = (extra: Record<string, unknown> = {}) => ({
  email: 'a@b.com',
  name: 'Test',
  terms_accepted: true,
  privacy_accepted: true,
  channel: 'bulk' as const,
  item_state: { name: 'Test' },
  ...extra,
});

const buildApp = (
  acting?: { org_id?: string; org_type?: 'aggregator' | 'voice' | 'network_service' },
): FastifyInstance => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    if (acting) {
      (req as any).acting_org = {
        org_id: acting.org_id ?? 'org_agg_a',
        org_type: acting.org_type ?? 'aggregator',
        service_user_id: 'svc_test',
      };
    }
    (req as any).user = { id: 'svc_test_user' };
  });
  app.register(participant);
  return app;
};

describe('POST /admin/participant', () => {
  beforeEach(() => {
    dbState.existingUserRows = [];
    dbState.signUpMode = 'ok';
    dbState.signUpUserId = `usr_test_${Math.random().toString(36).slice(2, 8)}`;
    dbState.attributionUpdates = [];
    dbState.itemsByUser = new Map();
    dbState.itemOwnerLookup = new Map();
    dbState.updates = [];
    dbState.inserts = [];
    dbState.deletes = [];
  });

  it('403 INVALID_ACTING_ORG when acting_org is missing', async () => {
    const app = buildApp(undefined);
    const res = await app.inject({ method: 'POST', url: '/participant', payload: validBody() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('INVALID_ACTING_ORG');
  });

  it('403 ACTING_ORG_TYPE_NOT_ALLOWED for voice', async () => {
    const app = buildApp({ org_type: 'voice' });
    const res = await app.inject({ method: 'POST', url: '/participant', payload: validBody() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ACTING_ORG_TYPE_NOT_ALLOWED');
  });

  it('aggregator + new user -> creates user + item, returns items[1]', async () => {
    const app = buildApp({ org_type: 'aggregator', org_id: 'org_agg_a' });
    const res = await app.inject({ method: 'POST', url: '/participant', payload: validBody() });
    expect(res.statusCode).toBe(200);
    expect(res.json().user_existed).toBe(false);
    expect(res.json().items).toHaveLength(1);
    expect(dbState.inserts).toHaveLength(1);
  });

  it('aggregator + existing OWN user -> returns items, no writes', async () => {
    dbState.existingUserRows = [
      { id: 'usr_existing', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_agg_a' },
    ];
    dbState.itemsByUser.set('usr_existing', [
      {
        item_id: 'item_1',
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { name: 'Existing' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const app = buildApp({ org_type: 'aggregator', org_id: 'org_agg_a' });
    const res = await app.inject({ method: 'POST', url: '/participant', payload: validBody() });
    expect(res.statusCode).toBe(200);
    expect(res.json().user_existed).toBe(true);
    expect(res.json().onboarded_at).toBeNull();
    expect(res.json().items).toHaveLength(1);
    expect(dbState.inserts).toHaveLength(0);
    expect(dbState.updates).toHaveLength(0);
  });

  it('aggregator + existing OTHER-aggregator user -> returns items:[] empty, no writes', async () => {
    dbState.existingUserRows = [
      { id: 'usr_other', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_agg_b' },
    ];
    dbState.itemsByUser.set('usr_other', [
      {
        item_id: 'item_2',
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const app = buildApp({ org_type: 'aggregator', org_id: 'org_agg_a' });
    const res = await app.inject({ method: 'POST', url: '/participant', payload: validBody() });
    expect(res.statusCode).toBe(200);
    expect(res.json().user_existed).toBe(true);
    expect(res.json().items).toEqual([]);
    expect(dbState.inserts).toHaveLength(0);
    expect(dbState.updates).toHaveLength(0);
  });

  it('aggregator + existing SELF-REGISTERED user (onboarded_by null) -> returns items:[]', async () => {
    dbState.existingUserRows = [
      { id: 'usr_self', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: null },
    ];
    dbState.itemsByUser.set('usr_self', [
      {
        item_id: 'item_3',
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const app = buildApp({ org_type: 'aggregator', org_id: 'org_agg_a' });
    const res = await app.inject({ method: 'POST', url: '/participant', payload: validBody() });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it('network_service + new user -> creates user + item', async () => {
    const app = buildApp({ org_type: 'network_service' });
    const res = await app.inject({ method: 'POST', url: '/participant', payload: validBody() });
    expect(res.statusCode).toBe(200);
    expect(res.json().user_existed).toBe(false);
    expect(res.json().items).toHaveLength(1);
    expect(dbState.inserts).toHaveLength(1);
  });

  it('network_service + existing user + valid item_id -> updates that item', async () => {
    dbState.existingUserRows = [
      { id: 'usr_existing', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_agg_a' },
    ];
    dbState.itemsByUser.set('usr_existing', [
      {
        item_id: 'item_target',
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { name: 'Old' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    dbState.itemOwnerLookup.set('item_target', 'usr_existing');
    const app = buildApp({ org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: validBody({ item_id: 'item_target', item_state: { name: 'New' } }),
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0].item_id).toBe('item_target');
  });

  it('network_service + existing user + invalid item_id (other user) -> 403 ITEM_NOT_OWNED_BY_USER', async () => {
    dbState.existingUserRows = [
      { id: 'usr_existing', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_agg_a' },
    ];
    dbState.itemOwnerLookup.set('item_owned_by_other', 'usr_someone_else');
    const app = buildApp({ org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: validBody({ item_id: 'item_owned_by_other' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ITEM_NOT_OWNED_BY_USER');
    expect(dbState.updates).toHaveLength(0);
  });

  it('network_service + existing user + no item_id -> inserts another item', async () => {
    dbState.existingUserRows = [
      { id: 'usr_existing', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_agg_a' },
    ];
    dbState.itemsByUser.set('usr_existing', [
      {
        item_id: 'item_existing',
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const app = buildApp({ org_type: 'network_service' });
    const res = await app.inject({ method: 'POST', url: '/participant', payload: validBody() });
    expect(res.statusCode).toBe(200);
    expect(dbState.inserts).toHaveLength(1);
    expect(res.json().items.length).toBeGreaterThanOrEqual(2);
  });

  it('network_service + existing user + duplicate (network, domain, item_type) + no item_id -> still inserts', async () => {
    dbState.existingUserRows = [
      { id: 'usr_existing', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_agg_a' },
    ];
    dbState.itemsByUser.set('usr_existing', [
      {
        item_id: 'item_existing',
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const app = buildApp({ org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: validBody({ network: 'blue_dot', domain: 'seeker', item_type: 'profile_1.0' }),
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.inserts).toHaveLength(1);
  });

  it('400 when neither email nor phone_number is provided', async () => {
    const app = buildApp({ org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: { name: 'X', terms_accepted: true, privacy_accepted: true, channel: 'bulk', item_state: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('items response is scoped to served-domain networks (cross-network items filtered out)', async () => {
    dbState.existingUserRows = [
      { id: 'usr_existing', email: 'a@b.com', phoneNumber: null, onboardedByOrgId: 'org_agg_a' },
    ];
    dbState.itemsByUser.set('usr_existing', [
      {
        item_id: 'item_blue',
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        item_id: 'item_yellow',
        item_network: 'onest_yellow_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        item_state: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const app = buildApp({ org_type: 'aggregator', org_id: 'org_agg_a' });
    const res = await app.inject({ method: 'POST', url: '/participant', payload: validBody() });
    // The route's WHERE clause filters by `item_network IN served_networks`.
    // The mock doesn't implement that filter inline, so this test asserts the
    // route makes the call with the right scope; we assert via the items
    // array containing only blue_dot once the route filters server-side.
    expect(res.statusCode).toBe(200);
    const networks = (res.json().items as Array<{ item_network: string }>).map(i => i.item_network);
    expect(networks.every(n => n === 'blue_dot')).toBe(true);
  });
});
```

> NOTE: the mock pattern is necessarily a bit gnarly because the route makes multiple `db.select(...)` calls with different projections. If you find the discriminator brittle, fall back to a simpler structure: instead of a single `db.select` mock, expose `dbState.nextSelectKind` ('user' | 'item_owner' | 'items_list') and have the test set it before each inject. Whichever keeps the test readable; the assertions are what matter.

- [ ] **Step 3: Run the test, confirm it fails**

```bash
pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/participant.test.ts
```

Expected: FAIL — `Cannot find module '../participant.js'`.

- [ ] **Step 4: Write the handler**

Create `apps/api/src/routes/v1/admin/participant.ts`:

```ts
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { ensureItemPartition, items } from '@dpg/database';
import { user } from '../../../../db/postgres/schema/auth.js';
import { authInstance } from '@/routes/auth/create_auth';
import { create_profile_item } from '@/lib/profile_item';
import { updateItemInternal } from '@/services/item_service';
import { apiConfig } from '@/config';
import {
  UpsertParticipantRequest,
  UpsertParticipantResponse,
  type UpsertParticipantRequest as UpsertBody,
  mergeItemStateWithPrivate,
} from '@dpg/schemas';
import { resolve_upsert_action } from './_resolve_upsert_action.js';

/**
 * POST /api/v1/admin/participant
 *
 * Tier-aware upsert (Plan C). Replaces the former /admin/onboard_participant.
 * See docs/superpowers/specs/2026-05-23-admin-participant-upsert-design.md
 * for the behavior matrix.
 */
type UpsertRequest = FastifyRequest<{ Body: UpsertBody }>;

export const participant: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/participant',
    method: 'POST',
    schema: {
      tags: ['admin'],
      body: UpsertParticipantRequest,
      response: { 200: UpsertParticipantResponse },
    },
    handler: participant_handler,
  });
};

export const participant_handler = async (
  request: UpsertRequest,
  reply: FastifyReply,
) => {
  const body = request.body;
  const email_norm = body.email?.trim().toLowerCase() ?? null;
  const phone_norm = body.phone_number?.trim() ?? null;

  if (!email_norm && !phone_norm) {
    return reply.code(400).send({
      error: 'MISSING_IDENTIFIER',
      message: 'either email or phone_number is required',
    });
  }

  // 1. Look up existing user.
  const conditions = [];
  if (email_norm) conditions.push(eq(user.email, email_norm));
  if (phone_norm) conditions.push(eq(user.phoneNumber, phone_norm));
  const whereClause = conditions.length === 1 ? conditions[0] : or(...conditions);

  const existingRows = await db
    .select({
      id: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
      onboardedByOrgId: user.onboardedByOrgId,
    })
    .from(user)
    .where(whereClause!)
    .limit(1);

  const existing = existingRows[0] ?? null;
  const user_exists = Boolean(existing);

  // 2. Dispatch on the helper's verdict.
  const verdict = resolve_upsert_action({
    acting_org: request.acting_org,
    user_exists,
    item_id_in_body: body.item_id,
  });

  if (verdict.kind === 'rejected') {
    return reply.code(verdict.status).send({
      error: verdict.error,
      message:
        verdict.error === 'INVALID_ACTING_ORG'
          ? 'acting_org is required for /admin/participant'
          : 'only aggregator or network_service acting orgs are allowed',
    });
  }

  // 3. Verdict-specific branches.
  if (verdict.kind === 'aggregator_existing_noop') {
    const acting_org_id = request.acting_org!.org_id;
    const isOwn = existing!.onboardedByOrgId === acting_org_id;
    const itemsList = isOwn ? await readItemsForUser(existing!.id) : [];
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      onboarded_at: null,
      items: itemsList,
    });
  }

  if (verdict.kind === 'update_item') {
    // Runtime ownership check — pre-flight ahead of updateItemInternal so we
    // produce the right 403 ITEM_NOT_OWNED_BY_USER error.
    const [ownerRow] = await db
      .select({ created_by: items.created_by })
      .from(items)
      .where(eq(items.item_id, verdict.item_id))
      .limit(1);
    if (!ownerRow || ownerRow.created_by !== existing!.id) {
      return reply.code(403).send({
        error: 'ITEM_NOT_OWNED_BY_USER',
        message: 'item_id does not belong to the resolved user',
      });
    }

    try {
      await updateItemInternal(
        db,
        verdict.item_id,
        existing!.id,
        /* isAdmin */ true, // ownership already verified above
        { item_state: body.item_state },
      );
    } catch (err) {
      request.log.error({ err, item_id: verdict.item_id }, 'updateItemInternal failed');
      const e = err as { statusCode?: number; errorCode?: string };
      return reply.code(e.statusCode ?? 500).send({
        error: e.errorCode ?? 'UPDATE_FAILED',
        message: (err as Error).message ?? 'item update failed',
      });
    }

    const itemsList = await readItemsForUser(existing!.id);
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      onboarded_at: null,
      items: itemsList,
    });
  }

  if (verdict.kind === 'insert_item') {
    const network = body.network ?? 'blue_dot';
    const domain = body.domain ?? 'seeker';
    const item_type = body.item_type ?? 'profile_1.0';
    try {
      await ensureItemPartition(db, network, domain);
    } catch (err) {
      request.log.error({ err, network, domain }, 'failed to ensure item partition');
      return reply.code(500).send({
        error: 'PARTITION_SETUP_FAILED',
        message: 'failed to prepare storage for item type',
      });
    }
    try {
      await create_profile_item({
        tx: db,
        user_id: existing!.id,
        network,
        domain,
        item_type,
        payload: body.item_state,
      });
    } catch (err) {
      request.log.error({ err }, 'insert_item failed');
      return reply.code(500).send({
        error: 'INSERT_ITEM_FAILED',
        message: (err as Error).message ?? 'item insert failed',
      });
    }
    const itemsList = await readItemsForUser(existing!.id);
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      onboarded_at: null,
      items: itemsList,
    });
  }

  // verdict.kind === 'create_new_user'
  const acting_org_id = request.acting_org!.org_id;
  const network = body.network ?? 'blue_dot';
  const domain = body.domain ?? 'seeker';
  const item_type = body.item_type ?? 'profile_1.0';

  try {
    await ensureItemPartition(db, network, domain);
  } catch (err) {
    request.log.error({ err, network, domain }, 'failed to ensure item partition');
    return reply.code(500).send({
      error: 'PARTITION_SETUP_FAILED',
      message: 'failed to prepare storage for item type',
    });
  }

  const now = new Date();
  const email_for_signup = email_norm ?? `${randomUUID()}@no-email.local`;

  let user_id: string;
  try {
    const signed_up = await authInstance.api.signUpEmail({
      body: {
        email: email_for_signup,
        password: randomUUID(),
        name: body.name,
      },
    });
    user_id = signed_up.user.id;
  } catch (signupErr: unknown) {
    const e = signupErr as { code?: string; cause?: { code?: string }; message?: string };
    const pg_code = e?.code ?? e?.cause?.code;
    const message = String(e?.message ?? '');
    if (
      pg_code === '23505' ||
      message.includes('duplicate key value') ||
      message.includes('unique constraint')
    ) {
      // Race: someone created the user between our SELECT and signUp.
      // Re-resolve and treat as 'aggregator_existing_noop' if aggregator,
      // else 'insert_item' for network_service.
      request.log.warn({ err: signupErr }, 'signUp race; user exists now');
      return reply.code(409).send({
        error: 'USER_ALREADY_EXISTS',
        message: 'email or phone already in use (race) — retry the request',
      });
    }
    request.log.error({ err: signupErr }, 'signUp failed during onboarding');
    return reply.code(500).send({
      error: 'ONBOARD_FAILED',
      message: 'could not onboard participant',
    });
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(user)
        .set({
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
        })
        .where(eq(user.id, user_id));

      await create_profile_item({
        tx,
        user_id,
        network,
        domain,
        item_type,
        payload: body.item_state,
      });
    });
  } catch (txErr: unknown) {
    try {
      await db.delete(user).where(eq(user.id, user_id));
      request.log.warn({ orphan_user_id: user_id }, 'cleaned up orphan user after tx rollback');
    } catch (cleanupErr) {
      request.log.error(
        { cleanupErr, orphan_user_id: user_id },
        'failed to clean up orphan user — manual cleanup needed',
      );
    }
    const e = txErr as { code?: string; message?: string; cause?: { code?: string }; statusCode?: number; errorCode?: string };
    if (e?.statusCode && e?.errorCode) {
      return reply.code(e.statusCode).send({
        error: e.errorCode,
        message: e.message ?? 'request rejected',
      });
    }
    const pg_code = e?.code ?? e?.cause?.code;
    const message = String(e?.message ?? '');
    if (pg_code === '23505' || message.includes('duplicate key value') || message.includes('unique constraint')) {
      return reply.code(409).send({
        error: 'USER_ALREADY_EXISTS',
        message: 'email or phone already in use (race)',
      });
    }
    request.log.error({ err: txErr }, 'participant onboard failed in tx');
    return reply.code(500).send({
      error: 'ONBOARD_FAILED',
      message: 'could not onboard participant',
    });
  }

  const itemsList = await readItemsForUser(user_id);
  return reply.code(200).send({
    user_id,
    user_existed: false,
    onboarded_at: now.toISOString(),
    items: itemsList,
  });
};

// --- helpers ---

const servedNetworks = (): string[] => {
  const set = new Set<string>();
  for (const d of apiConfig.served_domains) set.add(d.network);
  return Array.from(set);
};

async function readItemsForUser(user_id: string) {
  const networks = servedNetworks();
  const rows = await db
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      item_state: items.item_state,
      item_private_state: items.item_private_state,
      created_at: items.created_at,
      updated_at: items.updated_at,
    })
    .from(items)
    .where(
      networks.length > 0
        ? and(eq(items.created_by, user_id), inArray(items.item_network, networks))
        : eq(items.created_by, user_id),
    )
    .orderBy(items.created_at);
  return rows.map((r) => {
    const { item_private_state, ...rest } = r;
    return {
      ...rest,
      item_state: mergeItemStateWithPrivate(r.item_state, item_private_state),
      created_at: (r.created_at as Date).toISOString(),
      updated_at: (r.updated_at as Date).toISOString(),
    };
  });
}

export default participant;
```

- [ ] **Step 5: Remove the old handler file**

```bash
git rm apps/api/src/routes/v1/admin/onboard_participant.ts
git rm apps/api/src/routes/v1/admin/__tests__/onboard_participant.test.ts
git rm apps/api/src/routes/v1/admin/__tests__/onboard_participant.integration.test.ts
```

(The integration test will be reborn as `participant.integration.test.ts` in Task 4.)

- [ ] **Step 6: Update the admin route registration**

Edit `apps/api/src/routes/v1/admin/admin_routes.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { acting_org_preHandler } from '@/middleware/acting_org';
import { aggregator_upsert } from './aggregator/upsert.js';
import { participant } from './participant.js';

export const admin_routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', auth_middleware_if_enabled);
  app.addHook('preHandler', acting_org_preHandler);

  await app.register(aggregator_upsert);
  await app.register(participant);
};

export default admin_routes;
```

- [ ] **Step 7: Run the participant test, confirm 13/13 PASS**

```bash
pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/participant.test.ts
```

Expected: 13 PASS.

- [ ] **Step 8: Run the full api suite for regressions**

```bash
pnpm --filter api test
```

Expected: all pre-existing tests still green + the 13 new ones. If any test references `OnboardParticipantRequest` / `onboard_participant` symbols, update or delete those references.

- [ ] **Step 9: Typecheck**

```bash
pnpm --filter api exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/routes/v1/admin/participant.ts \
        apps/api/src/routes/v1/admin/__tests__/participant.test.ts \
        apps/api/src/routes/v1/admin/admin_routes.ts \
        apps/api/src/routes/v1/admin/onboard_participant.ts \
        apps/api/src/routes/v1/admin/__tests__/onboard_participant.test.ts \
        apps/api/src/routes/v1/admin/__tests__/onboard_participant.integration.test.ts
git commit -m "feat(api): /admin/participant tier-aware upsert; remove onboard_participant"
```

---

## Task 4: Integration test against real Postgres

**Files:**
- Create: `apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts`

- [ ] **Step 1: Pre-read**

Read Plan A's integration test for the seeding pattern:
```bash
cat apps/api/src/routes/v1/action/__tests__/on_behalf_of.integration.test.ts | head -120
```

Note the env-gate (`POSTGRES_URL ?? POSTGRES_USER`), the apikey hashing (`createHash('sha256').update(raw_key).digest('base64url')`), the listen-port handling, and the cleanup ordering (items → actions → users → members → apikeys → orgs).

- [ ] **Step 2: Write the integration test**

Create `apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '@api/db/postgres/drizzle_config';
import { eq } from 'drizzle-orm';
import { items } from '@dpg/database';
import { user, organization, member, apikey } from '@/db/postgres/schema/auth';
import admin_routes from '../../admin/admin_routes.js';

const can_run =
  Boolean(process.env.POSTGRES_URL) || Boolean(process.env.POSTGRES_USER);
const describeIf = can_run ? describe : describe.skip;

const hashKey = (raw: string) =>
  createHash('sha256').update(raw).digest('base64url');

const LISTEN_PORT = Number(process.env.API_PORT ?? 2742);

describeIf(`POST /api/v1/admin/participant (integration${can_run ? '' : ' — skipped: no POSTGRES_URL'})`, () => {
  let app: FastifyInstance;
  // Seeded resources, to be cleaned up in afterAll.
  let agg_a_org_id = `agg-int-a-${Date.now()}`;
  let agg_b_org_id = `agg-int-b-${Date.now()}`;
  let ns_org_id = `ns-int-${Date.now()}`;
  let svc_user_id: string;
  let agg_a_apikey_raw = `sk_signals_${randomUUID().replace(/-/g, '')}`;
  let ns_apikey_raw = `sk_signals_${randomUUID().replace(/-/g, '')}`;
  // Test-created users; tracked for cleanup.
  const created_user_ids: string[] = [];

  beforeAll(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(admin_routes, { prefix: '/api/v1/admin' });

    try {
      await app.listen({ port: LISTEN_PORT, host: '127.0.0.1' });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === 'EADDRINUSE') {
        throw new Error(
          `integration test requires port ${LISTEN_PORT} to be free ` +
          `(set API_PORT). Is the dev server already running?`,
        );
      }
      throw err;
    }

    // Seed: one service user, three orgs (agg_a, agg_b, network_service), two apikeys
    svc_user_id = `usr_svc_${randomUUID().slice(0, 8)}`;
    await db.insert(user).values({
      id: svc_user_id,
      email: `${svc_user_id}@svc.local`,
      name: 'integration svc user',
      role: 'service',
    });
    await db.insert(organization).values([
      { id: agg_a_org_id, name: 'Agg A', slug: agg_a_org_id, type: 'aggregator' },
      { id: agg_b_org_id, name: 'Agg B', slug: agg_b_org_id, type: 'aggregator' },
      { id: ns_org_id, name: 'NS', slug: ns_org_id, type: 'network_service' },
    ]);
    await db.insert(member).values([
      { id: `mem_${randomUUID().slice(0, 8)}`, userId: svc_user_id, organizationId: agg_a_org_id, role: 'owner' },
      { id: `mem_${randomUUID().slice(0, 8)}`, userId: svc_user_id, organizationId: ns_org_id, role: 'owner' },
    ]);
    await db.insert(apikey).values([
      {
        id: `ak_${randomUUID().slice(0, 8)}`,
        name: 'agg_a key',
        prefix: 'sk_signals_',
        key: hashKey(agg_a_apikey_raw),
        start: agg_a_apikey_raw.slice(0, 6),
        userId: svc_user_id,
        enabled: true,
        rateLimitEnabled: false,
      },
      {
        id: `ak_${randomUUID().slice(0, 8)}`,
        name: 'ns key',
        prefix: 'sk_signals_',
        key: hashKey(ns_apikey_raw),
        start: ns_apikey_raw.slice(0, 6),
        userId: svc_user_id,
        enabled: true,
        rateLimitEnabled: false,
      },
    ]);
  });

  afterAll(async () => {
    // Order: items → users (cascade removes member/apikey via FKs) → orgs.
    try {
      for (const uid of created_user_ids) {
        await db.delete(items).where(eq(items.created_by, uid)).catch(() => {});
        await db.delete(user).where(eq(user.id, uid)).catch(() => {});
      }
      await db.delete(items).where(eq(items.created_by, svc_user_id)).catch(() => {});
      await db.delete(user).where(eq(user.id, svc_user_id)).catch(() => {});
      await db.delete(organization).where(eq(organization.id, agg_a_org_id)).catch(() => {});
      await db.delete(organization).where(eq(organization.id, agg_b_org_id)).catch(() => {});
      await db.delete(organization).where(eq(organization.id, ns_org_id)).catch(() => {});
    } catch (cleanupErr) {
      // best-effort
       
      console.error('integration cleanup failed:', cleanupErr);
    }
    await app.close();
  });

  it('aggregator A onboards a new user; row + item exist with correct attribution', async () => {
    const email = `int_${randomUUID().slice(0, 6)}@a.test`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: {
        'x-api-key': agg_a_apikey_raw,
        'x-acting-org-id': agg_a_org_id,
      },
      payload: {
        email,
        name: 'Int A',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        item_state: { name: 'Int A', phone: '+919999000001' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(false);
    expect(body.items).toHaveLength(1);
    created_user_ids.push(body.user_id);

    const [row] = await db.select().from(user).where(eq(user.id, body.user_id)).limit(1);
    expect(row.onboardedByOrgId).toBe(agg_a_org_id);
  });

  it('aggregator A hits same user again — gets items, no writes', async () => {
    const uid = created_user_ids[0];
    const [u] = await db.select().from(user).where(eq(user.id, uid)).limit(1);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': agg_a_apikey_raw, 'x-acting-org-id': agg_a_org_id },
      payload: {
        email: u.email,
        name: 'doesnt matter',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        item_state: { wont: 'be used' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user_existed).toBe(true);
    expect(res.json().items.length).toBeGreaterThan(0);
  });

  it('network_service updates an existing item via item_id; item_state changes in DB', async () => {
    const uid = created_user_ids[0];
    const [u] = await db.select().from(user).where(eq(user.id, uid)).limit(1);
    const [existingItem] = await db
      .select()
      .from(items)
      .where(eq(items.created_by, uid))
      .limit(1);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns_apikey_raw, 'x-acting-org-id': ns_org_id },
      payload: {
        email: u.email,
        name: 'NS Update',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        item_state: { name: 'NS Update', phone: '+919999000002' },
        item_id: existingItem.item_id,
      },
    });
    expect(res.statusCode).toBe(200);
    const [refreshed] = await db
      .select()
      .from(items)
      .where(eq(items.item_id, existingItem.item_id))
      .limit(1);
    expect((refreshed.item_state as Record<string, unknown>).name).toBe('NS Update');
  });

  it('network_service inserts an additional item for the same user', async () => {
    const uid = created_user_ids[0];
    const [u] = await db.select().from(user).where(eq(user.id, uid)).limit(1);
    const before = await db.select().from(items).where(eq(items.created_by, uid));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns_apikey_raw, 'x-acting-org-id': ns_org_id },
      payload: {
        email: u.email,
        name: 'NS Insert',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        item_state: { name: 'NS Insert', phone: '+919999000003' },
        domain: 'provider',
        item_type: 'job_posting_1.0',
      },
    });
    expect(res.statusCode).toBe(200);
    const after = await db.select().from(items).where(eq(items.created_by, uid));
    expect(after.length).toBe(before.length + 1);
  });

  it('aggregator B trying to read agg_a user gets items: []', async () => {
    // For this test, we'd need an apikey + member for agg_b. Seed inline:
    const agg_b_apikey_raw = `sk_signals_${randomUUID().replace(/-/g, '')}`;
    await db.insert(member).values({
      id: `mem_${randomUUID().slice(0, 8)}`, userId: svc_user_id, organizationId: agg_b_org_id, role: 'owner',
    });
    await db.insert(apikey).values({
      id: `ak_${randomUUID().slice(0, 8)}`,
      name: 'agg_b key',
      prefix: 'sk_signals_',
      key: hashKey(agg_b_apikey_raw),
      start: agg_b_apikey_raw.slice(0, 6),
      userId: svc_user_id,
      enabled: true,
      rateLimitEnabled: false,
    });

    const uid = created_user_ids[0];
    const [u] = await db.select().from(user).where(eq(user.id, uid)).limit(1);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': agg_b_apikey_raw, 'x-acting-org-id': agg_b_org_id },
      payload: {
        email: u.email,
        name: 'agg_b probe',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        item_state: {},
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user_existed).toBe(true);
    expect(res.json().items).toEqual([]);
  });

  it('network_service with item_id from another user -> 403 ITEM_NOT_OWNED_BY_USER', async () => {
    // Create a second user via aggregator A, then attempt to update agg_a's
    // first user with the second user's item_id under network_service.
    const email2 = `int_${randomUUID().slice(0, 6)}@a.test`;
    const seed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': agg_a_apikey_raw, 'x-acting-org-id': agg_a_org_id },
      payload: {
        email: email2,
        name: 'Other',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        item_state: { name: 'Other' },
      },
    });
    expect(seed.statusCode).toBe(200);
    created_user_ids.push(seed.json().user_id);
    const otherUserItemId = seed.json().items[0].item_id;

    const uid_first = created_user_ids[0];
    const [u1] = await db.select().from(user).where(eq(user.id, uid_first)).limit(1);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': ns_apikey_raw, 'x-acting-org-id': ns_org_id },
      payload: {
        email: u1.email,
        name: 'NS bad update',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        item_state: {},
        item_id: otherUserItemId, // belongs to user-2, not user-1
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ITEM_NOT_OWNED_BY_USER');
  });
});
```

- [ ] **Step 3: Run integration test (if local PG is up)**

```bash
docker compose up -d db redis 2>/dev/null || true
pnpm --filter api test:integration
```

Expected: 6/6 PASS (or 6 SKIP if `POSTGRES_URL` not set).

- [ ] **Step 4: Confirm unit suite is unaffected**

```bash
pnpm --filter api test
```

Expected: still green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/admin/__tests__/participant.integration.test.ts
git commit -m "test(api): integration test for /admin/participant tier matrix"
```

---

## Task 5: Add OpenAPI tags to admin + aggregator routes

**Files (modify):**
- All `.ts` files under `apps/api/src/routes/v1/admin/`
- All `.ts` files under `apps/api/src/routes/v1/aggregator/`

- [ ] **Step 1: Enumerate route files needing the change**

```bash
grep -rln "fastify.route\|app.route\|schema:" apps/api/src/routes/v1/admin apps/api/src/routes/v1/aggregator 2>/dev/null | grep -v __tests__
```

Inspect each one. The Fastify route definitions look like:
```ts
fastify.route({
  url: '/foo',
  method: 'POST',
  schema: {
    body: ...,
    response: { 200: ... },
  },
  handler: ...,
});
```

For each one, add `tags: ['admin']` (admin subtree) or `tags: ['aggregator']` (aggregator subtree) inside `schema:`. The new `participant.ts` already has `tags: ['admin']` from Task 3.

- [ ] **Step 2: Apply the edits (one file at a time)**

Example for `apps/api/src/routes/v1/admin/aggregator/upsert.ts` (admin subtree):

```ts
fastify.route({
  url: '/upsert',
  method: 'POST',
  schema: {
    tags: ['admin'],                       // ← add this line
    body: ...,
    response: { 200: ... },
  },
  handler: ...,
});
```

Example for `apps/api/src/routes/v1/aggregator/dashboard.ts`:

```ts
fastify.route({
  url: '/dashboard',
  method: 'GET',
  schema: {
    tags: ['aggregator'],                  // ← add this line
    querystring: ...,
    response: { 200: ... },
  },
  handler: ...,
});
```

Touch every route file in those two subtrees.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter api exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Verify tags appear in the OpenAPI output**

Start the api locally and curl whatever the OpenAPI/Swagger endpoint is. If unsure:

```bash
grep -rn "swagger\|openapi" apps/api/src/server.ts apps/api/src/plugins 2>/dev/null
```

If `/docs/json` or similar is mounted, hit it:

```bash
curl -s http://localhost:2742/docs/json | jq '.paths | to_entries[] | {path: .key, methods: (.value | to_entries | map({method: .key, tags: .value.tags}))}' | head -50
```

Look for `admin` and `aggregator` tags appearing on the appropriate paths.

If no Swagger endpoint is mounted, just rely on the typecheck + visual inspection of the diff. The tags will materialize whenever Swagger is wired up.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/admin apps/api/src/routes/v1/aggregator
git commit -m "feat(api): tag admin + aggregator routes for OpenAPI grouping"
```

---

## Task 6: Postman collection + env updates

**Files (modify):**
- `docs/postman/Signals-DPG.postman_collection.json`
- `docs/postman/Blue-Dots.postman_environment.json`
- `docs/postman/Purple-Dots.postman_environment.json`

- [ ] **Step 1: Pre-read**

```bash
node -e "const c = JSON.parse(require('fs').readFileSync('docs/postman/Signals-DPG.postman_collection.json','utf8')); console.log(c.item.map(f => f.name));"
```

Note current folder names + ordering. The new folder `08 Admin Participant` should slot after the existing top-level folders.

Find the existing `Apply on behalf of seeker` request (somewhere under `07 Aggregator (on behalf of)` per Plan A's commit `b2a97d5`).

- [ ] **Step 2: Fix the action on-behalf-of body**

In the `Apply on behalf of seeker` request body, replace:
```json
"requirements_snapshot": {}
```
with:
```json
"requirements_snapshot": {{action_requirements_snapshot_json}}
```

(Postman variable interpolation. The variable value should be valid JSON when expanded — e.g. `{"role":"engineer","age":28,"workExperience":"Fresher"}`. The collection accepts variables inside JSON bodies.)

- [ ] **Step 3: Add the `08 Admin Participant` folder**

Append to `c.item` (the top-level folders array) an 8-request folder. Each request mirrors the existing collection's request style (method, url, headers, body). The 8 entries per the spec:

| # | Request name | Headers | Body (key bits) | Expected |
|---|---|---|---|---|
| 1 | Aggregator A — create new user | x-api-key={{aggregator_api_key}}, x-acting-org-id={{aggregator_org_id}} | email/phone, name, item_state | 200, user_existed:false |
| 2 | Aggregator A — existing own user | same | email matching existing | 200, user_existed:true, items populated |
| 3 | Aggregator B — existing other-aggregator user | x-api-key={{aggregator_b_api_key}}, x-acting-org-id={{aggregator_b_org_id}} | email of user owned by A | 200, items: [] |
| 4 | Network_service — create new user | x-api-key={{network_service_api_key}}, x-acting-org-id={{network_service_org_id}} | new email/phone | 200, user_existed:false |
| 5 | Network_service — update existing item | same | email of existing user + item_id={{participant_item_id}} | 200, item updated |
| 6 | Network_service — insert additional item | same | email of existing user, no item_id | 200, items grows |
| 7 | Network_service — invalid item_id | same | email of user A + item_id of user B | 403 ITEM_NOT_OWNED_BY_USER |
| 8 | Voice acting_org rejected | x-api-key={{network_service_api_key}}, x-acting-org-id={{voice_org_id_if_seeded}} | any | 403 ACTING_ORG_TYPE_NOT_ALLOWED |

(For request 8, voice orgs don't exist by default; either skip from the runner or seed one manually. Folder description should call this out.)

Each request's URL is `{{base_url}}/api/v1/admin/participant`. Method: POST. Content-Type: application/json.

Each request body is a JSON object matching `UpsertParticipantRequest`. For requests 5 and 7, the body includes `"item_id": "{{participant_item_id}}"` or `"item_id": "{{other_user_item_id}}"` — variables captured by earlier tests in the folder.

Add tests to each request (`event` → `prerequest` + `test`) that capture useful response fields into env vars:
- Request 1: capture `{{aggregator_a_user_id}}`, `{{participant_item_id}}` (from `items[0].item_id`).
- Request 7's pre-test seed: capture a different user's `item_id` into `{{other_user_item_id}}` — use a Postman `pre-request` script that pings `POST /admin/participant` with a fresh email, parses the response, sets the var. (Or do it manually via a separate seed request inside the folder, ordered earlier than request 7.)

- [ ] **Step 4: Update env files**

For both `docs/postman/Blue-Dots.postman_environment.json` and `Purple-Dots.postman_environment.json`, add these env vars with empty strings + appropriate `type` ('default' or 'secret') + `enabled: true`:

| Variable | Type | Why |
|---|---|---|
| `action_requirements_snapshot_json` | default | Fixes the action on-behalf-of request body. User fills with network-specific JSON (e.g. `{"role":"engineer","age":28,"workExperience":"Fresher"}`). |
| `network_service_org_id` | default | The Signals platform's own network_service-typed org id, for the broad-tier participant scenarios. |
| `aggregator_b_api_key` | secret | A second aggregator's apikey, used to demonstrate the cross-aggregator empty-items case. |
| `aggregator_b_org_id` | default | That second aggregator's org id. |
| `participant_item_id` | default | Captured by request 1 of folder 08 via Postman test script. |
| `other_user_item_id` | default | Captured by the pre-seed step for request 7. |
| `aggregator_a_user_id` | default | Captured by request 1 for downstream use. |

Symmetric across both env files — same keys, same types, empty values.

- [ ] **Step 5: Validate JSONs parse**

```bash
for f in docs/postman/Signals-DPG.postman_collection.json docs/postman/Blue-Dots.postman_environment.json docs/postman/Purple-Dots.postman_environment.json; do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "$f ok";
done
```

Expected: all three "ok".

- [ ] **Step 6: Verify symmetry between Blue-Dots + Purple-Dots envs**

```bash
diff <(jq -S '.values | map({key, type, enabled})' docs/postman/Blue-Dots.postman_environment.json) \
     <(jq -S '.values | map({key, type, enabled})' docs/postman/Purple-Dots.postman_environment.json)
```

Expected: no diff (only `value` may differ between Blue-Dots and Purple-Dots).

- [ ] **Step 7: Commit**

```bash
git add docs/postman/Signals-DPG.postman_collection.json \
        docs/postman/Blue-Dots.postman_environment.json \
        docs/postman/Purple-Dots.postman_environment.json
git commit -m "docs(postman): 08 Admin Participant folder + action body env var fix"
```

---

## Task 7: Update operator docs

**Files:**
- Modify: `docs/operations/integrating-dpgs.md`

- [ ] **Step 1: Pre-read**

```bash
grep -n "onboard_participant\|onboard a participant\|Onboard" docs/operations/integrating-dpgs.md | head
```

Identify the section that describes the old endpoint + matrix. Replace it.

- [ ] **Step 2: Replace the onboard section with the new endpoint description**

Use this content (slot it where the old "Onboard a participant" section was; preserve adjacent context):

```markdown
## Upserting a participant (tier-aware)

`POST /api/v1/admin/participant` is the single endpoint integrating DPGs
use to create or update participants. The behavior splits by the
`acting_org.org_type` asserted via `x-acting-org-id`:

| Tier                   | acting_org.org_type | Onboard new user | Read existing user's items                                     | Update item    | Insert additional item |
|------------------------|---------------------|------------------|----------------------------------------------------------------|----------------|------------------------|
| Ecosystem manager      | network_service     | yes              | yes (full list, served-domain scoped)                          | yes (`item_id`)| yes (omit `item_id`)   |
| Aggregator             | aggregator          | yes              | yes — but **only own users** (cross-aggregator returns `items:[]`) | no             | no                     |
| Voice (future)         | voice               | (rejected today) | (rejected)                                                     | (rejected)     | (rejected)             |

The future voice tier will piggyback on the aggregator behavior: when a
voice instance is delegated to an aggregator, voice-dpg simply starts
asserting the aggregator's `x-acting-org-id` — no code change needed.

### Request

```http
POST /api/v1/admin/participant
x-api-key: <network_service or aggregator apikey>
x-acting-org-id: <org id>
content-type: application/json

{
  "email": "user@example.com",
  "name": "Asha P",
  "terms_accepted": true,
  "privacy_accepted": true,
  "channel": "bulk",
  "item_state": { ... item-schema-validated payload ... },
  "item_id": "optional-uuid-for-update-only",
  "network": "blue_dot",
  "domain": "seeker",
  "item_type": "profile_1.0"
}
```

Identity rule: at least one of `email` or `phone_number` must be provided.

### Response

```json
{
  "user_id": "...",
  "user_existed": true,
  "onboarded_at": null,
  "items": [
    {
      "item_id": "...",
      "item_network": "blue_dot",
      "item_domain": "seeker",
      "item_type": "profile_1.0",
      "item_state": { ... },
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

`onboarded_at` is set only when this call created a new user; null
otherwise. `items` is scoped to the networks this Signals instance
serves.

### Error matrix (additions)

| Caller shape | HTTP | error | When |
|---|---|---|---|
| acting_org missing | 403 | `INVALID_ACTING_ORG` | request reached the handler without acting_org |
| acting_org_type == 'voice' (or anything not in aggregator/network_service) | 403 | `ACTING_ORG_TYPE_NOT_ALLOWED` | not allowed today |
| network_service + invalid `item_id` (doesn't belong to user) | 403 | `ITEM_NOT_OWNED_BY_USER` | item ownership check failed |
| email + phone race | 409 | `USER_ALREADY_EXISTS` | another caller created the same identity between SELECT and signUp |

### Migration from `/admin/onboard_participant`

The old endpoint is removed. Callers update:
- URL: `/admin/onboard_participant` → `/admin/participant`
- Body: `profile` → `item_state`
- Body: `profile_item_id` (not previously used) → `item_id` (now meaningful for network_service updates)
- Response: `profile_item_id` → `items: [...]` (full post-write set)
```

- [ ] **Step 3: Commit**

```bash
git add docs/operations/integrating-dpgs.md
git commit -m "docs: replace onboard_participant section with /admin/participant"
```

---

## Final checklist before opening PR

- [ ] All Task 1-7 commits land on `chore/plan-c-admin-participant-refactor`.
- [ ] `pnpm typecheck` clean across api / ui / docs.
- [ ] `pnpm --filter api test` clean — 128 (Plan A baseline) + 9 (helper) + 13 (route) = 150-ish.
- [ ] `pnpm schema:bundle:check` clean (no schema changes in this plan, so should be a no-op).
- [ ] `pnpm --filter api test:integration` clean against a fresh `docker compose up -d db redis`.
- [ ] Postman JSONs parse; env files symmetric.
- [ ] PR target is `feat/api-refactor` (NOT develop). Plan A's PR #13 already landed there; Plan C stacks on top.

---

## Self-review notes

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| Three-tier overview + voice future migration | Task 7 (docs) |
| URL + auth chain | Task 3 step 4, 6 |
| Behavior matrix (7 rows) | Task 2 (5 verdict cases) + Task 3 (runtime ownership) |
| Request shape (renamed fields + new `item_id`) | Task 1 |
| Response shape (`items` + `user_existed` + `onboarded_at` nullable) | Task 1 + Task 3 |
| Implementation outline | Task 3 |
| Test plan — 9 unit (helper) | Task 2 |
| Test plan — 13 route | Task 3 |
| Test plan — 6 integration | Task 4 |
| Side-task 7a (OpenAPI tags) | Task 5 |
| Side-task 7b (Postman) | Task 6 |
| Served-domain scoping | Task 3 `readItemsForUser` |
| 403 ITEM_NOT_OWNED_BY_USER | Task 3 update_item branch |
| Cross-aggregator empty-items | Task 3 aggregator_existing_noop branch + Task 4 case 5 |

**Placeholder scan:** no TBD / TODO. Each step has concrete content. The "discriminator brittle? fall back to..." note in Task 3 step 2 is a hint, not a placeholder — the test code above it is complete.

**Type consistency:** `UpsertParticipantRequest` / `UpsertParticipantResponse` named identically in Task 1 (schema), Task 3 (handler import), Task 4 (integration test imports). `UpsertVerdict` discriminator's 5 kinds are: `create_new_user`, `aggregator_existing_noop`, `update_item`, `insert_item`, `rejected` — referenced consistently across Task 2 (helper), Task 3 (handler switch), Task 4 (integration coverage). The runtime `ITEM_NOT_OWNED_BY_USER` 403 is documented as a post-verdict outcome in Task 3 + spec + integration test, NOT as a verdict.

**Granularity:** Each task has 3-10 bite-sized steps. The longest single step is Task 3 step 4 (handler code) and Task 3 step 2 (test code) — both are unavoidable; they're the core of the feature.
