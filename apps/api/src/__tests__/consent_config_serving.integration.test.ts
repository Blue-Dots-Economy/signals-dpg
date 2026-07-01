import { describe, it, expect, beforeAll } from 'vitest';
import { refreshConsumedSchemas, getCachedSchemas } from '@/network_schema_cache';

// Requires SERVED_DOMAINS to include blue_dot and NETWORK_CONFIG_LOCAL_FILE
// pointing at examples/schemas/blue_dot/network.json for this test env.
describe('consent config serving', () => {
  beforeAll(async () => {
    await refreshConsumedSchemas();
  });

  it('caches a network-default consent_config entry for blue_dot', async () => {
    const all = await getCachedSchemas({ network: 'blue_dot' });
    const consent = all.filter((e) => e.kind === 'consent_config');
    expect(consent.some((e) => !e.brand)).toBe(true);
  });

  it('caches the upsdm brand-scoped consent_config entry', async () => {
    const all = await getCachedSchemas({ network: 'blue_dot' });
    const upsdm = all.find((e) => e.kind === 'consent_config' && e.brand === 'upsdm');
    expect(upsdm).toBeDefined();
    expect((upsdm!.schema as { documents?: { privacy?: unknown } }).documents?.privacy).toBeDefined();
  });
});
