import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useItemDetail } from '../use-item-detail';

vi.mock('@/lib/network-api', () => ({
  fetchNetworkItems: vi.fn().mockRejectedValue(new Error('boom')),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useItemDetail isError', () => {
  it('surfaces isError when the fetch rejects', async () => {
    const { result } = renderHook(
      () => useItemDetail('blue_dot', { item_id: 'abc', item_domain: 'seeker', item_type: 'profile_1.0' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.item).toBeNull();
  });
});
