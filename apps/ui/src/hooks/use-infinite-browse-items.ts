import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchDiscover, fetchNetworkItems, PROFILE_PAGE_SIZE } from '@/lib/network-api';
import type { DiscoverFacetFilter, DiscoverSource, FetchDiscoverQuery } from '@/lib/network-api';
import type { Item } from '@/lib/item-api';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';
import { DEFAULT_BROWSE_AREA } from '@/lib/browse-discover';
import type { BrowseArea, BrowseSort } from '@/lib/browse-discover';

const BROWSE_STALE_TIME_MS = 90 * 1000;
const BROWSE_CACHE_TTL_SECONDS = 90;

// Which path served the data: 'native' is the plain proximity/recency
// `/network/item/fetch` browse; the others are the discover BFF's `meta.source`.
export type BrowseSource = 'native' | DiscoverSource;

interface UseInfiniteBrowseItemsOpts {
  enabled?: boolean;
  // A non-empty (trimmed) `q` routes to the discover BFF.
  q?: string;
  // Facet selections in the discover BFF's `filters` shape (re-validated
  // server-side). A non-empty array routes to discover.
  filters?: DiscoverFacetFilter[];
  // Forces discover/relevance mode with no q/filters.
  relevance?: boolean;
  // The active profile's item id, sent as `anchor_item_id` on the discover path
  // only. It is in the discover key (a profile switch re-ranks) but not the
  // native one (native has no ranking, so a switch must not refetch).
  anchorItemId?: string;
  // The area filter. The default `{ mode: 'anywhere' }` sends no coordinates.
  // Part of the query key, so changing it resets paging.
  area?: BrowseArea;
  // Explicit ordering; part of the query key.
  sort?: BrowseSort;
}

interface UseInfiniteBrowseItemsResult {
  items: Item[];
  total: number;
  hasNextPage: boolean;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  // True when any loaded page's `meta.partial` is true (a peer instance did not
  // answer in time). Sticky: earlier items may still be missing. Native path
  // only.
  partial: boolean;
  // 'native' on the plain path; the discover BFF's `meta.source` otherwise.
  source: BrowseSource;
  // True when the discover BFF fell back to its native path (signals-search
  // unavailable or timed out), so results are unranked. Always false on the
  // native path.
  degraded: boolean;
  // The discover BFF's `meta.distance_meters`, the radius actually applied, for
  // the "within X km" note. Undefined on the native path and when no location
  // was sent.
  distanceMeters?: number;
  // The order the server applied (`meta.sort_applied`); `relevance` with no
  // anchor and no text degrades to `newest`. Label from this, never from the
  // requested sort.
  sortApplied?: BrowseSort;
  /** A response arrived without an order; see `isSortUnreported`. */
  sortUnreported: boolean;
}

interface BrowsePage {
  items: Item[];
  meta: {
    total: number;
    limit: number;
    offset: number;
    source: BrowseSource;
    degraded: boolean;
    partial?: boolean;
    distanceMeters?: number;
    sortApplied?: BrowseSort;
  };
}

/**
 * A page has arrived and it carried no order. Not derivable from `sortApplied`
 * alone, which is also undefined before the first response: before then the UI
 * shows the requested order, after it an unreported order must not be assumed.
 *
 * A separate function to keep `useInfiniteBrowseItems` under the
 * cognitive-complexity limit.
 */
function isSortUnreported(lastPage: { meta: { sortApplied?: BrowseSort } } | undefined): boolean {
  if (lastPage === undefined) return false;
  return lastPage.meta.sortApplied === undefined;
}

/**
 * Paged browse feed for one domain, server-ordered, page size
 * `VITE_PROFILE_PAGE_SIZE`. A non-empty `q`, non-empty `filters` or `relevance`
 * switches to the discover BFF (`fetchDiscover`); both paths return the same
 * `Item` shape. Own-item and enum filtering stay in the page's view layer.
 */
export function useInfiniteBrowseItems(
  network: DotNetworkSchema | null,
  domain: DotNetworkDomain | null,
  userLocation: { lat: number; lng: number } | null,
  opts?: UseInfiniteBrowseItemsOpts,
): UseInfiniteBrowseItemsResult {
  const itemTypeKeys = domain?.item_schemas ? Object.keys(domain.item_schemas) : [];
  const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
  const enabled = !!network && !!domain && (opts?.enabled ?? true);

  const q = opts?.q?.trim() ?? '';
  const filters = opts?.filters ?? [];
  const useDiscover = q.length > 0 || filters.length > 0 || (opts?.relevance ?? false);
  const anchorItemId = opts?.anchorItemId;
  const area = opts?.area ?? DEFAULT_BROWSE_AREA;
  const sort = opts?.sort ?? 'relevance';

  // The area filter's centre, in radius mode only. `anywhere` sends nothing, so
  // signals-search applies no distance clause. Typed as the exact request
  // fields so a stray field cannot slip into `fetchDiscover` unnoticed.
  let areaFilter:
    | Pick<FetchDiscoverQuery, 'item_latitude' | 'item_longitude' | 'distance_meters'>
    | Pick<FetchDiscoverQuery, 'min_lat' | 'min_lng' | 'max_lat' | 'max_lng'>
    | undefined;
  if (area.mode === 'radius') {
    areaFilter = {
      item_latitude: area.center.lat,
      item_longitude: area.center.lng,
      distance_meters: area.meters,
    };
  } else if (area.mode === 'viewport') {
    // All four bounds travel together; the BFF rejects a partial box.
    areaFilter = {
      min_lat: area.bounds.minLat,
      min_lng: area.bounds.minLng,
      max_lat: area.bounds.maxLat,
      max_lng: area.bounds.maxLng,
    };
  }

  // The ordering centre, for `nearest` only. A radius area already supplies one
  // that signals-search reuses. A viewport does not, and the BFF will not derive
  // one (that would let "search this area" change the sort), so send the
  // viewport's midpoint explicitly.
  const needsExplicitCenter = area.mode !== 'radius';
  const nearestCenter =
    area.mode === 'viewport'
      ? {
          lat: (area.bounds.minLat + area.bounds.maxLat) / 2,
          lng: (area.bounds.minLng + area.bounds.maxLng) / 2,
        }
      : userLocation;
  const orderingCenter =
    sort === 'nearest' && needsExplicitCenter && nearestCenter
      ? { ordering_latitude: nearestCenter.lat, ordering_longitude: nearestCenter.lng }
      : undefined;

  // Every request input is in the key, so any change starts a fresh feed at
  // offset 0. `anchorItemId` is keyed in discover mode only.
  const filterKey = {
    limit: PROFILE_PAGE_SIZE,
    mode: useDiscover ? ('discover' as const) : ('native' as const),
    q,
    filters,
    // Only coordinates that reach the request belong in the key. On the
    // discover path the user's location affects only `nearest`, and then through
    // `ordering`, so keying on it would refetch when geolocation resolves; the native path orders by proximity.
    ...(useDiscover
      ? {
          area,
          sort,
          anchorItemId: anchorItemId ?? null,
          ordering: orderingCenter ?? null,
        }
      : { lat: userLocation?.lat ?? null, lng: userLocation?.lng ?? null }),
  };

  const query = useInfiniteQuery({
    queryKey:
      network && domain
        ? queryKeys.browseItems(network.id, domain.id, filterKey)
        : (['browse-items', null] as const),
    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }): Promise<BrowsePage> => {
      if (useDiscover) {
        const res = await fetchDiscover(
          {
            item_network: network!.id,
            item_domain: domain!.id,
            item_type: itemType,
            limit: PROFILE_PAGE_SIZE,
            offset: pageParam,
            ...(q ? { q } : {}),
            ...(filters.length > 0 ? { filters } : {}),
            ...areaFilter,
            ...orderingCenter,
            sort,
            ...(anchorItemId ? { anchor_item_id: anchorItemId } : {}),
          },
          signal,
        );
        return {
          items: res.items,
          meta: {
            total: res.meta.total,
            limit: res.meta.limit,
            offset: res.meta.offset,
            source: res.meta.source,
            degraded: res.meta.degraded,
            distanceMeters: res.meta.distance_meters,
            sortApplied: res.meta.sort_applied,
          },
        };
      }

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
      return {
        items: res.items,
        meta: {
          total: res.meta.total,
          limit: res.meta.limit,
          offset: res.meta.offset,
          source: 'native',
          degraded: false,
          partial: res.meta.partial === true,
        },
      };
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      // Stop on a short page as well as at the reported total: meta.total sums
      // Redis-cached per-instance counts and can overstate the real row count
      // within the count-cache TTL, which would otherwise loop "load more".
      if (lastPage.items.length < PROFILE_PAGE_SIZE) return undefined;
      return loaded < lastPage.meta.total ? loaded : undefined;
    },
    staleTime: BROWSE_STALE_TIME_MS,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const lastPage = query.data?.pages[query.data.pages.length - 1];
  const total = lastPage?.meta.total ?? 0;
  const partial = query.data?.pages.some((p) => p.meta.partial === true) ?? false;
  // `degraded`/`source` are sticky like `partial`: once any page fell back to
  // native, the feed mixes unranked and ranked pages, so the note stays until a
  // full refetch.
  const degraded = query.data?.pages.some((p) => p.meta.degraded) ?? false;
  const anyFallback = query.data?.pages.some((p) => p.meta.source === 'native_fallback') ?? false;
  const source: BrowseSource = anyFallback
    ? 'native_fallback'
    : (lastPage?.meta.source ?? (useDiscover ? 'signals_search' : 'native'));

  return {
    items,
    total,
    hasNextPage: query.hasNextPage,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
    },
    partial,
    source,
    degraded,
    // A property of the request, not of a page, so the latest page's value is
    // the right one.
    distanceMeters: lastPage?.meta.distanceMeters,
    sortApplied: lastPage?.meta.sortApplied,
    // See `isSortUnreported`.
    sortUnreported: isSortUnreported(lastPage),
  };
}
