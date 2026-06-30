# Decrypted Profile Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a signals admin endpoint that returns decrypted participant profile data (by `item_ids` or `user_id`, scoped to the calling org), and an aggregator "Export profile data" bulk action that downloads the selected dashboard rows' decrypted profiles as CSV.

**Architecture:** Signals gains `POST /api/v1/admin/participant/decrypt` (two-header auth, scoped by `item_metrics.onboarded_by_org_id` / `user.onboarded_by_org_id`, decrypts via the existing `decryptItemPrivate`). The aggregator adds a `signalstack-writer.fetchDecryptedProfiles` method (server-to-server, admin key never reaches the browser), a `POST /v1/dashboard/export/profiles` API route that builds the CSV, a web BFF relay, and a `export_profile_data` bulk action.

**Tech Stack:** Signals — Fastify + Zod (`fastify-type-provider-zod`) + Drizzle. Aggregator — Fastify (API), Next.js App Router (web BFF), `signalstack-writer` package (abstract base + http + memory + testing). Vitest both sides.

**Spec:** `Signals-DPG/docs/superpowers/specs/2026-06-26-decrypted-profile-export-design.md`

**This plan spans two repos:**
- Tasks A1–A3 → `/Users/srivastha/KKB/Github/Signals-DPG` (branch `feat/profile-export-decrypted`)
- Tasks B1–B6 → `/Users/srivastha/KKB/Github/aggregator-dpg` (branch `feat/profile-export-decrypted`)

Implement Part A first (the aggregator's HTTP impl targets the endpoint shape A defines), but B1–B3 (writer package) can proceed in parallel since they only depend on the documented request/response contract.

## Global Constraints

**Signals (Signals-DPG):**
- Routes **never throw** — return `reply.code(N).send({ error, message })` with a machine-readable `error` code.
- Files are **snake_case**; route handler exports snake_case; Zod schemas **PascalCase**; DB columns snake_case.
- **ESM only**, strict TS, **no `any`**. Use `import type` for type-only imports.
- All `/api/v1/admin/*` calls require `x-api-key` + `x-acting-org-id` (provided by `auth_middleware` + `acting_org_preHandler`; the handler reads `request.acting_org`, never the raw header).
- New env vars go in `packages/config/src/secrets.ts` AND `turbo.json` `globalPassThroughEnv` (none needed here — `SIGNALS_PII_KEY` already exists).

**Aggregator (aggregator-dpg):**
- Every cross-package contract is an `abstract class` (NOT a TS `interface`). Subclasses preserve exact signatures.
- Service methods return `Result<T, BaseError>` — **never throw** across a service boundary. Use `ok`/`err` from `@aggregator-dpg/shared-primitives/result`, errors from `@aggregator-dpg/shared-primitives/errors`.
- `src/interface.ts` may import only `@aggregator-dpg/shared-primitives`, `zod`, `node:*` (dep-cruiser `no-heavy-deps-in-interface`).
- Cross-package imports go through `./interface` or `./testing` subpaths only.
- Testing fakes **extend the in-memory impl** (not the abstract base); provide `seed()` + `build<Entity>()`. Tests in `src/__tests__/`, named `<module>.test.ts`. Target **≥70% line coverage**.
- Structured logging via the route's `req.log` child with `operation`/`status`/`latency_ms`; **never log PII** (no `item_state` values, names, phones) in the aggregator.
- Conventional Commits; **do not** bypass hooks with `--no-verify`.

**Security (both):**
- The signals admin key (`SIGNALSTACK_ADMIN_KEY` on the aggregator / the api-key signals validates) **never reaches the browser** — the decrypt call is aggregator-API → signals only.
- Decrypted PII is returned only for the acting aggregator's **onboarded** items; `network_service` may read all. Unknown / not-owned ids land in `skipped` with no found-vs-forbidden distinction.
- `item_private_state` is never serialized in any response.

---

# Part A — Signals-DPG

Repo root for all Part A paths: `/Users/srivastha/KKB/Github/Signals-DPG`

## File Structure (Part A)

- Create `packages/schemas/src/admin/participant_decrypt.ts` — request/response Zod schemas + inferred types.
- Modify `packages/schemas/src/index.ts` — re-export the new schema module.
- Create `apps/api/src/routes/v1/admin/participant_decrypt.ts` — route + handler.
- Modify `apps/api/src/routes/v1/admin/admin_routes.ts` — register the route.
- Create `apps/api/src/routes/v1/admin/__tests__/participant_decrypt.test.ts` — unit tests (validation + gating, no DB).
- Create `apps/api/src/routes/v1/admin/__tests__/participant_decrypt.integration.test.ts` — real-Postgres scoping + decryption.

---

### Task A1: Decrypt request/response schemas

**Files:**
- Create: `packages/schemas/src/admin/participant_decrypt.ts`
- Modify: `packages/schemas/src/index.ts` (add export after line 10, `export * from './admin/participant';`)
- Test: `packages/schemas/src/admin/__tests__/participant_decrypt.test.ts`

**Interfaces:**
- Produces: `DecryptParticipantRequest` (Zod + type — exactly one of `item_ids: string[]` / `user_id: string`), `DecryptedProfileSnapshot` (Zod + type), `DecryptParticipantResponse` (Zod + type — `{ profiles: DecryptedProfileSnapshot[]; skipped: string[] }`).

- [ ] **Step 1: Write the failing test**

Create `packages/schemas/src/admin/__tests__/participant_decrypt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  DecryptParticipantRequest,
  DecryptParticipantResponse,
} from '../participant_decrypt';

describe('DecryptParticipantRequest', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('accepts item_ids only', () => {
    const r = DecryptParticipantRequest.safeParse({ item_ids: [uuid] });
    expect(r.success).toBe(true);
  });

  it('accepts user_id only', () => {
    const r = DecryptParticipantRequest.safeParse({ user_id: 'usr_1' });
    expect(r.success).toBe(true);
  });

  it('rejects both item_ids and user_id', () => {
    const r = DecryptParticipantRequest.safeParse({ item_ids: [uuid], user_id: 'usr_1' });
    expect(r.success).toBe(false);
  });

  it('rejects neither', () => {
    const r = DecryptParticipantRequest.safeParse({});
    expect(r.success).toBe(false);
  });

  it('rejects empty item_ids array', () => {
    const r = DecryptParticipantRequest.safeParse({ item_ids: [] });
    expect(r.success).toBe(false);
  });

  it('rejects non-uuid item_ids', () => {
    const r = DecryptParticipantRequest.safeParse({ item_ids: ['not-a-uuid'] });
    expect(r.success).toBe(false);
  });

  it('response schema accepts a profiles + skipped payload', () => {
    const r = DecryptParticipantResponse.safeParse({
      profiles: [
        {
          item_id: uuid,
          item_network: 'blue_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          item_state: { name: 'Velu Murugan' },
          created_at: '2026-06-26T12:03:04.686Z',
          updated_at: '2026-06-26T12:03:04.686Z',
        },
      ],
      skipped: ['22222222-2222-4222-8222-222222222222'],
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dpg/schemas exec vitest run src/admin/__tests__/participant_decrypt.test.ts`
Expected: FAIL — cannot resolve `../participant_decrypt`.

- [ ] **Step 3: Write the schema module**

Create `packages/schemas/src/admin/participant_decrypt.ts`:

```typescript
import z from 'zod';

/**
 * Body for POST /api/v1/admin/participant/decrypt.
 *
 * Returns DECRYPTED profile item_state for participants the calling org is
 * entitled to (an aggregator sees only items it onboarded; network_service
 * sees all). Exactly one selector is required:
 *  - `item_ids` — 1..N item uuids (used by the aggregator profile export).
 *  - `user_id` — a single signals user id (all of that user's items).
 *
 * Both modes are implemented now; the aggregator UI uses item_ids first.
 */
export const DecryptParticipantRequest = z
  .object({
    item_ids: z.array(z.uuid()).min(1).optional(),
    user_id: z.string().min(1).optional(),
  })
  .refine(
    (b) => (b.item_ids ? 1 : 0) + (b.user_id ? 1 : 0) === 1,
    { message: 'exactly one of item_ids or user_id is required' },
  );

/**
 * One decrypted profile. `item_state` is the full cleartext merge of the
 * public item_state and the decrypted private fields. `item_private_state`
 * is never included.
 */
export const DecryptedProfileSnapshot = z.object({
  item_id: z.uuid(),
  item_network: z.string(),
  item_domain: z.string(),
  item_type: z.string(),
  item_state: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

/**
 * Response for the decrypt endpoint. Invariant for item_ids mode:
 * profiles.length + skipped.length === count of distinct requested item_ids.
 */
export const DecryptParticipantResponse = z.object({
  profiles: z.array(DecryptedProfileSnapshot),
  skipped: z.array(z.string()),
});

export type DecryptParticipantRequest = z.infer<typeof DecryptParticipantRequest>;
export type DecryptedProfileSnapshot = z.infer<typeof DecryptedProfileSnapshot>;
export type DecryptParticipantResponse = z.infer<typeof DecryptParticipantResponse>;
```

- [ ] **Step 4: Add the export**

In `packages/schemas/src/index.ts`, add a line directly after the existing `export * from './admin/participant';` (line 10):

```typescript
export * from './admin/participant_decrypt';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @dpg/schemas exec vitest run src/admin/__tests__/participant_decrypt.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @dpg/schemas exec tsc --noEmit` (or `pnpm typecheck` from repo root)
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/schemas/src/admin/participant_decrypt.ts packages/schemas/src/index.ts packages/schemas/src/admin/__tests__/participant_decrypt.test.ts
git commit -m "feat(schemas): add participant decrypt request/response schemas"
```

---

### Task A2: Decrypt route + handler (with unit tests)

**Files:**
- Create: `apps/api/src/routes/v1/admin/participant_decrypt.ts`
- Modify: `apps/api/src/routes/v1/admin/admin_routes.ts` (add import + `await app.register(participant_decrypt);`)
- Test: `apps/api/src/routes/v1/admin/__tests__/participant_decrypt.test.ts`

**Interfaces:**
- Consumes: `DecryptParticipantRequest`, `DecryptParticipantResponse` (Task A1); `decryptItemPrivate` from `@/utils/item_decrypt`; `apiConfig` from `@/config`; `items` from `@dpg/database`; `item_metrics` from `../../../../db/postgres/schema/metrics.js`; `user` from `../../../../db/postgres/schema/auth.js`; `db` from `@api/db/postgres/drizzle_config`.
- Produces: `export const participant_decrypt: FastifyPluginAsync`.

**Background (verbatim patterns to mirror):**
- `participant_read.ts:137-141` defines `servedNetworks()` — copy it.
- `participant_read.ts:143-178` (`readItemsForUser`) shows the decrypt+project pattern.
- `aggregator/export.ts:88-91` shows `eq(item_metrics.onboardedByOrgId, aggregator_id)` scoping.
- Drizzle's `and(...)` ignores `undefined` arguments, so conditional clauses can be passed as `cond ? expr : undefined`.

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/routes/v1/admin/__tests__/participant_decrypt.test.ts` (mirrors `participant_read.test.ts` harness — mocked config + mocked db; asserts validation + acting-org gating without a real DB):

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Unit tests for POST /api/v1/admin/participant/decrypt.
 * Mounts the route in isolation with mocked config + db and a stubbed
 * request.acting_org. Verifies request validation and the acting-org
 * gating matrix without touching a database.
 */

vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    served_domains: [{ network: 'blue_dot', domain: 'seeker' }],
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    schema_registry_url: '',
  },
  authConfig: { secret: 'test-secret', middleware_enabled: false, url: '', create_test_otp: false },
  databasesConfig: { pg_url: 'postgres://localhost/test' },
  getCurrentApiBaseUrl: () => 'http://source.local',
  instance: { INSTANCE_NAME: 'test', INSTANCE_ENV: 'development' },
  api: { API_DOMAIN: 'http://source.local', API_PORT: 3000 },
  auth: {}, databases: {}, matchScore: {}, notification: {},
  networkRuntime: {}, schemaRegistry: {},
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

// item_decrypt is exercised by the integration test; stub it here so the unit
// suite never needs the PII key.
vi.mock('@/utils/item_decrypt', () => ({
  decryptItemPrivate: (row: { item_state: Record<string, unknown> }) => ({ mergedState: row.item_state }),
}));

const uuid = '11111111-1111-4111-8111-111111111111';

async function buildApp(orgType: 'aggregator' | 'network_service' | 'voice' | null) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  if (orgType) {
    app.addHook('preHandler', async (request) => {
      request.acting_org = { org_id: 'org_test', org_type: orgType, service_user_id: 'usr_test' };
    });
  }
  const { participant_decrypt } = await import('../participant_decrypt');
  await app.register(participant_decrypt);
  return app;
}

describe('POST /api/v1/admin/participant/decrypt (unit)', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp('network_service'); });

  it('rejects a body with neither item_ids nor user_id (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/participant/decrypt', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a body with both item_ids and user_id (400)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/participant/decrypt',
      payload: { item_ids: [uuid], user_id: 'usr_1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty item_ids array (400)', async () => {
    const res = await app.inject({ method: 'POST', url: '/participant/decrypt', payload: { item_ids: [] } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing acting_org (403 INVALID_ACTING_ORG)', async () => {
    const app2 = await buildApp(null);
    const res = await app2.inject({ method: 'POST', url: '/participant/decrypt', payload: { item_ids: [uuid] } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('INVALID_ACTING_ORG');
  });

  it('rejects a voice acting org (403 ACTING_ORG_TYPE_NOT_ALLOWED)', async () => {
    const app2 = await buildApp('voice');
    const res = await app2.inject({ method: 'POST', url: '/participant/decrypt', payload: { item_ids: [uuid] } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ACTING_ORG_TYPE_NOT_ALLOWED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/participant_decrypt.test.ts`
Expected: FAIL — cannot resolve `../participant_decrypt`.

- [ ] **Step 3: Write the handler**

Create `apps/api/src/routes/v1/admin/participant_decrypt.ts`:

```typescript
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { item_metrics } from '../../../../db/postgres/schema/metrics.js';
import { user } from '../../../../db/postgres/schema/auth.js';
import {
  DecryptParticipantRequest as DecryptParticipantRequestSchema,
  DecryptParticipantResponse,
  type DecryptParticipantRequest as DecryptParticipantRequestType,
  type DecryptedProfileSnapshot,
} from '@dpg/schemas';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { apiConfig } from '@/config';

/**
 * POST /api/v1/admin/participant/decrypt
 *
 * Returns DECRYPTED profile item_state for a set of item_ids (now) or a
 * user_id (future UI). Scoping:
 *  - aggregator: only items it onboarded survive (item_ids mode scopes on
 *    item_metrics.onboarded_by_org_id; user_id mode on user.onboarded_by_org_id).
 *  - network_service: all items.
 * Requested ids that are not found / not in a served network / not owned land
 * in `skipped` with no distinction (no existence leak).
 */

type DecryptRequestType = FastifyRequest<{ Body: DecryptParticipantRequestType }>;

export const participant_decrypt: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/participant/decrypt',
    method: 'POST',
    schema: {
      tags: ['admin'],
      body: DecryptParticipantRequestSchema,
      response: { 200: DecryptParticipantResponse },
    },
    handler: participant_decrypt_handler,
  });
};

const servedNetworks = (): string[] => {
  const set = new Set<string>();
  for (const d of apiConfig.served_domains) set.add(d.network);
  return Array.from(set);
};

type DecryptableRow = {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: unknown;
  item_private_state: string;
  created_at: Date;
  updated_at: Date;
};

const toSnapshot = (r: DecryptableRow): DecryptedProfileSnapshot => {
  const { mergedState } = decryptItemPrivate({
    item_state: r.item_state as Record<string, unknown>,
    item_private_state: r.item_private_state,
  });
  return {
    item_id: r.item_id,
    item_network: r.item_network,
    item_domain: r.item_domain,
    item_type: r.item_type,
    item_state: mergedState,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
};

export const participant_decrypt_handler = async (
  request: DecryptRequestType,
  reply: FastifyReply,
) => {
  if (!request.acting_org) {
    return reply.code(403).send({
      error: 'INVALID_ACTING_ORG',
      message: 'acting_org is required for /admin/participant/decrypt',
    });
  }
  const acting = request.acting_org;
  if (acting.org_type !== 'aggregator' && acting.org_type !== 'network_service') {
    return reply.code(403).send({
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      message: 'only aggregator or network_service acting orgs are allowed',
    });
  }

  const isAgg = acting.org_type === 'aggregator';
  const networks = servedNetworks();
  const body = request.body;

  let profiles: DecryptedProfileSnapshot[] = [];
  let skipped: string[] = [];
  let mode: 'item_ids' | 'user_id';

  if (body.item_ids) {
    mode = 'item_ids';
    const requested = Array.from(new Set(body.item_ids));
    const rows = (await db
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
      .innerJoin(item_metrics, eq(item_metrics.itemId, items.item_id))
      .where(
        and(
          inArray(items.item_id, requested),
          networks.length > 0 ? inArray(items.item_network, networks) : undefined,
          isAgg ? eq(item_metrics.onboardedByOrgId, acting.org_id) : undefined,
        ),
      )) as DecryptableRow[];

    profiles = rows.map(toSnapshot);
    const found = new Set(profiles.map((p) => p.item_id));
    skipped = requested.filter((id) => !found.has(id));
  } else {
    mode = 'user_id';
    const userId = body.user_id!;
    const existingRows = await db
      .select({ id: user.id, onboardedByOrgId: user.onboardedByOrgId })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const existing = existingRows[0] ?? null;

    const entitled = existing !== null && (!isAgg || existing.onboardedByOrgId === acting.org_id);
    if (entitled) {
      const rows = (await db
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
            ? and(eq(items.created_by, existing.id), inArray(items.item_network, networks))
            : eq(items.created_by, existing.id),
        )
        .orderBy(items.created_at)) as DecryptableRow[];
      profiles = rows.map(toSnapshot);
    }
    skipped = [];
  }

  // Audit: one structured entry per call — this exposes raw PII.
  request.log.info({
    operation: 'admin.participant.decrypt',
    acting_org_id: acting.org_id,
    org_type: acting.org_type,
    mode,
    requested_count: body.item_ids ? new Set(body.item_ids).size : 1,
    returned_count: profiles.length,
    skipped_count: skipped.length,
  });

  return reply.code(200).send({ profiles, skipped });
};

export default participant_decrypt;
```

- [ ] **Step 4: Register the route**

In `apps/api/src/routes/v1/admin/admin_routes.ts`, add the import after line 6 (`import { participant_read } from './participant_read.js';`):

```typescript
import { participant_decrypt } from './participant_decrypt.js';
```

and add the registration after line 22 (`await app.register(participant_read);`):

```typescript
  await app.register(participant_decrypt);
```

- [ ] **Step 5: Run unit tests to verify they pass**

Run: `pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/participant_decrypt.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/v1/admin/participant_decrypt.ts apps/api/src/routes/v1/admin/admin_routes.ts apps/api/src/routes/v1/admin/__tests__/participant_decrypt.test.ts
git commit -m "feat(api): add admin participant decrypt endpoint"
```

---

### Task A3: Decrypt endpoint integration test (real Postgres)

**Files:**
- Test: `apps/api/src/routes/v1/admin/__tests__/participant_decrypt.integration.test.ts`

**Interfaces:**
- Consumes: the running route from A2; `encryptPiiBlob` + `getPiiKey` from `@dpg/auth`; `item_metrics` from `../../../../db/postgres/schema/metrics.js`; the `resolveBindings` / `generateMinimalItemState` helpers from `../../__tests__/integration_helpers`; the org/user/member/apikey seeding pattern from `participant_read.integration.test.ts`.

**Background:**
- The onboard path does **not** populate `item_metrics` — the test inserts those rows directly.
- Decryption seeding: set `item_state` to the masked public view and `item_private_state = encryptPiiBlob(JSON.stringify(privateFields), getPiiKey())`. The endpoint merges them back to cleartext.
- `getPiiKey()` reads `SIGNALS_PII_KEY`; the integration run must have it set (it is required by `packages/config/src/secrets.ts`). The suite skips when Postgres env is unset, matching `participant_read.integration.test.ts:31-37`.

- [ ] **Step 1: Write the integration test**

Create `apps/api/src/routes/v1/admin/__tests__/participant_decrypt.integration.test.ts`:

```typescript
/**
 * Integration test for POST /api/v1/admin/participant/decrypt against a real
 * Postgres. Seeds two aggregator orgs + one network_service org, an onboarded
 * user with one item carrying masked public state + an encrypted private blob,
 * and an item_metrics row attributing the item to aggregator A. Verifies:
 *   1. aggregator A decrypts its own item (cleartext private fields)
 *   2. aggregator B gets the same item in `skipped` (not owned)
 *   3. network_service decrypts any item
 *   4. unknown item_id → skipped; invariant profiles+skipped == requested
 *   5. user_id mode returns A's items for A, empty for B
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { eq, inArray } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { encryptPiiBlob, getPiiKey } from '@dpg/auth';
import { resolveBindings, generateMinimalItemState, type ResolvedBinding } from '../../__tests__/integration_helpers';

const pg_url = process.env.POSTGRES_URL ?? process.env.POSTGRES_USER;
const can_run = Boolean(pg_url);
const describeIf = can_run ? describe : describe.skip;
const hash_key = (raw: string) => createHash('sha256').update(raw).digest('base64url');

describeIf('POST /api/v1/admin/participant/decrypt (integration)', () => {
  let app: FastifyInstance;
  let db: typeof import('@api/db/postgres/drizzle_config').db;
  let authSchema: typeof import('../../../../../db/postgres/schema/auth.js');
  let metricsSchema: typeof import('../../../../../db/postgres/schema/metrics.js');
  let itemsTable: typeof import('@dpg/database').items;

  const listen_port = Number(process.env.API_PORT ?? 2742);
  const ts = Date.now();
  const svc_user_id = `usr_${randomUUID()}`;
  const svc_user_email = `decrypt-int-${ts}@signals.local`;

  const mk = (label: string) => ({
    org_id: `org_${randomUUID()}`,
    apikey_id: `key_${randomUUID()}`,
    member_id: `mem_${randomUUID()}`,
    raw_key: `sk_signals_${randomBytes(24).toString('hex')}`,
    slug: `decrypt-int-${label}-${ts}`,
  });
  const agg_a = mk('a');
  const agg_b = mk('b');
  const ns = mk('ns');

  let primary: ResolvedBinding;
  let participant_user_id = '';
  let item_id = '';

  beforeAll(async () => {
    const drizzle_mod = await import('@api/db/postgres/drizzle_config');
    authSchema = await import('../../../../../db/postgres/schema/auth.js');
    metricsSchema = await import('../../../../../db/postgres/schema/metrics.js');
    itemsTable = (await import('@dpg/database')).items;
    db = drizzle_mod.db;

    primary = (await resolveBindings()).primary;

    const { admin_routes } = await import('../admin_routes.js');
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(admin_routes, { prefix: '/api/v1/admin' });
    await app.listen({ port: listen_port, host: '127.0.0.1' });

    const { user, organization, member, apikey } = authSchema;
    const now = new Date();

    await db.insert(user).values({
      id: svc_user_id, email: svc_user_email, name: 'decrypt svc',
      emailVerified: true, createdAt: now, updatedAt: now,
    });
    await db.insert(organization).values([
      { id: agg_a.org_id, slug: agg_a.slug, name: agg_a.slug, type: 'aggregator', createdAt: now },
      { id: agg_b.org_id, slug: agg_b.slug, name: agg_b.slug, type: 'aggregator', createdAt: now },
      { id: ns.org_id, slug: ns.slug, name: ns.slug, type: 'network_service', createdAt: now },
    ]);
    await db.insert(member).values([agg_a, agg_b, ns].map((v) => ({
      id: v.member_id, organizationId: v.org_id, userId: svc_user_id, role: 'service', createdAt: now,
    })));
    for (const v of [agg_a, agg_b, ns]) {
      await db.insert(apikey).values({
        id: v.apikey_id, name: v.slug, key: hash_key(v.raw_key), userId: svc_user_id,
        referenceId: svc_user_id, configId: 'default', start: v.raw_key.slice(0, 6),
        prefix: 'sk_signals_', enabled: true, rateLimitEnabled: false, createdAt: now, updatedAt: now,
      });
    }

    // Onboard a participant via the real POST route (agg A) so the item row is
    // created with every required column. onboard sets user.onboarded_by_org_id
    // to the acting org, but does NOT write item_metrics (inserted below).
    const fixture = generateMinimalItemState(primary.schema);
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/participant',
      headers: { 'x-api-key': agg_a.raw_key, 'x-acting-org-id': agg_a.org_id, 'content-type': 'application/json' },
      payload: {
        email: `participant-${ts}@a.test`,
        name: 'Velu Murugan',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: primary.network,
        domain: primary.domain,
        item_type: primary.item_type,
        item_state: fixture,
      },
    });
    if (onboardRes.statusCode !== 200) {
      throw new Error(`onboard setup failed: ${onboardRes.statusCode} ${onboardRes.body}`);
    }
    const onboardBody = onboardRes.json();
    participant_user_id = onboardBody.user_id;
    item_id = onboardBody.items[0].item_id;

    // Overwrite the item with a known masked public state + encrypted private
    // blob so the decrypt assertions are deterministic regardless of which
    // fields the network schema marks private.
    const privateFields = { name: 'Velu Murugan', phone: '+919876801011' };
    await db
      .update(itemsTable)
      .set({
        item_state: { name: 'V***' },
        item_private_state: encryptPiiBlob(JSON.stringify(privateFields), getPiiKey()),
      })
      .where(eq(itemsTable.item_id, item_id));

    // item_metrics row attributing the item to aggregator A (onboard does not write this).
    await db.insert(metricsSchema.item_metrics).values({
      itemId: item_id,
      itemNetwork: primary.network,
      itemDomain: primary.domain,
      itemType: primary.item_type,
      ownerUserId: participant_user_id,
      onboardedByOrgId: agg_a.org_id,
      displayName: 'V***',
      lastComputedAt: now,
    });
  });

  afterAll(async () => {
    const { user, organization, apikey } = authSchema;
    try {
      await db.delete(metricsSchema.item_metrics).where(eq(metricsSchema.item_metrics.itemId, item_id));
      await db.delete(itemsTable).where(eq(itemsTable.item_id, item_id));
      await db.delete(user).where(inArray(user.id, [participant_user_id, svc_user_id]));
      await db.delete(apikey).where(inArray(apikey.id, [agg_a.apikey_id, agg_b.apikey_id, ns.apikey_id]));
      await db.delete(organization).where(inArray(organization.id, [agg_a.org_id, agg_b.org_id, ns.org_id]));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('cleanup failed:', err);
    }
    if (app) await app.close();
  });

  const post = (v: typeof agg_a, payload: unknown) =>
    app.inject({
      method: 'POST', url: '/api/v1/admin/participant/decrypt',
      headers: { 'x-api-key': v.raw_key, 'x-acting-org-id': v.org_id, 'content-type': 'application/json' },
      payload: payload as Record<string, unknown>,
    });

  it('aggregator A decrypts its own item (cleartext private fields)', async () => {
    const res = await post(agg_a, { item_ids: [item_id] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].item_id).toBe(item_id);
    expect(body.profiles[0].item_state.name).toBe('Velu Murugan');
    expect(body.profiles[0].item_state.phone).toBe('+919876801011');
    expect(body.skipped).toEqual([]);
  });

  it('aggregator B gets the item in skipped (not owned)', async () => {
    const res = await post(agg_b, { item_ids: [item_id] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles).toEqual([]);
    expect(body.skipped).toEqual([item_id]);
  });

  it('network_service decrypts any item', async () => {
    const res = await post(ns, { item_ids: [item_id] });
    expect(res.statusCode).toBe(200);
    expect(res.json().profiles[0].item_state.name).toBe('Velu Murugan');
  });

  it('unknown id is skipped; profiles + skipped == requested', async () => {
    const ghost = randomUUID();
    const res = await post(agg_a, { item_ids: [item_id, ghost] });
    const body = res.json();
    expect(body.profiles).toHaveLength(1);
    expect(body.skipped).toEqual([ghost]);
    expect(body.profiles.length + body.skipped.length).toBe(2);
  });

  it('user_id mode returns A items for A, empty for B', async () => {
    const a = (await post(agg_a, { user_id: participant_user_id })).json();
    expect(a.profiles).toHaveLength(1);
    expect(a.profiles[0].item_state.name).toBe('Velu Murugan');
    const b = (await post(agg_b, { user_id: participant_user_id })).json();
    expect(b.profiles).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run (DB must be up — `docker compose up -d db redis` and `SIGNALS_PII_KEY` set):
`pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/participant_decrypt.integration.test.ts`
Expected: PASS (5 tests). If Postgres env is unset the suite is skipped (still green) — run it locally against the dev DB before marking done.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/v1/admin/__tests__/participant_decrypt.integration.test.ts
git commit -m "test(api): integration coverage for participant decrypt scoping"
```

---

# Part B — aggregator-dpg

Repo root for all Part B paths: `/Users/srivastha/KKB/Github/aggregator-dpg`

## File Structure (Part B)

- Modify `packages/signalstack-writer/src/interface.ts` — add types + abstract `fetchDecryptedProfiles`.
- Modify `packages/signalstack-writer/src/http.ts` — HTTP impl.
- Modify `packages/signalstack-writer/src/memory.ts` — in-memory impl.
- Modify `packages/signalstack-writer/src/testing.ts` — fake passthrough (extends memory; add a `build` helper).
- Modify `packages/signalstack-writer/src/__tests__/http.test.ts` and `memory.test.ts`.
- Create `apps/api/src/services/profile-csv.ts` — server-side CSV builder.
- Modify `apps/api/src/routes/dashboard.ts` — `POST /v1/dashboard/export/profiles`.
- Modify `apps/api/src/routes/dashboard.test.ts` — route test.
- Create `apps/web/src/app/api/dashboard/export/profiles/route.ts` — BFF relay.
- Modify `apps/web/src/services/dashboard.service.ts` — `dashboardExportProfiles`.
- Modify `apps/web/src/services/bulk-actions.ts` — `export_profile_data` action.
- Modify the i18n messages file — `bulk.exportProfileData` key.

---

### Task B1: signalstack-writer interface — types + abstract method

**Files:**
- Modify: `packages/signalstack-writer/src/interface.ts`

**Interfaces:**
- Produces: `SignalStackFetchDecryptedProfilesQuery` (`{ actingOrgId: string; itemIds: string[] }`), `SignalStackDecryptedProfileRow` (`{ item_id, item_network, item_domain, item_type, item_state, created_at, updated_at }`), `SignalStackDecryptedProfiles` (`{ profiles: SignalStackDecryptedProfileRow[]; skipped: string[] }`), and `abstract fetchDecryptedProfiles(query): Promise<Result<SignalStackDecryptedProfiles, BaseError>>`.

- [ ] **Step 1: Add the type definitions**

In `packages/signalstack-writer/src/interface.ts`, immediately after the `SignalStackDashboardExport` interface (ends at line 334), add:

```typescript
/**
 * Input for a decrypted-profile fetch against signalstack's
 * `POST /api/v1/admin/participant/decrypt`. `actingOrgId` is the aggregator's
 * own signalstack org id, sent as the per-call `x-acting-org-id` header so
 * signalstack scopes decryption to items this aggregator onboarded.
 */
export interface SignalStackFetchDecryptedProfilesQuery {
  actingOrgId: string;
  itemIds: string[];
}

/**
 * One decrypted profile row. `item_state` is the full cleartext profile
 * (private fields decrypted). signalstack never returns item_private_state.
 */
export interface SignalStackDecryptedProfileRow {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Result of a decrypted-profile fetch. `skipped` holds requested item_ids
 * that were not returned (not found, or not onboarded by the acting org).
 * Invariant: profiles.length + skipped.length === distinct requested ids.
 */
export interface SignalStackDecryptedProfiles {
  profiles: SignalStackDecryptedProfileRow[];
  skipped: string[];
}
```

- [ ] **Step 2: Add the abstract method**

In the same file, inside the `SignalStackWriterBase` abstract class, immediately after the `exportDashboardCsv` abstract declaration (ends at line 485), add:

```typescript
  /**
   * Fetch DECRYPTED profile data for the given item_ids from signalstack.
   * Server-to-server only — the admin api-key never reaches a browser.
   *
   * @param query - actingOrgId (the aggregator's signalstack org) + itemIds.
   * @returns ok(SignalStackDecryptedProfiles) on 2xx; err(BaseError) on
   *          validation/transport/upstream failure.
   */
  abstract fetchDecryptedProfiles(
    query: SignalStackFetchDecryptedProfilesQuery,
  ): Promise<Result<SignalStackDecryptedProfiles, BaseError>>;
```

- [ ] **Step 3: Typecheck (expect failures in impls — they don't implement the new abstract method yet)**

Run: `pnpm --filter @aggregator-dpg/signalstack-writer exec tsc --noEmit`
Expected: FAIL — `HttpSignalStackWriter` and `InMemorySignalStackWriter` do not implement `fetchDecryptedProfiles`. This is expected; B2 and B3 resolve it. (Do not commit until B3 typechecks clean.)

> Note: B1, B2, B3 form one compile unit (adding an abstract method breaks the impls until implemented). Implement B1→B2→B3 before committing, then commit them together in B3's commit step. Steps below keep separate test runs, but a single commit at the end of B3.

---

### Task B2: signalstack-writer HTTP impl

**Files:**
- Modify: `packages/signalstack-writer/src/http.ts`
- Test: `packages/signalstack-writer/src/__tests__/http.test.ts`

**Interfaces:**
- Consumes: `SignalStackFetchDecryptedProfilesQuery`, `SignalStackDecryptedProfiles` (B1); `this.baseUrl`, `this.headers`, `this.requestWithRetry`, `this.codeForStatus`, `this.timeoutMs`, the module helpers `safeReadText` + `extractUpstreamMessage` (existing in http.ts, used by `exportDashboardCsv`).
- Produces: `override async fetchDecryptedProfiles(...)`.

- [ ] **Step 1: Write the failing HTTP test**

In `packages/signalstack-writer/src/__tests__/http.test.ts`, add a new `describe` block (mirror the existing `HttpSignalStackWriter.onboard` block's setup at lines 136-174). Append:

```typescript
describe('HttpSignalStackWriter.fetchDecryptedProfiles', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let writer: HttpSignalStackWriter;

  beforeEach(() => {
    fetchMock = vi.fn();
    writer = new HttpSignalStackWriter({
      baseUrl: 'http://signalstack.test',
      apiKey: 'test-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxRetries: 0,
    });
  });

  it('posts item_ids with the acting-org header and returns profiles + skipped', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        profiles: [
          {
            item_id: 'item-1',
            item_network: 'blue_dot',
            item_domain: 'seeker',
            item_type: 'profile_1.0',
            item_state: { name: 'Velu Murugan', phone: '+91987' },
            created_at: '2026-06-26T12:03:04.686Z',
            updated_at: '2026-06-26T12:03:04.686Z',
          },
        ],
        skipped: ['item-2'],
      }),
    );

    const result = await writer.fetchDecryptedProfiles({
      actingOrgId: 'org-abc',
      itemIds: ['item-1', 'item-2'],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.profiles).toHaveLength(1);
    expect(result.value.profiles[0].item_state.name).toBe('Velu Murugan');
    expect(result.value.skipped).toEqual(['item-2']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://signalstack.test/api/v1/admin/participant/decrypt');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-acting-org-id']).toBe('org-abc');
    expect(headers['x-api-key']).toBe('test-key');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ item_ids: ['item-1', 'item-2'] });
  });

  it('returns ValidationError when actingOrgId is missing', async () => {
    const result = await writer.fetchDecryptedProfiles({ actingOrgId: '', itemIds: ['item-1'] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ValidationError when itemIds is empty', async () => {
    const result = await writer.fetchDecryptedProfiles({ actingOrgId: 'org-abc', itemIds: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SIGNALSTACK_INPUT_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a non-2xx response to UpstreamError', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'BOOM', message: 'nope' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await writer.fetchDecryptedProfiles({ actingOrgId: 'org-abc', itemIds: ['item-1'] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.name).toBe('UpstreamError');
  });
});
```

> Check that `okJsonResponse`, `vi`, `describe`, `it`, `expect`, `beforeEach`, and `HttpSignalStackWriter` are already imported at the top of the file (they are — used by the existing onboard suite). No new imports needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/signalstack-writer exec vitest run src/__tests__/http.test.ts -t fetchDecryptedProfiles`
Expected: FAIL — `writer.fetchDecryptedProfiles is not a function`.

- [ ] **Step 3: Implement the method**

In `packages/signalstack-writer/src/http.ts`, add this method to `HttpSignalStackWriter` (place it directly after the existing `exportDashboardCsv` method, which ends at line 752). Mirror `exportDashboardCsv`'s error handling exactly:

```typescript
  override async fetchDecryptedProfiles(
    query: SignalStackFetchDecryptedProfilesQuery,
  ): Promise<Result<SignalStackDecryptedProfiles, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new ValidationError('actingOrgId is required for decrypted profile fetch', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }
    if (!Array.isArray(query.itemIds) || query.itemIds.length === 0) {
      return err(
        new ValidationError('itemIds must be a non-empty array', {
          code: 'SIGNALSTACK_INPUT_INVALID',
        }),
      );
    }

    const url = `${this.baseUrl}/api/v1/admin/participant/decrypt`;
    const headers = {
      ...this.headers,
      'x-acting-org-id': query.actingOrgId,
    };

    try {
      const res = await this.requestWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ item_ids: query.itemIds }),
      });

      if (!res.ok) {
        const bodyText = await safeReadText(res);
        const upstreamMsg = extractUpstreamMessage(bodyText);
        const message = upstreamMsg
          ? `signalstack decrypt returned ${res.status}: ${upstreamMsg}`
          : `signalstack decrypt returned ${res.status}`;
        return err(
          new UpstreamError(message, {
            code: this.codeForStatus(res.status),
            details: { status: res.status, body: bodyText },
          }),
        );
      }

      const parsed = (await res.json()) as SignalStackDecryptedProfiles;
      if (!parsed || !Array.isArray(parsed.profiles) || !Array.isArray(parsed.skipped)) {
        return err(
          new UpstreamError('signalstack decrypt returned a malformed body', {
            code: 'SIGNALSTACK_BAD_RESPONSE',
          }),
        );
      }
      return ok({ profiles: parsed.profiles, skipped: parsed.skipped });
    } catch (e) {
      const cause = e as Error;
      const aborted = cause.name === 'AbortError';
      return err(
        new UpstreamError(
          aborted
            ? `signalstack decrypt timed out after ${this.timeoutMs}ms`
            : `signalstack decrypt transport failure: ${cause.message}`,
          {
            cause,
            code: aborted ? 'SIGNALSTACK_TIMEOUT' : 'SIGNALSTACK_TRANSPORT_FAILED',
          },
        ),
      );
    }
  }
```

- [ ] **Step 4: Add the type imports**

In `packages/signalstack-writer/src/http.ts`, add `SignalStackFetchDecryptedProfilesQuery` and `SignalStackDecryptedProfiles` to the existing `import type { ... } from './interface...'` list (the same block that already imports `SignalStackDashboardExportQuery`/`SignalStackDashboardExport`). Confirm `ValidationError`, `UpstreamError`, `ok`, `err` are already imported (they are — used by existing methods).

- [ ] **Step 5: Run HTTP tests**

Run: `pnpm --filter @aggregator-dpg/signalstack-writer exec vitest run src/__tests__/http.test.ts -t fetchDecryptedProfiles`
Expected: PASS (4 tests).

---

### Task B3: signalstack-writer in-memory + fake

**Files:**
- Modify: `packages/signalstack-writer/src/memory.ts`
- Modify: `packages/signalstack-writer/src/testing.ts`
- Test: `packages/signalstack-writer/src/__tests__/memory.test.ts`

**Interfaces:**
- Consumes: the `this.profiles` map of `StoredProfile` (each has `item_state` + `acting_org_id`, populated at onboard), `SignalStackFetchDecryptedProfilesQuery`, `SignalStackDecryptedProfiles` (B1).
- Produces: `override async fetchDecryptedProfiles(...)` on `InMemorySignalStackWriter`.

**Background:** the in-memory store keys profiles by `item_id` (`StoredProfile.item_id`) and records `acting_org_id` at onboard. Scope by `acting_org_id === query.actingOrgId`; everything else → `skipped`. (The in-memory impl has no org-type concept; the aggregator only ever calls as itself, so org-scoped matching is the correct fake behaviour. network_service is exercised by the signals integration test, not here.)

- [ ] **Step 1: Write the failing in-memory test**

In `packages/signalstack-writer/src/__tests__/memory.test.ts`, append:

```typescript
describe('InMemorySignalStackWriter.fetchDecryptedProfiles', () => {
  let writer: InMemorySignalStackWriter;

  beforeEach(() => {
    writer = new InMemorySignalStackWriter();
  });

  it('returns the seeded item_state for its own items, skips the rest', async () => {
    const onboarded = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Velu',
      phoneNumber: '+919876801011',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { name: 'Velu Murugan', phone: '+919876801011' },
    });
    expect(onboarded.success).toBe(true);
    if (!onboarded.success) return;
    const itemId = onboarded.value.profile_item_id;

    const result = await writer.fetchDecryptedProfiles({
      actingOrgId: 'org-1',
      itemIds: [itemId, 'missing-item'],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.profiles).toHaveLength(1);
    expect(result.value.profiles[0].item_id).toBe(itemId);
    expect(result.value.profiles[0].item_state.name).toBe('Velu Murugan');
    expect(result.value.skipped).toEqual(['missing-item']);
  });

  it('skips items owned by a different acting org', async () => {
    const onboarded = await writer.onboard({
      actingOrgId: 'org-1',
      name: 'Velu',
      phoneNumber: '+919876801011',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { name: 'Velu Murugan' },
    });
    if (!onboarded.success) return;
    const itemId = onboarded.value.profile_item_id;

    const result = await writer.fetchDecryptedProfiles({ actingOrgId: 'org-2', itemIds: [itemId] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.profiles).toEqual([]);
    expect(result.value.skipped).toEqual([itemId]);
  });

  it('returns ValidationError on empty itemIds', async () => {
    const result = await writer.fetchDecryptedProfiles({ actingOrgId: 'org-1', itemIds: [] });
    expect(result.success).toBe(false);
  });
});
```

> Confirm `InMemorySignalStackWriter`, `describe`, `it`, `expect`, `beforeEach` are imported at the top (they are — used by the existing onboard suite).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/signalstack-writer exec vitest run src/__tests__/memory.test.ts -t fetchDecryptedProfiles`
Expected: FAIL — `writer.fetchDecryptedProfiles is not a function`.

- [ ] **Step 3: Implement the in-memory method**

In `packages/signalstack-writer/src/memory.ts`, add this method to `InMemorySignalStackWriter` (place it after the existing `exportDashboardCsv` method):

```typescript
  override async fetchDecryptedProfiles(
    query: SignalStackFetchDecryptedProfilesQuery,
  ): Promise<Result<SignalStackDecryptedProfiles, BaseError>> {
    if (!query?.actingOrgId) {
      return err(
        new ValidationError('actingOrgId is required', { code: 'SIGNALSTACK_INPUT_INVALID' }),
      );
    }
    if (!Array.isArray(query.itemIds) || query.itemIds.length === 0) {
      return err(
        new ValidationError('itemIds must be a non-empty array', { code: 'SIGNALSTACK_INPUT_INVALID' }),
      );
    }

    const requested = Array.from(new Set(query.itemIds));
    const profiles: SignalStackDecryptedProfileRow[] = [];
    const skipped: string[] = [];

    for (const id of requested) {
      const stored = this.profiles.get(id);
      if (stored && stored.acting_org_id === query.actingOrgId) {
        profiles.push({
          item_id: stored.item_id,
          item_network: stored.item_network,
          item_domain: stored.item_domain,
          item_type: stored.item_type,
          item_state: stored.item_state,
          created_at: stored.created_at,
          updated_at: stored.updated_at,
        });
      } else {
        skipped.push(id);
      }
    }

    return ok({ profiles, skipped });
  }
```

- [ ] **Step 4: Add type imports to memory.ts**

In `packages/signalstack-writer/src/memory.ts`, add `SignalStackFetchDecryptedProfilesQuery`, `SignalStackDecryptedProfileRow`, `SignalStackDecryptedProfiles` to the existing `import type { ... } from './interface...'` block. Confirm `ValidationError`, `ok`, `err`, `Result`, `BaseError` are already imported (used by existing methods).

- [ ] **Step 5: Add a build helper in testing.ts**

In `packages/signalstack-writer/src/testing.ts`, add an exported builder (the fake itself inherits `fetchDecryptedProfiles` from `InMemorySignalStackWriter`, so no override is needed — but provide a builder for route tests). Append near the other `buildX` helpers:

```typescript
import type { SignalStackDecryptedProfileRow } from './interface.js';

/**
 * Builds a decrypted profile row for tests of consumers that shape CSV/JSON
 * from {@link SignalStackDecryptedProfiles}.
 */
export function buildDecryptedProfileRow(
  overrides: Partial<SignalStackDecryptedProfileRow> = {},
): SignalStackDecryptedProfileRow {
  return {
    item_id: 'item-1',
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: { name: 'Default Name', phone: '+910000000000' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
```

> If `testing.ts` already imports from `./interface.js`, merge `SignalStackDecryptedProfileRow` into that existing import rather than adding a second import line.

- [ ] **Step 6: Run package tests + typecheck**

Run: `pnpm --filter @aggregator-dpg/signalstack-writer test`
Expected: all tests PASS (including B2 + B3 additions).
Run: `pnpm --filter @aggregator-dpg/signalstack-writer exec tsc --noEmit`
Expected: no errors (the abstract method from B1 is now implemented by both impls).

- [ ] **Step 7: dep-check + commit (B1 + B2 + B3 together)**

```bash
pnpm dep-check
git add packages/signalstack-writer/src/interface.ts packages/signalstack-writer/src/http.ts packages/signalstack-writer/src/memory.ts packages/signalstack-writer/src/testing.ts packages/signalstack-writer/src/__tests__/http.test.ts packages/signalstack-writer/src/__tests__/memory.test.ts
git commit -m "feat(signalstack-writer): add fetchDecryptedProfiles"
```

---

### Task B4: Aggregator API route — POST /v1/dashboard/export/profiles + CSV builder

**Files:**
- Create: `apps/api/src/services/profile-csv.ts`
- Modify: `apps/api/src/routes/dashboard.ts`
- Test: `apps/api/src/services/__tests__/profile-csv.test.ts` (create), `apps/api/src/routes/dashboard.test.ts` (extend)

**Interfaces:**
- Consumes: `getSignalStackWriter`, `requireApprovedAuth`, `resolveActingOrgId`, `getNetworkConfig`, `httpError`, `errorResponses` (all already in `dashboard.ts`); `SignalStackDecryptedProfileRow` from `@aggregator-dpg/signalstack-writer/interface`.
- Produces: `buildDecryptedProfilesCsv(rows: SignalStackDecryptedProfileRow[]): string`; the `POST /v1/dashboard/export/profiles` route.

- [ ] **Step 1: Write the failing CSV-builder test**

Create `apps/api/src/services/__tests__/profile-csv.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildDecryptedProfilesCsv } from '../profile-csv.js';
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';

const row = (over: Partial<SignalStackDecryptedProfileRow>): SignalStackDecryptedProfileRow => ({
  item_id: 'i1',
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_state: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('buildDecryptedProfilesCsv', () => {
  it('puts item_id first, then name/phone, then remaining keys sorted', () => {
    const csv = buildDecryptedProfilesCsv([
      row({ item_id: 'i1', item_state: { age: 19, phone: '+91987', name: 'Imran', city: 'Bengaluru' } }),
    ]);
    const [header] = csv.split('\r\n');
    expect(header).toBe('item_id,name,phone,age,city');
  });

  it('unions keys across rows and leaves missing cells empty', () => {
    const csv = buildDecryptedProfilesCsv([
      row({ item_id: 'i1', item_state: { name: 'A', age: 19 } }),
      row({ item_id: 'i2', item_state: { name: 'B', city: 'X' } }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('item_id,name,age,city');
    expect(lines[1]).toBe('i1,A,19,');
    expect(lines[2]).toBe('i2,B,,X');
  });

  it('escapes commas, quotes, and newlines; stringifies objects', () => {
    const csv = buildDecryptedProfilesCsv([
      row({ item_id: 'i1', item_state: { name: 'Last, First', note: 'he said "hi"', meta: { a: 1 } } }),
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('item_id,name,meta,note');
    expect(lines[1]).toBe('i1,"Last, First","{""a"":1}","he said ""hi"""');
  });

  it('returns just the item_id header for an empty input', () => {
    expect(buildDecryptedProfilesCsv([])).toBe('item_id');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/services/__tests__/profile-csv.test.ts`
Expected: FAIL — cannot resolve `../profile-csv.js`.

- [ ] **Step 3: Implement the CSV builder**

Create `apps/api/src/services/profile-csv.ts`:

```typescript
/**
 * Builds a CSV from decrypted signalstack profiles for the aggregator's
 * "Export profile data" action. Belongs to @aggregator-dpg/api.
 *
 * Columns: `item_id` first, then `name` and `phone` (when present), then the
 * remaining union of item_state keys in alphabetical order. Values that are
 * objects/arrays are JSON-stringified; all fields are RFC-4180 escaped.
 */
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';

const PRIORITY_KEYS = ['name', 'phone'] as const;

/**
 * Escapes a single CSV field per RFC 4180 (quote when it contains a comma,
 * quote, CR, or LF; double embedded quotes).
 */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Renders one item_state value to a CSV cell string. Objects/arrays become
 * compact JSON; null/undefined become an empty string.
 */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Builds the CSV body (CRLF line endings) from decrypted profile rows.
 *
 * @param rows - Decrypted profiles returned by signalstack.
 * @returns The CSV text. Header is just `item_id` when `rows` is empty.
 */
export function buildDecryptedProfilesCsv(rows: SignalStackDecryptedProfileRow[]): string {
  const keys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.item_state)) keys.add(k);
  }
  const priority = PRIORITY_KEYS.filter((k) => keys.has(k));
  const rest = [...keys].filter((k) => !PRIORITY_KEYS.includes(k as (typeof PRIORITY_KEYS)[number])).sort();
  const stateCols = [...priority, ...rest];
  const header = ['item_id', ...stateCols];

  const lines = [header.map(csvField).join(',')];
  for (const r of rows) {
    const cells = [csvField(r.item_id), ...stateCols.map((c) => csvField(renderCell(r.item_state[c])))];
    lines.push(cells.join(','));
  }
  return lines.join('\r\n');
}
```

- [ ] **Step 4: Run the CSV-builder test**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/services/__tests__/profile-csv.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the request schema + route to dashboard.ts**

In `apps/api/src/routes/dashboard.ts`, add the import near the existing `import type { SignalStackProfile } from '@aggregator-dpg/signalstack-writer/interface';`:

```typescript
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';
import { buildDecryptedProfilesCsv } from '../services/profile-csv.js';
```

Add a body schema near the other schema definitions in the file (e.g. beside `DashboardExportQuerySchema`):

```typescript
const ExportProfilesBodySchema = z.object({
  item_ids: z.array(z.string().min(1)).min(1),
  domain: z.string().min(1).optional(),
});
```

Inside `registerDashboardRoutes`, after the existing `app.get('/v1/dashboard/export', ...)` registration (ends ~line 456), add:

```typescript
  app.post(
    '/v1/dashboard/export/profiles',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'CSV export of DECRYPTED profile data for selected items',
        description:
          'Returns a CSV (text/csv) of decrypted profile data for the given item_ids, scoped to the caller aggregator. The signalstack admin key never leaves the server.',
        security: [{ bearerAuth: [] }],
        body: ExportProfilesBodySchema,
        response: { ...errorResponses(400, 401, 403, 500, 503) },
      },
    },
    async (req, reply) => {
      const auth = await requireApprovedAuth(req);
      const log = req.log.child({
        operation: 'dashboard.export.profiles',
        aggregator_id: auth.aggregatorId,
      });
      const start = Date.now();

      const { item_ids, domain: requestedDomain } = req.body as z.infer<typeof ExportProfilesBodySchema>;
      const networkCfg = await getNetworkConfig();
      const domain = requestedDomain ?? networkCfg.domainIds[0]!;
      if (!networkCfg.domains[domain]) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `unknown domain '${domain}' — valid: ${networkCfg.domainIds.join(', ')}`,
        });
      }

      const ss = getSignalStackWriter();
      if (!ss) {
        log.warn({ status: 'failure', sub: 'signalstack.disabled' });
        throw httpError('INTERNAL', { detail: 'Signalstack is not configured for this environment.' });
      }

      const actingOrgId = await resolveActingOrgId(auth, log);
      const result = await ss.fetchDecryptedProfiles({ actingOrgId, itemIds: item_ids });
      if (!result.success) {
        log.error({
          status: 'failure',
          sub: 'signalstack.profiles.decrypt',
          error: result.error.message,
          code: result.error.code,
        });
        throw httpError('INTERNAL', {
          detail: `Signalstack profile decrypt failed: ${result.error.code}`,
          cause: result.error,
        });
      }

      const rows: SignalStackDecryptedProfileRow[] = result.value.profiles;
      const csv = buildDecryptedProfilesCsv(rows);
      const filename = `profiles-${domain}-${new Date().toISOString().slice(0, 10)}.csv`;

      // Do NOT log item_state values (PII). Counts only.
      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        domain,
        requested: item_ids.length,
        returned: rows.length,
        skipped: result.value.skipped.length,
        bytes: csv.length,
      });

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`)
        .send(csv);
    },
  );
```

- [ ] **Step 6: Write the failing route test**

In `apps/api/src/routes/dashboard.test.ts`, add a test that mirrors the existing dashboard-route harness (`SignalStackWriterFake`, `AggregatorStoreFake`, JWT setup — reuse the `beforeEach` env + actors already present in the file). Add:

```typescript
describe('POST /v1/dashboard/export/profiles', () => {
  // Reuse the same app/writer/auth setup as the other dashboard route tests
  // in this file (SignalStackWriterFake, approved aggregator JWT, env vars).
  it('returns CSV of decrypted profiles for selected item_ids', async () => {
    // Seed a profile owned by this aggregator's signalstack org, then request it.
    // (Use the file's existing helper to mint an approved bearer token for AGG_A
    //  and the writer fake seeded via onboard so acting_org_id matches.)
    const onboarded = await writer.onboard({
      actingOrgId: 'org_a_signalstack',
      name: 'Velu',
      phoneNumber: '+919876801011',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      source_id: 'link-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      profile: { name: 'Velu Murugan', phone: '+919876801011' },
    });
    if (!onboarded.success) throw new Error('seed failed');
    const itemId = onboarded.value.profile_item_id;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: { authorization: `Bearer ${approvedTokenForAggA}`, 'content-type': 'application/json' },
      payload: { item_ids: [itemId], domain: 'seeker' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename="profiles-seeker-');
    const csv = res.body;
    expect(csv.split('\r\n')[0]).toBe('item_id,name,phone');
    expect(csv).toContain('Velu Murugan');
  });

  it('rejects an empty item_ids array with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/dashboard/export/profiles',
      headers: { authorization: `Bearer ${approvedTokenForAggA}`, 'content-type': 'application/json' },
      payload: { item_ids: [], domain: 'seeker' },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

> Adapt the variable names (`app`, `writer`, `approvedTokenForAggA`, the aggregator's `signalstackOrgId`) to whatever the existing `dashboard.test.ts` harness names them. The aggregator's `signalstackOrgId` must equal the `actingOrgId` used in the `onboard` seed so the fake's org-scoped match returns the row. Check how the file's existing `GET /v1/dashboard/export` test wires the approved token + aggregator store, and reuse that exact setup.

- [ ] **Step 7: Run API tests + typecheck**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/services/__tests__/profile-csv.test.ts src/routes/dashboard.test.ts`
Expected: PASS.
Run: `pnpm --filter @aggregator-dpg/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: dep-check + commit**

```bash
pnpm dep-check
git add apps/api/src/services/profile-csv.ts apps/api/src/services/__tests__/profile-csv.test.ts apps/api/src/routes/dashboard.ts apps/api/src/routes/dashboard.test.ts
git commit -m "feat(api): add profile-data CSV export route"
```

---

### Task B5: Web BFF relay + dashboard service method

**Files:**
- Create: `apps/web/src/app/api/dashboard/export/profiles/route.ts`
- Modify: `apps/web/src/services/dashboard.service.ts`

**Interfaces:**
- Consumes: `callApi` + the unauthorized/service-unavailable response helpers used by `apps/web/src/app/api/dashboard/export/route.ts`; `parseFilenameFromContentDisposition` + the `DashboardExportResult` type already in `dashboard.service.ts`.
- Produces: BFF `POST` handler at `/api/dashboard/export/profiles`; `dashboardExportProfiles(input: { domain: string; itemIds: string[] }): Promise<DashboardExportResult>` on `DashboardService` + `HttpDashboardService`.

- [ ] **Step 1: Create the BFF relay**

Create `apps/web/src/app/api/dashboard/export/profiles/route.ts` (mirror `apps/web/src/app/api/dashboard/export/route.ts`, but `POST` with a JSON body relayed to the API):

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { callApi } from '@/lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '@/app/api/_lib/responses';

/**
 * BFF relay for the decrypted profile-data CSV export. Forwards the selected
 * item_ids to the aggregator API (which holds the signalstack admin key) and
 * streams the CSV (or JSON error envelope) back to the browser.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { message: 'invalid JSON body' } }, { status: 400 });
  }

  try {
    const upstream = await callApi('/v1/dashboard/export/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/csv' },
      body: JSON.stringify(body),
    });
    const ct = upstream.headers.get('content-type') ?? '';
    if (!upstream.ok) {
      if (ct.includes('application/json')) {
        const data = (await upstream.json()) as unknown;
        return NextResponse.json(data, { status: upstream.status });
      }
      const text = await upstream.text();
      return new NextResponse(text, { status: upstream.status, headers: { 'Content-Type': ct || 'text/plain' } });
    }
    const csv = await upstream.text();
    const headers: Record<string, string> = { 'Content-Type': ct || 'text/csv; charset=utf-8' };
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) headers['Content-Disposition'] = disposition;
    return new NextResponse(csv, { status: upstream.status, headers });
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') {
      return unauthorizedResponse();
    }
    return serviceUnavailableResponse(
      'dashboard-export-profiles',
      err instanceof Error ? err.message : undefined,
    );
  }
}
```

> Confirm the exact import paths/names for `unauthorizedResponse` / `serviceUnavailableResponse` / `callApi` by opening `apps/web/src/app/api/dashboard/export/route.ts` and copying its imports verbatim — names above match that file's usage but the module paths must match exactly.

- [ ] **Step 2: Add the service method to the interface + impl**

In `apps/web/src/services/dashboard.service.ts`, add to the `DashboardService` interface (after `dashboardExport`):

```typescript
  dashboardExportProfiles(input: { domain: string; itemIds: string[] }): Promise<DashboardExportResult>;
```

And implement it on `HttpDashboardService` (mirror `dashboardExport`, but POST JSON):

```typescript
  async dashboardExportProfiles(input: { domain: string; itemIds: string[] }): Promise<DashboardExportResult> {
    if (!input.domain) throw new Error('dashboardExportProfiles requires `domain`');
    if (!input.itemIds.length) throw new Error('dashboardExportProfiles requires at least one item id');
    const res = await fetch('/api/dashboard/export/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/csv' },
      credentials: 'same-origin',
      body: JSON.stringify({ item_ids: input.itemIds, domain: input.domain }),
    });
    if (!res.ok) {
      let message = `profile export failed: ${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: { detail?: string; message?: string } };
        const detail = errBody?.error?.detail ?? errBody?.error?.message;
        if (detail) message = detail;
      } catch {
        // non-JSON body — keep the default message.
      }
      throw new Error(message);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') ?? '';
    const filename =
      parseFilenameFromContentDisposition(disposition) ?? `profiles-${input.domain}.csv`;
    return { blob, filename };
  }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @aggregator-dpg/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/dashboard/export/profiles/route.ts apps/web/src/services/dashboard.service.ts
git commit -m "feat(web): add profile-data export BFF + service method"
```

---

### Task B6: Web bulk action — "Export profile data"

**Files:**
- Modify: `apps/web/src/services/bulk-actions.ts`
- Modify: the i18n messages file holding `bulk.exportSelected` (find with `grep -rl "exportSelected" apps/web/src`)
- Test: `apps/web/src/services/__tests__/bulk-actions.test.ts` (create if absent, else extend)

**Interfaces:**
- Consumes: `dashboardService.dashboardExportProfiles` (B5); the `triggerCsvDownload` helper used by `export_selected_csv`; the `BulkAction` interface (`{ id, labelKey, icon, kind, run }`); `ParticipantBase.id`.
- Produces: a new `export_profile_data` entry in the bulk-actions array.

**Background:** `export_selected_csv` (lines 54-66) is `kind: 'client'`. The new action is `kind: 'server'` because it calls the BFF. Synthetic rows have ids starting with `row-` and must be filtered (they are not real signals item_ids).

- [ ] **Step 1: Write the failing bulk-action test**

Create/extend `apps/web/src/services/__tests__/bulk-actions.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bulkActions } from '../bulk-actions';
import { dashboardService } from '../dashboard.service';

const baseRow = (id: string) => ({
  id,
  name: 'X',
  joined: '2026-01-01',
  status: 'active',
  profile: { complete: true },
  initiated: { create: 0, accept: 0, reject: 0, cancel: 0 },
  received: { create: 0, accept: 0, reject: 0, cancel: 0 },
});

describe('export_profile_data bulk action', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends only real item_ids (drops synthetic row-* ids)', async () => {
    const action = bulkActions.find((a) => a.id === 'export_profile_data');
    expect(action).toBeDefined();
    expect(action!.kind).toBe('server');

    const spy = vi
      .spyOn(dashboardService, 'dashboardExportProfiles')
      .mockResolvedValue({ blob: new Blob(['item_id\r\ni1']), filename: 'profiles-seeker.csv' });
    // The download trigger touches DOM APIs; stub it via the module if present,
    // otherwise jsdom handles createObjectURL via the test environment.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    await action!.run(
      [baseRow('11111111-1111-4111-8111-111111111111'), baseRow('row-2')] as never,
      { domain: 'seeker' } as never,
    );

    expect(spy).toHaveBeenCalledWith({
      domain: 'seeker',
      itemIds: ['11111111-1111-4111-8111-111111111111'],
    });
  });
});
```

> Adjust the import name (`bulkActions`) to the file's actual export (it may export a factory or a named array — check the top of `bulk-actions.ts`). If `triggerCsvDownload` is a separate importable helper, `vi.mock` it instead of stubbing `URL`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/services/__tests__/bulk-actions.test.ts`
Expected: FAIL — no `export_profile_data` action found.

- [ ] **Step 3: Add the bulk action**

In `apps/web/src/services/bulk-actions.ts`, add a new entry directly after the `export_selected_csv` object (after line 66):

```typescript
  {
    id: 'export_profile_data',
    labelKey: 'bulk.exportProfileData',
    icon: 'download',
    kind: 'server',
    run: async (rows, ctx) => {
      const itemIds = rows.map((r) => r.id).filter((id) => !id.startsWith('row-'));
      if (itemIds.length === 0) return;
      const { blob, filename } = await dashboardService.dashboardExportProfiles({
        domain: ctx.domain,
        itemIds,
      });
      triggerCsvDownload({ blob, filename });
    },
  },
```

> Confirm `dashboardService` and `triggerCsvDownload` are already imported at the top of `bulk-actions.ts` (they are — used by existing actions).

- [ ] **Step 4: Add the i18n key**

Find the messages file: `grep -rl "exportSelected" apps/web/src`. In each locale object that contains `dashboard.bulk.exportSelected` (or the nested `bulk.exportSelected`), add a sibling key, matching the existing nesting/style:

```json
"exportProfileData": "Export profile data"
```

- [ ] **Step 5: Run web tests + typecheck**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/services/__tests__/bulk-actions.test.ts`
Expected: PASS.
Run: `pnpm --filter @aggregator-dpg/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/services/bulk-actions.ts apps/web/src/services/__tests__/bulk-actions.test.ts
git add $(grep -rl "exportProfileData" apps/web/src)
git commit -m "feat(web): add Export profile data bulk action"
```

---

## Final verification (both repos)

- [ ] **Signals:** `pnpm --filter @dpg/schemas test && pnpm --filter api exec vitest run src/routes/v1/admin/__tests__/participant_decrypt.test.ts && pnpm typecheck`
- [ ] **Signals (with DB up):** run `participant_decrypt.integration.test.ts` and confirm it passes (not skipped).
- [ ] **Aggregator:** `pnpm -w test && pnpm -w typecheck && pnpm -w lint && pnpm dep-check`
- [ ] **End-to-end (local, both stacks running, purple_dot):** select rows on the dashboard → "Export profile data" → CSV downloads with decrypted `name`/`phone` columns for the selected participants; a not-owned id contributes nothing (lands in `skipped` server-side).

> Local note: both stacks currently run `purple_dot` — test there once implemented. The decrypt scoping is network-agnostic (served networks come from `apiConfig.served_domains`).
