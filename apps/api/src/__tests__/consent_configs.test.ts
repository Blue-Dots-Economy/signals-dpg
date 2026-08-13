import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
const { loadConsentConfigs } = vi.hoisted(() => ({
  loadConsentConfigs: vi.fn(),
}));

vi.mock('@dpg/config', () => ({
  loadConsentConfigs: (...a: unknown[]) => loadConsentConfigs(...a),
}));

vi.mock('@/config', () => ({
  apiConfig: {
    // blue_dot appears twice: the loader must de-duplicate networks.
    served_domains: [
      { key: 'blue_dot/seeker', network: 'blue_dot', domain: 'seeker' },
      { key: 'blue_dot/provider', network: 'blue_dot', domain: 'provider' },
      { key: 'yellow_dot/student', network: 'yellow_dot', domain: 'student' },
    ],
    consent_config_source: 'local',
    network_config_local_file: '/tmp/network.json',
    consent_support_email: 'help@example.org',
  },
}));

describe('consent_configs', () => {
  beforeEach(() => {
    // The module memoises its promise at module scope, so each test needs a
    // fresh module registry to observe the caching behaviour independently.
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('loads the consent configs with de-duplicated served networks', async () => {
    loadConsentConfigs.mockResolvedValue([{ network: 'blue_dot' }]);
    const { getConsentConfigs } = await import('../consent_configs');

    await expect(getConsentConfigs()).resolves.toEqual([
      { network: 'blue_dot' },
    ]);
    expect(loadConsentConfigs).toHaveBeenCalledWith({
      source: 'local',
      networkLocalFile: '/tmp/network.json',
      networks: ['blue_dot', 'yellow_dot'],
      supportEmail: 'help@example.org',
    });
  });

  it('memoises the load — repeated calls hit the loader once', async () => {
    loadConsentConfigs.mockResolvedValue([]);
    const { getConsentConfigs } = await import('../consent_configs');

    await getConsentConfigs();
    await getConsentConfigs();
    await getConsentConfigs();

    expect(loadConsentConfigs).toHaveBeenCalledTimes(1);
  });

  it('hands back the same resolved array instance to every caller', async () => {
    // The function is `async`, so each call returns a fresh promise wrapper —
    // but they all settle to the one memoised value, which is what callers
    // actually share.
    loadConsentConfigs.mockResolvedValue([{ network: 'blue_dot' }]);
    const { getConsentConfigs } = await import('../consent_configs');

    const [a, b] = await Promise.all([
      getConsentConfigs(),
      getConsentConfigs(),
    ]);

    expect(a).toBe(b);
    expect(loadConsentConfigs).toHaveBeenCalledTimes(1);
  });

  it('refreshConsentConfigs re-loads even though the value was memoised', async () => {
    loadConsentConfigs.mockResolvedValue([{ network: 'blue_dot' }]);
    const { getConsentConfigs, refreshConsentConfigs } = await import(
      '../consent_configs'
    );

    await getConsentConfigs();
    expect(loadConsentConfigs).toHaveBeenCalledTimes(1);

    loadConsentConfigs.mockResolvedValue([{ network: 'refreshed' }]);
    await expect(refreshConsentConfigs()).resolves.toEqual([
      { network: 'refreshed' },
    ]);
    expect(loadConsentConfigs).toHaveBeenCalledTimes(2);
  });

  it('a refresh replaces the memoised value seen by later getConsentConfigs calls', async () => {
    loadConsentConfigs.mockResolvedValue([{ network: 'first' }]);
    const { getConsentConfigs, refreshConsentConfigs } = await import(
      '../consent_configs'
    );

    await getConsentConfigs();
    loadConsentConfigs.mockResolvedValue([{ network: 'second' }]);
    await refreshConsentConfigs();

    await expect(getConsentConfigs()).resolves.toEqual([{ network: 'second' }]);
    // Still 2 — the post-refresh get is served from the new memoised promise.
    expect(loadConsentConfigs).toHaveBeenCalledTimes(2);
  });
});
