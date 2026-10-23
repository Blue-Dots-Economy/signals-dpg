import type { FetchMyActionsQuery } from '@/lib/action-api';

/**
 * Central React Query key factory, so keys never drift across hooks and pages.
 */
const actions = {
  all: ['actions'] as const,
  lists: () => [...actions.all, 'list'] as const,
  // Keys on the full query object, not a destructured subset, so any field
  // added to `FetchMyActionsQuery` isolates its cache entry automatically.
  list: (filters: FetchMyActionsQuery) => [...actions.lists(), filters] as const,
  details: () => [...actions.all, 'detail'] as const,
  detail: (actionId: string) => [...actions.details(), actionId] as const,
  pendingCount: () => [...actions.all, 'pendingCount'] as const,
};

export const queryKeys = {
  networkConfig: (networkId: string) => ['network-config', networkId] as const,
  // All network configs (GET /network/schemas, no `network` param).
  networkConfigs: () => ['network-configs'] as const,
  // Network config with `$ref`s resolved against an API base URL. The base URL
  // is in the key so a future instance switch cannot serve a resolution built
  // against the old host.
  resolvedNetwork: (networkId: string, apiBaseUrl: string) =>
    ['resolved-network', networkId, apiBaseUrl] as const,
  // A single item located by id (edit form), scoped to its network.
  editItem: (networkId: string, itemId: string) =>
    ['edit-item', networkId, itemId] as const,
  // A single item located by id (detail view, e.g. marker click-through),
  // scoped to its network.
  itemDetail: (networkId: string, itemId: string) =>
    ['item-detail', networkId, itemId] as const,
  consentConfig: (themeId: string, brand: string | null) =>
    ['consent-config', themeId, brand] as const,
  // The user's profile-creation-consent status for a network (set of consented
  // item ids). Config-ish; invalidated on consent-accept.
  profileConsent: (networkId: string) => ['profile-consent', networkId] as const,
  // Support-form capabilities (enabled + attachment limits). Instance-wide, not
  // per network or user, so the key carries nothing.
  supportConfig: () => ['support-config'] as const,
  actions,
  myItems: (networkId: string) => ['my-items', networkId] as const,
  /**
   * Paged browse feed for one domain. `filters` carries `limit`, `mode`
   * ('native' | 'discover'), `q` and facet `filters`, so a change to any of
   * them restarts paging at offset 0. Native mode adds `lat`/`lng`; discover
   * mode adds `area`, `sort`, `ordering` and `anchorItemId` (the viewer's
   * selected own profile, which re-ranks results). Offset is the
   * useInfiniteQuery pageParam.
   *
   * Not yet in the key: the instance/API base URL. No instance switcher exists;
   * add cache busting when one does.
   */
  browseItems: (networkId: string, domain: string, filters: Record<string, unknown>) =>
    ['browse-items', networkId, domain, filters] as const,
  /**
   * Map markers for one domain within a viewport. `filters` is built by
   * `useMapMarkers` and carries:
   * - `snappedBbox` + `zoomBand` (see `lib/map-viewport-snap.ts`) when the
   *   viewport has a bbox, so a pan/zoom within the same grid cell and band
   *   reuses the entry.
   * - `bboxToken` (bbox path only): bumped to force a new key when a
   *   contained zoom-in must refetch because the held result was truncated,
   *   even if the snapped bbox rounds to the same cell.
   * - `latBucket`/`lngBucket`/`radiusBucket` instead, for radius-only viewports.
   * - `filters`, `satisfiable`, `q`, `limit`.
   *
   * Not yet in the key: the instance/API base URL (no instance switcher
   * exists) and the active profile id. The map never calls discover, so
   * markers are not relevance-ranked per profile; add `activeProfileId` here
   * when relevance-ranked map pins land (compare `browseItems`).
   */
  markers: (networkId: string, domain: string, filters: Record<string, unknown>) =>
    ['markers', networkId, domain, filters] as const,

  /**
   * Filter-scoped, location-independent totals for a domain.
   *
   * Separate from `browseItems` so the map's count and the list's pages do not
   * invalidate each other. The key carries only what changes the total: facets,
   * `q`, `satisfiable`, the relevance anchor, and `kind` ('all' | 'mappable').
   */
  browseTotals: (networkId: string, domain: string, filters: Record<string, unknown>) =>
    ['browseTotals', networkId, domain, filters] as const,
};
