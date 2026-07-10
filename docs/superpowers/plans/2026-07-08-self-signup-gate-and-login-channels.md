# Self-signup gate & configurable login channels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two instance-level auth config flags — gate self-service signup (default gated) and restrict allowed login channels (email / phone / both) — enforced authoritatively in the `unified_otp` plugin and surfaced to the UI.

**Architecture:** Env vars parsed in `@dpg/config` → exposed via `apps/api` `authConfig` → passed through `createAuth` into the `unified_otp` plugin, which calls pure guard helpers to reject disallowed channels and gated new-user creation. A public `GET /api/v1/auth/config` endpoint mirrors the flags to the UI (server env stays the single source of truth). The UI blocks unknown identifiers on the first `check-user` call and renders only allowed channel inputs.

**Tech Stack:** TypeScript (ESM), Zod, Fastify + `fastify-type-provider-zod`, better-auth (custom `unified_otp` plugin), React 19 + Vite, Vitest, `@testing-library/react`.

## Global Constraints

- ESM only, strict TS, no `any`. Use `import type` for type-only imports.
- Files are snake_case; route handler exports snake_case; Zod schemas PascalCase.
- Routes never throw — return `reply.code(N).send({ error, message })`; the auth plugin throws `APIError` (better-auth converts it to an HTTP response).
- New env vars require TWO changes: the Zod schema in `packages/config/src/secrets.ts` AND `turbo.json` `globalPassThroughEnv`.
- Default `SELF_SIGNUP_MODE=gated`; default `LOGIN_CHANNELS=email,phone`.
- Error codes: `SELF_SIGNUP_DISABLED` (HTTP 403), `LOGIN_CHANNEL_DISABLED` (HTTP 400).
- Admin-domain emails (domain ∈ `ADMIN_DOMAINS`) are exempt from the self-signup gate (admin bootstrap).
- Node `>=24`, `pnpm@11.1.2`. Run commands via `pnpm --filter <pkg>`.

---

## File Structure

- `packages/config/src/login_channels.ts` — **create.** `LoginChannel` type + `parseLoginChannels()`.
- `packages/config/src/secrets.ts` — **modify.** Add `SELF_SIGNUP_MODE`, `LOGIN_CHANNELS` to `AuthSecretsSchema`.
- `packages/config/src/index.ts` — **modify.** Export `login_channels`.
- `turbo.json` — **modify.** Add both env vars to `globalPassThroughEnv`.
- `packages/auth/plugins/auth_guards.ts` — **create.** Pure guards: `assertChannelAllowed`, `isAdminDomainEmail`, `assertSelfSignupAllowed`.
- `packages/auth/plugins/unified_otp.ts` — **modify.** Add options `allowSelfSignup`, `loginChannels`; call guards in `checkUser`, `requestOtp`, `verifyOtp`.
- `packages/auth/src/types.d.ts` — **modify.** Add fields to `AuthRuntimeConfig`.
- `packages/auth/src/config.ts` — **modify.** Forward new fields into `unifiedOtp({...})`.
- `apps/api/src/config.ts` — **modify.** `authConfig` gains `allow_self_signup`, `login_channels`.
- `apps/api/src/routes/auth/create_auth.ts` — **modify.** Pass the two fields into `createAuth`.
- `apps/api/src/routes/v1/auth/auth_config.ts` — **create.** `GET /config` route plugin.
- `apps/api/src/routes/v1/v1_routes.ts` — **modify.** Register the auth router at prefix `/auth`.
- `apps/ui/src/lib/auth-api.ts` — **modify.** Add `LoginChannel`, `AuthConfigResponse`, `fetchAuthConfig()`.
- `apps/ui/src/pages/auth/login-page.tsx` — **modify.** Fetch config; render allowed channels; block gated unknown identifier.
- `.env.example`, `SETUP.md` — **modify.** Document both flags + the gated default.

---

### Task 1: Config — `parseLoginChannels` + auth secrets + turbo passthrough

**Files:**
- Create: `packages/config/src/login_channels.ts`
- Modify: `packages/config/src/secrets.ts` (`AuthSecretsSchema`)
- Modify: `packages/config/src/index.ts`
- Modify: `turbo.json`
- Test: `packages/config/src/__tests__/login_channels.test.ts`

**Interfaces:**
- Produces: `type LoginChannel = 'email' | 'phone'`; `parseLoginChannels(input: string): LoginChannel[]`.
- Produces (schema): `AuthSecretsSchema` gains `SELF_SIGNUP_MODE: 'gated' | 'allowed'` (default `'gated'`) and `LOGIN_CHANNELS: string` (default `'email,phone'`).

- [ ] **Step 1: Write the failing test**

Create `packages/config/src/__tests__/login_channels.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseLoginChannels } from '../login_channels';

describe('parseLoginChannels', () => {
  it('parses both channels', () => {
    expect(parseLoginChannels('email,phone')).toEqual(['email', 'phone']);
  });

  it('parses a single channel', () => {
    expect(parseLoginChannels('phone')).toEqual(['phone']);
    expect(parseLoginChannels('email')).toEqual(['email']);
  });

  it('trims whitespace and lowercases', () => {
    expect(parseLoginChannels(' Email , PHONE ')).toEqual(['email', 'phone']);
  });

  it('de-duplicates', () => {
    expect(parseLoginChannels('phone,phone,email')).toEqual(['phone', 'email']);
  });

  it('throws on an unknown channel', () => {
    expect(() => parseLoginChannels('email,sms')).toThrow(/Invalid LOGIN_CHANNELS/);
  });

  it('throws when empty', () => {
    expect(() => parseLoginChannels('')).toThrow(/at least one/);
    expect(() => parseLoginChannels('  ,  ')).toThrow(/at least one/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dpg/config exec vitest run src/__tests__/login_channels.test.ts`
Expected: FAIL — cannot find module `../login_channels`.

- [ ] **Step 3: Create the helper**

Create `packages/config/src/login_channels.ts`:

```ts
export type LoginChannel = 'email' | 'phone';

/**
 * Parses the LOGIN_CHANNELS env value into the ordered, de-duplicated set of
 * allowed login identifier channels. Accepts a comma-separated list of
 * `email` / `phone` (any case, whitespace tolerated). Throws on an unknown
 * entry or an empty result so a misconfiguration fails fast at boot.
 */
export function parseLoginChannels(input: string): LoginChannel[] {
  const seen = new Set<LoginChannel>();
  const result: LoginChannel[] = [];

  for (const raw of input.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry !== 'email' && entry !== 'phone') {
      throw new Error(
        `Invalid LOGIN_CHANNELS entry "${entry}". Allowed values: email, phone.`
      );
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }

  if (result.length === 0) {
    throw new Error('LOGIN_CHANNELS must include at least one of: email, phone.');
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dpg/config exec vitest run src/__tests__/login_channels.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the two env vars to `AuthSecretsSchema`**

In `packages/config/src/secrets.ts`, extend `AuthSecretsSchema` (add after `CREATE_TEST_OTP`):

```ts
export const AuthSecretsSchema = z.object({
  AUTH_SECRET: z.string().min(8),
  AUTH_MIDDLEWARE_ENABLED: z
    .string()
    .default('true')
    .transform((val) => val === 'true'),
  CREATE_TEST_OTP: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
  // Self-signup gate (#105). Default 'gated': the public OTP flow will not
  // create new accounts (participants are onboarded via /admin/participant).
  // Set to 'allowed' to keep self-service registration.
  SELF_SIGNUP_MODE: z.enum(['gated', 'allowed']).default('gated'),
  // Allowed login identifier channels, comma-separated (email / phone).
  // Parsed by parseLoginChannels(). Default: both.
  LOGIN_CHANNELS: z.string().default('email,phone'),
});
```

- [ ] **Step 6: Export the helper**

In `packages/config/src/index.ts`, add:

```ts
export * from './login_channels';
```

- [ ] **Step 7: Add both vars to `turbo.json` passthrough**

In `turbo.json`, add `"SELF_SIGNUP_MODE"` and `"LOGIN_CHANNELS"` to the `globalPassThroughEnv` array (keep alphabetical if the array is sorted).

- [ ] **Step 8: Typecheck + full config tests**

Run: `pnpm --filter @dpg/config exec vitest run`
Expected: PASS (new + existing tests).

- [ ] **Step 9: Commit**

```bash
git add packages/config/src/login_channels.ts packages/config/src/secrets.ts packages/config/src/index.ts packages/config/src/__tests__/login_channels.test.ts turbo.json
git commit -m "feat(config): add SELF_SIGNUP_MODE + LOGIN_CHANNELS auth flags"
```

---

### Task 2: Auth guards (pure enforcement helpers)

**Files:**
- Create: `packages/auth/plugins/auth_guards.ts`
- Test: `packages/auth/plugins/__tests__/auth_guards.test.ts`

**Interfaces:**
- Consumes: `APIError` from `better-auth/api`.
- Produces:
  - `type LoginChannel = 'email' | 'phone'`
  - `assertChannelAllowed(identifier: { email?: string | null; phoneNumber?: string | null }, loginChannels: LoginChannel[]): void` — throws `APIError` (400, code `LOGIN_CHANNEL_DISABLED`) if the identifier uses a disallowed channel.
  - `isAdminDomainEmail(email: string | null | undefined, adminByDomain: string[] | undefined): boolean`
  - `assertSelfSignupAllowed(args: { allowSelfSignup: boolean; email: string | null | undefined; adminByDomain: string[] | undefined }): void` — throws `APIError` (403, code `SELF_SIGNUP_DISABLED`) when signup is gated and the email is not an admin-domain email.

- [ ] **Step 1: Write the failing test**

Create `packages/auth/plugins/__tests__/auth_guards.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  assertChannelAllowed,
  assertSelfSignupAllowed,
  isAdminDomainEmail,
} from '../auth_guards';

describe('assertChannelAllowed', () => {
  it('allows phone when phone is enabled', () => {
    expect(() => assertChannelAllowed({ phoneNumber: '+911234567890' }, ['phone'])).not.toThrow();
  });

  it('rejects phone when only email is enabled', () => {
    expect(() => assertChannelAllowed({ phoneNumber: '+911234567890' }, ['email'])).toThrow(
      /Phone login is not enabled/
    );
  });

  it('rejects email when only phone is enabled', () => {
    expect(() => assertChannelAllowed({ email: 'a@b.com' }, ['phone'])).toThrow(
      /Email login is not enabled/
    );
  });

  it('allows either when both enabled', () => {
    expect(() => assertChannelAllowed({ email: 'a@b.com' }, ['email', 'phone'])).not.toThrow();
    expect(() => assertChannelAllowed({ phoneNumber: '+911' }, ['email', 'phone'])).not.toThrow();
  });
});

describe('isAdminDomainEmail', () => {
  it('is true when the email domain is in adminByDomain', () => {
    expect(isAdminDomainEmail('x@sahamati.org.in', ['sahamati.org.in'])).toBe(true);
  });
  it('is false for a non-admin domain, missing email, or missing list', () => {
    expect(isAdminDomainEmail('x@other.com', ['sahamati.org.in'])).toBe(false);
    expect(isAdminDomainEmail(null, ['sahamati.org.in'])).toBe(false);
    expect(isAdminDomainEmail('x@a.com', undefined)).toBe(false);
  });
});

describe('assertSelfSignupAllowed', () => {
  it('passes when self-signup is allowed', () => {
    expect(() =>
      assertSelfSignupAllowed({ allowSelfSignup: true, email: 'x@y.com', adminByDomain: [] })
    ).not.toThrow();
  });

  it('throws SELF_SIGNUP_DISABLED when gated and not admin-domain', () => {
    expect(() =>
      assertSelfSignupAllowed({ allowSelfSignup: false, email: 'x@y.com', adminByDomain: ['admin.com'] })
    ).toThrow(/Self sign-up is disabled/);
  });

  it('exempts admin-domain emails even when gated', () => {
    expect(() =>
      assertSelfSignupAllowed({ allowSelfSignup: false, email: 'x@admin.com', adminByDomain: ['admin.com'] })
    ).not.toThrow();
  });

  it('throws when gated and identifier is phone-only (no email to exempt)', () => {
    expect(() =>
      assertSelfSignupAllowed({ allowSelfSignup: false, email: null, adminByDomain: ['admin.com'] })
    ).toThrow(/Self sign-up is disabled/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dpg/auth exec vitest run plugins/__tests__/auth_guards.test.ts`
Expected: FAIL — cannot find module `../auth_guards`.

- [ ] **Step 3: Create the guards**

Create `packages/auth/plugins/auth_guards.ts`:

```ts
import { APIError } from 'better-auth/api';

export type LoginChannel = 'email' | 'phone';

/**
 * Rejects a request whose identifier channel is not enabled for this instance.
 * Applied at the top of the OTP endpoints so a disallowed channel is blocked
 * before any OTP is generated.
 */
export function assertChannelAllowed(
  identifier: { email?: string | null; phoneNumber?: string | null },
  loginChannels: LoginChannel[]
): void {
  if (identifier.phoneNumber && !loginChannels.includes('phone')) {
    throw new APIError('BAD_REQUEST', {
      message: 'Phone login is not enabled on this instance.',
      code: 'LOGIN_CHANNEL_DISABLED',
    });
  }
  if (identifier.email && !loginChannels.includes('email')) {
    throw new APIError('BAD_REQUEST', {
      message: 'Email login is not enabled on this instance.',
      code: 'LOGIN_CHANNEL_DISABLED',
    });
  }
}

/** True when the email's domain is one of the configured admin domains. */
export function isAdminDomainEmail(
  email: string | null | undefined,
  adminByDomain: string[] | undefined
): boolean {
  if (!email || !Array.isArray(adminByDomain)) return false;
  const domain = email.split('@')[1];
  return !!domain && adminByDomain.includes(domain);
}

/**
 * Authoritative self-signup gate. When signup is gated, refuses new-user
 * creation unless the identifier is an admin-domain email (admin bootstrap).
 * Called at the point new-user creation would occur (requestOtp + verifyOtp).
 */
export function assertSelfSignupAllowed(args: {
  allowSelfSignup: boolean;
  email: string | null | undefined;
  adminByDomain: string[] | undefined;
}): void {
  if (args.allowSelfSignup) return;
  if (isAdminDomainEmail(args.email, args.adminByDomain)) return;
  throw new APIError('FORBIDDEN', {
    message:
      'Self sign-up is disabled on this instance. Contact your aggregator to get onboarded.',
    code: 'SELF_SIGNUP_DISABLED',
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dpg/auth exec vitest run plugins/__tests__/auth_guards.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/auth/plugins/auth_guards.ts packages/auth/plugins/__tests__/auth_guards.test.ts
git commit -m "feat(auth): add channel + self-signup guard helpers"
```

---

### Task 3: Wire flags through auth and enforce in `unified_otp`

**Files:**
- Modify: `packages/auth/plugins/unified_otp.ts`
- Modify: `packages/auth/src/types.d.ts`
- Modify: `packages/auth/src/config.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/routes/auth/create_auth.ts`

**Interfaces:**
- Consumes: `assertChannelAllowed`, `assertSelfSignupAllowed`, `LoginChannel` from `./auth_guards`; `parseLoginChannels` from `@dpg/config`.
- Produces: `unifiedOtpOptions` gains `allowSelfSignup: boolean` and `loginChannels: LoginChannel[]`; `AuthRuntimeConfig` gains `allowSelfSignup: boolean` and `loginChannels: ('email' | 'phone')[]`; `authConfig` gains `allow_self_signup: boolean` and `login_channels: LoginChannel[]`.

- [ ] **Step 1: Add options to `unifiedOtpOptions` and destructure them**

In `packages/auth/plugins/unified_otp.ts`:

Add the import at the top:
```ts
import { assertChannelAllowed, assertSelfSignupAllowed, type LoginChannel } from './auth_guards';
```

Extend the `unifiedOtpOptions` interface (add fields):
```ts
  /** When false, the OTP flow refuses to create new users (self-signup gated). */
  allowSelfSignup: boolean;
  /** Allowed login identifier channels for this instance. */
  loginChannels: LoginChannel[];
```

Update the destructure in `export const unifiedOtp = ({ ... })`:
```ts
export const unifiedOtp = ({
  sendPhoneOtp,
  sendEmailOtp,
  afterUserCreate,
  adminByDomain,
  createTestOtp,
  allowSelfSignup,
  loginChannels,
}: unifiedOtpOptions): BetterAuthPlugin => ({
```

- [ ] **Step 2: Enforce channel guard in `checkUser` and `requestOtp`; self-signup guard in `requestOtp`**

In the `checkUser` handler, immediately after the `const { email, phoneNumber } = validator.data;` line, add:
```ts
        assertChannelAllowed({ email, phoneNumber }, loginChannels);
```

In the `requestOtp` handler, after `const { email, phoneNumber } = validator.data;`, add:
```ts
        assertChannelAllowed({ email, phoneNumber }, loginChannels);
```

Still in `requestOtp`, after the block that resolves `user` (the two `findOne` lookups) and before `const otp = generateOtp(...)`, add the early-exit gate so no OTP is sent to an unknown identifier when gated:
```ts
        if (!user) {
          // Defense-in-depth for direct callers that skip check-user; also
          // prevents OTP-send abuse to arbitrary unknown identifiers.
          assertSelfSignupAllowed({ allowSelfSignup, email, adminByDomain });
        }
```

- [ ] **Step 3: Enforce channel + authoritative self-signup guard in `verifyOtp`**

In the `verifyOtp` handler, after destructuring `validator.data` and the existing `if (!email && !phoneNumber)` check, add the channel guard:
```ts
        assertChannelAllowed({ email, phoneNumber }, loginChannels);
```

Then locate the existing `if (!user) {` block (where `isNewUser = true` and `adapter.create` run). Insert the gate as the FIRST statement inside that block, before `isNewUser = true`:
```ts
        if (!user) {
          // Authoritative self-signup gate — runs regardless of caller.
          assertSelfSignupAllowed({ allowSelfSignup, email, adminByDomain });

          isNewUser = true;
          // ... existing admin-domain + adapter.create logic unchanged ...
```

- [ ] **Step 4: Add fields to `AuthRuntimeConfig`**

In `packages/auth/src/types.d.ts`, add to the `AuthRuntimeConfig` interface:
```ts
  allowSelfSignup: boolean;
  loginChannels: ('email' | 'phone')[];
```

- [ ] **Step 5: Forward fields into `unifiedOtp` from `createAuth`**

In `packages/auth/src/config.ts`, inside the `unifiedOtp({ ... })` call, add the two fields (alongside `adminByDomain` / `createTestOtp`):
```ts
      unifiedOtp({
        adminByDomain: config.adminDomains,
        allowSelfSignup: config.allowSelfSignup,
        loginChannels: config.loginChannels,
        // ... existing sendPhoneOtp / sendEmailOtp / afterUserCreate / createTestOtp ...
```

- [ ] **Step 6: Expose derived values in `authConfig`**

In `apps/api/src/config.ts`:

Add `parseLoginChannels` to the existing `@dpg/config` import:
```ts
import { assertCreateTestOtpSafe, parseServedDomains, parseLoginChannels } from '@dpg/config';
```

Extend the `authConfig` object:
```ts
export const authConfig = {
  secret: auth.AUTH_SECRET,
  middleware_enabled:
    instance.INSTANCE_ENV === 'development'
      ? auth.AUTH_MIDDLEWARE_ENABLED
      : true,
  url:
    instance.INSTANCE_ENV === 'development'
      ? `${apiConfig.domain}:${apiConfig.port}/api/auth`
      : `${apiConfig.domain}/api/auth`,
  create_test_otp: auth.CREATE_TEST_OTP,
  allow_self_signup: auth.SELF_SIGNUP_MODE === 'allowed',
  login_channels: parseLoginChannels(auth.LOGIN_CHANNELS),
};
```

- [ ] **Step 7: Pass the values into `createAuth`**

In `apps/api/src/routes/auth/create_auth.ts`:

Add `authConfig` to the `@/config` import:
```ts
import { api, instance, auth, notification, authConfig } from '@/config';
```

Add the two fields to the `createAuth({ ... })` call:
```ts
  allowSelfSignup: authConfig.allow_self_signup,
  loginChannels: authConfig.login_channels,
```

- [ ] **Step 8: Typecheck + run auth/config tests**

Run: `pnpm --filter @dpg/auth exec vitest run && pnpm --filter @dpg/config exec vitest run && pnpm typecheck`
Expected: PASS, no type errors. (The guard behaviour is covered by Task 2; this step verifies the wiring compiles and existing tests still pass.)

- [ ] **Step 9: Commit**

```bash
git add packages/auth/plugins/unified_otp.ts packages/auth/src/types.d.ts packages/auth/src/config.ts apps/api/src/config.ts apps/api/src/routes/auth/create_auth.ts
git commit -m "feat(auth): enforce self-signup gate + login-channel restriction in unified OTP"
```

---

### Task 4: Public `GET /api/v1/auth/config` endpoint

**Files:**
- Create: `apps/api/src/routes/v1/auth/auth_config.ts`
- Modify: `apps/api/src/routes/v1/v1_routes.ts`
- Test: `apps/api/src/routes/v1/auth/__tests__/auth_config.test.ts`

**Interfaces:**
- Consumes: `authConfig.allow_self_signup`, `authConfig.login_channels` from `@/config`.
- Produces: `GET /api/v1/auth/config` → `{ selfSignupAllowed: boolean, loginChannels: ('email'|'phone')[] }` (unauthenticated).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/v1/auth/__tests__/auth_config.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

vi.mock('@/config', () => ({
  authConfig: { allow_self_signup: false, login_channels: ['email', 'phone'] },
}));

async function buildApp() {
  const { auth_config } = await import('../auth_config');
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(auth_config, { prefix: '/api/v1/auth' });
  await app.ready();
  return app;
}

describe('GET /api/v1/auth/config', () => {
  beforeEach(() => vi.resetModules());

  it('returns the configured self-signup + channel flags', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ selfSignupAllowed: false, loginChannels: ['email', 'phone'] });
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/auth/__tests__/auth_config.test.ts`
Expected: FAIL — cannot find module `../auth_config`.

- [ ] **Step 3: Create the route plugin**

Create `apps/api/src/routes/v1/auth/auth_config.ts`:

```ts
import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authConfig } from '@/config';

const AuthConfigResponse = z.object({
  selfSignupAllowed: z.boolean(),
  loginChannels: z.array(z.enum(['email', 'phone'])),
});

/**
 * Public, unauthenticated. Surfaces the instance's auth-flow configuration to
 * the UI: whether self-signup is allowed and which login channels are enabled.
 * Server env remains the single source of truth (see apps/api/src/config.ts).
 */
export const auth_config: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/config',
    method: 'GET',
    schema: {
      tags: ['auth'],
      response: { 200: AuthConfigResponse },
    },
    handler: async (_request, reply) => {
      return reply.code(200).send({
        selfSignupAllowed: authConfig.allow_self_signup,
        loginChannels: authConfig.login_channels,
      });
    },
  });
};
```

- [ ] **Step 4: Register the route (public — no auth preHandler)**

In `apps/api/src/routes/v1/v1_routes.ts`, add the import and registration:

```ts
import { auth_config } from '@/routes/v1/auth/auth_config';
```
and inside the plugin body (with the other `fastify.register(...)` calls):
```ts
  fastify.register(auth_config, { prefix: '/auth' });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/v1/auth/__tests__/auth_config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/auth/auth_config.ts apps/api/src/routes/v1/v1_routes.ts apps/api/src/routes/v1/auth/__tests__/auth_config.test.ts
git commit -m "feat(api): add public GET /api/v1/auth/config endpoint"
```

---

### Task 5: UI — fetch config, render allowed channels, gate unknown identifiers

**Files:**
- Modify: `apps/ui/src/lib/auth-api.ts`
- Modify: `apps/ui/src/pages/auth/login-page.tsx`
- Test: `apps/ui/src/lib/__tests__/auth-api.test.ts` (extend)
- Test: `apps/ui/src/pages/auth/__tests__/login-page.test.tsx` (create)

**Interfaces:**
- Consumes: `GET /api/v1/auth/config` (Task 4).
- Produces: `type LoginChannel = 'email' | 'phone'`; `interface AuthConfigResponse { selfSignupAllowed: boolean; loginChannels: LoginChannel[] }`; `fetchAuthConfig(): Promise<AuthConfigResponse>`.

- [ ] **Step 1: Write the failing test for `fetchAuthConfig`**

Add to `apps/ui/src/lib/__tests__/auth-api.test.ts`:

```ts
import { vi } from 'vitest';

describe('fetchAuthConfig', () => {
  it('GETs /api/v1/auth/config and returns the config', async () => {
    vi.resetModules();
    vi.doMock('../api-client', () => ({
      createApiClient: () => ({
        get: vi.fn().mockResolvedValue({
          data: { selfSignupAllowed: false, loginChannels: ['phone'] },
        }),
      }),
    }));
    const { fetchAuthConfig } = await import('../auth-api');
    await expect(fetchAuthConfig()).resolves.toEqual({
      selfSignupAllowed: false,
      loginChannels: ['phone'],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/lib/__tests__/auth-api.test.ts`
Expected: FAIL — `fetchAuthConfig` is not exported.

- [ ] **Step 3: Add `fetchAuthConfig` to `auth-api.ts`**

In `apps/ui/src/lib/auth-api.ts`, add near the other exports:

```ts
export type LoginChannel = 'email' | 'phone';

export interface AuthConfigResponse {
  selfSignupAllowed: boolean;
  loginChannels: LoginChannel[];
}

export async function fetchAuthConfig(): Promise<AuthConfigResponse> {
  const response = await apiClient.get<AuthConfigResponse>('/api/v1/auth/config');
  return response.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/lib/__tests__/auth-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing login-page component test**

Create `apps/ui/src/pages/auth/__tests__/login-page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const checkUser = vi.fn();
const requestOtp = vi.fn();
const fetchAuthConfig = vi.fn();

vi.mock('@/lib/auth-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth-api')>()),
  checkUser: (...a: unknown[]) => checkUser(...a),
  requestOtp: (...a: unknown[]) => requestOtp(...a),
  fetchAuthConfig: () => fetchAuthConfig(),
}));
vi.mock('@/theme/theme-provider', () => ({ useNetworkTheme: () => ({ themeId: 'blue_dot', brand: 'standard' }) }));
vi.mock('@/lib/consent-api', () => ({
  fetchConsentConfigs: vi.fn().mockResolvedValue([]),
  getConsentStatusByIdentifier: vi.fn().mockResolvedValue({ statuses: { terms: [], privacy: [] } }),
}));

async function renderPage() {
  const { LoginPage } = await import('../login-page');
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestOtp.mockResolvedValue({ ok: true, user: false });
  });

  it('renders only the phone input when loginChannels is ["phone"]', async () => {
    fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: true, loginChannels: ['phone'] });
    await renderPage();
    await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /email/i })).toBeNull();
  });

  it('blocks an unknown identifier when self-signup is gated (no OTP requested)', async () => {
    fetchAuthConfig.mockResolvedValue({ selfSignupAllowed: false, loginChannels: ['phone', 'email'] });
    checkUser.mockResolvedValue({ userExists: false });
    await renderPage();
    await waitFor(() => expect(fetchAuthConfig).toHaveBeenCalled());

    await userEvent.type(screen.getByLabelText(/mobile/i), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: /continue|send/i }));

    await waitFor(() => expect(checkUser).toHaveBeenCalled());
    expect(requestOtp).not.toHaveBeenCalled();
    expect(screen.getByText(/contact your aggregator/i)).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/pages/auth/__tests__/login-page.test.tsx`
Expected: FAIL — the config is not fetched, both toggles render, and no gate message exists.

- [ ] **Step 7: Implement the login-page changes**

In `apps/ui/src/pages/auth/login-page.tsx`:

7a. Extend the auth-api import and add config state + fetch:
```ts
import {
  checkUser,
  consentStatusIdentifier,
  fetchAuthConfig,
  isValidPhoneNumber,
  requestOtp,
  type AuthConfigResponse,
  type AuthIdentifier,
  type LoginChannel,
} from '@/lib/auth-api';
```
Add state near the other `useState` calls:
```ts
  const [authCfg, setAuthCfg] = useState<AuthConfigResponse | null>(null);
```
Add an effect to load it (place with the other effects):
```ts
  useEffect(() => {
    fetchAuthConfig()
      .then(setAuthCfg)
      // Fail-safe: assume both channels + gated so the API stays authoritative.
      .catch(() => setAuthCfg({ selfSignupAllowed: false, loginChannels: ['phone', 'email'] }));
  }, []);
```

7b. Derive channels and keep `mode` valid. Replace the `const [mode, setMode] = useState<AuthMode>('phone');` line with a config-derived default via an effect:
```ts
  const channels: LoginChannel[] = authCfg?.loginChannels ?? ['phone', 'email'];
```
After `authCfg` loads, force `mode` to an allowed channel:
```ts
  useEffect(() => {
    if (authCfg && !authCfg.loginChannels.includes(mode)) {
      setMode(authCfg.loginChannels[0]);
    }
  }, [authCfg, mode]);
```

7c. Render the phone/email pill toggle only for allowed channels — replace the `.map(['phone','email'])` toggle block so it iterates `channels`, and hide the toggle entirely when only one channel is allowed:
```tsx
          {channels.length > 1 && (
            <div className="flex rounded-full border border-border bg-muted p-1 text-sm">
              {channels.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => handleModeChange(m)}
                  className={[
                    'flex-1 rounded-full py-1.5 font-medium transition-colors capitalize',
                    mode === m
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  ].join(' ')}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
```

7d. Gate the unknown identifier in `handleSubmit`. Immediately after `const exists = response.userExists;` (and `setUserExists(exists);`), insert:
```ts
      if (!exists && authCfg && !authCfg.selfSignupAllowed) {
        setIsLoading(false);
        toast.error(t('auth.toast_signup_disabled'), {
          description: t('auth.toast_signup_disabled_desc'),
        });
        setSignupBlocked(true);
        return;
      }
```
Add the `signupBlocked` state near the others:
```ts
  const [signupBlocked, setSignupBlocked] = useState(false);
```
And render the message (place above the CTA button in the form):
```tsx
          {signupBlocked && (
            <p className="text-sm text-destructive">
              {t('auth.signup_disabled_message')}
            </p>
          )}
```

7e. Add the i18n keys used above. In the auth section of the UI locale file(s) (search for an existing key such as `auth.toast_one_more_step` to locate the file), add:
```json
"toast_signup_disabled": "Self sign-up is disabled",
"toast_signup_disabled_desc": "Contact your aggregator to get onboarded.",
"signup_disabled_message": "Self sign-up is disabled on this network. Please contact your aggregator to get onboarded."
```

- [ ] **Step 8: Run the login-page + auth-api tests to verify they pass**

Run: `pnpm --filter ui exec vitest run src/pages/auth/__tests__/login-page.test.tsx src/lib/__tests__/auth-api.test.ts`
Expected: PASS. (The gate test asserts `requestOtp` was never called and the message renders.)

- [ ] **Step 9: Typecheck the UI**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/ui/src/lib/auth-api.ts apps/ui/src/pages/auth/login-page.tsx apps/ui/src/lib/__tests__/auth-api.test.ts apps/ui/src/pages/auth/__tests__/login-page.test.tsx
git add apps/ui/src/**/locales apps/ui/src/**/i18n 2>/dev/null || true
git commit -m "feat(ui): channel-aware login form + gated self-signup message"
```

---

### Task 6: Documentation

**Files:**
- Modify: `.env.example`
- Modify: `SETUP.md`

- [ ] **Step 1: Document the flags in `.env.example`**

Add (near the existing auth vars such as `AUTH_MIDDLEWARE_ENABLED` / `CREATE_TEST_OTP`):

```bash
# Self-signup gate (#105). 'gated' (default) blocks self-service account
# creation via the public OTP flow — participants are onboarded only via
# /api/v1/admin/participant (aggregator UI / voice bot). Set 'allowed' to keep
# self-service registration.
SELF_SIGNUP_MODE=gated

# Allowed login identifier channels, comma-separated: email / phone.
# Default both. Examples: LOGIN_CHANNELS=phone  |  LOGIN_CHANNELS=email,phone
LOGIN_CHANNELS=email,phone
```

- [ ] **Step 2: Note the gated-by-default behaviour change in `SETUP.md`**

Add a short subsection under the auth/local-setup area:

```markdown
### Self-signup & login channels

- `SELF_SIGNUP_MODE` (default `gated`) — the public OTP login flow will NOT create
  new accounts. Onboard participants via `POST /api/v1/admin/participant`
  (aggregator/voice). Set `SELF_SIGNUP_MODE=allowed` to permit self-registration.
- `LOGIN_CHANNELS` (default `email,phone`) — restrict login identifiers. e.g.
  `LOGIN_CHANNELS=phone` shows only the phone input and rejects email OTP.
- Admin-domain emails (`ADMIN_DOMAINS`) are exempt from the self-signup gate.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example SETUP.md
git commit -m "docs: document SELF_SIGNUP_MODE + LOGIN_CHANNELS"
```

---

## Self-Review

**1. Spec coverage:**
- Config source = instance env → Task 1 (`SELF_SIGNUP_MODE`, `LOGIN_CHANNELS`). ✅
- Self-signup gate, new-user-creation-only → Task 3 (`assertSelfSignupAllowed` in `verifyOtp` `if (!user)`; existing users skip it). ✅
- `requestOtp` early-exit + `verifyOtp` authoritative → Task 3 Steps 2–3. ✅
- Admin-domain bootstrap exempt → Task 2 `isAdminDomainEmail` / `assertSelfSignupAllowed`. ✅
- Login channels list, default both, per-channel enforcement → Task 1 (`parseLoginChannels`) + Task 3 (`assertChannelAllowed` in checkUser/requestOtp/verifyOtp). ✅
- Public config endpoint → Task 4. ✅
- UI: render allowed channels + block-with-message at check-user, no OTP → Task 5. ✅
- Error codes `SELF_SIGNUP_DISABLED` (403) / `LOGIN_CHANNEL_DISABLED` (400) → Task 2. ✅
- Docs + gated-default caveat → Task 6. ✅
- Admin/aggregator onboarding unaffected → untouched by design (`signUpEmail` path); no task modifies it. ✅

**2. Placeholder scan:** No TBD/TODO; all code steps include full code. The one text-only step (Task 5 Step 7e) instructs locating the i18n file by searching for an existing key, then adds the exact JSON — acceptable since the locale filename must be discovered in-repo.

**3. Type consistency:** `LoginChannel = 'email' | 'phone'` used consistently in config (`login_channels.ts`), auth (`auth_guards.ts`, `unified_otp.ts`, `AuthRuntimeConfig` as `('email'|'phone')[]`), API (`authConfig.login_channels`), UI (`auth-api.ts`). Guard names match across tasks: `assertChannelAllowed`, `assertSelfSignupAllowed`, `isAdminDomainEmail`. Config keys: `authConfig.allow_self_signup`, `authConfig.login_channels`; runtime config: `allowSelfSignup`, `loginChannels`; plugin options: `allowSelfSignup`, `loginChannels`. Consistent.
