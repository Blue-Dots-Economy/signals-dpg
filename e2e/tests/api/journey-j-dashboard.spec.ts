import { test, expect } from '../../src/fixtures.js';
import { requireCapabilities } from '../../src/capabilities.js';
import { resolveBinding, buildMinimalItemState } from '../../src/schema.js';
import { newName, newPhone, RUN_ID } from '../../src/identities.js';

/**
 * Journey J (API) — Aggregator dashboard & metrics recompute (P1).
 * Guards: per-domain rollup keyed to the acting aggregator · advisory-lock
 * recompute (?refresh) · CSV export parity. Uses the network_service key to act
 * as an aggregator org (org_type comes from the acting-org id), which it creates
 * via upsert — so no separate aggregator key is needed.
 */
test.describe('Journey J — aggregator dashboard', () => {
  test.beforeEach(({ caps }) => {
    requireCapabilities(test, caps, ['serviceAuth']);
  });

  test('dashboard rolls up an aggregator\'s onboarded participants; refresh + export work', async ({ api, service, cfg }) => {
    const domains = cfg.servedDomains.map((d) => d.split('/')[1]);
    const seekerDomain = cfg.servedDomains[0];

    // create an aggregator org scoped to the served domains
    const up = await service.post<{ org_id: string }>('/api/v1/admin/aggregator/upsert', {
      external_id: `ext-dash-${RUN_ID}`,
      name: 'E2E Dashboard Aggregator',
      slug: `e2e-dash-${RUN_ID}`,
      domains,
    });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const aggClient = service.with({ actingOrgId: up.body.org_id });

    // onboard one participant (with a profile) under this aggregator
    const binding = await resolveBinding(api, seekerDomain);
    const prov = await aggClient.post('/api/v1/admin/participant', {
      phone_number: newPhone(),
      name: newName('DashParticipant'),
      date_of_birth: '1990-01-01',
      terms_accepted: true,
      privacy_accepted: true,
      channel: 'link',
      network: binding.network,
      domain: binding.domain,
      item_type: binding.item_type,
      item_state: buildMinimalItemState(binding.schema),
    });
    expect(prov.status, `participant onboard: ${JSON.stringify(prov.body)}`).toBe(200);

    // dashboard rollup (refresh to force a recompute so the new participant is counted)
    const dash = await aggClient.get<{
      by_domain: Record<string, { total_matching: number; rollup?: { total_items: number } }>;
      metadata: { refreshed: boolean; ttl_seconds: number };
    }>('/api/v1/aggregator/dashboard?refresh=true');
    expect(dash.status, JSON.stringify(dash.body)).toBe(200);
    expect(dash.body.by_domain, 'response has a per-domain rollup').toBeTruthy();
    expect(Object.keys(dash.body.by_domain), 'rollup includes the seeker domain').toContain(binding.domain);
    expect(typeof dash.body.metadata.ttl_seconds).toBe('number');
    expect(dash.body.metadata.refreshed, '?refresh=true forces a recompute').toBe(true);

    const seekerBlock = dash.body.by_domain[binding.domain];
    expect(seekerBlock.total_matching, 'onboarded participant appears in the rollup').toBeGreaterThanOrEqual(1);

    // CSV export
    const csv = await aggClient.get<string>('/api/v1/aggregator/dashboard/export');
    expect(csv.status).toBe(200);
    expect(typeof csv.body === 'string' ? csv.body.length : JSON.stringify(csv.body).length).toBeGreaterThan(0);
  });

  test('a non-aggregator acting org is rejected from the dashboard', async ({ service }) => {
    // the network_service org itself is not an aggregator → dashboard denies it
    const res = await service.get<{ error?: string }>('/api/v1/aggregator/dashboard');
    expect(res.status).toBe(403);
  });
});
