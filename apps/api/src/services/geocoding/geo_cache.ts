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
