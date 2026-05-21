# Participant Onboarding & Source Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single admin endpoint that lets aggregator-dpg and voice-dpg create a participant (user + profile item) in Signals, with provenance — who onboarded them, via what channel, and a back-reference to the upstream record (bulk_upload_id, link_id, voice_session_id).

**Architecture:** Four attribution columns on `user` (`onboarded_by_org_id`, `onboarded_via`, `onboarded_source_id`, `onboarded_at`). One new admin route `POST /api/v1/admin/onboard_participant` that runs under the acting_org preHandler from the auth plan. The handler validates uniqueness against `user.email`/`user.phoneNumber`, calls better-auth's server-side signup primitives to create the user + account, creates the initial profile item via the existing item-create path, and writes attribution — all in one DB transaction.

**Tech Stack:** Drizzle ORM, better-auth server APIs, Fastify 5, Zod, Vitest.

**Prereqs:**
- Auth plan completed: `2026-05-21-aggregator-service-auth.md`. This plan reuses the acting_org preHandler and assumes the two service apikeys exist.
- Local Postgres + Redis up.

**Out of scope:** UI to onboard via the dashboard (aggregator-dpg owns that). Metrics computation (see `2026-05-21-participant-metrics-service.md`).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/db/postgres/schema/auth.ts` (modify) | Add 4 attribution columns to `user` |
| `apps/api/drizzle/<generated>.sql` | Migration produced by `pnpm db:generate:api` |
| `packages/schemas/src/admin/onboard_participant.ts` (new) | Zod request + response schemas |
| `apps/api/src/routes/v1/admin/onboard_participant.ts` (new) | Route handler |
| `apps/api/src/routes/v1/admin/__tests__/onboard_participant.test.ts` (new) | Route tests |
| `apps/api/src/routes/v1/admin/index.ts` (modify) | Register the new route |
| `apps/api/src/lib/profile_item.ts` (new) | Small wrapper around the existing item-create path so the route does not duplicate item write logic |

---

## Task 1: Add attribution columns to `user`

**Files:**
- Modify: `apps/api/db/postgres/schema/auth.ts`

- [ ] **Step 1: Edit the schema**

In `apps/api/db/postgres/schema/auth.ts`, add to the `user` table definition (right after `privacyAccepted`):
```ts
  onboardedByOrgId: text('onboarded_by_org_id').references(() => organization.id),
  onboardedVia: text('onboarded_via'),               // 'bulk' | 'link' | 'voice' | 'self'
  onboardedSourceId: text('onboarded_source_id'),    // opaque upstream id
  onboardedAt: timestamp('onboarded_at'),
```

Note: `organization` is declared further down in the same file. Reorder if needed so the reference resolves, or forward-declare via `(): any` cast — the simpler fix is to move the `organization` block above `user`. Drizzle handles circular forward references in `.references(() => …)` arrow form, so a reorder may not be necessary; try without first.

- [ ] **Step 2: Generate migration**

From repo root:
```bash
pnpm db:generate:api
```
Expected: a new file appears under `apps/api/drizzle/`. Inspect it — it should add four columns to `user` and one FK to `organization(id)`.

- [ ] **Step 3: Apply migration**
```bash
pnpm db:migrate:api
```
Expected: migration runs cleanly.

- [ ] **Step 4: Commit**
```bash
git add apps/api/db/postgres/schema/auth.ts apps/api/drizzle/
git commit -m "feat(api): add onboarding attribution columns to user"
```

---

## Task 2: Zod schemas for onboard_participant

**Files:**
- Create: `packages/schemas/src/admin/onboard_participant.ts`

- [ ] **Step 1: Write schemas**

Create `packages/schemas/src/admin/onboard_participant.ts`:
```ts
import { z } from 'zod';

const PhoneE164 = z.string().regex(/^\+\d{10,15}$/, 'must be E.164');

export const OnboardParticipantRequest = z
  .object({
    email: z.string().email().optional(),
    phone_number: PhoneE164.optional(),
    name: z.string().min(1),
    date_of_birth: z.string().datetime().optional(),
    terms_accepted: z.boolean().refine((v) => v === true, 'terms must be accepted'),
    privacy_accepted: z.boolean().refine((v) => v === true, 'privacy must be accepted'),
    channel: z.enum(['bulk', 'link', 'voice', 'self']),
    source_id: z.string().min(1).optional(),
    profile: z.record(z.unknown()).describe('profile_1.0 payload'),
  })
  .refine(
    (b) => Boolean(b.email) || Boolean(b.phone_number),
    'either email or phone_number is required',
  );

export const OnboardParticipantResponse = z.object({
  user_id: z.string(),
  profile_item_id: z.string(),
  onboarded_at: z.string().datetime(),
});

export type OnboardParticipantRequest = z.infer<typeof OnboardParticipantRequest>;
export type OnboardParticipantResponse = z.infer<typeof OnboardParticipantResponse>;
```

- [ ] **Step 2: Export from package index**

In `packages/schemas/src/index.ts`:
```ts
export * from './admin/onboard_participant.js';
```

- [ ] **Step 3: Type check + commit**
```bash
pnpm tsc --noEmit
git add packages/schemas/
git commit -m "feat(schemas): onboard_participant request/response"
```

---

## Task 3: Profile item helper

**Files:**
- Create: `apps/api/src/lib/profile_item.ts`

- [ ] **Step 1: Identify the existing item-create path**

Find the handler used by `POST /api/v1/item/create` (likely under `apps/api/src/routes/v1/item/`). Note the canonical service it calls to insert into the partitioned `item` table. Reuse that service rather than re-implementing partition-aware insert.

- [ ] **Step 2: Write the wrapper**

Create `apps/api/src/lib/profile_item.ts`:
```ts
import { create_item } from '../routes/v1/item/create_item.js'; // or the service module it uses
import type { DrizzleTx } from '@dpg/database';

export interface CreateProfileItemInput {
  user_id: string;
  network: string;
  domain: string;
  item_type: string;       // e.g. 'profile_1.0'
  payload: Record<string, unknown>;
  tx: DrizzleTx;
}

export const create_profile_item = async (
  input: CreateProfileItemInput,
): Promise<{ item_id: string }> => {
  // Delegate to the existing item-create service. Pass tx so this write
  // joins the same transaction as the user insert.
  // (Adjust the call signature to whatever create_item already exposes.)
  return create_item({ ...input, owner_user_id: input.user_id });
};
```

If `create_item` does not currently accept a `tx`, this is the place to introduce a `tx` parameter that defaults to a top-level `db` call — small refactor, kept in scope because it's directly required here.

- [ ] **Step 3: Commit**
```bash
git add apps/api/src/lib/profile_item.ts
# include any small refactor to create_item.ts in this commit
git commit -m "feat(api): profile_item helper that runs inside caller's tx"
```

---

## Task 4: Route — failing tests first

**Files:**
- Create: `apps/api/src/routes/v1/admin/__tests__/onboard_participant.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { onboard_participant } from '../onboard_participant.js';

const build_app = async (overrides: { acting_org_type?: 'aggregator' | 'voice' | 'network_service' } = {}) => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    req.acting_org = {
      org_id: 'org_test_agg',
      org_type: overrides.acting_org_type ?? 'aggregator',
      service_user_id: 'svc_test',
    };
  });
  await app.register(onboard_participant);
  return app;
};

describe('POST /admin/onboard_participant', () => {
  it('400 when neither email nor phone provided', async () => {
    const app = await build_app();
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        name: 'A',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        profile: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('409 when email already exists', async () => {
    // seed a user with that email in a fake/in-memory DB, then assert 409
  });

  it('409 when phone already exists', async () => {
    // same pattern as email
  });

  it('200 happy path — creates user, profile item, attribution', async () => {
    const app = await build_app();
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        phone_number: '+919876543210',
        name: 'Anita',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        source_id: 'bulk_upload_42',
        profile: { whoIAm: { education: 'XII' } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toMatch(/^usr_/);
    expect(body.profile_item_id).toBeTruthy();
    expect(body.onboarded_at).toBeTruthy();
  });

  it('403 when caller is network_service (must act as aggregator/voice)', async () => {
    const app = await build_app({ acting_org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        phone_number: '+919876543211',
        name: 'A',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        profile: {},
      },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run, verify they fail**
```bash
pnpm --filter @dpg/api test
```
Expected: FAIL — `../onboard_participant.js` not found.

- [ ] **Step 3: Commit (tests only)**
```bash
git add apps/api/src/routes/v1/admin/__tests__/onboard_participant.test.ts
git commit -m "test(api): failing tests for onboard_participant route"
```

---

## Task 5: Implement the route

**Files:**
- Create: `apps/api/src/routes/v1/admin/onboard_participant.ts`
- Modify: `apps/api/src/routes/v1/admin/index.ts`

- [ ] **Step 1: Implement**

```ts
import type { FastifyPluginAsync } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { db } from '@dpg/database';
import { user } from '../../../db/postgres/schema/auth.js';
import { eq, or } from 'drizzle-orm';
import { auth } from '@dpg/auth';
import { create_profile_item } from '../../../lib/profile_item.js';
import {
  OnboardParticipantRequest,
  OnboardParticipantResponse,
} from '@dpg/schemas';

export const onboard_participant: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/onboard_participant',
    {
      schema: {
        body: OnboardParticipantRequest,
        response: { 200: OnboardParticipantResponse },
      },
    },
    async (request, reply) => {
      const acting = request.acting_org;
      if (!acting || acting.org_type === 'network_service') {
        return reply.code(403).send({
          error: 'INVALID_ACTING_ORG',
          message: 'onboarding must be asserted on behalf of an aggregator or voice org',
        });
      }

      const body = request.body;

      // Uniqueness check (also enforced at DB level by unique indexes — this
      // gives a nice 409 instead of relying on the 23505 catch).
      const existing = await db
        .select({ id: user.id, email: user.email, phone: user.phoneNumber })
        .from(user)
        .where(
          or(
            body.email ? eq(user.email, body.email) : undefined,
            body.phone_number ? eq(user.phoneNumber, body.phone_number) : undefined,
          )!,
        )
        .limit(1)
        .then((r) => r[0]);

      if (existing) {
        const which = body.email && existing.email === body.email ? 'email' : 'phone_number';
        return reply.code(409).send({
          error: 'USER_ALREADY_EXISTS',
          message: `a user with this ${which} already exists`,
        });
      }

      try {
        const { user_id, profile_item_id, onboarded_at } = await db.transaction(async (tx) => {
          // Use better-auth's server API so the account row is created with
          // the right hashing + verification scaffolding. The exact call
          // depends on whether email or phone signup is used; both end up
          // calling adapter.createUser internally.
          const signed_up = await auth.api.signUpEmail({
            body: {
              email: body.email ?? `${randomUUID()}@no-email.local`,
              password: randomUUID(),       // placeholder — OTP flow sets a real one later
              name: body.name,
            },
          });
          const user_id = signed_up.user.id;

          // Apply attribution + phone/dob/terms in one update.
          const now = new Date();
          await tx
            .update(user)
            .set({
              phoneNumber: body.phone_number ?? null,
              phoneNumberVerified: false,
              dateOfBirth: body.date_of_birth ? new Date(body.date_of_birth) : null,
              termsAccepted: true,
              privacyAccepted: true,
              onboardedByOrgId: acting.org_id,
              onboardedVia: body.channel,
              onboardedSourceId: body.source_id ?? null,
              onboardedAt: now,
              updatedAt: now,
            })
            .where(eq(user.id, user_id));

          const { item_id } = await create_profile_item({
            user_id,
            network: 'blue_dot',          // adjust if onboarding is multi-network
            domain: 'seeker',
            item_type: 'profile_1.0',
            payload: body.profile,
            tx,
          });

          return { user_id, profile_item_id: item_id, onboarded_at: now.toISOString() };
        });

        return { user_id, profile_item_id, onboarded_at };
      } catch (err: any) {
        if (err?.code === '23505') {
          request.log.error({ err }, 'unique conflict during onboarding');
          return reply.code(409).send({
            error: 'USER_ALREADY_EXISTS',
            message: 'email or phone already in use (race)',
          });
        }
        request.log.error({ err }, 'onboard_participant failed');
        return reply.code(500).send({
          error: 'ONBOARD_FAILED',
          message: 'could not onboard participant',
        });
      }
    },
  );
};
```

- [ ] **Step 2: Register route**

In `apps/api/src/routes/v1/admin/index.ts`:
```ts
import { onboard_participant } from './onboard_participant.js';
// inside admin_routes plugin:
await app.register(onboard_participant);
```

- [ ] **Step 3: Run tests, verify pass**
```bash
pnpm --filter @dpg/api test
```
Expected: 5/5 PASS once each test wires its fakes/seeds.

- [ ] **Step 4: Commit**
```bash
git add apps/api/src/routes/v1/admin/onboard_participant.ts apps/api/src/routes/v1/admin/index.ts
git commit -m "feat(api): admin endpoint to onboard a participant with attribution"
```

---

## Task 6: Integration test against real Postgres

**Files:**
- Create: `apps/api/src/routes/v1/admin/__tests__/onboard_participant.integration.test.ts`

- [ ] **Step 1: Write test that hits a real DB**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build_test_app } from '../../../../testing/build_test_app.js';
// build_test_app boots Fastify with the real DB pointed at $POSTGRES_URL.

describe('onboard_participant (integration)', () => {
  it('creates user + profile + attribution and rejects duplicate email', async () => {
    const app = await build_test_app();
    const phone = '+919900' + Math.floor(100000 + Math.random() * 900000);
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard_participant',
      headers: {
        'authorization': `Bearer ${process.env.TEST_AGGREGATOR_APIKEY}`,
        'x-acting-org-id': process.env.TEST_AGGREGATOR_ORG_ID!,
      },
      payload: {
        phone_number: phone,
        name: 'Integration Test',
        terms_accepted: true, privacy_accepted: true,
        channel: 'bulk', source_id: 'integration_bulk_1',
        profile: {},
      },
    });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/onboard_participant',
      headers: {
        'authorization': `Bearer ${process.env.TEST_AGGREGATOR_APIKEY}`,
        'x-acting-org-id': process.env.TEST_AGGREGATOR_ORG_ID!,
      },
      payload: {
        phone_number: phone,
        name: 'Integration Test 2',
        terms_accepted: true, privacy_accepted: true,
        channel: 'bulk', profile: {},
      },
    });
    expect(r2.statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run (excluded from default `pnpm test`)**

```bash
pnpm --filter @dpg/api exec vitest run src/routes/v1/admin/__tests__/onboard_participant.integration.test.ts
```
Expected: PASS, with two new rows visible in `user` (one created, one not).

- [ ] **Step 3: Commit**
```bash
git add apps/api/src/routes/v1/admin/__tests__/onboard_participant.integration.test.ts
git commit -m "test(api): integration test for onboard_participant"
```

---

## Task 7: Document and expose in OpenAPI

**Files:**
- The route already declares its schema via fastify-type-provider-zod, so Swagger/Scalar at `/api/reference` will pick it up automatically.

- [ ] **Step 1: Manual smoke**
```bash
pnpm dev:api
# open http://localhost:3000/api/reference and confirm
#   POST /api/v1/admin/onboard_participant
# is listed under the admin group with the right body schema.
```

- [ ] **Step 2: Add a usage example to AGENTS.md (or docs/)**

Show the canonical curl an aggregator-dpg integration test would use, including the headers.

- [ ] **Step 3: Commit**

---

## Self-Review Checklist

- Spec coverage:
  - Attribution columns on `user` ✅ (Task 1)
  - Admin endpoint ✅ (Tasks 4-5)
  - Reject when user already exists by email or phone ✅ (Task 5, both pre-check and 23505 fallback)
  - Channel + source_id captured ✅ (Task 5)
  - Acting org enforced (must be aggregator or voice, not network_service) ✅ (Task 5)
- No `aggregator_id` columns added to `item` / `action`. ✅
- `phoneNumber` index/uniqueness already exists in `auth.ts` — no schema change needed beyond the four attribution columns.
- The placeholder password on signup is intentional — OTP-based flows in `unifiedOtp` set the real credential later. Document this in Task 7's notes.

## Open Questions

1. **Default `network` and `domain`** for the profile item are hardcoded to `blue_dot` / `seeker`. If aggregator-dpg ever onboards into other networks, accept `network` and `domain` in the request body.
2. **Phone-first signup**: `better-auth`'s `signUpEmail` requires an email. If a participant is onboarded with phone only, we currently synthesize a placeholder `<uuid>@no-email.local`. Acceptable for MVP but flag for the auth team — they may want a `signUpPhone` variant in better-auth config.
3. **Voice DPG and acting_org**: when voice is network-hosted (no aggregator behind it), the acting_org_id should be a special "network voice" org. Decide that org id at seed time.
