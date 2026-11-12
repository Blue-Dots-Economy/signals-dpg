import { redis } from '@api/db/secondary/redis';
import { geocodingConfig } from '@/config';
import type { PlaceResolution, ResolvedPlace } from './geo_resolver';

/**
 * Normalize a place query so case/spacing variants share one cache entry:
 * trim, lowercase, and collapse internal whitespace runs to a single space.
 */
export function normalizeGeoKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

// PII: entries are exact address→place pairs with no user or item link,
// kept in internal Redis only. Jitter for private fields is applied later, to
// the coordinate stored on the item. Design:
// docs/superpowers/specs/2026-07-07-pii-location-jitter-design.md.
/**
 * Redis key for a resolved place: `geo:place:v2:<normalized query>`, or
 * `geo:place:v2:<COUNTRY>:<normalized query>` when geocoding is restricted to a
 * country, so enabling the restriction does not serve foreign points cached
 * before it. `v2` separates these label-and-precision values from the older
 * bare-coordinate entries.
 */
export function buildPlaceCacheKey(query: string, country?: string): string {
  const scope = country ? `${country}:` : '';
  return `geo:place:v2:${scope}${normalizeGeoKey(query)}`;
}

/**
 * Sentinel stored for a query that resolved to nothing, so unresolvable
 * strings are not re-sent to the paid provider every time. Distinct from a
 * Redis miss (absent key → `redis.get` returns `null`).
 */
const GEO_NEGATIVE_SENTINEL = '__no_result__';

/**
 * Best-effort Redis get-or-load-and-set around a place lookup. Caches found
 * places for the long TTL and not-found briefly; `unavailable` is never
 * cached. Any Redis error falls through to a live `loader()` call and never
 * throws.
 */
export async function getCachedPlace(
  query: string,
  loader: () => Promise<PlaceResolution>,
  country?: string,
): Promise<PlaceResolution> {
  const cacheKey = buildPlaceCacheKey(query, country);

  try {
    const cached = await redis.get(cacheKey);
    if (cached === GEO_NEGATIVE_SENTINEL) return { kind: 'not_found' };
    if (cached !== null) return { kind: 'found', place: JSON.parse(cached) as ResolvedPlace };
  } catch {
    // Redis unavailable or an unreadable entry: fall through to a live resolve.
  }

  const result = await loader();

  try {
    if (result.kind === 'not_found') {
      await redis.set(cacheKey, GEO_NEGATIVE_SENTINEL, 'EX', geocodingConfig.cache_negative_ttl_seconds);
    } else if (result.kind === 'found') {
      await redis.set(cacheKey, JSON.stringify(result.place), 'EX', geocodingConfig.cache_ttl_seconds);
    }
  } catch {
    // Storing is best-effort; a write failure must not fail the resolve.
  }

  return result;
}
