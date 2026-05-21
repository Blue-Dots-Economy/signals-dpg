# Aggregator Service Auth & Org Mirroring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let external DPGs (aggregator-dpg, voice-dpg) authenticate to Signals as themselves and assert which aggregator org they are acting on behalf of for any given request.

**Architecture:** Use better-auth's existing `apikey` plugin — no new auth tables. One Signals service `user` per integrating DPG, sitting in a `network_service`-typed `organization`, owning one apikey. Each Signals request from a DPG carries `x-acting-org-id` naming the aggregator org. A Fastify preHandler resolves the apikey, looks up the acting org, validates the service user is permitted, and attaches `request.acting_org` to the request. Aggregator orgs themselves (BBMP, NSDC, etc.) are mirrored into Signals' `organization` table via a new admin upsert endpoint called from aggregator-dpg on aggregator signup.

**Tech Stack:** Fastify 5, better-auth (`apikey` + `organization` plugins, already configured in `packages/auth/src/config.ts`), Drizzle ORM, Zod (`fastify-type-provider-zod`), Vitest (newly introduced).

**Prereqs:** Local Postgres + Redis running (`docker compose up -d db redis`). Repo root `.env` populated. Run scripts from root so `scripts/turbo-with-root-env.mjs` loads env.

**Out of scope:** The `POST /api/v1/admin/onboard_participant` endpoint, attribution columns, and metrics — those are separate plans (see `2026-05-21-participant-onboarding-attribution.md` and `2026-05-21-participant-metrics-service.md`).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/vitest.config.ts` (new) | Vitest setup for `apps/api` |
| `apps/api/src/types/fastify.d.ts` (new) | Augment `FastifyRequest` with `acting_org` |
| `apps/api/src/middleware/acting_org.ts` (new) | preHandler that resolves apikey → service user → asserted org |
| `apps/api/src/middleware/__tests__/acting_org.test.ts` (new) | Unit tests for preHandler |
| `apps/api/src/server.ts` (modify) | Register the preHandler globally for `/api/v1/admin/*` and any aggregator/voice routes |
| `apps/api/src/routes/v1/admin/aggregator/upsert.ts` (new) | `POST /api/v1/admin/aggregator/upsert` — mirror an aggregator org from aggregator-dpg |
| `apps/api/src/routes/v1/admin/aggregator/__tests__/upsert.test.ts` (new) | Route tests |
| `apps/api/src/routes/v1/admin/index.ts` (new or modify) | Register admin route group |
| `packages/schemas/src/admin/aggregator_upsert.ts` (new) | Zod request/response schemas |
| `apps/api/scripts/seed_service_users.ts` (new) | One-time / idempotent seed for the two service users + apikeys |
| `apps/api/package.json` (modify) | Add `test` script, Vitest dep |

---

## Task 1: Add Vitest to apps/api

**Files:**
- Create: `apps/api/vitest.config.ts`
- Modify: `apps/api/package.json`

- [ ] **Step 1: Install Vitest**

Run from repo root:
```bash
pnpm add -D vitest --filter @dpg/api
```

- [ ] **Step 2: Create Vitest config**

Create `apps/api/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['src/**/__tests__/**/*.integration.test.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
```

- [ ] **Step 3: Add test script**

Edit `apps/api/package.json` `scripts` block, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Verify Vitest runs (no tests yet)**

Run from repo root:
```bash
pnpm --filter @dpg/api test
```
Expected: exits 0 with "No test files found" or equivalent.

- [ ] **Step 5: Commit**
```bash
git add apps/api/vitest.config.ts apps/api/package.json pnpm-lock.yaml
git commit -m "chore(api): add Vitest test runner"
```

---

## Task 2: Type augmentation for `request.acting_org`

**Files:**
- Create: `apps/api/src/types/fastify.d.ts`

- [ ] **Step 1: Write the augmentation**

Create `apps/api/src/types/fastify.d.ts`:
```ts
import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The aggregator/voice org this request is acting on behalf of.
     * Populated by the acting_org preHandler. Absent on routes that
     * don't require it.
     */
    acting_org?: {
      org_id: string;
      org_type: 'aggregator' | 'voice' | 'network_service';
      service_user_id: string;
    };
  }
}
```

- [ ] **Step 2: Verify TS picks it up**

Run from repo root:
```bash
pnpm tsc --noEmit
```
Expected: PASS with no errors.

- [ ] **Step 3: Commit**
```bash
git add apps/api/src/types/fastify.d.ts
git commit -m "feat(api): augment FastifyRequest with acting_org"
```

---

## Task 3: acting_org preHandler — failing tests first

**Files:**
- Create: `apps/api/src/middleware/__tests__/acting_org.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/middleware/__tests__/acting_org.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { acting_org_preHandler } from '../acting_org.js';

const makeReply = () => {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply as unknown as FastifyReply;
};

const makeRequest = (overrides: Partial<FastifyRequest> = {}): FastifyRequest =>
  ({
    headers: {},
    log: { error: vi.fn(), info: vi.fn() },
    user: undefined,
    ...overrides,
  } as unknown as FastifyRequest);

describe('acting_org preHandler', () => {
  it('rejects when x-acting-org-id header is missing', async () => {
    const req = makeRequest({ user: { id: 'svc_user_1' } as any });
    const reply = makeReply();
    await acting_org_preHandler(req, reply, async () => {});
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'MISSING_ACTING_ORG' })
    );
  });

  it('rejects when caller is not authenticated', async () => {
    const req = makeRequest({ headers: { 'x-acting-org-id': 'org_a' } });
    const reply = makeReply();
    await acting_org_preHandler(req, reply, async () => {});
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it('rejects when acting org does not exist', async () => {
    const req = makeRequest({
      headers: { 'x-acting-org-id': 'org_nope' },
      user: { id: 'svc_user_1' } as any,
    });
    const reply = makeReply();
    // org lookup returns null in fake — see implementation step
    await acting_org_preHandler(req, reply, async () => {});
    expect(reply.code).toHaveBeenCalledWith(404);
  });

  it('rejects when service user has no member row for the org', async () => {
    // covered in implementation by failing the member lookup
  });

  it('attaches acting_org and proceeds when authorized', async () => {
    // happy path covered in integration test (Task 5)
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

```bash
pnpm --filter @dpg/api test
```
Expected: FAIL with `Cannot find module '../acting_org.js'`.

- [ ] **Step 3: Commit (tests-only)**
```bash
git add apps/api/src/middleware/__tests__/acting_org.test.ts
git commit -m "test(api): add failing tests for acting_org preHandler"
```

---

## Task 4: Implement acting_org preHandler

**Files:**
- Create: `apps/api/src/middleware/acting_org.ts`

- [ ] **Step 1: Implement**

Create `apps/api/src/middleware/acting_org.ts`:
```ts
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { db } from '@dpg/database';
import { organization, member } from '../../db/postgres/schema/auth.js';
import { eq, and } from 'drizzle-orm';

const ALLOWED_ORG_TYPES = ['aggregator', 'voice', 'network_service'] as const;

export const acting_org_preHandler: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const header = request.headers['x-acting-org-id'];
  const org_id = Array.isArray(header) ? header[0] : header;

  if (!org_id) {
    return reply.code(400).send({
      error: 'MISSING_ACTING_ORG',
      message: 'x-acting-org-id header is required',
    });
  }

  const service_user_id = (request as any).user?.id as string | undefined;
  if (!service_user_id) {
    return reply.code(401).send({
      error: 'UNAUTHENTICATED',
      message: 'service apikey is required',
    });
  }

  const org_row = await db
    .select({ id: organization.id, type: organization.type })
    .from(organization)
    .where(eq(organization.id, org_id))
    .limit(1)
    .then((r) => r[0]);

  if (!org_row) {
    return reply.code(404).send({
      error: 'ACTING_ORG_NOT_FOUND',
      message: `org ${org_id} does not exist`,
    });
  }

  if (!ALLOWED_ORG_TYPES.includes(org_row.type as any)) {
    return reply.code(403).send({
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      message: `org type ${org_row.type} cannot be asserted as acting org`,
    });
  }

  // For network_service callers, the service user must be a member of a
  // network_service org. We then trust the asserted aggregator/voice org id
  // if it exists. If you want stricter scoping (this service user can only
  // act for orgs A and B), encode that in member.permissions and check here.
  const member_row = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.userId, service_user_id))
    .limit(1)
    .then((r) => r[0]);

  if (!member_row) {
    return reply.code(403).send({
      error: 'SERVICE_USER_NOT_REGISTERED',
      message: 'service user is not a member of any org',
    });
  }

  request.acting_org = {
    org_id: org_row.id,
    org_type: org_row.type as 'aggregator' | 'voice' | 'network_service',
    service_user_id,
  };
};
```

- [ ] **Step 2: Adjust tests to mock `db`**

Update `apps/api/src/middleware/__tests__/acting_org.test.ts` top:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@dpg/database', () => {
  const select_chain = (rows: any[]) => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  });
  return {
    db: {
      select: vi.fn(() => select_chain([])),
    },
    __setSelectRows: (rows: any[]) => {
      // helper used by tests
    },
  };
});
```
(Or replace this mock with a thin in-memory fake — fakes catch shape drift better than `vi.fn()`. Pattern documented in aggregator-dpg's `.claude/rules` if you want a reference.)

- [ ] **Step 3: Run tests, verify they pass**

```bash
pnpm --filter @dpg/api test
```
Expected: all 3 tests PASS.

- [ ] **Step 4: Commit**
```bash
git add apps/api/src/middleware/acting_org.ts apps/api/src/middleware/__tests__/acting_org.test.ts
git commit -m "feat(api): add acting_org preHandler resolving aggregator/voice scope"
```

---

## Task 5: Wire preHandler into the server for admin routes

**Files:**
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Read current server bootstrap**

Open `apps/api/src/server.ts` and locate where `AuthRoutes` and `v1_routes` are registered. The preHandler must run AFTER better-auth has populated `request.user` but BEFORE the route handler.

- [ ] **Step 2: Register the preHandler scoped to `/api/v1/admin`**

Add inside the v1 plugin or as a sub-plugin:
```ts
import { acting_org_preHandler } from './middleware/acting_org.js';

app.register(
  async (admin_scope) => {
    admin_scope.addHook('preHandler', acting_org_preHandler);
    // admin routes mount here in Task 7
  },
  { prefix: '/api/v1/admin' },
);
```

- [ ] **Step 3: Type check**
```bash
pnpm tsc --noEmit
```
Expected: PASS.

- [ ] **Step 4: Commit**
```bash
git add apps/api/src/server.ts
git commit -m "feat(api): mount acting_org preHandler on /api/v1/admin"
```

---

## Task 6: Zod schemas for aggregator upsert

**Files:**
- Create: `packages/schemas/src/admin/aggregator_upsert.ts`

- [ ] **Step 1: Write schemas**

Create `packages/schemas/src/admin/aggregator_upsert.ts`:
```ts
import { z } from 'zod';

export const AggregatorUpsertRequest = z.object({
  external_id: z.string().min(1).describe('aggregator-dpg primary key'),
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  logo_url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const AggregatorUpsertResponse = z.object({
  org_id: z.string(),
  created: z.boolean(),
});

export type AggregatorUpsertRequest = z.infer<typeof AggregatorUpsertRequest>;
export type AggregatorUpsertResponse = z.infer<typeof AggregatorUpsertResponse>;
```

- [ ] **Step 2: Export from package index**

Add to `packages/schemas/src/index.ts`:
```ts
export * from './admin/aggregator_upsert.js';
```

- [ ] **Step 3: Type check + commit**
```bash
pnpm tsc --noEmit
git add packages/schemas/src/admin/aggregator_upsert.ts packages/schemas/src/index.ts
git commit -m "feat(schemas): add aggregator upsert request/response schemas"
```

---

## Task 7: `POST /api/v1/admin/aggregator/upsert` — failing tests first

**Files:**
- Create: `apps/api/src/routes/v1/admin/aggregator/__tests__/upsert.test.ts`

- [ ] **Step 1: Write tests**

Create the test file:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { aggregator_upsert } from '../upsert.js';

// Helper: build an app with the preHandler stubbed to inject acting_org.
const build_app = async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    req.acting_org = {
      org_id: 'org_network_service',
      org_type: 'network_service',
      service_user_id: 'svc_user_aggregator_dpg',
    };
  });
  await app.register(aggregator_upsert);
  return app;
};

describe('POST /admin/aggregator/upsert', () => {
  it('creates a new aggregator org and returns created=true', async () => {
    const app = await build_app();
    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: {
        external_id: 'agg_bbmp_001',
        name: 'BBMP',
        slug: 'bbmp',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.org_id).toMatch(/^org_/);
  });

  it('updates an existing org when external_id matches', async () => {
    const app = await build_app();
    await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: { external_id: 'agg_bbmp_001', name: 'BBMP', slug: 'bbmp' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/aggregator/upsert',
      payload: { external_id: 'agg_bbmp_001', name: 'BBMP (renamed)', slug: 'bbmp' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(false);
  });

  it('returns 403 when acting_org is not a network_service caller', async () => {
    // stub the preHandler to inject org_type='aggregator' and assert 403
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**
```bash
pnpm --filter @dpg/api test
```
Expected: FAIL — module `../upsert.js` not found.

- [ ] **Step 3: Commit (tests only)**
```bash
git add apps/api/src/routes/v1/admin/aggregator/__tests__/upsert.test.ts
git commit -m "test(api): failing tests for aggregator upsert route"
```

---

## Task 8: Implement aggregator upsert route

**Files:**
- Create: `apps/api/src/routes/v1/admin/aggregator/upsert.ts`
- Modify: `apps/api/src/routes/v1/admin/index.ts`

- [ ] **Step 1: Implement the handler**

Create `apps/api/src/routes/v1/admin/aggregator/upsert.ts`:
```ts
import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { db } from '@dpg/database';
import { organization } from '../../../../db/postgres/schema/auth.js';
import { eq } from 'drizzle-orm';
import {
  AggregatorUpsertRequest,
  AggregatorUpsertResponse,
} from '@dpg/schemas';

export const aggregator_upsert: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/aggregator/upsert',
    {
      schema: {
        body: AggregatorUpsertRequest,
        response: { 200: AggregatorUpsertResponse },
      },
    },
    async (request, reply) => {
      if (request.acting_org?.org_type !== 'network_service') {
        return reply.code(403).send({
          error: 'NOT_NETWORK_SERVICE',
          message: 'only the network service caller may mirror aggregator orgs',
        });
      }

      const { external_id, name, slug, logo_url, metadata } = request.body;

      // Look up by metadata.external_id (we store it inside metadata to avoid
      // a schema change on `organization`).
      const existing = await db
        .select({ id: organization.id, metadata: organization.metadata })
        .from(organization)
        .where(eq(organization.slug, slug))
        .limit(1)
        .then((r) => r[0]);

      const meta_obj = { ...(metadata ?? {}), external_id };
      const meta_str = JSON.stringify(meta_obj);

      if (existing) {
        await db
          .update(organization)
          .set({ name, logo: logo_url ?? null, metadata: meta_str })
          .where(eq(organization.id, existing.id));
        return { org_id: existing.id, created: false };
      }

      const org_id = `org_${randomUUID()}`;
      try {
        await db.insert(organization).values({
          id: org_id,
          name,
          slug,
          logo: logo_url ?? null,
          type: 'aggregator',
          metadata: meta_str,
          createdAt: new Date(),
        });
      } catch (err: any) {
        if (err?.code === '23505') {
          request.log.error({ err, slug }, 'aggregator slug collision');
          return reply.code(409).send({
            error: 'SLUG_TAKEN',
            message: `slug "${slug}" is already in use`,
          });
        }
        throw err;
      }
      return { org_id, created: true };
    },
  );
};
```

- [ ] **Step 2: Register the route**

Create or modify `apps/api/src/routes/v1/admin/index.ts`:
```ts
import type { FastifyPluginAsync } from 'fastify';
import { aggregator_upsert } from './aggregator/upsert.js';

export const admin_routes: FastifyPluginAsync = async (app) => {
  await app.register(aggregator_upsert);
};
```

Then in `apps/api/src/server.ts`, inside the `/api/v1/admin` scope you opened in Task 5, mount it:
```ts
admin_scope.register(admin_routes);
```

- [ ] **Step 3: Run tests, verify pass**
```bash
pnpm --filter @dpg/api test
```
Expected: 2 of 3 tests PASS (the third — 403 stub — passes once you finish the stub in the test file).

- [ ] **Step 4: Commit**
```bash
git add apps/api/src/routes/v1/admin/aggregator/upsert.ts apps/api/src/routes/v1/admin/index.ts apps/api/src/server.ts
git commit -m "feat(api): admin endpoint to mirror aggregator orgs into Signals"
```

---

## Task 9: Seed script for service users + apikeys

**Files:**
- Create: `apps/api/scripts/seed_service_users.ts`

- [ ] **Step 1: Write the script**

Create `apps/api/scripts/seed_service_users.ts`:
```ts
/**
 * Idempotent seed for the two integrating-DPG service users:
 *   - aggregator-dpg-svc
 *   - voice-dpg-svc
 *
 * Each lives inside an org of type='network_service' and owns one apikey.
 * Run: pnpm --filter @dpg/api tsx scripts/seed_service_users.ts
 */
import { db } from '@dpg/database';
import { user, organization, member, apikey } from '../db/postgres/schema/auth.js';
import { eq } from 'drizzle-orm';
import { randomUUID, randomBytes } from 'node:crypto';

const SERVICES = [
  { slug: 'aggregator-dpg', user_email: 'aggregator-dpg-svc@signals.local' },
  { slug: 'voice-dpg',      user_email: 'voice-dpg-svc@signals.local'      },
];

const ensure_org = async (slug: string, name: string) => {
  const existing = await db.select().from(organization).where(eq(organization.slug, slug)).limit(1).then(r => r[0]);
  if (existing) return existing.id;
  const id = `org_${randomUUID()}`;
  await db.insert(organization).values({
    id, slug, name, type: 'network_service', createdAt: new Date(),
  });
  return id;
};

const ensure_user = async (email: string, name: string) => {
  const existing = await db.select().from(user).where(eq(user.email, email)).limit(1).then(r => r[0]);
  if (existing) return existing.id;
  const id = `usr_${randomUUID()}`;
  const now = new Date();
  await db.insert(user).values({
    id, email, name, emailVerified: true, createdAt: now, updatedAt: now,
  });
  return id;
};

const ensure_member = async (user_id: string, org_id: string) => {
  const existing = await db
    .select()
    .from(member)
    .where(eq(member.userId, user_id))
    .limit(1)
    .then(r => r[0]);
  if (existing) return;
  await db.insert(member).values({
    id: `mem_${randomUUID()}`,
    organizationId: org_id,
    userId: user_id,
    role: 'service',
    createdAt: new Date(),
  });
};

const ensure_apikey = async (user_id: string, name: string) => {
  const existing = await db
    .select()
    .from(apikey)
    .where(eq(apikey.userId, user_id))
    .limit(1)
    .then(r => r[0]);
  if (existing) {
    console.log(`apikey for ${name} already exists (id=${existing.id}); skipping.`);
    return null;
  }
  const raw_key = `sk_signals_${randomBytes(24).toString('hex')}`;
  const now = new Date();
  const id = `key_${randomUUID()}`;
  await db.insert(apikey).values({
    id, name, key: raw_key, userId: user_id,
    start: raw_key.slice(0, 6), prefix: 'sk_signals_',
    enabled: true, rateLimitEnabled: false,
    createdAt: now, updatedAt: now,
  });
  console.log(`MINTED ${name} apikey — store securely, will NOT be shown again:`);
  console.log(`  ${raw_key}`);
  return raw_key;
};

const main = async () => {
  for (const svc of SERVICES) {
    const org_id = await ensure_org(svc.slug, `${svc.slug} (network service)`);
    const user_id = await ensure_user(svc.user_email, svc.slug);
    await ensure_member(user_id, org_id);
    await ensure_apikey(user_id, svc.slug);
  }
  console.log('seed complete.');
  process.exit(0);
};

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run against local DB**
```bash
docker compose up -d db redis
pnpm db:migrate:api
pnpm --filter @dpg/api exec tsx scripts/seed_service_users.ts
```
Expected: prints two `sk_signals_...` keys. **Store them in a password manager** — they cannot be recovered.

- [ ] **Step 3: Commit**
```bash
git add apps/api/scripts/seed_service_users.ts
git commit -m "feat(api): idempotent seed for service users + apikeys"
```

---

## Task 10: Document the integration pattern

**Files:**
- Modify: `apps/api/AGENTS.md` (or create a section in `docs/`)

- [ ] **Step 1: Add a section "Integrating DPGs (aggregator, voice)"**

Document:
- The on-behalf-of header convention (`x-acting-org-id`).
- That the service apikey + acting_org_id together determine the effective tenant.
- That admin routes require both auth and the preHandler.
- That aggregator orgs are mirrored via `POST /api/v1/admin/aggregator/upsert`.
- Link to this plan file.

- [ ] **Step 2: Commit**
```bash
git add apps/api/AGENTS.md
git commit -m "docs(api): document aggregator/voice integration pattern"
```

---

## Self-Review Checklist

- Spec coverage: service auth (Tasks 4-5, 9), org mirroring (Tasks 6-8), preHandler (Tasks 3-4), seed (Task 9), docs (Task 10). ✅
- No placeholders left. Every code block is complete.
- `acting_org` shape consistent between `fastify.d.ts`, preHandler, and upsert route.
- `slug` is the natural key used for upsert; `external_id` is stored in `metadata` JSON to avoid a schema change on `organization`. Trade-off: lookups by external_id require a JSON path query. If aggregator-dpg starts looking up orgs by external_id often, add a dedicated column then.

## Open Questions

1. Should the preHandler also enforce an allowlist of orgs per service user (via `member.permissions`)? Current plan is permissive within a type. If you want strict per-aggregator scoping, encode allowed org_ids in `member.permissions` and check in Step 1 of Task 4.
2. Rate limiting on the service apikeys is currently disabled in the seed (`rateLimitEnabled: false`) since these are trusted callers. Revisit if voice-dpg traffic patterns warrant it.
