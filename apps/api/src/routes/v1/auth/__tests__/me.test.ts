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
