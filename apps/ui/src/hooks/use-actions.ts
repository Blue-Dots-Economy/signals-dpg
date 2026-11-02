import {
  keepPreviousData,
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

export const actionKeys = queryKeys.actions;

// How often action lists and the pending badge refetch (default 60s). Polling
// only covers someone else sending a new action; a user's own status change
// refreshes at once through mutation invalidation. Override with
// `VITE_ACTION_POLL_INTERVAL_MS` ("0" disables polling).
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

// Page size for `useActions` (unless overridden) and the infinite action hooks.
export const ACTIONS_PAGE_SIZE = 20;

// Query-shaping fields merged into the react-query options object, so
// `useActions('all', { enabled })` call sites need no separate params argument.
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
 * The FetchMyActionsQuery filter shape shared by the action hooks, without
 * `offset`: that is fixed for `useActions` and the page param for the infinite
 * hooks.
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

/**
 * Fetches the caller's actions with polling. `ownershipRole` selects
 * 'initiated' | 'received' | 'all'; the optional query fields scope and sort.
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
    // The endpoint requires a session; anonymous callers would 401 on every poll.
    enabled: isAuthenticated && (callerEnabled ?? true),
  });
}

/** Count of pending received actions, for the badge. Polls. */
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
    enabled: isAuthenticated,
  });
}

/** Updates one action's status and invalidates all action queries. */
export function useUpdateActionStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: UpdateActionStatusPayload) => {
      const response = await updateActionStatus(payload);
      return response;
    },
    onSuccess: () => {
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
    // `guardianOtp` (a minor resubmitting after GUARDIAN_OTP_REQUIRED) rides on
    // every payload so one code clears the whole batch.
    { payloads: UpdateActionStatusPayload[]; guardianOtp?: string }
  >({
    mutationFn: ({ payloads, guardianOtp }) => updateActionStatusBulk(payloads, guardianOtp),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: actionKeys.all });
    },
  });
}

/** Received actions, optionally filtered by status. Polls. */
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

/** Query-shaping params for `useReceivedActions`/`useInitiatedActions`. */
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
 * Shared infinite query for the received/initiated lists, scoped to one live
 * profile. With no `itemId` the query stays disabled (an empty list, never an
 * unscoped fetch). The key has no offset, so paging appends pages and a filter
 * change restarts at offset 0.
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
    // Polling refetches every loaded page.
    refetchInterval: POLLING_INTERVAL,
    refetchIntervalInBackground: false,
    staleTime: POLLING_INTERVAL === false ? Infinity : POLLING_INTERVAL,
    enabled: isAuthenticated && !!itemId,
  });
}

/** Initiated actions for `itemId` (the active live profile), paged. */
export function useInitiatedActions(
  itemId: string | null | undefined,
  params: UseOwnedActionsParams = {},
) {
  return useOwnedActionsInfinite('initiated', itemId, params);
}

/** Received actions for `itemId` (the active live profile), paged. */
export function useReceivedActions(
  itemId: string | null | undefined,
  params: UseOwnedActionsParams = {},
) {
  return useOwnedActionsInfinite('received', itemId, params);
}

/**
 * One page of the caller's sent and received actions, with filters and
 * `include` parts as the query says. Keeps the previous page on screen while
 * the next loads, so paging and filtering don't flash an empty table.
 */
export function useOwnedActionsPage(query: FetchMyActionsQuery, enabled = true) {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: actionKeys.list(query),
    queryFn: ({ signal }) => fetchMyActions(query, signal),
    placeholderData: keepPreviousData,
    refetchInterval: POLLING_INTERVAL,
    refetchIntervalInBackground: false,
    staleTime: POLLING_INTERVAL === false ? Infinity : POLLING_INTERVAL,
    enabled: isAuthenticated && enabled,
  });
}
