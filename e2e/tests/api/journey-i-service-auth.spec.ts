import { test, expect } from '../../src/fixtures.js';
import { requireCapabilities } from '../../src/capabilities.js';
import { newName, newPhone, RUN_ID } from '../../src/identities.js';
import { createLiveProfileUser } from '../../src/flows.js';

/**
 * Journey I — Integrating-DPG two-header service auth & participant (P0).
 * Exercises signals' own `/admin/*` surface with a SIMULATED service caller
 * (an API key from config) — no sibling application is involved.
 * Guards: apikey-priority no-fallback · acting-org check · idempotency.
 */
test.describe('Journey I — service auth & participant', () => {
  test.beforeEach(({ caps }) => {
    requireCapabilities(test, caps, ['serviceAuth']);
  });

  test('an invalid API key is rejected (403 INVALID_API_KEY, no session fallback)', async ({ api, cfg }) => {
    const bad = api.with({ apiKey: 'sk_signals_invalidkey0000000000000000000000000000', actingOrgId: cfg.auth.actingOrgId });
    const res = await bad.post<{ code?: string; error?: string }>('/api/v1/admin/participant', {
      phone_number: newPhone(),
      name: newName('Nope'),
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      network: cfg.network,
    });
    expect(res.status).toBe(403);
    // auth-middleware rejections carry the machine code in `code`
    expect(res.body.code ?? res.body.error).toBe('INVALID_API_KEY');
  });

  test('a valid key without an acting-org header is rejected (400 MISSING_ACTING_ORG)', async ({ api, cfg }) => {
    const noOrg = api.with({ apiKey: cfg.auth.serviceApiKey, actingOrgId: null });
    const res = await noOrg.post<{ error?: string }>('/api/v1/admin/participant', {
      phone_number: newPhone(),
      name: newName('NoOrg'),
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      network: cfg.network,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_ACTING_ORG');
  });

  test('a valid service caller creates a participant, and a duplicate returns 409', async ({ service, cfg }) => {
    const phone = newPhone();
    const body = {
      phone_number: phone,
      name: newName('Participant'),
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link' as const,
      network: cfg.network,
    };

    const first = await service.post<{ user_id: string; user_existed: boolean }>('/api/v1/admin/participant', body);
    expect(first.status, `create: ${JSON.stringify(first.body)}`).toBe(200);
    expect(first.body.user_id).toBeTruthy();

    // second call for the same identifier — account-only upsert returns the same user,
    // while a conflicting create is rejected 409. Accept either the idempotent 200
    // (user_existed=true) or an explicit 409 USER_ALREADY_EXISTS.
    const second = await service.post<{ user_existed?: boolean; error?: string }>('/api/v1/admin/participant', body);
    if (second.status === 200) {
      expect(second.body.user_existed, 'repeat upsert should report the existing user').toBeTruthy();
    } else {
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('USER_ALREADY_EXISTS');
    }
  });

  test('network_service upserts an aggregator org (idempotent on slug)', async ({ service }) => {
    const slug = `e2e-agg-${RUN_ID}`;
    const body = { external_id: `ext-${RUN_ID}`, name: 'E2E Aggregator', slug, domains: ['seeker', 'provider'] };
    const first = await service.post<{ org_id: string; created: boolean }>('/api/v1/admin/aggregator/upsert', body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.org_id).toBeTruthy();

    const second = await service.post<{ org_id: string; created: boolean }>('/api/v1/admin/aggregator/upsert', body);
    expect(second.status).toBe(200);
    expect(second.body.created, 'repeat upsert is idempotent').toBe(false);
    expect(second.body.org_id).toBe(first.body.org_id);
  });

  test('network_service performs an action on behalf of a user; negatives are enforced', async ({ api, service, cfg, caps, authCtx }) => {
    const a = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[0], label: 'oba' });
    const b = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[1] ?? cfg.servedDomains[0], label: 'obb' });
    const base = {
      action_type: cfg.action.type,
      source_item: a.sourceRef,
      target_item: b.targetRef,
      requirements_snapshot: {},
      consent: { acknowledged: true, version: 1 },
    };

    // success: network_service is unrestricted and A owns the source item
    const ok = await service.post<{ results: Array<{ status: string; error?: string }> }>('/api/v1/action/perform', {
      ...base,
      acting_as_user_id: a.userId,
    });
    expect(ok.body?.results?.[0]?.status, JSON.stringify(ok.body)).toBe('success');

    // missing acting_as_user_id when acting as an org → rejected
    const missing = await service.post<{ results: Array<{ error?: string }> }>('/api/v1/action/perform', base);
    expect(missing.body?.results?.[0]?.error).toBe('MISSING_ACTING_AS_USER_ID');

    // unknown target user → USER_NOT_FOUND
    const unknown = await service.post<{ results: Array<{ error?: string }> }>('/api/v1/action/perform', {
      ...base,
      acting_as_user_id: 'user-does-not-exist',
    });
    expect(unknown.body?.results?.[0]?.error).toBe('USER_NOT_FOUND');
  });
});
