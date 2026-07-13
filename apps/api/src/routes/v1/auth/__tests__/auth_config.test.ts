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
