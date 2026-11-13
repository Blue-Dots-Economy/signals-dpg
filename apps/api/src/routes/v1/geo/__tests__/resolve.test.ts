import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

/** POST /api/v1/geo/resolve: service-only, client-credentials callers. */

let behaviour: 'authenticated' | 'rejects' = 'authenticated';
let via: 'browser' | 'apikey' | 'client_credentials' = 'client_credentials';
let clientId = 'signals-search-client';
const disabledVariant = vi.fn();

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware: async (request: FastifyRequest, reply: FastifyReply) => {
    if (behaviour === 'rejects') {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        error: 'Unauthorized',
        message: 'Missing or invalid authentication',
      });
    }
    request.user = { id: 'u1', email: 'a@b.c', name: 'A', role: 'admin' };
    if (via === 'apikey') request.headers['x-api-key'] = 'k';
    if (via === 'client_credentials') request.service_client_id = clientId;
  },
  auth_middleware_if_enabled: (...args: unknown[]) => disabledVariant(...args),
}));

const resolvePlace = vi.fn();
vi.mock('@/services/geocoding/geo_resolver', () => ({
  resolvePlace: (...args: unknown[]) => resolvePlace(...args),
}));

async function post(body: unknown) {
  const { default: geo_routes } = await import('../geo_routes');
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(geo_routes, { prefix: '/api/v1/geo' });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/api/v1/geo/resolve', payload: body as object });
  await app.close();
  return res;
}

const place = {
  label: 'Dharwad, Karnataka',
  point: { lat: 15.46, lng: 75.01 },
  precision: 'city',
};

beforeEach(() => {
  vi.resetModules();
  behaviour = 'authenticated';
  via = 'client_credentials';
  clientId = 'signals-search-client';
  resolvePlace.mockReset();
  disabledVariant.mockReset();
});

describe('POST /api/v1/geo/resolve', () => {
  it('returns the resolved place for the allowed client', async () => {
    resolvePlace.mockResolvedValue({ kind: 'found', place });
    const res = await post({ address: 'Dharwad' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(place);
    expect(resolvePlace).toHaveBeenCalledWith('Dharwad', {
      timeoutMs: 1500,
      retryAttempts: 1,
      dailyCap: 5000,
    });
  });

  it('403s a client-credentials client that is not allow-listed', async () => {
    clientId = 'voice-dpg';
    const res = await post({ address: 'Dharwad' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('GEO_RESOLVE_NOT_ALLOWED');
    expect(resolvePlace).not.toHaveBeenCalled();
  });

  it('403s an API-key caller', async () => {
    via = 'apikey';
    const res = await post({ address: 'Dharwad' });
    expect(res.statusCode).toBe(403);
    expect(resolvePlace).not.toHaveBeenCalled();
  });

  it('403s a browser caller (user without service_client_id)', async () => {
    via = 'browser';
    const res = await post({ address: 'Dharwad' });
    expect(res.statusCode).toBe(403);
    expect(resolvePlace).not.toHaveBeenCalled();
  });

  it('401s when the middleware rejects', async () => {
    behaviour = 'rejects';
    const res = await post({ address: 'Dharwad' });
    expect(res.statusCode).toBe(401);
    expect(resolvePlace).not.toHaveBeenCalled();
  });

  it('422s when the place is not found', async () => {
    resolvePlace.mockResolvedValue({ kind: 'not_found' });
    const res = await post({ address: 'xyz' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: 'LOCATION_NOT_RESOLVED',
      message: "Could not resolve location 'xyz' to a place",
    });
  });

  it.each(['provider_error', 'timeout', 'spend_cap'])('503s on unavailable (%s)', async (reason) => {
    resolvePlace.mockResolvedValue({ kind: 'unavailable', reason });
    const res = await post({ address: 'Dharwad' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: 'GEOCODER_UNAVAILABLE',
      message: 'Geocoding is temporarily unavailable; retry later',
    });
  });

  it('400s a blank address', async () => {
    const res = await post({ address: '   ' });
    expect(res.statusCode).toBe(400);
    expect(resolvePlace).not.toHaveBeenCalled();
  });

  it('400s an address over 200 characters', async () => {
    const res = await post({ address: 'a'.repeat(201) });
    expect(res.statusCode).toBe(400);
    expect(resolvePlace).not.toHaveBeenCalled();
  });

  it('uses the always-on middleware, never the _if_enabled variant', async () => {
    resolvePlace.mockResolvedValue({ kind: 'found', place });
    await post({ address: 'Dharwad' });
    expect(disabledVariant).not.toHaveBeenCalled();
  });
});
