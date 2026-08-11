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
  signals?: Array<{
    name: string;
    impact: string;
    summary: string;
  }>;
  raw_response: unknown;
}

export interface MatchScoreClient {
  calculate(input: MatchScoreRequest): Promise<MatchScoreResult>;
}

export type MatchScoreProvider = 'signals_search';

// signals-search's in-network relevance API (POST /v1/relevance). Authenticated
// with a single x-api-key (validated against Signals' own apikey store).
// `path` overrides the default 'v1/relevance'.
export interface SignalsSearchClientConfig {
  baseUrl: string;
  apiKey: string;
  path?: string;
}

export type MatchScoreClientConfig = {
  provider: 'signals_search';
} & SignalsSearchClientConfig;
