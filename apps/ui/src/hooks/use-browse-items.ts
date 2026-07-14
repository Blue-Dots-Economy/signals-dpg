import { useQueries } from '@tanstack/react-query';
import { fetchNetworkItems, PROFILE_FETCH_LIMIT } from '@/lib/network-api';
import type { Item } from '@/lib/item-api';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

// Browse tier (spec §C2): others' items are cached ~90s client-side; the server
// cache (per-network floor ≥300s) absorbs the rest. `cache_ttl_seconds` is sent
// so the client's intent is aligned with the server knob (§C6); the server
// still enforces its own floor.
const BROWSE_STALE_TIME_MS = 90 * 1000;
const BROWSE_CACHE_TTL_SECONDS = 90;

interface UseBrowseItemsResult {
  data: Record<string, Item[]>;
  isLoading: boolean;
}

/**
 * Fetch browse items (others' profiles/postings via `/network/item/fetch`) for
 * a set of domains, one cached query per domain, and return them as a
 * domainId → items map. Items are RAW (unfiltered): the caller removes its own
 * items in a derived memo so the cache holds the true server response and a
 * profile edit doesn't force a browse refetch. Own-item filtering must NOT move
 * into this hook.
 */
export function useBrowseItems(
  network: DotNetworkSchema | null,
  domains: DotNetworkDomain[],
): UseBrowseItemsResult {
  const active = network ? domains : [];

  const results = useQueries({
    queries: active.map((domain) => {
      const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
      const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
      return {
        queryKey: queryKeys.browseItems(network!.id, domain.id, { limit: PROFILE_FETCH_LIMIT }),
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Item[]> => {
          const res = await fetchNetworkItems(
            {
              item_network: network!.id,
              item_domain: domain.id,
              item_type: itemType,
              limit: PROFILE_FETCH_LIMIT,
              cache_ttl_seconds: BROWSE_CACHE_TTL_SECONDS,
            },
            signal,
          );
          return res.items;
        },
        staleTime: BROWSE_STALE_TIME_MS,
      };
    }),
  });

  const data: Record<string, Item[]> = {};
  active.forEach((domain, i) => {
    data[domain.id] = results[i]?.data ?? [];
  });

  return { data, isLoading: results.some((r) => r.isLoading) };
}
