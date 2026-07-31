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

describe('item_state multi-value facet arrays (#203 Task 7)', () => {
  // Round-trip contract: apps/ui/src/lib/network-api.ts's `fetchNetworkMarkers`
  // serializes a multi-select facet as repeated `item_state[field]=value`
  // query params; the server's `qs`-backed querystring parser (registered via
  // `fastify-qs` in apps/api/src/app.ts) auto-arrays those repeated keys back
  // into a plain object shaped exactly like the one asserted here —
  // `{ item_state: { field: string[] } }`. This test locks in that
  // `MarkersQuerySchema`/`MarkersBodySchema` accept and preserve that shape
  // (the `apps/api` facet integration suite exercises the full HTTP chain
  // through the real qs parser).
  it('MarkersQuerySchema accepts a multi-value item_state facet as string[]', () => {
    const result = MarkersQuerySchema.safeParse({
      ...base,
      item_state: { gender: ['female', 'male'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.item_state).toEqual({ gender: ['female', 'male'] });
      expect(Array.isArray(result.data.item_state?.gender)).toBe(true);
    }
  });

  it('MarkersQuerySchema still accepts a scalar item_state value (unchanged)', () => {
    const result = MarkersQuerySchema.safeParse({ ...base, item_state: { gender: 'female' } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.item_state).toEqual({ gender: 'female' });
    }
  });

  it('MarkersBodySchema (the inter-instance peer body) accepts a multi-value item_state facet', () => {
    const result = MarkersBodySchema.safeParse({
      ...base,
      item_state: { gender: ['female', 'male'] },
      limit: 200,
      offset: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.item_state).toEqual({ gender: ['female', 'male'] });
    }
  });

  it('accepts a multi-value facet combined with a bbox (the map path)', () => {
    const result = MarkersQuerySchema.safeParse({
      ...base,
      ...bbox,
      item_state: { gender: ['female', 'male'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.item_state).toEqual({ gender: ['female', 'male'] });
      expect(result.data.min_lat).toBe(18);
    }
  });
});

describe('q free-text value-match search (#394 map native text search)', () => {
  it('MarkersQuerySchema accepts a q and preserves it', () => {
    const result = MarkersQuerySchema.safeParse({ ...base, q: 'plumber' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.q).toBe('plumber');
    }
  });

  it('MarkersQuerySchema trims surrounding whitespace off q', () => {
    const result = MarkersQuerySchema.safeParse({ ...base, q: '  plumber  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.q).toBe('plumber');
    }
  });

  it('MarkersQuerySchema rejects an empty/whitespace-only q rather than silently treating it as no search', () => {
    expect(MarkersQuerySchema.safeParse({ ...base, q: '' }).success).toBe(false);
    expect(MarkersQuerySchema.safeParse({ ...base, q: '   ' }).success).toBe(false);
  });

  it('MarkersQuerySchema treats q as optional (bare bbox/facet requests are unaffected)', () => {
    expect(MarkersQuerySchema.safeParse({ ...base }).success).toBe(true);
  });

  it('MarkersQuerySchema accepts q combined with a bbox (the map path)', () => {
    const result = MarkersQuerySchema.safeParse({ ...base, ...bbox, q: 'plumber' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.q).toBe('plumber');
      expect(result.data.min_lat).toBe(18);
    }
  });

  it('MarkersBodySchema (the inter-instance peer body) accepts and preserves q', () => {
    const result = MarkersBodySchema.safeParse({
      ...base,
      q: 'plumber',
      limit: 200,
      offset: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.q).toBe('plumber');
    }
  });

  it('FetchItemsQuerySchema (list/discover, not the map) has no q field of its own', () => {
    // q lives on MarkersSchemaBase specifically — the map stays native while
    // list/discover text search goes through signals-search's own `q`
    // (DiscoverItemsBodySchema), a distinct schema entirely.
    const result = FetchItemsQuerySchema.safeParse({ ...base, q: 'plumber' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).q).toBeUndefined();
    }
  });
});
