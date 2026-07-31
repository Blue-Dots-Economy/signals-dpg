import { createMatchScoreClient } from '@dpg/match_score';
import { matchScoreConfig } from '@/config';

export const getMatchScoreClient = () => {
  switch (matchScoreConfig.provider) {
    case 'signals_search': {
      const signalsSearch = matchScoreConfig.signals_search;

      if (!signalsSearch.endpoint || !signalsSearch.api_key) {
        return undefined;
      }

      return createMatchScoreClient({
        provider: 'signals_search',
        baseUrl: signalsSearch.endpoint,
        apiKey: signalsSearch.api_key,
        path: signalsSearch.path,
      });
    }

    default:
      return undefined;
  }
};
