import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
const { createMatchScoreClient, matchScoreConfig } = vi.hoisted(() => ({
  createMatchScoreClient: vi.fn(),
  matchScoreConfig: {
    provider: 'signals_search',
    signals_search: {
      endpoint: 'https://search.local',
      api_key: 'k',
      path: '/match',
    },
  } as {
    provider: string;
    signals_search: { endpoint?: string; api_key?: string; path?: string };
  },
}));

vi.mock('@dpg/match_score', () => ({
  createMatchScoreClient: (...a: unknown[]) => createMatchScoreClient(...a),
}));

vi.mock('@/config', () => ({ matchScoreConfig }));

import { getMatchScoreClient } from '../match_score_client';

describe('getMatchScoreClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    matchScoreConfig.provider = 'signals_search';
    matchScoreConfig.signals_search = {
      endpoint: 'https://search.local',
      api_key: 'k',
      path: '/match',
    };
  });

  it('builds a signals_search client from the configured endpoint/key/path', () => {
    createMatchScoreClient.mockReturnValue({ client: true });

    const client = getMatchScoreClient();

    expect(client).toEqual({ client: true });
    expect(createMatchScoreClient).toHaveBeenCalledWith({
      provider: 'signals_search',
      baseUrl: 'https://search.local',
      apiKey: 'k',
      path: '/match',
    });
  });

  it('returns undefined when the endpoint is unset (fail-soft, no client)', () => {
    matchScoreConfig.signals_search.endpoint = undefined;

    expect(getMatchScoreClient()).toBeUndefined();
    expect(createMatchScoreClient).not.toHaveBeenCalled();
  });

  it('returns undefined when the api key is unset', () => {
    matchScoreConfig.signals_search.api_key = undefined;

    expect(getMatchScoreClient()).toBeUndefined();
    expect(createMatchScoreClient).not.toHaveBeenCalled();
  });

  it('returns undefined for an unrecognised provider', () => {
    matchScoreConfig.provider = 'something_else';

    expect(getMatchScoreClient()).toBeUndefined();
    expect(createMatchScoreClient).not.toHaveBeenCalled();
  });

  it('passes an undefined path through rather than defaulting it here', () => {
    matchScoreConfig.signals_search.path = undefined;
    createMatchScoreClient.mockReturnValue({ client: true });

    getMatchScoreClient();

    expect(createMatchScoreClient).toHaveBeenCalledWith(
      expect.objectContaining({ path: undefined }),
    );
  });
});
