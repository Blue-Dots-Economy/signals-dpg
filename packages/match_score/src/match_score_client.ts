import { SignalsSearchClient } from './providers/signals_search/client';
import type { MatchScoreClient, MatchScoreClientConfig } from './match_score.types';

export function createMatchScoreClient(
  config: MatchScoreClientConfig
): MatchScoreClient {
  switch (config.provider) {
    case 'signals_search':
      return new SignalsSearchClient(config);
  }
}
