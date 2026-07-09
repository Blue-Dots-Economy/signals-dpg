import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadConsentConfigs } from '../consent_config_loader';

// examples/ lives at repo root; tests run from packages/config, so go up two levels.
const blueNetworkFile = resolve(__dirname, '../../../../examples/schemas/blue_dot/network.json');

describe('loadConsentConfigs (local)', () => {
  it('loads the network default and the upsdm brand override for blue_dot', async () => {
    const loaded = await loadConsentConfigs({
      source: 'local',
      networkLocalFile: blueNetworkFile,
      networks: ['blue_dot'],
    });

    const def = loaded.find((e) => e.network === 'blue_dot' && e.brand === null);
    expect(def).toBeDefined();
    expect(def!.config.documents.terms.current_version).toBe(1);

    const upsdm = loaded.find((e) => e.network === 'blue_dot' && e.brand === 'upsdm');
    expect(upsdm).toBeDefined();
    // upsdm overrides BOTH documents with UPSDM-branded copy (terms + privacy).
    expect(upsdm!.config.documents.terms).toBeDefined();
    expect(upsdm!.config.documents.privacy).toBeDefined();
    expect(upsdm!.config.documents.terms.current_version).toBe(1);
    expect(upsdm!.config.documents.privacy.current_version).toBe(1);
  });

  it('renders the __SUPPORT_EMAIL__ placeholder to the configured address', async () => {
    const loaded = await loadConsentConfigs({
      source: 'local',
      networkLocalFile: blueNetworkFile,
      networks: ['blue_dot'],
      supportEmail: 'ops@example.test',
    });
    const serialized = JSON.stringify(loaded);
    // Placeholder is fully substituted (no leftover token) with the given email.
    expect(serialized).not.toContain('__SUPPORT_EMAIL__');
    expect(serialized).toContain('ops@example.test');
  });

  it('defaults the support email to hello@bluedotseconomy.org when unset', async () => {
    const loaded = await loadConsentConfigs({
      source: 'local',
      networkLocalFile: blueNetworkFile,
      networks: ['blue_dot'],
    });
    const serialized = JSON.stringify(loaded);
    expect(serialized).not.toContain('__SUPPORT_EMAIL__');
    expect(serialized).toContain('hello@bluedotseconomy.org');
  });
});
