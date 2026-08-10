import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

// Issue #9 (GITHUB-ISSUES-COMPILATION.md): this pre-login enumeration surface
// is throttled to 20 req/min per IP. In-memory rate-limit store (no redis
// option) is enough here — the Redis-backed store used in production is
// exercised implicitly by the app registering the same plugin/options.

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
          then: (res: (v: unknown[]) => unknown) => Promise.resolve([]).then(res),
        }),
      }),
    }),
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  consent_record: {
    userId: 'cr.userId',
    level: 'cr.level',
    network: 'cr.network',
    consentCategory: 'cr.consentCategory',
    documentVersion: 'cr.documentVersion',
  },
}));

vi.mock('@api/db/postgres/schema/auth', () => ({
  user: { id: 'user.id', email: 'user.email', phoneNumber: 'user.phoneNumber' },
}));

async function buildApp() {
  const { get_consent_status_by_identifier } = await import(
    '../get_consent_status_by_identifier'
  );
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(get_consent_status_by_identifier);
  await app.ready();
  return app;
}

describe('GET /status-by-identifier rate limiting', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('allows the first 20 requests/min then returns 429 with Retry-After', async () => {
    const app = await buildApp();

    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/status-by-identifier?network=blue_dot&email=a@b.com',
      });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: 'GET',
      url: '/status-by-identifier?network=blue_dot&email=a@b.com',
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();

    await app.close();
  });
});
