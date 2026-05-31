import { describe, expect, it, vi } from 'vitest';

// mock @/config so the env-validating loadEnv() never runs in tests
vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://localhost:3000',
    port: 3000,
    served_domains: [],
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    schema_registry_url: '',
  },
  getCurrentApiBaseUrl: () => 'http://localhost:3000',
  instance: { INSTANCE_NAME: 'test', INSTANCE_ENV: 'development' },
}));

import { buildActionEventPayload } from '../action_event_runtime';

describe('buildActionEventPayload consent', () => {
  const ctx = {
    action_type: 'connect',
    source_item: {
      item_network: 'n',
      item_domain: 'd',
      item_type: 't',
      item_id: '00000000-0000-0000-0000-000000000001',
      item_instance_url: 'http://localhost:3000',
    },
    target_item: {
      item_network: 'n',
      item_domain: 'd',
      item_type: 't',
      item_id: '00000000-0000-0000-0000-000000000002',
      item_instance_url: 'http://localhost:3000',
    },
    requirements_snapshot: {},
  };

  it('omits consent when none provided', () => {
    const payload = buildActionEventPayload({
      action_status: 'accepted',
      remarks: null,
      context: ctx,
    });
    expect(payload.consent).toBeUndefined();
  });

  it('includes consent + server-stamped consented_at when provided', () => {
    const payload = buildActionEventPayload({
      action_status: 'accepted',
      remarks: null,
      context: ctx,
      consent: { acknowledged: true, text: 'I agree.' },
    });
    expect(payload.consent).toMatchObject({
      acknowledged: true,
      text: 'I agree.',
    });
    expect(typeof (payload.consent as Record<string, unknown>).consented_at).toBe('string');
    expect(Number.isNaN(Date.parse(((payload.consent as Record<string, string>).consented_at)))).toBe(false);
  });
});
