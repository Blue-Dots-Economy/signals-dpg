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
});
