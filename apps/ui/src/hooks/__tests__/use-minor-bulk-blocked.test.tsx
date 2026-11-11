import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';

const authConfig = vi.hoisted(() => ({ value: { minorBulkActionsEnabled: false } as { minorBulkActionsEnabled?: boolean } }));
vi.mock('@/hooks/use-auth-config', () => ({
  useAuthConfig: () => ({ config: authConfig.value, isLoading: false, isKeycloakLogin: true }),
}));

const getU18Status = vi.fn();
vi.mock('@/lib/consent-api', () => ({ getU18Status: (id: string) => getU18Status(id) }));

import { useMinorBulkBlocked } from '@/hooks/use-minor-bulk-blocked';

const network = {
  id: 'purple_dot',
  domains: [
    { id: 'seeker', guardian_consent_required: true },
    { id: 'provider', guardian_consent_required: false },
  ],
} as unknown as DotNetworkSchema;

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  authConfig.value = { minorBulkActionsEnabled: false };
  getU18Status.mockResolvedValue({ isMinor: true });
});

describe('useMinorBulkBlocked', () => {
  it('is true for a minor on a guardian-gated domain when bulk is off', async () => {
    const { result } = renderHook(() => useMinorBulkBlocked(network, 'seeker'), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
    expect(getU18Status).toHaveBeenCalledWith('purple_dot');
  });

  it('is false for an adult', async () => {
    getU18Status.mockResolvedValue({ isMinor: false });
    const { result } = renderHook(() => useMinorBulkBlocked(network, 'seeker'), { wrapper });
    await waitFor(() => expect(getU18Status).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('does not look up the minor status when bulk is on or not configured', () => {
    authConfig.value = {};
    const { result } = renderHook(() => useMinorBulkBlocked(network, 'seeker'), { wrapper });
    expect(result.current).toBe(false);
    expect(getU18Status).not.toHaveBeenCalled();
  });

  it('does not block before the network has loaded', () => {
    const { result } = renderHook(() => useMinorBulkBlocked(null, 'seeker'), { wrapper });
    expect(result.current).toBe(false);
    expect(getU18Status).not.toHaveBeenCalled();
  });

  it('does not block on a domain without guardian consent', () => {
    const { result } = renderHook(() => useMinorBulkBlocked(network, 'provider'), { wrapper });
    expect(result.current).toBe(false);
    expect(getU18Status).not.toHaveBeenCalled();
  });
});
