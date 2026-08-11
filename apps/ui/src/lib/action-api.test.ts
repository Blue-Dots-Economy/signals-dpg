import { describe, it, expect, vi, beforeEach } from 'vitest';

// #439 Task 8 — fetchMyActions must serialize the new sort/facets/status/type
// params the way the server's `/action/fetch` route (FetchOwnedActionsQuerySchema
// + `fastify-qs`, apps/api/src/app.ts) parses them:
// - `action_status`/`action_type`: a single value sets once; an array value
//   appends REPEATED entries under the same key (the schema's
//   `z.union([string, array]).transform(toStringArray)` accepts either).
// - `facets`: qs bracket-notation (`facets[0][field]`, `facets[0][values][0]`,
//   ...) — NOT JSON — because the route registers `fastify-qs` specifically to
//   parse that nested array-of-objects shape into `facets` server-side. This
//   differs from discover's `filters`, which travels as a POST JSON body.
// Mocks the shared axios client so the exact `URLSearchParams` sent can be
// inspected without a real HTTP call (mirrors network-api.test.ts).
const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('./api-client', () => ({
  createApiClient: () => ({ get: mockGet }),
}));

import { fetchMyActions, type FetchMyActionsResponse } from './action-api';

const emptyResponse: FetchMyActionsResponse = {
  meta: { total: 0, limit: 20, offset: 0 },
  actions: [],
};

describe('fetchMyActions param serialization (#439 Task 8)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({ data: emptyResponse });
  });

  it('serializes a single action_status/action_type as one param each (unchanged behavior)', async () => {
    await fetchMyActions({ action_status: 'pending', action_type: 'apply' });

    const params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect(params.getAll('action_status')).toEqual(['pending']);
    expect(params.getAll('action_type')).toEqual(['apply']);
  });

  it('serializes an array action_status/action_type as REPEATED params, not a comma-joined string', async () => {
    await fetchMyActions({
      action_status: ['pending', 'accepted'],
      action_type: ['apply', 'invite'],
    });

    const params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect(params.getAll('action_status')).toEqual(['pending', 'accepted']);
    expect(params.getAll('action_type')).toEqual(['apply', 'invite']);
  });

  it('sets sort as a single param when provided, and omits it otherwise', async () => {
    await fetchMyActions({ sort: 'distance' });
    let params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect(params.get('sort')).toBe('distance');

    mockGet.mockClear();
    await fetchMyActions({});
    params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect(params.has('sort')).toBe(false);
  });

  it('encodes facets as qs bracket-notation (field + repeated indexed values), not JSON', async () => {
    await fetchMyActions({
      facets: [
        { field: 'looking_for', values: ['maths', 'science'] },
        { field: 'gender', values: ['female'] },
      ],
    });

    const params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect(params.get('facets[0][field]')).toBe('looking_for');
    expect(params.getAll('facets[0][values][0]')).toEqual(['maths']);
    expect(params.getAll('facets[0][values][1]')).toEqual(['science']);
    expect(params.get('facets[1][field]')).toBe('gender');
    expect(params.getAll('facets[1][values][0]')).toEqual(['female']);
    // Never JSON-encoded — the server's querystring parser (fastify-qs) is
    // what turns the bracket keys into a nested array, not a JSON.parse.
    expect([...params.keys()].some((k) => k === 'facets')).toBe(false);
  });

  it('omits facets entirely when not provided or empty', async () => {
    await fetchMyActions({});
    let params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect([...params.keys()].some((k) => k.startsWith('facets'))).toBe(false);

    mockGet.mockClear();
    await fetchMyActions({ facets: [] });
    params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect([...params.keys()].some((k) => k.startsWith('facets'))).toBe(false);
  });

  it('still forwards item_id and ownership_role as before', async () => {
    await fetchMyActions({ item_id: 'item-123', ownership_role: 'received' });

    const params = mockGet.mock.calls[0][1].params as URLSearchParams;
    expect(params.get('item_id')).toBe('item-123');
    expect(params.get('ownership_role')).toBe('received');
  });
});
