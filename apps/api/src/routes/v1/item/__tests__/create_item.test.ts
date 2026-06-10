import { describe, it, expect, vi } from 'vitest';
import { resolveItemCoordinates } from '../geotag_item';

describe('resolveItemCoordinates', () => {
  it('returns provided coords unchanged when both present', async () => {
    const out = await resolveItemCoordinates({
      lat: 1, lng: 2, itemState: { address: 'X' }, itemSchema: {},
      resolve: vi.fn(),
    });
    expect(out).toEqual({ lat: 1, lng: 2 });
  });

  it('geocodes the composite query when coords absent', async () => {
    const resolve = vi.fn().mockResolvedValue({ lat: 10, lng: 20 });
    const out = await resolveItemCoordinates({
      lat: null, lng: null,
      itemState: { address: 'Udupi', pincode: '576101' },
      itemSchema: {
        properties: {
          address: { type: 'string', location: 'primary' },
          pincode: { type: 'string', location: true },
        },
      },
      resolve,
    });
    expect(resolve).toHaveBeenCalledWith('Udupi, 576101');
    expect(out).toEqual({ lat: 10, lng: 20 });
  });

  it('returns nulls when geocoding fails', async () => {
    const out = await resolveItemCoordinates({
      lat: null, lng: null,
      itemState: { address: 'Nowhere' },
      itemSchema: { properties: { address: { type: 'string', location: 'primary' } } },
      resolve: vi.fn().mockResolvedValue(null),
    });
    expect(out).toEqual({ lat: null, lng: null });
  });

  it('returns nulls when no primary field is marked', async () => {
    const resolve = vi.fn();
    const out = await resolveItemCoordinates({
      lat: null, lng: null, itemState: { city: 'X' },
      itemSchema: { properties: { city: { type: 'string' } } },
      resolve,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(out).toEqual({ lat: null, lng: null });
  });
});
