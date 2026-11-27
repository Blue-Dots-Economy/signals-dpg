import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { useMyItems } from './use-my-items';

vi.mock('@/lib/item-api', () => ({ fetchAllItems: vi.fn() }));
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
import { fetchAllItems } from '@/lib/item-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const item = (id: string, domain: string): Item =>
  ({ item_id: id, item_domain: domain } as unknown as Item);

const network = {
  id: 'blue_dot',
  domains: [
    { id: 'student', item_schemas: { 'profile_1.0': {} } },
    { id: 'mentor', item_schemas: { 'profile_1.0': {} } },
  ],
} as unknown as DotNetworkSchema;

describe('useMyItems', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flattens my items across the network domains', async () => {
    vi.mocked(fetchAllItems).mockImplementation(async (q) =>
      q.item_domain === 'student' ? [item('a', 'student')] : [item('b', 'mentor')],
    );
    const { result } = renderHook(() => useMyItems(network), { wrapper });
    await waitFor(() => expect(result.current.data.length).toBe(2));
    expect(result.current.data.map((i) => i.item_id).sort()).toEqual(['a', 'b']);
    // No page-size cap: fetchAllItems pages through everything.
    expect(fetchAllItems).toHaveBeenCalledWith(
      expect.not.objectContaining({ limit: expect.anything() }),
      expect.anything(),
    );
    expect(fetchAllItems).toHaveBeenCalledWith(
      expect.objectContaining({ created_by_me: true }),
      expect.anything(),
    );
    expect(result.current.isFetched).toBe(true);
  });

  it('is disabled (no fetch) when network is null', () => {
    renderHook(() => useMyItems(null), { wrapper });
    expect(fetchAllItems).not.toHaveBeenCalled();
  });

  it('returns the same empty list on every render while there are no items', () => {
    const { result, rerender } = renderHook(() => useMyItems(null), { wrapper });
    const first = result.current.data;
    rerender();
    expect(result.current.data).toBe(first);
  });
});
