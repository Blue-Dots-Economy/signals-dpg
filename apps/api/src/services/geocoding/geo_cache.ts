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

// PII: entries are exact address→coordinate pairs with no user or item link,
// kept in internal Redis only. Jitter for private fields is applied later, to
// the coordinate stored on the item. Design:
// docs/superpowers/specs/2026-07-07-pii-location-jitter-design.md.
/**
 * Redis key for a resolved place: `geo:place:<normalized query>`, or
 * `geo:place:<COUNTRY>:<normalized query>` when geocoding is restricted to a
 * country, so enabling the restriction does not serve foreign points cached
 * before it.
 */
export function buildGeoCacheKey(query: string, country?: string): string {
  const scope = country ? `${country}:` : '';
  return `geo:place:${scope}${normalizeGeoKey(query)}`;
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
  country?: string,
): Promise<Coordinates | null> {
  const cacheKey = buildGeoCacheKey(query, country);

  try {
    const cached = await redis.get(cacheKey);
    if (cached === GEO_NEGATIVE_SENTINEL) return null;
    if (cached !== null) return JSON.parse(cached) as Coordinates;
  } catch {
    // Redis unavailable: fall through to a live resolve.
  }

  let result: Coordinates | null;
  try {
    result = await loader();
  } catch {
    // Transient provider error: return null without caching so the next
    // lookup retries live.
    return null;
  }

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
