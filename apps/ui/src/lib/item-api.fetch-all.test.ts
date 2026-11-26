import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('./api-client', () => ({
  createApiClient: () => ({ get: mockGet }),
}));

import { fetchAllItems } from './item-api';

const query = {
  item_network: 'blue_dot',
  item_domain: 'provider',
  item_type: 'job_posting_1.0',
  created_by_me: true,
};

const items = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ item_id: `i${from + i}` }));

const page = (from: number, n: number, total: number) => ({
  data: { meta: { total, limit: 100, offset: from }, items: items(from, n) },
});

const sentParams = (call: number) => mockGet.mock.calls[call][1].params as URLSearchParams;

describe('fetchAllItems', () => {
  beforeEach(() => mockGet.mockReset());

  it('returns everything in one request when it fits in a page', async () => {
    mockGet.mockResolvedValueOnce(page(0, 40, 40));

    const all = await fetchAllItems(query);

    expect(all).toHaveLength(40);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(sentParams(0).get('limit')).toBe('100');
    expect(sentParams(0).get('offset')).toBe('0');
  });

  it('pages on until meta.total is reached: 300 profiles is 3 requests', async () => {
    mockGet
      .mockResolvedValueOnce(page(0, 100, 300))
      .mockResolvedValueOnce(page(100, 100, 300))
      .mockResolvedValueOnce(page(200, 100, 300));

    const all = await fetchAllItems(query);

    expect(all).toHaveLength(300);
    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(sentParams(1).get('offset')).toBe('100');
    expect(sentParams(2).get('offset')).toBe('200');
  });

  it('stops on an empty page even if total says there is more', async () => {
    mockGet.mockResolvedValueOnce(page(0, 0, 5));

    await expect(fetchAllItems(query)).resolves.toEqual([]);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
