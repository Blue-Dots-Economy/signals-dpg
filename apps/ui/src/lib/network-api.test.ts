import { describe, it, expect, vi, beforeEach } from 'vitest';

// #203 map-serverside-search Task 7 — the critical integration fix: a
// multi-select facet filter (`item_state: { field: string[] }`) must reach
// the server as a REAL array, not `String(value)` (a single comma-joined
// "a,b" string, which is inert against `buildWhereClause`'s
// `item_state ->> field = ANY(...)` facet path, Task 3). Mocks the shared
// axios client so we can inspect the exact `URLSearchParams` sent, without
// making a real HTTP call.
const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('./api-client', () => ({
  createApiClient: () => ({ get: mockGet }),
}));

import { fetchNetworkMarkers, type MarkersResponse } from './network-api';

const emptyResponse: MarkersResponse = {
  meta: { total: 0, limit: 0, offset: 0, partial: false, unavailable_instances: [] },
  markers: [],
};

describe('fetchNetworkMarkers item_state serialization (#203 Task 7)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({ data: emptyResponse });
  });

  it('serializes a multi-value facet as REPEATED params (an array), not a comma-joined string', async () => {
    await fetchNetworkMarkers({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_state: { gender: ['female', 'male'] },
    });

    expect(mockGet).toHaveBeenCalledTimes(1);
    const params = mockGet.mock.calls[0][1].params as URLSearchParams;

    // Two DISTINCT entries under the same bracket key — this is what `qs`
    // (the server's querystring parser) auto-arrays back into `string[]`.
    expect(params.getAll('item_state[gender]')).toEqual(['female', 'male']);
    // The old bug: a single `String(['female','male'])` === 'female,male'.
    expect(params.getAll('item_state[gender]')).not.toEqual(['female,male']);
    expect(params.get('item_state[gender]')).toBe('female'); // first of the repeated pair
  });

  it('serializes a 3+ value multi-select facet as one repeated entry per value', async () => {
    await fetchNetworkMarkers({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_state: { looking_for: ['a', 'b', 'c'] },
    });

    const params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect(params.getAll('item_state[looking_for]')).toEqual(['a', 'b', 'c']);
  });

  it('still serializes a scalar facet value as a single param (unchanged, pre-#203 behavior)', async () => {
    await fetchNetworkMarkers({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_state: { gender: 'female' },
    });

    const params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect(params.getAll('item_state[gender]')).toEqual(['female']);
  });

  it('mixes a scalar field and a multi-value field in the same request', async () => {
    await fetchNetworkMarkers({
      item_network: 'blue_dot',
      item_domain: 'seeker',
      item_state: { age_band: '18-25', gender: ['female', 'male'] },
    });

    const params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect(params.getAll('item_state[age_band]')).toEqual(['18-25']);
    expect(params.getAll('item_state[gender]')).toEqual(['female', 'male']);
  });

  it('sends no item_state params at all when item_state is undefined', async () => {
    await fetchNetworkMarkers({ item_network: 'blue_dot', item_domain: 'seeker' });

    const params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect([...params.keys()].some((k) => k.startsWith('item_state'))).toBe(false);
  });

  it('hits the markers endpoint with the network/domain params set', async () => {
    await fetchNetworkMarkers({ item_network: 'blue_dot', item_domain: 'seeker' });

    expect(mockGet).toHaveBeenCalledWith(
      '/api/v1/network/item/markers',
      expect.objectContaining({ params: expect.any(URLSearchParams) }),
    );
    const params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect(params.get('item_network')).toBe('blue_dot');
    expect(params.get('item_domain')).toBe('seeker');
  });
});
