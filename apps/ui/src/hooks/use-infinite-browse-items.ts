import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchNetworkItems, PROFILE_PAGE_SIZE } from '@/lib/network-api';
import type { Item } from '@/lib/item-api';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

const BROWSE_STALE_TIME_MS = 90 * 1000;
const BROWSE_CACHE_TTL_SECONDS = 90;

interface UseInfiniteBrowseItemsResult {
  items: Item[];
  total: number;
  hasNextPage: boolean;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}

/**
 * Paged browse feed for ONE domain (spec §5.1): server-ordered (nearest-first
 * when a location is supplied), page size VITE_PROFILE_PAGE_SIZE. The list view
 * consumes this; the map keeps its own fetch (decoupled in P4). Items are raw —
 * own-item filtering / enum filtering stay in the page's view layer.
 */
export function useInfiniteBrowseItems(
  network: DotNetworkSchema | null,
  domain: DotNetworkDomain | null,
  userLocation: { lat: number; lng: number } | null,
  opts?: { enabled?: boolean },
): UseInfiniteBrowseItemsResult {
  const itemTypeKeys = domain?.item_schemas ? Object.keys(domain.item_schemas) : [];
  const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
  const enabled = !!network && !!domain && (opts?.enabled ?? true);

  // Location is part of the key so a location change resets paging (spec §5.1).
  const filters = {
    limit: PROFILE_PAGE_SIZE,
    lat: userLocation?.lat ?? null,
    lng: userLocation?.lng ?? null,
  };

  const query = useInfiniteQuery({
    queryKey:
      network && domain
        ? queryKeys.browseItems(network.id, domain.id, filters)
        : (['browse-items', null] as const),
    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const res = await fetchNetworkItems(
        {
          item_network: network!.id,
          item_domain: domain!.id,
          item_type: itemType,
          limit: PROFILE_PAGE_SIZE,
          offset: pageParam,
          cache_ttl_seconds: BROWSE_CACHE_TTL_SECONDS,
          ...(userLocation
            ? { item_latitude: userLocation.lat, item_longitude: userLocation.lng }
            : {}),
        },
        signal,
      );
      return res;
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.meta.total ? loaded : undefined;
    },
    staleTime: BROWSE_STALE_TIME_MS,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const total = query.data?.pages[0]?.meta.total ?? 0;

  return {
    items,
    total,
    hasNextPage: query.hasNextPage,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
    },
  };
}
