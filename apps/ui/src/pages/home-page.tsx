import * as React from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import { useSearchParams, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type {
  DotNetworkSchema,
  DotActionSchema,
  ViewMode,
} from '@/engine/types';
import { resolveNetworkRefs } from '@/engine/schema/resolve-schema';
import { PageShell } from '@/components/layout/page-shell';
import { ContentHeader } from '@/components/layout/content-header';
import { GuestHero } from '@/components/layout/guest-hero';
import { CardGrid } from '@/components/cards/card-grid';
import { DomainCard } from '@/components/cards/domain-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ActionHandler } from '@/components/actions/action-handler';
import { MapView } from '@/components/map/map-container';
import { MapFiltersPanel } from '@/components/map/map-filters-panel';
import { MarkerPopupCard } from '@/components/map/marker-popup-card';
import { MatchScoreCard } from '@/components/match-score';
import '@/components/map/providers';
import { fetchItems, performAction, performActionsBulk, type Item } from '@/lib/item-api';
import { bulkFailureIndices, firstBulkError } from '@/lib/bulk';
import { useCardSelection } from '@/hooks/use-card-selection';
import { useEqualRowHeights } from '@/hooks/use-equal-row-heights';
import { SelectableCard } from '@/components/selection/selectable-card';
import { BulkActionBar } from '@/components/selection/bulk-action-bar';
import { ActionModal } from '@/components/actions/action-modal';
import { CheckSquare } from 'lucide-react';
import { getRuntimeEnv } from '@/lib/runtime-env';
import { ACTION_CONSENT_SENTINEL } from '@/lib/action-api';
import { EmptyState } from '@/components/empty-state';
import { fetchNetworkConfigs, fetchNetworkConfig, fetchNetworkItems } from '@/lib/network-api';
import { useAuth } from '@/contexts/auth-context';
import { apiConfig } from '@/lib/api-config';
import { getEnumFilterFieldsForDomains, itemPassesEnumFilters } from '@/lib/enum-filters';
import { getServedScope } from '@/lib/served-binding';
import { computeVisibleDomains } from '@/lib/visible-domains';
import { useUserLocation } from '@/hooks/use-user-location';
import { nearestDistanceMeters } from '@/lib/geo/distance';
import type { LatLng } from '@/lib/geo/types';
import { getProfileConsentStatus, acceptProfileConsent } from '@/lib/consent-api';
import { useConsentConfig } from '@/hooks/use-consent-config';
import { useNetworkTheme } from '@/theme/theme-provider';
import { ProfileConsentModal } from '@/components/consent/profile-consent-modal';

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

function getItemTypeForDomain(network: DotNetworkSchema, domainId: string): string {
  const domain = network.domains.find((d) => d.id === domainId);
  const itemTypeKeys = domain?.item_schemas ? Object.keys(domain.item_schemas) : [];
  return itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
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

export function HomePage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const allCardsGridRef = useEqualRowHeights<HTMLDivElement>();
  const [searchParams, setSearchParams] = useSearchParams();
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
  const [resolvedNetwork, setResolvedNetwork] = React.useState<DotNetworkSchema | null>(null);
  const [allNetworks, setAllNetworks] = React.useState<DotNetworkSchema[]>([]);
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
  const [domainItems, setDomainItems] = React.useState<Record<string, Item[]>>({});
  const [myItems, setMyItems] = React.useState<Item[]>([]);
  const [activeProfileId, setActiveProfileId] = React.useState<string | null>(null);
  // Whether the active-profile lookup has settled. Until it has, profileLocation
  // is transiently null even for a user who has a profile location, so the
  // browser-geo auto-prompt must wait for this to avoid a spurious permission prompt.
  const [profilesResolved, setProfilesResolved] = React.useState(false);
  const [consentedProfileIds, setConsentedProfileIds] = React.useState<Set<string>>(new Set());
  const [consentLoaded, setConsentLoaded] = React.useState(false);
  const [pendingConsentProfileId, setPendingConsentProfileId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const browseSelection = useCardSelection();
  const [bulkConnectOpen, setBulkConnectOpen] = React.useState(false);
  const [bulkConnectBusy, setBulkConnectBusy] = React.useState(false);

  React.useEffect(() => {
    if (!selectedNetworkId) {
      setActiveProfileId(null);
      return;
    }
    setActiveProfileId(getStoredActiveProfileId(selectedNetworkId));
  }, [selectedNetworkId]);

  // Fetch networks from API on mount
  React.useEffect(() => {
    const controller = new AbortController();

    fetchNetworkConfigs()
      .then((networks) => {
        if (controller.signal.aborted) return;
        
        // Filter by configured networks if VITE_NETWORK_ID is set, otherwise use all
        const targetNetworks = configuredNetworkIds.length > 0
          ? networks.filter(n => configuredNetworkIds.includes(n.id))
          : networks;
        setAllNetworks(targetNetworks);

        // Use first configured network, or first available
        const defaultNetwork = targetNetworks[0]?.id;
        if (defaultNetwork && !selectedNetworkId) {
          setSelectedNetworkId(defaultNetwork);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch networks:', err);
      });

    return () => { controller.abort(); };
  }, []);

  // Fetch and resolve the selected network
  React.useEffect(() => {
    if (!selectedNetworkId) return;

    const controller = new AbortController();

    setResolvedNetwork(null);
    setDomainItems({});
    setMyItems([]);
    setProfilesResolved(false);

    fetchNetworkConfig(selectedNetworkId)
      .then((config) => {
        if (controller.signal.aborted) return;
        // Resolve any $ref in the network config
        return resolveNetworkRefs(config, { baseUrl: apiConfig.getUrl() });
      })
      .then((resolved) => {
        if (controller.signal.aborted || !resolved) return;
        setResolvedNetwork(resolved as DotNetworkSchema);
      })
      .catch((err) => {
        console.error('Failed to fetch network config:', err);
      });

    return () => { controller.abort(); };
  }, [selectedNetworkId]);

  const network = resolvedNetwork;

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

  // Fetch all user profiles across all domains to discover their domain
  React.useEffect(() => {
    if (!network) return;
    // Signed out (or no session): drop the previous user's profiles so the
    // sidebar/active-profile clear immediately instead of lingering until refresh.
    if (!user) {
      setMyItems([]);
      setActiveProfileId(null);
      // A signed-out visitor has no profile to wait for — resolved immediately,
      // so the browser-geo auto-prompt may fire.
      setProfilesResolved(true);
      return;
    }

    const controller = new AbortController();

    const domainFetches = network.domains.map((domain) => {
      const itemType = getItemTypeForDomain(network, domain.id);
      return fetchItems({
        item_network: network.id,
        item_domain: domain.id,
        item_type: itemType,
        created_by_me: true,
        limit: 100,
      }, controller.signal)
        .then((res) => res.items)
        .catch(() => [] as Item[]);
    });

    // Fetch the profile-consent set in the SAME flow that loads profiles so
    // consentedProfileIds + consentLoaded are set together with profilesResolved.
    // This closes the transient window where a restored activeProfileId would be
    // treated as "active" before consent status loaded, delaying the gate modal.
    // Fail-open: an empty set on error still lets the gate prompt.
    const consentFetch = getProfileConsentStatus(network.id)
      .then((res) => new Set(res.consented_item_ids))
      .catch(() => new Set<string>());

    Promise.all([Promise.all(domainFetches), consentFetch]).then(([results, consentedIds]) => {
      if (controller.signal.aborted) return;
      const allProfiles = results.flat();
      setMyItems(allProfiles);
      // Consent status is known before profilesResolved is marked, so by the time
      // activeProfileId is derived the gate effect can fire without a content flash.
      setConsentedProfileIds(consentedIds);
      setConsentLoaded(true);
      // Profile lookup has settled — profileLocation is now authoritative, so the
      // browser-geo auto-prompt may fire if there's still no profile location.
      setProfilesResolved(true);

      // Auto-select: use stored ID if valid, otherwise first profile
      const storedId = getStoredActiveProfileId(network.id);
      if (storedId && allProfiles.some((p) => p.item_id === storedId)) {
        setActiveProfileId(storedId);
      } else if (allProfiles.length > 0) {
        setActiveProfileId(allProfiles[0].item_id);
        setStoredActiveProfileId(network.id, allProfiles[0].item_id);
      } else {
        // No profiles for this user — clear any stale ID from a previous session
        setActiveProfileId(null);
        clearStoredActiveProfileId(network.id);
      }
    });

    return () => { controller.abort(); };
  }, [network, user]);

  // Derive the active profile from myItems
  const myItem = React.useMemo(() => {
    if (!myItems.length) return null;
    return myItems.find((i) => i.item_id === activeProfileId) ?? myItems[0] ?? null;
  }, [myItems, activeProfileId]);

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
  const { location: userLocation } = useUserLocation(profileLocation, profilesResolved);

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
    profilesResolved,
    consentLoaded,
    profileConsentRequired,
    activeProfileId,
    consentedProfileIds,
    pendingConsentProfileId,
  ]);

  // Sort a card-item array (item_locations stored in .data) nearest-first when userLocation is known.
  // Items without locations sort last (nearestDistanceMeters returns Infinity for empty/missing arrays).
  const sortByNearest = React.useCallback(
    <T extends { data: Record<string, unknown> }>(items: T[]): T[] =>
      sortItemsByNearest(items, userLocation, (t) => getItemLocations(t.data)),
    [userLocation],
  );

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

  const localProfileItemIds = React.useMemo(
    () => new Set(myItems.filter((item) => item.item_domain === currentDomain).map((item) => item.item_id)),
    [myItems, currentDomain]
  );

  // Fetch items for selected domain(s); when All tab (null) fetch all visible domains in parallel
  React.useEffect(() => {
    if (!network || visibleDomains.length === 0) {
      setDomainItems({});
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    const domainsToFetch = selectedDomain === null
      ? visibleDomains
      : visibleDomains.filter((d) => d.id === selectedDomain);

    Promise.all(
      domainsToFetch.map((domain) => {
        const itemType = getItemTypeForDomain(network, domain.id);
        return fetchNetworkItems(
          { item_network: network.id, item_domain: domain.id, item_type: itemType, limit: 1000 },
          controller.signal
        )
          .then((res) => ({
            domain: domain.id,
            items: res.items.filter((item) => !localProfileItemIds.has(item.item_id)),
          }))
          .catch(() => ({ domain: domain.id, items: [] as Item[] }));
      })
    )
      .then((results) => {
        if (controller.signal.aborted) return;
        const map: Record<string, Item[]> = {};
        for (const r of results) map[r.domain] = r.items;
        setDomainItems(map);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => { controller.abort(); };
  }, [selectedDomain, visibleDomains, network, localProfileItemIds]);

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
      setBulkConnectBusy(true);
      try {
        const allItems = Object.values(domainItems).flat();
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
      domainItems,
      browseSelection.selected,
      browseSelection.exitSelect,
      browseSelection.setSelected,
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

  // Build per-domain card items filtered by search, domain, and status.
  // The same filtered result is consumed by both the list view and the map view
  // so both stay in sync without duplicating filter logic.
  // Derive enum filter field metadata once (used in the memo below and in MapView)
  const enumFilterFields = React.useMemo(
    () => (network ? getEnumFilterFieldsForDomains(network.domains) : []),
    [network],
  );

  const filteredDomainItems = React.useMemo(() => {
    const result: Record<string, { id: string; domain: string; data: Record<string, unknown> }[]> = {};

    // Determine which enum-field filters are active (non-empty selected arrays)
    const activeFieldFilters = Object.fromEntries(
      Object.entries(mapSelectedFields).filter(([, vals]) => vals.length > 0),
    );
    const hasFieldFilters = Object.keys(activeFieldFilters).length > 0;

    for (const [domainId, itemList] of Object.entries(domainItems)) {
      // Map domain filter: skip this domain entirely if filter is active and
      // this domain is not selected.
      if (mapSelectedDomains.length > 0 && !mapSelectedDomains.includes(domainId)) {
        result[domainId] = [];
        continue;
      }

      let cards = itemList.map(itemToCardItem);

      // Text search filter
      if (search) {
        cards = cards.filter((item) =>
          Object.values(item.data).some((val) =>
            String(val).toLowerCase().includes(search.toLowerCase())
          )
        );
      }

      // Enum-field filters: AND across different fields, OR within a field's
      // selected values. Absent fields on an item always pass (domain-safe).
      if (hasFieldFilters) {
        cards = cards.filter((item) =>
          itemPassesEnumFilters(item.data, activeFieldFilters, enumFilterFields),
        );
      }

      result[domainId] = cards;
    }

    return result;
  }, [domainItems, search, mapSelectedDomains, mapSelectedFields, network, enumFilterFields]);

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
          setConsentedProfileIds((prev) => new Set([...prev, pending]));
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
  const contentCount = headerDomain
    ? (filteredDomainItems[headerDomain]?.length ?? 0)
    : Object.values(filteredDomainItems).reduce((s, a) => s + a.length, 0);

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
          count={loading ? undefined : contentCount}
          noProfilePrompt={{ show: !myItem, networkId: selectedNetworkId ?? '' }}
          actions={
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
            ) : undefined
          }
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
            if (!user) {
              toast.error(t('nav.sign_in_to_connect'), {
                description: t('home.toast_sign_in_desc'),
              });
              throw new Error('No user');
            }
            const allItems = Object.values(domainItems).flat();
            const targetItem = allItems.find((i) => i.item_id === targetItemId);
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
            toast.success(t('home.toast_action_sent', { action: actionType.charAt(0).toUpperCase() + actionType.slice(1) }), {
              description: t('home.toast_action_sent_desc'),
            });
          }}
        >
          {(triggerAction) =>
            viewMode === 'list' ? (
              <>
                {selectedDomain === null ? (
              // All tab: flat grid across all domains, each card uses its own schema
              (() => {
                const allFlatItemsUnsorted = visibleDomains.flatMap((domain) => {
                  const domainSchema = domain.item_schemas
                    ? (Object.values(domain.item_schemas)[0] as import('@rjsf/utils').RJSFSchema)
                    : undefined;
                  const domainActions = getActionsForDomain(domain.id);
                  const domainLabel = domain.id
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, (c) => c.toUpperCase());
                  return (filteredDomainItems[domain.id] ?? []).map((item) => ({
                    item,
                    schema: domainSchema,
                    domainActions,
                    domainDescription: domain.description,
                    domainLabel,
                    cardConfig: domain.card,
                  }));
                });
                const allFlatItems = sortItemsByNearest(allFlatItemsUnsorted, userLocation, (x) => getItemLocations(x.item.data));

                if (loading) {
                  return (
                    <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <DomainCard key={i} schema={{}} data={{}} loading />
                      ))}
                    </div>
                  );
                }

                if (allFlatItems.length === 0) {
                  return buildEmptyState('All');
                }

                return (
                  <div ref={allCardsGridRef} className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {allFlatItems.map(({ item, schema, domainActions, domainDescription, domainLabel, cardConfig }) => {
                      const fullItem = Object.values(domainItems)
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
                );
              })()
            ) : (
              // Single domain tab: existing behaviour
              <CardGrid
                schema={activeSchema!}
                schemaName={selectedDomain}
                schemaDescription={currentDomainLabel}
                cardConfig={network?.domains.find((d) => d.id === selectedDomain)?.card}
                items={sortByNearest(filteredDomainItems[selectedDomain] ?? [])}
                fullItems={domainItems[selectedDomain] ?? []}
                actions={actions}
                onAction={(itemId, _type, actionSchema) => {
                  triggerAction(_type, actionSchema, itemId);
                }}
                loading={loading}
                emptyState={buildEmptyState(currentDomainLabel ?? 'items')}
                localItem={myItem}
                networkId={network?.id}
                selectedDomain={selectedDomain}
                selection={browseSelection}
              />
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
              <MapView
                schema={activeSchema!}
                resolveMarkerLabel={resolveMarkerLabel}
                items={Object.values(filteredDomainItems).flat()}
                focusPoint={userLocation}
                filtersSlot={filtersPanel}
                renderPopup={(marker) => {
                  // Marker ids are `${item_id}#${locationIndex}` — strip the suffix to look up the item.
                  const baseItemId = marker.id.includes('#') ? marker.id.split('#')[0] : marker.id;
                  const fullItem =
                    (marker.domain
                      ? domainItems[marker.domain]
                      : Object.values(domainItems).flat()
                    )?.find((i) => i.item_id === baseItemId) ?? null;
                  const domainActions = marker.domain ? getActionsForDomain(marker.domain) : [];
                  const connectAction = domainActions[0];
                  const markerDomain = marker.domain
                    ? network?.domains.find((d) => d.id === marker.domain)
                    : undefined;
                  const markerSchema = markerDomain?.item_schemas
                    ? (Object.values(markerDomain.item_schemas)[0] as import('@rjsf/utils').RJSFSchema)
                    : activeSchema;
                  return (
                    <MarkerPopupCard
                      marker={marker}
                      schema={markerSchema}
                      cardConfig={markerDomain?.card}
                      actions={myItem && connectAction ? [connectAction] : []}
                      onConnect={
                        myItem && connectAction
                          ? () => triggerAction(connectAction.action_type, connectAction, baseItemId)
                          : undefined
                      }
                      localItem={myItem}
                      networkItem={fullItem}
                    />
                  );
                }}
              />
            )
          }
        </ActionHandler>
    </PageShell>
    {profileConsentModal}
    </>
  );
}
