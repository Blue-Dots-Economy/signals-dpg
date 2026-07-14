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

// PII note: a cache entry is an UNLINKED address→coordinate map — the same fact
// any geocoder returns — with no user/item association and never served
// publicly (internal Redis only). Caching the exact coordinate here is therefore
// not user-PII; the PII-jitter control still applies downstream to the
// coordinate STORED ON and SERVED FROM an item. Caching a post-jitter value is
// infeasible: this sits at the shared exact-resolve / paid-API layer used by
// both public (exact) and private fields.
// See docs/superpowers/specs/2026-07-07-pii-location-jitter-design.md.
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
    // Redis unavailable → fall through to a live resolve (handled below).
  }

  let result: Coordinates | null;
  try {
    result = await loader();
  } catch {
    // Transient provider error (HTTP/network/rate-limit): best-effort null,
    // do NOT cache — the next lookup should retry live.
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
