import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { RJSFSchema } from '@rjsf/utils';
import {
  getExportableCounterparties,
  getExportableStatuses,
} from '@dpg/schemas/export_eligibility';
import { useOwnedActionsPage } from '@/hooks/use-actions';
import { useMyItems } from '@/hooks/use-my-items';
import { useActiveProfile } from '@/hooks/use-active-profile';
import { useNetworkConfigs, useResolvedNetwork } from '@/hooks/use-network-config';
import { getServedScope } from '@/lib/served-binding';
import { queryKeys } from '@/lib/query-keys';
import { getEnumFilterFieldsForDomains, humanizeKey } from '@/lib/enum-filters';
import { formatDomainLabel, pluralizeDomainLabel } from '@/lib/domain-icons';
import { PageShell } from '@/components/layout/page-shell';
import { ActionStatusUpdater } from '@/components/actions/action-status-updater';
import { BulkStatusDialog } from '@/components/actions/bulk-status-dialog';
import { ProfileCardModal, type ProfileCardCounterparty } from '@/components/actions/profile-card-modal';
import { getStatusStyle } from '@/components/actions/action-card';
import {
  COLUMN_IDS,
  MyActionsToolbar,
  type ColumnId,
  type FacetGroup,
} from '@/components/actions/my-actions/my-actions-toolbar';
import { ActionsTable, type BulkCommand, type RowCommand } from '@/components/actions/my-actions/actions-table';
import {
  ActionExportError,
  groupByCounterpartyType,
  runExportRequests,
  saveBlob,
  type ExportActionsBody,
} from '@/lib/action-export';
import {
  actionStatuses,
  actionTypes,
  activeFilterCount,
  applySavedView,
  currentSavedView,
  firstUseCopy,
  needsResponse,
  parseFilter,
  pendingStatuses,
  PENDING_OPTION,
  selectedStatusOptions,
  sidesOf,
  statusOptions as buildStatusOptions,
  toFetchQuery,
  viewExportableStatuses,
  withoutFacetValue,
  writeFilter,
  type MyActionsFilter,
  type StatusOption,
  type SavedViewId,
} from '@/lib/my-actions-view';
import type { Action } from '@/lib/action-api';

function parseNetworkIds(networkEnv: string | undefined): string[] {
  if (!networkEnv) return [];
  return networkEnv.split(',').map((n) => n.trim()).filter(Boolean);
}

// The same localStorage key `NetworkThemeProvider` (theme-provider.tsx)
// persists whenever a `?network=` param is seen — see the pre-revamp page.
const ACTIVE_NETWORK_STORAGE_KEY = 'dpg-active-network';
const COLUMNS_STORAGE_KEY = 'my-actions-columns';

function findTitleField(schema: RJSFSchema | undefined): string | null {
  if (!schema?.properties) return null;
  for (const key of ['name', 'full_name', 'title', 'organisationName', 'jobProviderName', 'role']) {
    if (key in schema.properties) return key;
  }
  return Object.keys(schema.properties)[0] ?? null;
}

/** Export error code → the message shown to the user. */
const EXPORT_ERROR_KEYS: Record<string, string> = {
  EXPORT_TOO_LARGE: 'actions.export_too_large',
  EXPORT_IN_PROGRESS: 'actions.export_in_progress',
  EXPORT_RATE_LIMITED: 'actions.export_rate_limited',
  EXPORT_NOT_ENABLED: 'actions.export_not_enabled',
  SERVICE_CALLER_NOT_ALLOWED: 'actions.export_not_enabled',
  STATUS_NOT_EXPORTABLE: 'actions.export_status_not_allowed',
  MIXED_COUNTERPARTY_TYPES: 'actions.export_mixed_types',
  NETWORK_CONFIG_UNAVAILABLE: 'actions.export_unavailable',
  EXPORT_RATE_LIMIT_UNAVAILABLE: 'actions.export_unavailable',
};

function exportErrorText(err: unknown, t: (key: string) => string): string {
  const code = err instanceof ActionExportError ? err.code : '';
  return t(EXPORT_ERROR_KEYS[code] ?? 'actions.export_failed');
}

function loadColumns(): Record<ColumnId, boolean> {
  const all = Object.fromEntries(COLUMN_IDS.map((c) => [c, true])) as Record<ColumnId, boolean>;
  try {
    const stored = JSON.parse(localStorage.getItem(COLUMNS_STORAGE_KEY) ?? '{}') as Partial<Record<ColumnId, boolean>>;
    return { ...all, ...stored };
  } catch {
    return all;
  }
}

/**
 * Which network My Actions shows: the served one, else `?network=`, else the
 * one last used elsewhere (localStorage), else the first configured.
 */
function useMyActionsNetwork(networkFromUrl: string | null) {
  const configuredNetworkIds = React.useMemo(() => parseNetworkIds(import.meta.env.VITE_NETWORK_ID), []);
  const servedScope = React.useMemo(() => getServedScope(), []);
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
        ? networksData.filter((n) => configuredNetworkIds.includes(n.id))
        : networksData;
    return filtered.map((n) => n.id);
  }, [networksData, networksError, configuredNetworkIds]);
  const targetNetworkId = React.useMemo(() => {
    if (servedScope?.network) return servedScope.network;
    if (availableNetworkIds === null) return null;
    if (networkFromUrl && availableNetworkIds.includes(networkFromUrl)) return networkFromUrl;
    if (storedNetworkId && availableNetworkIds.includes(storedNetworkId)) return storedNetworkId;
    return availableNetworkIds[0] ?? null;
  }, [servedScope?.network, availableNetworkIds, networkFromUrl, storedNetworkId]);
  const { data: network } = useResolvedNetwork(targetNetworkId);
  const allNetworks = React.useMemo(() => {
    if (!networksData) return [];
    return configuredNetworkIds.length > 0
      ? networksData.filter((n) => configuredNetworkIds.includes(n.id))
      : networksData;
  }, [networksData, configuredNetworkIds]);
  const showNetworkSelector = !servedScope && allNetworks.length > 1;

  return { availableNetworkIds, targetNetworkId, network, allNetworks, showNetworkSelector };
}

/**
 * My Actions (revamp): one table of the caller's sent and received actions
 * across their profiles — search, schema-driven filters, saved views, sort,
 * columns, pagination, bulk respond and export. Filter state lives in the URL.
 */
export function MyActionsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const { availableNetworkIds, targetNetworkId, network, allNetworks, showNetworkSelector } =
    useMyActionsNetwork(searchParams.get('network'));
  const domains = network?.domains ?? [];

  // ── The caller's profiles ────────────────────────────────────────────────
  const { data: myItems, isLoading: myItemsLoading } = useMyItems(network ?? null);
  const liveItems = React.useMemo(() => myItems.filter((i) => i.lifecycle_status === 'live'), [myItems]);
  const { activeProfileId, setActiveProfile } = useActiveProfile(network ?? null, myItems);
  const userSchemas = React.useMemo<Record<string, RJSFSchema>>(() => {
    const map: Record<string, RJSFSchema> = {};
    for (const d of domains) {
      const schema = d.item_schemas ? Object.values(d.item_schemas)[0] : undefined;
      if (schema) map[d.id] = schema;
    }
    return map;
  }, [domains]);
  const profileLabel = React.useCallback(
    (itemId: string) => {
      const item = myItems.find((i) => i.item_id === itemId);
      if (!item) return '—';
      const key = findTitleField(userSchemas[item.item_domain]);
      const v = key ? item.item_state[key] : null;
      return typeof v === 'string' && v.trim() ? v : t('nav.profile_fallback', 'Profile');
    },
    [myItems, userSchemas, t],
  );
  const profileOptions = React.useMemo(
    () => liveItems.map((i) => ({ id: i.item_id, label: profileLabel(i.item_id) })),
    [liveItems, profileLabel],
  );
  const myDomain = liveItems[0]?.item_domain ?? null; // one domain per account

  // ── Filter state (URL) ─────────────────────────────────────────────────────
  const filter = React.useMemo(() => parseFilter(searchParams), [searchParams]);
  const setFilter = React.useCallback(
    (next: MyActionsFilter) => setSearchParams((prev) => writeFilter(prev, next), { replace: true }),
    [setSearchParams],
  );

  // ── Network vocabulary ─────────────────────────────────────────────────────
  const statuses = React.useMemo(() => actionStatuses(network), [network]);
  const types = React.useMemo(() => actionTypes(network), [network]);
  const pending = React.useMemo(() => {
    const p = pendingStatuses(network);
    return p.length > 0 ? p : ['created', 'pending'];
  }, [network]);
  const exportStatuses = React.useMemo(
    () => (network && myDomain ? getExportableStatuses(network, myDomain) : []),
    [network, myDomain],
  );
  const exportableDomains = React.useMemo(
    () =>
      network && myDomain
        ? new Set(getExportableCounterparties(network, myDomain).map((c) => c.domain))
        : new Set<string>(),
    [network, myDomain],
  );
  const canExport = exportableDomains.size > 0 && exportStatuses.length > 0;
  const vocab = React.useMemo(() => ({ pending, exportable: exportStatuses }), [pending, exportStatuses]);

  const statusLabel = React.useCallback(
    (s: string) => {
      const key = getStatusStyle(s).labelKey;
      return key ? t(key) : humanizeKey(s);
    },
    [t],
  );
  const statusOptions = React.useMemo(
    () =>
      buildStatusOptions(statuses, pending).map((o) => ({
        ...o,
        label: o.id === PENDING_OPTION ? t('actions.status_pill_pending') : statusLabel(o.id),
      })),
    [statuses, pending, statusLabel, t],
  );
  const domainLabel = React.useCallback((d: string) => formatDomainLabel(d, domains), [domains]);

  // Schema-driven filters: one group per counterparty domain (every domain
  // but the caller's own), fields from that domain's item schema.
  const facetGroups = React.useMemo<FacetGroup[]>(() => {
    const counterparts = domains.filter((d) => d.id !== myDomain);
    return (counterparts.length > 0 ? counterparts : domains)
      .map((d) => ({
        domain: d.id,
        domainLabel: pluralizeDomainLabel(d.id, domains),
        fields: getEnumFilterFieldsForDomains([d]),
      }))
      .filter((g) => g.fields.length > 0);
  }, [domains, myDomain]);
  const fieldLabel = React.useCallback(
    (domain: string, field: string) => {
      const schema = domains.find((d) => d.id === domain)?.item_schemas;
      for (const s of Object.values(schema ?? {})) {
        const title = (s.properties as Record<string, { title?: string }> | undefined)?.[field]?.title;
        if (title) return title;
      }
      return humanizeKey(field);
    },
    [domains],
  );

  // ── Data ───────────────────────────────────────────────────────────────────
  const query = React.useMemo(() => toFetchQuery(filter), [filter]);
  const isBootstrapping = availableNetworkIds === null || !network || myItemsLoading;
  const actionsQuery = useOwnedActionsPage(query, !isBootstrapping && liveItems.length > 0);
  const rows = React.useMemo(() => actionsQuery.data?.actions ?? [], [actionsQuery.data]);
  const total = actionsQuery.data?.meta.total ?? 0;
  const counts = actionsQuery.data?.meta.counts;

  // A filter change can shrink the result set below the current page.
  React.useEffect(() => {
    const pages = Math.max(1, Math.ceil(total / filter.per));
    if (actionsQuery.data && filter.page > pages) setFilter({ ...filter, page: pages });
  }, [total, filter, actionsQuery.data, setFilter]);

  // ── Columns ────────────────────────────────────────────────────────────────
  const [columns, setColumns] = React.useState<Record<ColumnId, boolean>>(loadColumns);
  const toggleColumn = (id: ColumnId) =>
    setColumns((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — keep the in-memory choice */
      }
      return next;
    });

  // ── Selection ──────────────────────────────────────────────────────────────
  // Ids picked row by row, remembered with their rows across pages; or "all
  // matching", which exports by filter instead of by ids.
  const [picked, setPicked] = React.useState<Map<string, Action>>(new Map());
  const [allMatching, setAllMatching] = React.useState(false);
  const filterKey = JSON.stringify({ ...query, limit: 0, offset: 0 });
  React.useEffect(() => {
    setPicked(new Map());
    setAllMatching(false);
  }, [filterKey]);
  const selectedIds = React.useMemo(
    () => (allMatching ? new Set([...rows.map((r) => r.action_id), ...picked.keys()]) : new Set(picked.keys())),
    [allMatching, rows, picked],
  );
  const selectionSize = allMatching ? total : picked.size;
  const clearSelection = () => {
    setPicked(new Map());
    setAllMatching(false);
  };
  const toggleRow = (id: string) => {
    setAllMatching(false);
    setPicked((prev) => {
      const next = new Map(prev);
      const row = rows.find((r) => r.action_id === id);
      if (next.has(id)) next.delete(id);
      else if (row) next.set(id, row);
      return next;
    });
  };
  const togglePage = (ids: string[], on: boolean) => {
    setAllMatching(false);
    setPicked((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        const row = rows.find((r) => r.action_id === id);
        if (on && row) next.set(id, row);
        else next.delete(id);
      }
      return next;
    });
  };

  // ── Status changes ─────────────────────────────────────────────────────────
  const [statusTarget, setStatusTarget] = React.useState<{ action: Action; status: string } | null>(null);
  const [bulk, setBulk] = React.useState<{ actions: Action[]; status: string } | null>(null);
  const [profileOf, setProfileOf] = React.useState<{ action: Action; counterparty: ProfileCardCounterparty } | null>(
    null,
  );

  // ── Export ─────────────────────────────────────────────────────────────────
  const [exporting, setExporting] = React.useState(false);
  const exportErrorMessage = (err: unknown) => exportErrorText(err, t);
  /** One file per counterparty type (see runExportRequests); then one summary toast. */
  const runExports = async (requests: Array<ExportActionsBody['filters']>) => {
    setExporting(true);
    try {
      const { exported, skipped, failure } = await runExportRequests(requests, (r) => saveBlob(r.blob, r.filename));
      if (failure) toast.error(exportErrorMessage(failure));
      if (exported > 0) {
        toast.success(
          skipped > 0
            ? t('actions.export_done_skipped', { count: exported, skipped })
            : t('actions.export_done', { count: exported }),
        );
      } else if (!failure) {
        toast.error(t('actions.export_nothing'));
      }
    } finally {
      setExporting(false);
    }
  };
  const viewExportStatuses = viewExportableStatuses(filter.statuses, exportStatuses);
  const baseExportFilters = (): ExportActionsBody['filters'] => ({
    ownership_role: query.ownership_role ?? 'all',
    // The picked profiles, else every live one — so the server scopes the
    // export by the profiles this page lists, not an older or retired one.
    item_ids: query.item_ids ?? (liveItems.length > 0 ? liveItems.slice(0, 50).map((i) => i.item_id) : undefined),
    action_type: Array.isArray(query.action_type) ? query.action_type : undefined,
    // Only exportable statuses; a row whose status changed since it was shown
    // is dropped server-side instead of exported.
    action_status: viewExportStatuses,
    q: query.q,
    facets: query.facets,
  });
  // One export target per counterparty type the caller may export — a
  // provider gets seekers + service providers, a service provider gets
  // providers + seekers (network.json `export.requester_domains`). Each is one
  // file; "all" runs them in turn.
  const exportTargets = (): Array<{ key: string; domain: string; count?: number; filters: ExportActionsBody['filters'] }> => {
    if (viewExportStatuses.length === 0) return [];
    if (allMatching) {
      return [...exportableDomains].sort((a, b) => a.localeCompare(b)).map((domain) => ({
        key: domain,
        domain,
        filters: { ...baseExportFilters(), counterparty_domain: domain },
      }));
    }
    const exportable = [...picked.values()].filter((a) => viewExportStatuses.includes(a.action_status));
    return groupByCounterpartyType(exportable)
      .filter((g) => exportableDomains.has(g.domain))
      .map((g) => ({
        key: g.key,
        domain: g.domain,
        count: g.actionIds.length,
        filters: {
          ...baseExportFilters(),
          action_ids: g.actionIds,
          counterparty_network: g.network,
          counterparty_domain: g.domain,
          counterparty_item_type: g.itemType,
        },
      }));
  };

  // ── Bulk commands (counts reflect what each would act on) ──────────────────
  const pickedRows = [...picked.values()];
  const respondable = pickedRows.filter((a) => needsResponse(a, pending));
  let exportableCount = pickedRows.filter((a) => viewExportStatuses.includes(a.action_status)).length;
  if (allMatching) exportableCount = viewExportStatuses.length > 0 ? (counts?.ready_to_export ?? 0) : 0;
  // One button per counterparty type the selection holds ("Export seekers
  // (9)", "Export service providers (1)") — each downloads its own file, so
  // the caller picks the one they need. Under "select all" the per-type
  // counts are not known, so those buttons show no number.
  const exportCommands = (): BulkCommand[] => {
    if (exporting) {
      return [{ id: 'export', label: t('my_actions.exporting', 'Exporting…'), count: 1, hideCount: true, tone: 'primary', onClick: () => {} }];
    }
    const plural = (d: string) => pluralizeDomainLabel(d, domains).toLowerCase();
    return exportTargets().map((x) => ({
      id: `export:${x.key}`,
      label: t('my_actions.export_type', 'Export {{type}}', { type: plural(x.domain) }),
      count: x.count ?? (exportableCount > 0 ? 1 : 0),
      hideCount: x.count == null,
      tone: 'primary',
      onClick: () => void runExports([x.filters]),
    }));
  };

  // Selection only when some bulk command can apply to this caller: they may
  // export, or they have received requests waiting on a reply (Accept /
  // Reject). A seeker with only sent applications gets no checkboxes.
  const selectable =
    canExport || (counts?.needs_response ?? 0) > 0 || rows.some((a) => needsResponse(a, pending));

  const notExportable = allMatching ? 0 : pickedRows.length - exportableCount;
  let selectionNote: string | undefined;
  if (canExport && exportableCount > 0 && notExportable > 0) {
    selectionNote = t('my_actions.note_not_exportable', '{{count}} not exportable — only accepted or completed', {
      count: notExportable,
    });
  }
  const bulkCommands: BulkCommand[] = [
    {
      id: 'accept',
      label: t('actions.btn_accept', 'Accept'),
      count: allMatching ? 0 : respondable.length,
      tone: 'accept',
      onClick: () => setBulk({ actions: respondable, status: 'accepted' }),
    },
    {
      id: 'reject',
      label: t('actions.btn_reject', 'Reject'),
      count: allMatching ? 0 : respondable.length,
      tone: 'reject',
      onClick: () => setBulk({ actions: respondable, status: 'rejected' }),
    },
    ...(canExport ? exportCommands() : []),
  ];

  const onCommand = (action: Action, command: RowCommand) => {
    if (command === 'view_profile') {
      const { other } = sidesOf(action);
      const hasName = !!other.name && other.name !== other.itemId;
      setProfileOf({
        action,
        counterparty: {
          name: hasName ? other.name! : domainLabel(other.domain),
          itemId: other.itemId,
          itemNetwork: other.network,
          itemDomain: other.domain,
          itemType: other.itemType,
        },
      });
      return;
    }
    if (command === 'export') {
      const { other } = sidesOf(action);
      void runExports([
        {
          ...baseExportFilters(),
          action_ids: [action.action_id],
          counterparty_domain: other.domain,
          counterparty_item_type: other.itemType,
        },
      ]);
      return;
    }
    setStatusTarget({ action, status: command });
  };

  const onSavedView = (view: SavedViewId) => setFilter(applySavedView(filter, view, vocab));

  // Back: the previous in-app page when there is one; otherwise (the tab
  // opened here — after login, a pasted or refreshed URL) the map view.
  // History index, not `location.key`: filter changes replace the URL, which
  // mints a new key without adding anything to go back to.
  const mapUrl = `/?network=${encodeURIComponent(targetNetworkId ?? '')}&view=map`;
  const handleBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(mapUrl);
  };

  // Nothing filtered and still no rows: the caller has no actions yet, so
  // point them at where actions start (the map) instead of "loosen the
  // filters". Worded for the action types this network actually has.
  const nothingFiltered = activeFilterCount(filter) === 0 && !filter.q.trim() && filter.profiles.length === 0;
  const [firstUseKey, firstUseFallback] = firstUseCopy(types);
  const emptyState = nothingFiltered
    ? {
        title: t('my_actions.first_use_title', 'No actions yet'),
        body: t(firstUseKey, firstUseFallback),
        action: { label: t('my_actions.go_to_map', 'Go to the map'), onClick: () => navigate(mapUrl) },
      }
    : undefined;

  // ── Sidebar (profile switch still sets the shared active profile) ──────────
  const handleActiveProfileChange = (id: string) => {
    setActiveProfile(id);
    setFilter({ ...filter, profiles: [id], page: 1 });
  };
  const handleSidebarNetworkSelect = (networkId: string) =>
    setSearchParams(
      (prev) => {
        prev.set('network', networkId);
        prev.delete('profiles');
        return prev;
      },
      { replace: true },
    );
  const handleProfilesChanged = () => {
    if (network) queryClient.invalidateQueries({ queryKey: queryKeys.myItems(network.id) });
  };

  return (
    <PageShell
      variant="form"
      title={t('actions.my_actions_title')}
      subtitle={t('actions.my_actions_subtitle')}
      onBack={handleBack}
      backLabel={t('actions.my_actions_back')}
      networks={showNetworkSelector ? allNetworks : []}
      selectedNetwork={targetNetworkId}
      onNetworkSelect={handleSidebarNetworkSelect}
      domains={domains}
      selectedDomain={null}
      onDomainSelect={() => {}}
      myItems={liveItems}
      activeProfileId={filter.profiles.length === 1 ? filter.profiles[0] : activeProfileId}
      onActiveProfileChange={handleActiveProfileChange}
      onProfilesChanged={handleProfilesChanged}
      userSchemas={userSchemas}
      hideBrowse
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-3">
        <MyActionsToolbar
          filter={filter}
          onChange={setFilter}
          profiles={profileOptions}
          statusOptions={statusOptions}
          types={types}
          facetGroups={facetGroups}
          columns={columns}
          onToggleColumn={toggleColumn}
          savedView={currentSavedView(filter, vocab)}
          counts={counts}
          onSavedView={onSavedView}
          onRefresh={() => void actionsQuery.refetch()}
          refreshing={actionsQuery.isFetching}
        />

        <ActiveChips
          filter={filter}
          onChange={setFilter}
          statusOptions={statusOptions}
          statusLabel={statusLabel}
          profileLabel={profileLabel}
          fieldLabel={fieldLabel}
        />

        <ActionsTable
          emptyState={emptyState}
          selectable={selectable}
          rows={rows}
          total={total}
          page={filter.page}
          per={filter.per}
          onPage={(page) => setFilter({ ...filter, page })}
          onPer={(per) => setFilter({ ...filter, per, page: 1 })}
          columns={columns}
          sort={filter.sort}
          onSort={(sort) => setFilter({ ...filter, sort, page: 1 })}
          isLoading={isBootstrapping || actionsQuery.isLoading}
          isError={!isBootstrapping && actionsQuery.isError}
          onRetry={() => void actionsQuery.refetch()}
          pendingStatuses={pending}
          exportStatuses={exportStatuses}
          canExport={canExport}
          domainLabel={domainLabel}
          profileLabel={profileLabel}
          fieldLabel={fieldLabel}
          statusLabel={statusLabel}
          selected={selectedIds}
          onToggle={toggleRow}
          onTogglePage={togglePage}
          onSelectAll={() => setAllMatching(true)}
          onClearSelection={clearSelection}
          bulkCommands={selectionSize > 0 ? bulkCommands : []}
          selectionNote={selectionNote}
          onCommand={onCommand}
        />
      </div>

      <ActionStatusUpdater
        action={statusTarget?.action ?? null}
        open={statusTarget !== null}
        onOpenChange={(open) => !open && setStatusTarget(null)}
        suggestedStatus={statusTarget?.status ?? ''}
      />
      <BulkStatusDialog
        open={bulk !== null}
        onOpenChange={(open) => !open && setBulk(null)}
        actions={bulk?.actions ?? []}
        targetStatus={bulk?.status ?? ''}
        onSettled={(_ok, _total, failedIds) => {
          setPicked((prev) => new Map([...prev].filter(([id]) => failedIds.includes(id))));
        }}
      />
      {profileOf ? (
        <ProfileCardModal
          open
          onOpenChange={(open) => !open && setProfileOf(null)}
          actionId={profileOf.action.action_id}
          actionStatus={profileOf.action.action_status}
          counterparty={profileOf.counterparty}
        />
      ) : null}
    </PageShell>
  );
}

function ActiveChips({
  filter,
  onChange,
  statusOptions,
  statusLabel,
  profileLabel,
  fieldLabel,
}: Readonly<{
  filter: MyActionsFilter;
  onChange: (f: MyActionsFilter) => void;
  statusOptions: Array<StatusOption & { label: string }>;
  statusLabel: (s: string) => string;
  profileLabel: (id: string) => string;
  fieldLabel: (domain: string, field: string) => string;
}>) {
  const { t } = useTranslation();
  const chips: Array<{ key: string; group: string; label: string; remove: () => MyActionsFilter }> = [
    ...(filter.q.trim()
      ? [{ key: 'q', group: t('my_actions.chip_search', 'Search'), label: `“${filter.q}”`, remove: () => ({ ...filter, q: '' }) }]
      : []),
    ...filter.profiles.map((p) => ({
      key: `p:${p}`,
      group: t('my_actions.chip_profile', 'Profile'),
      label: profileLabel(p),
      remove: () => ({ ...filter, profiles: filter.profiles.filter((x) => x !== p) }),
    })),
    ...(filter.direction !== 'all'
      ? [
          {
            key: 'dir',
            group: t('my_actions.filter_direction', 'Direction'),
            label: filter.direction === 'received' ? t('my_actions.dir_received', 'Received') : t('my_actions.dir_sent', 'Sent'),
            remove: () => ({ ...filter, direction: 'all' as const }),
          },
        ]
      : []),
    // One chip per status option, so the grouped "Pending" is one chip.
    ...selectedStatusOptions(filter.statuses, statusOptions).map((o) => ({
      key: `s:${o.id}`,
      group: t('my_actions.filter_status', 'Status'),
      label: statusOptions.find((x) => x.id === o.id)?.label ?? statusLabel(o.id),
      remove: () => ({ ...filter, statuses: filter.statuses.filter((x) => !o.statuses.includes(x)) }),
    })),
    ...filter.types.map((ty) => ({
      key: `t:${ty}`,
      group: t('my_actions.filter_type', 'Action type'),
      label: ty,
      remove: () => ({ ...filter, types: filter.types.filter((x) => x !== ty) }),
    })),
    ...filter.facets.flatMap((f) =>
      f.values.map((v) => ({
        key: `f:${f.domain}.${f.field}:${v}`,
        group: fieldLabel(f.domain, f.field),
        label: v,
        remove: () => withoutFacetValue(filter, f.domain, f.field, v),
      })),
    ),
  ];
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[13px] text-muted-foreground">{t('my_actions.active', 'Active:')}</span>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onChange({ ...c.remove(), page: 1 })}
          className="flex h-7 items-center gap-1.5 rounded-full border border-primary bg-primary/5 pl-3 pr-2 text-[13px] font-semibold text-primary"
          aria-label={t('my_actions.remove_filter', 'Remove {{label}}', { label: `${c.group}: ${c.label}` })}
        >
          <span className="font-medium text-muted-foreground">{c.group}:</span>
          {c.label}
          <span aria-hidden="true">✕</span>
        </button>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({ ...filter, q: '', profiles: [], statuses: [], types: [], direction: 'all', facets: [], page: 1 })
        }
        className="text-[13px] font-semibold text-primary underline"
      >
        {t('my_actions.clear_all', 'Clear all')}
      </button>
    </div>
  );
}
