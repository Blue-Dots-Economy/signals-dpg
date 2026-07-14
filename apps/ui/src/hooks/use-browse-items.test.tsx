import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { useBrowseItems } from './use-browse-items';

vi.mock('@/lib/network-api', () => ({
  fetchNetworkItems: vi.fn(),
  PROFILE_FETCH_LIMIT: 1000,
}));
import { fetchNetworkItems } from '@/lib/network-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const item = (id: string): Item => ({ item_id: id } as unknown as Item);
const network = { id: 'blue_dot', domains: [] } as unknown as DotNetworkSchema;
const domains = [
  { id: 'student', item_schemas: { 'profile_1.0': {} } },
  { id: 'mentor', item_schemas: { 'profile_1.0': {} } },
] as unknown as DotNetworkDomain[];

describe('useBrowseItems', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns raw items keyed by domain and passes cache_ttl_seconds', async () => {
    vi.mocked(fetchNetworkItems).mockImplementation(async (q) => ({
      meta: { total: 0, limit: 1000, offset: 0 },
      items: q.item_domain === 'student' ? [item('a')] : [item('b')],
    }));
    const { result } = renderHook(() => useBrowseItems(network, domains), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data.student.map((i) => i.item_id)).toEqual(['a']);
    expect(result.current.data.mentor.map((i) => i.item_id)).toEqual(['b']);
    expect(fetchNetworkItems).toHaveBeenCalledWith(
      expect.objectContaining({ cache_ttl_seconds: 90, item_domain: 'student' }),
      expect.anything(),
    );
  });

  it('runs no queries when network is null', () => {
    renderHook(() => useBrowseItems(null, domains), { wrapper });
    expect(fetchNetworkItems).not.toHaveBeenCalled();
  });
});
