import { describe, it, expect } from 'vitest';
import {
  FetchItemsQuerySchema,
  MarkersQuerySchema,
  MarkersBodySchema,
} from '../item_schemas';

const base = { item_network: 'n', item_domain: 'd' };
const bbox = { min_lat: 18, min_lng: 72, max_lat: 20, max_lng: 74 };

describe('FetchItemsQuerySchema geo refinement (§4.2)', () => {
  it('accepts no geo params', () => {
    expect(FetchItemsQuerySchema.safeParse({ ...base }).success).toBe(true);
  });
  it('accepts lat+lng without radius (order-only)', () => {
    expect(FetchItemsQuerySchema.safeParse({ ...base, item_latitude: 19, item_longitude: 72 }).success).toBe(true);
  });
  it('accepts lat+lng+radius (filter+order)', () => {
    expect(
      FetchItemsQuerySchema.safeParse({ ...base, item_latitude: 19, item_longitude: 72, radius_meters: 1000 }).success,
    ).toBe(true);
  });
  it('rejects radius without lat/lng', () => {
    expect(FetchItemsQuerySchema.safeParse({ ...base, radius_meters: 1000 }).success).toBe(false);
  });
  it('rejects a lone latitude', () => {
    expect(FetchItemsQuerySchema.safeParse({ ...base, item_latitude: 19 }).success).toBe(false);
  });
});

describe('bbox request params (#203 Task 2)', () => {
  it('MarkersQuerySchema accepts and preserves a bbox', () => {
    const result = MarkersQuerySchema.safeParse({ ...base, ...bbox });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_lat).toBe(18);
      expect(result.data.min_lng).toBe(72);
      expect(result.data.max_lat).toBe(20);
      expect(result.data.max_lng).toBe(74);
    }
  });

  it('MarkersBodySchema accepts and preserves a bbox', () => {
    const result = MarkersBodySchema.safeParse({
      ...base,
      ...bbox,
      limit: 200,
      offset: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_lat).toBe(18);
      expect(result.data.max_lng).toBe(74);
    }
  });

  it('rejects a bbox combined with a radius center', () => {
    expect(
      MarkersQuerySchema.safeParse({
        ...base,
        ...bbox,
        item_latitude: 19,
        item_longitude: 72,
      }).success
    ).toBe(false);
  });

  it('rejects a partial bbox (all-four-or-none)', () => {
    expect(
      MarkersQuerySchema.safeParse({ ...base, min_lat: 18, min_lng: 72 }).success
    ).toBe(false);
  });

  it('accepts no geo params (bbox remains optional)', () => {
    expect(MarkersQuerySchema.safeParse({ ...base }).success).toBe(true);
  });

  it('rejects out-of-range bbox latitude', () => {
    expect(
      MarkersQuerySchema.safeParse({ ...base, ...bbox, max_lat: 95 }).success
    ).toBe(false);
  });
});
