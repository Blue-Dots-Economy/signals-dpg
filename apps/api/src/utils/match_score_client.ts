import { createMatchScoreClient } from '@dpg/match_score';
import { matchScoreConfig } from '@/config';

export const getMatchScoreClient = () => {
  switch (matchScoreConfig.provider) {
    case 'dpg_scoring': {
      const dpgScoring = matchScoreConfig.dpg_scoring;

      if (!dpgScoring.endpoint || !dpgScoring.key_id || !dpgScoring.secret) {
        return undefined;
      }

      return createMatchScoreClient({
        provider: 'dpg_scoring',
        baseUrl: dpgScoring.endpoint,
        keyId: dpgScoring.key_id,
        secret: dpgScoring.secret,
        path: dpgScoring.path,
        version: dpgScoring.version,
        promptVersion: dpgScoring.prompt_version,
      });
    }

    default:
      return undefined;
  }
};
