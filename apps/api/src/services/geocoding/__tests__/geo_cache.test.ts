import { describe, it, expect, vi } from 'vitest';

// geo_cache imports the Redis client and config at module load; mock both so
// the unit test never opens a socket or runs loadEnv().
vi.mock('@api/db/secondary/redis', () => ({ redis: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@/config', () => ({
  geocodingConfig: { cache_ttl_seconds: 2592000, cache_negative_ttl_seconds: 3600 },
}));

import { normalizeGeoKey, buildGeoCacheKey } from '../geo_cache.js';

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
