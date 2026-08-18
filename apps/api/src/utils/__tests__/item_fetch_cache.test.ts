import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
const { redisGet, redisSet } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock('@api/db/secondary/redis', () => ({
  redis: { get: redisGet, set: redisSet },
}));

import { getCachedLocalItemFetch } from '../item_fetch_cache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const filters = { item_network: 'blue_dot', item_domain: 'seeker' } as any;

describe('getCachedLocalItemFetch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the parsed cached value without invoking the loader on a hit', async () => {
    redisGet.mockResolvedValue(JSON.stringify({ items: ['cached'] }));
    const loader = vi.fn();

    const result = await getCachedLocalItemFetch(filters, loader);

    expect(result).toEqual({ items: ['cached'] });
    expect(loader).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('invokes the loader and caches its result on a miss', async () => {
    redisGet.mockResolvedValue(null);
    const loader = vi.fn().mockResolvedValue({ items: ['fresh'] });

    const result = await getCachedLocalItemFetch(filters, loader);

    expect(result).toEqual({ items: ['fresh'] });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(redisSet).toHaveBeenCalledTimes(1);
  });

  it('caches with a deliberately tiny 1-second TTL (collapses same-burst reads only)', async () => {
    redisGet.mockResolvedValue(null);
    const loader = vi.fn().mockResolvedValue({ items: [] });

    await getCachedLocalItemFetch(filters, loader);

    // Documented invariant: LOCAL_ITEM_FETCH_CACHE_TTL_SECONDS = 1, distinct
    // from the config-driven inter-instance TTL.
    const [, , exFlag, ttl] = redisSet.mock.calls[0];
    expect(exFlag).toBe('EX');
    expect(ttl).toBe(1);
  });

  it('namespaces the cache key under local-item-fetch:', async () => {
    redisGet.mockResolvedValue(null);
    await getCachedLocalItemFetch(filters, vi.fn().mockResolvedValue(null));

    const key = redisGet.mock.calls[0][0] as string;
    expect(key.startsWith('local-item-fetch:')).toBe(true);
    // Same key must be used for the read and the write.
    expect(redisSet.mock.calls[0][0]).toBe(key);
  });

  it('derives a key that is stable across filter key ordering', async () => {
    redisGet.mockResolvedValue(null);
    const loader = vi.fn().mockResolvedValue(null);

    await getCachedLocalItemFetch(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { item_network: 'blue_dot', item_domain: 'seeker' } as any,
      loader,
    );
    await getCachedLocalItemFetch(
      // Same filters, opposite declaration order.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { item_domain: 'seeker', item_network: 'blue_dot' } as any,
      loader,
    );

    expect(redisGet.mock.calls[0][0]).toBe(redisGet.mock.calls[1][0]);
  });

  it('derives different keys for different filters', async () => {
    redisGet.mockResolvedValue(null);
    const loader = vi.fn().mockResolvedValue(null);

    await getCachedLocalItemFetch(filters, loader);
    await getCachedLocalItemFetch(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { item_network: 'blue_dot', item_domain: 'provider' } as any,
      loader,
    );

    expect(redisGet.mock.calls[0][0]).not.toBe(redisGet.mock.calls[1][0]);
  });
});
