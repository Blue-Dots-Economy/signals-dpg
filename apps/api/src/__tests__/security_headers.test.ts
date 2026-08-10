import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerSecurityHeaders } from '@/plugins/security_headers';

async function buildApp() {
  const app = Fastify();
  registerSecurityHeaders(app);
  app.get('/public', async () => ({ ok: true }));
  app.get('/private', async (request) => {
    request.user = { id: 'user-1', email: 'a@b.com', name: 'A' };
    return { ok: true };
  });
  await app.ready();
  return app;
}

describe('security headers — Cache-Control on authenticated responses', () => {
  it('forces no-store on a response from an authenticated request', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/private' });
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['pragma']).toBe('no-cache');
    await app.close();
  });

  it('does not force Cache-Control on an unauthenticated response', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/public' });
    expect(res.headers['cache-control']).toBeUndefined();
    expect(res.headers['pragma']).toBeUndefined();
    await app.close();
  });
});
