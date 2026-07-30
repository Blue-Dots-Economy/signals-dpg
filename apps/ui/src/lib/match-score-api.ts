import { createApiClient } from './api-client';
import type { Item } from './item-api';

const apiClient = createApiClient();

export interface ItemSnapshot {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_instance_url: string | null;
  item_schema_url: string | null;
  item_state: Record<string, unknown>;
  item_latitude: number | null;
  item_longitude: number | null;
}

export interface MatchScoreSignal {
  name: string;
  impact: string;
  summary: string;
}

export interface MatchScoreResult {
  provider: string;
  score?: number;
  band?: string;
  confidence?: number;
  version?: string;
  prompt_version?: string;
  model_provider?: string;
  model?: string;
  reasoning?: string;
  signals?: MatchScoreSignal[];
  raw_response?: unknown;
  // #394: set only on the value `useMatchScore` seeds from the discover
  // response's `Item.score` (see `item-api.ts`), before any click hits
  // `/api/v1/match-score/calculate` — distinguishes "upfront, no confidence/
  // signals/reasoning yet" from a real `/v1/relevance` result, which never
  // sets this field.
  source?: 'discover';
}

export interface CalculateMatchScorePayload {
  itemA: ItemSnapshot;
  itemB: ItemSnapshot;
}

export interface MatchScoreError {
  error: string;
  message: string;
}

export function itemToSnapshot(item: Item): ItemSnapshot {
  const primary = item.item_locations?.[0] ?? null;
  return {
    item_id: item.item_id,
    item_network: item.item_network,
    item_domain: item.item_domain,
    item_type: item.item_type,
    item_instance_url: item.item_instance_url,
    item_schema_url: item.item_schema_url,
    item_state: item.item_state,
    item_latitude: primary ? primary.lat : null,
    item_longitude: primary ? primary.lng : null,
  };
}

export async function calculateMatchScore(
  payload: CalculateMatchScorePayload
): Promise<MatchScoreResult> {
  const response = await apiClient.post<MatchScoreResult>(
    '/api/v1/match-score/calculate',
    payload
  );
  return response.data;
}
