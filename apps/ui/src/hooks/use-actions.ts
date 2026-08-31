import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import {
  fetchMyActions,
  updateActionStatus,
  updateActionStatusBulk,
  type FetchMyActionsQuery,
  type UpdateActionStatusPayload,
  type UpdateActionStatusResponse,
  type Action,
} from '@/lib/action-api';
import type { BulkEnvelope } from '@/lib/bulk';
import { useAuth } from '@/contexts/auth-context';
import { queryKeys } from '@/lib/query-keys';
import { getRuntimeEnv } from '@/lib/runtime-env';

// ─── Query Keys ───────────────────────────────────────────────────

export const actionKeys = queryKeys.actions;

// ─── Constants ───────────────────────────────────────────────────

// How often to re-fetch action lists + the pending-action badge count.
// 5s was historically the default for a "real-time feel" but produces ~12
// requests per minute per logged-in user even when nothing changes — the
// dominant cost in the captured HAR. 30s is a better default for a
// notification badge (the receiver also gets an instant local refresh via
// useUpdateActionStatus.onSuccess invalidation, so polling only covers
// the cross-user case of someone else sending a new action).
//
// Override via `VITE_ACTION_POLL_INTERVAL_MS` (e.g. `"15000"` to poll every
// 15 seconds, or `"0"` to disable polling entirely and rely on mutations).
const DEFAULT_POLLING_INTERVAL = 60000;

export function resolvePollingInterval(): number | false {
  const raw = getRuntimeEnv('VITE_ACTION_POLL_INTERVAL_MS');
  if (raw === undefined || raw === '') return DEFAULT_POLLING_INTERVAL;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_POLLING_INTERVAL;
  if (parsed === 0) return false; // false disables polling in react-query
  return parsed;
}

const POLLING_INTERVAL = resolvePollingInterval();

// Page size for BOTH the plain `useActions` query (when the caller doesn't
// override it) and the paged `useReceivedActions`/`useInitiatedActions`
// infinite queries below (#439). Replaces the old hardcoded `limit: 100,
// offset: 0` — a small page + `useInfiniteQuery`'s `getNextPageParam` is what
// makes "My Actions" pageable instead of fetching everything up front.
export const ACTIONS_PAGE_SIZE = 20;

// The query-shaping fields #439 adds on top of plain react-query options.
// Kept as ONE merged options object (rather than a separate `params` arg) so
// every existing `useActions('all', { enabled: !!user })` call site keeps
// working unchanged.
interface ActionQueryFields {
  /** Scope to a single item's actions (either side) — the active profile. */
  itemId?: string | null;
  status?: NonNullable<FetchMyActionsQuery['action_status']>;
  type?: NonNullable<FetchMyActionsQuery['action_type']>;
  sort?: NonNullable<FetchMyActionsQuery['sort']>;
  facets?: NonNullable<FetchMyActionsQuery['facets']>;
  limit?: number;
}

type UseActionsOptions = ActionQueryFields &
  Omit<
    UseQueryOptions<{ actions: Action[]; meta: { total: number } }, Error>,
    'queryKey' | 'queryFn'
  >;

/**
 * Builds the FetchMyActionsQuery filter shape shared by `useActions` and the
 * infinite `useReceivedActions`/`useInitiatedActions` below, WITHOUT `offset`
 * — offset is either fixed (plain `useActions`) or driven by
 * `useInfiniteQuery`'s pageParam (the infinite hooks), so it's applied by the
 * caller, not baked into this shared shape (mirrors
 * `useInfiniteBrowseItems`'s `filterKey` convention).
 */
function buildActionsFilterKey(
  ownershipRole: 'initiated' | 'received' | 'all',
  fields: ActionQueryFields,
): Omit<FetchMyActionsQuery, 'offset'> {
  return {
    ownership_role: ownershipRole,
    ...(fields.itemId ? { item_id: fields.itemId } : {}),
    ...(fields.status !== undefined ? { action_status: fields.status } : {}),
    ...(fields.type !== undefined ? { action_type: fields.type } : {}),
    ...(fields.sort ? { sort: fields.sort } : {}),
    ...(fields.facets && fields.facets.length > 0 ? { facets: fields.facets } : {}),
    limit: fields.limit ?? ACTIONS_PAGE_SIZE,
  };
}

// ─── Hooks ────────────────────────────────────────────────────────

/**
 * Hook to fetch actions with auto-polling every 5 seconds
 * Use ownershipRole to filter: 'initiated' | 'received' | 'all'
 *
 * #439: now also accepts the same query-shaping fields as the infinite
 * hooks below (`itemId`/`status`/`type`/`sort`/`facets`/`limit`) merged into
 * the options object, so a caller that only wants "give me my recent
 * actions" (e.g. the home-page/public-profile-page open-pair-check) keeps
 * working unchanged while a caller that wants to scope/sort can opt in.
 */
export function useActions(
  ownershipRole: 'initiated' | 'received' | 'all' = 'all',
  options: UseActionsOptions = {}
) {
  const { isAuthenticated } = useAuth();
  const { enabled: callerEnabled, itemId, status, type, sort, facets, limit, ...restOptions } =
    options;
  const filterKey = buildActionsFilterKey(ownershipRole, { itemId, status, type, sort, facets, limit });
  const query: FetchMyActionsQuery = { ...filterKey, offset: 0 };

  return useQuery({
    queryKey: actionKeys.list(query),
    queryFn: async ({ signal }) => {
      const response = await fetchMyActions(query, signal);
      return {
        actions: response.actions,
        meta: response.meta,
      };
    },
    refetchInterval: POLLING_INTERVAL,
    refetchIntervalInBackground: false, // Stop polling when tab is hidden
    staleTime: POLLING_INTERVAL === false ? Infinity : POLLING_INTERVAL,
    ...restOptions,
    // Don't fetch/poll actions for anonymous users — the endpoint requires a
    // session and would 401 on every poll (e.g. sidebar open while logged out).
    enabled: isAuthenticated && (callerEnabled ?? true),
  });
}

/**
 * Hook to get count of pending received actions for badge
 * Auto-polls every 5 seconds
 */
export function usePendingActionsCount() {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: actionKeys.pendingCount(),
    queryFn: async ({ signal }) => {
      const response = await fetchMyActions(
        {
          ownership_role: 'received',
          action_status: 'created', // Only pending/new actions
          limit: 1,
          offset: 0,
        },
        signal
      );
      return response.meta.total;
    },
    refetchInterval: POLLING_INTERVAL,
    refetchIntervalInBackground: false,
    staleTime: POLLING_INTERVAL === false ? Infinity : POLLING_INTERVAL,
    // Anonymous users have no actions — skip the polling entirely (avoids
    // repeated 401s when the sidebar is open while logged out).
    enabled: isAuthenticated,
  });
}

/**
 * Hook to update action status
 * Automatically invalidates action queries on success
 */
export function useUpdateActionStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: UpdateActionStatusPayload) => {
      const response = await updateActionStatus(payload);
      return response;
    },
    onSuccess: () => {
      // Invalidate all action-related queries to refresh data
      queryClient.invalidateQueries({ queryKey: actionKeys.all });
    },
  });
}

/**
 * Bulk update action statuses. Returns the full envelope (so callers can show
 * partial-success). Invalidates all action queries on settle.
 */
export function useUpdateActionStatusBulk() {
  const queryClient = useQueryClient();

  return useMutation<
    BulkEnvelope<UpdateActionStatusResponse>,
    Error,
    // `guardianOtp` (when a minor resubmits the batch after GUARDIAN_OTP_REQUIRED)
    // rides on every payload so one code clears the whole accept batch (#393).
    { payloads: UpdateActionStatusPayload[]; guardianOtp?: string }
  >({
    mutationFn: ({ payloads, guardianOtp }) => updateActionStatusBulk(payloads, guardianOtp),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: actionKeys.all });
    },
  });
}

/**
 * Hook to get actions by specific status
 * Useful for filtering received actions
 */
export function useReceivedActionsByStatus(
  status?: string,
  options: Omit<
    UseQueryOptions<{ actions: Action[]; meta: { total: number } }, Error>,
    'queryKey' | 'queryFn'
  > = {}
) {
  const { isAuthenticated } = useAuth();
  const { enabled: callerEnabled, ...restOptions } = options;
  const query: FetchMyActionsQuery = {
    ownership_role: 'received',
    action_status: status,
    limit: 100,
    offset: 0,
  };

  return useQuery({
    queryKey: actionKeys.list(query),
    queryFn: async ({ signal }) => {
      const response = await fetchMyActions(query, signal);
      return {
        actions: response.actions,
        meta: response.meta,
      };
    },
    refetchInterval: POLLING_INTERVAL,
    refetchIntervalInBackground: false,
    staleTime: POLLING_INTERVAL === false ? Infinity : POLLING_INTERVAL,
    ...restOptions,
    enabled: isAuthenticated && (callerEnabled ?? true),
  });
}

/**
 * Query-shaping params `useReceivedActions`/`useInitiatedActions` accept on
 * top of the required scoping `itemId` (#439: My Actions per-profile
 * filter/sort — the page owns this state and passes it straight through).
 */
export interface UseOwnedActionsParams {
  status?: NonNullable<FetchMyActionsQuery['action_status']>;
  type?: NonNullable<FetchMyActionsQuery['action_type']>;
  sort?: NonNullable<FetchMyActionsQuery['sort']>;
  facets?: NonNullable<FetchMyActionsQuery['facets']>;
}

interface ActionsPage {
  actions: Action[];
  meta: { total: number; limit: number; offset: number };
}

/**
 * Shared `useInfiniteQuery` builder for the received/initiated tabs (#439).
 * `itemId` is REQUIRED to be a real id for the query to run — My Actions is
 * now scoped to exactly one (live) profile, so with no resolvable profile
 * there is nothing to scope to and the fetch stays disabled (an empty list
 * is the correct end state, not "fetch everything unscoped" like the old
 * behavior).
 *
 * The query key is built from `buildActionsFilterKey` (limit fixed at
 * `ACTIONS_PAGE_SIZE`, NO offset) so paging within the same filter set
 * appends pages via `fetchNextPage` instead of minting a new cache entry per
 * page; changing any filter (status/sort/facets/itemId) changes the key and
 * `useInfiniteQuery` restarts paging at offset 0, matching
 * `useInfiniteBrowseItems`'s convention.
 */
function useOwnedActionsInfinite(
  ownershipRole: 'initiated' | 'received',
  itemId: string | null | undefined,
  params: UseOwnedActionsParams = {},
) {
  const { isAuthenticated } = useAuth();
  const filterKey = buildActionsFilterKey(ownershipRole, { itemId, ...params });

  return useInfiniteQuery<ActionsPage>({
    queryKey: actionKeys.list(filterKey),
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const response = await fetchMyActions({ ...filterKey, offset: pageParam as number }, signal);
      return { actions: response.actions, meta: response.meta };
    },
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.meta.offset + lastPage.meta.limit;
      return nextOffset < lastPage.meta.total ? nextOffset : undefined;
    },
    // Same freshness behavior as before (60s default) — a refetch just
    // re-requests the FIRST page's worth (react-query refetches every loaded
    // page on an interval/invalidate, same as it always has for infinite
    // queries), keeping the badge/list in sync without a full page reload.
    refetchInterval: POLLING_INTERVAL,
    refetchIntervalInBackground: false,
    staleTime: POLLING_INTERVAL === false ? Infinity : POLLING_INTERVAL,
    enabled: isAuthenticated && !!itemId,
  });
}

/**
 * Hook to get initiated actions, scoped to `itemId` (the active live
 * profile) and paged via `useInfiniteQuery` (#439). See
 * `useOwnedActionsInfinite` for the shared paging/scoping behavior.
 */
export function useInitiatedActions(
  itemId: string | null | undefined,
  params: UseOwnedActionsParams = {},
) {
  return useOwnedActionsInfinite('initiated', itemId, params);
}

/**
 * Hook to get received actions, scoped to `itemId` (the active live
 * profile) and paged via `useInfiniteQuery` (#439). See
 * `useOwnedActionsInfinite` for the shared paging/scoping behavior.
 */
export function useReceivedActions(
  itemId: string | null | undefined,
  params: UseOwnedActionsParams = {},
) {
  return useOwnedActionsInfinite('received', itemId, params);
}
