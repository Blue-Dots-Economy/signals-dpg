import { describe, it, expect } from 'vitest';
import { parseNetworkConfigDocument } from '../network_workflow.js';

const base = {
  id: 'blue_dot',
  domains: [
    {
      id: 'provider',
      item_schemas: {
        'job_posting_1.0': {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          display_name_field: 'jobProviderName',
          properties: { jobProviderName: { type: 'string' } },
        },
      },
      card: { title_field: 'jobProviderName' },
      status_rules: [{ status: 'active', when: 'default' }],
      contact_fields: {
        name: 'jobProviderName',
        phone: 'hiringManagerPhoneNumber',
        email: 'hiringManagerEmail',
      },
    },
  ],
};

describe('network config contact_fields', () => {
  it('parses and exposes a domain contact_fields map', () => {
    const cfg = parseNetworkConfigDocument(base);
    const provider = cfg.domains.find((d) => d.id === 'provider');
    expect(provider?.contact_fields).toEqual({
      name: 'jobProviderName',
      phone: 'hiringManagerPhoneNumber',
      email: 'hiringManagerEmail',
    });
  });

  it('treats contact_fields as optional (absent → undefined)', () => {
    const noContact = { ...base, domains: [{ ...base.domains[0], contact_fields: undefined }] };
    const cfg = parseNetworkConfigDocument(noContact);
    expect(cfg.domains[0]!.contact_fields).toBeUndefined();
  });

  it('does NOT fail the whole parse on an empty-string mapping value (#521 review)', () => {
    // An authoring slip like `"phone": ""` must not take down boot — an empty
    // mapping is falsy and degrades to the account fallback at resolve time.
    const withEmpty = {
      ...base,
      domains: [{ ...base.domains[0], contact_fields: { name: 'jobProviderName', phone: '' } }],
    };
    const cfg = parseNetworkConfigDocument(withEmpty);
    expect(cfg.domains[0]!.contact_fields).toMatchObject({ name: 'jobProviderName', phone: '' });
  });

  it('strips an unknown contact_fields key rather than failing the parse (#521 review)', () => {
    const withUnknown = {
      ...base,
      domains: [{ ...base.domains[0], contact_fields: { name: 'jobProviderName', bogus: 'x' } }],
    };
    const cfg = parseNetworkConfigDocument(withUnknown);
    expect(cfg.domains[0]!.contact_fields).not.toHaveProperty('bogus');
    expect(cfg.domains[0]!.contact_fields).toMatchObject({ name: 'jobProviderName' });
  });
});
