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
import { PageShell } from '@/components/layout/page-shell';
import { ActionList } from '@/components/actions/action-list';
import { ActionStatusUpdater } from '@/components/actions/action-status-updater';
import { BulkStatusDialog } from '@/components/actions/bulk-status-dialog';
import { Button } from '@/components/ui/button';
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
      setSearchParams((prev) => {
        prev.set('profile', id);
        return prev;
      });
    },
    [setActiveProfile, setSearchParams],
  );

  const handleSidebarNetworkSelect = React.useCallback(
    (networkId: string) => {
      setSearchParams((prev) => {
        prev.set('network', networkId);
        // The previous network's profile id has no meaning on the new
        // network — drop it so `scopedId` re-resolves to that network's
        // first live profile instead of failing the liveItems.some check
        // silently (harmless either way, but keeps the URL honest).
        prev.delete('profile');
        return prev;
      });
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

  // ── Filter/sort state (#439) — sourced straight from the URL, which is the
  // single source of truth here. No control writes these yet (the toolbar/
  // filters-sheet land in later tasks of this epic); once they do, they'll
  // drive them via the same `setSearchParams` pattern used above for
  // `profile`/`network`, and this page won't need to change.
  const statusParam = searchParams.get('status');
  const status = React.useMemo<FetchMyActionsQuery['action_status']>(
    () => (statusParam ? statusParam.split(',').map((s) => s.trim()).filter(Boolean) : undefined),
    [statusParam],
  );
  const sortParam = searchParams.get('sort');
  const sort: FetchMyActionsQuery['sort'] = (
    ACTION_SORT_VALUES as readonly string[]
  ).includes(sortParam ?? '')
    ? (sortParam as FetchMyActionsQuery['sort'])
    : undefined;
  // Facet selections, `?f_<field>=value1,value2` — same URL convention as the
  // map/discover facet filter (home-page.tsx's `mapSelectedFields`).
  const facets = React.useMemo<FetchMyActionsQuery['facets']>(() => {
    const result: Array<{ field: string; values: string[] }> = [];
    for (const [param, value] of searchParams.entries()) {
      if (!param.startsWith('f_')) continue;
      const field = param.slice(2);
      if (!field) continue;
      const values = value.split(',').map((v) => decodeURIComponent(v.trim())).filter(Boolean);
      if (values.length > 0) result.push({ field, values });
    }
    return result;
  }, [searchParams]);

  // ── Actions data (#439: scoped to `scopedId`, paged via useInfiniteQuery) ─
  const initiatedQuery = useInitiatedActions(scopedId, { status, sort, facets });
  const receivedQuery = useReceivedActions(scopedId, { status, sort, facets });

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
        />
        {/* Reachable pagination for the now page-sized (20/request) queries —
            a plain "Load more" for now; ActionList's own infinite-scroll UI
            (dropping this button in favor of a scroll sentinel) is a later
            task in this epic. */}
        {activeQuery.hasNextPage && (
          <div className="mt-6 flex justify-center">
            <Button
              variant="outline"
              onClick={() => activeQuery.fetchNextPage()}
              disabled={activeQuery.isFetchingNextPage}
            >
              {activeQuery.isFetchingNextPage
                ? t('actions.loading_more')
                : t('actions.load_more')}
            </Button>
          </div>
        )}
      </div>

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
