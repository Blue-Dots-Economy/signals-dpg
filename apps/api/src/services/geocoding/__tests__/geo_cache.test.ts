import { describe, it, expect, vi, beforeEach } from 'vitest';

// geo_cache imports the Redis client and config at module load; mock both so
// the unit test never opens a socket or runs loadEnv().
const { get, set } = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('@api/db/secondary/redis', () => ({ redis: { get, set } }));
vi.mock('@/config', () => ({
  geocodingConfig: { cache_ttl_seconds: 2592000, cache_negative_ttl_seconds: 3600 },
}));

import { normalizeGeoKey, buildPlaceCacheKey, getCachedPlace } from '../geo_cache.js';

describe('normalizeGeoKey', () => {
  it('lowercases, trims, and collapses internal whitespace', () => {
    expect(normalizeGeoKey('  Noida,   Uttar   Pradesh ')).toBe('noida, uttar pradesh');
  });

  it('is stable across case/spacing variants', () => {
    expect(normalizeGeoKey('GHAZIABAD')).toBe(normalizeGeoKey('  ghaziabad '));
  });
});

describe('buildPlaceCacheKey', () => {
  it('prefixes the normalized query with geo:place:v2:', () => {
    expect(buildPlaceCacheKey(' Noida ')).toBe('geo:place:v2:noida');
  });
  it('scopes the key by country when geocoding is restricted', () => {
    expect(buildPlaceCacheKey(' Noida ', 'IN')).toBe('geo:place:v2:IN:noida');
  });
});

const place = { point: { lat: 1, lng: 2 }, label: 'Noida', precision: 'city' as const };

describe('getCachedPlace', () => {
  beforeEach(() => { get.mockReset(); set.mockReset(); });

  it('returns the cached place on a positive hit without calling the loader', async () => {
    get.mockResolvedValueOnce(JSON.stringify(place));
    const loader = vi.fn();
    const result = await getCachedPlace('Noida', loader);
    expect(result).toEqual({ kind: 'found', place });
    expect(loader).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('returns not_found on a cached negative sentinel without calling the loader', async () => {
    get.mockResolvedValueOnce('__no_result__');
    const loader = vi.fn();
    const result = await getCachedPlace('Nowhere', loader);
    expect(result).toEqual({ kind: 'not_found' });
    expect(loader).not.toHaveBeenCalled();
  });

  it('on a miss, calls the loader and stores a found place with the long TTL', async () => {
    get.mockResolvedValueOnce(null);
    const loader = vi.fn().mockResolvedValue({ kind: 'found', place });
    const result = await getCachedPlace('Noida', loader);
    expect(result).toEqual({ kind: 'found', place });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('geo:place:v2:noida', JSON.stringify(place), 'EX', 2592000);
  });

  it('on a miss that is not_found, stores the sentinel with the negative TTL', async () => {
    get.mockResolvedValueOnce(null);
    const loader = vi.fn().mockResolvedValue({ kind: 'not_found' });
    const result = await getCachedPlace('Gibberish', loader);
    expect(result).toEqual({ kind: 'not_found' });
    expect(set).toHaveBeenCalledWith('geo:place:v2:gibberish', '__no_result__', 'EX', 3600);
  });

  it('does not cache an unavailable result', async () => {
    get.mockResolvedValueOnce(null);
    const loader = vi.fn().mockResolvedValue({ kind: 'unavailable', reason: 'timeout' });
    const result = await getCachedPlace('Noida', loader);
    expect(result).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(set).not.toHaveBeenCalled();
  });

  it('falls through to the loader when Redis get throws', async () => {
    get.mockRejectedValueOnce(new Error('redis down'));
    const loader = vi.fn().mockResolvedValue({ kind: 'found', place });
    const result = await getCachedPlace('Delhi', loader);
    expect(result).toEqual({ kind: 'found', place });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
