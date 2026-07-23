import { test, expect } from '../../src/fixtures.js';
import { getRoot, resolveBinding } from '../../src/schema.js';

/**
 * Target readiness gate. The `api` and `ui` projects depend on this project, so
 * if the target is unreachable or misconfigured the whole run fails fast here
 * with a clear message instead of confusing mid-journey errors.
 */
test.describe('Preflight — target readiness', () => {
  test('root endpoint is live and serves domains', async ({ api, cfg }) => {
    const root = await getRoot(api);
    expect(root.status, 'GET / status should be "ok"').toBe('ok');
    expect(root.served_domains.length, 'target must serve at least one domain').toBeGreaterThan(0);

    const servedNetworks = new Set(root.served_domains.map((s) => s.network));
    expect(
      servedNetworks.has(cfg.network),
      `configured network "${cfg.network}" not served by target (serves: ${[...servedNetworks].join(', ')})`,
    ).toBeTruthy();
  });

  test('auth config is reachable and matches the declared signup mode', async ({ api, cfg }) => {
    const res = await api.get<{ selfSignupAllowed: boolean; loginChannels: string[] }>('/api/v1/auth/config');
    // Optional endpoint: some targets predate GET /api/v1/auth/config. Don't fail
    // the whole run on it — report and skip the mode-match assertion.
    test.skip(res.status === 404, 'target predates GET /api/v1/auth/config (cannot verify signup mode)');
    expect(res.status).toBe(200);
    expect(typeof res.body.selfSignupAllowed).toBe('boolean');
    expect(Array.isArray(res.body.loginChannels)).toBeTruthy();

    const liveMode = res.body.selfSignupAllowed ? 'allowed' : 'gated';
    expect(
      liveMode,
      `config selfSignupMode="${cfg.selfSignupMode}" but target reports "${liveMode}". Fix the config to match the running target.`,
    ).toBe(cfg.selfSignupMode);
  });

  test('a network schema resolves for the first served domain (schema sanity)', async ({ api, cfg }) => {
    const binding = await resolveBinding(api, cfg.servedDomains[0]);
    expect(binding.item_type, 'resolved item_type should be non-empty').toBeTruthy();
    expect(binding.schema, 'resolved schema should be present').toBeTruthy();
  });
});
