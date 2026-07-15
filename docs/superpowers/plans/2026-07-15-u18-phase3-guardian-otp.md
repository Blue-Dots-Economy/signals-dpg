# U18 Phase 3 — Guardian OTP Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone guardian-OTP primitive — issue a short-lived OTP to a guardian's contact, verify it, rate-limited — separate from the login OTP (which verifies the user's own contact). Later phases call it to gate guardian consent.

**Architecture:** A `guardian_otp` service backed by Redis (ioredis via `@api/db/secondary/redis`): `issueGuardianOtp` generates a 6-digit code, enforces a per-scope rate limit, stores the code under a scoped key with a short TTL, and dispatches it via a **send seam**; `verifyGuardianOtp` compares + consumes the code. The send seam is an injectable function so the core is testable without the notification service; a default adapter maps the guardian's contact type to a notification channel and calls the shared notification client (hard-failing when no provider is configured). Concrete OTP message templates are **out of scope — deferred to #9**; this phase wires the channel selection + a placeholder template id.

**Tech Stack:** TypeScript (ESM, strict), ioredis, `@dpg/notification` client, Vitest.

## Global Constraints

- ESM only, strict TS, no `any`; `import type` for type-only imports.
- Guardian OTP is its **own** primitive (spec D14) — do NOT reuse or modify the better-auth `unified_otp` login flow.
- OTP is an SMS/email-bomb vector → **rate-limited**, **short-TTL** nonces (spec §6).
- Channel = the guardian's contact type: `phone → sms`, `email → email` (spec D7). Only email + phone exist; **do not** add WhatsApp.
- No provider configured for the channel → **hard-fail** (`NO_OTP_PROVIDER`); do not silently skip verification on a guardian-required domain (spec §6 recommendation).
- Concrete message templates are **deferred to #9** — use the named placeholder constants; do not invent final copy.
- Run one API test file: `pnpm --filter api exec vitest run <path>`.

---

### Task 1: OTP core — generate, store, verify, rate-limit

**Files:**
- Create: `apps/api/src/services/guardian_otp.ts`
- Test: `apps/api/src/services/__tests__/guardian_otp.test.ts`

**Interfaces:**
- Consumes: `redis` from `@api/db/secondary/redis` (ioredis: `get`, `set(key, val, 'EX', sec)`, `del`, `incr`, `expire`).
- Produces:
  - `class GuardianOtpError extends Error` with `code: 'RATE_LIMITED' | 'NO_OTP_PROVIDER'`.
  - `type GuardianContactType = 'phone' | 'email'`.
  - `type OtpSend = (args: { contact: string; contactType: GuardianContactType; otp: string }) => Promise<void>`.
  - `issueGuardianOtp(args: { scope: string; contact: string; contactType: GuardianContactType; send: OtpSend }): Promise<void>` — rate-limits, stores, sends.
  - `verifyGuardianOtp(args: { scope: string; otp: string }): Promise<boolean>` — compares + consumes on match.
  - Exported constants: `GUARDIAN_OTP_TTL_SEC = 300`, `GUARDIAN_OTP_MAX_PER_WINDOW = 3`, `GUARDIAN_OTP_WINDOW_SEC = 300`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/__tests__/guardian_otp.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
    return 'OK';
  }),
  del: vi.fn(async (k: string) => {
    store.delete(k);
    return 1;
  }),
  incr: vi.fn(async (k: string) => {
    const n = Number(store.get(k) ?? '0') + 1;
    store.set(k, String(n));
    return n;
  }),
  expire: vi.fn(async () => 1),
};
vi.mock('@api/db/secondary/redis', () => ({ redis: redisMock }));

import {
  issueGuardianOtp,
  verifyGuardianOtp,
  GuardianOtpError,
  GUARDIAN_OTP_MAX_PER_WINDOW,
} from '@/services/guardian_otp';

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('guardian OTP core', () => {
  it('issues: stores a 6-digit code and sends it to the contact', async () => {
    const send = vi.fn(async () => {});
    await issueGuardianOtp({ scope: 'u1', contact: '+911', contactType: 'phone', send });
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg.contact).toBe('+911');
    expect(arg.contactType).toBe('phone');
    expect(arg.otp).toMatch(/^\d{6}$/);
  });

  it('verifies the issued code and consumes it (single-use)', async () => {
    let sent = '';
    const send = vi.fn(async (a: { otp: string }) => {
      sent = a.otp;
    });
    await issueGuardianOtp({ scope: 'u1', contact: 'a@b.co', contactType: 'email', send });
    expect(await verifyGuardianOtp({ scope: 'u1', otp: sent })).toBe(true);
    // consumed → second verify fails
    expect(await verifyGuardianOtp({ scope: 'u1', otp: sent })).toBe(false);
  });

  it('rejects a wrong or missing code', async () => {
    const send = vi.fn(async () => {});
    await issueGuardianOtp({ scope: 'u1', contact: 'a@b.co', contactType: 'email', send });
    expect(await verifyGuardianOtp({ scope: 'u1', otp: '000000' })).toBe(false);
    expect(await verifyGuardianOtp({ scope: 'other', otp: '000000' })).toBe(false);
  });

  it('rate-limits: throws RATE_LIMITED after the window max, without sending', async () => {
    const send = vi.fn(async () => {});
    for (let i = 0; i < GUARDIAN_OTP_MAX_PER_WINDOW; i++) {
      await issueGuardianOtp({ scope: 'u1', contact: 'a@b.co', contactType: 'email', send });
    }
    const sendsBefore = send.mock.calls.length;
    await expect(
      issueGuardianOtp({ scope: 'u1', contact: 'a@b.co', contactType: 'email', send }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(send.mock.calls.length).toBe(sendsBefore); // no extra send
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter api exec vitest run src/services/__tests__/guardian_otp.test.ts`
Expected: FAIL — `@/services/guardian_otp` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/guardian_otp.ts
import { randomInt } from 'node:crypto';
import { redis } from '@api/db/secondary/redis';

/** Codes the primitive raises; callers map these to HTTP responses. */
export class GuardianOtpError extends Error {
  constructor(public code: 'RATE_LIMITED' | 'NO_OTP_PROVIDER') {
    super(code);
    this.name = 'GuardianOtpError';
  }
}

export type GuardianContactType = 'phone' | 'email';

/** Dispatch seam — injected so the core is testable without the notifier. */
export type OtpSend = (args: {
  contact: string;
  contactType: GuardianContactType;
  otp: string;
}) => Promise<void>;

export const GUARDIAN_OTP_TTL_SEC = 300; // nonce lifetime (5 min)
export const GUARDIAN_OTP_MAX_PER_WINDOW = 3; // sends allowed per window
export const GUARDIAN_OTP_WINDOW_SEC = 300; // rate-limit window (5 min)

const codeKey = (scope: string) => `guardian_otp:code:${scope}`;
const rateKey = (scope: string) => `guardian_otp:rl:${scope}`;

function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Issue a guardian OTP for `scope` (e.g. a user id + purpose): rate-limit,
 * store the nonce with a short TTL, dispatch via `send`. Throws
 * `GuardianOtpError('RATE_LIMITED')` before sending when the window max is hit.
 */
export async function issueGuardianOtp(args: {
  scope: string;
  contact: string;
  contactType: GuardianContactType;
  send: OtpSend;
}): Promise<void> {
  const rk = rateKey(args.scope);
  const count = await redis.incr(rk);
  if (count === 1) {
    await redis.expire(rk, GUARDIAN_OTP_WINDOW_SEC);
  }
  if (count > GUARDIAN_OTP_MAX_PER_WINDOW) {
    throw new GuardianOtpError('RATE_LIMITED');
  }

  const otp = generateOtp();
  await redis.set(codeKey(args.scope), otp, 'EX', GUARDIAN_OTP_TTL_SEC);
  await args.send({ contact: args.contact, contactType: args.contactType, otp });
}

/**
 * Verify + consume a guardian OTP. Single-use: a correct code is deleted so it
 * cannot be replayed. Returns false for wrong/expired/missing codes.
 */
export async function verifyGuardianOtp(args: {
  scope: string;
  otp: string;
}): Promise<boolean> {
  const expected = await redis.get(codeKey(args.scope));
  if (expected && expected === args.otp) {
    await redis.del(codeKey(args.scope));
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter api exec vitest run src/services/__tests__/guardian_otp.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/guardian_otp.ts apps/api/src/services/__tests__/guardian_otp.test.ts
git commit -m "feat(u18): guardian OTP core — generate, store, verify, rate-limit"
```

---

### Task 2: Default send adapter (channel by contact type)

**Files:**
- Modify: `apps/api/src/services/guardian_otp.ts` (add the default send adapter + default it in `issueGuardianOtp`)
- Test: `apps/api/src/services/__tests__/guardian_otp_send.test.ts`

**Interfaces:**
- Consumes: `getNotificationClient` from `@/utils/notificationClient` (returns a client with `notify(payload)` or `undefined` when unconfigured).
- Produces: `defaultGuardianOtpSend: OtpSend` — maps `phone → 'sms'`, `email → 'email'`, calls `client.notify(...)`; throws `GuardianOtpError('NO_OTP_PROVIDER')` when no client. `issueGuardianOtp`'s `send` becomes **optional**, defaulting to `defaultGuardianOtpSend`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/__tests__/guardian_otp_send.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const notify = vi.fn(async () => {});
const getNotificationClient = vi.fn<() => { notify: typeof notify } | undefined>();
vi.mock('@/utils/notificationClient', () => ({
  getNotificationClient: () => getNotificationClient(),
}));

import { defaultGuardianOtpSend, GuardianOtpError } from '@/services/guardian_otp';

beforeEach(() => {
  vi.clearAllMocks();
  getNotificationClient.mockReturnValue({ notify });
});

describe('defaultGuardianOtpSend', () => {
  it('sends a phone OTP over the sms channel to the contact', async () => {
    await defaultGuardianOtpSend({ contact: '+911', contactType: 'phone', otp: '123456' });
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0][0] as { channel: string; to: string; variables: { otp: string } };
    expect(payload.channel).toBe('sms');
    expect(payload.to).toBe('+911');
    expect(payload.variables.otp).toBe('123456');
  });

  it('sends an email OTP over the email channel', async () => {
    await defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '123456' });
    const payload = notify.mock.calls[0][0] as { channel: string; to: string };
    expect(payload.channel).toBe('email');
    expect(payload.to).toBe('a@b.co');
  });

  it('hard-fails with NO_OTP_PROVIDER when no client is configured', async () => {
    getNotificationClient.mockReturnValue(undefined);
    await expect(
      defaultGuardianOtpSend({ contact: 'a@b.co', contactType: 'email', otp: '123456' }),
    ).rejects.toBeInstanceOf(GuardianOtpError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/__tests__/guardian_otp_send.test.ts`
Expected: FAIL — `defaultGuardianOtpSend` is not exported.

- [ ] **Step 3: Add the default send adapter**

Append to `apps/api/src/services/guardian_otp.ts`:

```ts
import { getNotificationClient } from '@/utils/notificationClient';

// Notification channel per guardian contact type (spec D7). WhatsApp is not
// wired — do not add it here.
const CHANNEL_BY_CONTACT_TYPE: Record<GuardianContactType, 'sms' | 'email'> = {
  phone: 'sms',
  email: 'email',
};

// TODO(#9): finalize ONEST guardian-OTP templates. Placeholder ids until then.
const GUARDIAN_OTP_TEMPLATE_ID: Record<'sms' | 'email', string> = {
  sms: 'guardian_otp_sms',
  email: 'guardian_otp_email',
};

/**
 * Default dispatch: pick the channel from the guardian's contact type and send
 * via the shared notification client. Hard-fails when no provider is
 * configured — a guardian-required domain must not silently skip verification.
 */
export const defaultGuardianOtpSend: OtpSend = async ({ contact, contactType, otp }) => {
  const client = getNotificationClient();
  if (!client) {
    throw new GuardianOtpError('NO_OTP_PROVIDER');
  }
  const channel = CHANNEL_BY_CONTACT_TYPE[contactType];
  await client.notify({
    channel,
    template_id: GUARDIAN_OTP_TEMPLATE_ID[channel],
    to: contact,
    priority: 'realtime',
    variables: { otp },
  });
};
```

Then make `send` optional in `issueGuardianOtp` — change its signature and the call:

```ts
export async function issueGuardianOtp(args: {
  scope: string;
  contact: string;
  contactType: GuardianContactType;
  send?: OtpSend;
}): Promise<void> {
```
and near the end, replace `await args.send({...})` with:
```ts
  const send = args.send ?? defaultGuardianOtpSend;
  await send({ contact: args.contact, contactType: args.contactType, otp });
```

- [ ] **Step 4: Run both OTP test files to verify green**

Run: `pnpm --filter api exec vitest run src/services/__tests__/guardian_otp.test.ts src/services/__tests__/guardian_otp_send.test.ts`
Expected: PASS (7 tests total — Task 1's 4 still pass with the now-optional `send`, Task 2's 3 pass).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: exit 0. If `client.notify(...)`'s payload type (`NotifyRequest`) rejects `channel: 'sms'` or the `variables` shape, adjust to satisfy the exported type from `@dpg/notification` — do not cast with `any`; if the channel union genuinely lacks `'sms'`, STOP and report it (it means the notifier doesn't support SMS yet, a real dependency gap for #9).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/guardian_otp.ts apps/api/src/services/__tests__/guardian_otp_send.test.ts
git commit -m "feat(u18): default guardian-OTP send adapter (channel by contact type)"
```

---

## Phase 3 exit criteria

- `issueGuardianOtp` / `verifyGuardianOtp` work against Redis: single-use codes, short TTL, per-scope rate limit that throws before sending.
- `defaultGuardianOtpSend` maps phone→sms / email→email and hard-fails `NO_OTP_PROVIDER` with no client.
- `issueGuardianOtp` defaults to the real adapter but accepts an injected `send` (used by tests + callers).
- `pnpm --filter api exec tsc --noEmit` clean.

## Self-review notes

- **Spec coverage:** D14 (own primitive, separate from login OTP) → whole phase; §6 rate-limit + short-TTL nonce → Task 1; D7 channel-by-contact-type + §6 no-provider hard-block → Task 2. Wiring OTP into guardian capture + writing the `guardian`-source consent rows is **Phase 4**, not here. HTTP route (issue/verify endpoints) is folded into Phase 4 where the request shape (scope from the authenticated ward + guardian record) is known — Phase 3 is the reusable service.
- **No placeholders that are plan gaps:** the `template_id` constants are intentionally provisional and flagged `TODO(#9)` per spec §13 — this is spec-deferred content, not an incomplete step. Every code/command step is concrete.
- **Type consistency:** `GuardianContactType`, `OtpSend`, `GuardianOtpError` codes, and the `guardian_otp:code:` / `guardian_otp:rl:` key prefixes are spelled identically across impl and tests. `send` is introduced required in Task 1 then widened to optional in Task 2 — Task 1's tests pass an explicit `send`, so they remain green.
- **Rate-limit note:** the limit is keyed per `scope`; Phase 4 chooses the scope granularity (per-user vs per-action). `incr`+`expire` is a standard fixed-window limiter — acceptable for an anti-abuse guard (not a precise SLA).
