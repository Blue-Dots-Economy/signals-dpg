import axios from 'axios';
import { createApiClient } from './api-client';
import { unwrapBulkSingle, postBulkEnvelope, type BulkEnvelope } from './bulk';
import { getAuthToken } from './auth-token';

// ─── Contact-details types ────────────────────────────────────────

export type ContactDetailsErrorCode =
  | 'UNAUTHORIZED'
  | 'ACTION_NOT_FOUND'
  | 'NOT_ACTION_PARTICIPANT'
  | 'PII_NOT_REVEALED'
  | 'CROSS_INSTANCE_REVEAL_NOT_SUPPORTED'
  | 'OTHER_ITEM_NOT_FOUND'
  | 'INTERNAL_SERVER_ERROR';

export interface ContactDetailsErrorBody {
  error: ContactDetailsErrorCode;
  message: string;
}

export interface ContactDetailsOtherActorItem {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_instance_url: string | null;
  item_schema_url: string | null;
  item_state: Record<string, unknown>;
  item_latitude: number | null;
  item_longitude: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ContactDetailsResponse {
  action_id: string;
  action_status: string;
  other_actor: {
    item: ContactDetailsOtherActorItem;
  };
}

/** Error thrown by getActionContactDetails on non-2xx responses */
export interface ContactDetailsError extends Error {
  status: number;
  code: ContactDetailsErrorCode;
}

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
 * Sentinel key used by ActionModal to smuggle the consent block through the
 * onSubmit(formData) signature into the parent's PerformActionPayload assembly
 * (see action-modal.tsx producer + home-page.tsx consumer).
 */
export const ACTION_CONSENT_SENTINEL = '__consent' as const;

/**
 * Payload for performing an action (initiated by source user)
 * Matches the actual API schema: POST /api/v1/action/perform
 */
export interface PerformActionPayload {
  action_type: string;
  source_item: ItemRef;
  target_item: TargetItemRef;
  requirements_snapshot: Record<string, unknown>;
  consent?: { acknowledged: true; text: string };
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
  consent?: { acknowledged: true; text: string };
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
  // Human-readable names resolved server-side from each item's
  // display_name_field (falls back to the item id when unavailable).
  source_item_name?: string | null;
  target_item_name?: string | null;
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

  return unwrapBulkSingle(
    client.post<BulkEnvelope<PerformActionResponse>>('/api/v1/action/perform', [payload]),
  );
}

/**
 * Update action status (target user response)
 * Target user calls this to accept, reject, or complete an action
 */
export async function updateActionStatus(
  payload: UpdateActionStatusPayload
): Promise<UpdateActionStatusResponse> {
  return unwrapBulkSingle(
    apiClient.post<BulkEnvelope<UpdateActionStatusResponse>>('/api/v1/action/update-status', [payload]),
  );
}

/**
 * Perform multiple actions in one bulk call. All payloads share the same source
 * instance (the source item's instance), so a single array POST is correct; the
 * backend loops per-item over the peer endpoint. Returns the full envelope so
 * callers can surface partial-success (207).
 */
export async function performActionsBulk(
  payloads: PerformActionPayload[],
  sourceInstanceUrl?: string,
): Promise<BulkEnvelope<PerformActionResponse>> {
  const client = sourceInstanceUrl
    ? createInstanceApiClient(sourceInstanceUrl)
    : apiClient;
  return postBulkEnvelope<PerformActionResponse>(
    client.post<BulkEnvelope<PerformActionResponse>>('/api/v1/action/perform', payloads),
  );
}

/**
 * Update multiple action statuses in one bulk call. All target actions are
 * self-owned and live on the caller's instance, so a single array POST is
 * correct. Returns the full envelope.
 */
export async function updateActionStatusBulk(
  payloads: UpdateActionStatusPayload[],
): Promise<BulkEnvelope<UpdateActionStatusResponse>> {
  return postBulkEnvelope<UpdateActionStatusResponse>(
    apiClient.post<BulkEnvelope<UpdateActionStatusResponse>>('/api/v1/action/update-status', payloads),
  );
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

/**
 * Fetch contact details for the other party in an accepted action.
 * Only succeeds when the action status has PII reveal enabled.
 *
 * @param actionId - The action UUID
 */
export async function getActionContactDetails(
  actionId: string
): Promise<ContactDetailsResponse> {
  try {
    const response = await apiClient.get<ContactDetailsResponse>(
      `/api/v1/action/${actionId}/contact-details`,
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
    return response.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const body = err.response.data as Partial<ContactDetailsErrorBody>;
      const message = body.message ?? `HTTP error ${err.response.status}`;
      const code: ContactDetailsErrorCode = body.error ?? 'INTERNAL_SERVER_ERROR';
      const typed = new Error(message) as ContactDetailsError;
      typed.status = err.response.status;
      typed.code = code;
      throw typed;
    }
    throw err;
  }
}
