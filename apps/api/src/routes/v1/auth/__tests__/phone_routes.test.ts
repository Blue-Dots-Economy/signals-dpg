import { beforeEach, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

// Only the request schema is under test; a refused phone never reaches these.
const selfSignup = vi.fn();
vi.mock('@/config', () => ({ authConfig: { phone_countries: ['IN'] } }));
vi.mock('@/services/auth/self_signup', () => ({
  selfSignup: (...a: unknown[]) => selfSignup(...a),
}));
vi.mock('@api/db/postgres/drizzle_config', () => ({ db: {} }));
vi.mock('@api/db/secondary/redis', () => ({ redis: {} }));
vi.mock('@/network_configs', () => ({ getNetworkConfigById: vi.fn() }));
vi.mock('@/services/minor', () => ({ guardianConsentRequired: vi.fn() }));

import { auth_signup } from '@/routes/v1/auth/signup';
import { u18_precheck } from '@/routes/v1/auth/u18_precheck';

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(auth_signup);
  await app.register(u18_precheck);
  return app;
}

describe('phone checks on the public auth routes', () => {
  beforeEach(() => selfSignup.mockClear());

  it.each([
    ['/signup', { name: 'Asha' }],
    ['/u18-precheck', { network: 'blue_dot' }],
  ])('%s lets a valid mobile past validation', async (url, payload) => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url,
      payload: { ...payload, phoneNumber: '98765 43210' },
    });
    expect(res.statusCode).not.toBe(400);
    await app.close();
  });

  it.each([
    ['a landline-range number', '+918020123456'],
    ['a country not listed', '+447400123456'],
  ])('sign-up refuses %s with 400', async (_label, phoneNumber) => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      payload: { name: 'Asha', phoneNumber },
    });
    expect(res.statusCode).toBe(400);
    expect(selfSignup).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['a landline-range number', '+918020123456'],
    ['a country not listed', '+447400123456'],
  ])('u18-precheck refuses %s with 400', async (_label, phoneNumber) => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/u18-precheck',
      payload: { network: 'blue_dot', phoneNumber },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
