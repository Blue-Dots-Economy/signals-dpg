import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { performAction, updateActionStatus } from '../../src/actions.js';

/**
 * Journey F — PII reveal on accepted action (P0).
 * Guards: reveal is participant + status gated · per-read recompute · the error
 * matrix (401 / 403 NOT_ACTION_PARTICIPANT / 403 PII_NOT_REVEALED) · no-store.
 *
 * @covers GET /api/v1/action/{action_id}/contact-details
 *   (the path is built from a runtime actionId, so the traceability check can't
 *   see it literally — scripts/check-coverage.mjs)
 */
test.describe('Journey F — PII reveal', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users (gated target without service creds)');
  test.skip(({ caps }) => !caps.testOtp, 'requires OTP retrieval (CREATE_TEST_OTP on the target)');

  test('contact details are revealed only to a participant after the reveal status', async ({ api, anon, service, cfg, caps, authCtx }) => {
    const source = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[0], label: 'fsrc' });
    const target = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[1] ?? cfg.servedDomains[0], label: 'ftgt' });

    const { actionId } = await performAction(source.session, {
      actionType: cfg.action.type,
      source: source.sourceRef,
      target: target.targetRef,
    });
    const path = `/api/v1/action/${actionId}/contact-details`;

    // before accept → not revealed (403)
    const before = await source.session.client.get(path);
    expect(before.status, 'PII must not reveal before the accept status').toBe(403);

    // unauthenticated → rejected (current source: 401 UNAUTHORIZED; older builds: 403).
    // Must be `anon`, not `api`: `source` and `target` were both just logged in on
    // `api`'s shared request context, so `api` here would carry `target`'s session
    // cookie and this would silently re-test "target reads before accept" (also
    // 403, so it would still pass) instead of the auth boundary (see fixtures.ts).
    const unauthed = await anon.get(path);
    expect([401, 403], `unauthenticated must be rejected, got ${unauthed.status}`).toContain(unauthed.status);

    // a non-participant third user → 403 NOT_ACTION_PARTICIPANT
    const stranger = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[0], label: 'fstr' });
    const strangerRes = await stranger.session.client.get<{ error?: string }>(path);
    expect(strangerRes.status).toBe(403);
    expect(strangerRes.body.error, JSON.stringify(strangerRes.body)).toBe('NOT_ACTION_PARTICIPANT');

    // accept, then the participant sees the other actor's item
    await updateActionStatus(target.session, { actionId, status: cfg.action.acceptStatus });

    const after = await source.session.client.get<{ other_actor?: { item?: { item_id?: string } } }>(path);
    expect(after.status, `reveal after accept: ${JSON.stringify(after.body)}`).toBe(200);
    expect(after.body.other_actor?.item, 'revealed other_actor.item should be present').toBeTruthy();
    expect(after.headers['cache-control'] ?? '', 'reveal response must be no-store').toContain('no-store');
  });
});
