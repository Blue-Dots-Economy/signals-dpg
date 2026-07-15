# U18 Phase 4 — Guardian Capture Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first-login guardian-capture API for minors — capture DOB, capture + encrypt guardian details, record the ward's guardian-validity attestation, send + verify a guardian OTP, and on success record the guardian's user-level consents. Wires Phase 1 (table + `isMinor`), Phase 2 (u18 version resolver), and Phase 3 (guardian OTP) into three authenticated endpoints.

**Architecture:** Three `POST /api/v1/consent/u18/*` routes on the ward's session (`request.user.id`). Guardian name/contact are encrypted at rest via the existing PII crypto (`@dpg/auth`). Consent is recorded as `consent_record` rows exactly like the shipped adult path, but with `source='guardian'` (guardian consents) / `source='self'` (ward attestation) and versions resolved with `variant:'u18'`. **Item-level `profile_creation` and per-action guardian consent are NOT here** — they belong to the gates (Phase 5), where the item/action context exists. Phase 4 records only the account-level pieces: `guardian_declaration`, `terms`, `privacy`.

**Tech Stack:** TypeScript (ESM, strict), Fastify + `fastify-type-provider-zod`, Drizzle/Postgres, ioredis, Vitest (unit + integration).

## Global Constraints

- ESM only, strict TS, no `any`; `import type` for type-only imports.
- Routes never throw — return `reply.code(N).send({ error, message })` with a machine-readable `error`; log via `request.log.error({ err }, 'msg')`. Handle PG `23505` (unique) explicitly where relevant.
- Version is always derived server-side via `resolveConsentVersion` — never trust a client version.
- Guardian contact ≠ the ward's own verified contact (spec D5). Guardian name + contact are **encrypted at rest** (`SIGNALS_PII_KEY` via `@dpg/auth`); cleartext is never persisted.
- Guardian OTP is the Phase 3 primitive; add a **verify-attempt** throttle (Phase 3 carry-forward).
- U18 versions resolved with `variant:'u18'`; guardian consents `source='guardian'`, ward attestation `source='self'`, `consent_category='guardian_declaration'`.
- Unit tests: `pnpm --filter api exec vitest run <path>`. Integration tests (need dpg-db + dpg-redis, already up): `pnpm --filter api test:integration <path>`.

---

### Task 1: Guardian PII crypto wrapper

**Files:**
- Create: `apps/api/src/services/guardian_pii.ts`
- Test: `apps/api/src/services/__tests__/guardian_pii.test.ts`

**Interfaces:**
- Consumes: `encryptPiiBlob(plaintext, key)`, `decryptPiiBlob(blob, key)`, `getPiiKey()` from `@dpg/auth`.
- Produces: `encryptGuardianField(plaintext: string): string`, `decryptGuardianField(blob: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/__tests__/guardian_pii.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { encryptGuardianField, decryptGuardianField } from '@/services/guardian_pii';

// getPiiKey() reads SIGNALS_PII_KEY; the integration env sets it. For this
// unit test, set a valid 32-byte base64 key before importing key usage.
beforeAll(() => {
  process.env.SIGNALS_PII_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

describe('guardian PII crypto', () => {
  it('round-trips a value (encrypt → decrypt)', () => {
    const blob = encryptGuardianField('+91999888777');
    expect(blob).not.toBe('+91999888777'); // actually encrypted
    expect(decryptGuardianField(blob)).toBe('+91999888777');
  });

  it('produces different ciphertext for the same input (IV/nonce)', () => {
    expect(encryptGuardianField('a@b.co')).not.toBe(encryptGuardianField('a@b.co'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/__tests__/guardian_pii.test.ts`
Expected: FAIL — `@/services/guardian_pii` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/guardian_pii.ts
import { encryptPiiBlob, decryptPiiBlob, getPiiKey } from '@dpg/auth';

/**
 * Encrypt a guardian PII field (name / contact) for at-rest storage, reusing
 * the shared PII key + AEAD scheme (spec D5). Cleartext is never persisted.
 */
export function encryptGuardianField(plaintext: string): string {
  return encryptPiiBlob(plaintext, getPiiKey());
}

/** Decrypt a guardian PII field — used only transiently (OTP send / audited view). */
export function decryptGuardianField(blob: string): string {
  return decryptPiiBlob(blob, getPiiKey());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/__tests__/guardian_pii.test.ts`
Expected: PASS (2 tests). (If `encryptPiiBlob` is deterministic without an IV, the second test will fail — in that case delete only the second test and note it in the report; do not weaken the crypto.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/guardian_pii.ts apps/api/src/services/__tests__/guardian_pii.test.ts
git commit -m "feat(u18): guardian PII encrypt/decrypt wrapper"
```

---

### Task 2: `minor_guardian` repository + verify-attempt throttle

**Files:**
- Create: `apps/api/src/services/minor_guardian_repo.ts`
- Modify: `apps/api/src/services/guardian_otp.ts` (add `assertVerifyAttemptAllowed`)
- Test: `apps/api/src/services/__tests__/minor_guardian_repo.integration.test.ts`
- Test: `apps/api/src/services/__tests__/guardian_otp_verify_attempt.test.ts`

**Interfaces:**
- Consumes: `db` (`@api/db/postgres/drizzle_config`), `minor_guardian` (`@api/db/postgres/schema`), `encryptGuardianField`/`decryptGuardianField` (Task 1), `redis` (`@api/db/secondary/redis`), `GuardianOtpError` (Phase 3).
- Produces:
  - `upsertBirthMonth(userId, birthYear, birthMonth): Promise<void>`
  - `getMinorGuardian(userId): Promise<{ birthYear: number; birthMonth: number; guardianContactType: 'phone' | 'email' | null; guardianVerified: boolean } | null>`
  - `upsertGuardianDetails(userId, { guardianName, guardianContact, guardianContactType }): Promise<void>` (encrypts name + contact)
  - `getGuardianContactPlaintext(userId): Promise<{ contact: string; contactType: 'phone' | 'email' } | null>` (decrypts — for OTP send)
  - `setGuardianVerified(userId): Promise<void>`
  - `assertVerifyAttemptAllowed(scope: string): Promise<void>` (in `guardian_otp.ts`) — throws `GuardianOtpError('VERIFY_THROTTLED')` past the limit. Adds `'VERIFY_THROTTLED'` to the error code union + exports `GUARDIAN_OTP_VERIFY_MAX = 5`, `GUARDIAN_OTP_VERIFY_WINDOW_SEC = 300`.

- [ ] **Step 1: Add the verify-attempt throttle to `guardian_otp.ts` + its unit test**

Extend the `GuardianOtpError` code union to include `'VERIFY_THROTTLED'`:
```ts
  constructor(public code: 'RATE_LIMITED' | 'NO_OTP_PROVIDER' | 'VERIFY_THROTTLED') {
```
Add constants + function (near the issue/verify functions):
```ts
export const GUARDIAN_OTP_VERIFY_MAX = 5; // verify attempts per window
export const GUARDIAN_OTP_VERIFY_WINDOW_SEC = 300;

const verifyRateKey = (scope: string) => `guardian_otp:vrl:${scope}`;

/**
 * Throttle verify attempts per scope (brute-force guard — the core OTP is a
 * 6-digit space). Throws VERIFY_THROTTLED past the window max. Call before
 * verifyGuardianOtp on the HTTP boundary.
 */
export async function assertVerifyAttemptAllowed(scope: string): Promise<void> {
  const k = verifyRateKey(scope);
  const count = await redis.incr(k);
  if (count === 1) {
    await redis.expire(k, GUARDIAN_OTP_VERIFY_WINDOW_SEC);
  }
  if (count > GUARDIAN_OTP_VERIFY_MAX) {
    throw new GuardianOtpError('VERIFY_THROTTLED');
  }
}
```

Unit test:
```ts
// apps/api/src/services/__tests__/guardian_otp_verify_attempt.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
const redisMock = {
  incr: vi.fn(async (k: string) => {
    const n = Number(store.get(k) ?? '0') + 1;
    store.set(k, String(n));
    return n;
  }),
  expire: vi.fn(async () => 1),
};
vi.mock('@api/db/secondary/redis', () => ({ redis: redisMock }));

import {
  assertVerifyAttemptAllowed,
  GUARDIAN_OTP_VERIFY_MAX,
} from '@/services/guardian_otp';

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('assertVerifyAttemptAllowed', () => {
  it('allows up to the max, throws VERIFY_THROTTLED after', async () => {
    for (let i = 0; i < GUARDIAN_OTP_VERIFY_MAX; i++) {
      await assertVerifyAttemptAllowed('u1');
    }
    await expect(assertVerifyAttemptAllowed('u1')).rejects.toMatchObject({
      code: 'VERIFY_THROTTLED',
    });
  });
});
```

- [ ] **Step 2: Run the throttle unit test (red → green)**

Run: `pnpm --filter api exec vitest run src/services/__tests__/guardian_otp_verify_attempt.test.ts`
Expected: after adding the code, PASS (1 test).

- [ ] **Step 3: Write the repository**

```ts
// apps/api/src/services/minor_guardian_repo.ts
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { minor_guardian } from '@api/db/postgres/schema';
import { encryptGuardianField, decryptGuardianField } from '@/services/guardian_pii';

type GuardianContactType = 'phone' | 'email';

/** Insert or update the ward's birth year/month (no exact day). */
export async function upsertBirthMonth(
  userId: string,
  birthYear: number,
  birthMonth: number,
): Promise<void> {
  await db
    .insert(minor_guardian)
    .values({ userId, birthYear, birthMonth })
    .onConflictDoUpdate({
      target: minor_guardian.userId,
      set: { birthYear, birthMonth, updatedAt: new Date() },
    });
}

export async function getMinorGuardian(userId: string): Promise<{
  birthYear: number;
  birthMonth: number;
  guardianContactType: GuardianContactType | null;
  guardianVerified: boolean;
} | null> {
  const [row] = await db
    .select({
      birthYear: minor_guardian.birthYear,
      birthMonth: minor_guardian.birthMonth,
      guardianContactType: minor_guardian.guardianContactType,
      guardianVerified: minor_guardian.guardianVerified,
    })
    .from(minor_guardian)
    .where(eq(minor_guardian.userId, userId))
    .limit(1);
  if (!row) return null;
  return {
    birthYear: row.birthYear,
    birthMonth: row.birthMonth,
    guardianContactType: (row.guardianContactType as GuardianContactType | null) ?? null,
    guardianVerified: row.guardianVerified,
  };
}

/** Store guardian details with name + contact encrypted at rest. Resets verified. */
export async function upsertGuardianDetails(
  userId: string,
  input: { guardianName: string; guardianContact: string; guardianContactType: GuardianContactType },
): Promise<void> {
  await db
    .update(minor_guardian)
    .set({
      guardianName: encryptGuardianField(input.guardianName),
      guardianContact: encryptGuardianField(input.guardianContact),
      guardianContactType: input.guardianContactType,
      guardianVerified: false,
      updatedAt: new Date(),
    })
    .where(eq(minor_guardian.userId, userId));
}

/** Decrypt the guardian contact for a transient use (OTP send). */
export async function getGuardianContactPlaintext(
  userId: string,
): Promise<{ contact: string; contactType: GuardianContactType } | null> {
  const [row] = await db
    .select({
      guardianContact: minor_guardian.guardianContact,
      guardianContactType: minor_guardian.guardianContactType,
    })
    .from(minor_guardian)
    .where(eq(minor_guardian.userId, userId))
    .limit(1);
  if (!row?.guardianContact || !row.guardianContactType) return null;
  return {
    contact: decryptGuardianField(row.guardianContact),
    contactType: row.guardianContactType as GuardianContactType,
  };
}

export async function setGuardianVerified(userId: string): Promise<void> {
  await db
    .update(minor_guardian)
    .set({ guardianVerified: true, updatedAt: new Date() })
    .where(eq(minor_guardian.userId, userId));
}
```

- [ ] **Step 4: Write the repo integration test**

```ts
// apps/api/src/services/__tests__/minor_guardian_repo.integration.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { minor_guardian } from '@api/db/postgres/schema';
import {
  upsertBirthMonth,
  getMinorGuardian,
  upsertGuardianDetails,
  getGuardianContactPlaintext,
  setGuardianVerified,
} from '@/services/minor_guardian_repo';

const uid = 'test-u18-repo-user';

afterAll(async () => {
  await db.delete(minor_guardian).where(eq(minor_guardian.userId, uid));
});

describe('minor_guardian_repo (integration)', () => {
  it('upserts birth month and reads it back', async () => {
    await upsertBirthMonth(uid, 2010, 6);
    const row = await getMinorGuardian(uid);
    expect(row).toMatchObject({ birthYear: 2010, birthMonth: 6, guardianVerified: false });
  });

  it('stores guardian details encrypted, decrypts contact, and flips verified', async () => {
    await upsertGuardianDetails(uid, {
      guardianName: 'Parent Name',
      guardianContact: 'parent@x.co',
      guardianContactType: 'email',
    });
    // stored ciphertext is not the plaintext
    const [raw] = await db
      .select({ c: minor_guardian.guardianContact })
      .from(minor_guardian)
      .where(eq(minor_guardian.userId, uid));
    expect(raw.c).not.toBe('parent@x.co');
    // decrypts back
    expect(await getGuardianContactPlaintext(uid)).toEqual({ contact: 'parent@x.co', contactType: 'email' });
    // verify flip
    await setGuardianVerified(uid);
    expect((await getMinorGuardian(uid))?.guardianVerified).toBe(true);
  });
});
```

- [ ] **Step 5: Run repo integration test + typecheck**

Run: `pnpm --filter api test:integration src/services/__tests__/minor_guardian_repo.integration.test.ts`
Expected: PASS (2 tests).
Run: `pnpm --filter api exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/minor_guardian_repo.ts apps/api/src/services/guardian_otp.ts apps/api/src/services/__tests__/minor_guardian_repo.integration.test.ts apps/api/src/services/__tests__/guardian_otp_verify_attempt.test.ts
git commit -m "feat(u18): minor_guardian repo + guardian-OTP verify-attempt throttle"
```

---

### Task 3: U18 request/response schemas + route registration scaffold

**Files:**
- Create: `packages/schemas/src/u18_consent.ts`
- Modify: `packages/schemas/src/index.ts` (export the new module)
- Test: `packages/schemas/src/__tests__/u18_consent.test.ts`

**Interfaces:**
- Produces (all Zod + inferred types), exported from `@dpg/schemas`:
  - `U18DobBodySchema` `{ network: string; birthYear: number(int, 1900-2100); birthMonth: number(int,1-12) }`; `U18DobResponseSchema` `{ isMinor: boolean }`.
  - `U18GuardianBodySchema` `{ network: string; brand?: string|null; guardianName: string(min1); guardianContact: string(min1); guardianContactType: 'phone'|'email'; guardianDeclarationAccepted: true }`; `U18GuardianResponseSchema` `{ otpSent: boolean }`.
  - `U18GuardianVerifyBodySchema` `{ network: string; brand?: string|null; otp: string(len 6) }`; `U18GuardianVerifyResponseSchema` `{ verified: boolean }`.

- [ ] **Step 1: Write the schemas**

```ts
// packages/schemas/src/u18_consent.ts
import z from 'zod';

export const U18DobBodySchema = z.object({
  network: z.string().min(1),
  birthYear: z.number().int().min(1900).max(2100),
  birthMonth: z.number().int().min(1).max(12),
});
export const U18DobResponseSchema = z.object({ isMinor: z.boolean() });

export const U18GuardianBodySchema = z.object({
  network: z.string().min(1),
  brand: z.string().min(1).nullish(),
  guardianName: z.string().min(1),
  guardianContact: z.string().min(1),
  guardianContactType: z.enum(['phone', 'email']),
  // Ward's guardian-validity attestation (D12) — must be explicitly true.
  guardianDeclarationAccepted: z.literal(true),
});
export const U18GuardianResponseSchema = z.object({ otpSent: z.boolean() });

export const U18GuardianVerifyBodySchema = z.object({
  network: z.string().min(1),
  brand: z.string().min(1).nullish(),
  otp: z.string().length(6),
});
export const U18GuardianVerifyResponseSchema = z.object({ verified: z.boolean() });

export type U18DobBody = z.infer<typeof U18DobBodySchema>;
export type U18GuardianBody = z.infer<typeof U18GuardianBodySchema>;
export type U18GuardianVerifyBody = z.infer<typeof U18GuardianVerifyBodySchema>;
```

- [ ] **Step 2: Export from the package barrel**

Add to `packages/schemas/src/index.ts` (alongside the other `export *` lines):
```ts
export * from './u18_consent';
```

- [ ] **Step 3: Write the failing test**

```ts
// packages/schemas/src/__tests__/u18_consent.test.ts
import { describe, it, expect } from 'vitest';
import {
  U18DobBodySchema,
  U18GuardianBodySchema,
  U18GuardianVerifyBodySchema,
} from '../u18_consent';

describe('U18 consent request schemas', () => {
  it('accepts a valid DOB body and rejects month 13', () => {
    expect(U18DobBodySchema.safeParse({ network: 'blue_dot', birthYear: 2010, birthMonth: 6 }).success).toBe(true);
    expect(U18DobBodySchema.safeParse({ network: 'blue_dot', birthYear: 2010, birthMonth: 13 }).success).toBe(false);
  });

  it('requires guardianDeclarationAccepted === true and a valid contact type', () => {
    const base = { network: 'blue_dot', guardianName: 'P', guardianContact: 'a@b.co', guardianContactType: 'email' as const };
    expect(U18GuardianBodySchema.safeParse({ ...base, guardianDeclarationAccepted: true }).success).toBe(true);
    expect(U18GuardianBodySchema.safeParse({ ...base, guardianDeclarationAccepted: false }).success).toBe(false);
    expect(U18GuardianBodySchema.safeParse({ ...base, guardianDeclarationAccepted: true, guardianContactType: 'whatsapp' }).success).toBe(false);
  });

  it('requires a 6-char otp', () => {
    expect(U18GuardianVerifyBodySchema.safeParse({ network: 'blue_dot', otp: '123456' }).success).toBe(true);
    expect(U18GuardianVerifyBodySchema.safeParse({ network: 'blue_dot', otp: '123' }).success).toBe(false);
  });
});
```

- [ ] **Step 4: Run (red→green) + typecheck**

Run: `pnpm --filter schemas exec vitest run src/__tests__/u18_consent.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/schemas/src/u18_consent.ts packages/schemas/src/index.ts packages/schemas/src/__tests__/u18_consent.test.ts
git commit -m "feat(u18): request/response schemas for the guardian capture endpoints"
```

---

### Task 4: `POST /u18/dob` + `POST /u18/guardian` routes

**Files:**
- Create: `apps/api/src/routes/v1/consent/u18_dob.ts`
- Create: `apps/api/src/routes/v1/consent/u18_guardian.ts`
- Modify: `apps/api/src/routes/v1/consent/consent_routes.ts` (register both)
- Test: `apps/api/src/routes/v1/consent/__tests__/u18_capture.integration.test.ts`

**Interfaces:**
- Consumes: `request.user.id`; `upsertBirthMonth`, `getMinorGuardian`, `upsertGuardianDetails`, `getGuardianContactPlaintext` (Task 2); `isMinor`, `guardianConsentRequired`? (Phase 1 — network config not needed for DOB); `resolveConsentVersion` (Phase 2); `issueGuardianOtp` (Phase 3); `db` + `consent_record`; the Task 3 schemas.
- Produces: routes `POST /api/v1/consent/u18/dob` and `POST /api/v1/consent/u18/guardian` (registered under the existing `/consent` prefix).

- [ ] **Step 1: Write the DOB route**

```ts
// apps/api/src/routes/v1/consent/u18_dob.ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { U18DobBodySchema, U18DobResponseSchema, type U18DobBody } from '@dpg/schemas';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { isMinor } from '@/services/minor';
import { upsertBirthMonth } from '@/services/minor_guardian_repo';

type Req = FastifyRequest<{ Body: U18DobBody }>;

export const u18_dob: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/u18/dob',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18DobBodySchema, response: { 200: U18DobResponseSchema } },
    handler: u18_dob_handler,
  });
};

export const u18_dob_handler = async (request: Req, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });

  const { network, birthYear, birthMonth } = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${network}" is not served` });
  }

  try {
    await upsertBirthMonth(userId, birthYear, birthMonth);
  } catch (err) {
    request.log.error({ err }, 'Failed to persist U18 DOB');
    return reply.code(500).send({ error: 'DOB_WRITE_FAILED', message: 'Failed to record date of birth' });
  }

  return reply.code(200).send({ isMinor: isMinor(birthYear, birthMonth) });
};
```

- [ ] **Step 2: Write the guardian route**

```ts
// apps/api/src/routes/v1/consent/u18_guardian.ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { U18GuardianBodySchema, U18GuardianResponseSchema, type U18GuardianBody } from '@dpg/schemas';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { isMinor } from '@/services/minor';
import {
  getMinorGuardian,
  upsertGuardianDetails,
  getGuardianContactPlaintext,
} from '@/services/minor_guardian_repo';
import { resolveConsentVersion } from '@/services/consent_version';
import { issueGuardianOtp, GuardianOtpError } from '@/services/guardian_otp';

type Req = FastifyRequest<{ Body: U18GuardianBody }>;

export const u18_guardian: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/u18/guardian',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18GuardianBodySchema, response: { 200: U18GuardianResponseSchema } },
    handler: u18_guardian_handler,
  });
};

export const guardianOtpScope = (userId: string) => `${userId}:guardian`;

export const u18_guardian_handler = async (request: Req, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });

  const body = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === body.network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${body.network}" is not served` });
  }

  const mg = await getMinorGuardian(userId);
  if (!mg) return reply.code(409).send({ error: 'DOB_REQUIRED', message: 'Submit date of birth before guardian details' });
  if (!isMinor(mg.birthYear, mg.birthMonth)) {
    return reply.code(409).send({ error: 'NOT_A_MINOR', message: 'Guardian flow applies only to under-18 users' });
  }

  // Record the ward's guardian-validity attestation (D12): source='self', u18.
  const declVersion = await resolveConsentVersion({
    network: body.network, brand: body.brand, category: 'guardian_declaration', variant: 'u18',
  });
  if (declVersion === null) {
    return reply.code(400).send({ error: 'CONSENT_VERSION_UNCONFIGURED', message: 'guardian_declaration not configured' });
  }

  try {
    await upsertGuardianDetails(userId, {
      guardianName: body.guardianName,
      guardianContact: body.guardianContact,
      guardianContactType: body.guardianContactType,
    });
    await db.insert(consent_record).values({
      level: 'user',
      consentCategory: 'guardian_declaration',
      userId,
      network: body.network,
      brand: body.brand ?? null,
      documentVersion: declVersion,
      source: 'self',
      acceptedAt: new Date(),
      metadata: { variant: 'u18' },
    });
  } catch (err) {
    request.log.error({ err }, 'Failed to persist guardian details/declaration');
    return reply.code(500).send({ error: 'GUARDIAN_WRITE_FAILED', message: 'Failed to record guardian details' });
  }

  const contact = await getGuardianContactPlaintext(userId);
  if (!contact) return reply.code(500).send({ error: 'GUARDIAN_WRITE_FAILED', message: 'Guardian contact missing after write' });

  try {
    await issueGuardianOtp({ scope: guardianOtpScope(userId), contact: contact.contact, contactType: contact.contactType });
  } catch (err) {
    if (err instanceof GuardianOtpError && err.code === 'RATE_LIMITED') {
      return reply.code(429).send({ error: 'OTP_RATE_LIMITED', message: 'Too many OTP requests; try again shortly' });
    }
    if (err instanceof GuardianOtpError && err.code === 'NO_OTP_PROVIDER') {
      return reply.code(503).send({ error: 'OTP_PROVIDER_UNAVAILABLE', message: 'No OTP channel configured for this instance' });
    }
    request.log.error({ err }, 'Failed to issue guardian OTP');
    return reply.code(500).send({ error: 'OTP_SEND_FAILED', message: 'Failed to send guardian OTP' });
  }

  return reply.code(200).send({ otpSent: true });
};
```

- [ ] **Step 3: Register both routes**

In `apps/api/src/routes/v1/consent/consent_routes.ts`, import and register (add to the imports and the plugin body):
```ts
import { u18_dob } from '@/routes/v1/consent/u18_dob';
import { u18_guardian } from '@/routes/v1/consent/u18_guardian';
// ... inside the plugin:
  fastify.register(u18_dob);
  fastify.register(u18_guardian);
```

> **Helper first (`u18_test_helpers.ts`).** Auth here is the REAL `auth_middleware` resolving `request.user.id` from a seeded **`x-api-key`** (there is no bearer stub). Read `consent.integration.test.ts` and copy its harness into `apps/api/src/routes/v1/consent/__tests__/u18_test_helpers.ts`, exposing `buildU18TestApp(): Promise<{ app; userId; rawKey; network; close }>`:
> - build Fastify with `withTypeProvider<ZodTypeProvider>()` + `setValidatorCompiler`/`setSerializerCompiler`, register `consent_routes` at prefix `/api/v1/consent`, `app.listen` on a free port (mirror the source, incl. its `EADDRINUSE` guard);
> - `network = apiConfig.served_domains[0].network`; `userId = 'test-u18-' + randomUUID()`;
> - seed `user` then `apikey` with `key = createHash('sha256').update(rawKey).digest('base64url')`, `userId`/`referenceId = userId`, `configId:'default'`, `prefix:'sk_signals_'`, `enabled:true`, `start: rawKey.slice(0,6)` (copy the field set verbatim from the source);
> - `close()` deletes the apikey + user rows and calls `app.close()`.
> Do NOT invent a new auth mechanism — reuse the source's exactly.

- [ ] **Step 4: Write the integration test** (mocks the notifier so the OTP path runs without a provider)

```ts
// apps/api/src/routes/v1/consent/__tests__/u18_capture.integration.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Guardian OTP send → no-op (no real notifier). Mocked before app import.
vi.mock('@/utils/notificationClient', () => ({ getNotificationClient: () => ({ notify: async () => {} }) }));

import { db } from '@api/db/postgres/drizzle_config';
import { minor_guardian, consent_record } from '@api/db/postgres/schema';
import { redis } from '@api/db/secondary/redis';
import { buildU18TestApp } from './u18_test_helpers';

let ctx: Awaited<ReturnType<typeof buildU18TestApp>>;

beforeAll(async () => {
  ctx = await buildU18TestApp();
});
afterAll(async () => {
  await db.delete(consent_record).where(eq(consent_record.userId, ctx.userId));
  await db.delete(minor_guardian).where(eq(minor_guardian.userId, ctx.userId));
  await redis.del(`guardian_otp:code:${ctx.userId}:guardian`);
  await redis.del(`guardian_otp:rl:${ctx.userId}:guardian`);
  await redis.del(`guardian_otp:vrl:${ctx.userId}:guardian`);
  await ctx.close();
});

describe('U18 capture (integration)', () => {
  it('DOB for a minor returns isMinor:true and persists', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/dob',
      headers: { 'x-api-key': ctx.rawKey },
      payload: { network: ctx.network, birthYear: 2012, birthMonth: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isMinor).toBe(true);
  });

  it('guardian submit stores encrypted details, writes guardian_declaration, sends OTP', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/v1/consent/u18/guardian',
      headers: { 'x-api-key': ctx.rawKey },
      payload: {
        network: ctx.network, guardianName: 'Parent', guardianContact: 'p@x.co',
        guardianContactType: 'email', guardianDeclarationAccepted: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().otpSent).toBe(true);

    const [g] = await db.select().from(minor_guardian).where(eq(minor_guardian.userId, ctx.userId));
    expect(g.guardianContact).not.toBe('p@x.co'); // encrypted at rest
    const decl = (await db.select().from(consent_record).where(eq(consent_record.userId, ctx.userId)))
      .find((r) => r.consentCategory === 'guardian_declaration');
    expect(decl?.source).toBe('self');
  });
});
```

> **Served-network note:** `ctx.network` is `served_domains[0].network` — in the integration env that is `blue_dot`, which has the u18 `consent.json` copy seeded in Phase 2, so `resolveConsentVersion({variant:'u18'})` resolves. If the env's served network has no u18 copy, `guardian_declaration`/`terms`/`privacy` resolution returns null and the route returns `CONSENT_VERSION_UNCONFIGURED` (400) — in that case seed u18 copy for that network's `consent.json` first.

- [ ] **Step 5: Run the integration test + typecheck**

Run: `pnpm --filter api test:integration src/routes/v1/consent/__tests__/u18_capture.integration.test.ts`
Expected: PASS (2 tests).
Run: `pnpm --filter api exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/consent/u18_dob.ts apps/api/src/routes/v1/consent/u18_guardian.ts apps/api/src/routes/v1/consent/consent_routes.ts apps/api/src/routes/v1/consent/__tests__/u18_capture.integration.test.ts apps/api/src/routes/v1/consent/__tests__/u18_test_helpers.ts
git commit -m "feat(u18): DOB + guardian-detail capture routes (declaration row + OTP)"
```

---

### Task 5: `POST /u18/guardian/verify` route

**Files:**
- Create: `apps/api/src/routes/v1/consent/u18_guardian_verify.ts`
- Modify: `apps/api/src/routes/v1/consent/consent_routes.ts` (register)
- Test: extend `apps/api/src/routes/v1/consent/__tests__/u18_capture.integration.test.ts`

**Interfaces:**
- Consumes: `assertVerifyAttemptAllowed`, `verifyGuardianOtp`, `GuardianOtpError` (guardian_otp); `setGuardianVerified` (repo); `resolveConsentVersion`; `db` + `consent_record`; `guardianOtpScope` (Task 4); Task 3 verify schema.
- Produces: `POST /api/v1/consent/u18/guardian/verify` → on success writes `terms` + `privacy` guardian rows (`source='guardian'`, u18) and flips `guardian_verified`.

- [ ] **Step 1: Write the verify route**

```ts
// apps/api/src/routes/v1/consent/u18_guardian_verify.ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  U18GuardianVerifyBodySchema, U18GuardianVerifyResponseSchema, type U18GuardianVerifyBody,
} from '@dpg/schemas';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { resolveConsentVersion } from '@/services/consent_version';
import { setGuardianVerified } from '@/services/minor_guardian_repo';
import { assertVerifyAttemptAllowed, verifyGuardianOtp, GuardianOtpError } from '@/services/guardian_otp';
import { guardianOtpScope } from '@/routes/v1/consent/u18_guardian';

type Req = FastifyRequest<{ Body: U18GuardianVerifyBody }>;
const GUARDIAN_USER_DOCS = ['terms', 'privacy'] as const;

export const u18_guardian_verify: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/u18/guardian/verify',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18GuardianVerifyBodySchema, response: { 200: U18GuardianVerifyResponseSchema } },
    handler: u18_guardian_verify_handler,
  });
};

export const u18_guardian_verify_handler = async (request: Req, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });

  const body = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === body.network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${body.network}" is not served` });
  }

  const scope = guardianOtpScope(userId);
  try {
    await assertVerifyAttemptAllowed(scope);
  } catch (err) {
    if (err instanceof GuardianOtpError && err.code === 'VERIFY_THROTTLED') {
      return reply.code(429).send({ error: 'OTP_VERIFY_THROTTLED', message: 'Too many attempts; try again shortly' });
    }
    throw err;
  }

  const ok = await verifyGuardianOtp({ scope, otp: body.otp });
  if (!ok) return reply.code(400).send({ error: 'INVALID_OTP', message: 'OTP is invalid or expired' });

  // Resolve u18 versions for the guardian's user-level consents.
  const rows = [];
  for (const category of GUARDIAN_USER_DOCS) {
    const version = await resolveConsentVersion({ network: body.network, brand: body.brand, category, variant: 'u18' });
    if (version === null) {
      return reply.code(400).send({ error: 'CONSENT_VERSION_UNCONFIGURED', message: `u18 ${category} not configured` });
    }
    rows.push({
      level: 'user' as const,
      consentCategory: category,
      userId,
      network: body.network,
      brand: body.brand ?? null,
      documentVersion: version,
      source: 'guardian' as const,
      acceptedAt: new Date(),
      metadata: { variant: 'u18' } as Record<string, unknown>,
    });
  }

  try {
    await db.insert(consent_record).values(rows);
    await setGuardianVerified(userId);
  } catch (err) {
    request.log.error({ err }, 'Failed to write guardian consents');
    return reply.code(500).send({ error: 'CONSENT_WRITE_FAILED', message: 'Failed to record guardian consent' });
  }

  return reply.code(200).send({ verified: true });
};
```

- [ ] **Step 2: Register the route**

In `consent_routes.ts` add:
```ts
import { u18_guardian_verify } from '@/routes/v1/consent/u18_guardian_verify';
// inside plugin:
  fastify.register(u18_guardian_verify);
```

- [ ] **Step 3: Extend the integration test**

Append two tests inside the same `describe` (they continue the shared `ctx` flow from Task 4 — DOB + guardian submit have run, so an OTP nonce exists in Redis). `redis` is already imported at the top of the file (Task 4 Step 4).

```ts
// append inside the describe in u18_capture.integration.test.ts
it('verify with the correct OTP writes guardian terms/privacy and flips verified', async () => {
  const otp = await redis.get(`guardian_otp:code:${ctx.userId}:guardian`);
  expect(otp).toMatch(/^\d{6}$/);

  const res = await ctx.app.inject({
    method: 'POST', url: '/api/v1/consent/u18/guardian/verify',
    headers: { 'x-api-key': ctx.rawKey },
    payload: { network: ctx.network, otp },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().verified).toBe(true);

  const cats = (await db.select({ c: consent_record.consentCategory, s: consent_record.source })
    .from(consent_record).where(eq(consent_record.userId, ctx.userId)))
    .filter((r) => r.s === 'guardian').map((r) => r.c).sort();
  expect(cats).toEqual(['privacy', 'terms']);

  const [g] = await db.select().from(minor_guardian).where(eq(minor_guardian.userId, ctx.userId));
  expect(g.guardianVerified).toBe(true);
});

it('rejects a wrong OTP with 400', async () => {
  // Nonce was consumed by the previous (successful) verify → no valid code.
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/v1/consent/u18/guardian/verify',
    headers: { 'x-api-key': ctx.rawKey },
    payload: { network: ctx.network, otp: '000000' },
  });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 4: Run the full U18 capture integration file + typecheck**

Run: `pnpm --filter api test:integration src/routes/v1/consent/__tests__/u18_capture.integration.test.ts`
Expected: PASS (4 tests — DOB, guardian submit, verify-success, verify-wrong). Tests share the `uid` and run in file order.
Run: `pnpm --filter api exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/consent/u18_guardian_verify.ts apps/api/src/routes/v1/consent/consent_routes.ts apps/api/src/routes/v1/consent/__tests__/u18_capture.integration.test.ts
git commit -m "feat(u18): guardian OTP verify route (throttle + guardian terms/privacy rows)"
```

---

## Phase 4 exit criteria

- Three endpoints live under `/api/v1/consent/u18/*`, registered, authenticated.
- DOB persists to `minor_guardian`; `isMinor` returned server-side.
- Guardian details stored **encrypted**; `guardian_declaration` row written (`source='self'`, u18); guardian OTP issued (rate-limited; hard-fails `503` with no provider).
- Verify throttled; correct OTP → `terms`+`privacy` guardian rows (`source='guardian'`, u18) + `guardian_verified=true`; wrong OTP → `400`.
- All unit + integration tests green; `pnpm --filter api exec tsc --noEmit` clean.

## Self-review notes

- **Spec coverage:** D1 DOB-at-first-login capture → Task 4 (`/u18/dob`); D5 encrypted guardian PII → Tasks 1–2; D12 ward guardian_declaration row → Task 4; D13 guardian gives terms/privacy → Task 5 (profile_creation + actions deferred to Phase 5 gates, where item/action context lives); D14 + Phase-3 carry-forward verify-attempt throttle → Task 2/Task 5. `guardian_consent_required` domain gating + profile go-live/action refusal = **Phase 5** (not here) — Phase 4 records, Phase 5 enforces.
- **No placeholders:** every route/handler/test is concrete. The one soft spot is the Task 4 test helper extraction from `consent.integration.test.ts` — the note directs the implementer to reuse that file's existing auth stub + seed/cleanup rather than invent one; the implementer must read that file (it is the authoritative harness).
- **Type consistency:** `guardianOtpScope(userId)` is defined in `u18_guardian.ts` and imported by the verify route (same key the OTP was stored under — `guardian_otp:code:${scope}`); `variant:'u18'`, `source` values, and category strings match Phases 2–3 exactly. `GuardianOtpError` code union gains `'VERIFY_THROTTLED'` in Task 2 and is handled in Task 5.
- **DB safety:** DOB upsert uses `onConflictDoUpdate` (idempotent re-submit); guardian rows are append-only like the adult path. Integration tests clean up their `uid` rows in `afterAll`.
