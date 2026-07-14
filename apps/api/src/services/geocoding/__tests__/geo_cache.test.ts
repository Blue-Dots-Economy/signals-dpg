import { describe, it, expect, vi, beforeEach } from 'vitest';

// geo_cache imports the Redis client and config at module load; mock both so
// the unit test never opens a socket or runs loadEnv().
const { get, set } = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('@api/db/secondary/redis', () => ({ redis: { get, set } }));
vi.mock('@/config', () => ({
  geocodingConfig: { cache_ttl_seconds: 2592000, cache_negative_ttl_seconds: 3600 },
}));

import { normalizeGeoKey, buildGeoCacheKey, getCachedCoordinates } from '../geo_cache.js';

describe('normalizeGeoKey', () => {
  it('lowercases, trims, and collapses internal whitespace', () => {
    expect(normalizeGeoKey('  Noida,   Uttar   Pradesh ')).toBe('noida, uttar pradesh');
  });

  it('is stable across case/spacing variants', () => {
    expect(normalizeGeoKey('GHAZIABAD')).toBe(normalizeGeoKey('  ghaziabad '));
  });
});

describe('buildGeoCacheKey', () => {
  it('prefixes the normalized query with geo:place:', () => {
    expect(buildGeoCacheKey(' Noida ')).toBe('geo:place:noida');
  });
});

describe('getCachedCoordinates', () => {
  beforeEach(() => { get.mockReset(); set.mockReset(); });

  it('returns cached coords on a positive hit without calling the loader', async () => {
    get.mockResolvedValueOnce(JSON.stringify({ lat: 12.97, lng: 77.59 }));
    const loader = vi.fn();
    const result = await getCachedCoordinates('Bengaluru', loader);
    expect(result).toEqual({ lat: 12.97, lng: 77.59 });
    expect(loader).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('returns null on a cached negative sentinel without calling the loader', async () => {
    get.mockResolvedValueOnce('__no_result__');
    const loader = vi.fn();
    const result = await getCachedCoordinates('Nowhere', loader);
    expect(result).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('on a miss, calls the loader and stores a positive result with the long TTL', async () => {
    get.mockResolvedValueOnce(null);
    const loader = vi.fn().mockResolvedValue({ lat: 1, lng: 2 });
    const result = await getCachedCoordinates('Noida', loader);
    expect(result).toEqual({ lat: 1, lng: 2 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('geo:place:noida', JSON.stringify({ lat: 1, lng: 2 }), 'EX', 2592000);
  });

  it('on a miss that resolves to null, stores the sentinel with the negative TTL', async () => {
    get.mockResolvedValueOnce(null);
    const loader = vi.fn().mockResolvedValue(null);
    const result = await getCachedCoordinates('Gibberish', loader);
    expect(result).toBeNull();
    expect(set).toHaveBeenCalledWith('geo:place:gibberish', '__no_result__', 'EX', 3600);
  });

  it('falls through to the loader when Redis get throws', async () => {
    get.mockRejectedValueOnce(new Error('redis down'));
    const loader = vi.fn().mockResolvedValue({ lat: 3, lng: 4 });
    const result = await getCachedCoordinates('Delhi', loader);
    expect(result).toEqual({ lat: 3, lng: 4 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('returns null without throwing when Redis get throws AND the loader throws', async () => {
    get.mockRejectedValueOnce(new Error('redis down'));
    const loader = vi.fn().mockRejectedValue(new Error('provider 500'));
    await expect(getCachedCoordinates('Delhi', loader)).resolves.toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
