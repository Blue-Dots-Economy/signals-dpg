import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth-context';

const { clearSchemaCache } = vi.hoisted(() => ({ clearSchemaCache: vi.fn() }));
vi.mock('@/engine', () => ({ clearSchemaCache }));
vi.mock('@/lib/auth-api', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  signOut: vi.fn().mockResolvedValue(undefined),
  fetchAuthConfig: vi.fn().mockResolvedValue({
    selfSignupAllowed: false,
    loginChannels: ['phone', 'email'],
    authProvider: 'betterauth',
  }),
}));

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return (
      <QueryClientProvider client={client}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  };
}

describe('AuthProvider signOut', () => {
  beforeEach(() => clearSchemaCache.mockClear());

  it('clears the schema cache on sign-out', async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(client) });
    await act(async () => {
      await result.current.signOut();
    });
    expect(clearSchemaCache).toHaveBeenCalled();
  });

  it('clears the schema cache even when the sign-out API call fails', async () => {
    const authApi = await import('@/lib/auth-api');
    vi.mocked(authApi.signOut).mockRejectedValueOnce(new Error('network'));
    const client = new QueryClient();
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(client) });
    await act(async () => {
      await expect(result.current.signOut()).rejects.toThrow('network');
    });
    expect(clearSchemaCache).toHaveBeenCalled();
  });

  it('clears every per-user cache (my-items, profile-consent, edit-item, actions) on sign-out', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'removeQueries');
    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper(client) });
    await act(async () => {
      await result.current.signOut();
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['my-items'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['profile-consent'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['edit-item'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['actions'] });
  });
});
