import type { GeoProvider, GeoSuggestion, LatLng } from './types';

/** Default LRU cap for a memoized geo lookup (entries). */
const DEFAULT_CACHE_CAP = 500;

/**
 * Normalize a place query so case/spacing variants share one cache entry:
 * trim, lowercase, and collapse internal whitespace runs to a single space.
 */
export function normalizeGeoKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Session-scoped memoizing wrapper for an async geo lookup. Bounded LRU
 * (insertion-order, `cap` entries) keyed by `normalizeGeoKey(query)`, with
 * in-flight dedup so concurrent identical lookups collapse to one call. Only
 * results for which `shouldCache(value)` is true are stored (so a transient
 * empty/error result is not cached). The `signal` is accepted for call-site
 * compatibility but deliberately NOT forwarded to the shared underlying call —
 * one waiter must not abort a promise shared by others; callers still gate on
 * their own signal before using the resolved value.
 */
export function memoizeGeoLookup<T>(
  fn: (query: string) => Promise<T>,
  shouldCache: (value: T) => boolean,
  cap: number = DEFAULT_CACHE_CAP,
): (query: string, signal?: AbortSignal) => Promise<T> {
  const resolved = new Map<string, T>();
  const inFlight = new Map<string, Promise<T>>();

  return (query: string): Promise<T> => {
    const key = normalizeGeoKey(query);

    if (resolved.has(key)) {
      const value = resolved.get(key)!;
      resolved.delete(key); // refresh LRU recency
      resolved.set(key, value);
      return Promise.resolve(value);
    }

    const pending = inFlight.get(key);
    if (pending) return pending;

    const promise = fn(query)
      .then((value) => {
        if (shouldCache(value)) {
          resolved.set(key, value);
          if (resolved.size > cap) {
            const oldest = resolved.keys().next().value as string;
            resolved.delete(oldest);
          }
        }
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, promise);
    return promise;
  };
}

/**
 * Wraps a GeoProvider so `suggest`/`geocode` are transparently session-cached
 * (see memoizeGeoLookup). suggest results are cached only when non-empty and
 * geocode results only when non-null, so a transient empty/error result is not
 * stuck for the session.
 */
export function withGeoCache(base: GeoProvider): GeoProvider {
  const cachedSuggest = memoizeGeoLookup<GeoSuggestion[]>(
    (q) => base.suggest(q),
    (results) => results.length > 0,
  );
  const cachedGeocode = memoizeGeoLookup<LatLng | null>(
    (q) => base.geocode(q),
    (result) => result !== null,
  );
  return {
    suggest: (query, signal) => cachedSuggest(query, signal),
    geocode: (address, signal) => cachedGeocode(address, signal),
  };
}
