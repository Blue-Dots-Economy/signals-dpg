export interface MatchScoreItem {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
  item_instance_url: string;
  item_schema_url: string;
  item_state: Record<string, unknown>;
  item_latitude?: number | null;
  item_longitude?: number | null;
}

export interface MatchScoreRequest {
  itemA: MatchScoreItem;
  itemB: MatchScoreItem;
}

/**
 * Result of one match-score call. /v1/relevance answers 404 (an item is not
 * indexed yet, common because indexing is async) and 409 (embedded with
 * different model versions); both are expected states, reported via
 * `unavailable_reason` rather than as errors.
 */
export interface MatchScoreResult {
  provider: string;
  /** 0-100. */
  score?: number;
  version?: string;
  /** Why no score is available, for the two expected non-outage states. */
  unavailable_reason?: 'not_indexed' | 'not_comparable';
  raw_response: unknown;
}

export interface MatchScoreClient {
  calculate(input: MatchScoreRequest): Promise<MatchScoreResult>;
}

export type MatchScoreProvider = 'signals_search';

// signals-search's relevance API (POST /v1/relevance), authenticated with an
// x-api-key from the shared Signals apikey store. `path` overrides
// 'v1/relevance'.
export interface SignalsSearchClientConfig {
  baseUrl: string;
  apiKey: string;
  path?: string;
}

export type MatchScoreClientConfig = {
  provider: 'signals_search';
} & SignalsSearchClientConfig;
