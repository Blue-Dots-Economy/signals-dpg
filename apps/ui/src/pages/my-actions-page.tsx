import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import { useInitiatedActions, useReceivedActions } from '@/hooks/use-actions';
import { useMyItems } from '@/hooks/use-my-items';
import { useActiveProfile } from '@/hooks/use-active-profile';
import { useNetworkConfigs, useResolvedNetwork } from '@/hooks/use-network-config';
import { useCardSelection } from '@/hooks/use-card-selection';
import { getServedScope } from '@/lib/served-binding';
import { queryKeys } from '@/lib/query-keys';
import { humanizeKey, getEnumFilterFieldsForDomains } from '@/lib/enum-filters';
import { PageShell } from '@/components/layout/page-shell';
import { ActionList } from '@/components/actions/action-list';
import { ActionStatusUpdater } from '@/components/actions/action-status-updater';
import { BulkStatusDialog } from '@/components/actions/bulk-status-dialog';
import {
  ACTION_STATUS_FILTERS,
  FILTER_STATUSES,
  type ActionStatusFilter,
  type ActionSort,
  type ActiveFacet,
} from '@/components/actions/action-toolbar';
import { ActionFiltersSheet, type ActionTypeFilter } from '@/components/actions/action-filters-sheet';
import type { Action, FetchMyActionsQuery } from '@/lib/action-api';

type TabValue = 'initiated' | 'received';

function parseNetworkIds(networkEnv: string | undefined): string[] {
  if (!networkEnv) return [];
  return networkEnv.split(',').map((n) => n.trim()).filter(Boolean);
}

// The same localStorage key `NetworkThemeProvider` (theme-provider.tsx)
// persists whenever a `?network=` param is seen. /my-actions is navigated to
// from the sidebar/top-bar/notification bell WITHOUT a `?network=` (see that
// provider's comment) — reading it here too means switching networks
// elsewhere is respected on this page instead of always falling back to the
// build's first configured network.
const ACTIVE_NETWORK_STORAGE_KEY = 'dpg-active-network';

const ACTION_SORT_VALUES = ['recent', 'oldest', 'match_score', 'distance'] as const;

export function MyActionsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [activeTab, setActiveTab] = React.useState<TabValue>('received');
  const [selectedAction, setSelectedAction] = React.useState<Action | null>(null);
  const [isStatusModalOpen, setIsStatusModalOpen] = React.useState(false);
  const [suggestedStatus, setSuggestedStatus] = React.useState<string>('');
  const selection = useCardSelection();
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkStatus, setBulkStatus] = React.useState<string>('');
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  // ── Network resolution (mirrors profile-form-page.tsx) ──────────────────
  const configuredNetworkIds = React.useMemo(
    () => parseNetworkIds(import.meta.env.VITE_NETWORK_ID),
    [],
  );
  const servedScope = React.useMemo(() => getServedScope(), []);
  const networkFromUrl = searchParams.get('network');
  const storedNetworkId = React.useMemo(() => {
    try {
      return localStorage.getItem(ACTIVE_NETWORK_STORAGE_KEY);
    } catch {
      return null;
    }
  }, []);

  const { data: networksData, isError: networksError } = useNetworkConfigs();
  const availableNetworkIds = React.useMemo<string[] | null>(() => {
    if (networksError) return [];
    if (!networksData) return null;
    const filtered =
      configuredNetworkIds.length > 0
        ? networksData.filter((network) => configuredNetworkIds.includes(network.id))
        : networksData;
    return filtered.map((network) => network.id);
  }, [networksData, networksError, configuredNetworkIds]);

  const targetNetworkId = React.useMemo(() => {
    if (servedScope?.network) return servedScope.network;
    if (availableNetworkIds === null) return null;
    if (networkFromUrl && availableNetworkIds.includes(networkFromUrl)) return networkFromUrl;
    if (storedNetworkId && availableNetworkIds.includes(storedNetworkId)) return storedNetworkId;
    return availableNetworkIds[0] ?? null;
  }, [servedScope?.network, availableNetworkIds, networkFromUrl, storedNetworkId]);

  const { data: resolvedNetwork } = useResolvedNetwork(targetNetworkId);
  const network = resolvedNetwork;
  const domains = network?.domains ?? [];
  const allNetworks = React.useMemo(() => {
    if (!networksData) return [];
    return configuredNetworkIds.length > 0
      ? networksData.filter((n) => configuredNetworkIds.includes(n.id))
      : networksData;
  }, [networksData, configuredNetworkIds]);
  const showNetworkSelector = !servedScope && allNetworks.length > 1;

  // ── Per-profile scoping (#439) ───────────────────────────────────────────
  // Only LIVE profiles are offered — an action can only ever be scoped to a
  // live item, so draft/paused profiles have no actions of their own to show
  // and would be a dead end in the switcher.
  const { data: myItems, isLoading: myItemsLoading } = useMyItems(network);
  const liveItems = React.useMemo(
    () => myItems.filter((i) => i.lifecycle_status === 'live'),
    [myItems],
  );
  const { activeProfileId, setActiveProfile } = useActiveProfile(network, myItems);

  // `?profile=` wins on load (e.g. a bookmarked/shared link into a specific
  // profile's actions); otherwise fall back to the shared active-profile
  // store. Either way, if the resolved id isn't one of THIS page's live
  // profiles (stale/foreign/not-live), fall back to the first live profile —
  // WITHOUT calling `setActiveProfile` here, so a stored selection that just
  // happens to be paused/draft right now isn't clobbered for the map/discover
  // feed that also reads it.
  const profileFromUrl = searchParams.get('profile');
  const candidateProfileId = profileFromUrl ?? activeProfileId;
  const scopedId = React.useMemo(() => {
    if (candidateProfileId && liveItems.some((i) => i.item_id === candidateProfileId)) {
      return candidateProfileId;
    }
    return liveItems[0]?.item_id ?? null;
  }, [candidateProfileId, liveItems]);

  // Keep `?profile=` in sync with whatever the scoping actually resolved to
  // (covers both the initial fallback-to-first-live case and a stale URL
  // value getting corrected), so the URL stays shareable/bookmarkable.
  React.useEffect(() => {
    if (!scopedId) return;
    if (searchParams.get('profile') === scopedId) return;
    setSearchParams(
      (prev) => {
        prev.set('profile', scopedId);
        return prev;
      },
      { replace: true },
    );
  }, [scopedId, searchParams, setSearchParams]);

  // Explicit user action (sidebar profile switch) — updates the SHARED store
  // (so home/map pick it up too) as well as this page's URL.
  const handleActiveProfileChange = React.useCallback(
    (id: string) => {
      setActiveProfile(id);
      setSearchParams(
        (prev) => {
          prev.set('profile', id);
          return prev;
        },
        { replace: true },
      );
    },
    [setActiveProfile, setSearchParams],
  );

  const handleSidebarNetworkSelect = React.useCallback(
    (networkId: string) => {
      setSearchParams(
        (prev) => {
          prev.set('network', networkId);
          // The previous network's profile id has no meaning on the new
          // network — drop it so `scopedId` re-resolves to that network's
          // first live profile instead of failing the liveItems.some check
          // silently (harmless either way, but keeps the URL honest).
          prev.delete('profile');
          return prev;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  // My Actions has no domain-scoped browse concept (hideBrowse below hides
  // the control entirely) — kept only to satisfy PageShell/AppSidebar's prop
  // contract, which every other page wires the same way.
  const handleSidebarDomainSelect = React.useCallback((_domainId: string | null) => {}, []);

  const handleProfilesChanged = React.useCallback(() => {
    if (network) queryClient.invalidateQueries({ queryKey: queryKeys.myItems(network.id) });
  }, [network, queryClient]);

  const userSchemas = React.useMemo<Record<string, RJSFSchema>>(() => {
    if (!network) return {};
    const map: Record<string, RJSFSchema> = {};
    for (const domain of network.domains) {
      const schema = domain.item_schemas ? Object.values(domain.item_schemas)[0] : undefined;
      if (schema) map[domain.id] = schema;
    }
    return map;
  }, [network]);

  // ── Filter/sort state (#439 Task 13) — the URL is the single source of
  // truth; every control below (`ActionToolbar`/`ActionFiltersSheet`) reads
  // its value from here and writes back via `setSearchParams`, same pattern
  // as `profile`/`network` above.

  // Status: the toolbar works in CHIP terms (All/Pending/Accepted/Rejected),
  // stored in the URL as `?status=<Chip>` (absent = All). `FILTER_STATUSES`
  // (shared with `action-toolbar.tsx`) maps the chip to the raw
  // `action_status` values the hook/API expect.
  const statusChipParam = searchParams.get('status');
  const statusChip: ActionStatusFilter = (ACTION_STATUS_FILTERS as readonly string[]).includes(
    statusChipParam ?? '',
  )
    ? (statusChipParam as ActionStatusFilter)
    : 'All';
  const status = FILTER_STATUSES[statusChip] ?? undefined;

  const sortParam = searchParams.get('sort');
  const sort: FetchMyActionsQuery['sort'] = (
    ACTION_SORT_VALUES as readonly string[]
  ).includes(sortParam ?? '')
    ? (sortParam as FetchMyActionsQuery['sort'])
    : undefined;
  // The toolbar always needs a concrete value to render as "active" — the
  // hook itself defaults to 'recent' server-side when `sort` is undefined, so
  // mirror that default here rather than writing it into the URL up front.
  const toolbarSort: ActionSort = sort ?? 'recent';

  // Facet selections, `?f_<field>=value1,value2` — same URL convention as the
  // map/discover facet filter (home-page.tsx's `mapSelectedFields`). Kept as
  // a `Record<field, values[]>` (the shape `ActionFiltersSheet.selected`
  // wants) and derived into the hook's `Array<{field,values}>` shape below.
  const selectedFacets = React.useMemo<Record<string, string[]>>(() => {
    const result: Record<string, string[]> = {};
    for (const [param, value] of searchParams.entries()) {
      if (!param.startsWith('f_')) continue;
      const field = param.slice(2);
      if (!field) continue;
      const values = value.split(',').map((v) => decodeURIComponent(v.trim())).filter(Boolean);
      if (values.length > 0) result[field] = values;
    }
    return result;
  }, [searchParams]);
  const facets = React.useMemo<FetchMyActionsQuery['facets']>(
    () => Object.entries(selectedFacets).map(([field, values]) => ({ field, values })),
    [selectedFacets],
  );

  // Action type — Connect/Apply — its own `?action_type=` param (distinct
  // from the schema-derived `facets`, see `ActionFiltersSheetProps.selected`'s
  // doc comment for why).
  const actionTypeParam = searchParams.get('action_type');
  const actionTypes = React.useMemo<ActionTypeFilter[]>(() => {
    if (!actionTypeParam) return [];
    return actionTypeParam
      .split(',')
      .map((v) => v.trim())
      .filter((v): v is ActionTypeFilter => v === 'connect' || v === 'apply');
  }, [actionTypeParam]);
  const actionType: FetchMyActionsQuery['action_type'] = actionTypes.length > 0 ? actionTypes : undefined;

  // ── Filters-sheet domains (#439 Task 13) — mirrors home-page.tsx's
  // `filterFieldDomains`: the counterparty domain(s), i.e. every visible
  // domain except the active profile's own, falling back to all domains when
  // that would leave nothing (e.g. a self-only interaction domain).
  const scopedItem = React.useMemo(
    () => liveItems.find((i) => i.item_id === scopedId) ?? null,
    [liveItems, scopedId],
  );
  const filterDomains = React.useMemo(() => {
    if (!network) return [];
    const counterparts = network.domains.filter((d) => d.id !== scopedItem?.item_domain);
    return counterparts.length > 0 ? counterparts : network.domains;
  }, [network, scopedItem]);
  const enumFilterFields = React.useMemo(
    () => getEnumFilterFieldsForDomains(filterDomains),
    [filterDomains],
  );
  const facetLabelFor = React.useCallback(
    (field: string) => enumFilterFields.find((f) => f.key === field)?.label ?? humanizeKey(field),
    [enumFilterFields],
  );
  const activeFacetsForToolbar = React.useMemo<ActiveFacet[]>(() => {
    const result: ActiveFacet[] = [];
    for (const [field, values] of Object.entries(selectedFacets)) {
      const label = facetLabelFor(field);
      for (const value of values) result.push({ field, label, value });
    }
    return result;
  }, [selectedFacets, facetLabelFor]);

  // ── Write-path handlers — every control change round-trips through the URL
  // (never local component state), so the filter/sort state stays shareable
  // and a page refresh reproduces the same view.
  const handleStatusChange = React.useCallback(
    (chip: ActionStatusFilter) => {
      selection.exitSelect();
      setSearchParams(
        (prev) => {
          if (chip === 'All') prev.delete('status');
          else prev.set('status', chip);
          return prev;
        },
        { replace: true },
      );
    },
    [setSearchParams, selection],
  );

  const handleSortChange = React.useCallback(
    (nextSort: ActionSort) => {
      setSearchParams(
        (prev) => {
          prev.set('sort', nextSort);
          return prev;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const handleFacetsChange = React.useCallback(
    (next: Record<string, string[]>) => {
      setSearchParams(
        (prev) => {
          for (const key of Array.from(prev.keys())) {
            if (key.startsWith('f_')) prev.delete(key);
          }
          for (const [field, values] of Object.entries(next)) {
            if (values.length === 0) continue;
            prev.set(`f_${field}`, values.map(encodeURIComponent).join(','));
          }
          return prev;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const handleRemoveFacet = React.useCallback(
    (field: string, value: string) => {
      const current = selectedFacets[field] ?? [];
      const next = { ...selectedFacets, [field]: current.filter((v) => v !== value) };
      handleFacetsChange(next);
    },
    [selectedFacets, handleFacetsChange],
  );

  const handleActionTypesChange = React.useCallback(
    (next: ActionTypeFilter[]) => {
      setSearchParams(
        (prev) => {
          if (next.length === 0) prev.delete('action_type');
          else prev.set('action_type', next.join(','));
          return prev;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const handleClearFilters = React.useCallback(() => {
    setSearchParams(
      (prev) => {
        for (const key of Array.from(prev.keys())) {
          if (key.startsWith('f_')) prev.delete(key);
        }
        prev.delete('action_type');
        return prev;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // ── Actions data (#439: scoped to `scopedId`, paged via useInfiniteQuery) ─
  const initiatedQuery = useInitiatedActions(scopedId, { status, sort, facets, type: actionType });
  const receivedQuery = useReceivedActions(scopedId, { status, sort, facets, type: actionType });

  const handleTabChange = (tab: TabValue) => {
    selection.exitSelect();
    setActiveTab(tab);
  };

  const handleStatusUpdate = (action: Action, targetStatus: string) => {
    setSelectedAction(action);
    setSuggestedStatus(targetStatus);
    setIsStatusModalOpen(true);
  };

  const handleRefresh = () => {
    if (activeTab === 'initiated') {
      initiatedQuery.refetch();
    } else {
      receivedQuery.refetch();
    }
  };

  // Bootstrapping = still resolving which network/profile to scope to. Folded
  // into `isLoading` below (rather than a separate full-page loading screen)
  // so ActionList's existing skeleton covers this too, avoiding a flash of
  // its "nothing here yet" empty state before the scoped query has even had
  // a chance to become enabled.
  const isBootstrapping = availableNetworkIds === null || !network || myItemsLoading;

  const activeQuery = activeTab === 'initiated' ? initiatedQuery : receivedQuery;
  const isLoading = isBootstrapping || activeQuery.isLoading;
  const isError = !isBootstrapping && activeQuery.isError;
  const error = activeQuery.error;
  const isRefetching = activeQuery.isRefetching;

  const initiatedActions = React.useMemo(
    () => initiatedQuery.data?.pages.flatMap((p) => p.actions) ?? [],
    [initiatedQuery.data],
  );
  const receivedActions = React.useMemo(
    () => receivedQuery.data?.pages.flatMap((p) => p.actions) ?? [],
    [receivedQuery.data],
  );

  // Tab badge counts (#439 follow-up): the infinite query only ever loads a
  // page at a time, so `initiatedActions.length`/`receivedActions.length`
  // undercounts once there's more than one page. The true total is on every
  // page's `meta`, so the first page's is enough (it doesn't change as later
  // pages load).
  const initiatedTotal = initiatedQuery.data?.pages?.[0]?.meta.total;
  const receivedTotal = receivedQuery.data?.pages?.[0]?.meta.total;

  const sourceActions = activeTab === 'initiated' ? initiatedActions : receivedActions;
  const selectedActions = sourceActions.filter((a) => selection.selected.has(a.action_id));

  const shellSidebarProps = {
    networks: showNetworkSelector ? allNetworks : [],
    selectedNetwork: targetNetworkId,
    onNetworkSelect: handleSidebarNetworkSelect,
    domains,
    selectedDomain: null as string | null,
    onDomainSelect: handleSidebarDomainSelect,
    myItems: liveItems,
    activeProfileId: scopedId,
    onActiveProfileChange: handleActiveProfileChange,
    onProfilesChanged: handleProfilesChanged,
    userSchemas,
    hideBrowse: true,
  };

  return (
    <PageShell
      variant="form"
      title={t('actions.my_actions_title')}
      subtitle={t('actions.my_actions_subtitle')}
      onBack={() => navigate(-1)}
      backLabel={t('actions.my_actions_back')}
      {...shellSidebarProps}
    >
      <div className="mx-auto max-w-6xl">
        <ActionList
          initiatedActions={initiatedActions}
          receivedActions={receivedActions}
          initiatedTotal={initiatedTotal}
          receivedTotal={receivedTotal}
          isLoading={isLoading}
          isError={isError}
          error={error}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          onStatusUpdate={(action, targetStatus) => handleStatusUpdate(action, targetStatus)}
          onRefresh={handleRefresh}
          isRefetching={isRefetching}
          selection={selection}
          onBulkAction={(targetStatus) => {
            setBulkStatus(targetStatus);
            setBulkOpen(true);
          }}
          toolbarStatus={statusChip}
          toolbarSort={toolbarSort}
          activeFacets={activeFacetsForToolbar}
          onStatusChange={handleStatusChange}
          onSortChange={handleSortChange}
          onOpenFilters={() => setFiltersOpen(true)}
          onRemoveFacet={handleRemoveFacet}
          onClearFilters={handleClearFilters}
          hasNextPage={activeQuery.hasNextPage}
          isFetchingNextPage={activeQuery.isFetchingNextPage}
          onLoadMore={() => activeQuery.fetchNextPage()}
        />
      </div>

      <ActionFiltersSheet
        open={filtersOpen}
        domains={filterDomains}
        selected={selectedFacets}
        onChange={handleFacetsChange}
        actionTypes={actionTypes}
        onActionTypesChange={handleActionTypesChange}
        onClose={() => setFiltersOpen(false)}
      />

      <ActionStatusUpdater
        action={selectedAction}
        open={isStatusModalOpen}
        onOpenChange={setIsStatusModalOpen}
        suggestedStatus={suggestedStatus}
      />
      <BulkStatusDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        actions={selectedActions}
        targetStatus={bulkStatus}
        onSettled={(_succeeded, _total, failedIds) => {
          if (failedIds.length === 0) selection.exitSelect();
          else selection.setSelected(failedIds);
        }}
      />
    </PageShell>
  );
}
