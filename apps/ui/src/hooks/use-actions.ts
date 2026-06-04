import {
  useQuery,
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

// ─── Query Keys ───────────────────────────────────────────────────

export const actionKeys = {
  all: ['actions'] as const,
  lists: () => [...actionKeys.all, 'list'] as const,
  list: (filters: FetchMyActionsQuery) =>
    [...actionKeys.lists(), filters] as const,
  details: () => [...actionKeys.all, 'detail'] as const,
  detail: (actionId: string) => [...actionKeys.details(), actionId] as const,
  pendingCount: () => [...actionKeys.all, 'pendingCount'] as const,
};

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
const DEFAULT_POLLING_INTERVAL = 30000;

function resolvePollingInterval(): number | false {
  const raw = import.meta.env.VITE_ACTION_POLL_INTERVAL_MS;
  if (raw === undefined || raw === '') return DEFAULT_POLLING_INTERVAL;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_POLLING_INTERVAL;
  if (parsed === 0) return false; // false disables polling in react-query
  return parsed;
}

const POLLING_INTERVAL = resolvePollingInterval();

// ─── Hooks ────────────────────────────────────────────────────────

/**
 * Hook to fetch actions with auto-polling every 5 seconds
 * Use ownershipRole to filter: 'initiated' | 'received' | 'all'
 */
export function useActions(
  ownershipRole: 'initiated' | 'received' | 'all' = 'all',
  options: Omit<
    UseQueryOptions<{ actions: Action[]; meta: { total: number } }, Error>,
    'queryKey' | 'queryFn'
  > = {}
) {
  const query: FetchMyActionsQuery = {
    ownership_role: ownershipRole,
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
    refetchIntervalInBackground: false, // Stop polling when tab is hidden
    staleTime: POLLING_INTERVAL === false ? Infinity : POLLING_INTERVAL,
    ...options,
  });
}

/**
 * Hook to get count of pending received actions for badge
 * Auto-polls every 5 seconds
 */
export function usePendingActionsCount() {
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

  return useMutation<BulkEnvelope<UpdateActionStatusResponse>, Error, UpdateActionStatusPayload[]>({
    mutationFn: (payloads) => updateActionStatusBulk(payloads),
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
    ...options,
  });
}

/**
 * Hook to get initiated actions
 */
export function useInitiatedActions(
  options: Omit<
    UseQueryOptions<{ actions: Action[]; meta: { total: number } }, Error>,
    'queryKey' | 'queryFn'
  > = {}
) {
  return useActions('initiated', options);
}

/**
 * Hook to get received actions
 */
export function useReceivedActions(
  options: Omit<
    UseQueryOptions<{ actions: Action[]; meta: { total: number } }, Error>,
    'queryKey' | 'queryFn'
  > = {}
) {
  return useActions('received', options);
}
