import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { performAction } from '../../src/actions.js';
import {
  fetchOwnItemById,
  setLifecycle,
  waitForLifecycle,
  waitForDiscoverable,
} from '../../src/items.js';

/**
 * Journey O — profile lifecycle: pause / unpause / retire (P0).
 *
 * `draft → live → paused → retired` via `POST /api/v1/item/lifecycle`.
 *
 * **Retire is terminal and destructive** (#347) and fans out to five subsystems
 * in one transaction: it scrubs PII from `item_state`, clears the encrypted
 * private blob, wipes `item_locations`, cancels every still-open action on
 * either side, and de-indexes the item from search. Any one of those failing
 * silently leaves personal data reachable after a user asked to leave, which is
 * why this is the highest-consequence path in the product.
 *
 * Unpause deliberately does NOT flip straight back to `live` — it re-derives the
 * status through the classifier, so a profile that lost a required field while
 * paused comes back as `draft` rather than being published incomplete.
 */
test.describe('Journey O — profile lifecycle', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users');
  test.skip(({ caps }) => !caps.testOtp, 'requires OTP retrieval');

  test('pause hides a live profile; unpause re-derives status through the classifier', async ({
    api,
    service,
    cfg,
    caps,
    authCtx,
  }) => {
    const u = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'opause',
    });
    expect(u.lifecycleStatus).toBe('live');

    const paused = await setLifecycle(u.session, u.itemId, 'pause');
    test.skip(
      paused.status === 409 && paused.body?.error === 'PAUSE_NOT_ENABLED',
      'pause is disabled network-wide on this target (pause_enabled=false)',
    );
    expect(paused.status, `pause: ${JSON.stringify(paused.body)}`).toBe(200);
    expect(paused.body.lifecycle_status).toBe('paused');

    const hidden = await waitForLifecycle(u.session, u.binding, u.itemId, 'paused');
    expect(hidden?.lifecycle_status).toBe('paused');
    // The point of pause: it comes out of discovery.
    expect(
      await waitForDiscoverable(api, u.binding, u.itemId, false),
      'a paused profile must leave the network feed',
    ).toBe(false);

    const unpaused = await setLifecycle(u.session, u.itemId, 'unpause');
    expect(unpaused.status, `unpause: ${JSON.stringify(unpaused.body)}`).toBe(200);
    // Re-derived, not flipped: a complete profile lands back on `live`.
    expect(unpaused.body.lifecycle_status).toBe('live');
    expect(
      await waitForDiscoverable(api, u.binding, u.itemId, true),
      'an unpaused complete profile must return to the feed',
    ).toBe(true);
  });

  test('lifecycle transition guards are enforced', async ({ api, anon, service, cfg, caps, authCtx }) => {
    const u = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'oguard',
    });

    // unpause on a live (not paused) item
    const badUnpause = await setLifecycle(u.session, u.itemId, 'unpause');
    expect(badUnpause.status, `unpause on live: ${JSON.stringify(badUnpause.body)}`).toBe(409);
    expect(badUnpause.body?.error).toBe('INVALID_LIFECYCLE_ACTION');

    // a lifecycle change on an item that doesn't exist
    const ghost = await setLifecycle(u.session, '00000000-0000-4000-8000-000000000000', 'pause');
    expect(ghost.status).toBe(404);
    expect(ghost.body?.error).toBe('ITEM_NOT_FOUND');

    // unauthenticated — `anon` carries no cookie from `u`'s login, unlike `api`
    // (see fixtures.ts), so this is a real 401, not a session the test forgot about.
    const unauthed = await anon.post<{ error?: string }>('/api/v1/item/lifecycle', {
      item_id: u.itemId,
      action: 'pause',
    });
    expect(unauthed.status, 'lifecycle must not be drivable anonymously').toBe(401);
  });

  test('a non-owner cannot change another user\'s lifecycle', async ({ api, service, cfg, caps, authCtx }) => {
    const owner = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'oowner',
    });
    const stranger = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'ostrange',
    });

    const res = await setLifecycle(stranger.session, owner.itemId, 'retire');
    expect(res.status, `stranger retire: ${JSON.stringify(res.body)}`).toBe(403);
    expect(res.body?.error).toBe('ITEM_NOT_OWNED_BY_USER');

    // …and the owner's profile is untouched.
    const still = await fetchOwnItemById(owner.session, owner.binding, owner.itemId);
    expect(still?.lifecycle_status, 'a refused retire must not change anything').toBe('live');
  });

  test('retire is terminal, de-indexes, and cancels open connections', async ({
    api,
    service,
    cfg,
    caps,
    authCtx,
  }) => {
    const leaver = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'oretire',
    });
    const counterparty = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[1] ?? cfg.servedDomains[0],
      label: 'octr',
    });

    // An open connection that retire is required to cancel.
    const { actionId } = await performAction(leaver.session, {
      actionType: cfg.action.type,
      source: leaver.sourceRef,
      target: counterparty.targetRef,
    });

    const retired = await setLifecycle(leaver.session, leaver.itemId, 'retire');
    expect(retired.status, `retire: ${JSON.stringify(retired.body)}`).toBe(200);
    expect(retired.body.lifecycle_status).toBe('retired');

    // 1. Terminal — nothing transitions out of retired, in either direction.
    for (const action of ['unpause', 'pause', 'retire'] as const) {
      const again = await setLifecycle(leaver.session, leaver.itemId, action);
      expect(again.status, `${action} after retire must be refused`).toBe(409);
      expect(again.body?.error).toBe('INVALID_LIFECYCLE_ACTION');
    }

    // 2. De-indexed from the network feed.
    expect(
      await waitForDiscoverable(api, leaver.binding, leaver.itemId, false),
      'a retired profile must leave discovery',
    ).toBe(false);

    // 3. The counterparty's open action is cancelled — asserted from the OTHER
    //    side, because that is who is left holding a dead connection.
    const theirs = await counterparty.session.client.get<{
      actions: Array<{ action_id: string; action_status: string }>;
    }>(`/api/v1/action/fetch?action_id=${actionId}`);
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    const seen = theirs.body.actions.find((a) => a.action_id === actionId);
    expect(seen, 'the counterparty must still see the action row').toBeTruthy();
    expect(
      ['cancelled', 'rejected', 'withdrawn', 'declined'],
      `an open action must be closed by the counterparty's retire, got "${seen?.action_status}"`,
    ).toContain(seen?.action_status);
  });

  test('a retired profile is permanently removed from the owner\'s own list', async ({
    api,
    service,
    cfg,
    caps,
    authCtx,
  }) => {
    const u = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'oscrub',
    });
    const props = u.binding.schema.properties ?? {};
    const privateField = Object.entries(props).find(([, p]) => p?.private === true)?.[0];

    // Before: the owner's own read returns their real private value.
    const before = await fetchOwnItemById(u.session, u.binding, u.itemId);
    expect(before?.lifecycle_status).toBe('live');
    if (privateField) {
      expect(before?.item_state?.[privateField]).toBe(u.itemState[privateField]);
    }

    const retired = await setLifecycle(u.session, u.itemId, 'retire');
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.lifecycle_status).toBe('retired');

    // `/item/fetch` is the owner "My Profiles" list and sets `exclude_retired`
    // (#347), so a retired profile disappears from it entirely rather than
    // listing with a `retired` status. Poll: the ~1s cache can still serve the
    // pre-retire page.
    let stillListed = await fetchOwnItemById(u.session, u.binding, u.itemId);
    for (let i = 0; i < 6 && stillListed; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      stillListed = await fetchOwnItemById(u.session, u.binding, u.itemId);
    }
    expect(
      stillListed,
      'a retired profile must not remain in the owner\'s own list — retire is removal, not hiding',
    ).toBeUndefined();

    // LIMITATION: the PII scrub itself (item_state wiped, private blob cleared,
    // item_locations emptied — services/items/retire_pii.ts) is NOT observable
    // over HTTP once the row is excluded from every read the owner can make.
    // Asserting it needs row-level introspection, i.e. the `db` capability,
    // which has no fixture yet. Tracked in docs/testing/e2e-coverage-backlog.md
    // §3.1 / §4 — do not mistake this test for proof that the scrub happened.
  });
});
