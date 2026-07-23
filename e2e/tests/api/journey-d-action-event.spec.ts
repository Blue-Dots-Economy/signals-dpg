import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { performAction, updateActionStatus } from '../../src/actions.js';

/**
 * Journey D — Item performs an action on another → event (P0).
 * Guards: single-object perform contract · live-on-both-ends · the accept
 * transition. Needs two live profiles, so it requires a way to create users.
 */
test.describe('Journey D — action → event', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users (gated target without service creds)');
  test.skip(({ caps }) => !caps.testOtp, 'requires OTP retrieval (CREATE_TEST_OTP on the target)');

  test('a live source performs an action on a live target, which the target accepts', async ({ api, service, cfg, caps }) => {
    const sourceDomain = cfg.servedDomains[0];
    const targetDomain = cfg.servedDomains[1] ?? cfg.servedDomains[0];

    const source = await createLiveProfileUser(api, service, cfg, caps, { domainKey: sourceDomain, label: 'src' });
    const target = await createLiveProfileUser(api, service, cfg, caps, { domainKey: targetDomain, label: 'tgt' });
    expect(source.lifecycleStatus).toBe('live');
    expect(target.lifecycleStatus).toBe('live');

    const perform = await performAction(source.session, {
      actionType: cfg.action.type,
      source: source.sourceRef,
      target: target.targetRef,
    });
    expect(perform.actionId).toBeTruthy();
    expect(perform.res.body.summary.total, 'single-object perform ⇒ summary.total === 1').toBe(1);
    expect(perform.res.body.summary.succeeded).toBe(1);

    // receiver accepts
    const update = await updateActionStatus(target.session, { actionId: perform.actionId, status: cfg.action.acceptStatus });
    expect(update.res.body.summary.succeeded).toBe(1);
  });

  test('array body to /action/perform is rejected (batch belongs to /perform/bulk)', async ({ api, service, cfg, caps }) => {
    const source = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[0], label: 'arr' });
    const target = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[1] ?? cfg.servedDomains[0], label: 'arr2' });

    const res = await source.session.client.post<{ summary?: unknown }>('/api/v1/action/perform', [
      {
        action_type: cfg.action.type,
        source_item: source.sourceRef,
        target_item: target.targetRef,
        requirements_snapshot: {},
      },
    ]);
    // Current contract: array to the single-object endpoint is a request-level 400.
    // Older builds (pre-#296) still accept arrays and return an envelope — report+skip there.
    test.skip(res.status !== 400 && !!res.body?.summary, 'target predates single-object /action/perform (accepts arrays)');
    expect(res.status, 'an array to the single-object endpoint must be a request-level 400').toBe(400);
  });

  test('a non-participant cannot advance another action\'s status', async ({ api, service, cfg, caps }) => {
    const source = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[0], label: 'dns' });
    const target = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[1] ?? cfg.servedDomains[0], label: 'dnt' });
    const stranger = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[0], label: 'dnstr' });

    const { actionId } = await performAction(source.session, {
      actionType: cfg.action.type,
      source: source.sourceRef,
      target: target.targetRef,
    });

    // a third user (neither source nor target owner) tries to accept it → rejected per-item
    const res = await stranger.session.client.post<{ results: Array<{ status: string; error?: string }> }>(
      '/api/v1/action/update-status',
      [{ action_id: actionId, action_status: cfg.action.acceptStatus, remarks: 'nope' }],
    );
    const item = res.body?.results?.[0];
    expect(item?.status, `stranger update should be rejected: ${JSON.stringify(res.body)}`).toBe('error');
    expect(['NOT_TARGET_ITEM_OWNER', 'NOT_SOURCE_ITEM_OWNER', 'ACTION_NOT_FOUND']).toContain(item?.error);
  });
});
