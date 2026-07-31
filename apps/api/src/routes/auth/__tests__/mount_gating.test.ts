import { describe, it, expect, vi, afterEach } from 'vitest';

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
 * `MATCH_SCORE_PROVIDER` is stubbed because `src/config.ts` Zod-validates the
 * whole env at module load and the schema accepts only `'signals_search'` or
 * absent. `vitest.setup.ts` loads the repo-root `.env` with `override: false`, so
 * a developer whose `.env` carries any other value would otherwise fail to build
 * the app here. Stubbed before the dynamic import, since config is read at import.
 */

function stubEnvForProvider(provider: 'betterauth' | 'keycloak'): void {
  vi.stubEnv('MATCH_SCORE_PROVIDER', 'signals_search');
  vi.stubEnv('AUTH_PROVIDER', provider);
  // The startup guard requires both of these whenever Keycloak is enabled.
  vi.stubEnv('KEYCLOAK_BASE_URL', 'http://localhost:8080');
  vi.stubEnv('KEYCLOAK_ACCEPTED_CLIENT_IDS', 'signals-ui');
  // Keep the API-reference plugin out of the way; it is irrelevant here and
  // pulls a heavy dependency at registration time.
  vi.stubEnv('API_REFERENCE_ENABLED', 'false');
}

/**
 * Build the real app for one provider. `resetModules` matters: `src/config.ts`
 * resolves its flags once at module load, so a second build in the same worker
 * would otherwise reuse the first provider's config.
 */
async function buildFor(provider: 'betterauth' | 'keycloak') {
  vi.resetModules();
  stubEnvForProvider(provider);
  const { buildApp } = await import('@/app');
  const app = await buildApp();
  await app.ready();
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('AUTH_PROVIDER=betterauth', () => {
  it('mounts the better-auth OTP surface', async () => {
    const app = await buildFor('betterauth');
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/unified-otp/check-user',
        payload: { email: 'asha@example.org' },
      });
      // Anything but 404 proves the route is mounted. The handler's own answer
      // depends on Redis/db, which this test deliberately does not provide.
      expect(res.statusCode).not.toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('AUTH_PROVIDER=keycloak', () => {
  it('does not mount the OTP surface that could still create users', async () => {
    const app = await buildFor('keycloak');
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
    const app = await buildFor('keycloak');
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
    const app = await buildFor('keycloak');
    try {
      const res = await app.inject({ method: 'GET', url: '/health/live' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
