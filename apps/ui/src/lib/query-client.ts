import { QueryClient } from '@tanstack/react-query';

/**
 * The single React Query client factory for the app. Both entry points
 * (`main.tsx`, `tourist/main.tourist.tsx`) use this so their defaults can't
 * drift. `refetchOnWindowFocus` is off (freshness comes from per-query
 * staleTime tiers and, for actions, refetchInterval — never from focus). No
 * global `staleTime` is set: React Query defaults to 0, and per-query tiers
 * (Plan 2b-ii) set it where caching is wanted.
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
