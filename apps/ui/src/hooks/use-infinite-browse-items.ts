import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchDiscover, fetchNetworkItems, PROFILE_PAGE_SIZE } from '@/lib/network-api';
import type { DiscoverFacetFilter, DiscoverSource } from '@/lib/network-api';
import type { Item } from '@/lib/item-api';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

const BROWSE_STALE_TIME_MS = 90 * 1000;
const BROWSE_CACHE_TTL_SECONDS = 90;

// Which path served the current data (#203 List PR Task 4): 'native' is the
// plain proximity/recency `/network/item/fetch` browse; the other two mirror
// the discover BFF's own `meta.source` when q/filters/relevance route through
// `/network/item/discover` (Task 6 uses this for the degraded-list UX).
export type BrowseSource = 'native' | DiscoverSource;

interface UseInfiniteBrowseItemsOpts {
  enabled?: boolean;
  // Free-text search (#203 List PR Task 4). A non-empty (trimmed) `q` routes
  // to the discover BFF instead of the native paged fetch.
  q?: string;
  // Facet selections, same shape the discover BFF's `filters` body field
  // expects (`resolveAllowedFacetFilters` re-validates server-side regardless
  // of what's sent). A non-empty array routes to discover.
  filters?: DiscoverFacetFilter[];
  // Forces discover/relevance mode even with no q/filters (e.g. an explicit
  // "sort by relevance" toggle). Defaults to false — plain proximity/recency
  // browse (native) stays the default when nothing else requests discover.
  relevance?: boolean;
  // The active profile's item id (#394 Task 2). Forwarded to the discover BFF
  // as `anchor_item_id` (relevance-to-profile ranking, Task 1) ONLY on the
  // discover path — plain native browse has no ranking concept, so it's
  // neither sent nor part of that path's query key (a profile switch during
  // plain proximity browse must not cause a needless refetch). On the
  // discover path it IS part of the key: switching the selected profile must
  // re-rank, so paging resets and the feed refetches (Task 3 wires the real
  // value in from the page).
  anchorItemId?: string;
}

interface UseInfiniteBrowseItemsResult {
  items: Item[];
  total: number;
  hasNextPage: boolean;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  // True when ANY loaded page's `meta.partial` is true — i.e. a peer instance
  // didn't answer in time on at least one of the pages fetched so far, so the
  // accumulated feed is known-incomplete (#203 §6, mirrors the map's
  // `mapMarkers.partial` from P4). Sticky across pages: once a page comes
  // back partial the feed stays flagged even if a later page's peers all
  // answered, since earlier items may still be missing. Native path only —
  // the discover BFF's response has no per-instance partial concept.
  partial: boolean;
  // See `BrowseSource`. 'native' on the plain browse path; the discover BFF's
  // `meta.source` ('signals_search' | 'native_fallback') on the discover path.
  source: BrowseSource;
  // True when the discover BFF fell back to its native path (signals-search
  // unavailable/unconfigured/timed out) — q/filters were NOT honored
  // server-side in that case. Always false on the native browse path.
  degraded: boolean;
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
  };
}

/**
 * Paged browse feed for ONE domain (spec §5.1): server-ordered (nearest-first
 * when a location is supplied), page size VITE_PROFILE_PAGE_SIZE. The list view
 * consumes this; the map keeps its own fetch (decoupled in P4). Items are raw —
 * own-item filtering / enum filtering stay in the page's view layer.
 *
 * #203 List PR Task 4: when `opts.q` is non-empty, `opts.filters` is
 * non-empty, or `opts.relevance` is set, this switches to the discover BFF
 * (`fetchDiscover`) instead of the native paged fetch — the "discover"
 * condition. Discover items are the SAME `Item` shape the native path
 * returns, so the list renders both uniformly without forking the item type.
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

  // Location + q/filters/mode are all part of the key so any change resets
  // paging (spec §5.1; #203 List PR Task 4 extends this to discover inputs) —
  // useInfiniteQuery starts a fresh query (pageParam back at 0) rather than
  // appending to the previous feed whenever the key changes. `anchorItemId`
  // (#394 Task 2) is included ONLY in discover mode: it has no effect on the
  // native path, so leaving it out of that path's key means a profile switch
  // during plain proximity browse doesn't trigger a needless refetch, while a
  // profile switch during discover DOES change the key (re-ranking depends
  // on the anchor).
  const filterKey = {
    limit: PROFILE_PAGE_SIZE,
    lat: userLocation?.lat ?? null,
    lng: userLocation?.lng ?? null,
    mode: useDiscover ? ('discover' as const) : ('native' as const),
    q,
    filters,
    ...(useDiscover ? { anchorItemId: anchorItemId ?? null } : {}),
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
            ...(userLocation
              ? { item_latitude: userLocation.lat, item_longitude: userLocation.lng }
              : {}),
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
      // Stop when the server returned a short page (fewer than a full page) OR
      // we've loaded at least the reported total. meta.total is a sum of
      // Redis-cached per-instance counts and can transiently overstate the real
      // row count (deletes/pauses within the count-cache TTL); the short-page
      // check prevents an endless "load more" in that case.
      if (lastPage.items.length < PROFILE_PAGE_SIZE) return undefined;
      return loaded < lastPage.meta.total ? loaded : undefined;
    },
    staleTime: BROWSE_STALE_TIME_MS,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const lastPage = query.data?.pages[query.data.pages.length - 1];
  const total = lastPage?.meta.total ?? 0;
  const partial = query.data?.pages.some((p) => p.meta.partial === true) ?? false;
  // `degraded`/`source` are STICKY across pages (like `partial`): once ANY
  // loaded page fell back to native, later pages that happen to hit a
  // recovered signals-search must not flip the "basic matches" note off
  // mid-scroll — the accumulated feed still mixes native (unranked) pages with
  // ranked ones, so the note stays until a full refetch. (The native fallback
  // DOES apply search + filters now — #394 list-native-fallback — so this is
  // about ranking consistency, not "unfiltered shown as filtered".)
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
  };
}
