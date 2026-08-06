import { describe, it, expect, vi } from 'vitest';
import { resolveItemLocations } from '../geotag_item';

const multipleSchema = { properties: { service_cities: { type: 'array', location: 'primary' } } };
const singleSchema = { properties: { address: { type: 'string', location: 'primary' } } };

describe('resolveItemLocations', () => {
  it('passes provided locations through unchanged', async () => {
    const out = await resolveItemLocations({ provided: [{ lat: 1, lng: 2 }], itemState: {}, itemSchema: multipleSchema, geocode: vi.fn() });
    expect(out).toEqual([{ lat: 1, lng: 2 }]);
  });
  it('multiple → geocodes each city, attaches label, skips failures', async () => {
    const geocode = vi.fn(async (q: string) => (q === 'Goa' ? { lat: 15, lng: 73 } : null));
    const out = await resolveItemLocations({ provided: undefined, itemState: { service_cities: ['Goa', 'Nowhere'] }, itemSchema: multipleSchema, geocode });
    expect(out).toEqual([{ lat: 15, lng: 73, label: 'Goa' }]);
  });
  it('single → one geocoded coord (no label)', async () => {
    const geocode = vi.fn(async () => ({ lat: 12, lng: 77 }));
    const out = await resolveItemLocations({ provided: undefined, itemState: { address: 'X' }, itemSchema: singleSchema, geocode });
    expect(out).toEqual([{ lat: 12, lng: 77 }]);
  });
  it('returns [] when no marker/value', async () => {
    expect(await resolveItemLocations({ provided: undefined, itemState: {}, itemSchema: { properties: {} }, geocode: vi.fn() })).toEqual([]);
  });
});
