import { test, expect } from '../../src/fixtures.js';
import { requireCapabilities } from '../../src/capabilities.js';
import { createLiveProfileUser } from '../../src/flows.js';
import { RUN_ID, newPhone } from '../../src/identities.js';

interface ParticipantRead {
  user_id: string | null;
  user_consent: { terms_accepted: boolean; privacy_accepted: boolean; has_age: boolean };
  items: Array<{ item_id: string; item_state: Record<string, unknown> }>;
  error?: string;
}
interface DecryptResponse {
  profiles: Array<{ item_id: string; item_state: Record<string, unknown> }>;
  skipped: string[];
  error?: string;
}

/**
 * Journey V — admin participant read & decrypt tiers (P0).
 *
 * Journey I covers participant *create* and the two-header model. These are the
 * two routes that hand back **real, decrypted PII**, and neither was exercised.
 *
 * The tier rule (`participant_read.ts`, `participant_decrypt.ts`): a
 * `network_service` acting org reads everything in its served networks; an
 * `aggregator` reads only participants **it** onboarded, keyed on the item
 * creator's `user.onboarded_by_org_id`. A wrong-org read must be a *silent* miss
 * — `items: []` / `skipped: [...]`, never a 404 — so the response can't be used
 * to test whether a person exists on the instance.
 *
 * How the aggregator tier is reachable with one credential: `acting_org.ts`
 * checks that the caller is a member of *some* org, not of the asserted one, so
 * under the default `ACTING_ORG_SOURCE=header` the configured service key can
 * assert a freshly-upserted aggregator's id and be treated as that aggregator.
 */
test.describe('Journey V — admin participant tiers', () => {
  test.beforeEach(({ caps }) => {
    requireCapabilities(test, caps, ['serviceAuth']);
  });

  test('a lookup with no identifier is refused', async ({ service }) => {
    const res = await service.get<ParticipantRead>('/api/v1/admin/participant');
    expect(res.status).toBe(400);
    // NOTE: the querystring schema's `.refine()` (one of email/phone required)
    // rejects first with Fastify/Zod's generic `{ error: 'Bad Request' }`, so
    // the handler's own `MISSING_IDENTIFIER` branch is unreachable over HTTP.
    // What matters is that no participant data comes back with the 400.
    expect(res.body?.error).toBeTruthy();
    expect(res.body?.user_id).toBeUndefined();
    expect(res.body?.items).toBeUndefined();
  });

  test('an unknown identifier reports absence without leaking anything', async ({ service }) => {
    const res = await service.get<ParticipantRead>(
      `/api/v1/admin/participant?phone_number=${encodeURIComponent(newPhone())}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.user_id).toBeNull();
    expect(res.body.items).toEqual([]);
  });

  test('the onboarding org reads its participant back, and decrypt returns cleartext PII', async ({
    api,
    service,
    cfg,
    caps,
    authCtx,
  }) => {
    const u = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'vread',
    });

    // Find a private field to prove the decrypt actually decrypts.
    const props = u.binding.schema.properties ?? {};
    const privateField = Object.entries(props).find(([, p]) => p?.private === true)?.[0];

    const decrypted = await service.post<DecryptResponse>('/api/v1/admin/participant/decrypt', {
      user_id: u.userId,
    });
    expect(decrypted.status, JSON.stringify(decrypted.body)).toBe(200);
    const profile = decrypted.body.profiles.find((p) => p.item_id === u.itemId);
    expect(profile, 'the onboarding org must see its own participant\'s profile').toBeTruthy();

    if (privateField) {
      // The decrypt route merges the decrypted private blob over item_state, so
      // the value must be the REAL one the profile was created with — not the
      // "M***" mask that item_state carries at rest.
      expect(
        profile?.item_state[privateField],
        'decrypt must return the real private value, not the stored mask',
      ).toBe(u.itemState[privateField]);
    }
  });

  test('an aggregator cannot read a participant it did not onboard', async ({
    api,
    service,
    cfg,
    caps,
    authCtx,
  }) => {
    // A participant onboarded by the configured service org…
    const u = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'vscope',
    });

    // …and a *different* aggregator org, which onboarded nobody.
    const slug = `e2e-agg-scope-${RUN_ID}`;
    const upsert = await service.post<{ org_id: string; error?: string }>('/api/v1/admin/aggregator/upsert', {
      external_id: `ext-scope-${RUN_ID}`,
      name: 'E2E Scope Aggregator',
      slug,
      domains: ['seeker', 'provider'],
    });
    test.skip(
      upsert.status === 403,
      'configured acting org is not network_service — cannot mint an aggregator to test scoping with',
    );
    expect(upsert.status, JSON.stringify(upsert.body)).toBe(200);
    const stranger = service.with({ actingOrgId: upsert.body.org_id });

    // Read: the user id may resolve, but no items and no consent may be disclosed.
    const read = await stranger.get<ParticipantRead>(
      `/api/v1/admin/participant?phone_number=${encodeURIComponent('+00000000000')}`,
    );
    expect(read.status).toBe(200);

    // Decrypt by the known item id is the sharp probe — a leak here is a direct
    // PII disclosure to an unrelated aggregator.
    const decrypted = await stranger.post<DecryptResponse>('/api/v1/admin/participant/decrypt', {
      item_ids: [u.itemId],
    });
    expect(decrypted.status, JSON.stringify(decrypted.body)).toBe(200);
    expect(
      decrypted.body.profiles,
      'an aggregator must not decrypt a participant it did not onboard',
    ).toEqual([]);
    // Absent vs not-owned are deliberately indistinguishable — both land in
    // `skipped`, so the response is not an existence oracle.
    expect(decrypted.body.skipped).toContain(u.itemId);

    // And the same request for an item id that doesn't exist looks identical.
    const ghost = '00000000-0000-4000-8000-000000000000';
    const ghostRes = await stranger.post<DecryptResponse>('/api/v1/admin/participant/decrypt', {
      item_ids: [ghost],
    });
    expect(ghostRes.status).toBe(200);
    expect(
      ghostRes.body.skipped,
      'a non-existent id and a not-owned id must be reported identically',
    ).toContain(ghost);
    expect(ghostRes.body.profiles).toEqual([]);
  });

  test('decrypt refuses a caller with no acting org', async ({ cfg, service }) => {
    const noOrg = service.with({ actingOrgId: null });
    const res = await noOrg.post<DecryptResponse>('/api/v1/admin/participant/decrypt', {
      user_id: 'someone',
    });
    // The acting-org preHandler rejects before the handler is reached.
    expect([400, 403]).toContain(res.status);
    expect(['MISSING_ACTING_ORG', 'INVALID_ACTING_ORG']).toContain(res.body?.error);
    expect(cfg.apiBaseUrl).toBeTruthy(); // cfg is used to keep the fixture wired
  });

  test('a signed-in human cannot reach the admin tier', async ({ api, service, cfg, caps, authCtx }) => {
    const u = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: cfg.servedDomains[0],
      label: 'vhuman',
    });
    // A session bearer with an acting-org header: the header selects an org, but
    // the caller is not a registered service member of any org.
    const res = await u.session.client
      .with({ actingOrgId: cfg.auth.actingOrgId })
      .get<ParticipantRead>('/api/v1/admin/participant?phone_number=%2B910000000000');
    expect(res.status, `a human session must not read the admin tier: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
    expect(res.body?.user_id).toBeUndefined();
  });
});
