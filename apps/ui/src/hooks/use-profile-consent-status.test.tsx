import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';
import { useProfileConsentStatus } from './use-profile-consent-status';

vi.mock('@/lib/consent-api', () => ({ getProfileConsentStatus: vi.fn() }));
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
import { getProfileConsentStatus } from '@/lib/consent-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const network = { id: 'blue_dot', domains: [] } as unknown as DotNetworkSchema;

describe('useProfileConsentStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a Set of consented item ids', async () => {
    vi.mocked(getProfileConsentStatus).mockResolvedValue({ consented_item_ids: ['a', 'b'] });
    const { result } = renderHook(() => useProfileConsentStatus(network), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data instanceof Set).toBe(true);
    expect([...(result.current.data ?? [])].sort()).toEqual(['a', 'b']);
  });

  it('is disabled (no fetch) when network is null', () => {
    renderHook(() => useProfileConsentStatus(null), { wrapper });
    expect(getProfileConsentStatus).not.toHaveBeenCalled();
  });
});
