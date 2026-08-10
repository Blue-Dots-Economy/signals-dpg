/**
 * Issue #12 (security assessment) — POST /network/refetch_schemas previously
 * had no role check, so any authenticated user/apikey holder could trigger
 * an expensive schema-cache rebuild. Covers the new admin-role gate and the
 * per-route rate limit added alongside it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

const state = {
  userRole: undefined as string | undefined,
};

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: vi.fn(async (request: { user?: unknown }) => {
    request.user = { id: 'usr_test', email: 't@example.com', name: 'Test', role: state.userRole };
  }),
}));

const { refreshConsumedSchemasMock, redisFake, redisStore } = vi.hoisted(() => {
  const redisStore = new Map<string, number>();
  return {
    refreshConsumedSchemasMock: vi.fn(async () => [{ id: 'schema_1' }]),
    // Simple in-memory fake standing in for the ioredis client —
    // deterministic fixed-window counting without a real Redis instance.
    redisFake: {
      incr: vi.fn(async (key: string) => {
        const next = (redisStore.get(key) ?? 0) + 1;
        redisStore.set(key, next);
        return next;
      }),
      expire: vi.fn(async () => 1),
    },
    redisStore,
  };
});

vi.mock('@/network_schema_cache', () => ({
  refreshConsumedSchemas: refreshConsumedSchemasMock,
}));
vi.mock('@api/db/secondary/redis', () => ({ redis: redisFake }));

// Imported after mocks.
import { refetch_schema } from '../refetch_schema.js';

function buildApp(): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(refetch_schema, { prefix: '/api/v1/network' });
  return app;
}

describe('POST /network/refetch_schemas', () => {
  beforeEach(() => {
    state.userRole = undefined;
    redisStore.clear();
    refreshConsumedSchemasMock.mockClear();
  });

  it('returns 403 for an authenticated non-admin user', async () => {
    state.userRole = 'seeker';
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/network/refetch_schemas' });
    expect(res.statusCode).toBe(403);
    expect(refreshConsumedSchemasMock).not.toHaveBeenCalled();
  });

  it('succeeds for a user with the admin role', async () => {
    state.userRole = 'admin';
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/network/refetch_schemas' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ refreshed: true, schema_count: 1 });
    expect(refreshConsumedSchemasMock).toHaveBeenCalledOnce();
  });

  it('rate-limits the 6th request within the window to 429', async () => {
    state.userRole = 'admin';
    const app = buildApp();
    for (let i = 0; i < 5; i++) {
      const ok = await app.inject({ method: 'POST', url: '/api/v1/network/refetch_schemas' });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/v1/network/refetch_schemas' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
  });
});
