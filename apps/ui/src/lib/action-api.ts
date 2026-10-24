import axios from 'axios';
import { createApiClient } from './api-client';
import { unwrapBulkSingle, postBulkEnvelope, type BulkEnvelope } from './bulk';

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
  item_locations: Array<{ lat: number; lng: number; label?: string }>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ContactDetailsResponse {
  action_id: string;
  action_status: string;
  /** false → `item` is the masked pre-reveal view (a party is not live/paused). */
  revealed: boolean;
  /** When not revealed: `self` = viewer's own profile not live; `other` = counterparty's. */
  reveal_blocked_reason?: 'self' | 'other' | 'retired';
  other_actor: {
    item: ContactDetailsOtherActorItem;
  };
}

/** Error thrown by getActionContactDetails on a non-2xx response. */
export interface ContactDetailsError extends Error {
  status: number;
  code: ContactDetailsErrorCode;
}

const apiClient = createApiClient();

/**
 * Actions always go to the same-origin API: the session is an origin-scoped
 * cookie, so a request to the item's recorded `item_instance_url` would carry no
 * session and return 401. `POST /action/perform` needs the source item to be
 * local anyway; the API forwards cross-instance hops to the target instance over
 * the HMAC-signed peer route, since the browser holds no peer credential.
 */
function actionClient() {
  return apiClient;
}

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
 * Key ActionModal uses to pass the consent block through `onSubmit(formData)`
 * into the caller's PerformActionPayload (see action-modal.tsx and home-page.tsx).
 */
export const ACTION_CONSENT_SENTINEL = '__consent' as const;

/**
 * Body for `POST /api/v1/action/perform`. Use `performActionsBulk` for
 * `/api/v1/action/perform/bulk`.
 */
export interface PerformActionPayload {
  action_type: string;
  source_item: ItemRef;
  target_item: TargetItemRef;
  requirements_snapshot: Record<string, unknown>;
  consent?: { acknowledged: true; version: number; brand?: string | null };
}

export interface PerformActionResponse {
  action_id: string;
  action_type: string;
  action_status: string;
  update_count: number;
  source_item_id: string;
  target_item_id: string;
}

/** Body for `POST /api/v1/action/update-status` (target user's response). */
export interface UpdateActionStatusPayload {
  action_id: string;
  action_status: string;
  remarks?: string;
  consent?: { acknowledged: true; version: number; brand?: string | null };
}

export interface UpdateActionStatusResponse {
  action_id: string;
  action_type: string;
  action_status: string;
  update_count: number;
}

export interface FetchMyActionsQuery {
  action_id?: string;
  // One value or several (OR'd); the server normalizes both to an array.
  action_type?: string | string[];
  action_status?: string | string[];
  item_id?: string;
  /** Several of the caller's profiles; omitted = all of them. */
  item_ids?: string[];
  ownership_role?: 'all' | 'initiated' | 'received';
  /** Search on unmasked names only (see the server's `q`). */
  q?: string;
  /** Opt-in response parts. */
  include?: Array<'counts' | 'column_fields'>;
  // Server default is 'recent'.
  sort?: 'recent' | 'oldest' | 'match_score' | 'distance';
  // Non-PII item_state facet selections on the counterparty item (OR within a
  // field, AND across fields). `domain` limits a selection to that domain.
  facets?: Array<{ domain?: string; field: string; values: string[] }>;
  limit?: number;
  offset?: number;
}

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
  source_item_locations?: Array<{ lat: number; lng: number; label?: string }>;
  target_item_id: string;
  target_item_network: string;
  target_item_domain: string;
  target_item_type: string;
  target_item_owner: string | null;
  target_item_locations?: Array<{ lat: number; lng: number; label?: string }>;
  requirements_snapshot: Record<string, unknown>;
  // The actor's remark, or a system remark (e.g. the counterparty retired).
  remarks?: string | null;
  created_at: string;
  updated_at: string;
  ownership_roles: ('initiated' | 'received')[];
  // Resolved server-side from each item's display_name_field; falls back to the item id.
  source_item_name?: string | null;
  target_item_name?: string | null;
  // Null when not computed for this row (e.g. no location on one side for
  // distance, or the score service was not consulted).
  match_score?: number | null;
  distance_m?: number | null;
  /** `include=column_fields` only — non-private fields, no personal data. */
  counterparty?: {
    network: string;
    domain: string;
    item_type: string;
    column_fields: Record<string, unknown>;
  } | null;
}

/** `include=counts`: totals for the My Actions saved views. */
export interface OwnedActionCounts {
  all: number;
  needs_response: number;
  ready_to_export: number;
  sent: number;
}

export interface FetchMyActionsResponse {
  meta: {
    total: number;
    limit: number;
    offset: number;
    counts?: OwnedActionCounts;
  };
  actions: Action[];
}

/** Action event (status history). */
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
  source_item_locations?: Array<{ lat: number; lng: number; label?: string }>;
  target_item_id: string;
  target_item_network: string;
  target_item_domain: string;
  target_item_type: string;
  target_item_owner: string | null;
  target_item_locations?: Array<{ lat: number; lng: number; label?: string }>;
  event_payload: Record<string, unknown>;
  remarks: string | null;
  origin_instance_domain: string;
  created_at: string;
  ownership_roles: ('initiated' | 'received')[];
}

export interface FetchActionEventsResponse {
  meta: {
    total: number;
    limit: number;
    offset: number;
  };
  events: ActionEvent[];
}

export interface FetchActionEventsQuery {
  action_type: string;
  action_id: string;
  update_count?: number;
  limit?: number;
  offset?: number;
}

/**
 * Guardian-OTP error codes a bulk result entry's `error` can carry
 * (perform_action / update_action_status), so `action-modal` can branch on them.
 */
export type GuardianOtpErrorCode =
  | 'GUARDIAN_OTP_REQUIRED'
  | 'GUARDIAN_OTP_INVALID'
  | 'GUARDIAN_OTP_THROTTLED'
  | 'GUARDIAN_OTP_RATE_LIMITED'
  | 'OTP_PROVIDER_UNAVAILABLE';

const GUARDIAN_OTP_ERROR_CODES: readonly GuardianOtpErrorCode[] = [
  'GUARDIAN_OTP_REQUIRED',
  'GUARDIAN_OTP_INVALID',
  'GUARDIAN_OTP_THROTTLED',
  'GUARDIAN_OTP_RATE_LIMITED',
  'OTP_PROVIDER_UNAVAILABLE',
];

// The profile-consent guardian OTP routes (/u18/profile-consent/*) use different
// code strings; map them to the shared set so GuardianOtpDialog shows the right message.
const GUARDIAN_OTP_CODE_ALIASES: Record<string, GuardianOtpErrorCode> = {
  INVALID_OTP: 'GUARDIAN_OTP_INVALID',
  OTP_VERIFY_THROTTLED: 'GUARDIAN_OTP_THROTTLED',
  OTP_RATE_LIMITED: 'GUARDIAN_OTP_RATE_LIMITED',
  OTP_PROVIDER_UNAVAILABLE: 'OTP_PROVIDER_UNAVAILABLE',
};
/**
 * Classifies a bulk result entry's `error` as a `GuardianOtpErrorCode`, or
 * `null` if it is not one (including a success entry with no `error`).
 */
export function guardianOtpErrorOf(
  entry: { error?: string } | null | undefined,
): GuardianOtpErrorCode | null {
  const code = entry?.error;
  if (code === undefined) return null;
  if ((GUARDIAN_OTP_ERROR_CODES as readonly string[]).includes(code)) {
    return code as GuardianOtpErrorCode;
  }
  return GUARDIAN_OTP_CODE_ALIASES[code] ?? null;
}

/**
 * Classifies a thrown error as a `GuardianOtpErrorCode`, or `null`. Single-item
 * calls throw a `BulkSingleError` with the code on `.code`; a raw axios error
 * carries it on `response.data.error`.
 */
export function guardianOtpErrorFromThrown(err: unknown): GuardianOtpErrorCode | null {
  if (axios.isAxiosError(err)) {
    return guardianOtpErrorOf(err.response?.data as { error?: string } | undefined);
  }
  const code = (err as { code?: string } | null | undefined)?.code;
  return guardianOtpErrorOf({ error: code });
}

/**
 * Starts an action on the source item's instance, which forwards it to the target.
 *
 * @param _sourceInstanceUrl - Ignored; the action always goes to this origin
 *   (see `actionClient`).
 * @param guardianOtp - Guardian OTP to resubmit with after a
 *   `GUARDIAN_OTP_REQUIRED` per-item error. Sent as `guardian_otp`.
 */
export async function performAction(
  payload: PerformActionPayload,
  _sourceInstanceUrl?: string,
  guardianOtp?: string,
): Promise<PerformActionResponse> {
  const client = actionClient();

  const body = guardianOtp ? { ...payload, guardian_otp: guardianOtp } : payload;

  return unwrapBulkSingle(
    client.post<BulkEnvelope<PerformActionResponse>>('/api/v1/action/perform', body),
  );
}

/**
 * Target user's response to an action (accept, reject, complete).
 *
 * @param guardianOtp - Guardian OTP to resubmit with after a
 *   `GUARDIAN_OTP_REQUIRED` per-item error. Sent as `guardian_otp`.
 */
export async function updateActionStatus(
  payload: UpdateActionStatusPayload,
  guardianOtp?: string,
): Promise<UpdateActionStatusResponse> {
  const body = guardianOtp ? { ...payload, guardian_otp: guardianOtp } : payload;
  return unwrapBulkSingle(
    apiClient.post<BulkEnvelope<UpdateActionStatusResponse>>('/api/v1/action/update-status', [body]),
  );
}

/**
 * Performs several actions in one call to `/perform/bulk`. Returns the full
 * envelope so callers can surface partial success (207).
 */
export async function performActionsBulk(
  payloads: PerformActionPayload[],
  _sourceInstanceUrl?: string,
  guardianOtp?: string,
): Promise<BulkEnvelope<PerformActionResponse>> {
  const client = actionClient();
  const body = guardianOtp
    ? payloads.map((payload) => ({ ...payload, guardian_otp: guardianOtp }))
    : payloads;
  return postBulkEnvelope<PerformActionResponse>(
    client.post<BulkEnvelope<PerformActionResponse>>('/api/v1/action/perform/bulk', body),
  );
}

/**
 * Updates several action statuses in one call; all are on the caller's
 * instance. Returns the full envelope.
 */
export async function updateActionStatusBulk(
  payloads: UpdateActionStatusPayload[],
  guardianOtp?: string,
): Promise<BulkEnvelope<UpdateActionStatusResponse>> {
  const body = guardianOtp
    ? payloads.map((payload) => ({ ...payload, guardian_otp: guardianOtp }))
    : payloads;
  return postBulkEnvelope<UpdateActionStatusResponse>(
    // One guardian OTP on every payload clears a minor's whole batch.
    apiClient.post<BulkEnvelope<UpdateActionStatusResponse>>('/api/v1/action/update-status', body),
  );
}

/**
 * Appends a single-or-array param as repeated keys, which the server
 * normalizes to an array.
 */
function appendRepeated(params: URLSearchParams, key: string, value: string | string[] | undefined) {
  if (value === undefined) return;
  for (const v of Array.isArray(value) ? value : [value]) {
    params.append(key, v);
  }
}

/**
 * Appends `facets` in the `qs` bracket notation `/action/fetch` parses
 * (`facets[0][field]=..&facets[0][values][0]=..`) via `fastify-qs`. Do not
 * JSON-encode it: the query string parser would not read it.
 */
function appendFacets(params: URLSearchParams, facets: FetchMyActionsQuery['facets']) {
  if (!facets?.length) return;
  facets.forEach((facet, i) => {
    if (facet.domain) params.append(`facets[${i}][domain]`, facet.domain);
    params.append(`facets[${i}][field]`, facet.field);
    facet.values.forEach((v, j) => {
      params.append(`facets[${i}][values][${j}]`, v);
    });
  });
}

/** Fetches the caller's actions; `ownership_role` defaults to 'all'. */
export async function fetchMyActions(
  query: FetchMyActionsQuery = {},
  signal?: AbortSignal
): Promise<FetchMyActionsResponse> {
  const params = new URLSearchParams();

  params.set('ownership_role', query.ownership_role ?? 'all');

  if (query.action_id) params.set('action_id', query.action_id);
  appendRepeated(params, 'action_type', query.action_type);
  appendRepeated(params, 'action_status', query.action_status);
  if (query.item_id) params.set('item_id', query.item_id);
  appendRepeated(params, 'item_ids', query.item_ids);
  if (query.q?.trim()) params.set('q', query.q.trim());
  appendRepeated(params, 'include', query.include);
  if (query.sort) params.set('sort', query.sort);
  appendFacets(params, query.facets);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));

  const response = await apiClient.get<FetchMyActionsResponse>('/api/v1/action/fetch', {
    params,
    signal,
  });
  return response.data;
}

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
 * Contact details for the other party in an action. Succeeds only when the
 * action status has PII reveal enabled; throws a `ContactDetailsError` otherwise.
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
