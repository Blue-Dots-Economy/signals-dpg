import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import { useBrowseTotals } from './use-browse-totals';

vi.mock('@/lib/network-api', () => ({
  fetchDiscover: vi.fn(),
  fetchNetworkMarkers: vi.fn(),
  MAP_FETCH_LIMIT: 5000,
}));
import { fetchDiscover, fetchNetworkMarkers } from '@/lib/network-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const network = { id: 'blue_dot' } as unknown as DotNetworkSchema;
const seeker = {
  id: 'seeker',
  item_schemas: { 'profile_1.0': { properties: { gender: { type: 'string' } } } },
} as unknown as DotNetworkDomain;
const provider = {
  id: 'provider',
  item_schemas: { 'job_posting_1.0': { properties: { natureOfJob: { type: 'string' } } } },
} as unknown as DotNetworkDomain;

const discoverTotal = (n: number, anchorApplied = false) =>
  ({ meta: { total: n, anchor_applied: anchorApplied } }) as never;
const markersTotal = (n: number) => ({ meta: { total: n } }) as never;

describe('useBrowseTotals', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sums the filter total across domains and reports what the map cannot plot', async () => {
    // The measured blue_dot shape: 79 + 23 = 102 matching, 72 + 22 = 94 the
    // map can plot anywhere, so 8 will never be pins at any zoom.
    vi.mocked(fetchDiscover).mockImplementation(async (q) =>
      discoverTotal(q.item_domain === 'seeker' ? 79 : 23),
    );
    vi.mocked(fetchNetworkMarkers).mockImplementation(async (q) =>
      markersTotal(q.item_domain === 'seeker' ? 72 : 22),
    );

    const { result } = renderHook(
      () => useBrowseTotals(network, [seeker, provider], {}, '', true),
      { wrapper },
    );

    await waitFor(() => expect(result.current.total).toBe(102));
    expect(result.current.mappable).toBe(94);
    expect(result.current.notMappable).toBe(8);
  });

  it('sends a GLOBAL bbox, not a bbox-less request', async () => {
    // Without a bbox the markers total counts every match regardless of
    // coordinates — it equals the discover total, so the difference would
    // always be zero. The exact ±90/±180 envelope returns 0 rows, hence inset.
    vi.mocked(fetchDiscover).mockResolvedValue(discoverTotal(10));
    vi.mocked(fetchNetworkMarkers).mockResolvedValue(markersTotal(8));

    renderHook(() => useBrowseTotals(network, [seeker], {}, '', true), { wrapper });

    await waitFor(() => expect(vi.mocked(fetchNetworkMarkers)).toHaveBeenCalled());
    const [q] = vi.mocked(fetchNetworkMarkers).mock.calls[0];
    expect(q.min_lat).toBeGreaterThan(-90);
    expect(q.max_lat).toBeLessThan(90);
    expect(q.min_lng).toBeGreaterThan(-180);
    expect(q.max_lng).toBeLessThan(180);
  });

  it('never reports a negative shortfall', async () => {
    // The two counts are separate requests; a write landing between them must
    // not surface as "-3 not on the map".
    vi.mocked(fetchDiscover).mockResolvedValue(discoverTotal(5));
    vi.mocked(fetchNetworkMarkers).mockResolvedValue(markersTotal(8));

    const { result } = renderHook(() => useBrowseTotals(network, [seeker], {}, '', true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.mappable).toBe(8));
    expect(result.current.notMappable).toBe(0);
  });

  it('skips a domain that cannot honour an active facet', async () => {
    // Same routing as useMapMarkers: the server drops a facet the domain does
    // not declare, so counting without this would inflate the total for
    // exactly the domains whose pins are excluded.
    vi.mocked(fetchDiscover).mockResolvedValue(discoverTotal(79));
    vi.mocked(fetchNetworkMarkers).mockResolvedValue(markersTotal(72));

    renderHook(
      () => useBrowseTotals(network, [seeker, provider], { gender: ['Female'] }, '', true),
      { wrapper },
    );

    await waitFor(() => expect(vi.mocked(fetchDiscover)).toHaveBeenCalled());
    const domains = vi.mocked(fetchDiscover).mock.calls.map(([q]) => q.item_domain);
    expect(domains).toContain('seeker');
    expect(domains).not.toContain('provider');
  });

  it('sends the anchor per target domain, so a typed query actually narrows', async () => {
    // The reported bug: `q` alone does not narrow `/discover` — signals-search
    // treats text as a ranking signal unless an anchor accompanies it — while
    // `/markers` always narrows. Measured against the dev cluster for
    // "Titan Retail Malleshwaram": q alone 135, q + anchor 1, markers 1.
    vi.mocked(fetchDiscover).mockImplementation(async (q) =>
      q.anchor_item_id ? discoverTotal(1, true) : discoverTotal(135),
    );
    vi.mocked(fetchNetworkMarkers).mockResolvedValue(markersTotal(1));

    const anchorFor = (domain: string) => (domain === 'seeker' ? 'anchor-1' : undefined);
    const { result } = renderHook(
      () => useBrowseTotals(network, [seeker], {}, 'Titan Retail Malleshwaram', true, anchorFor),
      { wrapper },
    );

    await waitFor(() => expect(result.current.total).toBe(1));
    expect(vi.mocked(fetchDiscover).mock.calls[0][0].anchor_item_id).toBe('anchor-1');
    // Both counts now come from the same matching, so nothing is "missing".
    expect(result.current.notMappable).toBe(0);
  });

  it('omits the anchor for a domain the interaction matrix forbids', async () => {
    // `anchorFor` returns undefined there; sending it anyway would 403
    // (INTERACTION_NOT_ALLOWED) and lose the count entirely.
    vi.mocked(fetchDiscover).mockResolvedValue(discoverTotal(5));
    vi.mocked(fetchNetworkMarkers).mockResolvedValue(markersTotal(5));

    renderHook(
      () => useBrowseTotals(network, [provider], {}, 'plumber', true, () => undefined),
      { wrapper },
    );

    await waitFor(() => expect(vi.mocked(fetchDiscover)).toHaveBeenCalled());
    expect(vi.mocked(fetchDiscover).mock.calls[0][0].anchor_item_id).toBeUndefined();
  });

  it('withholds the shortfall when a typed query is counted two different ways', async () => {
    // Signed out, no profile, or an anchor the matrix forbids: `/discover`
    // returns every candidate and `/markers` returns the text matches, so the
    // difference counts neither missing coordinates nor anything else. The
    // total still stands on its own — it is what the list shows.
    vi.mocked(fetchDiscover).mockResolvedValue(discoverTotal(135));
    vi.mocked(fetchNetworkMarkers).mockResolvedValue(markersTotal(1));

    const { result } = renderHook(
      () => useBrowseTotals(network, [seeker], {}, 'Titan Retail Malleshwaram', true),
      { wrapper },
    );

    await waitFor(() => expect(result.current.total).toBe(135));
    expect(result.current.mappable).toBe(1);
    expect(result.current.notMappable).toBe(0);
  });

  it('withholds the shortfall when the server REJECTED the anchor we sent', async () => {
    // The case a client-side guess cannot see, and the one that actually
    // happened: signals-search rejects an anchor it cannot compare — a profile
    // whose only populated fields are private has no `vectorize` content, so
    // no embedding — and the BFF retries without it, returning 200 and
    // `degraded: false`. `q` then stops filtering, so discover counts every
    // candidate while markers counts the text matches.
    vi.mocked(fetchDiscover).mockResolvedValue(discoverTotal(135, false));
    vi.mocked(fetchNetworkMarkers).mockResolvedValue(markersTotal(3));

    const { result } = renderHook(
      () => useBrowseTotals(network, [seeker], {}, 'test', true, () => 'anchor-1'),
      { wrapper },
    );

    await waitFor(() => expect(result.current.total).toBe(135));
    // We DID send an anchor, so the old client-side guard would have computed
    // 135 - 3 and printed "132 not on the map".
    expect(vi.mocked(fetchDiscover).mock.calls[0][0].anchor_item_id).toBe('anchor-1');
    expect(result.current.notMappable).toBe(0);
  });

  it('still reports the shortfall when there is no typed query', async () => {
    // The guard above must not swallow the genuine case it was built for:
    // with no `q`, both endpoints match identically and the gap is real.
    vi.mocked(fetchDiscover).mockResolvedValue(discoverTotal(102, false));
    vi.mocked(fetchNetworkMarkers).mockResolvedValue(markersTotal(94));

    const { result } = renderHook(
      () => useBrowseTotals(network, [seeker], {}, '', true, () => undefined),
      { wrapper },
    );

    await waitFor(() => expect(result.current.total).toBe(102));
    expect(result.current.notMappable).toBe(8);
  });

  it('refetches when the anchor changes, because it changes what matches', async () => {
    vi.mocked(fetchDiscover).mockImplementation(async (q) =>
      discoverTotal(q.anchor_item_id === 'anchor-2' ? 3 : 1, true),
    );
    vi.mocked(fetchNetworkMarkers).mockResolvedValue(markersTotal(1));

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useBrowseTotals(network, [seeker], {}, 'plumber', true, () => id),
      { wrapper, initialProps: { id: 'anchor-1' } },
    );
    await waitFor(() => expect(result.current.total).toBe(1));

    rerender({ id: 'anchor-2' });
    await waitFor(() => expect(result.current.total).toBe(3));
  });

  it('issues nothing at all when disabled', async () => {
    renderHook(() => useBrowseTotals(network, [seeker], {}, '', false), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(fetchDiscover)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchNetworkMarkers)).not.toHaveBeenCalled();
  });
});
