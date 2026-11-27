import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useConsentGate } from '../use-consent-gate';

const state = vi.hoisted(() => ({ signedIn: false }));
const { getConsentStatus } = vi.hoisted(() => ({ getConsentStatus: vi.fn() }));

vi.mock('@/lib/consent-api', () => ({ getConsentStatus }));
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ isAuthenticated: state.signedIn }),
}));
vi.mock('@/theme/theme-provider', () => ({
  useNetworkTheme: () => ({ themeId: 'blue_dot', brand: null }),
}));
vi.mock('../use-consent-config', () => ({
  useConsentConfig: () => ({ config: null, isLoading: false }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  getConsentStatus.mockReset().mockResolvedValue({ accepted: [] });
});

describe('useConsentGate', () => {
  it('does not ask a visitor for consent status, and is not left loading', async () => {
    state.signedIn = false;
    const { result } = renderHook(() => useConsentGate(), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getConsentStatus).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.needed).toEqual([]);
  });

  it('asks for a signed-in user', async () => {
    state.signedIn = true;
    renderHook(() => useConsentGate(), { wrapper });
    await waitFor(() => expect(getConsentStatus).toHaveBeenCalledWith('blue_dot'));
  });
});
