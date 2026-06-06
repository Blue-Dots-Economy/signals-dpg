import { createApiClient } from './api-client';

export type LifecycleStatus = 'draft' | 'live' | 'paused';

export interface ItemLifecyclePayload {
  item_id: string;
  action: 'pause' | 'unpause';
}

export interface ItemLifecycleResponse {
  item_id: string;
  lifecycle_status: LifecycleStatus;
  completion_pct: number;
  cancelled_pending_actions: number;
}

const apiClient = createApiClient();

/**
 * POST /api/v1/item/lifecycle — owner or network_service may pause /
 * unpause a profile item. Pause is sticky; unpause recomputes via the
 * classifier from the current item_state.
 *
 * Returns the new lifecycle status, refreshed completion_pct, and the
 * count of pending actions that were auto-cancelled by the transition
 * (used by the UI to show a "cancelled N requests" toast).
 */
export async function setItemLifecycle(
  payload: ItemLifecyclePayload,
): Promise<ItemLifecycleResponse> {
  const res = await apiClient.post<ItemLifecycleResponse>(
    '/api/v1/item/lifecycle',
    payload,
  );
  return res.data;
}
