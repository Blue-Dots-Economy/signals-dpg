import type { GeoProvider, GeoSuggestion } from './types';

/** Default LRU cap for a memoized geo lookup (entries). */
const DEFAULT_CACHE_CAP = 500;

/** Trims, lowercases and collapses whitespace so query variants share a cache entry. */
export function normalizeGeoKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Session-scoped memoizer for an async geo lookup: bounded LRU keyed by
 * `normalizeGeoKey(query)`, with in-flight dedup. Only values passing
 * `shouldCache` are stored, so a transient empty/error result is not cached.
 *
 * Abort is ref-counted: the shared call is aborted only once every waiter has
 * aborted its own signal, so one caller moving on (the next keystroke) cancels
 * the fetch only if nobody else is waiting on it. A waiter with no signal keeps
 * it alive.
 */
export function memoizeGeoLookup<T>(
  fn: (query: string, signal?: AbortSignal) => Promise<T>,
  shouldCache: (value: T) => boolean,
  cap: number = DEFAULT_CACHE_CAP,
): (query: string, signal?: AbortSignal) => Promise<T> {
  const resolved = new Map<string, T>();

  interface InFlight {
    promise: Promise<T>;
    controller: AbortController;
    waiters: Set<object>;
  }
  const inFlight = new Map<string, InFlight>();

  return (query: string, signal?: AbortSignal): Promise<T> => {
    const key = normalizeGeoKey(query);

    if (resolved.has(key)) {
      const value = resolved.get(key)!;
      resolved.delete(key); // refresh LRU recency
      resolved.set(key, value);
      return Promise.resolve(value);
    }

    let entry = inFlight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: InFlight = {
        controller,
        waiters: new Set<object>(),
        promise: fn(query, controller.signal)
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
          }),
      };
      inFlight.set(key, created);
      entry = created;
    }

    // Register this caller as a waiter. The shared fetch is aborted only when
    // every waiter has aborted; a no-signal waiter is released on settle.
    const current = entry;
    const token = {};
    current.waiters.add(token);

    if (signal) {
      const onAbort = () => {
        current.waiters.delete(token);
        if (current.waiters.size === 0) current.controller.abort();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        void current.promise.finally(() => signal.removeEventListener('abort', onAbort));
      }
    }
    void current.promise.finally(() => {
      current.waiters.delete(token);
    });

    return current.promise;
  };
}

/**
 * Wraps a GeoProvider so `suggest` is session-cached; only non-empty results
 * are cached.
 */
export function withGeoCache(base: GeoProvider): GeoProvider {
  const cachedSuggest = memoizeGeoLookup<GeoSuggestion[]>(
    (q, signal) => base.suggest(q, signal),
    (results) => results.length > 0,
  );
  return { suggest: cachedSuggest };
}
