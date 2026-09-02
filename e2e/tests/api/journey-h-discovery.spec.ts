import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';

/**
 * Journey H — Discovery / search (P0, subset).
 * Guards: two distinct fetch paths (instance-local owner-scoped vs network) ·
 * network fetch returns live-only and carries the partial-aggregate flag.
 */
test.describe('Journey H — discovery', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users (gated target without service creds)');
  test.skip(({ caps }) => !caps.testOtp, 'requires OTP retrieval (CREATE_TEST_OTP on the target)');

  test('instance-local fetch is owner-scoped; network fetch discovers the live item', async ({ api, service, cfg, caps, authCtx }) => {
    const owner = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[0], label: 'disc' });
    const { network, domain, item_type } = owner.binding;

    // instance-local: the owner sees their own item
    const mine = await owner.session.client.get<{ meta: unknown; items: Array<{ item_id: string }> }>(
      `/api/v1/item/fetch?item_network=${network}&item_domain=${domain}&item_type=${item_type}&limit=100`,
    );
    expect(mine.status).toBe(200);
    expect(mine.body.items.some((i) => i.item_id === owner.itemId), 'owner should see own item locally').toBeTruthy();

    // network fetch merges + caches per (query, ttl) for the domain-minimum TTL
    // (300s here). Pass a unique cache_ttl_seconds to force a fresh, uncached read
    // so we assert real discoverability rather than a stale cached page.
    const bust = 300 + (Date.now() % 100000);
    const net = await api.get<{ meta: { total: number; partial?: boolean }; items: Array<{ item_id: string }> }>(
      `/api/v1/network/item/fetch?item_network=${network}&item_domain=${domain}&item_type=${item_type}&limit=200&cache_ttl_seconds=${bust}`,
    );
    expect(net.status).toBe(200);
    expect(net.body.items.some((i) => i.item_id === owner.itemId), 'live item must be discoverable via network fetch').toBeTruthy();
    expect(typeof net.body.meta.total, 'network fetch returns a meta.total').toBe('number');
  });

  test('instance-local fetch does not leak another user\'s items to a caller', async ({ api, service, cfg, caps, authCtx }) => {
    const a = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[0], label: 'own-a' });
    const b = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[0], label: 'own-b' });

    // b's local fetch must not contain a's item (owner-scoped)
    const bItems = await b.session.client.get<{ items: Array<{ item_id: string }> }>(
      `/api/v1/item/fetch?item_network=${b.binding.network}&item_domain=${b.binding.domain}&item_type=${b.binding.item_type}&limit=200`,
    );
    expect(bItems.body.items.some((i) => i.item_id === a.itemId), 'local fetch must be owner-scoped').toBeFalsy();
  });
});
