import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { useEditItem } from './use-edit-item';

vi.mock('@/lib/item-api', () => ({ fetchItems: vi.fn() }));
import { fetchItems } from '@/lib/item-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const item = (id: string, domain: string): Item =>
  ({ item_id: id, item_domain: domain, item_state: {} } as unknown as Item);

const network = {
  id: 'blue_dot',
  domains: [
    { id: 'student', item_schemas: { 'profile_1.0': {} } },
    { id: 'mentor', item_schemas: { 'profile_1.0': {} } },
  ],
} as unknown as DotNetworkSchema;

describe('useEditItem', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the first matching item found across domains', async () => {
    vi.mocked(fetchItems).mockImplementation(async (q) => ({
      meta: { total: 0, limit: 1, offset: 0 },
      items: q.item_domain === 'mentor' ? [item('x', 'mentor')] : [],
    }));
    const { result } = renderHook(() => useEditItem(network, 'x'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.item_id).toBe('x');
  });

  it('returns null when no domain has the item', async () => {
    vi.mocked(fetchItems).mockResolvedValue({ meta: { total: 0, limit: 1, offset: 0 }, items: [] });
    const { result } = renderHook(() => useEditItem(network, 'missing'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('is disabled (no fetch) when itemId is null', () => {
    renderHook(() => useEditItem(network, null), { wrapper });
    expect(fetchItems).not.toHaveBeenCalled();
  });
});
