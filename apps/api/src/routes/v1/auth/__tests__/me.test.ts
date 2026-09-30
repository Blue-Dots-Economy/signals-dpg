import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

/**
 * GET /api/v1/auth/me — the endpoint the Keycloak UI flow uses to resolve its
 * user (and, via the auth middleware, to trigger first-login provisioning).
 */

// Stands in for auth_middleware_if_enabled. `behaviour` lets each test choose
// whether the middleware authenticates, rejects, or is switched off entirely.
let behaviour: 'authenticated' | 'rejects' | 'disabled' = 'authenticated';
// How the caller arrived: a browser session cookie, or a service credential.
let via: 'browser' | 'apikey' | 'client_credentials' | 'none' = 'none';

// The browser session store and the one-time first-login claim.
let session: { firstLogin?: boolean } | null = null;
const updateSession = vi.fn(async (_id: string, patch: { firstLogin?: boolean }) => {
  session = { ...session, ...patch };
  return session;
});
let claimResult: boolean | Error = true;
const claimAppFirstLogin = vi.fn(async () => {
  if (claimResult instanceof Error) throw claimResult;
  return claimResult;
});
vi.mock('@api/plugins/auth/resolve_browser_session', () => ({ SESSION_COOKIE: 'sid' }));
vi.mock('@/services/auth/browser_session', () => ({
  readSession: async () => session,
  updateSession: (id: string, patch: { firstLogin?: boolean }) => updateSession(id, patch),
}));
vi.mock('@/services/auth/app_first_login', () => ({
  claimAppFirstLogin: () => claimAppFirstLogin(),
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async (request: FastifyRequest, reply: FastifyReply) => {
    if (behaviour === 'rejects') {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        error: 'Unauthorized',
        message: 'Missing or invalid authentication',
      });
    }
    if (behaviour === 'disabled') return; // AUTH_MIDDLEWARE_ENABLED=false
    request.user = {
      id: 'user-1',
      email: 'asha@example.org',
      name: 'Asha',
      role: 'admin',
    };
    if (via === 'browser') (request as unknown as { cookies: Record<string, string> }).cookies = { sid: 's1' };
    if (via === 'apikey') request.headers['x-api-key'] = 'k';
    if (via === 'client_credentials') request.service_client_id = 'voice-dpg';
  },
}));

async function buildApp() {
  const { auth_me } = await import('../me');
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(auth_me, { prefix: '/api/v1/auth' });
  await app.ready();
  return app;
}

const get = async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
  await app.close();
  return res;
};

beforeEach(() => {
  vi.resetModules();
  behaviour = 'authenticated';
  via = 'none';
  session = null;
  claimResult = true;
  updateSession.mockClear();
  claimAppFirstLogin.mockClear();
});

describe('GET /api/v1/auth/me', () => {
  it('returns the authenticated user from the local mirror', async () => {
    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: 'user-1',
      email: 'asha@example.org',
      name: 'Asha',
      role: 'admin',
      first_login: false,
    });
  });

  it('401s when the middleware rejects the request', async () => {
    behaviour = 'rejects';

    const res = await get();

    expect(res.statusCode).toBe(401);
  });

  it('401s rather than 500s when auth is switched off in dev', async () => {
    // AUTH_MIDDLEWARE_ENABLED=false skips the preHandler entirely, so there is
    // no request.user to report — the handler must not assume one is present.
    behaviour = 'disabled';

    const res = await get();

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });
});

describe('GET /api/v1/auth/me — first_login', () => {
  it('a browser session claims the first login once, and remembers it for reloads', async () => {
    via = 'browser';
    session = {};
    expect((await get()).json().first_login).toBe(true);
    expect(claimAppFirstLogin).toHaveBeenCalledTimes(1);
    expect(updateSession).toHaveBeenCalledWith('s1', { firstLogin: true });

    // Reload in the same session: the cached answer, no second claim.
    expect((await get()).json().first_login).toBe(true);
    expect(claimAppFirstLogin).toHaveBeenCalledTimes(1);
  });

  it('a later session (marker already set) is not a first login', async () => {
    via = 'browser';
    session = {};
    claimResult = false;
    expect((await get()).json().first_login).toBe(false);
    expect(updateSession).toHaveBeenCalledWith('s1', { firstLogin: false });
  });

  it.each(['apikey', 'client_credentials'] as const)(
    'a %s caller (voice / aggregator) is never a first login and claims nothing',
    async (credential) => {
      via = credential;
      session = {};
      expect((await get()).json().first_login).toBe(false);
      expect(claimAppFirstLogin).not.toHaveBeenCalled();
    },
  );

  it('a failed claim answers false rather than failing the request', async () => {
    via = 'browser';
    session = {};
    claimResult = new Error('db down');
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().first_login).toBe(false);
  });
});
