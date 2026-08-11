import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';
import { useNetworkConfigs, useResolvedNetwork } from './use-network-config';

vi.mock('@/lib/network-api', () => ({
  fetchNetworkConfigs: vi.fn(),
  fetchNetworkConfig: vi.fn(),
}));
import { fetchNetworkConfigs, fetchNetworkConfig } from '@/lib/network-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const cfg = (id: string): DotNetworkSchema =>
  ({ id, domains: [] } as unknown as DotNetworkSchema);

describe('useNetworkConfigs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the fetched network configs', async () => {
    vi.mocked(fetchNetworkConfigs).mockResolvedValue([cfg('blue_dot'), cfg('yellow_dot')]);
    const { result } = renderHook(() => useNetworkConfigs(), { wrapper });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.map((n) => n.id)).toEqual(['blue_dot', 'yellow_dot']);
  });
});

describe('useResolvedNetwork', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches the config then resolves it (identity when no $refs)', async () => {
    vi.mocked(fetchNetworkConfig).mockResolvedValue(cfg('blue_dot'));
    const { result } = renderHook(() => useResolvedNetwork('blue_dot'), { wrapper });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.id).toBe('blue_dot');
    expect(fetchNetworkConfig).toHaveBeenCalledWith('blue_dot');
  });

  it('is disabled for a null networkId (no fetch)', () => {
    renderHook(() => useResolvedNetwork(null), { wrapper });
    expect(fetchNetworkConfig).not.toHaveBeenCalled();
  });
});
