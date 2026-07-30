/**
 * #394 (map native text search) — unit test for `GET /network/item/markers`'s
 * `q` → server-resolved `text_search.fields` wiring.
 *
 * Mocks `getNetworkConfigById` and `fetchMarkersAcrossInstances` (no DB
 * required — the SQL match itself is covered by
 * `apps/api/src/utils/__tests__/text_search.integration.test.ts`) and asserts
 * that the handler:
 *   - resolves the non-private field allowlist for the given item_type via
 *     `resolveAllowedFacetFields` (reused from facet_guard.ts) and passes it
 *     as `filters.text_search.fields` — excluding any `private: true` field
 *     even though the client never supplies a field list at all;
 *   - unions non-private fields across every item_type declared for the
 *     domain when `item_type` is omitted from the request;
 *   - omits `text_search` entirely when `q` is not supplied.
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
const OTHER_ITEM_TYPE = 'profile_2.0';

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
          [OTHER_ITEM_TYPE]: {
            type: 'object',
            properties: {
              age: { type: 'number' },
              ssn: { type: 'string', private: true },
            },
          },
        },
      },
    ],
  })),
}));

const { fetchMarkersAcrossInstancesMock } = vi.hoisted(() => ({
  fetchMarkersAcrossInstancesMock: vi.fn(),
}));

vi.mock('@/utils/inter_instance_fetch', () => ({
  fetchMarkersAcrossInstances: fetchMarkersAcrossInstancesMock,
}));

// Imported after mocks.
import { markers } from '../markers.js';

function buildApp(): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(markers, { prefix: '/api/v1/network' });
  return app;
}

function query(extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    item_network: NET,
    item_domain: DOMAIN,
    ...extra,
  });
  return `/api/v1/network/item/markers?${params.toString()}`;
}

const EMPTY_RESULT = {
  meta: { total: 0, limit: 200, offset: 0, partial: false, unavailable_instances: [] },
  markers: [],
};

describe('GET /api/v1/network/item/markers — q → text_search.fields resolution (#394)', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    fetchMarkersAcrossInstancesMock.mockReset();
    fetchMarkersAcrossInstancesMock.mockResolvedValue(EMPTY_RESULT);
    app = buildApp();
  });

  it('resolves the non-private field allowlist for the given item_type, excluding the private field', async () => {
    const res = await app.inject({
      method: 'GET',
      url: query({ item_type: ITEM_TYPE, q: 'pune' }),
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMarkersAcrossInstancesMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMarkersAcrossInstancesMock.mock.calls[0][0] as {
      filters: { text_search?: { q: string; fields: string[] } };
    };

    expect(callArgs.filters.text_search?.q).toBe('pune');
    expect(new Set(callArgs.filters.text_search?.fields)).toEqual(
      new Set(['city', 'skills'])
    );
    expect(callArgs.filters.text_search?.fields).not.toContain('phone');
  });

  it('unions non-private fields across every item_type when item_type is omitted', async () => {
    const res = await app.inject({
      method: 'GET',
      url: query({ q: 'pune' }), // no item_type
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchMarkersAcrossInstancesMock.mock.calls[0][0] as {
      filters: { text_search?: { q: string; fields: string[] } };
    };

    expect(new Set(callArgs.filters.text_search?.fields)).toEqual(
      new Set(['city', 'skills', 'age'])
    );
    expect(callArgs.filters.text_search?.fields).not.toContain('phone');
    expect(callArgs.filters.text_search?.fields).not.toContain('ssn');
  });

  it('omits text_search entirely when q is not supplied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: query({ item_type: ITEM_TYPE }),
    });

    expect(res.statusCode).toBe(200);
    const callArgs = fetchMarkersAcrossInstancesMock.mock.calls[0][0] as {
      filters: { text_search?: unknown };
    };
    expect(callArgs.filters.text_search).toBeUndefined();
  });

  it('rejects an empty/whitespace-only q at the schema layer (400, handler never reached)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: query({ item_type: ITEM_TYPE, q: '   ' }),
    });

    expect(res.statusCode).toBe(400);
    expect(fetchMarkersAcrossInstancesMock).not.toHaveBeenCalled();
  });
});
