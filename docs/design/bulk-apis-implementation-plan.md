# Bulk APIs Implementation Plan

> **Scope update:** Bulk for `POST /api/v1/item/create` was **removed per client decision** — bulk applies **only to `/action/perform` and `/action/update-status`**. **Task 1's create handler / Task 4 (Convert `/item/create`) are no longer in scope** and were reverted; `/item/create` stays single-object. The `runBulk` helper, `BULK_MAX_ITEMS` config, and bulk response schemas remain (used by the two action endpoints). The sections below that build/convert `/item/create` are historical.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /api/v1/action/perform` and `POST /api/v1/action/update-status` accept a JSON **array** and process each element best-effort, returning per-item results. (`/item/create` is **excluded** — see scope update above.)

**Architecture:** A shared `runBulk` helper owns limit/loop/result/status concerns. Each route handler resolves per-request context once, then delegates each array element to a `processOne` callback that contains the (refactored) single-item logic and throws `BulkItemFailure(code, message)` for per-item errors. Array-only contract; response mirrors a `{ results, summary }` envelope with HTTP 201/200 (all ok), 207 (partial), 422 (all fail), 400 (request-level). The UI client layer wraps single calls as arrays of one and unwraps `results[0]`.

**Tech Stack:** Fastify + `fastify-type-provider-zod`, Zod, Drizzle ORM, Vitest. Monorepo packages: `@dpg/schemas`, `@dpg/config`.

**Spec:** `docs/design/bulk-apis-design.md`

---

## File Structure

**Create:**
- `apps/api/src/utils/bulk_runner.ts` — generic `runBulk` + `BulkItemFailure` + result types.
- `apps/api/src/utils/__tests__/bulk_runner.test.ts` — unit tests for the runner.
- `packages/schemas/src/api/bulk_schemas.ts` — bulk response envelope + per-endpoint success/result schemas.
- `packages/schemas/src/api/__tests__/bulk_schemas.test.ts` — schema parse tests.

**Modify:**
- `packages/config/src/secrets.ts` — add `BULK_MAX_ITEMS` to `NetworkRuntimeSecretsSchema`.
- `apps/api/src/config.ts` — expose `bulk_max_items` on `apiConfig`.
- `turbo.json` — add `BULK_MAX_ITEMS` to `globalPassThroughEnv`.
- `packages/schemas/src/index.ts` — re-export `bulk_schemas`.
- `apps/api/src/routes/v1/item/create_item.ts` — array body + `processOne`.
- `apps/api/src/routes/v1/action/update_action_status.ts` — array body + `processOne`.
- `apps/api/src/routes/v1/action/perform_action.ts` — array body + `processOne`.
- `apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts` — payloads → arrays, assert envelope.
- `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts` — payloads → arrays, assert envelope.
- `apps/ui/src/lib/item-api.ts` — `createItem` sends `[payload]`, unwraps `results[0]`.
- `apps/ui/src/lib/action-api.ts` — `performAction`/`updateActionStatus` send `[payload]`, unwrap `results[0]`.

---

## Phase 0 — Foundation (config, runner, schemas)

### Task 1: Add the `BULK_MAX_ITEMS` config

**Files:**
- Modify: `packages/config/src/secrets.ts:50-64`
- Modify: `apps/api/src/config.ts:15-24`
- Modify: `turbo.json` (`globalPassThroughEnv` array)

- [ ] **Step 1: Add the env field to the Zod schema**

In `packages/config/src/secrets.ts`, inside `NetworkRuntimeSecretsSchema`, add the field after `ALLOW_EXTRA_SCHEMA_DATA`:

```ts
  ALLOW_EXTRA_SCHEMA_DATA: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
  BULK_MAX_ITEMS: z.coerce.number().int().positive().default(100),
});
```

- [ ] **Step 2: Expose it on `apiConfig`**

In `apps/api/src/config.ts`, add to the `apiConfig` object (after `allow_extra_schema_data`):

```ts
  allow_extra_schema_data: networkRuntime.ALLOW_EXTRA_SCHEMA_DATA,
  bulk_max_items: networkRuntime.BULK_MAX_ITEMS,
```

- [ ] **Step 3: Pass the env var through turbo**

In `turbo.json`, add `"BULK_MAX_ITEMS"` to the `globalPassThroughEnv` array (alphabetical neighborhood near `ALLOW_EXTRA_SCHEMA_DATA`):

```jsonc
    "ALLOW_EXTRA_SCHEMA_DATA",
    "BULK_MAX_ITEMS",
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @dpg/config build && pnpm --filter api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/secrets.ts apps/api/src/config.ts turbo.json
git commit -m "feat(api): add configurable BULK_MAX_ITEMS (default 100)"
```

---

### Task 2: The shared `runBulk` helper

**Files:**
- Create: `apps/api/src/utils/bulk_runner.ts`
- Test: `apps/api/src/utils/__tests__/bulk_runner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/utils/__tests__/bulk_runner.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runBulk, BulkItemFailure } from '../bulk_runner.js';

const opts = { okStatus: 201, maxItems: 3 };

describe('runBulk', () => {
  it('returns a request error for an empty array', async () => {
    const out = await runBulk([], async () => ({ ok: true }), opts);
    expect(out.requestError).toEqual({
      code: 'BULK_EMPTY_ARRAY',
      message: expect.any(String),
    });
    expect(out.results).toBeUndefined();
  });

  it('returns a request error when over the limit', async () => {
    const out = await runBulk([1, 2, 3, 4], async () => ({ ok: true }), opts);
    expect(out.requestError?.code).toBe('BULK_LIMIT_EXCEEDED');
  });

  it('returns okStatus when every item succeeds, preserving order + index', async () => {
    const out = await runBulk(
      ['a', 'b'],
      async (el, i) => ({ value: `${el as string}-${i}` }),
      opts,
    );
    expect(out.httpStatus).toBe(201);
    expect(out.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(out.results).toEqual([
      { index: 0, status: 'success', value: 'a-0' },
      { index: 1, status: 'success', value: 'b-1' },
    ]);
  });

  it('returns 207 on partial failure and maps BulkItemFailure', async () => {
    const out = await runBulk(
      ['ok', 'bad'],
      async (el) => {
        if (el === 'bad') throw new BulkItemFailure('NOPE', 'bad item');
        return { value: el };
      },
      opts,
    );
    expect(out.httpStatus).toBe(207);
    expect(out.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(out.results?.[1]).toEqual({
      index: 1,
      status: 'error',
      error: 'NOPE',
      message: 'bad item',
    });
  });

  it('returns 422 when every item fails', async () => {
    const out = await runBulk(
      ['x'],
      async () => {
        throw new BulkItemFailure('NOPE', 'nope');
      },
      opts,
    );
    expect(out.httpStatus).toBe(422);
    expect(out.summary).toEqual({ total: 1, succeeded: 0, failed: 1 });
  });

  it('maps unknown throws to INTERNAL_SERVER_ERROR', async () => {
    const out = await runBulk(
      ['x'],
      async () => {
        throw new Error('boom');
      },
      opts,
    );
    expect(out.results?.[0]).toMatchObject({
      index: 0,
      status: 'error',
      error: 'INTERNAL_SERVER_ERROR',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api exec vitest run src/utils/__tests__/bulk_runner.test.ts`
Expected: FAIL — cannot find module `../bulk_runner.js`.

- [ ] **Step 3: Implement the runner**

Create `apps/api/src/utils/bulk_runner.ts`:

```ts
/**
 * Per-item error thrown by a processOne callback. The runner converts it into
 * an error entry in the results array (does NOT abort the batch).
 */
export class BulkItemFailure extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'BulkItemFailure';
  }
}

type SuccessResult<T> = { index: number; status: 'success' } & T;
interface ErrorResult {
  index: number;
  status: 'error';
  error: string;
  message: string;
}
export type BulkItemResult<T> = SuccessResult<T> | ErrorResult;

export interface BulkOutcome<T> {
  /** Set only for request-level rejection (empty / over-limit). Caller → 400. */
  requestError?: { code: string; message: string };
  results?: BulkItemResult<T>[];
  summary?: { total: number; succeeded: number; failed: number };
  /** okStatus when all succeed, 207 on partial, 422 when all fail. */
  httpStatus?: number;
}

/**
 * Run `processOne` over each element best-effort. Sequential by design (v1):
 * keeps DB partition creation and cross-instance fan-out predictable.
 */
export async function runBulk<T extends object>(
  elements: unknown[],
  processOne: (element: unknown, index: number) => Promise<T>,
  opts: { okStatus: number; maxItems: number },
): Promise<BulkOutcome<T>> {
  if (elements.length === 0) {
    return {
      requestError: {
        code: 'BULK_EMPTY_ARRAY',
        message: 'Request body must be a non-empty array.',
      },
    };
  }
  if (elements.length > opts.maxItems) {
    return {
      requestError: {
        code: 'BULK_LIMIT_EXCEEDED',
        message: `Request exceeds the maximum of ${opts.maxItems} items per call (received ${elements.length}).`,
      },
    };
  }

  const results: BulkItemResult<T>[] = [];
  let succeeded = 0;

  for (let index = 0; index < elements.length; index++) {
    try {
      const success = await processOne(elements[index], index);
      results.push({ index, status: 'success', ...success });
      succeeded += 1;
    } catch (err) {
      if (err instanceof BulkItemFailure) {
        results.push({ index, status: 'error', error: err.errorCode, message: err.message });
      } else {
        results.push({
          index,
          status: 'error',
          error: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    }
  }

  const failed = results.length - succeeded;
  const httpStatus = failed === 0 ? opts.okStatus : succeeded === 0 ? 422 : 207;

  return { results, summary: { total: results.length, succeeded, failed }, httpStatus };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter api exec vitest run src/utils/__tests__/bulk_runner.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/utils/bulk_runner.ts apps/api/src/utils/__tests__/bulk_runner.test.ts
git commit -m "feat(api): add runBulk helper for best-effort bulk processing"
```

---

### Task 3: Bulk response schemas

**Files:**
- Create: `packages/schemas/src/api/bulk_schemas.ts`
- Modify: `packages/schemas/src/index.ts:6` (add re-export)
- Test: `packages/schemas/src/api/__tests__/bulk_schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/schemas/src/api/__tests__/bulk_schemas.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  BulkCreateItemResponseSchema,
  BulkPerformActionResponseSchema,
  BulkUpdateActionStatusResponseSchema,
} from '../bulk_schemas';

describe('bulk response schemas', () => {
  it('accepts a mixed create envelope', () => {
    const parsed = BulkCreateItemResponseSchema.parse({
      results: [
        { index: 0, status: 'success', item_id: 'a', item_type: 'profile_1.0' },
        { index: 1, status: 'error', error: 'INVALID_PAYLOAD', message: 'bad' },
      ],
      summary: { total: 2, succeeded: 1, failed: 1 },
    });
    expect(parsed.results).toHaveLength(2);
  });

  it('rejects a success entry missing item_id', () => {
    expect(() =>
      BulkCreateItemResponseSchema.parse({
        results: [{ index: 0, status: 'success', item_type: 'x' }],
        summary: { total: 1, succeeded: 1, failed: 0 },
      }),
    ).toThrow();
  });

  it('accepts perform + update envelopes', () => {
    expect(
      BulkPerformActionResponseSchema.parse({
        results: [
          {
            index: 0,
            status: 'success',
            action_id: 'a',
            action_type: 'connect',
            action_status: 'created',
            update_count: 0,
            source_item_id: 's',
            target_item_id: 't',
          },
        ],
        summary: { total: 1, succeeded: 1, failed: 0 },
      }).results,
    ).toHaveLength(1);

    expect(
      BulkUpdateActionStatusResponseSchema.parse({
        results: [
          {
            index: 0,
            status: 'success',
            action_id: 'a',
            action_type: 'connect',
            action_status: 'accepted',
            update_count: 1,
          },
        ],
        summary: { total: 1, succeeded: 1, failed: 0 },
      }).results,
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dpg/schemas exec vitest run src/api/__tests__/bulk_schemas.test.ts`
Expected: FAIL — cannot find module `../bulk_schemas`.

- [ ] **Step 3: Implement the schemas**

Create `packages/schemas/src/api/bulk_schemas.ts`:

```ts
import z from 'zod';

export const BulkItemErrorSchema = z.object({
  index: z.number().int().nonnegative(),
  status: z.literal('error'),
  error: z.string().min(1),
  message: z.string(),
});

export const BulkSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

/** Build a `{ results, summary }` envelope schema for a given success shape. */
function bulkEnvelope<T extends z.ZodRawShape>(successFields: T) {
  const success = z
    .object({
      index: z.number().int().nonnegative(),
      status: z.literal('success'),
    })
    .extend(successFields);
  return z.object({
    results: z.array(z.union([success, BulkItemErrorSchema])),
    summary: BulkSummarySchema,
  });
}

export const BulkCreateItemResponseSchema = bulkEnvelope({
  item_id: z.string(),
  item_type: z.string(),
});

export const BulkPerformActionResponseSchema = bulkEnvelope({
  action_id: z.string(),
  action_type: z.string(),
  action_status: z.string(),
  update_count: z.number().int().nonnegative(),
  source_item_id: z.string(),
  target_item_id: z.string(),
});

export const BulkUpdateActionStatusResponseSchema = bulkEnvelope({
  action_id: z.string(),
  action_type: z.string(),
  action_status: z.string(),
  update_count: z.number().int().nonnegative(),
});

/** Request-level (non-array / empty / over-limit) error body. */
export const BulkRequestErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});
```

- [ ] **Step 4: Re-export from the barrel**

In `packages/schemas/src/index.ts`, add after line 5 (`export * from './api/item_schemas';`):

```ts
export * from './api/bulk_schemas';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @dpg/schemas exec vitest run src/api/__tests__/bulk_schemas.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/src/api/bulk_schemas.ts packages/schemas/src/api/__tests__/bulk_schemas.test.ts packages/schemas/src/index.ts
git commit -m "feat(schemas): add bulk response envelope schemas"
```

---

## Phase 1 — Bulk Create

### Task 4: Convert `/item/create` to array + processOne

**Files:**
- Modify: `apps/api/src/routes/v1/item/create_item.ts` (full rewrite of the route + handler)
- Test: `apps/api/src/routes/v1/item/__tests__/create_item.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/v1/item/__tests__/create_item.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    served_domains: [{ network: 'blue_dot', domain: 'seeker', key: 'blue_dot/seeker' }],
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    bulk_max_items: 3,
    schema_registry_url: '',
  },
  getCurrentApiBaseUrl: () => 'http://source.local',
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: vi.fn(async () => {}),
  auth_middleware: vi.fn(async () => {}),
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({ db: {} }));

vi.mock('@dpg/database', async () => {
  const actual = await vi.importActual<typeof import('@dpg/database')>('@dpg/database');
  return { ...actual, ensureItemPartition: vi.fn(async () => undefined) };
});

vi.mock('@/utils/item_fetch_cache_invalidate', () => ({
  invalidateItemFetchCache: vi.fn(async () => undefined),
}));

// createItemInternal succeeds for seeker; throws ItemServiceError(409) for item_type 'dupe'.
const { ItemServiceError } = await vi.importActual<
  typeof import('@/services/item_service')
>('@/services/item_service');
vi.mock('@/services/item_service', async () => {
  const actual = await vi.importActual<typeof import('@/services/item_service')>(
    '@/services/item_service',
  );
  return {
    ...actual,
    createItemInternal: vi.fn(async (_db: unknown, params: { item_type: string }) => {
      if (params.item_type === 'dupe') {
        throw new actual.ItemServiceError(409, 'ITEM_ALREADY_EXISTS', 'exists');
      }
      return {
        itemNetwork: 'blue_dot',
        itemDomain: 'seeker',
        itemType: params.item_type,
        itemId: `id-${params.item_type}`,
      };
    }),
  };
});

import { create_item } from '../create_item.js';

const buildApp = (user: { id: string; role?: string } = { id: 'usr_1' }): FastifyInstance => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { user: typeof user }).user = user;
  });
  app.register(create_item);
  return app;
};

const item = (item_type = 'profile_1.0') => ({
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type,
  item_state: {},
});

describe('POST /api/v1/item/create (bulk)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('201 when all items succeed', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/create', payload: [item('a'), item('b')] });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(body.results[0]).toMatchObject({ index: 0, status: 'success', item_id: 'id-a' });
  });

  it('207 on partial failure (one duplicate)', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/create', payload: [item('a'), item('dupe')] });
    expect(res.statusCode).toBe(207);
    const body = res.json();
    expect(body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(body.results[1]).toMatchObject({ index: 1, status: 'error', error: 'ITEM_ALREADY_EXISTS' });
  });

  it('per-item INVALID_PAYLOAD for a malformed element; valid sibling still created', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/create',
      payload: [item('a'), { item_network: 'blue_dot' /* missing required fields */ }],
    });
    expect(res.statusCode).toBe(207);
    expect(res.json().results[1]).toMatchObject({ index: 1, status: 'error', error: 'INVALID_PAYLOAD' });
  });

  it('per-item UNSERVED_DOMAIN_BINDING for an unserved domain', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/create',
      payload: [{ ...item('a'), item_domain: 'provider' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'UNSERVED_DOMAIN_BINDING' });
  });

  it('400 BULK_LIMIT_EXCEEDED when over the configured max', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/create',
      payload: [item('a'), item('b'), item('c'), item('d')],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'BULK_LIMIT_EXCEEDED' });
  });

  it('400 BULK_EMPTY_ARRAY for an empty array', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/create', payload: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'BULK_EMPTY_ARRAY' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/item/__tests__/create_item.test.ts`
Expected: FAIL — current handler treats the array body as a single object (Zod 400) / no envelope.

- [ ] **Step 3: Rewrite the handler**

Replace the full contents of `apps/api/src/routes/v1/item/create_item.ts`:

```ts
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z, {
  CreateItemBodySchema,
  BulkCreateItemResponseSchema,
  BulkRequestErrorSchema,
} from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { DrizzleQueryError } from 'drizzle-orm';
import { DatabaseError, ensureItemPartition } from '@dpg/database';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { isServedDomainBinding } from '@/utils/served_domain_guard';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';
import { createItemInternal, ItemServiceError } from '@/services/item_service';
import { runBulk, BulkItemFailure } from '@/utils/bulk_runner';
import { apiConfig } from '@/config';

const BulkCreateItemBodySchema = z.array(z.unknown());

type CreateItemRequest = FastifyRequest<{ Body: unknown[] }>;

export const create_item: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/create',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      body: BulkCreateItemBodySchema,
      response: {
        201: BulkCreateItemResponseSchema,
        207: BulkCreateItemResponseSchema,
        422: BulkCreateItemResponseSchema,
        400: BulkRequestErrorSchema,
      },
    },
    handler: create_item_handler,
  });
};

export const create_item_handler = async (
  request: CreateItemRequest,
  reply: FastifyReply,
) => {
  const callerId = request.user?.id;
  const callerRole = request.user?.role;

  if (!callerId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to create an item',
    });
  }

  // Admin-on-behalf-of is reserved for api-key callers (see prior single-item
  // contract). Resolved once per request; created_by stays per-element.
  const isApiKeyCaller = Boolean(request.headers['x-api-key']);
  const isAdminApiCaller = isApiKeyCaller && callerRole === 'admin';

  const outcome = await runBulk(
    request.body,
    async (raw) => {
      const parsed = CreateItemBodySchema.safeParse(raw);
      if (!parsed.success) {
        throw new BulkItemFailure(
          'INVALID_PAYLOAD',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      const body = parsed.data;

      if (!isAdminApiCaller && body.created_by) {
        throw new BulkItemFailure(
          'FORBIDDEN_CREATED_BY',
          'created_by may only be set by an admin api-key caller',
        );
      }
      if (isAdminApiCaller && !body.created_by) {
        throw new BulkItemFailure(
          'CREATED_BY_REQUIRED',
          'created_by is required when an admin api-key creates an item',
        );
      }
      const userId = isAdminApiCaller ? (body.created_by as string) : callerId;

      if (!isServedDomainBinding(body.item_network, body.item_domain)) {
        throw new BulkItemFailure(
          'UNSERVED_DOMAIN_BINDING',
          `This API instance does not serve "${body.item_network}/${body.item_domain}".`,
        );
      }

      try {
        await ensureItemPartition(db, body.item_network, body.item_domain);
      } catch (err) {
        request.log.error(
          { err, item_network: body.item_network, item_domain: body.item_domain },
          'Failed to ensure item partition',
        );
        throw new BulkItemFailure(
          'PARTITION_SETUP_FAILED',
          'Failed to prepare storage for item type',
        );
      }

      try {
        const created = await createItemInternal(db, {
          item_network: body.item_network,
          item_domain: body.item_domain,
          item_type: body.item_type,
          item_state: body.item_state ?? {},
          item_latitude: body.item_latitude ?? null,
          item_longitude: body.item_longitude ?? null,
          created_by: userId,
        });

        await invalidateItemFetchCache(body.item_network, body.item_domain).catch((err) =>
          request.log.warn({ err }, 'cache invalidation after create failed'),
        );

        return { item_id: created.itemId, item_type: created.itemType };
      } catch (err) {
        if (err instanceof ItemServiceError) {
          throw new BulkItemFailure(err.errorCode, err.message);
        }
        if (err instanceof DrizzleQueryError && err.cause instanceof DatabaseError) {
          if (err.cause.code === '23505') {
            throw new BulkItemFailure(
              'ITEM_ALREADY_EXISTS',
              'An item with the same type and id already exists',
            );
          }
          if (err.cause.code === '23503') {
            throw new BulkItemFailure(
              'INVALID_REFERENCE',
              'One or more referenced entities do not exist, including the authenticated user',
            );
          }
        }
        request.log.error({ err }, 'Failed to create item');
        throw new BulkItemFailure('INTERNAL_SERVER_ERROR', 'Failed to create item');
      }
    },
    { okStatus: 201, maxItems: apiConfig.bulk_max_items },
  );

  if (outcome.requestError) {
    return reply.code(400).send({
      error: outcome.requestError.code,
      message: outcome.requestError.message,
    });
  }

  return reply.code(outcome.httpStatus!).send({
    results: outcome.results,
    summary: outcome.summary,
  });
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/v1/item/__tests__/create_item.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck the API**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/item/create_item.ts apps/api/src/routes/v1/item/__tests__/create_item.test.ts
git commit -m "feat(api): bulk POST /item/create (array body, per-item results, 207)"
```

---

## Phase 2 — Bulk Accept/Reject (`/action/update-status`)

### Task 5: Convert `/action/update-status` to array + processOne

**Files:**
- Modify: `apps/api/src/routes/v1/action/update_action_status.ts`
- Modify: `apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts`

- [ ] **Step 1: Update the existing tests to array payloads + envelope assertions**

In `apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts`:

1a. Add `bulk_max_items: 100,` to the mocked `apiConfig` object (after `allow_extra_schema_data: true,`).

1b. Wrap every `payload: <obj>` in an array and assert the envelope. Replace each existing `app.inject(... payload: BODY ...)` + assertions. Concretely, the four primary cases become:

```ts
  it('404 ACTION_NOT_FOUND when action_id does not resolve', async () => {
    dbState.existingAction = null;
    const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
      method: 'POST', url: '/update-status', payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'ACTION_NOT_FOUND' });
  });

  it('403→422 NOT_TARGET_ITEM_OWNER when request.user is not the target owner', async () => {
    dbState.existingAction = { ...EXISTING_ACTION, target_item_owner: 'usr_other_provider' };
    const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
      method: 'POST', url: '/update-status', payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ error: 'NOT_TARGET_ITEM_OWNER' });
    expect(dbState.updates).toHaveLength(0);
  });

  it('200 when self-acted by the target item owner', async () => {
    const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
      method: 'POST', url: '/update-status', payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({ action_status: 'shortlisted' });
  });
```

For the consent-gate cases, wrap each payload in `[ ... ]` and change `expect(res.statusCode).toBe(403)` → `toBe(422)` with `res.json().results[0].error === 'CONSENT_REQUIRED'`; `toBe(200)` cases stay `200` and assert `summary.succeeded === 1`. Add one new case:

```ts
  it('207 on a mixed batch (one ok, one not found)', async () => {
    dbState.existingAction = { ...EXISTING_ACTION };
    const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
      method: 'POST',
      url: '/update-status',
      payload: [VALID_BODY, { action_id: '00000000-0000-4000-8000-0000000000ff', action_status: 'x' }],
    });
    expect(res.statusCode).toBe(207);
    expect(res.json().summary).toEqual({ total: 2, succeeded: 2, failed: 0 }); // both resolve via mocked db
  });
```

> Note: the existing mocked `db.select` returns `dbState.existingAction` for ANY `action_id`. Keep the mixed-batch assertion aligned with the mock (both succeed). To exercise a real per-item 404 in the mixed batch, extend the mock so it returns `[]` when the queried `action_id` differs from `EXISTING_ACTION.action_id`; if you do, assert `summary: { total: 2, succeeded: 1, failed: 1 }` and `results[1].error === 'ACTION_NOT_FOUND'`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/update_action_status.test.ts`
Expected: FAIL — current handler returns a single object / non-array body rejected.

- [ ] **Step 3: Rewrite the handler**

Replace the route registration and handler body in `apps/api/src/routes/v1/action/update_action_status.ts`. Keep all existing imports and ADD:

```ts
import {
  UpdateActionStatusBodySchema,
  BulkUpdateActionStatusResponseSchema,
  BulkRequestErrorSchema,
} from '@dpg/schemas';
import { runBulk, BulkItemFailure } from '@/utils/bulk_runner';
import { apiConfig } from '@/config';
```

Replace the `update_action_status` plugin registration:

```ts
const BulkUpdateActionStatusBodySchema = z.array(z.unknown());

export const update_action_status: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/update-status',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      body: BulkUpdateActionStatusBodySchema,
      response: {
        200: BulkUpdateActionStatusResponseSchema,
        207: BulkUpdateActionStatusResponseSchema,
        422: BulkUpdateActionStatusResponseSchema,
        400: BulkRequestErrorSchema,
      },
    },
    handler: update_action_status_handler,
  });
};
```

Replace the handler so the existing per-action logic lives inside `processOne`. The body of `processOne` is the current handler logic with every `return reply.code(4xx).send({error,message})` rewritten as `throw new BulkItemFailure('CODE', message)` and the final `return reply.code(200).send(...)` rewritten as `return { ... }`:

```ts
export const update_action_status_handler = async (
  request: FastifyRequest<{ Body: unknown[] }>,
  reply: FastifyReply,
) => {
  const callerId = request.user.id;

  const outcome = await runBulk(
    request.body,
    async (raw) => {
      const parsed = UpdateActionStatusBodySchema.safeParse(raw);
      if (!parsed.success) {
        throw new BulkItemFailure(
          'INVALID_PAYLOAD',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      const body = parsed.data;

      const [existingAction] = await db
        .select()
        .from(item_actions)
        .where(eq(item_actions.action_id, body.action_id))
        .limit(1);

      if (!existingAction) {
        throw new BulkItemFailure('ACTION_NOT_FOUND', 'Action does not exist on this instance');
      }
      if (existingAction.target_item_owner !== callerId) {
        throw new BulkItemFailure(
          'NOT_TARGET_ITEM_OWNER',
          'update-status may only be called by the target item owner.',
        );
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
        throw new BulkItemFailure(
          'INVALID_ACTION_EVENT',
          err instanceof Error ? err.message : 'Invalid action event',
        );
      }

      const requiresReceiverConsent =
        interaction.reveals_pii_on_status.includes(body.action_status) &&
        !!interaction.consent_text_receiver?.trim();

      if (requiresReceiverConsent && !body.consent?.acknowledged) {
        throw new BulkItemFailure(
          'CONSENT_REQUIRED',
          'Receiver consent acknowledgment required to transition to this status.',
        );
      }
      if (requiresReceiverConsent && body.consent?.acknowledged) {
        request.log.info(
          {
            side: 'receiver',
            action_id: body.action_id,
            action_status: body.action_status,
            consent_text_length: body.consent.text.length,
          },
          'consent recorded',
        );
      }

      const eventPayload = buildActionEventPayload({
        event_schema: interaction.event_schema,
        action_status: body.action_status,
        remarks: body.remarks,
        consent: body.consent,
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
          requirements_snapshot: existingAction.requirements_snapshot as Record<string, unknown>,
        },
      });

      try {
        validateActionEventPayload(interaction.event_schema, eventPayload);
      } catch (err) {
        throw new BulkItemFailure(
          'INVALID_ACTION_EVENT',
          err instanceof Error ? err.message : 'Invalid action event',
        );
      }

      try {
        await ensureActionEventPartition(
          db,
          existingAction.target_item_network,
          existingAction.action_type,
        );
      } catch (err) {
        request.log.error(
          { err, action_id: existingAction.action_id, action_type: existingAction.action_type },
          'Failed to ensure action event partition',
        );
        throw new BulkItemFailure('PARTITION_SETUP_FAILED', 'Failed to prepare storage for action event');
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
        source_item_owner: updatedAction.source_item_owner ?? sourceItemSnapshot?.created_by ?? null,
        target_item_owner: updatedAction.target_item_owner ?? targetItemSnapshot?.created_by ?? null,
        source_item_latitude: sourceItemSnapshot?.item_latitude ?? null,
        source_item_longitude: sourceItemSnapshot?.item_longitude ?? null,
        target_item_latitude: targetItemSnapshot?.item_latitude ?? null,
        target_item_longitude: targetItemSnapshot?.item_longitude ?? null,
        event_payload: eventPayload,
        remarks: body.remarks,
      };

      await insertActionEvent(db, storedEvent);
      void mirrorActionEventToSourceInstance(storedEvent, request.log);

      return {
        action_id: updatedAction.action_id,
        action_type: updatedAction.action_type,
        action_status: updatedAction.action_status,
        update_count: updatedAction.update_count,
      };
    },
    { okStatus: 200, maxItems: apiConfig.bulk_max_items },
  );

  if (outcome.requestError) {
    return reply.code(400).send({
      error: outcome.requestError.code,
      message: outcome.requestError.message,
    });
  }

  return reply.code(outcome.httpStatus!).send({
    results: outcome.results,
    summary: outcome.summary,
  });
};
```

Remove the now-unused `UpdateActionStatusRequest` type and the old `UpdateActionStatusResponseSchema` const (replaced by the bulk schema).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/update_action_status.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/action/update_action_status.ts apps/api/src/routes/v1/action/__tests__/update_action_status.test.ts
git commit -m "feat(api): bulk POST /action/update-status (array body, per-item results)"
```

---

## Phase 3 — Bulk Connect (`/action/perform`)

### Task 6: Convert `/action/perform` to array + processOne (loop per item)

**Files:**
- Modify: `apps/api/src/routes/v1/action/perform_action.ts`
- Modify: `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts`

- [ ] **Step 1: Update the existing tests to array payloads + envelope assertions**

In `apps/api/src/routes/v1/action/__tests__/perform_action.test.ts`:

1a. Add `bulk_max_items: 100,` to the mocked `apiConfig`.

1b. Wrap each `payload:` in an array. Success cases assert `res.statusCode === 201`, `res.json().summary.succeeded === 1`, and `res.json().results[0]` matches the prior single response. Per-item rejection cases (e.g. `SOURCE_ITEM_NOT_FOUND`, `SOURCE_ITEM_NOT_OWNED_BY_ACTOR`, `INVALID_TARGET_INSTANCE`, `CONSENT_REQUIRED`) now assert `res.statusCode === 422` and `res.json().results[0]` matches `{ status: 'error', error: '<CODE>' }`. Actor-resolution rejections that are **request-level** (the `resolve_acting_actor` failure, which is computed per element from `acting_as_user_id`) become per-item errors too — assert via `results[0]`.

1c. Add a mixed-batch case:

```ts
  it('207 when one connect succeeds and one has an unknown target instance', async () => {
    // first element: valid (mocked fetch returns ok); second: target instance not allowed
    const res = await buildApp(/* existing valid wiring */).inject({
      method: 'POST',
      url: '/perform',
      payload: [VALID_PERFORM_BODY, { ...VALID_PERFORM_BODY, target_item: { ...VALID_PERFORM_BODY.target_item, item_instance_url: 'http://not-allowed.local' } }],
    });
    expect(res.statusCode).toBe(207);
    expect(res.json().summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(res.json().results[1]).toMatchObject({ status: 'error', error: 'INVALID_TARGET_INSTANCE' });
  });
```

> Keep the existing `global.fetch` / `vi.fn` mock that the file already uses to stub the inter-instance call; the bulk handler calls it once per element. If the test mocks a single resolved fetch, switch it to `mockResolvedValue` (not `mockResolvedValueOnce`) so each looped element gets a response.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/perform_action.test.ts`
Expected: FAIL — non-array body rejected / no envelope.

- [ ] **Step 3: Rewrite the handler**

In `apps/api/src/routes/v1/action/perform_action.ts`, ADD imports:

```ts
import {
  PerformActionBodySchema,
  BulkPerformActionResponseSchema,
  BulkRequestErrorSchema,
} from '@dpg/schemas';
import { runBulk, BulkItemFailure } from '@/utils/bulk_runner';
import { apiConfig } from '@/config';
```

(`apiConfig` is already imported in this file — merge, don't duplicate.) Replace the plugin registration:

```ts
const BulkPerformActionBodySchema = z.array(z.unknown());

export const perform_action: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/perform',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      body: BulkPerformActionBodySchema,
      response: {
        201: BulkPerformActionResponseSchema,
        207: BulkPerformActionResponseSchema,
        422: BulkPerformActionResponseSchema,
        400: BulkRequestErrorSchema,
      },
    },
    handler: perform_action_handler,
  });
};
```

Replace the handler. Each element resolves its own actor (it carries its own `acting_as_user_id`), validates, and makes the existing per-item HTTP call. Every `return reply.code(4xx).send(...)` becomes `throw new BulkItemFailure(...)`; the success `return reply.code(201).send(responseBody)` becomes `return responseBody`:

```ts
export const perform_action_handler = async (
  request: FastifyRequest<{ Body: unknown[] }>,
  reply: FastifyReply,
) => {
  const sourceInstanceUrl = getCurrentApiBaseUrl();

  const outcome = await runBulk(
    request.body,
    async (raw) => {
      const parsed = PerformActionBodySchema.safeParse(raw);
      if (!parsed.success) {
        throw new BulkItemFailure(
          'INVALID_PAYLOAD',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      const body = parsed.data;

      const actor = await resolve_acting_actor({
        acting_org: request.acting_org,
        request_user_id: request.user.id,
        acting_as_user_id: body.acting_as_user_id,
        lookup_user: lookup_user_for_acting,
      });
      if (!actor.ok) {
        throw new BulkItemFailure(actor.error, action_error_messages[actor.error]);
      }

      if (!isServedDomainBinding(body.source_item.item_network, body.source_item.item_domain)) {
        throw new BulkItemFailure(
          'UNSERVED_DOMAIN_BINDING',
          `This API instance does not serve "${body.source_item.item_network}/${body.source_item.item_domain}".`,
        );
      }

      const sourceItem = { ...body.source_item, item_instance_url: sourceInstanceUrl };
      const targetItem = buildNetworkActionTargetItem(body.target_item);

      const sourceItemSnapshot = await fetchLocalItemSnapshot(db, sourceItem);
      if (!sourceItemSnapshot) {
        throw new BulkItemFailure('SOURCE_ITEM_NOT_FOUND', 'Source item does not exist on this instance');
      }
      if (sourceItemSnapshot.created_by !== actor.effective_user_id) {
        throw new BulkItemFailure(
          'SOURCE_ITEM_NOT_OWNED_BY_ACTOR',
          'source_item must be owned by the effective actor (request.user or acting_as_user_id)',
        );
      }

      let requirementsSnapshot = body.requirements_snapshot;

      try {
        const networkConfig = await getNetworkConfigById(targetItem.item_network);
        const matchedDomain = networkConfig.domains.find((d) => d.id === targetItem.item_domain);
        if (!matchedDomain) {
          throw new BulkItemFailure(
            'INVALID_TARGET_ITEM',
            `Domain "${targetItem.item_domain}" is not defined for network "${targetItem.item_network}".`,
          );
        }
        const allowedInstance = networkConfig.instances.some(
          (instance) =>
            instance.domain_id === targetItem.item_domain &&
            normalizeInstanceUrl(instance.instance_url) === normalizeInstanceUrl(targetItem.item_instance_url),
        );
        if (!allowedInstance) {
          throw new BulkItemFailure(
            'INVALID_TARGET_INSTANCE',
            'Target item instance URL is not allowed for this network/domain',
          );
        }

        const interaction = getActionInteraction(networkConfig, {
          actionType: body.action_type,
          fromNetwork: sourceItem.item_network,
          fromDomain: sourceItem.item_domain,
          fromItemType: sourceItem.item_type,
          toNetwork: targetItem.item_network,
          toDomain: targetItem.item_domain,
          toItemType: targetItem.item_type,
        });

        if (interaction.consent_text_initiator?.trim() && !body.consent?.acknowledged) {
          throw new BulkItemFailure('CONSENT_REQUIRED', 'Initiator consent acknowledgment required for this action.');
        }

        requirementsSnapshot = mergeItemStateWithPrivate(
          body.requirements_snapshot,
          projectPrivateStateForSchema(interaction.requirement_schema, sourceItemSnapshot.private_state),
        );
        validateAgainstJsonSchema(interaction.requirement_schema, requirementsSnapshot, 'action requirements', {
          allowAdditionalProperties: apiConfig.allow_extra_schema_data,
        });
      } catch (err) {
        if (err instanceof BulkItemFailure) throw err;
        throw new BulkItemFailure(
          'INVALID_ACTION_REQUEST',
          err instanceof Error ? err.message : 'Invalid action request',
        );
      }

      let response: Response;
      try {
        response = await fetch(new URL('/api/v1/network/action/perform', targetItem.item_instance_url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action_type: body.action_type,
            source_item: sourceItem,
            target_item: targetItem,
            source_item_owner: actor.effective_user_id,
            requirements_snapshot: requirementsSnapshot,
            performed_by_org_id: actor.audit.performed_by_org_id,
            performed_by_service_user_id: actor.audit.performed_by_service_user_id,
            consent: body.consent,
          }),
        });
      } catch (err) {
        request.log.error(
          { err, action_type: body.action_type, target_instance_url: targetItem.item_instance_url },
          'Failed to call target instance perform action API',
        );
        throw new BulkItemFailure('TARGET_INSTANCE_UNAVAILABLE', 'Failed to reach the target instance perform action API');
      }

      const responseBody = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const code = typeof responseBody.error === 'string' ? responseBody.error : 'TARGET_INSTANCE_ERROR';
        const message = typeof responseBody.message === 'string' ? responseBody.message : 'Target instance rejected the action';
        throw new BulkItemFailure(code, message);
      }
      return responseBody as {
        action_id: string;
        action_type: string;
        action_status: string;
        update_count: number;
        source_item_id: string;
        target_item_id: string;
      };
    },
    { okStatus: 201, maxItems: apiConfig.bulk_max_items },
  );

  if (outcome.requestError) {
    return reply.code(400).send({
      error: outcome.requestError.code,
      message: outcome.requestError.message,
    });
  }

  return reply.code(outcome.httpStatus!).send({
    results: outcome.results,
    summary: outcome.summary,
  });
};
```

Remove the now-unused `PerformActionRequest` type and `PerformActionResponseSchema` const.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/v1/action/__tests__/perform_action.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole API unit suite + typecheck**

Run: `pnpm --filter api test && pnpm --filter api exec tsc --noEmit`
Expected: all pass, no type errors. (Fix any other existing tests that posted single objects to these three routes by wrapping payloads in arrays and asserting the envelope.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/action/perform_action.ts apps/api/src/routes/v1/action/__tests__/perform_action.test.ts
git commit -m "feat(api): bulk POST /action/perform (array body, loop-per-item fan-out)"
```

---

## Phase 4 — UI client layer

### Task 7: Wrap single UI calls as arrays of one

**Files:**
- Modify: `apps/ui/src/lib/item-api.ts:73-76`
- Modify: `apps/ui/src/lib/action-api.ts:263-291`

- [ ] **Step 1: Add a shared bulk-result type + unwrap helper to `item-api.ts`**

In `apps/ui/src/lib/item-api.ts`, add near the top (after the existing interfaces) and rewrite `createItem`:

```ts
interface BulkItemError {
  index: number;
  status: 'error';
  error: string;
  message: string;
}
type BulkResult<T> = ({ index: number; status: 'success' } & T) | BulkItemError;
interface BulkEnvelope<T> {
  results: BulkResult<T>[];
  summary: { total: number; succeeded: number; failed: number };
}

/** Unwrap a single-item bulk envelope: return results[0] or throw its error. */
function unwrapSingle<T>(envelope: BulkEnvelope<T>): T {
  const first = envelope.results[0];
  if (!first || first.status === 'error') {
    const err = first as BulkItemError | undefined;
    const e = new Error(err?.message ?? 'Request failed') as Error & { code?: string };
    e.code = err?.error ?? 'UNKNOWN';
    throw e;
  }
  const { index: _i, status: _s, ...data } = first;
  return data as T;
}

export async function createItem(payload: CreateItemPayload): Promise<CreateItemResponse> {
  const response = await apiClient.post<BulkEnvelope<CreateItemResponse>>(
    '/api/v1/item/create',
    [payload],
  );
  return unwrapSingle(response.data);
}
```

- [ ] **Step 2: Rewrite `performAction` + `updateActionStatus` in `action-api.ts`**

In `apps/ui/src/lib/action-api.ts`, add the same `BulkEnvelope`/`unwrapSingle` helper (or import a shared one — if you extract it, put it in `apps/ui/src/lib/bulk.ts` and import in both files), then:

```ts
export async function performAction(
  payload: PerformActionPayload,
  sourceInstanceUrl?: string,
): Promise<PerformActionResponse> {
  const client = sourceInstanceUrl ? createInstanceApiClient(sourceInstanceUrl) : apiClient;
  const response = await client.post<BulkEnvelope<PerformActionResponse>>(
    '/api/v1/action/perform',
    [payload],
  );
  return unwrapSingle(response.data);
}

export async function updateActionStatus(
  payload: UpdateActionStatusPayload,
): Promise<UpdateActionStatusResponse> {
  const response = await apiClient.post<BulkEnvelope<UpdateActionStatusResponse>>(
    '/api/v1/action/update-status',
    [payload],
  );
  return unwrapSingle(response.data);
}
```

> Recommended: extract `BulkEnvelope`, `BulkItemError`, and `unwrapSingle` into `apps/ui/src/lib/bulk.ts` and import in both `item-api.ts` and `action-api.ts` (DRY). The error carries `.code` so existing callers that read `err.code` (e.g. `contact-details-modal`, profile error mapping) keep working.

- [ ] **Step 3: Typecheck the UI**

Run: `pnpm --filter @dpg/ui exec tsc --noEmit` (or `cd apps/ui && pnpm exec tsc --noEmit`)
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/lib/item-api.ts apps/ui/src/lib/action-api.ts apps/ui/src/lib/bulk.ts
git commit -m "feat(ui): adapt create/perform/update-status clients to array-only bulk APIs"
```

---

## Phase 5 — Verification & manual smoke

### Task 8: Full verification

- [ ] **Step 1: Run the full API unit suite**

Run: `pnpm --filter api test`
Expected: all pass.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: api + ui both clean.

- [ ] **Step 3: Manual smoke (requires db + redis + dev servers)**

Start services (`docker compose up -d db redis`, `pnpm dev:api`, `pnpm dev:ui`) and verify in the UI on `?network=purple_dot`:
- Create a single profile → succeeds (network tab shows `POST /item/create` with `[{...}]` body and `{ results:[...], summary:{succeeded:1} }`, 201).
- Connect to a provider → succeeds (single-element array, 201).
- Accept/Reject from My Actions → succeeds (single-element array, 200).

- [ ] **Step 4: Commit any fixes, then stop**

```bash
git add -A && git commit -m "test: bulk API verification fixes" # only if changes were needed
```

> Note: integration tests that exercise these routes end-to-end (`*.integration.test.ts`) and the external callers (aggregator-dpg, voice-dpg) are updated in the separate coordinated follow-up described in the spec — not in this plan.

---

## Self-Review

**Spec coverage:**
- Array-only payload → Tasks 4/5/6 (route body `z.array(z.unknown())`). ✓
- Per-item lenient validation → `safeParse` inside each `processOne` → `INVALID_PAYLOAD`. ✓
- Best-effort + per-item results + 207 → `runBulk` (Task 2). ✓
- Configurable limit → `BULK_MAX_ITEMS` (Task 1), enforced in `runBulk`. ✓
- Connect loop-per-item → Task 6 calls the existing single inter-instance endpoint once per element. ✓
- Status codes (201/200 / 207 / 422 / 400) → `runBulk` + handler request-error branch. ✓
- UI absorbs the break in the client layer → Task 7. ✓
- Existing tests updated to arrays → Tasks 4/5/6 Step 1. ✓
- Migration of external callers → explicitly out of scope (Task 8 note + spec). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**Type consistency:** `runBulk`/`BulkItemFailure` signatures match across Tasks 2/4/5/6. Success shapes match the bulk schemas in Task 3 (`item_id`/`item_type`; action fields incl. `source_item_id`/`target_item_id` for perform). `unwrapSingle` strips `index`/`status` and returns the existing response interfaces. ✓
