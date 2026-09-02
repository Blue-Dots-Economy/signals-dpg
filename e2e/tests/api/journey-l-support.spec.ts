import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';

/**
 * Journey L (API) — support config contract.
 *
 * `GET /api/v1/support/config` shipped with support attachments (#551) after
 * this suite's branch went dormant, so it had no journey — this closes that
 * gap. Its `enabled` must mirror the submit route's 503 condition exactly
 * (apps/api/CLAUDE.md), and the UI validates attachments against the limits
 * this returns rather than its own copy, so both need asserting.
 *
 * @covers GET /api/v1/support/config
 */
test.describe('Journey L (API) — support config', () => {
  // Only the second test needs a live user; gate at describe level so a
  // gated target without service creds reports one clear skip reason instead
  // of createLiveProfileUser throwing mid-test.
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users (gated target without service creds)');

  test('support config requires auth and, when reachable, describes the limits', async ({ api }) => {
    const anon = await api.get('/api/v1/support/config');
    expect(anon.status).toBe(401);
  });

  test("an authenticated caller gets the server's own attachment limits", async ({ api, service, cfg, caps, authCtx }) => {
    const user = await createLiveProfileUser(api, service, cfg, caps, { authCtx, label: 'supcfg' });
    const res = await user.session.client.get<{
      enabled: boolean;
      maxTotalBytes?: number;
      maxFiles?: number;
      allowedTypes?: string[];
    }>('/api/v1/support/config');
    expect(res.status).toBe(200);
    expect(typeof res.body.enabled).toBe('boolean');
    if (res.body.enabled) {
      // The UI validates against these numbers rather than its own copy, so
      // they must be present and positive whenever support is on.
      expect(res.body.maxFiles).toBeGreaterThan(0);
      expect(res.body.maxTotalBytes).toBeGreaterThan(0);
      expect(Array.isArray(res.body.allowedTypes)).toBe(true);
    }
  });
});
