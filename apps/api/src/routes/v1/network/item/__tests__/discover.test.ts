/**
 * Epic #203 List PR (P-follow-3, Task 2 — REVISED) — unit test for the public
 * `POST /network/item/discover` BFF's DIRECT MAP behavior.
 *
 * signals-search's `/v1/search` now returns the full item row per result
 * (signals-search PR #87), so this BFF maps each ranked result straight to
 * the DPG item response shape — no local-DB hydrate/re-read by id. Because
 * the happy path no longer touches Postgres, this suite mocks
 * `searchSignals`, `getNetworkConfigById`, and `isServedDomainBinding` and
 * runs as a plain (non-integration) unit test — no `docker compose up db`
 * required. The facet-guard-against-a-real-schema case stays covered by
 * `discover.integration.test.ts` (real network config); this file proves the
 * direct-mapping/order/error-passthrough behavior fast and unconditionally.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

const NET = 'blue_dot';
const DOMAIN = 'seeker';
const ITEM_TYPE = 'profile_1.0';

vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: () => true,
  replyForUnservedDomain: vi.fn(),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    id: NET,
    domains: [
      {
        id: DOMAIN,
        item_schemas: {
          [ITEM_TYPE]: {
            type: 'object',
            properties: {
              city: { type: 'string' },
              skills: { type: 'array', items: { type: 'string' } },
              phone: { type: 'string', private: true },
            },
          },
        },
      },
    ],
  })),
}));

const { searchSignalsMock, fetchItemsAcrossInstancesMock } = vi.hoisted(() => ({
  searchSignalsMock: vi.fn(),
  fetchItemsAcrossInstancesMock: vi.fn(),
}));

vi.mock('@/services/signals_search_client', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/signals_search_client')
  >('@/services/signals_search_client');
  return {
    ...actual,
    searchSignals: searchSignalsMock,
  };
});

vi.mock('@/utils/inter_instance_fetch', () => ({
  fetchItemsAcrossInstances: fetchItemsAcrossInstancesMock,
}));

// Imported after mocks.
import { discover } from '../discover.js';
import { SignalsSearchError } from '@/services/signals_search_client';

function buildApp(): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(discover, { prefix: '/api/v1/network' });
  return app;
}

function baseBody(extra: Record<string, unknown> = {}) {
  return {
    item_network: NET,
    item_domain: DOMAIN,
    item_type: ITEM_TYPE,
    limit: 20,
    offset: 0,
    ...extra,
  };
}

const FULL_ITEM_A = {
  item_network: NET,
  item_domain: DOMAIN,
  item_type: ITEM_TYPE,
  item_id: '11111111-1111-4111-8111-111111111111',
  item_state: { city: 'pune' },
  item_locations: [{ lat: 18.5, lng: 73.8 }],
  item_instance_url: 'http://source-a.local',
  item_schema_url: 'http://source-a.local/schema',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  created_by: 'usr_a',
  lifecycle_status: 'live',
  score: 0.4,
  distanceMeters: 500,
};

const FULL_ITEM_B = {
  item_network: NET,
  item_domain: DOMAIN,
  item_type: ITEM_TYPE,
  item_id: '00000000-0000-4000-8000-000000000000',
  item_state: { city: 'mumbai' },
  item_locations: [{ lat: 19.1, lng: 72.9 }],
  item_instance_url: null,
  item_schema_url: null,
  created_at: '2026-01-03T00:00:00.000Z',
  updated_at: '2026-01-04T00:00:00.000Z',
  created_by: null,
  lifecycle_status: 'live',
  score: 0.9,
  distanceMeters: 100,
};

describe('POST /api/v1/network/item/discover — direct map (revised, no hydrate)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    app = buildApp();
  });

  it('maps signals-search full items directly to the response, preserving signals-search order, with score/distanceMeters and meta.total', async () => {
    // FULL_ITEM_B (lower alphabetical/uuid order) ranked FIRST — a pass-through
    // that silently re-sorted (or hydrated from a DB and re-ordered) would be
    // caught by asserting this exact order.
    searchSignalsMock.mockResolvedValueOnce({
      items: [FULL_ITEM_B, FULL_ITEM_A],
      meta: { total: 2, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      meta: { total: number; limit: number; offset: number };
      items: Array<Record<string, unknown>>;
    };

    expect(body.items.map((i) => i.item_id)).toEqual([
      FULL_ITEM_B.item_id,
      FULL_ITEM_A.item_id,
    ]);
    expect(body.items[0]).toMatchObject({
      item_id: FULL_ITEM_B.item_id,
      item_instance_url: null,
      item_schema_url: null,
      created_by: null,
      created_at: FULL_ITEM_B.created_at,
      updated_at: FULL_ITEM_B.updated_at,
      lifecycle_status: 'live',
      item_state: { city: 'mumbai' },
      score: 0.9,
      distanceMeters: 100,
    });
    expect(body.items[1]).toMatchObject({
      item_id: FULL_ITEM_A.item_id,
      item_instance_url: 'http://source-a.local',
      item_schema_url: 'http://source-a.local/schema',
      created_by: 'usr_a',
      score: 0.4,
      distanceMeters: 500,
    });
    expect(body.meta).toEqual({
      total: 2,
      limit: 20,
      offset: 0,
      source: 'signals_search',
      degraded: false,
    });
  });

  it('passes q, geo, and pagination through to searchSignals (no DB involved)', async () => {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 10, offset: 5 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({
        q: 'plumber',
        item_latitude: 12.9716,
        item_longitude: 77.5946,
        distance_meters: 3000,
        limit: 10,
        offset: 5,
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(1);
    const callArgs = searchSignalsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).toMatchObject({
      network: NET,
      domain: DOMAIN,
      itemType: ITEM_TYPE,
      q: 'plumber',
      lat: 12.9716,
      lng: 77.5946,
      distanceMeters: 3000,
      limit: 10,
      offset: 5,
    });
  });

  it('returns an empty items array (with meta) when signals-search has no matches, without touching a DB', async () => {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      meta: { total: 0, limit: 20, offset: 0, source: 'signals_search', degraded: false },
      items: [],
    });
  });
});

describe('POST /api/v1/network/item/discover — profile anchor relevance (#394)', () => {
  let app: FastifyInstance;
  const ANCHOR_ITEM_ID = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    app = buildApp();
  });

  it('passes anchor_item_id through to searchSignals as anchorItemId', async () => {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: ANCHOR_ITEM_ID }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(1);
    const callArgs = searchSignalsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).toMatchObject({ anchorItemId: ANCHOR_ITEM_ID });
  });

  it('retries searchSignals once WITHOUT the anchor on ANCHOR_NOT_FOUND (404), returning source:signals_search / degraded:false — not native_fallback', async () => {
    const notFoundErr = new SignalsSearchError('anchor not found');
    notFoundErr.status = 404;
    notFoundErr.code = 'ANCHOR_NOT_FOUND';

    searchSignalsMock.mockRejectedValueOnce(notFoundErr);
    searchSignalsMock.mockResolvedValueOnce({
      items: [FULL_ITEM_A],
      meta: { total: 1, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: ANCHOR_ITEM_ID }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(2);
    const secondCallArgs = searchSignalsMock.mock.calls[1][0] as Record<string, unknown>;
    expect(secondCallArgs.anchorItemId).toBeUndefined();
    expect(fetchItemsAcrossInstancesMock).not.toHaveBeenCalled();

    const body = res.json() as {
      meta: { total: number; limit: number; offset: number; source: string; degraded: boolean };
      items: Array<Record<string, unknown>>;
    };
    expect(body.meta).toEqual({
      total: 1,
      limit: 20,
      offset: 0,
      source: 'signals_search',
      degraded: false,
    });
    expect(body.items[0]).toMatchObject({ item_id: FULL_ITEM_A.item_id });
  });

  it('retries WITHOUT the anchor on INTERACTION_NOT_ALLOWED (403) — e.g. seeker→seeker — returning source:signals_search / degraded:false', async () => {
    const interactionErr = new SignalsSearchError('seeker → seeker not permitted');
    interactionErr.status = 403;
    interactionErr.code = 'INTERACTION_NOT_ALLOWED';

    searchSignalsMock.mockRejectedValueOnce(interactionErr);
    searchSignalsMock.mockResolvedValueOnce({
      items: [FULL_ITEM_A],
      meta: { total: 1, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: ANCHOR_ITEM_ID }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(2);
    expect((searchSignalsMock.mock.calls[1][0] as Record<string, unknown>).anchorItemId).toBeUndefined();
    expect(fetchItemsAcrossInstancesMock).not.toHaveBeenCalled();
    const body = res.json() as { meta: { source: string; degraded: boolean } };
    expect(body.meta.source).toBe('signals_search');
    expect(body.meta.degraded).toBe(false);
  });

  it('falls back to native when the anchor retry ALSO fails', async () => {
    const notFoundErr = new SignalsSearchError('anchor not found');
    notFoundErr.status = 404;
    notFoundErr.code = 'ANCHOR_NOT_FOUND';

    searchSignalsMock.mockRejectedValueOnce(notFoundErr);
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: ANCHOR_ITEM_ID }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(2);
    expect(fetchItemsAcrossInstancesMock).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({
      meta: { source: 'native_fallback', degraded: true },
    });
  });

  it('does NOT retry (goes straight to native fallback) on a non-anchor search error even when anchor_item_id is set', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: ANCHOR_ITEM_ID }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(1);
    expect(fetchItemsAcrossInstancesMock).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({
      meta: { source: 'native_fallback', degraded: true },
    });
  });

  it('does NOT retry on a SignalsSearchError with a non-404 status even when anchor_item_id is set', async () => {
    const serverErr = new SignalsSearchError('upstream error');
    serverErr.status = 500;
    serverErr.code = 'INTERNAL_ERROR';

    searchSignalsMock.mockRejectedValueOnce(serverErr);
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ anchor_item_id: ANCHOR_ITEM_ID }),
    });

    expect(res.statusCode).toBe(200);
    expect(searchSignalsMock).toHaveBeenCalledTimes(1);
    expect(fetchItemsAcrossInstancesMock).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({
      meta: { source: 'native_fallback', degraded: true },
    });
  });
});

describe('POST /api/v1/network/item/discover — native fallback (#203 List PR, Task 3)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    app = buildApp();
  });

  it('falls back to the native fetch path and sets meta.source=native_fallback when signals-search throws', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 1, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [
        {
          item_network: NET,
          item_domain: DOMAIN,
          item_type: ITEM_TYPE,
          item_id: FULL_ITEM_A.item_id,
          item_instance_url: FULL_ITEM_A.item_instance_url,
          item_schema_url: FULL_ITEM_A.item_schema_url,
          item_state: FULL_ITEM_A.item_state,
          item_locations: FULL_ITEM_A.item_locations,
          created_by: FULL_ITEM_A.created_by,
          created_at: FULL_ITEM_A.created_at,
          updated_at: FULL_ITEM_A.updated_at,
          lifecycle_status: 'live',
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      meta: { total: number; limit: number; offset: number; source: string; degraded: boolean };
      items: Array<Record<string, unknown>>;
    };
    expect(body.meta).toEqual({
      total: 1,
      limit: 20,
      offset: 0,
      source: 'native_fallback',
      degraded: true,
    });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ item_id: FULL_ITEM_A.item_id });
    // Native fallback has no server-side facet/text search — score/distanceMeters
    // are search-only fields and are never present on a fallback item.
    expect(body.items[0]).not.toHaveProperty('score');
    expect(body.items[0]).not.toHaveProperty('distanceMeters');
  });

  it('falls back when signals-search times out (AbortSignal-style rejection)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'TimeoutError');
    searchSignalsMock.mockRejectedValueOnce(abortError);
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      meta: { source: 'native_fallback', degraded: true },
    });
  });

  it('falls back when signals-search is unconfigured (client throws a config error)', async () => {
    searchSignalsMock.mockRejectedValueOnce(
      new Error('signals-search is not configured (SIGNALS_SEARCH_URL/SIGNALS_SEARCH_API_KEY unset)')
    );
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      meta: { source: 'native_fallback', degraded: true },
    });
    expect(fetchItemsAcrossInstancesMock).toHaveBeenCalledTimes(1);
  });

  it('honors page size/offset and the geo filters on the fallback call', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 10, offset: 5, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({
        item_latitude: 12.9716,
        item_longitude: 77.5946,
        distance_meters: 3000,
        limit: 10,
        offset: 5,
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(fetchItemsAcrossInstancesMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: Record<string, unknown>;
    };
    expect(callArgs.filters).toMatchObject({
      item_network: NET,
      item_domain: DOMAIN,
      item_type: ITEM_TYPE,
      item_latitude: 12.9716,
      item_longitude: 77.5946,
      radius_meters: 3000,
      limit: 10,
      offset: 5,
      lifecycle_filter: 'live_only',
    });
  });

  it('applies q as a native text_search (public, non-private field allowlist) on the fallback call', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ q: 'plumber' }),
    });

    expect(res.statusCode).toBe(200);
    expect(fetchItemsAcrossInstancesMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: { text_search?: { q: string; fields: string[] } };
    };
    expect(callArgs.filters.text_search).toBeDefined();
    expect(callArgs.filters.text_search?.q).toBe('plumber');
    // 'city' and 'skills' are non-private on the mocked schema; 'phone' is
    // private and must never appear in the allowlist.
    expect(callArgs.filters.text_search?.fields.sort()).toEqual(['city', 'skills']);
  });

  it('does not set text_search on the fallback call when no q was given', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: Record<string, unknown>;
    };
    expect(callArgs.filters.text_search).toBeUndefined();
  });

  it('applies facet filters as native item_state on the fallback call', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({
        filters: [
          { field: 'city', values: ['pune'] },
          { field: 'phone', values: ['555'] }, // private — must be dropped
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: { item_state?: Record<string, unknown> };
    };
    expect(callArgs.filters.item_state).toEqual({ city: ['pune'] });
  });

  it('does not set item_state on the fallback call when no filters were given', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockResolvedValueOnce({
      meta: { total: 0, limit: 20, offset: 0, partial: false, unavailable_instances: [] },
      items: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchItemsAcrossInstancesMock.mock.calls[0][0] as {
      filters: Record<string, unknown>;
    };
    expect(callArgs.filters.item_state).toBeUndefined();
  });

  it('never leaks text_search/item_state into the happy-path searchSignals call', async () => {
    searchSignalsMock.mockResolvedValueOnce({
      items: [],
      meta: { total: 0, limit: 20, offset: 0 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ q: 'plumber', filters: [{ field: 'city', values: ['pune'] }] }),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = searchSignalsMock.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('text_search');
    expect(callArgs).not.toHaveProperty('item_state');
    expect(fetchItemsAcrossInstancesMock).not.toHaveBeenCalled();
  });

  it('returns a clean 500 (never throws) when BOTH signals-search and the native fallback fail', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));
    fetchItemsAcrossInstancesMock.mockRejectedValueOnce(new Error('db unreachable'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
  });
});

describe('POST /api/v1/network/item/discover — input validation (#419 should-fix)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    searchSignalsMock.mockReset();
    fetchItemsAcrossInstancesMock.mockReset();
    app = buildApp();
  });

  it('returns 400 INVALID_ITEM_TYPE (not 500) for an item_type not declared on the domain, without calling searchSignals', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody({ item_type: 'not_a_real_type' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'INVALID_ITEM_TYPE' });
    expect(searchSignalsMock).not.toHaveBeenCalled();
    expect(fetchItemsAcrossInstancesMock).not.toHaveBeenCalled();
  });
});
