import { describe, expect, it } from 'vitest';
import { AggregatorUpsertRequest, AggregatorUpsertResponse } from '../aggregator_upsert';

const base = { external_id: 'agg-42', name: 'Acme Aggregator', slug: 'acme-aggregator' };

describe('AggregatorUpsertRequest — required identity fields', () => {
  it('accepts the minimal body (external_id + name + slug)', () => {
    const result = AggregatorUpsertRequest.safeParse(base);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(base);
    }
  });

  it('does not default `domains` — an omitted value stays absent', () => {
    const result = AggregatorUpsertRequest.safeParse(base);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.domains).toBeUndefined();
    }
  });

  it.each(['external_id', 'name', 'slug'])('rejects a missing %s', (field) => {
    const body: Record<string, unknown> = { ...base };
    delete body[field];

    const result = AggregatorUpsertRequest.safeParse(body);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual([field]);
    }
  });

  it.each(['external_id', 'name', 'slug'])('rejects an empty %s', (field) => {
    const result = AggregatorUpsertRequest.safeParse({ ...base, [field]: '' });

    expect(result.success).toBe(false);
  });

  it('rejects a non-string external_id (no numeric coercion)', () => {
    expect(AggregatorUpsertRequest.safeParse({ ...base, external_id: 42 }).success).toBe(false);
  });
});

describe('AggregatorUpsertRequest — slug format', () => {
  it.each(['a', 'acme', 'acme-2', 'a-b-c', '123', 'acme-dpg-1'])('accepts slug %s', (slug) => {
    expect(AggregatorUpsertRequest.safeParse({ ...base, slug }).success).toBe(true);
  });

  it.each([
    ['uppercase', 'Acme'],
    ['underscore', 'acme_dpg'],
    ['space', 'acme dpg'],
    ['dot', 'acme.dpg'],
    ['slash', 'acme/dpg'],
    ['trailing newline', 'acme\n'],
    ['unicode', 'acmé'],
  ])('rejects a slug with %s', (_label, slug) => {
    const result = AggregatorUpsertRequest.safeParse({ ...base, slug });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('slug must be lowercase alphanumeric + hyphens');
    }
  });
});

describe('AggregatorUpsertRequest — optional fields', () => {
  it('accepts a valid logo_url', () => {
    expect(
      AggregatorUpsertRequest.safeParse({ ...base, logo_url: 'https://cdn.test/logo.png' }).success,
    ).toBe(true);
  });

  it('rejects a logo_url that is not a URL', () => {
    const result = AggregatorUpsertRequest.safeParse({ ...base, logo_url: 'cdn.test/logo.png' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['logo_url']);
    }
  });

  it('accepts a multi-domain list and preserves order', () => {
    const result = AggregatorUpsertRequest.safeParse({
      ...base,
      domains: ['seeker', 'provider'],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.domains).toEqual(['seeker', 'provider']);
    }
  });

  it('accepts an explicitly empty domains array', () => {
    expect(AggregatorUpsertRequest.safeParse({ ...base, domains: [] }).success).toBe(true);
  });

  it('rejects an empty-string domain entry', () => {
    const result = AggregatorUpsertRequest.safeParse({ ...base, domains: ['seeker', ''] });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['domains', 1]);
    }
  });

  it('rejects a non-array domains value', () => {
    expect(AggregatorUpsertRequest.safeParse({ ...base, domains: 'seeker' }).success).toBe(false);
  });

  it('accepts arbitrary metadata values', () => {
    const result = AggregatorUpsertRequest.safeParse({
      ...base,
      metadata: { tier: 2, region: 'IN', nested: { any: [1, 'two', null] } },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toEqual({
        tier: 2,
        region: 'IN',
        nested: { any: [1, 'two', null] },
      });
    }
  });

  it('rejects a non-object metadata value', () => {
    expect(AggregatorUpsertRequest.safeParse({ ...base, metadata: 'opaque' }).success).toBe(false);
  });

  it('strips unknown top-level keys', () => {
    const result = AggregatorUpsertRequest.safeParse({ ...base, org_id: 'org_should_be_ignored' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('org_id');
    }
  });
});

describe('AggregatorUpsertResponse', () => {
  it('accepts a created response', () => {
    const result = AggregatorUpsertResponse.safeParse({ org_id: 'org_abc', created: true });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ org_id: 'org_abc', created: true });
    }
  });

  it('accepts an updated (created: false) response', () => {
    expect(AggregatorUpsertResponse.safeParse({ org_id: 'org_abc', created: false }).success).toBe(
      true,
    );
  });

  it('rejects a missing created flag', () => {
    expect(AggregatorUpsertResponse.safeParse({ org_id: 'org_abc' }).success).toBe(false);
  });

  it('rejects a non-boolean created flag (no truthiness coercion)', () => {
    expect(
      AggregatorUpsertResponse.safeParse({ org_id: 'org_abc', created: 'true' }).success,
    ).toBe(false);
  });

  it('rejects a missing org_id', () => {
    expect(AggregatorUpsertResponse.safeParse({ created: true }).success).toBe(false);
  });
});
