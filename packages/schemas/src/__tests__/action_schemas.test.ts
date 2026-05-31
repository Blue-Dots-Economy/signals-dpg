import { describe, expect, it } from 'vitest';
import {
  ConsentAckSchema,
  PerformActionBodySchema,
  PerformNetworkActionBodySchema,
  UpdateActionStatusBodySchema,
} from '../api/action_schemas';

describe('ConsentAckSchema', () => {
  it('accepts a valid consent acknowledgement', () => {
    const parsed = ConsentAckSchema.parse({
      acknowledged: true,
      text: 'I agree to share my PII.',
    });
    expect(parsed.acknowledged).toBe(true);
    expect(parsed.text).toBe('I agree to share my PII.');
  });

  it('rejects acknowledged:false', () => {
    expect(() =>
      ConsentAckSchema.parse({ acknowledged: false, text: 'I agree.' })
    ).toThrow();
  });

  it('rejects empty / whitespace text', () => {
    expect(() => ConsentAckSchema.parse({ acknowledged: true, text: '' })).toThrow();
    expect(() => ConsentAckSchema.parse({ acknowledged: true, text: '   ' })).toThrow();
  });

  it('rejects text longer than 500 chars', () => {
    expect(() =>
      ConsentAckSchema.parse({ acknowledged: true, text: 'x'.repeat(501) })
    ).toThrow();
  });

  it('rejects unknown keys (strict mode)', () => {
    expect(() =>
      ConsentAckSchema.parse({ acknowledged: true, text: 'ok', extra: 1 })
    ).toThrow();
  });
});

// Valid RFC 4122 v4 UUIDs for use in fixtures
const UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const UUID_B = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';

describe('PerformActionBodySchema with consent', () => {
  it('accepts a body without consent (back-compat)', () => {
    const parsed = PerformActionBodySchema.parse({
      action_type: 'connect',
      source_item: {
        item_network: 'n',
        item_domain: 'd',
        item_type: 't',
        item_id: UUID_A,
      },
      target_item: {
        item_network: 'n',
        item_domain: 'd',
        item_type: 't',
        item_id: UUID_B,
        item_instance_url: 'http://x.example.com',
      },
      requirements_snapshot: {},
    });
    expect(parsed.consent).toBeUndefined();
  });

  it('accepts a body with a valid consent block', () => {
    const parsed = PerformActionBodySchema.parse({
      action_type: 'connect',
      source_item: {
        item_network: 'n',
        item_domain: 'd',
        item_type: 't',
        item_id: UUID_A,
      },
      target_item: {
        item_network: 'n',
        item_domain: 'd',
        item_type: 't',
        item_id: UUID_B,
        item_instance_url: 'http://x.example.com',
      },
      requirements_snapshot: {},
      consent: { acknowledged: true, text: 'I agree.' },
    });
    expect(parsed.consent?.acknowledged).toBe(true);
  });
});

describe('UpdateActionStatusBodySchema with consent', () => {
  it('accepts a body without consent', () => {
    const parsed = UpdateActionStatusBodySchema.parse({
      action_id: UUID_A,
      action_status: 'rejected',
    });
    expect(parsed.consent).toBeUndefined();
  });

  it('accepts a body with consent + remarks coexisting', () => {
    const parsed = UpdateActionStatusBodySchema.parse({
      action_id: UUID_A,
      action_status: 'accepted',
      remarks: 'optional note',
      consent: { acknowledged: true, text: 'I agree.' },
    });
    expect(parsed.remarks).toBe('optional note');
    expect(parsed.consent?.acknowledged).toBe(true);
  });
});

describe('PerformNetworkActionBodySchema with consent', () => {
  it('accepts a body with consent (passed through from initiator instance)', () => {
    const parsed = PerformNetworkActionBodySchema.parse({
      action_type: 'connect',
      source_item: {
        item_network: 'n',
        item_domain: 'd',
        item_type: 't',
        item_id: UUID_A,
        item_instance_url: 'http://source.example.com',
      },
      target_item: {
        item_network: 'n',
        item_domain: 'd',
        item_type: 't',
        item_id: UUID_B,
        item_instance_url: 'http://target.example.com',
      },
      source_item_owner: 'org-abc',
      requirements_snapshot: {},
      consent: { acknowledged: true, text: 'I agree to share my PII.' },
    });
    expect(parsed.consent?.acknowledged).toBe(true);
    expect(parsed.consent?.text).toBe('I agree to share my PII.');
  });
});
