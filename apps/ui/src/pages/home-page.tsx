import * as React from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import type { GoLiveGate } from '@dpg/schemas';
import { useSearchParams, useNavigate } from 'react-router-dom';
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
import { useActions } from '@/hooks/use-actions';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ActionHandler } from '@/components/actions/action-handler';
import { MapView } from '@/components/map/map-container';
import { MapErrorBoundary } from '@/components/map/map-error-boundary';
import { SEARCH_AREA_MIN_ZOOM } from '@/lib/map-caps';
import { BrowseFiltersPanel } from '@/components/filters/browse-filters-panel';
import { MarkerPopupCard } from '@/components/map/marker-popup-card';
import { MapCountPill } from '@/components/map/map-count-pill';
import { MarkerDetailSheet } from '@/components/map/marker-detail-sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import '@/components/map/providers';
import { performAction, performActionsBulk, type Item } from '@/lib/item-api';
import { BulkSingleError } from '@/lib/bulk';
import { resolveBulkOutcome } from '@/lib/bulk-outcome';
import { useCardSelection } from '@/hooks/use-card-selection';
import { useNetworkConfigs, useResolvedNetwork, useNetworkConfig } from '@/hooks/use-network-config';
import { BulkActionBar } from '@/components/selection/bulk-action-bar';
import { ActionModal } from '@/components/actions/action-modal';
import { CheckSquare, List } from 'lucide-react';
import { getRuntimeEnv } from '@/lib/runtime-env';
import { formatDomainLabel, pluralizeDomainLabel } from '@/lib/domain-icons';
import { ACTION_CONSENT_SENTINEL, guardianOtpErrorOf, type PerformActionPayload } from '@/lib/action-api';
import { ActionAbortedError } from '@/lib/action-abort';
import { BrowseEmptyState } from '@/components/browse-empty-state';
import { useAuth } from '@/contexts/auth-context';
import { apiConfig } from '@/lib/api-config';
import {
  getActionsForDomain as flattenInteractionActions,
  resolveTargetInstanceUrl,
  computeOpenActionItemIds,
} from '@/lib/profile-actions';
import type { TFunction } from 'i18next';
import { getEnumFilterFieldsForDomains } from '@/lib/enum-filters';
import {
  deriveBrowseParams,
  anchorItemIdForTarget,
  domainsInteract,
  isDiscoverActive,
  resolveListNote,
  excludeOwnItems,
  buildFilteredCardsForDomain,
  DEFAULT_BROWSE_AREA,
  type DerivedBrowseParams,
  type BrowseArea,
  type BrowseSort,
  type ListNoteResult,
} from '@/lib/browse-discover';
import { BrowseToolbar } from '@/components/filters/browse-toolbar';
import { LocationSourceSelect } from '@/components/filters/location-source-select';
import { useAppliedFilterChips } from '@/hooks/use-applied-filter-chips';
import { useBrowseTotals } from '@/hooks/use-browse-totals';
import { resolveFacetFieldLabels } from '@/lib/facet-fields';
import type { DomainOption } from '@/components/filters/domain-control';
import { resolveDefaultDomain, collapseToSingleDomain } from '@/lib/browse-domain';
import { getServedScope } from '@/lib/served-binding';
import { computeVisibleDomains } from '@/lib/visible-domains';
import { useUserLocation } from '@/hooks/use-user-location';
import type { PreferredLocationSource } from '@/hooks/use-user-location';
import { useGeolocationPermission } from '@/hooks/use-geolocation-permission';
import { EnableLocationBanner } from '@/components/location/enable-location-banner';
import type { LatLng } from '@/lib/geo/types';
import { nearestDistanceMeters } from '@/lib/geo/distance';
import {
  getU18Status,
  type U18StatusResponse,
} from '@/lib/consent-api';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { useConsentGate } from '@/hooks/use-consent-gate';
import { useProfileConsentAccept } from '@/hooks/use-profile-consent-accept';
import { useNetworkTheme } from '@/theme/theme-provider';
import { ProfileConsentModal } from '@/components/consent/profile-consent-modal';
import { useMyItems } from '@/hooks/use-my-items';
import {
  getStoredActiveProfileId,
  setStoredActiveProfileId,
  clearStoredActiveProfileId,
} from '@/lib/active-profile';
import { useInfiniteBrowseItems } from '@/hooks/use-infinite-browse-items';
import { useProfileConsentStatus } from '@/hooks/use-profile-consent-status';
import { useMapMarkers } from '@/hooks/use-map-markers';
import { useItemDetail } from '@/hooks/use-item-detail';
import type { Marker as NetworkMarker } from '@/lib/network-api';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { GuardianOtpDialog } from '@/components/actions/guardian-otp-dialog';
import { GuardianOtpPurpose } from '@/components/consent/u18/guardian-otp-purpose';
import { U18GuardianFlow } from '@/components/consent/u18/u18-guardian-flow';
import { isGuardianConsentRequiredDomain } from '@/lib/guardian-consent';

type TriggerAction = Parameters<React.ComponentProps<typeof ActionHandler>['children']>[0];

/**
 * True when the map spans so much longitude that "zoom out" is no usable
 * instruction. 120° is roughly a continental view.
 */
const WIDE_VIEWPORT_LNG_SPAN_DEGREES = 120;

export function isWideViewport(viewport: MapViewport | null): boolean {
  if (viewport?.minLng === undefined || viewport?.maxLng === undefined) return false;
  return viewport.maxLng - viewport.minLng >= WIDE_VIEWPORT_LNG_SPAN_DEGREES;
}

/**
 * Which empty-map message to show. A failed load is not an empty area, and at
 * a world-scale viewport "zoom out" is advice the user cannot act on.
 */
export function mapEmptyMessageKey(opts: { isError: boolean; wideViewport: boolean }): string {
  if (opts.isError) return 'home.map_load_failed';
  if (opts.wideViewport) return 'home.map_no_items_wide';
  return 'home.map_no_items_in_area';
}

// Bottom-sentinel scroll observer: fires `onIntersect` when the sentinel
// scrolls into view. `onIntersect` is read through a ref because
// `useInfiniteBrowseItems` returns a new closure every render, which would
// otherwise recreate the IntersectionObserver on every re-render.
function useLoadMoreSentinel(
  onIntersect: () => void,
  enabled: boolean,
): (node: HTMLDivElement | null) => void {
  const onIntersectRef = React.useRef(onIntersect);
  onIntersectRef.current = onIntersect;
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  const observerRef = React.useRef<IntersectionObserver | null>(null);

  // Callback ref with empty deps, so it re-attaches to the current node: the
  // "All" tab renders the sentinel in more than one branch, so the live node can
  // swap without `enabled` changing. rootMargin fires 200px before the 1px
  // sentinel reaches the fold, which is robust to scroll clamping and momentum.
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

// A marker popup lazily fetches the full item only while shown: the map
// provider calls `renderPopup(marker)` only for the open marker. Hooks cannot
// run inside that callback, hence a standalone component.
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
  connectDisabled,
  connectDisabledReason,
  onItemResolved,
  cardVariant,
}: Readonly<{
  networkId: string | null;
  marker: MapMarker;
  // The network-api `Marker` this marker came from; carries
  // `item_instance_url` for routed fetches.
  sourceMarker: NetworkMarker | undefined;
  // The marker's domain item type (e.g. `job_posting_1.0`), derived by the
  // parent from the network config; the by-id fetch filters on it.
  itemType?: string;
  schema?: RJSFSchema;
  cardConfig?: DotCardConfig | null;
  localItem: Item | null;
  connectAction?: DotActionSchema;
  onConnect?: (baseItemId: string) => void;
  // Disables the connect CTA when an action is already open for this pair.
  connectDisabled?: boolean;
  connectDisabledReason?: string;
  // Lifts the fetched full item to the parent, whose `onActionSubmit` needs it
  // to build a connect-action's `target_item`. A map-only item (never paged
  // into the list feeds) has no other source.
  onItemResolved?: (item: Item) => void;
  /** Forwarded to `MarkerPopupCard` — `'list'` in the phone bottom sheet. */
  cardVariant?: 'popup' | 'list';
}>) {
  const { t } = useTranslation();
  const { data: popupNetworkConfig } = useNetworkConfig(networkId ?? null);
  // Marker ids are `${item_id}#${locationIndex}` — strip the suffix to look up the item.
  const baseItemId = marker.id.includes('#') ? marker.id.split('#')[0] : marker.id;
  // Fetch from the marker's own id + domain; do not wait for `sourceMarker` in
  // the live markers array, which churns as the viewport refetches and would
  // leave the popup on "Loading…". `sourceMarker` only adds the optional
  // owning-instance URL.
  const itemDomain = marker.domain ?? sourceMarker?.item_domain;

  const { item, isLoading } = useItemDetail(
    networkId,
    itemDomain
      ? {
          item_id: baseItemId,
          item_domain: itemDomain,
          // Slim markers carry no item type, so the parent derives it from the
          // domain config; without it the by-id fetch matches nothing.
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

  // The slim marker carries no item_state and only a generic label, so enrich
  // it with the fetched item's state and real title. Keep the marker's
  // location, precision and domain.
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
      connectDisabled={connectDisabled}
      connectDisabledReason={connectDisabledReason}
      localItem={localItem}
      networkItem={item}
      domains={popupNetworkConfig?.domains}
      cardVariant={cardVariant}
    />
  );
}

function parseNetworkIds(networkEnv: string | undefined): string[] {
  if (!networkEnv) return [];
  return networkEnv.split(',').map(n => n.trim()).filter(Boolean);
}

// The landing-page view mode from VITE_DEFAULT_VIEW_MODE; 'map' when missing or
// unrecognised.
function resolveDefaultViewMode(): ViewMode {
  const raw = getRuntimeEnv('VITE_DEFAULT_VIEW_MODE');
  if (raw === 'list' || raw === 'map') return raw;
  return 'map';
}


/**
 * Whether the domain requires profile_creation consent before go-live, from
 * its `go_live_required` gates. Absent config requires it.
 */
function domainNeedsProfileConsent(
  domains:
    | ReadonlyArray<{ id: string; go_live_required?: GoLiveGate[] }>
    | undefined,
  domainId: string | undefined,
): boolean {
  const gates = domains?.find((d) => d.id === domainId)?.go_live_required;
  return gates ? gates.includes('consent_required') : true;
}

/** The parsed served-domain scope, or null when the deployment serves all domains. */
type HomeServedScope = ReturnType<typeof getServedScope>;

/** The single served domain when exactly one is bound (the single-domain portal), else null. */
function resolveBoundDomain(servedScope: HomeServedScope): string | null {
  return servedScope?.domains.length === 1 ? servedScope.domains[0] : null;
}

/**
 * Resolve the initial selected-network id: a served scope pins it, else a valid
 * `?network=` URL param, else the first configured network id.
 */
function resolveInitialNetworkId(
  servedScope: HomeServedScope,
  networkFromUrl: string | null,
  configuredNetworkIds: string[],
): string | null {
  if (servedScope?.network) return servedScope.network;
  if (networkFromUrl && configuredNetworkIds.includes(networkFromUrl)) return networkFromUrl;
  return configuredNetworkIds[0] || null;
}

/** Whether the location-source toggle applies (a profile location exists AND the browser can provide one). */
function computeCanToggleLocation(profileLocation: LatLng | null, browserSupported: boolean): boolean {
  return Boolean(profileLocation) && browserSupported;
}

/** Whether to offer the "enable location" banner (toggle applies, browser source picked, but it errored). */
function computeShowLocationBanner(
  canToggle: boolean,
  preferredSource: PreferredLocationSource,
  browserStatus: string,
): boolean {
  return canToggle && preferredSource === 'browser' && browserStatus === 'error';
}

/** Whether the active profile's domain gates go-live on profile_creation consent (absent config ⇒ require). */
function computeProfileConsentRequired(
  profileStatement: string,
  domains: Parameters<typeof domainNeedsProfileConsent>[0],
  itemDomain: string | undefined,
): boolean {
  return Boolean(profileStatement) && domainNeedsProfileConsent(domains, itemDomain);
}

/** Whether the ward's domain requires the U18 guardian gate (needs an authenticated user on a gated domain). */
function computeRequiresGuardianGate(
  user: unknown,
  network: DotNetworkSchema | null | undefined,
  wardDomain: string | null,
): boolean {
  return Boolean(user && network && wardDomain && isGuardianConsentRequiredDomain(network, wardDomain));
}

/** Derives the U18 guardian-flow display state from the stored status and gate signals. */
function deriveU18GuardianState(p: {
  status: U18StatusResponse | null;
  statusLoading: boolean;
  gateLoading: boolean;
  dismissed: boolean;
  requiresGate: boolean;
  neededConsentCount: number;
}): {
  resolvedAdult: boolean;
  initialStep: 'dob' | 'guardian';
  birthUnresolved: boolean;
  minorNeedsGuardian: boolean;
  showFlow: boolean;
} {
  const resolvedAdult = p.status?.hasBirthData === true && p.status.isMinor === false;
  const initialStep: 'dob' | 'guardian' = p.status?.hasBirthData ? 'guardian' : 'dob';
  const birthUnresolved = !p.statusLoading && p.status?.hasBirthData !== true;
  const minorNeedsGuardian = p.status?.isMinor === true && p.status?.guardianVerified !== true;
  const showFlow =
    p.requiresGate &&
    !p.gateLoading &&
    !p.dismissed &&
    !p.statusLoading &&
    !resolvedAdult &&
    (p.neededConsentCount > 0 || birthUnresolved || minorNeedsGuardian);
  return { resolvedAdult, initialStep, birthUnresolved, minorNeedsGuardian, showFlow };
}

/** Pick the single-domain value on a specific domain tab, else the "All"-tab aggregate. */
function resolveSingleDomainAnchor(
  selectedDomain: string | null,
  anchorFor: (targetDomain: string) => string | undefined,
): string | undefined {
  return selectedDomain ? anchorFor(selectedDomain) : undefined;
}

/**
 * Whether a profile anchor is actually being sent for the browsed domain(s) —
 * gated by the schema interaction matrix, not merely "signed in with a profile".
 */
function computeHasProfileAnchor(p: {
  selectedDomain: string | null;
  anchorFor: (targetDomain: string) => string | undefined;
  activeProfileId: string | null;
  activeProfileDomain: string | null;
  visibleDomains: DotNetworkDomain[];
  networkActions: Parameters<typeof domainsInteract>[0];
}): boolean {
  if (p.selectedDomain !== null) return p.anchorFor(p.selectedDomain) !== undefined;
  const { activeProfileDomain } = p;
  return Boolean(
    p.activeProfileId &&
      activeProfileDomain &&
      p.visibleDomains.some((domain) => domainsInteract(p.networkActions, activeProfileDomain, domain.id)),
  );
}

/**
 * A resolved list note to its display string. The interpolated
 * `locationSource` is itself a translation key, so it needs a second `t` call.
 */
function formatListNote(t: TFunction, note: ListNoteResult): string {
  if (!note.values) return t(note.key);
  return t(note.key, {
    km: note.values.km,
    locationSource: t(`home.location_source_${note.values.locationSource}`),
  });
}

/** The location source for the list-note wording ('none' reads as 'profile'). */
function noteLocationSource(resolvedLocationSource: string): 'browser' | 'profile' {
  return resolvedLocationSource === 'browser' ? 'browser' : 'profile';
}

/** Whether the network selector should render (no served scope, more than one network). */
function computeShowNetworkSelector(servedScope: HomeServedScope, networkCount: number): boolean {
  return !servedScope && networkCount > 1;
}

/** The dynamic actions to surface: the selected domain's, else the legacy single active action, else none. */
function resolveDomainActions(
  selectedDomain: string | null,
  getActionsForDomain: (targetDomain: string) => DotActionSchema[],
  activeAction: DotActionSchema | null,
): DotActionSchema[] {
  if (selectedDomain) return getActionsForDomain(selectedDomain);
  return activeAction ? [activeAction] : [];
}

/** Normalise a guardian-flow action type to the OTP-purpose kind ('connect' or 'apply'). */
function guardianActionKind(actionType: string | undefined): 'connect' | 'apply' {
  return actionType === 'connect' ? 'connect' : 'apply';
}

/** The network list the PageShell selector renders (empty unless the selector should show). */
function pickNetworksForShell(
  showNetworkSelector: boolean,
  allNetworks: DotNetworkSchema[],
): DotNetworkSchema[] {
  return showNetworkSelector ? allNetworks : [];
}

/** `?map_domains=seeker,provider` → the map's domain selection. */
function parseMapDomainsParam(searchParams: URLSearchParams): string[] {
  const raw = searchParams.get('map_domains');
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `?f_<field>=a,b` → the active facet set. One param per field keeps a filter
 * link readable and hand-editable.
 */
function parseFacetParams(searchParams: URLSearchParams): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [param, value] of searchParams.entries()) {
    if (!param.startsWith('f_')) continue;
    const fieldKey = param.slice(2);
    if (!fieldKey) continue;
    const values = value
      .split(',')
      .map((s) => decodeURIComponent(s.trim()))
      .filter(Boolean);
    if (values.length > 0) result[fieldKey] = values;
  }
  return result;
}

/**
 * Splits the action-consent sentinel out of a submitted action form.
 * `ConsentCheckbox` stores its acknowledgement under `ACTION_CONSENT_SENTINEL`
 * in the same `formData` as the requirement answers, and it must never reach
 * the server inside `requirements_snapshot`. Validated structurally: a
 * malformed or unacknowledged sentinel yields `undefined` (no consent claimed).
 */
function splitActionConsent(formData: Record<string, unknown>): {
  consent: { acknowledged: true; version: number; brand?: string | null } | undefined;
  requirementsSnapshot: Record<string, unknown>;
} {
  const { [ACTION_CONSENT_SENTINEL]: consentRaw, ...requirementsSnapshot } = formData;
  const ack = consentRaw as { acknowledged?: unknown; version?: unknown; brand?: string | null };
  const valid =
    !!consentRaw &&
    typeof consentRaw === 'object' &&
    ack.acknowledged === true &&
    typeof ack.version === 'number';

  return {
    consent: valid
      ? { acknowledged: true, version: ack.version as number, brand: ack.brand }
      : undefined,
    requirementsSnapshot,
  };
}

/**
 * Where an item lives, for an action payload. A stored localhost
 * `item_instance_url` means the item was created on the API this build talks
 * to, so the configured URL is used; anything else resolves through the
 * network config.
 */
function instanceUrlForAction(item: Item, network: DotNetworkSchema): string {
  return item.item_instance_url?.includes('localhost')
    ? apiConfig.getUrl()
    : resolveTargetInstanceUrl(item, network, apiConfig.getUrl());
}

/**
 * Whether the server ranked by relevance. Optimistic before the first
 * response so the list note does not flicker in, but false once a response
 * reports no order, since the note must not then claim profile relevance.
 * Module-level to keep `HomePage` under the cognitive-complexity limit.
 */
function resolveRelevanceApplied(
  applied: BrowseSort | undefined,
  unreported: boolean,
  requested: BrowseSort,
): boolean {
  if (unreported) return false;
  return (applied ?? requested) === 'relevance';
}

export function HomePage() {
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [search, setSearch] = React.useState('');
  const [viewMode, setViewMode] = React.useState<ViewMode>(
    (searchParams.get('view') as ViewMode) ?? resolveDefaultViewMode()
  );
  const [selectedDomain, setSelectedDomain] = React.useState<string | null>(
    searchParams.get('domain')
  );
  // Map domain filter (?map_domains=seeker,provider).
  const [mapSelectedDomains, setMapSelectedDomains] = React.useState<string[]>(() =>
    parseMapDomainsParam(searchParams),
  );
  // Map enum-field filters, one param per field (?f_<key>=value1,value2).
  const [mapSelectedFields, setMapSelectedFields] = React.useState<Record<string, string[]>>(() =>
    parseFacetParams(searchParams),
  );
  // Map viewport: null until the map reports its first settled
  // `onViewportChange`, so `useMapMarkers` stays disabled until then.
  const [mapViewport, setMapViewport] = React.useState<MapViewport | null>(null);
  // The full `Item` last resolved by an open marker popup (see
  // `MarkerDetailPopup`'s `onItemResolved`).
  const [mapDetailItem, setMapDetailItem] = React.useState<Item | null>(null);
  // Phone map: a tapped marker opens in a bottom sheet instead of the
  // provider's popup. `null` = closed.
  const isMobile = useIsMobile();
  const [sheetMarker, setSheetMarker] = React.useState<MapMarker | null>(null);
  // Leaving the map closes it, so returning to the map does not re-open it.
  React.useEffect(() => {
    if (viewMode !== 'map') setSheetMarker(null);
  }, [viewMode]);
  const configuredNetworkIds = parseNetworkIds(import.meta.env.VITE_NETWORK_ID);
  // Domains this deployment serves (VITE_SERVED_BINDINGS), or null for all.
  // Exactly one served domain is the forced browse domain (single-domain
  // portal). Runtime config is fixed for the session, hence memoised once.
  const servedScope = React.useMemo(() => getServedScope(), []);
  const boundDomain = resolveBoundDomain(servedScope);

  // Network: the served scope pins it; otherwise URL param, then env config.
  const networkFromUrl = searchParams.get('network');
  const initialNetworkId = resolveInitialNetworkId(servedScope, networkFromUrl, configuredNetworkIds);

  const [selectedNetworkId, setSelectedNetworkId] = React.useState<string | null>(initialNetworkId);
  const [activeProfileId, setActiveProfileId] = React.useState<string | null>(null);
  const [pendingConsentProfileId, setPendingConsentProfileId] = React.useState<string | null>(null);
  const browseSelection = useCardSelection();
  const [bulkConnectOpen, setBulkConnectOpen] = React.useState(false);
  const [bulkConnectBusy, setBulkConnectBusy] = React.useState(false);
  // Minor ward bulk action: gated items come back GUARDIAN_OTP_REQUIRED after
  // one OTP goes to the guardian. Stash the payloads to resubmit with the code
  // (one guardian OTP dialog for the batch).
  const [bulkGuardianChallenge, setBulkGuardianChallenge] = React.useState<{
    payloads: PerformActionPayload[];
    sourceInstanceUrl?: string;
    actionType: string;
    // Non-guardian failures from a mixed batch, reselected once the guardian
    // dialog resolves so they can be retried.
    otherFailedIds?: string[];
  } | null>(null);
  // Minor ward: the "a code will be sent to your guardian" confirm shown before
  // a bulk action dispatches the OTP. Holds the deferred submit and action type.
  const [bulkGuardianConfirm, setBulkGuardianConfirm] = React.useState<
    { run: () => void; actionType: string } | null
  >(null);

  // Networks list and the resolved selected network.
  const { data: networksData } = useNetworkConfigs();
  const allNetworks = React.useMemo<DotNetworkSchema[]>(() => {
    if (!networksData) return [];
    return configuredNetworkIds.length > 0
      ? networksData.filter((n) => configuredNetworkIds.includes(n.id))
      : networksData;
  }, [networksData, configuredNetworkIds]);

  const { data: resolvedNetwork } = useResolvedNetwork(selectedNetworkId);
  const network = resolvedNetwork;

  // My profiles across domains and their profile-consent status.
  const { data: myItems, isFetched: myItemsFetched } = useMyItems(network);
  const consentQuery = useProfileConsentStatus(network);
  const consentedProfileIds = consentQuery.data ?? new Set<string>();
  // Settled = resolved either way (fail-open: an error yields an empty set, so
  // the gate can still prompt). Signed-out users resolve immediately.
  const profilesResolved = !user || myItemsFetched;
  const consentLoaded = !user || consentQuery.isSuccess || consentQuery.isError;
  const queryClient = useQueryClient();

  // Default to the first network once the list loads, if none is selected.
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

  // A marker's label comes from its own domain's card.title_field, so titles
  // are right in the "All" view where markers span domains.
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

  // Restore or auto-select the active profile once per network after
  // my-profiles settle. The ref stops a background refetch from resetting a
  // manual selection.
  const restoredForNetwork = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!user) {
      // Signed out: clear selection and any open consent gate; allow restore
      // on the next sign-in.
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

  const myItem = React.useMemo(() => {
    if (!myItems.length) return null;
    return myItems.find((i) => i.item_id === activeProfileId) ?? myItems[0] ?? null;
  }, [myItems, activeProfileId]);

  // Item ids the active profile already has an open action with, in either
  // direction; their Connect/Apply CTA is disabled (one open action per pair).
  // The server cap is the real guard.
  const { data: myActionsData } = useActions('all', { enabled: !!user, limit: 100 });
  const openActionItemIds = React.useMemo(
    () => computeOpenActionItemIds(myActionsData?.actions ?? [], activeProfileId),
    [myActionsData, activeProfileId],
  );

  // A draft profile cannot act (the API returns PROFILE_NOT_LIVE), so prompt to
  // finish it instead. Returns true when the caller should abort.
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

  // The active profile's first location, or null to fall back to browser geo.
  const profileLocation = React.useMemo(
    () =>
      myItem?.item_locations?.[0]
        ? { lat: myItem.item_locations[0].lat, lng: myItem.item_locations[0].lng }
        : null,
    [myItem],
  );

  // Profile location → browser geo → null. The browser prompt waits for
  // profilesResolved so a user with a profile location is not prompted while
  // profiles load.
  const [preferredSource, setPreferredSource] =
    React.useState<PreferredLocationSource>('profile');

  const {
    location: userLocation,
    source: resolvedLocationSource,
    browser: browserLocation,
  } = useUserLocation(profileLocation, profilesResolved, preferredSource);
  const geoPermission = useGeolocationPermission();

  // The toggle needs a profile location to switch from and a browser that can
  // provide the alternative.
  const canToggleLocation = computeCanToggleLocation(profileLocation, browserLocation.isSupported);

  // "Current location" picked but the browser request errored: offer to enable
  // it. Only while a profile location exists, since the banner copy says
  // results fall back to it.
  const showLocationBanner = computeShowLocationBanner(
    canToggleLocation,
    preferredSource,
    browserLocation.status,
  );

  // Bumped on every source pick so the map recenters even when the resolved
  // coordinate is unchanged (e.g. back to "My profile" after a denied browser
  // request, or re-picking the active source after panning away).
  const [recenterNonce, setRecenterNonce] = React.useState(0);

  // Bumped before a marker popup's Connect/Apply opens the consent modal, so
  // the map closes the popup first; otherwise the popup sits above the
  // mobile bottom-sheet and hides the consent checkbox and Confirm.
  const [closePopupNonce, setClosePopupNonce] = React.useState(0);

  const handleLocationSourceChange = React.useCallback(
    (next: PreferredLocationSource) => {
      setPreferredSource(next);
      setRecenterNonce((n) => n + 1);
      // An explicit "Current location" click always retries: the auto-request
      // only fires from `idle`, and the browser re-prompts while permission is
      // still promptable.
      if (next === 'browser' && browserLocation.status !== 'loading') {
        void browserLocation.request();
      }
    },
    [browserLocation],
  );

  // Profile-creation consent gate: aggregator-created profiles have no
  // profile_creation consent recorded, so selecting one prompts first.
  const { config: consentConfig } = useConsentConfig();
  const { brand } = useNetworkTheme();
  const profileDoc = consentConfig?.documents.profile_creation;
  const profileVersion = profileDoc?.versions.find(
    (v) => v.version === profileDoc.current_version,
  );
  const profileStatement = profileVersion?.statement ?? '';
  // Whether the active profile's domain gates go-live on `consent_required`.
  // Absent config requires it.
  const profileConsentRequired = computeProfileConsentRequired(
    profileStatement,
    network?.domains,
    myItem?.item_domain,
  );

  // Shared profile_creation consent accept flow (adult self-accept or minor
  // guardian OTP). `dialogs` hosts the guardian dialogs; `guardianActive` hides
  // the ProfileConsentModal below while one is open.
  const {
    accept: acceptProfileConsentFlow,
    dialogs: consentAcceptDialogs,
    guardianActive,
  } = useProfileConsentAccept();

  // Prompt when the auto-selected profile lacks profile_creation consent.
  React.useEffect(() => {
    if (
      // `activeProfileId` can briefly hold a stale stored value after sign-out
      // or a user switch, so require a user and an owned profile.
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

  // U18 guardian consent gate. The domain comes from the ward's own profile
  // item. Only wards in a `guardian_consent_required` domain who still need
  // terms/privacy consent go through the guardian flow (the guardian OTP
  // verify records those categories).
  const wardDomain = myItem?.item_domain ?? null;
  const requiresGuardianGate = computeRequiresGuardianGate(user, network, wardDomain);
  const {
    needed: u18NeededConsent,
    isLoading: u18GateLoading,
    refetch: refetchU18Gate,
  } = useConsentGate();
  const [guardianFlowDismissed, setGuardianFlowDismissed] = React.useState(false);

  // Re-evaluate when the network or ward domain changes.
  React.useEffect(() => {
    setGuardianFlowDismissed(false);
  }, [network?.id, wardDomain]);

  // Stored U18 status (birth year captured once). Stored birth data skips the
  // DOB step, and a stored adult never enters the guardian flow.
  const [u18Status, setU18Status] = React.useState<U18StatusResponse | null>(null);
  const [u18StatusLoading, setU18StatusLoading] = React.useState(false);
  // Bumped after the guardian flow completes so the stored status is re-read;
  // a stale one would re-trigger the DOB step at the next profile creation.
  const [u18StatusReload, setU18StatusReload] = React.useState(0);
  React.useEffect(() => {
    // Fetch even with no profile yet, or the first profile creation cannot
    // tell the ward is a minor.
    if (!user || !network) {
      setU18Status(null);
      return;
    }
    let cancelled = false;
    setU18StatusLoading(true);
    getU18Status(network.id)
      .then((s) => { if (!cancelled) setU18Status(s); })
      // On failure u18Status stays null → initialStep 'dob'; a transient error
      // never leaves a minor ungated.
      .catch(() => { if (!cancelled) setU18Status(null); })
      .finally(() => { if (!cancelled) setU18StatusLoading(false); });
    return () => { cancelled = true; };
  }, [user, network, network?.id, u18StatusReload]);

  // U18 guardian-flow display state (see `deriveU18GuardianState`):
  //  - resolvedAdult: stored data says adult, so no guardian gate.
  //  - initialStep: skip the DOB step when birth data is already stored.
  //  - birthUnresolved: run the DOB step even when terms/privacy are satisfied,
  //    or a bulk/form ward who accepted at login is never asked and the server
  //    cannot detect a minor.
  //  - minorNeedsGuardian: gate an unverified minor even when terms/privacy
  //    are satisfied, or they land with no way to attach a guardian.
  const {
    initialStep: u18InitialStep,
    showFlow: showU18GuardianFlow,
  } = deriveU18GuardianState({
    status: u18Status,
    statusLoading: u18StatusLoading,
    gateLoading: u18GateLoading,
    dismissed: guardianFlowDismissed,
    requiresGate: requiresGuardianGate,
    neededConsentCount: u18NeededConsent.length,
  });

  // Acting domain: ?as= test override → served binding → active profile →
  // network default. Drives the connect-action source domain.
  const currentDomain =
    searchParams.get('as') ??
    boundDomain ??
    myItem?.item_domain ??
    network?.domains[0]?.id ??
    'student_profile';

  // Viewer domain for browse scoping: ?as= → single served domain → own
  // profile domain → null. A signed-in viewer browses only domains their domain
  // can initiate toward; null (signed out / no profile) browses all to_domains.
  const viewerDomain =
    searchParams.get('as') ?? boundDomain ?? myItem?.item_domain ?? null;

  const visibleDomains = React.useMemo(
    () => (network ? computeVisibleDomains(network, viewerDomain) : []),
    [network, viewerDomain],
  );

  const mapDomains = React.useMemo(
    () =>
      mapSelectedDomains.length > 0
        ? visibleDomains.filter((d) => mapSelectedDomains.includes(d.id))
        : visibleDomains,
    [mapSelectedDomains, visibleDomains],
  );

  // Domains whose fields drive the browse filters. Must match the domains
  // actually queried: the server silently drops a facet not declared for the
  // item's own domain (so undeclared/private fields cannot be enumerated), and
  // blue_dot's seeker and provider schemas share no field names. The map is
  // multi-domain (`mapSelectedDomains`); the list is single-domain
  // (`selectedDomain`).
  const filterFieldDomains = React.useMemo(() => {
    if (viewMode === 'map') return mapDomains;
    if (selectedDomain) {
      const selected = visibleDomains.filter((d) => d.id === selectedDomain);
      if (selected.length > 0) return selected;
    }
    const counterparts = visibleDomains.filter((d) => d.id !== viewerDomain);
    return counterparts.length > 0 ? counterparts : visibleDomains;
  }, [visibleDomains, viewerDomain, selectedDomain, viewMode, mapDomains]);

  // A domain is always selected; `null` is only a transient pre-network state.
  // Resolves the default once the network and visible domains are known, and
  // repairs an invalid selection (stale `?domain=`, or a domain the
  // interaction matrix no longer shows).
  React.useEffect(() => {
    if (!network || visibleDomains.length === 0) return;
    const resolved = resolveDefaultDomain({
      fromParam: selectedDomain,
      visibleDomains,
      viewerDomain: myItem?.item_domain ?? null,
      actions: network.actions ?? {},
    });
    if (!resolved || resolved === selectedDomain) return;

    setSelectedDomain(resolved);

    // Rewrite the URL only when repairing a param that was present. Writing a
    // resolved default would race other `setSearchParams` callers in the same
    // tick (a network switch deletes `domain`) and pin a shared link to the
    // sharer's default.
    if (selectedDomain !== null) {
      setSearchParams((prev) => {
        prev.set('domain', resolved);
        return prev;
      });
    }
  }, [network, selectedDomain, visibleDomains, myItem, setSearchParams]);

  // Enum-field facet filters sent to the server on the map path as
  // `item_state.<field>` params (see `fetchNetworkMarkers`). Computed here so
  // it is ready before `useMapMarkers`.
  const activeFieldFilters = React.useMemo(
    () => Object.fromEntries(Object.entries(mapSelectedFields).filter(([, vals]) => vals.length > 0)),
    [mapSelectedFields],
  );

  // Design: docs/architecture/ui-home-browse.md
  // The map fetches slim viewport markers per selected domain (empty selection
  // = all visible) and clusters them; free-text `search` and the facets are
  // applied server-side.
  const mapMarkers = useMapMarkers(network, mapDomains, mapViewport, activeFieldFilters, search);

  // Per-target-domain profile anchor: `anchorItemIdForTarget` consults the
  // interaction matrix to decide whether the active profile may anchor
  // discover calls for `targetDomain`. Used by both the map totals and the list.
  const anchorFor = React.useCallback(
    (targetDomain: string): string | undefined =>
      anchorItemIdForTarget({
        activeProfileId,
        activeProfileDomain: myItem?.item_domain ?? null,
        targetDomain,
        actions: network?.actions ?? {},
      }),
    [activeProfileId, myItem, network],
  );

  // Filter-scoped totals for the map's filter bar; the list gets its total from
  // its own feed, so these requests run on the map only.
  const browseTotals = useBrowseTotals(
    network,
    mapDomains,
    activeFieldFilters,
    search,
    viewMode === 'map',
    // The list's anchor too, or a typed query does not narrow this count.
    anchorFor,
  );


  // The viewer's own item ids across every domain: the map never renders the
  // viewer's own pins (they cannot act on themselves).
  const ownMapItemIds = React.useMemo(
    () => new Set((myItems ?? []).map((it) => it.item_id)),
    [myItems],
  );

  const mapItems = React.useMemo(
    () =>
      mapMarkers.markers
        .filter((m) => !ownMapItemIds.has(m.item_id))
        .map((m) => ({
          id: m.item_id,
          domain: m.item_domain,
          data: { item_locations: m.item_locations },
        })),
    [mapMarkers.markers, ownMapItemIds],
  );

  const localProfileItemIds = React.useMemo(
    () => new Set(myItems.filter((item) => item.item_domain === currentDomain).map((item) => item.item_id)),
    [myItems, currentDomain]
  );

  // Paged list view. The selected domain's schema object, and the coords for
  // server-side nearest ordering (null when no location is known).
  const selectedDomainObj = React.useMemo(
    () => (selectedDomain ? (network?.domains.find((d) => d.id === selectedDomain) ?? null) : null),
    [network, selectedDomain],
  );
  const browseCoords = React.useMemo(
    () => (userLocation ? { lat: userLocation.lat, lng: userLocation.lng } : null),
    [userLocation],
  );

  // Area filter and sort. `area` defaults to `anywhere`, which sends no
  // coordinates: signals-search turns a spatial clause into a hard distance
  // filter, so the resolved location is only offered as the radius centre and
  // used as the `nearest` ordering centre.
  const [area, setArea] = React.useState<BrowseArea>(DEFAULT_BROWSE_AREA);
  const [sort, setSort] = React.useState<BrowseSort>('relevance');

  // An active radius is re-centred on whatever "Search near" currently
  // resolves, not the centre `AreaSelect` captured at pick time, so switching
  // location source moves the radius too. Falls back to the captured centre
  // when no location resolves. `viewport` is untouched: its centre is the
  // rectangle.
  const resolvedArea = React.useMemo<BrowseArea>(
    () =>
      area.mode === 'radius' ? { ...area, center: browseCoords ?? area.center } : area,
    [area, browseCoords],
  );

  const browseParams = React.useMemo<DerivedBrowseParams>(
    () => deriveBrowseParams({ search, activeFieldFilters, area: resolvedArea, sort }),
    [search, activeFieldFilters, resolvedArea, sort],
  );
  // The ordering centre only; it never filters.
  const browseLocation = browseCoords;
  // Discover params shared by the list paths. `anchorItemId` is not shared:
  // signals-search returns 403 `INTERACTION_NOT_ALLOWED` when the anchor's
  // domain has no interaction with the browsed domain, so it is computed per
  // target domain (`anchorFor`).
  const browseHookOpts = React.useMemo(
    () => ({
      q: browseParams.q,
      filters: browseParams.filters,
      relevance: browseParams.relevance,
      area: browseParams.area,
      sort: browseParams.sort,
    }),
    [browseParams],
  );
  // True when the discover BFF serves the feed (q, filters or relevance); the
  // server already filtered, so `buildFilteredCardsForDomain` skips its own.
  const listDiscover = isDiscoverActive(browseParams);

  // Single-domain paged fetch.
  const singleDomainList = useInfiniteBrowseItems(
    network,
    selectedDomainObj,
    browseLocation,
    {
      // Wait for a valid domain: `selectedDomain` can briefly hold a stale
      // `?domain=`, and fetching it wastes a request (or draws a 403 on the
      // anchor for a non-interacting domain).
      enabled:
        selectedDomain !== null && visibleDomains.some((d) => d.id === selectedDomain),
      ...browseHookOpts,
      anchorItemId: resolveSingleDomainAnchor(selectedDomain, anchorFor),
    },
  );

  // Drop the viewer's own items from the feed, in both discover modes.
  const singleDomainItems = React.useMemo(() => {
    const own = excludeOwnItems(singleDomainList.items, localProfileItemIds);

    // Under `nearest` the card's pill is the distance. signals-search returns
    // `distanceMeters`; the native fallback orders by distance but does not
    // project it, so compute it client-side from the same stored (PII-jittered)
    // coordinates. Haversine error is far below the label's precision.
    if (singleDomainList.sortApplied !== 'nearest' || !browseCoords) return own;

    return own.map((item) => {
      if (item.distanceMeters != null) return item;
      const meters = nearestDistanceMeters(browseCoords, item.item_locations);
      if (!Number.isFinite(meters)) return item;
      return { ...item, distanceMeters: meters };
    });
  }, [singleDomainList.items, singleDomainList.sortApplied, localProfileItemIds, browseCoords]);

  // Bottom sentinel advances the paged fetch; the server already orders
  // nearest-first. Passing the non-memoized `fetchNextPage` is safe (the
  // sentinel reads it through a ref).
  const singleDomainSentinelRef = useLoadMoreSentinel(
    singleDomainList.fetchNextPage,
    singleDomainList.hasNextPage,
  );

  // List federation-degradation banner and note inputs, from the one paged feed.
  const listPartial = singleDomainList.partial;
  const listDegraded = singleDomainList.degraded;
  const listDistanceMeters = singleDomainList.distanceMeters;
  // Label from what the server did, not what was asked: a `relevance` request
  // with no anchor and no text degrades to `newest`.
  const listSortApplied = singleDomainList.sortApplied;
  // A response arrived carrying no order (see the hook); distinct from
  // `listSortApplied === undefined`, which also covers "nothing loaded yet".
  const listSortUnreported = singleDomainList.sortUnreported;
  // Whether a profile anchor is actually sent for the browsed domain, using the
  // same `domainsInteract` rule that gates the anchor. A directory-style
  // network can have no interaction edge to the viewer's domain, and the note
  // must not then claim profile relevance.
  const activeProfileDomain = myItem?.item_domain ?? null;
  const hasProfileAnchor = computeHasProfileAnchor({
    selectedDomain,
    anchorFor,
    activeProfileId,
    activeProfileDomain,
    visibleDomains,
    networkActions: network?.actions ?? {},
  });
  // Whether a location is actually being sent as the discover spatial filter.
  const hasLocation = browseLocation !== null;
  const listNote = resolveListNote({
    hasProfileAnchor,
    // See `resolveRelevanceApplied`.
    relevanceApplied: resolveRelevanceApplied(listSortApplied, listSortUnreported, sort),
    hasLocation,
    degraded: listDegraded,
    distanceMeters: listDistanceMeters,
    // The effective source of the coordinate actually sent, not the toggle
    // preference: with no profile, useUserLocation uses the browser coordinate.
    locationSource: noteLocationSource(resolvedLocationSource),
  });

  // Active schema: the selected domain's, else the first visible domain's.
  const activeSchema = React.useMemo(() => {
    if (!network) return undefined;
    const domainId = selectedDomain ?? visibleDomains[0]?.id;
    const domain = network.domains.find((d) => d.id === domainId) ?? network.domains[0];
    if (!domain) return undefined;
    return domain.item_schemas ? Object.values(domain.item_schemas)[0] : undefined;
  }, [network, selectedDomain, visibleDomains]);

  // Domain → schema map for sidebar profile titles.
  const userSchemas = React.useMemo(() => {
    if (!network) return {};
    const map: Record<string, RJSFSchema> = {};
    for (const domain of network.domains) {
      const schema = domain.item_schemas ? Object.values(domain.item_schemas)[0] : undefined;
      if (schema) map[domain.id] = schema;
    }
    return map;
  }, [network]);

  // Available actions toward a target domain. Requires an active profile as
  // the source.
  const getActionsForDomain = React.useCallback(
    (targetDomainId: string): DotActionSchema[] =>
      myItem ? flattenInteractionActions(network, currentDomain, targetDomainId) : [],
    [network, currentDomain, myItem]
  );

  const handleBulkConnect = React.useCallback(
    async (actionType: string, formData: Record<string, unknown>, confirmed = false) => {
      if (!myItem || !network) return;
      if (promptCompleteDraftProfile(myItem)) {
        setBulkConnectOpen(false);
        return;
      }
      // Minor ward: confirm before the bulk perform below sends the guardian OTP.
      if (
        !confirmed &&
        u18Status?.isMinor === true &&
        !!wardDomain &&
        isGuardianConsentRequiredDomain(network, wardDomain)
      ) {
        setBulkConnectOpen(false);
        setBulkGuardianConfirm({
          actionType,
          run: () => { void handleBulkConnect(actionType, formData, true); },
        });
        return;
      }
      setBulkConnectBusy(true);
      try {
        // Bulk select only renders in the list view, so candidates come from
        // the paged list feed, never the map.
        const allItems = singleDomainItems;
        const ids = Array.from(browseSelection.selected);
        const targets = ids
          .map((id) => allItems.find((i) => i.item_id === id))
          .filter((t): t is Item => !!t);

        // Nothing valid to send (e.g. the selection went stale after a reload).
        if (targets.length === 0) {
          setBulkConnectOpen(false);
          browseSelection.exitSelect();
          return;
        }

        const { consent, requirementsSnapshot } = splitActionConsent(formData);

        const sourceItemInstanceUrl = instanceUrlForAction(myItem, network);

        const payloads = targets.map((targetItem) => {
            const targetItemInstanceUrl = instanceUrlForAction(targetItem, network);
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
        // New actions surface without waiting for the poll.
        queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
        setBulkConnectOpen(false);

        // `resolveBulkOutcome` makes the three-way decision; this reacts to it.
        const outcome = resolveBulkOutcome(env, targets, payloads);

        if (outcome.kind === 'all') {
          toast.success(t('home.bulk_connected_all', { count: outcome.succeeded }));
          browseSelection.exitSelect();
        } else if (outcome.kind === 'guardian') {
          // A code has already gone to the guardian; the OTP dialog owns the
          // resubmit.
          setBulkConnectOpen(false);
          setBulkGuardianChallenge({
            payloads: outcome.payloads,
            sourceInstanceUrl: sourceItemInstanceUrl,
            actionType,
            otherFailedIds: outcome.otherFailedIds,
          });
        } else {
          toast.warning(
            t('home.bulk_connected_partial', {
              succeeded: outcome.succeeded,
              total: outcome.total,
            }),
            {
              description: outcome.firstError
                ? t('home.bulk_connect_first_error', { message: outcome.firstError })
                : undefined,
            },
          );
          browseSelection.setSelected(outcome.failedIds);
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
      singleDomainItems,
      browseSelection.selected,
      browseSelection.exitSelect,
      browseSelection.setSelected,
      promptCompleteDraftProfile,
      u18Status,
      wardDomain,
      t,
    ],
  );

  // The single active action for the selected domain (for CardGrid).
  const activeAction = React.useMemo<DotActionSchema | null>(() => {
    const toDomain = selectedDomain ?? visibleDomains[0]?.id;
    if (!toDomain) return null;
    const actions = getActionsForDomain(toDomain);
    return actions[0] ?? null;
  }, [getActionsForDomain, selectedDomain, visibleDomains]);

  // Enum filter field metadata, used below and by MapView.
  const enumFilterFields = React.useMemo(
    () => (network ? getEnumFilterFieldsForDomains(network.domains) : []),
    [network],
  );

  // List cards: the search/enum filter applied to the paged feed (bypassed in
  // discover mode). The server already orders nearest-first.
  const singleDomainCards = React.useMemo(
    () =>
      selectedDomain
        ? buildFilteredCardsForDomain(selectedDomain, singleDomainItems, {
            search,
            activeFieldFilters,
            enumFilterFields,
            discover: listDiscover,
          })
        : [],
    [selectedDomain, singleDomainItems, search, activeFieldFilters, enumFilterFields, listDiscover],
  );

  // Every facet the queried domain will honour, key → label. Feeds both the
  // chips and the stale-facet prune, so they agree. Mirrors the server's
  // allowlist (declared + non-private), not the panel's enum-only set.
  const facetFieldLabels = React.useMemo(
    () => resolveFacetFieldLabels(filterFieldDomains),
    [filterFieldDomains],
  );

  // Memoized: the stale-facet prune effect below depends on it.
  const handleMapFieldsChange = React.useCallback((fields: Record<string, string[]>) => {
    setMapSelectedFields(fields);
    setSearchParams((prev) => {
      const keysToDelete: string[] = [];
      for (const key of prev.keys()) {
        if (key.startsWith('f_')) keysToDelete.push(key);
      }
      for (const key of keysToDelete) prev.delete(key);
      for (const [fieldKey, values] of Object.entries(fields)) {
        if (values.length > 0) {
          prev.set(`f_${fieldKey}`, values.map(encodeURIComponent).join(','));
        }
      }
      return prev;
    });
  }, [setSearchParams]);

  // Drop facets the queried domain cannot honour. The server silently drops an
  // undeclared field (so private fields cannot be probed) and returns the
  // domain unfiltered, while the chip would still look active. Pruning this one
  // state keeps chips, badge, `?f_*` params and the request consistent; going
  // through `handleMapFieldsChange` rewrites the URL so a reload does not
  // restore the pruned facets.
  React.useEffect(() => {
    const allowed = new Set(Object.keys(facetFieldLabels));
    if (allowed.size === 0) return; // schemas not resolved yet
    const stale = Object.keys(mapSelectedFields).filter((key) => !allowed.has(key));
    if (stale.length === 0) return;
    const next = { ...mapSelectedFields };
    for (const key of stale) delete next[key];
    handleMapFieldsChange(next);
  }, [facetFieldLabels, mapSelectedFields, handleMapFieldsChange]);

  // Applied-filter state (chips, per-chip removal, reset, "anything applied")
  // lives in one hook so the four always agree.
  const {
    chips: appliedChips,
    onRemove: handleRemoveChip,
    onClearAll: handleClearAll,
    canClearAll,
  } = useAppliedFilterChips({
    search,
    setSearch,
    activeFieldFilters,
    // Not the bare `setMapSelectedFields`: facets are mirrored into `?f_<key>`
    // params, and only this handler rewrites them.
    setFieldFilters: handleMapFieldsChange,
    fieldLabels: facetFieldLabels,
    area,
    setArea,
  });

  // The map applies facets and search text but not `area` or `sort`, so
  // clearing from there must not reset controls the user cannot see.
  const handleClearFacetsOnly = React.useCallback(() => {
    setSearch('');
    handleMapFieldsChange({});
  }, [setSearch, handleMapFieldsChange]);

  // Only the domains this viewer can browse; a non-interacting domain is not
  // rendered at all (a permanently disabled button reads as broken).
  const domainOptions = React.useMemo<DomainOption[]>(
    () =>
      visibleDomains.map((d) => ({
        id: d.id,
        label: formatDomainLabel(d.id, [d]) || d.id,
        // The collapsed one-domain label names a set, not an item.
        pluralLabel: pluralizeDomainLabel(d.id, [d]) || formatDomainLabel(d.id, [d]) || d.id,
      })),
    [visibleDomains],
  );

  const handleDomainSelect = (domainId: string) => {
    setSelectedDomain(domainId);
    // New domain, new filter fields: reset the map domain and enum-field
    // selections, or a leftover chip hides every item or shows as active
    // with no group rendered.
    setMapSelectedDomains([]);
    setMapSelectedFields({});
    setSearchParams((prev) => {
      prev.set('domain', domainId);
      prev.delete('map_domains');
      for (const key of [...prev.keys()]) {
        if (key.startsWith('f_')) prev.delete(key);
      }
      return prev;
    });
  };

  const handleViewModeChange = (mode: ViewMode) => {
    // The map is multi-domain and the list takes one, so on map → list collapse
    // the map's selection to one of its domains. Only when the list domain is
    // not already one of the map's, so toggling does not reshuffle a choice;
    // an empty map selection means "all visible".
    const collapsed =
      mode === 'list' &&
      mapSelectedDomains.length > 0 &&
      (selectedDomain === null || !mapSelectedDomains.includes(selectedDomain))
        ? collapseToSingleDomain(mapSelectedDomains, visibleDomains)
        : null;

    // Not `handleDomainSelect`: that clears `map_domains` and the facet params,
    // losing the map selection the viewer may switch back to.
    if (collapsed) setSelectedDomain(collapsed);

    setViewMode(mode);
    setSearchParams((prev) => {
      prev.set('view', mode);
      if (collapsed) prev.set('domain', collapsed);
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
    // Domain is network-specific; clearing it lets the default-domain effect
    // resolve one for the new network.
    setSelectedDomain(null);
    setSearchParams((prev) => {
      prev.set('network', networkId);
      prev.delete('domain');
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


  const showNetworkSelector = computeShowNetworkSelector(servedScope, allNetworks.length);

  // `|| undefined` keeps the "absent → undefined" contract downstream defaults
  // rely on (the resolver returns '').
  const currentDomainLabel = formatDomainLabel(selectedDomain, network?.domains) || undefined;

  const actions = resolveDomainActions(selectedDomain, getActionsForDomain, activeAction);

  // Names the profile the (repeating) consent prompt is for.
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

  // Render function rather than an element to keep HomePage's cognitive
  // complexity within bounds (Sonar S3776).
  const renderU18GuardianFlowModal = () =>
    showU18GuardianFlow && network ? (
      <U18GuardianFlow
        network={network.id}
        brand={brand === 'standard' ? null : brand}
        purpose={{ kind: 'profile' }}
        // Skip the DOB step when birth data is already stored.
        initialStep={u18InitialStep}
        onComplete={() => {
          setGuardianFlowDismissed(true);
          // Re-read stored U18 status so a later profile creation does not
          // re-ask the DOB.
          setU18StatusReload((n) => n + 1);
          void refetchU18Gate();
        }}
        onNotMinor={() => {
          setGuardianFlowDismissed(true);
          setU18StatusReload((n) => n + 1);
        }}
        onLogout={() => { void signOut(); }}
      />
    ) : null;

  const profileConsentModal = (
    <ProfileConsentModal
      // The U18 gate takes priority, and `guardianActive` hides this while a
      // guardian dialog is open.
      open={Boolean(pendingConsentProfileId) && !showU18GuardianFlow && !guardianActive}
      statement={profileStatement}
      profileLabel={pendingProfileLabel}
      minor={u18Status?.isMinor === true}
      onAccept={async () => {
        const pending = pendingConsentProfileId;
        if (!pending || !network?.id || !profileDoc) return;
        const profile = myItems.find((p) => p.item_id === pending);
        if (!profile) {
          setPendingConsentProfileId(null);
          return;
        }
        // The shared hook handles adult self-accept or a minor's guardian OTP,
        // records consent, promotes draft→live, updates caches and toasts.
        // `onDone` runs only on success (for a minor, after the guardian OTP
        // verifies), so a failed attempt leaves the prompt open.
        await acceptProfileConsentFlow({
          network: network.id,
          brand: brand === 'standard' ? null : brand,
          item: {
            item_id: profile.item_id,
            item_domain: profile.item_domain,
            item_type: profile.item_type,
          },
          version: profileDoc.current_version,
          isMinor: u18Status?.isMinor === true,
          // Guardian capture may reclassify the ward; re-sync U18 status so a
          // retry uses it.
          onGuardianStatusChanged: () => setU18StatusReload((n) => n + 1),
          onDone: () => {
            setActiveProfileId(pending);
            setStoredActiveProfileId(network.id, pending);
            setPendingConsentProfileId(null);
          },
        });
      }}
    />
  );

  // "A code will be sent to your guardian — proceed?" confirm before a minor's
  // bulk action dispatches the OTP.
  const bulkGuardianConfirmModal = (
    <Dialog
      open={!!bulkGuardianConfirm}
      onOpenChange={(open) => { if (!open) setBulkGuardianConfirm(null); }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('actions.guardian_confirm_title')}</DialogTitle>
          <DialogDescription>{t('actions.guardian_confirm_desc')}</DialogDescription>
        </DialogHeader>
        <GuardianOtpPurpose
          purpose={{
            kind: 'bulk',
            action: guardianActionKind(bulkGuardianConfirm?.actionType),
            count: browseSelection.selected.size,
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setBulkGuardianConfirm(null)}>
            {t('actions.guardian_confirm_cancel')}
          </Button>
          <Button
            onClick={() => {
              const run = bulkGuardianConfirm?.run;
              setBulkGuardianConfirm(null);
              run?.();
            }}
          >
            {t('actions.guardian_confirm_proceed')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const bulkGuardianOtpModal = (
    <GuardianOtpDialog
      open={!!bulkGuardianChallenge}
      onOpenChange={(open) => { if (!open) setBulkGuardianChallenge(null); }}
      purpose={{
        kind: 'bulk',
        action: guardianActionKind(bulkGuardianChallenge?.actionType),
        count: bulkGuardianChallenge?.payloads.length ?? 0,
      }}
      onLogout={() => { void signOut(); }}
      onSubmitOtp={async (otp) => {
        const ch = bulkGuardianChallenge;
        if (!ch) return;
        const env2 = await performActionsBulk(ch.payloads, ch.sourceInstanceUrl, otp);
        queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
        if (env2.summary.failed === 0) {
          const otherFailedIds = ch.otherFailedIds ?? [];
          setBulkGuardianChallenge(null);
          if (otherFailedIds.length > 0) {
            // Mixed batch: keep the non-guardian failures selected for retry
            // rather than claim everything succeeded.
            toast.warning(
              t('home.bulk_connected_partial', {
                succeeded: env2.summary.succeeded,
                total: env2.summary.succeeded + otherFailedIds.length,
              }),
            );
            browseSelection.setSelected(otherFailedIds);
          } else {
            toast.success(t('home.bulk_connected_all', { count: env2.summary.succeeded }));
            browseSelection.exitSelect();
          }
          return;
        }
        // Still failing (wrong/expired code, throttled): throw a classified
        // error so GuardianOtpDialog shows it inline and stays open.
        const firstFail = env2.results.find((r) => r.status === 'error');
        const code = guardianOtpErrorOf(firstFail) ?? 'GUARDIAN_OTP_INVALID';
        throw new BulkSingleError(code, firstFail?.message ?? 'Guardian confirmation failed', 422);
      }}
    />
  );

  if (!network) {
    return (
      <>
        <div className="flex h-svh flex-col">
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
        {renderU18GuardianFlowModal()}
        {profileConsentModal}
        {consentAcceptDialogs}
        {bulkGuardianConfirmModal}
        {bulkGuardianOtpModal}
      </>
    );
  }

  // Which domains the control shows as selected: the map's own selection
  // (empty = all visible), or the list's single domain. Not memoized: this is
  // after the `if (!network) return` guard, so a hook here would break the
  // rules of hooks.
  const toolbarSelectedDomains = ((): string[] => {
    if (viewMode === 'map') {
      return mapSelectedDomains.length > 0
        ? mapSelectedDomains
        : visibleDomains.map((d) => d.id);
    }
    return selectedDomain ? [selectedDomain] : [];
  })();

  // Which quantity `relevance` means for this viewer: their profile when an
  // anchor is sent, else their typed text, else neither.
  let relevanceBasis: 'profile' | 'search' | null = null;
  if (hasProfileAnchor) relevanceBasis = 'profile';
  else if (search.trim()) relevanceBasis = 'search';

  // Relevance needs a query vector (anchor or typed text) and a live
  // signals-search; the native fallback does no ranking and reports
  // `sort_applied: 'newest'`.
  const relevanceAvailable = relevanceBasis !== null && !listDegraded;

  // The bar shows "how many match these filters" in both views; the map's
  // viewport count lives in its own pill.
  const contentCount = viewMode === 'map' ? browseTotals.total : singleDomainList.total;
  const contentLoading =
    viewMode === 'map' ? browseTotals.isLoading : singleDomainList.isLoading;

  // Suppressed on an empty or loading list, where `BrowseEmptyState` or the
  // skeleton explains instead.
  const listNoteText = listNote && contentCount > 0 ? formatListNote(t, listNote) : null;


  // Bulk-select toggle, rendered over the results rather than in the filter
  // bar because it acts on the results instead of choosing them.
  const browseSelectButton =
    myItem && viewMode === 'list' ? (
      <Button
        type="button"
        variant={browseSelection.selectMode ? 'default' : 'outline'}
        size="sm"
        // `size="sm"` is below the touch minimum; match the rest of the chrome.
        className="pointer-coarse:min-h-11"
        data-tour="bulk-select"
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

  // The map's location control, repeated in the maximized map's overlay
  // because fullscreen covers the page header.
  const mapLocationControl = (
    <LocationSourceSelect
      value={preferredSource}
      // What the map is actually centred on: `preferredSource` stays 'profile'
      // even with no profile location, while `useUserLocation` resolves to the
      // browser coordinate.
      effectiveValue={noteLocationSource(resolvedLocationSource)}
      onChange={handleLocationSourceChange}
      profileAvailable={profileLocation !== null}
      browserAvailable={browserLocation.isSupported}
    />
  );

  // A render function rather than an element: cognitive complexity is
  // measured per function, and this subtree's view-dependent ternaries would
  // push `HomePage` over its limit (Sonar S3776).
  const renderBrowseToolbar = () =>
    network ? (
      <BrowseToolbar
        viewMode={viewMode}
        filtersSlot={listFiltersPanel}
        domainOptions={domainOptions}
        selectedDomains={toolbarSelectedDomains}
        onDomainsChange={(next) => {
          if (viewMode === 'map') {
            handleMapDomainsChange(next);
            return;
          }
          // Single-select: DomainControl always emits exactly one here.
          if (next[0]) handleDomainSelect(next[0]);
        }}
        count={contentLoading ? undefined : contentCount}
        // Map only: items that can never be pins, so the gap with the
        // viewport pill that zooming out will not close is stated.
        notMappable={viewMode === 'map' ? browseTotals.notMappable : undefined}
        sort={sort}
        sortApplied={listSortApplied}
        sortUnreported={listSortUnreported}
        // `nearest` needs a centre to order around.
        nearestAvailable={browseCoords !== null}
        relevanceAvailable={relevanceAvailable}
        relevanceBasis={relevanceBasis}
        onSortChange={setSort}
        area={area}
        defaultCenter={browseCoords}
        // The location source lives with the distance, in one control.
        locationSource={preferredSource}
        effectiveLocationSource={noteLocationSource(resolvedLocationSource)}
        onLocationSourceChange={handleLocationSourceChange}
        profileLocationAvailable={profileLocation !== null}
        browserLocationAvailable={browserLocation.isSupported}
        onAreaChange={setArea}
        chips={appliedChips}
        onRemoveChip={handleRemoveChip}
        // Clear-all offers only what applies to the current view: the map
        // renders no Sort or Location and ignores `area` (it scopes by
        // viewport).
        onClearAll={viewMode === 'map' ? handleClearFacetsOnly : handleClearAll}
        canClearAll={viewMode === 'map' ? appliedChips.length > 0 : canClearAll}
      />
    ) : undefined

  const renderPageHeader = () => {
    return (
      <>
        {!user && <GuestHero />}
        {/* Signed-in only: prompts a viewer who has no profile yet. */}
        {user && (
          <ContentHeader
            count={undefined}
            noProfilePrompt={{ show: !myItem, networkId: selectedNetworkId ?? '' }}
          />
        )}
      </>
    );
  };

  const filtersPanel = (
    <BrowseFiltersPanel
      // The map's own copy, shown only while maximized (the toolbar is behind
      // the overlay).
      trigger="overlay"
      domains={visibleDomains}
      filterFieldDomains={filterFieldDomains}
      selectedFields={mapSelectedFields}
      onFieldsChange={handleMapFieldsChange}
      viewMode={viewMode}
    />
  );

  // The toolbar's filters panel; `filtersPanel` above is the maximized map's
  // copy.
  const listFiltersPanel = (
    <BrowseFiltersPanel
      domains={visibleDomains}
      filterFieldDomains={filterFieldDomains}
      selectedFields={mapSelectedFields}
      onFieldsChange={handleMapFieldsChange}
      viewMode={viewMode}
    />
  );

  // One marker-details renderer for the desktop popup and the phone bottom
  // sheet. `onBeforeConnect` closes whichever is open so the action's modal is
  // not underneath it.
  const renderMarkerDetail = (
    marker: MapMarker,
    triggerAction: TriggerAction,
    cardVariant: 'popup' | 'list',
    onBeforeConnect: () => void,
  ) => {
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
    // The domain's item type for the by-id detail fetch; slim markers lack it.
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
        connectDisabled={openActionItemIds.has(baseItemId)}
        connectDisabledReason={t('actions.pair_open_disabled', 'A request is already open with this profile.')}
        onConnect={(itemId) => {
          onBeforeConnect();
          if (connectAction) triggerAction(connectAction.action_type, connectAction, itemId);
        }}
        onItemResolved={setMapDetailItem}
        cardVariant={cardVariant}
      />
    );
  };

  // The sheet's heading: the item's configured title once its detail has
  // loaded (via `mapDetailItem`), the marker's generic label until then.
  const markerSheetTitle = (marker: MapMarker): string => {
    const baseItemId = marker.id.split('#')[0];
    const titleField = network?.domains.find((d) => d.id === marker.domain)?.card?.title_field;
    if (mapDetailItem?.item_id === baseItemId && titleField) {
      const raw = mapDetailItem.item_state[titleField];
      const title = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
      if (title) return title;
    }
    return marker.label;
  };

  return (
    <>
    <PageShell
      networks={pickNetworksForShell(showNetworkSelector, allNetworks)}
      selectedNetwork={selectedNetworkId}
      onNetworkSelect={handleNetworkSelect}
      // Domain selection lives in the browse toolbar; `hideBrowse` keeps the
      // sidebar's other groups.
      hideBrowse
      // Still needed: the sidebar reads `my_items_label` from it to title the
      // own-items group (e.g. "My Jobs" for a provider). The network's domains,
      // not `visibleDomains`, which excludes the viewer's own domain.
      domains={network.domains}
      currentDomainLabel={currentDomainLabel}
      myItems={myItems}
      activeProfileId={activeProfileId}
      onActiveProfileChange={handleActiveProfileChange}
      onProfilesChanged={() => {
        if (network) queryClient.invalidateQueries({ queryKey: queryKeys.myItems(network.id) });
      }}
      userSchemas={userSchemas}
      search={search}
      onSearchChange={setSearch}
      viewMode={viewMode}
      onViewModeChange={handleViewModeChange}
      toolbarSlot={
        renderBrowseToolbar()
      }
    >
      {renderPageHeader()}
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
          // Minor on a guardian-gated domain: confirm before the guardian OTP
          // is dispatched (the server issues it on the first submit).
          guardianConfirmRequired={
            u18Status?.isMinor === true &&
            !!network &&
            !!wardDomain &&
            isGuardianConsentRequiredDomain(network, wardDomain)
          }
          onActionSubmit={async (actionType, _actionSchema, formData, targetItemId, guardianOtp) => {
            if (!myItem) {
              toast.error(t('home.toast_profile_required'), {
                description: t('home.toast_profile_required_desc'),
              });
              throw new Error('No source item');
            }
            // Draft source profile: prompt to complete it. ActionAbortedError
            // suppresses ActionHandler's generic toast.
            if (promptCompleteDraftProfile(myItem)) {
              throw new ActionAbortedError('source profile is draft');
            }
            if (!user) {
              toast.error(t('nav.sign_in_to_connect'), {
                description: t('home.toast_sign_in_desc'),
              });
              throw new Error('No user');
            }
            // Serves both list card actions and the map popup's connect button.
            // A map-driven target may never have been paged into the list, so
            // fall back to `mapDetailItem` (resolved by the open popup).
            const listItems = singleDomainItems;
            const targetItem =
              listItems.find((i) => i.item_id === targetItemId) ??
              (mapDetailItem?.item_id === targetItemId ? mapDetailItem : undefined);
            if (!targetItem) {
              toast.error(t('home.toast_profile_not_found'), {
                description: t('home.toast_profile_not_found_desc'),
              });
              throw new Error('Target item not found');
            }

            // The consent sentinel must not reach requirements_snapshot.
            const { consent, requirementsSnapshot } = splitActionConsent(formData);

            const sourceItemInstanceUrl = instanceUrlForAction(myItem, network);

            const targetItemInstanceUrl = instanceUrlForAction(targetItem, network);

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
              sourceItemInstanceUrl, // the source instance, where myItem lives
              guardianOtp
            );
            // New actions surface without waiting for the poll.
            queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
            toast.success(t('home.toast_action_sent', { action: actionType.charAt(0).toUpperCase() + actionType.slice(1) }), {
              description: t('home.toast_action_sent_desc'),
            });
          }}
        >
          {(triggerAction) =>
            viewMode === 'list' ? (
              <>
                {/* Federation degradation: some peer instances did not answer
                    in time, so the list is known-partial. In-flow here; the
                    map's banner is `fixed`. */}
                {listPartial && (
                  <p className="mb-3 rounded-md bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 shadow-sm ring-1 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-800">
                    {t('home.list_partial')}
                  </p>
                )}
                {/* The list note says what drives the results (profile
                    relevance, proximity, both, or ranking unavailable on the
                    native fallback); see `resolveListNote`. */}
                {/* Paged infinite scroll in the server's order; no client
                    re-sort. */}
              <>
                {/* No "Showing N of M": the toolbar states the total and the
                    list is infinite scroll. */}
                {/* The list note and bulk-select share one line;
                    `items-baseline` keeps the note's text on it. */}
                {(listNoteText || browseSelectButton) && (
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <p className="min-w-0 text-xs text-muted-foreground">{listNoteText}</p>
                    {browseSelectButton}
                  </div>
                )}
                <CardGrid
                  schema={activeSchema!}
                  schemaName={selectedDomain ?? undefined}
                  schemaDescription={currentDomainLabel}
                  cardConfig={network?.domains.find((d) => d.id === selectedDomain)?.card}
                  items={singleDomainCards}
                  fullItems={singleDomainItems}
                  actions={actions}
                  onAction={(itemId, _type, actionSchema) => {
                    triggerAction(_type, actionSchema, itemId);
                  }}
                  // `selectedDomain === null` is the transient state before the
                  // default domain resolves; the feed is disabled, so show
                  // loading rather than "no listings".
                  loading={singleDomainList.isLoading || selectedDomain === null}
                  emptyState={
                    <BrowseEmptyState
                      search={search}
                      signedIn={Boolean(user)}
                      hasProfile={Boolean(myItem)}
                      networkId={selectedNetworkId ?? ''}
                      domainLabel={currentDomainLabel ?? 'items'}
                      hasLocation={hasLocation}
                      distanceMeters={listDistanceMeters}
                      locationSource={resolvedLocationSource}
                    />
                  }
                  localItem={myItem}
                  networkId={network?.id}
                  selectedDomain={selectedDomain}
                  openActionItemIds={openActionItemIds}
                  openActionReason={t('actions.pair_open_disabled', 'A request is already open with this profile.')}
                  selection={browseSelection}
                  // Each card's pill shows what drove its position, per the
                  // sort the server applied.
                  sortApplied={listSortApplied}
                  relevanceBasis={relevanceBasis}
                />
                <div ref={singleDomainSentinelRef} aria-hidden="true" className="h-px w-full" />
              </>
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
              <div data-tour="map" className="relative h-full">
                <MapErrorBoundary>
                <MapView
                  schema={activeSchema!}
                  resolveMarkerLabel={resolveMarkerLabel}
                  items={mapItems}
                  focusPoint={userLocation}
                  focusNonce={recenterNonce}
                  closePopupNonce={closePopupNonce}
                  selfLocation={userLocation}
                  filtersSlot={filtersPanel}
                  locationSlot={mapLocationControl}
                  onViewportChange={setMapViewport}
                  emptyMessage={t(
                    mapEmptyMessageKey({
                      isError: mapMarkers.isError,
                      wideViewport: isWideViewport(mapViewport),
                    }),
                  )}
                  renderPopup={(marker) =>
                    renderMarkerDetail(marker, triggerAction, 'popup', () =>
                      // Close the popup so it does not cover the consent modal.
                      setClosePopupNonce((n) => n + 1),
                    )
                  }
                  // Phone: the tapped marker opens in the bottom sheet instead.
                  showPopup={!isMobile}
                  onMarkerSelect={isMobile ? setSheetMarker : undefined}
                />
                </MapErrorBoundary>
                {isMobile && (
                  <MarkerDetailSheet
                    open={sheetMarker !== null}
                    onOpenChange={(open) => {
                      if (!open) setSheetMarker(null);
                    }}
                    title={sheetMarker ? markerSheetTitle(sheetMarker) : ''}
                  >
                    {sheetMarker &&
                      renderMarkerDetail(sheetMarker, triggerAction, 'list', () =>
                        // Close the sheet: the action opens its own bottom
                        // sheet, which must not stack under this one.
                        setSheetMarker(null),
                      )}
                  </MarkerDetailSheet>
                )}
                {/* "Search this area": applies the map viewport as the list's
                    area and switches to the list in one action. */}
                {mapViewport?.minLat !== undefined &&
                  mapViewport.minLng !== undefined &&
                  mapViewport.maxLat !== undefined &&
                  mapViewport.maxLng !== undefined &&
                  // Offered when zoomed in far enough and searching would change
                  // the result: the map cannot draw everything in view, or
                  // matching items lie outside it. Compared against `mappable`,
                  // not `total`, which counts items with no coordinates.
                  (mapViewport.zoom ?? 0) >= SEARCH_AREA_MIN_ZOOM &&
                  (mapMarkers.truncated || mapMarkers.total < browseTotals.mappable) && (
                    // Hidden while any modal is open (see MapCountPill).
                    <div className="pointer-events-none fixed bottom-20 left-1/2 z-[2100] -translate-x-1/2 px-4 in-data-[scroll-locked]:hidden">
                      <button
                        type="button"
                        data-testid="search-this-area"
                        onClick={() => {
                          setArea({
                            mode: 'viewport',
                            bounds: {
                              minLat: mapViewport.minLat!,
                              minLng: mapViewport.minLng!,
                              maxLat: mapViewport.maxLat!,
                              maxLng: mapViewport.maxLng!,
                            },
                          });
                          handleViewModeChange('list');
                        }}
                        className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3.5 py-2 text-xs font-semibold shadow-lg pointer-coarse:min-h-11 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <List className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        {t('home.search_this_area')}
                      </button>
                    </div>
                  )}
                {/* The viewport count, for every visitor (the toolbar shows
                    the filter total). `fixed` and a high z-index keep it above
                    the maximize overlay. */}
                <MapCountPill
                  total={mapMarkers.total}
                  shown={mapItems.length}
                  truncated={mapMarkers.truncated}
                />
                {/* Federation degradation: some peer instances did not answer
                    in time, so the marker set is known-partial. `fixed` keeps
                    it above the maximize overlay. */}
                {mapMarkers.partial && (
                  <div className="pointer-events-none fixed left-1/2 top-20 z-[2100] w-full max-w-[calc(100vw-2rem)] -translate-x-1/2 px-4 in-data-[scroll-locked]:hidden">
                    <p className="pointer-events-auto mx-auto w-fit max-w-full rounded-md bg-amber-50 px-3 py-1.5 text-center text-xs font-medium text-amber-900 shadow-md ring-1 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-800">
                      {t('home.map_partial')}
                    </p>
                  </div>
                )}
              </div>
            )
          }
        </ActionHandler>
    </PageShell>
    {renderU18GuardianFlowModal()}
    {profileConsentModal}
    {consentAcceptDialogs}
        {bulkGuardianConfirmModal}
        {bulkGuardianOtpModal}
    </>
  );
}
