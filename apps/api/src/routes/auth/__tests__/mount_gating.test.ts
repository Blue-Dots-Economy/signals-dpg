import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * better-auth's `/api/auth/*` mount must exist under `AUTH_PROVIDER=betterauth`
 * and be **absent** under `keycloak`.
 *
 * This is the security-relevant half of the migration's Phase 3: while the mount
 * stayed registered unconditionally, `unified_otp`'s `verifyOtp` remained
 * reachable under Keycloak and still created users — with no Keycloak identity,
 * so they could never log in. Asserting a 404 rather than "the handler refused"
 * is deliberate: the guarantee is that the route does not exist at all.
 *
 * ── Why this mocks rather than sets env ──────────────────────────────────────
 * A first version drove the decision with `vi.stubEnv('AUTH_PROVIDER', …)` plus
 * `vi.resetModules()`. It passed alone and failed intermittently in the full
 * suite, because `process.env` is process-wide while module mocks are per-file,
 * and because importing the real `@api/db/secondary/redis` opens an ioredis
 * connection eagerly (`new Redis(url)` at module scope) — a real socket attempt
 * that stalls for seconds under load.
 *
 * So the provider is injected through a `@/config` getter, which app.ts reads at
 * `buildApp()` time, and Redis is stubbed out. Nothing here depends on ambient
 * env or on the network, so it cannot be perturbed by whatever else is running.
 */

/** Flipped per test; read through the getter below at buildApp() time. */
let betterauthEnabled = true;

// `MATCH_SCORE_PROVIDER` must be valid before the real config module is
// evaluated by `importOriginal`: the schema accepts only 'signals_search' or
// absent, and `vitest.setup.ts` loads the repo-root .env with override:false.
vi.stubEnv('MATCH_SCORE_PROVIDER', 'signals_search');
// The API-reference plugin is irrelevant here and heavy to register.
vi.stubEnv('API_REFERENCE_ENABLED', 'false');

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    get authConfig() {
      return { ...actual.authConfig, betterauth_enabled: betterauthEnabled };
    },
  };
});

// No real Redis. better-auth is constructed when `AuthRoutes` is imported —
// which happens regardless of whether it ends up mounted — and its
// `secondaryStorage` holds this client.
vi.mock('@api/db/secondary/redis', () => ({
  redis: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    on: vi.fn(),
  },
}));

const { buildApp } = await import('@/app');

async function build() {
  const app = await buildApp();
  await app.ready();
  return app;
}

beforeEach(() => {
  betterauthEnabled = true;
});

describe('AUTH_PROVIDER=betterauth', () => {
  it('mounts the better-auth OTP surface', async () => {
    betterauthEnabled = true;
    const app = await build();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/unified-otp/check-user',
        payload: { email: 'asha@example.org' },
      });
      // Anything but 404 proves the route is mounted. The handler's own answer
      // depends on state this test deliberately does not provide.
      expect(res.statusCode).not.toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('AUTH_PROVIDER=keycloak', () => {
  beforeEach(() => {
    betterauthEnabled = false;
  });

  it('does not mount the OTP surface that could still create users', async () => {
    const app = await build();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/unified-otp/check-user',
        payload: { email: 'asha@example.org' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('does not mount sign-out or get-session either', async () => {
    // The whole better-auth surface goes, not just the OTP endpoints — the UI
    // uses these only on the OTP screen, which Keycloak mode never renders.
    const app = await build();
    try {
      const signOut = await app.inject({ method: 'POST', url: '/api/auth/sign-out' });
      const session = await app.inject({ method: 'GET', url: '/api/auth/get-session' });
      expect(signOut.statusCode).toBe(404);
      expect(session.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('still serves the rest of the API', async () => {
    // Guards against the gate being written so broadly it unmounts more than
    // better-auth — health is registered right beside it.
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/health/live' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
