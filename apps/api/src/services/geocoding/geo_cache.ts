import { redis } from '@api/db/secondary/redis';
import { geocodingConfig } from '@/config';
import type { Coordinates } from './geo_resolver';

/**
 * Normalize a place query so case/spacing variants share one cache entry:
 * trim, lowercase, and collapse internal whitespace runs to a single space.
 */
export function normalizeGeoKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Redis key for a resolved place: `geo:place:<normalized query>`. */
export function buildGeoCacheKey(query: string): string {
  return `geo:place:${normalizeGeoKey(query)}`;
}

/**
 * Sentinel stored for a query that resolved to nothing, so unresolvable
 * strings are not re-sent to the paid provider every time. Distinct from a
 * Redis miss (absent key → `redis.get` returns `null`).
 */
const GEO_NEGATIVE_SENTINEL = '__no_result__';

/**
 * Best-effort Redis get-or-load-and-set around a geocode. Caches positive
 * results for the long TTL and negative results briefly. Any Redis error
 * falls through to a live `loader()` call and never throws.
 */
export async function getCachedCoordinates(
  query: string,
  loader: () => Promise<Coordinates | null>,
): Promise<Coordinates | null> {
  const cacheKey = buildGeoCacheKey(query);

  try {
    const cached = await redis.get(cacheKey);
    if (cached === GEO_NEGATIVE_SENTINEL) return null;
    if (cached !== null) return JSON.parse(cached) as Coordinates;
  } catch {
    // Redis unavailable → resolve live, skip caching this round.
    return loader();
  }

  const result = await loader();

  try {
    if (result === null) {
      await redis.set(cacheKey, GEO_NEGATIVE_SENTINEL, 'EX', geocodingConfig.cache_negative_ttl_seconds);
    } else {
      await redis.set(cacheKey, JSON.stringify(result), 'EX', geocodingConfig.cache_ttl_seconds);
    }
  } catch {
    // Storing is best-effort; a write failure must not fail the resolve.
  }

  return result;
}
