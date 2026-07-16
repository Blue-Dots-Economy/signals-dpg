import * as React from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type {
  DotNetworkSchema,
  DotNetworkDomain,
  DotActionSchema,
  DotCardConfig,
  MapMarker,
  MapViewport,
  ViewMode,
} from '@/engine/types';
import { PageShell } from '@/components/layout/page-shell';
import { ContentHeader } from '@/components/layout/content-header';
import { GuestHero } from '@/components/layout/guest-hero';
import { CardGrid } from '@/components/cards/card-grid';
import { DomainCard } from '@/components/cards/domain-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ActionHandler } from '@/components/actions/action-handler';
import { MapView, DEFAULT_ZOOM } from '@/components/map/map-container';
import { MapFiltersPanel } from '@/components/map/map-filters-panel';
import { MarkerPopupCard } from '@/components/map/marker-popup-card';
import { MatchScoreCard } from '@/components/match-score';
import '@/components/map/providers';
import { performAction, performActionsBulk, type Item } from '@/lib/item-api';
import { bulkFailureIndices, firstBulkError } from '@/lib/bulk';
import { useCardSelection } from '@/hooks/use-card-selection';
import { useEqualRowHeights } from '@/hooks/use-equal-row-heights';
import { useNetworkConfigs, useResolvedNetwork } from '@/hooks/use-network-config';
import { SelectableCard } from '@/components/selection/selectable-card';
import { BulkActionBar } from '@/components/selection/bulk-action-bar';
import { ActionModal } from '@/components/actions/action-modal';
import { CheckSquare } from 'lucide-react';
import { getRuntimeEnv } from '@/lib/runtime-env';
import { ACTION_CONSENT_SENTINEL } from '@/lib/action-api';
import { ActionAbortedError } from '@/lib/action-abort';
import { EmptyState } from '@/components/empty-state';
import { useAuth } from '@/contexts/auth-context';
import { apiConfig } from '@/lib/api-config';
import { getEnumFilterFieldsForDomains, itemPassesEnumFilters } from '@/lib/enum-filters';
import type { EnumFilterField } from '@/lib/enum-filters';
import { getServedScope } from '@/lib/served-binding';
import { computeVisibleDomains } from '@/lib/visible-domains';
import { useUserLocation } from '@/hooks/use-user-location';
import type { PreferredLocationSource } from '@/hooks/use-user-location';
import { useGeolocationPermission } from '@/hooks/use-geolocation-permission';
import { LocationSourceToggle } from '@/components/location/location-source-toggle';
import { EnableLocationBanner } from '@/components/location/enable-location-banner';
import { nearestDistanceMeters } from '@/lib/geo/distance';
import type { LatLng } from '@/lib/geo/types';
import { acceptProfileConsent } from '@/lib/consent-api';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { useNetworkTheme } from '@/theme/theme-provider';
import { ProfileConsentModal } from '@/components/consent/profile-consent-modal';
import { useMyItems } from '@/hooks/use-my-items';
import { useInfiniteBrowseItems } from '@/hooks/use-infinite-browse-items';
import { useProfileConsentStatus } from '@/hooks/use-profile-consent-status';
import { useMapMarkers } from '@/hooks/use-map-markers';
import { useItemDetail } from '@/hooks/use-item-detail';
import type { Marker as NetworkMarker } from '@/lib/network-api';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';

function itemToCardItem(item: Item): { id: string; domain: string; data: Record<string, unknown> } {
  return {
    id: item.item_id,
    domain: item.item_domain,
    data: { ...item.item_state, item_locations: item.item_locations },
  };
}

function getItemLocations(
  data: Record<string, unknown>,
): Array<{ lat: number; lng: number; label?: string }> | undefined {
  const raw = data.item_locations;
  if (!Array.isArray(raw)) return undefined;
  return raw as Array<{ lat: number; lng: number; label?: string }>;
}

function sortItemsByNearest<T>(
  items: T[],
  userLocation: LatLng | null,
  getLocations: (item: T) => ReadonlyArray<{ lat: number; lng: number; label?: string }> | undefined,
): T[] {
  if (!userLocation) return items;
  return [...items].sort(
    (a, b) =>
      nearestDistanceMeters(userLocation, getLocations(a)) -
      nearestDistanceMeters(userLocation, getLocations(b)),
  );
}

// Shared card filter: search text + enum-field filters + the map's domain
// multi-select. Used by both the paged single-domain list (`singleDomainCards`)
// and the "All" tab's merged paged union (`filteredAllDomainItems`), so the
// predicate is defined exactly once (§Task5 constraint: reuse, do not
// duplicate). (Task 7, #203 §5.2: the old full-fetch `filteredDomainItems`
// caller was removed — the map reads viewport markers, not this filter.)
function buildFilteredCardsForDomain(
  domainId: string,
  items: Item[],
  opts: {
    search: string;
    mapSelectedDomains: string[];
    activeFieldFilters: Record<string, string[]>;
    enumFilterFields: EnumFilterField[];
  },
): Array<{ id: string; domain: string; data: Record<string, unknown> }> {
  // Map domain filter: skip this domain entirely if filter is active and this
  // domain is not selected.
  if (opts.mapSelectedDomains.length > 0 && !opts.mapSelectedDomains.includes(domainId)) {
    return [];
  }

  let cards = items.map(itemToCardItem);

  // Text search filter
  if (opts.search) {
    cards = cards.filter((item) =>
      Object.values(item.data).some((val) =>
        String(val).toLowerCase().includes(opts.search.toLowerCase())
      )
    );
  }

  // Enum-field filters: AND across different fields, OR within a field's
  // selected values. Absent fields on an item always pass (domain-safe).
  if (Object.keys(opts.activeFieldFilters).length > 0) {
    cards = cards.filter((item) =>
      itemPassesEnumFilters(item.data, opts.activeFieldFilters, opts.enumFilterFields),
    );
  }

  return cards;
}

// Bottom-sentinel scroll observer: fires `onIntersect` when the sentinel node
// scrolls into view. Disconnects on cleanup / when disabled. Shared by the
// single-domain list and the "All" tab merged list (Task 5 §5.1 paging).
//
// `onIntersect` is read through a ref (kept fresh every render) rather than
// placed in the effect's dependency array — the hooks this drives
// (`useInfiniteBrowseItems`) hand back a new closure identity on every render,
// so depending on it directly would tear down and recreate the
// IntersectionObserver (and re-fire its callback) on every unrelated
// re-render instead of only on real intersection changes.
function useLoadMoreSentinel(
  onIntersect: () => void,
  enabled: boolean,
): (node: HTMLDivElement | null) => void {
  const onIntersectRef = React.useRef(onIntersect);
  onIntersectRef.current = onIntersect;
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  const observerRef = React.useRef<IntersectionObserver | null>(null);

  // Callback ref (stable, empty deps → runs only when the sentinel node itself
  // mounts/unmounts, not every render). This re-attaches the observer to the
  // *current* node: the "All" tab renders the sentinel in more than one branch,
  // so the live node can swap without `enabled` changing — a useEffect([enabled])
  // kept observing a stale, unmounted node and never fired (needed a tab switch
  // to remount). rootMargin pre-triggers 200px before the 1px sentinel reaches
  // the fold, so firing no longer depends on that exact pixel crossing the edge
  // (flaky under max-scroll clamping / momentum scrolling).
  return React.useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (enabledRef.current && entries.some((entry) => entry.isIntersecting)) {
          onIntersectRef.current();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    observerRef.current = observer;
  }, []);
}

interface DomainPageState {
  items: Item[];
  hasMore: boolean;
  total: number;
  // Task 7 (#203 §5.2 cleanup): lifted so the "All" tab's loading gate can
  // read the paged hooks directly instead of the removed full `useBrowseItems`
  // fetch (resolves the P3-deferred loading-flash minor).
  isLoading: boolean;
  fetchNext: () => void;
  // P5 (#203 §6): lifted from `useInfiniteBrowseItems`' `partial` so the "All"
  // tab can show the same federation-degradation banner as the single-domain
  // list and the map (P4's `mapMarkers.partial`).
  partial: boolean;
}

// Headless per-domain paged fetch for the "All" tab (Task 5 §5.1). React hooks
// cannot be called in a loop, so each visible domain gets its own instance of
// this component (one `useInfiniteBrowseItems` call each — legal), and lifts
// its loaded page state up to the parent via `onItems` so the parent can
// render ONE merged, nearest-first-sorted grid across all domains. Renders
// nothing itself.
function DomainPagedFetch({
  network,
  domain,
  coords,
  onItems,
}: {
  network: DotNetworkSchema;
  domain: DotNetworkDomain;
  coords: { lat: number; lng: number } | null;
  onItems: (
    domainId: string,
    items: Item[],
    hasMore: boolean,
    total: number,
    isLoading: boolean,
    fetchNext: () => void,
    partial: boolean,
  ) => void;
}): null {
  const list = useInfiniteBrowseItems(network, domain, coords);
  // `list.items` is a fresh array on every render (the hook doesn't memoize
  // it), so this effect refires on every plain re-render too. That's fine:
  // `onItems` (`handleDomainItems`) is idempotent — it bails out of its
  // `setState` when the lifted data is unchanged (element-wise reference
  // equality on `items`, plus `hasMore`/`total`/`isLoading`/`partial`), so a
  // plain re-render never causes a further re-render here. This is what lets
  // a same-length refetch (new item object refs, edited `item_state`) still
  // get lifted — gating on `items.length` would silently drop that update.
  React.useEffect(() => {
    onItems(domain.id, list.items, list.hasNextPage, list.total, list.isLoading, list.fetchNextPage, list.partial);
  }, [domain.id, list.items, list.hasNextPage, list.total, list.isLoading, list.fetchNextPage, list.partial, onItems]);
  return null;
}

// Task 6 (#203 §5.2): a map marker's popup lazily fetches the full item only
// once the popup is actually shown — the active `MapProvider` only invokes
// `renderPopup(marker)` while a marker is selected/open (see
// `google-maps-provider.tsx` / `leaflet-provider.tsx`), so this component's
// `useItemDetail` call only fires for the marker the user clicked, not for
// every viewport marker. Hooks can't be called inside the `renderPopup`
// callback itself, hence a standalone component (mirrors the
// `DomainPagedFetch` pattern above) rather than an inline hook call.
function MarkerDetailPopup({
  networkId,
  marker,
  sourceMarker,
  itemType,
  schema,
  cardConfig,
  localItem,
  connectAction,
  onConnect,
  onItemResolved,
}: {
  networkId: string | null;
  marker: MapMarker;
  // The `Marker` (network-api) this popup's marker was derived from — carries
  // `item_instance_url` for routed fetches, which the lightweight `MapMarker`
  // shape does not.
  sourceMarker: NetworkMarker | undefined;
  // The clicked marker's domain item type (e.g. `job_posting_1.0`), derived by
  // the parent from the network config — the by-id detail fetch filters on it.
  itemType?: string;
  schema?: RJSFSchema;
  cardConfig?: DotCardConfig | null;
  localItem: Item | null;
  connectAction?: DotActionSchema;
  onConnect?: (baseItemId: string) => void;
  // Task 7 (#203 §5.2 cleanup): lifts this popup's already-fetched full item
  // up to the parent. Home-page's `onActionSubmit` needs the full `Item`
  // (network/domain/type/instance_url) to build a connect-action's
  // `target_item`, but a map-only item (one loaded via viewport markers, never
  // paged into the list feeds) has no other source now that the full
  // `useBrowseItems` fetch is gone — this reuses the popup's own
  // `useItemDetail` result instead of re-fetching or reintroducing a full
  // browse feed.
  onItemResolved?: (item: Item) => void;
}) {
  const { t } = useTranslation();
  // Marker ids are `${item_id}#${locationIndex}` — strip the suffix to look up the item.
  const baseItemId = marker.id.includes('#') ? marker.id.split('#')[0] : marker.id;
  // Fetch from the clicked marker's OWN id + domain (always present on the map
  // marker) — do NOT gate on finding `sourceMarker` in the live markers array,
  // which churns as the viewport refetches and would otherwise leave the popup
  // stuck on "Loading…" with no request ever firing. `sourceMarker` (when
  // present) only supplies the optional owning-instance URL for a routed fetch;
  // its absence just means the network fetch discovers the item by id.
  const itemDomain = marker.domain ?? sourceMarker?.item_domain;

  const { item, isLoading } = useItemDetail(
    networkId,
    itemDomain
      ? {
          item_id: baseItemId,
          item_domain: itemDomain,
          // The domain's item type (e.g. `profile_1.0` / `job_posting_1.0`).
          // Slim markers don't carry it, so the parent derives it from the
          // domain config and passes it in — without it the by-id fetch would
          // filter on the wrong (default) type and match nothing.
          item_type: itemType,
          item_instance_url: sourceMarker?.item_instance_url,
        }
      : null,
  );

  React.useEffect(() => {
    if (item) onItemResolved?.(item);
  }, [item, onItemResolved]);

  if (isLoading) {
    return (
      <div className="p-3 text-sm text-muted-foreground">{t('map.loading_detail')}</div>
    );
  }
  if (!item) {
    return (
      <div className="p-3 text-sm text-muted-foreground">{t('map.detail_unavailable')}</div>
    );
  }

  // The slim map marker carries no item_state (its `data` is just
  // `{ item_locations }`) and only a generic `label`, so the popup card would
  // render empty fields and an "Item — <place>" title. Enrich it with the
  // fetched full item's state + real title so the card shows the actual profile
  // / posting details. Keep the clicked marker's location/precision/domain.
  const resolvedTitle = cardConfig?.title_field
    ? String((item.item_state as Record<string, unknown>)[cardConfig.title_field] ?? '').trim()
    : '';
  const enrichedMarker: MapMarker = {
    ...marker,
    data: item.item_state,
    label: resolvedTitle || marker.label,
  };

  return (
    <MarkerPopupCard
      marker={enrichedMarker}
      schema={schema}
      cardConfig={cardConfig}
      actions={localItem && connectAction ? [connectAction] : []}
      onConnect={localItem && connectAction ? () => onConnect?.(baseItemId) : undefined}
      localItem={localItem}
      networkItem={item}
    />
  );
}

function parseNetworkIds(networkEnv: string | undefined): string[] {
  if (!networkEnv) return [];
  return networkEnv.split(',').map(n => n.trim()).filter(Boolean);
}

function getActiveProfileStorageKey(networkId: string): string {
  return `activeProfileId:${networkId}`;
}

function getStoredActiveProfileId(networkId: string): string | null {
  return localStorage.getItem(getActiveProfileStorageKey(networkId));
}

function setStoredActiveProfileId(networkId: string, profileId: string): void {
  localStorage.setItem(getActiveProfileStorageKey(networkId), profileId);
}

function clearStoredActiveProfileId(networkId: string): void {
  localStorage.removeItem(getActiveProfileStorageKey(networkId));
}

/**
 * Resolve the instance URL for a target item
 * Priority:
 * 1. Item's own item_instance_url (if available and not localhost)
 * 2. Network config instances lookup by domain
 * 3. Current API base URL as fallback
 */
function resolveTargetInstanceUrl(
  targetItem: Item,
  network: DotNetworkSchema | null,
  currentApiUrl: string,
  itemType: 'source' | 'target' = 'target'
): string {
  console.log(`🔍 Resolving ${itemType} instance URL:`, {
    itemId: targetItem.item_id,
    itemDomain: targetItem.item_domain,
    itemInstanceUrl: targetItem.item_instance_url,
    currentApiUrl,
    networkInstances: network?.instances?.map(i => ({ domain: i.domain_id, url: i.instance_url })),
  });

  // Priority 1: Use item's instance URL if it exists and is valid (not localhost in production)
  if (targetItem.item_instance_url) {
    // Check if it's a valid URL (not just http://localhost in production)
    const isLocalhost = targetItem.item_instance_url.includes('localhost') || 
                        targetItem.item_instance_url.includes('127.0.0.1');
    const isProduction = !currentApiUrl.includes('localhost') && 
                         !currentApiUrl.includes('127.0.0.1');
    
    if (!isLocalhost || !isProduction) {
      console.log(`✅ Using item's instance_url: ${targetItem.item_instance_url}`);
      return targetItem.item_instance_url;
    }
    console.log(`⚠️ Item has localhost URL in production, skipping: ${targetItem.item_instance_url}`);
    // If localhost in production, continue to fallback
  }

  // Priority 2: Lookup in network.instances by domain
  if (network?.instances) {
    const instanceConfig = network.instances.find(
      (i) => i.domain_id === targetItem.item_domain
    );
    if (instanceConfig?.instance_url) {
      console.log(`✅ Using network.instances lookup: ${instanceConfig.instance_url}`);
      return instanceConfig.instance_url;
    }
  }

  // Priority 3: Fallback to current API URL
  console.log(`⚠️ Fallback to current API URL: ${currentApiUrl}`);
  return currentApiUrl;
}

// Resolves the landing-page default view mode from VITE_DEFAULT_VIEW_MODE.
// Falls back to 'map' when the env var is missing or holds an unrecognised
// value, so a fresh install ships with the map-first experience.
function resolveDefaultViewMode(): ViewMode {
  const raw = getRuntimeEnv('VITE_DEFAULT_VIEW_MODE');
  if (raw === 'list' || raw === 'map') return raw;
  return 'map';
}

// Anonymous count-first map browsing (#203 §7): below this zoom (region
// level — a whole state/country is roughly visible), a signed-out visitor
// with no resolved location sees an aggregate count + prompt instead of a
// country-wide pin pull. See `countFirst` below for the full gating.
const REGION_ZOOM = 8;

export function HomePage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const allCardsGridRef = useEqualRowHeights<HTMLDivElement>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [search, setSearch] = React.useState('');
  const [viewMode, setViewMode] = React.useState<ViewMode>(
    (searchParams.get('view') as ViewMode) ?? resolveDefaultViewMode()
  );
  const [selectedDomain, setSelectedDomain] = React.useState<string | null>(
    searchParams.get('domain')
  );
  // Map filter: multi-select domain filter (URL param: ?map_domains=seeker,provider)
  const [mapSelectedDomains, setMapSelectedDomains] = React.useState<string[]>(() => {
    const raw = searchParams.get('map_domains');
    if (!raw) return [];
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  });
  // Map filter: enum-field filters (URL params: ?f_<key>=value1,value2)
  // Each active field gets its own param namespaced with the "f_" prefix.
  const [mapSelectedFields, setMapSelectedFields] = React.useState<Record<string, string[]>>(() => {
    const result: Record<string, string[]> = {};
    for (const [param, value] of searchParams.entries()) {
      if (!param.startsWith('f_')) continue;
      const fieldKey = param.slice(2); // strip "f_" prefix
      if (!fieldKey) continue;
      const values = value.split(',').map((s) => decodeURIComponent(s.trim())).filter(Boolean);
      if (values.length > 0) result[fieldKey] = values;
    }
    return result;
  });
  // Map viewport (Task 6, #203 §5.2): null until the map reports its first
  // `onViewportChange` (debounced pan/zoom settle). The map's own initial
  // center/zoom comes from the existing `focusPoint`/`userLocation`/default
  // logic below — this state only tracks what the map has told us it's
  // actually showing, so `useMapMarkers` stays disabled (no markers query)
  // until that first report lands.
  const [mapViewport, setMapViewport] = React.useState<MapViewport | null>(null);
  // The full `Item` most recently resolved by an open marker popup's
  // `useItemDetail` fetch (Task 7, #203 §5.2 cleanup) — see
  // `MarkerDetailPopup`'s `onItemResolved` doc comment for why this exists.
  const [mapDetailItem, setMapDetailItem] = React.useState<Item | null>(null);
  const configuredNetworkIds = parseNetworkIds(import.meta.env.VITE_NETWORK_ID);
  // The set of domains this deployment serves (VITE_SERVED_BINDINGS), or null
  // when unset (serve all domains). When exactly ONE domain is served, that is
  // the forced acting/browse domain (the single-domain portal); with multiple,
  // the acting domain is derived from the logged-in user (whitelisted combined
  // UI). Memoised — runtime config is fixed for the session's lifetime.
  const servedScope = React.useMemo(() => getServedScope(), []);
  const boundDomain =
    servedScope && servedScope.domains.length === 1 ? servedScope.domains[0] : null;

  // Network: the served scope pins it; otherwise URL param, then env config.
  const networkFromUrl = searchParams.get('network');
  const initialNetworkId =
    servedScope?.network ??
    (networkFromUrl && configuredNetworkIds.includes(networkFromUrl)
      ? networkFromUrl
      : (configuredNetworkIds[0] || null));

  const [selectedNetworkId, setSelectedNetworkId] = React.useState<string | null>(initialNetworkId);
  const [activeProfileId, setActiveProfileId] = React.useState<string | null>(null);
  const [pendingConsentProfileId, setPendingConsentProfileId] = React.useState<string | null>(null);
  const browseSelection = useCardSelection();
  const [bulkConnectOpen, setBulkConnectOpen] = React.useState(false);
  const [bulkConnectBusy, setBulkConnectBusy] = React.useState(false);

  // Networks list + resolved selected network (config tier). Replaces the raw
  // mount-fetch + resolve effects; `allNetworks`/`network` are now query-derived.
  const { data: networksData } = useNetworkConfigs();
  const allNetworks = React.useMemo<DotNetworkSchema[]>(() => {
    if (!networksData) return [];
    return configuredNetworkIds.length > 0
      ? networksData.filter((n) => configuredNetworkIds.includes(n.id))
      : networksData;
  }, [networksData, configuredNetworkIds]);

  const { data: resolvedNetwork } = useResolvedNetwork(selectedNetworkId);
  const network = resolvedNetwork;

  // My profiles across domains (own-data tier) + profile-consent status
  // (config tier). Replace the coordinated raw fetch; the gate reads both.
  const { data: myItems, isFetched: myItemsFetched } = useMyItems(network);
  const consentQuery = useProfileConsentStatus(network);
  const consentedProfileIds = consentQuery.data ?? new Set<string>();
  // Settled = query resolved either way (fail-open: an error yields an empty set
  // and still marks loaded, so the gate can prompt). Signed-out users have no
  // profiles/consent to wait for — resolved immediately.
  const profilesResolved = !user || myItemsFetched;
  const consentLoaded = !user || consentQuery.isSuccess || consentQuery.isError;
  const queryClient = useQueryClient();

  // Default the selected network to the first available once the list loads
  // (only when nothing is selected yet) — previously done in the mount fetch.
  React.useEffect(() => {
    if (selectedNetworkId) return;
    const first = allNetworks[0]?.id;
    if (first) setSelectedNetworkId(first);
  }, [allNetworks, selectedNetworkId]);

  React.useEffect(() => {
    if (!selectedNetworkId) {
      setActiveProfileId(null);
      return;
    }
    setActiveProfileId(getStoredActiveProfileId(selectedNetworkId));
  }, [selectedNetworkId]);

  // Resolve a map marker's label from its domain's card.title_field so titles
  // are correct even in the "All" view where markers span multiple domains.
  const resolveMarkerLabel = React.useCallback(
    (item: { id: string; domain?: string; data: Record<string, unknown> }) => {
      const domain = item.domain
        ? network?.domains.find((d) => d.id === item.domain)
        : undefined;
      const titleField = domain?.card?.title_field;
      const value = titleField ? item.data[titleField] : undefined;
      return value != null && String(value).trim() ? String(value) : undefined;
    },
    [network]
  );

  // Restore or auto-select the active profile once per network, when my-profiles
  // have settled. A ref guards against re-running on a background refetch
  // (which must not reset the user's manual selection).
  const restoredForNetwork = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!user) {
      // Signed out: clear selection + any open consent gate, and allow
      // restoration to re-run on next sign-in.
      setActiveProfileId(null);
      setPendingConsentProfileId(null);
      restoredForNetwork.current = null;
      return;
    }
    if (!network || !myItemsFetched) return;
    if (restoredForNetwork.current === network.id) return;
    restoredForNetwork.current = network.id;

    const storedId = getStoredActiveProfileId(network.id);
    if (storedId && myItems.some((p) => p.item_id === storedId)) {
      setActiveProfileId(storedId);
    } else if (myItems.length > 0) {
      setActiveProfileId(myItems[0].item_id);
      setStoredActiveProfileId(network.id, myItems[0].item_id);
    } else {
      setActiveProfileId(null);
      clearStoredActiveProfileId(network.id);
    }
  }, [user, network, myItemsFetched, myItems]);

  // Derive the active profile from myItems
  const myItem = React.useMemo(() => {
    if (!myItems.length) return null;
    return myItems.find((i) => i.item_id === activeProfileId) ?? myItems[0] ?? null;
  }, [myItems, activeProfileId]);

  // A draft (incomplete) profile can't apply/connect — the API rejects it with
  // PROFILE_NOT_LIVE. Prompt the user to finish their profile (with a shortcut
  // to the edit form) instead of surfacing that error. Returns true when the
  // profile is draft (caller should abort the action).
  const promptCompleteDraftProfile = React.useCallback(
    (profile: Item): boolean => {
      if (profile.lifecycle_status !== 'draft') return false;
      toast.warning(t('home.toast_profile_draft'), {
        description: t('home.toast_profile_draft_desc'),
        action: {
          label: t('home.toast_profile_draft_cta'),
          onClick: () =>
            navigate(
              `/profile/${profile.item_id}/edit?network=${encodeURIComponent(profile.item_network)}`,
            ),
        },
      });
      return true;
    },
    [navigate, t],
  );

  // Derive the active profile's first location (profile-first), or null to trigger browser-geo fallback
  const profileLocation = React.useMemo(
    () =>
      myItem?.item_locations?.[0]
        ? { lat: myItem.item_locations[0].lat, lng: myItem.item_locations[0].lng }
        : null,
    [myItem],
  );

  // Resolve: profile location → browser geo → null. Gate the browser auto-prompt
  // on profilesResolved so a logged-in user with a profile location isn't prompted
  // during the async profile-load window.
  const [preferredSource, setPreferredSource] =
    React.useState<PreferredLocationSource>('profile');

  const { location: userLocation, browser: browserLocation } = useUserLocation(
    profileLocation,
    profilesResolved,
    preferredSource,
  );
  const geoPermission = useGeolocationPermission();

  // The toggle only makes sense when there's a profile location to switch away
  // from and the browser can actually provide the alternative.
  const canToggleLocation = Boolean(profileLocation) && browserLocation.isSupported;

  // When the user picked "current location" but the browser request errored
  // (denied / unavailable), offer to enable it. Gated on canToggleLocation so
  // the banner only appears while a profile location exists — i.e. results are
  // still sorted by the profile fallback, which the banner copy reflects.
  const showLocationBanner =
    canToggleLocation &&
    preferredSource === 'browser' &&
    browserLocation.status === 'error';

  // Bumped whenever the user switches source so the map recenters on the chosen
  // anchor even when the resolved coordinate is unchanged — e.g. switching back
  // to "My profile" after a "Current location" attempt that was denied and fell
  // back to the same profile coordinate, so panning-away is undone. (Re-picking
  // the already-active source can't happen: radix single-toggle deselects to ''
  // and handleLocationSourceChange ignores it.)
  const [recenterNonce, setRecenterNonce] = React.useState(0);

  const handleLocationSourceChange = React.useCallback(
    (next: PreferredLocationSource) => {
      setPreferredSource(next);
      setRecenterNonce((n) => n + 1);
      // An explicit "Current location" click always retries the geolocation
      // request. The auto-request effect only fires from an `idle` state, so
      // without this a second click after a dismiss/error would do nothing —
      // whereas the browser will re-prompt on a fresh request while the
      // permission is still promptable (i.e. not a real block).
      if (next === 'browser' && browserLocation.status !== 'loading') {
        void browserLocation.request();
      }
    },
    [browserLocation],
  );

  // Profile-creation consent gate. Profiles created via the aggregator channel
  // have no profile_creation consent recorded; selecting one must first prompt.
  const { config: consentConfig } = useConsentConfig();
  const { brand } = useNetworkTheme();
  const profileDoc = consentConfig?.documents.profile_creation;
  const profileVersion = profileDoc?.versions.find(
    (v) => v.version === profileDoc.current_version,
  );
  const profileStatement = profileVersion?.statement ?? '';
  const profileConsentRequired = Boolean(profileStatement);

  // Gate the auto-selected profile: if it lacks profile_creation consent, prompt.
  React.useEffect(() => {
    if (
      // Never gate a signed-out user. `activeProfileId` can briefly hold a
      // stale localStorage value (from a prior session) after sign-out or when
      // a different/no-profile user signs in — before the restore effect nulls
      // it. Requiring `user` + that the id is a real OWNED profile in myItems
      // stops the consent modal flashing for logged-out or profile-less users.
      !user ||
      !myItems.some((p) => p.item_id === activeProfileId) ||
      !profilesResolved ||
      !consentLoaded ||
      !profileConsentRequired ||
      !activeProfileId ||
      pendingConsentProfileId !== null ||
      consentedProfileIds.has(activeProfileId)
    ) {
      return;
    }
    setPendingConsentProfileId(activeProfileId);
  }, [
    user,
    myItems,
    profilesResolved,
    consentLoaded,
    profileConsentRequired,
    activeProfileId,
    consentedProfileIds,
    pendingConsentProfileId,
  ]);

  // Acting domain: ?as= test override → served binding → active profile →
  // network default. Drives the connect-action source (from_domain).
  const currentDomain =
    searchParams.get('as') ??
    boundDomain ??
    myItem?.item_domain ??
    network?.domains[0]?.id ??
    'student_profile';

  // Viewer domain for Browse scoping: ?as= → the single served domain (when
  // exactly one is served) → the logged-in user's own profile domain → null.
  // A signed-in viewer only browses the domains their domain can initiate
  // toward (e.g. a seeker sees providers, not other seekers) in bound portals
  // and the combined UI alike. Null (only a signed-out / no-profile visitor)
  // means network-wide browse — all to_domains (computeVisibleDomains).
  const viewerDomain =
    searchParams.get('as') ?? boundDomain ?? myItem?.item_domain ?? null;

  const visibleDomains = React.useMemo(
    () => (network ? computeVisibleDomains(network, viewerDomain) : []),
    [network, viewerDomain],
  );

  React.useEffect(() => {
    if (!network) return;
    if (selectedDomain === null) return;
    if (!visibleDomains.some((d) => d.id === selectedDomain)) {
      setSelectedDomain(null);
      setSearchParams((prev) => {
        prev.delete('domain');
        return prev;
      });
    }
  }, [network, selectedDomain, visibleDomains, setSearchParams]);

  // Anonymous low-zoom map browsing (#203 §7, revised): a signed-out visitor
  // with no resolved location (no profile, no browser geolocation) starts the
  // map at the whole-network default view. We still fetch + cluster the slim
  // pins (see `useMapMarkers` below) so they can see WHERE items are — this flag
  // only drives the small aggregate-count pill shown near the `MapView` below,
  // not whether pins load. ANY of: being signed in, having a resolved location,
  // or zooming in past the threshold flips it false (the pill hides once
  // individual pins are self-explanatory). `mapViewport` is null until the
  // map's first report lands, so we fall back to the map's own default zoom
  // (`DEFAULT_ZOOM`) for that brief window, matching what's on screen.
  const countFirst =
    !user && !userLocation && (mapViewport?.zoom ?? DEFAULT_ZOOM) < REGION_ZOOM;

  // Task 6 (#203 §5.2): the map view is now sourced from viewport-scoped
  // markers rather than a full per-domain browse feed (that full fetch was
  // removed from this page entirely in Task 7). Map enum-field
  // filtering (mapSelectedFields) AND the top-bar free-text `search` are BOTH
  // DEFERRED for the map in P4: viewport markers are slim (coords only, no
  // item_state), so neither the enum-field filter nor a text match can run
  // client-side, and the markers endpoint has no text-search — both need
  // server-side support (relevance/search, spec §9). `useMapMarkers` is
  // therefore never given `item_state`/enum fields or `search`; the map shows
  // all viewport markers for the visible domains. `MapFiltersPanel` and the
  // search box stay mounted (they still filter the LIST view), but have no
  // effect on which markers are fetched. Only domain multi-select (below) —
  // an array membership check needing no server support — still narrows pins.
  //
  // Even at low zoom for an anonymous / no-location visitor we now fetch the
  // slim viewport markers (coords only, capped at MAP_FETCH_LIMIT) and cluster
  // them, rather than the old count-only pull that showed just aggregate text.
  // Clustering already bounds on-screen density, and a visitor needs to SEE
  // where items are to know where to zoom — "N results, zoom in" gave no clue
  // where. A small non-blocking count pill (below) keeps the aggregate visible.
  // `meta.total` still reports the true match count regardless of the fetch cap.
  const mapMarkers = useMapMarkers(network, visibleDomains, mapViewport);

  // The map's own domain multi-select still narrows what's shown — applied
  // client-side to the fetched markers (every `Marker` already carries
  // `item_domain`), same "skip the whole domain when not selected" rule as
  // `buildFilteredCardsForDomain` uses for the list view. This is distinct
  // from the deferred enum-field filter above: domain filtering needs no
  // server support, it's just an array membership check.
  const mapItems = React.useMemo(
    () =>
      mapMarkers.markers
        .filter(
          (m) => mapSelectedDomains.length === 0 || mapSelectedDomains.includes(m.item_domain),
        )
        .map((m) => ({
          id: m.item_id,
          domain: m.item_domain,
          data: { item_locations: m.item_locations },
        })),
    [mapMarkers.markers, mapSelectedDomains],
  );

  const localProfileItemIds = React.useMemo(
    () => new Set(myItems.filter((item) => item.item_domain === currentDomain).map((item) => item.item_id)),
    [myItems, currentDomain]
  );

  // --- Task 5 (#203 §5.1): paged infinite-scroll list view ------------------
  // The selected domain's full schema object (needed by the paged hook), and
  // the coords used to drive server-side nearest ordering. Coords are omitted
  // (null) when there is no known location — the hook then fetches unordered.
  const selectedDomainObj = React.useMemo(
    () => (selectedDomain ? (network?.domains.find((d) => d.id === selectedDomain) ?? null) : null),
    [network, selectedDomain],
  );
  const browseCoords = React.useMemo(
    () => (userLocation ? { lat: userLocation.lat, lng: userLocation.lng } : null),
    [userLocation],
  );

  // Single-domain paged fetch. Enabled only while a specific domain tab is
  // selected; disabled (and thus inert) on the "All" tab.
  const singleDomainList = useInfiniteBrowseItems(
    network,
    selectedDomain ? selectedDomainObj : null,
    browseCoords,
    { enabled: selectedDomain !== null },
  );

  // Own-item filtering is a view concern (mirrored below by
  // `allDomainItemsFiltered` for the "All" tab) — apply the same rule to the
  // paged feed so a viewer never sees their own profile in their own browse
  // list.
  const singleDomainItems = React.useMemo(
    () => singleDomainList.items.filter((it) => !localProfileItemIds.has(it.item_id)),
    [singleDomainList.items, localProfileItemIds],
  );

  const activeFieldFilters = React.useMemo(
    () => Object.fromEntries(Object.entries(mapSelectedFields).filter(([, vals]) => vals.length > 0)),
    [mapSelectedFields],
  );

  // Single-domain: bottom sentinel advances the paged fetch. Server already
  // orders nearest-first (§4.1), so no client `sortByNearest` for this path.
  // (`useLoadMoreSentinel` reads the callback through a ref, so passing the
  // hook's non-memoized `fetchNextPage` directly is safe — see its comment.)
  const singleDomainSentinelRef = useLoadMoreSentinel(
    singleDomainList.fetchNextPage,
    selectedDomain !== null && singleDomainList.hasNextPage,
  );

  // "All" tab: each visible domain's paged state, lifted up from its headless
  // <DomainPagedFetch> child (one hook call per child — legal; hooks can't be
  // called in a loop). Keyed by domain id.
  const [allDomainPages, setAllDomainPages] = React.useState<Record<string, DomainPageState>>({});

  // `DomainPagedFetch` re-invokes this on every one of its renders (its
  // `list.items` array is never referentially stable — see its effect), so
  // this lift must be idempotent itself: bail out of the `setState` when the
  // domain's data hasn't actually changed, so React skips the re-render and
  // the loop terminates. "Unchanged" is element-wise reference equality on
  // `items` (individual item object refs ARE stable across a plain
  // re-render, and only change when React Query actually refetches), plus
  // `hasMore`/`total`/`isLoading`/`partial`. `fetchNext`'s identity always
  // changes and is intentionally excluded from the comparison — we still
  // store the latest one, just don't gate on it.
  const handleDomainItems = React.useCallback(
    (
      domainId: string,
      items: Item[],
      hasMore: boolean,
      total: number,
      isLoading: boolean,
      fetchNext: () => void,
      partial: boolean,
    ) => {
      setAllDomainPages((prev) => {
        const existing = prev[domainId];
        const itemsUnchanged =
          existing !== undefined &&
          existing.items.length === items.length &&
          existing.items.every((it, i) => it === items[i]);
        if (
          itemsUnchanged &&
          existing.hasMore === hasMore &&
          existing.total === total &&
          existing.isLoading === isLoading &&
          existing.partial === partial
        ) {
          // Same data (plain re-render): bail so React doesn't re-render → no loop.
          return prev;
        }
        return { ...prev, [domainId]: { items, hasMore, total, isLoading, fetchNext, partial } };
      });
    },
    [],
  );

  // Own-item-filtered accumulated union across all "All"-tab domains (mirrors
  // `singleDomainItems` above). The merged grid and its `fullItem` lookups
  // read this.
  const allDomainItemsFiltered = React.useMemo(() => {
    const result: Record<string, Item[]> = {};
    for (const [domainId, state] of Object.entries(allDomainPages)) {
      result[domainId] = state.items.filter((it) => !localProfileItemIds.has(it.item_id));
    }
    return result;
  }, [allDomainPages, localProfileItemIds]);

  const fetchNextAllDomainPages = React.useCallback(() => {
    for (const state of Object.values(allDomainPages)) {
      if (state.hasMore) state.fetchNext();
    }
  }, [allDomainPages]);
  // Iterate `visibleDomains` (not all of `allDomainPages`) so a domain that
  // scrolled out of view (e.g. a domain-tab/served-scope change) doesn't keep
  // inflating this via a stale entry that's no longer rendered (Fix C).
  const anyAllDomainHasMore = visibleDomains.some((domain) => allDomainPages[domain.id]?.hasMore ?? false);
  const allDomainsSentinelRef = useLoadMoreSentinel(
    fetchNextAllDomainPages,
    selectedDomain === null && anyAllDomainHasMore,
  );
  // --- end Task 5 -------------------------------------------------------------

  // Task 6 (#203 §6): "All" tab total for the X-of-Y indicator is the sum of
  // each visible domain's server-reported total (no single server call spans
  // domains, so there's no one `meta.total` to read). P3 surfaces meta.total
  // only — the federation-degradation banner (meta.partial/unavailable_instances)
  // lands in P5 below.
  // Sum only over `visibleDomains` — `allDomainPages` entries are never pruned
  // when `visibleDomains` shrinks, so a no-longer-visible domain would keep
  // inflating the "X of Y" if we reduced over all of `allDomainPages` instead.
  const allDomainsTotalCount = React.useMemo(
    () =>
      visibleDomains.reduce((sum, domain) => {
        const state = allDomainPages[domain.id];
        return state ? sum + state.total : sum;
      }, 0),
    [visibleDomains, allDomainPages],
  );
  // Raw loaded count (mirrors the single-domain path's raw `items.length`):
  // sums the unfiltered per-domain page items, NOT `allFlatItems.length`
  // (which is post search/enum-filter). The indicator must reflect pagination
  // truncation only, not client-side filtering.
  const allDomainsLoadedCount = React.useMemo(
    () =>
      visibleDomains.reduce((sum, domain) => {
        const state = allDomainPages[domain.id];
        return state ? sum + state.items.length : sum;
      }, 0),
    [visibleDomains, allDomainPages],
  );
  // Task 7 (#203 §5.2 cleanup): the "All" tab's loading gate, re-sourced from
  // the paged hooks (`allDomainPages`, lifted per-domain from
  // `useInfiniteBrowseItems` via `DomainPagedFetch`) instead of the removed
  // full `useBrowseItems` fetch's single `isLoading`. A domain missing from
  // `allDomainPages` (its `DomainPagedFetch` child hasn't committed its first
  // effect yet) counts as still loading, so the skeleton doesn't flash empty
  // before every visible domain has reported in.
  const allDomainsLoading = visibleDomains.some(
    (domain) => allDomainPages[domain.id]?.isLoading ?? true,
  );

  // P5 (#203 §6): "All" tab is partial if ANY visible domain's paged feed is
  // partial — mirrors `allDomainsTotalCount`'s "sum over `visibleDomains` only"
  // rule so a domain that scrolled out of view can't keep the banner up.
  const allDomainsListPartial = visibleDomains.some(
    (domain) => allDomainPages[domain.id]?.partial ?? false,
  );
  // Single source of truth for the list federation-degradation banner
  // (mirrors the map's `mapMarkers.partial` from P4): single-domain tab reads
  // the one paged feed directly, "All" tab is the OR above.
  const listPartial = selectedDomain !== null ? singleDomainList.partial : allDomainsListPartial;

  // Active schema: from the selected browsing domain, or first visible domain
  const activeSchema = React.useMemo(() => {
    if (!network) return undefined;
    const domainId = selectedDomain ?? visibleDomains[0]?.id;
    const domain = network.domains.find((d) => d.id === domainId) ?? network.domains[0];
    if (!domain) return undefined;
    return domain.item_schemas ? Object.values(domain.item_schemas)[0] : undefined;
  }, [network, selectedDomain, visibleDomains]);

  // Build domain → schema map for sidebar profile title resolution
  const userSchemas = React.useMemo(() => {
    if (!network) return {};
    const map: Record<string, RJSFSchema> = {};
    for (const domain of network.domains) {
      const schema = domain.item_schemas ? Object.values(domain.item_schemas)[0] : undefined;
      if (schema) map[domain.id] = schema;
    }
    return map;
  }, [network]);

  // Get all available actions for a given target domain
  const getActionsForDomain = React.useCallback(
    (targetDomainId: string): DotActionSchema[] => {
      if (!network || !myItem) return [];

      const actions: DotActionSchema[] = [];

      // Iterate through all action types defined in the network schema
      for (const [actionType, actionConfig] of Object.entries(network.actions)) {
        if (!actionConfig?.interactions) continue;

        // Find matching interactions for currentDomain -> targetDomain
        const matchingInteractions = actionConfig.interactions.filter(
          (i) => i.from_domain === currentDomain && i.to_domain === targetDomainId
        );

        for (const interaction of matchingInteractions) {
          actions.push({
            action_type: actionType,
            from_domain: interaction.from_domain,
            to_domain: interaction.to_domain,
            requirement_schema: interaction.requirement_schema,
            event_schema: interaction.event_schema,
            reveals_pii_on_status: interaction.reveals_pii_on_status,
          });
        }
      }

      return actions;
    },
    [network, currentDomain, myItem]
  );

  const handleBulkConnect = React.useCallback(
    async (actionType: string, formData: Record<string, unknown>) => {
      if (!myItem || !network) return;
      // Draft source profile can't act — prompt to complete it, don't submit.
      if (promptCompleteDraftProfile(myItem)) {
        setBulkConnectOpen(false);
        return;
      }
      setBulkConnectBusy(true);
      try {
        // Task 7 (#203 §5.2 cleanup): bulk-select only renders in the LIST
        // view (see `browseSelection.selectMode` below), so its candidates are
        // always sourced from whichever paged list feed is currently active —
        // never from the map/markers, so no `mapDetailItem` fallback is needed
        // here (contrast `onActionSubmit` below).
        const allItems =
          selectedDomain === null ? Object.values(allDomainItemsFiltered).flat() : singleDomainItems;
        const ids = Array.from(browseSelection.selected);
        const targets = ids
          .map((id) => allItems.find((i) => i.item_id === id))
          .filter((t): t is Item => !!t);

        // Guard: nothing valid to send (e.g. selection went stale after a reload)
        if (targets.length === 0) {
          setBulkConnectOpen(false);
          browseSelection.exitSelect();
          return;
        }

        const { [ACTION_CONSENT_SENTINEL]: consentRaw, ...requirementsSnapshot } = formData;
        const consent =
          consentRaw &&
          typeof consentRaw === 'object' &&
          (consentRaw as { acknowledged?: unknown }).acknowledged === true &&
          typeof (consentRaw as { version?: unknown }).version === 'number'
            ? {
                acknowledged: true as const,
                version: (consentRaw as { version: number }).version,
                brand: (consentRaw as { brand?: string | null }).brand,
              }
            : undefined;

        const sourceItemInstanceUrl = myItem.item_instance_url?.includes('localhost')
          ? apiConfig.getUrl()
          : resolveTargetInstanceUrl(myItem, network, apiConfig.getUrl(), 'source');

        const payloads = targets.map((targetItem) => {
            const targetItemInstanceUrl = targetItem.item_instance_url?.includes('localhost')
              ? apiConfig.getUrl()
              : resolveTargetInstanceUrl(targetItem, network, apiConfig.getUrl(), 'target');
            return {
              action_type: actionType,
              source_item: {
                item_network: myItem.item_network,
                item_domain: myItem.item_domain,
                item_type: myItem.item_type,
                item_id: myItem.item_id,
              },
              target_item: {
                item_network: targetItem.item_network,
                item_domain: targetItem.item_domain,
                item_type: targetItem.item_type,
                item_id: targetItem.item_id,
                item_instance_url: targetItemInstanceUrl,
              },
              requirements_snapshot: requirementsSnapshot,
              ...(consent ? { consent } : {}),
            };
          });

        const env = await performActionsBulk(payloads, sourceItemInstanceUrl);
        // New actions must surface without waiting for the 60s poll (§C5).
        queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
        setBulkConnectOpen(false);

        if (env.summary.failed === 0) {
          toast.success(t('home.bulk_connected_all', { count: env.summary.succeeded }));
          browseSelection.exitSelect();
        } else {
          const failedIdxs = bulkFailureIndices(env);
          const failedIds = failedIdxs.map((i) => targets[i].item_id);
          const firstErr = firstBulkError(env);
          toast.warning(
            t('home.bulk_connected_partial', {
              succeeded: env.summary.succeeded,
              total: env.summary.total,
            }),
            {
              description: firstErr
                ? t('home.bulk_connect_first_error', { message: firstErr })
                : undefined,
            },
          );
          browseSelection.setSelected(failedIds);
        }
      } catch (err) {
        toast.error(t('home.bulk_connect_failed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setBulkConnectBusy(false);
      }
    },
    [
      myItem,
      network,
      selectedDomain,
      allDomainItemsFiltered,
      singleDomainItems,
      browseSelection.selected,
      browseSelection.exitSelect,
      browseSelection.setSelected,
      promptCompleteDraftProfile,
      t,
    ],
  );

  // Legacy: single active action for the selected domain (for CardGrid)
  const activeAction = React.useMemo<DotActionSchema | null>(() => {
    const toDomain = selectedDomain ?? visibleDomains[0]?.id;
    if (!toDomain) return null;
    const actions = getActionsForDomain(toDomain);
    return actions[0] ?? null;
  }, [getActionsForDomain, selectedDomain, visibleDomains]);

  // Build per-domain card items filtered by search, domain, and status, for
  // the LIST view (the map view reads viewport markers instead — decoupled
  // in Task 6/7, #203 §5.2).
  // Derive enum filter field metadata once (used in the memos below and in MapView)
  const enumFilterFields = React.useMemo(
    () => (network ? getEnumFilterFieldsForDomains(network.domains) : []),
    [network],
  );

  // Task 5 (#203 §5.1): the search/enum/map-domain filter, applied to the
  // paged feeds (the full-fetch `domainItems` snapshot this used to read from
  // was removed in Task 7). Single-domain list cards (server already orders
  // nearest-first — no client `sortByNearest`).
  const singleDomainCards = React.useMemo(
    () =>
      selectedDomain
        ? buildFilteredCardsForDomain(selectedDomain, singleDomainItems, {
            search,
            mapSelectedDomains,
            activeFieldFilters,
            enumFilterFields,
          })
        : [],
    [selectedDomain, singleDomainItems, search, mapSelectedDomains, activeFieldFilters, enumFilterFields],
  );

  // "All" tab: same filter applied per-domain to the accumulated paged union.
  const filteredAllDomainItems = React.useMemo(() => {
    const result: Record<string, { id: string; domain: string; data: Record<string, unknown> }[]> = {};
    for (const domain of visibleDomains) {
      result[domain.id] = buildFilteredCardsForDomain(domain.id, allDomainItemsFiltered[domain.id] ?? [], {
        search,
        mapSelectedDomains,
        activeFieldFilters,
        enumFilterFields,
      });
    }
    return result;
  }, [visibleDomains, allDomainItemsFiltered, search, mapSelectedDomains, activeFieldFilters, enumFilterFields]);

  const handleDomainSelect = (domainId: string | null) => {
    setSelectedDomain(domainId);
    setSearchParams((prev) => {
      if (domainId) {
        prev.set('domain', domainId);
      } else {
        prev.delete('domain');
      }
      return prev;
    });
  };

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    setSearchParams((prev) => {
      prev.set('view', mode);
      return prev;
    });
  };

  const handleActiveProfileChange = (profileId: string) => {
    if (profileConsentRequired && !consentedProfileIds.has(profileId)) {
      setPendingConsentProfileId(profileId);
      return;
    }
    setActiveProfileId(profileId);
    if (network?.id) {
      setStoredActiveProfileId(network.id, profileId);
    }
  };

  const handleNetworkSelect = (networkId: string) => {
    setSelectedNetworkId(networkId);
    setSelectedDomain(null);
    setSearchParams((prev) => {
      prev.set('network', networkId);
      prev.delete('domain'); // Remove domain since it's network-specific
      return prev;
    });
  };

  const handleMapDomainsChange = (domains: string[]) => {
    setMapSelectedDomains(domains);
    setSearchParams((prev) => {
      if (domains.length > 0) {
        prev.set('map_domains', domains.join(','));
      } else {
        prev.delete('map_domains');
      }
      return prev;
    });
  };

  const handleMapFieldsChange = (fields: Record<string, string[]>) => {
    setMapSelectedFields(fields);
    setSearchParams((prev) => {
      // Remove all existing f_* params before re-writing
      const keysToDelete: string[] = [];
      for (const key of prev.keys()) {
        if (key.startsWith('f_')) keysToDelete.push(key);
      }
      for (const key of keysToDelete) prev.delete(key);
      // Write active field selections as ?f_<key>=value1,value2
      for (const [fieldKey, values] of Object.entries(fields)) {
        if (values.length > 0) {
          prev.set(`f_${fieldKey}`, values.map(encodeURIComponent).join(','));
        }
      }
      return prev;
    });
  };

  const showNetworkSelector = !servedScope && allNetworks.length > 1;

  const currentDomainLabel = selectedDomain
    ? selectedDomain
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : undefined;

  // Get dynamic actions for the selected domain
  const actions = selectedDomain
    ? getActionsForDomain(selectedDomain)
    : activeAction
      ? [activeAction]
      : [];

  // Label the pending profile so the user knows which profile the (repeating)
  // consent popup is for — reuses the sidebar's title-field candidates.
  const pendingProfileLabel = React.useMemo(() => {
    if (!pendingConsentProfileId) return undefined;
    const profile = myItems.find((p) => p.item_id === pendingConsentProfileId);
    if (!profile) return undefined;
    const schema = userSchemas[profile.item_domain] as
      | { properties?: Record<string, unknown> }
      | undefined;
    const candidates = ['name', 'full_name', 'title', 'provider_id', 'learner_id', 'student_id'];
    const titleKey = candidates.find((c) => schema?.properties?.[c] !== undefined);
    const value = titleKey ? profile.item_state[titleKey] : undefined;
    return value ? String(value) : profile.item_domain;
  }, [pendingConsentProfileId, myItems, userSchemas]);

  const profileConsentModal = (
    <ProfileConsentModal
      open={Boolean(pendingConsentProfileId)}
      statement={profileStatement}
      profileLabel={pendingProfileLabel}
      onAccept={async () => {
        const pending = pendingConsentProfileId;
        if (!pending || !network?.id || !profileDoc) return;
        const profile = myItems.find((p) => p.item_id === pending);
        if (!profile) {
          setPendingConsentProfileId(null);
          return;
        }
        try {
          await acceptProfileConsent({
            network: network.id,
            brand: brand === 'standard' ? null : brand,
            item_domain: profile.item_domain,
            item_type: profile.item_type,
            item_id: profile.item_id,
            version: profileDoc.current_version,
          });
          // Update the consent-status cache directly (not invalidate) so the
          // derived `consentedProfileIds` reflects the accepted profile in the
          // same batched render as the activeProfileId/pendingConsentProfileId
          // updates below — an invalidate-triggered refetch would leave a window
          // where the gate effect sees the old (not-yet-consented) set and
          // reopens the modal it was just told to close.
          queryClient.setQueryData<Set<string>>(
            queryKeys.profileConsent(network.id),
            (prev) => new Set([...(prev ?? []), pending]),
          );
          setActiveProfileId(pending);
          setStoredActiveProfileId(network.id, pending);
          setPendingConsentProfileId(null);
        } catch {
          toast.error(t('profile.error_generic_desc'));
          // Keep the modal open so the user can retry.
        }
      }}
    />
  );

  if (!network) {
    return (
      <>
        <div className="flex h-screen flex-col">
        <div className="h-14 border-b bg-gradient-to-r from-background to-primary/5" />
        <div className="flex flex-1 overflow-hidden">
          <div className="hidden md:block w-64 shrink-0 border-r p-4 space-y-3">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
          <div className="flex-1 p-6 space-y-4">
            <Skeleton className="h-7 w-40" />
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-40 rounded-lg" />
              ))}
            </div>
          </div>
        </div>
        </div>
        {profileConsentModal}
      </>
    );
  }

  // With a single browseable domain there's no "All" — the header names that
  // one domain (derived from visibleDomains, so it's generic, not per-network).
  const headerDomain =
    selectedDomain ?? (visibleDomains.length === 1 ? visibleDomains[0].id : null);
  const contentTitle = headerDomain
    ? headerDomain.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : t('home.browse_all');
  const contentDescription = headerDomain
    ? visibleDomains.find((d) => d.id === headerDomain)?.description
    : undefined;
  // Task 7 (#203 §5.2 cleanup): re-sourced from the list totals — keyed on
  // `selectedDomain` (which paged feed is actually driving the list), not
  // `headerDomain` (a display-only label that can be non-null even on the
  // "All" tab when exactly one domain is visible). This also resolves the
  // P3-deferred header-count-vs-list-total mismatch: the header now reports
  // the same server-side total the "Showing X of Y" list indicator uses,
  // instead of a client-filtered card count.
  const contentCount = selectedDomain !== null ? singleDomainList.total : allDomainsTotalCount;
  const contentLoading = selectedDomain !== null ? singleDomainList.isLoading : allDomainsLoading;

  function buildEmptyState(domainLabel: string) {
    if (search) return <EmptyState message={t('home.no_search_results', { search })} />;
    // GuestHero already shows the sign-in CTA — keep this message simple
    if (!user) return <EmptyState message={t('home.no_listings_yet')} />;
    if (!myItem) {
      return (
        <EmptyState
          heading={t('home.empty_create_heading')}
          message={t('home.empty_create_message')}
          action={
            <Button asChild size="sm">
              <Link to={`/profile/new?network=${selectedNetworkId ?? ''}`}>{t('nav.create_profile')}</Link>
            </Button>
          }
        />
      );
    }
    return (
      <EmptyState
        heading={t('home.nothing_here_heading')}
        message={t('home.no_domain_listings', { domain: domainLabel.toLowerCase() })}
      />
    );
  }

  // Single filters element surfaced in the top bar (next to search) and, when
  // the map is maximized, in the map overlay (the top bar is hidden in
  // fullscreen). Each location instantiates its own popover state; the filter
  // selection itself is controlled via the shared props below.
  const selectButton =
    myItem && viewMode === 'list' ? (
      <Button
        type="button"
        variant={browseSelection.selectMode ? 'default' : 'outline'}
        size="sm"
        onClick={() =>
          browseSelection.selectMode
            ? browseSelection.exitSelect()
            : browseSelection.enterSelect()
        }
      >
        <CheckSquare className="mr-1.5 h-4 w-4" />
        {browseSelection.selectMode ? t('selection.done') : t('selection.select')}
      </Button>
    ) : null;

  const headerActions =
    canToggleLocation || selectButton ? (
      <div className="flex items-center gap-2">
        {canToggleLocation && (
          <LocationSourceToggle
            value={preferredSource}
            onChange={handleLocationSourceChange}
          />
        )}
        {selectButton}
      </div>
    ) : undefined;

  const filtersPanel = (
    <MapFiltersPanel
      domains={visibleDomains}
      selectedDomains={mapSelectedDomains}
      onDomainsChange={handleMapDomainsChange}
      selectedFields={mapSelectedFields}
      onFieldsChange={handleMapFieldsChange}
      viewMode={viewMode}
    />
  );

  return (
    <>
    <PageShell
      networks={showNetworkSelector ? allNetworks : []}
      selectedNetwork={selectedNetworkId}
      onNetworkSelect={handleNetworkSelect}
      domains={visibleDomains}
      selectedDomain={selectedDomain}
      onDomainSelect={handleDomainSelect}
      currentDomainLabel={currentDomainLabel}
      myItems={myItems}
      activeProfileId={activeProfileId}
      onActiveProfileChange={handleActiveProfileChange}
      userSchemas={userSchemas}
      search={search}
      onSearchChange={setSearch}
      viewMode={viewMode}
      onViewModeChange={handleViewModeChange}
      filtersSlot={filtersPanel}
    >
      {!user ? (
        <GuestHero />
      ) : (
        <ContentHeader
          title={contentTitle}
          description={contentDescription}
          count={contentLoading ? undefined : contentCount}
          noProfilePrompt={{ show: !myItem, networkId: selectedNetworkId ?? '' }}
          actions={headerActions}
        />
      )}
      {/* All-tab header count ("X listings") is summed from each visible
          domain's server-reported total, lifted by these headless
          DomainPagedFetch children. In list view the grid below mounts its own
          set; without this, map view never fetches those totals so the count
          stays hidden until the user visits the list once. Gated to map view
          (viewMode !== 'list') so the two sets never double-mount. */}
      {user && network && selectedDomain === null && viewMode !== 'list' &&
        visibleDomains.map((domain) => (
          <DomainPagedFetch
            key={`count-${domain.id}`}
            network={network}
            domain={domain}
            coords={browseCoords}
            onItems={handleDomainItems}
          />
        ))}
      {showLocationBanner && (
        <EnableLocationBanner
          onEnable={() => void browserLocation.request()}
          blocked={geoPermission === 'denied'}
          title={t('home.location_off_title')}
          body={t('home.location_off_body')}
          blockedBody={t('home.location_blocked_body')}
          cta={t('home.location_enable_cta')}
        />
      )}
      <ActionHandler
          onActionSubmit={async (actionType, _actionSchema, formData, targetItemId) => {
            if (!myItem) {
              toast.error(t('home.toast_profile_required'), {
                description: t('home.toast_profile_required_desc'),
              });
              throw new Error('No source item');
            }
            // Draft source profile can't act — prompt to complete it. Throw an
            // ActionAbortedError so ActionHandler suppresses its generic toast.
            if (promptCompleteDraftProfile(myItem)) {
              throw new ActionAbortedError('source profile is draft');
            }
            if (!user) {
              toast.error(t('nav.sign_in_to_connect'), {
                description: t('home.toast_sign_in_desc'),
              });
              throw new Error('No user');
            }
            // Task 7 (#203 §5.2 cleanup): this handler serves BOTH the list
            // view (card actions) and the map view (a popup's connect button),
            // so the target lookup must cover both. List-driven targets are
            // always in one of the paged feeds; a map-driven target may be a
            // viewport marker never paged into either list feed, so fall back
            // to `mapDetailItem` — the full `Item` the open popup already
            // resolved via `useItemDetail` (see `MarkerDetailPopup`).
            const listItems =
              selectedDomain === null ? Object.values(allDomainItemsFiltered).flat() : singleDomainItems;
            const targetItem =
              listItems.find((i) => i.item_id === targetItemId) ??
              (mapDetailItem?.item_id === targetItemId ? mapDetailItem : undefined);
            if (!targetItem) {
              toast.error(t('home.toast_profile_not_found'), {
                description: t('home.toast_profile_not_found_desc'),
              });
              throw new Error('Target item not found');
            }

            // Extract consent sentinel placed by ConsentCheckbox inside ActionModal.
            // Must not appear in requirements_snapshot sent to the server.
            const { [ACTION_CONSENT_SENTINEL]: consentRaw, ...requirementsSnapshot } = formData;
            const consent =
              consentRaw &&
              typeof consentRaw === 'object' &&
              (consentRaw as { acknowledged?: unknown }).acknowledged === true &&
              typeof (consentRaw as { version?: unknown }).version === 'number'
                ? ({
                    acknowledged: true as const,
                    version: (consentRaw as { version: number }).version,
                    brand: (consentRaw as { brand?: string | null }).brand,
                  })
                : undefined;

            // Resolve source item instance URL (where my profile is stored)
            // IMPORTANT: If the source item has localhost as instance_url,
            // it means it was created on the current API instance
            const sourceItemInstanceUrl = myItem.item_instance_url?.includes('localhost')
              ? apiConfig.getUrl()  // Use current API where the item was actually created
              : resolveTargetInstanceUrl(myItem, network, apiConfig.getUrl(), 'source');

            // Resolve target item instance URL dynamically
            // IMPORTANT: If target item has localhost, use current API as fallback
            const targetItemInstanceUrl = targetItem.item_instance_url?.includes('localhost')
              ? apiConfig.getUrl()  // Use current API where the item was actually fetched from
              : resolveTargetInstanceUrl(targetItem, network, apiConfig.getUrl(), 'target');

            await performAction(
              {
                action_type: actionType,
                source_item: {
                  item_network: myItem.item_network,
                  item_domain: myItem.item_domain,
                  item_type: myItem.item_type,
                  item_id: myItem.item_id,
                },
                target_item: {
                  item_network: targetItem.item_network,
                  item_domain: targetItem.item_domain,
                  item_type: targetItem.item_type,
                  item_id: targetItem.item_id,
                  item_instance_url: targetItemInstanceUrl,
                },
                requirements_snapshot: requirementsSnapshot,
                ...(consent ? { consent } : {}),
              },
              sourceItemInstanceUrl // Call the SOURCE instance (where myItem exists)
            );
            // New actions must surface without waiting for the 60s poll (§C5).
            queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
            toast.success(t('home.toast_action_sent', { action: actionType.charAt(0).toUpperCase() + actionType.slice(1) }), {
              description: t('home.toast_action_sent_desc'),
            });
          }}
        >
          {(triggerAction) =>
            viewMode === 'list' ? (
              <>
                {/* Federation-degradation indicator (#203 §6): some peer instances
                    didn't answer in time on at least one loaded page, so the list
                    feed (single-domain or, on the "All" tab, at least one visible
                    domain) is known-partial. Mirrors the map's `mapMarkers.partial`
                    banner (P4) — same styling, in-flow above the grid instead of
                    `fixed` (the list has no maximize overlay to sit above). */}
                {listPartial && (
                  <p className="mb-3 rounded-md bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 shadow-sm ring-1 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-800">
                    {t('home.list_partial')}
                  </p>
                )}
                {selectedDomain === null ? (
              // All tab: flat grid across all domains, each card uses its own schema.
              // Each visible domain gets a headless <DomainPagedFetch> that fetches
              // its own pages server-ordered (nearest-first, §4.1) and lifts the
              // loaded items up; the union is then merge-sorted client-side across
              // domains (§5.1) since no single server call spans domains.
              (() => {
                const pagedFetchers = (
                  <>
                    {visibleDomains.map((domain) => (
                      <DomainPagedFetch
                        key={domain.id}
                        network={network}
                        domain={domain}
                        coords={browseCoords}
                        onItems={handleDomainItems}
                      />
                    ))}
                  </>
                );

                const allFlatItemsUnsorted = visibleDomains.flatMap((domain) => {
                  const domainSchema = domain.item_schemas
                    ? (Object.values(domain.item_schemas)[0] as import('@rjsf/utils').RJSFSchema)
                    : undefined;
                  const domainActions = getActionsForDomain(domain.id);
                  const domainLabel = domain.id
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, (c) => c.toUpperCase());
                  return (filteredAllDomainItems[domain.id] ?? []).map((item) => ({
                    item,
                    schema: domainSchema,
                    domainActions,
                    domainDescription: domain.description,
                    domainLabel,
                    cardConfig: domain.card,
                  }));
                });
                const allFlatItems = sortItemsByNearest(allFlatItemsUnsorted, userLocation, (x) => getItemLocations(x.item.data));

                if (allDomainsLoading) {
                  return (
                    <>
                      {pagedFetchers}
                      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {Array.from({ length: 6 }).map((_, i) => (
                          <DomainCard key={i} schema={{}} data={{}} loading />
                        ))}
                      </div>
                    </>
                  );
                }

                if (allFlatItems.length === 0) {
                  return (
                    <>
                      {pagedFetchers}
                      {buildEmptyState('All')}
                      {/* Client search/enum filtering covers only loaded pages until
                          server-side search (§9/#117) lands — keep the sentinel
                          mounted here too so a filtered-to-empty grid with more
                          server pages still auto-loads instead of dead-ending. */}
                      {anyAllDomainHasMore && (
                        <div ref={allDomainsSentinelRef} aria-hidden="true" className="h-px w-full" />
                      )}
                    </>
                  );
                }

                return (
                  <>
                    {pagedFetchers}
                    {allDomainsLoadedCount < allDomainsTotalCount && (
                      <p className="mb-2 text-xs text-muted-foreground">
                        {t('home.showing_x_of_y', {
                          shown: allDomainsLoadedCount,
                          total: allDomainsTotalCount,
                        })}
                      </p>
                    )}
                    <div ref={allCardsGridRef} className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {allFlatItems.map(({ item, schema, domainActions, domainDescription, domainLabel, cardConfig }) => {
                        const fullItem = Object.values(allDomainItemsFiltered)
                          .flat()
                          .find((i) => i.item_id === item.id);

                        return (
                          <SelectableCard
                            key={item.id}
                            id={item.id}
                            selectMode={browseSelection.selectMode}
                            selected={browseSelection.isSelected(item.id)}
                            selectable={browseSelection.canSelect(item.domain ?? '')}
                            onToggle={(id) => browseSelection.toggle(id, item.domain ?? '')}
                          >
                            <MatchScoreCard
                              schema={schema!}
                              schemaDescription={domainDescription}
                              domainLabel={domainLabel}
                              cardConfig={cardConfig}
                              data={item.data}
                              actions={domainActions}
                              selectionMode={browseSelection.selectMode}
                              onAction={(type, actionSchema) =>
                                triggerAction(type, actionSchema, item.id)
                              }
                              localItem={myItem}
                              networkItem={fullItem || {
                                item_id: item.id,
                                item_network: network?.id || '',
                                item_domain: selectedDomain || '',
                                item_type: 'profile',
                                item_instance_url: null,
                                item_schema_url: null,
                                item_state: item.data,
                                item_locations: [],
                                created_at: new Date().toISOString(),
                                updated_at: new Date().toISOString(),
                              }}
                            />
                          </SelectableCard>
                        );
                      })}
                    </div>
                    {anyAllDomainHasMore && (
                      <div ref={allDomainsSentinelRef} aria-hidden="true" className="h-px w-full" />
                    )}
                  </>
                );
              })()
            ) : (
              // Single domain tab: paged infinite scroll (§5.1). Server already
              // orders nearest-first when coords are known, so no client sort here.
              <>
                {singleDomainList.items.length < singleDomainList.total && (
                  <p className="mb-2 text-xs text-muted-foreground">
                    {t('home.showing_x_of_y', {
                      shown: singleDomainList.items.length,
                      total: singleDomainList.total,
                    })}
                  </p>
                )}
                <CardGrid
                  schema={activeSchema!}
                  schemaName={selectedDomain}
                  schemaDescription={currentDomainLabel}
                  cardConfig={network?.domains.find((d) => d.id === selectedDomain)?.card}
                  items={singleDomainCards}
                  fullItems={singleDomainItems}
                  actions={actions}
                  onAction={(itemId, _type, actionSchema) => {
                    triggerAction(_type, actionSchema, itemId);
                  }}
                  loading={singleDomainList.isLoading}
                  emptyState={buildEmptyState(currentDomainLabel ?? 'items')}
                  localItem={myItem}
                  networkId={network?.id}
                  selectedDomain={selectedDomain}
                  selection={browseSelection}
                />
                <div ref={singleDomainSentinelRef} aria-hidden="true" className="h-px w-full" />
              </>
                )}
                {browseSelection.selectMode && (() => {
                  const lockDomain = browseSelection.lockKey ?? selectedDomain ?? '';
                  const connectAction = lockDomain ? getActionsForDomain(lockDomain)[0] : undefined;
                  return (
                    <>
                      <BulkActionBar
                        count={browseSelection.selected.size}
                        onClear={browseSelection.clear}
                      >
                        <button
                          type="button"
                          disabled={!connectAction || bulkConnectBusy}
                          onClick={() => setBulkConnectOpen(true)}
                          className="rounded-lg bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground disabled:opacity-50"
                        >
                          {t('home.bulk_connect_all', { count: browseSelection.selected.size })}
                        </button>
                      </BulkActionBar>
                      {connectAction && (
                        <ActionModal
                          open={bulkConnectOpen}
                          onOpenChange={(open) => !open && setBulkConnectOpen(false)}
                          actionSchema={connectAction}
                          loading={bulkConnectBusy}
                          onSubmit={(fd) => handleBulkConnect(connectAction.action_type, fd)}
                        />
                      )}
                    </>
                  );
                })()}
              </>
            ) : (
              <div className="relative h-full">
                <MapView
                  schema={activeSchema!}
                  resolveMarkerLabel={resolveMarkerLabel}
                  items={mapItems}
                  focusPoint={userLocation}
                  focusNonce={recenterNonce}
                  filtersSlot={filtersPanel}
                  onViewportChange={setMapViewport}
                  emptyMessage={t('home.map_no_items_in_area')}
                  renderPopup={(marker) => {
                    // Marker ids are `${item_id}#${locationIndex}` — strip the suffix to look up the item.
                    const baseItemId = marker.id.includes('#') ? marker.id.split('#')[0] : marker.id;
                    const sourceMarker = mapMarkers.markers.find(
                      (m) =>
                        m.item_id === baseItemId &&
                        (!marker.domain || m.item_domain === marker.domain),
                    );
                    const domainActions = marker.domain ? getActionsForDomain(marker.domain) : [];
                    const connectAction = domainActions[0];
                    const markerDomain = marker.domain
                      ? network?.domains.find((d) => d.id === marker.domain)
                      : undefined;
                    const markerSchema = markerDomain?.item_schemas
                      ? (Object.values(markerDomain.item_schemas)[0] as import('@rjsf/utils').RJSFSchema)
                      : activeSchema;
                    // Domain's item type (e.g. `job_posting_1.0`) for the by-id
                    // detail fetch — slim markers don't carry it.
                    const markerItemType = markerDomain?.item_schemas
                      ? Object.keys(markerDomain.item_schemas)[0]
                      : undefined;
                    return (
                      <MarkerDetailPopup
                        networkId={network?.id ?? null}
                        marker={marker}
                        sourceMarker={sourceMarker}
                        itemType={markerItemType}
                        schema={markerSchema}
                        cardConfig={markerDomain?.card}
                        localItem={myItem}
                        connectAction={connectAction}
                        onConnect={(itemId) => {
                          if (connectAction) triggerAction(connectAction.action_type, connectAction, itemId);
                        }}
                        onItemResolved={setMapDetailItem}
                      />
                    );
                  }}
                />
                {/* Anonymous count pill (#203 §7, revised): a signed-out visitor
                    at low zoom now sees the clustered pins themselves (fetched
                    slim, capped at MAP_FETCH_LIMIT) so they know where items are.
                    This small non-blocking pill keeps the aggregate total visible
                    without covering the map. `fixed` + high z-index so it stays
                    above the map's own maximize overlay (z-[2000]). */}
                {countFirst && mapMarkers.total > 0 && (
                  <div className="pointer-events-none fixed bottom-6 left-1/2 z-[2100] -translate-x-1/2 px-4">
                    <div className="rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-md backdrop-blur-sm">
                      {t('header.listings', { count: mapMarkers.total })}
                    </div>
                  </div>
                )}
                {/* Federation-degradation indicator (#203 §6): some peer instances
                    didn't answer in time, so the viewport marker set is known-partial.
                    `fixed` (not `absolute`) so it stays visible above the map's own
                    maximize overlay (z-[1000]) in both normal and maximized mode. */}
                {mapMarkers.partial && (
                  <div className="pointer-events-none fixed left-1/2 top-20 z-[2100] -translate-x-1/2 px-4">
                    <p className="pointer-events-auto rounded-md bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 shadow-md ring-1 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-800">
                      {t('home.map_partial')}
                    </p>
                  </div>
                )}
              </div>
            )
          }
        </ActionHandler>
    </PageShell>
    {profileConsentModal}
    </>
  );
}
