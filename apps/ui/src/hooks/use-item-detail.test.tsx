import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Item } from '@/lib/item-api';
import { useItemDetail } from './use-item-detail';

vi.mock('@/lib/network-api', () => ({
  fetchNetworkItems: vi.fn(),
}));
import { fetchNetworkItems } from '@/lib/network-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const fullItem = (id: string): Item =>
  ({ item_id: id, item_domain: 'student', item_type: 'profile_1.0' } as unknown as Item);

const ref = {
  item_id: 'item-1',
  item_domain: 'student',
  item_type: 'profile_1.0',
  item_instance_url: 'https://peer.example',
};

describe('useItemDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches by id when enabled and returns items[0]', async () => {
    vi.mocked(fetchNetworkItems).mockResolvedValue({
      meta: { total: 1, limit: 1, offset: 0 },
      items: [fullItem('item-1')],
    });

    const { result } = renderHook(() => useItemDetail('blue_dot', ref), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.item?.item_id).toBe('item-1');
    expect(fetchNetworkItems).toHaveBeenCalledWith(
      expect.objectContaining({
        item_network: 'blue_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        item_id: 'item-1',
        item_instance_url: 'https://peer.example',
        limit: 1,
        offset: 0,
      }),
      expect.anything(),
    );
  });

  it('returns null when the server has no match', async () => {
    vi.mocked(fetchNetworkItems).mockResolvedValue({
      meta: { total: 0, limit: 1, offset: 0 },
      items: [],
    });

    const { result } = renderHook(() => useItemDetail('blue_dot', ref), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.item).toBeNull();
  });

  it('is disabled when item is null (no fetch)', () => {
    renderHook(() => useItemDetail('blue_dot', null), { wrapper });
    expect(fetchNetworkItems).not.toHaveBeenCalled();
  });

  it('is disabled when networkId is null (no fetch)', () => {
    renderHook(() => useItemDetail(null, ref), { wrapper });
    expect(fetchNetworkItems).not.toHaveBeenCalled();
  });

  it('is disabled when opts.enabled is false, even with a valid item (popup gate)', () => {
    renderHook(() => useItemDetail('blue_dot', ref, { enabled: false }), { wrapper });
    expect(fetchNetworkItems).not.toHaveBeenCalled();
  });
});
