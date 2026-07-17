import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfiguredNetworkSchemas = vi.fn();
vi.mock('@/network_schema_cache', () => ({
  getConfiguredNetworkSchemas: () => getConfiguredNetworkSchemas(),
}));

import { resolveConsentVersion } from '@/services/consent_version';

const consentConfig = {
  documents: {
    terms: { current_version: 3 },
    privacy: { current_version: 1 },
    profile_creation: { current_version: 1 },
  },
  u18_documents: {
    terms: { current_version: 5 },
    privacy: { current_version: 2 },
    profile_creation: { current_version: 1 },
    guardian_declaration: { current_version: 1 },
  },
};

beforeEach(() => {
  getConfiguredNetworkSchemas.mockResolvedValue([
    { kind: 'consent_config', network: 'blue_dot', brand: null, schema: consentConfig },
  ]);
});

describe('resolveConsentVersion variant', () => {
  it('defaults to the adult document set', async () => {
    expect(await resolveConsentVersion({ network: 'blue_dot', category: 'terms' })).toBe(3);
  });

  it('reads the u18 set when variant is u18', async () => {
    expect(
      await resolveConsentVersion({ network: 'blue_dot', category: 'terms', variant: 'u18' }),
    ).toBe(5);
  });

  it('resolves guardian_declaration only under the u18 variant', async () => {
    expect(
      await resolveConsentVersion({ network: 'blue_dot', category: 'guardian_declaration', variant: 'u18' }),
    ).toBe(1);
    expect(
      await resolveConsentVersion({ network: 'blue_dot', category: 'guardian_declaration', variant: 'adult' }),
    ).toBeNull();
  });

  it('returns null when the u18 set is not configured', async () => {
    getConfiguredNetworkSchemas.mockResolvedValue([
      { kind: 'consent_config', network: 'blue_dot', brand: null, schema: { documents: consentConfig.documents } },
    ]);
    expect(
      await resolveConsentVersion({ network: 'blue_dot', category: 'terms', variant: 'u18' }),
    ).toBeNull();
  });
});
