import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { requestIdOptions, registerRequestIdEcho, REQUEST_ID_HEADER } from '@/request_id';

async function buildApp() {
  const app = Fastify({ ...requestIdOptions });
  registerRequestIdEcho(app);
  app.get('/ping', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('request id correlation', () => {
  it('honours and echoes an inbound x-request-id', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { [REQUEST_ID_HEADER]: 'trace-abc-123' },
    });
    expect(res.headers[REQUEST_ID_HEADER]).toBe('trace-abc-123');
    await app.close();
  });

  it('mints a req- id when none is supplied', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.headers[REQUEST_ID_HEADER]).toMatch(/^req-/);
    await app.close();
  });

  it('ignores an over-long inbound id and mints a fresh one', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { [REQUEST_ID_HEADER]: 'x'.repeat(300) },
    });
    expect(res.headers[REQUEST_ID_HEADER]).toMatch(/^req-/);
    await app.close();
  });
});
