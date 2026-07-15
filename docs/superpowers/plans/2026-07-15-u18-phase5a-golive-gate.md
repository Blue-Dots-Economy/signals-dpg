# U18 Phase 5a — Profile Go-Live Gate + Guardian-OTP Profile Consent

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Enforce that a minor's profile only goes live once the **guardian** has OTP-confirmed profile creation. Server-side: `promoteItemOnProfileConsent` refuses to promote a minor's draft unless a guardian-source `profile_creation` consent row exists; a new item-scoped guardian-OTP flow records that row and promotes.

**Architecture:** A gate in `promoteItemOnProfileConsent` (the single choke point that flips `draft→live`) checks minor status of the item's creator + the domain's `guardian_consent_required`; if gated and no guardian `profile_creation` row exists, it returns `false` (stays draft) — so the existing adult self-consent path cannot promote a minor. Two new routes (`/u18/profile-consent/issue` + `/verify`) mirror Phase 4's guardian-OTP challenge/response, item-scoped, writing the guardian `profile_creation` row and promoting on verify.

**Tech Stack:** TypeScript (ESM, strict), Fastify + zod, Drizzle/Postgres, ioredis, Vitest (unit + integration; dpg-db + dpg-redis are up).

## Global Constraints

- ESM only, strict TS, no `any`; `import type` for type-only imports.
- Routes never throw — `reply.code(N).send({ error, message })`; log `request.log.error({ err }, 'msg')`.
- Versions derived server-side (`resolveConsentVersion`, `variant:'u18'` for guardian rows). Guardian consent `source='guardian'`.
- The gate is server-enforced + fail-closed: gated-but-unsatisfied → do NOT promote.
- Reuse Phase 1–4 primitives: `guardianConsentRequired`, `isMinor`, `getNetworkConfigById`, `getMinorGuardian`/`getGuardianContactPlaintext`, `issueGuardianOtp`/`verifyGuardianOtp`/`assertVerifyAttemptAllowed`, `resolveConsentVersion`.
- Integration tests: `pnpm --filter api test:integration <path>`. Unit: `pnpm --filter api exec vitest run <path>`.

---

### Task 1: Minor go-live gate in `promoteItemOnProfileConsent`

**Files:**
- Modify: `apps/api/src/services/item_service.ts` (`promoteItemOnProfileConsent`)
- Test: `apps/api/src/services/__tests__/promote_minor_gate.integration.test.ts`

**Interfaces:**
- Consumes: `getNetworkConfigById` (`@/network_configs`), `guardianConsentRequired` + `isMinor` (`@/services/minor`), `minor_guardian` + `consent_record` + `items` tables, `eq`/`and` from `drizzle-orm`.
- Produces: `promoteItemOnProfileConsent` returns `false` (no promotion) when the item creator is a minor on a `guardian_consent_required` domain and no guardian `profile_creation` row exists for `(created_by, item_id)`.

- [ ] **Step 0: Enable the gate on the served domain (fixture config)**

The gate only fires on a `guardian_consent_required` domain. Enable it for the blue_dot seeker + provider domains so the gate + tests exercise. In `examples/schemas/blue_dot/network.json`, for the domain objects with `"id": "seeker"` and `"id": "provider"`, add `"guardian_consent_required": true` (a sibling key inside each domain object — a targeted edit, do not reformat the file). This is the real switch that turns U18 on for blue_dot.

- [ ] **Step 1: Add `created_by` to the item select + the gate check**

In `promoteItemOnProfileConsent`, add `created_by: items.created_by` to the `.select({...})` object.

After the existing `if (lifecycle_status !== 'live') return false;` line and **before** the `await exec.update(items)...` promotion, insert:

```ts
  // U18 gate: a minor's profile only goes live on GUARDIAN profile_creation
  // consent. Fail-closed — a gated domain with no guardian row stays draft,
  // so the adult self-consent path cannot promote a minor (spec §7 / D11/D13).
  const networkConfig = await getNetworkConfigById(item.item_network);
  if (guardianConsentRequired(networkConfig, item.item_domain)) {
    const [mg] = await exec
      .select({ birthYear: minor_guardian.birthYear, birthMonth: minor_guardian.birthMonth })
      .from(minor_guardian)
      .where(eq(minor_guardian.userId, item.created_by))
      .limit(1);
    if (mg && isMinor(mg.birthYear, mg.birthMonth)) {
      const [guardianRow] = await exec
        .select({ id: consent_record.id })
        .from(consent_record)
        .where(
          and(
            eq(consent_record.userId, item.created_by),
            eq(consent_record.level, 'item'),
            eq(consent_record.consentCategory, 'profile_creation'),
            eq(consent_record.itemId, itemId),
            eq(consent_record.source, 'guardian'),
          ),
        )
        .limit(1);
      if (!guardianRow) return false; // minor without guardian consent → stay draft
    }
  }
```

Add the imports at the top of `item_service.ts` if not present:
```ts
import { getNetworkConfigById } from '@/network_configs';
import { guardianConsentRequired, isMinor } from '@/services/minor';
import { minor_guardian, consent_record } from '@api/db/postgres/schema';
```
(`items`, `eq`, `and`, `sql` are already imported — verify and only add what's missing.)

- [ ] **Step 2: Write the integration test**

```ts
// apps/api/src/services/__tests__/promote_minor_gate.integration.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items, minor_guardian, consent_record } from '@api/db/postgres/schema';
import { ensureItemPartition } from '@dpg/database';
import { promoteItemOnProfileConsent } from '@/services/item_service';
import { apiConfig } from '@/config';
import { resolveConsentVersion } from '@/services/consent_version';

// Requires the served domain to be guardian_consent_required for this test to
// exercise the gate. If served_domains[0] is not gated, this test documents
// that by skipping the gate assertions — see note below.
const binding = apiConfig.served_domains[0];
const network = binding.network;
const domain = binding.domain;

// Helpers to build a minimal draft profile item owned by a minor.
// (Fill item_type/schema_url from the served domain's config as the existing
// item integration tests do — read create_items usage in a sibling test.)
```

> **Test-build note:** constructing a valid `items` row + partition is non-trivial. Reuse the item-seeding approach from an existing integration test that inserts into `items` (e.g. `apps/api/src/routes/v1/consent/__tests__/consent.integration.test.ts` seeds an item via `ensureItemPartition` + `db.insert(itemsTable)`). Copy its item-insert shape (item_type, item_schema_url, item_state satisfying the schema's required fields so `classify_item` yields `live`, `lifecycle_status:'draft'`, `created_by: <minor userId>`). The test must:
> 1. seed a `minor_guardian` row for `created_by` with a minor DOB (e.g. `birthYear: 2012`);
> 2. **`guardian_consent_required` must be true for `domain`** — if the served domain isn't gated in `network.json`, set it in the test fixture's loaded config is not possible at runtime, so instead assert the gate only when `guardianConsentRequired` is true and otherwise `expect(true).toBe(true)` with a `console.warn` that the served domain is ungated (documented skip). Prefer running with `SERVED_DOMAINS` including a gated seeker domain.
> 3. Assert: with no guardian `profile_creation` row → `promoteItemOnProfileConsent(db, itemId)` returns `false` and the item stays `draft`.
> 4. Insert a guardian-source `profile_creation` row (level `item`, `source:'guardian'`, version from `resolveConsentVersion({network, category:'profile_creation', variant:'u18'})`, `itemId`), then → `promoteItemOnProfileConsent(db, itemId)` returns `true` and lifecycle is `live`.
> `afterAll` deletes the seeded item, minor_guardian, and consent_record rows.

- [ ] **Step 3: Run the integration test + typecheck**

Run: `pnpm --filter api test:integration src/services/__tests__/promote_minor_gate.integration.test.ts`
Expected: PASS. Run: `pnpm --filter api exec tsc --noEmit` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/item_service.ts apps/api/src/services/__tests__/promote_minor_gate.integration.test.ts
git commit -m "feat(u18): gate profile go-live on guardian profile_creation consent for minors"
```

---

### Task 2: Guardian-OTP-gated profile-consent routes

**Files:**
- Modify: `packages/schemas/src/u18_consent.ts` (add issue/verify schemas) + its test
- Create: `apps/api/src/routes/v1/consent/u18_profile_consent.ts` (both routes)
- Modify: `apps/api/src/routes/v1/consent/consent_routes.ts` (register)
- Test: `apps/api/src/routes/v1/consent/__tests__/u18_profile_consent.integration.test.ts`

**Interfaces:**
- Produces: `POST /api/v1/consent/u18/profile-consent/issue` and `/verify`; item-scoped guardian OTP under scope `${userId}:profile:${itemId}`; on verify writes the guardian `profile_creation` item row (`source='guardian'`, u18 version) + calls `promoteItemOnProfileConsent` in a tx.
- Schemas exported from `@dpg/schemas`:
  - `U18ProfileConsentBodySchema` `{ network; brand?; item_domain; item_type; item_id (uuid) }`; response `{ otpSent: boolean }`.
  - `U18ProfileConsentVerifyBodySchema` = same + `{ otp: string(6) }`; response `{ verified: boolean; promoted: boolean }`.

- [ ] **Step 1: Add the schemas**

Append to `packages/schemas/src/u18_consent.ts`:
```ts
export const U18ProfileConsentBodySchema = z.object({
  network: z.string().min(1),
  brand: z.string().min(1).nullish(),
  item_domain: z.string().min(1),
  item_type: z.string().min(1),
  item_id: z.string().uuid(),
});
export const U18ProfileConsentResponseSchema = z.object({ otpSent: z.boolean() });

export const U18ProfileConsentVerifyBodySchema = U18ProfileConsentBodySchema.extend({
  otp: z.string().length(6),
});
export const U18ProfileConsentVerifyResponseSchema = z.object({
  verified: z.boolean(),
  promoted: z.boolean(),
});

export type U18ProfileConsentBody = z.infer<typeof U18ProfileConsentBodySchema>;
export type U18ProfileConsentVerifyBody = z.infer<typeof U18ProfileConsentVerifyBodySchema>;
```
Add one schema test to `packages/schemas/src/__tests__/u18_consent.test.ts`:
```ts
it('profile-consent verify requires a 6-char otp + uuid item_id', () => {
  const base = { network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0', item_id: '11111111-1111-1111-1111-111111111111' };
  expect(U18ProfileConsentVerifyBodySchema.safeParse({ ...base, otp: '123456' }).success).toBe(true);
  expect(U18ProfileConsentVerifyBodySchema.safeParse({ ...base, otp: '12' }).success).toBe(false);
  expect(U18ProfileConsentBodySchema.safeParse({ ...base, item_id: 'not-uuid' }).success).toBe(false);
});
```
(Import the two symbols at the top of the test.)

- [ ] **Step 2: Write the routes**

```ts
// apps/api/src/routes/v1/consent/u18_profile_consent.ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  U18ProfileConsentBodySchema, U18ProfileConsentResponseSchema, type U18ProfileConsentBody,
  U18ProfileConsentVerifyBodySchema, U18ProfileConsentVerifyResponseSchema, type U18ProfileConsentVerifyBody,
} from '@dpg/schemas';
import { db } from '@api/db/postgres/drizzle_config';
import { items, consent_record } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { isMinor } from '@/services/minor';
import { getMinorGuardian, getGuardianContactPlaintext } from '@/services/minor_guardian_repo';
import { resolveConsentVersion } from '@/services/consent_version';
import {
  issueGuardianOtp, verifyGuardianOtp, assertVerifyAttemptAllowed, GuardianOtpError,
} from '@/services/guardian_otp';
import { promoteItemOnProfileConsent } from '@/services/item_service';

const profileScope = (userId: string, itemId: string) => `${userId}:profile:${itemId}`;

async function assertOwnedMinorItem(userId: string, body: { network: string; item_domain: string; item_type: string; item_id: string }) {
  const [owner] = await db
    .select({ created_by: items.created_by })
    .from(items)
    .where(and(
      eq(items.item_network, body.network), eq(items.item_domain, body.item_domain),
      eq(items.item_type, body.item_type), eq(items.item_id, body.item_id),
      eq(items.created_by, userId),
    )).limit(1);
  if (!owner) return { ok: false as const, code: 'NOT_ITEM_OWNER' };
  const mg = await getMinorGuardian(userId);
  if (!mg) return { ok: false as const, code: 'DOB_REQUIRED' };
  if (!isMinor(mg.birthYear, mg.birthMonth)) return { ok: false as const, code: 'NOT_A_MINOR' };
  return { ok: true as const };
}

type IssueReq = FastifyRequest<{ Body: U18ProfileConsentBody }>;
type VerifyReq = FastifyRequest<{ Body: U18ProfileConsentVerifyBody }>;

export const u18_profile_consent: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/u18/profile-consent/issue', method: 'POST', preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18ProfileConsentBodySchema, response: { 200: U18ProfileConsentResponseSchema } },
    handler: issue_handler,
  });
  fastify.route({
    url: '/u18/profile-consent/verify', method: 'POST', preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18ProfileConsentVerifyBodySchema, response: { 200: U18ProfileConsentVerifyResponseSchema } },
    handler: verify_handler,
  });
};

const issue_handler = async (request: IssueReq, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  const body = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === body.network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${body.network}" is not served` });
  }
  const check = await assertOwnedMinorItem(userId, body);
  if (!check.ok) {
    const status = check.code === 'NOT_ITEM_OWNER' ? 403 : 409;
    return reply.code(status).send({ error: check.code, message: check.code });
  }
  const contact = await getGuardianContactPlaintext(userId);
  if (!contact) return reply.code(409).send({ error: 'GUARDIAN_REQUIRED', message: 'Submit guardian details first' });
  try {
    await issueGuardianOtp({ scope: profileScope(userId, body.item_id), contact: contact.contact, contactType: contact.contactType });
  } catch (err) {
    if (err instanceof GuardianOtpError && err.code === 'RATE_LIMITED') return reply.code(429).send({ error: 'OTP_RATE_LIMITED', message: 'Too many OTP requests' });
    if (err instanceof GuardianOtpError && err.code === 'NO_OTP_PROVIDER') return reply.code(503).send({ error: 'OTP_PROVIDER_UNAVAILABLE', message: 'No OTP channel configured' });
    request.log.error({ err }, 'Failed to issue profile-consent OTP');
    return reply.code(500).send({ error: 'OTP_SEND_FAILED', message: 'Failed to send guardian OTP' });
  }
  return reply.code(200).send({ otpSent: true });
};

const verify_handler = async (request: VerifyReq, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  const body = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === body.network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${body.network}" is not served` });
  }
  const check = await assertOwnedMinorItem(userId, body);
  if (!check.ok) {
    const status = check.code === 'NOT_ITEM_OWNER' ? 403 : 409;
    return reply.code(status).send({ error: check.code, message: check.code });
  }
  const scope = profileScope(userId, body.item_id);
  try {
    await assertVerifyAttemptAllowed(scope);
  } catch (err) {
    if (err instanceof GuardianOtpError && err.code === 'VERIFY_THROTTLED') return reply.code(429).send({ error: 'OTP_VERIFY_THROTTLED', message: 'Too many attempts' });
    throw err;
  }
  // Resolve version BEFORE consuming the single-use OTP.
  const version = await resolveConsentVersion({ network: body.network, brand: body.brand, category: 'profile_creation', variant: 'u18' });
  if (version === null) return reply.code(400).send({ error: 'CONSENT_VERSION_UNCONFIGURED', message: 'u18 profile_creation not configured' });

  const ok = await verifyGuardianOtp({ scope, otp: body.otp });
  if (!ok) return reply.code(400).send({ error: 'INVALID_OTP', message: 'OTP is invalid or expired' });

  let promoted = false;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(consent_record).values({
        level: 'item', consentCategory: 'profile_creation', userId, itemId: body.item_id,
        network: body.network, brand: body.brand ?? null, documentVersion: version,
        source: 'guardian', acceptedAt: new Date(), metadata: { variant: 'u18' } as Record<string, unknown>,
      });
      promoted = await promoteItemOnProfileConsent(tx, body.item_id);
    });
  } catch (err) {
    const e = err as { code?: string } | null;
    if (e?.code === '23505') return reply.code(200).send({ verified: true, promoted: false }); // already recorded
    request.log.error({ err }, 'Failed to write guardian profile consent');
    return reply.code(500).send({ error: 'CONSENT_WRITE_FAILED', message: 'Failed to record guardian profile consent' });
  }
  return reply.code(200).send({ verified: true, promoted });
};
```

- [ ] **Step 3: Register the routes**

In `consent_routes.ts`:
```ts
import { u18_profile_consent } from '@/routes/v1/consent/u18_profile_consent';
// inside plugin:
  fastify.register(u18_profile_consent);
```

- [ ] **Step 4: Write the integration test**

Mirror `u18_capture.integration.test.ts` (reuse `buildU18TestApp` from `u18_test_helpers.ts`; mock `@/utils/notificationClient`). Seed a **draft** profile item owned by `ctx.userId` (copy the item-insert shape from `consent.integration.test.ts`, item_state satisfying required so classify→live), and seed a minor DOB + guardian details (call the `/u18/dob` + `/u18/guardian` endpoints, or seed `minor_guardian` directly). Then:
1. `POST /u18/profile-consent/issue` → 200 `{ otpSent: true }`.
2. read OTP from `redis.get('guardian_otp:code:' + ctx.userId + ':profile:' + itemId)`.
3. `POST /u18/profile-consent/verify` with the OTP → 200 `{ verified: true, promoted: true }`; assert the item is now `lifecycle_status: 'live'` and a guardian-source item `profile_creation` row exists.
`afterAll` cleans up item + minor_guardian + consent_record + the redis scope keys.

Run: `pnpm --filter api test:integration src/routes/v1/consent/__tests__/u18_profile_consent.integration.test.ts` → PASS. And `pnpm --filter schemas exec vitest run src/__tests__/u18_consent.test.ts` → PASS. `pnpm --filter api exec tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/schemas/src/u18_consent.ts packages/schemas/src/__tests__/u18_consent.test.ts apps/api/src/routes/v1/consent/u18_profile_consent.ts apps/api/src/routes/v1/consent/consent_routes.ts apps/api/src/routes/v1/consent/__tests__/u18_profile_consent.integration.test.ts
git commit -m "feat(u18): guardian-OTP-gated profile-consent routes (issue/verify + promote)"
```

---

## Phase 5a exit criteria

- `promoteItemOnProfileConsent` fail-closed for minors: no guardian `profile_creation` row → stays draft; guardian row present → promotes.
- `/u18/profile-consent/issue` + `/verify` record the guardian `profile_creation` row and promote on OTP verify; throttled; version resolved before nonce consumed.
- All tests green; `tsc --noEmit` clean.

## Self-review notes

- **Spec coverage:** §7 profile go-live gate + D13 guardian profile_creation → Task 1 (gate) + Task 2 (capture). Per-action (perform/accept) gating = **Phase 5b** (challenge/response on the action endpoints). UI popup = Phase 6.
- **Fail-closed:** the gate returns `false` for a gated minor without a guardian row — the adult path physically cannot flip a minor to live.
- **Nonce ordering:** verify resolves the version before `verifyGuardianOtp` (same fix as Phase 4).
- **Test caveat:** the gate only fires when the served domain is `guardian_consent_required`. Run integration with `SERVED_DOMAINS` including a gated seeker domain; the test documents a skip if the served domain is ungated.
