import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveCoordinates = vi.fn();
vi.mock('../geo_resolver', () => ({ resolveCoordinates: (q: string) => resolveCoordinates(q) }));

import { geocodeLocationsFromState } from '../resolve_locations_for_create';

const privateSchema = {
  properties: { address: { type: 'string', location: 'primary', private: true } },
};

describe('geocodeLocationsFromState — private field', () => {
  beforeEach(() => resolveCoordinates.mockReset());

  it('returns the exact geocoded point (no city centroid)', async () => {
    resolveCoordinates.mockResolvedValue({ lat: 12.9716, lng: 77.5946 });
    const out = await geocodeLocationsFromState(privateSchema, { address: '12 MG Road, Bengaluru' });
    expect(out).toEqual([{ lat: 12.9716, lng: 77.5946 }]);
    expect(resolveCoordinates).toHaveBeenCalledTimes(1);
  });
});
