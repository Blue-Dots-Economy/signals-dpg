import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';

/**
 * Journey G (API) — PII at rest: masking & non-leakage (P0).
 * Guards: private fields are returned REAL to the owner but MASKED to strangers ·
 * the encrypted `item_private_state` blob never appears in any response · a
 * stranger read stays masked even after the owner self-read (no decrypted leak).
 *
 * DB-level assertions (ciphertext `v1:` prefix, exact jitter coordinates) require
 * a Postgres driver in the harness and are intentionally out of scope here — the
 * observable masking + non-leakage above are the release-gating invariants.
 */
test.describe('Journey G — PII masking & non-leakage', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP on the target');

  test('private fields are real to the owner, masked to strangers; private_state never leaks', async ({ api, service, cfg, caps }) => {
    const owner = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[0], label: 'pii' });
    const { network, domain, item_type } = owner.binding;

    // pick a private field that was set (seeker's name/phone/location are private)
    const privateKeys = ['name', 'phone', 'location'].filter((k) => owner.itemState[k] !== undefined);
    expect(privateKeys.length, 'expected at least one private field in the profile').toBeGreaterThan(0);

    // OWNER self-fetch (/item/fetch always decrypts own items) → real values
    const selfRes = await owner.session.client.get<{ items: Array<{ item_id: string; item_state: Record<string, unknown> }> }>(
      `/api/v1/item/fetch?item_network=${network}&item_domain=${domain}&item_type=${item_type}&item_id=${owner.itemId}&limit=10`,
    );
    const selfItem = selfRes.body.items.find((i) => i.item_id === owner.itemId);
    expect(selfItem, 'owner sees own item').toBeTruthy();
    for (const k of privateKeys) {
      expect(selfItem!.item_state[k], `owner sees real ${k}`).toBe(owner.itemState[k]);
    }
    expect(JSON.stringify(selfRes.body), 'no item_private_state in self response').not.toContain('item_private_state');

    // STRANGER network-fetch → masked (fresh, cache-busted)
    const bust = 300 + (Date.now() % 100000);
    const net = await api.get<{ items: Array<{ item_id: string; item_state: Record<string, unknown> }> }>(
      `/api/v1/network/item/fetch?item_network=${network}&item_domain=${domain}&item_type=${item_type}&limit=200&cache_ttl_seconds=${bust}`,
    );
    const strangerItem = net.body.items.find((i) => i.item_id === owner.itemId);
    expect(strangerItem, 'live item is discoverable to strangers').toBeTruthy();
    for (const k of privateKeys) {
      expect(strangerItem!.item_state[k], `stranger sees masked (not real) ${k}`).not.toBe(owner.itemState[k]);
    }
    expect(JSON.stringify(net.body), 'no item_private_state in network response').not.toContain('item_private_state');
  });

  test('a stranger read stays masked even after the owner has self-read (cache isolation)', async ({ api, service, cfg, caps }) => {
    const owner = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[0], label: 'piic' });
    const { network, domain, item_type } = owner.binding;
    const key = ['name', 'phone', 'location'].find((k) => owner.itemState[k] !== undefined)!;

    // owner reads first (populates the decrypted local-fetch cache)
    await owner.session.client.get(`/api/v1/item/fetch?item_network=${network}&item_domain=${domain}&item_type=${item_type}&item_id=${owner.itemId}&limit=10`);

    // stranger read must NOT return the owner's decrypted value
    const bust = 300 + (Date.now() % 100000);
    const net = await api.get<{ items: Array<{ item_id: string; item_state: Record<string, unknown> }> }>(
      `/api/v1/network/item/fetch?item_network=${network}&item_domain=${domain}&item_type=${item_type}&limit=200&cache_ttl_seconds=${bust}`,
    );
    const strangerItem = net.body.items.find((i) => i.item_id === owner.itemId);
    expect(strangerItem?.item_state[key], 'stranger never gets the owner-decrypted value').not.toBe(owner.itemState[key]);
  });

  test('a protected route rejects unauthenticated access', async ({ api }) => {
    // /item/fetch requires auth — no bearer, no apikey
    const res = await api.get('/api/v1/item/fetch?item_network=blue_dot&item_domain=seeker');
    expect([401, 403], `unauthenticated must be rejected, got ${res.status}`).toContain(res.status);
  });
});
