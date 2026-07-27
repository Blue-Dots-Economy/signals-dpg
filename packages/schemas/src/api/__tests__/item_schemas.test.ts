import { describe, it, expect } from 'vitest';
import { FetchItemsQuerySchema } from '../item_schemas';

const base = { item_network: 'n', item_domain: 'd' };

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
