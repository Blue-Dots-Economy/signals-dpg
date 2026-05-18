import axios from 'axios';
import { createApiClient } from './api-client';
import { getAuthToken } from './auth-token';

const apiClient = createApiClient();

/**
 * Create an API client for a specific instance URL
 */
function createInstanceApiClient(instanceUrl: string) {
  const client = axios.create({
    baseURL: instanceUrl,
    withCredentials: true,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  client.interceptors.request.use((config) => {
    const token = getAuthToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  return client;
}

// ─── Types ───────────────────────────────────────────────────────

export interface ItemRef {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
}

export interface TargetItemRef extends ItemRef {
  item_instance_url: string;
}

/**
 * Payload for performing an action (initiated by source user)
 * Matches the actual API schema: POST /api/v1/action/perform
 */
export interface PerformActionPayload {
  action_type: string;
  source_item: ItemRef;
  target_item: TargetItemRef;
  requirements_snapshot: Record<string, unknown>;
}

/**
 * Response from perform action API
 */
export interface PerformActionResponse {
  action_id: string;
  action_type: string;
  action_status: string;
  update_count: number;
  source_item_id: string;
  target_item_id: string;
}

/**
 * Payload for updating action status (target user response)
 * Matches the actual API schema: POST /api/v1/action/update-status
 */
export interface UpdateActionStatusPayload {
  action_id: string;
  action_status: string;
  remarks?: string;
}

/**
 * Response from update action status API
 */
export interface UpdateActionStatusResponse {
  action_id: string;
  action_type: string;
  action_status: string;
  update_count: number;
}

/**
 * Query parameters for fetching actions
 */
export interface FetchMyActionsQuery {
  action_id?: string;
  action_type?: string;
  action_status?: string;
  item_id?: string;
  ownership_role?: 'all' | 'initiated' | 'received';
  limit?: number;
  offset?: number;
}

/**
 * Action with ownership roles returned from API
 */
export interface Action {
  action_id: string;
  action_type: string;
  action_status: string;
  update_count: number;
  source_item_id: string;
  source_item_network: string;
  source_item_domain: string;
  source_item_type: string;
  source_item_owner: string | null;
  source_item_latitude: number | null | undefined;
  source_item_longitude: number | null | undefined;
  target_item_id: string;
  target_item_network: string;
  target_item_domain: string;
  target_item_type: string;
  target_item_owner: string | null;
  target_item_latitude: number | null | undefined;
  target_item_longitude: number | null | undefined;
  requirements_snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  ownership_roles: ('initiated' | 'received')[];
}

/**
 * Response from fetch actions API
 */
export interface FetchMyActionsResponse {
  meta: {
    total: number;
    limit: number;
    offset: number;
  };
  actions: Action[];
}

/**
 * Action event (status history)
 */
export interface ActionEvent {
  event_id: string;
  action_type: string;
  action_id: string;
  update_count: number;
  action_status: string;
  source_item_id: string;
  source_item_network: string;
  source_item_domain: string;
  source_item_type: string;
  source_item_owner: string | null;
  source_item_latitude: number | null;
  source_item_longitude: number | null;
  target_item_id: string;
  target_item_network: string;
  target_item_domain: string;
  target_item_type: string;
  target_item_owner: string | null;
  target_item_latitude: number | null;
  target_item_longitude: number | null;
  event_payload: Record<string, unknown>;
  remarks: string | null;
  origin_instance_domain: string;
  created_at: string;
  ownership_roles: ('initiated' | 'received')[];
}

/**
 * Response from fetch action events API
 */
export interface FetchActionEventsResponse {
  meta: {
    total: number;
    limit: number;
    offset: number;
  };
  events: ActionEvent[];
}

/**
 * Query parameters for fetching action events
 */
export interface FetchActionEventsQuery {
  action_type: string;
  action_id: string;
  update_count?: number;
  limit?: number;
  offset?: number;
}

// ─── API Functions ────────────────────────────────────────────────

/**
 * Perform an action (initiate cross-instance action)
 * Source user calls this to start an action with a target item
 * 
 * Note: This MUST be called on the SOURCE instance (where source item exists).
 * The source instance validates the source item exists, then forwards to target.
 * 
 * @param payload - The action payload
 * @param sourceInstanceUrl - Optional: URL of the source instance. 
 *   If not provided, uses default API. Should be the instance where source item exists.
 */
export async function performAction(
  payload: PerformActionPayload,
  sourceInstanceUrl?: string
): Promise<PerformActionResponse> {
  // Use source instance URL if provided, otherwise fall back to default API client
  const client = sourceInstanceUrl 
    ? createInstanceApiClient(sourceInstanceUrl)
    : apiClient;
    
  const response = await client.post<PerformActionResponse>(
    '/api/v1/action/perform',
    payload
  );
  return response.data;
}

/**
 * Update action status (target user response)
 * Target user calls this to accept, reject, or complete an action
 */
export async function updateActionStatus(
  payload: UpdateActionStatusPayload
): Promise<UpdateActionStatusResponse> {
  const response = await apiClient.post<UpdateActionStatusResponse>(
    '/api/v1/action/update-status',
    payload
  );
  return response.data;
}

/**
 * Fetch my actions with filtering and pagination
 * Use ownership_role to filter: 'initiated' | 'received' | 'all'
 */
export async function fetchMyActions(
  query: FetchMyActionsQuery = {},
  signal?: AbortSignal
): Promise<FetchMyActionsResponse> {
  const params = new URLSearchParams();

  // Always set ownership_role, default to 'all'
  params.set('ownership_role', query.ownership_role ?? 'all');

  if (query.action_id) params.set('action_id', query.action_id);
  if (query.action_type) params.set('action_type', query.action_type);
  if (query.action_status) params.set('action_status', query.action_status);
  if (query.item_id) params.set('item_id', query.item_id);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));

  const response = await apiClient.get<FetchMyActionsResponse>('/api/v1/action/fetch', {
    params,
    signal,
  });
  return response.data;
}

/**
 * Fetch events/history for a specific action
 */
export async function fetchActionEvents(
  query: FetchActionEventsQuery,
  signal?: AbortSignal
): Promise<FetchActionEventsResponse> {
  const params = new URLSearchParams();

  params.set('action_type', query.action_type);
  params.set('action_id', query.action_id);
  if (query.update_count !== undefined) {
    params.set('update_count', String(query.update_count));
  }
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));

  const response = await apiClient.get<FetchActionEventsResponse>('/api/v1/action/fetch-events', {
    params,
    signal,
  });
  return response.data;
}
