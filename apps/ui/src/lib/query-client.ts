import { QueryClient } from '@tanstack/react-query';

/**
 * The single React Query client factory, used by both entry points (`main.tsx`,
 * `tourist/main.tourist.tsx`) so their defaults cannot drift. No global
 * `staleTime`; each query picks a tier:
 *  - Config-like data (network config/list, consent config, profile-consent
 *    status, resolved schemas): 5 min; invalidate on the event that changes it.
 *  - Feeds of others' data (browse): ~90s; pass `cache_ttl_seconds` so the
 *    server cache absorbs the rest.
 *  - The user's own data (my items): 60s + invalidate-on-write.
 *  - Polled data (actions): `refetchInterval` + invalidate-on-write.
 *  - Expensive lookups keyed by immutable input (geocode): a dedicated cache,
 *    not React Query.
 * `refetchOnWindowFocus` is off; never rely on it for freshness.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        // Never retry a 401/403: it cannot succeed without new credentials,
        // and retrying multiplied every expired-session poll into a burst.
        // Axios reports the status on `error.response.status`, so read both.
        retry: (failureCount, error) => {
          const status =
            (error as { response?: { status?: number }; status?: number })?.response?.status ??
            (error as { status?: number })?.status;
          if (status === 401 || status === 403) return false;
          return failureCount < 2;
        },
      },
    },
  });
}
