import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { fetchOwnItemById, waitForDiscoverable } from '../../src/items.js';

/**
 * Journey P — item update & delete (P0).
 *
 * `PATCH /api/v1/item/{itemId}` and `DELETE /api/v1/item/{itemId}`.
 *
 * The invariant worth guarding hardest: **`item_instance_url` and
 * `item_schema_url` are backend-generated** (root CLAUDE.md). They address the
 * item across instances, so a client that could rewrite them could point a peer
 * at an instance of its choosing. The update body schema omits the identity
 * columns; this proves the URLs can't be steered either.
 *
 * Ownership failures here are deliberately **404, not 403**
 * (`ITEM_NOT_FOUND_OR_FORBIDDEN`) — a 403 would confirm to a stranger that the
 * id exists.
 */
test.describe('Journey P — item update & delete', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users');
  test.skip(({ caps }) => !caps.testOtp, 'requires OTP retrieval');

  test('server-owned URLs cannot be steered by an update', async ({ api, service, cfg, caps, authCtx }) => {
    const u = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'purl',
    });
    const before = await fetchOwnItemById(u.session, u.binding, u.itemId);
    expect(before?.item_instance_url, 'the item must start with a backend-generated instance URL').toBeTruthy();

    const res = await u.session.client.patch<{ error?: string }>(`/api/v1/item/${u.itemId}`, {
      item_state: u.itemState,
      item_instance_url: 'https://attacker.example',
      item_schema_url: 'https://attacker.example/schema.json',
    });
    // Either the field is rejected outright or silently dropped — both are
    // acceptable; what must never happen is the value taking effect.
    expect([200, 400], `unexpected status: ${JSON.stringify(res.body)}`).toContain(res.status);

    const after = await fetchOwnItemById(u.session, u.binding, u.itemId);
    expect(
      after?.item_instance_url,
      'a client must not be able to rewrite the item instance URL',
    ).toBe(before?.item_instance_url);
    expect(after?.item_instance_url).not.toContain('attacker.example');
  });

  test('a stranger can neither update nor delete another user\'s item', async ({
    api,
    service,
    cfg,
    caps,
    authCtx,
  }) => {
    const owner = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'powner',
    });
    const stranger = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'pstr',
    });

    const patched = await stranger.session.client.patch<{ error?: string }>(
      `/api/v1/item/${owner.itemId}`,
      { item_state: owner.itemState },
    );
    expect(patched.status, `stranger patch: ${JSON.stringify(patched.body)}`).toBe(404);
    expect(
      patched.body?.error,
      'ownership failures must be indistinguishable from "no such item"',
    ).toBe('ITEM_NOT_FOUND_OR_FORBIDDEN');

    const deleted = await stranger.session.client.delete<{ error?: string }>(
      `/api/v1/item/${owner.itemId}`,
    );
    expect(deleted.status, `stranger delete: ${JSON.stringify(deleted.body)}`).toBe(404);

    // The owner's item is untouched by either attempt.
    const still = await fetchOwnItemById(owner.session, owner.binding, owner.itemId);
    expect(still?.lifecycle_status, 'a refused write must change nothing').toBe('live');
  });

  test('item writes reject an unauthenticated caller', async ({ api, service, cfg, caps, authCtx }) => {
    const u = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'panon',
    });

    const patched = await api.patch(`/api/v1/item/${u.itemId}`, { item_state: u.itemState });
    expect(patched.status).toBe(401);
    const deleted = await api.delete(`/api/v1/item/${u.itemId}`);
    expect(deleted.status).toBe(401);

    const still = await fetchOwnItemById(u.session, u.binding, u.itemId);
    expect(still, 'the item must survive both anonymous attempts').toBeTruthy();
  });

  test('the owner can delete their own item; it leaves own-fetch and discovery', async ({
    api,
    service,
    cfg,
    caps,
    authCtx,
  }) => {
    const u = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'pdel',
    });
    expect(await waitForDiscoverable(api, u.binding, u.itemId, true)).toBe(true);

    const res = await u.session.client.delete<{ error?: string }>(`/api/v1/item/${u.itemId}`);
    expect(res.status, `owner delete: ${JSON.stringify(res.body)}`).toBe(204);

    let still = await fetchOwnItemById(u.session, u.binding, u.itemId);
    for (let i = 0; i < 6 && still; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      still = await fetchOwnItemById(u.session, u.binding, u.itemId);
    }
    expect(still, 'a deleted item must leave the owner\'s own list').toBeUndefined();

    expect(
      await waitForDiscoverable(api, u.binding, u.itemId, false),
      'a deleted item must leave the network feed',
    ).toBe(false);

    // Deleting twice is a no-op, not a 500 — and still must not confirm existence.
    const again = await u.session.client.delete<{ error?: string }>(`/api/v1/item/${u.itemId}`);
    expect([204, 404]).toContain(again.status);
  });

  /*
   * NOT COVERED HERE — the `DOMAIN_LOCKED` single-role lock.
   *
   * `create_item.ts` drives it off `user.domains`, which is bootstrapped when a
   * user creates their first item *through their own session*. Admin api-key
   * callers bypass the check, and `POST /admin/participant` does not populate
   * the column — so a service-provisioned persona (what this suite uses by
   * default, to dodge the self-signup rate limit) has `domains = []` and is
   * NOT domain-locked. A cross-domain create for such a user returns 201.
   *
   * Asserting the lock therefore needs a self-signed-up persona whose first item
   * went through their own session. That belongs with the self-signup journeys
   * (A/B) rather than here, and costs one of the 10/hour signups. Left parked
   * deliberately rather than asserted against a persona the rule doesn't apply
   * to — which would have made this test pass for the wrong reason.
   */
});
