import type {
  MatchScoreClient,
  MatchScoreItem,
  MatchScoreRequest,
  MatchScoreResult,
  SignalsSearchClientConfig,
} from '../../match_score.types';

const DEFAULT_RELEVANCE_PATH = 'v1/relevance';

// /v1/relevance takes only each item's composite key (without the item_
// prefix) and scores from the indexed embeddings, so item_state and
// coordinates are not sent.
function toRef(item: MatchScoreItem) {
  return {
    network: item.item_network,
    domain: item.item_domain,
    type: item.item_type,
    id: item.item_id,
  };
}

export class SignalsSearchClient implements MatchScoreClient {
  constructor(private readonly config: SignalsSearchClientConfig) {}

  async calculate(input: MatchScoreRequest): Promise<MatchScoreResult> {
    const path = this.config.path ?? DEFAULT_RELEVANCE_PATH;
    const url = new URL(path, this.config.baseUrl);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
      },
      body: JSON.stringify({
        source: toRef(input.itemA),
        target: toRef(input.itemB),
      }),
    });

    const rawText = await response.text();
    const rawResponse = tryParseJson(rawText);

    if (!response.ok) {
      // 404 (an item not live and indexed yet, common right after creation
      // because indexing is async) and 409 (different embedding model
      // versions) are expected states, returned as a scoreless result. Any
      // other status throws, and the handler maps it to 502.
      if (response.status === 404 || response.status === 409) {
        return {
          provider: 'signals_search',
          score: undefined,
          unavailable_reason: response.status === 404 ? 'not_indexed' : 'not_comparable',
          raw_response: rawResponse,
        };
      }
      throw new Error(
        `Match score service error ${response.status}: ${rawText || response.statusText}`
      );
    }

    const percentage = extractNumeric(rawResponse, ['score']);

    return {
      provider: 'signals_search',
      // signals-search already emits 0-100; passed through unscaled.
      score: percentage,
      raw_response: rawResponse,
    };
  }
}

function tryParseJson(input: string): unknown {
  if (!input) {
    return null;
  }

  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function extractNumeric(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
