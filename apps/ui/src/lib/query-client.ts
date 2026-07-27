import { QueryClient } from '@tanstack/react-query';

/**
 * The single React Query client factory for the app. Both entry points
 * (`main.tsx`, `tourist/main.tourist.tsx`) use this so their defaults can't
 * drift. `refetchOnWindowFocus` is off (freshness comes from per-query
 * staleTime tiers and, for actions, refetchInterval — never from focus). No
 * global `staleTime` is set: React Query defaults to 0, and per-query tiers
 * (Plan 2b-ii) set it where caching is wanted.
 *
 * Caching rule (spec §5) — pick the tier when adding a query:
 *  - Config-like, rarely-changing (network config/list, consent config,
 *    profile-consent status, resolved schemas): staleTime 5 min; invalidate on
 *    the event that changes it.
 *  - Feeds of others' data (browse `/network/item/fetch`): staleTime ~90s; the
 *    server cache (~5 min) absorbs the rest; pass `cache_ttl_seconds`.
 *  - The user's own data (my items): staleTime 60s + invalidate-on-write.
 *  - Polled / near-real-time (actions): `refetchInterval` + invalidate-on-write.
 *  - Expensive external lookups keyed by immutable input (geocode): dedicated
 *    cache (Redis server-side; in-memory session client-side), not React Query.
 * Never rely on `refetchOnWindowFocus` for freshness. One QueryClient config,
 * one key factory (`lib/query-keys.ts`).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 2,
      },
    },
  });
}
