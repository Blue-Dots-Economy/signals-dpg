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

const { searchSignalsMock } = vi.hoisted(() => ({
  searchSignalsMock: vi.fn(),
}));

vi.mock('@/services/signals_search_client', () => ({
  searchSignals: searchSignalsMock,
}));

// Imported after mocks.
import { discover } from '../discover.js';

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
    expect(body.meta).toEqual({ total: 2, limit: 20, offset: 0 });
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
      meta: { total: 0, limit: 20, offset: 0 },
      items: [],
    });
  });

  it('returns a clean 500 (never throws) when signals-search fails', async () => {
    searchSignalsMock.mockRejectedValueOnce(new Error('signals-search unreachable'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/network/item/discover',
      payload: baseBody(),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
  });
});
