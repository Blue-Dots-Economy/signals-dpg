import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    served_domains: [{ network: 'blue_dot', domain: 'seeker', key: 'blue_dot/seeker' }],
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    bulk_max_items: 3,
    schema_registry_url: '',
  },
  getCurrentApiBaseUrl: () => 'http://source.local',
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: vi.fn(async () => {}),
  auth_middleware: vi.fn(async () => {}),
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({ db: {} }));

vi.mock('@dpg/database', async () => {
  const actual = await vi.importActual<typeof import('@dpg/database')>('@dpg/database');
  return { ...actual, ensureItemPartition: vi.fn(async () => undefined) };
});

vi.mock('@/utils/item_fetch_cache_invalidate', () => ({
  invalidateItemFetchCache: vi.fn(async () => undefined),
}));

// createItemInternal succeeds for seeker; throws ItemServiceError(409) for item_type 'dupe';
// throws plain Error for item_type 'boom'.
vi.mock('@/services/item_service', async () => {
  const actual = await vi.importActual<typeof import('@/services/item_service')>(
    '@/services/item_service',
  );
  return {
    ...actual,
    createItemInternal: vi.fn(async (_db: unknown, params: { item_type: string }) => {
      if (params.item_type === 'dupe') {
        throw new actual.ItemServiceError(409, 'ITEM_ALREADY_EXISTS', 'exists');
      }
      if (params.item_type === 'boom') {
        throw new Error('kaboom');
      }
      return {
        itemNetwork: 'blue_dot',
        itemDomain: 'seeker',
        itemType: params.item_type,
        itemId: `id-${params.item_type}`,
      };
    }),
  };
});

import { create_item } from '../create_item.js';
import { createItemInternal } from '@/services/item_service';

const buildApp = (user: { id: string; role?: string } = { id: 'usr_1' }): FastifyInstance => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { user: typeof user }).user = user;
  });
  app.register(create_item);
  return app;
};

const item = (item_type = 'profile_1.0') => ({
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type,
  item_state: {},
});

describe('POST /api/v1/item/create (bulk)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('201 when all items succeed', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/create', payload: [item('a'), item('b')] });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(body.results[0]).toMatchObject({ index: 0, status: 'success', item_id: 'id-a' });
  });

  it('207 on partial failure (one duplicate)', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/create', payload: [item('a'), item('dupe')] });
    expect(res.statusCode).toBe(207);
    const body = res.json();
    expect(body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(body.results[1]).toMatchObject({ index: 1, status: 'error', error: 'ITEM_ALREADY_EXISTS' });
  });

  it('per-item INVALID_PAYLOAD for a malformed element; valid sibling still created', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/create',
      payload: [item('a'), { item_network: 'blue_dot' /* missing required fields */ }],
    });
    expect(res.statusCode).toBe(207);
    expect(res.json().results[1]).toMatchObject({ index: 1, status: 'error', error: 'INVALID_PAYLOAD' });
  });

  it('per-item UNSERVED_DOMAIN_BINDING for an unserved domain', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/create',
      payload: [{ ...item('a'), item_domain: 'provider' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'UNSERVED_DOMAIN_BINDING' });
  });

  it('400 BULK_LIMIT_EXCEEDED when over the configured max', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/create',
      payload: [item('a'), item('b'), item('c'), item('d')],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'BULK_LIMIT_EXCEEDED' });
  });

  it('400 BULK_EMPTY_ARRAY for an empty array', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/create', payload: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'BULK_EMPTY_ARRAY' });
  });

  it('422 FORBIDDEN_CREATED_BY when a non-admin caller supplies created_by', async () => {
    const res = await buildApp({ id: 'usr_1' }).inject({
      method: 'POST',
      url: '/create',
      payload: [{ ...item('a'), created_by: 'usr_x' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'FORBIDDEN_CREATED_BY' });
  });

  it('422 CREATED_BY_REQUIRED when an admin api-key caller omits created_by', async () => {
    const res = await buildApp({ id: 'usr_admin', role: 'admin' }).inject({
      method: 'POST',
      url: '/create',
      payload: [item('a')],
      headers: { 'x-api-key': 'k' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'CREATED_BY_REQUIRED' });
  });

  it('201 with per-element created_by when admin api-key caller provides it', async () => {
    const res = await buildApp({ id: 'usr_admin', role: 'admin' }).inject({
      method: 'POST',
      url: '/create',
      payload: [{ ...item('a'), created_by: 'usr_target' }],
      headers: { 'x-api-key': 'k' },
    });
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(createItemInternal)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ created_by: 'usr_target' }),
    );
  });

  it('207 unexpected error does not abort the batch; safe message returned', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/create',
      payload: [item('boom'), item('a')],
    });
    expect(res.statusCode).toBe(207);
    const body = res.json();
    expect(body.results[0]).toMatchObject({
      status: 'error',
      error: 'INTERNAL_SERVER_ERROR',
    });
    // The raw error message ('kaboom') must NOT be exposed to the caller.
    expect(body.results[0].message).not.toBe('kaboom');
    expect(body.results[1]).toMatchObject({ status: 'success', item_id: 'id-a' });
    expect(body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
  });
});
