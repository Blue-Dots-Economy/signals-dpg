import { describe, expect, it } from 'vitest';
import {
  ConsentAckSchema,
  PerformActionBodySchema,
  PerformNetworkActionBodySchema,
  UpdateActionStatusBodySchema,
} from '../api/action_schemas';

describe('ConsentAckSchema', () => {
  it('accepts a valid consent acknowledgement with version', () => {
    const parsed = ConsentAckSchema.parse({
      acknowledged: true,
      version: 1,
    });
    expect(parsed.acknowledged).toBe(true);
    expect(parsed.version).toBe(1);
  });

  it('accepts a valid consent with optional brand', () => {
    const parsed = ConsentAckSchema.parse({
      acknowledged: true,
      version: 2,
      brand: 'sanketika',
    });
    expect(parsed.acknowledged).toBe(true);
    expect(parsed.version).toBe(2);
    expect(parsed.brand).toBe('sanketika');
  });

  it('accepts null brand', () => {
    const parsed = ConsentAckSchema.parse({
      acknowledged: true,
      version: 1,
      brand: null,
    });
    expect(parsed.brand).toBeNull();
  });

  it('rejects acknowledged:false', () => {
    expect(() =>
      ConsentAckSchema.parse({ acknowledged: false, version: 1 })
    ).toThrow();
  });

  it('rejects missing version', () => {
    expect(() => ConsentAckSchema.parse({ acknowledged: true })).toThrow();
  });

  it('rejects version < 1', () => {
    expect(() => ConsentAckSchema.parse({ acknowledged: true, version: 0 })).toThrow();
  });

  it('rejects non-integer version', () => {
    expect(() => ConsentAckSchema.parse({ acknowledged: true, version: 1.5 })).toThrow();
  });

  it('rejects empty brand string', () => {
    expect(() =>
      ConsentAckSchema.parse({ acknowledged: true, version: 1, brand: '' })
    ).toThrow();
  });

  it('rejects unknown keys (strict mode)', () => {
    expect(() =>
      ConsentAckSchema.parse({ acknowledged: true, version: 1, extra: 1 })
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
      consent: { acknowledged: true, version: 1 },
    });
    expect(parsed.consent?.acknowledged).toBe(true);
    expect(parsed.consent?.version).toBe(1);
  });
});

describe('requirements_snapshot is optional (defaults to {})', () => {
  const base = {
    action_type: 'connect',
    source_item: { item_network: 'n', item_domain: 'd', item_type: 't', item_id: UUID_A },
    target_item: {
      item_network: 'n',
      item_domain: 'd',
      item_type: 't',
      item_id: UUID_B,
      item_instance_url: 'http://x.example.com',
    },
  };

  it('PerformActionBodySchema: an omitted requirements_snapshot defaults to {}', () => {
    const parsed = PerformActionBodySchema.parse(base);
    expect(parsed.requirements_snapshot).toEqual({});
  });

  it('PerformActionBodySchema: a provided requirements_snapshot is preserved', () => {
    const parsed = PerformActionBodySchema.parse({ ...base, requirements_snapshot: { years: 3 } });
    expect(parsed.requirements_snapshot).toEqual({ years: 3 });
  });

  it('PerformNetworkActionBodySchema: an omitted requirements_snapshot defaults to {}', () => {
    const parsed = PerformNetworkActionBodySchema.parse({
      action_type: 'connect',
      source_item: { ...base.source_item, item_instance_url: 'http://s.example.com' },
      target_item: base.target_item,
      source_item_owner: 'usr_1',
    });
    expect(parsed.requirements_snapshot).toEqual({});
  });

  it('each parse gets its own {} (no shared reference across parses)', () => {
    const a = PerformActionBodySchema.parse(base);
    const b = PerformActionBodySchema.parse(base);
    expect(a.requirements_snapshot).not.toBe(b.requirements_snapshot);
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
      consent: { acknowledged: true, version: 1 },
    });
    expect(parsed.remarks).toBe('optional note');
    expect(parsed.consent?.acknowledged).toBe(true);
    expect(parsed.consent?.version).toBe(1);
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
      consent: { acknowledged: true, version: 2, brand: 'sanketika' },
    });
    expect(parsed.consent?.acknowledged).toBe(true);
    expect(parsed.consent?.version).toBe(2);
    expect(parsed.consent?.brand).toBe('sanketika');
  });
});
