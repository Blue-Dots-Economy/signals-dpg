import type { FetchMyActionsQuery } from '@/lib/action-api';

/**
 * Central query-key factory. One source of truth for React Query keys so keys
 * never drift across hooks/pages. Values for existing hooks are preserved
 * exactly (network-config / consent-config / actions) so adopting the factory
 * does not bust any live cache.
 *
 * `myItems` / `browseItems` / `markers` are declared ahead of use (spec §11
 * flag-back): the page migration (Plan 2b-ii) and the #203 scale work consume
 * them, and browse/markers filters must eventually carry the §8 axes (rounded
 * viewport bucket, offset, active profile, location source, instance URL).
 */
const actions = {
  all: ['actions'] as const,
  lists: () => [...actions.all, 'list'] as const,
  list: (filters: FetchMyActionsQuery) => [...actions.lists(), filters] as const,
  details: () => [...actions.all, 'detail'] as const,
  detail: (actionId: string) => [...actions.details(), actionId] as const,
  pendingCount: () => [...actions.all, 'pendingCount'] as const,
};

export const queryKeys = {
  networkConfig: (networkId: string) => ['network-config', networkId] as const,
  // The full list of network configs (GET /network/schemas, no `network` param).
  networkConfigs: () => ['network-configs'] as const,
  // Network config with all `$ref`s resolved against a given API base URL. The
  // base URL is part of the key so switching instance (§8, Plan 2b-v) yields a
  // distinct entry rather than serving a resolution built against the old host.
  resolvedNetwork: (networkId: string, apiBaseUrl: string) =>
    ['resolved-network', networkId, apiBaseUrl] as const,
  // A single item located by id (edit form), scoped to its network.
  editItem: (networkId: string, itemId: string) =>
    ['edit-item', networkId, itemId] as const,
  // A single item located by id (detail view, e.g. marker click-through),
  // scoped to its network. Declared ahead of use (#203 P4 Task 3); consumed
  // starting Task 4+.
  itemDetail: (networkId: string, itemId: string) =>
    ['item-detail', networkId, itemId] as const,
  consentConfig: (themeId: string, brand: string | null) =>
    ['consent-config', themeId, brand] as const,
  // The user's profile-creation-consent status for a network (set of consented
  // item ids). Config-ish; invalidated on consent-accept.
  profileConsent: (networkId: string) => ['profile-consent', networkId] as const,
  actions,
  myItems: (networkId: string) => ['my-items', networkId] as const,
  /**
   * Paged browse feed for ONE domain (spec §5.1). Key axes carried in filters:
   * - lat, lng (location, part of filter object; null when user has no location)
   * - limit (page size; PROFILE_PAGE_SIZE)
   * Offset/pagination is handled by useInfiniteQuery's pageParam.
   * DEFERRED axes (§8): instance/API base URL (no selectedApiUrl switcher
   * exists; wire cache busting when added), activeProfileId (only affects
   * results once relevance ranking §9 lands).
   */
  browseItems: (networkId: string, domain: string, filters: Record<string, unknown>) =>
    ['browse-items', networkId, domain, filters] as const,
  /**
   * Map markers for visible domains within a viewport (spec §5.2 / §8; bbox
   * axes #203 map-serverside-search Task 4). `filters` is built by
   * `useMapMarkers` and carries:
   * - `snappedBbox` + `zoomBand` (see `lib/map-viewport-snap.ts`) when the
   *   viewport has a bbox — a snapped-grid bbox + a clustered/individual zoom
   *   band, so a pan/zoom that stays within the same grid cell and band
   *   reuses the cache entry while a real move/zoom-band-cross busts it.
   * - `latBucket`/`lngBucket`/`radiusBucket` instead, for the older
   *   radius-only viewport shape (hand-built viewports predating the bbox
   *   work; still exercised by existing tests).
   * - `filters` — the active facet filter set (`item_state.*`), wired end to
   *   end starting Task 7; included here from Task 4 on so the key shape is
   *   ready and a filter change always produces a distinct key.
   * - `limit`.
   * DEFERRED axes (§8): instance/API base URL (no selectedApiUrl switcher
   * exists; wire cache busting when added), activeProfileId (only affects
   * results once relevance ranking §9 lands).
   */
  markers: (networkId: string, domain: string, filters: Record<string, unknown>) =>
    ['markers', networkId, domain, filters] as const,
};
