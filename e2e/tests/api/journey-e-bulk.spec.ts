import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod, type LiveProfile } from '../../src/flows.js';

/**
 * Journey E (API) — Bulk actions & partial-failure semantics (P1).
 * Guards: the {results, summary} envelope · per-item partial failure (207) ·
 * empty/limit rejection. `/action/perform/bulk` is a separate route from the
 * single-object `/perform`; targets that predate it (pre-#296) skip-and-report.
 */
test.describe('Journey E — bulk actions', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP on the target');

  const action = (source: LiveProfile, target: LiveProfile, actionType: string) => ({
    action_type: actionType,
    source_item: source.sourceRef,
    target_item: target.targetRef,
    requirements_snapshot: {},
    consent: { acknowledged: true, version: 1 },
  });

  test('all-valid bulk → 201 with every item succeeded', async ({ api, service, cfg, caps }) => {
    const src = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[0], label: 'ebs' });
    const t1 = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[1] ?? cfg.servedDomains[0], label: 'ebt1' });
    const t2 = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[1] ?? cfg.servedDomains[0], label: 'ebt2' });

    const res = await src.session.client.post<{ results: Array<{ status: string }>; summary: { total: number; succeeded: number; failed: number } }>(
      '/api/v1/action/perform/bulk',
      [action(src, t1, cfg.action.type), action(src, t2, cfg.action.type)],
    );
    test.skip(res.status === 404, 'target predates /action/perform/bulk');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.summary.total).toBe(2);
    expect(res.body.summary.succeeded).toBe(2);
    expect(res.body.summary.failed).toBe(0);
  });

  test('mixed bulk → 207 partial with exact success/failure counts', async ({ api, service, cfg, caps }) => {
    const src = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[0], label: 'ems' });
    const t1 = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[1] ?? cfg.servedDomains[0], label: 'emt1' });

    const valid = action(src, t1, cfg.action.type);
    const bogus = { ...action(src, t1, cfg.action.type), target_item: { ...t1.targetRef, item_id: '00000000-0000-0000-0000-000000000000' } };

    const res = await src.session.client.post<{ summary: { total: number; succeeded: number; failed: number } }>(
      '/api/v1/action/perform/bulk',
      [valid, bogus],
    );
    test.skip(res.status === 404, 'target predates /action/perform/bulk');
    expect(res.status).toBe(207);
    expect(res.body.summary.total).toBe(2);
    expect(res.body.summary.succeeded).toBe(1);
    expect(res.body.summary.failed).toBe(1);
  });

  test('empty bulk array → 400 BULK_EMPTY_ARRAY', async ({ api, service, cfg, caps }) => {
    const src = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[0], label: 'eempty' });
    const res = await src.session.client.post<{ error?: string }>('/api/v1/action/perform/bulk', []);
    test.skip(res.status === 404, 'target predates /action/perform/bulk');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BULK_EMPTY_ARRAY');
  });
});
