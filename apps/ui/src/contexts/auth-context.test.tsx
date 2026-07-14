import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './auth-context';

const { clearSchemaCache } = vi.hoisted(() => ({ clearSchemaCache: vi.fn() }));
vi.mock('@/engine', () => ({ clearSchemaCache }));
vi.mock('@/lib/auth-api', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  signOut: vi.fn().mockResolvedValue(undefined),
}));

describe('AuthProvider signOut', () => {
  beforeEach(() => clearSchemaCache.mockClear());

  it('clears the schema cache on sign-out', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await act(async () => {
      await result.current.signOut();
    });
    expect(clearSchemaCache).toHaveBeenCalled();
  });
});
