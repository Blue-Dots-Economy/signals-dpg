import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { useInfiniteBrowseItems } from './use-infinite-browse-items';

vi.mock('@/lib/network-api', () => ({
  fetchNetworkItems: vi.fn(),
  PROFILE_PAGE_SIZE: 2,
}));
import { fetchNetworkItems } from '@/lib/network-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const item = (id: string): Item => ({ item_id: id } as unknown as Item);
const network = { id: 'blue_dot' } as unknown as DotNetworkSchema;
const domain = { id: 'student', item_schemas: { 'profile_1.0': {} } } as unknown as DotNetworkDomain;

describe('useInfiniteBrowseItems', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads pages, appends, exposes total + hasNextPage, sends lat/lng + offset', async () => {
    vi.mocked(fetchNetworkItems).mockImplementation(async (q) => ({
      meta: { total: 3, limit: 2, offset: q.offset ?? 0 },
      items: (q.offset ?? 0) === 0 ? [item('a'), item('b')] : [item('c')],
    }));
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, { lat: 19, lng: 72 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.total).toBe(3);
    expect(result.current.hasNextPage).toBe(true);
    expect(fetchNetworkItems).toHaveBeenCalledWith(
      expect.objectContaining({ item_latitude: 19, item_longitude: 72, offset: 0 }),
      expect.anything(),
    );
    act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.items.map((i) => i.item_id)).toEqual(['a', 'b', 'c']));
    expect(result.current.hasNextPage).toBe(false); // 3 of 3 loaded
  });

  it('is disabled when domain is null (no fetch)', () => {
    renderHook(() => useInfiniteBrowseItems(network, null, null), { wrapper });
    expect(fetchNetworkItems).not.toHaveBeenCalled();
  });

  it('defaults partial to false when meta.partial is absent', async () => {
    vi.mocked(fetchNetworkItems).mockImplementation(async () => ({
      meta: { total: 1, limit: 2, offset: 0 },
      items: [item('a')],
    }));
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, null),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(result.current.partial).toBe(false);
  });

  // #203 §6: `partial` must propagate up to the list feed if ANY loaded page
  // came back partial, even once a later page's peers all answered — earlier
  // items may still be missing, so the feed stays flagged (sticky).
  it('exposes partial=true when any loaded page is partial, and it stays true once a later page is not', async () => {
    vi.mocked(fetchNetworkItems).mockImplementation(async (q) => {
      const offset = q.offset ?? 0;
      return offset === 0
        ? { meta: { total: 3, limit: 2, offset, partial: true, unavailable_instances: ['https://peer.example'] }, items: [item('a'), item('b')] }
        : { meta: { total: 3, limit: 2, offset, partial: false, unavailable_instances: [] }, items: [item('c')] };
    });
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, null),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.partial).toBe(true);

    act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.items.length).toBe(3));
    expect(result.current.partial).toBe(true);
  });

  // meta.total sums Redis-cached per-instance counts (TTL >= 300s) while pages
  // are fresh, so a delete/pause inside that window can leave `total` (5) higher
  // than the rows the server can actually return (a short first page of 1, below
  // PROFILE_PAGE_SIZE=2). Without the short-page check, `loaded` (1) < `total`
  // (5) forever, `hasNextPage` never flips false, and the scroll sentinel fires
  // endless empty-page fetches.
  it('stops paging on a short page even when meta.total says more remain', async () => {
    vi.mocked(fetchNetworkItems).mockImplementation(async () => ({
      meta: { total: 5, limit: 2, offset: 0 },
      items: [item('a')],
    }));
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, null),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(result.current.total).toBe(5);
    expect(result.current.hasNextPage).toBe(false);
    expect(fetchNetworkItems).toHaveBeenCalledTimes(1);
  });
});
