import { describe, it, expect } from 'vitest';
import {
  FetchItemsQuerySchema,
  FetchItemsBodySchema,
  FetchItemsCountBodySchema,
  UpdateItemBodySchema,
  UpdateItemParamsSchema,
  MarkerResponseSchema,
  MarkersQuerySchema,
  ItemLocationsArray,
} from '../item_schemas';

const base = { item_network: 'yellow_dot', item_domain: 'student' };

describe('include_retired query flag (#376)', () => {
  it('defaults to false when absent', () => {
    const result = FetchItemsQuerySchema.safeParse({ ...base });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.include_retired).toBe(false);
  });

  it('transforms the "true" string to boolean true', () => {
    const result = FetchItemsQuerySchema.safeParse({ ...base, include_retired: 'true' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.include_retired).toBe(true);
  });

  it('transforms the "false" string to boolean false', () => {
    const result = FetchItemsQuerySchema.safeParse({ ...base, include_retired: 'false' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.include_retired).toBe(false);
  });

  it('rejects any other string (no truthy coercion of arbitrary values)', () => {
    expect(FetchItemsQuerySchema.safeParse({ ...base, include_retired: 'yes' }).success).toBe(false);
    expect(FetchItemsQuerySchema.safeParse({ ...base, include_retired: '1' }).success).toBe(false);
  });
});

describe('FetchItems pagination coercion vs strict body typing', () => {
  it('coerces numeric strings on the query schema and applies the 20/0 defaults', () => {
    const defaults = FetchItemsQuerySchema.safeParse({ ...base });
    expect(defaults.success).toBe(true);
    if (defaults.success) {
      expect(defaults.data.limit).toBe(20);
      expect(defaults.data.offset).toBe(0);
    }

    const coerced = FetchItemsQuerySchema.safeParse({ ...base, limit: '50', offset: '10' });
    expect(coerced.success).toBe(true);
    if (coerced.success) {
      expect(coerced.data.limit).toBe(50);
      expect(coerced.data.offset).toBe(10);
    }
  });

  it('rejects a limit over the 1000 cap and a negative offset', () => {
    expect(FetchItemsQuerySchema.safeParse({ ...base, limit: '1001' }).success).toBe(false);
    expect(FetchItemsQuerySchema.safeParse({ ...base, offset: '-1' }).success).toBe(false);
  });

  it('FetchItemsBodySchema requires real numbers (no string coercion)', () => {
    expect(FetchItemsBodySchema.safeParse({ ...base, limit: '20', offset: 0 }).success).toBe(false);
    expect(FetchItemsBodySchema.safeParse({ ...base, limit: 20, offset: 0 }).success).toBe(true);
  });

  it('FetchItemsCountBodySchema drops the pagination fields entirely', () => {
    const result = FetchItemsCountBodySchema.safeParse({ ...base });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('limit' in result.data).toBe(false);
      expect('offset' in result.data).toBe(false);
      expect('cache_ttl_seconds' in result.data).toBe(false);
    }
  });

  it('rejects a non-positive cache_ttl_seconds', () => {
    expect(FetchItemsQuerySchema.safeParse({ ...base, cache_ttl_seconds: '0' }).success).toBe(false);
    expect(FetchItemsQuerySchema.safeParse({ ...base, cache_ttl_seconds: '60' }).success).toBe(true);
  });

  it('MarkersQuerySchema allows a far higher limit than the fetch cap', () => {
    expect(MarkersQuerySchema.safeParse({ ...base, limit: '25000' }).success).toBe(true);
    expect(MarkersQuerySchema.safeParse({ ...base, limit: '25001' }).success).toBe(false);
    const defaults = MarkersQuerySchema.safeParse({ ...base });
    if (defaults.success) expect(defaults.data.limit).toBe(200);
  });

  it('MarkersQuerySchema trims q and rejects a blank one', () => {
    const result = MarkersQuerySchema.safeParse({ ...base, q: '  welder  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.q).toBe('welder');
    expect(MarkersQuerySchema.safeParse({ ...base, q: '   ' }).success).toBe(false);
  });
});

describe('UpdateItemBodySchema', () => {
  it('accepts a single-field partial update', () => {
    const result = UpdateItemBodySchema.safeParse({ item_state: { full_name: 'Asha' } });
    expect(result.success).toBe(true);
  });

  it('rejects an empty body with the "at least one field" message', () => {
    const result = UpdateItemBodySchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'At least one field must be provided for update',
      );
    }
  });

  it('rejects immutable / server-generated columns as unknown keys (strict)', () => {
    for (const key of [
      'item_id',
      'item_network',
      'item_domain',
      'item_type',
      'item_private_state',
      'lifecycle_status',
      'created_by',
    ]) {
      const result = UpdateItemBodySchema.safeParse({ [key]: 'x' });
      expect(result.success, `${key} must be rejected`).toBe(false);
    }
  });

  it('accepts item_locations and rejects an out-of-range coordinate', () => {
    expect(
      UpdateItemBodySchema.safeParse({ item_locations: [{ lat: 18.5, lng: 73.8, label: 'Pune' }] })
        .success,
    ).toBe(true);
    expect(
      UpdateItemBodySchema.safeParse({ item_locations: [{ lat: 91, lng: 73.8 }] }).success,
    ).toBe(false);
    expect(
      UpdateItemBodySchema.safeParse({ item_locations: [{ lat: 18.5, lng: 181 }] }).success,
    ).toBe(false);
  });
});

describe('UpdateItemParamsSchema / MarkerResponseSchema / ItemLocationsArray', () => {
  it('requires a uuid itemId param', () => {
    expect(
      UpdateItemParamsSchema.safeParse({ itemId: '3f6f1b52-2a6f-4d2a-9d1a-1b0a9c7e5d21' }).success,
    ).toBe(true);
    expect(UpdateItemParamsSchema.safeParse({ itemId: '42' }).success).toBe(false);
  });

  it('allows a null item_instance_url on a marker but requires a url otherwise', () => {
    const marker = {
      item_id: '3f6f1b52-2a6f-4d2a-9d1a-1b0a9c7e5d21',
      item_domain: 'student',
      item_locations: [{ lat: 18.5, lng: 73.8 }],
    };
    expect(MarkerResponseSchema.safeParse({ ...marker, item_instance_url: null }).success).toBe(
      true,
    );
    expect(
      MarkerResponseSchema.safeParse({ ...marker, item_instance_url: 'not-a-url' }).success,
    ).toBe(false);
  });

  it('accepts an empty locations array and rejects a missing lng', () => {
    expect(ItemLocationsArray.safeParse([]).success).toBe(true);
    expect(ItemLocationsArray.safeParse([{ lat: 18.5 }]).success).toBe(false);
  });
});
