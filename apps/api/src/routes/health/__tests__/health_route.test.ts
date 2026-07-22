import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

// Hoisted so the vi.mock factories (which are hoisted above module code) can
// reference them without a temporal-dead-zone error.
const { dbExecute, redisPing } = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  redisPing: vi.fn(),
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({ db: { execute: dbExecute } }));
vi.mock('@api/db/secondary/redis', () => ({ redis: { ping: redisPing } }));

async function buildApp() {
  const health_routes = (await import('../health_route')).default;
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(health_routes);
  await app.ready();
  return app;
}

describe('health routes', () => {
  beforeEach(() => {
    vi.resetModules();
    dbExecute.mockReset();
    redisPing.mockReset();
  });

  it('GET /health/live returns 200 ok', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /health/ready returns 200 ready when Postgres + Redis are healthy', async () => {
    dbExecute.mockResolvedValue([{ ok: 1 }]);
    redisPing.mockResolvedValue('PONG');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('GET /health/ready returns 503 naming the failing dependency', async () => {
    dbExecute.mockRejectedValue(new Error('pg down'));
    redisPing.mockResolvedValue('PONG');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', checks: { postgres: 'error', redis: 'ok' } });
    await app.close();
  });
});
