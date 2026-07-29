import { describe, it, expect, vi } from 'vitest';

describe('fetchDiscover', () => {
  it('POSTs /api/v1/network/item/discover with q, filters, geo, and pagination in the BFF body shape', async () => {
    vi.resetModules();
    const postMock = vi.fn().mockResolvedValue({
      data: {
        items: [{ item_id: 'a' }],
        meta: { total: 1, limit: 20, offset: 0, source: 'signals_search', degraded: false },
      },
    });
    vi.doMock('../api-client', () => ({
      createApiClient: () => ({ post: postMock, get: vi.fn() }),
    }));
    const { fetchDiscover } = await import('../network-api');

    const result = await fetchDiscover({
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      q: 'math tutor',
      filters: [{ field: 'skills', values: ['algebra', 'geometry'] }],
      item_latitude: 19,
      item_longitude: 72,
      distance_meters: 5000,
      limit: 20,
      offset: 0,
    });

    expect(postMock).toHaveBeenCalledWith(
      '/api/v1/network/item/discover',
      {
        item_network: 'blue_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        q: 'math tutor',
        filters: [{ field: 'skills', values: ['algebra', 'geometry'] }],
        item_latitude: 19,
        item_longitude: 72,
        distance_meters: 5000,
        limit: 20,
        offset: 0,
      },
      expect.anything(),
    );
    expect(result).toEqual({
      items: [{ item_id: 'a' }],
      meta: { total: 1, limit: 20, offset: 0, source: 'signals_search', degraded: false },
    });
  });

  it('omits q/filters/geo entirely when not provided (a plain relevance-only discover call)', async () => {
    vi.resetModules();
    const postMock = vi.fn().mockResolvedValue({
      data: {
        items: [],
        meta: { total: 0, limit: 20, offset: 0, source: 'native_fallback', degraded: true },
      },
    });
    vi.doMock('../api-client', () => ({
      createApiClient: () => ({ post: postMock, get: vi.fn() }),
    }));
    const { fetchDiscover } = await import('../network-api');

    await fetchDiscover({
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      limit: 20,
      offset: 0,
    });

    expect(postMock).toHaveBeenCalledWith(
      '/api/v1/network/item/discover',
      {
        item_network: 'blue_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        limit: 20,
        offset: 0,
      },
      expect.anything(),
    );
  });

  it('drops an empty filters array rather than sending filters: []', async () => {
    vi.resetModules();
    const postMock = vi.fn().mockResolvedValue({
      data: { items: [], meta: { total: 0, limit: 20, offset: 0, source: 'signals_search', degraded: false } },
    });
    vi.doMock('../api-client', () => ({
      createApiClient: () => ({ post: postMock, get: vi.fn() }),
    }));
    const { fetchDiscover } = await import('../network-api');

    await fetchDiscover({
      item_network: 'blue_dot',
      item_domain: 'student',
      item_type: 'profile_1.0',
      filters: [],
      limit: 20,
      offset: 0,
    });

    const [, body] = postMock.mock.calls[0];
    expect(body).not.toHaveProperty('filters');
  });
});
